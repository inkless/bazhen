//! `/v1/events`: the log from a client's cursor, the backlog then each new event, every one once.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, close_code};
use bazhen_protocol::events::{ClientEventFrame, EventFrame, ResetReason};
use bazhen_store::{FrameError, Page, Reads, StoredEvent};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use tokio::sync::{Notify, mpsc};
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

use crate::accept::Held;
use crate::heartbeat::{Beat, Heartbeat, Pulse};
use crate::writer::Writer;

/// How many events a page holds.
pub(crate) const PAGE: u32 = 500;

/// Where a stream resumes: after event `after` of the log whose epoch is `epoch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Cursor {
    pub(crate) epoch: String,
    pub(crate) after: u64,
}

/// The cursor a stream's query names, as `EventStreamQuery` takes it: an epoch, and `after` in
/// digits. A name given twice takes its last value, as `Object.fromEntries` does, and other names
/// are ignored.
pub(crate) fn cursor(query: &[(String, String)]) -> Option<Cursor> {
    let last = |name: &str| {
        query
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let epoch = last("epoch").filter(|epoch| !epoch.is_empty())?;
    let after = last("after")
        .filter(|after| !after.is_empty() && after.bytes().all(|b| b.is_ascii_digit()))?;
    Some(Cursor {
        epoch: epoch.to_owned(),
        // `Number()` reads one past every id as larger than any, so the cursor is foreign.
        after: after.parse().unwrap_or(u64::MAX),
    })
}

/// What a feed does next.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Next {
    /// The cursor can't resume: send `reset` and close.
    Reset(ResetReason),
    /// Send these frames, then say when the last is written.
    Send(Vec<String>),
    /// Nothing until a commit, or until the page in flight is written.
    Wait,
}

/// Why a feed stopped on the daemon's side.
#[derive(Debug, thiserror::Error)]
pub(crate) enum Broke {
    #[error(transparent)]
    Read(#[from] rusqlite::Error),
    #[error(transparent)]
    Frame(#[from] FrameError),
}

/// One subscriber's place in the log. One page is in flight at a time, so a slow client falls
/// behind in the store rather than in memory, and the cursor is checked before every page, since
/// retention can overtake a client still reading an old backlog.
#[derive(Debug)]
pub(crate) struct Feed {
    cursor: Cursor,
    page: u32,
    in_flight: bool,
}

impl Feed {
    pub(crate) fn new(cursor: Cursor, page: u32) -> Self {
        Self {
            cursor,
            page,
            in_flight: false,
        }
    }

    /// The next page from the cursor. A page holding an event that can't be framed fails before
    /// the cursor moves past it.
    ///
    /// # Errors
    ///
    /// [`Broke`]: the log can't be read, or an event in the page can't be framed.
    pub(crate) fn next(&mut self, reads: Reads<'_>) -> Result<Next, Broke> {
        if self.in_flight {
            return Ok(Next::Wait);
        }
        match reads.page(&self.cursor.epoch, self.cursor.after, self.page)? {
            Page::Reset(reason) => Ok(Next::Reset(reason)),
            Page::Events(events) => {
                let Some(last) = events.last() else {
                    return Ok(Next::Wait);
                };
                let frames = events
                    .iter()
                    .map(StoredEvent::frame)
                    .collect::<Result<_, _>>()?;
                self.cursor.after = last.id;
                self.in_flight = true;
                Ok(Next::Send(frames))
            }
        }
    }

    /// The page in flight has been written.
    pub(crate) fn written(&mut self) {
        self.in_flight = false;
    }
}

/// What a stream needs of the daemon.
#[derive(Debug, Clone)]
pub(crate) struct Streaming {
    pub(crate) store: Writer,
    pub(crate) stop: CancellationToken,
    /// For a paired device's stream, cancelled once the device is revoked or lapses.
    pub(crate) device: Option<CancellationToken>,
    pub(crate) heartbeat: Heartbeat,
}

/// Whether the stream is a device's that has been revoked or has lapsed.
fn device_ended(how: &Streaming) -> bool {
    how.device
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
}

/// The close a device's ended stream is sent: a policy close, so the page doesn't open it again,
/// unless the daemon is stopping. A device's token is the daemon's child, so both end then.
fn device_close(how: &Streaming) -> u16 {
    if how.stop.is_cancelled() {
        close_code::AWAY
    } else {
        close_code::POLICY
    }
}

/// Resolves once `device` is cancelled, and never for a stream that isn't a device's.
async fn ended(device: Option<&CancellationToken>) {
    match device {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

/// A frame for the writer, and whether it ends a page.
#[derive(Debug)]
struct Out {
    message: Message,
    ends_page: bool,
}

/// How a stream ended: with frames still to send or a close to answer, or with no one to say
/// anything to.
#[derive(Debug, PartialEq, Eq)]
enum Ending {
    Close,
    Gone,
}

/// Streams the log on `socket` from `cursor` until the client goes, the cursor can't resume, or
/// the daemon stops. `held` keeps the connection's place under its listener's cap and drain.
pub(crate) async fn stream(socket: WebSocket, cursor: Cursor, how: Streaming, held: Option<Held>) {
    let (sink, heard) = socket.split();
    over(sink, heard, cursor, how, held).await;
}

/// [`stream`], sending on `sink` what the client is sent and hearing from `heard` what it sends.
async fn over<E>(
    sink: impl Sink<Message>,
    heard: impl Stream<Item = Result<Message, E>>,
    cursor: Cursor,
    how: Streaming,
    held: Option<Held>,
) {
    let _held = held;
    let (out, queued) = mpsc::unbounded_channel();
    let unsent = Arc::new(AtomicUsize::new(0));
    let written = Arc::new(Notify::new());
    let mut writing = std::pin::pin!(write(
        sink,
        queued,
        Arc::clone(&unsent),
        Arc::clone(&written)
    ));
    let ending = tokio::select! {
        ending = follow(heard, &out, cursor, &how, &unsent, &written) => ending,
        () = &mut writing => return,
    };
    drop(out);
    if ending == Ending::Close {
        let _ = tokio::time::timeout(how.heartbeat.close_within(), writing).await;
    }
}

/// Sends what is queued, in order, saying when each page's last frame is written, then flushes
/// `sink`, which sends the answer the socket queued to a client's close.
async fn write(
    sink: impl Sink<Message>,
    mut queued: mpsc::UnboundedReceiver<Out>,
    unsent: Arc<AtomicUsize>,
    written: Arc<Notify>,
) {
    let mut sink = std::pin::pin!(sink);
    while let Some(Out { message, ends_page }) = queued.recv().await {
        let counted = matches!(message, Message::Text(_));
        let closing = matches!(message, Message::Close(_));
        let sent = sink.send(message).await;
        if counted {
            unsent.fetch_sub(1, Ordering::Relaxed);
        }
        // Even a send that failed leaves the reply to a client's close queued, for the flush.
        if sent.is_err() || closing {
            break;
        }
        if ends_page {
            written.notify_one();
        }
    }
    let _ = sink.flush().await;
}

fn closing(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

/// Feeds the log to the writer and listens to the client, until the stream ends.
async fn follow<E>(
    heard: impl Stream<Item = Result<Message, E>>,
    out: &mpsc::UnboundedSender<Out>,
    cursor: Cursor,
    how: &Streaming,
    unsent: &AtomicUsize,
    written: &Notify,
) -> Ending {
    let send = |message: Message, ends_page: bool| {
        if matches!(message, Message::Text(_)) {
            unsent.fetch_add(1, Ordering::Relaxed);
        }
        // The writer ends only once this stream has, so nothing sent here is lost.
        let _ = out.send(Out { message, ends_page });
    };
    let failed = |err: &dyn std::fmt::Display| {
        tracing::error!("an event stream failed: {err}");
        send(closing(close_code::ERROR, "internal error"), false);
        Ending::Close
    };
    let mut reader = match how.store.reader() {
        Ok(reader) => reader,
        Err(err) => return failed(&err),
    };
    let mut feed = Feed::new(cursor, PAGE);
    let mut committed = how.store.committed();
    // The first read below takes in every commit so far; only one after it calls for another.
    committed.mark_unchanged();
    let mut pulse = Pulse::new(how.heartbeat.patience);
    let every = how.heartbeat.every;
    let mut beat = tokio::time::interval_at(Instant::now() + every, every);
    // A stall doesn't fire the beats it missed back to back, a ping then at once its verdict, which
    // would find a peer gone that had no turn to answer; the next beat is a whole beat on.
    beat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut heard = std::pin::pin!(heard);
    let mut pump = true;
    loop {
        if pump {
            pump = false;
            let read = tokio::task::spawn_blocking(move || {
                let next = feed.next(reader.reads());
                (reader, feed, next)
            })
            .await;
            let next = match read {
                Ok((kept, moved, next)) => {
                    (reader, feed) = (kept, moved);
                    next
                }
                Err(lost) => return failed(&lost),
            };
            // A device revoked or lapsed before its stream opened, or while it was read, is
            // sent none of it.
            if device_ended(how) {
                send(closing(device_close(how), ""), false);
                return Ending::Close;
            }
            match next {
                Ok(Next::Wait) => {}
                Ok(Next::Send(frames)) => {
                    let last = frames.len().saturating_sub(1);
                    for (i, frame) in frames.into_iter().enumerate() {
                        send(Message::Text(frame.into()), i == last);
                    }
                }
                Ok(Next::Reset(reason)) => {
                    match serde_json::to_string(&EventFrame::Reset { reason }) {
                        Ok(reset) => send(Message::Text(reset.into()), false),
                        Err(err) => return failed(&err),
                    }
                    send(Message::Close(None), false);
                    return Ending::Close;
                }
                Err(err) => return failed(&err),
            }
        }
        tokio::select! {
            () = how.stop.cancelled() => {
                send(closing(close_code::AWAY, ""), false);
                return Ending::Close;
            }
            () = ended(how.device.as_ref()) => {
                send(closing(device_close(how), ""), false);
                return Ending::Close;
            }
            message = heard.next() => match message {
                None | Some(Err(_)) => return Ending::Gone,
                Some(Ok(Message::Close(_))) => return Ending::Close,
                Some(Ok(message)) => {
                    pulse.heard();
                    // Presence is read here once the daemon keeps it; a frame this build doesn't
                    // know is skipped, as clients skip unknown events.
                    if let Message::Text(text) = message {
                        let _ = serde_json::from_str::<ClientEventFrame>(&text);
                    }
                }
            },
            _ = beat.tick() => match pulse.beat(unsent.load(Ordering::Relaxed)) {
                Beat::Ping => send(Message::Ping(Bytes::new()), false),
                Beat::Gone => return Ending::Gone,
            },
            changed = committed.changed() => {
                if changed.is_err() {
                    send(closing(close_code::AWAY, ""), false);
                    return Ending::Close;
                }
                pump = true;
            }
            () = written.notified() => {
                feed.written();
                pump = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::events::TaskCreated;
    use bazhen_protocol::ids::TaskId;
    use bazhen_store::{NewEvent, Store};

    use bazhen_protocol::events::EVENT_FRAME_MAX_BYTES;

    use tokio_util::task::TaskTracker;

    use super::*;
    use crate::testing::{TempDir, paused};

    fn pairs(query: &[(&str, &str)]) -> Vec<(String, String)> {
        query
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn takes_a_cursor_whole_though_it_names_no_version_and_refuses_one_that_isnt() {
        let at = |epoch: &str, after| {
            Some(Cursor {
                epoch: epoch.to_owned(),
                after,
            })
        };
        assert_eq!(
            [
                cursor(&pairs(&[("epoch", "e"), ("after", "7")])),
                cursor(&pairs(&[
                    ("epoch", "e"),
                    ("after", "1"),
                    ("after", "2"),
                    ("v", "9")
                ])),
                cursor(&pairs(&[("epoch", "e"), ("after", "99999999999999999999")])),
                cursor(&pairs(&[("epoch", ""), ("after", "1")])),
                cursor(&pairs(&[("epoch", "e"), ("after", "-1")])),
                cursor(&pairs(&[("epoch", "e"), ("after", "")])),
                cursor(&pairs(&[("epoch", "e"), ("after", "\u{0661}")])),
                cursor(&pairs(&[("after", "1")])),
            ],
            [
                at("e", 7),
                at("e", 2),
                at("e", u64::MAX),
                None,
                None,
                None,
                None,
                None
            ]
        );
    }

    fn created(n: u8) -> NewEvent {
        NewEvent::TaskCreated {
            task: TaskId::mint(1, [n; 16]),
            actor: "human".to_owned(),
            payload: TaskCreated {
                title: format!("Task {n}"),
                brief: "b".to_owned(),
                owner_agent_id: None,
                parent_task_id: None,
                delegated_from: None,
            },
        }
    }

    fn append(store: &mut Store, n: u8) -> u64 {
        store.write(|w| w.append(&created(n))).unwrap()
    }

    fn ids(next: &Next) -> Vec<u64> {
        let Next::Send(frames) = next else {
            return Vec::new();
        };
        frames
            .iter()
            .map(|f| {
                let frame: serde_json::Value = serde_json::from_str(f).unwrap();
                frame["event"]["id"].as_u64().unwrap()
            })
            .collect()
    }

    fn opened(dir: &TempDir) -> (Store, Feed) {
        let store = Store::open(&dir.path().join("bazhen.db")).unwrap();
        let epoch = store.reads().epoch().unwrap();
        (store, Feed::new(Cursor { epoch, after: 0 }, 2))
    }

    #[test]
    fn sends_the_backlog_after_the_cursor_then_each_new_event_every_one_once() {
        let dir = TempDir::new("feed-order");
        let (mut store, mut feed) = opened(&dir);
        let backlog: Vec<u64> = (1..=3).map(|n| append(&mut store, n)).collect();
        let mut sent = Vec::new();
        for _ in 0..3 {
            sent.extend(ids(&feed.next(store.reads()).unwrap()));
            feed.written();
        }
        assert_eq!(sent, backlog);
        let later = append(&mut store, 4);
        assert_eq!(ids(&feed.next(store.reads()).unwrap()), [later]);
        feed.written();
        assert_eq!(feed.next(store.reads()).unwrap(), Next::Wait);
    }

    #[test]
    fn keeps_one_page_in_flight_and_reads_what_arrived_meanwhile_once_it_is_written() {
        let dir = TempDir::new("feed-in-flight");
        let (mut store, mut feed) = opened(&dir);
        let first = append(&mut store, 1);
        assert_eq!(ids(&feed.next(store.reads()).unwrap()), [first]);
        let meanwhile = [append(&mut store, 2), append(&mut store, 3)];
        assert_eq!(feed.next(store.reads()).unwrap(), Next::Wait);
        feed.written();
        assert_eq!(ids(&feed.next(store.reads()).unwrap()), meanwhile);
    }

    #[test]
    fn resets_a_client_that_retention_overtakes_while_it_reads_an_old_backlog() {
        let dir = TempDir::new("feed-stale");
        let (mut store, mut feed) = opened(&dir);
        let path = dir.path().join("bazhen.db");
        let visit = "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
             VALUES ((SELECT id FROM host), '2000-01-01T00:00:00.000Z', 'attachment.ended',
               'attachment', 'att_1', 'system', '{\"reason\":\"client_closed\"}')";
        let db = rusqlite::Connection::open(&path).unwrap();
        for _ in 0..5 {
            db.execute(visit, ()).unwrap();
        }
        assert_eq!(ids(&feed.next(store.reads()).unwrap()), [1, 2]);
        feed.written();
        store
            .prune_batch(
                "2020-01-01T00:00:00Z".parse().unwrap(),
                std::num::NonZeroU32::new(1000).unwrap(),
            )
            .unwrap();
        assert_eq!(
            feed.next(store.reads()).unwrap(),
            Next::Reset(ResetReason::Stale)
        );
    }

    #[test]
    fn resets_a_cursor_from_another_store_at_once_sending_it_no_events() {
        let dir = TempDir::new("feed-foreign");
        let (mut store, _) = opened(&dir);
        append(&mut store, 1);
        let mut feed = Feed::new(
            Cursor {
                epoch: "0".repeat(32),
                after: 0,
            },
            2,
        );
        assert_eq!(
            feed.next(store.reads()).unwrap(),
            Next::Reset(ResetReason::Foreign)
        );
    }

    /// The socket's routes on loopback TCP, over a store of their own.
    struct Daemon {
        address: std::net::SocketAddr,
        stop: crate::routes::Stop,
        store: Writer,
        thread: Option<crate::writer::Thread>,
        runtime: tokio::runtime::Runtime,
        dir: TempDir,
    }

    impl Daemon {
        fn start(name: &str) -> Self {
            let dir = TempDir::new(name);
            let path = dir.path().join("bazhen.db");
            let (store, thread) = crate::writer::start(Store::open(&path).unwrap(), &path).unwrap();
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            let stop = crate::routes::Stop::default();
            let shared = crate::routes::Shared::new("f", stop.clone(), store.clone());
            let listener = runtime
                .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
                .unwrap();
            let address = listener.local_addr().unwrap();
            runtime.spawn(crate::accept::serve_on(
                listener,
                crate::routes::socket_router(shared),
                crate::accept::SOCKET,
                stop.token().clone(),
                tokio_util::task::TaskTracker::new(),
                || {},
            ));
            Self {
                address,
                stop,
                store,
                thread: Some(thread),
                runtime,
                dir,
            }
        }

        fn append(&self, n: u8) -> u64 {
            self.runtime
                .block_on(
                    self.store
                        .run(move |store| store.write(|w| w.append(&created(n)))),
                )
                .unwrap()
                .unwrap()
        }

        fn epoch(&self) -> String {
            self.store.reader().unwrap().reads().epoch().unwrap()
        }

        fn open(&self, query: &str) -> Result<Client, tungstenite::Error> {
            let tcp = std::net::TcpStream::connect(self.address).unwrap();
            tcp.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let url = format!("ws://{}/v1/events?{query}", self.address);
            tungstenite::client(url, tcp)
                .map(|(ws, _)| ws)
                .map_err(|err| match err {
                    tungstenite::HandshakeError::Failure(err) => err,
                    tungstenite::HandshakeError::Interrupted(_) => panic!("interrupted"),
                })
        }

        fn follow(&self, after: u64) -> Client {
            self.open(&format!("epoch={}&after={after}", self.epoch()))
                .unwrap()
        }
    }

    impl Drop for Daemon {
        fn drop(&mut self) {
            self.stop.now(crate::routes::Reason::Requested);
            if let Some(thread) = self.thread.take() {
                thread.finish();
            }
        }
    }

    type Client = tungstenite::WebSocket<std::net::TcpStream>;

    /// The next frame the daemon sends that isn't a ping, a text frame as JSON and a close as its
    /// code and reason; `None` once the connection has ended without one. Pings don't put off
    /// the five seconds it waits.
    fn heard(ws: &mut Client) -> Option<serde_json::Value> {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            assert!(std::time::Instant::now() < until, "nothing heard");
            match ws.read() {
                Ok(tungstenite::Message::Text(text)) => {
                    return Some(serde_json::from_str(&text).unwrap());
                }
                Ok(tungstenite::Message::Close(frame)) => {
                    let frame = frame.unwrap_or_else(|| tungstenite::protocol::CloseFrame {
                        code: tungstenite::protocol::frame::coding::CloseCode::Status,
                        reason: "".into(),
                    });
                    return Some(serde_json::json!({
                        "close": u16::from(frame.code),
                        "reason": frame.reason.as_str(),
                    }));
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(err))
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut =>
                {
                    panic!("nothing heard: {err}")
                }
                Err(_) => return None,
            }
        }
    }

    fn event_id(frame: Option<serde_json::Value>) -> u64 {
        let frame = frame.unwrap();
        assert_eq!(frame["type"], "event", "{frame}");
        frame["event"]["id"].as_u64().unwrap()
    }

    #[test]
    fn streams_the_events_after_the_cursor_it_was_opened_with_then_each_new_one() {
        let daemon = Daemon::start("stream-order");
        let ids: Vec<u64> = (1..=3).map(|n| daemon.append(n)).collect();
        let mut ws = daemon.follow(ids[0]);
        assert_eq!(
            [event_id(heard(&mut ws)), event_id(heard(&mut ws))],
            [ids[1], ids[2]]
        );
        let later = daemon.append(4);
        assert_eq!(event_id(heard(&mut ws)), later);
    }

    #[test]
    fn resets_a_cursor_from_another_store_and_closes() {
        let daemon = Daemon::start("stream-foreign");
        daemon.append(1);
        let mut ws = daemon
            .open(&format!("epoch={}&after=0", "0".repeat(32)))
            .unwrap();
        assert_eq!(
            [heard(&mut ws), heard(&mut ws)],
            [
                Some(serde_json::json!({"type": "reset", "reason": "foreign"})),
                Some(serde_json::json!({"close": 1005, "reason": ""})),
            ]
        );
    }

    #[test]
    fn refuses_an_upgrade_whose_cursor_isnt_whole_with_400() {
        let daemon = Daemon::start("stream-refused");
        for query in ["after=0", "epoch=e&after=x", "epoch=e"] {
            match daemon.open(query) {
                Err(tungstenite::Error::Http(answer)) => assert_eq!(answer.status(), 400),
                other => panic!("{query}: {other:?}"),
            }
        }
    }

    #[test]
    fn closes_with_1011_a_stream_whose_page_wont_frame() {
        let daemon = Daemon::start("stream-broken");
        rusqlite::Connection::open(daemon.dir.path().join("bazhen.db"))
            .unwrap()
            .execute(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                 VALUES ((SELECT id FROM host), '2026-11-01T00:00:00.000Z', 'task.exploded',
                   'task', 't', 'system', '{}')",
                (),
            )
            .unwrap();
        let mut ws = daemon.follow(0);
        assert_eq!(
            heard(&mut ws),
            Some(serde_json::json!({"close": 1011, "reason": "internal error"}))
        );
    }

    #[test]
    fn closes_going_away_when_the_daemon_stops() {
        let daemon = Daemon::start("stream-stop");
        let mut ws = daemon.follow(0);
        daemon.stop.now(crate::routes::Reason::Requested);
        assert_eq!(
            heard(&mut ws),
            Some(serde_json::json!({"close": 1001, "reason": ""}))
        );
    }

    #[test]
    fn answers_a_client_that_closes_with_a_close_of_its_own() {
        let daemon = Daemon::start("stream-client-close");
        let mut ws = daemon.follow(0);
        ws.send(tungstenite::Message::Close(None)).unwrap();
        let ended = loop {
            match ws.read() {
                Ok(_) => {}
                Err(err) => break err,
            }
        };
        assert!(
            matches!(ended, tungstenite::Error::ConnectionClosed),
            "{ended}"
        );
    }

    #[test]
    fn answers_a_client_that_closes_while_a_page_is_still_queued_for_it() {
        let daemon = Daemon::start("stream-close-mid-page");
        for n in 1..=200 {
            daemon.append(n);
        }
        let mut ws = daemon.follow(0);
        ws.send(tungstenite::Message::Close(None)).unwrap();
        let ended = loop {
            match ws.read() {
                Ok(_) => {}
                Err(err) => break err,
            }
        };
        assert!(
            matches!(ended, tungstenite::Error::ConnectionClosed),
            "{ended}"
        );
    }

    /// Beating every 200 ms of a paused clock, patient for three beats.
    const BEAT: Heartbeat = Heartbeat {
        every: std::time::Duration::from_millis(200),
        patience: 3,
    };

    /// A stream to a client in this process, on a paused clock: what the client gets, what it
    /// says, and the stream's task, which ends when the stream does.
    struct Peer {
        gets: mpsc::UnboundedReceiver<Message>,
        says: mpsc::UnboundedSender<Message>,
        ended: tokio::task::JoinHandle<()>,
        tasks: TaskTracker,
    }

    fn peer(store: &Writer) -> Peer {
        peer_of(store, None)
    }

    /// The same, for a device's stream that ends with `device`.
    fn peer_of(store: &Writer, device: Option<CancellationToken>) -> Peer {
        let epoch = store.reader().unwrap().reads().epoch().unwrap();
        let (to_peer, gets) = mpsc::unbounded_channel();
        let (says, from_peer) = mpsc::unbounded_channel::<Message>();
        let sink = futures_util::sink::unfold(to_peer, |to: mpsc::UnboundedSender<Message>, m| {
            let sent = to.send(m).map(|()| to);
            async move { sent }
        });
        let heard = futures_util::stream::unfold(from_peer, |mut from| async move {
            let message = from.recv().await?;
            Some((Ok::<_, std::convert::Infallible>(message), from))
        });
        let how = Streaming {
            store: store.clone(),
            stop: CancellationToken::new(),
            device,
            heartbeat: BEAT,
        };
        let tasks = TaskTracker::new();
        let ended = tasks.spawn(over(sink, heard, Cursor { epoch, after: 0 }, how, None));
        Peer {
            gets,
            says,
            ended,
            tasks,
        }
    }

    impl Peer {
        /// Answers each ping as a browser does, handing on the ids of the events it is sent.
        fn answering(self) -> (mpsc::UnboundedReceiver<u64>, tokio::task::JoinHandle<()>) {
            let Self {
                mut gets,
                says,
                ended,
                tasks,
            } = self;
            let (ids, events) = mpsc::unbounded_channel();
            tasks.spawn(async move {
                while let Some(message) = gets.recv().await {
                    match message {
                        Message::Ping(_) => {
                            let _ = says.send(Message::Pong(Bytes::new()));
                        }
                        Message::Text(text) => {
                            let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
                            let _ = ids.send(frame["event"]["id"].as_u64().unwrap());
                        }
                        _ => {}
                    }
                }
            });
            (events, ended)
        }
    }

    fn writer(dir: &TempDir) -> (Writer, crate::writer::Thread) {
        let path = dir.path().join("bazhen.db");
        crate::writer::start(Store::open(&path).unwrap(), &path).unwrap()
    }

    async fn appended(store: &Writer, n: u8) -> u64 {
        store
            .run(move |store| store.write(|w| w.append(&created(n))))
            .await
            .unwrap()
            .unwrap()
    }

    #[test]
    fn sends_a_stream_its_device_ended_before_it_opened_nothing_but_a_policy_close() {
        let dir = TempDir::new("stream-revoked");
        let (store, thread) = writer(&dir);
        paused().block_on(async {
            appended(&store, 1).await;
            let device = CancellationToken::new();
            device.cancel();
            let mut peer = peer_of(&store, Some(device));
            peer.ended.await.unwrap();
            let mut got = Vec::new();
            while let Ok(message) = peer.gets.try_recv() {
                got.push(message);
            }
            assert_eq!(got, vec![closing(close_code::POLICY, "")]);
        });
        thread.finish();
    }

    #[test]
    fn ends_a_client_that_stops_answering_pings() {
        let dir = TempDir::new("stream-silent");
        let (store, thread) = writer(&dir);
        paused().block_on(async {
            let mut peer = peer(&store);
            let start = Instant::now();
            tokio::time::sleep(BEAT.every * 3 / 2).await;
            assert!(matches!(peer.gets.try_recv(), Ok(Message::Ping(_))));
            assert!(
                !peer.ended.is_finished(),
                "ended before its ping was due an answer"
            );
            peer.ended.await.unwrap();
            assert_eq!(start.elapsed(), BEAT.every * 2);
            drop(peer.says);
        });
        thread.finish();
    }

    #[test]
    fn keeps_a_client_that_answers_pings() {
        let dir = TempDir::new("stream-answering");
        let (store, thread) = writer(&dir);
        paused().block_on(async {
            let (mut events, ended) = peer(&store).answering();
            tokio::time::sleep(BEAT.every * 10).await;
            assert!(!ended.is_finished(), "ended a client that answers");
            let id = appended(&store, 1).await;
            assert_eq!(events.recv().await, Some(id));
        });
        thread.finish();
    }

    #[test]
    fn keeps_a_client_that_answers_after_the_daemon_stalls_for_beats() {
        let dir = TempDir::new("stream-stalled");
        let (store, thread) = writer(&dir);
        paused().block_on(async {
            let first = appended(&store, 1).await;
            let (mut events, ended) = peer(&store).answering();
            assert_eq!(events.recv().await, Some(first));
            // The clock jumps three beats while no task runs, as a daemon stalled would find it.
            tokio::time::advance(BEAT.every * 3).await;
            tokio::time::sleep(BEAT.every * 5).await;
            assert!(
                !ended.is_finished(),
                "ended a client that had no turn to answer"
            );
            let id = appended(&store, 2).await;
            assert_eq!(events.recv().await, Some(id));
        });
        thread.finish();
    }

    #[test]
    fn keeps_a_client_that_sends_no_pongs_while_it_keeps_reporting() {
        let dir = TempDir::new("stream-reporting");
        let (store, thread) = writer(&dir);
        paused().block_on(async {
            let mut peer = peer(&store);
            let says = peer.says.clone();
            // It reports a quarter-beat apart for as long as it is heard, never answering a ping.
            peer.tasks.spawn(async move {
                let report = r#"{"type":"visibility","visible":true}"#;
                while says.send(Message::text(report)).is_ok() {
                    tokio::time::sleep(BEAT.every / 4).await;
                }
            });
            tokio::time::sleep(BEAT.every * 10).await;
            assert!(
                !peer.ended.is_finished(),
                "ended a client that keeps reporting"
            );
            let id = appended(&store, 1).await;
            let sent = loop {
                match peer.gets.recv().await {
                    Some(Message::Text(text)) => break text,
                    Some(_) => {}
                    None => panic!("ended a client that keeps reporting"),
                }
            };
            let frame: serde_json::Value = serde_json::from_str(&sent).unwrap();
            assert_eq!(frame["event"]["id"].as_u64(), Some(id));
        });
        thread.finish();
    }

    #[test]
    fn ends_a_client_whose_frame_is_over_a_kibibyte() {
        let daemon = Daemon::start("stream-oversized");
        let mut ws = daemon.follow(0);
        ws.send(tungstenite::Message::text(
            "x".repeat(EVENT_FRAME_MAX_BYTES + 1),
        ))
        .unwrap();
        assert!(
            !matches!(heard(&mut ws), Some(frame) if frame["type"] == "event"),
            "still streaming"
        );
        assert_eq!(heard(&mut ws), None);
    }

    #[test]
    fn fails_a_page_holding_an_event_that_wont_frame_sending_none_of_it() {
        let dir = TempDir::new("feed-broken");
        let (mut store, mut feed) = opened(&dir);
        append(&mut store, 1);
        let db = rusqlite::Connection::open(dir.path().join("bazhen.db")).unwrap();
        db.execute(
            "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
             VALUES ((SELECT id FROM host), '2026-11-01T00:00:00.000Z', 'task.exploded', 'task',
               't', 'system', '{}')",
            (),
        )
        .unwrap();
        assert!(matches!(feed.next(store.reads()), Err(Broke::Frame(_))));
        assert!(matches!(feed.next(store.reads()), Err(Broke::Frame(_))));
    }
}
