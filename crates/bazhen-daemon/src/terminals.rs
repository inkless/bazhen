//! What the daemon asks of the runtime its terminals run on, as `RuntimeAdapter` in
//! packages/core is to the TypeScript daemon: a seam, so the shells' lifecycle is tested against
//! a runtime in memory, and only `holder.rs` reaches a holder.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

use bazhen_protocol::daemon::{Containment, RunningHolder, RuntimeHealthReport};
use bazhen_protocol::ids::{AgentId, TerminalId};
use bazhen_protocol::record::Record;
use bazhen_protocol::shells::TuiTheme;

/// A future a runtime answers with, boxed so the trait is one a `dyn` can be.
pub(crate) type Answer<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A new shell, as the lifecycle asks for it; the runtime adds its size and history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShellSpec {
    pub(crate) terminal_id: TerminalId,
    pub(crate) linked_agent_id: Option<AgentId>,
    pub(crate) argv: Vec<String>,
    pub(crate) cwd: String,
    /// The shell's own variables, over the runtime's.
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) theme: Option<TuiTheme>,
}

/// A terminal's incarnation as the store records it: its id, and its runtime's locator, as the
/// JSON text the runtime wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Recorded {
    pub(crate) terminal_id: TerminalId,
    pub(crate) locator: String,
}

/// Why the runtime didn't do what it was asked, in the kinds a command answers differently.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum TerminalError {
    /// What runs at the terminal is not the incarnation recorded: its holder or process changed.
    #[error("{0}")]
    Stale(String),
    /// Its process is not in the state the verb needs, as one that has exited.
    #[error("{0}")]
    ProcessState(String),
    /// Its holder speaks no protocol this build does.
    #[error("its holder speaks only {}", .protocol.join(", "))]
    Unservable {
        protocol: Vec<String>,
        holder_pid: Option<u64>,
    },
    /// Nothing answers for it, but what ran it may still run it.
    #[error("{0}")]
    Unconfirmed(String),
    /// Anything else: the runtime could not act just now.
    #[error("{0}")]
    Other(String),
}

impl TerminalError {
    /// Whether a forced close may record past it: all but a terminal that is provably another
    /// than the one recorded, or one this build can't speak to (`forceable` in `commands.ts`).
    pub(crate) fn forceable(&self) -> bool {
        !matches!(
            self,
            Self::Stale(_) | Self::ProcessState(_) | Self::Unservable { .. }
        )
    }
}

/// A terminal's process that ended, at the generation it ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Exit {
    pub(crate) terminal_id: TerminalId,
    pub(crate) generation: u64,
}

/// The exits a runtime tells, from when it was asked for them.
pub(crate) trait Exits: Send + std::fmt::Debug {
    /// The next exit, or `None` once the runtime tells no more.
    fn next(&mut self) -> Answer<'_, Option<Exit>>;
}

/// The runtime new terminals run on.
pub(crate) trait Terminals: Send + Sync + std::fmt::Debug {
    /// Starts `spec`, answering where the runtime keeps it, every value a string, in the order
    /// the runtime wrote them.
    fn create(&self, spec: ShellSpec) -> Answer<'_, Result<Record<String>, TerminalError>>;

    /// Ends the terminal, and everything in it.
    fn close<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, Result<(), TerminalError>>;

    /// What holds the terminal's foreground, or `None` while its own process does.
    fn foreground<'a>(
        &'a self,
        terminal: &'a Recorded,
    ) -> Answer<'a, Result<Option<String>, TerminalError>>;

    /// The runtime's health, as `/v1/health` reports it.
    fn health(&self) -> Answer<'_, RuntimeHealthReport>;

    /// The holders that answer, for `bazhen doctor`, or why they can't be listed.
    fn holders(&self) -> Answer<'_, Result<Vec<RunningHolder>, String>>;

    /// Whether new terminals start contained, for `bazhen doctor`.
    fn containment(&self) -> Containment;

    /// The exits told from now on. Ask before the first create, or an exit told as its watch
    /// opens is missed.
    fn exits(&self) -> Box<dyn Exits>;

    /// Ends the runtime's watches and connections, and waits for them; terminals run on.
    fn shutdown(&self) -> Answer<'_, ()>;
}

#[cfg(test)]
pub(crate) mod fake {
    //! A runtime in memory: terminals that run until closed, whose foreground and exits a test
    //! sets, and whose creates and closes it can make fail.

    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use bazhen_protocol::daemon::RuntimeReportState;
    use tokio::sync::{Semaphore, mpsc};

    use super::*;

    /// One terminal the fake runs.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct Running {
        pub(crate) spec: ShellSpec,
        /// What holds its foreground; `None` for its own process.
        pub(crate) foreground: Option<String>,
        pub(crate) exited: bool,
    }

    #[derive(Debug, Default)]
    pub(crate) struct State {
        pub(crate) running: BTreeMap<String, Running>,
        /// The terminals closed, in order, each with what the store said of it as its close came.
        pub(crate) closed: Vec<String>,
        pub(crate) fail_creates: bool,
        pub(crate) fail_closes: bool,
        pub(crate) fail_holders: bool,
        /// Each create waits for a permit here before it starts anything.
        pub(crate) hold_creates: Option<Arc<Semaphore>>,
        /// Each create's process exits as it starts, told while the create has yet to answer.
        pub(crate) exit_as_created: bool,
        exits: Vec<mpsc::UnboundedSender<Exit>>,
    }

    /// How long a create whose process exited as it started takes still to answer.
    const ANSWERS_AFTER_EXIT: std::time::Duration = std::time::Duration::from_millis(50);

    /// The fake, shared between a test and the lifecycle it drives.
    #[derive(Debug, Clone, Default)]
    pub(crate) struct Fake {
        pub(crate) state: Arc<Mutex<State>>,
        /// Called as each close reaches the runtime, before it ends anything.
        pub(crate) on_close: Arc<Mutex<Option<OnClose>>>,
    }

    /// What a test runs as a close reaches the runtime.
    pub(crate) struct OnClose(pub(crate) Box<dyn Fn(&str) + Send>);

    impl std::fmt::Debug for OnClose {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("OnClose")
        }
    }

    /// The locator the fake writes for `terminal_id`: its own id, at generation 0.
    pub(crate) fn locator(terminal_id: &str) -> Record<String> {
        Record::new(vec![
            ("socket".to_owned(), format!("/fake/{terminal_id}.sock")),
            ("generation".to_owned(), "0".to_owned()),
        ])
    }

    impl Fake {
        pub(crate) fn spec_of(&self, terminal_id: &str) -> ShellSpec {
            self.state.lock().unwrap().running[terminal_id].spec.clone()
        }

        pub(crate) fn carries(&self, terminal_id: &str) -> bool {
            self.state.lock().unwrap().running.contains_key(terminal_id)
        }

        pub(crate) fn run_in_foreground(&self, terminal_id: &str, program: &str) {
            self.state
                .lock()
                .unwrap()
                .running
                .get_mut(terminal_id)
                .unwrap()
                .foreground = Some(program.to_owned());
        }

        /// Its process ends, and the exit is told to every listener.
        pub(crate) fn exit(&self, terminal_id: &str) {
            let mut state = self.state.lock().unwrap();
            state.running.get_mut(terminal_id).unwrap().exited = true;
            let exit = Exit {
                terminal_id: TerminalId::parse(terminal_id).unwrap(),
                generation: 0,
            };
            state.exits.retain(|to| to.send(exit.clone()).is_ok());
        }

        /// Its process ends, told to no one, as one that ended before anything watched it.
        pub(crate) fn exit_unseen(&self, terminal_id: &str) {
            let mut state = self.state.lock().unwrap();
            state.running.get_mut(terminal_id).unwrap().exited = true;
        }

        pub(crate) fn set(&self, change: impl FnOnce(&mut State)) {
            change(&mut self.state.lock().unwrap());
        }
    }

    #[derive(Debug)]
    struct Told(mpsc::UnboundedReceiver<Exit>);

    impl Exits for Told {
        fn next(&mut self) -> Answer<'_, Option<Exit>> {
            Box::pin(self.0.recv())
        }
    }

    impl Terminals for Fake {
        fn create(&self, spec: ShellSpec) -> Answer<'_, Result<Record<String>, TerminalError>> {
            Box::pin(async move {
                let held = self.state.lock().unwrap().hold_creates.clone();
                if let Some(gate) = held {
                    gate.acquire().await.unwrap().forget();
                }
                let id = spec.terminal_id.as_str().to_owned();
                let exits_as_created = {
                    let mut state = self.state.lock().unwrap();
                    if state.fail_creates {
                        return Err(TerminalError::Other("the fake refused".to_owned()));
                    }
                    state.running.insert(
                        id.clone(),
                        Running {
                            spec,
                            foreground: None,
                            exited: false,
                        },
                    );
                    state.exit_as_created
                };
                if exits_as_created {
                    self.exit(&id);
                    tokio::time::sleep(ANSWERS_AFTER_EXIT).await;
                }
                Ok(locator(&id))
            })
        }

        fn close<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, Result<(), TerminalError>> {
            Box::pin(async move {
                let id = terminal.terminal_id.as_str();
                if let Some(OnClose(seen)) = self.on_close.lock().unwrap().as_ref() {
                    seen(id);
                }
                let mut state = self.state.lock().unwrap();
                if state.fail_closes {
                    return Err(TerminalError::Other("the fake is unreachable".to_owned()));
                }
                state.running.remove(id);
                state.closed.push(id.to_owned());
                Ok(())
            })
        }

        fn foreground<'a>(
            &'a self,
            terminal: &'a Recorded,
        ) -> Answer<'a, Result<Option<String>, TerminalError>> {
            Box::pin(async move {
                let state = self.state.lock().unwrap();
                match state.running.get(terminal.terminal_id.as_str()) {
                    Some(running) if running.exited => Err(TerminalError::ProcessState(
                        "its process isn't running".to_owned(),
                    )),
                    Some(running) => Ok(running.foreground.clone()),
                    None => Err(TerminalError::Stale("no such terminal".to_owned())),
                }
            })
        }

        fn health(&self) -> Answer<'_, RuntimeHealthReport> {
            Box::pin(async {
                RuntimeHealthReport {
                    kind: "holder".to_owned(),
                    state: RuntimeReportState::NotRunning,
                    version: Some("holder/1.4".to_owned()),
                    workarounds: None,
                }
            })
        }

        fn holders(&self) -> Answer<'_, Result<Vec<RunningHolder>, String>> {
            Box::pin(async {
                if self.state.lock().unwrap().fail_holders {
                    return Err("the fake can't list its holders".to_owned());
                }
                Ok(Vec::new())
            })
        }

        fn containment(&self) -> Containment {
            Containment::Unchecked
        }

        fn exits(&self) -> Box<dyn Exits> {
            let (tx, rx) = mpsc::unbounded_channel();
            self.state.lock().unwrap().exits.push(tx);
            Box::new(Told(rx))
        }

        fn shutdown(&self) -> Answer<'_, ()> {
            Box::pin(async {
                self.state.lock().unwrap().exits.clear();
            })
        }
    }
}
