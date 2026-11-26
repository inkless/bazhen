//! The approvals and questions a harness asks, while they are open (`attention/inbox.ts`'s
//! pending map): which tool call each is about, the hook each approval holds, and the claim that
//! ends one.
//!
//! Every path that ends an item claims its entry and closes the item in one job on the store's
//! writer: an answer, the hold's deadline, its client going, a fact that settles it, and the
//! agent closing. The writer runs one job at a time, so one path wins, and closes the item; the
//! others find nothing to claim. Dropping a claimed hook's sender answers its hook quiet, so the
//! harness goes on as it would alone.
//!
//! An item a harness's server asked holds that request, answered on the connection it came on
//! while that connection is open. The server asks its pending requests again on each new
//! connection, so each such item is marked when it's asked, and one not asked again on the next
//! connection is stale: its request went with the server that held it.
//!
//! The registry's lock is never held across an `.await`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use bazhen_harness::{HarnessId, ToolKey};
use bazhen_protocol::ids::{AgentId, AttentionId};
use bazhen_protocol::mail::HookReply;
use bazhen_protocol::mail_events::AttentionClosedReason;
use bazhen_store::Store;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::quiet;
use crate::channel::rpc::{RequestId, Rpc};
use crate::writer::Writer;

/// The most tool calls an agent's started list keeps, the oldest going first: a call is only
/// matched to a request that comes while it runs.
const TOOLS_KEPT: usize = 64;

/// Who a held item's answer goes to.
#[derive(Debug)]
pub(crate) enum Responder {
    /// The hook that asked, held until it is answered; the reply is built before the claim.
    Hook(oneshot::Sender<HookReply>),
    /// A request of the harness's server, answered on the connection it came on.
    Server(ServerHold),
}

impl Responder {
    /// Whether an answer can reach it now: a server's request only while its connection is open.
    fn reachable(&self) -> bool {
        match self {
            Self::Hook(_) => true,
            Self::Server(hold) => hold.on.open(),
        }
    }
}

/// A server's request, by the connection it came on and its id there.
#[derive(Debug)]
pub(crate) struct ServerHold {
    pub(crate) on: Rpc,
    pub(crate) id: RequestId,
    pub(crate) method: String,
}

/// What an item a harness's server asked keeps of that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Served {
    pub(crate) harness: HarnessId,
    /// Asked since the server's last connection ended, so held by the one it's on now.
    pub(crate) asked_since: bool,
}

/// An open item, by what it is about.
#[derive(Debug)]
pub(crate) struct Entry {
    pub(crate) agent: AgentId,
    pub(crate) key: ToolKey,
    /// The session whose hook asked it, whose turn or next prompt settles it.
    pub(crate) session: Option<String>,
    pub(crate) use_id: Option<String>,
    /// The held request it answers; none for a question only the TUI takes.
    pub(crate) responder: Option<Responder>,
    /// The server that asked it, none for a hook's.
    pub(crate) served: Option<Served>,
}

#[derive(Debug, Default)]
struct Registry {
    open: HashMap<AttentionId, Entry>,
    /// Each agent's tool calls started and not yet settled, oldest first.
    tools: HashMap<AgentId, VecDeque<(ToolKey, String)>>,
}

/// The open items and the tool calls they are matched to.
#[derive(Debug, Default)]
pub(crate) struct Approvals {
    registry: StdMutex<Registry>,
}

impl Approvals {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `agent`'s tool call `use_id` started, keyed as a request about it will be.
    pub(crate) fn started(&self, agent: &AgentId, key: ToolKey, use_id: String) {
        let mut registry = self.registry();
        let tools = registry.tools.entry(agent.clone()).or_default();
        if tools.len() == TOOLS_KEPT {
            tools.pop_front();
        }
        tools.push_back((key, use_id));
    }

    /// `agent`'s tool call `use_id` ended: it leaves the started list, and the open items about it
    /// are answered.
    pub(crate) fn tool_settled(&self, agent: &AgentId, use_id: &str) -> Vec<AttentionId> {
        let mut registry = self.registry();
        if let Some(tools) = registry.tools.get_mut(agent) {
            tools.retain(|(_, started)| started != use_id);
        }
        registry
            .open
            .iter()
            .filter(|(_, entry)| &entry.agent == agent && entry.use_id.as_deref() == Some(use_id))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// The earliest call `agent` started under `key` that no request has taken, which a request
    /// under that key is about; it leaves the list.
    pub(crate) fn take_use_id(&self, agent: &AgentId, key: &ToolKey) -> Option<String> {
        let mut registry = self.registry();
        let tools = registry.tools.get_mut(agent)?;
        let at = tools.iter().position(|(started, _)| started == key)?;
        tools.remove(at).map(|(_, use_id)| use_id)
    }

    /// Forgets the calls `agent` started, as a turn's end, a new prompt or a new session does.
    pub(crate) fn forget_tools(&self, agent: &AgentId) {
        self.registry().tools.remove(agent);
    }

    pub(crate) fn opened(&self, id: AttentionId, entry: Entry) {
        self.registry().open.insert(id, entry);
    }

    /// Holds `responder` for the open item `id`; false when it isn't open.
    pub(crate) fn hold(&self, id: &AttentionId, responder: Responder) -> bool {
        match self.registry().open.get_mut(id) {
            Some(entry) => {
                entry.responder = Some(responder);
                true
            }
            None => false,
        }
    }

    /// Whether the item `id` is open with a request held for its answer that an answer can reach:
    /// a hook's, or a server's on a connection still open.
    pub(crate) fn held(&self, id: &AttentionId) -> bool {
        self.registry()
            .open
            .get(id)
            .and_then(|entry| entry.responder.as_ref())
            .is_some_and(Responder::reachable)
    }

    /// Whether the item `id` is open holding a server's request, on a connection open or not.
    pub(crate) fn held_by_server(&self, id: &AttentionId) -> bool {
        let registry = self.registry();
        let entry = registry.open.get(id);
        matches!(
            entry.and_then(|e| e.responder.as_ref()),
            Some(Responder::Server(_))
        )
    }

    /// The open item `harness`'s server asked under `key`, marked asked again; none when there is
    /// none, and the request is new. It holds nothing until the request asked again is held: the
    /// one it held may be one the server no longer waits on.
    pub(crate) fn asked_again(&self, harness: HarnessId, key: &ToolKey) -> Option<AttentionId> {
        let mut registry = self.registry();
        let (id, entry) = registry
            .open
            .iter_mut()
            .find(|(_, entry)| served_by(entry, harness) && &entry.key == key)?;
        entry.served = Some(Served {
            harness,
            asked_since: true,
        });
        entry.responder = None;
        Some(id.clone())
    }

    /// Drops the requests held for the open items `harness`'s server asked under `key`, which it
    /// has asked again where no one agent is found to hold the new one for: the one held may be
    /// one the server no longer waits on.
    pub(crate) fn unhold(&self, harness: HarnessId, key: &ToolKey) {
        for entry in self.registry().open.values_mut() {
            if served_by(entry, harness) && &entry.key == key {
                entry.responder = None;
            }
        }
    }

    /// The open items `harness`'s server asked under `key`, whichever agent each is of.
    pub(crate) fn served_matching(&self, harness: HarnessId, key: &ToolKey) -> Vec<AttentionId> {
        self.registry()
            .open
            .iter()
            .filter(|(_, entry)| served_by(entry, harness) && &entry.key == key)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Marks each open item `harness`'s server asked as not asked since its connection ended.
    pub(crate) fn disconnected(&self, harness: HarnessId) {
        for entry in self.registry().open.values_mut() {
            if let Some(served) = entry.served.as_mut().filter(|s| s.harness == harness) {
                served.asked_since = false;
            }
        }
    }

    /// The open items `harness`'s server asked and hasn't asked again since its last connection
    /// ended: the server that held their requests is gone.
    pub(crate) fn not_asked_again(&self, harness: HarnessId) -> Vec<AttentionId> {
        let stale = Served {
            harness,
            asked_since: false,
        };
        self.registry()
            .open
            .iter()
            .filter(|(_, entry)| entry.served == Some(stale))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// The agent the open item `id` belongs to.
    pub(crate) fn agent_of(&self, id: &AttentionId) -> Option<AgentId> {
        self.registry()
            .open
            .get(id)
            .map(|entry| entry.agent.clone())
    }

    /// Takes the item `id`'s entry, which only one path ending it can.
    pub(crate) fn claim(&self, id: &AttentionId) -> Option<Entry> {
        self.registry().open.remove(id)
    }

    /// Puts back an entry claimed for a close that didn't commit.
    pub(crate) fn put_back(&self, id: AttentionId, entry: Entry) {
        self.registry().open.insert(id, entry);
    }

    /// The open items of `agent` that `settles` picks.
    pub(crate) fn matching(
        &self,
        agent: &AgentId,
        settles: impl Fn(&Entry) -> bool,
    ) -> Vec<AttentionId> {
        self.registry()
            .open
            .iter()
            .filter(|(_, entry)| &entry.agent == agent && settles(entry))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Claims each of `ids` still open and closes it for `reason`, in one job on the writer.
    ///
    /// # Errors
    ///
    /// The store's, once the claimed entries are put back without what they held, whose
    /// requests the harness then decides alone.
    pub(crate) async fn settle(
        self: &Arc<Self>,
        store: &Writer,
        ids: Vec<AttentionId>,
        reason: AttentionClosedReason,
    ) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let approvals = Arc::clone(self);
        store
            .run(move |store| {
                let claimed = ids
                    .into_iter()
                    .filter_map(|id| approvals.claim(&id).map(|entry| (id, entry)))
                    .collect();
                approvals.close(store, claimed, |_| reason)
            })
            .await
            .map_err(|err| err.to_string())?
    }

    /// Closes the `claimed` items, each for the reason `reason_of` gives, in one transaction. A
    /// close that doesn't commit puts each entry back without its responder, whose request the
    /// harness then decides alone: the item waits for a later settle, or the next boot.
    fn close(
        &self,
        store: &mut Store,
        claimed: Vec<(AttentionId, Entry)>,
        reason_of: impl Fn(&Entry) -> AttentionClosedReason,
    ) -> Result<(), String> {
        if claimed.is_empty() {
            return Ok(());
        }
        let reasons: Vec<_> = claimed
            .iter()
            .map(|(id, entry)| (id.clone(), reason_of(entry)))
            .collect();
        let closed = store.write(|w| {
            for (id, reason) in &reasons {
                w.settle_attention(id, *reason, "system")?;
            }
            Ok::<_, bazhen_store::AppendError>(())
        });
        if let Err(err) = closed {
            for (id, mut entry) in claimed {
                entry.responder = None;
                self.put_back(id, entry);
            }
            return Err(err.to_string());
        }
        Ok(())
    }

    /// Holds the open item `id` for `responder`'s answer, until `wait` passes, the answer comes, or
    /// whatever holds it is dropped.
    pub(crate) fn holding(
        self: &Arc<Self>,
        id: &AttentionId,
        wait: Option<Duration>,
        store: &Writer,
        stop: &CancellationToken,
    ) -> Option<Holding> {
        let (answer, answered) = oneshot::channel();
        if !self.hold(id, Responder::Hook(answer)) {
            return None;
        }
        Some(Holding {
            answered,
            wait,
            guard: Guard {
                approvals: Arc::clone(self),
                id: Some(id.clone()),
                store: store.clone(),
                stop: stop.clone(),
            },
        })
    }
}

fn served_by(entry: &Entry, harness: HarnessId) -> bool {
    entry.served.is_some_and(|served| served.harness == harness)
}

/// An approval's hook, held for the human's answer.
#[derive(Debug)]
pub(crate) struct Holding {
    answered: oneshot::Receiver<HookReply>,
    wait: Option<Duration>,
    guard: Guard,
}

impl Holding {
    /// The reply the hook gives: the human's answer, or quiet once the item ends some other way.
    pub(crate) async fn answered(mut self) -> HookReply {
        let reply = match self.wait {
            None => (&mut self.answered).await.ok(),
            Some(wait) => match tokio::time::timeout(wait, &mut self.answered).await {
                Ok(answered) => answered.ok(),
                Err(_) if self.guard.timed_out().await => None,
                // An answer claimed it first, and its send comes in the job that claimed it.
                Err(_) => (&mut self.answered).await.ok(),
            },
        };
        self.guard.id = None;
        reply.unwrap_or_else(quiet)
    }
}

/// Ends the held item when its hook goes unanswered: its client went, as when the human answered
/// in the TUI or the agent's process ended.
#[derive(Debug)]
struct Guard {
    approvals: Arc<Approvals>,
    /// The item, until the hold ends on its own.
    id: Option<AttentionId>,
    store: Writer,
    stop: CancellationToken,
}

impl Guard {
    /// Claims the item and closes it timed out, in one job; whether it was still there to claim.
    async fn timed_out(&mut self) -> bool {
        let Some(id) = self.id.take() else {
            return false;
        };
        let approvals = Arc::clone(&self.approvals);
        let closed = self
            .store
            .run(move |store| {
                let entry = approvals.claim(&id)?;
                let closed = approvals.close(store, vec![(id, entry)], |_| {
                    AttentionClosedReason::TimedOut
                });
                if let Err(err) = closed {
                    tracing::warn!("bazhen: an approval that timed out stays open: {err}");
                }
                Some(())
            })
            .await;
        // A store that closed has nothing to answer: the daemon is stopping.
        !matches!(closed, Ok(None))
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let Some(id) = self.id.take() else {
            return;
        };
        // A stopping daemon leaves the item to the next boot, which closes it stale.
        if self.stop.is_cancelled() {
            return;
        }
        let approvals = Arc::clone(&self.approvals);
        let queued = self.store.queue(move |store| {
            let Some(entry) = approvals.claim(&id) else {
                return;
            };
            let gone = |entry: &Entry| match store.reads().agent_binding(entry.agent.as_str()) {
                Ok(binding) => binding
                    .is_none_or(|binding| ["closing", "closed"].contains(&binding.state.as_str())),
                Err(_) => false,
            };
            let closing = gone(&entry);
            let closed = approvals.close(store, vec![(id, entry)], |_| {
                if closing {
                    AttentionClosedReason::AgentClosed
                } else {
                    AttentionClosedReason::AnsweredInTui
                }
            });
            if let Err(err) = closed {
                tracing::warn!("bazhen: an approval whose hook went stays open: {err}");
            }
        });
        if queued.is_err() {
            tracing::warn!("bazhen: an approval whose hook went stays open: the store has closed");
        }
    }
}
