//! What each running shell's foreground holds (`shells/foreground.ts`), kept current from process
//! facts, never from its screen: one read of the running shells on each tick, and none while no
//! shell runs. An event is recorded only when what runs changes, and it names the program alone,
//! never its command line: that is the shell's own expansion of what the user typed, secrets
//! included.

use std::collections::HashMap;
use std::sync::PoisonError;

use bazhen_protocol::events::TerminalForegroundChanged;
use bazhen_protocol::shells::TerminalState;
use bazhen_store::{Actor, NewEvent, ShellRow, TerminalChange};

use super::{ShellError, Shells, locator_of, recorded};
use crate::devices::whole;
use crate::terminals::ShellForeground;

/// The longest program name an event carries; a name is a word, never a command line.
const COMMAND_MAX: usize = 200;

impl Shells {
    /// One read of the running shells' foregrounds, recording what changed. A failure is said
    /// once until a read succeeds again.
    pub(crate) async fn refresh_foregrounds(&self) {
        let read = self.read_foregrounds().await;
        let mut fault = self
            .foreground_fault
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match read {
            Ok(()) => *fault = None,
            Err(err) => {
                let said = format!("shells: could not read their foregrounds: {err}");
                if fault.as_deref() != Some(said.as_str()) {
                    tracing::warn!("bazhen: {said}");
                }
                *fault = Some(said);
            }
        }
    }

    async fn running(&self) -> Result<Vec<ShellRow>, ShellError> {
        let shells = self
            .deps
            .store
            .run(|store| store.reads().recoverable_shells())
            .await??;
        Ok(shells
            .into_iter()
            .filter(|shell| shell.state == TerminalState::Running)
            .collect())
    }

    async fn read_foregrounds(&self) -> Result<(), ShellError> {
        let terminals: Vec<_> = self.running().await?.iter().filter_map(recorded).collect();
        if terminals.is_empty() {
            return Ok(());
        }
        let seen: HashMap<String, ShellForeground> = self
            .deps
            .terminals
            .foregrounds(&terminals)
            .await
            .map_err(|e| ShellError::Unavailable(e.to_string()))?
            .into_iter()
            .map(|f| (f.terminal.terminal_id.as_str().to_owned(), f))
            .collect();
        // Read again once the runtime has answered: a shell closed meanwhile is left as it is.
        for shell in self.running().await? {
            let Some(found) = seen.get(shell.id.as_str()) else {
                continue;
            };
            if !at_generation(found, shell.generation) {
                continue;
            }
            let found = found.clone();
            self.write(move |w| {
                if let Some(cwd) = &found.cwd
                    && *cwd != shell.current_cwd
                {
                    w.note_shell_cwd(shell.id.as_str(), cwd)?;
                }
                let command = found
                    .command
                    .as_deref()
                    .map(|c| whole(c, COMMAND_MAX).to_owned());
                if command == shell.foreground {
                    return Ok(());
                }
                w.append(&NewEvent::Terminal {
                    terminal: shell.id,
                    actor: Actor::System,
                    change: TerminalChange::ForegroundChanged(TerminalForegroundChanged {
                        command,
                    }),
                })?;
                Ok(())
            })
            .await?;
        }
        Ok(())
    }
}

/// Whether `found` was read of the shell's process at `generation`, as the store records it.
fn at_generation(found: &ShellForeground, generation: u64) -> bool {
    locator_of(&found.terminal).is_some_and(|locator| {
        locator
            .entries()
            .iter()
            .any(|(key, value)| key == "generation" && *value == generation.to_string())
    })
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::shells::{Foreground, TuiTheme};

    use super::*;
    use crate::shells::tests::{Harness, Said, setup};
    use crate::terminals::fake::unreadable;
    use crate::testing::runtime;

    impl Harness {
        /// What the state shows the only shell's foreground holding.
        fn foreground_shown(&self) -> Option<Foreground> {
            self.listed().into_iter().next().and_then(|s| s.foreground)
        }

        /// The payload of each foreground change recorded, oldest first.
        fn foreground_changes(&self) -> Vec<String> {
            let reader = self.store.reader().unwrap();
            let events = reader.reads().events(0, 1000).unwrap();
            events
                .into_iter()
                .filter(|e| e.kind == "terminal.foreground_changed")
                .map(|e| e.payload)
                .collect()
        }
    }

    #[test]
    fn shows_a_program_running_in_it_by_name_and_none_once_it_ends() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.run_in_foreground(&id, "nvim");
            h.shells.refresh_foregrounds().await;
            let running = h.foreground_shown().map(|f| f.command);
            h.fake.at_prompt(&id, None);
            h.shells.refresh_foregrounds().await;
            assert_eq!(
                (running, h.foreground_shown()),
                (Some("nvim".to_owned()), None)
            );
        });
    }

    #[test]
    fn records_a_change_only_when_what_runs_changes() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.run_in_foreground(&id, "sleep");
            h.shells.refresh_foregrounds().await;
            h.shells.refresh_foregrounds().await;
            assert_eq!(h.foreground_changes(), [r#"{"command":"sleep"}"#]);
        });
    }

    #[test]
    fn reads_nothing_at_all_while_no_shell_runs() {
        let h = setup(100);
        runtime().block_on(async {
            h.lost(TuiTheme::Dark).await;
            h.shells.refresh_foregrounds().await;
            assert_eq!(h.fake.state.lock().unwrap().foreground_reads, 0);
        });
    }

    #[test]
    fn says_a_read_that_fails_once_however_often_it_fails() {
        let h = setup(100);
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            h.open("open").await.unwrap();
            h.fake.set(|state| state.reads_refused = Some(unreadable()));
            h.shells.refresh_foregrounds().await;
            h.shells.refresh_foregrounds().await;
            assert_eq!(said.times("shells: could not read their foregrounds"), 1);
        });
    }

    #[test]
    fn drops_the_foreground_of_a_shell_that_is_lost_so_it_shows_nothing_running() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.run_in_foreground(&id, "nvim");
            h.shells.refresh_foregrounds().await;
            h.shells
                .record(
                    &bazhen_protocol::ids::TerminalId::parse(&id).unwrap(),
                    Actor::System,
                    TerminalChange::Lost,
                )
                .await
                .unwrap();
            assert_eq!(h.foreground_shown(), None);
        });
    }

    #[test]
    fn notes_the_directory_its_shell_is_in_and_names_at_most_200_units_of_a_program() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let long = format!("{}\u{1f600}", "x".repeat(199));
            h.fake.run_in_foreground(&id, &long);
            h.fake.set(|state| {
                state.running.get_mut(&id).unwrap().cwd = Some("/srv/work".to_owned());
            });
            h.shells.refresh_foregrounds().await;
            assert_eq!(
                (
                    h.shell(&id).map(|s| s.current_cwd),
                    h.foreground_shown().map(|f| f.command)
                ),
                (Some("/srv/work".to_owned()), Some("x".repeat(199)))
            );
        });
    }

    #[test]
    fn leaves_a_shell_whose_read_is_of_another_process_than_the_one_recorded() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.respawn_unseen(&id);
            h.fake.run_in_foreground(&id, "nvim");
            h.shells.refresh_foregrounds().await;
            assert_eq!(h.foreground_changes(), Vec::<String>::new());
        });
    }
}
