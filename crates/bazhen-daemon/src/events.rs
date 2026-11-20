//! `/v1/events`: the log from a client's cursor, the backlog then each new event, every one once.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, close_code};
use bazhen_protocol::events::{ClientEventFrame, EventFrame, ResetReason};
use bazhen_store::{FrameError, Page, Reads, StoredEvent};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
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
    pub(crate) heartbeat: Heartbeat,
}

/// A frame for the writer, and whether it ends a page.
#[derive(Debug)]
struct Out {
    message: Message,
    ends_page: bool,
}

/// How a stream ended: with frames still to send, or with nothing more to say.
#[derive(Debug, PartialEq, Eq)]
enum Ending {
    Close,
    Gone,
}

/// Streams the log on `socket` from `cursor` until the client goes, the cursor can't resume, or
/// the daemon stops. `held` keeps the connection's place under its listener's cap and drain.
pub(crate) async fn stream(socket: WebSocket, cursor: Cursor, how: Streaming, held: Option<Held>) {
    let _held = held;
    let (sink, heard) = socket.split();
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

/// Sends what is queued, in order, saying when each page's last frame is written.
async fn write(
    mut sink: SplitSink<WebSocket, Message>,
    mut queued: mpsc::UnboundedReceiver<Out>,
    unsent: Arc<AtomicUsize>,
    written: Arc<Notify>,
) {
    while let Some(Out { message, ends_page }) = queued.recv().await {
        let counted = matches!(message, Message::Text(_));
        let closing = matches!(message, Message::Close(_));
        let sent = sink.send(message).await;
        if counted {
            unsent.fetch_sub(1, Ordering::Relaxed);
        }
        if sent.is_err() || closing {
            return;
        }
        if ends_page {
            written.notify_one();
        }
    }
}

fn closing(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

/// Feeds the log to the writer and listens to the client, until the stream ends.
async fn follow(
    mut heard: SplitStream<WebSocket>,
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
    let mut pulse = Pulse::new(how.heartbeat.patience);
    let every = how.heartbeat.every;
    let mut beat = tokio::time::interval_at(Instant::now() + every, every);
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
            message = heard.next() => match message {
                None | Some(Err(_) | Ok(Message::Close(_))) => return Ending::Gone,
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

    use super::*;
    use crate::testing::TempDir;

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

    /// The socket's routes on loopback TCP, over a store of their own, beating every 200 ms.
    struct Daemon {
        address: std::net::SocketAddr,
        stop: crate::routes::Stop,
        store: Writer,
        thread: Option<crate::writer::Thread>,
        runtime: tokio::runtime::Runtime,
        dir: TempDir,
    }

    const BEAT: Heartbeat = Heartbeat {
        every: std::time::Duration::from_millis(200),
        patience: 3,
    };

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
            let mut shared = crate::routes::Shared::new("f", stop.clone(), store.clone());
            shared.heartbeat = BEAT;
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
    fn ends_a_client_that_stops_answering_pings() {
        let daemon = Daemon::start("stream-silent");
        let mut ws = daemon.follow(0);
        std::thread::sleep(BEAT.every * 5);
        assert_eq!(heard(&mut ws), None);
    }

    #[test]
    fn keeps_a_client_that_answers_pings() {
        let daemon = Daemon::start("stream-answering");
        let mut ws = daemon.follow(0);
        ws.get_ref().set_read_timeout(Some(BEAT.every / 4)).unwrap();
        let until = std::time::Instant::now() + BEAT.every * 5;
        while std::time::Instant::now() < until {
            match ws.read() {
                Ok(_) => {}
                Err(tungstenite::Error::Io(err))
                    if err.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(err) => panic!("ended: {err}"),
            }
        }
        ws.get_ref()
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let id = daemon.append(1);
        assert_eq!(event_id(heard(&mut ws)), id);
    }

    #[test]
    fn keeps_a_client_that_sends_no_pongs_while_it_keeps_reporting() {
        let daemon = Daemon::start("stream-reporting");
        let mut ws = daemon.follow(0);
        let until = std::time::Instant::now() + BEAT.every * 5;
        while std::time::Instant::now() < until {
            ws.send(tungstenite::Message::text(
                r#"{"type":"visibility","visible":true}"#,
            ))
            .unwrap();
            std::thread::sleep(BEAT.every / 4);
        }
        let id = daemon.append(1);
        assert_eq!(event_id(heard(&mut ws)), id);
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
