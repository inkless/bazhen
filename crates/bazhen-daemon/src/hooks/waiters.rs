//! The waiter each agent holds (`Mailbox.wait`): the hook that wakes an idle session when mail
//! comes. Only the newest of an agent's waiters may hand out mail, since Claude Code never reaps
//! old ones, so a newer one answers the one before it quiet.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};

use bazhen_protocol::ids::AgentId;
use bazhen_protocol::mail::HookReply;
use tokio::sync::oneshot;

use super::quiet;

/// Each agent's held waiter, by the epoch its wait was registered at.
#[derive(Debug, Default)]
pub(crate) struct Waiters {
    held: StdMutex<HashMap<AgentId, Entry>>,
    epochs: AtomicU64,
}

#[derive(Debug)]
struct Entry {
    epoch: u64,
    answer: oneshot::Sender<HookReply>,
}

/// One registered wait. Dropped, as when its client closes its connection, it leaves the registry,
/// unless a newer wait has taken its place.
#[derive(Debug)]
pub(crate) struct Waiting {
    waiters: Arc<Waiters>,
    agent: AgentId,
    epoch: u64,
    answer: oneshot::Receiver<HookReply>,
}

impl Waiters {
    /// Registers `agent`'s new waiter, answering the one it replaces quiet.
    pub(crate) fn wait(self: &Arc<Self>, agent: &AgentId) -> Waiting {
        let epoch = self.epochs.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        let older = self.held().insert(agent.clone(), Entry { epoch, answer });
        if let Some(older) = older {
            // Its client may have gone already, with nothing left to answer.
            let _ = older.answer.send(quiet());
        }
        Waiting {
            waiters: Arc::clone(self),
            agent: agent.clone(),
            epoch,
            answer: answered,
        }
    }

    /// Answers `agent`'s waiter quiet and forgets it, as when the agent has closed.
    pub(crate) fn release(&self, agent: &AgentId) {
        if let Some(held) = self.held().remove(agent) {
            // Its client may have gone already, with nothing left to answer.
            let _ = held.answer.send(quiet());
        }
    }

    /// The agents that hold a waiter now.
    pub(crate) fn agents(&self) -> Vec<AgentId> {
        self.held().keys().cloned().collect()
    }

    /// Whether `agent` holds a waiter, which mail sent to it would wake.
    pub(crate) fn holds(&self, agent: &AgentId) -> bool {
        self.held().contains_key(agent)
    }

    /// Answers `agent`'s held waiter with `reply`, which lets it go; whether it held one whose
    /// client was still there to take it.
    pub(crate) fn answer(&self, agent: &AgentId, reply: HookReply) -> bool {
        let held = self.held().remove(agent);
        held.is_some_and(|entry| entry.answer.send(reply).is_ok())
    }

    fn held(&self) -> MutexGuard<'_, HashMap<AgentId, Entry>> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Waiting {
    /// What the wait is answered with: quiet, once a newer wait replaces it.
    pub(crate) async fn answered(&mut self) -> HookReply {
        (&mut self.answer).await.unwrap_or_else(|_| quiet())
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        let mut held = self.waiters.held();
        if held.get(&self.agent).is_some_and(|e| e.epoch == self.epoch) {
            held.remove(&self.agent);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> AgentId {
        AgentId::parse("agent_01900000000070008000000000000001").unwrap()
    }

    #[test]
    fn answers_an_older_wait_quiet_and_keeps_the_newer_when_the_older_goes() {
        let waiters = Arc::new(Waiters::default());
        let mut older = waiters.wait(&agent());
        let newer = waiters.wait(&agent());
        let answered = older.answer.try_recv().ok();
        drop(older);
        assert_eq!((answered, waiters.holds(&agent())), (Some(quiet()), true));
        drop(newer);
        assert!(!waiters.holds(&agent()));
    }
}
