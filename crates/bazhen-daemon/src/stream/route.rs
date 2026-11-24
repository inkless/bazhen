//! A terminal's stream, `GET /v1/terminals/{id}/stream`, over a WebSocket, as
//! `apps/daemon/src/stream/server.ts` serves it: a view says hello and joins the terminal's hub,
//! its input goes to the hub as binary frames, and whatever ends it is said in an `error` frame
//! before the close. Each socket is served by a task of the daemon's own, which owns the view's
//! attachment once it has joined and leaves it however the socket ends.

use std::fmt;
use std::future::Future;
use std::pin::{Pin, pin};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Extension;
use axum::body::Bytes;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocketUpgrade, close_code};
use axum::extract::{Path, State};
use axum::response::Response;
use bazhen_holder_proto::body::Size;
use bazhen_protocol::ids::{AttachmentId, TerminalId};
use bazhen_protocol::stream::{AttachmentMode, Resumes, STREAM_FRAME_MAX_BYTES, StreamServerFrame};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::closing::{ClosingBudget, Place};
use super::hub::{self, Attachment, AttachmentLog, Hub, JoinError, LeaveReason, Runtime, Viewer};
use super::said::{Said, read};
use super::view::{self, Inbox, MOST_UNSENT, Outbox, Unsent, ViewSocket, write_one};
use crate::accept::Held;
use crate::heartbeat::{Beat, Heartbeat, Pulse};
use crate::paired;
use crate::routes::{Shared, not_found};
use crate::terminals::Answer;

/// What a view from another build is told.
pub(crate) const ANOTHER_PAGE: &str =
    "this page is from another build of Bazhen than the daemon: reload it";

/// The hub, as the route drives it.
pub(crate) trait Views: Send + Sync + 'static {
    fn join(
        &self,
        terminal: TerminalId,
        viewer: Viewer,
        size: Size,
        resumes: Option<Resumes>,
    ) -> Answer<'static, Result<Attachment, JoinError>>;

    fn write(&self, terminal: &TerminalId, attachment: &AttachmentId, input: &[u8]);

    fn engage(&self, terminal: &TerminalId, attachment: &AttachmentId);

    fn declare_epoch(&self, terminal: &TerminalId, attachment: &AttachmentId, epoch: u64);

    fn resize(&self, terminal: &TerminalId, attachment: &AttachmentId, size: Size);

    fn leave(&self, terminal: &TerminalId, attachment: &AttachmentId, reason: LeaveReason);

    /// Closes every stream, as the daemon stops.
    fn close(&self);
}

impl<R: Runtime, L: AttachmentLog> Views for Hub<R, L> {
    fn join(
        &self,
        terminal: TerminalId,
        viewer: Viewer,
        size: Size,
        resumes: Option<Resumes>,
    ) -> Answer<'static, Result<Attachment, JoinError>> {
        let hub = self.clone();
        Box::pin(async move { hub.join(&terminal, viewer, size, resumes).await })
    }

    fn write(&self, terminal: &TerminalId, attachment: &AttachmentId, input: &[u8]) {
        Hub::write(
            self,
            terminal,
            &hub::Writer::View(attachment.clone()),
            input,
        );
    }

    fn engage(&self, terminal: &TerminalId, attachment: &AttachmentId) {
        Hub::engage(self, terminal, attachment);
    }

    fn declare_epoch(&self, terminal: &TerminalId, attachment: &AttachmentId, epoch: u64) {
        Hub::declare_epoch(self, terminal, attachment, epoch);
    }

    fn resize(&self, terminal: &TerminalId, attachment: &AttachmentId, size: Size) {
        Hub::resize(self, terminal, attachment, size);
    }

    fn leave(&self, terminal: &TerminalId, attachment: &AttachmentId, reason: LeaveReason) {
        Hub::leave(self, terminal, attachment, reason);
    }

    fn close(&self) {
        Hub::close(self);
    }
}

/// Whether a terminal runs in an incarnation a view can open: `runtimeRef` in `server.ts`.
pub(crate) type Running =
    Arc<dyn Fn(TerminalId) -> Answer<'static, Result<bool, String>> + Send + Sync>;

/// What every terminal stream shares.
#[derive(Clone)]
pub(crate) struct Streams {
    pub(crate) views: Arc<dyn Views>,
    pub(crate) running: Running,
    pub(crate) protocol_id: Arc<str>,
    /// What every closing stream may still hold, together.
    pub(crate) closing: Arc<ClosingBudget>,
    /// Where each socket is served, which the daemon's drain waits for.
    pub(crate) tasks: TaskTracker,
    /// Where the hub does its own work.
    pub(crate) hub: TaskTracker,
}

impl Streams {
    /// Closes every stream, a parked one without waiting out its linger.
    pub(crate) fn close(&self) {
        self.views.close();
        self.hub.close();
    }

    /// Waits up to `within` for the hub's work to finish, once the streams are closed.
    pub(crate) async fn wait(&self, within: std::time::Duration) {
        let _ = tokio::time::timeout(within, self.hub.wait()).await;
    }
}

impl fmt::Debug for Streams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Streams")
            .field("protocol_id", &self.protocol_id)
            .field("closing", &self.closing)
            .finish_non_exhaustive()
    }
}

/// One socket's lot: when it is to end, and how often it is pinged.
#[derive(Debug, Clone)]
pub(crate) struct How {
    pub(crate) stop: CancellationToken,
    /// For a paired device's view, cancelled once the device is revoked or lapses.
    pub(crate) device: Option<CancellationToken>,
    /// The name the device was paired with, which its view carries.
    pub(crate) device_name: Option<String>,
    pub(crate) heartbeat: Heartbeat,
}

/// The terminal stream. A request that isn't an upgrade reaches no route, as on the TypeScript
/// daemon; nor does one to a daemon that runs no terminals.
pub(crate) async fn stream(
    State(shared): State<Shared>,
    Path(terminal): Path<String>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    held: Option<Extension<Held>>,
    viewer: Option<Extension<paired::Viewer>>,
) -> Response {
    let (Ok(upgrade), Some(streams)) = (upgrade, shared.streams.clone()) else {
        return not_found();
    };
    // A device's view is held, to close when the device is revoked or lapses.
    let (device, device_name) = match viewer {
        Some(Extension(paired::Viewer::Device { id, name, required })) => (
            Some(
                shared
                    .pairing
                    .holds
                    .hold(id.as_str(), shared.stop.token(), required),
            ),
            Some(name),
        ),
        _ => (None, None),
    };
    let how = How {
        stop: shared.stop.token().clone(),
        device: device.as_ref().map(|hold| hold.token().clone()),
        device_name,
        heartbeat: shared.heartbeat,
    };
    upgrade
        .max_message_size(STREAM_FRAME_MAX_BYTES)
        .max_frame_size(STREAM_FRAME_MAX_BYTES)
        .on_upgrade(move |socket| async move {
            let tasks = streams.tasks.clone();
            tasks.spawn(async move {
                let (_device, _held) = (device, held);
                let (sink, heard) = socket.split();
                serve(sink, heard, terminal, streams, how).await;
            });
        })
}

/// A view's attachment, which it leaves once dropped, as it is however its socket ends.
struct Leaving {
    views: Arc<dyn Views>,
    terminal: TerminalId,
    id: AttachmentId,
    reason: LeaveReason,
}

impl Drop for Leaving {
    fn drop(&mut self) {
        self.views.leave(&self.terminal, &self.id, self.reason);
    }
}

/// A socket closing: its place in the budget, and when it is ended whatever it holds.
struct Closing {
    place: Place,
    by: Instant,
}

/// A view joining: the terminal it joined and its attachment, or what it is to be told.
type Joining = Pin<Box<dyn Future<Output = Result<(TerminalId, Attachment), String>> + Send>>;

/// What the route sends itself, ahead of nothing the hub has queued. A pong, and the heartbeat's
/// ping, is queued at most once until the writer takes it, so a peer that pings without reading
/// what it is sent grows nothing: the one pong queued answers every ping before it.
enum Own {
    Frame(Message),
    Pong,
    Ping,
}

/// Whether a pong, and a ping, is queued and not yet taken by the writer.
#[derive(Debug, Default)]
struct Queued {
    pong: AtomicBool,
    ping: AtomicBool,
}

impl Queued {
    fn of(&self, own: &Own) -> Option<&AtomicBool> {
        match own {
            Own::Frame(_) => None,
            Own::Pong => Some(&self.pong),
            Own::Ping => Some(&self.ping),
        }
    }
}

/// The queue of what the route sends itself: its end and the writer's.
fn own_queue() -> (Ours, Mine) {
    let (tx, rx) = mpsc::unbounded_channel();
    let queued = Arc::new(Queued::default());
    (
        Ours {
            tx,
            queued: Arc::clone(&queued),
        },
        Mine { rx, queued },
    )
}

/// The route's end of what it sends itself.
struct Ours {
    tx: mpsc::UnboundedSender<Own>,
    queued: Arc<Queued>,
}

impl Ours {
    /// Queues `own` for the writer, unless it is a pong or a ping one is already queued for.
    fn send(&self, own: Own) {
        if self
            .queued
            .of(&own)
            .is_some_and(|queued| queued.swap(true, Ordering::AcqRel))
        {
            return;
        }
        // The writer goes only once the socket is done with, so nothing sent here is lost.
        let _ = self.tx.send(own);
    }
}

/// The writer's end of what the route sends itself.
struct Mine {
    rx: mpsc::UnboundedReceiver<Own>,
    queued: Arc<Queued>,
}

impl Mine {
    /// What the route sends next; a pong or a ping taken may be queued again.
    async fn recv(&mut self) -> Option<Own> {
        let own = self.rx.recv().await?;
        if let Some(queued) = self.queued.of(&own) {
            queued.store(false, Ordering::Release);
        }
        Some(own)
    }
}

fn text(frame: &StreamServerFrame) -> Option<Message> {
    match serde_json::to_string(frame) {
        Ok(text) => Some(Message::Text(text.into())),
        Err(err) => {
            tracing::error!("bazhen: can't write a stream's frame: {err}");
            None
        }
    }
}

/// Resolves once `token` is cancelled, and never without one.
async fn cancelled(token: Option<&CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

async fn until(by: Option<Instant>) {
    match by {
        Some(by) => tokio::time::sleep_until(by).await,
        None => std::future::pending().await,
    }
}

async fn joined(joining: &mut Option<Joining>) -> Result<(TerminalId, Attachment), String> {
    match joining {
        Some(joining) => joining.as_mut().await,
        None => std::future::pending().await,
    }
}

/// Whether a terminal runs, then the view joined to it, or what it is to be told it isn't.
async fn join(
    views: Arc<dyn Views>,
    running: Running,
    terminal: TerminalId,
    viewer: Viewer,
    size: Size,
    resumes: Option<Resumes>,
) -> Result<(TerminalId, Attachment), String> {
    match running(terminal.clone()).await {
        Ok(true) => {}
        Ok(false) => return Err(format!("no running terminal {terminal}")),
        Err(err) => return Err(format!("attach failed: {err}")),
    }
    views
        .join(terminal.clone(), viewer, size, resumes)
        .await
        .map(|attachment| (terminal, attachment))
        .map_err(|err| match err {
            JoinError::Refused(message) => message,
            err => format!("attach failed: {err}"),
        })
}

/// One socket's view, as what it says moves it.
struct View<'a> {
    streams: &'a Streams,
    how: &'a How,
    terminal: String,
    /// What the route itself sends, ahead of nothing the hub has queued.
    own: Ours,
    /// The hub's end of the view's queue, until the view joins with it.
    outbox: Option<Outbox>,
    unsent: Unsent,
    said_hello: bool,
    joining: Option<Joining>,
    leaving: Option<Leaving>,
    closing: Option<Closing>,
}

impl View<'_> {
    fn send(&self, message: Message) {
        self.own.send(Own::Frame(message));
    }

    /// The socket begins to close, given until the heartbeat would end it to send what it holds.
    fn closing(&mut self) {
        if self.closing.is_none() {
            self.closing = Some(Closing {
                place: self.streams.closing.close(self.unsent.clone()),
                by: Instant::now() + self.how.heartbeat.close_within(),
            });
        }
    }

    fn close(&mut self, code: Option<u16>) {
        let frame = code.map(|code| CloseFrame {
            code,
            reason: "".into(),
        });
        self.send(Message::Close(frame));
        self.closing();
    }

    fn refuse(&mut self, message: String) {
        if let Some(error) = text(&StreamServerFrame::Error { message }) {
            self.send(error);
        }
        self.close(None);
    }

    fn device_close(&self) -> u16 {
        // A device's token is the daemon's child, so both end as the daemon stops.
        if self.how.stop.is_cancelled() {
            close_code::AWAY
        } else {
            close_code::POLICY
        }
    }

    /// The view joined, or was refused. One that joined while its socket closes leaves at once;
    /// one whose queue the hub has already let go of closes.
    fn joined(&mut self, joined: Result<(TerminalId, Attachment), String>, drained: bool) {
        self.joining = None;
        match joined {
            Ok((terminal, attachment)) => {
                let leaving = Leaving {
                    views: Arc::clone(&self.streams.views),
                    terminal,
                    id: attachment.id,
                    reason: LeaveReason::ClientClosed,
                };
                if self.closing.is_none() {
                    self.leaving = Some(leaving);
                } else if drained {
                    self.close(None);
                }
            }
            Err(message) => self.refuse(message),
        }
    }

    fn heard(&mut self, message: Message) {
        match message {
            Message::Text(frame) => match read(frame.as_str()) {
                Some(said) => self.said(said),
                None => self.refuse("unreadable frame".to_owned()),
            },
            Message::Binary(input) => {
                if let Some(at) = &self.leaving {
                    self.streams.views.write(&at.terminal, &at.id, &input);
                }
            }
            _ => {}
        }
    }

    fn said(&mut self, said: Said) {
        let views = &self.streams.views;
        match (said, &self.leaving) {
            (
                Said::Hello {
                    protocol_id,
                    mode,
                    size,
                    resumes,
                },
                _,
            ) => self.hello(protocol_id.as_deref(), mode, size, resumes),
            (Said::Ping, _) => self.own.send(Own::Pong),
            (Said::Resize(size), Some(at)) => views.resize(&at.terminal, &at.id, size),
            (Said::Engage, Some(at)) => views.engage(&at.terminal, &at.id),
            (Said::Epoch(epoch), Some(at)) => views.declare_epoch(&at.terminal, &at.id, epoch),
            (Said::Resize(_) | Said::Engage | Said::Epoch(_), None) => {}
        }
    }

    /// A view's first hello joins it; any other is ignored.
    fn hello(
        &mut self,
        protocol_id: Option<&str>,
        mode: AttachmentMode,
        size: Size,
        resumes: Option<Resumes>,
    ) {
        if std::mem::replace(&mut self.said_hello, true) {
            return;
        }
        if protocol_id != Some(&*self.streams.protocol_id) {
            return self.refuse(ANOTHER_PAGE.to_owned());
        }
        let (Some(terminal), Some(outbox)) =
            (TerminalId::parse(&self.terminal), self.outbox.take())
        else {
            return self.refuse(format!("no running terminal {}", self.terminal));
        };
        let viewer = Viewer {
            mode,
            device_name: self.how.device_name.clone(),
            outbox,
        };
        self.joining = Some(Box::pin(join(
            Arc::clone(&self.streams.views),
            Arc::clone(&self.streams.running),
            terminal,
            viewer,
            size,
            resumes,
        )));
    }
}

/// Serves one socket: sends on `sink` and hears from `heard` until it ends, leaving the view's
/// attachment, if it joined, as it does. A close the route sends goes after what the hub queued
/// before it, and the view leaves its attachment once that close is sent, so a peer that never
/// answers holds no lease. The socket then waits, reading what the peer still sends, for the
/// peer's close, as long as the close may take: dropped at once, unread input would reset the
/// connection under its last frames. A close that answers the peer's ends it once sent.
pub(crate) async fn serve<E>(
    sink: impl Sink<Message> + Send,
    heard: impl Stream<Item = Result<Message, E>> + Send,
    terminal: String,
    streams: Streams,
    how: How,
) {
    let (own, mine) = own_queue();
    let (outbox, inbox) = view::queue(MOST_UNSENT);
    let (released, unsent, quiet) = (inbox.released(), inbox.unsent(), inbox.timed_out());
    let (drained_tx, mut drained) = oneshot::channel();
    let mut writing = pin!(write(sink, mine, inbox, drained_tx));
    let mut view = View {
        streams: &streams,
        how: &how,
        terminal,
        own,
        outbox: Some(outbox),
        unsent: unsent.clone(),
        said_hello: false,
        joining: None,
        leaving: None,
        closing: None,
    };
    let mut pulse = Pulse::new(how.heartbeat.patience);
    let every = how.heartbeat.every;
    let mut beat = tokio::time::interval_at(Instant::now() + every, every);
    beat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut heard = pin!(heard);
    let (mut was_released, mut was_drained) = (false, false);
    // Whether the route's close has been sent, and whether the peer's has been heard: once both
    // have, the socket is done with.
    let (mut closed, mut peer_closed) = (false, false);
    loop {
        let open = view.closing.is_none();
        tokio::select! {
            biased;
            wrote = &mut writing, if !closed => match wrote {
                Wrote::Closed if peer_closed => return,
                Wrote::Closed => {
                    closed = true;
                    view.leaving = None;
                }
                Wrote::Failed => return,
            },
            () = cancelled(view.closing.as_ref().map(|c| c.place.ended())) => return,
            () = until(view.closing.as_ref().map(|c| c.by)) => return,
            () = how.stop.cancelled(), if open => view.close(Some(close_code::AWAY)),
            () = cancelled(how.device.as_ref()), if open => {
                let code = view.device_close();
                view.close(Some(code));
            }
            joined = joined(&mut view.joining) => view.joined(joined, was_drained),
            // The hub let go of the view: it closes once what it was given is sent.
            () = released.cancelled(), if !was_released => {
                was_released = true;
                view.closing();
            }
            sent = &mut drained, if !was_drained => {
                was_drained = true;
                if sent.is_ok() && view.joining.is_none() {
                    view.close(None);
                }
            }
            message = heard.next() => match message {
                None | Some(Err(_)) => return,
                // The peer's answer to the route's close, or a close of its own.
                Some(Ok(Message::Close(_))) if closed => return,
                Some(Ok(Message::Close(_))) => {
                    peer_closed = true;
                    view.leaving = None;
                    view.close(None);
                }
                Some(Ok(message)) if open => {
                    pulse.heard();
                    view.heard(message);
                }
                // Read while the socket closes, only so the peer's input isn't left unread.
                Some(Ok(_)) => {}
            },
            _ = beat.tick(), if open => match pulse.beat(unsent.get()) {
                Beat::Ping => view.own.send(Own::Ping),
                Beat::Gone => {
                    // A view still joining is ended as timed out by the hub, as it lets go.
                    quiet.timed_out();
                    if let Some(leaving) = &mut view.leaving {
                        leaving.reason = LeaveReason::TimedOut;
                    }
                    return;
                }
            },
        }
    }
}

/// The socket's sink, which sends what the hub queues and what the route sends itself.
struct Socket<S>(Pin<Box<S>>);

impl<S: Sink<Message> + Send> ViewSocket for Socket<S> {
    type Error = ();

    async fn output(&mut self, output: Vec<u8>) -> Result<(), ()> {
        self.send(Message::Binary(output.into())).await
    }

    async fn frame(&mut self, frame: &StreamServerFrame) -> Result<(), ()> {
        let Some(message) = text(frame) else {
            return Ok(());
        };
        self.send(message).await
    }
}

impl<S: Sink<Message> + Send> Socket<S> {
    async fn send(&mut self, message: Message) -> Result<(), ()> {
        self.0.send(message).await.map_err(drop)
    }
}

/// How the writer ended: the route's close sent, or a send failed.
#[derive(Debug, PartialEq, Eq)]
enum Wrote {
    Closed,
    Failed,
}

/// Sends what the hub queues for the view, saying once it has all been sent, and what the route
/// sends itself, until the route's close is sent or a send fails; then flushes, which sends the
/// answer the socket queued to a client's close. What the hub queued before the route's close goes
/// ahead of it.
async fn write(
    sink: impl Sink<Message> + Send,
    mut mine: Mine,
    mut inbox: Inbox,
    drained: oneshot::Sender<()>,
) -> Wrote {
    let mut socket = Socket(Box::pin(sink));
    let mut drained = Some(drained);
    let wrote = loop {
        tokio::select! {
            biased;
            own = mine.recv() => {
                let Some(own) = own else {
                    break Wrote::Failed;
                };
                let message = match own {
                    Own::Frame(message) => message,
                    Own::Pong => match text(&StreamServerFrame::Pong) {
                        Some(pong) => pong,
                        None => continue,
                    },
                    Own::Ping => Message::Ping(Bytes::new()),
                };
                let close = matches!(message, Message::Close(_));
                if close && !write_queued(&mut inbox, &mut socket).await {
                    break Wrote::Failed;
                }
                if socket.send(message).await.is_err() {
                    break Wrote::Failed;
                }
                if close {
                    break Wrote::Closed;
                }
            }
            out = inbox.recv(), if drained.is_some() => match out {
                Some(out) => {
                    if write_one(out, &mut socket).await.is_err() {
                        break Wrote::Failed;
                    }
                }
                None => {
                    if let Some(drained) = drained.take() {
                        let _ = drained.send(());
                    }
                }
            },
        }
    };
    let _ = socket.0.flush().await;
    wrote
}

/// Writes what the hub has queued so far; false if a send fails.
async fn write_queued<S: Sink<Message> + Send>(inbox: &mut Inbox, socket: &mut Socket<S>) -> bool {
    while let Some(out) = inbox.try_recv() {
        if write_one(out, socket).await.is_err() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    //! The route over the hub's fake runtime, each socket in-process: what the client says goes
    //! in on one channel, what it is sent comes out on another.

    use std::convert::Infallible;
    use std::time::Duration;

    use super::*;
    use crate::stream::closing::MAX_CLOSING_BYTES;
    use crate::stream::hub::HubOptions;
    use crate::stream::hub::tests::{Fake, Log, size};
    use crate::testing::runtime;

    const WAIT: Duration = Duration::from_secs(5);
    const BUILD: &str = "this-build";

    fn terminal() -> TerminalId {
        TerminalId::mint(1, [7; 16])
    }

    fn hello(protocol_id: &str, mode: &str) -> String {
        format!(
            r#"{{"type":"hello","protocolId":"{protocol_id}","mode":"{mode}","cols":80,"rows":24}}"#
        )
    }

    /// A ping every `every`, patient for one beat.
    fn how(every: Duration) -> How {
        How {
            stop: CancellationToken::new(),
            device: None,
            device_name: None,
            heartbeat: Heartbeat { every, patience: 1 },
        }
    }

    fn quiet() -> How {
        how(Duration::from_secs(60))
    }

    /// The route over a fake terminal, which runs as `running` says.
    struct Served {
        fake: Fake,
        log: Log,
        streams: Streams,
    }

    impl Served {
        fn new(
            running: impl Fn(&TerminalId) -> Result<bool, String> + Send + Sync + 'static,
        ) -> Self {
            let (fake, log) = (Fake::new("", 0), Log::default());
            let hub = Hub::new(
                fake.clone(),
                log.clone(),
                HubOptions::default(),
                TaskTracker::new(),
            );
            let running = Arc::new(running);
            Self {
                fake,
                log,
                streams: Streams {
                    views: Arc::new(hub),
                    running: Arc::new(move |id| Box::pin(std::future::ready(running(&id)))),
                    protocol_id: Arc::from(BUILD),
                    closing: ClosingBudget::new(MAX_CLOSING_BYTES),
                    tasks: TaskTracker::new(),
                    hub: TaskTracker::new(),
                },
            }
        }

        fn running() -> Self {
            Self::new(|id| Ok(*id == terminal()))
        }

        /// A client that answers the route's close with its own, as a WebSocket peer does.
        fn open(&self, terminal: &str, how: How) -> Client {
            self.open_answering(terminal, how, true)
        }

        fn open_answering(&self, terminal: &str, how: How, answers_close: bool) -> Client {
            let (says, from_client) = mpsc::unbounded_channel::<Result<Message, Infallible>>();
            let (to_client, hears) = mpsc::unbounded_channel();
            let answer = says.clone();
            let sink = futures_util::sink::unfold(
                (to_client, answer),
                move |(to, answer), message: Message| async move {
                    if answers_close && matches!(message, Message::Close(_)) {
                        let _ = answer.send(Ok(Message::Close(None)));
                    }
                    to.send(message).map(|()| (to, answer)).map_err(drop)
                },
            );
            let said = futures_util::stream::unfold(from_client, |mut from| async move {
                from.recv().await.map(|message| (message, from))
            });
            let streams = self.streams.clone();
            self.streams
                .tasks
                .spawn(serve(sink, said, terminal.to_owned(), streams, how));
            Client { says, hears }
        }

        /// Whether every socket's task ended within the wait.
        async fn ended(&self) -> bool {
            self.streams.tasks.close();
            tokio::time::timeout(WAIT, self.streams.tasks.wait())
                .await
                .is_ok()
        }

        /// What the hub recorded of views ending.
        fn ends(&self) -> Vec<String> {
            let ended = self.log.events().into_iter();
            ended.filter(|event| event.starts_with("ended ")).collect()
        }
    }

    struct Client {
        says: mpsc::UnboundedSender<Result<Message, Infallible>>,
        hears: mpsc::UnboundedReceiver<Message>,
    }

    impl Client {
        fn say(&self, frame: &str) {
            let _ = self.says.send(Ok(Message::Text(frame.into())));
        }

        fn send(&self, message: Message) {
            let _ = self.says.send(Ok(message));
        }

        /// The next text frame by `by`, past output and pings, or what came instead.
        async fn next(&mut self, by: tokio::time::Instant) -> Heard {
            loop {
                match tokio::time::timeout_at(by, self.hears.recv()).await {
                    Err(_) => return Heard::Nothing,
                    Ok(None) => return Heard::Ended,
                    Ok(Some(Message::Text(text))) => {
                        return Heard::Frame(serde_json::from_str(&text).unwrap());
                    }
                    Ok(Some(Message::Close(close))) => return Heard::Closed(close),
                    Ok(Some(_)) => {}
                }
            }
        }

        /// Every text frame heard within the wait, and what ended them.
        async fn until_closed(&mut self) -> (Vec<StreamServerFrame>, Heard) {
            let by = tokio::time::Instant::now() + WAIT;
            let mut frames = vec![];
            loop {
                match self.next(by).await {
                    Heard::Frame(frame) => frames.push(frame),
                    other => return (frames, other),
                }
            }
        }

        /// Says hello, and waits to be told the view is attached.
        async fn attached(&mut self, mode: &str) -> AttachmentId {
            self.say(&hello(BUILD, mode));
            self.until(|frame| match frame {
                StreamServerFrame::Attached { attachment_id, .. } => Some(attachment_id),
                _ => None,
            })
            .await
            .unwrap_or_else(|heard| panic!("the view was never attached: {heard:?}"))
        }

        /// The first frame within the wait that `pick` keeps, or what came instead.
        async fn until<T>(
            &mut self,
            pick: impl Fn(StreamServerFrame) -> Option<T>,
        ) -> Result<T, Heard> {
            let by = tokio::time::Instant::now() + WAIT;
            loop {
                match self.next(by).await {
                    Heard::Frame(frame) => {
                        if let Some(picked) = pick(frame) {
                            return Ok(picked);
                        }
                    }
                    other => return Err(other),
                }
            }
        }
    }

    /// What a client heard within a wait: a text frame, the close, the stream ending without
    /// one, or nothing at all. A value, so a test waiting on a frame that never comes fails its
    /// own assertion rather than its wait.
    #[derive(Debug, PartialEq)]
    enum Heard {
        Frame(StreamServerFrame),
        Closed(Option<CloseFrame>),
        Ended,
        Nothing,
    }

    impl Heard {
        /// The code of the close heard, if a close with one was.
        fn code(&self) -> Option<u16> {
            match self {
                Self::Closed(Some(close)) => Some(close.code),
                _ => None,
            }
        }
    }

    /// `read` as soon as `done` says it is done, or as it is once a wait has passed.
    async fn once<T>(read: impl Fn() -> T, done: impl Fn(&T) -> bool) -> T {
        let until = Instant::now() + WAIT;
        loop {
            let value = read();
            if done(&value) || Instant::now() > until {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn ended(attachment: &AttachmentId, reason: &str) -> Vec<String> {
        vec![format!("ended {attachment} {reason}")]
    }

    fn error(message: &str) -> StreamServerFrame {
        StreamServerFrame::Error {
            message: message.to_owned(),
        }
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn attaches_a_view_that_says_hello_and_answers_its_ping() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let mut client = served.open(terminal().as_str(), quiet());
            client.attached("observe").await;
            client.say(r#"{"type":"ping"}"#);
            let pong = client
                .until(|frame| (frame == StreamServerFrame::Pong).then_some(frame))
                .await;
            assert_eq!(pong, Ok(StreamServerFrame::Pong));
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_a_page_from_another_build_with_an_error_then_closes() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let mut client = served.open(terminal().as_str(), quiet());
            client.say(&hello("another-build", "observe"));
            let refused = client.until_closed().await;
            assert_eq!(refused, (vec![error(ANOTHER_PAGE)], Heard::Closed(None)));
            assert_eq!((served.ended().await, served.log.events()), (true, vec![]));
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_a_terminal_that_isnt_running_with_an_error_then_closes() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let other = TerminalId::mint(2, [8; 16]);
            let mut unknown = served.open(other.as_str(), quiet());
            let mut unnamed = served.open("not-a-terminal", quiet());
            let unread = Served::new(|_| Err("the store has closed".to_owned()));
            let mut unreadable = unread.open(terminal().as_str(), quiet());
            let mut refusals = vec![];
            for client in [&mut unknown, &mut unnamed, &mut unreadable] {
                client.say(&hello(BUILD, "observe"));
                refusals.push(client.until_closed().await);
            }
            assert_eq!(
                refusals,
                [
                    (
                        vec![error(&format!("no running terminal {other}"))],
                        Heard::Closed(None)
                    ),
                    (
                        vec![error("no running terminal not-a-terminal")],
                        Heard::Closed(None)
                    ),
                    (
                        vec![error("attach failed: the store has closed")],
                        Heard::Closed(None)
                    ),
                ]
            );
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_an_unreadable_frame_with_an_error_then_closes() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let mut client = served.open(terminal().as_str(), quiet());
            client.say(
                r#"{"type":"hello","protocolId":"this-build","mode":"observe","cols":1,"rows":24}"#,
            );
            assert_eq!(
                client.until_closed().await,
                (vec![error("unreadable frame")], Heard::Closed(None))
            );
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_a_view_once_its_terminal_has_gone_after_sending_what_it_was_given() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let mut client = served.open(terminal().as_str(), quiet());
            client.attached("observe").await;
            served.fake.vanish();
            let (frames, heard) = client.until_closed().await;
            let gone = StreamServerFrame::Ended {
                reason: bazhen_protocol::stream::EndedReason::Disconnected,
            };
            assert_eq!((frames.last(), heard), (Some(&gone), Heard::Closed(None)));
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn types_binary_frames_only_from_its_driver_into_the_terminal_and_resizes_it_as_it_asks() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let mut client = served.open(terminal().as_str(), quiet());
            client.attached("interactive").await;
            let mut observer = served.open(terminal().as_str(), quiet());
            observer.attached("observe").await;
            let mut other = served.open(terminal().as_str(), quiet());
            other.attached("interactive").await;
            for view in [&mut observer, &mut other] {
                view.send(Message::Binary(Bytes::from_static(b"no\r")));
                // Its pong comes once what it said before has been read.
                view.say(r#"{"type":"ping"}"#);
                view.until(|frame| (frame == StreamServerFrame::Pong).then_some(()))
                    .await
                    .unwrap_or_else(|heard| panic!("never answered its ping: {heard:?}"));
            }
            client.say(r#"{"type":"engage"}"#);
            let epoch = client
                .until(|frame| match frame {
                    StreamServerFrame::Lease {
                        driver: true,
                        epoch,
                        ..
                    } => Some(epoch),
                    _ => None,
                })
                .await
                .unwrap_or_else(|heard| panic!("never made the driver: {heard:?}"));
            client.say(&format!(r#"{{"type":"epoch","epoch":{epoch}}}"#));
            client.send(Message::Binary(Bytes::from_static(b"ls\r")));
            client.say(r#"{"type":"resize","cols":100,"rows":30}"#);
            let resizes = once(|| served.fake.resizes(), |resizes| !resizes.is_empty()).await;
            assert_eq!(
                (served.fake.written(), resizes),
                (vec!["ls\r".to_owned()], vec![size(100, 30)])
            );
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn leaves_the_terminal_once_the_client_closes() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let mut client = served.open(terminal().as_str(), quiet());
            let attachment = client.attached("observe").await;
            client.send(Message::Close(None));
            assert_eq!(
                (served.ended().await, served.ends()),
                (true, ended(&attachment, "client_closed"))
            );
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn leaves_the_terminal_timed_out_once_the_client_stops_answering_its_pings() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let mut client = served.open(terminal().as_str(), how(Duration::from_millis(300)));
            let attachment = client.attached("observe").await;
            assert_eq!(
                (served.ended().await, served.ends()),
                (true, ended(&attachment, "timed_out"))
            );
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_a_revoked_device_s_view_and_leaves_the_terminal() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let holds = crate::devices::Holds::default();
            let stop = CancellationToken::new();
            let hold = holds.hold("dev_1", &stop, true);
            let mut client = served.open(
                terminal().as_str(),
                How {
                    device: Some(hold.token().clone()),
                    device_name: Some("phone".to_owned()),
                    ..quiet()
                },
            );
            let attachment = client.attached("observe").await;
            holds.revoke("dev_1");
            let (_, heard) = client.until_closed().await;
            assert_eq!(heard.code(), Some(close_code::POLICY), "{heard:?}");
            assert_eq!(
                (served.ended().await, served.ends()),
                (true, ended(&attachment, "client_closed"))
            );
        });
    }

    /// A driver that never answers a close, opened as `how` says, and an observer of the same
    /// terminal that joined once the driver held the lease.
    async fn driven(served: &Served, how: How) -> (Client, AttachmentId, Client) {
        let mut driver = served.open_answering(terminal().as_str(), how, false);
        let attachment = driver.attached("interactive").await;
        driver.say(r#"{"type":"engage"}"#);
        driver
            .until(|frame| {
                matches!(frame, StreamServerFrame::Lease { driver: true, .. }).then_some(())
            })
            .await
            .unwrap_or_else(|heard| panic!("never made the driver: {heard:?}"));
        let mut observer = served.open(terminal().as_str(), quiet());
        observer.attached("observe").await;
        (driver, attachment, observer)
    }

    /// Whether `observer` heard the lease let go, what the hub recorded of views ending, and how
    /// many sockets are still served, once the driver's socket has closed.
    async fn let_go(served: &Served, observer: &mut Client) -> (bool, Vec<String>, usize) {
        let released = observer
            .until(|frame| {
                matches!(
                    frame,
                    StreamServerFrame::Lease {
                        driven: Some(false),
                        ..
                    }
                )
                .then_some(())
            })
            .await;
        let ends = once(|| served.ends(), |ends| !ends.is_empty()).await;
        (released.is_ok(), ends, served.streams.tasks.len())
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn leaves_the_terminal_once_a_revoked_device_s_close_is_sent_though_its_peer_never_answers() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let holds = crate::devices::Holds::default();
            let stop = CancellationToken::new();
            let hold = holds.hold("dev_1", &stop, true);
            let how = How {
                device: Some(hold.token().clone()),
                device_name: Some("phone".to_owned()),
                ..quiet()
            };
            let (mut driver, attachment, mut observer) = driven(&served, how).await;
            holds.revoke("dev_1");
            let (_, heard) = driver.until_closed().await;
            assert_eq!(heard.code(), Some(close_code::POLICY), "{heard:?}");
            assert_eq!(
                let_go(&served, &mut observer).await,
                (true, ended(&attachment, "client_closed"), 2)
            );
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn leaves_the_terminal_once_its_refusal_of_a_joined_view_is_sent_though_its_peer_never_answers()
    {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let (mut driver, attachment, mut observer) = driven(&served, quiet()).await;
            driver.say("not a frame");
            let (_, heard) = driver.until_closed().await;
            assert_eq!(heard, Heard::Closed(None));
            assert_eq!(
                let_go(&served, &mut observer).await,
                (true, ended(&attachment, "client_closed"), 2)
            );
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn serves_a_view_on_the_socket_s_router_from_a_task_of_its_own() {
        bazhen_test_signal::require_sandbox().unwrap();
        let served = Served::running();
        // Its workers serve the socket while this thread waits on it.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let stop = crate::routes::Stop::default();
        let mut shared = Shared::new(BUILD, stop.clone(), crate::writer::Writer::closed());
        shared.streams = Some(served.streams.clone());
        let listener = rt
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let address = listener.local_addr().unwrap();
        let connections = TaskTracker::new();
        connections.spawn_on(
            crate::accept::serve_on(
                listener,
                crate::routes::socket_router(shared),
                crate::accept::SOCKET,
                stop.token().clone(),
                TaskTracker::new(),
                || {},
            ),
            rt.handle(),
        );
        let tcp = std::net::TcpStream::connect(address).unwrap();
        tcp.set_read_timeout(Some(WAIT)).unwrap();
        let url = format!("ws://{address}/v1/terminals/{}/stream", terminal());
        let shook = tungstenite::client(url, tcp);
        let status = match &shook {
            Ok((_, response)) => Some(response.status().as_u16()),
            Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response))) => {
                Some(response.status().as_u16())
            }
            Err(_) => None,
        };
        assert_eq!(
            status,
            Some(101),
            "the socket's router didn't upgrade the stream"
        );
        let (mut ws, _) = shook.unwrap();
        ws.send(tungstenite::Message::text(hello(BUILD, "observe")))
            .unwrap();
        let attachment_id = loop {
            if let tungstenite::Message::Text(text) = ws.read().unwrap()
                && let StreamServerFrame::Attached { attachment_id, .. } =
                    serde_json::from_str(&text).unwrap()
            {
                break attachment_id;
            }
        };
        ws.close(None).unwrap();
        while ws.read().is_ok() {}
        let all_ended = rt.block_on(served.ended());
        stop.now(crate::routes::Reason::Requested);
        assert_eq!(
            (all_ended, served.ends()),
            (true, ended(&attachment_id, "client_closed"))
        );
    }

    /// What `write` sends a socket from what the route queued itself and what the hub queued,
    /// and how it ended.
    async fn written(mine: Mine, inbox: Inbox) -> (Wrote, Vec<Message>) {
        let (to_client, mut hears) = mpsc::unbounded_channel();
        let sink = futures_util::sink::unfold(to_client, |to, message: Message| async move {
            to.send(message).map(|()| to).map_err(drop)
        });
        let (drained, _) = oneshot::channel();
        let wrote = write(sink, mine, inbox, drained).await;
        let mut sent = vec![];
        while let Ok(message) = hears.try_recv() {
            sent.push(message);
        }
        (wrote, sent)
    }

    #[test]
    fn queues_one_pong_and_one_ping_however_many_go_unsent() {
        runtime().block_on(async {
            let (ours, mine) = own_queue();
            let (_outbox, inbox) = view::queue(MOST_UNSENT);
            for _ in 0..1000 {
                ours.send(Own::Pong);
                ours.send(Own::Ping);
            }
            ours.send(Own::Frame(Message::Close(None)));
            let pong = text(&StreamServerFrame::Pong).unwrap();
            assert_eq!(
                written(mine, inbox).await,
                (
                    Wrote::Closed,
                    vec![pong, Message::Ping(Bytes::new()), Message::Close(None)]
                )
            );
        });
    }

    #[test]
    fn queues_a_pong_again_once_the_writer_has_taken_the_one_before() {
        runtime().block_on(async {
            let (ours, mut mine) = own_queue();
            ours.send(Own::Pong);
            let first = mine.recv().await;
            ours.send(Own::Pong);
            let again = mine.rx.try_recv().ok();
            assert_eq!(
                (
                    matches!(first, Some(Own::Pong)),
                    matches!(again, Some(Own::Pong))
                ),
                (true, true)
            );
        });
    }

    #[test]
    fn sends_what_the_hub_queued_before_the_route_s_close_ahead_of_it() {
        runtime().block_on(async {
            let (ours, mine) = own_queue();
            let (outbox, inbox) = view::queue(MOST_UNSENT);
            outbox.send(b"one".to_vec()).unwrap();
            outbox.send(b"two".to_vec()).unwrap();
            ours.send(Own::Frame(Message::Close(None)));
            assert_eq!(
                written(mine, inbox).await,
                (
                    Wrote::Closed,
                    vec![
                        Message::Binary(Bytes::from_static(b"one")),
                        Message::Binary(Bytes::from_static(b"two")),
                        Message::Close(None),
                    ]
                )
            );
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn reads_the_socket_after_its_close_until_the_client_closes_too() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            let how = quiet();
            let stop = how.stop.clone();
            let mut client = served.open_answering(terminal().as_str(), how, false);
            client.attached("observe").await;
            stop.cancel();
            let (_, heard) = client.until_closed().await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let read_on = !client.says.is_closed();
            client.send(Message::Close(None));
            assert_eq!(
                (heard.code(), read_on, served.ended().await),
                (Some(close_code::AWAY), true, true)
            );
        });
    }

    // Sandbox-only by name alone: it serves a view through serve, whose closes of the socket the
    // signal scan can't tell from a holder stream's close; over the fake runtime it signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn ends_a_view_still_joining_as_timed_out_once_its_client_stops_answering() {
        bazhen_test_signal::require_sandbox().unwrap();
        runtime().block_on(async {
            let served = Served::running();
            // The first view takes the snapshot made as the stream opened; the next asks for one.
            let mut first = served.open(terminal().as_str(), quiet());
            first.attached("observe").await;
            served.fake.hold_snapshots();
            let client = served.open(terminal().as_str(), how(Duration::from_millis(300)));
            client.say(&hello(BUILD, "observe"));
            let ends = once(|| served.ends(), |ends| !ends.is_empty()).await;
            let reasons: Vec<String> = ends
                .iter()
                .filter_map(|end| end.rsplit(' ').next().map(str::to_owned))
                .collect();
            assert_eq!(reasons, vec!["timed_out".to_owned()]);
        });
    }
}
