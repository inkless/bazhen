//! Which terminals need a restart (`terminals/needs-restart.ts`), kept in step with what their
//! runtime serves: a terminal on a holder this build can't fully serve is recorded once, and
//! cleared once a build that serves it in full reads it, as after a daemon update. For each such
//! terminal, the holder's pid as last proved still running there is kept too, which is all a
//! restart prompt may name: a pid reused since must never be offered up to be ended.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use bazhen_protocol::events::TerminalNeedsRestart;
use bazhen_protocol::ids::TerminalId;
use bazhen_protocol::record::Record;
use bazhen_store::{Actor, AppendError, NewEvent, TerminalChange};
use rusqlite::OptionalExtension as _;

use crate::terminals::Terminals;
use crate::writer::Writer;

/// The largest integer JavaScript's `Number` holds exactly, as a locator's pid is read.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The holder each terminal that needs a restart runs on, as last proved still running there.
#[derive(Debug, Default)]
pub(crate) struct Restarts {
    holders: Mutex<HashMap<String, u64>>,
}

impl Restarts {
    /// The holder to end for each terminal, as the last read proved it, by the terminal's id.
    pub(crate) fn holders(&self) -> HashMap<String, u64> {
        self.holders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// One read of the runtime, recording each terminal that now needs a restart and each that
    /// needs one no more.
    ///
    /// # Errors
    ///
    /// When the runtime or the store can't be read: nothing changes.
    pub(crate) async fn sweep(
        &self,
        store: &Writer,
        terminals: &dyn Terminals,
    ) -> Result<(), String> {
        let read = terminals.compatibility().await.map_err(|e| e.to_string())?;
        let outdated = read.outdated;
        let served = read.served;
        let locators = store
            .run(move |store| {
                store.write(|w| -> Result<Vec<(String, Option<String>)>, AppendError> {
                    let reads = w.reads();
                    let mut locators = Vec::new();
                    for (id, protocol) in &outdated {
                        let Some(terminal) = TerminalId::parse(id) else {
                            continue;
                        };
                        if reads.restart_unrecorded(id)? {
                            w.append(&NewEvent::Terminal {
                                terminal,
                                actor: Actor::System,
                                change: TerminalChange::NeedsRestart(TerminalNeedsRestart {
                                    protocol: protocol.clone(),
                                }),
                            })?;
                        }
                        let locator: Option<Option<String>> = w
                            .connection()
                            .query_row("SELECT locator FROM terminals WHERE id = ?", [id], |row| {
                                row.get(0)
                            })
                            .optional()?;
                        locators.push((id.clone(), locator.flatten()));
                    }
                    for id in reads.restarts_recorded()? {
                        let Some(terminal) = TerminalId::parse(&id) else {
                            continue;
                        };
                        if served.contains(&id) {
                            w.append(&NewEvent::Terminal {
                                terminal,
                                actor: Actor::System,
                                change: TerminalChange::RestartCleared,
                            })?;
                        }
                    }
                    Ok(locators)
                })
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let holders = locators
            .into_iter()
            .filter_map(|(id, locator)| {
                let (pid, start) = holder_of(locator.as_deref()?)?;
                terminals.vouches(pid, start).then_some((id, pid))
            })
            .collect();
        *self.holders.lock().unwrap_or_else(PoisonError::into_inner) = holders;
        Ok(())
    }
}

/// The holder a locator records, as its pid and start, where both are whole numbers a pid and a
/// start can be: never init, or below.
fn holder_of(locator: &str) -> Option<(u64, u64)> {
    let locator: Record<String> = serde_json::from_str(locator).ok()?;
    let number = |key: &str| {
        let (_, text) = locator.entries().iter().find(|(k, _)| k == key)?;
        text.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE_INTEGER)
    };
    let pid = number("holderPid").filter(|pid| *pid > 1)?;
    Some((pid, number("holderStart")?))
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::events::{TerminalClosed, TerminalClosedReason};
    use bazhen_protocol::shells::{NeedsRestart, Shell};
    use bazhen_store::SnapshotView;

    use super::*;
    use crate::shells::tests::{Harness, setup};
    use crate::terminals::Compatibility;
    use crate::terminals::fake::{HOLDER_PID, unreadable};
    use crate::testing::runtime;

    impl Harness {
        /// The runtime reads the terminal `id` names as on a holder this build can't serve in
        /// full, speaking `protocol`, or as served in full.
        fn serve(&self, id: &str, outdated: Option<&[&str]>) {
            self.fake.set(|state| {
                state.compatibility = match outdated {
                    Some(protocol) => Compatibility {
                        outdated: [(
                            id.to_owned(),
                            protocol.iter().map(|v| (*v).to_owned()).collect(),
                        )]
                        .into(),
                        served: [].into(),
                    },
                    None => Compatibility {
                        outdated: [].into(),
                        served: [id.to_owned()].into(),
                    },
                };
            });
        }

        async fn sweep_restarts(&self) {
            self.shells.sweep_restarts().await.unwrap();
        }

        /// The only shell, as the state shows it with the holders the last read proved.
        fn shown(&self) -> Option<Shell> {
            let view = SnapshotView {
                host: "h".to_owned(),
                restart_holders: self.shells.restarts().holders(),
                shells_report: false,
            };
            let reader = self.store.reader().unwrap();
            reader
                .reads()
                .snapshot(&view)
                .unwrap()
                .shells
                .into_iter()
                .next()
        }

        fn recorded(&self, id: &str, kind: &str) -> usize {
            let reader = self.store.reader().unwrap();
            let events = reader.reads().events(0, 1000).unwrap();
            events
                .iter()
                .filter(|e| e.entity_id == id && e.kind == kind)
                .count()
        }
    }

    #[test]
    fn records_one_once_however_often_it_is_seen_naming_the_holder_it_proved_still_runs() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let before = h.shown().and_then(|s| s.needs_restart);
            h.serve(&id, Some(&["2.0"]));
            h.sweep_restarts().await;
            h.sweep_restarts().await;
            assert_eq!(
                (
                    before,
                    h.shown().and_then(|s| s.needs_restart),
                    h.recorded(&id, "terminal.needs_restart")
                ),
                (
                    None,
                    Some(NeedsRestart {
                        holder_pid: Some(HOLDER_PID),
                        served: false
                    }),
                    1
                )
            );
        });
    }

    #[test]
    fn names_no_pid_once_the_holder_isnt_proved_to_run_there_and_offers_no_attach_command() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.serve(&id, Some(&["2.0"]));
            h.fake.set(|state| {
                state.holders_ended.insert(HOLDER_PID);
            });
            h.sweep_restarts().await;
            let shown = h.shown().unwrap();
            assert_eq!(
                (shown.needs_restart, shown.attach_command),
                (
                    Some(NeedsRestart {
                        holder_pid: None,
                        served: false
                    }),
                    None
                )
            );
        });
    }

    #[test]
    fn clears_it_once_a_build_that_serves_the_terminal_in_full_reads_it() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.serve(&id, Some(&["2.0"]));
            h.sweep_restarts().await;
            h.serve(&id, None);
            h.sweep_restarts().await;
            h.sweep_restarts().await;
            assert_eq!(
                (
                    h.shown().and_then(|s| s.needs_restart),
                    h.recorded(&id, "terminal.restart_cleared")
                ),
                (None, 1)
            );
        });
    }

    #[test]
    fn shows_nothing_for_a_terminal_lost_since_whose_pid_may_be_anyones_by_now() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.serve(&id, Some(&["2.0"]));
            h.sweep_restarts().await;
            h.mark(&id, TerminalChange::Lost).await;
            assert_eq!(h.shown().and_then(|s| s.needs_restart), None);
        });
    }

    #[test]
    fn tells_a_holder_this_build_still_serves_on_an_older_major_from_one_it_cant_speak_to() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.serve(&id, Some(&["0.9", bazhen_holder_proto::PROTOCOL_VERSION]));
            h.sweep_restarts().await;
            assert_eq!(
                h.shown().and_then(|s| s.needs_restart),
                Some(NeedsRestart {
                    holder_pid: Some(HOLDER_PID),
                    served: true
                })
            );
        });
    }

    #[test]
    fn records_nothing_for_a_terminal_that_has_ended_or_while_the_runtime_cant_be_read() {
        let h = setup(100);
        runtime().block_on(async {
            let ended = h.open("ended").await.unwrap();
            for change in [
                TerminalChange::Closing,
                TerminalChange::Closed(TerminalClosed {
                    reason: TerminalClosedReason::User,
                }),
            ] {
                h.mark(&ended, change).await;
            }
            h.serve(&ended, Some(&["2.0"]));
            h.sweep_restarts().await;
            let unread = h.open("unread").await.unwrap();
            h.serve(&unread, Some(&["2.0"]));
            h.fake.set(|state| state.reads_refused = Some(unreadable()));
            let failed = h.shells.sweep_restarts().await;
            assert!(failed.is_err(), "{failed:?}");
            assert_eq!(
                [
                    h.recorded(&ended, "terminal.needs_restart"),
                    h.recorded(&unread, "terminal.needs_restart")
                ],
                [0, 0]
            );
        });
    }
}
