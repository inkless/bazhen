//! What a restarted daemon makes of its shells (`shells/reconcile.ts`): each the store records is
//! matched against what the runtime runs, by the rules agents go by. A runtime that can't be read
//! concludes nothing about its shells, and a shell the runtime doesn't list is lost only once what
//! ran it is provably gone. A shell whose process exited while the daemon was down is closed, as
//! it would have been at once. The shells a start couldn't settle are tried again each tick, and
//! only those: any other was opened by this daemon, which settles it itself.

use std::collections::{BTreeSet, HashMap};
use std::sync::PoisonError;

use bazhen_protocol::events::{TerminalFailed, TerminalFailedReason};
use bazhen_protocol::ids::TerminalId;
use bazhen_protocol::shells::TerminalState;
use bazhen_store::{Actor, ShellRow, TerminalChange};

use super::{RUNTIME, ShellError, Shells, Unended, adopts, gone_from, incarnation, recorded};
use crate::terminals::{FoundShell, TerminalError};

/// The shells a start read and couldn't settle yet, and what the last try of them said, so a
/// failure that lasts is said once.
#[derive(Debug, Default)]
pub(crate) struct Unreconciled {
    kept: BTreeSet<String>,
    said: Vec<String>,
}

/// Why a shell wasn't settled.
#[derive(Debug)]
enum Unsettled {
    /// A later try may settle it: the store or its runtime couldn't be reached just now.
    Again(ShellError),
    /// The runtime doesn't list it, and what ran it isn't proven gone: it may still run where
    /// no read reaches, or its holder may yet bind its socket again or be shown gone.
    Unproven,
    /// No try can: it is left as it is.
    Never(ShellError),
}

impl From<ShellError> for Unsettled {
    fn from(err: ShellError) -> Self {
        Self::Again(err)
    }
}

impl Unsettled {
    /// The runtime's failure for shell `id`, kept to try again only where a later try may get
    /// past it.
    fn of(id: &str, cause: TerminalError) -> Self {
        if cause.forceable() {
            Self::Again(super::from_runtime(id, cause))
        } else {
            Self::Never(super::from_runtime(id, cause))
        }
    }
}

/// What one try of the kept shells left: those to try again, and what it said of them.
struct Tried {
    kept: BTreeSet<String>,
    said: Vec<String>,
}

/// Whether a shell in `state` may still be running, as `recoverable_shells` reads them.
fn recoverable(state: TerminalState) -> bool {
    !matches!(
        state,
        TerminalState::Lost | TerminalState::Closed | TerminalState::Failed
    )
}

impl Shells {
    /// Matches the runtime's shells against the store's, before anything else acts on them.
    /// Run it before the runtime's events are followed: an exit told meanwhile waits, and then
    /// finds the shell as this left it. What it can't settle, `reconcile_again` tries again.
    ///
    /// # Errors
    ///
    /// When the store can't be read: no shell is known to settle.
    pub(crate) async fn reconcile(&self) -> Result<(), ShellError> {
        let kept = self
            .deps
            .store
            .run(|store| store.reads().recoverable_shells())
            .await??;
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
        self.unreconciled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .kept = ours
            .iter()
            .map(|shell| shell.id.as_str().to_owned())
            .collect();
        self.settle_kept().await;
        Ok(())
    }

    /// Tries again each shell the start's reconcile couldn't settle, saying once when the last
    /// of them is.
    pub(crate) async fn reconcile_again(&self) {
        if self.unreconciled_ids().is_empty() {
            return;
        }
        if self.settle_kept().await {
            tracing::info!("bazhen: reconcile: settled the shells it couldn't at start");
        }
    }

    fn unreconciled_ids(&self) -> Vec<String> {
        let unreconciled = self
            .unreconciled
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        unreconciled.kept.iter().cloned().collect()
    }

    /// Settles the kept shells it can, keeping the rest, and says what the last try didn't.
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
        let all = ids.iter().cloned().collect();
        let read = self
            .deps
            .store
            .run(move |store| {
                let reads = store.reads();
                let mut shells = Vec::new();
                for id in &ids {
                    shells.extend(reads.shell(id)?);
                }
                Ok::<_, rusqlite::Error>((shells, reads.local_environment()?))
            })
            .await
            .map_err(ShellError::from)
            .and_then(|read| read.map_err(ShellError::from));
        let (shells, environment) = match read {
            Ok(read) => read,
            Err(err) => {
                return Tried {
                    kept: all,
                    said: vec![format!("could not read the shells: {err}")],
                };
            }
        };
        let shells: Vec<ShellRow> = shells
            .into_iter()
            .filter(|shell| recoverable(shell.state))
            .collect();
        if shells.is_empty() {
            return Tried {
                kept: BTreeSet::new(),
                said: Vec::new(),
            };
        }
        let kept = shells.iter().map(|s| s.id.as_str().to_owned()).collect();
        let environment = environment.unwrap_or_default();
        let known: Vec<_> = shells.iter().filter_map(recorded).collect();
        if !self.deps.terminals.reachable(&known).await {
            return Tried {
                kept,
                said: vec![format!(
                    "could not reach environment {environment}'s {RUNTIME} shells; trying again each tick"
                )],
            };
        }
        let present: HashMap<String, FoundShell> = match self.deps.terminals.shells().await {
            Ok(found) => found
                .into_iter()
                .map(|f| (f.terminal.terminal_id.as_str().to_owned(), f))
                .collect(),
            Err(err) => {
                return Tried {
                    kept,
                    said: vec![format!(
                        "could not read environment {environment}'s {RUNTIME} shells: {err}"
                    )],
                };
            }
        };
        let mut tried = Tried {
            kept: BTreeSet::new(),
            said: Vec::new(),
        };
        for shell in &shells {
            let id = shell.id.as_str();
            match self.settle_now(&shell.id, present.get(id)).await {
                Ok(()) => {}
                Err(Unsettled::Again(err)) => {
                    tried.kept.insert(id.to_owned());
                    tried
                        .said
                        .push(format!("could not settle shell {id}: {err}"));
                }
                Err(Unsettled::Unproven) => {
                    tried.kept.insert(id.to_owned());
                    tried.said.push(format!(
                        "shell {id}'s terminal may still run on its old server; trying again each tick"
                    ));
                }
                Err(Unsettled::Never(err)) => {
                    tracing::warn!(
                        "bazhen: reconcile: can't settle shell {id}, so it is left as it is: {err}"
                    );
                }
            }
        }
        tried
    }

    /// Settles the shell `id` names as it is now, under its turn: a command or an event on it
    /// meanwhile went first, and one it closed, lost or failed is left as it is.
    async fn settle_now(
        &self,
        id: &TerminalId,
        found: Option<&FoundShell>,
    ) -> Result<(), Unsettled> {
        let _turn = self.turns.take(id.as_str()).await;
        match self.shell(id.as_str()).await? {
            Some(shell) if recoverable(shell.state) => self.settle(&shell, found).await,
            _ => Ok(()),
        }
    }

    async fn settle(&self, shell: &ShellRow, found: Option<&FoundShell>) -> Result<(), Unsettled> {
        let id = &shell.id;
        if shell.state == TerminalState::Creating {
            // The daemon died while opening it: the terminal tagged with it is the shell, or
            // there is none.
            let Some(found) = found else {
                let failed = TerminalChange::Failed(TerminalFailed {
                    reason: TerminalFailedReason::DaemonRestart,
                });
                return Ok(self.record(id, Actor::System, failed).await.map(drop)?);
            };
            let running =
                TerminalChange::Running(incarnation(&found.terminal).map_err(Unsettled::Never)?);
            self.record(id, Actor::System, running).await?;
            if found.dead {
                self.ended(id.as_str()).await?;
            }
            return Ok(());
        }
        if let Some(found) = found {
            let adopted = adopts(shell, &found.terminal);
            if adopted {
                let change = TerminalChange::ProcessAdopted(
                    incarnation(&found.terminal).map_err(Unsettled::Never)?,
                );
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
                    .map_err(|cause| Unsettled::of(id.as_str(), cause))?;
            }
            return Ok(());
        }
        if let Some(terminal) = recorded(shell)
            && !self.deps.terminals.gone(&terminal).await
        {
            return Err(Unsettled::Unproven);
        }
        Ok(self
            .record(id, Actor::System, gone_from(shell.state))
            .await
            .map(drop)?)
    }

    /// Ends the shell `id` names as it is now, its process having exited.
    async fn ended(&self, id: &str) -> Result<(), Unsettled> {
        let shell = self
            .shell(id)
            .await?
            .ok_or_else(|| ShellError::Unknown(id.to_owned()))?;
        self.ending(&shell).await
    }

    async fn ending(&self, shell: &ShellRow) -> Result<(), Unsettled> {
        self.end_exited(shell)
            .await
            .map_err(|unended| match unended {
                Unended::Again(err) => Unsettled::Again(err),
                Unended::Never { err, .. } => Unsettled::Never(err),
            })
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::events::RuntimeRefPayload;
    use bazhen_protocol::events::{TerminalIncarnation as Incarnation, TerminalOpened};
    use bazhen_protocol::ids::{AgentId, TerminalId};
    use std::sync::Arc;

    use bazhen_store::NewEvent;

    use super::*;
    use crate::shells::tests::{Harness, Said, setup};
    use crate::terminals::fake::{Held, Reach, Running, locator_at, unreadable};
    use crate::testing::runtime;

    const AGENT: &str = "agent_0190a1b2c3d47abc8def0123456789ad";

    impl Harness {
        /// A shell the store records opening on the holder runtime, which the runtime started
        /// nothing for.
        pub(crate) async fn opening_unanswered(&self) -> String {
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

        /// How many terminals the store counts as starting, as the budget admits by.
        pub(crate) fn starting(&self) -> u64 {
            self.store
                .reader()
                .unwrap()
                .reads()
                .starting_terminals()
                .unwrap()
        }

        /// Returns once a command or settle waits for the shell's turn behind the one holding it.
        /// Panics if none has within 10 s, so a retry that neither waits nor ends fails the test.
        async fn turn_awaited(&self, id: &str) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let waiting = self
                    .shells
                    .turns
                    .0
                    .lock()
                    .unwrap()
                    .get(id)
                    // The map's, the holder's guard's, and the waiter's.
                    .is_some_and(|lock| Arc::strong_count(lock) > 2);
                if waiting {
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "nothing waited for shell {id}'s turn within 10 s"
                );
                tokio::task::yield_now().await;
            }
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
            h.shells.reconcile().await.unwrap();
            assert_eq!(h.state_of(&id), Some(TerminalState::Lost));
        });
    }

    #[test]
    fn closes_a_shell_whose_shell_exited_while_the_daemon_was_down_rather_than_call_it_lost() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.exit_unseen(&id);
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
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
            h.shells.reconcile().await.unwrap();
            assert_eq!(h.state_of(&id), Some(TerminalState::Running));
            assert_eq!(
                said.times(&format!(
                    "reconcile: shell {id}'s terminal may still run on its old server; trying again each tick"
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
            h.shells.reconcile().await.unwrap();
            assert_eq!(h.state_of(&id), Some(TerminalState::Running));
            assert_eq!(
                said.times(&format!(
                    "reconcile: shell {id} is on tmux, which this daemon doesn't run"
                )),
                1
            );
        });
    }

    #[test]
    fn settles_on_a_later_try_a_shell_left_creating_while_the_runtime_couldnt_be_reached() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.opening_unanswered().await;
            h.fake.set(|state| state.reach = Reach::Unreachable);
            h.shells.reconcile().await.unwrap();
            let at_start = (h.state_of(&id), h.starting());
            h.fake.set(|state| state.reach = Reach::Answers);
            h.shells.reconcile_again().await;
            assert_eq!(
                (at_start, (h.state_of(&id), h.starting())),
                (
                    (Some(TerminalState::Creating), 1),
                    (Some(TerminalState::Failed), 0)
                )
            );
        });
    }

    #[test]
    fn marks_lost_on_a_later_try_a_shell_whose_holder_went_while_the_runtime_couldnt_be_read() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.gone(&id);
            h.fake.set(|state| state.reads_refused = Some(unreadable()));
            h.shells.reconcile().await.unwrap();
            let at_start = h.state_of(&id);
            h.fake.set(|state| state.reads_refused = None);
            h.shells.reconcile_again().await;
            assert_eq!(
                (at_start, h.state_of(&id)),
                (Some(TerminalState::Running), Some(TerminalState::Lost))
            );
        });
    }

    #[test]
    fn never_settles_on_a_later_try_a_shell_opened_since_the_start() {
        let h = setup(100);
        runtime().block_on(async {
            let kept = h.opening_unanswered().await;
            h.fake.set(|state| state.reach = Reach::Unreachable);
            h.shells.reconcile().await.unwrap();
            let since = h.opening_unanswered().await;
            h.fake.set(|state| state.reach = Reach::Answers);
            h.shells.reconcile_again().await;
            assert_eq!(
                [h.state_of(&kept), h.state_of(&since)],
                [Some(TerminalState::Failed), Some(TerminalState::Creating)]
            );
        });
    }

    #[test]
    fn marks_lost_on_a_later_try_a_shell_whose_holder_wasnt_yet_shown_gone_at_start() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.set(|state| {
                state.running.remove(&id);
                state.unproven.insert(id.clone());
            });
            h.shells.reconcile().await.unwrap();
            let at_start = h.state_of(&id);
            h.fake.set(|state| {
                state.unproven.remove(&id);
            });
            h.shells.reconcile_again().await;
            assert_eq!(
                (at_start, h.state_of(&id)),
                (Some(TerminalState::Running), Some(TerminalState::Lost))
            );
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn waits_for_a_users_close_of_a_kept_shell_rather_than_close_it_under_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.set(|state| state.reads_refused = Some(unreadable()));
            h.shells.reconcile().await.unwrap();
            let held = Held::shut();
            h.fake.set(|state| {
                state.reads_refused = None;
                state.hold_closes = Some(held.clone());
            });
            let shells = Arc::clone(&h.shells);
            let close = bazhen_protocol::shells::CloseShellRequest {
                idempotency_key: "c".to_owned(),
                generation: 0,
                confirm_busy: Some(true),
                confirmed_program: None,
                force: None,
            };
            let tasks = tokio_util::task::TaskTracker::new();
            let shut = id.clone();
            let closing = tasks.spawn(async move { shells.close(&shut, &close).await });
            // Its terminal gone, the close yet to record it closed.
            held.reached().await;
            let shells = Arc::clone(&h.shells);
            let mut trying = tasks.spawn(async move { shells.reconcile_again().await });
            let tried = tokio::select! {
                tried = &mut trying => {
                    tried.unwrap();
                    true
                }
                () = h.turn_awaited(&id) => false,
            };
            held.go.add_permits(1);
            let answered = closing.await.unwrap();
            if !tried {
                trying.await.unwrap();
            }
            let recorded_closed = h
                .events_of(&id)
                .into_iter()
                .filter(|(kind, _)| kind == "terminal.closed")
                .count();
            assert_eq!(
                (answered.is_ok(), h.state_of(&id), recorded_closed),
                (true, Some(TerminalState::Closed), 1),
                "{answered:?}"
            );
        });
    }

    #[test]
    fn leaves_a_kept_shell_closed_while_a_later_try_read_the_runtime_as_it_was_closed() {
        let h = setup(100);
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.set(|state| state.reads_refused = Some(unreadable()));
            h.shells.reconcile().await.unwrap();
            let held = Held::shut();
            h.fake.set(|state| {
                state.reads_refused = None;
                state.hold_inventory = Some(held.clone());
            });
            let shells = Arc::clone(&h.shells);
            let trying = tokio_util::task::TaskTracker::new()
                .spawn(async move { shells.reconcile_again().await });
            held.reached().await;
            // A close recorded meanwhile, its holder ended.
            h.fake.set(|state| {
                state.running.remove(&id);
            });
            h.mark(&id, TerminalChange::Closing).await;
            h.mark(
                &id,
                TerminalChange::Closed(bazhen_protocol::events::TerminalClosed {
                    reason: bazhen_protocol::events::TerminalClosedReason::User,
                }),
            )
            .await;
            let closed = h.events_of(&id).len();
            held.go.add_permits(1);
            trying.await.unwrap();
            assert_eq!(
                (
                    h.state_of(&id),
                    h.events_of(&id).len(),
                    said.times("reconcile: could not settle shell"),
                    said.times("reconcile: settled the shells it couldn't at start")
                ),
                (Some(TerminalState::Closed), closed, 0, 1)
            );
        });
    }

    #[test]
    fn says_a_lasting_failure_once_and_once_that_the_shells_it_kept_are_settled() {
        let h = setup(100);
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            h.open("open").await.unwrap();
            h.fake.set(|state| state.reads_refused = Some(unreadable()));
            h.shells.reconcile().await.unwrap();
            h.shells.reconcile_again().await;
            h.shells.reconcile_again().await;
            h.fake.set(|state| state.reads_refused = None);
            h.shells.reconcile_again().await;
            h.shells.reconcile_again().await;
            assert_eq!(
                (
                    said.times("reconcile: could not read environment"),
                    said.times("reconcile: settled the shells it couldn't at start")
                ),
                (1, 1)
            );
        });
    }

    #[test]
    fn closes_on_a_later_try_an_exited_shell_whose_close_failed_for_now() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.exit_unseen(&id);
            h.fake.set(|state| state.fail_closes = true);
            h.shells.reconcile().await.unwrap();
            let at_start = h.state_of(&id);
            h.fake.set(|state| state.fail_closes = false);
            h.shells.reconcile_again().await;
            assert_eq!(
                (at_start, h.state_of(&id)),
                (Some(TerminalState::Closing), Some(TerminalState::Closed))
            );
        });
    }

    #[test]
    fn tries_no_more_an_exited_shell_no_close_can_end() {
        let h = setup(100);
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.exit_unseen(&id);
            h.fake.set(|state| {
                state.closes_refused = Some(crate::terminals::TerminalError::Stale(
                    "another holder runs it".to_owned(),
                ));
            });
            let closes = h.count_closes();
            h.shells.reconcile().await.unwrap();
            h.shells.reconcile_again().await;
            assert_eq!(
                (
                    h.state_of(&id),
                    closes.load(std::sync::atomic::Ordering::SeqCst),
                    said.times(&format!("reconcile: can't settle shell {id}"))
                ),
                (Some(TerminalState::Closing), 1, 1)
            );
        });
    }
}
