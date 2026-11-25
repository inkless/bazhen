//! The commands on an agent once it is launched (`agents/lifecycle.ts`): each runs in its agent's
//! turn, a repeated key gets the first answer, and otherwise the agent must be in a state the
//! command accepts, at the generation it names (`Lifecycle.command`).

use bazhen_core::agent::agent_commands;
use bazhen_holder_proto::body::{ExitStatus, Exited};
use bazhen_protocol::agent_events::{AgentExited, AgentSignalled};
use bazhen_protocol::agents::{
    AgentCommand, AgentCommandResponse, AgentState, CloseAgentRequest, SignalAgentRequest,
};
use bazhen_protocol::ids::{AgentId, TerminalId};
use bazhen_protocol::mail_events::{MailUndeliverable, UndeliverableReason};
use bazhen_protocol::record::Record;
use bazhen_store::{
    Actor, AgentChange, AgentTerminal, AppendError, MailChange, NewEvent, Writer as StoreWriter,
    takes_exit,
};
use serde::Serialize;

use super::{AgentError, Agents};
use crate::terminals::{Recorded, TerminalError};

/// The request as the idempotency key keeps it, as `JSON.stringify` writes
/// `{ command, agentId, ...req }`: the command first, then the agent, then the request's keys in
/// its schema's order.
#[derive(Serialize)]
struct Asked<'a, R> {
    command: &'a str,
    #[serde(rename = "agentId")]
    agent_id: &'a str,
    #[serde(flatten)]
    request: &'a R,
}

pub(super) fn asked<R: Serialize>(
    command: &str,
    agent_id: &str,
    request: &R,
) -> Result<String, AgentError> {
    serde_json::to_string(&Asked {
        command,
        agent_id,
        request,
    })
    .map_err(|e| AgentError::Internal(e.to_string()))
}

/// What a command found: the first answer to its key, or the agent it may act on.
pub(super) enum Begun {
    Prior(AgentCommandResponse),
    Found(AgentTerminal),
}

/// Whether the agent is offered `command` now (`agentCommands`).
pub(super) fn offers(command: AgentCommand) -> impl Fn(&AgentTerminal) -> bool {
    move |found| agent_commands(found.state, found.terminal_state).contains(&command)
}

/// Where the agent's terminal runs, once a runtime has confirmed it.
pub(super) fn recorded(found: &AgentTerminal) -> Option<Recorded> {
    Some(Recorded {
        terminal_id: found.terminal_id.clone()?,
        locator: found.locator.clone()?,
    })
}

/// What a forced close leaves running, as its log line says it (`stillRunning`).
fn still_running(found: &AgentTerminal) -> String {
    let field = |name: &str| {
        found
            .locator
            .as_deref()
            .and_then(|text| serde_json::from_str::<Record<String>>(text).ok())
            .and_then(|locator| {
                locator
                    .entries()
                    .iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.clone())
            })
            .unwrap_or_else(|| "unknown".to_owned())
    };
    if found.runtime.as_deref() == Some("holder") {
        format!(
            "its holder (pid {}) may still be running it",
            field("holderPid")
        )
    } else {
        format!(
            "its terminal's tmux server (pid {}) may still be running it",
            field("serverPid")
        )
    }
}

/// The agent's process exited, as its terminal's stream told before any view hears of it
/// (`told`): recorded then, ahead of the runtime's next report, so whoever acts on the exit finds
/// the agent exited. Only the exit of the generation recorded is taken, by a terminal whose
/// state takes one; any other is the runtime's report to read. A terminal no agent runs in now
/// is no agent's.
pub(crate) fn told(
    w: &StoreWriter<'_>,
    terminal: &TerminalId,
    exit: &Exited,
) -> Result<(), AppendError> {
    exited_at(w, terminal, exit.generation.get(), &exit.status)
}

/// `told`, of the process of `generation` that ended as `status` says, however the daemon heard.
pub(crate) fn exited_at(
    w: &StoreWriter<'_>,
    terminal: &TerminalId,
    generation: u64,
    status: &ExitStatus,
) -> Result<(), AppendError> {
    let Some(found) = w.reads().agent_of_terminal(terminal.as_str())? else {
        return Ok(());
    };
    if found.generation != Some(generation) || !found.terminal_state.is_some_and(takes_exit) {
        return Ok(());
    }
    w.append(&NewEvent::Agent {
        agent: found.agent_id,
        actor: Actor::System.as_str().to_owned(),
        change: AgentChange::Exited(AgentExited {
            exit: crate::stream::hub::exit_status(status),
        }),
    })?;
    Ok(())
}

/// Appends one change to `agent`, as `actor` made it.
pub(super) fn append(
    w: &StoreWriter<'_>,
    agent: &AgentId,
    actor: Actor,
    change: AgentChange,
) -> Result<u64, AgentError> {
    Ok(w.append(&NewEvent::Agent {
        agent: agent.clone(),
        actor: actor.as_str().to_owned(),
        change,
    })?)
}

/// Records `agent` closed, and the mail still on its way to it undeliverable, as `actor` closed
/// it (`recordClosed`): in the caller's transaction, so no mail is left on its way to an agent
/// recorded closed but a row whose id no message could have, which `in_flight_mail` skips.
pub(crate) fn record_closed(
    w: &StoreWriter<'_>,
    agent: &AgentId,
    actor: Actor,
) -> Result<Vec<u64>, AgentError> {
    let mut ids = vec![append(w, agent, actor, AgentChange::Closed)?];
    for message in w.reads().in_flight_mail(agent.as_str())? {
        ids.push(w.append(&NewEvent::Mail {
            message,
            actor: Actor::System.as_str().to_owned(),
            change: MailChange::Undeliverable(MailUndeliverable {
                reason: UndeliverableReason::AgentClosed,
            }),
        })?);
    }
    Ok(ids)
}

/// What a command was doing to an agent when its runtime failed, for the words its answer uses.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Doing {
    Close,
    Signal,
    /// A respawn or a relaunch.
    Start,
}

impl Doing {
    /// The agent, as the command would have left it: "closed".
    const fn done(self) -> &'static str {
        match self {
            Self::Close => "closed",
            Self::Signal => "signalled",
            Self::Start => "started again",
        }
    }

    /// What may be done once its holder's process has ended.
    const fn after(self) -> &'static str {
        match self {
            Self::Close => "close it again, or relaunch it",
            Self::Signal | Self::Start => "relaunch it",
        }
    }
}

/// The runtime's failure as a command on agent `id`'s (`fromEnvironment`): typed where the
/// caller can act on it, else the environment out of reach.
pub(crate) fn from_runtime(id: &str, doing: Doing, cause: TerminalError) -> AgentError {
    match cause {
        TerminalError::Stale(_) | TerminalError::Gone(_) => AgentError::Conflict(format!(
            "agent {id}'s terminal is not the one recorded; its server or pane has changed"
        )),
        TerminalError::ProcessState(message) => AgentError::Conflict(message),
        TerminalError::Unservable {
            protocol,
            holder_pid,
        } => {
            let holder = holder_pid.map_or_else(
                || "its holder".to_owned(),
                |pid| format!("its holder, pid {pid},"),
            );
            AgentError::NeedsRestart(format!(
                "agent {id}'s terminal runs on a holder that speaks only {}, which this version of Bazhen doesn't, so it can't be {} from here: {holder} keeps running until its process is ended. Once it has, {}.",
                protocol.join(", "),
                doing.done(),
                doing.after(),
            ))
        }
        TerminalError::Unconfirmed(_) => AgentError::ServerUnconfirmed(match doing {
            Doing::Close => format!(
                "agent {id}'s terminal is no longer where it ran, but what ran it may still be running it; close it with force to record it closed anyway"
            ),
            Doing::Signal | Doing::Start => format!(
                "agent {id}'s terminal is no longer where it ran, but what ran it may still be running it, so it can't be {}; close it, and if its close is refused the same way, close it with force to record it closed",
                doing.done()
            ),
        }),
        other @ (TerminalError::Other(_)
        | TerminalError::Unreachable(_)
        | TerminalError::Predates { .. }
        | TerminalError::Unreadable { .. }) => AgentError::Unavailable(format!(
            "could not reach the environment running agent {id}: {other}"
        )),
    }
}

impl Agents {
    /// The first answer to `key`, or the agent `id` names if it accepts the command at
    /// `generation`. Taken in the agent's turn.
    pub(super) async fn begin(
        &self,
        id: &str,
        key: &str,
        request: &str,
        generation: u64,
        accepts: impl Fn(&AgentTerminal) -> bool,
    ) -> Result<Begun, AgentError> {
        let (agent, key, request) = (id.to_owned(), key.to_owned(), request.to_owned());
        let (prior, found) = self
            .write(move |w| {
                let prior = w.replay::<AgentCommandResponse>(&key, &request)?;
                let found = w.reads().agent_terminal(&agent)?;
                Ok((prior, found))
            })
            .await?;
        if let Some(prior) = prior {
            return Ok(Begun::Prior(prior));
        }
        let found = found.ok_or_else(|| AgentError::Unknown(id.to_owned()))?;
        if !accepts(&found) {
            return Err(AgentError::Conflict(format!(
                "agent {id} is {}",
                found.state.as_str()
            )));
        }
        if found.generation != Some(generation) {
            return Err(AgentError::Stale {
                id: id.to_owned(),
                generation: found.generation,
            });
        }
        Ok(Begun::Found(found))
    }

    /// Records a command's last steps, as `last` appends them, with the key's answer, in one
    /// transaction.
    pub(super) async fn finish(
        &self,
        agent: &AgentId,
        key: &str,
        request: &str,
        last: impl FnOnce(&StoreWriter<'_>) -> Result<Vec<u64>, AgentError> + Send + 'static,
    ) -> Result<AgentCommandResponse, AgentError> {
        let (agent, key, request) = (agent.clone(), key.to_owned(), request.to_owned());
        self.write(move |w| {
            let response = AgentCommandResponse {
                event_ids: last(w)?,
                agent_id: agent,
            };
            w.answered(&key, &request, &response)?;
            Ok(response)
        })
        .await
    }

    /// Ends an agent and its terminal. `closing` is recorded before the terminal is touched; if
    /// the runtime can't be reached the agent stays closing, and the same command finishes it
    /// later. A lost agent's terminal is already gone, so it closes without the runtime.
    pub(crate) async fn close(
        &self,
        id: &str,
        req: &CloseAgentRequest,
    ) -> Result<AgentCommandResponse, AgentError> {
        let request = asked("close", id, req)?;
        let key = &req.idempotency_key;
        let force = req.force == Some(true);
        // Force only finishes a close already refused: anything else still ends its terminal.
        let accepts = |found: &AgentTerminal| {
            if force {
                found.state == AgentState::Closing
            } else {
                found.state == AgentState::Closed || offers(AgentCommand::Close)(found)
            }
        };
        let _turn = self.deps.turns.take(id).await;
        let found = match self
            .begin(id, key, &request, req.generation, accepts)
            .await?
        {
            Begun::Prior(prior) => return Ok(prior),
            Begun::Found(found) => found,
        };
        let agent = found.agent_id.clone();
        if found.state == AgentState::Closed {
            return self.finish(&agent, key, &request, |_| Ok(Vec::new())).await;
        }
        let closing = if found.state == AgentState::Closing {
            let agent = id.to_owned();
            self.write(move |w| Ok(w.reads().last_event_id(&agent, "agent.closing")?))
                .await?
        } else {
            let agent = agent.clone();
            Some(
                self.write(move |w| append(w, &agent, Actor::User, AgentChange::Closing))
                    .await?,
            )
        };
        if found.state != AgentState::Lost {
            self.end(&found, force).await?;
        }
        self.deps.tokens.forget(&agent);
        let closed = agent.clone();
        let response = self
            .finish(&agent, key, &request, move |w| {
                let mut ids: Vec<u64> = closing.into_iter().collect();
                ids.extend(record_closed(w, &closed, Actor::User)?);
                Ok(ids)
            })
            .await?;
        self.deps.prompts.remove(&agent);
        Ok(response)
    }

    /// Closes the agent's terminal. Force records closed only what a close could not end: a
    /// terminal its old server may still run, or one a runtime that can't be reached holds. It
    /// never skips a close that would work.
    async fn end(&self, found: &AgentTerminal, force: bool) -> Result<(), AgentError> {
        let Some(terminal) = recorded(found) else {
            return Ok(());
        };
        match self.deps.terminals.close(&terminal).await {
            Ok(()) => Ok(()),
            Err(cause) if force && cause.forceable() => {
                tracing::warn!(
                    "bazhen: agent {} closed by force; {}",
                    found.agent_id,
                    still_running(found)
                );
                Ok(())
            }
            Err(cause) => Err(from_runtime(found.agent_id.as_str(), Doing::Close, cause)),
        }
    }

    /// Signals a running agent's process; an exit it causes is recorded when the runtime tells
    /// of it.
    pub(crate) async fn signal(
        &self,
        id: &str,
        req: &SignalAgentRequest,
    ) -> Result<AgentCommandResponse, AgentError> {
        let request = asked("signal", id, req)?;
        let key = &req.idempotency_key;
        let _turn = self.deps.turns.take(id).await;
        let found = match self
            .begin(
                id,
                key,
                &request,
                req.generation,
                offers(AgentCommand::Signal),
            )
            .await?
        {
            Begun::Prior(prior) => return Ok(prior),
            Begun::Found(found) => found,
        };
        let terminal = recorded(&found)
            .ok_or_else(|| AgentError::Conflict(format!("agent {id} has no terminal running")))?;
        self.deps
            .terminals
            .signal(&terminal, req.signal)
            .await
            .map_err(|cause| from_runtime(id, Doing::Signal, cause))?;
        let (agent, signal) = (found.agent_id.clone(), req.signal);
        self.finish(&found.agent_id, key, &request, move |w| {
            let change = AgentChange::Signalled(AgentSignalled { signal });
            Ok(vec![append(w, &agent, Actor::User, change)?])
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::agents::Signal;

    use super::*;
    use crate::agents::tests::{Fixture, Setup, request, setup_with};
    use crate::terminals::TerminalError;
    use crate::testing::runtime;

    fn launched() -> (Fixture, AgentId, u64) {
        let f = setup_with(Setup::default());
        let launched = runtime().block_on(f.launch(request("k-1"))).unwrap();
        let generation = f
            .store
            .reader()
            .unwrap()
            .reads()
            .agent_terminal(launched.agent_id.as_str())
            .unwrap()
            .unwrap()
            .generation
            .unwrap();
        (f, launched.agent_id, generation)
    }

    fn closing(key: &str, generation: u64) -> CloseAgentRequest {
        CloseAgentRequest {
            idempotency_key: key.to_owned(),
            generation,
            force: None,
            keep_shells: None,
            confirm_busy: None,
            confirmed_busy: None,
        }
    }

    fn forcing(key: &str, generation: u64) -> CloseAgentRequest {
        CloseAgentRequest {
            force: Some(true),
            ..closing(key, generation)
        }
    }

    /// Records `change` to the agent, as the system made it.
    fn mark(f: &Fixture, agent: &AgentId, change: AgentChange) {
        let agent = agent.clone();
        runtime()
            .block_on(
                f.store
                    .run(move |store| store.write(|w| append(w, &agent, Actor::System, change))),
            )
            .unwrap()
            .unwrap();
    }

    /// Mail queued for the agent, still on its way to it.
    fn queue_mail(f: &Fixture, agent: &AgentId) {
        let agent = agent.clone();
        runtime()
            .block_on(f.store.run(move |store| {
                store.write(|w| {
                    w.append(&NewEvent::Mail {
                        message: bazhen_protocol::ids::MessageId::parse(
                            "msg_0190a1b2c3d47abc8def0123456789a1",
                        )
                        .unwrap(),
                        actor: "user".to_owned(),
                        change: MailChange::Queued(bazhen_protocol::mail_events::MailQueued {
                            agent_id: agent,
                            body: "b".to_owned(),
                            from: None,
                        }),
                    })
                })
            }))
            .unwrap()
            .unwrap();
    }

    /// The types of the events recorded after the first `from`.
    fn since(f: &Fixture, from: usize) -> Vec<String> {
        f.types().split_off(from)
    }

    fn closed_terminals(f: &Fixture) -> Vec<String> {
        let mut closed = Vec::new();
        f.fake().set(|state| closed.clone_from(&state.closed));
        closed
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_a_running_agent_ending_its_terminal_and_making_its_mail_on_the_way_undeliverable() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (f, agent, generation) = launched();
        queue_mail(&f, &agent);
        let before = f.types().len();
        let id = agent.as_str();
        let [first, again] = [(); 2].map(|()| {
            runtime()
                .block_on(f.agents.close(id, &closing("c-1", generation)))
                .unwrap()
        });
        let ids: Vec<u64> = (before + 1..=before + 3).map(|n| n as u64).collect();
        assert_eq!(
            (
                since(&f, before),
                first.event_ids.clone(),
                first == again,
                closed_terminals(&f),
                f.token_files(),
                f.prompts(),
            ),
            (
                vec![
                    "agent.closing".to_owned(),
                    "agent.closed".to_owned(),
                    "mailbox.undeliverable".to_owned()
                ],
                ids,
                true,
                vec![f.terminal_of(id)],
                Vec::<String>::new(),
                Vec::<String>::new(),
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn leaves_an_agent_closing_when_its_runtime_cant_be_reached_and_a_later_close_finishes_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (f, agent, generation) = launched();
        let before = f.types().len();
        let id = agent.as_str();
        f.fake().set(|state| state.fail_closes = true);
        let refused = runtime().block_on(f.agents.close(id, &closing("c-1", generation)));
        let left = since(&f, before);
        f.fake().set(|state| state.fail_closes = false);
        let finished = runtime()
            .block_on(f.agents.close(id, &closing("c-2", generation)))
            .unwrap();
        let first_closing = before as u64 + 1;
        assert!(
            matches!(&refused, Err(AgentError::Unavailable(m)) if m.starts_with(&format!("could not reach the environment running agent {id}"))),
            "{refused:?}"
        );
        assert_eq!(
            (left, finished.event_ids, closed_terminals(&f)),
            (
                vec!["agent.closing".to_owned()],
                vec![first_closing, first_closing + 1],
                vec![f.terminal_of(id)]
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn forces_only_a_close_already_refused_and_only_past_a_failure_force_may_record_past() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (f, agent, generation) = launched();
        let id = agent.as_str();
        let early = runtime().block_on(f.agents.close(id, &forcing("c-1", generation)));
        f.fake().set(|state| state.fail_closes = true);
        let _ = runtime().block_on(f.agents.close(id, &closing("c-2", generation)));
        f.fake().set(|state| {
            state.fail_closes = false;
            state.closes_refused = Some(TerminalError::Stale("replaced".to_owned()));
        });
        let stale = runtime().block_on(f.agents.close(id, &forcing("c-3", generation)));
        f.fake().set(|state| {
            state.closes_refused = None;
            state.fail_closes = true;
        });
        let forced = runtime().block_on(f.agents.close(id, &forcing("c-4", generation)));
        assert_eq!(
            (
                early,
                stale.map(|_| ()),
                forced.map(|_| ()),
                f.types().last().cloned()
            ),
            (
                Err(AgentError::Conflict(format!("agent {id} is starting"))),
                Err(AgentError::Conflict(format!(
                    "agent {id}'s terminal is not the one recorded; its server or pane has changed"
                ))),
                Ok(()),
                Some("agent.closed".to_owned())
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_a_lost_agent_without_asking_its_runtime() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (f, agent, generation) = launched();
        mark(&f, &agent, AgentChange::Lost);
        f.fake().set(|state| state.fail_closes = true);
        let before = f.types().len();
        let closed =
            runtime().block_on(f.agents.close(agent.as_str(), &closing("c-1", generation)));
        assert_eq!(
            (closed.map(|_| ()), since(&f, before), closed_terminals(&f)),
            (
                Ok(()),
                vec!["agent.closing".to_owned(), "agent.closed".to_owned()],
                Vec::<String>::new()
            )
        );
    }

    fn signalling(key: &str, generation: u64) -> SignalAgentRequest {
        SignalAgentRequest {
            idempotency_key: key.to_owned(),
            generation,
            signal: Signal::Sigint,
        }
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn signals_a_running_agents_process_through_its_runtime_and_records_it_once_per_key() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (f, agent, generation) = launched();
        let id = agent.as_str();
        let [first, again] = [(); 2].map(|()| {
            runtime()
                .block_on(f.agents.signal(id, &signalling("s-1", generation)))
                .unwrap()
        });
        let terminal = f.terminal_of(id);
        assert_eq!(
            (
                first.event_ids.len(),
                first == again,
                f.fake_signalled(),
                f.types().last().cloned()
            ),
            (
                1,
                true,
                vec![(terminal, Signal::Sigint)],
                Some("agent.signalled".to_owned())
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_a_signal_at_another_generation_or_to_an_agent_it_doesnt_know_recording_nothing() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (f, agent, generation) = launched();
        let before = f.types();
        let id = agent.as_str();
        let stale = runtime().block_on(f.agents.signal(id, &signalling("s-1", generation + 1)));
        let unknown = runtime().block_on(f.agents.signal(
            "agent_0190a1b2c3d47abc8def0123456789a1",
            &signalling("s-2", generation),
        ));
        assert_eq!(
            (stale, unknown, f.types() == before, f.fake_signalled()),
            (
                Err(AgentError::Stale {
                    id: id.to_owned(),
                    generation: Some(generation)
                }),
                Err(AgentError::Unknown(
                    "agent_0190a1b2c3d47abc8def0123456789a1".to_owned()
                )),
                true,
                vec![]
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_a_signal_to_a_process_that_has_exited_as_the_runtime_says() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (f, agent, generation) = launched();
        let id = agent.as_str();
        f.fake_exit_unseen(&f.terminal_of(id));
        let refused = runtime().block_on(f.agents.signal(id, &signalling("s-1", generation)));
        assert!(
            matches!(&refused, Err(AgentError::Conflict(m)) if m.contains("exited")),
            "{refused:?}"
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_a_signal_to_an_agent_recorded_exited_without_asking_its_runtime() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (f, agent, generation) = launched();
        let recorded = agent.clone();
        runtime()
            .block_on(f.store.run(move |store| {
                store.write(|w| {
                    w.append(&NewEvent::Agent {
                        agent: recorded,
                        actor: Actor::System.as_str().to_owned(),
                        change: AgentChange::Exited(bazhen_protocol::agent_events::AgentExited {
                            exit: bazhen_protocol::agents::ExitStatus::Unknown,
                        }),
                    })
                })
            }))
            .unwrap()
            .unwrap();
        let id = agent.as_str();
        let refused = runtime().block_on(f.agents.signal(id, &signalling("s-1", generation)));
        assert_eq!(
            (refused, f.fake_signalled()),
            (
                Err(AgentError::Conflict(format!("agent {id} is exited"))),
                vec![]
            )
        );
    }

    #[test]
    fn words_a_runtime_failure_for_the_command_it_failed() {
        let worded = [Doing::Close, Doing::Signal, Doing::Start].map(|doing| {
            let unservable = TerminalError::Unservable {
                protocol: vec!["holder/2.0".to_owned()],
                holder_pid: Some(42),
            };
            let unconfirmed = TerminalError::Unconfirmed("gone".to_owned());
            [unservable, unconfirmed].map(|cause| from_runtime("agent_x", doing, cause).to_string())
        });
        let unservable = |done: &str, after: &str| {
            format!(
                "agent agent_x's terminal runs on a holder that speaks only holder/2.0, which this version of Bazhen doesn't, so it can't be {done} from here: its holder, pid 42, keeps running until its process is ended. Once it has, {after}."
            )
        };
        let unconfirmed = |done: &str| {
            format!(
                "agent agent_x's terminal is no longer where it ran, but what ran it may still be running it, so it can't be {done}; close it, and if its close is refused the same way, close it with force to record it closed"
            )
        };
        assert_eq!(
            worded,
            [
                [
                    unservable("closed", "close it again, or relaunch it"),
                    "agent agent_x's terminal is no longer where it ran, but what ran it may still be running it; close it with force to record it closed anyway".to_owned(),
                ],
                [unservable("signalled", "relaunch it"), unconfirmed("signalled")],
                [unservable("started again", "relaunch it"), unconfirmed("started again")],
            ]
        );
    }
}
