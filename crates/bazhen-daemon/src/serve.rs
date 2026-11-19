//! The daemon in the foreground, as `apps/daemon/src/main.ts` starts and stops it: make the home's
//! directories, refuse a second daemon, open the store, then serve the socket and loopback HTTP
//! until a signal or a stop.

use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use bazhen_client::paths::Paths;
use bazhen_store::{OpenError, Store};
use tokio::net::{TcpListener, UnixListener};
use tokio::signal::unix::{SignalKind, signal};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::accept::{self, Limits, serve_on};
use crate::guard;
use crate::private_dir::ensure_private_dir;
use crate::probe::{Answer, probe};
use crate::routes::{self, Gate, Reason, Shared, Stop};

/// How the daemon serves: each listener's limits, and how long its connections get to finish once
/// a stop is asked for.
#[derive(Debug, Clone, Copy)]
struct Serving {
    http: Limits,
    socket: Limits,
    drain: Duration,
}

const SERVING: Serving = Serving {
    http: accept::HTTP,
    socket: accept::SOCKET,
    drain: Duration::from_secs(5),
};

/// What serving needs from the settings.
#[derive(Debug, Clone)]
pub(crate) struct Startup {
    pub(crate) paths: Paths,
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
    #[error("{0}")]
    Said(String),
}

/// Runs the daemon until it is stopped.
pub(crate) fn serve(startup: &Startup) -> ExitCode {
    match prepare(startup).and_then(|store| run(startup, store)) {
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

/// Everything before the daemon serves: its directories, a private `run`, no daemon already on
/// the socket, and the store, migrated.
fn prepare(startup: &Startup) -> Result<Store, Refused> {
    let p = &startup.paths;
    for dir in [&p.config, &p.data, &p.bank, &p.state, &p.cache] {
        std::fs::create_dir_all(dir)
            .map_err(|err| Refused::Said(format!("bazhen can't create {dir}: {err}")))?;
    }
    ensure_private_dir(Path::new(&p.run), startup.uid).map_err(|e| Refused::Said(e.to_string()))?;
    // Its socket is about to be replaced; a daemon still answering on it would be orphaned, with
    // its store shared.
    if probe(Path::new(&p.socket)) != Answer::Nothing {
        return Err(Refused::Running(p.socket.clone()));
    }
    let path = PathBuf::from(&p.data).join("bazhen.db");
    let store = Store::open(&path).map_err(|err| match err {
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
    Ok(store)
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
fn run(startup: &Startup, store: Store) -> Result<Reason, Refused> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| Refused::Said(format!("bazhen can't start its runtime: {err}")))?;
    let reason = runtime.block_on(listen(startup, SERVING))?;
    drop(store);
    Ok(reason)
}

/// Serves the socket and loopback HTTP until a stop, then drains them, and says why it stopped.
async fn listen(startup: &Startup, serving: Serving) -> Result<Reason, Refused> {
    let stop = Stop::default();
    let hurry = CancellationToken::new();
    let hearing = TaskTracker::new();
    hear_signals(&hearing, &stop, &hurry)?;
    let shared = Shared::new(bazhen_protocol::id::PROTOCOL_ID, stop.clone());
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
    tracing::info!(
        "bazhen daemon listening on {url} (data: {})",
        startup.paths.data
    );
    let path = PathBuf::from(&startup.paths.socket);
    let (socket, made) = bind_socket(&path)?;

    let tracker = TaskTracker::new();
    let token = stop.token();
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
    Ok(stop.reason().unwrap_or(Reason::Requested))
}

/// Waits for the listeners' connections to end, for no longer than `within`, and no longer at all
/// once `hurry` is cancelled. A connection that won't finish, such as a stream, is left to the
/// exit.
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

/// Removes the socket file once the daemon no longer listens on it, as Node's close does, so it
/// doesn't outlive the daemon; but only the one it made, not one a daemon started since has.
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

    /// A directory of the test's own, removed when the test ends, whether or not it passed.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("bz-serve-{name}-{}-{n}", std::process::id()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            // A directory left in the temp dir costs nothing a test would see.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn startup(home: &Path) -> Startup {
        let at = |name: &str| home.join(name).to_string_lossy().into_owned();
        Startup {
            paths: Paths {
                config: at("config"),
                data: at("data"),
                bank: at("bank"),
                state: at("state"),
                cache: at("cache"),
                run: at("run"),
                socket: at("run/bazhen.sock"),
            },
            uid: rustix::process::getuid().as_raw(),
            port: 0,
            web_port: None,
            external_origins: Vec::new(),
            external_origins_from: None,
            pairing: "auto",
            pairing_required: false,
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
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
        let startup = startup(&home.0);
        let socket = PathBuf::from(&startup.paths.socket);
        let _store = prepare(&startup).unwrap();
        runtime().block_on(async {
            let tracker = TaskTracker::new();
            let serving = tracker.spawn(async move { listen(&startup, QUICK).await });
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
    }

    #[test]
    fn waits_out_its_drain_for_a_connection_still_sending_its_request_then_stops() {
        let home = TempDir::new("drain");
        let startup = startup(&home.0);
        let socket = PathBuf::from(&startup.paths.socket);
        let _store = prepare(&startup).unwrap();
        runtime().block_on(async {
            let tracker = TaskTracker::new();
            let serving = tracker.spawn(async move { listen(&startup, QUICK).await });
            let mut held = connect(&socket).await;
            held.write_all(b"GET /v1/health HTTP/1.1\r\n")
                .await
                .unwrap();
            let answer = ask(&socket, STOP).await;
            let asked = Instant::now();
            let reason = tokio::time::timeout(Duration::from_secs(5), serving).await;
            let took = asked.elapsed();
            assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
            assert!(
                matches!(reason, Ok(Ok(Ok(Reason::Requested)))),
                "{reason:?}"
            );
            assert!(took >= QUICK.drain && took < QUICK.drain * 3, "{took:?}");
        });
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
        let path = dir.0.join("bazhen.sock");
        std::fs::write(&path, "left from before").unwrap();
        let ours = runtime().block_on(async {
            let (_listener, made) = bind_socket(&path).unwrap();
            made
        });
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        // Kept linked, so the next socket can't be given its inode.
        std::fs::hard_link(&path, dir.0.join("kept")).unwrap();
        forget_socket(&path, ours);
        let removed = !path.exists();
        let theirs = runtime().block_on(async { bind_socket(&path).unwrap().1 });
        forget_socket(&path, ours);
        assert_eq!(mode, 0o600);
        assert!(removed);
        assert_ne!(theirs, ours);
        assert!(path.exists());
    }

    #[test]
    fn refuses_to_start_while_a_daemon_answers_on_its_socket() {
        let home = TempDir::new("running");
        let startup = startup(&home.0);
        std::fs::create_dir(&startup.paths.run).unwrap();
        std::fs::set_permissions(&startup.paths.run, std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let listener = std::os::unix::net::UnixListener::bind(&startup.paths.socket).unwrap();
        let answering = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            std::io::Write::write_all(
                &mut stream,
                b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
            )
            .unwrap();
        });
        let refused = prepare(&startup);
        // Left to end with the test: it waits on a probe forever if prepare never asked.
        drop(answering);
        assert!(
            matches!(&refused, Err(Refused::Running(at)) if *at == startup.paths.socket),
            "{refused:?}"
        );
    }

    #[test]
    fn refuses_to_start_on_a_database_it_cant_open() {
        let home = TempDir::new("store");
        let startup = startup(&home.0);
        std::fs::create_dir_all(Path::new(&startup.paths.data).join("bazhen.db")).unwrap();
        let refused = prepare(&startup);
        assert!(
            matches!(&refused, Err(Refused::Said(said)) if said.contains("bazhen.db")),
            "{refused:?}"
        );
    }
}
