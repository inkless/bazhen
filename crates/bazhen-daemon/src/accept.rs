//! Each listener's connections, served under the limits Node's HTTP server keeps by default, so a
//! client that sends slowly, sends too much, or opens connections without end can't hold the
//! daemon: axum's own `serve` has no timer at all.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::http::{HeaderValue, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::serve::Listener;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tokio_util::task::task_tracker::TaskTrackerToken;
use tower::ServiceExt;

use crate::peer::PeerSocket;

/// What a listener allows each connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Limits {
    /// Node's `headersTimeout`: how long a request's head may take to arrive, timed from when
    /// the connection is ready for one, so an idle connection is closed after it too.
    pub(crate) head: Duration,
    /// Node's `requestTimeout`: how long a request may take to be answered, its body read
    /// included, before it is answered 408. `None` for none, as the TypeScript daemon's socket
    /// sets it to 0.
    pub(crate) request: Option<Duration>,
    /// Node's `maxHeaderSize`: a request whose head, its start line included, is longer is
    /// answered 431.
    pub(crate) head_bytes: usize,
    /// How many connections are served at once. A later one waits in the backlog until one
    /// ends, so connections to one listener can't take the descriptors the other needs.
    pub(crate) connections: usize,
}

/// The loopback HTTP listener's limits: Node's defaults.
pub(crate) const HTTP: Limits = Limits {
    head: Duration::from_secs(60),
    request: Some(Duration::from_secs(300)),
    head_bytes: 16 * 1024,
    connections: 128,
};

/// The socket's limits: HTTP's, with no request timeout, as `main.ts` sets for its socket.
pub(crate) const SOCKET: Limits = Limits {
    request: None,
    ..HTTP
};

/// A connection's place under its listener's cap and in its tracker, which every request on it
/// carries: a WebSocket route moves it into the task its upgraded socket runs in, so the socket
/// counts against the cap and the drain until it closes, not just until the upgrade.
#[derive(Debug, Clone)]
pub(crate) struct Held {
    _place: Arc<(OwnedSemaphorePermit, TaskTrackerToken)>,
}

/// Whether a connection's request is held open for its answer, as a waiter is. When the daemon
/// stops, a held connection is dropped unanswered, so its client asks again of the next daemon;
/// one that answered quiet would end its client instead.
#[derive(Debug, Clone)]
pub(crate) struct Holdable(Arc<watch::Sender<bool>>);

/// A request held open, until it is dropped.
#[derive(Debug)]
pub(crate) struct Holding(Arc<watch::Sender<bool>>);

impl Holdable {
    pub(crate) fn hold(&self) -> Holding {
        self.0.send_replace(true);
        Holding(Arc::clone(&self.0))
    }
}

impl Drop for Holding {
    fn drop(&mut self) {
        self.0.send_replace(false);
    }
}

/// A connection's own socket, kept for its requests to read who is at the other end: a Unix
/// socket's, which the kernel names the peer of; none for TCP, whose callers are paired instead.
pub(crate) trait Connected {
    fn peer(&self) -> Option<PeerSocket>;
}

impl Connected for tokio::net::TcpStream {
    fn peer(&self) -> Option<PeerSocket> {
        None
    }
}

impl Connected for tokio::net::UnixStream {
    fn peer(&self) -> Option<PeerSocket> {
        Some(PeerSocket::accepted_now(std::os::fd::AsFd::as_fd(self)))
    }
}

/// Serves `router` on `listener` until `stop`. Then it stops accepting, calls `stopped` while it
/// still listens, so a socket file `stopped` removes never refuses a connection, closes the
/// listener, and asks each open connection to end once it has answered the request it is on; an
/// upgraded one is its route's to end. Every connection is a task on `tracker`, so waiting on it
/// waits on them, and every request on a Unix connection carries its `PeerSocket`.
pub(crate) async fn serve_on<L>(
    mut listener: L,
    router: Router,
    limits: Limits,
    stop: CancellationToken,
    tracker: TaskTracker,
    stopped: impl FnOnce(),
) where
    L: Listener,
    L::Io: Connected,
{
    let open = Arc::new(Semaphore::new(limits.connections));
    loop {
        let Some(Ok(permit)) = stop
            .run_until_cancelled(Arc::clone(&open).acquire_owned())
            .await
        else {
            break;
        };
        let Some((io, _)) = stop.run_until_cancelled(listener.accept()).await else {
            break;
        };
        let router = router.clone();
        let held = Held {
            _place: Arc::new((permit, tracker.token())),
        };
        let peer = io.peer();
        let holding = Arc::new(watch::channel(false).0);
        let holdable = Holdable(Arc::clone(&holding));
        let service = service_fn(move |mut request: Request<Incoming>| {
            request.extensions_mut().insert(held.clone());
            request.extensions_mut().insert(holdable.clone());
            if let Some(peer) = &peer {
                request.extensions_mut().insert(peer.clone());
            }
            answer(router.clone(), limits.request, request)
        });
        let connection = http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(limits.head)
            .max_header_size(limits.head_bytes)
            .serve_connection(TokioIo::new(io), service)
            .with_upgrades();
        let stopping = stop.clone();
        tracker.spawn(async move {
            let mut connection = std::pin::pin!(connection);
            // A connection that fails, as one the client drops does, has no one to tell.
            tokio::select! {
                _ = connection.as_mut() => return,
                () = stopping.cancelled() => connection.as_mut().graceful_shutdown(),
            }
            let mut held = holding.subscribe();
            tokio::select! {
                _ = connection => {}
                // Dropped, the connection ends with no answer.
                _ = held.wait_for(|held| *held) => {}
            }
        });
    }
    stopped();
    drop(listener);
}

/// `request`'s answer from `router`, or 408 if it isn't answered within `limit`.
async fn answer(
    router: Router,
    limit: Option<Duration>,
    request: Request<Incoming>,
) -> Result<Response, Infallible> {
    let answered = router.oneshot(request);
    let Some(limit) = limit else {
        return answered.await;
    };
    Ok(tokio::time::timeout(limit, answered)
        .await
        .unwrap_or_else(|_| Ok(timed_out()))
        .unwrap_or_else(|never: Infallible| match never {}))
}

/// Node's answer to a request that took too long: 408, and the connection closed.
fn timed_out() -> Response {
    (
        StatusCode::REQUEST_TIMEOUT,
        [(header::CONNECTION, HeaderValue::from_static("close"))],
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use axum::Extension;
    use axum::body::Bytes;
    use axum::extract::WebSocketUpgrade;
    use axum::routing::{get, post};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;

    const SHORT: Limits = Limits {
        head: Duration::from_millis(300),
        request: Some(Duration::from_millis(300)),
        head_bytes: 16 * 1024,
        connections: 1,
    };

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// A listener on loopback serving `/` and `/echo`, which reads the whole body, under
    /// `limits`, and its address.
    async fn serving(limits: Limits) -> (std::net::SocketAddr, CancellationToken, TaskTracker) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/", get(|| async { "ok" }))
            .route("/echo", post(|body: Bytes| async move { body }))
            .route("/ws", get(held_open));
        let stop = CancellationToken::new();
        let tracker = TaskTracker::new();
        tracker.spawn(serve_on(
            listener,
            router,
            limits,
            stop.clone(),
            tracker.clone(),
            || {},
        ));
        (address, stop, tracker)
    }

    /// A WebSocket that holds its connection's place until the client closes it.
    async fn held_open(ws: WebSocketUpgrade, Extension(held): Extension<Held>) -> Response {
        ws.on_upgrade(move |mut socket| async move {
            let _held = held;
            while let Some(Ok(_)) = socket.recv().await {}
        })
    }

    const UPGRADE: &[u8] =
        b"GET /ws HTTP/1.1\r\nhost: x\r\nconnection: upgrade\r\nupgrade: websocket\r\n\
        sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";

    /// A WebSocket to `/ws`, once its upgrade is answered.
    async fn upgraded(address: std::net::SocketAddr) -> TcpStream {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(UPGRADE).await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(stream.read_u8().await.unwrap());
        }
        assert!(
            head.starts_with(b"HTTP/1.1 101 "),
            "{}",
            String::from_utf8_lossy(&head)
        );
        stream
    }

    #[test]
    fn counts_an_upgraded_socket_against_its_limit_until_it_closes() {
        runtime().block_on(async {
            let (address, _stop, _tracker) = serving(HTTP).await;
            let mut sockets = Vec::new();
            for _ in 0..HTTP.connections {
                sockets.push(upgraded(address).await);
            }
            let mut next = TcpStream::connect(address).await.unwrap();
            next.write_all(GET).await.unwrap();
            assert_eq!(read_for(&mut next, Duration::from_millis(300)).await, "");
            drop(sockets.pop());
            let answer = read_for(&mut next, Duration::from_secs(5)).await;
            assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
        });
    }

    #[test]
    fn drains_an_upgraded_socket_as_a_connection_until_it_closes() {
        runtime().block_on(async {
            let (address, stop, tracker) = serving(SHORT).await;
            let socket = upgraded(address).await;
            stop.cancel();
            tracker.close();
            let drained = tokio::time::timeout(Duration::from_millis(300), tracker.wait()).await;
            assert!(drained.is_err(), "drained with a socket open");
            drop(socket);
            tokio::time::timeout(Duration::from_secs(5), tracker.wait())
                .await
                .unwrap();
        });
    }

    /// What the server sends on `stream` until it closes it, or what it sent by `within`.
    async fn read_for(stream: &mut TcpStream, within: Duration) -> String {
        let mut got = Vec::new();
        let _ = tokio::time::timeout(within, stream.read_to_end(&mut got)).await;
        String::from_utf8_lossy(&got).into_owned()
    }

    const GET: &[u8] = b"GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n";

    #[test]
    fn closes_a_connection_whose_head_takes_too_long_and_answers_one_that_doesnt() {
        runtime().block_on(async {
            let (address, _stop, _tracker) = serving(SHORT).await;
            let mut slow = TcpStream::connect(address).await.unwrap();
            slow.write_all(b"GET / HTTP/1.1\r\nhost: x\r\n")
                .await
                .unwrap();
            let started = Instant::now();
            let said = read_for(&mut slow, Duration::from_secs(5)).await;
            let waited = started.elapsed();
            assert!(!said.contains("200 OK"), "{said}");
            assert!(waited < Duration::from_secs(2), "{waited:?}");
            let mut quick = TcpStream::connect(address).await.unwrap();
            quick.write_all(GET).await.unwrap();
            let said = read_for(&mut quick, Duration::from_secs(5)).await;
            assert!(said.starts_with("HTTP/1.1 200 OK"), "{said}");
        });
    }

    #[test]
    fn answers_408_to_a_request_whose_body_takes_too_long() {
        runtime().block_on(async {
            let (address, _stop, _tracker) = serving(SHORT).await;
            let mut slow = TcpStream::connect(address).await.unwrap();
            slow.write_all(b"POST /echo HTTP/1.1\r\nhost: x\r\ncontent-length: 10\r\n\r\nabc")
                .await
                .unwrap();
            let said = read_for(&mut slow, Duration::from_secs(5)).await;
            assert!(said.starts_with("HTTP/1.1 408"), "{said}");
        });
    }

    #[test]
    fn answers_a_request_on_a_listener_without_a_request_limit_however_long_it_takes() {
        runtime().block_on(async {
            let (address, _stop, _tracker) = serving(Limits {
                request: None,
                head: Duration::from_secs(5),
                ..SHORT
            })
            .await;
            let mut slow = TcpStream::connect(address).await.unwrap();
            slow.write_all(b"POST /echo HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: 6\r\n\r\nabc")
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(600)).await;
            slow.write_all(b"def").await.unwrap();
            let said = read_for(&mut slow, Duration::from_secs(5)).await;
            assert!(said.starts_with("HTTP/1.1 200 OK"), "{said}");
            assert!(said.ends_with("abcdef"), "{said}");
        });
    }

    #[test]
    fn answers_431_to_a_head_longer_than_its_limit() {
        runtime().block_on(async {
            let (address, _stop, _tracker) = serving(SHORT).await;
            let mut long = TcpStream::connect(address).await.unwrap();
            let padding = "a".repeat(20 * 1024);
            let request = format!("GET / HTTP/1.1\r\nhost: x\r\nx-pad: {padding}\r\n\r\n");
            // The server may answer and close before it has read it all.
            let _ = long.write_all(request.as_bytes()).await;
            let said = read_for(&mut long, Duration::from_secs(5)).await;
            assert!(said.starts_with("HTTP/1.1 431"), "{said}");
        });
    }

    #[test]
    fn serves_no_more_connections_at_once_than_its_limit() {
        runtime().block_on(async {
            let (address, _stop, _tracker) = serving(Limits {
                head: Duration::from_secs(5),
                ..SHORT
            })
            .await;
            let mut first = TcpStream::connect(address).await.unwrap();
            first
                .write_all(b"GET / HTTP/1.1\r\nhost: x\r\n\r\n")
                .await
                .unwrap();
            let mut answer = [0; 15];
            first.read_exact(&mut answer).await.unwrap();
            assert_eq!(&answer, b"HTTP/1.1 200 OK");
            let mut second = TcpStream::connect(address).await.unwrap();
            second.write_all(GET).await.unwrap();
            let while_first_open = read_for(&mut second, Duration::from_millis(500)).await;
            drop(first);
            let after = read_for(&mut second, Duration::from_secs(5)).await;
            assert_eq!(while_first_open, "");
            assert!(after.starts_with("HTTP/1.1 200 OK"), "{after}");
        });
    }

    #[test]
    fn stops_accepting_at_the_stop_says_so_and_lets_an_open_request_finish() {
        runtime().block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let router = Router::new().route("/echo", post(|body: Bytes| async move { body }));
            let stop = CancellationToken::new();
            let tracker = TaskTracker::new();
            let (told, heard) = tokio::sync::oneshot::channel();
            let serving = tracker.spawn(serve_on(
                listener,
                router,
                // Room for another, so the stop finds it waiting on the accept.
                Limits {
                    head: Duration::from_secs(5),
                    request: None,
                    connections: 2,
                    ..SHORT
                },
                stop.clone(),
                tracker.clone(),
                move || {
                    let _ = told.send(());
                },
            ));
            let mut open = TcpStream::connect(address).await.unwrap();
            open.write_all(b"POST /echo HTTP/1.1\r\nhost: x\r\ncontent-length: 6\r\n\r\nabc")
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            stop.cancel();
            let said_so = tokio::time::timeout(Duration::from_secs(5), heard).await;
            assert!(matches!(said_so, Ok(Ok(()))), "{said_so:?}");
            tokio::time::timeout(Duration::from_secs(5), serving)
                .await
                .unwrap()
                .unwrap();
            assert!(TcpStream::connect(address).await.is_err());
            open.write_all(b"def").await.unwrap();
            let said = read_for(&mut open, Duration::from_secs(5)).await;
            assert!(said.ends_with("abcdef"), "{said}");
            tracker.close();
            tokio::time::timeout(Duration::from_secs(5), tracker.wait())
                .await
                .unwrap();
        });
    }

    #[test]
    fn calls_stopped_while_its_socket_still_takes_a_connection() {
        let dir = crate::testing::TempDir::new("stopped-listening");
        let path = dir.path().join("s.sock");
        let mut connected = None;
        runtime().block_on(async {
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            let stop = CancellationToken::new();
            stop.cancel();
            serve_on(
                listener,
                Router::new(),
                SOCKET,
                stop,
                TaskTracker::new(),
                || connected = Some(std::os::unix::net::UnixStream::connect(&path).map(drop)),
            )
            .await;
        });
        assert!(matches!(connected, Some(Ok(()))), "{connected:?}");
    }

    /// `/peer` answers who is at the other end of its connection, or `none` for no socket kept.
    fn peered() -> Router {
        Router::new().route(
            "/peer",
            get(|peer: Option<Extension<PeerSocket>>| async move {
                let Some(Extension(peer)) = peer else {
                    return "none".to_owned();
                };
                match crate::peer::Peers::default().read(&peer).await {
                    crate::peer::PeerRead::Read(read) => read.pid.as_raw_pid().to_string(),
                    other => format!("{other:?}"),
                }
            }),
        )
    }

    async fn peer_said(
        mut stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    ) -> String {
        stream
            .write_all(b"GET /peer HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        answer.rsplit("\r\n").next().unwrap_or_default().to_owned()
    }

    #[test]
    fn gives_each_request_on_a_unix_connection_its_socket_to_read_the_peer_of_and_tcps_none() {
        let dir = crate::testing::TempDir::new("peered");
        let path = dir.path().join("s.sock");
        runtime().block_on(async {
            let stop = CancellationToken::new();
            let tracker = TaskTracker::new();
            let unix = tokio::net::UnixListener::bind(&path).unwrap();
            let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = tcp.local_addr().unwrap();
            tracker.spawn(serve_on(
                unix,
                peered(),
                SOCKET,
                stop.clone(),
                tracker.clone(),
                || {},
            ));
            tracker.spawn(serve_on(
                tcp,
                peered(),
                HTTP,
                stop.clone(),
                tracker.clone(),
                || {},
            ));
            let unix = tokio::net::UnixStream::connect(&path).await.unwrap();
            let tcp = TcpStream::connect(address).await.unwrap();
            assert_eq!(
                [peer_said(unix).await, peer_said(tcp).await],
                [std::process::id().to_string(), "none".to_owned()]
            );
            stop.cancel();
        });
    }
}
