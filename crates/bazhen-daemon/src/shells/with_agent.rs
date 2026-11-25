//! Closing an agent with its linked shells (`closeAgent` in `shells/lifecycle.ts`): the shells
//! it keeps are made standalone first, and every other one closes once the agent has.

use std::collections::{BTreeSet, HashMap};
use std::future::Future;

use bazhen_protocol::agents::{AgentCommandResponse, CloseAgentRequest};
use bazhen_protocol::events::{TerminalClosed, TerminalClosedReason};
use bazhen_protocol::ids::TerminalId;
use bazhen_protocol::shells::{ShellCommand, TerminalState, shell_commands};
use bazhen_store::{Actor, ShellRow, TerminalChange};

use super::{ShellError, Shells};
use crate::agents::AgentError;

impl Shells {
    /// Closes `agent` with `close`, and its linked shells with it. It is refused while a shell
    /// it would close runs a program the user didn't confirm in `confirmedBusy`, naming them,
    /// unless `confirmBusy` confirms everything. The shells named in `keepShells` are made
    /// standalone before the agent closes, so a shell still linked to a closed agent was never
    /// kept. Every other one is closed once the agent is; any that can't be is reported, and
    /// repeating the command finishes them.
    pub(crate) async fn close_agent<F>(
        &self,
        agent: &str,
        req: &CloseAgentRequest,
        close: F,
    ) -> Result<AgentCommandResponse, AgentError>
    where
        F: Future<Output = Result<AgentCommandResponse, AgentError>>,
    {
        // A repeat replays the agent's first answer; what it asked was checked and done the
        // first time, so only the shells left to close are settled again.
        if !self
            .recalled(&req.idempotency_key)
            .await
            .map_err(AgentError::Shells)?
        {
            self.before_agent_closes(agent, req)
                .await
                .map_err(AgentError::Shells)?;
        }
        let response = close.await?;
        self.settle_with_agent(agent)
            .await
            .map_err(AgentError::Shells)?;
        Ok(response)
    }

    /// What an agent's close asks of its shells before the agent closes: those it keeps must run
    /// beside it, those it closes must run nothing unconfirmed, and those it keeps are made
    /// standalone.
    async fn before_agent_closes(
        &self,
        agent: &str,
        req: &CloseAgentRequest,
    ) -> Result<(), ShellError> {
        let keep: BTreeSet<&str> = req
            .keep_shells
            .iter()
            .flatten()
            .map(TerminalId::as_str)
            .collect();
        let linked = self.linked(agent).await?;
        for id in &keep {
            let running = linked
                .iter()
                .any(|s| s.id.as_str() == *id && s.state == TerminalState::Running);
            if !running {
                return Err(ShellError::Conflict(format!(
                    "shell {id} is not running beside agent {agent}"
                )));
            }
        }
        if req.confirm_busy != Some(true) {
            let confirmed: HashMap<&str, &str> = req
                .confirmed_busy
                .iter()
                .flatten()
                .map(|b| (b.terminal_id.as_str(), b.program.as_str()))
                .collect();
            let closing: Vec<&ShellRow> = linked
                .iter()
                .filter(|s| !keep.contains(s.id.as_str()))
                .collect();
            self.refuse_busy(&format!("agent {agent}'s shells"), closing, |id| {
                confirmed.get(id.as_str()).copied()
            })
            .await?;
        }
        let kept: Vec<&ShellRow> = linked
            .iter()
            .filter(|s| keep.contains(s.id.as_str()))
            .collect();
        for shell in kept {
            self.keep(shell).await?;
        }
        Ok(())
    }

    /// Whether `key` already answered a command.
    async fn recalled(&self, key: &str) -> Result<bool, ShellError> {
        let key = key.to_owned();
        self.write(move |w| Ok(w.recall(&key)?.is_some())).await
    }

    async fn linked(&self, agent: &str) -> Result<Vec<ShellRow>, ShellError> {
        let agent = agent.to_owned();
        Ok(self
            .deps
            .store
            .run(move |store| store.reads().linked_shells(&agent))
            .await??)
    }

    /// Makes a shell standalone in the store first, then where it runs. A tag left behind names
    /// an agent nothing links it to any more, which reconcile drops.
    async fn keep(&self, shell: &ShellRow) -> Result<(), ShellError> {
        let _turn = self.deps.turns.take(shell.id.as_str()).await;
        self.record(&shell.id, Actor::User, TerminalChange::Unlinked)
            .await?;
        if let Err(err) = self.untag(shell).await {
            tracing::warn!(
                "bazhen: shell {}: kept, but its terminal still names its agent: {err}",
                shell.id
            );
        }
        Ok(())
    }

    /// Closes each shell still linked to `agent`, each in its own turn, reporting those it
    /// couldn't.
    async fn settle_with_agent(&self, agent: &str) -> Result<(), ShellError> {
        let mut unsettled = Vec::new();
        for shell in self.linked(agent).await? {
            let id = shell.id.as_str();
            let _turn = self.deps.turns.take(id).await;
            if let Err(err) = self.close_with_agent(id).await {
                tracing::warn!("bazhen: shell {id}: could not close it with its agent: {err}");
                unsettled.push(id.to_owned());
            }
        }
        if unsettled.is_empty() {
            return Ok(());
        }
        Err(ShellError::Unavailable(format!(
            "agent {agent} closed, but its shells {} could not be closed; close it again to \
             finish",
            unsettled.join(", ")
        )))
    }

    /// Closes a shell its agent's close takes, recorded closing before anything ends.
    async fn close_with_agent(&self, id: &str) -> Result<(), ShellError> {
        let Some(found) = self.shell(id).await? else {
            return Ok(());
        };
        if !shell_commands(found.state, false).contains(&ShellCommand::Close) {
            return Ok(());
        }
        if found.state != TerminalState::Closing {
            self.record(&found.id, Actor::System, TerminalChange::Closing)
                .await?;
        }
        if found.state != TerminalState::Lost {
            self.end(&found, false).await?;
        }
        self.record(
            &found.id,
            Actor::System,
            TerminalChange::Closed(TerminalClosed {
                reason: TerminalClosedReason::AgentClosed,
            }),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use bazhen_protocol::ids::AgentId;
    use bazhen_protocol::shells::BusyShell;

    use super::*;
    use crate::shells::tests::{Harness, agent, beside, setup};
    use crate::terminals::Kind;
    use crate::testing::runtime;

    fn closing(key: &str) -> CloseAgentRequest {
        CloseAgentRequest {
            idempotency_key: key.to_owned(),
            generation: 0,
            force: None,
            keep_shells: None,
            confirm_busy: None,
            confirmed_busy: None,
        }
    }

    /// The agent's own close, as the agents answer it: `agent` closed by event 7.
    fn answered(agent: &AgentId) -> AgentCommandResponse {
        AgentCommandResponse {
            agent_id: agent.clone(),
            event_ids: vec![7],
        }
    }

    async fn opened_beside(h: &Harness, key: &str, agent: &AgentId) -> String {
        let opened = h.shells.open(&beside(key, agent), None).await.unwrap();
        opened.terminal_id.as_str().to_owned()
    }

    /// Who closed the shell, and why, as the store records it; `None` for one not closed.
    fn closed_for(h: &Harness, id: &str) -> Option<(String, String)> {
        let reader = h.store.reader().unwrap();
        let reads = reader.reads();
        let at = reads.last_event_id(id, "terminal.closed").unwrap()?;
        let event = reads.events(at - 1, 1).unwrap().pop()?;
        Some((event.actor, event.payload))
    }

    #[test]
    fn closes_an_agents_linked_shells_after_the_agent_keeping_those_it_names_standalone() {
        let h = setup(100);
        runtime().block_on(async {
            let (live, other) = (agent(1), agent(2));
            h.launched(&live, "/repo/live").await;
            h.launched(&other, "/repo/other").await;
            let taken = opened_beside(&h, "a", &live).await;
            let kept = opened_beside(&h, "b", &live).await;
            let standalone = h.open("c").await.unwrap();
            let elsewhere = opened_beside(&h, "d", &other).await;
            let seen = Mutex::new(None);
            let agent_closed = async {
                *seen.lock().unwrap() =
                    Some((h.state_of(&taken), h.shell(&kept).unwrap().linked_agent_id));
                Ok(answered(&live))
            };
            let req = CloseAgentRequest {
                keep_shells: Some(vec![TerminalId::parse(&kept).unwrap()]),
                ..closing("k")
            };
            let response = h
                .shells
                .close_agent(live.as_str(), &req, agent_closed)
                .await
                .unwrap();
            let (unlinked, kind) = {
                let state = h.fake.state.lock().unwrap();
                let kind = state.running.get(&kept).map(|r| r.spec.kind.clone());
                (state.unlinked.clone(), kind)
            };
            assert_eq!(
                (
                    response,
                    seen.into_inner().unwrap(),
                    [&taken, &kept, &standalone, &elsewhere].map(|id| h.state_of(id)),
                    closed_for(&h, &taken),
                    unlinked,
                    kind,
                ),
                (
                    answered(&live),
                    Some((Some(TerminalState::Running), None)),
                    [
                        Some(TerminalState::Closed),
                        Some(TerminalState::Running),
                        Some(TerminalState::Running),
                        Some(TerminalState::Running),
                    ],
                    Some((
                        "system".to_owned(),
                        r#"{"reason":"agent_closed"}"#.to_owned()
                    )),
                    vec![kept.clone()],
                    Some(Kind::Shell {
                        linked_agent_id: None
                    }),
                )
            );
        });
    }

    #[test]
    fn refuses_before_the_agent_closes_to_keep_a_shell_not_beside_it_or_end_an_unconfirmed_program()
    {
        let h = setup(100);
        runtime().block_on(async {
            let live = agent(1);
            h.launched(&live, "/repo/live").await;
            let busy = opened_beside(&h, "a", &live).await;
            let quiet = opened_beside(&h, "b", &live).await;
            let standalone = h.open("c").await.unwrap();
            h.fake.run_in_foreground(&busy, "vim");
            let reached = Mutex::new(0);
            let agent_closed = || async {
                *reached.lock().unwrap() += 1;
                Ok(answered(&live))
            };
            let keeping = CloseAgentRequest {
                keep_shells: Some(vec![TerminalId::parse(&standalone).unwrap()]),
                ..closing("k")
            };
            let not_beside = h
                .shells
                .close_agent(live.as_str(), &keeping, agent_closed())
                .await;
            let unconfirmed = h
                .shells
                .close_agent(live.as_str(), &closing("u"), agent_closed())
                .await;
            let other_program = CloseAgentRequest {
                confirmed_busy: Some(vec![BusyShell {
                    terminal_id: TerminalId::parse(&busy).unwrap(),
                    program: "less".to_owned(),
                }]),
                ..closing("o")
            };
            let misconfirmed = h
                .shells
                .close_agent(live.as_str(), &other_program, agent_closed())
                .await;
            let refused_reached = *reached.lock().unwrap();
            let confirmed = CloseAgentRequest {
                confirmed_busy: Some(vec![BusyShell {
                    terminal_id: TerminalId::parse(&busy).unwrap(),
                    program: "vim".to_owned(),
                }]),
                ..closing("v")
            };
            let confirmed = h
                .shells
                .close_agent(live.as_str(), &confirmed, agent_closed())
                .await
                .map(|_| ());
            let busy_shells = vec![BusyShell {
                terminal_id: TerminalId::parse(&busy).unwrap(),
                program: "vim".to_owned(),
            }];
            let refusal = |busy_shells: Vec<BusyShell>| {
                AgentError::Shells(ShellError::Busy {
                    message: format!(
                        "vim is running in agent {live}'s shells; close anyway to end it"
                    ),
                    busy: busy_shells,
                })
            };
            assert_eq!(
                (not_beside, unconfirmed, misconfirmed, refused_reached),
                (
                    Err(AgentError::Shells(ShellError::Conflict(format!(
                        "shell {standalone} is not running beside agent {live}"
                    )))),
                    Err(refusal(busy_shells.clone())),
                    Err(refusal(busy_shells)),
                    0,
                )
            );
            assert_eq!(
                (
                    confirmed,
                    [&busy, &quiet].map(|id| h.state_of(id)),
                    *reached.lock().unwrap()
                ),
                (
                    Ok(()),
                    [Some(TerminalState::Closed), Some(TerminalState::Closed)],
                    1
                )
            );
        });
    }

    #[test]
    fn settles_only_the_shells_left_when_a_recalled_key_repeats_the_close() {
        let h = setup(100);
        runtime().block_on(async {
            let live = agent(1);
            h.launched(&live, "/repo/live").await;
            let busy = opened_beside(&h, "a", &live).await;
            h.fake.run_in_foreground(&busy, "vim");
            h.shells
                .write(|w| Ok(w.remember("k", &serde_json::json!({}))?))
                .await
                .unwrap();
            let req = CloseAgentRequest {
                keep_shells: Some(vec![TerminalId::parse(&busy).unwrap()]),
                ..closing("k")
            };
            h.shells
                .close_agent(live.as_str(), &req, async { Ok(answered(&live)) })
                .await
                .unwrap();
            assert_eq!(h.state_of(&busy), Some(TerminalState::Closed));
        });
    }

    #[test]
    fn reports_the_shells_it_could_not_close_after_the_agent_closed_and_a_repeat_finishes_them() {
        let h = setup(100);
        runtime().block_on(async {
            let live = agent(1);
            h.launched(&live, "/repo/live").await;
            let first = opened_beside(&h, "a", &live).await;
            let second = opened_beside(&h, "b", &live).await;
            h.fake.set(|state| state.fail_closes = true);
            let unsettled = h
                .shells
                .close_agent(live.as_str(), &closing("k"), async { Ok(answered(&live)) })
                .await;
            let left = [&first, &second].map(|id| h.state_of(id));
            h.fake.set(|state| state.fail_closes = false);
            h.shells
                .close_agent(live.as_str(), &closing("k"), async { Ok(answered(&live)) })
                .await
                .unwrap();
            assert_eq!(
                (unsettled, left, [&first, &second].map(|id| h.state_of(id))),
                (
                    Err(AgentError::Shells(ShellError::Unavailable(format!(
                        "agent {live} closed, but its shells {first}, {second} could not be \
                         closed; close it again to finish"
                    )))),
                    [Some(TerminalState::Closing), Some(TerminalState::Closing)],
                    [Some(TerminalState::Closed), Some(TerminalState::Closed)],
                )
            );
        });
    }

    #[test]
    fn answers_the_agents_own_refusal_and_closes_none_of_its_shells() {
        let h = setup(100);
        runtime().block_on(async {
            let live = agent(1);
            h.launched(&live, "/repo/live").await;
            let shell = opened_beside(&h, "a", &live).await;
            let refused = h
                .shells
                .close_agent(live.as_str(), &closing("k"), async {
                    Err(AgentError::Conflict("agent is closed".to_owned()))
                })
                .await;
            assert_eq!(
                (refused, h.state_of(&shell)),
                (
                    Err(AgentError::Conflict("agent is closed".to_owned())),
                    Some(TerminalState::Running)
                )
            );
        });
    }
}
