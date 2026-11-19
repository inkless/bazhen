//! The daemon in the foreground, as `apps/daemon/src/main.ts` starts and stops it: make the home's
//! directories, refuse a second daemon, open the store, then serve the socket and loopback HTTP
//! until a signal or a stop.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use bazhen_client::paths::Paths;
use bazhen_store::{OpenError, Store};
use tokio::net::{TcpListener, UnixListener};
use tokio::signal::unix::{SignalKind, signal};
use tokio_util::task::TaskTracker;

use crate::guard;
use crate::private_dir::ensure_private_dir;
use crate::probe::{Answer, probe};
use crate::routes::{self, Gate, Reason, Shared, Stop};

/// How long the listeners get to finish the connections they have once a stop is asked for.
const DRAIN: Duration = Duration::from_secs(5);

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
    let reason = runtime.block_on(listen(startup))?;
    drop(store);
    Ok(reason)
}

async fn listen(startup: &Startup) -> Result<Reason, Refused> {
    let stop = Stop::default();
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
    let socket = bind_socket(Path::new(&startup.paths.socket))?;

    let tracker = TaskTracker::new();
    let token = stop.token().clone();
    tracker.spawn(
        axum::serve(http, routes::http_router(shared.clone(), gate))
            .with_graceful_shutdown(token.clone().cancelled_owned())
            .into_future(),
    );
    tracker.spawn(
        axum::serve(socket, routes::socket_router(shared))
            .with_graceful_shutdown(token.clone().cancelled_owned())
            .into_future(),
    );
    stop_on_signals(&tracker, &stop)?;
    tracker.close();
    token.cancelled().await;
    // A connection that won't finish, such as a stream, is left to the exit.
    let _ = tokio::time::timeout(DRAIN, tracker.wait()).await;
    Ok(stop.reason().unwrap_or(Reason::Requested))
}

/// The socket, made afresh and readable and writable by this user only.
fn bind_socket(path: &Path) -> Result<UnixListener, Refused> {
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
    Ok(listener)
}

/// SIGTERM and SIGINT stop the daemon, each said as the reason. Each listener ends with the stop,
/// whichever asked for it, so the drain waits on it no longer than that.
fn stop_on_signals(tracker: &TaskTracker, stop: &Stop) -> Result<(), Refused> {
    for (kind, reason) in [
        (SignalKind::terminate(), Reason::Sigterm),
        (SignalKind::interrupt(), Reason::Sigint),
    ] {
        let mut received = signal(kind).map_err(|err| {
            Refused::Said(format!("bazhen can't hear {}: {err}", reason.as_str()))
        })?;
        let stop = stop.clone();
        tracker.spawn(async move {
            let heard = stop.token().run_until_cancelled(received.recv()).await;
            if heard.flatten().is_some() {
                stop.now(reason);
            }
        });
    }
    Ok(())
}
