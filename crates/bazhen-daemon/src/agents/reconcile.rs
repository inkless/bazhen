//! What a restarted daemon makes of its agents (`agents/reconcile.ts`): each the store records is
//! matched against what the runtime runs by its current terminal, never by the agent a terminal
//! is tagged for, so a holder a dead daemon left starting for it isn't taken for its start. An
//! agent is concluded on only by what was read of its own terminal: one whose holder can't be
//! read is left, and the rest settle all the same. One the runtime doesn't list is ended only
//! once what ran it is provably gone, or, its start having recorded nothing to prove that by,
//! once nothing has answered for it long after anything could start it. What a start couldn't
//! settle is tried again each tick, and only that, each in its agent's turn if no command holds
//! it.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::PoisonError;

use bazhen_protocol::agent_events::{
    AgentFailed, AgentFailedReason, AgentRelaunchRejected, AgentRespawnRejected, AgentRestarted,
    AgentRunning, RelaunchRejectedReason, RespawnRejectedReason,
};
use bazhen_protocol::agents::{AgentState, ExternalRef};
use bazhen_protocol::ids::{AgentId, TerminalId};
use bazhen_protocol::shells::TerminalState;
use bazhen_store::{Actor, AgentChange, AgentTerminal, Writer as StoreWriter};

use super::lifecycle::{append, exited_at, record_closed, recorded};
use super::watch::{adopt, losable, runtime_ref};
use super::{AgentError, Agents};
use crate::shells::{RUNTIME, generation_of, locator_of};
use crate::terminals::{AgentsFound, FoundAgent, Recorded};
use crate::tokens::unheld;

/// The agents a start read and couldn't settle yet, and what the last try of them said, so a
/// failure that lasts is said once.
#[derive(Debug, Default)]
pub(crate) struct Unreconciled {
    kept: BTreeSet<String>,
    said: Vec<String>,
}

/// Why an agent wasn't settled this time. Each is tried again.
#[derive(Debug)]
enum Unsettled {
    /// A command holds its turn: it is that command's now, and is tried again once it isn't.
    Busy,
    /// It moved between its read and its write: what moved it went first.
    Moved,
    /// Its terminal's holder is there but couldn't be read.
    Unread,
    /// The runtime doesn't list its terminal, and what ran it isn't proven gone.
    Unproven,
    /// The store or the runtime failed.
    Failed(AgentError),
}

impl From<AgentError> for Unsettled {
    fn from(err: AgentError) -> Self {
        Self::Failed(err)
    }
}

/// What one try of the kept agents left: those to try again, and what it said of them.
#[derive(Default)]
struct Tried {
    kept: BTreeSet<String>,
    said: Vec<String>,
}

/// What one read of the runtime listed of the agents' terminals, by terminal.
struct Listed {
    found: HashMap<TerminalId, FoundAgent>,
    unreadable: HashSet<TerminalId>,
}

impl From<AgentsFound> for Listed {
    fn from(read: AgentsFound) -> Self {
        Self {
            found: read
                .found
                .into_iter()
                .map(|found| (found.terminal.terminal_id.clone(), found))
                .collect(),
            unreadable: read.unreadable.into_iter().collect(),
        }
    }
}

/// Whether an agent in `state` may still be running, as `recoverable_agents` reads them.
fn recoverable(state: AgentState) -> bool {
    !matches!(
        state,
        AgentState::Lost | AgentState::Closed | AgentState::Failed
    )
}

/// The generation `at` runs, where its locator names one.
fn generation_at(at: &Recorded) -> Option<u64> {
    locator_of(at).and_then(|locator| generation_of(&locator))
}

/// The harness session a start found running is on: the one the agent is bound to by now, or
/// else the one its terminal was started with.
fn session_of(
    w: &StoreWriter<'_>,
    agent: &AgentId,
    found: &FoundAgent,
) -> Result<Option<ExternalRef>, AgentError> {
    Ok(bound(w, agent)?.or_else(|| {
        found
            .harness_session
            .as_deref()
            .and_then(|tag| serde_json::from_str(tag).ok())
    }))
}

/// The harness session `agent` is bound to.
fn bound(w: &StoreWriter<'_>, agent: &AgentId) -> Result<Option<ExternalRef>, AgentError> {
    Ok(w.reads()
        .agent_launch(agent.as_str())?
        .and_then(|launch| launch.external_ref))
}

/// The harness session a relaunch found running is on, as `Done::recorded` takes it: the one the
/// agent is bound to, if its binding moved since the request, as a quick /clear moves it; else
/// the one its new terminal was started with, if any, which a fresh relaunch's isn't bound to
/// yet.
fn relaunched_on(
    w: &StoreWriter<'_>,
    agent: &AgentId,
    found: &FoundAgent,
) -> Result<Option<ExternalRef>, AgentError> {
    let reads = w.reads();
    let asked = reads.last_event_id(agent.as_str(), "agent.relaunch_requested")?;
    let moved = reads.last_event_id(agent.as_str(), "agent.external_ref_updated")?;
    let bound = bound(w, agent)?;
    let tagged = found
        .harness_session
        .as_deref()
        .and_then(|tag| serde_json::from_str(tag).ok());
    Ok(match (moved, asked) {
        (Some(moved), Some(asked)) if moved > asked => bound,
        _ => tagged,
    })
}

/// A start again the runtime shows went ahead on `session`, as `respawned` or `relaunched`
/// records it.
fn restarted(
    found: &FoundAgent,
    session: Option<ExternalRef>,
) -> Result<AgentRestarted, AgentError> {
    Ok(AgentRestarted {
        external_ref: session,
        runtime_ref: runtime_ref(&found.terminal)?,
        theme: None,
        harness_name: None,
        prompt_hash: None,
    })
}

/// Records the exit of a process found ended, by `told`'s rule: only at the generation recorded,
/// by a terminal whose state takes one.
fn exited_if_dead(w: &StoreWriter<'_>, found: &FoundAgent) -> Result<(), AgentError> {
    if let (Some(status), Some(generation)) = (&found.exit, generation_at(&found.terminal)) {
        exited_at(w, &found.terminal.terminal_id, generation, status)?;
    }
    Ok(())
}

/// Whether `found`, a holder tagged for an agent, runs in no terminal its agent runs in now, by
/// what the store says of its terminal, `row`, and of that agent with its current terminal: a
/// terminal the store never recorded, one its agent has left or that has ended, or one of an
/// agent closed or failed. A row of another agent than its tag names is left: what it is isn't
/// known.
fn orphaned(
    found: &FoundAgent,
    row: Option<&AgentTerminal>,
    current: Option<&AgentTerminal>,
) -> bool {
    let Some(row) = row else {
        return true;
    };
    if row.agent_id != found.agent_id {
        return false;
    }
    let ended = |state| {
        matches!(
            state,
            Some(TerminalState::Closed | TerminalState::Failed | TerminalState::Lost)
        )
    };
    current.is_none_or(|current| {
        current.terminal_id != row.terminal_id
            || matches!(current.state, AgentState::Closed | AgentState::Failed)
            || ended(row.terminal_state)
    })
}

/// What follows a settle once it commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum After {
    Nothing,
    /// No start went ahead, nor will: no file of its token is read again.
    Unstarted,
    /// It closed.
    Closed,
}

/// A start the runtime shows went ahead, on the token its start was given: the agent's bare id
/// no longer names it. The files of earlier starts' tokens are left for its close: none names
/// it now.
fn started(w: &StoreWriter<'_>, agent: &AgentId, change: AgentChange) -> Result<After, AgentError> {
    append(w, agent, Actor::System, change)?;
    w.kept_agent_token(agent.as_str())?;
    Ok(After::Nothing)
}

/// One agent's events, from what the store says of it and what its terminal shows, in the
/// caller's transaction (`settle`), and what follows them. `unheld` is the hash of a token no
/// one holds, which a relaunch that never started leaves the agent with: its process may yet
/// start, and must not speak for it.
fn settle(
    w: &StoreWriter<'_>,
    agent: &AgentTerminal,
    found: Option<&FoundAgent>,
    unheld: &str,
) -> Result<After, AgentError> {
    let id = &agent.agent_id;
    let system = |change| append(w, id, Actor::System, change).map(drop);
    match (agent.state, agent.terminal_state) {
        (AgentState::Starting, Some(TerminalState::Creating))
            if w.reads()
                .last_event_id(id.as_str(), "agent.relaunch_requested")?
                .is_some() =>
        {
            // The daemon died mid-relaunch: the new terminal runs it, or the agent is lost
            // again, never failed, as a relaunch that can't start leaves it.
            let Some(found) = found else {
                system(AgentChange::RelaunchRejected(AgentRelaunchRejected {
                    reason: RelaunchRejectedReason::DaemonRestart,
                    detail: None,
                }))?;
                w.note_agent_token(id.as_str(), unheld)?;
                return Ok(After::Unstarted);
            };
            let after = started(
                w,
                id,
                AgentChange::Relaunched(restarted(found, relaunched_on(w, id, found)?)?),
            )?;
            exited_if_dead(w, found)?;
            Ok(after)
        }
        (AgentState::Starting, Some(TerminalState::Creating)) => {
            // The daemon died mid-launch: its terminal runs it, or there is none.
            let Some(found) = found else {
                system(AgentChange::Failed(AgentFailed {
                    reason: AgentFailedReason::DaemonRestart,
                    detail: None,
                }))?;
                return Ok(After::Unstarted);
            };
            let running = AgentChange::Running(AgentRunning {
                external_ref: session_of(w, id, found)?,
                runtime_ref: Some(runtime_ref(&found.terminal)?),
                theme: None,
                harness_name: None,
            });
            let after = started(w, id, running)?;
            exited_if_dead(w, found)?;
            Ok(after)
        }
        (AgentState::Starting, Some(TerminalState::Exited)) if agent.generation.is_some() => {
            // The daemon died mid-respawn. The generation is written before the new process
            // starts, so the next one means it started. It resumed the bound session in the same
            // terminal, whose tag still names the session it was created on.
            let next = agent.generation.map(|generation| generation + 1);
            if let Some(found) = found.filter(|found| generation_at(&found.terminal) == next) {
                let after = started(
                    w,
                    id,
                    AgentChange::Respawned(restarted(found, bound(w, id)?)?),
                )?;
                exited_if_dead(w, found)?;
                return Ok(after);
            }
            // Its token is kept: a process that starts late in the same terminal is its own,
            // and is adopted.
            system(AgentChange::RespawnRejected(AgentRespawnRejected {
                reason: RespawnRejectedReason::DaemonRestart,
                detail: None,
            }))?;
            let Some(found) = found else {
                system(AgentChange::Lost)?;
                return Ok(After::Nothing);
            };
            if let Some(now) = w.reads().agent_terminal(id.as_str())? {
                adopt(w, &now, &found.terminal)?;
            }
            exited_if_dead(w, found)?;
            Ok(After::Nothing)
        }
        _ => match found {
            Some(found) => {
                adopt(w, agent, &found.terminal)?;
                exited_if_dead(w, found)?;
                Ok(After::Nothing)
            }
            None if losable(agent) => {
                system(AgentChange::Lost)?;
                Ok(After::Nothing)
            }
            None if agent.state == AgentState::Closing => {
                record_closed(w, id, Actor::System)?;
                Ok(After::Closed)
            }
            None => Ok(After::Nothing),
        },
    }
}

impl Agents {
    /// Matches the runtime's agents against the store's, before anything else acts on them: run
    /// it before the runtime's events are followed, mail is requeued, and commands are taken.
    /// What it can't settle, `reconcile_again` tries again.
    ///
    /// # Errors
    ///
    /// When the store can't be read: no agent is known to settle.
    pub(crate) async fn reconcile(&self) -> Result<(), AgentError> {
        let kept = self.write(|w| Ok(w.reads().recoverable_agents()?)).await?;
        let (ours, unrouted): (Vec<AgentTerminal>, Vec<AgentTerminal>) =
            kept.into_iter().partition(|agent| {
                agent
                    .runtime_kind
                    .as_deref()
                    .is_none_or(|kind| kind == RUNTIME)
            });
        for agent in &unrouted {
            tracing::warn!(
                "bazhen: reconcile: agent {}'s terminal is on {}, which this daemon doesn't run",
                agent.agent_id,
                agent.runtime_kind.as_deref().unwrap_or_default()
            );
        }
        self.unreconciled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .kept = ours
            .iter()
            .map(|agent| agent.agent_id.as_str().to_owned())
            .collect();
        self.settle_kept().await;
        self.close_orphans().await;
        Ok(())
    }

    /// Closes each holder tagged for an agent that no agent runs in: one a start the daemon never
    /// saw through left, which would otherwise run a second process on its agent's session. Each
    /// is weighed in its agent's turn, on what the store says after the runtime was read, so a
    /// start that recorded its terminal meanwhile keeps it. One whose agent is busy, or whose
    /// close fails, is left for the next try.
    async fn close_orphans(&self) {
        let found = match self.deps.terminals.agents().await {
            Ok(read) => read.found,
            Err(err) => {
                tracing::warn!("bazhen: reconcile: could not read the {RUNTIME} agents: {err}");
                return;
            }
        };
        for found in found {
            let Some(_turn) = self.deps.turns.try_take(found.agent_id.as_str()) else {
                continue;
            };
            let terminal = found.terminal.terminal_id.clone();
            let read = {
                let terminal = terminal.clone();
                self.write(move |w| {
                    let reads = w.reads();
                    let row = reads.agent_with_terminal(terminal.as_str())?;
                    let current = match &row {
                        Some(row) => reads.agent_terminal(row.agent_id.as_str())?,
                        None => None,
                    };
                    Ok((row, current))
                })
                .await
            };
            let (row, current) = match read {
                Ok(read) => read,
                Err(err) => {
                    tracing::warn!("bazhen: reconcile: could not read terminal {terminal}: {err}");
                    continue;
                }
            };
            if !orphaned(&found, row.as_ref(), current.as_ref()) {
                continue;
            }
            match self.deps.terminals.close(&found.terminal).await {
                Ok(()) => tracing::info!(
                    "bazhen: reconcile: closed terminal {terminal}, which agent {} no longer runs in",
                    found.agent_id
                ),
                Err(err) => tracing::warn!(
                    "bazhen: reconcile: terminal {terminal} runs for agent {}, which no longer runs in it, and can't be closed: {err}",
                    found.agent_id
                ),
            }
        }
    }

    /// Tries again each agent the start's reconcile couldn't settle, saying once when the last
    /// of them is.
    pub(crate) async fn reconcile_again(&self) {
        if self.unreconciled_ids().is_empty() {
            return;
        }
        if self.settle_kept().await {
            tracing::info!("bazhen: reconcile: settled the agents it couldn't at start");
        }
    }

    fn unreconciled_ids(&self) -> Vec<String> {
        let unreconciled = self
            .unreconciled
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        unreconciled.kept.iter().cloned().collect()
    }

    /// Settles the kept agents it can, keeping the rest, and says what the last try didn't.
    /// Whether none is left.
    async fn settle_kept(&self) -> bool {
        let tried = self.try_kept(self.unreconciled_ids()).await;
        let mut unreconciled = self
            .unreconciled
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for said in &tried.said {
            if !unreconciled.said.contains(said) {
                tracing::warn!("bazhen: reconcile: {said}");
            }
        }
        unreconciled.kept = tried.kept;
        unreconciled.said = tried.said;
        unreconciled.kept.is_empty()
    }

    async fn try_kept(&self, ids: Vec<String>) -> Tried {
        let all: BTreeSet<String> = ids.iter().cloned().collect();
        let read = self
            .write(move |w| {
                let reads = w.reads();
                let mut agents = Vec::new();
                for id in &ids {
                    agents.extend(reads.agent_terminal(id)?);
                }
                Ok(agents)
            })
            .await;
        let agents: Vec<AgentTerminal> = match read {
            Ok(agents) => agents
                .into_iter()
                .filter(|agent| recoverable(agent.state))
                .collect(),
            Err(err) => {
                return Tried {
                    kept: all,
                    said: vec![format!("could not read the agents: {err}")],
                };
            }
        };
        if agents.is_empty() {
            return Tried::default();
        }
        // Asked for what it does to a holder that lost its socket, which binds again: whether
        // the runtime is reachable as a whole concludes nothing about any one agent.
        let known: Vec<Recorded> = agents.iter().filter_map(recorded).collect();
        self.deps.terminals.reachable(&known).await;
        let listed = match self.deps.terminals.agents().await {
            Ok(read) => Listed::from(read),
            Err(err) => {
                return Tried {
                    kept: all,
                    said: vec![format!(
                        "could not read the {RUNTIME} agents: {err}; trying again each tick"
                    )],
                };
            }
        };
        let mut tried = Tried::default();
        for agent in &agents {
            let id = agent.agent_id.as_str();
            let said = match self.settle_now(&agent.agent_id, &listed).await {
                Ok(()) => continue,
                Err(Unsettled::Busy | Unsettled::Moved) => None,
                Err(Unsettled::Unread) => Some(format!(
                    "agent {id}'s terminal can't be read just now; trying again each tick"
                )),
                Err(Unsettled::Unproven) => Some(format!(
                    "agent {id}'s terminal may still run on its old holder; trying again each tick"
                )),
                Err(Unsettled::Failed(err)) => Some(format!("could not settle agent {id}: {err}")),
            };
            tried.kept.insert(id.to_owned());
            tried.said.extend(said);
        }
        tried
    }

    /// Settles agent `id` as it is now, in its turn if no command holds it: one a command or an
    /// event moved meanwhile is left for the next try, and one it ended is left as it is.
    async fn settle_now(&self, id: &AgentId, listed: &Listed) -> Result<(), Unsettled> {
        let Some(_turn) = self.deps.turns.try_take(id.as_str()) else {
            return Err(Unsettled::Busy);
        };
        let was = {
            let id = id.clone();
            self.write(move |w| Ok(w.reads().agent_terminal(id.as_str())?))
                .await?
        };
        let Some(was) = was.filter(|agent| recoverable(agent.state)) else {
            return Ok(());
        };
        let terminal = was.terminal_id.clone();
        if terminal
            .as_ref()
            .is_some_and(|terminal| listed.unreadable.contains(terminal))
        {
            return Err(Unsettled::Unread);
        }
        let found = terminal
            .as_ref()
            .and_then(|terminal| listed.found.get(terminal))
            .cloned();
        if found.is_none() && !self.absent(&was).await {
            return Err(Unsettled::Unproven);
        }
        let unheld = unheld().map_err(|err| {
            AgentError::Internal(format!("no token can be made that no one holds: {err}"))
        })?;
        let after = self
            .write(
                move |w| match w.reads().agent_terminal(was.agent_id.as_str())? {
                    Some(now) if now == was => settle(w, &now, found.as_ref(), &unheld).map(Some),
                    Some(now) if recoverable(now.state) => Ok(None),
                    _ => Ok(Some(After::Nothing)),
                },
            )
            .await?;
        match after.ok_or(Unsettled::Moved)? {
            After::Nothing => {}
            After::Unstarted => self.deps.tokens.forget(id),
            After::Closed => self.after_closed(id).await,
        }
        Ok(())
    }

    /// Whether what ran `agent`'s terminal is provably gone, the runtime not listing it: by what
    /// its start recorded, or, where it recorded nothing yet, by nothing answering long after
    /// anything could start it. An agent with no terminal has nothing to prove gone.
    async fn absent(&self, agent: &AgentTerminal) -> bool {
        if let Some(at) = recorded(agent) {
            return self.deps.terminals.gone(&at).await;
        }
        match (&agent.terminal_id, agent.terminal_state) {
            (None, _) => true,
            (Some(terminal), Some(TerminalState::Creating)) => {
                let since = self.unstartable_since(terminal);
                self.deps.terminals.unstarted(terminal, since).await
            }
            (Some(_), _) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::sync::Arc;
    use std::time::Duration;

    use bazhen_harness::BoxFuture;
    use bazhen_protocol::agents::{CloseAgentRequest, RelaunchAgentRequest, RespawnAgentRequest};
    use serde_json::json;
    use tokio::sync::Semaphore;
    use tokio_util::task::TaskTracker;

    use super::*;
    use crate::agents::restart::tests::{exited, lost};
    use crate::agents::tests::{Fixture, request, setup_with};
    use crate::terminals::Event;
    use crate::terminals::fake::{Held, recorded_at};
    use crate::testing::runtime;
    use crate::testing::stub_harness::{STUB_SESSION, StubHarness, pull};

    /// A terminal no agent was made for.
    const STRAY: &str = "term_0190a1b2c3d47abc8def0123456789ff";

    /// Runs `command` on a task of its own until it records an event of `kind`, then ends it
    /// there, as a daemon that died there would.
    fn stopped_at<F>(f: &Fixture, kind: &str, command: F)
    where
        F: Future + Send + 'static,
        F::Output: Send,
    {
        let count = || f.types().iter().filter(|k| *k == kind).count();
        let before = count();
        runtime().block_on(async {
            let task = TaskTracker::new().spawn(command);
            for _ in 0..400 {
                if count() > before {
                    task.abort();
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            panic!("{kind} was never recorded: {:?}", f.types());
        });
    }

    /// A `replaced` that never answers, so a command waits there.
    fn never(_: AgentId) -> BoxFuture<'static, ()> {
        Box::pin(std::future::pending())
    }

    /// Agents whose creates wait until the test lets them through, as none here does.
    fn held_creates() -> Fixture {
        let f = setup_with(crate::agents::tests::Setup::default());
        f.fake()
            .set(|state| state.hold_creates = Some(Arc::new(Semaphore::new(0))));
        f
    }

    /// A launch keyed `key` that a daemon died in while its create was asked for.
    fn mid_launch(f: &Fixture, key: &str) -> AgentId {
        let (agents, req) = (Arc::clone(&f.agents), request(key));
        stopped_at(
            f,
            "agent.launched",
            async move { agents.launch(&req).await },
        );
        newest(f)
    }

    /// A relaunch of lost `agent` that a daemon died in once it was requested.
    fn mid_relaunch(f: &Fixture, agent: &AgentId, generation: u64) {
        mid_relaunch_as(f, agent, generation, None);
    }

    /// The same, `fresh` as asked.
    fn mid_relaunch_as(f: &Fixture, agent: &AgentId, generation: u64, fresh: Option<bool>) {
        let (agents, id) = (Arc::clone(&f.agents), agent.as_str().to_owned());
        let req = RelaunchAgentRequest {
            idempotency_key: "r-1".to_owned(),
            generation,
            theme: None,
            fresh,
        };
        stopped_at(f, "agent.relaunch_requested", async move {
            agents.relaunch(&id, &req, never).await
        });
    }

    /// A respawn of exited `agent` that a daemon died in once it was requested.
    fn mid_respawn(f: &Fixture, agent: &AgentId, generation: u64) {
        let (agents, id) = (Arc::clone(&f.agents), agent.as_str().to_owned());
        let req = RespawnAgentRequest {
            idempotency_key: "s-1".to_owned(),
            generation,
            theme: None,
        };
        stopped_at(f, "agent.respawn_requested", async move {
            agents.respawn(&id, &req, never).await
        });
    }

    /// The agent launched last.
    fn newest(f: &Fixture) -> AgentId {
        let reader = f.store.reader().unwrap();
        let agents = reader.reads().recoverable_agents().unwrap();
        agents.last().unwrap().agent_id.clone()
    }

    fn agent(f: &Fixture, agent: &AgentId) -> AgentTerminal {
        let reader = f.store.reader().unwrap();
        let found = reader.reads().agent_terminal(agent.as_str()).unwrap();
        found.unwrap()
    }

    fn state(f: &Fixture, id: &AgentId) -> AgentState {
        agent(f, id).state
    }

    fn starting_terminals(f: &Fixture) -> u64 {
        let reader = f.store.reader().unwrap();
        reader.reads().starting_terminals().unwrap()
    }

    fn token_hash(f: &Fixture, agent: &AgentId) -> Option<String> {
        let reader = f.store.reader().unwrap();
        reader.reads().agent_token_hash(agent.as_str()).unwrap()
    }

    fn closed(f: &Fixture) -> Vec<String> {
        let mut closed = Vec::new();
        f.fake().set(|state| closed.clone_from(&state.closed));
        closed
    }

    fn reconciled(agents: &Agents) {
        runtime().block_on(agents.reconcile()).unwrap();
    }

    /// The events `then` records, by type.
    fn recorded(f: &Fixture, then: impl FnOnce()) -> Vec<String> {
        let before = f.types().len();
        then();
        f.types().split_off(before)
    }

    /// An agent launched in full, and its terminal.
    fn launched(f: &Fixture, key: &str) -> (AgentId, String) {
        let agent = runtime().block_on(f.launch(request(key))).unwrap().agent_id;
        let terminal = f.terminal_of(agent.as_str());
        (agent, terminal)
    }

    #[test]
    fn records_a_launch_a_dead_daemon_left_running_where_its_terminal_runs_and_failed_where_none_does()
     {
        let f = held_creates();
        let ran = mid_launch(&f, "k-1");
        let never_ran = mid_launch(&f, "k-2");
        f.fake().start_unseen(&f.terminal_of(ran.as_str()), &ran, 0);
        let starting = starting_terminals(&f);
        let events = recorded(&f, || reconciled(&f.restarted()));
        assert_eq!(
            (
                events,
                f.last_of("agent.failed"),
                state(&f, &ran),
                state(&f, &never_ran),
                (starting, starting_terminals(&f)),
            ),
            (
                vec!["agent.running".to_owned(), "agent.failed".to_owned()],
                Some(json!({"reason": "daemon_restart"})),
                AgentState::Starting,
                AgentState::Failed,
                (2, 0),
            )
        );
    }

    #[test]
    fn records_a_relaunch_a_dead_daemon_left_relaunched_where_its_new_terminal_runs() {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        mid_relaunch(&f, &agent, generation);
        let new = f.terminal_of(agent.as_str());
        f.fake().start_unseen(&new, &agent, generation + 1);
        let held = token_hash(&f, &agent);
        let events = recorded(&f, || reconciled(&f.restarted()));
        let now = agent_of(&f, &agent);
        assert_eq!(
            (
                events,
                (now.state, now.terminal_state, now.generation),
                token_hash(&f, &agent) == held,
                f.token_files().len(),
            ),
            (
                vec!["agent.relaunched".to_owned()],
                (
                    AgentState::Starting,
                    Some(TerminalState::Running),
                    Some(generation + 1)
                ),
                true,
                1,
            )
        );
    }

    /// The session `agent` is bound to.
    fn bound(f: &Fixture, agent: &AgentId) -> Option<ExternalRef> {
        let reader = f.store.reader().unwrap();
        let launch = reader.reads().agent_launch(agent.as_str()).unwrap();
        launch.and_then(|launch| launch.external_ref)
    }

    /// The tag of a terminal started on session `id`, in `like`'s environment.
    fn session_tag(like: &ExternalRef, id: &str) -> String {
        serde_json::to_string(&ExternalRef {
            id: id.to_owned(),
            ..like.clone()
        })
        .unwrap()
    }

    /// `agent`'s binding moved to `session`, as a quick /clear moves it.
    fn rebound(f: &Fixture, agent: &AgentId, session: &ExternalRef) {
        let (agent, session) = (agent.clone(), session.clone());
        runtime()
            .block_on(f.store.run(move |store| {
                store.write(|w| {
                    w.append(&bazhen_store::NewEvent::Agent {
                        agent,
                        actor: Actor::System.as_str().to_owned(),
                        change: AgentChange::ExternalRefUpdated(
                            bazhen_protocol::agent_events::AgentExternalRefUpdated {
                                external_ref: session,
                            },
                        ),
                    })
                })
            }))
            .unwrap()
            .unwrap();
    }

    #[test]
    fn records_a_fresh_relaunch_a_dead_daemon_left_on_the_session_its_new_terminal_started_on() {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        let was = bound(&f, &agent);
        mid_relaunch_as(&f, &agent, generation, Some(true));
        let new = f.terminal_of(agent.as_str());
        f.fake().start_unseen(&new, &agent, generation + 1);
        f.fake()
            .tag_session(&new, &session_tag(was.as_ref().unwrap(), "fresh-session"));
        reconciled(&f.restarted());
        assert_eq!(
            (
                was.map(|was| was.id),
                f.last_of("agent.relaunched")
                    .map(|relaunched| relaunched["externalRef"]["id"].clone()),
                bound(&f, &agent).map(|now| now.id),
            ),
            (
                Some(STUB_SESSION.to_owned()),
                Some(json!("fresh-session")),
                Some("fresh-session".to_owned()),
            )
        );
    }

    #[test]
    fn records_a_relaunch_a_dead_daemon_left_on_the_session_its_binding_moved_to_since() {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        mid_relaunch_as(&f, &agent, generation, Some(true));
        let new = f.terminal_of(agent.as_str());
        f.fake().start_unseen(&new, &agent, generation + 1);
        f.fake().tag_session(
            &new,
            &session_tag(&bound(&f, &agent).unwrap(), "fresh-session"),
        );
        let moved = ExternalRef {
            id: "moved-session".to_owned(),
            ..bound(&f, &agent).unwrap()
        };
        rebound(&f, &agent, &moved);
        reconciled(&f.restarted());
        assert_eq!(
            f.last_of("agent.relaunched")
                .map(|relaunched| relaunched["externalRef"]["id"].clone()),
            Some(json!("moved-session"))
        );
    }

    fn agent_of(f: &Fixture, id: &AgentId) -> AgentTerminal {
        agent(f, id)
    }

    #[test]
    fn rejects_a_relaunch_a_dead_daemon_left_where_nothing_runs_failing_its_terminal_and_its_token()
    {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        mid_relaunch(&f, &agent, generation);
        let new = f.terminal_of(agent.as_str());
        let (starting, held) = (starting_terminals(&f), token_hash(&f, &agent));
        let events = recorded(&f, || reconciled(&f.restarted()));
        let failed = f
            .store
            .reader()
            .unwrap()
            .reads()
            .agent_with_terminal(&new)
            .unwrap()
            .and_then(|row| row.terminal_state);
        assert_eq!(
            (
                events,
                f.last_of("agent.relaunch_rejected"),
                state(&f, &agent),
                failed,
                (starting, starting_terminals(&f)),
                held.is_some() && token_hash(&f, &agent) != held,
                f.token_files(),
            ),
            (
                vec!["agent.relaunch_rejected".to_owned()],
                Some(json!({"reason": "daemon_restart"})),
                AgentState::Lost,
                Some(TerminalState::Failed),
                (1, 0),
                true,
                Vec::<String>::new(),
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn records_a_respawn_a_dead_daemon_left_respawned_where_its_next_generation_runs() {
        bazhen_test_signal::require_sandbox().unwrap();
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = exited(&stub);
        mid_respawn(&f, &agent, generation);
        let next = f.fake().respawn_unseen(&f.terminal_of(agent.as_str()));
        let events = recorded(&f, || reconciled(&f.restarted()));
        let now = agent_of(&f, &agent);
        assert_eq!(
            (events, next, (now.state, now.generation)),
            (
                vec!["agent.respawned".to_owned()],
                generation + 1,
                (AgentState::Starting, Some(generation + 1))
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn records_a_respawn_a_dead_daemon_left_on_the_session_it_resumed_not_its_terminals_first() {
        bazhen_test_signal::require_sandbox().unwrap();
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = exited(&stub);
        let moved = ExternalRef {
            id: "moved-session".to_owned(),
            ..bound(&f, &agent).unwrap()
        };
        rebound(&f, &agent, &moved);
        mid_respawn(&f, &agent, generation);
        f.fake().respawn_unseen(&f.terminal_of(agent.as_str()));
        reconciled(&f.restarted());
        assert_eq!(
            (
                f.last_of("agent.respawned")
                    .map(|respawned| respawned["externalRef"]["id"].clone()),
                bound(&f, &agent).map(|now| now.id),
            ),
            (
                Some(json!("moved-session")),
                Some("moved-session".to_owned())
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn rejects_a_respawn_a_dead_daemon_left_then_loses_the_agent_where_nothing_runs() {
        bazhen_test_signal::require_sandbox().unwrap();
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = exited(&stub);
        mid_respawn(&f, &agent, generation);
        f.fake().gone(&f.terminal_of(agent.as_str()));
        let events = recorded(&f, || reconciled(&f.restarted()));
        assert_eq!(
            (
                events,
                f.last_of("agent.respawn_rejected"),
                state(&f, &agent)
            ),
            (
                vec!["agent.respawn_rejected".to_owned(), "agent.lost".to_owned()],
                Some(json!({"reason": "daemon_restart"})),
                AgentState::Lost
            )
        );
    }

    #[test]
    fn records_the_exit_of_a_process_that_ended_while_the_daemon_was_down() {
        let f = setup_with(crate::agents::tests::Setup::default());
        let (agent, terminal) = launched(&f, "k-1");
        f.fake_exit_unseen(&terminal);
        let events = recorded(&f, || reconciled(&f.restarted()));
        assert_eq!(
            (events, state(&f, &agent)),
            (vec!["agent.exited".to_owned()], AgentState::Exited)
        );
    }

    #[test]
    fn concludes_on_each_agent_by_its_own_terminal_alone() {
        let f = setup_with(crate::agents::tests::Setup::default());
        let (wedged, at_wedged) = launched(&f, "k-1");
        let (ended, at_ended) = launched(&f, "k-2");
        f.fake().set(|state| {
            state.unreadable.insert(at_wedged.clone());
        });
        f.fake().gone(&at_ended);
        let agents = f.restarted();
        let first = recorded(&f, || reconciled(&agents));
        let while_wedged = state(&f, &wedged);
        f.fake().set(|state| {
            state.unreadable.clear();
        });
        f.fake().gone(&at_wedged);
        let then = recorded(&f, || runtime().block_on(agents.reconcile_again()));
        assert_eq!(
            (
                first,
                while_wedged,
                state(&f, &ended),
                then,
                state(&f, &wedged)
            ),
            (
                vec!["agent.lost".to_owned()],
                AgentState::Starting,
                AgentState::Lost,
                vec!["agent.lost".to_owned()],
                AgentState::Lost,
            )
        );
    }

    #[test]
    fn leaves_an_agent_the_runtime_doesnt_list_until_what_ran_it_is_proved_gone() {
        let f = setup_with(crate::agents::tests::Setup::default());
        let (agent, terminal) = launched(&f, "k-1");
        f.fake().gone(&terminal);
        f.fake().set(|state| {
            state.unproven.insert(terminal.clone());
        });
        let agents = f.restarted();
        let first = recorded(&f, || reconciled(&agents));
        f.fake().set(|state| {
            state.unproven.clear();
        });
        let then = recorded(&f, || runtime().block_on(agents.reconcile_again()));
        assert_eq!(
            (first, then, state(&f, &agent)),
            (
                Vec::<String>::new(),
                vec!["agent.lost".to_owned()],
                AgentState::Lost
            )
        );
    }

    #[test]
    fn waits_out_the_hello_deadline_before_failing_a_launch_that_left_no_holder() {
        let f = held_creates();
        let agent = mid_launch(&f, "k-1");
        f.fake()
            .set(|state| state.hello_margin = Duration::from_secs(3600));
        let agents = f.restarted();
        let early = recorded(&f, || reconciled(&agents));
        f.fake()
            .start_unseen(&f.terminal_of(agent.as_str()), &agent, 0);
        let then = recorded(&f, || runtime().block_on(agents.reconcile_again()));
        assert_eq!(
            (early, then, state(&f, &agent)),
            (
                Vec::<String>::new(),
                vec!["agent.running".to_owned()],
                AgentState::Starting
            )
        );
    }

    #[test]
    fn closes_a_holder_tagged_for_an_agent_at_a_terminal_it_doesnt_run_in_never_taking_it_as_its_start()
     {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        mid_relaunch(&f, &agent, generation);
        f.fake().start_unseen(STRAY, &agent, generation + 1);
        let events = recorded(&f, || reconciled(&f.restarted()));
        assert_eq!(
            (events, closed(&f)),
            (
                vec!["agent.relaunch_rejected".to_owned()],
                vec![STRAY.to_owned()]
            )
        );
    }

    #[test]
    fn leaves_the_terminal_of_a_relaunch_recorded_after_the_runtime_was_read() {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        let held = Held::shut();
        f.fake()
            .set(|state| state.hold_inventory = Some(held.clone()));
        let (agents, id) = (f.restarted(), agent.as_str().to_owned());
        let relaunched = runtime().block_on(async {
            let sweep = TaskTracker::new().spawn(async move { agents.reconcile().await });
            held.reached().await;
            let relaunched = f
                .agents
                .relaunch(
                    &id,
                    &RelaunchAgentRequest {
                        idempotency_key: "r-1".to_owned(),
                        generation,
                        theme: None,
                        fresh: None,
                    },
                    |_| -> BoxFuture<'static, ()> { Box::pin(async {}) },
                )
                .await
                .map(drop);
            held.go.add_permits(1);
            sweep.await.unwrap().unwrap();
            relaunched
        });
        let now = f.terminal_of(agent.as_str());
        assert_eq!(
            (relaunched, f.fake().carries(&now), closed(&f)),
            (Ok(()), true, Vec::<String>::new())
        );
    }

    #[test]
    fn closes_a_late_holder_at_the_terminal_of_an_agent_that_failed() {
        let f = held_creates();
        let agent = mid_launch(&f, "k-1");
        reconciled(&f.restarted());
        let terminal = f.terminal_of(agent.as_str());
        f.fake().start_unseen(&terminal, &agent, 0);
        let events = recorded(&f, || reconciled(&f.restarted()));
        assert_eq!(
            (events, state(&f, &agent), closed(&f)),
            (Vec::<String>::new(), AgentState::Failed, vec![terminal])
        );
    }

    #[test]
    fn leaves_a_holder_at_its_agents_current_terminal_for_its_settle() {
        let f = setup_with(crate::agents::tests::Setup::default());
        let (agent, terminal) = launched(&f, "k-1");
        let row = agent_of(&f, &agent);
        let found = FoundAgent {
            terminal: recorded_at(&terminal, 0),
            exit: None,
            agent_id: agent.clone(),
            harness_session: None,
        };
        let failed = AgentTerminal {
            state: AgentState::Failed,
            ..row.clone()
        };
        assert_eq!(
            (
                orphaned(&found, Some(&row), Some(&row)),
                orphaned(&found, Some(&row), Some(&failed)),
                orphaned(&found, None, None),
            ),
            (false, true, true)
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn answers_the_waiter_of_an_agent_however_its_close_is_recorded() {
        bazhen_test_signal::require_sandbox().unwrap();
        let f = setup_with(crate::agents::tests::Setup::default());
        let hooks = Arc::clone(&f.agents.deps.hooks);
        let (by_command, _) = launched(&f, "k-1");
        let (by_reconcile, at_reconcile) = launched(&f, "k-2");
        let (by_watch, at_watch) = launched(&f, "k-3");
        let _waiting = [&by_command, &by_reconcile, &by_watch].map(|agent| hooks.waiter(agent));
        let close = |agent: &AgentId, key: &str| {
            runtime().block_on(f.agents.close(
                agent.as_str(),
                &CloseAgentRequest {
                    idempotency_key: key.to_owned(),
                    generation: agent_of(&f, agent).generation.unwrap(),
                    force: None,
                    keep_shells: None,
                    confirm_busy: None,
                    confirmed_busy: None,
                },
            ))
        };
        close(&by_command, "c-1").unwrap();
        f.fake().set(|state| state.fail_closes = true);
        assert!(close(&by_reconcile, "c-2").is_err());
        assert!(close(&by_watch, "c-3").is_err());
        let closing = [&by_reconcile, &by_watch].map(|agent| state(&f, agent));
        f.fake().gone(&at_reconcile);
        f.fake().gone(&at_watch);
        let generation = agent_of(&f, &by_watch).generation.unwrap();
        runtime()
            .block_on(
                f.agents
                    .observed(Event::Lost(recorded_at(&at_watch, generation))),
            )
            .unwrap();
        reconciled(&f.restarted());
        assert_eq!(
            (
                closing,
                [&by_command, &by_reconcile, &by_watch].map(|agent| state(&f, agent)),
                [&by_command, &by_reconcile, &by_watch].map(|agent| hooks.holds_waiter(agent)),
                f.token_files(),
            ),
            (
                [AgentState::Closing; 2],
                [AgentState::Closed; 3],
                [false; 3],
                Vec::<String>::new(),
            )
        );
    }
}
