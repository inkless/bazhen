//! What the daemon's tests share.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::Value;
use tokio::net::{UnixListener, UnixStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

pub(crate) mod stub_harness;

/// What `router` makes of a writer on an empty store of its own, for routes that read the store
/// but need nothing in it, as the guard does to read a caller over `connected`. The router keeps
/// the store's directory until it is dropped.
pub(crate) fn on_an_empty_store(
    router: impl FnOnce(crate::writer::Writer) -> axum::Router,
) -> axum::Router {
    let dir = TempDir::new("empty-store");
    let path = dir.path().join("bazhen.db");
    let (writer, _thread) =
        crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
    router(writer).layer(axum::Extension(std::sync::Arc::new(dir)))
}

/// `router` as the loopback listener serves it: each request carries its connection's socket, as
/// `accept` gives it. Here that is one end of a pair this test holds both ends of, so the caller
/// reads as the test's own process, outside every terminal: the human.
pub(crate) fn connected(router: axum::Router) -> axum::Router {
    let ends = std::sync::Arc::new(std::os::unix::net::UnixStream::pair().unwrap());
    router.layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            request
                .extensions_mut()
                .insert(crate::peer::PeerSocket::accepted_now(
                    std::os::fd::AsFd::as_fd(&ends.0),
                ));
            next.run(request)
        },
    ))
}

/// A directory of the test's own, removed when the test ends, whether or not it passed.
pub(crate) struct TempDir(PathBuf);

impl TempDir {
    pub(crate) fn new(name: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("bz-daemon-{name}-{}-{n}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // A directory left in the temp dir costs nothing a test would see.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// A runtime whose clock moves only as its timers come due, once nothing else can run.
pub(crate) fn paused() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap()
}

/// A listener at a socket that never accepts, its one-place backlog taken by a connection of its
/// own, so a connect there waits as it would on a daemon stuck with a full backlog. Linux only:
/// macOS refuses such a connect, as it does one to a socket nothing listens on.
#[cfg(target_os = "linux")]
pub(crate) struct FullBacklog {
    _listener: std::os::unix::net::UnixListener,
    _queued: std::os::unix::net::UnixStream,
}

#[cfg(target_os = "linux")]
impl FullBacklog {
    pub(crate) fn at(socket: &Path) -> Self {
        let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        // Linux takes a second listen as the backlog's new length.
        rustix::net::listen(&listener, 0).unwrap();
        Self {
            _listener: listener,
            _queued: std::os::unix::net::UnixStream::connect(socket).unwrap(),
        }
    }
}

/// `test` within `limit`, so a test that would wait forever on a reply fails instead.
pub(crate) async fn within<T>(limit: Duration, test: impl Future<Output = T>) -> T {
    tokio::time::timeout(limit, test)
        .await
        .unwrap_or_else(|_| panic!("the test still waits after {limit:?}"))
}

pub(crate) async fn bounded<T>(test: impl Future<Output = T>) -> T {
    within(Duration::from_secs(5), test).await
}

/// A server's side of one connection: a WebSocket it accepted.
pub(crate) type Server = WebSocketStream<UnixStream>;

pub(crate) async fn accepted(listener: &UnixListener) -> Server {
    let (stream, _) = listener.accept().await.unwrap();
    tokio_tungstenite::accept_async(stream).await.unwrap()
}

/// The next message the client sent.
pub(crate) async fn heard(server: &mut Server) -> Value {
    loop {
        if let Message::Text(text) = server.next().await.unwrap().unwrap() {
            return serde_json::from_str(text.as_str()).unwrap();
        }
    }
}

pub(crate) async fn say(server: &mut Server, value: Value) {
    server.send(Message::text(value.to_string())).await.unwrap();
}
