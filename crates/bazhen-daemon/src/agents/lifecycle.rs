//! The commands on an agent once it is launched (`agents/lifecycle.ts`): each runs in its agent's
//! turn, a repeated key gets the first answer, and otherwise the agent must be in a state the
//! command accepts, at the generation it names (`Lifecycle.command`).

use bazhen_core::agent::agent_commands;
use bazhen_protocol::agent_events::AgentSignalled;
use bazhen_protocol::agents::{AgentCommand, AgentCommandResponse, SignalAgentRequest};
use bazhen_protocol::ids::AgentId;
use bazhen_store::{Actor, AgentChange, AgentTerminal, NewEvent};
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

fn asked<R: Serialize>(command: &str, agent_id: &str, request: &R) -> Result<String, AgentError> {
    serde_json::to_string(&Asked {
        command,
        agent_id,
        request,
    })
    .map_err(|e| AgentError::Internal(e.to_string()))
}

/// What a command found: the first answer to its key, or the agent it may act on.
enum Begun {
    Prior(AgentCommandResponse),
    Found(AgentTerminal),
}

/// Whether the agent is offered `command` now (`agentCommands`).
fn offers(command: AgentCommand) -> impl Fn(&AgentTerminal) -> bool {
    move |found| agent_commands(found.state, found.terminal_state).contains(&command)
}

/// Where the agent's terminal runs, once a runtime has confirmed it.
fn recorded(found: &AgentTerminal) -> Option<Recorded> {
    Some(Recorded {
        terminal_id: found.terminal_id.clone()?,
        locator: found.locator.clone()?,
    })
}

/// The runtime's failure as a command on agent `id`'s (`fromEnvironment`): typed where the
/// caller can act on it, else the environment out of reach.
pub(crate) fn from_runtime(id: &str, cause: TerminalError) -> AgentError {
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
                "agent {id}'s terminal runs on a holder that speaks only {}, which this version of Bazhen doesn't, so it can't be closed from here: {holder} keeps running until its process is ended. Once it has, close it again, or relaunch it.",
                protocol.join(", ")
            ))
        }
        TerminalError::Unconfirmed(_) => AgentError::ServerUnconfirmed(format!(
            "agent {id}'s terminal is no longer where it ran, but what ran it may still be running it; close it with force to record it closed anyway"
        )),
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
    async fn begin(
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

    /// Records a command's last steps with the key's answer, in one transaction.
    async fn finish(
        &self,
        agent: &AgentId,
        key: &str,
        request: &str,
        last: Vec<AgentChange>,
    ) -> Result<AgentCommandResponse, AgentError> {
        let (agent, key, request) = (agent.clone(), key.to_owned(), request.to_owned());
        self.write(move |w| {
            let mut event_ids = Vec::new();
            for change in last {
                event_ids.push(w.append(&NewEvent::Agent {
                    agent: agent.clone(),
                    actor: Actor::User.as_str().to_owned(),
                    change,
                })?);
            }
            let response = AgentCommandResponse {
                agent_id: agent,
                event_ids,
            };
            w.answered(&key, &request, &response)?;
            Ok(response)
        })
        .await
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
        let _turn = self.turns.take(id).await;
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
            .map_err(|cause| from_runtime(id, cause))?;
        self.finish(
            &found.agent_id,
            key,
            &request,
            vec![AgentChange::Signalled(AgentSignalled {
                signal: req.signal,
            })],
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::agents::Signal;

    use super::*;
    use crate::agents::tests::{Fixture, Setup, request, setup_with};
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
}
