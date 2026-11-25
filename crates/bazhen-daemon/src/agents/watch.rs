//! What the runtime tells of agents' terminals unasked (`Lifecycle.watch`, `observed`): an exit
//! no view is there to hear, as one while the daemon was down, a process started in an agent's
//! terminal outside the daemon, and a holder lost.

use std::sync::Arc;

use bazhen_core::agent::{AgentEvent, accepts};
use bazhen_protocol::agent_events::{AgentExited, AgentProcessAdopted};
use bazhen_protocol::agents::AgentState;
use bazhen_protocol::events::RuntimeRefPayload;
use bazhen_protocol::ids::TerminalId;
use bazhen_protocol::shells::TerminalState;
use bazhen_store::{Actor, AgentChange, AgentTerminal, Writer as StoreWriter};
use tokio_util::task::TaskTracker;

use super::lifecycle::{append, exited_at, record_closed, recorded};
use super::{AgentError, Agents};
use crate::shells::{RUNTIME, generation_of, later_generation, locator_of};
use crate::terminals::{Event, Exit, Recorded};

/// Whether `found` runs `at` as a process started outside the daemon, which it takes as its own
/// (`adopts`): a later generation of the same holder than its record names, past the one the
/// store counts. A start in flight owns its terminal, so a starting agent is adopted only once
/// its terminal runs; a closing one never is.
pub(crate) fn adopts(found: &AgentTerminal, at: &Recorded) -> bool {
    accepts(found.state, AgentEvent::ProcessAdopted)
        && (found.state != AgentState::Starting
            || found.terminal_state == Some(TerminalState::Running))
        && found.runtime.as_deref() == Some(RUNTIME)
        && recorded(found).is_some_and(|before| later_generation(&before, at))
        && locator_of(at)
            .and_then(|locator| generation_of(&locator))
            .zip(found.generation)
            .is_some_and(|(adopted, counted)| adopted > counted)
}

/// Whether a holder proved gone leaves `found` lost: one whose terminal ran, as a start in
/// flight's doesn't yet.
pub(super) fn losable(found: &AgentTerminal) -> bool {
    match found.state {
        AgentState::Running | AgentState::Unknown | AgentState::Exited => true,
        AgentState::Starting => found.terminal_state == Some(TerminalState::Running),
        _ => false,
    }
}

/// `at` as an adoption records it.
fn adopted(at: &Recorded) -> Result<AgentChange, AgentError> {
    Ok(AgentChange::ProcessAdopted(AgentProcessAdopted {
        runtime_ref: runtime_ref(at)?,
    }))
}

/// Where `at` runs, as an event records it.
pub(super) fn runtime_ref(at: &Recorded) -> Result<RuntimeRefPayload, AgentError> {
    let locator = serde_json::from_str(&at.locator)
        .map_err(|e| AgentError::Internal(format!("its locator isn't one: {e}")))?;
    Ok(RuntimeRefPayload {
        runtime: RUNTIME.to_owned(),
        locator,
    })
}

/// Takes `at` as `found`'s process where it adopts it, in the caller's transaction; whether it
/// did.
pub(super) fn adopt(
    w: &StoreWriter<'_>,
    found: &AgentTerminal,
    at: &Recorded,
) -> Result<bool, AgentError> {
    if !adopts(found, at) {
        return Ok(false);
    }
    append(w, &found.agent_id, Actor::System, adopted(at)?)?;
    Ok(true)
}

/// An exit, as `observed` takes one: a later generation's is of a process adopted as it ends;
/// the recorded generation's is `told`'s.
fn exited(w: &StoreWriter<'_>, exit: &Exit) -> Result<(), AgentError> {
    let Some(found) = w.reads().agent_of_terminal(exit.terminal_id.as_str())? else {
        return Ok(());
    };
    if let Some(at) = &exit.found
        && adopt(w, &found, at)?
    {
        append(
            w,
            &found.agent_id,
            Actor::System,
            AgentChange::Exited(AgentExited {
                exit: crate::stream::hub::exit_status(&exit.status),
            }),
        )?;
        return Ok(());
    }
    Ok(exited_at(
        w,
        &exit.terminal_id,
        exit.generation,
        &exit.status,
    )?)
}

fn terminal_of(event: &Event) -> &TerminalId {
    match event {
        Event::Exited(exit) => &exit.terminal_id,
        Event::Respawned(at) | Event::Lost(at) => &at.terminal_id,
    }
}

impl Agents {
    /// Hands what the runtime tells to the agent whose terminal it names, on `tracker`, so one
    /// slow agent holds up no other. A terminal no agent runs in now is no agent's: a shell's,
    /// or one a relaunch left behind.
    pub(crate) fn heard(self: &Arc<Self>, event: Event, tracker: &TaskTracker) {
        let agents = Arc::clone(self);
        tracker.spawn(async move {
            let terminal = terminal_of(&event).clone();
            if let Err(err) = agents.observed(event).await {
                tracing::warn!("bazhen: the agent in terminal {terminal}: {err}");
            }
        });
    }

    /// What `heard` does with one event, in the agent's turn.
    pub(crate) async fn observed(&self, event: Event) -> Result<(), AgentError> {
        let terminal = terminal_of(&event).clone();
        let Some(found) = self.in_terminal(&terminal).await? else {
            return Ok(());
        };
        let _turn = self.deps.turns.take(found.agent_id.as_str()).await;
        match event {
            Event::Exited(exit) => self.write(move |w| exited(w, &exit)).await,
            Event::Respawned(at) => {
                self.write(move |w| {
                    if let Some(found) = w.reads().agent_of_terminal(at.terminal_id.as_str())? {
                        adopt(w, &found, &at)?;
                    }
                    Ok(())
                })
                .await
            }
            Event::Lost(_) => self.lost(&terminal).await,
        }
    }

    /// The holder of an agent's terminal is lost, as the runtime tells: its holder has gone, or
    /// only its socket has. Once what the store records runs no more the agent is lost, or, one
    /// closing, closed; one whose holder may still run is left as it is.
    async fn lost(&self, terminal: &TerminalId) -> Result<(), AgentError> {
        let Some(found) = self.in_terminal(terminal).await? else {
            return Ok(());
        };
        let ends = |found: &AgentTerminal| losable(found) || found.state == AgentState::Closing;
        let Some(at) = recorded(&found).filter(|_| ends(&found)) else {
            return Ok(());
        };
        if !self.deps.terminals.gone(&at).await {
            tracing::warn!(
                "bazhen: agent {}'s holder is lost, but may still run it; left as it is",
                found.agent_id
            );
            return Ok(());
        }
        let closed = self
            .write(move |w| {
                let Some(now) = w.reads().agent_of_terminal(at.terminal_id.as_str())? else {
                    return Ok(false);
                };
                if recorded(&now).as_ref() != Some(&at) {
                    return Ok(false);
                }
                if losable(&now) {
                    append(w, &now.agent_id, Actor::System, AgentChange::Lost)?;
                    return Ok(false);
                }
                if now.state == AgentState::Closing {
                    record_closed(w, &now.agent_id, Actor::System)?;
                    return Ok(true);
                }
                Ok(false)
            })
            .await?;
        if closed {
            self.after_closed(&found.agent_id).await;
        }
        Ok(())
    }

    /// The agent `terminal` is the current terminal of, if any.
    async fn in_terminal(
        &self,
        terminal: &TerminalId,
    ) -> Result<Option<AgentTerminal>, AgentError> {
        let terminal = terminal.clone();
        self.write(move |w| Ok(w.reads().agent_of_terminal(terminal.as_str())?))
            .await
    }
}

#[cfg(test)]
mod tests {
    use bazhen_holder_proto::body::{ExitCode, ExitStatus};
    use serde_json::json;

    use super::*;
    use crate::agents::tests::{Fixture, request, setup_with};
    use crate::terminals::fake::recorded_at;
    use crate::testing::runtime;

    /// A launched agent: the fixture, its terminal, and the generation its terminal runs.
    fn launched() -> (Fixture, String, u64) {
        let f = setup_with(crate::agents::tests::Setup::default());
        let agent = runtime()
            .block_on(f.launch(request("k-1")))
            .unwrap()
            .agent_id;
        let terminal = f.terminal_of(agent.as_str());
        let generation = generation_of_agent(&f, agent.as_str());
        (f, terminal, generation)
    }

    fn generation_of_agent(f: &Fixture, agent: &str) -> u64 {
        f.store
            .reader()
            .unwrap()
            .reads()
            .agent_terminal(agent)
            .unwrap()
            .unwrap()
            .generation
            .unwrap()
    }

    fn exit(terminal: &str, generation: u64, found: Option<Recorded>) -> Event {
        Event::Exited(Exit {
            terminal_id: TerminalId::parse(terminal).unwrap(),
            generation,
            status: ExitStatus::Exited {
                code: ExitCode::new(3).unwrap(),
            },
            found,
        })
    }

    fn hear(f: &Fixture, event: Event) {
        runtime().block_on(f.agents.observed(event)).unwrap();
    }

    #[test]
    fn records_an_exit_no_view_heard_at_the_generation_recorded_and_no_other() {
        let (f, terminal, generation) = launched();
        let before = f.types().len();
        hear(&f, exit("term_0190a1b2c3d47abc8def0123456789ff", 1, None));
        hear(&f, exit(&terminal, generation + 1, None));
        hear(&f, exit(&terminal, generation, None));
        hear(&f, exit(&terminal, generation, None));
        assert_eq!(
            (f.types().split_off(before), f.last_of("agent.exited")),
            (
                vec!["agent.exited".to_owned()],
                Some(json!({"exit": {"type": "exited", "code": 3}}))
            )
        );
    }

    #[test]
    fn adopts_a_later_generations_process_as_it_ends_and_records_its_exit() {
        let (f, terminal, _) = launched();
        let later = f.fake().respawn_unseen(&terminal);
        let before = f.types().len();
        hear(
            &f,
            exit(&terminal, later, Some(recorded_at(&terminal, later))),
        );
        let agent = f
            .store
            .reader()
            .unwrap()
            .reads()
            .agent_of_terminal(&terminal)
            .unwrap()
            .unwrap();
        assert_eq!(
            (f.types().split_off(before), agent.generation, agent.state),
            (
                vec![
                    "agent.process_adopted".to_owned(),
                    "agent.exited".to_owned()
                ],
                Some(later),
                AgentState::Exited
            )
        );
    }

    #[test]
    fn adopts_a_process_started_in_its_terminal_outside_the_daemon_once() {
        let (f, terminal, generation) = launched();
        let later = f.fake().respawn_unseen(&terminal);
        let before = f.types().len();
        hear(&f, Event::Respawned(recorded_at(&terminal, generation)));
        hear(&f, Event::Respawned(recorded_at(&terminal, later)));
        hear(&f, Event::Respawned(recorded_at(&terminal, later)));
        assert_eq!(
            f.types().split_off(before),
            vec!["agent.process_adopted".to_owned()]
        );
    }

    #[test]
    fn marks_an_agent_lost_only_once_its_holder_is_proved_gone() {
        let (f, terminal, generation) = launched();
        let before = f.types().len();
        hear(&f, Event::Lost(recorded_at(&terminal, generation)));
        let while_it_may_run = f.types().split_off(before);
        f.fake().gone(&terminal);
        hear(&f, Event::Lost(recorded_at(&terminal, generation)));
        assert_eq!(
            (while_it_may_run, f.types().split_off(before)),
            (Vec::<String>::new(), vec!["agent.lost".to_owned()])
        );
    }
}
