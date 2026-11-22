//! What a restarted daemon makes of its shells (`shells/reconcile.ts`): each the store records is
//! matched against what the runtime runs, by the rules agents go by. A runtime that can't be read
//! concludes nothing about its shells, and a shell the runtime doesn't list is lost only once what
//! ran it is provably gone. A shell whose process exited while the daemon was down is closed, as
//! it would have been at once.

use std::collections::HashMap;

use bazhen_protocol::events::{TerminalFailed, TerminalFailedReason};
use bazhen_protocol::shells::TerminalState;
use bazhen_store::{Actor, ShellRow, TerminalChange};

use super::{RUNTIME, ShellError, Shells, Unended, adopts, gone_from, incarnation, recorded};
use crate::terminals::FoundShell;

impl Shells {
    /// Matches the runtime's shells against the store's, once, before anything else acts on
    /// them. Run it before the runtime's events are followed: an exit told meanwhile waits, and
    /// then finds the shell as this left it.
    pub(crate) async fn reconcile(&self) {
        let (kept, environment) = match self
            .deps
            .store
            .run(|store| {
                let reads = store.reads();
                Ok::<_, rusqlite::Error>((reads.recoverable_shells()?, reads.local_environment()?))
            })
            .await
        {
            Ok(Ok(read)) => read,
            Ok(Err(err)) => {
                return tracing::warn!("bazhen: reconcile: could not read the shells: {err}");
            }
            Err(err) => {
                return tracing::warn!("bazhen: reconcile: could not read the shells: {err}");
            }
        };
        let (ours, unrouted): (Vec<ShellRow>, Vec<ShellRow>) = kept
            .into_iter()
            .partition(|shell| shell.runtime_kind == RUNTIME);
        for shell in &unrouted {
            tracing::warn!(
                "bazhen: reconcile: shell {} is on {}, which this daemon doesn't run",
                shell.id,
                shell.runtime_kind
            );
        }
        if ours.is_empty() {
            return;
        }
        let known: Vec<_> = ours.iter().filter_map(recorded).collect();
        if !self.deps.terminals.reachable(&known).await {
            return;
        }
        let present: HashMap<String, FoundShell> = match self.deps.terminals.shells().await {
            Ok(found) => found
                .into_iter()
                .map(|f| (f.terminal.terminal_id.as_str().to_owned(), f))
                .collect(),
            Err(err) => {
                let environment = environment.unwrap_or_default();
                return tracing::warn!(
                    "bazhen: reconcile: could not read environment {environment}'s {RUNTIME} shells: {err}"
                );
            }
        };
        for shell in &ours {
            if let Err(err) = self.settle(shell, present.get(shell.id.as_str())).await {
                tracing::warn!(
                    "bazhen: reconcile: could not settle shell {}: {err}",
                    shell.id
                );
            }
        }
    }

    async fn settle(&self, shell: &ShellRow, found: Option<&FoundShell>) -> Result<(), ShellError> {
        let id = &shell.id;
        if shell.state == TerminalState::Creating {
            // The daemon died while opening it: the terminal tagged with it is the shell, or
            // there is none.
            let Some(found) = found else {
                let failed = TerminalChange::Failed(TerminalFailed {
                    reason: TerminalFailedReason::DaemonRestart,
                });
                return self.record(id, Actor::System, failed).await.map(drop);
            };
            let running = TerminalChange::Running(incarnation(&found.terminal)?);
            self.record(id, Actor::System, running).await?;
            if found.dead {
                self.ended(id.as_str()).await?;
            }
            return Ok(());
        }
        if let Some(found) = found {
            let adopted = adopts(shell, &found.terminal);
            if adopted {
                let change = TerminalChange::ProcessAdopted(incarnation(&found.terminal)?);
                self.record(id, Actor::System, change).await?;
            }
            if found.dead {
                return if adopted {
                    self.ended(id.as_str()).await
                } else {
                    self.ending(shell).await
                };
            }
            // A shell kept as standalone whose terminal kept its agent: the store is what links
            // it.
            if found.linked_agent_id.is_some() && shell.linked_agent_id.is_none() {
                self.deps
                    .terminals
                    .unlink(&found.terminal)
                    .await
                    .map_err(|cause| super::from_runtime(id.as_str(), cause))?;
            }
            return Ok(());
        }
        if let Some(terminal) = recorded(shell)
            && !self.deps.terminals.gone(&terminal).await
        {
            tracing::warn!(
                "bazhen: reconcile: shell {id}'s terminal may still run on its old server; left"
            );
            return Ok(());
        }
        self.record(id, Actor::System, gone_from(shell.state))
            .await
            .map(drop)
    }

    /// Ends the shell `id` names as it is now, its process having exited.
    async fn ended(&self, id: &str) -> Result<(), ShellError> {
        let shell = self
            .shell(id)
            .await?
            .ok_or_else(|| ShellError::Unknown(id.to_owned()))?;
        self.ending(&shell).await
    }

    async fn ending(&self, shell: &ShellRow) -> Result<(), ShellError> {
        self.end_exited(shell)
            .await
            .map_err(|unended| match unended {
                Unended::Again(err) | Unended::Never { err, .. } => err,
            })
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::events::RuntimeRefPayload;
    use bazhen_protocol::events::{TerminalIncarnation as Incarnation, TerminalOpened};
    use bazhen_protocol::ids::{AgentId, TerminalId};
    use bazhen_store::NewEvent;

    use super::*;
    use crate::shells::tests::{Harness, Said, setup};
    use crate::terminals::fake::{Reach, Running, locator_at, unreadable};
    use crate::testing::runtime;

    const AGENT: &str = "agent_0190a1b2c3d47abc8def0123456789ad";

    impl Harness {
        /// A shell the store records opening on the holder runtime, which the runtime started
        /// nothing for.
        async fn opening_unanswered(&self) -> String {
            self.store
                .run(|store| {
                    store.write(|w| {
                        let terminal = w.mint_terminal()?;
                        w.append(&NewEvent::Terminal {
                            terminal: terminal.clone(),
                            actor: Actor::User,
                            change: TerminalChange::Opened(TerminalOpened {
                                environment_id: w.local_environment()?,
                                cwd: "/".to_owned(),
                                linked_agent_id: None,
                                theme: None,
                                restart_of: None,
                                runtime: Some(RUNTIME.to_owned()),
                            }),
                        })?;
                        Ok::<_, bazhen_store::AppendError>(terminal.as_str().to_owned())
                    })
                })
                .await
                .unwrap()
                .unwrap()
        }

        /// The runtime starts a terminal for `id`, as one the daemon died before recording.
        fn start_unrecorded(&self, id: &str, linked: Option<&str>) {
            let spec = crate::terminals::ShellSpec {
                terminal_id: TerminalId::parse(id).unwrap(),
                linked_agent_id: linked.and_then(AgentId::parse),
                argv: vec!["/bin/zsh".to_owned()],
                cwd: "/".to_owned(),
                env: std::collections::BTreeMap::new(),
                theme: None,
            };
            self.fake.set(|state| {
                state.running.insert(
                    id.to_owned(),
                    Running {
                        spec,
                        foreground: None,
                        cwd: None,
                        exited: false,
                        gone: false,
                        generation: 0,
                    },
                );
            });
        }

        async fn record_running(&self, id: &str) {
            let incarnation = Incarnation {
                runtime_ref: RuntimeRefPayload {
                    runtime: RUNTIME.to_owned(),
                    locator: locator_at(id, 0),
                },
            };
            self.shells
                .record(
                    &TerminalId::parse(id).unwrap(),
                    Actor::System,
                    TerminalChange::Running(incarnation),
                )
                .await
                .unwrap();
        }

        /// Each event of the shell `id` names, by type and actor, oldest first.
        fn events_of(&self, id: &str) -> Vec<(String, String)> {
            let reader = self.store.reader().unwrap();
            let events = reader.reads().events(0, 1000).unwrap();
            events
                .into_iter()
                .filter(|e| e.entity_id == id)
                .map(|e| (e.kind, e.actor))
                .collect()
        }

        /// The generation the shell's recorded locator names.
        fn locator_generation(&self, id: &str) -> Option<String> {
            let locator: bazhen_protocol::record::Record<String> =
                serde_json::from_str(&self.shell(id)?.locator?).ok()?;
            locator
                .entries()
                .iter()
                .find(|(key, _)| key == "generation")
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn marks_a_shell_lost_once_its_holder_is_gone() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.gone(&id);
            h.shells.reconcile().await;
            assert_eq!(h.state_of(&id), Some(TerminalState::Lost));
        });
    }

    #[test]
    fn closes_a_shell_whose_shell_exited_while_the_daemon_was_down_rather_than_call_it_lost() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.exit_unseen(&id);
            h.shells.reconcile().await;
            assert_eq!(
                (h.state_of(&id), h.fake.carries(&id)),
                (Some(TerminalState::Closed), false)
            );
        });
    }

    #[test]
    fn adopts_a_process_started_in_a_shells_terminal_while_the_daemon_was_down() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.exit_unseen(&id);
            h.fake.respawn_unseen(&id);
            h.shells.reconcile().await;
            let adopted: Vec<_> = h
                .events_of(&id)
                .into_iter()
                .filter(|(kind, _)| kind == "terminal.process_adopted")
                .map(|(_, actor)| actor)
                .collect();
            assert_eq!(
                (
                    h.state_of(&id),
                    h.shell(&id).map(|s| s.generation),
                    h.locator_generation(&id),
                    adopted
                ),
                (
                    Some(TerminalState::Running),
                    Some(1),
                    Some("1".to_owned()),
                    vec!["system".to_owned()]
                )
            );
        });
    }

    #[test]
    fn adopts_a_process_that_ended_while_the_daemon_was_down_closing_the_shell_at_its_generation() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.exit_unseen(&id);
            h.fake.respawn_unseen(&id);
            h.fake.exit_unseen(&id);
            h.shells.reconcile().await;
            let kinds: Vec<_> = h.events_of(&id).into_iter().map(|(kind, _)| kind).collect();
            assert_eq!(
                (
                    h.state_of(&id),
                    h.shell(&id).map(|s| s.generation),
                    &kinds[kinds.len() - 3..]
                ),
                (
                    Some(TerminalState::Closed),
                    Some(1),
                    &[
                        "terminal.process_adopted".to_owned(),
                        "terminal.closing".to_owned(),
                        "terminal.closed".to_owned()
                    ][..]
                )
            );
        });
    }

    #[test]
    fn leaves_a_running_shell_running() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.shells.reconcile().await;
            assert_eq!(h.state_of(&id), Some(TerminalState::Running));
        });
    }

    #[test]
    fn settles_a_shell_the_daemon_died_opening_by_whether_its_terminal_appeared() {
        let h = setup(100);
        runtime().block_on(async {
            let appeared = h.opening_unanswered().await;
            let never = h.opening_unanswered().await;
            h.start_unrecorded(&appeared, None);
            h.shells.reconcile().await;
            assert_eq!(
                [h.state_of(&appeared), h.state_of(&never)],
                [Some(TerminalState::Running), Some(TerminalState::Failed)]
            );
            assert_eq!(h.locator_generation(&appeared), Some("0".to_owned()));
            assert_eq!(h.fake.state.lock().unwrap().running.len(), 1);
        });
    }

    #[test]
    fn finishes_the_close_of_a_shell_left_closing_once_its_holder_is_gone() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.shells
                .record(
                    &TerminalId::parse(&id).unwrap(),
                    Actor::User,
                    TerminalChange::Closing,
                )
                .await
                .unwrap();
            h.fake.gone(&id);
            h.shells.reconcile().await;
            assert_eq!(h.state_of(&id), Some(TerminalState::Closed));
        });
    }

    #[test]
    fn closes_a_shell_the_daemon_died_opening_whose_shell_then_exited() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.opening_unanswered().await;
            h.start_unrecorded(&id, None);
            h.fake.exit_unseen(&id);
            h.shells.reconcile().await;
            assert_eq!(
                (h.state_of(&id), h.fake.carries(&id)),
                (Some(TerminalState::Closed), false)
            );
        });
    }

    #[test]
    fn drops_the_agent_from_a_kept_shells_terminal_that_still_names_it() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.opening_unanswered().await;
            h.start_unrecorded(&id, Some(AGENT));
            h.record_running(&id).await;
            h.shells.reconcile().await;
            assert_eq!(
                (h.state_of(&id), h.fake.spec_of(&id).linked_agent_id),
                (Some(TerminalState::Running), None)
            );
        });
    }

    #[test]
    fn concludes_nothing_while_the_runtime_cant_be_reached() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.gone(&id);
            h.fake.set(|state| state.reach = Reach::Unreachable);
            h.shells.reconcile().await;
            assert_eq!(h.state_of(&id), Some(TerminalState::Running));
        });
    }

    #[test]
    fn says_it_could_not_read_the_runtimes_shells_and_concludes_nothing() {
        let h = setup(100);
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.gone(&id);
            h.fake.set(|state| state.reads_refused = Some(unreadable()));
            h.shells.reconcile().await;
            assert_eq!(h.state_of(&id), Some(TerminalState::Running));
            assert_eq!(said.times("reconcile: could not read environment"), 1);
        });
    }

    #[test]
    fn leaves_a_shell_the_runtime_doesnt_list_while_what_ran_it_may_still_run_it() {
        let h = setup(100);
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.set(|state| {
                state.running.remove(&id);
                state.unproven.insert(id.clone());
            });
            h.shells.reconcile().await;
            assert_eq!(h.state_of(&id), Some(TerminalState::Running));
            assert_eq!(
                said.times(&format!(
                    "reconcile: shell {id}'s terminal may still run on its old server; left"
                )),
                1
            );
        });
    }

    #[test]
    fn says_once_of_each_shell_on_a_runtime_this_daemon_doesnt_run_and_leaves_it() {
        let h = setup(100);
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let on_tmux = id.clone();
            h.store
                .run(move |store| {
                    store.write(|w| {
                        w.connection().execute(
                            "UPDATE terminals SET runtime_kind = 'tmux' WHERE id = ?",
                            [&on_tmux],
                        )
                    })
                })
                .await
                .unwrap()
                .unwrap();
            h.fake.gone(&id);
            h.shells.reconcile().await;
            assert_eq!(h.state_of(&id), Some(TerminalState::Running));
            assert_eq!(
                said.times(&format!(
                    "reconcile: shell {id} is on tmux, which this daemon doesn't run"
                )),
                1
            );
        });
    }
}
