//! Each agent's mail on its way through the agent's hooks, for a harness that takes mail by pull
//! (foundation-design §5.6). A message is offered to the waiter that wakes an idle session, or
//! folded into a running turn at its next tool call; written by the hook client, which acks it;
//! seen in the prompt that carries it; and delivered when that prompt's turn stops. What the hook
//! client never wrote, or the agent never saw, goes back to the queue, and what the agent's side
//! fails too often is given up.
//!
//! Each agent's mail is stepped under its own lock, so a hook, an ack, a send and a deadline of
//! one agent never interleave, and each step reads and records in one transaction. A deadline is
//! owned by the offer or the watch that started it: settling the message calls it off, and one
//! that fires after its message moved on finds it no longer its own and changes nothing.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bazhen_harness::{Answer, Mail, Pending, Resolution};
use bazhen_protocol::ids::{AgentId, MessageId};
use bazhen_protocol::mail::{HookReply, MailboxState, OfferToken};
use bazhen_protocol::mail_events::{
    MailOffered, MailRequeued, MailSeen, MailUndeliverable, RequeueReason, UndeliverableReason,
};
use bazhen_store::{AppendError, MailChange, Writer as StoreWriter};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio::task::AbortHandle;

use super::waiters::Waiters;
use super::{quiet, write};
use crate::agents::Agents;
use crate::routes::Shared;

/// How long the hook client has to write what it was handed and ack it.
const ACK_DEADLINE: Duration = Duration::from_secs(10);

/// How long a written wake may go unseen before it goes back to the queue: long, since the TUI
/// holds a wake back while a dialog or menu is open. While a turn is under way the turn's
/// boundaries decide, for at most `UNSEEN_TURN_CHECKS` more deadlines, in case its end was never
/// heard.
const UNSEEN_DEADLINE: Duration = Duration::from_mins(10);
const UNSEEN_TURN_CHECKS: u32 = 3;

/// A message is given up once the agent's side has failed it this often: its first offer, then
/// three more.
const MAX_FAILURES: u32 = 4;

/// What a hook holds, or held: handed over and not yet delivered.
const IN_FLIGHT: [MailboxState; 3] = [
    MailboxState::Offered,
    MailboxState::Emitted,
    MailboxState::Seen,
];

/// An agent that takes no more mail: closing or closed, its mail is given up, and failed, it never
/// started.
const GONE: [&str; 3] = ["closing", "closed", "failed"];

/// How long each of the mailbox's deadlines is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Deadlines {
    pub(crate) ack: Duration,
    pub(crate) unseen: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        Self {
            ack: ACK_DEADLINE,
            unseen: UNSEEN_DEADLINE,
        }
    }
}

/// Every agent's mail in flight through its hooks.
#[derive(Debug)]
pub(crate) struct Mailbox {
    waiters: Arc<Waiters>,
    agents: StdMutex<HashMap<AgentId, Arc<AsyncMutex<AgentMail>>>>,
    deadlines: Deadlines,
    /// This daemon's own prefix for its offers' ids, then a count, so no two offers share one,
    /// not even across a restart.
    prefix: String,
    count: AtomicU64,
}

/// What one agent's mail keeps between its hooks.
#[derive(Debug, Default)]
struct AgentMail {
    /// The prompt id of the turn under way, as last heard.
    turn: Option<String>,
    /// The prompt id of the turn last heard to end. Two hooks report each end, the Stop and the
    /// waiter beside it, so one lost still ends the turn, and the second changes nothing.
    ended: Option<String>,
    /// Messages written and unseen when the agent's last turn ended.
    unseen_at_turn_end: HashSet<String>,
    /// Each message handed to a hook and not yet written, by id.
    unacked: HashMap<String, Unacked>,
    /// Each written wake not yet seen, by id, and the deadline that requeues it.
    unseen: HashMap<String, Deadline>,
    /// Whether the agent closed, which no step touches again.
    forgotten: bool,
}

#[derive(Debug)]
struct Unacked {
    /// The offer's token, which only an ack of this offer names.
    token: OfferToken,
    deadline: Deadline,
    /// Whether it was folded into a turn, whose Stop delivers it however long that takes.
    fold: bool,
}

/// A timer that steps one message when it comes due, called off when dropped.
#[derive(Debug)]
struct Deadline {
    id: u64,
    timer: Option<AbortHandle>,
}

impl Deadline {
    /// Leaves its timer running: the timer itself, as it fires.
    fn fired(mut self) {
        self.timer = None;
    }
}

impl Drop for Deadline {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}

/// What a deadline does when it comes due.
#[derive(Debug, Clone, Copy)]
enum Due {
    /// The hook client never wrote the offer.
    Ack,
    /// The written wake went unseen, with this many more deadlines to wait out a turn under way.
    Unseen { checks: u32 },
}

impl AgentMail {
    /// Calls off what was held for `message`: the deadline for its ack, and the one for its being
    /// seen.
    fn call_off(&mut self, message: &str) {
        self.unacked.remove(message);
        self.unseen.remove(message);
        self.unseen_at_turn_end.remove(message);
    }
}

impl Mailbox {
    pub(crate) fn new(waiters: Arc<Waiters>, deadlines: Deadlines) -> Self {
        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        Self {
            waiters,
            agents: StdMutex::default(),
            deadlines,
            prefix: format!("{:x}", started.as_micros()),
            count: AtomicU64::new(0),
        }
    }

    /// `agent`'s mail, which a step holds from its first read to its last change.
    fn of(&self, agent: &AgentId) -> Arc<AsyncMutex<AgentMail>> {
        let mut agents = self.agents.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(agents.entry(agent.clone()).or_default())
    }

    /// `agent`'s mail, held for a step; `None` once the agent is forgotten, whose mail no step
    /// touches again.
    async fn held(&self, agent: &AgentId) -> Option<OwnedMutexGuard<AgentMail>> {
        let mail = self.of(agent).lock_owned().await;
        (!mail.forgotten).then_some(mail)
    }

    fn next(&self) -> u64 {
        self.count.fetch_add(1, Ordering::Relaxed)
    }

    /// Offers `agent`'s queued mail to the waiter it holds, if it holds one.
    pub(crate) async fn offer(
        self: &Arc<Self>,
        shared: &Shared,
        agent: &AgentId,
    ) -> Result<(), String> {
        let (mailbox, on, agent) = (Arc::clone(self), shared.clone(), agent.clone());
        whole(shared, async move { mailbox.offer_step(&on, &agent).await }).await
    }

    /// Folds `agent`'s queued mail into its turn `prompt`: see [`Self::fold_step`].
    pub(crate) async fn fold(
        self: &Arc<Self>,
        shared: &Shared,
        agent: &AgentId,
        prompt: &str,
    ) -> Result<HookReply, String> {
        let (mailbox, on, agent, prompt) = (
            Arc::clone(self),
            shared.clone(),
            agent.clone(),
            prompt.to_owned(),
        );
        whole(shared, async move {
            mailbox.fold_step(&on, &agent, &prompt).await
        })
        .await
    }

    /// Confirms the offers `offered` names: see [`Self::ack_step`].
    pub(crate) async fn ack(
        self: &Arc<Self>,
        shared: &Shared,
        agent: &AgentId,
        offered: &[OfferToken],
    ) -> Result<(), String> {
        let (mailbox, on, agent, offered) = (
            Arc::clone(self),
            shared.clone(),
            agent.clone(),
            offered.to_vec(),
        );
        whole(shared, async move {
            mailbox.ack_step(&on, &agent, &offered).await
        })
        .await
    }

    /// A prompt started a turn: see [`Self::prompt_started_step`].
    pub(crate) async fn prompt_started(
        self: &Arc<Self>,
        shared: &Shared,
        agent: &AgentId,
        prompt: Option<&str>,
        carries: &[String],
    ) -> Result<(), String> {
        let (mailbox, on, agent) = (Arc::clone(self), shared.clone(), agent.clone());
        let (prompt, carries) = (prompt.map(str::to_owned), carries.to_vec());
        whole(shared, async move {
            mailbox
                .prompt_started_step(&on, &agent, prompt.as_deref(), &carries)
                .await
        })
        .await
    }

    /// A turn ended: see [`Self::turn_ended_step`].
    pub(crate) async fn turn_ended(
        self: &Arc<Self>,
        shared: &Shared,
        agent: &AgentId,
        prompt: Option<&str>,
        failed: bool,
    ) -> Result<(), String> {
        let (mailbox, on, agent) = (Arc::clone(self), shared.clone(), agent.clone());
        let prompt = prompt.map(str::to_owned);
        whole(shared, async move {
            mailbox
                .turn_ended_step(&on, &agent, prompt.as_deref(), failed)
                .await
        })
        .await
    }

    /// `agent`'s session started over: see [`Self::session_started_step`].
    pub(crate) async fn session_started(
        self: &Arc<Self>,
        shared: &Shared,
        agent: &AgentId,
        compacted: bool,
    ) -> Result<(), String> {
        let (mailbox, on, agent) = (Arc::clone(self), shared.clone(), agent.clone());
        whole(shared, async move {
            mailbox.session_started_step(&on, &agent, compacted).await
        })
        .await
    }

    async fn offer_step(&self, shared: &Shared, agent: &AgentId) -> Result<(), String> {
        let Some(mut mail) = self.held(agent).await else {
            return Ok(());
        };
        self.offer_held(shared, agent, &mut mail).await
    }

    async fn offer_held(
        &self,
        shared: &Shared,
        agent: &AgentId,
        mail: &mut AgentMail,
    ) -> Result<(), String> {
        if !self.waiters.holds(agent) {
            return Ok(());
        }
        if let Some(reply) = self.hand(shared, agent, mail, None).await? {
            // A waiter gone since leaves the offer unwritten, and its deadline requeues it.
            self.waiters.answer(agent, reply);
        }
        Ok(())
    }

    /// Folds `agent`'s queued mail into its turn `prompt` at a tool call's end, as much as the
    /// harness's answer takes: quiet with nothing queued.
    async fn fold_step(
        &self,
        shared: &Shared,
        agent: &AgentId,
        prompt: &str,
    ) -> Result<HookReply, String> {
        let Some(mut mail) = self.held(agent).await else {
            return Ok(quiet());
        };
        let Some(reply) = self.hand(shared, agent, &mut mail, Some(prompt)).await? else {
            return Ok(quiet());
        };
        // A tool call ending means a turn is under way, even one whose prompt came before a
        // restart.
        mail.turn.get_or_insert_with(|| prompt.to_owned());
        Ok(reply)
    }

    /// Hands over as much of `agent`'s queued mail as its harness's answer takes: to its waiter,
    /// or folded into the turn `fold`. Each message handed over is recorded offered, and its ack
    /// deadline started. None when nothing is, or the agent takes no more mail.
    async fn hand(
        &self,
        shared: &Shared,
        agent: &AgentId,
        mail: &mut AgentMail,
        fold: Option<&str>,
    ) -> Result<Option<HookReply>, String> {
        let agents = shared.agents.clone().ok_or("this daemon runs no agents")?;
        let (id, prompt) = (agent.clone(), fold.map(str::to_owned));
        let handed = write(&shared.store, move |w| {
            let reads = w.reads();
            let binding = reads.agent_binding(id.as_str())?;
            let Some(binding) = binding.filter(|b| !GONE.contains(&b.state.as_str())) else {
                return Ok(None);
            };
            let Some(harness) = crate::mail::harness_of(&agents, &binding.harness) else {
                return Ok(None);
            };
            let queued = reads.mail(id.as_str(), &[MailboxState::Queued])?;
            let queued: Vec<Mail<'_>> = queued
                .iter()
                .map(|m| Mail {
                    id: &m.id,
                    body: &m.body,
                    first_offered: m.first_offered.as_deref(),
                })
                .collect();
            let pending = if prompt.is_some() {
                Pending::Fold
            } else {
                Pending::Waiter
            };
            let Answer::Hook(output) = harness.answer(&pending, Resolution::Mail(&queued)) else {
                return Ok(None);
            };
            let mut offered = Vec::new();
            for carried in &output.carried {
                // The harness hands back only ids it was handed, which the store minted.
                let Some(message) = MessageId::parse(carried) else {
                    continue;
                };
                let change = MailChange::Offered(MailOffered {
                    prompt_id: prompt.clone(),
                });
                w.mail_step(&message, change)?;
                offered.push(message);
            }
            Ok((!offered.is_empty()).then_some((output, offered)))
        })
        .await?;
        let Some((output, offered)) = handed else {
            return Ok(None);
        };
        let mut tokens = Vec::with_capacity(offered.len());
        for message in &offered {
            let offer = format!("{}{}", self.prefix, self.next());
            let token = OfferToken::of(message, &offer)
                .ok_or_else(|| format!("no offer token can be made of {message}"))?;
            let deadline = self.after(shared, agent, message.as_str(), Due::Ack);
            mail.unacked.insert(
                message.as_str().to_owned(),
                Unacked {
                    token: token.clone(),
                    deadline,
                    fold: fold.is_some(),
                },
            );
            tokens.push(token);
        }
        Ok(Some(HookReply {
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            offered: tokens,
        }))
    }

    /// The hook client wrote what it was handed. Only the offers it names, made to `agent`, are
    /// confirmed: an ack for an offer since taken back and made again confirms nothing.
    async fn ack_step(
        &self,
        shared: &Shared,
        agent: &AgentId,
        offered: &[OfferToken],
    ) -> Result<(), String> {
        let Some(mut mail) = self.held(agent).await else {
            return Ok(());
        };
        let written: Vec<(String, bool)> = mail
            .unacked
            .iter()
            .filter(|(_, unacked)| offered.contains(&unacked.token))
            .map(|(id, unacked)| (id.clone(), unacked.fold))
            .collect();
        if written.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = written.iter().map(|(id, _)| id.clone()).collect();
        write(&shared.store, move |w| {
            for id in &ids {
                step_from(w, id, &[MailboxState::Offered], MailChange::Emitted)?;
            }
            Ok(())
        })
        .await?;
        for (id, fold) in written {
            mail.unacked.remove(&id);
            // A fold is never seen in a prompt: its turn's Stop delivers it.
            if !fold {
                self.watch_unseen(shared, agent, &mut mail, &id, UNSEEN_TURN_CHECKS);
            }
        }
        Ok(())
    }

    /// A prompt `prompt` started a turn, carrying the messages `carries` as a wake handed them
    /// over: those the agent has seen. A new prompt while a turn is still under way means that
    /// turn ended with no Stop, as Esc ends one, or its TUI died: what it took goes back.
    async fn prompt_started_step(
        &self,
        shared: &Shared,
        agent: &AgentId,
        prompt: Option<&str>,
        carries: &[String],
    ) -> Result<(), String> {
        let Some(prompt) = prompt else {
            return Ok(());
        };
        let Some(mut mail) = self.held(agent).await else {
            return Ok(());
        };
        if let Some(current) = mail.turn.clone().filter(|turn| turn != prompt) {
            let took = took_in(shared, agent, &current).await?;
            for message in took {
                self.requeue(
                    shared,
                    agent,
                    &mut mail,
                    &message,
                    RequeueReason::Interrupted,
                )
                .await?;
            }
        }
        mail.turn = Some(prompt.to_owned());
        let (wakes, prompt) = (carries.to_vec(), prompt.to_owned());
        let seen = write(&shared.store, move |w| {
            let mut seen = Vec::new();
            for id in wakes {
                let change = MailChange::Seen(MailSeen {
                    prompt_id: prompt.clone(),
                });
                let from = [
                    MailboxState::Queued,
                    MailboxState::Offered,
                    MailboxState::Emitted,
                ];
                if step_from(w, &id, &from, change)? {
                    seen.push(id);
                }
            }
            Ok(seen)
        })
        .await?;
        for message in seen {
            mail.call_off(&message);
        }
        Ok(())
    }

    /// The turn `prompt` ended: stopped, what it took is delivered; failed, it goes back.
    async fn turn_ended_step(
        &self,
        shared: &Shared,
        agent: &AgentId,
        prompt: Option<&str>,
        failed: bool,
    ) -> Result<(), String> {
        let Some(mut mail) = self.held(agent).await else {
            return Ok(());
        };
        if let Some(prompt) = prompt {
            // The end of a turn a newer prompt cut short, reported late: that prompt took back
            // what the turn took, and the turn under way is the newer one.
            let stale = mail.turn.as_deref().is_some_and(|turn| turn != prompt);
            if stale || mail.ended.as_deref() == Some(prompt) {
                return Ok(());
            }
            mail.ended = Some(prompt.to_owned());
        }
        mail.turn = None;
        if let Some(prompt) = prompt {
            let took = took_in(shared, agent, prompt).await?;
            if failed {
                for message in took {
                    self.requeue(
                        shared,
                        agent,
                        &mut mail,
                        &message,
                        RequeueReason::StopFailed,
                    )
                    .await?;
                }
            } else {
                write(&shared.store, move |w| {
                    for id in &took {
                        let from = [MailboxState::Seen, MailboxState::Emitted];
                        step_from(w, id, &from, MailChange::Delivered)?;
                    }
                    Ok(())
                })
                .await?;
            }
        }
        self.turn_boundary(shared, agent, &mut mail).await
    }

    /// A wake written during a turn is taken into the next one, whose prompt comes after that
    /// turn ends: one still unseen when a second turn has ended never reached the agent.
    async fn turn_boundary(
        &self,
        shared: &Shared,
        agent: &AgentId,
        mail: &mut AgentMail,
    ) -> Result<(), String> {
        let before = std::mem::take(&mut mail.unseen_at_turn_end);
        let written = mail_of(shared, agent, &[MailboxState::Emitted]).await?;
        let mut still = HashSet::new();
        for message in written {
            if before.contains(&message.id) {
                self.requeue(shared, agent, mail, &message.id, RequeueReason::NotSeen)
                    .await?;
            } else {
                still.insert(message.id);
            }
        }
        mail.unseen_at_turn_end = still;
        Ok(())
    }

    /// `agent`'s session started over, as /clear, a fork or a resume start one: what was handed
    /// over and not yet seen can't reach it. The waiter it held may be the old session's, so it is
    /// answered first, and the requeued mail waits for the new session's. Unless the session only
    /// compacted, the turn under way is over too, and with it what that turn saw. A compaction
    /// keeps the turn, and what was folded into it, which the model has read.
    async fn session_started_step(
        &self,
        shared: &Shared,
        agent: &AgentId,
        compacted: bool,
    ) -> Result<(), String> {
        self.waiters.answer(agent, quiet());
        let Some(mut mail) = self.held(agent).await else {
            return Ok(());
        };
        let lost: Vec<String> = if compacted {
            let held = [MailboxState::Offered, MailboxState::Emitted];
            let held = mail_of(shared, agent, &held).await?;
            held.into_iter()
                .filter(|m| m.prompt_id.is_none())
                .map(|m| m.id)
                .collect()
        } else {
            let held = mail_of(shared, agent, &IN_FLIGHT).await?;
            held.into_iter().map(|m| m.id).collect()
        };
        for message in lost {
            self.requeue(
                shared,
                agent,
                &mut mail,
                &message,
                RequeueReason::SessionStarted,
            )
            .await?;
        }
        if !compacted {
            mail.turn = None;
            mail.ended = None;
        }
        Ok(())
    }

    /// Forgets `agent` as it closes, which gives its mail up: nothing held for that mail, or for
    /// its turns, is wanted again, and each of its deadlines is called off. Its entry stays,
    /// marked, so that a step coming after (from a deadline firing, a send committed before the
    /// close, or a hook let in before its token went) finds it and does nothing, rather than
    /// start the agent's mail afresh beside a step still under way. A closed agent never runs
    /// again, so the mark is never lifted, and the entry stays for the daemon's life: an empty
    /// entry for each agent closed while it runs, which is few and small. The agents'
    /// `after_closed` calls it, once the hooks have answered the agent's waiter, holding neither
    /// the hooks' turn of the agent nor its mail; the agent's command turn may be held.
    pub(crate) async fn forget(
        self: &Arc<Self>,
        agents: &Agents,
        agent: &AgentId,
    ) -> Result<(), String> {
        let (mailbox, agent) = (Arc::clone(self), agent.clone());
        whole_on(Some(agents), async move {
            let mail = mailbox.of(&agent);
            *mail.lock().await = AgentMail {
                forgotten: true,
                ..AgentMail::default()
            };
            Ok(())
        })
        .await
    }

    /// Back to the queue, and on to the waiter if one is held; given up instead once the agent's
    /// side has failed it `MAX_FAILURES` times. One no longer in flight is left where it is.
    async fn requeue(
        &self,
        shared: &Shared,
        agent: &AgentId,
        mail: &mut AgentMail,
        message: &str,
        reason: RequeueReason,
    ) -> Result<(), String> {
        mail.call_off(message);
        let (id, message_id) = (agent.clone(), message.to_owned());
        let gave_up = write(&shared.store, move |w| {
            let held = w.reads().mail(id.as_str(), &IN_FLIGHT)?;
            let Some(held) = held.into_iter().find(|m| m.id == message_id) else {
                return Ok(false);
            };
            let Some(message) = MessageId::parse(&held.id) else {
                return Ok(false);
            };
            let gives_up = reason.is_agent_failure() && held.failures + 1 >= MAX_FAILURES;
            w.mail_step(&message, MailChange::Requeued(MailRequeued { reason }))?;
            if gives_up {
                let reason = UndeliverableReason::GaveUp;
                let change = MailChange::Undeliverable(MailUndeliverable { reason });
                w.mail_step(&message, change)?;
            }
            Ok(gives_up)
        })
        .await?;
        if gave_up {
            tracing::warn!(
                "bazhen: gave up on {message} for agent {agent} after {MAX_FAILURES} failed offers"
            );
        }
        self.offer_held(shared, agent, mail).await
    }

    /// Watches a written wake, which goes back to the queue unless it is seen by the deadline.
    fn watch_unseen(
        &self,
        shared: &Shared,
        agent: &AgentId,
        mail: &mut AgentMail,
        message: &str,
        checks: u32,
    ) {
        let deadline = self.after(shared, agent, message, Due::Unseen { checks });
        // One watching it before is called off.
        mail.unseen.insert(message.to_owned(), deadline);
    }

    /// A deadline for `message`, which runs on the agents' tracker and ends with the daemon: what
    /// it held is requeued at the next start.
    fn after(&self, shared: &Shared, agent: &AgentId, message: &str, due: Due) -> Deadline {
        let id = self.next();
        let Some(agents) = shared.agents.as_ref() else {
            return Deadline { id, timer: None };
        };
        let wait = match due {
            Due::Ack => self.deadlines.ack,
            Due::Unseen { .. } => self.deadlines.unseen,
        };
        let (on, agent, message) = (shared.clone(), agent.clone(), message.to_owned());
        let stop = shared.stop.token().clone();
        let timer = agents.spawn(async move {
            if stop
                .run_until_cancelled(tokio::time::sleep(wait))
                .await
                .is_none()
            {
                return;
            }
            let mailbox = &on.hooks.mailbox;
            if let Err(err) = mailbox.due(&on, &agent, &message, id, due).await {
                tracing::warn!("bazhen: a deadline for {message} of agent {agent} failed: {err}");
            }
        });
        Deadline {
            id,
            timer: Some(timer.abort_handle()),
        }
    }

    /// The deadline `id` for `message` came due, if it is still that message's own.
    async fn due(
        &self,
        shared: &Shared,
        agent: &AgentId,
        message: &str,
        id: u64,
        due: Due,
    ) -> Result<(), String> {
        let Some(mut mail) = self.held(agent).await else {
            return Ok(());
        };
        match due {
            Due::Ack => {
                if mail
                    .unacked
                    .get(message)
                    .is_none_or(|unacked| unacked.deadline.id != id)
                {
                    return Ok(());
                }
                if let Some(unacked) = mail.unacked.remove(message) {
                    unacked.deadline.fired();
                }
                self.requeue(shared, agent, &mut mail, message, RequeueReason::NotWritten)
                    .await
            }
            Due::Unseen { checks } => {
                if mail.unseen.get(message).is_none_or(|d| d.id != id) {
                    return Ok(());
                }
                if let Some(deadline) = mail.unseen.remove(message) {
                    deadline.fired();
                }
                if mail.turn.is_some() && checks > 0 {
                    self.watch_unseen(shared, agent, &mut mail, message, checks - 1);
                    Ok(())
                } else {
                    self.requeue(shared, agent, &mut mail, message, RequeueReason::NotSeen)
                        .await
                }
            }
        }
    }
}

/// Runs a step of an agent's mail to its end as a task of its own, which the caller awaits. A
/// caller that goes, as a hook client killed or a request out of time does, can't split the step:
/// what its store write committed still gets what holds it, an ack's deadline or a call-off.
async fn whole<T: Send + 'static>(
    shared: &Shared,
    step: impl Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    whole_on(shared.agents.as_deref(), step).await
}

/// The same, on the tracker of `agents` where there are any.
async fn whole_on<T: Send + 'static>(
    agents: Option<&Agents>,
    step: impl Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    let Some(agents) = agents else {
        return step.await;
    };
    let (sent, answer) = tokio::sync::oneshot::channel();
    agents.spawn(async move {
        // The caller may have gone: the step is done all the same.
        sent.send(step.await).ok();
    });
    answer
        .await
        .map_err(|_| "the daemon stopped before the step was done".to_owned())?
}

/// Requeues the mail the hooks of the daemon before this one held: they went with its socket.
pub(crate) async fn requeue_in_flight(store: &crate::writer::Writer) {
    let requeued = write(store, |w| {
        let requeued = w.requeue_in_flight()?;
        Ok(requeued)
    })
    .await;
    match requeued {
        Ok(0) => {}
        Ok(requeued) => {
            tracing::info!("bazhen: requeued {requeued} messages the last daemon's hooks held");
        }
        Err(err) => {
            tracing::warn!("bazhen: couldn't requeue the mail the last daemon's hooks held: {err}");
        }
    }
}

/// The ids of `agent`'s messages a prompt may carry as a wake handed them over: offered before,
/// and not yet seen.
pub(crate) async fn offered(shared: &Shared, agent: &AgentId) -> Result<Vec<String>, String> {
    let states = [
        MailboxState::Queued,
        MailboxState::Offered,
        MailboxState::Emitted,
    ];
    let held = mail_of(shared, agent, &states).await?;
    Ok(held
        .into_iter()
        .filter(|m| m.first_offered.is_some())
        .map(|m| m.id)
        .collect())
}

/// What `agent`'s turn `prompt` took: seen in its prompt, or folded into it.
async fn took_in(shared: &Shared, agent: &AgentId, prompt: &str) -> Result<Vec<String>, String> {
    let held = mail_of(shared, agent, &[MailboxState::Seen, MailboxState::Emitted]).await?;
    Ok(held
        .into_iter()
        .filter(|m| m.prompt_id.as_deref() == Some(prompt))
        .map(|m| m.id)
        .collect())
}

async fn mail_of(
    shared: &Shared,
    agent: &AgentId,
    states: &[MailboxState],
) -> Result<Vec<bazhen_store::Mail>, String> {
    let (agent, states) = (agent.clone(), states.to_vec());
    shared
        .store
        .run(move |store| store.reads().mail(agent.as_str(), &states))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

/// Steps the message `id` by `change` if it is in one of `from`, answering whether it was: one
/// that has moved on, as a closing agent's given-up mail has, is left where it is.
fn step_from(
    w: &StoreWriter<'_>,
    id: &str,
    from: &[MailboxState],
    change: MailChange,
) -> Result<bool, AppendError> {
    let Some(message) = MessageId::parse(id) else {
        return Ok(false);
    };
    let state = w.reads().message(id)?.map(|m| m.state);
    if !state.is_some_and(|state| from.contains(&state)) {
        return Ok(false);
    }
    w.mail_step(&message, change)?;
    Ok(true)
}

#[cfg(test)]
mod tests;
