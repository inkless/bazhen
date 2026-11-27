//! One connection to a harness's server: JSON-RPC over a WebSocket on its Unix socket. One task
//! owns the socket. It writes what the daemon sends, settles each request with its reply, and hands
//! the server's own requests and notifications to the connection's [`Inbox`]. The server may exit
//! without a close frame, so the socket ending is the disconnect, and every request still waiting
//! fails then. A server that stops reading, or floods the inbox, is disconnected too: the
//! connection never waits on the server without end, nor holds without bound what it sent.
//!
//! Messages carry no `jsonrpc` member: the servers this talks to send none and need none.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bazhen_harness::{BoxFuture, ChannelError, ChannelErrorKind, ChannelPort};
use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{Map, Number, Value};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

/// How long the socket may take to connect and upgrade to a WebSocket.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// How long one request may wait for its reply.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long one message may take to write: a server that reads nothing for this long is gone.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// The server's own messages the inbox holds unread; one more disconnects the server. The daemon
/// reads them as they come, as the TypeScript daemon handled each before reading the next.
pub const INBOX_CAPACITY: usize = 4096;
/// The largest message, and frame, the server may send: what the TypeScript daemon's `ws` client
/// took (its 100 MiB `maxPayload`), so a thread's whole history that it read is never refused.
/// tungstenite's own defaults, 64 MiB and 16 MiB, are less.
const MAX_MESSAGE: usize = 100 * 1024 * 1024;

/// The `data.reason` a server gives its errors while it drains before it exits.
const DRAINING: &str = "serverShuttingDown";

/// The JSON-RPC errors that say the server can't take a request as it was sent: invalid request,
/// method not found and invalid params.
const REFUSALS: [f64; 3] = [-32600.0, -32601.0, -32602.0];

/// The id the server gives one of its own requests, answered as it came.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestId {
    Number(Number),
    Text(String),
}

impl From<RequestId> for Value {
    fn from(id: RequestId) -> Self {
        match id {
            RequestId::Number(n) => Value::Number(n),
            RequestId::Text(text) => Value::String(text),
        }
    }
}

/// What the server sends of its own accord.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    /// A request the server waits on, which [`Rpc::respond`] answers on the same connection.
    Request {
        id: RequestId,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
}

/// A JSON-RPC error, as the server sent it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerError {
    pub code: Number,
    pub message: String,
    /// The `data.reason` some servers add, when it is text.
    pub reason: Option<String>,
}

/// One text frame from the server, as [`decode`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// The reply to the daemon's request `id`: its result, or the server's error.
    Reply {
        id: u64,
        outcome: Result<Value, ServerError>,
    },
    Inbound(Inbound),
}

/// Reads one text frame. A frame with a `method` is the server's own: a request when it has an id,
/// a number or a string, and a notification when it has none. Any other frame is a reply. `None`
/// for a frame that is neither, which is dropped, as is a reply to an id the daemon never sent.
pub fn decode(text: &str) -> Option<Frame> {
    let Ok(Value::Object(mut fields)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    if let Some(method) = fields.remove("method") {
        let Value::String(method) = method else {
            return None;
        };
        let params = fields.remove("params");
        let inbound = match fields.remove("id") {
            None => Inbound::Notification { method, params },
            Some(Value::Number(n)) => Inbound::Request {
                id: RequestId::Number(n),
                method,
                params,
            },
            Some(Value::String(text)) => Inbound::Request {
                id: RequestId::Text(text),
                method,
                params,
            },
            Some(_) => return None,
        };
        return Some(Frame::Inbound(inbound));
    }
    let id = fields.get("id")?.as_u64()?;
    let outcome = match fields.remove("error") {
        None => Ok(fields.remove("result").unwrap_or(Value::Null)),
        Some(error) => Err(server_error(error)?),
    };
    Some(Frame::Reply { id, outcome })
}

fn server_error(error: Value) -> Option<ServerError> {
    let Value::Object(mut error) = error else {
        return None;
    };
    let Some(Value::Number(code)) = error.remove("code") else {
        return None;
    };
    let Some(Value::String(message)) = error.remove("message") else {
        return None;
    };
    let reason = match error.get("data").and_then(|data| data.get("reason")) {
        Some(Value::String(reason)) => Some(reason.clone()),
        _ => None,
    };
    Some(ServerError {
        code,
        message,
        reason,
    })
}

/// A request that got no result.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RpcError {
    /// The server answered it with an error.
    #[error("{method}: {} ({})", error.message, error.code)]
    Server { method: String, error: ServerError },
    /// No reply came within [`REQUEST_TIMEOUT`].
    #[error("{method}: no reply in {ms} ms", ms = REQUEST_TIMEOUT.as_millis())]
    TimedOut { method: String },
    /// The connection ended while it waited.
    #[error("{method}: the connection ended")]
    Ended { method: String },
    /// The connection had already ended.
    #[error("{method}: the server is not connected")]
    NotOpen { method: String },
}

impl RpcError {
    /// Whether the server is draining before it exits: the request belongs to the server that
    /// comes next.
    pub fn draining(&self) -> bool {
        matches!(self, Self::Server { error, .. } if error.reason.as_deref() == Some(DRAINING))
    }

    /// Whether the server can't take the request as it was sent, so sending it again won't help.
    /// A draining server's error never is one: the next server may take it.
    pub fn refused(&self) -> bool {
        match self {
            Self::Server { error, .. } => {
                !self.draining()
                    && error
                        .code
                        .as_f64()
                        .is_some_and(|code| REFUSALS.contains(&code))
            }
            Self::TimedOut { .. } | Self::Ended { .. } | Self::NotOpen { .. } => false,
        }
    }
}

impl From<RpcError> for ChannelError {
    fn from(error: RpcError) -> Self {
        Self {
            kind: if error.refused() {
                ChannelErrorKind::Refused
            } else {
                ChannelErrorKind::Failed
            },
            message: error.to_string(),
        }
    }
}

/// A connection that couldn't be opened.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct OpenError {
    pub message: String,
    /// Whether nothing listens at the socket: there is none, or nobody accepts on it.
    pub absent: bool,
}

impl From<OpenError> for ChannelError {
    fn from(error: OpenError) -> Self {
        Self {
            kind: ChannelErrorKind::Failed,
            message: error.message,
        }
    }
}

/// How far the connection's requests have got: how many were sent, how many of their replies
/// were read, and how many still wait for one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Progress {
    pub sent: u64,
    pub read: u64,
    pub waiting: usize,
}

/// The requests waiting for their replies, while the connection is open.
#[derive(Debug)]
struct Waiting {
    open: bool,
    next_id: u64,
    read: u64,
    replies: HashMap<u64, oneshot::Sender<Result<Value, ServerError>>>,
    /// Told each change of [`Waiting::progress`].
    progress: watch::Sender<Progress>,
}

impl Waiting {
    fn progress(&self) -> Progress {
        Progress {
            sent: self.next_id,
            read: self.read,
            waiting: self.replies.len(),
        }
    }

    fn changed(&self) {
        self.progress.send_replace(self.progress());
    }
}

fn lock(waiting: &Mutex<Waiting>) -> MutexGuard<'_, Waiting> {
    // The lock guards a map no holder leaves half-changed, so a panic while it was held
    // corrupted nothing.
    waiting.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One request's place among those waiting, given up however its wait ends: answered, timed out,
/// or dropped by a caller that stopped waiting.
struct Place<'a> {
    waiting: &'a Mutex<Waiting>,
    id: u64,
}

impl Drop for Place<'_> {
    fn drop(&mut self) {
        let mut waiting = lock(self.waiting);
        if waiting.replies.remove(&self.id).is_some() {
            waiting.changed();
        }
    }
}

/// A handle to one connection, to send on it. The connection ends when the socket does, when its
/// stop token is cancelled, or once every handle is dropped.
#[derive(Debug, Clone)]
pub struct Rpc {
    waiting: Arc<Mutex<Waiting>>,
    outbox: mpsc::UnboundedSender<String>,
}

/// The server's own requests and notifications, in the order it sent them, at most
/// [`INBOX_CAPACITY`] unread. A reply never waits behind them: it settles its request directly.
#[derive(Debug)]
pub struct Inbox(mpsc::Receiver<Heard>);

/// One message of the server's own, and how far the daemon's requests had got as it came: the
/// replies read before it, and the requests still waiting then.
#[derive(Debug)]
pub struct Heard {
    pub message: Inbound,
    pub at: Progress,
}

impl Inbox {
    /// The next message, or `None` once the connection has ended and every message is read.
    pub async fn next(&mut self) -> Option<Heard> {
        self.0.recv().await
    }
}

/// Connects to the server listening at `socket`, and starts the task that owns the connection,
/// under `tasks`.
///
/// # Errors
///
/// Nothing listens at `socket`, or it didn't upgrade to a WebSocket within [`OPEN_TIMEOUT`].
pub async fn connect(
    socket: &Path,
    tasks: &TaskTracker,
    stop: CancellationToken,
) -> Result<(Rpc, Inbox), OpenError> {
    let refused = |why: String| OpenError {
        message: format!("can't connect to {}: {why}", socket.display()),
        absent: false,
    };
    let opening = async {
        let stream = UnixStream::connect(socket).await.map_err(|e| OpenError {
            absent: matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ),
            ..refused(e.to_string())
        })?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let (ws, _) =
            tokio_tungstenite::client_async_with_config("ws://localhost/", stream, Some(config))
                .await
                .map_err(|e| refused(e.to_string()))?;
        Ok(ws)
    };
    let ws = tokio::time::timeout(OPEN_TIMEOUT, opening)
        .await
        .map_err(|_| refused(format!("no WebSocket in {} s", OPEN_TIMEOUT.as_secs())))??;
    let waiting = Arc::new(Mutex::new(Waiting {
        open: true,
        next_id: 0,
        read: 0,
        replies: HashMap::new(),
        progress: watch::Sender::new(Progress::default()),
    }));
    let (outbox, sending) = mpsc::unbounded_channel();
    let (heard, inbox) = mpsc::channel(INBOX_CAPACITY);
    tasks.spawn(own(ws, Arc::clone(&waiting), sending, heard, stop));
    Ok((Rpc { waiting, outbox }, Inbox(inbox)))
}

/// The task that owns the socket, until it ends, `stop` is cancelled or every [`Rpc`] is dropped.
/// It reads and writes at once, so a write the server doesn't take holds up neither its replies
/// nor the stop; one that takes longer than [`WRITE_TIMEOUT`] ends the connection. Then each
/// request still waiting fails as ended, and any after fails as not open.
async fn own(
    ws: WebSocketStream<UnixStream>,
    waiting: Arc<Mutex<Waiting>>,
    mut sending: mpsc::UnboundedReceiver<String>,
    heard: mpsc::Sender<Heard>,
    stop: CancellationToken,
) {
    let (mut sink, mut stream) = ws.split();
    let outgoing = async {
        while let Some(text) = sending.recv().await {
            // A write that fails is the socket ending.
            match tokio::time::timeout(WRITE_TIMEOUT, sink.send(Message::text(text))).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
    };
    let incoming = async {
        while let Some(frame) = stream.next().await {
            match frame {
                Ok(Message::Text(text)) => {
                    if !receive(&waiting, &heard, text.as_str()) {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                // Pings are answered by the WebSocket itself; nothing else is the server's.
                Ok(_) => {}
            }
        }
    };
    tokio::select! {
        () = stop.cancelled() => {}
        () = outgoing => {}
        () = incoming => {}
    }
    let mut waiting = lock(&waiting);
    waiting.open = false;
    // Dropping each reply's sender fails its request as ended.
    waiting.replies.clear();
    waiting.changed();
}

/// Takes one text frame; false when the server has filled the inbox, which disconnects it.
fn receive(waiting: &Mutex<Waiting>, heard: &mpsc::Sender<Heard>, text: &str) -> bool {
    match decode(text) {
        Some(Frame::Reply { id, outcome }) => {
            let mut waiting = lock(waiting);
            if let Some(reply) = waiting.replies.remove(&id) {
                // Counted before it settles, so the request's caller finds it read.
                waiting.read += 1;
                waiting.changed();
                // A request that stopped waiting wants no reply.
                let _ = reply.send(outcome);
            }
            true
        }
        // An inbox nobody holds hears nothing: the server's message goes unread, as it would
        // with no one listening.
        Some(Frame::Inbound(message)) => {
            let at = lock(waiting).progress();
            !matches!(
                heard.try_send(Heard { message, at }),
                Err(mpsc::error::TrySendError::Full(_))
            )
        }
        None => true,
    }
}

/// A request, with its id, or a notification, without one; `params` is left out when null.
fn call(id: Option<u64>, method: &str, params: Value) -> String {
    let mut fields = Map::new();
    if let Some(id) = id {
        fields.insert("id".to_owned(), id.into());
    }
    fields.insert("method".to_owned(), Value::String(method.to_owned()));
    if !params.is_null() {
        fields.insert("params".to_owned(), params);
    }
    Value::Object(fields).to_string()
}

impl Rpc {
    /// One request's result.
    ///
    /// # Errors
    ///
    /// The server's error, no reply within [`REQUEST_TIMEOUT`], or the connection ending.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let (id, reply) = {
            let mut waiting = lock(&self.waiting);
            if !waiting.open {
                return Err(RpcError::NotOpen {
                    method: method.to_owned(),
                });
            }
            let id = waiting.next_id;
            waiting.next_id = id.wrapping_add(1);
            let (sender, reply) = oneshot::channel();
            waiting.replies.insert(id, sender);
            waiting.changed();
            (id, reply)
        };
        let _place = Place {
            waiting: &self.waiting,
            id,
        };
        self.send(call(Some(id), method, params));
        match tokio::time::timeout(REQUEST_TIMEOUT, reply).await {
            Ok(Ok(outcome)) => outcome.map_err(|error| RpcError::Server {
                method: method.to_owned(),
                error,
            }),
            Ok(Err(_)) => Err(RpcError::Ended {
                method: method.to_owned(),
            }),
            Err(_) => Err(RpcError::TimedOut {
                method: method.to_owned(),
            }),
        }
    }

    /// One notification, which the server answers with nothing.
    ///
    /// # Errors
    ///
    /// The connection has ended.
    pub fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        if !lock(&self.waiting).open {
            return Err(RpcError::NotOpen {
                method: method.to_owned(),
            });
        }
        self.send(call(None, method, params));
        Ok(())
    }

    /// Answers the server's request `id` with `result`. Once the connection has ended there is
    /// no one to answer: the server that asked went with it.
    pub fn respond(&self, id: RequestId, result: Value) {
        let mut fields = Map::new();
        fields.insert("id".to_owned(), id.into());
        fields.insert("result".to_owned(), result);
        self.send(Value::Object(fields).to_string());
    }

    /// Whether the connection is still open.
    pub fn open(&self) -> bool {
        lock(&self.waiting).open
    }

    /// How far the connection's requests have got now, and each change after.
    pub fn progress(&self) -> watch::Receiver<Progress> {
        lock(&self.waiting).progress.subscribe()
    }

    fn send(&self, text: String) {
        // The owner has ended, so the connection has: whatever waits on it fails as ended.
        let _ = self.outbox.send(text);
    }
}

/// One connection, for what is said on it alone, such as the handshake: it is never made again.
impl ChannelPort for Rpc {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, ChannelError>> {
        Box::pin(async move { Ok(Self::request(self, method, params).await?) })
    }

    fn notify<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<(), ChannelError>> {
        Box::pin(async move { Ok(Self::notify(self, method, params)?) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Server, TempDir, accepted, bounded, heard, paused, runtime, say, within};
    use futures_util::FutureExt as _;
    use serde_json::json;
    use tokio::net::UnixListener;

    /// A listener in a directory of the test's own, and a connection to it.
    async fn connected(
        dir: &TempDir,
        tasks: &TaskTracker,
        stop: CancellationToken,
    ) -> (Rpc, Inbox, Server) {
        let path = dir.path().join("server.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let (client, server) = tokio::join!(connect(&path, tasks, stop), accepted(&listener));
        let (rpc, inbox) = client.unwrap();
        (rpc, inbox, server)
    }

    #[test]
    fn returns_each_request_s_result_by_its_id() {
        let dir = TempDir::new("rpc-result");
        runtime().block_on(bounded(async {
            let tasks = TaskTracker::new();
            let (rpc, _inbox, mut server) = connected(&dir, &tasks, CancellationToken::new()).await;
            let asking = async {
                tokio::join!(
                    rpc.request("a/first", json!({ "cwd": "/work" })),
                    rpc.request("a/second", Value::Null),
                )
            };
            let answering = async {
                let first = heard(&mut server).await;
                let second = heard(&mut server).await;
                // Answered out of order: each reply finds its request by id.
                say(&mut server, json!({ "id": 1, "result": "two" })).await;
                say(&mut server, json!({ "id": 0, "result": { "thread": "t" } })).await;
                (first, second)
            };
            let ((first, second), sent) = tokio::join!(asking, answering);
            assert_eq!(first, Ok(json!({ "thread": "t" })));
            assert_eq!(second, Ok(json!("two")));
            assert_eq!(
                sent,
                (
                    json!({ "id": 0, "method": "a/first", "params": { "cwd": "/work" } }),
                    json!({ "id": 1, "method": "a/second" }),
                )
            );
        }));
    }

    #[test]
    fn fails_a_request_the_server_answers_with_an_error_with_the_server_s_code() {
        let dir = TempDir::new("rpc-error");
        runtime().block_on(bounded(async {
            let tasks = TaskTracker::new();
            let (rpc, _inbox, mut server) = connected(&dir, &tasks, CancellationToken::new()).await;
            let answering = async {
                heard(&mut server).await;
                let error = json!({ "code": -32601, "message": "no such method" });
                say(&mut server, json!({ "id": 0, "error": error })).await;
            };
            let (failed, ()) = tokio::join!(rpc.request("a/gone", Value::Null), answering);
            let failed = failed.unwrap_err();
            assert_eq!(failed.to_string(), "a/gone: no such method (-32601)");
            assert_eq!(ChannelError::from(failed).kind, ChannelErrorKind::Refused);
        }));
    }

    fn server(code: &Value, reason: Option<&str>) -> RpcError {
        RpcError::Server {
            method: "m".to_owned(),
            error: server_error(json!({
                "code": code,
                "message": "no",
                "data": { "reason": reason },
            }))
            .unwrap(),
        }
    }

    #[test]
    fn takes_only_an_invalid_request_method_or_params_for_a_refusal_and_never_while_draining() {
        let kind = |error: RpcError| ChannelError::from(error).kind;
        for code in [json!(-32600), json!(-32601), json!(-32602), json!(-32601.0)] {
            assert_eq!(kind(server(&code, None)), ChannelErrorKind::Refused);
        }
        for code in [json!(-32603), json!(-32599), json!(-32000), json!(-32601.5)] {
            assert_eq!(kind(server(&code, None)), ChannelErrorKind::Failed);
        }
        let draining = server(&json!(-32600), Some(DRAINING));
        assert!(draining.draining());
        assert_eq!(kind(draining), ChannelErrorKind::Failed);
        assert!(!server(&json!(-32600), Some("other")).draining());
        let method = || "m".to_owned();
        for error in [
            RpcError::TimedOut { method: method() },
            RpcError::Ended { method: method() },
            RpcError::NotOpen { method: method() },
        ] {
            assert!(!error.draining());
            assert_eq!(kind(error), ChannelErrorKind::Failed);
        }
        let open = OpenError {
            message: "no".to_owned(),
            absent: true,
        };
        assert_eq!(ChannelError::from(open).kind, ChannelErrorKind::Failed);
    }

    #[test]
    fn fails_a_request_in_flight_when_the_socket_ends_without_a_close_frame() {
        let dir = TempDir::new("rpc-ended");
        runtime().block_on(bounded(async {
            let tasks = TaskTracker::new();
            let (rpc, mut inbox, mut server) =
                connected(&dir, &tasks, CancellationToken::new()).await;
            let ending = async {
                heard(&mut server).await;
                // Dropped, not closed: the socket ends with no close frame.
                drop(server);
            };
            let (failed, ()) = tokio::join!(rpc.request("a/slow", Value::Null), ending);
            assert_eq!(
                failed,
                Err(RpcError::Ended {
                    method: "a/slow".to_owned()
                })
            );
            assert_eq!(inbox.next().await.map(|heard| heard.message), None);
            assert_eq!(
                rpc.request("a/later", Value::Null).await,
                Err(RpcError::NotOpen {
                    method: "a/later".to_owned()
                })
            );
            assert!(rpc.notify("a/later", Value::Null).is_err());
            tasks.close();
            tasks.wait().await;
        }));
    }

    #[test]
    fn ends_the_connection_when_stopped() {
        let dir = TempDir::new("rpc-stopped");
        runtime().block_on(bounded(async {
            let tasks = TaskTracker::new();
            let stop = CancellationToken::new();
            let (rpc, mut inbox, mut server) = connected(&dir, &tasks, stop.clone()).await;
            let request = rpc.request("a/slow", Value::Null);
            tokio::pin!(request);
            tokio::select! {
                _ = &mut request => panic!("answered with no reply"),
                _ = heard(&mut server) => {}
            }
            stop.cancel();
            tasks.close();
            let ended = tokio::time::timeout(Duration::from_secs(1), tasks.wait()).await;
            assert!(ended.is_ok(), "the owner still runs after its stop");
            assert!(matches!(request.await, Err(RpcError::Ended { .. })));
            assert_eq!(inbox.next().await.map(|heard| heard.message), None);
            // The owner is gone, and the socket with it.
            assert!(!matches!(server.next().await, Some(Ok(Message::Text(_)))));
        }));
    }

    #[test]
    fn hands_the_server_s_requests_and_notifications_to_its_inbox_and_answers_on_the_same_connection()
     {
        let dir = TempDir::new("rpc-inbound");
        runtime().block_on(bounded(async {
            let tasks = TaskTracker::new();
            let (rpc, mut inbox, mut server) =
                connected(&dir, &tasks, CancellationToken::new()).await;
            say(
                &mut server,
                json!({ "method": "a/started", "params": { "n": 1 } }),
            )
            .await;
            say(
                &mut server,
                json!({ "id": "r1", "method": "a/ask", "params": {} }),
            )
            .await;
            say(&mut server, json!({ "id": 7, "method": "a/ask" })).await;
            assert_eq!(
                inbox.next().await.map(|heard| heard.message),
                Some(Inbound::Notification {
                    method: "a/started".to_owned(),
                    params: Some(json!({ "n": 1 })),
                })
            );
            let Some(Inbound::Request { id: text, .. }) =
                inbox.next().await.map(|heard| heard.message)
            else {
                panic!("not a request");
            };
            let Some(Inbound::Request {
                id: number, params, ..
            }) = inbox.next().await.map(|heard| heard.message)
            else {
                panic!("not a request");
            };
            assert_eq!(params, None);
            rpc.respond(text, json!({ "decision": "accept" }));
            rpc.respond(number, Value::Null);
            assert_eq!(
                heard(&mut server).await,
                json!({ "id": "r1", "result": { "decision": "accept" } })
            );
            assert_eq!(heard(&mut server).await, json!({ "id": 7, "result": null }));
            rpc.notify("a/ready", Value::Null).unwrap();
            assert_eq!(heard(&mut server).await, json!({ "method": "a/ready" }));
        }));
    }

    #[test]
    fn gives_up_on_a_request_with_no_reply_in_30_s_and_drops_the_reply_that_comes_late() {
        let dir = TempDir::new("rpc-timeout");
        paused().block_on(within(2 * REQUEST_TIMEOUT, async {
            let tasks = TaskTracker::new();
            let (rpc, _inbox, mut server) = connected(&dir, &tasks, CancellationToken::new()).await;
            let started = tokio::time::Instant::now();
            let (failed, first) =
                tokio::join!(rpc.request("a/slow", Value::Null), heard(&mut server));
            assert_eq!(
                failed,
                Err(RpcError::TimedOut {
                    method: "a/slow".to_owned()
                })
            );
            assert_eq!(started.elapsed(), REQUEST_TIMEOUT);
            assert_eq!(first["id"], 0);
            assert_eq!(lock(&rpc.waiting).replies.len(), 0);
            let answering = async {
                heard(&mut server).await;
                say(&mut server, json!({ "id": 0, "result": "late" })).await;
                say(&mut server, json!({ "id": 1, "result": "on time" })).await;
            };
            let (next, ()) = tokio::join!(rpc.request("a/next", Value::Null), answering);
            assert_eq!(next, Ok(json!("on time")));
            assert_eq!(lock(&rpc.waiting).replies.len(), 0);
        }));
    }

    #[test]
    fn is_refused_when_the_socket_doesn_t_upgrade_in_10_s() {
        let dir = TempDir::new("rpc-open");
        let path = dir.path().join("server.sock");
        paused().block_on(within(2 * OPEN_TIMEOUT, async {
            let listener = UnixListener::bind(&path).unwrap();
            let started = tokio::time::Instant::now();
            let silent = async {
                // Accepted, never answered.
                let (stream, _) = listener.accept().await.unwrap();
                std::future::pending::<()>().await;
                drop(stream);
            };
            let tasks = TaskTracker::new();
            let refused = tokio::select! {
                refused = connect(&path, &tasks, CancellationToken::new()) => refused,
                () = silent => panic!("the silent server never ends"),
            };
            assert_eq!(started.elapsed(), OPEN_TIMEOUT);
            let refused = refused.unwrap_err();
            assert_eq!(
                refused.to_string(),
                format!("can't connect to {}: no WebSocket in 10 s", path.display())
            );
            assert!(!refused.absent, "something listened");
        }));
    }

    #[test]
    fn gives_up_its_place_when_the_caller_stops_waiting() {
        let dir = TempDir::new("rpc-dropped");
        runtime().block_on(bounded(async {
            let tasks = TaskTracker::new();
            let (rpc, _inbox, mut server) = connected(&dir, &tasks, CancellationToken::new()).await;
            // Polled once, so sent, then dropped.
            assert!(rpc.request("a/slow", Value::Null).now_or_never().is_none());
            assert_eq!(lock(&rpc.waiting).replies.len(), 0);
            assert_eq!(heard(&mut server).await["id"], 0);
        }));
    }

    /// A request too big for the socket's buffers, which a server that reads nothing never takes.
    fn too_big() -> Value {
        Value::String("x".repeat(8 * 1024 * 1024))
    }

    #[test]
    fn stops_while_a_write_the_server_doesn_t_read_waits() {
        let dir = TempDir::new("rpc-stuck");
        runtime().block_on(bounded(async {
            let tasks = TaskTracker::new();
            let stop = CancellationToken::new();
            let (rpc, _inbox, _server) = connected(&dir, &tasks, stop.clone()).await;
            let request = rpc.request("a/big", too_big());
            tokio::pin!(request);
            assert!((&mut request).now_or_never().is_none());
            // Long enough for the owner to start the write, and the socket's buffers to fill.
            tokio::time::sleep(Duration::from_millis(200)).await;
            stop.cancel();
            tasks.close();
            let ended = tokio::time::timeout(Duration::from_secs(1), tasks.wait()).await;
            assert!(ended.is_ok(), "the owner still writes after its stop");
            assert!(matches!(request.await, Err(RpcError::Ended { .. })));
        }));
    }

    #[test]
    fn ends_the_connection_when_the_server_reads_nothing_for_10_s() {
        let dir = TempDir::new("rpc-unread");
        paused().block_on(within(2 * REQUEST_TIMEOUT, async {
            let tasks = TaskTracker::new();
            let (rpc, _inbox, _server) = connected(&dir, &tasks, CancellationToken::new()).await;
            let started = tokio::time::Instant::now();
            assert_eq!(
                rpc.request("a/big", too_big()).await,
                Err(RpcError::Ended {
                    method: "a/big".to_owned()
                })
            );
            assert_eq!(started.elapsed(), WRITE_TIMEOUT);
        }));
    }

    #[test]
    fn disconnects_a_server_that_fills_the_inbox() {
        let dir = TempDir::new("rpc-flood");
        runtime().block_on(bounded(async {
            let tasks = TaskTracker::new();
            let (rpc, mut inbox, mut server) =
                connected(&dir, &tasks, CancellationToken::new()).await;
            for n in 0..=INBOX_CAPACITY {
                say(&mut server, json!({ "method": "a/tick", "params": n })).await;
            }
            // Nobody reads the inbox until the owner has ended, as it ends on the one too many.
            tasks.close();
            let ended = tokio::time::timeout(Duration::from_secs(1), tasks.wait()).await;
            assert!(
                ended.is_ok(),
                "a server that filled the inbox is still connected"
            );
            let mut read = 0;
            while inbox.next().await.is_some() {
                read += 1;
            }
            assert_eq!(read, INBOX_CAPACITY);
            assert!(rpc.notify("a/after", Value::Null).is_err());
        }));
    }

    #[test]
    fn is_refused_at_once_where_nothing_listens() {
        let dir = TempDir::new("rpc-absent");
        let path = dir.path().join("server.sock");
        runtime().block_on(bounded(async {
            let refused = connect(&path, &TaskTracker::new(), CancellationToken::new()).await;
            let refused = refused.unwrap_err();
            assert!(
                refused
                    .message
                    .starts_with(&format!("can't connect to {}: ", path.display()))
            );
            assert!(refused.absent, "no socket");
            // A socket its server left behind, which nobody accepts on.
            drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
            let refused = connect(&path, &TaskTracker::new(), CancellationToken::new()).await;
            assert!(refused.unwrap_err().absent, "a socket nobody accepts on");
        }));
    }

    #[test]
    fn drops_a_frame_that_is_neither_a_reply_nor_a_message_of_the_server_s_own() {
        for text in [
            "",
            "not json",
            "[]",
            "3",
            r#"{"method": 3}"#,
            r#"{"method": "a", "id": null}"#,
            r#"{"method": "a", "id": true}"#,
            r#"{"method": "a", "id": {}}"#,
            r#"{"result": 1}"#,
            r#"{"id": "0", "result": 1}"#,
            r#"{"id": -1, "result": 1}"#,
            r#"{"id": 1.5, "result": 1}"#,
            r#"{"id": 0, "error": null}"#,
            r#"{"id": 0, "error": {"code": "1", "message": "m"}}"#,
            r#"{"id": 0, "error": {"code": 1}}"#,
        ] {
            assert_eq!(decode(text), None, "{text}");
        }
    }

    #[test]
    fn reads_a_reply_with_no_result_as_null_and_an_error_s_reason_only_when_it_is_text() {
        assert_eq!(
            decode(r#"{"id": 3}"#),
            Some(Frame::Reply {
                id: 3,
                outcome: Ok(Value::Null)
            })
        );
        let reason = |data: &str| match decode(&format!(
            r#"{{"id": 0, "error": {{"code": 1, "message": "m", "data": {data}}}}}"#
        )) {
            Some(Frame::Reply {
                outcome: Err(error),
                ..
            }) => error.reason,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            reason(r#"{"reason": "serverShuttingDown"}"#),
            Some(DRAINING.to_owned())
        );
        assert_eq!(reason(r#"{"reason": 5}"#), None);
        assert_eq!(reason("[]"), None);
        assert_eq!(reason("null"), None);
    }

    mod properties {
        use super::super::*;
        use proptest::prelude::{Just, Strategy, any, prop, prop_assert_eq, prop_oneof, proptest};
        use serde_json::json;

        fn method() -> impl Strategy<Value = String> {
            "[a-z/]{1,12}"
        }

        fn params() -> impl Strategy<Value = Option<Value>> {
            prop::option::of(prop_oneof![
                Just(Value::Null),
                any::<i64>().prop_map(Value::from),
                ".{0,8}".prop_map(Value::from),
                ".{0,8}".prop_map(|s| json!({ "s": s })),
            ])
        }

        fn inbound() -> impl Strategy<Value = Inbound> {
            let id = prop_oneof![
                any::<i64>().prop_map(|n| RequestId::Number(n.into())),
                ".{0,8}".prop_map(RequestId::Text),
            ];
            prop_oneof![
                (id, method(), params()).prop_map(|(id, method, params)| Inbound::Request {
                    id,
                    method,
                    params
                }),
                (method(), params())
                    .prop_map(|(method, params)| Inbound::Notification { method, params }),
            ]
        }

        fn encoded(message: &Inbound) -> String {
            let (id, method, params) = match message.clone() {
                Inbound::Request { id, method, params } => (Some(Value::from(id)), method, params),
                Inbound::Notification { method, params } => (None, method, params),
            };
            let mut fields = Map::new();
            if let Some(id) = id {
                fields.insert("id".to_owned(), id);
            }
            fields.insert("method".to_owned(), Value::String(method));
            if let Some(params) = params {
                fields.insert("params".to_owned(), params);
            }
            Value::Object(fields).to_string()
        }

        proptest! {
            #[test]
            fn reads_back_each_message_of_the_server_s_own(message in inbound()) {
                prop_assert_eq!(decode(&encoded(&message)), Some(Frame::Inbound(message)));
            }

            #[test]
            fn reads_back_each_reply(id in any::<u64>(), result in params(), code in any::<i64>(), text in ".{0,8}") {
                let mut reply = json!({ "id": id });
                if let Some(result) = result.clone() {
                    reply["result"] = result;
                }
                prop_assert_eq!(
                    decode(&reply.to_string()),
                    Some(Frame::Reply { id, outcome: Ok(result.unwrap_or(Value::Null)) })
                );
                let error = json!({ "id": id, "error": { "code": code, "message": text } });
                prop_assert_eq!(
                    decode(&error.to_string()),
                    Some(Frame::Reply {
                        id,
                        outcome: Err(ServerError { code: code.into(), message: text, reason: None }),
                    })
                );
            }

            #[test]
            fn never_panics_on_any_text(text in ".{0,64}") {
                let _ = decode(&text);
            }

            #[test]
            fn never_panics_on_any_truncation_of_a_frame(message in inbound(), cut in any::<prop::sample::Index>()) {
                let text = encoded(&message);
                let at = cut.index(text.len() + 1);
                if let Some(head) = text.get(..at) {
                    let _ = decode(head);
                }
            }
        }
    }
}
