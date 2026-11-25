//! The agents' watch (`agents/server-watch.ts`): each tick reads the runtime's agents and settles,
//! as a start's reconcile does, every agent the store has as possibly running that the runtime
//! doesn't list, or whose start or close hasn't finished, so a holder that dies under the daemon
//! leaves its agent lost, and a start with no clear answer is settled on what runs. One a command
//! holds is that command's, and is left for the next tick. A whole tick's failure, and what each
//! agent left unsettled, is said once while it lasts.

use std::collections::{BTreeSet, HashMap};
use std::sync::PoisonError;

use bazhen_protocol::agents::AgentState;
use bazhen_protocol::ids::AgentId;
use bazhen_store::{Actor, AgentTerminal};

use super::{After, Cause, Listed, Unsettled};
use crate::agents::Agents;
use crate::agents::lifecycle::{Doing, from_runtime, record_closed, recorded};
use crate::shells::RUNTIME;
use crate::terminals::{FoundAgent, Recorded};

/// The longest wait, in ticks, before the runtime's reach is read again after a reading that
/// wasn't reachable: five minutes of five-second ticks.
const MAX_BACKOFF: u32 = 60;

/// What the watch carries from one tick to the next.
#[derive(Debug)]
pub(crate) struct Ticking {
    /// Ticks left before the runtime's reach is read again.
    wait: u32,
    /// The wait the last reading that wasn't reachable set, which the next one doubles.
    backoff: u32,
    /// Whether the last reading was reachable.
    reachable: bool,
    /// What was last said of each agent left unsettled.
    said: HashMap<String, String>,
    /// The last failure of a whole tick.
    fault: Option<String>,
}

impl Default for Ticking {
    fn default() -> Self {
        Self {
            wait: 0,
            backoff: 0,
            reachable: true,
            said: HashMap::new(),
            fault: None,
        }
    }
}

impl Ticking {
    /// Whether the runtime's reach is read this tick. A reading that isn't reachable may have
    /// told a holder to bind its socket again, so the next waits, each such reading twice as
    /// long as the last.
    fn reach_due(&mut self) -> bool {
        if self.wait == 0 {
            return true;
        }
        self.wait -= 1;
        false
    }

    /// Takes a reading of the runtime's reach, saying only what changed.
    fn reached(&mut self, reachable: bool) {
        self.backoff = if reachable {
            0
        } else {
            (self.backoff * 2).clamp(1, MAX_BACKOFF)
        };
        self.wait = self.backoff.saturating_sub(1);
        if reachable != self.reachable {
            if reachable {
                tracing::info!("bazhen: watch: the {RUNTIME} runtime is reachable again");
            } else {
                tracing::warn!("bazhen: watch: the {RUNTIME} runtime isn't reachable");
            }
        }
        self.reachable = reachable;
    }

    /// Says `what` of agent `id`, unless it was the last thing said of it.
    fn say(&mut self, id: &str, what: String) {
        if self.said.get(id) != Some(&what) {
            tracing::warn!("bazhen: watch: {what}");
        }
        self.said.insert(id.to_owned(), what);
    }
}

impl Agents {
    /// One tick of the watch, then the waiters of agents a close missed are answered. Never
    /// fails: what it can't do it says, once while it lasts, and the next tick tries again.
    pub(crate) async fn tick(&self) {
        let fault = self.check().await.err();
        {
            let mut unreconciled = self.unreconciled();
            let ticking = &mut unreconciled.watch;
            if let Some(fault) = &fault
                && ticking.fault.as_ref() != Some(fault)
            {
                tracing::warn!("bazhen: watch: {fault}");
            }
            ticking.fault = fault;
        }
        self.deps.hooks.release_closed(&self.deps.store).await;
    }

    /// Settles each agent of this runtime that may need it, then closes the holders no agent
    /// runs in.
    async fn check(&self) -> Result<(), String> {
        let agents: Vec<AgentTerminal> = self
            .write(|w| Ok(w.reads().recoverable_agents()?))
            .await
            .map_err(|err| format!("could not read the agents: {err}"))?
            .into_iter()
            .filter(|agent| {
                agent
                    .runtime_kind
                    .as_deref()
                    .is_none_or(|kind| kind == RUNTIME)
            })
            .collect();
        if self.unreconciled().watch.reach_due() {
            let known: Vec<Recorded> = agents.iter().filter_map(recorded).collect();
            let reachable = self.deps.terminals.reachable(&known).await;
            self.unreconciled().watch.reached(reachable);
        }
        let read = self
            .deps
            .terminals
            .agents()
            .await
            .map_err(|err| format!("could not read the {RUNTIME} agents: {err}"))?;
        let mut orphans = read.found.clone();
        let listed = Listed::from(read);
        // What a start's reconcile couldn't settle was left by a daemon that died.
        let restarted: BTreeSet<String> = self.unreconciled_ids().into_iter().collect();
        let mut kept = BTreeSet::new();
        // What the close step closed this tick, which the orphans' read still lists.
        let mut closed = Vec::new();
        for agent in &agents {
            let id = &agent.agent_id;
            let found = agent
                .terminal_id
                .as_ref()
                .and_then(|terminal| listed.found.get(terminal));
            let cause = if restarted.contains(id.as_str()) {
                Cause::Restart
            } else {
                Cause::Unconfirmed
            };
            let settled = match (agent.state, found) {
                (AgentState::Closing, Some(found)) => {
                    let done = self.close_found(id, found).await;
                    if done.is_ok() {
                        closed.push(found.terminal.terminal_id.clone());
                    }
                    done
                }
                (AgentState::Starting, _) | (_, None) => self.settle_now(id, &listed, cause).await,
                _ => Ok(()),
            };
            let mut unreconciled = self.unreconciled();
            match settled {
                Ok(()) => {
                    unreconciled.watch.said.remove(id.as_str());
                }
                Err(unsettled) => {
                    kept.insert(id.as_str().to_owned());
                    if let Some(what) = unsettled.said(id.as_str()) {
                        unreconciled.watch.say(id.as_str(), what);
                    }
                }
            }
        }
        {
            let mut unreconciled = self.unreconciled();
            let was = unreconciled.kept.len();
            unreconciled.kept.retain(|id| kept.contains(id));
            if was > 0 && unreconciled.kept.is_empty() {
                tracing::info!("bazhen: reconcile: settled the agents it couldn't at start");
            }
        }
        orphans.retain(|found| !closed.contains(&found.terminal.terminal_id));
        self.close_orphans_among(orphans).await;
        Ok(())
    }

    /// Closes the holder found for agent `id`, which is closing: one its close left running, as
    /// one that couldn't be closed then, is closed now, and the agent recorded closed. In its
    /// turn if no command holds it, and only while it is still closing on that terminal.
    async fn close_found(&self, id: &AgentId, found: &FoundAgent) -> Result<(), Unsettled> {
        let Some(_turn) = self.deps.turns.try_take(id.as_str()) else {
            return Err(Unsettled::Busy);
        };
        let terminal = found.terminal.terminal_id.clone();
        let closing = move |now: Option<AgentTerminal>| {
            now.is_some_and(|now| {
                now.state == AgentState::Closing && now.terminal_id.as_ref() == Some(&terminal)
            })
        };
        let was = {
            let id = id.clone();
            self.write(move |w| Ok(w.reads().agent_terminal(id.as_str())?))
                .await?
        };
        if !closing.clone()(was) {
            return Err(Unsettled::Moved);
        }
        self.deps
            .terminals
            .close(&found.terminal)
            .await
            .map_err(|cause| Unsettled::Failed(from_runtime(id.as_str(), Doing::Close, cause)))?;
        let after = {
            let id = id.clone();
            self.write(move |w| {
                if !closing(w.reads().agent_terminal(id.as_str())?) {
                    return Ok(After::Nothing);
                }
                record_closed(w, &id, Actor::System)?;
                Ok(After::Closed)
            })
            .await?
        };
        if after == After::Closed {
            self.after_closed(id).await;
        }
        Ok(())
    }

    fn unreconciled(&self) -> std::sync::MutexGuard<'_, super::Unreconciled> {
        self.unreconciled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}
