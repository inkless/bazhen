//! The daemon's holder runtime, as `HolderRuntime` in `packages/runtime-holder/src/runtime.ts`:
//! each terminal in a `bazhen-holder` of its own, found again by its socket whatever happened to
//! the daemon in between. Each verb asks on a connection of its own, made for it and hung up
//! after, each request bounded; what a holder says unasked reaches `events` through the watch
//! (`watch.rs`), on a connection of its own.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bazhen_holder_proto::body::{
    Argv, Env, ErrorCode, ExitStatus, Generation, HelloReply, HistoryLines, NonEmpty, PasteRequest,
    Pid, ProcessSpec, Signal, Size, SpawnSpec, Stats, Theme, Versions,
};
use bazhen_holder_proto::{PROTOCOL_VERSION, negotiate};
use bazhen_host_guard::holder::{
    HolderProcess, START_SKEW_S, StartError, StartHolderOptions, holder_build_of,
    holder_socket_refusal,
};
use bazhen_host_guard::scope::{
    CapsRefused, Containment, ScopeLaunch, TerminalCaps, terminal_scope,
};
use bazhen_protocol::ids::TerminalId;
use tokio::sync::{OnceCell, broadcast};
use tokio::task::JoinSet;

use crate::client::{
    Answer, ClientOptions, ConnectError, HolderClient, HolderEvent, HolderEvents, HolderRefusal,
    RequestError, connect,
};
use crate::host::{Host, System};
use crate::locator::{HolderLocator, HolderRef, os_pid};
use crate::sockets::HolderRoot;
use crate::tags::{TerminalTags, decode_tags, encode_tags, unlinked};
use crate::watch::{Running, RuntimeEvent, Watches};

/// How long a holder has to answer `hello`, past which it counts as one that can't be read.
pub const HELLO: Duration = Duration::from_secs(2);
/// How long a holder has to answer a request once past `hello`.
pub const REQUEST: Duration = Duration::from_secs(10);
const DEFAULT_COLORTERM: &str = "truecolor";

#[derive(Debug, Clone)]
pub struct RuntimeOptions {
    pub root: HolderRoot,
    /// The `bazhen-holder` every new terminal's holder runs. `None` when none is installed: the
    /// holders already running are still found and served, and only a new terminal is refused.
    pub binary: Option<PathBuf>,
    /// Why there is no binary, which a refused new terminal says.
    pub unavailable: Option<String>,
    /// Where holder builds are installed, each in a directory named by its build.
    pub install_dir: Option<PathBuf>,
    /// The environment every new terminal starts from, already filtered.
    pub env: BTreeMap<String, String>,
    /// The caps of each terminal's scope. `None` starts every holder where the daemon runs, and
    /// probes nothing.
    pub caps: Option<TerminalCaps>,
    pub hello: Duration,
    pub request: Duration,
}

impl RuntimeOptions {
    /// Holders under `root`, none startable, none contained.
    pub fn new(root: HolderRoot) -> Self {
        Self {
            root,
            binary: None,
            unavailable: None,
            install_dir: None,
            env: BTreeMap::new(),
            caps: None,
            hello: HELLO,
            request: REQUEST,
        }
    }
}

/// What a terminal runs, as a create or a respawn gives it.
#[derive(Clone, PartialEq, Eq)]
pub struct ProcessLaunch {
    pub argv: Vec<String>,
    pub cwd: String,
    /// The terminal's own variables, over the runtime's.
    pub env: BTreeMap<String, String>,
    pub generation: Generation,
    pub theme: Option<Theme>,
}

/// Its variables by name alone: a value may be a secret, as a shell's report token is.
impl std::fmt::Debug for ProcessLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessLaunch")
            .field("argv", &self.argv)
            .field("cwd", &self.cwd)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("generation", &self.generation)
            .field("theme", &self.theme)
            .finish()
    }
}

/// A new terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSpec {
    pub terminal_id: TerminalId,
    pub tags: TerminalTags,
    pub size: Size,
    pub history_lines: HistoryLines,
    pub process: ProcessLaunch,
}

/// A terminal a holder answers for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InventoryEntry {
    pub terminal: HolderRef,
    pub tags: TerminalTags,
    pub exit: Option<ExitStatus>,
}

/// What holds a terminal's foreground: its leader's command, whether that is the terminal's own
/// process, and its directory where the OS shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundProcess {
    pub command: String,
    pub own: bool,
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthState {
    Healthy,
    NotRunning,
    Unreachable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeHealth {
    pub state: HealthState,
    pub version: String,
}

/// Which terminals this build serves in full, and which run on a holder sharing no major with it,
/// with the versions that holder speaks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Compatibility {
    pub outdated: HashMap<TerminalId, Vec<String>>,
    pub served: HashSet<TerminalId>,
}

/// A holder that answered, the build it runs and the protocol versions it speaks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolderBuild {
    pub terminal_id: TerminalId,
    /// `None` for a holder not run from an install, or that the kernel no longer shows.
    pub build: Option<String>,
    pub protocol: Versions,
    /// Whether it runs in a terminal's scope; `None` where that can't be read.
    pub contained: Option<bool>,
    pub socket: PathBuf,
    /// `None` for a holder that shares no protocol with this build, which names no pid.
    pub holder_pid: Option<Pid>,
    /// Its memory, as it reports it; `None` where it didn't.
    pub stats: Option<Stats>,
}

/// Why a ref names no process a verb can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaleReason {
    /// No holder answers, and the one recorded no longer runs.
    Gone,
    /// Another holder answers at the terminal's socket.
    ServerReplaced,
    /// The holder runs another process of the terminal than the ref's.
    ProcessReplaced,
    /// The ref records no generation.
    Unnumbered,
}

/// What a verb needs the terminal's process to be, and it isn't.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Needs {
    Running,
    Exited,
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("terminal {terminal_id}: {reason:?}")]
    Stale {
        terminal_id: TerminalId,
        reason: StaleReason,
    },
    /// No holder answers, and the recorded one isn't provably gone.
    #[error("terminal {terminal_id}: its holder can't be confirmed")]
    Unconfirmed {
        terminal_id: TerminalId,
        #[source]
        source: ConnectError,
    },
    /// The socket can't be read while the recorded holder still runs.
    #[error("terminal {terminal_id}: its holder runs but can't be reached")]
    Unreachable {
        terminal_id: TerminalId,
        #[source]
        source: ConnectError,
    },
    /// Its holder shares no protocol with this build.
    #[error("terminal {terminal_id}: its holder (pid {holder_pid}) speaks {protocol:?} only")]
    Unservable {
        terminal_id: TerminalId,
        protocol: Option<Versions>,
        holder_pid: u64,
    },
    #[error("terminal {terminal_id}: its process isn't {needs:?}")]
    ProcessState {
        terminal_id: TerminalId,
        needs: Needs,
    },
    #[error("terminal {terminal_id}: its holder refused {}: {}", .refusal.request, .refusal.reason)]
    Refused {
        terminal_id: TerminalId,
        refusal: Box<HolderRefusal>,
    },
    #[error("terminal {terminal_id}: its holder didn't answer")]
    Unanswered {
        terminal_id: TerminalId,
        #[source]
        source: Option<Box<RequestError>>,
    },
    #[error("terminal {terminal_id}: no holder can be started: {why}")]
    NoBinary {
        terminal_id: TerminalId,
        why: String,
    },
    #[error("terminal {terminal_id}: its holder didn't start")]
    Start {
        terminal_id: TerminalId,
        #[source]
        source: StartError,
    },
    #[error("terminal {terminal_id}: its holder started but doesn't answer")]
    Unstarted {
        terminal_id: TerminalId,
        why: String,
    },
    #[error("terminal {terminal_id}: {why}")]
    Spec {
        terminal_id: TerminalId,
        why: String,
    },
    #[error(
        "terminal {terminal_id}: no holder can be started, as the caps of its scope are refused"
    )]
    Containment {
        terminal_id: TerminalId,
        #[source]
        source: CapsRefused,
    },
    /// The runtime is shutting down: no holder is started from now on.
    #[error("terminal {terminal_id}: no holder is started while the runtime shuts down")]
    ShuttingDown { terminal_id: TerminalId },
    #[error("the holders' directory can't be listed")]
    Unlistable(#[source] io::Error),
    #[error("the holders at {sockets:?} can't be read")]
    Unreadable { sockets: Vec<PathBuf> },
    #[error("terminal {terminal_id}: its foreground can't be read")]
    Foreground { terminal_id: TerminalId },
    /// A paste that typed nothing: the text may not be pasted, or the program wasn't reading it
    /// as text, as `PasteRefused` says. The reason never quotes the text.
    #[error("{reason}")]
    PasteRefused {
        terminal_id: TerminalId,
        reason: String,
    },
}

/// What saying `hello` at a socket found.
#[derive(Debug)]
enum Reached {
    Holder(Box<Answered>),
    Not(Unreached),
}

/// A holder that answered, on the connection kept open for a caller that watches it.
#[derive(Debug)]
struct Answered {
    client: HolderClient,
    events: HolderEvents,
    stats: Option<Stats>,
}

/// Why no holder this build speaks to answered at a socket.
#[derive(Debug)]
pub(crate) enum Unreached {
    /// No holder listens there: no file, or one a holder that died left behind.
    None { stale: bool, source: ConnectError },
    /// Something may listen there, but couldn't be read: refused access, or no answer in time.
    Unreadable { source: ConnectError },
    /// A holder answers there that shares no protocol with this build: it runs, and can't be
    /// spoken to, so it is never called gone.
    Outdated { protocol: Option<Versions> },
}

impl From<ConnectError> for Unreached {
    fn from(source: ConnectError) -> Self {
        match &source {
            ConnectError::Hello { source: why, .. } => match why.as_ref() {
                RequestError::Refused(refusal) if refusal.code == ErrorCode::NoSharedVersion => {
                    Self::Outdated {
                        protocol: refusal.protocol.clone(),
                    }
                }
                _ => Self::Unreadable { source },
            },
            ConnectError::Connect { source: io, .. } => match io.kind() {
                io::ErrorKind::NotFound => Self::None {
                    stale: false,
                    source,
                },
                io::ErrorKind::ConnectionRefused => Self::None {
                    stale: true,
                    source,
                },
                _ => Self::Unreadable { source },
            },
            ConnectError::Timeout { .. } => Self::Unreadable { source },
        }
    }
}

/// Says `hello` at `socket`, and asks for `stats` too `with_stats`, bounded by `bound`.
async fn reach(
    socket: PathBuf,
    options: ClientOptions,
    with_stats: bool,
    bound: Duration,
) -> (PathBuf, Reached) {
    let reached = match connect(&socket, &options).await {
        Ok((client, events)) => {
            // A holder that won't say still answered: it is listed, without its memory.
            let stats = if with_stats {
                tokio::time::timeout(bound, client.stats())
                    .await
                    .ok()
                    .and_then(Result::ok)
            } else {
                None
            };
            Reached::Holder(Box::new(Answered {
                client,
                events,
                stats,
            }))
        }
        Err(e) => Reached::Not(e.into()),
    };
    (socket, reached)
}

/// The terminal whose holder binds `socket`, by its name.
fn terminal_at(socket: &Path) -> Option<TerminalId> {
    let name = socket.file_name()?.to_str()?.strip_suffix(".sock")?;
    TerminalId::parse(name)
}

/// What a request's refusal means to the terminal's process.
fn refusal(terminal_id: &TerminalId, error: RequestError) -> RuntimeError {
    let terminal_id = terminal_id.clone();
    match error {
        RequestError::Refused(refusal) => match refusal.raw_code.as_str() {
            "exited" => RuntimeError::ProcessState {
                terminal_id,
                needs: Needs::Running,
            },
            "running" => RuntimeError::ProcessState {
                terminal_id,
                needs: Needs::Exited,
            },
            _ if refusal.code == ErrorCode::StaleGeneration => RuntimeError::Stale {
                terminal_id,
                reason: StaleReason::ProcessReplaced,
            },
            _ => RuntimeError::Refused {
                terminal_id,
                refusal: Box::new(refusal),
            },
        },
        other => RuntimeError::Unanswered {
            terminal_id,
            source: Some(Box::new(other)),
        },
    }
}

/// The holder protocol version that added `paste`, the gated paste.
const PASTE_VERSION: &str = "1.3";

/// Whether a holder that agreed `agreed` has `paste` (`holderHasPaste` in packages/protocol).
fn has_paste(agreed: &str) -> bool {
    negotiate(&[agreed], &[PASTE_VERSION])
        .map(|v| v.to_string())
        .as_deref()
        == Some(PASTE_VERSION)
}

/// Why `text` may not be pasted, or `None` when it may, as `pasteTextRefusal` in
/// packages/host-guard words it: a control character is a key, not text, and text that may arrive
/// as keys, unmarked, must be printable ASCII as well. A byte of 0x80 or more is a meta key to a
/// line editor reading 8-bit input.
fn paste_text_refusal(text: &str, brackets: bool) -> Option<&'static str> {
    if text
        .chars()
        .any(|c| c < ' ' || ('\u{7f}'..='\u{9f}').contains(&c))
    {
        return Some("refusing to paste a control character");
    }
    if !brackets && !text.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return Some("refusing to paste text beyond printable ASCII that may arrive as keys");
    }
    None
}

/// Text no two scopes of this process share, from the kernel's randomness where it gives some.
fn unit_random() -> String {
    use std::io::Read as _;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut bytes = [0_u8; 8];
    let read = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes));
    if read.is_ok() {
        return format!("{:016x}", u64::from_ne_bytes(bytes));
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// Says what the containment probe found, once, as `containmentLog` does.
fn log_containment(found: &Result<Containment, CapsRefused>) {
    match found {
        Ok(Containment::Scoped(scoped)) if scoped.oom_policy => {
            tracing::info!(caps = ?scoped.caps, "each terminal starts in a scope of its own");
        }
        Ok(Containment::Scoped(scoped)) => tracing::warn!(
            systemd = scoped.systemd,
            "each terminal starts in a scope of its own, but systemd before 253 takes no \
             OOMPolicy=continue: a terminal past its cap loses its holder too"
        ),
        Ok(Containment::Uncontained { why }) => tracing::warn!(
            why = %why,
            "terminals start uncontained: one can take all of the machine's memory"
        ),
        Err(refused) => tracing::error!(error = %refused, "no terminal can be started"),
    }
}

/// Whether `hello` came from the holder this runtime started as `holder`.
fn is_started(hello: &HelloReply, holder: HolderProcess) -> bool {
    os_pid(hello.holder_pid) == Some(holder.pid)
        && hello.holder_start.get().abs_diff(holder.start) <= START_SKEW_S
}

/// What a create needs from its start on, in a task of the runtime's own.
struct Starting {
    host: Arc<dyn Host>,
    watches: Arc<Watches>,
    hello: Duration,
    request: Duration,
}

impl Starting {
    /// Options for a connection to a holder just started, which shutdown doesn't end: once a
    /// holder runs, it is answered and watched, or told to close, either bounded by its deadline.
    fn client_options(&self) -> ClientOptions {
        ClientOptions {
            writer: false,
            connect: self.hello,
            ..ClientOptions::default()
        }
    }

    async fn start(
        self,
        terminal_id: TerminalId,
        socket: PathBuf,
        options: StartHolderOptions,
    ) -> Result<HolderRef, RuntimeError> {
        // Asked here, in the tracker's task: a shutdown that cancelled after this had not yet
        // closed the tracker as the task was spawned, so it waits for whatever this starts.
        if self.watches.token.is_cancelled() {
            return Err(RuntimeError::ShuttingDown { terminal_id });
        }
        let started = self
            .host
            .start(options)
            .await
            .map_err(|source| RuntimeError::Start {
                terminal_id: terminal_id.clone(),
                source,
            })?;
        if let Some(handle) = started.handle {
            self.watches.reap(handle);
        }
        let (_, reached) = reach(socket.clone(), self.client_options(), false, self.request).await;
        let why = match reached {
            Reached::Holder(answered) if is_started(answered.client.hello(), started.holder) => {
                let Answered { client, events, .. } = *answered;
                let terminal = HolderRef {
                    terminal_id,
                    locator: HolderLocator::of(socket, client.hello()),
                };
                self.watches.adopt(terminal.clone(), client, events);
                return Ok(terminal);
            }
            Reached::Holder(answered) => {
                // Another holder answers: not ours to close.
                let pid = answered.client.hello().holder_pid.get();
                return Err(RuntimeError::Unstarted {
                    terminal_id,
                    why: format!("pid {pid} answers at its socket"),
                });
            }
            Reached::Not(Unreached::Outdated { protocol }) => format!("it speaks {protocol:?}"),
            Reached::Not(Unreached::None { source, .. } | Unreached::Unreadable { source }) => {
                source.to_string()
            }
        };
        self.close_unanswered(socket, started.holder);
        Err(RuntimeError::Unstarted { terminal_id, why })
    }

    /// Best effort, in a task of its own: the holder started as `holder`, should it answer
    /// later, is told to close, rather than left with no record. Spawned from the create's own
    /// task, so the tracker holds one or the other throughout, and shutdown waits for it.
    fn close_unanswered(&self, socket: PathBuf, holder: HolderProcess) {
        let options = self.client_options();
        let bound = self.request;
        self.watches.tasks.spawn(async move {
            if let Ok((client, events)) = connect(&socket, &options).await {
                drop(events);
                // Another holder answers there now: not ours to close.
                if is_started(client.hello(), holder) {
                    // It won't close: there is nothing more to do from here.
                    let _ = tokio::time::timeout(bound, client.close()).await;
                }
                client.end();
            }
        });
    }
}

/// Runs each terminal in a `bazhen-holder` of its own. Share it in an `Arc`; `shutdown` ends its
/// watches and connections.
#[derive(Debug)]
pub struct HolderRuntime {
    options: RuntimeOptions,
    env: Mutex<BTreeMap<String, String>>,
    host: Arc<dyn Host>,
    /// Whether this machine can contain terminals, probed at the first start that needs it.
    containment: OnceCell<Result<Containment, CapsRefused>>,
    /// The sockets reported unreadable, each reported again only once it has been readable.
    unreadable: Mutex<HashSet<PathBuf>>,
    watches: Arc<Watches>,
}

impl HolderRuntime {
    pub fn new(options: RuntimeOptions) -> Self {
        Self::with_host(options, Arc::new(System))
    }

    pub(crate) fn with_host(mut options: RuntimeOptions, host: Arc<dyn Host>) -> Self {
        let env = std::mem::take(&mut options.env);
        let runs = Arc::clone(&host);
        let watches = Arc::new(Watches::new(
            options.hello,
            Running::new(move |holder| runs.runs(holder)),
        ));
        Self {
            options,
            env: Mutex::new(env),
            host,
            containment: OnceCell::new(),
            unreadable: Mutex::new(HashSet::new()),
            watches,
        }
    }

    /// The environment every terminal started from now on starts from.
    pub fn replace_env(&self, env: BTreeMap<String, String>) {
        *self.env.lock().unwrap_or_else(PoisonError::into_inner) = env;
    }

    /// What the watch tells from now on: every terminal found or created is watched, until it
    /// is closed or its holder lost. Subscribe before the first `inventory`, `create` or `watch`:
    /// what a watch tells as it opens, an exit its holder saw before and the title, is told once,
    /// and a receiver made after has missed it.
    pub fn events(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.watches.subscribe()
    }

    /// What the first start that needed it found of this machine's containment, as `doctor`
    /// reports it; `None` before one has, or with no caps, when nothing is probed.
    pub fn containment(&self) -> Option<&Result<Containment, CapsRefused>> {
        self.containment.get()
    }

    /// Ends every watch and connection, and waits for them; holders run on.
    pub async fn shutdown(&self) {
        self.watches.shutdown().await;
    }

    fn client_options(&self) -> ClientOptions {
        self.watches.client_options(&self.watches.token)
    }

    fn socket_of(&self, terminal_id: &TerminalId) -> Result<PathBuf, RuntimeError> {
        let spec = |why: String| RuntimeError::Spec {
            terminal_id: terminal_id.clone(),
            why,
        };
        let id = bazhen_holder_proto::body::TerminalId::new(terminal_id.as_str())
            .map_err(|e| spec(e.to_string()))?;
        let socket = self.options.root.socket(&id);
        match holder_socket_refusal(&socket, self.options.root.path(), terminal_id.as_str()) {
            Some(why) => Err(spec(why)),
            None => Ok(socket),
        }
    }

    async fn bounded<T>(
        &self,
        terminal_id: &TerminalId,
        answer: Answer<T>,
    ) -> Result<T, RuntimeError> {
        match tokio::time::timeout(self.options.request, answer).await {
            Ok(answered) => answered.map_err(|e| refusal(terminal_id, e)),
            Err(_) => Err(RuntimeError::Unanswered {
                terminal_id: terminal_id.clone(),
                source: None,
            }),
        }
    }

    /// Whether the holder `terminal` recorded is still the process at its pid.
    fn recorded_runs(&self, terminal: &HolderRef) -> bool {
        terminal
            .holder()
            .is_some_and(|holder| self.host.runs(holder))
    }

    /// A connection to the holder `terminal` was made on, past `hello`; its events are dropped,
    /// as no verb waits on one but `respawn`, which keeps them.
    async fn holder_of(
        &self,
        terminal: &HolderRef,
    ) -> Result<(HolderClient, HolderEvents), RuntimeError> {
        let terminal_id = &terminal.terminal_id;
        let socket = self.socket_of(terminal_id)?;
        let (client, events) = match connect(&socket, &self.client_options()).await {
            Ok(connected) => connected,
            Err(e) => {
                return Err(match Unreached::from(e) {
                    Unreached::None { .. } if self.gone(terminal).await => RuntimeError::Stale {
                        terminal_id: terminal_id.clone(),
                        reason: StaleReason::Gone,
                    },
                    Unreached::Outdated { protocol } => RuntimeError::Unservable {
                        terminal_id: terminal_id.clone(),
                        protocol,
                        holder_pid: terminal.locator.holder_pid.get(),
                    },
                    Unreached::Unreadable { source } if self.recorded_runs(terminal) => {
                        RuntimeError::Unreachable {
                            terminal_id: terminal_id.clone(),
                            source,
                        }
                    }
                    Unreached::None { source, .. } | Unreached::Unreadable { source } => {
                        RuntimeError::Unconfirmed {
                            terminal_id: terminal_id.clone(),
                            source,
                        }
                    }
                });
            }
        };
        let hello = client.hello();
        if hello.terminal_id.as_str() != terminal_id.as_str()
            || !terminal.locator.is_holder_of(hello)
        {
            return Err(RuntimeError::Stale {
                terminal_id: terminal_id.clone(),
                reason: StaleReason::ServerReplaced,
            });
        }
        Ok((client, events))
    }

    /// `holder_of`, then the process `terminal` recorded: the same generation and child.
    async fn process_of(
        &self,
        terminal: &HolderRef,
    ) -> Result<(HolderClient, HolderEvents), RuntimeError> {
        let (client, events) = self.holder_of(terminal).await?;
        let hello = client.hello();
        let stale = |reason| RuntimeError::Stale {
            terminal_id: terminal.terminal_id.clone(),
            reason,
        };
        let locator = &terminal.locator;
        match locator.generation {
            None => Err(stale(StaleReason::Unnumbered)),
            Some(generation)
                if generation != hello.generation
                    || locator.child_pid != hello.child_pid
                    || locator.child_start != hello.child_start =>
            {
                Err(stale(StaleReason::ProcessReplaced))
            }
            Some(_) => Ok((client, events)),
        }
    }

    /// `process_of`, refusing a process that isn't as `needs` says.
    async fn process_that(
        &self,
        terminal: &HolderRef,
        needs: Needs,
    ) -> Result<(HolderClient, HolderEvents), RuntimeError> {
        let (client, events) = self.process_of(terminal).await?;
        let exited = client.hello().exit.is_some();
        if exited == (needs == Needs::Running) {
            return Err(RuntimeError::ProcessState {
                terminal_id: terminal.terminal_id.clone(),
                needs,
            });
        }
        Ok((client, events))
    }

    /// What the holder runs: the runtime's environment, then the terminal's own variables.
    fn process_spec(
        &self,
        terminal_id: &TerminalId,
        launch: &ProcessLaunch,
    ) -> Result<ProcessSpec, RuntimeError> {
        let spec = |why: String| RuntimeError::Spec {
            terminal_id: terminal_id.clone(),
            why,
        };
        let mut env = self
            .env
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        env.extend(launch.env.clone());
        env.insert("TERM".to_owned(), "xterm-256color".to_owned());
        let colorterm = launch
            .env
            .get("COLORTERM")
            .map_or(DEFAULT_COLORTERM, String::as_str);
        env.insert("COLORTERM".to_owned(), colorterm.to_owned());
        Ok(ProcessSpec {
            argv: Argv::new(launch.argv.clone()).map_err(|e| spec(e.to_string()))?,
            cwd: NonEmpty::new(launch.cwd.clone()).map_err(|e| spec(e.to_string()))?,
            env: Env::new(env).map_err(|e| spec(e.to_string()))?,
            generation: launch.generation,
            theme: launch.theme,
        })
    }

    /// The scope a new terminal's holder starts in: none without caps, or where terminals can't
    /// be contained.
    async fn scope(&self, terminal_id: &TerminalId) -> Result<Option<ScopeLaunch>, RuntimeError> {
        let Some(caps) = &self.options.caps else {
            return Ok(None);
        };
        let found = self
            .containment
            .get_or_init(|| async {
                let found = self.host.probe(caps.clone()).await;
                log_containment(&found);
                found
            })
            .await;
        match found {
            Ok(Containment::Scoped(scoped)) => Ok(Some(terminal_scope(
                scoped,
                terminal_id.as_str(),
                &unit_random(),
            ))),
            Ok(Containment::Uncontained { .. }) => Ok(None),
            Err(refused) => Err(RuntimeError::Containment {
                terminal_id: terminal_id.clone(),
                source: refused.clone(),
            }),
        }
    }

    /// Starts a holder for a new terminal, contained where terminals can be, and watches it.
    /// From the start on, it runs in a task of the runtime's own, so a caller that stops waiting,
    /// as a request whose client hung up does, leaves no holder started and never answered or
    /// told to close; shutdown waits for it.
    ///
    /// # Errors
    ///
    /// Once the runtime is shutting down, with no binary, a spec no holder takes, a start that
    /// fails, or a holder that started but doesn't answer, which is told to close should it
    /// answer later.
    pub async fn create(&self, spec: TerminalSpec) -> Result<HolderRef, RuntimeError> {
        let terminal_id = spec.terminal_id.clone();
        let Some(binary) = self.options.binary.clone() else {
            let why = self
                .options
                .unavailable
                .clone()
                .unwrap_or_else(|| "no bazhen-holder is installed".to_owned());
            return Err(RuntimeError::NoBinary { terminal_id, why });
        };
        let socket = self.socket_of(&terminal_id)?;
        let process = self.process_spec(&terminal_id, &spec.process)?;
        let invalid = |why: String| RuntimeError::Spec {
            terminal_id: terminal_id.clone(),
            why,
        };
        let holder_spec = SpawnSpec {
            argv: process.argv,
            cwd: process.cwd,
            env: process.env,
            generation: process.generation,
            theme: process.theme,
            protocol: Versions::spoken(),
            terminal_id: bazhen_holder_proto::body::TerminalId::new(terminal_id.as_str())
                .map_err(|e| invalid(e.to_string()))?,
            socket: NonEmpty::new(socket.to_string_lossy().into_owned())
                .map_err(|e| invalid(e.to_string()))?,
            tags: encode_tags(&spec.tags).map_err(|e| invalid(e.to_string()))?,
            size: spec.size,
            history_lines: spec.history_lines,
        };
        let mut options =
            StartHolderOptions::new(binary, self.options.root.path().to_path_buf(), holder_spec);
        options.scope = self.scope(&terminal_id).await?;
        let starting = Starting {
            host: Arc::clone(&self.host),
            watches: Arc::clone(&self.watches),
            hello: self.options.hello,
            request: self.options.request,
        };
        let id = terminal_id.clone();
        self.watches
            .tasks
            .spawn(starting.start(id, socket, options))
            .await
            .unwrap_or_else(|ended| {
                Err(RuntimeError::Unstarted {
                    terminal_id,
                    why: format!("its start ended early: {ended}"),
                })
            })
    }

    /// `hello` to every socket in the holders' directory, and `stats` too `with_stats`, at once.
    async fn reach_all(&self, with_stats: bool) -> Result<Vec<(PathBuf, Reached)>, RuntimeError> {
        let dir = self.options.root.holders_dir();
        let names = match std::fs::read_dir(&dir) {
            Ok(names) => names,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(RuntimeError::Unlistable(e)),
        };
        let mut reaching = JoinSet::new();
        for name in names {
            let path = name.map_err(RuntimeError::Unlistable)?.path();
            if path.extension() == Some(OsStr::new("sock")) {
                reaching.spawn(reach(
                    path,
                    self.client_options(),
                    with_stats,
                    self.options.request,
                ));
            }
        }
        let mut all = Vec::new();
        while let Some(done) = reaching.join_next().await {
            // A reach that panicked read nothing, as one that couldn't be read.
            if let Ok(reached) = done {
                all.push(reached);
            }
        }
        all.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(all)
    }

    /// Reports `socket` unreadable, once until it reads again.
    fn report_unreadable(&self, socket: &Path, why: &dyn std::fmt::Display) {
        let mut unreadable = self
            .unreadable
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if unreadable.insert(socket.to_path_buf()) {
            tracing::warn!(socket = %socket.display(), why = %why, "a holder can't be read");
        }
    }

    /// The entries `inventory` reads, and the sockets that couldn't be read. Each holder found is
    /// watched. A holder is listed by what it says, as the TypeScript runtime lists it, whether
    /// or not the kernel vouches for its pid: one in another pid namespace names a pid this one
    /// can't read, and refusing it would refuse every inventory for as long as it runs.
    async fn listed(&self) -> Result<(Vec<InventoryEntry>, Vec<PathBuf>), RuntimeError> {
        let all = self.reach_all(false).await?;
        {
            let listed: HashSet<&PathBuf> = all.iter().map(|(socket, _)| socket).collect();
            self.unreadable
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|socket| listed.contains(socket));
        }
        let mut entries = Vec::new();
        let mut unreadable = Vec::new();
        for (socket, reached) in all {
            let (client, events) = match reached {
                Reached::Holder(answered) => (answered.client, answered.events),
                Reached::Not(Unreached::Unreadable { source }) => {
                    self.report_unreadable(&socket, &source);
                    unreadable.push(socket);
                    continue;
                }
                Reached::Not(Unreached::None { .. } | Unreached::Outdated { .. }) => {
                    self.unreadable
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(&socket);
                    continue;
                }
            };
            let hello = client.hello();
            self.unreadable
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&socket);
            if let Some(entry) = self.entry(&socket, hello) {
                self.watches.adopt(entry.terminal.clone(), client, events);
                entries.push(entry);
            }
        }
        Ok((entries, unreadable))
    }

    /// A holder answers at its own terminal's socket only, with tags this runtime wrote;
    /// anything else isn't one of ours.
    fn entry(&self, socket: &Path, hello: &HelloReply) -> Option<InventoryEntry> {
        let tags = decode_tags(&hello.tags)?;
        let terminal_id = TerminalId::parse(hello.terminal_id.as_str())?;
        if terminal_at(socket).as_ref() != Some(&terminal_id)
            || self.socket_of(&terminal_id).ok()? != socket
        {
            return None;
        }
        Some(InventoryEntry {
            terminal: HolderRef {
                terminal_id,
                locator: HolderLocator::of(socket.to_path_buf(), hello),
            },
            tags,
            exit: hello.exit.clone(),
        })
    }

    /// Every terminal a holder answers for, each watched from now on.
    ///
    /// # Errors
    ///
    /// When the holders can't be listed, or any can't be read: a reader that concludes from what
    /// is missing must not take a holder it couldn't read for one that isn't there. The others
    /// are watched all the same.
    pub async fn inventory(&self) -> Result<Vec<InventoryEntry>, RuntimeError> {
        let (entries, unreadable) = self.listed().await?;
        if unreadable.is_empty() {
            Ok(entries)
        } else {
            Err(RuntimeError::Unreadable {
                sockets: unreadable,
            })
        }
    }

    /// Watches `terminal` from now on, unless its holder is watched already.
    ///
    /// # Errors
    ///
    /// As a verb's, when its holder isn't the one `terminal` records.
    pub async fn watch(&self, terminal: &HolderRef) -> Result<(), RuntimeError> {
        let (client, events) = self.holder_of(terminal).await?;
        // The socket the runtime would bind, not the caller's: its watch says hello again there.
        let socket = self.socket_of(&terminal.terminal_id)?;
        let found = HolderRef {
            terminal_id: terminal.terminal_id.clone(),
            locator: HolderLocator::of(socket, client.hello()),
        };
        self.watches.adopt(found, client, events);
        Ok(())
    }

    /// No holder answers at the terminal's socket, and the one `terminal` recorded is no longer
    /// the process at its pid. One that can't be read, or still runs, is no proof.
    pub async fn gone(&self, terminal: &HolderRef) -> bool {
        let Ok(socket) = self.socket_of(&terminal.terminal_id) else {
            return false;
        };
        let (_, reached) = reach(socket, self.client_options(), false, self.options.request).await;
        matches!(reached, Reached::Not(Unreached::None { .. })) && !self.recorded_runs(terminal)
    }

    /// Closes the terminal: its holder ends its process and exits. One no holder answers for
    /// counts as closed once it is provably gone, its stale socket removed.
    ///
    /// The terminal isn't watched while it closes, so one whose close fails is watched again only
    /// at the next inventory or `watch`: a caller that keeps the terminal calls `watch` itself.
    ///
    /// # Errors
    ///
    /// As a verb's, or when the holder doesn't answer or hang up in time.
    pub async fn close(&self, terminal: &HolderRef) -> Result<(), RuntimeError> {
        let terminal_id = &terminal.terminal_id;
        let (client, events) = match self.holder_of(terminal).await {
            Ok(connected) => connected,
            Err(RuntimeError::Stale {
                reason: StaleReason::Gone,
                ..
            }) => {
                self.watches.closing(terminal).closed();
                let socket = self.socket_of(terminal_id)?;
                let (_, reached) = reach(
                    socket.clone(),
                    self.client_options(),
                    false,
                    self.options.request,
                )
                .await;
                if matches!(reached, Reached::Not(Unreached::None { stale: true, .. })) {
                    match std::fs::remove_file(&socket) {
                        Err(e) if e.kind() != io::ErrorKind::NotFound => {
                            tracing::warn!(socket = %socket.display(), error = %e, "a stale holder socket stays");
                        }
                        _ => {}
                    }
                }
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        drop(events);
        // Closed on purpose: no exit or loss of it is told, by its watch or by one an inventory
        // in flight would start.
        let closing = self.watches.closing(terminal);
        let closed = self.bounded(terminal_id, client.close()).await;
        let ended = tokio::time::timeout(self.options.request, client.ended()).await;
        client.end();
        closed?;
        ended.map_err(|_| RuntimeError::Unanswered {
            terminal_id: terminal_id.clone(),
            source: None,
        })?;
        closing.closed();
        Ok(())
    }

    /// Sends `signal` to the terminal's running process, through its holder.
    ///
    /// # Errors
    ///
    /// As a verb's, or when its process has exited.
    pub async fn signal(&self, terminal: &HolderRef, signal: Signal) -> Result<(), RuntimeError> {
        let (client, events) = self.process_that(terminal, Needs::Running).await?;
        drop(events);
        let sent = self
            .bounded(&terminal.terminal_id, client.signal(signal))
            .await;
        client.end();
        sent
    }

    /// Pastes `text` through the holder's gate, which types it only if the program would read it
    /// as text now, checked in the turn that queues it; marked with the bracketed-paste sequences
    /// when `brackets` is true. A holder older than the gate refuses every paste.
    ///
    /// # Errors
    ///
    /// [`RuntimeError::PasteRefused`] for text that may not be pasted, a holder before the gate,
    /// or a program not reading text; otherwise as a verb's, or when its process has exited.
    pub async fn paste(
        &self,
        terminal: &HolderRef,
        text: &str,
        brackets: bool,
    ) -> Result<(), RuntimeError> {
        let refused = |reason: String| RuntimeError::PasteRefused {
            terminal_id: terminal.terminal_id.clone(),
            reason,
        };
        if let Some(reason) = paste_text_refusal(text, brackets) {
            return Err(refused(reason.to_owned()));
        }
        let (client, events) = self.process_that(terminal, Needs::Running).await?;
        drop(events);
        let hello = client.hello();
        let request = if has_paste(hello.version.as_str()) {
            PasteRequest::new(hello.generation, text, brackets).map_err(|e| refused(e.to_string()))
        } else {
            Err(refused(
                "this terminal's holder predates gated paste; restart the terminal to paste"
                    .to_owned(),
            ))
        };
        let pasted = match request {
            Err(err) => Err(err),
            Ok(request) => {
                match tokio::time::timeout(self.options.request, client.paste(request)).await {
                    Ok(Err(RequestError::Refused(said)))
                        if matches!(said.raw_code.as_str(), "not-ready" | "unavailable") =>
                    {
                        Err(refused(said.reason))
                    }
                    Ok(answered) => answered.map_err(|e| refusal(&terminal.terminal_id, e)),
                    Err(_) => Err(RuntimeError::Unanswered {
                        terminal_id: terminal.terminal_id.clone(),
                        source: None,
                    }),
                }
            }
        };
        client.end();
        pasted
    }

    /// Runs `launch` in the terminal whose process has exited; the ref of the new process.
    ///
    /// # Errors
    ///
    /// As a verb's, when its process still runs, or when the holder doesn't say what it started.
    pub async fn respawn(
        &self,
        terminal: &HolderRef,
        launch: &ProcessLaunch,
    ) -> Result<HolderRef, RuntimeError> {
        let terminal_id = &terminal.terminal_id;
        let spec = self.process_spec(terminal_id, launch)?;
        let (client, mut events) = self.process_that(terminal, Needs::Exited).await?;
        let answered = self.bounded(terminal_id, client.respawn(spec)).await;
        client.end();
        answered?;
        // The holder sends `respawned` before its `ok`, so it has come by now.
        while let Some(event) = events.try_recv() {
            if let HolderEvent::Respawned(respawned) = event {
                let mut next = terminal.clone();
                next.locator.child_pid = respawned.child_pid;
                next.locator.child_start = respawned.child_start;
                next.locator.generation = Some(respawned.generation);
                return Ok(next);
            }
        }
        Err(RuntimeError::Unanswered {
            terminal_id: terminal_id.clone(),
            source: None,
        })
    }

    /// Replaces the terminal's tags.
    ///
    /// # Errors
    ///
    /// As a verb's, or tags no holder keeps.
    pub async fn set_tags(
        &self,
        terminal: &HolderRef,
        tags: &TerminalTags,
    ) -> Result<(), RuntimeError> {
        let terminal_id = &terminal.terminal_id;
        let tags = encode_tags(tags).map_err(|e| RuntimeError::Spec {
            terminal_id: terminal_id.clone(),
            why: e.to_string(),
        })?;
        let (client, _) = self.holder_of(terminal).await?;
        let set = self.bounded(terminal_id, client.set_tags(tags)).await;
        client.end();
        set
    }

    /// Drops the agent a shell is linked to from its tags.
    ///
    /// # Errors
    ///
    /// As a verb's.
    pub async fn unlink(&self, terminal: &HolderRef) -> Result<(), RuntimeError> {
        let terminal_id = &terminal.terminal_id;
        let (client, _) = self.holder_of(terminal).await?;
        let tags = unlinked(&client.hello().tags).map_err(|e| RuntimeError::Spec {
            terminal_id: terminal_id.clone(),
            why: e.to_string(),
        })?;
        let set = self.bounded(terminal_id, client.set_tags(tags)).await;
        client.end();
        set
    }

    /// Tells the terminal's process the theme it is drawn in.
    ///
    /// # Errors
    ///
    /// As a verb's.
    pub async fn set_theme(
        &self,
        terminal: &HolderRef,
        theme: Option<Theme>,
    ) -> Result<(), RuntimeError> {
        let (client, _) = self.process_of(terminal).await?;
        let set = self
            .bounded(&terminal.terminal_id, client.set_theme(theme))
            .await;
        client.end();
        set
    }

    /// The title in the holder's `hello`: its current process's, whichever generation that is.
    ///
    /// # Errors
    ///
    /// As a verb's.
    pub async fn title(&self, terminal: &HolderRef) -> Result<String, RuntimeError> {
        let (client, _) = self.holder_of(terminal).await?;
        let title = client.hello().title.clone();
        client.end();
        Ok(title)
    }

    /// The group holding the terminal's foreground as its holder names it, and its leader's
    /// start, so that a reused pid is refused.
    async fn foreground_group(
        &self,
        terminal: &HolderRef,
    ) -> Result<bazhen_holder_proto::body::Foreground, RuntimeError> {
        let (client, _) = self.process_that(terminal, Needs::Running).await?;
        let read = self
            .bounded(&terminal.terminal_id, client.foreground())
            .await;
        client.end();
        read
    }

    /// The leader of `group` as the kernel shows it, if it is still the one that started when
    /// the holder said.
    fn leader_of(
        &self,
        group: &bazhen_holder_proto::body::Foreground,
    ) -> Option<ForegroundProcess> {
        let leader = self.host.leader(os_pid(group.pgid)?)?;
        if leader.start.abs_diff(group.pgid_start.get()) > START_SKEW_S {
            return None;
        }
        let command = Path::new(&leader.comm)
            .file_name()?
            .to_string_lossy()
            .into_owned();
        Some(ForegroundProcess {
            command,
            own: group.pgid == group.child_pid,
            cwd: leader.cwd,
        })
    }

    /// What holds the terminal's foreground, from its PTY.
    ///
    /// # Errors
    ///
    /// As a verb's, when its process has exited, or when its leader can't be read.
    pub async fn foreground(
        &self,
        terminal: &HolderRef,
    ) -> Result<ForegroundProcess, RuntimeError> {
        let group = self.foreground_group(terminal).await?;
        self.leader_of(&group)
            .ok_or_else(|| RuntimeError::Foreground {
                terminal_id: terminal.terminal_id.clone(),
            })
    }

    /// The foregrounds of the running terminals among `terminal_ids`, leaving out each whose
    /// foreground can't be read.
    ///
    /// # Errors
    ///
    /// When the holders can't be listed.
    pub async fn foregrounds(
        &self,
        terminal_ids: &HashSet<TerminalId>,
    ) -> Result<Vec<(HolderRef, ForegroundProcess)>, RuntimeError> {
        if terminal_ids.is_empty() {
            return Ok(Vec::new());
        }
        let (entries, _) = self.listed().await?;
        let mut read = Vec::new();
        for entry in entries {
            if entry.exit.is_some() || !terminal_ids.contains(&entry.terminal.terminal_id) {
                continue;
            }
            let Ok(group) = self.foreground_group(&entry.terminal).await else {
                continue;
            };
            if let Some(foreground) = self.leader_of(&group) {
                read.push((entry.terminal, foreground));
            }
        }
        Ok(read)
    }

    /// `Unreachable` while a holder can't be read, or while one `recorded` names still runs with
    /// its socket gone, which is then told to bind it again. `NotRunning` only when no holder
    /// answers and none recorded still runs.
    pub async fn health(&self, recorded: &[HolderRef]) -> RuntimeHealth {
        let health = |state| RuntimeHealth {
            state,
            version: format!("holder/{PROTOCOL_VERSION}"),
        };
        let Ok(reached) = self.reach_all(false).await else {
            return health(HealthState::Unreachable);
        };
        let mut answering = HashSet::new();
        for (socket, reached) in &reached {
            match reached {
                Reached::Not(Unreached::Unreadable { .. }) => {
                    return health(HealthState::Unreachable);
                }
                Reached::Holder(answered) => {
                    answering.insert(answered.client.hello().terminal_id.as_str().to_owned());
                }
                // One that can't be spoken to still runs, so it is never told to rebind.
                Reached::Not(Unreached::Outdated { .. }) => {
                    if let Some(at) = terminal_at(socket) {
                        answering.insert(at.as_str().to_owned());
                    }
                }
                Reached::Not(Unreached::None { .. }) => {}
            }
        }
        drop(reached);
        let mut socketless = false;
        for terminal in recorded {
            if answering.contains(terminal.terminal_id.as_str()) {
                continue;
            }
            if let Some(holder) = terminal.holder()
                && matches!(self.host.rebind(holder).await, Ok(true))
            {
                socketless = true;
            }
        }
        health(if socketless {
            HealthState::Unreachable
        } else if answering.is_empty() {
            HealthState::NotRunning
        } else {
            HealthState::Healthy
        })
    }

    /// What each holder speaks, by the terminal its socket is named for: one at another's socket
    /// is neither. Reads only.
    ///
    /// # Errors
    ///
    /// When the holders can't be listed.
    pub async fn compatibility(&self) -> Result<Compatibility, RuntimeError> {
        let mut read = Compatibility::default();
        for (socket, reached) in self.reach_all(false).await? {
            let Some(at) = terminal_at(&socket) else {
                continue;
            };
            match reached {
                Reached::Not(Unreached::Outdated { protocol }) => {
                    let protocol = protocol.map_or_else(Vec::new, |versions| {
                        versions
                            .as_slice()
                            .iter()
                            .map(|v| v.as_str().to_owned())
                            .collect()
                    });
                    read.outdated.insert(at, protocol);
                }
                // This build says hello in its own major alone, so one that answers is served in
                // full: none agrees on an older major, as a TypeScript daemon's holder may.
                Reached::Holder(answered) => {
                    if answered.client.hello().terminal_id.as_str() == at.as_str() {
                        read.served.insert(at);
                    }
                }
                Reached::Not(_) => {}
            }
        }
        Ok(read)
    }

    /// Each holder that answers, with the build its argv names if it started when it says, and
    /// whether it is contained. One sharing no protocol with this build is listed by its socket.
    /// Reads only.
    ///
    /// # Errors
    ///
    /// When the holders can't be listed.
    pub async fn builds(&self) -> Result<Vec<HolderBuild>, RuntimeError> {
        let mut builds = Vec::new();
        for (socket, reached) in self.reach_all(true).await? {
            match reached {
                Reached::Not(Unreached::Outdated { protocol }) => {
                    let (Some(terminal_id), Some(protocol)) = (terminal_at(&socket), protocol)
                    else {
                        continue;
                    };
                    builds.push(HolderBuild {
                        terminal_id,
                        build: None,
                        protocol,
                        contained: None,
                        socket,
                        holder_pid: None,
                        stats: None,
                    });
                }
                Reached::Holder(answered) => {
                    let hello = answered.client.hello();
                    let Some(terminal_id) = TerminalId::parse(hello.terminal_id.as_str()) else {
                        continue;
                    };
                    let pid = os_pid(hello.holder_pid);
                    let build = match (
                        &self.options.install_dir,
                        pid.and_then(|p| self.host.process(p)),
                    ) {
                        (Some(dir), Some((start, args)))
                            if start.abs_diff(hello.holder_start.get()) <= START_SKEW_S =>
                        {
                            holder_build_of(&args, dir).map(str::to_owned)
                        }
                        _ => None,
                    };
                    builds.push(HolderBuild {
                        terminal_id,
                        build,
                        protocol: hello.protocol.clone(),
                        // The pid is the one that just answered, so it can't have been reused.
                        contained: pid.and_then(|p| self.host.in_scope(p)),
                        socket,
                        holder_pid: Some(hello.holder_pid),
                        stats: answered.stats,
                    });
                }
                Reached::Not(Unreached::None { .. } | Unreached::Unreadable { .. }) => {}
            }
        }
        Ok(builds)
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::sync::atomic::AtomicUsize;

    use bazhen_holder_proto::body::{
        ErrorBody, Foreground, OkBody, ProtocolVersion, StartTime, Tags, VersionText,
    };
    use bazhen_holder_proto::{Reply, Request};
    use bazhen_host_guard::holder::HolderProcess;
    use bazhen_host_guard::scope::{Enforced, Scoped};
    use tokio::net::UnixListener;

    use super::*;
    use crate::fake_holder::{FakeHolder, fake_hello};
    use crate::host::{Boxed, Leader, Started};
    use crate::test_support::{TempDir, block_on, me};

    const PID: i32 = 4242;
    const START: u64 = 1_700_000_000;

    #[derive(Debug, Default)]
    struct FakeHost {
        started: Mutex<Vec<StartHolderOptions>>,
        probes: AtomicUsize,
        containment: Option<Result<Containment, CapsRefused>>,
        /// Whether the holder a pid names is taken for running.
        running: bool,
        rebinds: bool,
        rebound: Mutex<Vec<HolderProcess>>,
        leader: Option<Leader>,
    }

    impl Host for FakeHost {
        fn start(&self, options: StartHolderOptions) -> Boxed<Result<Started, StartError>> {
            self.started.lock().unwrap().push(options);
            let holder = HolderProcess {
                pid: rustix::process::Pid::from_raw(PID).unwrap(),
                start: START,
            };
            Box::pin(std::future::ready(Ok(Started {
                holder,
                handle: None,
            })))
        }

        fn probe(&self, _: TerminalCaps) -> Boxed<Result<Containment, CapsRefused>> {
            self.probes.fetch_add(1, Ordering::Relaxed);
            Box::pin(std::future::ready(self.containment.clone().unwrap()))
        }

        fn rebind(&self, holder: HolderProcess) -> Boxed<Result<bool, bazhen_host_guard::Error>> {
            self.rebound.lock().unwrap().push(holder);
            Box::pin(std::future::ready(Ok(self.rebinds)))
        }

        fn runs(&self, _: HolderProcess) -> bool {
            self.running
        }

        fn leader(&self, _: rustix::process::Pid) -> Option<Leader> {
            self.leader.clone()
        }

        fn in_scope(&self, _: rustix::process::Pid) -> Option<bool> {
            Some(true)
        }

        fn process(&self, _: rustix::process::Pid) -> Option<(u64, Vec<OsString>)> {
            Some((
                START,
                vec!["/opt/bz/holder/0123456789abcdef/bazhen-holder".into()],
            ))
        }
    }

    /// How a fake at a socket answers `hello`.
    #[derive(Debug, Clone)]
    enum Answering {
        Hello(Box<HelloReply>),
        /// With `no-shared-version`, speaking 2.0 only.
        Outdated,
        /// Never.
        Silent,
        /// Never on the first connection, as `Hello` on each after.
        Late(Box<HelloReply>),
    }

    /// Each connection at `listener`, its hello answered as `answering` says, and each request
    /// after as `answer` does. Every request after hello is put in `seen`.
    async fn serve(
        listener: UnixListener,
        answering: Answering,
        answer: fn(&Request) -> Vec<Reply>,
        seen: Arc<Mutex<Vec<Request>>>,
    ) {
        let mut connections = JoinSet::new();
        let mut first = true;
        while let Ok((stream, _)) = listener.accept().await {
            let answering = match (&answering, first) {
                (Answering::Late(_), true) => Answering::Silent,
                (Answering::Late(hello), false) => Answering::Hello(hello.clone()),
                (answering, _) => answering.clone(),
            };
            first = false;
            let seen = Arc::clone(&seen);
            connections.spawn(async move {
                let mut holder = FakeHolder::new(stream);
                match answering {
                    Answering::Hello(hello) => {
                        drop(holder.answer_hello_with(|h| *h = *hello).await);
                    }
                    Answering::Outdated => {
                        let id = holder.request().await.id();
                        let mut body = ErrorBody::new("hello", ErrorCode::NoSharedVersion, "no");
                        body.protocol =
                            Some(Versions::new(vec![VersionText::new("2.0").unwrap()]).unwrap());
                        holder.send(&[Reply::Error { id, body }]).await;
                    }
                    Answering::Silent | Answering::Late(_) => drop(holder.until_eof().await),
                }
                while let Some(request) = holder.next().await {
                    let replies = answer(&request);
                    seen.lock().unwrap().push(request);
                    holder.send(&replies).await;
                }
            });
        }
    }

    fn ok(request: &Request) -> Vec<Reply> {
        let body = OkBody {
            request: "ok".to_owned(),
        };
        vec![Reply::Ok {
            id: request.id(),
            body,
        }]
    }

    fn answers(request: &Request) -> Vec<Reply> {
        let id = request.id();
        match request {
            Request::Foreground { .. } => vec![Reply::Foreground {
                id,
                body: Foreground {
                    child_pid: Pid::new(4243).unwrap(),
                    child_start: StartTime::new(START).unwrap(),
                    pgid: Pid::new(4250).unwrap(),
                    pgid_start: StartTime::new(START + 5).unwrap(),
                },
            }],
            Request::Stats { .. } => vec![Reply::Stats {
                id,
                body: Stats {
                    engine_bytes: 2048.try_into().unwrap(),
                    rss: Some(8192.try_into().unwrap()),
                    ring_bytes: 1024.try_into().unwrap(),
                    history_lines: 7.try_into().unwrap(),
                    engine_resets: None,
                },
            }],
            Request::Paste { body, .. } if body.text() == "cat" => vec![Reply::Error {
                id,
                body: ErrorBody::new(
                    "paste",
                    ErrorCode::NotReady,
                    "the shell isn't reading at its prompt",
                ),
            }],
            _ => ok(request),
        }
    }

    /// A runtime under a root of its own, on `host`.
    struct Fixture {
        dir: TempDir,
        root: HolderRoot,
        runtime: HolderRuntime,
        servers: JoinSet<()>,
        seen: Arc<Mutex<Vec<Request>>>,
    }

    impl Fixture {
        fn new(host: FakeHost, edit: impl FnOnce(&mut RuntimeOptions)) -> (Self, Arc<FakeHost>) {
            let dir = TempDir::new();
            let root = HolderRoot::of(&dir.path().join("run"), me());
            root.make_private(me()).unwrap();
            let mut options = RuntimeOptions::new(root.clone());
            options.binary = Some(PathBuf::from(
                "/opt/bz/holder/0123456789abcdef/bazhen-holder",
            ));
            options.hello = Duration::from_millis(500);
            edit(&mut options);
            let host = Arc::new(host);
            let runtime = HolderRuntime::with_host(options, Arc::clone(&host) as Arc<dyn Host>);
            let fixture = Self {
                dir,
                root,
                runtime,
                servers: JoinSet::new(),
                seen: Arc::default(),
            };
            (fixture, host)
        }

        fn socket(&self, terminal_id: &TerminalId) -> PathBuf {
            self.root
                .socket(&bazhen_holder_proto::body::TerminalId::new(terminal_id.as_str()).unwrap())
        }

        /// A fake holder at `terminal_id`'s socket.
        fn serve(&mut self, terminal_id: &TerminalId, answering: Answering) {
            let listener = UnixListener::bind(self.socket(terminal_id)).unwrap();
            let seen = Arc::clone(&self.seen);
            self.servers
                .spawn(serve(listener, answering, answers, seen));
        }

        /// A socket at `terminal_id`'s whose holder has gone.
        fn stale(&self, terminal_id: &TerminalId) {
            drop(std::os::unix::net::UnixListener::bind(self.socket(terminal_id)).unwrap());
        }
    }

    fn id(n: u8) -> TerminalId {
        TerminalId::mint(1, [n; 16])
    }

    fn shell() -> TerminalTags {
        TerminalTags::Shell {
            linked_agent_id: None,
        }
    }

    /// The hello of `terminal_id`'s holder, with tags this runtime writes.
    fn hello_of(terminal_id: &TerminalId) -> HelloReply {
        let mut hello = fake_hello();
        hello.terminal_id =
            bazhen_holder_proto::body::TerminalId::new(terminal_id.as_str()).unwrap();
        hello.tags = encode_tags(&shell()).unwrap();
        hello
    }

    fn spec(terminal_id: &TerminalId) -> TerminalSpec {
        TerminalSpec {
            terminal_id: terminal_id.clone(),
            tags: shell(),
            size: fake_hello().size,
            history_lines: HistoryLines::new(1234).unwrap(),
            process: ProcessLaunch {
                argv: vec!["/bin/sh".to_owned()],
                cwd: "/".to_owned(),
                env: BTreeMap::from([("OWN".to_owned(), "1".to_owned())]),
                generation: Generation::new(0).unwrap(),
                theme: None,
            },
        }
    }

    fn reference(fixture: &Fixture, terminal_id: &TerminalId) -> HolderRef {
        HolderRef {
            terminal_id: terminal_id.clone(),
            locator: HolderLocator::of(fixture.socket(terminal_id), &hello_of(terminal_id)),
        }
    }

    fn scoped() -> Containment {
        let caps = TerminalCaps {
            terminal: "1G".to_owned(),
            total: "4G".to_owned(),
            swap: "0".to_owned(),
        };
        Containment::Scoped(Scoped {
            systemd: 255,
            oom_policy: true,
            caps,
            enforced: Enforced {
                terminal: None,
                total: None,
                swap: None,
            },
            systemd_run: PathBuf::from("/usr/bin/systemd-run"),
            runtime_dir: "/run/user/1000".into(),
        })
    }

    #[test]
    fn starts_a_holder_with_an_env_of_its_own_and_the_terminals_in_its_spec_and_watches_it() {
        let (mut fixture, host) = Fixture::new(FakeHost::default(), |o| {
            o.env = BTreeMap::from([
                ("RUNTIME".to_owned(), "1".to_owned()),
                ("COLORTERM".to_owned(), "no".to_owned()),
            ]);
        });
        let terminal_id = id(1);
        block_on(async {
            fixture.serve(
                &terminal_id,
                Answering::Hello(Box::new(hello_of(&terminal_id))),
            );
            let mut told = fixture.runtime.events();
            let made = fixture.runtime.create(spec(&terminal_id)).await.unwrap();
            assert_eq!(made, reference(&fixture, &terminal_id));
            assert_eq!(
                told.recv().await.unwrap(),
                RuntimeEvent::Title {
                    terminal_id: terminal_id.clone()
                }
            );
            let started = host.started.lock().unwrap().clone();
            let [options] = started.as_slice() else {
                panic!("started {started:?}")
            };
            assert_eq!((options.env.len(), &options.scope), (0, &None));
            assert_eq!(options.spec.history_lines.get(), 1234);
            let env: Vec<_> = options
                .spec
                .env
                .as_map()
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect();
            assert_eq!(
                env,
                [
                    "COLORTERM=truecolor",
                    "OWN=1",
                    "RUNTIME=1",
                    "TERM=xterm-256color"
                ]
            );
            fixture.runtime.shutdown().await;
        });
    }

    #[test]
    fn refuses_a_new_terminal_with_no_binary_saying_why_and_starts_nothing() {
        let (fixture, host) = Fixture::new(FakeHost::default(), |o| {
            o.binary = None;
            o.unavailable = Some("the install failed".to_owned());
        });
        let refused = block_on(fixture.runtime.create(spec(&id(1))));
        assert!(
            matches!(&refused, Err(RuntimeError::NoBinary { why, .. }) if why == "the install failed"),
            "{refused:?}"
        );
        assert!(host.started.lock().unwrap().is_empty());
    }

    #[test]
    fn starts_each_holder_in_a_scope_of_its_own_probing_once_and_only_when_starting() {
        let host = FakeHost {
            containment: Some(Ok(scoped())),
            ..FakeHost::default()
        };
        let (mut fixture, host) = Fixture::new(host, |o| {
            o.caps = Some(TerminalCaps {
                terminal: "1G".to_owned(),
                total: "4G".to_owned(),
                swap: "0".to_owned(),
            });
        });
        block_on(async {
            drop(fixture.runtime.inventory().await.unwrap());
            assert_eq!(host.probes.load(Ordering::Relaxed), 0);
            for n in [1, 2] {
                fixture.serve(&id(n), Answering::Hello(Box::new(hello_of(&id(n)))));
                fixture.runtime.create(spec(&id(n))).await.unwrap();
            }
            fixture.runtime.shutdown().await;
        });
        assert_eq!(host.probes.load(Ordering::Relaxed), 1);
        let units: Vec<_> = host
            .started
            .lock()
            .unwrap()
            .iter()
            .map(|o| {
                let scope = o.scope.clone().unwrap();
                assert_eq!(
                    scope.argv.first(),
                    Some(&OsString::from("/usr/bin/systemd-run"))
                );
                scope
                    .argv
                    .into_iter()
                    .find(|a| a.to_string_lossy().starts_with("--unit="))
                    .unwrap()
            })
            .collect();
        assert_ne!(units.first(), units.get(1));
    }

    #[test]
    fn starts_a_holder_uncontained_where_terminals_cant_be_and_none_once_the_caps_are_refused() {
        let caps = TerminalCaps {
            terminal: "lots".to_owned(),
            total: "4G".to_owned(),
            swap: "0".to_owned(),
        };
        let refused = CapsRefused {
            caps: caps.clone(),
            why: "not a size",
        };
        let found = [
            Ok(Containment::Uncontained {
                why: "no systemd".to_owned(),
            }),
            Err(refused),
        ];
        let started: Vec<_> = found
            .into_iter()
            .map(|found| {
                let host = FakeHost {
                    containment: Some(found),
                    ..FakeHost::default()
                };
                let (mut fixture, host) = Fixture::new(host, |o| o.caps = Some(caps.clone()));
                let created = block_on(async {
                    fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
                    let created = fixture.runtime.create(spec(&id(1))).await;
                    fixture.runtime.shutdown().await;
                    created
                });
                let scopes: Vec<_> = host
                    .started
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|o| o.scope.is_some())
                    .collect();
                (created.is_ok(), scopes)
            })
            .collect();
        assert_eq!(started, [(true, vec![false]), (false, vec![])]);
    }

    #[test]
    fn fails_a_create_whose_holder_doesnt_answer_and_closes_it_once_it_does_if_it_is_the_one_started()
     {
        let asked: Vec<_> = [PID, 4999]
            .into_iter()
            .map(|pid| {
                let (mut fixture, _) = Fixture::new(FakeHost::default(), |_| {});
                let terminal_id = id(1);
                let mut hello = hello_of(&terminal_id);
                hello.holder_pid = Pid::new(pid.try_into().unwrap()).unwrap();
                block_on(async {
                    fixture.serve(&terminal_id, Answering::Late(Box::new(hello)));
                    let created = fixture.runtime.create(spec(&terminal_id)).await;
                    assert!(
                        matches!(created, Err(RuntimeError::Unstarted { .. })),
                        "{created:?}"
                    );
                    // Shutdown waits for the close it was told.
                    fixture.runtime.shutdown().await;
                });
                let seen = fixture.seen.lock().unwrap();
                seen.iter()
                    .map(|r| matches!(r, Request::Close { .. }))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(asked, [vec![true], vec![]]);
    }

    #[test]
    fn refuses_to_start_a_holder_once_the_runtime_is_shutting_down() {
        // Shut down before the create, and as the create's start waits for its task to run.
        let refused: Vec<_> = [false, true]
            .into_iter()
            .map(|during| {
                let (fixture, host) = Fixture::new(FakeHost::default(), |_| {});
                let created = block_on(async {
                    if during {
                        let both = futures_util::future::join(
                            fixture.runtime.create(spec(&id(1))),
                            fixture.runtime.shutdown(),
                        );
                        both.await.0
                    } else {
                        fixture.runtime.shutdown().await;
                        fixture.runtime.create(spec(&id(1))).await
                    }
                });
                let started = host.started.lock().unwrap().len();
                (
                    matches!(created, Err(RuntimeError::ShuttingDown { terminal_id }) if terminal_id == id(1)),
                    started,
                )
            })
            .collect();
        assert_eq!(refused, [(true, 0), (true, 0)]);
    }

    #[test]
    fn says_what_containment_the_first_start_found_and_a_refusal_naming_the_terminal() {
        let caps = TerminalCaps {
            terminal: "1G".to_owned(),
            total: "4G".to_owned(),
            swap: "0".to_owned(),
        };
        let refused = CapsRefused {
            caps: caps.clone(),
            why: "not a size",
        };
        let found = [Ok(scoped()), Err(refused.clone())];
        let decided: Vec<_> = found
            .into_iter()
            .map(|found| {
                let host = FakeHost {
                    containment: Some(found),
                    ..FakeHost::default()
                };
                let (mut fixture, _) = Fixture::new(host, |o| o.caps = Some(caps.clone()));
                let before = fixture.runtime.containment().cloned();
                let created = block_on(async {
                    fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
                    let created = fixture.runtime.create(spec(&id(1))).await;
                    fixture.runtime.shutdown().await;
                    created
                });
                let named = match created {
                    Ok(_) => None,
                    Err(RuntimeError::Containment { terminal_id, .. }) => Some(terminal_id),
                    Err(other) => panic!("{other:?}"),
                };
                (before, fixture.runtime.containment().cloned(), named)
            })
            .collect();
        assert_eq!(
            decided,
            [
                (None, Some(Ok(scoped())), None),
                (None, Some(Err(refused)), Some(id(1)))
            ]
        );
    }

    #[test]
    fn finds_its_terminals_leaving_out_stale_sockets_foreign_holders_and_another_terminals_socket()
    {
        let (mut fixture, _) = Fixture::new(
            FakeHost {
                running: true,
                ..FakeHost::default()
            },
            |_| {},
        );
        block_on(async {
            fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
            let mut foreign = hello_of(&id(2));
            foreign.tags = Tags::default();
            fixture.serve(&id(2), Answering::Hello(Box::new(foreign)));
            fixture.serve(&id(3), Answering::Hello(Box::new(hello_of(&id(9)))));
            fixture.stale(&id(4));
            fixture.serve(&id(5), Answering::Outdated);
            let mut told = fixture.runtime.events();
            let found = fixture.runtime.inventory().await.unwrap();
            let ids: Vec<_> = found
                .iter()
                .map(|e| (e.terminal.terminal_id.clone(), e.tags.clone()))
                .collect();
            assert_eq!(ids, [(id(1), shell())]);
            assert_eq!(
                told.recv().await.unwrap(),
                RuntimeEvent::Title { terminal_id: id(1) }
            );
            fixture.runtime.shutdown().await;
        });
    }

    #[test]
    fn tells_the_terminals_it_serves_from_those_on_a_holder_it_cant_naming_what_that_speaks() {
        let (mut fixture, _) = Fixture::new(FakeHost::default(), |_| {});
        block_on(async {
            fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
            fixture.serve(&id(2), Answering::Outdated);
            fixture.serve(&id(3), Answering::Hello(Box::new(hello_of(&id(9)))));
            fixture.stale(&id(4));
            let read = fixture.runtime.compatibility().await.unwrap();
            assert_eq!(
                read,
                Compatibility {
                    outdated: HashMap::from([(id(2), vec!["2.0".to_owned()])]),
                    served: HashSet::from([id(1)]),
                }
            );
            fixture.runtime.shutdown().await;
        });
    }

    #[test]
    fn finds_nothing_before_the_first_terminal_and_fails_when_the_holders_cant_be_listed() {
        let (fixture, _) = Fixture::new(FakeHost::default(), |_| {});
        std::fs::remove_dir(fixture.root.holders_dir()).unwrap();
        let before = block_on(fixture.runtime.inventory());
        std::fs::write(fixture.root.holders_dir(), "").unwrap();
        let unlistable = block_on(fixture.runtime.inventory());
        let listed = [before, unlistable]
            .map(|listed| listed.map_err(|e| matches!(e, RuntimeError::Unlistable(_))));
        assert_eq!(listed, [Ok(Vec::new()), Err(true)]);
        drop(fixture.dir);
    }

    #[test]
    fn refuses_an_inventory_while_a_holder_cant_be_read_and_watches_the_rest() {
        let (mut fixture, _) = Fixture::new(FakeHost::default(), |_| {});
        block_on(async {
            fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
            fixture.serve(&id(2), Answering::Silent);
            let mut told = fixture.runtime.events();
            let listed = fixture.runtime.inventory().await;
            let want = vec![fixture.socket(&id(2))];
            assert!(
                matches!(&listed, Err(RuntimeError::Unreadable { sockets }) if *sockets == want),
                "{listed:?}"
            );
            assert_eq!(
                told.recv().await.unwrap(),
                RuntimeEvent::Title { terminal_id: id(1) }
            );
            fixture.runtime.shutdown().await;
        });
    }

    #[test]
    fn lists_a_holder_whose_pid_the_kernel_wont_vouch_for_as_the_typescript_runtime_does() {
        // Taken for running by nothing: every pid is one the kernel won't vouch for.
        let (mut fixture, _) = Fixture::new(FakeHost::default(), |_| {});
        let listed = block_on(async {
            fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
            let listed = fixture.runtime.inventory().await;
            fixture.runtime.shutdown().await;
            listed
        });
        let ids = listed
            .map(|entries| {
                entries
                    .into_iter()
                    .map(|e| e.terminal.terminal_id)
                    .collect()
            })
            .map_err(|e| e.to_string());
        assert_eq!(ids, Ok(vec![id(1)]));
    }

    #[test]
    fn refuses_a_ref_from_another_holder_generation_or_child_or_with_none_and_sends_it_nothing() {
        let (mut fixture, _) = Fixture::new(FakeHost::default(), |_| {});
        let terminal_id = id(1);
        let at = reference(&fixture, &terminal_id);
        let edits: [fn(&mut HolderLocator); 4] = [
            |l| l.holder_pid = Pid::new(1).unwrap(),
            |l| l.generation = Some(Generation::new(3).unwrap()),
            |l| l.child_start = StartTime::new(1).unwrap(),
            |l| l.generation = None,
        ];
        let reasons = block_on(async {
            fixture.serve(
                &terminal_id,
                Answering::Hello(Box::new(hello_of(&terminal_id))),
            );
            let mut reasons = Vec::new();
            for edit in edits {
                let mut terminal = at.clone();
                edit(&mut terminal.locator);
                match fixture.runtime.set_theme(&terminal, None).await {
                    Err(RuntimeError::Stale { reason, .. }) => reasons.push(reason),
                    other => panic!("{other:?}"),
                }
            }
            fixture.runtime.set_theme(&at, None).await.unwrap();
            reasons
        });
        assert_eq!(
            reasons,
            [
                StaleReason::ServerReplaced,
                StaleReason::ProcessReplaced,
                StaleReason::ProcessReplaced,
                StaleReason::Unnumbered
            ]
        );
        assert!(matches!(
            fixture.seen.lock().unwrap().as_slice(),
            [Request::SetTheme { .. }]
        ));
    }

    #[test]
    fn calls_a_terminal_gone_only_when_no_holder_answers_and_the_recorded_one_isnt_running() {
        let gone: Vec<_> = [(false, false), (false, true), (true, false)]
            .into_iter()
            .map(|(answers, running)| {
                let (mut fixture, _) = Fixture::new(
                    FakeHost {
                        running,
                        ..FakeHost::default()
                    },
                    |_| {},
                );
                let terminal = reference(&fixture, &id(1));
                block_on(async {
                    if answers {
                        fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
                    } else {
                        fixture.stale(&id(1));
                    }
                    let gone = fixture.runtime.gone(&terminal).await;
                    let title = fixture.runtime.title(&terminal).await;
                    (
                        gone,
                        title.map_err(|e| {
                            matches!(
                                e,
                                RuntimeError::Stale {
                                    reason: StaleReason::Gone,
                                    ..
                                }
                            )
                        }),
                    )
                })
            })
            .collect();
        assert_eq!(
            gone,
            [
                (true, Err(true)),
                (false, Err(false)),
                (false, Ok(String::new()))
            ]
        );
    }

    #[test]
    fn is_unreachable_while_a_recorded_holder_runs_with_its_socket_gone_and_tells_it_to_bind_again()
    {
        let health: Vec<_> = [(false, false), (true, false), (false, true)]
            .into_iter()
            .map(|(answers, rebinds)| {
                let (mut fixture, host) = Fixture::new(
                    FakeHost {
                        rebinds,
                        ..FakeHost::default()
                    },
                    |_| {},
                );
                let recorded = [reference(&fixture, &id(1)), reference(&fixture, &id(2))];
                let state = block_on(async {
                    if answers {
                        fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
                    }
                    fixture.runtime.health(&recorded).await
                });
                assert_eq!(state.version, "holder/1.4");
                (state.state, host.rebound.lock().unwrap().len())
            })
            .collect();
        assert_eq!(
            health,
            [
                (HealthState::NotRunning, 2),
                (HealthState::Healthy, 1),
                (HealthState::Unreachable, 2)
            ]
        );
    }

    #[test]
    fn reads_a_foreground_by_its_leader_refusing_one_started_at_another_time() {
        let leader = |start| Leader {
            comm: "/usr/bin/vim".into(),
            start,
            cwd: Some(PathBuf::from("/src")),
        };
        let read: Vec<_> = [START + 5, START + 5 + START_SKEW_S + 1]
            .into_iter()
            .map(|start| {
                let host = FakeHost {
                    leader: Some(leader(start)),
                    running: true,
                    ..FakeHost::default()
                };
                let (mut fixture, _) = Fixture::new(host, |_| {});
                block_on(async {
                    fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
                    let one = fixture
                        .runtime
                        .foreground(&reference(&fixture, &id(1)))
                        .await
                        .ok();
                    let all = fixture
                        .runtime
                        .foregrounds(&HashSet::from([id(1)]))
                        .await
                        .unwrap();
                    fixture.runtime.shutdown().await;
                    (one, all.into_iter().map(|(_, f)| f).collect::<Vec<_>>())
                })
            })
            .collect();
        let vim = ForegroundProcess {
            command: "vim".to_owned(),
            own: false,
            cwd: Some(PathBuf::from("/src")),
        };
        assert_eq!(read, [(Some(vim.clone()), vec![vim]), (None, vec![])]);
    }

    #[test]
    fn pastes_only_text_the_gate_takes_on_a_holder_with_the_gate_saying_why_it_typed_nothing() {
        let pasted = |hello: HelloReply, text: &'static str, brackets: bool| {
            let (mut fixture, _) = Fixture::new(FakeHost::default(), |_| {});
            block_on(async {
                fixture.serve(&id(1), Answering::Hello(Box::new(hello)));
                let at = reference(&fixture, &id(1));
                let pasted = match fixture.runtime.paste(&at, text, brackets).await {
                    Ok(()) => Ok(()),
                    Err(RuntimeError::PasteRefused { reason, .. }) => Err(reason),
                    Err(other) => panic!("{other:?}"),
                };
                fixture.runtime.shutdown().await;
                let sent: Vec<(String, bool)> = fixture
                    .seen
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|r| match r {
                        Request::Paste { body, .. } => {
                            Some((body.text().to_owned(), body.brackets()))
                        }
                        _ => None,
                    })
                    .collect();
                (pasted, sent)
            })
        };
        let mut before_gate = hello_of(&id(1));
        before_gate.version = ProtocolVersion::new("1.2").unwrap();
        let sent = |text: &str, brackets| vec![(text.to_owned(), brackets)];
        assert_eq!(
            [
                pasted(hello_of(&id(1)), "echo café", true),
                pasted(hello_of(&id(1)), "make", false),
                pasted(hello_of(&id(1)), "cat", false),
                pasted(hello_of(&id(1)), "echo café", false),
                pasted(hello_of(&id(1)), "make\r", true),
                pasted(before_gate, "make", false),
            ],
            [
                (Ok(()), sent("echo café", true)),
                (Ok(()), sent("make", false)),
                (
                    Err("the shell isn't reading at its prompt".to_owned()),
                    sent("cat", false)
                ),
                (
                    Err("refusing to paste text beyond printable ASCII that may arrive as keys"
                        .to_owned()),
                    vec![]
                ),
                (Err("refusing to paste a control character".to_owned()), vec![]),
                (
                    Err("this terminal's holder predates gated paste; restart the terminal to paste"
                        .to_owned()),
                    vec![]
                ),
            ]
        );
    }

    #[test]
    fn lists_each_holder_with_its_build_memory_and_scope_and_one_it_cant_speak_to_by_its_socket() {
        let (mut fixture, _) = Fixture::new(FakeHost::default(), |o| {
            o.install_dir = Some(PathBuf::from("/opt/bz/holder"));
        });
        let builds = block_on(async {
            fixture.serve(&id(1), Answering::Hello(Box::new(hello_of(&id(1)))));
            fixture.serve(&id(2), Answering::Outdated);
            fixture.runtime.builds().await.unwrap()
        });
        let listed: Vec<_> = builds
            .iter()
            .map(|b| {
                (
                    b.terminal_id.clone(),
                    b.build.as_deref(),
                    b.contained,
                    b.holder_pid.map(Pid::get),
                    b.stats.map(|s| s.rss),
                )
            })
            .collect();
        assert_eq!(
            listed,
            [
                (
                    id(1),
                    Some("0123456789abcdef"),
                    Some(true),
                    Some(4242),
                    Some(Some(8192.try_into().unwrap()))
                ),
                (id(2), None, None, None, None),
            ]
        );
    }

    #[test]
    fn writes_the_scope_unit_from_the_kernels_randomness() {
        let (a, b) = (unit_random(), unit_random());
        assert_ne!(a, b);
        assert_eq!(a.len(), 16);
    }
}
