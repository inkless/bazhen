//! Starting an agent again (`Lifecycle.respawn` and `Lifecycle.relaunch` in
//! `agents/lifecycle.ts`), at the next generation. A respawn starts an exited agent's process
//! again in the same terminal, resuming its harness session; a relaunch starts a lost agent on a
//! new terminal, resuming its session or, when asked, on a fresh one. Each is recorded requested
//! first, so a daemon that dies meanwhile leaves a record of the start under way, for an agent
//! reconcile to settle; none runs yet. One rejected leaves the agent on the terminal it had,
//! still closable.

use std::collections::BTreeMap;
use std::sync::Arc;

use bazhen_harness::{BoxFuture, LaunchError, LaunchRequest, LaunchSpec};
use bazhen_protocol::agent_events::{
    AgentRelaunchRejected, AgentRelaunchRequested, AgentRespawnRejected, AgentRestarted,
    RelaunchRejectedReason, RespawnRejectedReason,
};
use bazhen_protocol::agents::{
    AgentCommand, AgentCommandResponse, ExternalRef, RelaunchAgentRequest, RespawnAgentRequest,
};
use bazhen_protocol::events::RuntimeRefPayload;
use bazhen_protocol::ids::{AgentId, EnvironmentId, TerminalId};
use bazhen_protocol::record::Record;
use bazhen_protocol::shells::TuiTheme;
use bazhen_store::{Actor, AgentChange, AgentLaunch, AgentTerminal, Writer as StoreWriter};

use super::lifecycle::{Begun, Doing, append, asked, from_runtime, offers, recorded};
use super::prompts::{Composed, FLEET, compose};
use super::{AgentError, Agents, minted, session_tag};
use crate::budget::Counts;
use crate::failure::failure_detail;
use crate::shells::RUNTIME;
use crate::terminals::{Kind, NewTerminal, Recorded, Restart, TerminalError};
use crate::tokens::Minted;

/// What stopped a start once it was recorded requested.
enum Failed {
    /// The harness wouldn't, or couldn't, give the command to start its session.
    Harness(LaunchError),
    /// The runtime didn't start the process.
    Terminal(TerminalError),
    /// The agent's new token couldn't be made.
    Token(String),
    /// What ran the terminal the agent was lost on isn't proved gone, and may still run it, as a
    /// holder whose socket has gone may: the agent has one terminal at a time.
    Exists(TerminalId),
    /// A terminal an earlier start asked for, which recorded nothing to prove it gone by, may
    /// still be starting: once nothing could, it is proved so.
    Starting(TerminalId),
    /// No runtime confirmed where the terminal the agent was lost on ran, so nothing can prove
    /// it gone.
    Unlocated,
}

impl Failed {
    fn detail(&self) -> String {
        failure_detail(&match self {
            Self::Harness(LaunchError::Refused(why) | LaunchError::Unavailable(why))
            | Self::Token(why) => why.clone(),
            Self::Terminal(err) => err.to_string(),
            Self::Exists(terminal) => format!("terminal {terminal} isn't proved gone"),
            Self::Starting(terminal) => format!("terminal {terminal} may still be starting"),
            Self::Unlocated => "no runtime confirmed where its last terminal ran".to_owned(),
        })
    }

    /// Whether the start may have happened: the runtime was asked, and didn't say.
    fn unknown(&self) -> bool {
        matches!(self, Self::Terminal(TerminalError::Unknown(_)))
    }

    /// Why the respawn was rejected, as `agent.respawn_rejected` records it (`rejection`).
    fn respawn_rejected(&self) -> AgentRespawnRejected {
        let reason = match self {
            Self::Harness(LaunchError::Refused(_)) => RespawnRejectedReason::HarnessRefused,
            Self::Terminal(
                TerminalError::Stale(_) | TerminalError::Gone(_) | TerminalError::ProcessState(_),
            ) => RespawnRejectedReason::TerminalChanged,
            Self::Harness(LaunchError::Unavailable(_))
            | Self::Terminal(_)
            | Self::Token(_)
            | Self::Exists(_)
            | Self::Starting(_)
            | Self::Unlocated => RespawnRejectedReason::Unavailable,
        };
        AgentRespawnRejected {
            reason,
            detail: Some(self.detail()),
        }
    }

    /// Why the relaunch was rejected, as `agent.relaunch_rejected` records it
    /// (`relaunchRejection`).
    fn relaunch_rejected(&self) -> AgentRelaunchRejected {
        let reason = match self {
            Self::Harness(LaunchError::Refused(_)) => RelaunchRejectedReason::HarnessRefused,
            Self::Exists(_) | Self::Starting(_) => RelaunchRejectedReason::TerminalExists,
            Self::Harness(LaunchError::Unavailable(_))
            | Self::Terminal(_)
            | Self::Token(_)
            | Self::Unlocated => RelaunchRejectedReason::Unavailable,
        };
        AgentRelaunchRejected {
            reason,
            detail: Some(self.detail()),
        }
    }

    /// The failure as the command's answer, for a start that was `resuming` a session or not.
    fn answer(self, id: &str, resuming: bool) -> AgentError {
        match self {
            Self::Terminal(err) => from_runtime(id, Doing::Start, err),
            Self::Harness(LaunchError::Refused(why)) => {
                let verb = if resuming { "resume" } else { "start" };
                AgentError::Conflict(format!("agent {id}'s harness won't {verb} it: {why}"))
            }
            Self::Exists(terminal) => AgentError::Conflict(format!(
                "agent {id} already has a terminal: {terminal} isn't proved gone"
            )),
            Self::Starting(terminal) => AgentError::Conflict(format!(
                "agent {id} already has a terminal: {terminal} may still be starting; try again \
                 shortly"
            )),
            Self::Harness(LaunchError::Unavailable(why)) | Self::Token(why) => {
                AgentError::Unavailable(format!("agent {id} could not be started again: {why}"))
            }
            Self::Unlocated => AgentError::Unavailable(format!(
                "agent {id} could not be started again: no runtime confirmed where its last terminal ran, so nothing proves it gone"
            )),
        }
    }
}

/// What a start again gave: where its terminal runs now, the session it is on, and the theme it
/// drew for.
struct Resumed {
    locator: Record<String>,
    session: Option<ExternalRef>,
    theme: Option<TuiTheme>,
}

/// What a start again is started with, beside the agent.
struct Again<'a> {
    launch: &'a AgentLaunch,
    /// The session it resumes, or none for a fresh one.
    session: Option<&'a ExternalRef>,
    /// The environment a session it starts is in.
    environment: EnvironmentId,
    generation: u64,
    prompt: Composed,
    prompt_file: String,
    theme: Option<TuiTheme>,
}

/// The harness's command for a start again, on the agent's new token.
struct Command {
    argv: Vec<String>,
    env: BTreeMap<String, String>,
    theme: Option<TuiTheme>,
    session: Option<ExternalRef>,
    token: Minted,
}

/// A start again that started, to be recorded with its key's answer.
struct Done {
    agent: AgentId,
    /// `agent.respawned` or `agent.relaunched`.
    change: fn(AgentRestarted) -> AgentChange,
    /// The session it was bound to before it started.
    was: Option<String>,
    harness_name: Option<String>,
    prompt_hash: String,
    resumed: Resumed,
}

impl Done {
    /// Records the agent started. A TUI that moved its binding while it started, as a quick
    /// /clear does, is on the newer session, read here in the same transaction.
    fn recorded(self, w: &StoreWriter<'_>) -> Result<u64, AgentError> {
        let current = w
            .reads()
            .agent_launch(self.agent.as_str())?
            .and_then(|now| now.external_ref);
        let external_ref = match current {
            Some(current) if Some(&current.id) != self.was.as_ref() => Some(current),
            _ => self.resumed.session,
        };
        let started = (self.change)(AgentRestarted {
            external_ref,
            runtime_ref: RuntimeRefPayload {
                runtime: RUNTIME.to_owned(),
                locator: self.resumed.locator,
            },
            theme: self.resumed.theme,
            harness_name: self.harness_name,
            prompt_hash: Some(self.prompt_hash),
        });
        append(w, &self.agent, Actor::User, started)
    }
}

/// An agent found for a command, and what it was launched with.
struct Found {
    found: AgentTerminal,
    launch: AgentLaunch,
}

impl Agents {
    /// Starts an exited agent again on its harness session, at the next generation. One with no
    /// session to resume is refused with nothing recorded. `replaced` settles what the agent's
    /// hooks held of its last process, once the respawn is recorded and before the new one
    /// starts, whether or not it then does.
    pub(crate) async fn respawn<F>(
        &self,
        id: &str,
        req: &RespawnAgentRequest,
        replaced: F,
    ) -> Result<AgentCommandResponse, AgentError>
    where
        F: FnOnce(AgentId) -> BoxFuture<'static, ()> + Send,
    {
        let request = asked("respawn", id, req)?;
        let key = &req.idempotency_key;
        let _turn = self.deps.turns.take(id).await;
        let Found { found, launch } = match self
            .found(id, key, &request, req.generation, AgentCommand::Respawn)
            .await?
        {
            Ok(found) => found,
            Err(prior) => return Ok(prior),
        };
        let agent = found.agent_id.clone();
        let (Some(terminal), Some(generation)) = (recorded(&found), found.generation) else {
            return Err(no_terminal(id));
        };
        // Known before anything happens, so it is refused with nothing recorded.
        let session = self.resumable(id, &launch, "")?;
        self.refuse_taken(&agent, &launch, session).await?;
        let (prompt, prompt_file) = self.prompt_for(&agent, &launch)?;
        let requesting = agent.clone();
        let requested = self
            .write(move |w| append(w, &requesting, Actor::User, AgentChange::RespawnRequested))
            .await?;
        replaced(agent.clone()).await;
        let again = Again {
            launch: &launch,
            session: Some(session),
            environment: session.environment_id.clone(),
            generation: generation + 1,
            prompt,
            prompt_file,
            // Drawn as it was last, unless it is asked otherwise.
            theme: req.theme.or(launch.theme),
        };
        let prompt_hash = again.prompt.hash.clone();
        match self.start_again(&agent, terminal, again).await {
            // Left requested, for the daemon to settle once it can tell.
            Err(failed) if failed.unknown() => Err(failed.answer(id, true)),
            Err(failed) => {
                let rejecting = agent.clone();
                let rejected = AgentChange::RespawnRejected(failed.respawn_rejected());
                self.write(move |w| append(w, &rejecting, Actor::User, rejected))
                    .await?;
                Err(failed.answer(id, true))
            }
            Ok(resumed) => {
                let done = Done {
                    agent: agent.clone(),
                    change: AgentChange::Respawned,
                    was: Some(session.id.clone()),
                    harness_name: launch.name.clone(),
                    prompt_hash,
                    resumed,
                };
                self.finish(&agent, key, &request, move |w| {
                    Ok(vec![requested, done.recorded(w)?])
                })
                .await
            }
        }
    }

    /// Starts a lost agent again on a new terminal, at the next generation, resuming its
    /// harness session, or on a new one only when `fresh` asks. One that can't resume is refused
    /// with nothing recorded. The new terminal is admitted to the budget in the transaction that
    /// records it requested. `replaced` is as a respawn's.
    pub(crate) async fn relaunch<F>(
        &self,
        id: &str,
        req: &RelaunchAgentRequest,
        replaced: F,
    ) -> Result<AgentCommandResponse, AgentError>
    where
        F: FnOnce(AgentId) -> BoxFuture<'static, ()> + Send,
    {
        let request = asked("relaunch", id, req)?;
        let key = &req.idempotency_key;
        let _turn = self.deps.turns.take(id).await;
        let Found { found, launch } = match self
            .found(id, key, &request, req.generation, AgentCommand::Relaunch)
            .await?
        {
            Ok(found) => found,
            Err(prior) => return Ok(prior),
        };
        let agent = found.agent_id.clone();
        let (Some(_), Some(generation)) = (found.terminal_id.as_ref(), found.generation) else {
            return Err(no_terminal(id));
        };
        let fresh = req.fresh == Some(true);
        // Known before anything happens, so it is refused with nothing recorded.
        let session = if fresh {
            None
        } else {
            let session = self.resumable(
                id,
                &launch,
                "; relaunch it fresh to start it on a new session",
            )?;
            self.refuse_taken(&agent, &launch, session).await?;
            Some(session)
        };
        let (prompt, prompt_file) = self.prompt_for(&agent, &launch)?;
        let terminal: TerminalId = minted()?;
        let generation = generation + 1;
        let budget = Arc::clone(&self.deps.budget);
        let (requesting, payload) = (
            agent.clone(),
            AgentRelaunchRequested {
                terminal_id: terminal.clone(),
                generation,
                fresh,
                runtime: Some(RUNTIME.to_owned()),
            },
        );
        let (requested, environment) = self
            .write(move |w| {
                let reads = w.reads();
                budget.admit(Counts {
                    open: reads.open_terminals()?,
                    starting: reads.starting_terminals()?,
                })?;
                let environment = w.local_environment()?;
                let change = AgentChange::RelaunchRequested(payload);
                Ok((append(w, &requesting, Actor::User, change)?, environment))
            })
            .await?;
        replaced(agent.clone()).await;
        let again = Again {
            launch: &launch,
            session,
            environment,
            generation,
            prompt,
            prompt_file,
            theme: req.theme.or(launch.theme),
        };
        let prompt_hash = again.prompt.hash.clone();
        match self
            .start_new(&agent, recorded(&found), terminal, again)
            .await
        {
            // Left requested, for the daemon to settle once it can tell.
            Err(failed) if failed.unknown() => Err(failed.answer(id, session.is_some())),
            Err(failed) => {
                let rejecting = agent.clone();
                let rejected = AgentChange::RelaunchRejected(failed.relaunch_rejected());
                self.write(move |w| append(w, &rejecting, Actor::User, rejected))
                    .await?;
                Err(failed.answer(id, session.is_some()))
            }
            Ok(resumed) => {
                let done = Done {
                    agent: agent.clone(),
                    change: AgentChange::Relaunched,
                    was: launch
                        .external_ref
                        .as_ref()
                        .map(|session| session.id.clone()),
                    harness_name: launch.name.clone(),
                    prompt_hash,
                    resumed,
                };
                self.finish(&agent, key, &request, move |w| {
                    Ok(vec![requested, done.recorded(w)?])
                })
                .await
            }
        }
    }

    /// The agent `id`, in a state `command` takes, at `generation`, with what it was launched
    /// with; or the key's first answer.
    async fn found(
        &self,
        id: &str,
        key: &str,
        request: &str,
        generation: u64,
        command: AgentCommand,
    ) -> Result<Result<Found, AgentCommandResponse>, AgentError> {
        let found = match self
            .begin(id, key, request, generation, offers(command))
            .await?
        {
            Begun::Prior(prior) => return Ok(Err(prior)),
            Begun::Found(found) => found,
        };
        let reading = found.agent_id.clone();
        let launch = self
            .write(move |w| Ok(w.reads().agent_launch(reading.as_str())?))
            .await?
            .ok_or_else(|| no_terminal(id))?;
        Ok(Ok(Found { found, launch }))
    }

    /// The session the agent is on, where its harness says it resumes; else why not, then
    /// `instead`.
    fn resumable<'l>(
        &self,
        id: &str,
        launch: &'l AgentLaunch,
        instead: &str,
    ) -> Result<&'l ExternalRef, AgentError> {
        let why = match &launch.external_ref {
            Some(session) if self.resumes(launch) => return Ok(session),
            Some(_) => format!("agent {id}'s harness can't resume its session"),
            None => format!("agent {id} has no session to resume"),
        };
        Err(AgentError::NotResumable(format!("{why}{instead}")))
    }

    /// The prompt the agent's role gives now, written to the file its start reads.
    fn prompt_for(
        &self,
        agent: &AgentId,
        launch: &AgentLaunch,
    ) -> Result<(Composed, String), AgentError> {
        let roles = self.deps.roles.current();
        let prompt = compose(FLEET, &roles.book, launch.role.as_ref());
        let prompt_file = self
            .deps
            .prompts
            .write(agent, &prompt.text)
            .map_err(|err| {
                AgentError::Internal(format!("agent {agent}'s prompt can't be written: {err}"))
            })?
            .to_string_lossy()
            .into_owned();
        Ok((prompt, prompt_file))
    }

    /// Refuses to start `agent` again on a session another agent holds, for a harness whose
    /// sessions are one agent's at a time (`refuseTaken`).
    pub(super) async fn refuse_taken(
        &self,
        agent: &AgentId,
        launch: &AgentLaunch,
        session: &ExternalRef,
    ) -> Result<(), AgentError> {
        let held_alone = self
            .deps
            .harnesses
            .get(launch.harness)
            .is_some_and(bazhen_harness::Harness::session_held_alone);
        if !held_alone {
            return Ok(());
        }
        let asked = session.clone();
        let holders = self
            .write(move |w| Ok(w.reads().session_holders(&asked)?))
            .await?;
        let others: Vec<String> = holders
            .into_iter()
            .filter(|holder| holder != agent.as_str())
            .collect();
        if others.is_empty() {
            return Ok(());
        }
        Err(AgentError::SessionTaken(format!(
            "agent {agent} can't resume session {}: {} is on it too",
            session.id,
            others.join(", ")
        )))
    }

    /// Whether the agent's harness says its session resumes, by what its reports said of it.
    fn resumes(&self, launch: &AgentLaunch) -> bool {
        self.deps
            .harnesses
            .get(launch.harness)
            .is_some_and(|harness| {
                harness.can_resume(&bazhen_harness::Evidence {
                    transcript: launch.transcript.as_deref(),
                })
            })
    }

    /// Starts the agent's process again in its terminal, at its next generation.
    async fn start_again(
        &self,
        agent: &AgentId,
        terminal: Recorded,
        again: Again<'_>,
    ) -> Result<Resumed, Failed> {
        let (cwd, generation) = (again.launch.cwd.clone(), again.generation);
        let command = self.command_for(agent, again).await?;
        let restart = Restart {
            argv: command.argv,
            cwd,
            env: command.env,
            theme: command.theme,
            generation,
        };
        match self.deps.terminals.respawn(&terminal, restart).await {
            Ok(locator) => {
                command.token.kept().await;
                Ok(Resumed {
                    locator,
                    session: command.session,
                    theme: command.theme,
                })
            }
            // The holder may have started it, with the token's file, which it may still read.
            Err(err @ TerminalError::Unknown(_)) => Err(Failed::Terminal(err)),
            Err(err) => {
                command.token.abandoned().await;
                Err(Failed::Terminal(err))
            }
        }
    }

    /// Starts the agent on the new terminal `terminal`, once the one it was lost on, `lost`, is
    /// proved gone.
    async fn start_new(
        &self,
        agent: &AgentId,
        lost: Option<Recorded>,
        terminal: TerminalId,
        again: Again<'_>,
    ) -> Result<Resumed, Failed> {
        self.refuse_unless_gone(agent, lost, &terminal).await?;
        let (cwd, generation) = (again.launch.cwd.clone(), again.generation);
        let command = self.command_for(agent, again).await?;
        let harness_session = match command.session.as_ref().map(session_tag).transpose() {
            Ok(tag) => tag,
            Err(err) => {
                command.token.abandoned().await;
                return Err(Failed::Harness(LaunchError::Unavailable(err.to_string())));
            }
        };
        let spec = NewTerminal {
            terminal_id: terminal.clone(),
            kind: Kind::Agent {
                agent_id: agent.clone(),
                harness_session,
            },
            argv: command.argv,
            cwd,
            env: command.env,
            theme: command.theme,
            generation,
        };
        match self.deps.terminals.create(spec).await {
            Ok(locator) => {
                command.token.kept().await;
                Ok(Resumed {
                    locator,
                    session: command.session,
                    theme: command.theme,
                })
            }
            Err(err) => {
                self.refused(terminal);
                // A holder that may run started with the token's file, which it may still read.
                if !matches!(err, TerminalError::Unknown(_)) {
                    command.token.abandoned().await;
                }
                Err(Failed::Terminal(err))
            }
        }
    }

    /// Refuses a new terminal for an agent until what ran its lost one is proved gone: no holder
    /// answers for it, and its process is no longer the one recorded. One whose holder can't be
    /// reached, or whose socket has gone while it runs, isn't proved gone, so two TUIs never run
    /// one agent. Every other terminal made for it and not closed is asked of too, `terminal`,
    /// the one it starts on, aside: a start before that a daemon never saw through may have
    /// spawned a holder that answers late.
    async fn refuse_unless_gone(
        &self,
        agent: &AgentId,
        lost: Option<Recorded>,
        terminal: &TerminalId,
    ) -> Result<(), Failed> {
        let lost = lost.ok_or(Failed::Unlocated)?;
        if !self.deps.terminals.gone(&lost).await {
            return Err(Failed::Exists(lost.terminal_id));
        }
        let id = agent.as_str().to_owned();
        let rows = self
            .write(move |w| Ok(w.reads().agent_terminals(&id)?))
            .await
            .map_err(|err| Failed::Terminal(TerminalError::Other(err.to_string())))?;
        for row in rows {
            let Some(id) = row.terminal_id.clone() else {
                continue;
            };
            if &id == terminal || id == lost.terminal_id {
                continue;
            }
            if let Some(at) = recorded(&row) {
                if !self.deps.terminals.gone(&at).await {
                    return Err(Failed::Exists(id));
                }
            } else if !self.unstarted(&id).await {
                return Err(Failed::Starting(id));
            }
        }
        Ok(())
    }

    /// The harness's command to start the agent on its session, or on a fresh one, and the new
    /// token it starts with.
    async fn command_for(&self, agent: &AgentId, again: Again<'_>) -> Result<Command, Failed> {
        let harness = self
            .deps
            .harnesses
            .get(again.launch.harness)
            .ok_or_else(|| {
                Failed::Harness(LaunchError::Unavailable(format!(
                    "this environment cannot run {}",
                    again.launch.harness.as_str()
                )))
            })?;
        let request = LaunchRequest {
            cwd: again.launch.cwd.clone(),
            theme: again.theme,
            instructions_changed: again.launch.prompt_hash.as_deref()
                != Some(again.prompt.hash.as_str()),
            instructions: Some(again.prompt.text),
            instructions_file: Some(again.prompt_file),
            name: again.launch.name.clone().filter(|name| !name.is_empty()),
            compact_window_tokens: again.launch.compact_window_tokens.map(u64::from),
        };
        let starting = match again.session {
            Some(session) => harness.resume(&request, session, None).ok_or_else(|| {
                Failed::Harness(LaunchError::Refused(
                    "its harness starts no session again".to_owned(),
                ))
            })?,
            None => harness.launch(&request, None),
        };
        let LaunchSpec {
            argv,
            env,
            theme,
            session,
        } = starting.await.map_err(Failed::Harness)?;
        let token = self
            .deps
            .tokens
            .mint(agent)
            .await
            .map_err(|err| Failed::Token(err.to_string()))?;
        let (argv, env) = self.process_of(agent, &token.file, argv, env);
        Ok(Command {
            argv,
            env,
            theme,
            session: session.map(|session| ExternalRef {
                environment_id: again.environment,
                kind: session.kind,
                id: session.id,
            }),
            token,
        })
    }
}

/// Refused: the agent has no terminal recorded to start it again from.
fn no_terminal(id: &str) -> AgentError {
    AgentError::Conflict(format!("agent {id} has no terminal recorded"))
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::{Arc, Mutex};

    use bazhen_harness::LaunchError;
    use bazhen_protocol::agent_events::AgentExited;
    use bazhen_protocol::agents::{AgentState, ExitStatus, LaunchAgentRequest};
    use bazhen_store::NewEvent;

    use super::*;
    use crate::agents::tests::{Fixture, request, stubbed};
    use crate::testing::runtime;
    use crate::testing::stub_harness::{STUB_RESUME_ARGV, STUB_SESSION, StubHarness, pull};

    /// An agent launched on `stub` asking for a light theme, which it draws dark, whose process
    /// has since exited; and its generation.
    pub(crate) fn exited(stub: &StubHarness) -> (Fixture, AgentId, u64) {
        let (f, agent) = launched(stub);
        f.fake_exit_unseen(&f.terminal_of(agent.as_str()));
        ended(
            f,
            agent,
            AgentChange::Exited(AgentExited {
                exit: ExitStatus::Unknown,
            }),
        )
    }

    /// The same, but its terminal has since been lost.
    pub(crate) fn lost(stub: &StubHarness) -> (Fixture, AgentId, u64) {
        lost_on(stubbed(stub))
    }

    /// The same, on `f`.
    fn lost_on(f: Fixture) -> (Fixture, AgentId, u64) {
        let (f, agent) = launched_on(f);
        f.fake().gone(&f.terminal_of(agent.as_str()));
        ended(f, agent, AgentChange::Lost)
    }

    fn launched(stub: &StubHarness) -> (Fixture, AgentId) {
        launched_on(stubbed(stub))
    }

    fn launched_on(f: Fixture) -> (Fixture, AgentId) {
        let launch = LaunchAgentRequest {
            theme: Some(TuiTheme::Light),
            ..request("k-1")
        };
        let agent = runtime().block_on(f.launch(launch)).unwrap().agent_id;
        (f, agent)
    }

    /// `agent` recorded as `change` says its terminal ended; with its generation.
    fn ended(f: Fixture, agent: AgentId, change: AgentChange) -> (Fixture, AgentId, u64) {
        let recorded = agent.clone();
        runtime()
            .block_on(f.store.run(move |store| {
                store.write(|w| {
                    w.append(&NewEvent::Agent {
                        agent: recorded,
                        actor: Actor::System.as_str().to_owned(),
                        change,
                    })
                })
            }))
            .unwrap()
            .unwrap();
        let generation = found(&f, &agent).generation.unwrap();
        (f, agent, generation)
    }

    fn found(f: &Fixture, agent: &AgentId) -> bazhen_store::AgentTerminal {
        f.store
            .reader()
            .unwrap()
            .reads()
            .agent_terminal(agent.as_str())
            .unwrap()
            .unwrap()
    }

    fn respawning(key: &str, generation: u64) -> RespawnAgentRequest {
        RespawnAgentRequest {
            idempotency_key: key.to_owned(),
            generation,
            theme: None,
        }
    }

    /// What each call of `replaced` was given, with the last event recorded when it was.
    type Calls = Arc<Mutex<Vec<(AgentId, Option<String>)>>>;

    /// A `replaced` that records each call into `calls`.
    fn recording(
        f: &Fixture,
        calls: &Calls,
    ) -> impl FnOnce(AgentId) -> BoxFuture<'static, ()> + Send + use<> {
        let (store, calls) = (f.store.clone(), Arc::clone(calls));
        move |agent| {
            Box::pin(async move {
                let reader = store.reader().unwrap();
                let last = reader
                    .reads()
                    .events(0, 1000)
                    .unwrap()
                    .pop()
                    .map(|e| e.kind);
                calls.lock().unwrap().push((agent, last));
            })
        }
    }

    fn respawned(f: &Fixture) -> Vec<(String, Restart)> {
        let mut respawned = Vec::new();
        f.fake()
            .set(|state| respawned = std::mem::take(&mut state.respawned));
        respawned
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn starts_an_exited_agent_again_on_its_session_at_the_next_generation_waiting_on_its_harness() {
        bazhen_test_signal::require_sandbox().unwrap();
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = exited(&stub);
        let terminal = f.terminal_of(agent.as_str());
        let before = f.types().len();
        let calls = Calls::default();
        let id = agent.as_str();
        let [first, again] = [(); 2].map(|()| {
            runtime().block_on(f.agents.respawn(
                id,
                &respawning("r-1", generation),
                recording(&f, &calls),
            ))
        });
        let now = found(&f, &agent);
        let asked: Vec<Option<TuiTheme>> = stub
            .resumes_asked
            .lock()
            .unwrap()
            .iter()
            .map(|(request, _)| request.theme)
            .collect();
        let started: Vec<(String, Vec<String>, u64, Option<String>)> = respawned(&f)
            .into_iter()
            .map(|(terminal, restart)| {
                let id = restart.env.get("BAZHEN_AGENT_ID").cloned();
                (terminal, restart.argv, restart.generation, id)
            })
            .collect();
        let mut argv: Vec<String> = STUB_RESUME_ARGV.map(str::to_owned).to_vec();
        argv.push(STUB_SESSION.to_owned());
        assert_eq!(
            (
                f.types().split_off(before),
                first.as_ref().map(|first| first.event_ids.len()),
                first == again,
                calls.lock().unwrap().clone(),
                asked,
                started,
                (
                    now.state,
                    now.generation,
                    now.terminal_id.map(|t| t.as_str().to_owned())
                ),
            ),
            (
                vec![
                    "agent.respawn_requested".to_owned(),
                    "agent.respawned".to_owned()
                ],
                Ok(2),
                true,
                vec![(agent.clone(), Some("agent.respawn_requested".to_owned()))],
                vec![Some(TuiTheme::Dark)],
                vec![(terminal.clone(), argv, generation + 1, Some(id.to_owned()))],
                (AgentState::Starting, Some(generation + 1), Some(terminal)),
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_an_agent_whose_session_cant_resume_recording_nothing() {
        bazhen_test_signal::require_sandbox().unwrap();
        let stub = StubHarness::new(pull());
        let (f, agent, generation) = exited(&stub);
        let before = f.types().len();
        let calls = Calls::default();
        let id = agent.as_str();
        let refused = runtime().block_on(f.agents.respawn(
            id,
            &respawning("r-1", generation),
            recording(&f, &calls),
        ));
        assert_eq!(
            (
                refused,
                f.types().split_off(before),
                calls.lock().unwrap().len(),
                respawned(&f).len(),
                stub.resumes_asked.lock().unwrap().len(),
            ),
            (
                Err(AgentError::NotResumable(format!(
                    "agent {id}'s harness can't resume its session"
                ))),
                Vec::<String>::new(),
                0,
                0,
                0
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn rejects_a_respawn_its_runtime_refuses_leaving_the_agent_exited_on_its_terminal() {
        bazhen_test_signal::require_sandbox().unwrap();
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = exited(&stub);
        let terminal = f.terminal_of(agent.as_str());
        let before = f.types().len();
        f.fake().set(|state| {
            state.respawns_refused = Some(TerminalError::ProcessState("still running".to_owned()));
        });
        let calls = Calls::default();
        let id = agent.as_str();
        let refused = runtime().block_on(f.agents.respawn(
            id,
            &respawning("r-1", generation),
            recording(&f, &calls),
        ));
        let now = found(&f, &agent);
        assert_eq!(
            (
                refused,
                f.types().split_off(before),
                f.last_of("agent.respawn_rejected")
                    .map(|p| p["reason"].clone()),
                calls.lock().unwrap().len(),
                (
                    now.state,
                    now.generation,
                    now.terminal_id.map(|t| t.as_str().to_owned())
                ),
            ),
            (
                Err(AgentError::Conflict("still running".to_owned())),
                vec![
                    "agent.respawn_requested".to_owned(),
                    "agent.respawn_rejected".to_owned()
                ],
                Some(serde_json::json!("terminal_changed")),
                1,
                (AgentState::Exited, Some(generation), Some(terminal)),
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn rejects_a_respawn_its_harness_refuses_as_a_conflict_starting_nothing() {
        bazhen_test_signal::require_sandbox().unwrap();
        let stub = StubHarness::new(pull())
            .resuming()
            .refusing_resumes(LaunchError::Refused("session archived".to_owned()));
        let (f, agent, generation) = exited(&stub);
        let calls = Calls::default();
        let id = agent.as_str();
        let refused = runtime().block_on(f.agents.respawn(
            id,
            &respawning("r-1", generation),
            recording(&f, &calls),
        ));
        assert_eq!(
            (
                refused,
                f.last_of("agent.respawn_rejected")
                    .map(|p| p["reason"].clone()),
                calls.lock().unwrap().len(),
                respawned(&f).len(),
            ),
            (
                Err(AgentError::Conflict(format!(
                    "agent {id}'s harness won't resume it: session archived"
                ))),
                Some(serde_json::json!("harness_refused")),
                1,
                0,
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn keeps_the_session_its_tui_moved_to_while_it_started_again() {
        bazhen_test_signal::require_sandbox().unwrap();
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = exited(&stub);
        let launch = |f: &Fixture| {
            f.store
                .reader()
                .unwrap()
                .reads()
                .agent_launch(agent.as_str())
                .unwrap()
                .unwrap()
        };
        let moved = ExternalRef {
            id: "moved-session".to_owned(),
            ..launch(&f).external_ref.unwrap()
        };
        let store = f.store.clone();
        let moving = moved.clone();
        // A quick /clear in the new TUI, told while the respawn is under way.
        let replaced = move |agent: AgentId| -> BoxFuture<'static, ()> {
            Box::pin(async move {
                store
                    .run(move |store| {
                        store.write(|w| {
                            w.append(&bazhen_store::NewEvent::Agent {
                                agent,
                                actor: Actor::System.as_str().to_owned(),
                                change: AgentChange::ExternalRefUpdated(
                                    bazhen_protocol::agent_events::AgentExternalRefUpdated {
                                        external_ref: moving,
                                    },
                                ),
                            })
                        })
                    })
                    .await
                    .unwrap()
                    .unwrap();
            })
        };
        let answer = runtime().block_on(f.agents.respawn(
            agent.as_str(),
            &respawning("r-1", generation),
            replaced,
        ));
        assert_eq!(
            (
                answer.map(|answer| answer.event_ids.len()),
                launch(&f).external_ref,
                f.last_of("agent.respawned")
                    .map(|p| p["externalRef"]["id"].clone()),
            ),
            (Ok(2), Some(moved), Some(serde_json::json!("moved-session")))
        );
    }

    fn relaunching(key: &str, generation: u64, fresh: Option<bool>) -> RelaunchAgentRequest {
        RelaunchAgentRequest {
            idempotency_key: key.to_owned(),
            generation,
            theme: None,
            fresh,
        }
    }

    /// The agent's terminal now, and the command, generation and agent it was created with,
    /// where the runtime created one.
    fn created(f: &Fixture, agent: &AgentId) -> Option<(String, Vec<String>, u64, Option<String>)> {
        let terminal = found(f, agent).terminal_id?.as_str().to_owned();
        let mut spec = None;
        f.fake()
            .set(|state| spec = state.running.get(&terminal).map(|r| r.spec.clone()));
        let spec = spec?;
        let id = spec.env.get("BAZHEN_AGENT_ID").cloned();
        Some((terminal, spec.argv, spec.generation, id))
    }

    #[test]
    fn relaunches_a_lost_agent_on_a_new_terminal_at_the_next_generation_resuming_its_session() {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        let was = f.terminal_of(agent.as_str());
        let before = f.types().len();
        let calls = Calls::default();
        let id = agent.as_str();
        let [first, again] = [(); 2].map(|()| {
            runtime().block_on(f.agents.relaunch(
                id,
                &relaunching("r-1", generation, None),
                recording(&f, &calls),
            ))
        });
        let now = found(&f, &agent);
        let asked: Vec<Option<TuiTheme>> = stub
            .resumes_asked
            .lock()
            .unwrap()
            .iter()
            .map(|(request, _)| request.theme)
            .collect();
        let started = created(&f, &agent)
            .map(|(terminal, argv, at, as_agent)| (terminal != was, argv, at, as_agent));
        let mut resumed: Vec<String> = STUB_RESUME_ARGV.map(str::to_owned).to_vec();
        resumed.push(STUB_SESSION.to_owned());
        assert_eq!(
            (
                f.types().split_off(before),
                first.as_ref().map(|first| first.event_ids.len()),
                first == again,
                calls.lock().unwrap().clone(),
                asked,
                started,
                (now.state, now.generation),
            ),
            (
                vec![
                    "agent.relaunch_requested".to_owned(),
                    "agent.relaunched".to_owned()
                ],
                Ok(2),
                true,
                vec![(agent.clone(), Some("agent.relaunch_requested".to_owned()))],
                vec![Some(TuiTheme::Dark)],
                Some((true, resumed, generation + 1, Some(id.to_owned()))),
                (AgentState::Starting, Some(generation + 1)),
            )
        );
    }

    #[test]
    fn relaunches_a_lost_agent_its_harness_cant_resume_on_a_fresh_session_when_asked() {
        let stub = StubHarness::new(pull());
        let (f, agent, generation) = lost(&stub);
        let launched = f.fake().spec_of(&f.terminal_of(agent.as_str())).argv;
        let id = agent.as_str();
        let answer = runtime().block_on(f.agents.relaunch(
            id,
            &relaunching("r-1", generation, Some(true)),
            recording(&f, &Calls::default()),
        ));
        let started = created(&f, &agent).map(|(_, argv, at, _)| (argv == launched, at));
        assert_eq!(
            (
                answer.map(|answer| answer.event_ids.len()),
                stub.launches.lock().unwrap().len(),
                stub.resumes_asked.lock().unwrap().len(),
                started,
            ),
            (Ok(2), 2, 0, Some((true, generation + 1)))
        );
    }

    #[test]
    fn refuses_to_relaunch_an_agent_with_no_session_recording_nothing() {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        let unbound = agent.as_str().to_owned();
        runtime()
            .block_on(f.store.run(move |store| {
                store.write(|w| {
                    w.connection().execute(
                        "UPDATE agent_sessions SET external_ref = NULL WHERE id = ?",
                        [unbound],
                    )?;
                    Ok::<_, rusqlite::Error>(())
                })
            }))
            .unwrap()
            .unwrap();
        let before = f.types().len();
        let id = agent.as_str();
        let refused = runtime().block_on(f.agents.relaunch(
            id,
            &relaunching("r-1", generation, None),
            recording(&f, &Calls::default()),
        ));
        assert_eq!(
            (refused, f.types().len(), found(&f, &agent).state),
            (
                Err(AgentError::NotResumable(format!(
                    "agent {id} has no session to resume; relaunch it fresh to start it on a new session"
                ))),
                before,
                AgentState::Lost
            )
        );
    }

    #[test]
    fn refuses_to_relaunch_an_agent_whose_session_cant_resume_recording_nothing() {
        let stub = StubHarness::new(pull());
        let (f, agent, generation) = lost(&stub);
        let before = f.types().len();
        let calls = Calls::default();
        let id = agent.as_str();
        let refused = runtime().block_on(f.agents.relaunch(
            id,
            &relaunching("r-1", generation, None),
            recording(&f, &calls),
        ));
        assert_eq!(
            (
                refused,
                f.types().len(),
                calls.lock().unwrap().len(),
                found(&f, &agent).state
            ),
            (
                Err(AgentError::NotResumable(format!(
                    "agent {id}'s harness can't resume its session; relaunch it fresh to start it on a new session"
                ))),
                before,
                0,
                AgentState::Lost
            )
        );
    }

    #[test]
    fn refuses_a_relaunch_past_the_budget_recording_nothing() {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost_on(crate::agents::tests::setup_with(
            crate::agents::tests::Setup {
                harnesses: stub.served_as(bazhen_protocol::agents::HarnessId::ClaudeCode),
                max: 1,
                ..crate::agents::tests::Setup::default()
            },
        ));
        // The one slot, which the lost terminal gave up, taken by another agent.
        runtime().block_on(f.launch(request("k-2"))).unwrap();
        let before = f.types().len();
        let refused = runtime().block_on(f.agents.relaunch(
            agent.as_str(),
            &relaunching("r-1", generation, None),
            recording(&f, &Calls::default()),
        ));
        assert!(matches!(refused, Err(AgentError::Limit(_))), "{refused:?}");
        assert_eq!(f.types().len(), before);
    }

    /// What a relaunch of a lost agent did.
    struct Beside {
        answer: Result<AgentCommandResponse, AgentError>,
        id: String,
        /// The terminal it was lost on.
        was: String,
        /// The events it recorded, the agent's state, whether it is still on the terminal it
        /// was lost on, and the state its new terminal was left in.
        after: (
            Vec<String>,
            AgentState,
            bool,
            Option<bazhen_protocol::shells::TerminalState>,
        ),
    }

    /// A relaunch of a lost agent, once `prepare` was given the fixture and its old terminal.
    fn relaunched_beside(prepare: impl FnOnce(&Fixture, &str)) -> Beside {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        let was = f.terminal_of(agent.as_str());
        prepare(&f, &was);
        let before = f.types().len();
        let answer = runtime().block_on(f.agents.relaunch(
            agent.as_str(),
            &relaunching("r-1", generation, None),
            recording(&f, &Calls::default()),
        ));
        let now = found(&f, &agent);
        let new = f
            .last_of("agent.relaunch_requested")
            .and_then(|p| p["terminalId"].as_str().map(str::to_owned))
            .and_then(|new| {
                f.store
                    .reader()
                    .unwrap()
                    .reads()
                    .terminal_state(&new)
                    .unwrap()
            });
        Beside {
            answer,
            id: agent.as_str().to_owned(),
            after: (
                f.types().split_off(before),
                now.state,
                now.terminal_id.is_some_and(|t| t.as_str() == was),
                new,
            ),
            was,
        }
    }

    /// Requested then rejected, the agent lost on its old terminal, the new one failed.
    fn rejected() -> (
        Vec<String>,
        AgentState,
        bool,
        Option<bazhen_protocol::shells::TerminalState>,
    ) {
        (
            vec![
                "agent.relaunch_requested".to_owned(),
                "agent.relaunch_rejected".to_owned(),
            ],
            AgentState::Lost,
            true,
            Some(bazhen_protocol::shells::TerminalState::Failed),
        )
    }

    #[test]
    fn refuses_a_relaunch_while_the_lost_terminal_isnt_proved_gone() {
        let Beside {
            answer,
            id,
            was,
            after,
        } = relaunched_beside(|f, was| {
            f.fake().set(|state| {
                state.unproven.insert(was.to_owned());
            });
        });
        assert_eq!(
            (answer, after),
            (
                Err(AgentError::Conflict(format!(
                    "agent {id} already has a terminal: {was} isn't proved gone"
                ))),
                rejected()
            )
        );
    }

    #[test]
    fn refuses_a_relaunch_while_a_terminal_an_earlier_one_asked_for_may_yet_start() {
        let stub = StubHarness::new(pull()).resuming();
        let (f, agent, generation) = lost(&stub);
        let relaunch = |key: &str| {
            runtime().block_on(f.agents.relaunch(
                agent.as_str(),
                &relaunching(key, generation, None),
                recording(&f, &Calls::default()),
            ))
        };
        f.fake().set(|state| {
            state.creates_refused = Some(crate::terminals::fake::refused());
            state.hello_margin = std::time::Duration::from_secs(3600);
        });
        let refused_create = relaunch("r-1");
        let asked = f
            .last("agent.relaunch_requested")
            .get("terminalId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap();
        f.fake().set(|state| state.creates_refused = None);
        let while_it_may_start = relaunch("r-2");
        f.fake()
            .set(|state| state.hello_margin = std::time::Duration::ZERO);
        let once_it_cant = relaunch("r-3").map(|_| ());
        assert_eq!(
            (refused_create.is_err(), while_it_may_start, once_it_cant),
            (
                true,
                Err(AgentError::Conflict(format!(
                    "agent {agent} already has a terminal: {asked} may still be starting; try \
                     again shortly"
                ))),
                Ok(())
            )
        );
    }

    #[test]
    fn refuses_a_relaunch_when_no_runtime_confirmed_where_the_lost_terminal_ran() {
        let Beside {
            answer, id, after, ..
        } = relaunched_beside(|f, was| {
            let was = was.to_owned();
            runtime()
                .block_on(f.store.run(move |store| {
                    store.write(|w| {
                        w.connection()
                            .execute("UPDATE terminals SET locator = NULL WHERE id = ?", [was])?;
                        Ok::<_, rusqlite::Error>(())
                    })
                }))
                .unwrap()
                .unwrap();
        });
        assert_eq!(
            (answer, after),
            (
                Err(AgentError::Unavailable(format!(
                    "agent {id} could not be started again: no runtime confirmed where its last terminal ran, so nothing proves it gone"
                ))),
                rejected()
            )
        );
    }
}
