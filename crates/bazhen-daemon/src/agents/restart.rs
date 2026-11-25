//! Starting an agent again (`Lifecycle.respawn` in `agents/lifecycle.ts`): its exited process
//! is started again in the same terminal, resuming its harness session, at the next generation.
//! `respawn_requested` is recorded first, so a daemon that dies meanwhile finds a respawn to
//! settle; one rejected returns the agent to exited, its terminal kept and still closable.

use bazhen_harness::{BoxFuture, LaunchError, LaunchRequest, LaunchSpec};
use bazhen_protocol::agent_events::{AgentRespawnRejected, AgentRestarted, RespawnRejectedReason};
use bazhen_protocol::agents::{
    AgentCommand, AgentCommandResponse, ExternalRef, RespawnAgentRequest,
};
use bazhen_protocol::events::RuntimeRefPayload;
use bazhen_protocol::ids::AgentId;
use bazhen_protocol::record::Record;
use bazhen_protocol::shells::TuiTheme;
use bazhen_store::{Actor, AgentChange, AgentLaunch, Writer as StoreWriter};

use super::lifecycle::{Begun, append, asked, from_runtime, offers, recorded};
use super::prompts::{Composed, FLEET, compose};
use super::{AgentError, Agents};
use crate::failure::failure_detail;
use crate::shells::RUNTIME;
use crate::terminals::{Recorded, Restart, TerminalError};

/// What stopped a start once it was recorded requested.
enum Failed {
    /// The harness wouldn't, or couldn't, give the command to resume its session.
    Harness(LaunchError),
    /// The runtime didn't start the process again.
    Terminal(TerminalError),
    /// The agent's new token couldn't be made.
    Token(String),
}

impl Failed {
    fn detail(&self) -> String {
        failure_detail(&match self {
            Self::Harness(LaunchError::Refused(why) | LaunchError::Unavailable(why))
            | Self::Token(why) => why.clone(),
            Self::Terminal(err) => err.to_string(),
        })
    }

    /// Why the respawn was rejected, as `agent.respawn_rejected` records it (`rejection`).
    fn rejected(&self) -> AgentRespawnRejected {
        let reason = match self {
            Self::Harness(LaunchError::Refused(_)) => RespawnRejectedReason::HarnessRefused,
            Self::Terminal(
                TerminalError::Stale(_) | TerminalError::Gone(_) | TerminalError::ProcessState(_),
            ) => RespawnRejectedReason::TerminalChanged,
            Self::Harness(LaunchError::Unavailable(_)) | Self::Terminal(_) | Self::Token(_) => {
                RespawnRejectedReason::Unavailable
            }
        };
        AgentRespawnRejected {
            reason,
            detail: Some(self.detail()),
        }
    }

    /// The failure as the command's answer.
    fn answer(self, id: &str) -> AgentError {
        match self {
            Self::Terminal(err) => from_runtime(id, err),
            Self::Harness(LaunchError::Refused(why)) => {
                AgentError::Conflict(format!("agent {id}'s harness won't resume it: {why}"))
            }
            Self::Harness(LaunchError::Unavailable(why)) | Self::Token(why) => {
                AgentError::Unavailable(format!("agent {id} could not be started again: {why}"))
            }
        }
    }
}

/// What a start again gave: where its terminal runs now, the session it resumed, and the theme
/// it drew for.
struct Resumed {
    locator: Record<String>,
    session: Option<ExternalRef>,
    theme: Option<TuiTheme>,
}

/// What a start again is started with, beside the agent.
struct Again<'a> {
    launch: &'a AgentLaunch,
    session: &'a ExternalRef,
    terminal: Recorded,
    generation: u64,
    prompt: Composed,
    prompt_file: String,
    theme: Option<TuiTheme>,
}

/// A respawn that started, to be recorded with its key's answer.
struct Done {
    agent: AgentId,
    /// The session it resumed.
    was: String,
    harness_name: Option<String>,
    prompt_hash: String,
    resumed: Resumed,
}

impl Done {
    /// Records the agent respawned. A TUI that moved its binding while it started, as a quick
    /// /clear does, is on the newer session, read here in the same transaction.
    fn recorded(self, w: &StoreWriter<'_>) -> Result<u64, AgentError> {
        let current = w
            .reads()
            .agent_launch(self.agent.as_str())?
            .and_then(|now| now.external_ref);
        let external_ref = match current {
            Some(current) if current.id != self.was => Some(current),
            _ => self.resumed.session,
        };
        let respawned = AgentChange::Respawned(AgentRestarted {
            external_ref,
            runtime_ref: RuntimeRefPayload {
                runtime: RUNTIME.to_owned(),
                locator: self.resumed.locator,
            },
            theme: self.resumed.theme,
            harness_name: self.harness_name,
            prompt_hash: Some(self.prompt_hash),
        });
        append(w, &self.agent, Actor::User, respawned)
    }
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
        let found = match self
            .begin(
                id,
                key,
                &request,
                req.generation,
                offers(AgentCommand::Respawn),
            )
            .await?
        {
            Begun::Prior(prior) => return Ok(prior),
            Begun::Found(found) => found,
        };
        let agent = found.agent_id.clone();
        let reading = agent.clone();
        let launch = self
            .write(move |w| Ok(w.reads().agent_launch(reading.as_str())?))
            .await?;
        let no_terminal = || AgentError::Conflict(format!("agent {id} has no terminal recorded"));
        let (Some(launch), Some(terminal), Some(generation)) =
            (launch, recorded(&found), found.generation)
        else {
            return Err(no_terminal());
        };
        // Known before anything happens, so it is refused with nothing recorded.
        let session = launch
            .external_ref
            .as_ref()
            .filter(|_| self.resumes(&launch))
            .ok_or_else(|| AgentError::NotResumable(id.to_owned()))?;
        self.refuse_taken(&agent, &launch, session).await?;
        let roles = self.deps.roles.current();
        let prompt = compose(FLEET, &roles.book, launch.role.as_ref());
        let prompt_file = self
            .deps
            .prompts
            .write(&agent, &prompt.text)
            .map_err(|err| {
                AgentError::Internal(format!("agent {agent}'s prompt can't be written: {err}"))
            })?
            .to_string_lossy()
            .into_owned();
        let requesting = agent.clone();
        let requested = self
            .write(move |w| append(w, &requesting, Actor::User, AgentChange::RespawnRequested))
            .await?;
        replaced(agent.clone()).await;
        let again = Again {
            launch: &launch,
            session,
            terminal,
            generation: generation + 1,
            prompt,
            prompt_file,
            // Drawn as it was last, unless it is asked otherwise.
            theme: req.theme.or(launch.theme),
        };
        let prompt_hash = again.prompt.hash.clone();
        match self.start_again(&agent, again).await {
            Err(failed) => {
                let rejecting = agent.clone();
                let rejected = AgentChange::RespawnRejected(failed.rejected());
                self.write(move |w| append(w, &rejecting, Actor::User, rejected))
                    .await?;
                Err(failed.answer(id))
            }
            Ok(resumed) => {
                let done = Done {
                    agent: agent.clone(),
                    was: session.id.clone(),
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

    /// Starts the agent's process again in its terminal, on a new token, resuming its session.
    async fn start_again(&self, agent: &AgentId, again: Again<'_>) -> Result<Resumed, Failed> {
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
        let resuming = harness
            .resume(&request, again.session, None)
            .ok_or_else(|| {
                Failed::Harness(LaunchError::Refused(
                    "its harness starts no session again".to_owned(),
                ))
            })?;
        let LaunchSpec {
            argv,
            env,
            theme,
            session,
        } = resuming.await.map_err(Failed::Harness)?;
        let token = self
            .deps
            .tokens
            .mint(agent)
            .await
            .map_err(|err| Failed::Token(err.to_string()))?;
        let (argv, env) = self.process_of(agent, &token.file, argv, env);
        let restart = Restart {
            argv,
            cwd: again.launch.cwd.clone(),
            env,
            theme,
            generation: again.generation,
        };
        match self.deps.terminals.respawn(&again.terminal, restart).await {
            Ok(locator) => {
                token.kept().await;
                Ok(Resumed {
                    locator,
                    session: session.map(|session| ExternalRef {
                        environment_id: again.session.environment_id.clone(),
                        kind: session.kind,
                        id: session.id,
                    }),
                    theme,
                })
            }
            Err(err) => {
                token.abandoned().await;
                Err(Failed::Terminal(err))
            }
        }
    }
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
        let f = stubbed(stub);
        let launch = LaunchAgentRequest {
            theme: Some(TuiTheme::Light),
            ..request("k-1")
        };
        let agent = runtime().block_on(f.launch(launch)).unwrap().agent_id;
        f.fake_exit_unseen(&f.terminal_of(agent.as_str()));
        let recorded = agent.clone();
        runtime()
            .block_on(f.store.run(move |store| {
                store.write(|w| {
                    w.append(&NewEvent::Agent {
                        agent: recorded,
                        actor: Actor::System.as_str().to_owned(),
                        change: AgentChange::Exited(AgentExited {
                            exit: ExitStatus::Unknown,
                        }),
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
            runtime()
                .block_on(f.agents.respawn(
                    id,
                    &respawning("r-1", generation),
                    recording(&f, &calls),
                ))
                .unwrap()
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
                first.event_ids.len(),
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
                2,
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
                Err(AgentError::NotResumable(id.to_owned())),
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
                refused.is_err(),
                f.types().split_off(before),
                f.last("agent.respawn_rejected")["reason"].clone(),
                calls.lock().unwrap().len(),
                (
                    now.state,
                    now.generation,
                    now.terminal_id.map(|t| t.as_str().to_owned())
                ),
            ),
            (
                true,
                vec![
                    "agent.respawn_requested".to_owned(),
                    "agent.respawn_rejected".to_owned()
                ],
                serde_json::json!("terminal_changed"),
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
                f.last("agent.respawn_rejected")["reason"].clone(),
                calls.lock().unwrap().len(),
                respawned(&f).len(),
            ),
            (
                Err(AgentError::Conflict(format!(
                    "agent {id}'s harness won't resume it: session archived"
                ))),
                serde_json::json!("harness_refused"),
                1,
                0,
            )
        );
    }
}
