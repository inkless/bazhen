//! What the daemon asks of the runtime its terminals run on, as `RuntimeAdapter` in
//! packages/core is to the TypeScript daemon: a seam, so the shells' lifecycle is tested against
//! a runtime in memory, and only `holder.rs` reaches a holder.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;

use bazhen_protocol::daemon::{Containment, RunningHolder, RuntimeHealthReport};
use bazhen_protocol::ids::{AgentId, TerminalId};
use bazhen_protocol::record::Record;
use bazhen_protocol::shells::TuiTheme;
use bazhen_protocol::terminals::TerminalScreen;

/// A future a runtime answers with, boxed so the trait is one a `dyn` can be.
pub(crate) type Answer<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a new terminal holds, as its runtime tags it, so an inventory tells them apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Kind {
    /// A shell, beside an agent or on its own.
    Shell { linked_agent_id: Option<AgentId> },
    /// An agent's TUI, with the harness session it starts when that is known before it does:
    /// carried on the terminal, so a daemon that dies before recording it can still resume it.
    Agent {
        agent_id: AgentId,
        harness_session: Option<String>,
    },
}

/// A new terminal, as a lifecycle asks for it; the runtime adds its size and history.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct NewTerminal {
    pub(crate) terminal_id: TerminalId,
    pub(crate) kind: Kind,
    pub(crate) argv: Vec<String>,
    pub(crate) cwd: String,
    /// Its own variables, over the runtime's.
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) theme: Option<TuiTheme>,
    /// The generation its first process starts at: 0, but for an agent relaunched on it.
    pub(crate) generation: u64,
}

/// Its variables by name alone: `BAZHEN_SHELL_TOKEN`'s value proves the shell.
impl std::fmt::Debug for NewTerminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewTerminal")
            .field("terminal_id", &self.terminal_id)
            .field("kind", &self.kind)
            .field("argv", &self.argv)
            .field("cwd", &self.cwd)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("theme", &self.theme)
            .field("generation", &self.generation)
            .finish()
    }
}

/// A terminal's process started again in the same terminal: what it runs, where, with which of
/// its own variables, and at which generation.
pub(crate) struct Restart {
    pub(crate) argv: Vec<String>,
    pub(crate) cwd: String,
    /// Its own variables, over the runtime's.
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) theme: Option<TuiTheme>,
    pub(crate) generation: u64,
}

/// Its variables by name alone: `BAZHEN_AGENT_AUTH_FILE` names the agent's token.
impl std::fmt::Debug for Restart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Restart")
            .field("argv", &self.argv)
            .field("cwd", &self.cwd)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("theme", &self.theme)
            .field("generation", &self.generation)
            .finish()
    }
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
    /// Nothing answers for it, and what ran it provably runs no more: it is running nothing.
    #[error("{0}")]
    Gone(String),
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
    /// What runs it is there, but can't be reached just now: asking again may work.
    #[error("{0}")]
    Unreachable(String),
    /// Its holder predates `what`, which was asked of it; restarting the terminal starts it on one
    /// that has it.
    #[error("its holder predates {what}")]
    Predates { what: String },
    /// Its screen can't be read just now, as when its holder has lost it.
    #[error("its screen can't be read: {reason}")]
    Unreadable { reason: String },
    /// The request reached the runtime, which didn't say what came of it: what was asked may
    /// have happened, as a holder spawned that hasn't answered, or a respawn whose answer was lost.
    #[error("{0}")]
    Unknown(String),
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
            Self::Stale(_) | Self::Gone(_) | Self::ProcessState(_) | Self::Unservable { .. }
        )
    }
}

/// A terminal's process that ended, at the generation it ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Exit {
    pub(crate) terminal_id: TerminalId,
    pub(crate) generation: u64,
    /// How it ended, as an agent's exit records it.
    pub(crate) status: bazhen_holder_proto::body::ExitStatus,
    /// The incarnation that ended, where the runtime named it: one at a later generation than the
    /// store's is of a process started outside the daemon, adopted as it closes.
    pub(crate) found: Option<Recorded>,
}

/// What a runtime tells of its terminals unasked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Event {
    Exited(Exit),
    /// A process started outside the daemon runs in the terminal: this names it.
    Respawned(Recorded),
    /// What ran the terminal has gone, or its socket has: this names the incarnation it ran.
    Lost(Recorded),
    /// The terminal's title may have changed: [`Terminals::title`] reads it. The title itself
    /// isn't told, as one told could be read after a respawn it predates.
    Title(TerminalId),
    /// Events were missed, a title among them maybe: whoever follows titles reads them again.
    TitlesMissed,
}

/// The events a runtime tells, from when it was asked for them.
pub(crate) trait Events: Send + std::fmt::Debug {
    /// The next event, or `None` once the runtime tells no more.
    fn next(&mut self) -> Answer<'_, Option<Event>>;
}

/// A shell the runtime runs, as its inventory lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FoundShell {
    pub(crate) terminal: Recorded,
    /// Its process has exited.
    pub(crate) dead: bool,
    /// The agent its terminal still names, if it does.
    pub(crate) linked_agent_id: Option<AgentId>,
}

/// An agent's terminal the runtime runs, as its inventory lists it: one tagged for `agent_id`,
/// whether or not it is that agent's current terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FoundAgent {
    pub(crate) terminal: Recorded,
    /// How its process ended, where it has.
    pub(crate) exit: Option<bazhen_holder_proto::body::ExitStatus>,
    pub(crate) agent_id: AgentId,
    /// The harness session its terminal was started with, where one was known.
    pub(crate) harness_session: Option<String>,
}

/// What one read of the agents' terminals finds: those read, and those whose holders are there
/// but couldn't be read, which prove nothing either way.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AgentsFound {
    pub(crate) found: Vec<FoundAgent>,
    pub(crate) unreadable: Vec<TerminalId>,
}

/// What a running shell's foreground holds, as one read of them all finds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShellForeground {
    pub(crate) terminal: Recorded,
    /// The program's name, `None` at the shell's prompt.
    pub(crate) command: Option<String>,
    /// The directory the shell is in now, `None` when it couldn't be read whole.
    pub(crate) cwd: Option<String>,
}

/// Which terminals this build serves in full, and which run where it can't, with the versions
/// what runs them speaks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Compatibility {
    pub(crate) outdated: BTreeMap<String, Vec<String>>,
    pub(crate) served: BTreeSet<String>,
}

/// The runtime new terminals run on.
pub(crate) trait Terminals: Send + Sync + std::fmt::Debug {
    /// Starts `spec`, answering where the runtime keeps it, every value a string, in the order
    /// the runtime wrote them.
    fn create(&self, spec: NewTerminal) -> Answer<'_, Result<Record<String>, TerminalError>>;

    /// Ends the terminal, and everything in it.
    fn close<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, Result<(), TerminalError>>;

    /// What holds the terminal's foreground, or `None` while its own process does.
    fn foreground<'a>(
        &'a self,
        terminal: &'a Recorded,
    ) -> Answer<'a, Result<Option<String>, TerminalError>>;

    /// What holds the foreground of each running shell among `terminals`, leaving out any that
    /// can't be read.
    fn foregrounds<'a>(
        &'a self,
        terminals: &'a [Recorded],
    ) -> Answer<'a, Result<Vec<ShellForeground>, TerminalError>>;

    /// Types `text` at the terminal without Enter, as a paste its holder's gate types only if
    /// the program would read it as text now; marked with the bracketed-paste sequences when
    /// `brackets` is true. A refusal says why, never quoting the text.
    fn paste<'a>(
        &'a self,
        terminal: &'a Recorded,
        text: &'a str,
        brackets: bool,
    ) -> Answer<'a, Result<(), TerminalError>>;

    /// The screen shown as plain text, after the newest `history` rows of history, from reading
    /// alone: it takes no writer's slot, and nothing reaches the terminal.
    fn screen<'a>(
        &'a self,
        terminal: &'a Recorded,
        history: u32,
    ) -> Answer<'a, Result<TerminalScreen, TerminalError>>;

    /// The runtime's health, as `/v1/health` reports it.
    fn health(&self) -> Answer<'_, RuntimeHealthReport>;

    /// Whether the runtime can be read, with `recorded` the terminals the store knows: one of
    /// them still running with its socket gone is told to bind it again, and isn't reachable
    /// until it has.
    fn reachable<'a>(&'a self, recorded: &'a [Recorded]) -> Answer<'a, bool>;

    /// Every shell the runtime runs, each watched from now on. One that can't be read fails it:
    /// a reader that concludes from what is missing must not take it for one that isn't there.
    fn shells(&self) -> Answer<'_, Result<Vec<FoundShell>, TerminalError>>;

    /// Every agent's terminal the runtime runs, each watched from now on. One that can't be read
    /// is named, not taken for one that isn't there, and fails no other.
    fn agents(&self) -> Answer<'_, Result<AgentsFound, TerminalError>>;

    /// Nothing answers for the terminal, and what ran it provably runs no more.
    fn gone<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, bool>;

    /// The terminal's title, with the generation of the process that set it.
    fn title<'a>(
        &'a self,
        terminal: &'a Recorded,
    ) -> Answer<'a, Result<(u64, String), TerminalError>>;

    /// Nothing answers for a terminal whose start recorded nothing to prove it gone by, and
    /// nothing will: `since` is a moment after which nothing could start it, long enough ago
    /// that what started before then would answer by now.
    fn unstarted<'a>(
        &'a self,
        terminal: &'a TerminalId,
        since: std::time::Instant,
    ) -> Answer<'a, bool>;

    /// Makes a shell standalone where it runs: its terminal no longer names an agent.
    fn unlink<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, Result<(), TerminalError>>;

    /// Sends `signal` to the terminal's running process, through what runs it: the daemon sends
    /// no signal itself. A process that has exited refuses it as [`TerminalError::ProcessState`].
    fn signal<'a>(
        &'a self,
        terminal: &'a Recorded,
        signal: bazhen_protocol::agents::Signal,
    ) -> Answer<'a, Result<(), TerminalError>>;

    /// Starts the terminal's process again as `restart` says, in the same terminal, once the
    /// last one has exited, answering where the runtime keeps it now. A process still running
    /// refuses it as [`TerminalError::ProcessState`].
    fn respawn<'a>(
        &'a self,
        terminal: &'a Recorded,
        restart: Restart,
    ) -> Answer<'a, Result<Record<String>, TerminalError>>;

    /// What each terminal's runtime speaks, as this build serves it.
    fn compatibility(&self) -> Answer<'_, Result<Compatibility, TerminalError>>;

    /// Whether the host shows `pid` as the holder that started at `start`, from reading alone.
    fn vouches(&self, pid: u64, start: u64) -> bool;

    /// The holders that answer, for `bazhen doctor`, or why they can't be listed.
    fn holders(&self) -> Answer<'_, Result<Vec<RunningHolder>, String>>;

    /// Whether new terminals start contained, for `bazhen doctor`.
    fn containment(&self) -> Containment;

    /// The events told from now on. Ask before the first create, or an exit told as its watch
    /// opens is missed.
    fn events(&self) -> Box<dyn Events>;

    /// Ends the runtime's watches and connections, and waits for them; terminals run on.
    fn shutdown(&self) -> Answer<'_, ()>;
}

#[cfg(test)]
pub(crate) mod fake {
    //! A runtime in memory: terminals that run until closed, whose foreground, exits and new
    //! processes a test sets, and whose creates, closes and reads it can make fail.

    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::{Arc, Mutex};

    use bazhen_protocol::daemon::RuntimeReportState;
    use tokio::sync::{Semaphore, mpsc};

    use super::*;

    /// What a read fails with in a test whose runtime can't be read.
    pub(crate) fn unreadable() -> TerminalError {
        TerminalError::Other("the fake can't be read".to_owned())
    }

    /// The holder every fake terminal names, as its locator records it. It, and each child's pid
    /// after it, is past every pid a process can have: Linux's are below 2^22, macOS's below
    /// 100,000. A request a test sends over a real socket is read by its real process and
    /// ancestry, so a fake pid a process of the run had would take the test's own request for one
    /// under Bazhen's runtime, or from an agent's terminal.
    pub(crate) const HOLDER_PID: u64 = 1 << 22;
    pub(crate) const HOLDER_START: u64 = 1_700_000_000;
    /// The pid of a fake terminal's child at generation 0, as a peer's pid reads.
    pub(crate) const FIRST_CHILD_PID: i32 = (1 << 22) + 1000;

    /// One terminal the fake runs.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct Running {
        pub(crate) spec: NewTerminal,
        /// What holds its foreground; `None` for its own process.
        pub(crate) foreground: Option<String>,
        /// The directory its foreground is in, where one is seen.
        pub(crate) cwd: Option<String>,
        pub(crate) exited: bool,
        /// Its holder died, taking its process with it.
        pub(crate) gone: bool,
        /// The generation of the process it runs.
        pub(crate) generation: u64,
        /// The title its process set: none until it sets one.
        pub(crate) title: String,
    }

    /// A create's refusal, as the fake refuses one it is set to.
    pub(crate) fn refused() -> TerminalError {
        TerminalError::Other("the fake refused".to_owned())
    }

    #[derive(Debug, Default)]
    pub(crate) struct State {
        pub(crate) running: BTreeMap<String, Running>,
        /// The terminals closed, in order, each with what the store said of it as its close came.
        pub(crate) closed: Vec<String>,
        /// What each create fails with, creating nothing, where one does.
        pub(crate) creates_refused: Option<TerminalError>,
        /// Each create and respawn does what it was asked, then answers that what came of it is
        /// unknown, as a holder whose answer was lost.
        pub(crate) answers_unknown: bool,
        /// What each respawn fails with, where one does.
        pub(crate) respawns_refused: Option<TerminalError>,
        /// The terminals started again, in order, each with what it was started again as.
        pub(crate) respawned: Vec<(String, Restart)>,
        pub(crate) fail_closes: bool,
        /// What each close fails with, where it fails as no unreachable runtime does.
        pub(crate) closes_refused: Option<TerminalError>,
        pub(crate) fail_holders: bool,
        /// What the next title reads fail with, one read each, before any answers.
        pub(crate) titles_refused: std::collections::VecDeque<TerminalError>,
        /// What each read of what the runtime holds fails with, where it can't be read: no
        /// inventory, foreground or compatibility.
        pub(crate) reads_refused: Option<TerminalError>,
        /// Whether the runtime answers a read of its health at all.
        pub(crate) reach: Reach,
        /// How many reads of whether the runtime is reachable it was asked for.
        pub(crate) reach_reads: usize,
        /// Terminals the fake doesn't list, and can't prove gone.
        pub(crate) unproven: BTreeSet<String>,
        /// Terminals whose holders are there but can't be read: listed as unreadable.
        pub(crate) unreadable: BTreeSet<String>,
        /// How long after a moment nothing could start a terminal its holder may still answer,
        /// as twice the holder's hello deadline is: none unless a test sets one.
        pub(crate) hello_margin: std::time::Duration,
        /// The shells unlinked from their agent, in order.
        pub(crate) unlinked: Vec<String>,
        /// The signals sent, in order, each with the terminal it was sent to.
        pub(crate) signalled: Vec<(String, bazhen_protocol::agents::Signal)>,
        /// How many reads of the foregrounds reached the runtime.
        pub(crate) foreground_reads: usize,
        /// How many reads of the foregrounds the runtime answered.
        pub(crate) foreground_answers: usize,
        /// What the runtime says of each terminal's compatibility.
        pub(crate) compatibility: Compatibility,
        /// The holders the host no longer shows, by pid.
        pub(crate) holders_ended: BTreeSet<u64>,
        /// Each create waits for a permit here before it starts anything.
        pub(crate) hold_creates: Option<Arc<Semaphore>>,
        /// Each read of the foregrounds waits for a permit here once it has reached the runtime.
        pub(crate) hold_reads: Option<Arc<Semaphore>>,
        /// Each create's process exits as it starts, told while the create has yet to answer.
        pub(crate) exit_as_created: bool,
        /// Each paste asked for, in order: the terminal, the text and whether it was marked.
        pub(crate) pasted: Vec<(String, String, bool)>,
        /// The terminals whose title was read, in order.
        pub(crate) titles_read: Vec<String>,
        /// What each paste fails with, where it types nothing, as one into a shell whose input
        /// was typed ahead.
        pub(crate) pastes_refused: Option<TerminalError>,
        /// The screen each terminal shows, as its reads answer it; an empty one where unset.
        pub(crate) shown: BTreeMap<String, String>,
        /// Each screen read asked for, in order: the terminal and the rows of history.
        pub(crate) screens_read: Vec<(String, u32)>,
        /// What each screen read fails with, where its terminal runs but the read can't be made.
        pub(crate) screens_refused: Option<TerminalError>,
        /// Each read of the runtime's shells is held here as it reaches the runtime.
        pub(crate) hold_inventory: Option<Held>,
        /// Each read of what the terminals speak is held here as it reaches the runtime.
        pub(crate) hold_compatibility: Option<Held>,
        /// Each close is held here once its terminal is gone, before it answers.
        pub(crate) hold_closes: Option<Held>,
        told: Vec<mpsc::UnboundedSender<Event>>,
    }

    /// A read a test holds: each tells `reached` as it comes, then waits for a permit of `go`.
    #[derive(Debug, Clone)]
    pub(crate) struct Held {
        pub(crate) reached: Arc<Semaphore>,
        pub(crate) go: Arc<Semaphore>,
    }

    impl Held {
        /// Every read waits until the test lets it go.
        pub(crate) fn shut() -> Self {
            Self {
                reached: Arc::new(Semaphore::new(0)),
                go: Arc::new(Semaphore::new(0)),
            }
        }

        /// Every read goes on at once, having told the test it came.
        pub(crate) fn open() -> Self {
            Self {
                reached: Arc::new(Semaphore::new(0)),
                go: Arc::new(Semaphore::new(Semaphore::MAX_PERMITS)),
            }
        }

        /// Waits for the next read to reach it.
        pub(crate) async fn reached(&self) {
            self.reached.acquire().await.unwrap().forget();
        }

        async fn pass(held: Option<Self>) {
            if let Some(held) = held {
                held.reached.add_permits(1);
                held.go.acquire().await.unwrap().forget();
            }
        }
    }

    /// Whether the fake runtime answers a read of its health, whatever else it answers.
    #[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Reach {
        #[default]
        Answers,
        Unreachable,
    }

    impl State {
        fn tell(&mut self, event: &Event) {
            self.told.retain(|to| to.send(event.clone()).is_ok());
        }
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

    /// The locator the fake writes for `terminal_id`'s process of `generation`: its own socket,
    /// its one holder, and a child of that generation.
    pub(crate) fn locator_at(terminal_id: &str, generation: u64) -> Record<String> {
        Record::new(vec![
            ("socket".to_owned(), format!("/fake/{terminal_id}.sock")),
            ("holderPid".to_owned(), HOLDER_PID.to_string()),
            ("holderStart".to_owned(), HOLDER_START.to_string()),
            (
                "childPid".to_owned(),
                (u64::from(FIRST_CHILD_PID.unsigned_abs()) + generation).to_string(),
            ),
            ("generation".to_owned(), generation.to_string()),
        ])
    }

    /// The incarnation of `terminal_id` at `generation`, as the store records it.
    pub(crate) fn recorded_at(terminal_id: &str, generation: u64) -> Recorded {
        Recorded {
            terminal_id: TerminalId::parse(terminal_id).unwrap(),
            locator: serde_json::to_string(&locator_at(terminal_id, generation)).unwrap(),
        }
    }

    impl Fake {
        pub(crate) fn spec_of(&self, terminal_id: &str) -> NewTerminal {
            self.state.lock().unwrap().running[terminal_id].spec.clone()
        }

        pub(crate) fn carries(&self, terminal_id: &str) -> bool {
            self.state.lock().unwrap().running.contains_key(terminal_id)
        }

        fn change(&self, terminal_id: &str, change: impl FnOnce(&mut Running)) {
            change(
                self.state
                    .lock()
                    .unwrap()
                    .running
                    .get_mut(terminal_id)
                    .unwrap(),
            );
        }

        pub(crate) fn run_in_foreground(&self, terminal_id: &str, program: &str) {
            self.change(terminal_id, |running| {
                running.foreground = Some(program.to_owned());
            });
        }

        /// Its shell is back at its prompt, in `cwd` where one is given.
        pub(crate) fn at_prompt(&self, terminal_id: &str, cwd: Option<&str>) {
            self.change(terminal_id, |running| {
                running.foreground = None;
                running.cwd = cwd.map(str::to_owned);
            });
        }

        /// Its process ends, and the exit is told to every listener.
        pub(crate) fn exit(&self, terminal_id: &str) {
            let mut state = self.state.lock().unwrap();
            let running = state.running.get_mut(terminal_id).unwrap();
            running.exited = true;
            let generation = running.generation;
            state.tell(&Event::Exited(Exit {
                terminal_id: TerminalId::parse(terminal_id).unwrap(),
                generation,
                status: bazhen_holder_proto::body::ExitStatus::Exited {
                    code: bazhen_holder_proto::body::ExitCode::new(0).unwrap(),
                },
                found: Some(recorded_at(terminal_id, generation)),
            }));
        }

        /// What ran it ends, told to no one, as a holder that died: its process is gone with it.
        pub(crate) fn gone(&self, terminal_id: &str) {
            self.change(terminal_id, |running| running.gone = true);
        }

        /// Its process sets its title to `title`, which is told to every listener.
        pub(crate) fn title(&self, terminal_id: &str, title: &str) {
            let mut state = self.state.lock().unwrap();
            state.running.get_mut(terminal_id).unwrap().title = title.to_owned();
            state.tell(&Event::Title(TerminalId::parse(terminal_id).unwrap()));
        }

        /// Its process sets its title to `title`, told to no one, as one set while events were
        /// missed.
        pub(crate) fn title_unseen(&self, terminal_id: &str, title: &str) {
            self.change(terminal_id, |running| running.title = title.to_owned());
        }

        /// What ran it ends, and its loss is told to every listener.
        pub(crate) fn lose(&self, terminal_id: &str) {
            let mut state = self.state.lock().unwrap();
            let running = state.running.get_mut(terminal_id).unwrap();
            running.gone = true;
            let generation = running.generation;
            state.tell(&Event::Lost(recorded_at(terminal_id, generation)));
        }

        /// A holder runs agent `agent_id` at `terminal_id`, at `generation`, told to no one, as
        /// one a create the daemon never saw answer started.
        pub(crate) fn start_unseen(
            &self,
            terminal_id: &str,
            agent_id: &bazhen_protocol::ids::AgentId,
            generation: u64,
        ) {
            let spec = NewTerminal {
                terminal_id: TerminalId::parse(terminal_id).unwrap(),
                kind: Kind::Agent {
                    agent_id: agent_id.clone(),
                    harness_session: None,
                },
                argv: Vec::new(),
                cwd: "/".to_owned(),
                env: BTreeMap::new(),
                theme: None,
                generation,
            };
            self.state.lock().unwrap().running.insert(
                terminal_id.to_owned(),
                Running {
                    spec,
                    foreground: None,
                    cwd: None,
                    exited: false,
                    gone: false,
                    generation,
                    title: String::new(),
                },
            );
        }

        /// Its holder is tagged with the harness session `session` its process was started on.
        pub(crate) fn tag_session(&self, terminal_id: &str, session: &str) {
            self.change(terminal_id, |running| {
                if let Kind::Agent {
                    harness_session, ..
                } = &mut running.spec.kind
                {
                    *harness_session = Some(session.to_owned());
                }
            });
        }

        /// Its process ends, told to no one, as one that ended before anything watched it.
        pub(crate) fn exit_unseen(&self, terminal_id: &str) {
            self.change(terminal_id, |running| running.exited = true);
        }

        /// A process started outside the daemon runs in it, at the next generation, told to no
        /// one, as one started while the daemon was down.
        pub(crate) fn respawn_unseen(&self, terminal_id: &str) -> u64 {
            let mut generation = 0;
            self.change(terminal_id, |running| {
                running.exited = false;
                running.generation += 1;
                running.title.clear();
                generation = running.generation;
            });
            generation
        }

        /// The same, told to every listener.
        pub(crate) fn respawn(&self, terminal_id: &str) {
            let generation = self.respawn_unseen(terminal_id);
            self.state
                .lock()
                .unwrap()
                .tell(&Event::Respawned(recorded_at(terminal_id, generation)));
        }

        pub(crate) fn set(&self, change: impl FnOnce(&mut State)) {
            change(&mut self.state.lock().unwrap());
        }
    }

    #[derive(Debug)]
    struct Told(mpsc::UnboundedReceiver<Event>);

    impl Events for Told {
        fn next(&mut self) -> Answer<'_, Option<Event>> {
            Box::pin(self.0.recv())
        }
    }

    impl Terminals for Fake {
        fn create(&self, spec: NewTerminal) -> Answer<'_, Result<Record<String>, TerminalError>> {
            Box::pin(async move {
                let held = self.state.lock().unwrap().hold_creates.clone();
                if let Some(gate) = held {
                    gate.acquire().await.unwrap().forget();
                }
                let id = spec.terminal_id.as_str().to_owned();
                let generation = spec.generation;
                let exits_as_created = {
                    let mut state = self.state.lock().unwrap();
                    if let Some(refused) = &state.creates_refused {
                        return Err(refused.clone());
                    }
                    state.running.insert(
                        id.clone(),
                        Running {
                            spec,
                            foreground: None,
                            cwd: None,
                            exited: false,
                            gone: false,
                            generation,
                            title: String::new(),
                        },
                    );
                    if state.answers_unknown {
                        return Err(TerminalError::Unknown("the fake didn't answer".to_owned()));
                    }
                    state.exit_as_created
                };
                if exits_as_created {
                    self.exit(&id);
                    tokio::time::sleep(ANSWERS_AFTER_EXIT).await;
                }
                Ok(locator_at(&id, 0))
            })
        }

        fn close<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, Result<(), TerminalError>> {
            Box::pin(async move {
                let id = terminal.terminal_id.as_str();
                if let Some(OnClose(seen)) = self.on_close.lock().unwrap().as_ref() {
                    seen(id);
                }
                let held = {
                    let mut state = self.state.lock().unwrap();
                    if state.fail_closes {
                        return Err(TerminalError::Other("the fake is unreachable".to_owned()));
                    }
                    if let Some(refused) = &state.closes_refused {
                        return Err(refused.clone());
                    }
                    state.running.remove(id);
                    state.closed.push(id.to_owned());
                    state.hold_closes.clone()
                };
                Held::pass(held).await;
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
                    Some(running) if running.gone => {
                        Err(TerminalError::Gone("its holder is gone".to_owned()))
                    }
                    Some(running) if running.exited => Err(TerminalError::ProcessState(
                        "its process isn't running".to_owned(),
                    )),
                    Some(running) => Ok(running.foreground.clone()),
                    None => Err(TerminalError::Stale("no such terminal".to_owned())),
                }
            })
        }

        fn foregrounds<'a>(
            &'a self,
            terminals: &'a [Recorded],
        ) -> Answer<'a, Result<Vec<ShellForeground>, TerminalError>> {
            Box::pin(async move {
                let held = {
                    let mut state = self.state.lock().unwrap();
                    state.foreground_reads += 1;
                    state.hold_reads.clone()
                };
                if let Some(gate) = held {
                    gate.acquire().await.unwrap().forget();
                }
                let mut state = self.state.lock().unwrap();
                state.foreground_answers += 1;
                if let Some(refused) = &state.reads_refused {
                    return Err(refused.clone());
                }
                let asked: BTreeSet<&str> =
                    terminals.iter().map(|t| t.terminal_id.as_str()).collect();
                Ok(state
                    .running
                    .iter()
                    .filter(|(id, running)| {
                        asked.contains(id.as_str()) && !running.exited && !running.gone
                    })
                    .map(|(id, running)| ShellForeground {
                        terminal: recorded_at(id, running.generation),
                        command: running.foreground.clone(),
                        cwd: running.cwd.clone(),
                    })
                    .collect())
            })
        }

        fn paste<'a>(
            &'a self,
            terminal: &'a Recorded,
            text: &'a str,
            brackets: bool,
        ) -> Answer<'a, Result<(), TerminalError>> {
            Box::pin(async move {
                let mut state = self.state.lock().unwrap();
                let id = terminal.terminal_id.as_str().to_owned();
                state.pasted.push((id, text.to_owned(), brackets));
                state.pastes_refused.clone().map_or(Ok(()), Err)
            })
        }

        /// Read after its process has exited too, as a holder's screen is.
        fn screen<'a>(
            &'a self,
            terminal: &'a Recorded,
            history: u32,
        ) -> Answer<'a, Result<TerminalScreen, TerminalError>> {
            Box::pin(async move {
                let mut state = self.state.lock().unwrap();
                let id = terminal.terminal_id.as_str().to_owned();
                state.screens_read.push((id.clone(), history));
                match state.running.get(&id) {
                    Some(running) if running.gone => {
                        return Err(TerminalError::Gone("its holder is gone".to_owned()));
                    }
                    Some(_) => {}
                    None => return Err(TerminalError::Stale("no such terminal".to_owned())),
                }
                if let Some(refused) = &state.screens_refused {
                    return Err(refused.clone());
                }
                Ok(TerminalScreen {
                    text: state.shown.get(&id).cloned().unwrap_or_default(),
                    history: u64::from(history),
                })
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

        fn reachable<'a>(&'a self, _recorded: &'a [Recorded]) -> Answer<'a, bool> {
            Box::pin(async {
                let mut state = self.state.lock().unwrap();
                state.reach_reads += 1;
                state.reach == Reach::Answers
            })
        }

        fn shells(&self) -> Answer<'_, Result<Vec<FoundShell>, TerminalError>> {
            Box::pin(async {
                let held = self.state.lock().unwrap().hold_inventory.clone();
                Held::pass(held).await;
                let state = self.state.lock().unwrap();
                if let Some(refused) = &state.reads_refused {
                    return Err(refused.clone());
                }
                Ok(state
                    .running
                    .iter()
                    .filter(|(_, running)| !running.gone)
                    .filter_map(|(id, running)| match &running.spec.kind {
                        Kind::Shell { linked_agent_id } => Some(FoundShell {
                            terminal: recorded_at(id, running.generation),
                            dead: running.exited,
                            linked_agent_id: linked_agent_id.clone(),
                        }),
                        Kind::Agent { .. } => None,
                    })
                    .collect())
            })
        }

        fn agents(&self) -> Answer<'_, Result<AgentsFound, TerminalError>> {
            Box::pin(async {
                let held = self.state.lock().unwrap().hold_inventory.clone();
                Held::pass(held).await;
                let state = self.state.lock().unwrap();
                if let Some(refused) = &state.reads_refused {
                    return Err(refused.clone());
                }
                let mut read = AgentsFound::default();
                for (id, running) in state.running.iter().filter(|(_, running)| !running.gone) {
                    let Kind::Agent {
                        agent_id,
                        harness_session,
                    } = &running.spec.kind
                    else {
                        continue;
                    };
                    if state.unreadable.contains(id) {
                        read.unreadable.push(TerminalId::parse(id).unwrap());
                        continue;
                    }
                    read.found.push(FoundAgent {
                        terminal: recorded_at(id, running.generation),
                        exit: running.exited.then(|| {
                            bazhen_holder_proto::body::ExitStatus::Exited {
                                code: bazhen_holder_proto::body::ExitCode::new(0).unwrap(),
                            }
                        }),
                        agent_id: agent_id.clone(),
                        harness_session: harness_session.clone(),
                    });
                }
                Ok(read)
            })
        }

        fn title<'a>(
            &'a self,
            terminal: &'a Recorded,
        ) -> Answer<'a, Result<(u64, String), TerminalError>> {
            Box::pin(async move {
                let mut state = self.state.lock().unwrap();
                let id = terminal.terminal_id.as_str();
                state.titles_read.push(id.to_owned());
                if let Some(refused) = state.titles_refused.pop_front() {
                    return Err(refused);
                }
                match state.running.get(id) {
                    Some(running) if running.gone => {
                        Err(TerminalError::Gone("its holder is gone".to_owned()))
                    }
                    Some(running) => Ok((running.generation, running.title.clone())),
                    None => Err(TerminalError::Stale("no such terminal".to_owned())),
                }
            })
        }

        fn gone<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, bool> {
            Box::pin(async move {
                let state = self.state.lock().unwrap();
                let id = terminal.terminal_id.as_str();
                !state.unproven.contains(id) && state.running.get(id).is_none_or(|r| r.gone)
            })
        }

        fn unstarted<'a>(
            &'a self,
            terminal: &'a TerminalId,
            since: std::time::Instant,
        ) -> Answer<'a, bool> {
            Box::pin(async move {
                let state = self.state.lock().unwrap();
                let id = terminal.as_str();
                since.elapsed() >= state.hello_margin
                    && !state.unproven.contains(id)
                    && state.running.get(id).is_none_or(|r| r.gone)
            })
        }

        fn unlink<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, Result<(), TerminalError>> {
            Box::pin(async move {
                let mut state = self.state.lock().unwrap();
                let id = terminal.terminal_id.as_str().to_owned();
                if let Some(running) = state.running.get_mut(&id) {
                    running.spec.kind = Kind::Shell {
                        linked_agent_id: None,
                    };
                }
                state.unlinked.push(id);
                Ok(())
            })
        }

        fn signal<'a>(
            &'a self,
            terminal: &'a Recorded,
            signal: bazhen_protocol::agents::Signal,
        ) -> Answer<'a, Result<(), TerminalError>> {
            Box::pin(async move {
                let mut state = self.state.lock().unwrap();
                let id = terminal.terminal_id.as_str().to_owned();
                match state.running.get(&id) {
                    Some(running) if !running.exited && !running.gone => {}
                    _ => {
                        return Err(TerminalError::ProcessState(format!(
                            "terminal {id}'s process has exited"
                        )));
                    }
                }
                state.signalled.push((id, signal));
                Ok(())
            })
        }

        fn respawn<'a>(
            &'a self,
            terminal: &'a Recorded,
            restart: Restart,
        ) -> Answer<'a, Result<Record<String>, TerminalError>> {
            Box::pin(async move {
                let mut state = self.state.lock().unwrap();
                let id = terminal.terminal_id.as_str().to_owned();
                if let Some(refused) = &state.respawns_refused {
                    return Err(refused.clone());
                }
                let generation = restart.generation;
                match state.running.get_mut(&id) {
                    None => return Err(TerminalError::Stale("no such terminal".to_owned())),
                    Some(running) if running.gone => {
                        return Err(TerminalError::Gone("its holder is gone".to_owned()));
                    }
                    Some(running) if !running.exited => {
                        return Err(TerminalError::ProcessState(format!(
                            "terminal {id}'s process is still running"
                        )));
                    }
                    Some(running) => {
                        running.exited = false;
                        running.generation = generation;
                        running.title.clear();
                    }
                }
                state.respawned.push((id.clone(), restart));
                if state.answers_unknown {
                    return Err(TerminalError::Unknown("the fake didn't answer".to_owned()));
                }
                state.tell(&Event::Respawned(recorded_at(&id, generation)));
                Ok(locator_at(&id, generation))
            })
        }

        fn compatibility(&self) -> Answer<'_, Result<Compatibility, TerminalError>> {
            Box::pin(async {
                let held = self.state.lock().unwrap().hold_compatibility.clone();
                Held::pass(held).await;
                let state = self.state.lock().unwrap();
                if let Some(refused) = &state.reads_refused {
                    return Err(refused.clone());
                }
                Ok(state.compatibility.clone())
            })
        }

        fn vouches(&self, pid: u64, start: u64) -> bool {
            (pid, start) == (HOLDER_PID, HOLDER_START)
                && !self.state.lock().unwrap().holders_ended.contains(&pid)
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

        fn events(&self) -> Box<dyn Events> {
            let (tx, rx) = mpsc::unbounded_channel();
            self.state.lock().unwrap().told.push(tx);
            Box::new(Told(rx))
        }

        fn shutdown(&self) -> Answer<'_, ()> {
            Box::pin(async {
                self.state.lock().unwrap().told.clear();
            })
        }
    }
}
