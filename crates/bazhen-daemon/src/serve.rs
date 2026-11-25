//! The daemon in the foreground, as `apps/daemon/src/main.ts` starts and stops it: make the home's
//! directories, refuse a second daemon, open the store, then serve the socket and loopback HTTP
//! until a signal or a stop.

use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use bazhen_client::paths::{DRAIN, LOCK_WAIT, Paths, lock_of};
use bazhen_store::{AppendError, OpenError, Store};

use crate::retention;
use crate::writer::{self, Writer};
use tokio::net::{TcpListener, UnixListener};
use tokio::signal::unix::{SignalKind, signal};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::accept::{self, Limits, serve_on};
use crate::agents::prompts::daemon_prompts;
use crate::agents::{Agents, AgentsDeps};
use crate::config::Settings;
use crate::doctor::Settled;
use crate::guard;
use crate::lock::{Claim, Lock, claim};
use crate::private_dir::ensure_private_dir;
use crate::probe::{probe, silence};
use crate::roles::Roles;
use crate::routes::{self, Gate, Reason, Shared, Stop};
use crate::runner::{self, Runner};
use crate::shells::integration::{Integration, install_shell_integration};
use crate::shells::{ShellError, Shells, ShellsDeps};
use crate::terminals::Events;
use crate::tokens::{self, AgentTokens};
use crate::web::State;

/// How the daemon serves: each listener's limits, how long its connections get to finish once
/// a stop is asked for, and how often it reads its shells again.
#[derive(Debug, Clone, Copy)]
struct Serving {
    http: Limits,
    socket: Limits,
    drain: Duration,
    tick: Duration,
}

const SERVING: Serving = Serving {
    http: accept::HTTP,
    socket: accept::SOCKET,
    drain: DRAIN,
    tick: TICK,
};

/// What serving needs from the settings.
#[derive(Debug, Clone)]
pub(crate) struct Startup {
    pub(crate) paths: Paths,
    /// The settings as loaded, which the terminals and doctor read.
    pub(crate) settings: Settings,
    /// The daemon user's home: a shell's default directory.
    pub(crate) home: String,
    pub(crate) uid: u32,
    pub(crate) port: u16,
    /// `BAZHEN_WEB_PORT`: the web dev server's port, whose pages may act.
    pub(crate) web_port: Option<String>,
    pub(crate) external_origins: Vec<String>,
    /// Where the external origins came from, for the start-up line; `None` when there are none.
    pub(crate) external_origins_from: Option<&'static str>,
    pub(crate) pairing: &'static str,
    pub(crate) pairing_required: bool,
}

/// A start-up failure, said in one line before the daemon exits 1.
#[derive(Debug, thiserror::Error)]
pub(crate) enum Refused {
    #[error("bazhen is already running on {0}")]
    Running(String),
    #[error("{}", silence(.socket, .seen))]
    Silent { socket: String, seen: String },
    #[error(
        "bazhen won't start: another daemon holds {} but doesn't answer on {socket}; it may be stuck",
        .lock.display()
    )]
    Held { lock: PathBuf, socket: String },
    #[error("{0}")]
    Said(String),
}

/// Runs the daemon until it is stopped.
pub(crate) fn serve(startup: &Startup) -> ExitCode {
    // Before any child starts, so the kernel keeps each one exited until it is waited for, and its
    // pid stays its own: a SIGCHLD ignored by whatever started the daemon would reap it at once.
    let served = bazhen_host_guard::keep_exited_children()
        .map_err(|e| Refused::Said(format!("bazhen can't keep its exited children: {e}")))
        .and_then(|()| prepare(startup, LOCK_WAIT))
        .and_then(|(lock, store)| {
            let reason = run(startup, store);
            drop(lock);
            reason
        });
    match served {
        Ok(reason) => {
            tracing::info!("bazhen daemon stopped ({})", reason.as_str());
            ExitCode::SUCCESS
        }
        Err(refused) => {
            tracing::error!("{refused}");
            ExitCode::FAILURE
        }
    }
}

/// Everything before the daemon serves: its directories, a private `run`, the start-up lock with
/// no daemon on the socket, and the store, migrated, on its writer thread.
fn prepare(startup: &Startup, wait: Duration) -> Result<(Lock, (Writer, writer::Thread)), Refused> {
    let p = &startup.paths;
    for dir in [&p.config, &p.data, &p.bank, &p.state, &p.cache] {
        std::fs::create_dir_all(dir)
            .map_err(|err| Refused::Said(format!("bazhen can't create {dir}: {err}")))?;
    }
    ensure_private_dir(Path::new(&p.run), startup.uid).map_err(|e| Refused::Said(e.to_string()))?;
    // Its socket is about to be replaced; a daemon still holding it would be orphaned, with its
    // store shared.
    let socket = Path::new(&p.socket);
    let lock_file = lock_of(socket);
    let lock = claim(&lock_file, wait, || probe(socket)).map_err(|claimed| match claimed {
        Claim::Running => Refused::Running(p.socket.clone()),
        Claim::Silent { seen } => Refused::Silent {
            socket: p.socket.clone(),
            seen,
        },
        Claim::Held => Refused::Held {
            lock: lock_file.clone(),
            socket: p.socket.clone(),
        },
        Claim::Io(err) => {
            Refused::Said(format!("bazhen can't lock {}: {err}", lock_file.display()))
        }
    })?;
    let path = PathBuf::from(&p.data).join("bazhen.db");
    let mut store = Store::open(&path).map_err(|err| match err {
        OpenError::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => {
            Refused::Said(format!(
                "bazhen can't open {} as its own ({}): check who owns it",
                path.display(),
                errno_name(&io)
            ))
        }
        other => Refused::Said(other.to_string()),
    })?;
    if !store.missed().is_empty() {
        tracing::warn!(
            "bazhen: running migrations this database missed, after later ones it has run: {}",
            store.missed().join(", ")
        );
    }
    tokens::forget_ended(
        &Path::new(&p.run).join("agents"),
        startup.uid,
        store.reads(),
    )
    .map_err(|err| Refused::Said(err.to_string()))?;
    // No view outlives the daemon that served it: each still recorded as open ends, releasing its
    // lease, and its page reattaches for a fresh screen.
    let ended = store
        .write(|w: &bazhen_store::Writer<'_>| w.end_open_attachments())
        .map_err(|err| Refused::Said(format!("bazhen can't end the views left open: {err}")))?;
    // Said only when there were some: most starts follow a daemon whose views all closed.
    if ended > 0 {
        tracing::info!(
            views = ended,
            "bazhen: ended the views left open by the daemon before it"
        );
    }
    let store = writer::start(store, &path)
        .map_err(|err| Refused::Said(format!("bazhen can't start its store: {err}")))?;
    Ok((lock, store))
}

/// `EPERM` or `EACCES`, as Node names the code.
fn errno_name(err: &std::io::Error) -> &'static str {
    if err.raw_os_error() == Some(rustix::io::Errno::PERM.raw_os_error()) {
        "EPERM"
    } else {
        "EACCES"
    }
}

/// Serves until a stop, then lets the listeners drain, and says why it stopped.
fn run(startup: &Startup, (store, writer): (Writer, writer::Thread)) -> Result<Reason, Refused> {
    let served = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| Refused::Said(format!("bazhen can't start its runtime: {err}")))
        .and_then(|runtime| {
            runtime.block_on(async {
                let runner = runner::holders(startup).await?;
                listen(startup, SERVING, store, Some(runner)).await
            })
        });
    writer.finish();
    served
}

/// What new shells report their lines with (`shellIntegration` in `main.ts`): with
/// `shells.retype_last_command` off, nothing, and every line and token kept from before is
/// forgotten; with it on, the snippets written where shells are told to find them, and the hook
/// client built beside the daemon that they run. Without either, shells report nothing, as is said.
async fn shell_integration(
    startup: &Startup,
    store: &Writer,
    hook: Option<&str>,
) -> Result<Option<Integration>, Refused> {
    if !startup.settings.config.retype_last_command {
        store
            .run(|store| store.write(|w: &bazhen_store::Writer<'_>| w.forget_shell_commands()))
            .await
            .map_err(|err| Refused::Said(format!("bazhen can't start its store: {err}")))?
            .map_err(|err| Refused::Said(format!("bazhen can't forget shells' lines: {err}")))?;
        return Ok(None);
    }
    let Some(hook) = hook else {
        tracing::warn!(
            "shells.retype_last_command is on, but bazhen-hook is not built: shells report nothing"
        );
        return Ok(None);
    };
    let dir = Path::new(&startup.paths.state).join("shell-integration");
    match install_shell_integration(&dir, startup.uid) {
        Ok(()) => Ok(Some(Integration {
            hook: hook.to_owned(),
            dir: dir.to_string_lossy().into_owned(),
        })),
        Err(err) => {
            tracing::warn!("shells.retype_last_command is on, but shells report nothing: {err}");
            Ok(None)
        }
    }
}

/// The shells over `runner`'s terminals, with this machine's environment registered, the shells
/// kept from before reconciled with what runs, what the budget says of those still open, and the
/// events told from before any of it. A wait on a restarted shell's prompt ends at `stop`.
async fn shells(
    startup: &Startup,
    store: &Writer,
    runner: Runner,
    tracker: &TaskTracker,
    stop: &CancellationToken,
    roles: Arc<Roles>,
) -> Result<Running, Refused> {
    let events = runner.terminals.events();
    store
        .run(|store| {
            store.write(|w| -> Result<(), AppendError> { w.local_environment().map(drop) })
        })
        .await
        .map_err(|err| Refused::Said(format!("bazhen can't start its store: {err}")))?
        .map_err(|err| Refused::Said(format!("bazhen can't register this machine: {err}")))?;
    let integration = shell_integration(startup, store, runner.hook.as_deref()).await?;
    let budget = Arc::clone(&runner.budget);
    let run = Path::new(&startup.paths.run);
    let turns = Arc::<crate::turns::Turns>::default();
    let agents = Agents::new(AgentsDeps {
        store: store.clone(),
        terminals: Arc::clone(&runner.terminals),
        budget: Arc::clone(&runner.budget),
        home: startup.home.clone(),
        socket: startup.paths.socket.clone(),
        tracker: tracker.clone(),
        roles,
        harnesses: runner.harnesses,
        hook_built: runner.hook.is_some(),
        tokens: AgentTokens::new(run.join("agents"), startup.uid, store.clone()),
        prompts: daemon_prompts(run, startup.uid),
        login_shell: startup.settings.config.login_shell.clone(),
        turns: Arc::clone(&turns),
    });
    let shells = Shells::new(ShellsDeps {
        turns,
        store: store.clone(),
        terminals: runner.terminals,
        budget: runner.budget,
        home: startup.home.clone(),
        shell: runner.shell,
        socket: startup.paths.socket.clone(),
        tracker: tracker.clone(),
        stop: stop.clone(),
        integration,
    });
    if let Err(err) = shells.reconcile().await {
        return Err(unread_shells(startup, store, &err).await);
    }
    if let Err(err) = shells.sweep_restarts().await {
        tracing::warn!(
            "bazhen: terminals on holders this build can't fully serve weren't read: {err}"
        );
    }
    let open = store
        .run(|store| store.reads().open_terminals())
        .await
        .map_err(|err| Refused::Said(format!("bazhen can't start its store: {err}")))?
        .map_err(|err| Refused::Said(format!("bazhen can't read its terminals: {err}")))?;
    for warning in budget.startup_warnings(open) {
        tracing::warn!("bazhen: {warning}");
    }
    Ok(Running {
        watched: Watched {
            shells: Arc::new(shells),
            agents: Arc::new(agents),
            events,
        },
        doctor: runner.doctor,
    })
}

/// What runs on the daemon's terminals, as its start sets it up.
struct Running {
    watched: Watched,
    doctor: Settled,
}

/// How often the running shells' foregrounds, and what their holders speak, are read again: the
/// TypeScript daemon's server watch's tick.
const TICK: Duration = Duration::from_secs(5);

/// Why the start can't read the shells kept from before, naming the one it can't, as one bad row
/// keeps the daemon from starting.
async fn unread_shells(startup: &Startup, store: &Writer, err: &ShellError) -> Refused {
    let named = store
        .run(|store| store.reads().unreadable_shell())
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    let db = PathBuf::from(&startup.paths.data).join("bazhen.db");
    Refused::Said(match named {
        Some(id) => format!(
            "bazhen can't read shell {id} kept from before: {err}; start the bazhen build that wrote it, or move {} aside to start without anything it keeps",
            db.display()
        ),
        None => format!("bazhen can't read its shells: {err}"),
    })
}

/// What the runtime runs, and what it tells of its terminals, as `follow` watches them.
struct Watched {
    shells: Arc<Shells>,
    agents: Arc<Agents>,
    events: Box<dyn Events>,
}

/// Runs the shells' tick every `tick`, and follows what the runtime tells of its terminals, until
/// `stop`: each event goes to the shells and to the agents, each on `tracker`, and each takes only
/// its own terminals' events.
async fn follow(
    Watched {
        shells,
        agents,
        mut events,
    }: Watched,
    tick: Duration,
    tracker: TaskTracker,
    stop: CancellationToken,
) {
    tracker.spawn(every_tick(Arc::clone(&shells), tick, stop.clone()));
    while let Some(Some(event)) = stop.run_until_cancelled(events.next()).await {
        agents.heard(event.clone(), &tracker);
        shells.heard(event, &tracker, &stop);
    }
}

/// Tries again the shells the start's reconcile couldn't settle, then reads the running shells'
/// foregrounds, and which terminals need a restart, `every` so often, until `stop`, which ends a
/// tick midway: each of its writes to the store is whole on its own. A stop amid a retry's close
/// or unlink may leave the shell closing, or still naming its agent where it runs; the next
/// start's reconcile settles it. A restart read that fails is said once until one reads again.
async fn every_tick(shells: Arc<Shells>, every: Duration, stop: CancellationToken) {
    let mut fault = None;
    while stop
        .run_until_cancelled(tokio::time::sleep(every))
        .await
        .is_some()
    {
        let swept = stop
            .run_until_cancelled(async {
                shells.reconcile_again().await;
                shells.refresh_foregrounds().await;
                shells.sweep_restarts().await
            })
            .await;
        match swept {
            None => return,
            Some(Ok(())) => fault = None,
            Some(Err(err)) => {
                if fault.as_ref() != Some(&err) {
                    tracing::warn!(
                        "bazhen: terminals on holders this build can't fully serve weren't read: {err}"
                    );
                }
                fault = Some(err);
            }
        }
    }
}

/// The start-up lines on whom the daemon admits, whether they must pair, and what page it serves
/// them.
fn say_whom_it_serves(startup: &Startup, web: Option<(&Path, &State)>) {
    if let Some(from) = startup.external_origins_from {
        tracing::info!(
            "bazhen: admitting external origins from {from}: {}",
            startup.external_origins.join(", ")
        );
    }
    if startup.pairing_required {
        tracing::info!(
            "bazhen: pairing required on every origin (web.pairing = \"{}\")",
            startup.pairing
        );
    } else {
        tracing::info!(
            "bazhen: pairing not required on loopback (web.pairing = \"auto\", no external origins); a request forwarded from another machine must still pair"
        );
    }
    match web {
        Some((bundle, State::Served)) => {
            tracing::info!("bazhen: serving the web app from {}", bundle.display());
        }
        Some((bundle, State::Unbuilt)) => tracing::info!(
            "bazhen: the web app isn't built ({}); `moon run :build` builds it, serving only the API until then",
            bundle.display()
        ),
        Some((bundle, State::Refused(why))) => tracing::warn!(
            "bazhen: not serving the web app from {}: {why}; serving only the API until then",
            bundle.display()
        ),
        None => {}
    }
}

/// Serves the socket and loopback HTTP until a stop, then drains them, and says why it stopped.
/// With `runner`, it runs shells on its terminals, and ends the runtime's watches at the drain.
async fn listen(
    startup: &Startup,
    serving: Serving,
    store: Writer,
    runner: Option<Runner>,
) -> Result<Reason, Refused> {
    let stop = Stop::default();
    let hurry = CancellationToken::new();
    let hearing = TaskTracker::new();
    hear_signals(&hearing, &stop, &hurry)?;
    let mut shared = Shared::new(
        bazhen_protocol::id::PROTOCOL_ID,
        stop.clone(),
        store.clone(),
    )
    .with_external_origins(startup.external_origins.clone())
    .with_roles(Path::new(&startup.paths.config).join("roles"));
    // Made before the shells, whose commands run on it, so the drain waits for them as well.
    let tracker = TaskTracker::new();
    let mut watching = None;
    if let Some(runner) = runner {
        let streaming = runner.streams.clone();
        let roles = Arc::clone(&shared.roles);
        let Running { watched, doctor } =
            shells(startup, &store, runner, &tracker, stop.token(), roles).await?;
        let bundle = doctor.bundle.clone();
        shared = shared
            .with_shells(Arc::clone(&watched.shells), doctor)
            .with_agents(Arc::clone(&watched.agents))
            .with_web(bundle);
        shared.streams =
            crate::stream::on_holders(&store, streaming, &watched.shells, &tracker, stop.token());
        watching = Some(watched);
    }
    let gate = Gate {
        allow: guard::allowlists(
            startup.port,
            startup.web_port.as_deref(),
            &startup.external_origins,
        ),
        pairing_required: startup.pairing_required,
    };
    let url = format!("http://{}:{}", guard::LOOPBACK, startup.port);
    let http = TcpListener::bind((guard::LOOPBACK, startup.port))
        .await
        .map_err(|err| Refused::Said(format!("bazhen can't listen on {url}: {err}")))?;
    let web = match shared.web.clone() {
        Some(bundle) => {
            let read = Arc::clone(&bundle);
            let state = tokio::task::spawn_blocking(move || read.state()).await;
            Some((bundle, state.unwrap_or(State::Unbuilt)))
        }
        None => None,
    };
    say_whom_it_serves(
        startup,
        web.as_ref().map(|(bundle, state)| (bundle.dist(), state)),
    );
    tracing::info!(
        "bazhen daemon listening on {url} (data: {})",
        startup.paths.data
    );
    let path = PathBuf::from(&startup.paths.socket);
    let (socket, made) = bind_socket(&path)?;

    let token = stop.token();
    let retiring = token.clone();
    let ending = watching.as_ref().map(|watched| Arc::clone(&watched.shells));
    let streams = shared.streams.clone();
    if let Some(watched) = watching {
        tracker.spawn(follow(
            watched,
            serving.tick,
            tracker.clone(),
            token.clone(),
        ));
    }
    tracker.spawn(crate::paired::close_lapsed_every_minute(
        shared.clone(),
        token.clone(),
    ));
    tracker.spawn(retention::every_hour(token.clone(), move || {
        let (store, stop) = (store.clone(), retiring.clone());
        async move { retention::prune(&store, jiff::Timestamp::now(), &stop).await }
    }));
    tracker.spawn(serve_on(
        http,
        routes::http_router(shared.clone(), gate),
        serving.http,
        token.clone(),
        tracker.clone(),
        || {},
    ));
    tracker.spawn(serve_on(
        socket,
        routes::socket_router(shared),
        serving.socket,
        token.clone(),
        tracker.clone(),
        move || forget_socket(&path, made),
    ));
    tracker.close();
    token.cancelled().await;
    drain(&tracker, serving.drain, &hurry).await;
    end_terminals(streams, ending, serving.drain, &hurry).await;
    Ok(stop.reason().unwrap_or(Reason::Requested))
}

/// Closes the terminals' streams, a parked one without waiting out its linger, then the runtime's
/// watches of them and its connections, each for no longer than `within`. Holders run on. A hurry
/// cuts short only the wait for the hub's work: every stream is closed all the same.
async fn end_terminals(
    streams: Option<crate::stream::route::Streams>,
    shells: Option<Arc<Shells>>,
    within: Duration,
    hurry: &CancellationToken,
) {
    if let Some(streams) = streams {
        streams.close();
        hurry.run_until_cancelled(streams.wait(within)).await;
    }
    if let Some(shells) = shells {
        let _ = tokio::time::timeout(within, shells.terminals().shutdown()).await;
    }
}

/// Waits for the listeners' connections to end, for no longer than `within`, and no longer at all
/// once `hurry` is cancelled. A connection that won't finish is left to the exit.
async fn drain(tracker: &TaskTracker, within: Duration, hurry: &CancellationToken) {
    let _ = tokio::time::timeout(within, hurry.run_until_cancelled(tracker.wait())).await;
}

/// The socket file a daemon made, as its device and inode.
type Made = (u64, u64);

/// The socket, made afresh and readable and writable by this user only, and the file it made.
fn bind_socket(path: &Path) -> Result<(UnixListener, Made), Refused> {
    let refused = |err: std::io::Error| {
        Refused::Said(format!("bazhen can't listen on {}: {err}", path.display()))
    };
    match std::fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(refused(err)),
        _ => {}
    }
    let listener = UnixListener::bind(path).map_err(refused)?;
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .map_err(refused)?;
    let file = std::fs::symlink_metadata(path).map_err(refused)?;
    Ok((listener, (file.dev(), file.ino())))
}

/// Removes the socket file while the daemon still listens on it, as Node's close does, so it
/// doesn't outlive the daemon; but only the one it made, not one a daemon started since has. The
/// open listener holds the file's inode, so no other file at `path` can have the one it made.
fn forget_socket(path: &Path, made: Made) {
    let ours = std::fs::symlink_metadata(path).is_ok_and(|file| (file.dev(), file.ino()) == made);
    if ours && let Err(err) = std::fs::remove_file(path) {
        tracing::warn!("bazhen: can't remove {}: {err}", path.display());
    }
}

/// SIGTERM and SIGINT stop the daemon, each said as the reason.
fn hear_signals(
    hearing: &TaskTracker,
    stop: &Stop,
    hurry: &CancellationToken,
) -> Result<(), Refused> {
    for (kind, reason) in [
        (SignalKind::terminate(), Reason::Sigterm),
        (SignalKind::interrupt(), Reason::Sigint),
    ] {
        let mut received = signal(kind).map_err(|err| {
            Refused::Said(format!("bazhen can't hear {}: {err}", reason.as_str()))
        })?;
        let (stop, hurry) = (stop.clone(), hurry.clone());
        hearing.spawn(async move {
            while received.recv().await.is_some() {
                heard(&stop, &hurry, reason);
            }
        });
    }
    Ok(())
}

/// A signal: the stop, or, heard once there is one, the end of its drain, since the TypeScript
/// daemon exits at once on each.
fn heard(stop: &Stop, hurry: &CancellationToken, reason: Reason) {
    if stop.token().is_cancelled() {
        hurry.cancel();
    } else {
        stop.now(reason);
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::time::Instant;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    use super::*;
    use crate::testing::{TempDir, runtime};

    /// An agent's process that exits while no view watches its terminal is recorded exited, as
    /// the runtime tells it, while the shells take only their own terminals' events.
    #[test]
    fn hands_an_agents_exit_no_view_heard_to_the_agents() {
        use crate::terminals::Terminals as _;
        let f = crate::agents::tests::setup_with(crate::agents::tests::Setup::default());
        let agent = runtime()
            .block_on(f.launch(crate::agents::tests::request("k-1")))
            .unwrap()
            .agent_id;
        let terminal = f.terminal_of(agent.as_str());
        let tracker = TaskTracker::new();
        let stop = CancellationToken::new();
        let state = |f: &crate::agents::tests::Fixture| {
            f.store
                .reader()
                .unwrap()
                .reads()
                .agent_state(agent.as_str())
                .unwrap()
        };
        let seen = runtime().block_on(async {
            tracker.spawn(follow(
                Watched {
                    shells: f.shells(),
                    agents: Arc::clone(&f.agents),
                    events: f.fake().events(),
                },
                Duration::from_secs(3600),
                tracker.clone(),
                stop.clone(),
            ));
            tokio::task::yield_now().await;
            f.fake().exit(&terminal);
            let deadline = Instant::now() + Duration::from_secs(5);
            while state(&f).as_deref() != Some("exited") && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            stop.cancel();
            tracker.close();
            tracker.wait().await;
            state(&f)
        });
        assert_eq!(seen.as_deref(), Some("exited"));
    }

    fn startup(home: &Path) -> Startup {
        let at = |name: &str| home.join(name).to_string_lossy().into_owned();
        let paths = Paths {
            config: at("config"),
            data: at("data"),
            bank: at("bank"),
            state: at("state"),
            cache: at("cache"),
            run: at("run"),
            socket: at("run/bazhen.sock"),
        };
        Startup {
            paths: paths.clone(),
            settings: Settings {
                paths,
                config: crate::config::resolve_config(
                    &crate::config::FileConfig::default(),
                    &|_| None,
                )
                .unwrap(),
                config_file: crate::config::ConfigFile {
                    path: at("config/config.toml"),
                    found: false,
                },
            },
            home: at("home"),
            uid: rustix::process::getuid().as_raw(),
            port: 0,
            web_port: None,
            external_origins: Vec::new(),
            external_origins_from: None,
            pairing: "auto",
            pairing_required: false,
        }
    }

    const QUICK: Serving = Serving {
        drain: Duration::from_millis(400),
        ..SERVING
    };

    /// A connection to the daemon on `socket`, once it is listening.
    async fn connect(socket: &Path) -> UnixStream {
        let started = Instant::now();
        loop {
            match UnixStream::connect(socket).await {
                Ok(stream) => return stream,
                Err(err) if started.elapsed() > Duration::from_secs(5) => panic!("{err}"),
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    }

    /// What the daemon on `socket` answers `request`, once it is listening.
    async fn ask(socket: &Path, request: &[u8]) -> String {
        let mut stream = connect(socket).await;
        stream.write_all(request).await.unwrap();
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.unwrap();
        String::from_utf8_lossy(&answer).into_owned()
    }

    const STOP: &[u8] =
        b"POST /v1/daemon/stop HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

    #[test]
    fn stops_when_asked_over_its_socket_says_so_and_leaves_no_socket_behind() {
        let home = TempDir::new("stop");
        let startup = startup(home.path());
        let socket = PathBuf::from(&startup.paths.socket);
        let (_lock, (store, writer)) = prepare(&startup, QUICK.drain).unwrap();
        runtime().block_on(async {
            let tracker = TaskTracker::new();
            let serving = tracker.spawn(async move { listen(&startup, QUICK, store, None).await });
            let answer = ask(&socket, STOP).await;
            let asked = Instant::now();
            let reason = tokio::time::timeout(Duration::from_secs(5), serving).await;
            let took = asked.elapsed();
            assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
            assert!(
                matches!(reason, Ok(Ok(Ok(Reason::Requested)))),
                "{reason:?}"
            );
            assert!(took < QUICK.drain, "{took:?}");
            assert!(!socket.exists());
        });
        writer.finish();
    }

    /// Terminals on a fake runtime, three at most, with no holder installed.
    fn roles() -> Arc<Roles> {
        Arc::new(Roles::new(None))
    }

    fn faked(startup: &Startup) -> Runner {
        use crate::budget::tests::{Machine, roomy};
        let captured = crate::env::capture(
            &[],
            &startup.settings.config.env_rules,
            jiff::Timestamp::UNIX_EPOCH,
        );
        let doctor = Settled::of(crate::doctor::Settings {
            exe: Path::new("/nowhere/target/release/bazhen-daemon"),
            config: &startup.settings,
            install: crate::holder::Install::None("no build".to_owned()),
            capture: &captured,
            hook: None,
        });
        let budget = crate::budget::Budget::new(
            3,
            Arc::new(Machine(std::sync::Mutex::new(roomy()))),
            Box::new(|_| {}),
        );
        Runner {
            terminals: Arc::new(crate::terminals::fake::Fake::default()),
            budget: Arc::new(budget),
            doctor,
            shell: "/bin/sh".to_owned(),
            streams: None,
            hook: None,
            harnesses: bazhen_harness::Harnesses::new(Vec::new()),
        }
    }

    #[test]
    fn reconciles_the_shells_kept_from_before_then_says_what_the_budget_makes_of_those_left_open() {
        use crate::budget::tests::{Machine, roomy};
        use bazhen_protocol::shells::TerminalState;
        let home = TempDir::new("kept");
        let startup = startup(home.path());
        std::fs::create_dir_all(&startup.home).unwrap();
        let (_lock, (store, writer)) = prepare(&startup, QUICK.drain).unwrap();
        let fake = crate::terminals::fake::Fake::default();
        let said = crate::shells::tests::Said::default();
        let _logging = said.logging();
        let budget = |max| {
            Arc::new(crate::budget::Budget::new(
                max,
                Arc::new(Machine(std::sync::Mutex::new(roomy()))),
                Box::new(|_| {}),
            ))
        };
        let (kept, gone) = runtime().block_on(async {
            let before = Shells::new(ShellsDeps {
                turns: Arc::default(),
                store: store.clone(),
                terminals: Arc::new(fake.clone()),
                budget: budget(3),
                home: startup.home.clone(),
                shell: "/bin/sh".to_owned(),
                socket: startup.paths.socket.clone(),
                tracker: TaskTracker::new(),
                stop: CancellationToken::new(),
                integration: None,
            });
            let mut opened = Vec::new();
            for key in ["a", "b"] {
                let req = bazhen_protocol::shells::OpenShellRequest {
                    idempotency_key: key.to_owned(),
                    linked_agent_id: None,
                    cwd: None,
                    theme: None,
                };
                opened.push(before.open(&req, None).await.unwrap().terminal_id);
            }
            fake.gone(opened[1].as_str());
            let runner = Runner {
                terminals: Arc::new(fake.clone()),
                budget: budget(1),
                ..faked(&startup)
            };
            let stop = CancellationToken::new();
            let Ok(_) = shells(
                &startup,
                &store,
                runner,
                &TaskTracker::new(),
                &stop,
                roles(),
            )
            .await
            else {
                panic!("refused to start");
            };
            (opened[0].clone(), opened[1].clone())
        });
        let state_of = |id: &bazhen_protocol::ids::TerminalId| {
            let reader = store.reader().unwrap();
            reader.reads().shell(id.as_str()).unwrap().map(|s| s.state)
        };
        assert_eq!(
            [state_of(&kept), state_of(&gone)],
            [Some(TerminalState::Running), Some(TerminalState::Lost)]
        );
        assert_eq!(said.times("above terminals.max_open"), 0);
        writer.finish();
    }

    #[test]
    fn starts_the_agents_and_shells_on_one_set_of_turns() {
        let home = TempDir::new("turns");
        let startup = startup(home.path());
        std::fs::create_dir_all(&startup.home).unwrap();
        let (_lock, (store, writer)) = prepare(&startup, QUICK.drain).unwrap();
        let shared = runtime().block_on(async {
            let started = shells(
                &startup,
                &store,
                faked(&startup),
                &TaskTracker::new(),
                &CancellationToken::new(),
                roles(),
            )
            .await;
            started
                .ok()
                .map(|running| running.watched)
                .map(|watched| Arc::ptr_eq(watched.agents.turns(), watched.shells.turns()))
        });
        assert_eq!(shared, Some(true));
        writer.finish();
    }

    #[test]
    fn tells_shells_to_report_only_with_retyping_on_the_hook_built_and_the_snippets_written() {
        use bazhen_protocol::shells::ShellReport;
        let h = crate::shells::tests::setup_with(100, Some(crate::shells::tests::integration()));
        let mut startup = startup(h.dir.path());
        let said = crate::shells::tests::Said::default();
        let _logging = said.logging();
        let built = Some("/opt/bazhen/bazhen-hook");
        let unbuilt = None;
        runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let report = ShellReport {
                token: h.token_of(&id).unwrap(),
                at: 1,
                command: Some("make".to_owned()),
            };
            h.shells.report(&id, report).await.unwrap();
            let off = shell_integration(&startup, &h.store, built).await;
            let forgotten = {
                let reader = h.store.reader().unwrap();
                let reads = reader.reads();
                (
                    reads.last_shell_command(&id).unwrap(),
                    reads.shell_token_hash(&id).unwrap(),
                )
            };
            startup.settings.config.retype_last_command = true;
            let state = std::path::Path::new(&startup.paths.state);
            std::fs::create_dir_all(state).unwrap();
            std::fs::write(state.join("shell-integration"), "a file").unwrap();
            let unwritten = shell_integration(&startup, &h.store, built).await;
            std::fs::remove_file(state.join("shell-integration")).unwrap();
            let on = shell_integration(&startup, &h.store, built).await;
            let no_hook = shell_integration(&startup, &h.store, unbuilt).await;
            assert_eq!((off.unwrap(), forgotten), (None, (None, None)));
            assert_eq!((no_hook.unwrap(), unwritten.unwrap()), (None, None));
            assert_eq!(
                on.unwrap(),
                Some(Integration {
                    hook: "/opt/bazhen/bazhen-hook".to_owned(),
                    dir: state
                        .join("shell-integration")
                        .to_string_lossy()
                        .into_owned(),
                })
            );
            assert!(state.join("shell-integration/zsh").is_file());
        });
        assert_eq!(
            said.times(
                "shells.retype_last_command is on, but bazhen-hook is not built: shells report nothing"
            ),
            1
        );
        assert_eq!(
            said.times("shells.retype_last_command is on, but shells report nothing: "),
            1
        );
    }

    #[test]
    fn refuses_to_start_when_it_cant_read_the_shells_kept_from_before() {
        let home = TempDir::new("unread");
        let startup = startup(home.path());
        std::fs::create_dir_all(&startup.home).unwrap();
        let (_lock, (store, writer)) = prepare(&startup, QUICK.drain).unwrap();
        let fake = crate::terminals::fake::Fake::default();
        let (id, refused) = runtime().block_on(async {
            let runner = Runner {
                terminals: Arc::new(fake.clone()),
                ..faked(&startup)
            };
            let before = Shells::new(ShellsDeps {
                turns: Arc::default(),
                store: store.clone(),
                terminals: Arc::clone(&runner.terminals),
                budget: Arc::clone(&runner.budget),
                home: startup.home.clone(),
                shell: "/bin/sh".to_owned(),
                socket: startup.paths.socket.clone(),
                tracker: TaskTracker::new(),
                integration: None,
                stop: CancellationToken::new(),
            });
            let req = bazhen_protocol::shells::OpenShellRequest {
                idempotency_key: "a".to_owned(),
                linked_agent_id: None,
                cwd: None,
                theme: None,
            };
            let id = before.open(&req, None).await.unwrap().terminal_id;
            store
                .run(|store| {
                    store.write(|w| {
                        w.connection()
                            .execute("UPDATE terminals SET state = 'unreadable'", [])
                    })
                })
                .await
                .unwrap()
                .unwrap();
            let refused = match shells(
                &startup,
                &store,
                runner,
                &TaskTracker::new(),
                &CancellationToken::new(),
                roles(),
            )
            .await
            {
                Ok(_) => None,
                Err(refused) => Some(refused.to_string()),
            };
            (id, refused)
        });
        let named = format!("bazhen can't read shell {id} kept from before: ");
        let db = PathBuf::from(&startup.paths.data).join("bazhen.db");
        let remedy = format!(
            "or move {} aside to start without anything it keeps",
            db.display()
        );
        assert!(
            refused
                .as_deref()
                .is_some_and(|said| said.starts_with(&named) && said.ends_with(&remedy)),
            "{refused:?}"
        );
        writer.finish();
    }

    #[test]
    fn fails_doctor_rather_than_list_no_holders_where_it_cant_list_them() {
        let home = TempDir::new("doctor");
        let startup = startup(home.path());
        let path = home.path().join("bazhen.db");
        let (store, thread) =
            crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
        let fake = crate::terminals::fake::Fake::default();
        let runner = Runner {
            terminals: Arc::new(fake.clone()),
            ..faked(&startup)
        };
        let shells = Shells::new(crate::shells::ShellsDeps {
            turns: Arc::default(),
            store: store.clone(),
            terminals: runner.terminals,
            budget: runner.budget,
            home: startup.home.clone(),
            shell: runner.shell,
            socket: startup.paths.socket.clone(),
            tracker: TaskTracker::new(),
            stop: CancellationToken::new(),
            integration: None,
        });
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), store)
            .with_shells(Arc::new(shells), runner.doctor);
        let asked = || crate::doctor::doctor(axum::extract::State(shared.clone()));
        let answered = runtime().block_on(async {
            let listed = asked().await.status().as_u16();
            fake.set(|state| state.fail_holders = true);
            [listed, asked().await.status().as_u16()]
        });
        thread.finish();
        assert_eq!(answered, [200, 500]);
    }

    /// The JSON body of an answer read whole.
    fn body_of(answer: &str) -> serde_json::Value {
        let (_, body) = answer.split_once("\r\n\r\n").unwrap();
        serde_json::from_str(body).unwrap_or_else(|e| panic!("{e}: {answer}"))
    }

    #[test]
    fn serves_shells_on_its_runtime_and_says_what_runs_them_in_its_health_and_doctor() {
        let home = TempDir::new("shells");
        let startup = startup(home.path());
        std::fs::create_dir_all(&startup.home).unwrap();
        let socket = PathBuf::from(&startup.paths.socket);
        let (_lock, (store, writer)) = prepare(&startup, QUICK.drain).unwrap();
        let runner = faked(&startup);
        runtime().block_on(async {
            let tracker = TaskTracker::new();
            let serving =
                tracker.spawn(async move { listen(&startup, QUICK, store, Some(runner)).await });
            let open = b"POST /v1/shells HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 22\r\nconnection: close\r\n\r\n{\"idempotencyKey\":\"o\"}";
            let opened = body_of(&ask(&socket, open).await);
            let doctor = body_of(
                &ask(
                    &socket,
                    b"GET /v1/daemon/doctor HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n",
                )
                .await,
            );
            let health = body_of(
                &ask(
                    &socket,
                    b"GET /v1/health HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n",
                )
                .await,
            );
            ask(&socket, STOP).await;
            let _ = tokio::time::timeout(Duration::from_secs(5), serving).await;
            assert_eq!(opened["eventIds"].as_array().map(Vec::len), Some(2), "{opened}");
            assert_eq!(
                (
                    &doctor["terminals"]["open"],
                    &doctor["terminals"]["max"],
                    &doctor["holder"]["reason"],
                    &doctor["runtimes"],
                    &doctor["web"]["pairing"]["mode"],
                    // Null, not absent: this daemon serves a web client, unbuilt here.
                    doctor["web"].get("app"),
                ),
                (
                    &serde_json::json!(1),
                    &serde_json::json!(3),
                    &serde_json::json!("no build"),
                    &serde_json::json!([
                        {"kind": "tmux", "state": "unused", "version": null, "workarounds": []},
                        {"kind": "holder", "state": "not-running", "version": "holder/1.4", "workarounds": []},
                    ]),
                    &serde_json::json!("auto"),
                    Some(&serde_json::Value::Null),
                ),
                "{doctor}"
            );
            assert_eq!(
                health["runtimes"],
                serde_json::json!([
                    {"kind": "tmux", "state": "unused", "version": null},
                    {"kind": "holder", "state": "not-running", "version": "holder/1.4"},
                ]),
                "{health}"
            );
        });
        writer.finish();
    }

    #[test]
    fn reads_its_shells_foregrounds_each_tick_and_stops_at_once_amid_a_read_that_hangs() {
        let home = TempDir::new("tick");
        let startup = startup(home.path());
        std::fs::create_dir_all(&startup.home).unwrap();
        let socket = PathBuf::from(&startup.paths.socket);
        let (_lock, (store, writer)) = prepare(&startup, QUICK.drain).unwrap();
        let fake = crate::terminals::fake::Fake::default();
        fake.set(|state| state.hold_reads = Some(Arc::new(tokio::sync::Semaphore::new(0))));
        let runner = Runner {
            terminals: Arc::new(fake.clone()),
            ..faked(&startup)
        };
        let ticking = Serving {
            tick: Duration::from_millis(20),
            ..QUICK
        };
        let reads = || fake.state.lock().unwrap().foreground_reads;
        runtime().block_on(async {
            let tracker = TaskTracker::new();
            let serving =
                tracker.spawn(async move { listen(&startup, ticking, store, Some(runner)).await });
            let open = b"POST /v1/shells HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 22\r\nconnection: close\r\n\r\n{\"idempotencyKey\":\"o\"}";
            ask(&socket, open).await;
            let deadline = Instant::now() + Duration::from_secs(5);
            while reads() == 0 {
                assert!(Instant::now() < deadline, "no tick read the foregrounds");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let answer = ask(&socket, STOP).await;
            let asked = Instant::now();
            let reason = tokio::time::timeout(Duration::from_secs(5), serving).await;
            let took = asked.elapsed();
            assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
            assert!(
                matches!(reason, Ok(Ok(Ok(Reason::Requested)))),
                "{reason:?}"
            );
            assert_eq!(reads(), 1);
            assert!(took < QUICK.drain, "{took:?}");
        });
        writer.finish();
    }

    #[test]
    fn tries_again_on_the_next_tick_a_shell_the_start_couldnt_settle() {
        use crate::terminals::fake::{Held, Reach};
        use bazhen_protocol::shells::TerminalState;
        let h = crate::shells::tests::setup(100);
        crate::testing::paused().block_on(async {
            let id = h.opening_unanswered().await;
            h.fake.set(|state| state.reach = Reach::Unreachable);
            h.shells.reconcile().await.unwrap();
            let swept = Held::open();
            h.fake.set(|state| {
                state.reach = Reach::Answers;
                state.hold_compatibility = Some(swept.clone());
            });
            let stop = CancellationToken::new();
            let ticking =
                TaskTracker::new().spawn(every_tick(Arc::clone(&h.shells), TICK, stop.clone()));
            swept.reached().await;
            let after_one_tick = h.state_of(&id);
            stop.cancel();
            ticking.await.unwrap();
            assert_eq!(after_one_tick, Some(TerminalState::Failed));
        });
    }

    #[test]
    fn stops_at_once_amid_a_tick_trying_again_a_shell_the_start_couldnt_settle() {
        use crate::terminals::fake::{Held, Reach};
        use bazhen_protocol::shells::TerminalState;
        let h = crate::shells::tests::setup(100);
        crate::testing::paused().block_on(async {
            let id = h.opening_unanswered().await;
            h.fake.set(|state| state.reach = Reach::Unreachable);
            h.shells.reconcile().await.unwrap();
            let read = Held::shut();
            h.fake.set(|state| {
                state.reach = Reach::Answers;
                state.hold_inventory = Some(read.clone());
            });
            let stop = CancellationToken::new();
            let ticking =
                TaskTracker::new().spawn(every_tick(Arc::clone(&h.shells), TICK, stop.clone()));
            read.reached().await;
            stop.cancel();
            let stopped = tokio::time::timeout(TICK, ticking).await;
            assert!(matches!(stopped, Ok(Ok(()))), "{stopped:?}");
            assert_eq!(h.state_of(&id), Some(TerminalState::Creating));
        });
    }

    #[test]
    fn waits_out_its_drain_for_a_connection_still_sending_its_request_then_stops() {
        let home = TempDir::new("drain");
        let startup = startup(home.path());
        let socket = PathBuf::from(&startup.paths.socket);
        let (_lock, (store, writer)) = prepare(&startup, QUICK.drain).unwrap();
        runtime().block_on(async {
            let tracker = TaskTracker::new();
            let serving = tracker.spawn(async move { listen(&startup, QUICK, store, None).await });
            let mut held = connect(&socket).await;
            held.write_all(b"GET /v1/health HTTP/1.1\r\n")
                .await
                .unwrap();
            let mut stopping = connect(&socket).await;
            // Before the stop is sent, so before the drain can start, however late its answer is
            // read: here 100 ms late, as a test held off the CPU may read it.
            let asked = Instant::now();
            stopping.write_all(STOP).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut answer = Vec::new();
            stopping.read_to_end(&mut answer).await.unwrap();
            let answer = String::from_utf8_lossy(&answer).into_owned();
            let reason = tokio::time::timeout(Duration::from_secs(5), serving).await;
            let took = asked.elapsed();
            assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
            assert!(
                matches!(reason, Ok(Ok(Ok(Reason::Requested)))),
                "{reason:?}"
            );
            assert!(took >= QUICK.drain && took < QUICK.drain * 3, "{took:?}");
        });
        writer.finish();
    }

    #[test]
    fn a_signal_stops_with_its_reason_and_one_after_the_stop_ends_the_drain_instead() {
        let (stop, hurry) = (Stop::default(), CancellationToken::new());
        heard(&stop, &hurry, Reason::Sigterm);
        let first = (
            stop.token().is_cancelled(),
            stop.reason(),
            hurry.is_cancelled(),
        );
        heard(&stop, &hurry, Reason::Sigint);
        let second = (stop.reason(), hurry.is_cancelled());
        assert_eq!(first, (true, Some(Reason::Sigterm), false));
        assert_eq!(second, (Some(Reason::Sigterm), true));
    }

    /// How long `drain` takes over a connection that never ends, with `hurry` cancelled after
    /// `hurried`, if at all.
    fn drained_in(within: Duration, hurried: Option<Duration>) -> Duration {
        runtime().block_on(async {
            let tracker = TaskTracker::new();
            tracker.spawn(std::future::pending::<()>());
            tracker.close();
            let hurry = CancellationToken::new();
            if let Some(after) = hurried {
                let hurry = hurry.clone();
                tracker.spawn(async move {
                    tokio::time::sleep(after).await;
                    hurry.cancel();
                });
            }
            let started = Instant::now();
            let bounded =
                tokio::time::timeout(Duration::from_secs(5), drain(&tracker, within, &hurry));
            assert!(bounded.await.is_ok(), "drained for more than 5 s");
            started.elapsed()
        })
    }

    #[test]
    fn drains_for_no_longer_than_its_limit_and_not_at_all_once_hurried() {
        let limit = Duration::from_millis(400);
        let waited = drained_in(limit, None);
        let hurried = drained_in(limit, Some(Duration::from_millis(50)));
        assert!(waited >= limit && waited < limit * 3, "{waited:?}");
        assert!(hurried < limit, "{hurried:?}");
    }

    #[test]
    fn drains_no_longer_than_its_connections_take() {
        runtime().block_on(async {
            let tracker = TaskTracker::new();
            tracker.spawn(tokio::time::sleep(Duration::from_millis(50)));
            tracker.close();
            let started = Instant::now();
            drain(&tracker, Duration::from_secs(5), &CancellationToken::new()).await;
            assert!(started.elapsed() < Duration::from_secs(1));
        });
    }

    #[test]
    fn makes_its_socket_afresh_for_this_user_alone_and_removes_only_that_one() {
        let dir = TempDir::new("socket");
        let path = dir.path().join("bazhen.sock");
        std::fs::write(&path, "left from before").unwrap();
        let (mode, removed, ours, theirs) = runtime().block_on(async {
            let (_listener, ours) = bind_socket(&path).unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            forget_socket(&path, ours);
            let removed = !path.exists();
            let (_replacement, theirs) = bind_socket(&path).unwrap();
            forget_socket(&path, ours);
            (mode, removed, ours, theirs)
        });
        assert_eq!(mode, 0o600);
        assert!(removed);
        assert_ne!(theirs, ours);
        assert!(path.exists());
    }

    #[test]
    fn refuses_to_start_while_a_daemon_answers_on_its_socket() {
        let home = TempDir::new("running");
        let startup = startup(home.path());
        std::fs::create_dir(&startup.paths.run).unwrap();
        std::fs::set_permissions(&startup.paths.run, std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let listener = std::os::unix::net::UnixListener::bind(&startup.paths.socket).unwrap();
        let answering = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut asked = Vec::new();
            while !asked.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                std::io::Read::read_exact(&mut stream, &mut byte).unwrap();
                asked.push(byte[0]);
            }
            std::io::Write::write_all(
                &mut stream,
                b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
            )
            .unwrap();
        });
        let refused = prepare(&startup, QUICK.drain);
        // Left to end with the test: it waits on a probe forever if prepare never asked.
        drop(answering);
        assert!(
            matches!(&refused, Err(Refused::Running(at)) if *at == startup.paths.socket),
            "{refused:?}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn refuses_to_start_over_a_daemon_that_holds_its_socket_without_answering() {
        let home = TempDir::new("silent");
        let startup = startup(home.path());
        std::fs::create_dir(&startup.paths.run).unwrap();
        std::fs::set_permissions(&startup.paths.run, std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let _stuck = crate::testing::FullBacklog::at(Path::new(&startup.paths.socket));
        let refused = prepare(&startup, QUICK.drain);
        assert!(
            matches!(&refused, Err(Refused::Silent { socket, .. }) if *socket == startup.paths.socket),
            "{refused:?}"
        );
    }

    #[test]
    fn ends_the_views_left_open_by_the_daemon_before_it_as_a_restart_and_frees_the_lease() {
        use bazhen_protocol::events::{AttachmentStarted, LeaseGranted, TerminalOpened};
        use bazhen_protocol::ids::{AttachmentId, TerminalId};
        use bazhen_protocol::stream::AttachmentMode;
        use bazhen_store::{Actor, NewEvent, TerminalChange};
        use rusqlite::OptionalExtension;
        let home = TempDir::new("views-left");
        let startup = startup(home.path());
        std::fs::create_dir_all(&startup.paths.data).unwrap();
        let terminal = TerminalId::mint(1, [3; 16]);
        let laptop = AttachmentId::mint(1, [1; 16]);
        let mut before =
            Store::open(&PathBuf::from(&startup.paths.data).join("bazhen.db")).unwrap();
        before
            .write(|w| -> Result<_, AppendError> {
                let environment = w.local_environment()?;
                w.append(&NewEvent::Terminal {
                    terminal: terminal.clone(),
                    actor: Actor::User,
                    change: TerminalChange::Opened(TerminalOpened {
                        environment_id: environment,
                        cwd: "/home/me".to_owned(),
                        linked_agent_id: None,
                        theme: None,
                        restart_of: None,
                        runtime: Some("holder".to_owned()),
                    }),
                })?;
                w.append(&NewEvent::AttachmentStarted {
                    attachment: laptop.clone(),
                    payload: AttachmentStarted {
                        terminal_id: terminal.clone(),
                        mode: AttachmentMode::Interactive,
                    },
                })?;
                w.append(&NewEvent::LeaseGranted {
                    terminal: terminal.clone(),
                    payload: LeaseGranted {
                        attachment_id: laptop.clone(),
                        epoch: 2,
                    },
                })
            })
            .unwrap();
        drop(before);
        let (_lock, (store, _writer)) = prepare(&startup, QUICK.drain).unwrap();
        let (open, epoch, holder, ended) = runtime().block_on(async {
            store
                .run(move |store| {
                    store.write(|w| -> rusqlite::Result<_> {
                        let holder: Option<String> = w.connection().query_row(
                            "SELECT holder FROM leases WHERE terminal_id = ?",
                            [terminal.as_str()],
                            |row| row.get(0),
                        )?;
                        let ended: Option<String> = w
                            .connection()
                            .query_row(
                                "SELECT payload FROM events WHERE type = 'attachment.ended'
                               AND entity_id = ?",
                                [laptop.as_str()],
                                |row| row.get(0),
                            )
                            .optional()?;
                        Ok((
                            w.reads().open_attachments()?,
                            w.reads().lease_epoch(&terminal)?,
                            holder,
                            ended,
                        ))
                    })
                })
                .await
                .unwrap()
                .unwrap()
        });
        assert_eq!(
            (open, epoch, holder, ended.as_deref()),
            (vec![], 2, None, Some(r#"{"reason":"daemon_restart"}"#))
        );
    }

    #[test]
    fn says_how_many_views_left_open_it_ended_and_nothing_once_none_were() {
        use bazhen_protocol::events::{AttachmentStarted, TerminalOpened};
        use bazhen_protocol::ids::{AttachmentId, TerminalId};
        use bazhen_protocol::stream::AttachmentMode;
        use bazhen_store::{Actor, NewEvent, TerminalChange};
        let said = crate::shells::tests::Said::default();
        let _logging = said.logging();
        let home = TempDir::new("views-counted");
        let startup = startup(home.path());
        std::fs::create_dir_all(&startup.paths.data).unwrap();
        let terminal = TerminalId::mint(1, [3; 16]);
        let mut before =
            Store::open(&PathBuf::from(&startup.paths.data).join("bazhen.db")).unwrap();
        before
            .write(|w| -> Result<_, AppendError> {
                let environment = w.local_environment()?;
                w.append(&NewEvent::Terminal {
                    terminal: terminal.clone(),
                    actor: Actor::User,
                    change: TerminalChange::Opened(TerminalOpened {
                        environment_id: environment,
                        cwd: "/home/me".to_owned(),
                        linked_agent_id: None,
                        theme: None,
                        restart_of: None,
                        runtime: Some("holder".to_owned()),
                    }),
                })?;
                for n in 1..=2 {
                    w.append(&NewEvent::AttachmentStarted {
                        attachment: AttachmentId::mint(1, [n; 16]),
                        payload: AttachmentStarted {
                            terminal_id: terminal.clone(),
                            mode: AttachmentMode::Interactive,
                        },
                    })?;
                }
                Ok(())
            })
            .unwrap();
        drop(before);
        let said_ended = |said: &crate::shells::tests::Said| {
            said.text()
                .lines()
                .filter(|line| line.contains("views left open"))
                .map(|line| line.split_once("bazhen: ").map(|(_, said)| said.to_owned()))
                .collect::<Vec<_>>()
        };
        let first = prepare(&startup, QUICK.drain).unwrap();
        let after_first = said_ended(&said);
        drop(first);
        prepare(&startup, QUICK.drain).unwrap();
        assert_eq!(
            (after_first, said_ended(&said).len()),
            (
                vec![Some(
                    "ended the views left open by the daemon before it views=2".to_owned()
                )],
                1
            )
        );
    }

    #[test]
    fn refuses_to_start_while_another_daemon_holds_the_lock_though_nothing_answers() {
        let home = TempDir::new("held");
        let startup = startup(home.path());
        std::fs::create_dir(&startup.paths.run).unwrap();
        std::fs::set_permissions(&startup.paths.run, std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let lock_file = lock_of(Path::new(&startup.paths.socket));
        let _held = crate::lock::try_lock(&lock_file).unwrap().unwrap();
        let refused = prepare(&startup, QUICK.drain);
        assert!(
            matches!(&refused, Err(Refused::Held { lock, socket })
                if *lock == lock_file && *socket == startup.paths.socket),
            "{refused:?}"
        );
        assert!(!Path::new(&startup.paths.data).join("bazhen.db").exists());
    }

    #[test]
    fn refuses_to_start_on_a_database_it_cant_open() {
        let home = TempDir::new("store");
        let startup = startup(home.path());
        std::fs::create_dir_all(Path::new(&startup.paths.data).join("bazhen.db")).unwrap();
        let refused = prepare(&startup, QUICK.drain);
        assert!(
            matches!(&refused, Err(Refused::Said(said)) if said.contains("bazhen.db")),
            "{refused:?}"
        );
    }

    /// The hub, as far as the route drives it, saying only whether it was closed.
    #[derive(Default)]
    struct Closed(std::sync::atomic::AtomicBool);

    impl crate::stream::route::Views for Closed {
        fn join(
            &self,
            _: bazhen_protocol::ids::TerminalId,
            _: crate::stream::hub::Viewer,
            _: bazhen_holder_proto::body::Size,
            _: Option<bazhen_protocol::stream::Resumes>,
        ) -> crate::terminals::Answer<
            'static,
            Result<crate::stream::hub::Attachment, crate::stream::hub::JoinError>,
        > {
            Box::pin(std::future::ready(Err(
                crate::stream::hub::JoinError::Ended,
            )))
        }

        fn write(&self, _: &bazhen_protocol::ids::TerminalId, _: &AttachmentId, _: &[u8]) {}

        fn engage(&self, _: &bazhen_protocol::ids::TerminalId, _: &AttachmentId) {}

        fn declare_epoch(&self, _: &bazhen_protocol::ids::TerminalId, _: &AttachmentId, _: u64) {}

        fn resize(
            &self,
            _: &bazhen_protocol::ids::TerminalId,
            _: &AttachmentId,
            _: bazhen_holder_proto::body::Size,
        ) {
        }

        fn leave(
            &self,
            _: &bazhen_protocol::ids::TerminalId,
            _: &AttachmentId,
            _: crate::stream::hub::LeaveReason,
        ) {
        }

        fn close(&self) {
            self.0.store(true, std::sync::atomic::Ordering::Release);
        }
    }

    type AttachmentId = bazhen_protocol::ids::AttachmentId;

    // Sandbox-only by name alone: end_terminals also shuts the shells' terminals down, which the
    // signal scan follows to a holder's close; with no shells and a stub hub it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_every_stream_even_when_it_is_told_to_hurry() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let views = Arc::new(Closed::default());
            let streams = crate::stream::route::Streams {
                views: Arc::clone(&views) as Arc<dyn crate::stream::route::Views>,
                running: Arc::new(|_| Box::pin(std::future::ready(Ok(true)))),
                protocol_id: Arc::from("build"),
                closing: crate::stream::closing::ClosingBudget::new(
                    crate::stream::closing::MAX_CLOSING_BYTES,
                ),
                tasks: TaskTracker::new(),
                hub: TaskTracker::new(),
            };
            let hurry = CancellationToken::new();
            hurry.cancel();
            end_terminals(Some(streams), None, Duration::from_secs(60), &hurry).await;
            assert!(views.0.load(std::sync::atomic::Ordering::Acquire));
        });
    }

    #[test]
    fn sweeps_the_token_files_no_agent_will_run_on_again_before_it_serves() {
        let home = TempDir::new("sweep");
        let startup = startup(home.path());
        let agents = Path::new(&startup.paths.run).join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        let unknown = agents.join("agent_0190a1b2c3d47abc8def0123456789ad.0a.token");
        std::fs::write(&unknown, "x").unwrap();
        let (_lock, (store, writer)) = prepare(&startup, QUICK.drain).unwrap();
        drop(store);
        writer.finish();
        assert!(!unknown.exists());
    }

    #[test]
    fn refuses_to_start_on_a_token_directory_it_cant_keep_private() {
        let home = TempDir::new("sweep-link");
        let startup = startup(home.path());
        std::fs::create_dir_all(home.path().join("elsewhere")).unwrap();
        std::fs::create_dir_all(&startup.paths.run).unwrap();
        std::os::unix::fs::symlink(
            home.path().join("elsewhere"),
            Path::new(&startup.paths.run).join("agents"),
        )
        .unwrap();
        let refused = prepare(&startup, QUICK.drain);
        assert!(
            matches!(&refused, Err(Refused::Said(said)) if said.contains("agents") && said.contains("symlink")),
            "{refused:?}"
        );
    }
}
