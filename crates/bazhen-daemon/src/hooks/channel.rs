//! What a harness's own server tells of the agents it serves, applied as their hooks' facts are:
//! each in its agent's turn, through the same appliers. What it tells of the account goes to every
//! agent it serves, and a message it says a turn took is confirmed by the message, not the session.

use std::sync::Arc;

use bazhen_harness::{HarnessId, Key, Keyed, Observed, Origin, SessionKey};
use bazhen_protocol::agents::UsageLimit;
use bazhen_protocol::ids::{AgentId, AttentionId, MessageId};
use bazhen_protocol::mail::MailboxState;
use bazhen_protocol::mail_events::AttentionClosedReason;
use bazhen_store::MailChange;

use super::{Hooks, Passes, Source, settled_for, write};
use crate::routes::Shared;

/// What a server's report passes: none of a hook's gates, which tell an agent's own session from
/// another that ran its hook. A server names the session it speaks of.
const SERVED: Passes = Passes {
    in_session: false,
    owner: false,
    started_here: false,
};

/// The one agent `harness`'s server serves on `session`, none where there is none or two.
///
/// # Errors
///
/// The store's.
pub(crate) async fn served_on(
    shared: &Shared,
    harness: HarnessId,
    session: &SessionKey,
) -> Result<Option<AgentId>, String> {
    let session = session.0.clone();
    let id = shared
        .store
        .run(move |store| store.reads().served_on(harness, &session))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    Ok(id.as_deref().and_then(AgentId::parse))
}

impl Hooks {
    /// Applies what one report from `harness`'s server says, in order: each fact of a session to
    /// the agent served on it, and none to no agent's; the account's limits to every agent it
    /// serves; and a message a turn took, by the message. `routed` is the session the report was
    /// routed to and the agent found served on it, which its facts of that session go to, so that
    /// one report is never split between two agents by a binding moved meanwhile. A request the
    /// server settled closes the item it asked, by the request, whichever agent the item is of.
    /// Answers the item a request in the report opened, or asked again, for its request to be held.
    ///
    /// # Errors
    ///
    /// The store's, or an applier's; the facts before it are applied.
    pub(crate) async fn channel(
        &self,
        shared: &Shared,
        harness: HarnessId,
        observed: Vec<Keyed>,
        routed: Option<(&SessionKey, Option<&AgentId>)>,
    ) -> Result<Option<AttentionId>, String> {
        let mut asked = None;
        let origin = Origin {
            session: None,
            transcript: None,
            subagent: None,
        };
        for keyed in observed {
            let agent = match (&keyed.key, &keyed.fact) {
                (Key::Account, Observed::AccountLimits(update)) => {
                    self.account(shared, harness, update.clone()).await?;
                    continue;
                }
                (Key::Account, _) => continue,
                (Key::Session(session), Observed::MailTaken { message_id }) => {
                    taken(shared, harness, session, message_id).await?;
                    continue;
                }
                // By the request: its thread may have no agent on it now, or another.
                (Key::Session(_), Observed::ApprovalSettled { key, how }) => {
                    let ids = self.approvals.served_matching(harness, key);
                    let reason = settled_for(*how);
                    self.approvals.settle(&shared.store, ids, reason).await?;
                    continue;
                }
                (Key::Session(session), _) => match routed {
                    Some((on, agent)) if on == session => agent.cloned(),
                    _ => served_on(shared, harness, session).await?,
                },
                (Key::Agent(agent), _) => Some(agent.clone()),
            };
            let Some(agent) = agent else {
                // Asked again where it can't be routed: what was held for it may not be answered.
                if let Observed::ApprovalAsked { key, .. } | Observed::QuestionAsked { key, .. } =
                    &keyed.fact
                {
                    self.approvals.unhold(harness, key);
                }
                continue;
            };
            let one = Keyed {
                key: Key::Agent(agent.clone()),
                ..keyed
            };
            let turn = self.turn_of(&agent);
            let applied = {
                let _held = turn.lock().await;
                let source = Source::Server(harness);
                self.apply(shared, &agent, source, &origin, (SERVED, None), &[one])
                    .await
            };
            self.release(&agent, turn);
            asked = applied?.or(asked);
        }
        Ok(asked)
    }

    /// `harness`'s server is connected again, and has asked again each request it still holds:
    /// each item it asked before and hasn't asked again is stale, as the server that held its
    /// request is gone.
    ///
    /// # Errors
    ///
    /// The store's.
    pub(crate) async fn connected(
        &self,
        shared: &Shared,
        harness: HarnessId,
    ) -> Result<(), String> {
        let ids = self.approvals.not_asked_again(harness);
        let stale = AttentionClosedReason::Stale;
        self.approvals.settle(&shared.store, ids, stale).await
    }

    /// Records an update of the account's limits for every agent `harness`'s server serves, as
    /// each shares the account.
    async fn account(
        &self,
        shared: &Shared,
        harness: HarnessId,
        update: Vec<UsageLimit>,
    ) -> Result<(), String> {
        let (limits, now) = (Arc::clone(&self.limits), jiff::Timestamp::now());
        write(&shared.store, move |w| {
            let served = w.reads().served_agents(harness)?;
            let agents: Vec<AgentId> = served.iter().filter_map(|id| AgentId::parse(id)).collect();
            limits.account_limits(w, &agents, &update, now)
        })
        .await
    }
}

/// Confirms the message `message_id` delivered, as `harness`'s server says a turn on `session`
/// took it, while it is still queued for a live agent of that harness's: when that agent is the
/// one served on the session, or no agent is and the server already held the message, as one it
/// held for a session the agent has since moved off is still taken there. A session another
/// agent is on, or two are, confirms nothing of this one's, whatever its turn quotes. A message
/// confirmed already, or never queued, is left as it is.
///
/// # Errors
///
/// The store's.
async fn taken(
    shared: &Shared,
    harness: HarnessId,
    session: &SessionKey,
    message_id: &str,
) -> Result<(), String> {
    let Some(message) = MessageId::parse(message_id) else {
        tracing::debug!("bazhen: a turn took {message_id:?}, which no message could be");
        return Ok(());
    };
    let session = session.0.clone();
    write(&shared.store, move |w| {
        let reads = w.reads();
        let Some(queued) = reads.message(message.as_str())? else {
            return Ok(());
        };
        let held = match queued.state {
            MailboxState::Queued => false,
            MailboxState::QueuedInCodex => true,
            _ => return Ok(()),
        };
        let live = reads.agent_binding(&queued.agent)?.is_some_and(|binding| {
            binding.harness == harness.as_str()
                && matches!(binding.state.as_str(), "starting" | "running")
        });
        if !live {
            return Ok(());
        }
        let owners = reads.served_by(harness, &session)?;
        let own = owners == [queued.agent.as_str()];
        if own || (owners.is_empty() && held) {
            w.mail_step(&message, MailChange::Delivered)?;
        }
        Ok(())
    })
    .await
}
