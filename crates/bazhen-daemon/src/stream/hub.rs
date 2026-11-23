//! At most one stream per viewed terminal, however many views are open, its output fanned out to
//! every view, as `apps/daemon/src/stream/hub.ts` keeps them. The lease decides whose size the
//! terminal takes and whose keystrokes reach it.
//!
//! Each terminal's events are taken by a task of its own, which applies each under the terminal's
//! lock, so a view's output, its geometry and its lease frames go out in one order. A view opens on
//! a snapshot seamed to the output held for it while the snapshot was on its way.

use std::collections::HashMap;
use std::fmt::{self, Display};
use std::future::Future;
use std::pin::pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bazhen_holder_proto::body::{self, Exited, Size};
use bazhen_protocol::agents;
use bazhen_protocol::events::AttachmentEndReason;
use bazhen_protocol::ids::{AttachmentId, TerminalId};
use bazhen_protocol::input::{has_keystrokes, without_replies};
use bazhen_protocol::stream::{AttachmentMode, EndedReason, Resumes, StreamServerFrame};
use futures_util::future::{Either, select};
use tokio::sync::{OnceCell, watch};
use tokio_util::task::TaskTracker;

use super::lease::{Epoch, Lease};
use super::screen::{Opening, Snapshot};
use super::seam::{Held, Position, RESPAWN_RESET, seam};
use super::view::{Behind, Outbox};

/// A terminal's stream, which every view of it shares.
pub trait TerminalStream: Send + Sync + 'static {
    type Error: Display + Send + 'static;

    /// The terminal's size, as the stream last knew it applied: what a snapshot taken now is
    /// drawn at.
    fn size(&self) -> Size;

    /// Input for the program.
    fn write(&self, input: &[u8]);

    /// Resolves once the terminal has the size, and the stream's event saying so is queued.
    fn resize(&self, size: Size) -> impl Future<Output = Result<(), Self::Error>> + Send;

    /// Resolves once every event up to where the snapshot was taken is queued.
    fn snapshot(&self) -> impl Future<Output = Result<Snapshot, Self::Error>> + Send;

    /// Ends the stream; its events end with a [`StreamEvent::Closed`].
    fn close(&self);
}

/// What a terminal's stream tells, in order. They must keep being taken, or the stream stalls.
pub trait TerminalEvents: Send + 'static {
    fn recv(&mut self) -> impl Future<Output = Option<StreamEvent>> + Send;
}

/// One thing a terminal's stream tells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// Output, whose first byte is at `at`.
    Data {
        at: Position,
        output: Vec<u8>,
    },
    /// Another process started in the terminal; its output starts at offset 0.
    Respawned {
        generation: u64,
    },
    Exited(Exited),
    /// The terminal took this size, whoever asked for it.
    Resized(Size),
    /// Something the stream does failed, which every view is told.
    Failed {
        what: &'static str,
        message: String,
    },
    Closed(StreamEnd),
}

/// Why a stream closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEnd {
    Ended,
    /// It fell too far behind the terminal's output.
    Behind,
}

/// A stream just opened, with the snapshot it opened on.
#[derive(Debug)]
pub struct Opened<S, E> {
    pub snapshot: Snapshot,
    /// The size the snapshot was drawn at. The stream's own may have moved on by the time it
    /// is read.
    pub size: Size,
    /// How much history above its screen the terminal keeps.
    pub history_lines: u64,
    pub stream: S,
    pub events: E,
}

/// Where the hub opens terminals' streams.
pub trait Runtime: Send + Sync + 'static {
    type Stream: TerminalStream;
    type Events: TerminalEvents;
    type Error: Display + Send + 'static;

    /// Opens a stream on `terminal`, sized to `size` first if there is one.
    fn attach(
        &self,
        terminal: &TerminalId,
        size: Option<Size>,
    ) -> impl Future<Output = Result<Opened<Self::Stream, Self::Events>, Self::Error>> + Send;
}

/// What the hub records about attachments and leases; the daemon writes it to the store.
pub trait AttachmentLog: Send + Sync + 'static {
    type Error: Display + Send + 'static;

    fn started(&self, attachment: &AttachmentId, terminal: &TerminalId, mode: AttachmentMode);

    fn ended(&self, attachment: &AttachmentId, reason: AttachmentEndReason);

    fn granted(&self, terminal: &TerminalId, attachment: &AttachmentId, epoch: Epoch);

    /// The epoch of the terminal's last grant, so a new one is always higher.
    ///
    /// # Errors
    ///
    /// When it can't be read; the terminal isn't opened.
    fn epoch(&self, terminal: &TerminalId) -> Result<Epoch, Self::Error>;

    /// Whether the terminal is being closed, so its stream's end ends views as closed.
    fn closing(&self, terminal: &TerminalId) -> bool;

    /// Its process exited, as its stream told: recorded before any view is told, to act on.
    fn exited(
        &self,
        terminal: &TerminalId,
        exit: &Exited,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

/// One view of a terminal, as it asks to open.
#[derive(Debug)]
pub struct Viewer {
    pub mode: AttachmentMode,
    /// The name of the paired device the view is on, if it is on one.
    pub device_name: Option<String>,
    pub outbox: Outbox,
}

/// Who input comes from. Every write passes the lease, the filter and the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Writer {
    View(AttachmentId),
}

/// Why a view's own side ended: it closed, or its socket stopped answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaveReason {
    ClientClosed,
    TimedOut,
}

impl From<LeaveReason> for AttachmentEndReason {
    fn from(reason: LeaveReason) -> Self {
        match reason {
            LeaveReason::ClientClosed => Self::ClientClosed,
            LeaveReason::TimedOut => Self::TimedOut,
        }
    }
}

/// An open view: its attachment, and the token that lets it end that attachment when it comes
/// back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub id: AttachmentId,
    pub resume_token: String,
}

/// Why a view didn't open.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JoinError {
    /// It ended while it opened; it was never told it is attached.
    #[error("the view ended while it opened")]
    Ended,
    /// It was turned away, in words for the person who opened it.
    #[error("{0}")]
    Refused(String),
    #[error("bazhen can't open this terminal: {0}")]
    Open(String),
    #[error("this terminal's screen could not be taken: {0}")]
    Snapshot(String),
}

/// How the hub sends what it sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubOptions {
    /// A snapshot goes to its view a piece of this many bytes at a time, each once the last is
    /// written.
    pub snapshot_piece_bytes: usize,
}

impl Default for HubOptions {
    fn default() -> Self {
        Self {
            snapshot_piece_bytes: 1 << 20,
        }
    }
}

/// Every viewed terminal's stream and views.
pub struct Hub<R: Runtime, L> {
    shared: Arc<Shared<R, L>>,
}

impl<R: Runtime, L> Clone for Hub<R, L> {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl<R: Runtime, L> fmt::Debug for Hub<R, L> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Hub").finish_non_exhaustive()
    }
}

struct Shared<R: Runtime, L> {
    runtime: R,
    log: L,
    options: HubOptions,
    tasks: TaskTracker,
    watched: Mutex<HashMap<TerminalId, Arc<Slot<R::Stream>>>>,
}

/// A terminal's stream, once open; joins that come while it opens wait for the one opening it.
type Slot<S> = OnceCell<Arc<Watched<S>>>;

struct Watched<S> {
    terminal: TerminalId,
    stream: S,
    history_lines: u64,
    state: Mutex<State>,
    /// Moves on whenever the state does, for whoever waits on it.
    moved: watch::Sender<u64>,
}

struct State {
    /// Where the stream is, as far as the hub has taken its events: the next byte's position.
    at: Position,
    /// In the order they opened.
    views: Vec<View>,
    lease: Lease,
    /// The exit of the process running now, once its stream has told it.
    exited: Option<Exited>,
    resizing: bool,
    /// The latest size asked for while a resize runs.
    wanted: Option<Size>,
    opening: Option<Opening>,
    /// The hub is done with the stream: it closed, or its last view left.
    closed: bool,
}

struct View {
    id: AttachmentId,
    mode: AttachmentMode,
    device_name: Option<String>,
    outbox: Outbox,
    /// The sha256 of the token that lets this view end this attachment when it comes back.
    resume_digest: String,
    size: Size,
    /// The epoch the view says its input is typed under; a grant never changes it.
    declared: Option<Epoch>,
    /// Live output held while the view's snapshot is on its way.
    queue: Option<Vec<Held>>,
    /// Whether it has been told its input was dropped under the current lease.
    told_dropped: bool,
}

/// Where a view's held output is cut: it was held from `from`, the snapshot taken at `taken`,
/// drawn at `geometry`, and asked for once `queued` items were held.
struct Seamed {
    from: Position,
    taken: Position,
    queued: usize,
    geometry: Size,
}

/// Why taking a view's snapshot stopped.
enum Taking {
    Gone,
    Failed(String),
}

impl<R: Runtime, L: AttachmentLog> Hub<R, L> {
    /// The hub's tasks run on `tasks`.
    pub fn new(runtime: R, log: L, options: HubOptions, tasks: TaskTracker) -> Self {
        Self {
            shared: Arc::new(Shared {
                runtime,
                log,
                options,
                tasks,
                watched: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Opens a view on `terminal`, at `size` if it sizes it. `resumes` names the view's own
    /// earlier attachment, when it comes back after losing its socket; that one is ended before
    /// the view is told who drives, if the token is the one that attachment was given.
    ///
    /// # Errors
    ///
    /// [`JoinError`]: the view ended while it opened, or was turned away, or the terminal's
    /// stream or screen couldn't be had.
    pub async fn join(
        &self,
        terminal: &TerminalId,
        viewer: Viewer,
        size: Size,
        resumes: Option<Resumes>,
    ) -> Result<Attachment, JoinError> {
        self.shared.join(terminal, viewer, size, resumes).await
    }

    /// Input from `writer`, which reaches the program only from the driver, under the epoch it
    /// was granted, without the replies a terminal sends.
    pub fn write(&self, terminal: &TerminalId, writer: &Writer, input: &[u8]) {
        self.shared.write(terminal, writer, input);
    }

    /// The person engaged the view: an interactive one takes the lease.
    pub fn engage(&self, terminal: &TerminalId, attachment: &AttachmentId) {
        self.shared.on(terminal, |hub, watched, state| {
            hub.engage(watched, state, attachment);
        });
    }

    /// The epoch the view's following input is typed under.
    pub fn declare_epoch(&self, terminal: &TerminalId, attachment: &AttachmentId, epoch: u64) {
        self.shared.on(terminal, |_, _, state| {
            if let Some(view) = state.view_mut(attachment) {
                view.declared = Some(Epoch::new(epoch));
            }
        });
    }

    /// The view's window is `size`; the terminal takes it if the view sets its size.
    pub fn resize(&self, terminal: &TerminalId, attachment: &AttachmentId, size: Size) {
        self.shared.on(terminal, |hub, watched, state| {
            if let Some(view) = state.view_mut(attachment) {
                view.size = size;
                hub.fit_to(watched, state, None);
            }
        });
    }

    /// The view's own side ended.
    pub fn leave(&self, terminal: &TerminalId, attachment: &AttachmentId, reason: LeaveReason) {
        self.shared.on(terminal, |hub, watched, state| {
            hub.end(watched, state, attachment, reason.into());
        });
    }
}

impl<R: Runtime, L: AttachmentLog> Shared<R, L> {
    async fn join(
        self: &Arc<Self>,
        terminal: &TerminalId,
        viewer: Viewer,
        size: Size,
        resumes: Option<Resumes>,
    ) -> Result<Attachment, JoinError> {
        // An observer never sizes the terminal, not even by being the first to open it.
        let opening = (viewer.mode == AttachmentMode::Interactive).then_some(size);
        let (watched, opened) = self.watch(terminal, opening).await?;
        let id = AttachmentId::mint(now_ms(), random()?);
        let resume_token = crate::devices::token_of(random()?);
        let mode = viewer.mode;
        let (from, exited, replacing) = {
            let mut state = watched.lock();
            if state.closed {
                return Err(JoinError::Ended);
            }
            let replacing = resumes
                .filter(|r| {
                    state.view(&r.attachment_id).is_some_and(|v| {
                        crate::pairing::same(
                            &crate::devices::hash_token(&r.token),
                            &v.resume_digest,
                        )
                    })
                })
                .map(|r| r.attachment_id);
            // From here the view's live output is held, and its snapshot is no older than this.
            let from = state.at;
            // An exit told before this view opened still reaches it, unless its snapshot is of a
            // later process.
            let exited = state.exited.clone();
            state.views.push(View {
                id: id.clone(),
                mode,
                device_name: viewer.device_name,
                outbox: viewer.outbox,
                resume_digest: crate::devices::hash_token(&resume_token),
                size,
                declared: None,
                queue: Some(exited.iter().cloned().map(Held::Exited).collect()),
                told_dropped: false,
            });
            if !opened {
                self.fit_to(&watched, &mut state, replacing.as_ref());
            }
            (from, exited, replacing)
        };
        if let Some(exit) = &exited {
            self.record_exit(terminal, exit).await;
        }
        self.log.started(&id, terminal, mode);
        let (shown, geometry, queued) = match self.take_snapshot(&watched, &id).await {
            Ok(taken) => taken,
            Err(Taking::Gone) => return Err(JoinError::Ended),
            Err(Taking::Failed(message)) => {
                let mut state = watched.lock();
                if state.view(&id).is_none() {
                    return Err(JoinError::Ended);
                }
                self.end(&watched, &mut state, &id, AttachmentEndReason::AttachFailed);
                return Err(JoinError::Snapshot(message));
            }
        };
        let seamed = Seamed {
            from,
            taken: shown.at(),
            queued,
            geometry,
        };
        self.begin(&watched, &id, seamed, replacing.as_ref())
            .await?;
        self.send_snapshot(&watched, &id, shown.vt()).await?;
        let mut state = watched.lock();
        let Some(view) = state.view_mut(&id) else {
            return Err(JoinError::Ended);
        };
        view.outbox.notify(StreamServerFrame::SnapshotEnd);
        let rest = view.queue.take().unwrap_or_default();
        if rest.iter().any(|item| pass(&view.outbox, item).is_err()) {
            self.evict(&watched, &mut state, &id);
            return Err(JoinError::Ended);
        }
        // Last: a view may send input and engage as soon as it is told.
        view.outbox.notify(StreamServerFrame::Attached {
            attachment_id: id.clone(),
            resume_token: Some(resume_token.clone()),
        });
        Ok(Attachment { id, resume_token })
    }

    /// Cuts what was held for the view where its snapshot ends, ends the attachment it replaces,
    /// and tells it the snapshot starts.
    async fn begin(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        id: &AttachmentId,
        seamed: Seamed,
        replacing: Option<&AttachmentId>,
    ) -> Result<(), JoinError> {
        let Seamed {
            from,
            taken,
            queued,
            geometry,
        } = seamed;
        // The snapshot resolves once its stream has queued every event up to it; the hub may not
        // have taken them all yet, and the seam needs them.
        let caught_up = watched
            .until(|state| (state.view(id).is_none() || state.at >= taken).then_some(()))
            .await;
        let mut state = watched.lock();
        let now = state.at;
        let Some(view) = state.view_mut(id).filter(|_| caught_up.is_some()) else {
            return Err(JoinError::Ended);
        };
        let held = view.queue.take().unwrap_or_default();
        let Some(rest) = seam(held, from, now, taken, queued) else {
            self.end(watched, &mut state, id, AttachmentEndReason::AttachFailed);
            return Err(JoinError::Refused(
                "this terminal's screen could not be read; reopen it".to_owned(),
            ));
        };
        // What the snapshot covers is never sent, so it isn't held either.
        view.queue = Some(rest);
        if let Some(replaced) = replacing {
            self.end(watched, &mut state, replaced, AttachmentEndReason::Replaced);
        }
        let lease = lease_frame(&state, id);
        let Some(view) = state.view(id) else {
            return Err(JoinError::Ended);
        };
        // Not before: a view clears its screen for a snapshot, and one turned away would
        // lose it.
        view.outbox.notify(StreamServerFrame::SnapshotStart {
            history_lines: Some(watched.history_lines),
        });
        view.outbox.notify(geometry_frame(geometry));
        view.outbox.notify(lease);
        Ok(())
    }

    /// The terminal's stream, opened if nobody has it open, and whether this call opened it.
    async fn watch(
        self: &Arc<Self>,
        terminal: &TerminalId,
        size: Option<Size>,
    ) -> Result<(Arc<Watched<R::Stream>>, bool), JoinError> {
        let slot = Arc::clone(lock(&self.watched).entry(terminal.clone()).or_default());
        let mut opened = false;
        let watched = slot
            .get_or_try_init(|| {
                opened = true;
                self.open(terminal, size)
            })
            .await
            .cloned();
        match watched {
            Ok(watched) if !watched.lock().closed => Ok((watched, opened)),
            Ok(_) => {
                self.forget(terminal, &slot);
                Err(JoinError::Ended)
            }
            Err(err) => {
                self.forget(terminal, &slot);
                Err(err)
            }
        }
    }

    async fn open(
        self: &Arc<Self>,
        terminal: &TerminalId,
        size: Option<Size>,
    ) -> Result<Arc<Watched<R::Stream>>, JoinError> {
        let epoch = self.log.epoch(terminal).map_err(|err| {
            JoinError::Open(format!("bazhen can't read who last drove it: {err}"))
        })?;
        let Opened {
            snapshot,
            size: geometry,
            history_lines,
            stream,
            events,
        } = self
            .runtime
            .attach(terminal, size)
            .await
            .map_err(|err| JoinError::Open(err.to_string()))?;
        let watched = Arc::new(Watched {
            terminal: terminal.clone(),
            stream,
            history_lines,
            state: Mutex::new(State {
                at: snapshot.at(),
                views: Vec::new(),
                lease: Lease::released_at(epoch),
                exited: None,
                resizing: false,
                wanted: None,
                opening: Some(Opening::new(snapshot, geometry)),
                closed: false,
            }),
            moved: watch::Sender::new(0),
        });
        let hub = Arc::clone(self);
        let taking = Arc::clone(&watched);
        self.tasks
            .spawn(async move { hub.take_events(&taking, events).await });
        Ok(watched)
    }

    /// Applies each of a stream's events in turn, until it closes.
    async fn take_events(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        mut events: R::Events,
    ) {
        loop {
            let event = events
                .recv()
                .await
                .unwrap_or(StreamEvent::Closed(StreamEnd::Ended));
            if let StreamEvent::Exited(exit) = &event {
                self.record_exit(&watched.terminal, exit).await;
            }
            let closed = matches!(event, StreamEvent::Closed(_));
            self.apply(watched, event);
            watched.moved();
            if closed {
                return;
            }
        }
    }

    fn apply(self: &Arc<Self>, watched: &Arc<Watched<R::Stream>>, event: StreamEvent) {
        let mut state = watched.lock();
        match event {
            StreamEvent::Data { at, output } => {
                state.at = at.after(output.len());
                self.deliver(watched, &mut state, &Held::Data { at, bytes: output });
            }
            StreamEvent::Respawned { generation } => {
                state.at = Position::start(generation);
                state.exited = None;
                self.deliver(watched, &mut state, &Held::Reset { generation });
            }
            StreamEvent::Exited(exit) => {
                state.exited = Some(exit.clone());
                self.deliver(watched, &mut state, &Held::Exited(exit));
            }
            StreamEvent::Resized(size) => {
                state.opening = None;
                self.deliver(watched, &mut state, &Held::Geometry(size));
            }
            StreamEvent::Failed { what, message } => {
                // Forwarded unredacted, as holder.rs's failure detail still is, until TS's
                // `failureDetail` redaction is ported.
                let message = format!("{what} failed: {message}");
                for view in &state.views {
                    view.outbox.notify(StreamServerFrame::Notice {
                        message: message.clone(),
                    });
                }
            }
            StreamEvent::Closed(end) => self.closed(watched, &mut state, end),
        }
    }

    /// Records an exit a stream told, before any view is told of it. A record that fails is
    /// logged and the views told all the same: their program has ended either way.
    async fn record_exit(&self, terminal: &TerminalId, exit: &Exited) {
        if let Err(err) = self.log.exited(terminal, exit).await {
            tracing::error!(
                %terminal,
                "bazhen: recording the exit of the terminal's process failed: {err}"
            );
        }
    }

    /// Passes `item` to every view, or holds it for one whose snapshot is on its way.
    fn deliver(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        state: &mut State,
        item: &Held,
    ) {
        let mut behind = vec![];
        for view in &mut state.views {
            if let Some(queue) = &mut view.queue {
                queue.push(item.clone());
            } else if pass(&view.outbox, item).is_err() {
                behind.push(view.id.clone());
            }
        }
        for id in &behind {
            self.evict(watched, state, id);
        }
    }

    /// The stream closed: every view's stream ends with it.
    fn closed(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        state: &mut State,
        end: StreamEnd,
    ) {
        // The stream also ends when the holder is lost while the terminal lives on.
        let reason = if self.log.closing(&watched.terminal) {
            AttachmentEndReason::TerminalClosed
        } else if end == StreamEnd::Behind {
            AttachmentEndReason::EvictedSlow
        } else {
            AttachmentEndReason::Disconnected
        };
        let frame = match reason {
            AttachmentEndReason::EvictedSlow => StreamServerFrame::Ended {
                reason: EndedReason::EvictedSlow,
            },
            AttachmentEndReason::Disconnected => StreamServerFrame::Ended {
                reason: EndedReason::Disconnected,
            },
            _ => StreamServerFrame::Closed,
        };
        for view in state.views.drain(..) {
            view.outbox.notify(frame.clone());
            self.log.ended(&view.id, reason);
        }
        state.closed = true;
        self.forget_watched(watched);
    }

    /// Takes a snapshot only once the terminal has the size the view is to be told: it waits out
    /// a resize in flight, and takes another if the size moved while it was taken. Returns it,
    /// the size it was drawn at, and how much of the view's output was held as it was asked for.
    async fn take_snapshot(
        &self,
        watched: &Watched<R::Stream>,
        id: &AttachmentId,
    ) -> Result<(Snapshot, Size, usize), Taking> {
        loop {
            let asked = watched
                .until(|state| {
                    if state.view(id).is_none() {
                        return Some(Err(Taking::Gone));
                    }
                    if state.resizing {
                        return None;
                    }
                    let geometry = watched.stream.size();
                    let queued = state
                        .view(id)
                        .and_then(|v| v.queue.as_ref())
                        .map_or(0, Vec::len);
                    let now = state.at;
                    let cached = state
                        .opening
                        .take()
                        .and_then(|opening| opening.usable(now, geometry));
                    Some(Ok((geometry, queued, cached)))
                })
                .await
                .unwrap_or(Err(Taking::Gone));
            let (geometry, queued, cached) = asked?;
            let shown = match cached {
                Some(shown) => shown,
                None => watched
                    .stream
                    .snapshot()
                    .await
                    .map_err(|err| Taking::Failed(err.to_string()))?,
            };
            let state = watched.lock();
            if watched.stream.size() == geometry && !state.resizing {
                return Ok((shown, geometry, queued));
            }
        }
    }

    /// A piece at a time, each once the last is written: pieces queued together would be
    /// written as one batch, and a view reading slowly would look no different from one gone.
    async fn send_snapshot(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        id: &AttachmentId,
        shown: &[u8],
    ) -> Result<(), JoinError> {
        for piece in shown.chunks(self.options.snapshot_piece_bytes.max(1)) {
            let written = {
                let mut state = watched.lock();
                let Some(view) = state.view(id) else {
                    return Err(JoinError::Ended);
                };
                let Ok(written) = view.outbox.send_piece(piece.to_vec()) else {
                    self.evict(watched, &mut state, id);
                    return Err(JoinError::Ended);
                };
                written
            };
            let gone = watched.until(|state| state.view(id).is_none().then_some(()));
            if let Either::Right(_) = select(written, pin!(gone)).await {
                return Err(JoinError::Ended);
            }
        }
        Ok(())
    }

    fn write(self: &Arc<Self>, terminal: &TerminalId, writer: &Writer, input: &[u8]) {
        let Writer::View(id) = writer;
        self.on(terminal, |hub, watched, state| {
            hub.input(watched, state, id, input);
        });
    }

    /// Keystrokes reach the terminal only from its driver. Any other view's are dropped, never
    /// queued: an interactive view's keystroke takes the lease instead, and an observer is told
    /// once per lease. Terminal replies never reach the program, and neither replies nor focus
    /// and mouse reports count as keystrokes: an old driver's blur must not take the lease back.
    /// Input is applied only under the epoch the view declared, and only a keystroke typed under
    /// the current epoch takes the lease over: a key typed before its view learnt of a takeover
    /// was typed for another screen.
    fn input(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        state: &mut State,
        id: &AttachmentId,
        input: &[u8],
    ) {
        let lease = state.lease.clone();
        let Some(view) = state.view_mut(id) else {
            return;
        };
        let declared = view.declared;
        if declared.is_some_and(|epoch| lease.accepts_input(id, epoch)) {
            let program = without_replies(input);
            if !program.is_empty() {
                watched.stream.write(&program);
            }
            return;
        }
        if !has_keystrokes(input) {
            return;
        }
        if view.mode == AttachmentMode::Interactive {
            if declared == Some(lease.epoch()) {
                self.engage(watched, state, id);
            }
            return;
        }
        if !view.told_dropped {
            view.told_dropped = true;
            view.outbox.notify(StreamServerFrame::InputDropped);
        }
    }

    fn engage(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        state: &mut State,
        id: &AttachmentId,
    ) {
        let Some(view) = state.view(id) else {
            return;
        };
        let next = state.lease.engage(id, view.mode);
        if next == state.lease {
            return;
        }
        self.log.granted(&watched.terminal, id, next.epoch());
        state.lease = next;
        announce_lease(state);
        self.fit_to(watched, state, None);
    }

    /// The driver's size, or with no driver the newest interactive view's, leaving out a view
    /// being replaced.
    fn fit_to(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        state: &mut State,
        replaced: Option<&AttachmentId>,
    ) {
        let views = || state.views.iter().filter(|v| Some(&v.id) != replaced);
        let setter = views()
            .find(|v| state.lease.holder() == Some(&v.id))
            .or_else(|| {
                views()
                    .rev()
                    .find(|v| v.mode == AttachmentMode::Interactive)
            });
        if let Some(size) = setter.map(|v| v.size) {
            self.apply_size(watched, state, size);
        }
    }

    /// One resize at a time: a dragged window sends many, and only the latest size matters. The
    /// size the terminal already has is not applied again, since that would redraw every view.
    fn apply_size(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        state: &mut State,
        size: Size,
    ) {
        state.wanted = Some(size);
        if state.resizing {
            return;
        }
        let Some(next) = state.wanted.take() else {
            return;
        };
        if next == watched.stream.size() {
            return;
        }
        state.resizing = true;
        let hub = Arc::clone(self);
        let resizing = Arc::clone(watched);
        self.tasks
            .spawn(async move { hub.resized(&resizing, next).await });
    }

    async fn resized(self: &Arc<Self>, watched: &Arc<Watched<R::Stream>>, size: Size) {
        let result = watched.stream.resize(size).await;
        let mut state = watched.lock();
        if let Err(err) = result {
            for view in &state.views {
                view.outbox.notify(StreamServerFrame::Notice {
                    message: format!("resize failed: {err}"),
                });
            }
        }
        state.resizing = false;
        if let Some(wanted) = state.wanted.take() {
            self.apply_size(watched, &mut state, wanted);
        }
        drop(state);
        watched.moved();
    }

    /// Ends a view that has fallen behind, at a frame boundary; it comes back for a fresh screen.
    fn evict(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        state: &mut State,
        id: &AttachmentId,
    ) {
        if let Some(view) = state.view(id) {
            view.outbox.notify(StreamServerFrame::Ended {
                reason: EndedReason::EvictedSlow,
            });
        }
        self.end(watched, state, id, AttachmentEndReason::EvictedSlow);
    }

    /// Ends a view; its stream ends once what it was sent is written.
    fn end(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        state: &mut State,
        id: &AttachmentId,
        reason: AttachmentEndReason,
    ) {
        let Some(index) = state.views.iter().position(|v| &v.id == id) else {
            return;
        };
        drop(state.views.remove(index));
        self.log.ended(id, reason);
        let was_driver = state.lease.holder() == Some(id);
        state.lease = state.lease.release(id);
        watched.moved();
        if state.views.is_empty() {
            state.closed = true;
            self.forget_watched(watched);
            let_go(watched);
            return;
        }
        if was_driver {
            announce_lease(state);
        }
        self.fit_to(watched, state, None);
    }

    /// Runs `act` on the terminal's state, if it is watched.
    fn on(
        self: &Arc<Self>,
        terminal: &TerminalId,
        act: impl FnOnce(&Arc<Self>, &Arc<Watched<R::Stream>>, &mut State),
    ) {
        let slot = lock(&self.watched).get(terminal).cloned();
        if let Some(watched) = slot.as_ref().and_then(|slot| slot.get()) {
            act(self, watched, &mut watched.lock());
        }
    }

    fn forget(&self, terminal: &TerminalId, slot: &Arc<Slot<R::Stream>>) {
        let mut map = lock(&self.watched);
        if map.get(terminal).is_some_and(|s| Arc::ptr_eq(s, slot)) {
            map.remove(terminal);
        }
    }

    fn forget_watched(&self, watched: &Arc<Watched<R::Stream>>) {
        let mut map = lock(&self.watched);
        let current = map
            .get(&watched.terminal)
            .and_then(|slot| slot.get())
            .is_some_and(|w| Arc::ptr_eq(w, watched));
        if current {
            map.remove(&watched.terminal);
        }
    }
}

/// The hub is done with a stream whose last view has left.
fn let_go<S: TerminalStream>(watched: &Watched<S>) {
    watched.stream.close();
}

impl<S> Watched<S> {
    fn lock(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    fn moved(&self) {
        self.moved.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Waits until `ready` gives something, checked now and whenever the state moves.
    async fn until<T>(&self, mut ready: impl FnMut(&mut State) -> Option<T>) -> Option<T> {
        let mut moved = self.moved.subscribe();
        loop {
            if let Some(out) = ready(&mut self.lock()) {
                return Some(out);
            }
            moved.changed().await.ok()?;
        }
    }
}

impl State {
    fn view(&self, id: &AttachmentId) -> Option<&View> {
        self.views.iter().find(|v| &v.id == id)
    }

    fn view_mut(&mut self, id: &AttachmentId) -> Option<&mut View> {
        self.views.iter_mut().find(|v| &v.id == id)
    }
}

fn announce_lease(state: &mut State) {
    let frames: Vec<_> = state
        .views
        .iter()
        .map(|v| lease_frame(state, &v.id))
        .collect();
    for (view, frame) in state.views.iter_mut().zip(frames) {
        view.told_dropped = false;
        view.outbox.notify(frame);
    }
}

fn lease_frame(state: &State, id: &AttachmentId) -> StreamServerFrame {
    let holder = state.lease.holder();
    let driven = holder.is_some_and(|h| h != id);
    let driver_device = holder
        .filter(|_| driven)
        .and_then(|h| state.view(h))
        .and_then(|v| v.device_name.clone());
    StreamServerFrame::Lease {
        driver: holder == Some(id),
        epoch: state.lease.epoch().get(),
        driven: Some(driven),
        driver_device,
    }
}

fn geometry_frame(size: Size) -> StreamServerFrame {
    let cells = |n: u64| u16::try_from(n).unwrap_or(u16::MAX);
    StreamServerFrame::Geometry {
        cols: cells(size.cols.get()),
        rows: cells(size.rows.get()),
    }
}

/// A held item, to a view whose snapshot is done: output as its bytes, the rest as frames.
fn pass(outbox: &Outbox, item: &Held) -> Result<(), Behind> {
    match item {
        Held::Data { bytes, .. } => outbox.send(bytes.clone()),
        Held::Reset { .. } => outbox.send(RESPAWN_RESET.to_vec()),
        Held::Geometry(size) => {
            outbox.notify(geometry_frame(*size));
            Ok(())
        }
        Held::Exited(exit) => {
            outbox.notify(StreamServerFrame::Exited {
                generation: exit.generation.get(),
                exit: match &exit.status {
                    body::ExitStatus::Exited { code } => {
                        agents::ExitStatus::Exited { code: code.get() }
                    }
                    body::ExitStatus::Signalled { signal } => agents::ExitStatus::Signalled {
                        signal: signal.clone(),
                    },
                    body::ExitStatus::Unknown => agents::ExitStatus::Unknown,
                },
            });
            Ok(())
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> u64 {
    u64::try_from(jiff::Timestamp::now().as_millisecond()).unwrap_or(0)
}

fn random<const N: usize>() -> Result<[u8; N], JoinError> {
    crate::pairing::random_bytes()
        .map_err(|err| JoinError::Open(format!("bazhen can't make the view's id: {err}")))
}

#[cfg(test)]
mod tests {
    //! The hub, driven through a fake runtime whose terminal keeps everything it printed and
    //! draws a snapshot by replaying it, as `FakeRuntime` does in `packages/core/src/testing`.
    //! Each view's socket is a recorder that writes whatever it is sent at once and declares its
    //! epoch on every lease frame once attached, as a browser does.

    use std::sync::{Arc, Mutex};

    use bazhen_holder_engine::{Engine, HistoryRows};
    use bazhen_holder_proto::body::{Cols, ExitCode, ExitStatus, Generation, Rows};
    use bazhen_protocol::stream::Resumes;
    use tokio::sync::{Semaphore, mpsc, oneshot};

    use super::*;
    use crate::shells::tests::Said;
    use crate::stream::view::{self, MOST_UNSENT, ViewSocket, write_to};
    use crate::testing::runtime;

    fn size(cols: u64, rows: u64) -> Size {
        Size {
            cols: Cols::new(cols).unwrap(),
            rows: Rows::new(rows).unwrap(),
        }
    }

    fn standard() -> Size {
        size(80, 24)
    }

    /// Lets every task that can run, run, until none can.
    async fn settle() {
        yields(256).await;
    }

    async fn yields(n: usize) {
        for _ in 0..n {
            tokio::task::yield_now().await;
        }
    }

    /// Something the fake's terminal does while it is being asked for a snapshot, or opened.
    type Hook = Box<dyn FnOnce(&mut Terminal) + Send>;

    /// A snapshot asked for while snapshots are held, and the one taken for it, if one has been.
    struct Asked {
        answer: oneshot::Sender<Snapshot>,
        taken: Option<Snapshot>,
    }

    struct Terminal {
        size: Size,
        /// Lines scrolled off its screen, which a snapshot puts above it.
        history: String,
        history_lines: u64,
        /// Everything printed, a respawn's reset among it, which a snapshot replays.
        printed: Vec<u8>,
        generation: u64,
        offset: u64,
        /// Each stream opened on it: what it was asked to open at.
        attaches: Vec<Option<Size>>,
        resizes: Vec<Size>,
        written: Vec<String>,
        closes: usize,
        /// Each open stream's events.
        clients: Vec<(usize, mpsc::UnboundedSender<StreamEvent>)>,
        next_client: usize,
        /// What has been done, in order, of the resizes and snapshots asked for.
        asked: Vec<String>,
        holding: bool,
        held: Vec<Asked>,
        /// Resizes wait for a permit each while this is set.
        gate: Option<Arc<Semaphore>>,
        refuse_resizes: Option<String>,
        before_snapshot: Option<Hook>,
        during_snapshot: Option<Hook>,
        after_attach: Option<Hook>,
        /// Events its streams have yet to be told.
        unheard: Vec<StreamEvent>,
    }

    impl Terminal {
        fn tell(&mut self, event: &StreamEvent) {
            for (_, client) in &self.clients {
                let _ = client.send(event.clone());
            }
        }

        fn print(&mut self, text: &str) {
            let printed = self.print_unheard(text);
            self.tell(&printed);
        }

        /// Prints `text`, and returns the event that tells it.
        fn print_unheard(&mut self, text: &str) -> StreamEvent {
            let at = Position {
                generation: self.generation,
                offset: self.offset,
            };
            self.printed.extend_from_slice(text.as_bytes());
            self.offset += text.len() as u64;
            StreamEvent::Data {
                at,
                output: text.as_bytes().to_vec(),
            }
        }

        /// The history above a clear screen, then everything printed since from its top.
        fn snapshot_now(&self) -> Snapshot {
            let mut vt = Vec::new();
            if !self.history.is_empty() {
                vt.extend_from_slice(self.history.replace('\n', "\r\n").as_bytes());
                vt.extend_from_slice("\r\n".repeat(self.rows()).as_bytes());
                vt.extend_from_slice(b"\x1b[0m\x1b[H");
            }
            vt.extend_from_slice(&self.printed);
            Snapshot::new(
                vt,
                Position {
                    generation: self.generation,
                    offset: self.offset,
                },
            )
        }

        fn rows(&self) -> usize {
            usize::try_from(self.size.rows.get()).unwrap()
        }

        /// Someone else sized the terminal: every stream hears it, as they would from its holder.
        fn sized_elsewhere(&mut self, to: Size) {
            self.size = to;
            self.tell(&StreamEvent::Resized(to));
        }

        fn vanish(&mut self) {
            self.tell(&StreamEvent::Closed(StreamEnd::Ended));
            self.clients.clear();
        }
    }

    /// A runtime with one terminal, whose program echoes nothing.
    #[derive(Clone)]
    struct Fake(Arc<Mutex<Terminal>>);

    impl Fake {
        fn new(history: &str, history_lines: u64) -> Self {
            Self(Arc::new(Mutex::new(Terminal {
                size: standard(),
                history: history.to_owned(),
                history_lines,
                printed: Vec::new(),
                generation: 0,
                offset: 0,
                attaches: Vec::new(),
                resizes: Vec::new(),
                written: Vec::new(),
                closes: 0,
                clients: Vec::new(),
                next_client: 0,
                asked: Vec::new(),
                holding: false,
                held: Vec::new(),
                gate: None,
                refuse_resizes: None,
                before_snapshot: None,
                during_snapshot: None,
                after_attach: None,
                unheard: Vec::new(),
            })))
        }

        fn terminal(&self) -> std::sync::MutexGuard<'_, Terminal> {
            self.0.lock().unwrap()
        }

        fn print(&self, text: &str) {
            self.terminal().print(text);
        }

        fn exits(&self, code: i64) {
            let mut t = self.terminal();
            let exit = Exited {
                generation: Generation::new(t.generation).unwrap(),
                status: ExitStatus::Exited {
                    code: ExitCode::new(code).unwrap(),
                },
            };
            t.tell(&StreamEvent::Exited(exit));
        }

        /// The terminal's next process starts, as a respawn's does.
        fn respawned(&self, generation: u64) {
            let mut t = self.terminal();
            t.printed.extend_from_slice(RESPAWN_RESET);
            t.generation = generation;
            t.offset = 0;
            t.tell(&StreamEvent::Respawned { generation });
        }

        fn vanish(&self) {
            self.terminal().vanish();
        }

        fn fails(&self, what: &'static str, message: &str) {
            self.terminal().tell(&StreamEvent::Failed {
                what,
                message: message.to_owned(),
            });
        }

        fn before_snapshot(&self, hook: impl FnOnce(&mut Terminal) + Send + 'static) {
            self.terminal().before_snapshot = Some(Box::new(hook));
        }

        /// Tells its streams what they have yet to be told.
        fn tell_unheard(&self) {
            let mut t = self.terminal();
            for event in std::mem::take(&mut t.unheard) {
                t.tell(&event);
            }
        }

        fn during_snapshot(&self, hook: impl FnOnce(&mut Terminal) + Send + 'static) {
            self.terminal().during_snapshot = Some(Box::new(hook));
        }

        fn after_attach(&self, hook: impl FnOnce(&mut Terminal) + Send + 'static) {
            self.terminal().after_attach = Some(Box::new(hook));
        }

        /// Snapshots asked for from now on wait until [`Fake::release`].
        fn hold_snapshots(&self) {
            self.terminal().holding = true;
        }

        /// Takes every held snapshot not yet taken, as of now; none of them resolves yet.
        fn take(&self) {
            let mut t = self.terminal();
            let now = t.snapshot_now();
            for asked in &mut t.held {
                asked
                    .taken
                    .get_or_insert_with(|| Snapshot::new(now.vt().to_vec(), now.at()));
            }
        }

        /// Resolves every held snapshot, each as taken or as of now, and stops holding them.
        fn release(&self) {
            let mut t = self.terminal();
            t.holding = false;
            for asked in std::mem::take(&mut t.held) {
                let shown = asked.taken.unwrap_or_else(|| t.snapshot_now());
                let _ = asked.answer.send(shown);
            }
        }

        /// Resizes from now on wait for a permit each from what this returns.
        fn hold_resizes(&self) -> Arc<Semaphore> {
            let gate = Arc::new(Semaphore::new(0));
            self.terminal().gate = Some(Arc::clone(&gate));
            gate
        }

        fn refuse_resizes(&self, why: &str) {
            self.terminal().refuse_resizes = Some(why.to_owned());
        }

        fn written(&self) -> Vec<String> {
            self.terminal().written.clone()
        }

        fn resizes(&self) -> Vec<Size> {
            self.terminal().resizes.clone()
        }

        fn attaches(&self) -> Vec<Option<Size>> {
            self.terminal().attaches.clone()
        }

        fn closes(&self) -> usize {
            self.terminal().closes
        }

        fn asked(&self) -> Vec<String> {
            self.terminal().asked.clone()
        }

        fn snapshots_asked(&self) -> usize {
            self.asked().iter().filter(|a| *a == "snapshot").count()
        }
    }

    struct FakeStream {
        terminal: Fake,
        client: usize,
    }

    impl FakeStream {
        fn open(&self) -> bool {
            self.terminal
                .terminal()
                .clients
                .iter()
                .any(|(n, _)| *n == self.client)
        }
    }

    impl TerminalStream for FakeStream {
        type Error = String;

        fn size(&self) -> Size {
            self.terminal.terminal().size
        }

        fn write(&self, input: &[u8]) {
            self.terminal
                .terminal()
                .written
                .push(String::from_utf8(input.to_vec()).unwrap());
        }

        async fn resize(&self, to: Size) -> Result<(), String> {
            let gate = {
                let mut t = self.terminal.terminal();
                t.asked
                    .push(format!("resize {}x{}", to.cols.get(), to.rows.get()));
                t.gate.clone()
            };
            match gate {
                Some(gate) => gate.acquire().await.unwrap().forget(),
                None => tokio::task::yield_now().await,
            }
            let mut t = self.terminal.terminal();
            if let Some(why) = &t.refuse_resizes {
                return Err(why.clone());
            }
            t.resizes.push(to);
            t.sized_elsewhere(to);
            Ok(())
        }

        async fn snapshot(&self) -> Result<Snapshot, String> {
            if !self.open() {
                return Err("the stream closed".to_owned());
            }
            let waiting = {
                let mut t = self.terminal.terminal();
                t.asked.push("snapshot".to_owned());
                if let Some(hook) = t.before_snapshot.take() {
                    hook(&mut t);
                }
                let now = t.snapshot_now();
                if let Some(hook) = t.during_snapshot.take() {
                    hook(&mut t);
                }
                if !t.holding {
                    return Ok(now);
                }
                let (answer, waiting) = oneshot::channel();
                t.held.push(Asked {
                    answer,
                    taken: None,
                });
                waiting
            };
            waiting.await.map_err(|_| "the stream closed".to_owned())
        }

        fn close(&self) {
            let mut t = self.terminal.terminal();
            t.closes += 1;
            let client = self.client;
            if let Some(index) = t.clients.iter().position(|(n, _)| *n == client) {
                let (_, events) = t.clients.remove(index);
                let _ = events.send(StreamEvent::Closed(StreamEnd::Ended));
            }
        }
    }

    struct FakeEvents(mpsc::UnboundedReceiver<StreamEvent>);

    impl TerminalEvents for FakeEvents {
        async fn recv(&mut self) -> Option<StreamEvent> {
            self.0.recv().await
        }
    }

    impl Runtime for Fake {
        type Stream = FakeStream;
        type Events = FakeEvents;
        type Error = String;

        fn attach(
            &self,
            _terminal: &TerminalId,
            at: Option<Size>,
        ) -> impl Future<Output = Result<Opened<FakeStream, FakeEvents>, String>> + Send {
            let mut t = self.terminal();
            t.attaches.push(at);
            // A stream sizes the terminal before it subscribes, so its snapshot is drawn at that
            // size.
            if let Some(at) = at.filter(|&at| at != t.size) {
                t.sized_elsewhere(at);
            }
            let (tx, rx) = mpsc::unbounded_channel();
            let client = t.next_client;
            t.next_client += 1;
            t.clients.push((client, tx));
            let snapshot = t.snapshot_now();
            let drawn_at = t.size;
            if let Some(hook) = t.after_attach.take() {
                hook(&mut t);
            }
            std::future::ready(Ok(Opened {
                snapshot,
                size: drawn_at,
                history_lines: t.history_lines,
                stream: FakeStream {
                    terminal: self.clone(),
                    client,
                },
                events: FakeEvents(rx),
            }))
        }
    }

    #[derive(Default)]
    struct Book {
        events: Vec<String>,
        closing: bool,
        refuse_exits: Option<String>,
        /// What else to note as an exit is recorded, once its recording has given every task a
        /// chance to run.
        as_exit_recorded: Option<Box<dyn Fn() -> String + Send>>,
    }

    /// What the hub records, as lines.
    #[derive(Clone, Default)]
    struct Log(Arc<Mutex<Book>>);

    impl Log {
        fn push(&self, event: String) {
            self.0.lock().unwrap().events.push(event);
        }

        fn events(&self) -> Vec<String> {
            self.0.lock().unwrap().events.clone()
        }

        fn starting(&self, prefix: &str) -> Vec<String> {
            self.events()
                .into_iter()
                .filter(|e| e.starts_with(prefix))
                .collect()
        }
    }

    impl AttachmentLog for Log {
        type Error = String;

        fn started(&self, attachment: &AttachmentId, _: &TerminalId, _: AttachmentMode) {
            self.push(format!("started {attachment}"));
        }

        fn ended(&self, attachment: &AttachmentId, reason: AttachmentEndReason) {
            let reason = serde_json::to_value(reason).unwrap();
            self.push(format!("ended {attachment} {}", reason.as_str().unwrap()));
        }

        fn granted(&self, _: &TerminalId, attachment: &AttachmentId, epoch: Epoch) {
            self.push(format!("granted {attachment} {}", epoch.get()));
        }

        fn epoch(&self, _: &TerminalId) -> Result<Epoch, String> {
            Ok(Epoch::new(4))
        }

        fn closing(&self, _: &TerminalId) -> bool {
            self.0.lock().unwrap().closing
        }

        async fn exited(&self, terminal: &TerminalId, exit: &Exited) -> Result<(), String> {
            self.push(format!("exited {terminal} {}", exit.generation.get()));
            // A view told before the record finishes would hear of it meanwhile.
            yields(16).await;
            let (noted, refused) = {
                let book = self.0.lock().unwrap();
                (
                    book.as_exit_recorded.as_ref().map(|note| note()),
                    book.refuse_exits.clone(),
                )
            };
            if let Some(noted) = noted {
                self.push(noted);
            }
            refused.map_or(Ok(()), Err)
        }
    }

    /// Everything a view's socket was sent.
    #[derive(Default)]
    struct Record {
        frames: Vec<StreamServerFrame>,
        output: Vec<u8>,
        /// Output and exits, in the order the view was sent them.
        log: Vec<String>,
        /// Each thing sent: a frame's type, or "bytes".
        order: Vec<String>,
        closed: bool,
    }

    #[derive(Clone, Default)]
    struct Seen(Arc<Mutex<Record>>);

    impl Seen {
        fn record(&self) -> std::sync::MutexGuard<'_, Record> {
            self.0.lock().unwrap()
        }

        fn frames(&self) -> Vec<StreamServerFrame> {
            self.record().frames.clone()
        }

        fn last_frame(&self) -> Option<StreamServerFrame> {
            self.record().frames.last().cloned()
        }

        fn leases(&self) -> Vec<StreamServerFrame> {
            self.frames()
                .into_iter()
                .filter(|f| matches!(f, StreamServerFrame::Lease { .. }))
                .collect()
        }

        fn exits(&self) -> Vec<StreamServerFrame> {
            self.frames()
                .into_iter()
                .filter(|f| matches!(f, StreamServerFrame::Exited { .. }))
                .collect()
        }

        fn notices(&self) -> Vec<StreamServerFrame> {
            self.frames()
                .into_iter()
                .filter(|f| matches!(f, StreamServerFrame::Notice { .. }))
                .collect()
        }

        fn geometries(&self) -> Vec<StreamServerFrame> {
            self.frames()
                .into_iter()
                .filter(|f| matches!(f, StreamServerFrame::Geometry { .. }))
                .collect()
        }

        fn output(&self) -> Vec<u8> {
            self.record().output.clone()
        }

        fn log(&self) -> Vec<String> {
            self.record().log.clone()
        }

        fn last_output(&self) -> Option<String> {
            self.record()
                .log
                .iter()
                .rev()
                .find(|l| !l.starts_with("<exited"))
                .cloned()
        }

        fn order(&self) -> Vec<String> {
            self.record().order.clone()
        }

        fn closed(&self) -> bool {
            self.record().closed
        }

        fn attached(&self) -> bool {
            self.frames()
                .iter()
                .any(|f| matches!(f, StreamServerFrame::Attached { .. }))
        }

        fn token(&self) -> String {
            self.frames()
                .into_iter()
                .find_map(|f| match f {
                    StreamServerFrame::Attached { resume_token, .. } => resume_token,
                    _ => None,
                })
                .unwrap()
        }
    }

    fn type_of(frame: &StreamServerFrame) -> String {
        let value = serde_json::to_value(frame).unwrap();
        value["type"].as_str().unwrap().to_owned()
    }

    /// A view's socket, writing everything it is sent at once.
    struct Recorder {
        seen: Seen,
        /// Where it declares its epoch, as a browser does: on every lease frame once attached.
        declares: Option<(Hub<Fake, Log>, TerminalId)>,
        epoch: u64,
        id: Option<AttachmentId>,
        on_output: Option<Box<dyn FnMut() + Send>>,
    }

    impl Recorder {
        fn declare(&self) {
            if let (Some((hub, terminal)), Some(id)) = (&self.declares, &self.id) {
                hub.declare_epoch(terminal, id, self.epoch);
            }
        }
    }

    impl ViewSocket for Recorder {
        type Error = ();

        fn output(&mut self, output: Vec<u8>) -> impl Future<Output = Result<(), ()>> + Send {
            {
                let mut record = self.seen.record();
                record
                    .log
                    .push(String::from_utf8_lossy(&output).into_owned());
                record.output.extend_from_slice(&output);
                record.order.push("bytes".to_owned());
            }
            if let Some(hook) = &mut self.on_output {
                hook();
            }
            std::future::ready(Ok(()))
        }

        fn frame(
            &mut self,
            frame: &StreamServerFrame,
        ) -> impl Future<Output = Result<(), ()>> + Send {
            {
                let mut record = self.seen.record();
                record.frames.push(frame.clone());
                record.order.push(type_of(frame));
                if let StreamServerFrame::Exited { generation, .. } = frame {
                    record.log.push(format!("<exited {generation}>"));
                }
            }
            match frame {
                StreamServerFrame::Lease { epoch, .. } => {
                    self.epoch = *epoch;
                    self.declare();
                }
                StreamServerFrame::Attached { attachment_id, .. } => {
                    self.id = Some(attachment_id.clone());
                    self.declare();
                }
                _ => {}
            }
            std::future::ready(Ok(()))
        }
    }

    /// How a view asks to open.
    struct Ask {
        mode: AttachmentMode,
        size: Size,
        device_name: Option<String>,
        /// Whether it declares its epoch as a browser does, or only when the test says.
        declares: bool,
        resumes: Option<Resumes>,
        on_output: Option<Box<dyn FnMut() + Send>>,
    }

    impl Ask {
        fn new(mode: AttachmentMode) -> Self {
            Self {
                mode,
                size: standard(),
                device_name: None,
                declares: true,
                resumes: None,
                on_output: None,
            }
        }

        fn interactive() -> Self {
            Self::new(AttachmentMode::Interactive)
        }

        fn observer() -> Self {
            Self::new(AttachmentMode::Observe)
        }

        fn at(self, size: Size) -> Self {
            Self { size, ..self }
        }

        fn declaring_by_hand(self) -> Self {
            Self {
                declares: false,
                ..self
            }
        }

        fn resuming(self, attachment_id: &AttachmentId, token: String) -> Self {
            Self {
                resumes: Some(Resumes {
                    attachment_id: attachment_id.clone(),
                    token,
                }),
                ..self
            }
        }
    }

    /// An open view: its attachment and what it was sent.
    struct V {
        id: AttachmentId,
        seen: Seen,
    }

    struct H {
        rt: Fake,
        log: Log,
        hub: Hub<Fake, Log>,
        tasks: TaskTracker,
        terminal: TerminalId,
    }

    impl H {
        fn new() -> Self {
            Self::with(Fake::new("earlier output", 10_000))
        }

        fn with(rt: Fake) -> Self {
            let log = Log::default();
            let tasks = TaskTracker::new();
            let hub = Hub::new(
                rt.clone(),
                log.clone(),
                HubOptions::default(),
                tasks.clone(),
            );
            Self {
                rt,
                log,
                hub,
                tasks,
                terminal: TerminalId::mint(1, [7; 16]),
            }
        }

        /// Starts a view opening; what it returns resolves once the join has.
        fn start(&self, ask: Ask) -> (oneshot::Receiver<Result<Attachment, JoinError>>, Seen) {
            let (outbox, inbox) = view::queue(MOST_UNSENT);
            let seen = Seen::default();
            let mut socket = Recorder {
                seen: seen.clone(),
                declares: ask
                    .declares
                    .then(|| (self.hub.clone(), self.terminal.clone())),
                epoch: 0,
                id: None,
                on_output: ask.on_output,
            };
            self.tasks.spawn(async move {
                let _ = write_to(inbox, &mut socket).await;
                socket.seen.record().closed = true;
            });
            let (answer, joined) = oneshot::channel();
            let hub = self.hub.clone();
            let terminal = self.terminal.clone();
            let viewer = Viewer {
                mode: ask.mode,
                device_name: ask.device_name,
                outbox,
            };
            let (at, resumes) = (ask.size, ask.resumes);
            self.tasks.spawn(async move {
                let _ = answer.send(hub.join(&terminal, viewer, at, resumes).await);
            });
            (joined, seen)
        }

        async fn open(&self, ask: Ask) -> (Result<Attachment, JoinError>, Seen) {
            let (joined, seen) = self.start(ask);
            let joined = joined.await.unwrap();
            settle().await;
            (joined, seen)
        }

        async fn view(&self, ask: Ask) -> V {
            let (joined, seen) = self.open(ask).await;
            V {
                id: joined.unwrap().id,
                seen,
            }
        }

        async fn interactive(&self) -> V {
            self.view(Ask::interactive()).await
        }

        async fn observer(&self) -> V {
            self.view(Ask::observer()).await
        }

        async fn print(&self, text: &str) {
            self.rt.print(text);
            settle().await;
        }

        async fn input(&self, view: &V, input: &str) {
            self.hub.write(
                &self.terminal,
                &Writer::View(view.id.clone()),
                input.as_bytes(),
            );
            settle().await;
        }

        async fn engage(&self, view: &V) {
            self.hub.engage(&self.terminal, &view.id);
            settle().await;
        }

        async fn declare(&self, view: &V, epoch: u64) {
            self.hub.declare_epoch(&self.terminal, &view.id, epoch);
            settle().await;
        }

        async fn resize(&self, view: &V, to: Size) {
            self.hub.resize(&self.terminal, &view.id, to);
            settle().await;
        }

        async fn leave(&self, view: &V) {
            self.hub
                .leave(&self.terminal, &view.id, LeaveReason::ClientClosed);
            settle().await;
        }
    }

    fn lease(is_driver: bool, driven: bool, epoch: u64) -> StreamServerFrame {
        StreamServerFrame::Lease {
            driver: is_driver,
            epoch,
            driven: Some(driven),
            driver_device: None,
        }
    }

    fn exit_frame(generation: u64, code: i64) -> StreamServerFrame {
        StreamServerFrame::Exited {
            generation,
            exit: agents::ExitStatus::Exited { code },
        }
    }

    fn geometry(cols: u16, rows: u16) -> StreamServerFrame {
        StreamServerFrame::Geometry { cols, rows }
    }

    fn notice(message: &str) -> StreamServerFrame {
        StreamServerFrame::Notice {
            message: message.to_owned(),
        }
    }

    /// A browser's terminal after writing `output`.
    fn replayed(output: &[u8]) -> Engine {
        let mut engine = Engine::new(
            bazhen_holder_engine::Size { cols: 80, rows: 24 },
            HistoryRows(10_000),
        );
        engine.advance(output);
        engine
    }

    /// The rows that hold anything, of the newest `history` rows of history and then the screen.
    fn rows_of(engine: &mut Engine, history: usize) -> Vec<String> {
        let mut text = String::new();
        engine.text(history, usize::MAX, &mut text).unwrap();
        text.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect()
    }

    /// Each non-blank row a browser holds after writing what a view was sent.
    fn screen_of(view: &Seen) -> Vec<String> {
        rows_of(&mut replayed(&view.output()), 10_000)
    }

    mod terminal_hub {
        use super::*;

        #[test]
        fn serves_every_view_of_a_terminal_from_one_stream() {
            runtime().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                let b = h.observer().await;
                h.print("out").await;
                assert_eq!(
                    (
                        h.rt.attaches().len(),
                        a.seen.last_output(),
                        b.seen.last_output()
                    ),
                    (1, Some("out".to_owned()), Some("out".to_owned()))
                );
            });
        }

        #[test]
        fn opens_every_view_on_its_snapshot_then_live_output_with_nothing_missed_or_repeated() {
            runtime().block_on(async {
                let h = H::new();
                h.rt.print("before ");
                let first = h.interactive().await;
                h.print("one ").await;
                h.rt.during_snapshot(|t| t.print("two "));
                let late = h.interactive().await;
                h.print("three").await;
                let all = ["earlier output", "before one two three"].map(str::to_owned);
                assert_eq!(
                    (screen_of(&first.seen), screen_of(&late.seen)),
                    (all.to_vec(), all.to_vec())
                );
                let mut shown = replayed(&late.seen.output());
                let screen = rows_of(&mut shown, 0);
                let history = rows_of(&mut shown, 10_000);
                assert_eq!(
                    (screen.first().cloned(), history.first().cloned()),
                    (
                        Some("before one two three".to_owned()),
                        Some("earlier output".to_owned())
                    )
                );
            });
        }

        #[test]
        fn tells_a_view_as_its_snapshot_starts_how_much_history_its_terminal_keeps() {
            runtime().block_on(async {
                let h = H::with(Fake::new("earlier output", 250));
                let view = h.interactive().await;
                assert_eq!(
                    view.seen
                        .frames()
                        .into_iter()
                        .find(|f| matches!(f, StreamServerFrame::SnapshotStart { .. })),
                    Some(StreamServerFrame::SnapshotStart {
                        history_lines: Some(250)
                    })
                );
            });
        }

        #[test]
        fn starts_every_view_of_a_respawned_terminal_on_its_main_screen_as_a_fresh_terminal() {
            runtime().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                h.print("\x1b]11;#ff0000\x07\x1b[?1049hALTDRAWN\x1b[?1000h")
                    .await;
                h.rt.exits(0);
                h.rt.respawned(1);
                h.print("respawned").await;
                let late = h.interactive().await;
                let state = |output: &[u8]| {
                    let shown = replayed(output);
                    (shown.alternate(), shown.modes())
                };
                let fresh = state(&[]);
                assert_eq!(
                    (
                        state(&first.seen.output()),
                        state(&late.seen.output()),
                        screen_of(&late.seen).iter().any(|l| l.contains("ALTDRAWN"))
                    ),
                    (fresh.clone(), fresh, false)
                );
            });
        }

        #[test]
        fn never_tells_a_view_it_is_attached_when_the_terminal_closes_while_it_opens() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.rt.during_snapshot(Terminal::vanish);
                let (joined, late) = h.open(Ask::interactive()).await;
                assert_eq!(
                    (joined, late.attached(), late.closed()),
                    (Err(JoinError::Ended), false, true)
                );
            });
        }

        #[test]
        fn never_tells_a_view_it_is_attached_when_the_terminal_closes_as_its_screen_is_sent() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                let rt = h.rt.clone();
                let (joined, late) = h
                    .open(Ask {
                        on_output: Some(Box::new(move || rt.vanish())),
                        ..Ask::interactive()
                    })
                    .await;
                assert_eq!((joined, late.attached()), (Err(JoinError::Ended), false));
            });
        }

        #[test]
        fn tells_a_view_it_is_attached_only_once_it_has_its_screen_and_is_ready_for_input() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                let late = h.interactive().await;
                assert_eq!(
                    late.seen.order(),
                    [
                        "snapshot_start",
                        "geometry",
                        "lease",
                        "bytes",
                        "snapshot_end",
                        "attached"
                    ]
                );
            });
        }

        #[test]
        fn passes_keystrokes_only_from_the_driver_and_drops_the_rest_without_queuing_them() {
            runtime().block_on(async {
                let h = H::new();
                let laptop = h.interactive().await;
                let watcher = h.observer().await;
                h.engage(&laptop).await;
                h.input(&laptop, "a").await;
                h.input(&watcher, "b").await;
                h.input(&watcher, "c").await;
                let dropped = watcher
                    .seen
                    .frames()
                    .into_iter()
                    .filter(|f| *f == StreamServerFrame::InputDropped)
                    .count();
                assert_eq!((h.rt.written(), dropped), (vec!["a".to_owned()], 1));
            });
        }

        #[test]
        fn drops_a_stray_keystroke_from_an_interactive_view_and_gives_that_view_the_lease() {
            runtime().block_on(async {
                let h = H::new();
                let laptop = h.interactive().await;
                let phone = h.interactive().await;
                h.engage(&laptop).await;
                h.input(&phone, "b").await;
                h.input(&phone, "c").await;
                let told_dropped = phone
                    .seen
                    .frames()
                    .contains(&StreamServerFrame::InputDropped);
                assert_eq!(
                    (h.rt.written(), laptop.seen.last_frame(), told_dropped),
                    (vec!["c".to_owned()], Some(lease(false, true, 6)), false)
                );
            });
        }

        #[test]
        fn drops_a_key_typed_before_its_view_learnt_of_a_takeover_and_leaves_the_lease_where_it_is()
        {
            runtime().block_on(async {
                let h = H::new();
                let laptop = h.view(Ask::interactive().declaring_by_hand()).await;
                let phone = h.interactive().await;
                h.engage(&laptop).await;
                h.declare(&laptop, 5).await;
                h.input(&laptop, "a").await;
                h.engage(&phone).await;
                // Typed at epoch 5, still on the wire as the phone took over.
                h.input(&laptop, "b").await;
                let after_stale_key = phone.seen.last_frame();
                // The laptop has seen it lost: its next key is the user's, and takes the lease
                // back.
                h.declare(&laptop, 6).await;
                h.input(&laptop, "c").await;
                assert_eq!(
                    (h.rt.written(), after_stale_key, phone.seen.last_frame()),
                    (
                        vec!["a".to_owned()],
                        Some(lease(true, false, 6)),
                        Some(lease(false, true, 7))
                    )
                );
            });
        }

        #[test]
        fn keeps_the_lease_still_while_two_views_type_at_once_applying_only_the_driver_s_keys() {
            runtime().block_on(async {
                let h = H::new();
                let laptop = h.view(Ask::interactive().declaring_by_hand()).await;
                let phone = h.view(Ask::interactive().declaring_by_hand()).await;
                h.engage(&laptop).await;
                h.declare(&laptop, 5).await;
                h.engage(&phone).await;
                h.declare(&phone, 6).await;
                // The laptop hasn't heard it lost yet; its keys and the phone's interleave.
                for (view, key) in [(&laptop, "1"), (&phone, "2"), (&laptop, "3"), (&phone, "4")] {
                    h.input(view, key).await;
                }
                assert_eq!(
                    (h.rt.written(), h.log.starting("granted").len()),
                    (vec!["2".to_owned(), "4".to_owned()], 2)
                );
            });
        }

        #[test]
        fn drops_a_view_s_input_until_it_declares_its_epoch() {
            runtime().block_on(async {
                let h = H::new();
                let declaring = h.view(Ask::interactive().declaring_by_hand()).await;
                h.engage(&declaring).await;
                h.input(&declaring, "x").await;
                h.declare(&declaring, 5).await;
                h.input(&declaring, "y").await;
                assert_eq!(h.rt.written(), ["y"]);
            });
        }

        #[test]
        fn drops_input_declared_under_an_epoch_the_view_was_never_granted() {
            runtime().block_on(async {
                let h = H::new();
                let declaring = h.view(Ask::interactive().declaring_by_hand()).await;
                h.engage(&declaring).await;
                h.declare(&declaring, 6).await;
                h.input(&declaring, "x").await;
                assert_eq!(h.rt.written(), Vec::<String>::new());
            });
        }

        #[test]
        fn ends_a_view_s_own_earlier_attachment_when_it_reattaches_freeing_the_lease_it_held() {
            runtime().block_on(async {
                let h = H::new();
                let gone = h.interactive().await;
                h.engage(&gone).await;
                let token = gone.seen.token();
                let back = h.view(Ask::interactive().resuming(&gone.id, token)).await;
                assert_eq!(
                    (
                        gone.seen.closed(),
                        h.log.starting(&format!("ended {}", gone.id)),
                        back.seen.leases().first().cloned()
                    ),
                    (
                        true,
                        vec![format!("ended {} replaced", gone.id)],
                        Some(lease(false, false, 5))
                    )
                );
            });
        }

        #[test]
        fn leaves_the_lease_with_a_view_that_took_it_while_the_reattaching_one_was_gone() {
            runtime().block_on(async {
                let h = H::new();
                let gone = h.interactive().await;
                let phone = h.interactive().await;
                h.engage(&gone).await;
                h.engage(&phone).await;
                let token = gone.seen.token();
                let back = h.view(Ask::interactive().resuming(&gone.id, token)).await;
                assert_eq!(
                    (
                        h.log
                            .events()
                            .contains(&format!("ended {} replaced", gone.id)),
                        back.seen.leases().first().cloned(),
                        phone.seen.last_frame()
                    ),
                    (
                        true,
                        Some(lease(false, true, 6)),
                        Some(lease(true, false, 6))
                    )
                );
            });
        }

        #[test]
        fn ends_no_attachment_for_a_token_it_was_not_given_which_the_driver_s_id_alone_cannot_name()
        {
            runtime().block_on(async {
                let h = H::new();
                let driver = h.interactive().await;
                h.engage(&driver).await;
                // Another view knows the driver's id, as every reader of the event stream does.
                let other = h.interactive().await;
                let intruder = h
                    .view(Ask::interactive().resuming(&driver.id, other.seen.token()))
                    .await;
                assert_eq!(
                    (
                        driver.seen.closed(),
                        h.log.events().iter().any(|e| e.ends_with("replaced")),
                        intruder.seen.leases().first().cloned()
                    ),
                    (false, false, Some(lease(false, true, 5)))
                );
            });
        }

        #[test]
        fn gives_every_view_its_own_resume_token() {
            runtime().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                let b = h.interactive().await;
                assert_ne!(a.seen.token(), b.seen.token());
            });
        }

        #[test]
        fn names_the_driving_view_s_device_to_the_others_and_none_it_is_not_on() {
            runtime().block_on(async {
                let h = H::new();
                let laptop = h.interactive().await;
                let phone = h
                    .view(Ask {
                        device_name: Some("Phone".to_owned()),
                        ..Ask::interactive()
                    })
                    .await;
                h.engage(&phone).await;
                let to_laptop = laptop.seen.last_frame();
                let to_phone = phone.seen.last_frame();
                h.engage(&laptop).await;
                assert_eq!(
                    (to_laptop, to_phone, phone.seen.last_frame()),
                    (
                        Some(StreamServerFrame::Lease {
                            driver: false,
                            epoch: 5,
                            driven: Some(true),
                            driver_device: Some("Phone".to_owned())
                        }),
                        Some(lease(true, false, 5)),
                        Some(lease(false, true, 6))
                    )
                );
            });
        }

        #[test]
        fn never_passes_a_terminal_reply_from_the_driver_to_the_program() {
            runtime().block_on(async {
                let h = H::new();
                let driver = h.interactive().await;
                h.engage(&driver).await;
                h.input(&driver, "\x1b[?1;2c").await;
                h.input(&driver, "x").await;
                assert_eq!(h.rt.written(), ["x"]);
            });
        }

        #[test]
        fn takes_the_lease_for_a_stray_keystroke_but_not_for_a_focus_report() {
            runtime().block_on(async {
                let h = H::new();
                let laptop = h.interactive().await;
                let phone = h.interactive().await;
                h.engage(&laptop).await;
                h.input(&phone, "\x1b[O").await;
                let after_focus_report = laptop.seen.last_frame();
                h.input(&phone, "k").await;
                assert_eq!(
                    (h.rt.written(), after_focus_report, laptop.seen.last_frame()),
                    (
                        Vec::<String>::new(),
                        Some(lease(true, false, 5)),
                        Some(lease(false, true, 6))
                    )
                );
            });
        }

        #[test]
        fn moves_the_lease_to_the_view_the_user_engages_and_tells_every_view() {
            runtime().block_on(async {
                let h = H::new();
                let laptop = h.interactive().await;
                let phone = h.view(Ask::interactive().at(size(40, 50))).await;
                h.engage(&laptop).await;
                h.engage(&phone).await;
                assert_eq!(
                    (
                        laptop.seen.leases().last().cloned(),
                        phone.seen.leases().last().cloned(),
                        h.log.starting("granted"),
                        h.rt.resizes().last().copied()
                    ),
                    (
                        Some(lease(false, true, 6)),
                        Some(lease(true, false, 6)),
                        vec![
                            format!("granted {} 5", laptop.id),
                            format!("granted {} 6", phone.id)
                        ],
                        Some(size(40, 50))
                    )
                );
            });
        }

        #[test]
        fn never_gives_the_lease_to_an_observer() {
            runtime().block_on(async {
                let h = H::new();
                let watcher = h.observer().await;
                h.engage(&watcher).await;
                h.input(&watcher, "x").await;
                assert_eq!(
                    (h.rt.written(), h.log.starting("granted")),
                    (Vec::<String>::new(), Vec::<String>::new())
                );
            });
        }

        #[test]
        fn sizes_the_terminal_only_from_its_driver() {
            runtime().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                let b = h.interactive().await;
                h.engage(&a).await;
                h.resize(&b, size(30, 10)).await;
                h.resize(&a, size(100, 30)).await;
                assert_eq!(h.rt.resizes(), [size(100, 30)]);
            });
        }

        #[test]
        fn never_resizes_the_terminal_to_the_size_it_already_has_which_would_redraw_every_view() {
            runtime().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                h.interactive().await;
                h.engage(&a).await;
                h.resize(&a, standard()).await;
                h.observer().await;
                assert_eq!(h.rt.resizes(), []);
            });
        }

        #[test]
        fn applies_only_the_latest_of_a_burst_of_resizes_once_the_one_in_flight_settles() {
            runtime().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                h.engage(&a).await;
                for cols in 81..=90 {
                    h.hub.resize(&h.terminal, &a.id, size(cols, 24));
                }
                settle().await;
                assert_eq!(h.rt.resizes(), [size(81, 24), size(90, 24)]);
            });
        }

        #[test]
        fn never_sizes_the_terminal_from_an_observer_even_the_first_one_to_open_it() {
            runtime().block_on(async {
                let h = H::new();
                h.view(Ask::observer().at(size(40, 60))).await;
                assert_eq!((h.rt.attaches(), h.rt.resizes()), (vec![None], vec![]));
            });
        }

        #[test]
        fn sizes_the_terminal_from_the_latest_interactive_view_while_nobody_drives() {
            runtime().block_on(async {
                let h = H::new();
                h.observer().await;
                h.view(Ask::interactive().at(size(120, 40))).await;
                assert_eq!(h.rt.resizes(), [size(120, 40)]);
            });
        }

        #[test]
        fn hands_the_size_to_the_remaining_view_when_the_driver_leaves_and_tells_it() {
            runtime().block_on(async {
                let h = H::new();
                let laptop = h.view(Ask::interactive().at(size(200, 50))).await;
                let phone = h.view(Ask::interactive().at(size(60, 50))).await;
                h.engage(&laptop).await;
                let driving = h.rt.resizes().last().copied();
                let before = phone.seen.leases().len();
                h.leave(&laptop).await;
                assert_eq!(
                    (
                        driving,
                        h.rt.resizes().last().copied(),
                        phone.seen.leases().len() - before,
                        phone.seen.leases().last().cloned()
                    ),
                    (
                        Some(size(200, 50)),
                        Some(size(60, 50)),
                        1,
                        Some(lease(false, false, 5))
                    )
                );
            });
        }

        #[test]
        fn closes_the_stream_once_its_last_view_has_left_and_opens_another_for_the_next() {
            runtime().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                let b = h.interactive().await;
                h.leave(&a).await;
                let one_left = h.rt.closes();
                h.leave(&b).await;
                let ended = h.log.events().last().cloned();
                let none_left = h.rt.closes();
                let back = h.interactive().await;
                h.print("out").await;
                assert_eq!(
                    (
                        one_left,
                        none_left,
                        ended,
                        h.rt.attaches().len(),
                        back.seen.last_output()
                    ),
                    (
                        0,
                        1,
                        Some(format!("ended {} client_closed", b.id)),
                        2,
                        Some("out".to_owned())
                    )
                );
            });
        }

        #[test]
        fn tells_every_view_when_the_terminal_itself_goes_away() {
            runtime().block_on(async {
                let h = H::new();
                h.log.0.lock().unwrap().closing = true;
                let a = h.interactive().await;
                h.rt.vanish();
                settle().await;
                assert_eq!(
                    (
                        a.seen.last_frame(),
                        a.seen.closed(),
                        h.log.events().last().cloned(),
                        h.rt.closes()
                    ),
                    (
                        Some(StreamServerFrame::Closed),
                        true,
                        Some(format!("ended {} terminal_closed", a.id)),
                        0
                    )
                );
            });
        }
    }

    mod screen_state {
        use super::*;

        #[test]
        fn tells_a_view_nothing_of_its_screen_whose_switches_its_bytes_carry() {
            runtime().block_on(async {
                let h = H::new();
                h.rt.print("\x1b[?1049h");
                let a = h.interactive().await;
                h.print("\x1b[?1049l").await;
                h.print("\x1b[?1049h").await;
                let screens = a
                    .seen
                    .frames()
                    .into_iter()
                    .filter(|f| matches!(f, StreamServerFrame::Screen { .. }))
                    .count();
                assert_eq!((screens, replayed(&a.seen.output()).alternate()), (0, true));
            });
        }

        #[test]
        fn tells_every_view_what_failed_in_the_runtime() {
            runtime().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                let b = h.observer().await;
                h.rt.fails("screen check", "tmux gone");
                settle().await;
                let told = vec![notice("screen check failed: tmux gone")];
                assert_eq!((a.seen.notices(), b.seen.notices()), (told.clone(), told));
            });
        }

        #[test]
        fn ends_views_as_disconnected_when_the_stream_is_lost_but_the_terminal_lives_on() {
            runtime().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                h.rt.vanish();
                settle().await;
                assert_eq!(
                    (
                        a.seen.last_frame(),
                        a.seen.closed(),
                        h.log.events().last().cloned()
                    ),
                    (
                        Some(StreamServerFrame::Ended {
                            reason: EndedReason::Disconnected
                        }),
                        true,
                        Some(format!("ended {} disconnected", a.id))
                    )
                );
            });
        }
    }

    mod a_process_s_exit {
        use super::*;

        #[test]
        fn tells_every_open_view_of_it_after_the_output_before_it_and_keeps_the_views_open() {
            runtime().block_on(async {
                let h = H::new();
                let one = h.interactive().await;
                let two = h.observer().await;
                h.print("last words").await;
                h.rt.exits(0);
                settle().await;
                for view in [&one, &two] {
                    let log = view.seen.log();
                    assert_eq!(
                        (
                            log[log.len() - 2..].to_vec(),
                            view.seen.exits(),
                            view.seen.closed()
                        ),
                        (
                            vec!["last words".to_owned(), "<exited 0>".to_owned()],
                            vec![exit_frame(0, 0)],
                            false
                        )
                    );
                }
                assert_eq!(h.log.starting("ended"), Vec::<String>::new());
            });
        }

        #[test]
        fn has_it_recorded_before_any_view_is_told_of_it() {
            runtime().block_on(async {
                let h = H::new();
                let view = h.interactive().await;
                let seen = view.seen.clone();
                h.log.0.lock().unwrap().as_exit_recorded = Some(Box::new(move || {
                    format!("views told: {}", seen.exits().len())
                }));
                h.rt.exits(0);
                settle().await;
                let recorded: Vec<String> = h
                    .log
                    .events()
                    .into_iter()
                    .filter(|e| e.starts_with("exited") || e.starts_with("views told"))
                    .collect();
                assert_eq!(
                    (recorded, view.seen.exits()),
                    (
                        vec![
                            format!("exited {} 0", h.terminal),
                            "views told: 0".to_owned()
                        ],
                        vec![exit_frame(0, 0)]
                    )
                );
            });
        }

        #[test]
        fn has_an_exit_told_before_a_view_opened_recorded_as_that_view_is_told() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.rt.exits(0);
                settle().await;
                let before = h.log.starting("exited").len();
                let late = h.interactive().await;
                assert_eq!(
                    (h.log.starting("exited").len() - before, late.seen.exits()),
                    (1, vec![exit_frame(0, 0)])
                );
            });
        }

        #[test]
        fn still_tells_its_views_of_an_exit_that_could_not_be_recorded_and_says_why() {
            runtime().block_on(async {
                let said = Said::default();
                let _logging = said.logging();
                let h = H::new();
                h.log.0.lock().unwrap().refuse_exits = Some("the store is read-only".to_owned());
                let view = h.interactive().await;
                h.rt.exits(0);
                settle().await;
                assert_eq!(
                    (view.seen.exits(), said.times("the store is read-only")),
                    (vec![exit_frame(0, 0)], 1)
                );
            });
        }

        #[test]
        fn holds_it_for_a_view_whose_snapshot_is_on_its_way_behind_the_output_before_it() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.rt.hold_snapshots();
                let (joined, late) = h.start(Ask::interactive());
                settle().await;
                h.print("one ").await;
                h.rt.exits(0);
                settle().await;
                h.rt.take();
                h.print("two").await;
                h.rt.release();
                joined.await.unwrap().unwrap();
                settle().await;
                let log = late.log();
                let at = log.iter().position(|l| l == "<exited 0>").unwrap();
                assert_eq!(
                    (
                        late.exits(),
                        log[..at].concat().contains("one "),
                        log[at + 1..].concat()
                    ),
                    (vec![exit_frame(0, 0)], true, "two".to_owned())
                );
            });
        }

        #[test]
        fn tells_a_view_that_opens_after_it_of_it_once() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.print("last words").await;
                h.rt.exits(3);
                settle().await;
                let late = h.interactive().await;
                let order = late.seen.order();
                let ended = order.iter().position(|k| k == "snapshot_end");
                let told = order.iter().position(|k| k == "exited");
                assert_eq!(
                    (late.seen.exits(), told > ended),
                    (vec![exit_frame(0, 3)], true)
                );
            });
        }

        #[test]
        fn never_tells_a_view_of_a_respawned_terminal_the_exit_before_the_respawn() {
            runtime().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                h.rt.exits(0);
                h.rt.respawned(1);
                h.print("next").await;
                let late = h.interactive().await;
                h.rt.exits(2);
                settle().await;
                assert_eq!(
                    (
                        first.seen.exits(),
                        late.seen.exits(),
                        h.log.starting("exited")
                    ),
                    (
                        vec![exit_frame(0, 0), exit_frame(1, 2)],
                        vec![exit_frame(1, 2)],
                        vec![
                            format!("exited {} 0", h.terminal),
                            format!("exited {} 1", h.terminal)
                        ]
                    )
                );
            });
        }
    }

    /// The rules a view's snapshot is taken by, so that it is drawn at the size the view is told,
    /// each with a test that fails without it.
    mod snapshot_at_the_size_applied {
        use super::*;

        #[test]
        fn tells_a_view_the_size_applied_not_the_one_it_asked_for_when_a_resize_is_refused() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.rt.refuse_resizes("writer lost");
                let late = h.view(Ask::interactive().at(size(120, 40))).await;
                assert_eq!(
                    (late.seen.geometries(), late.seen.notices()),
                    (
                        vec![geometry(80, 24)],
                        vec![notice("resize failed: writer lost")]
                    )
                );
            });
        }

        #[test]
        fn waits_out_a_resize_in_flight_before_asking_for_a_snapshot() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                let gate = h.rt.hold_resizes();
                let (joined, late) = h.start(Ask::interactive().at(size(120, 40)));
                settle().await;
                let while_resizing = h.rt.asked();
                gate.add_permits(1);
                joined.await.unwrap().unwrap();
                settle().await;
                assert_eq!(
                    (
                        while_resizing,
                        h.rt.asked(),
                        late.geometries().first().cloned()
                    ),
                    (
                        vec!["resize 120x40".to_owned()],
                        vec!["resize 120x40".to_owned(), "snapshot".to_owned()],
                        Some(geometry(120, 40))
                    )
                );
            });
        }

        #[test]
        fn takes_another_snapshot_when_the_size_moves_while_one_is_taken() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.rt.during_snapshot(|t| t.sized_elsewhere(size(100, 30)));
                let late = h.interactive().await;
                assert_eq!(
                    (
                        h.rt.snapshots_asked(),
                        late.seen.geometries().first().cloned()
                    ),
                    (2, Some(geometry(100, 30)))
                );
            });
        }

        #[test]
        fn opens_the_first_view_on_a_fresh_snapshot_once_the_size_moved_since_the_stream_opened() {
            runtime().block_on(async {
                let h = H::new();
                // The stream has applied a new size, and the hub has yet to hear of it.
                h.rt.after_attach(|t| t.size = size(100, 30));
                let first = h.interactive().await;
                assert_eq!(
                    (
                        h.rt.snapshots_asked(),
                        first.seen.geometries().first().cloned()
                    ),
                    (1, Some(geometry(100, 30)))
                );
            });
        }

        #[test]
        fn opens_the_first_view_on_the_snapshot_its_stream_opened_on_asking_for_no_other() {
            runtime().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                assert_eq!(
                    (h.rt.snapshots_asked(), screen_of(&first.seen)),
                    (0, vec!["earlier output".to_owned()])
                );
            });
        }

        #[test]
        fn opens_a_view_on_output_its_stream_delivered_that_the_hub_has_yet_to_take() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                // The snapshot shows it, and the hub has yet to hear of it as the snapshot arrives.
                h.rt.before_snapshot(|t| {
                    let printed = t.print_unheard("just now");
                    t.unheard.push(printed);
                });
                let (mut joined, late) = h.start(Ask::interactive());
                settle().await;
                let early = joined.try_recv();
                let waiting = early.is_err();
                h.rt.tell_unheard();
                let joined = match early {
                    Ok(joined) => joined,
                    Err(_) => joined.await.unwrap(),
                };
                settle().await;
                assert_eq!(
                    (waiting, joined.map(|_| ()), screen_of(&late)),
                    (
                        true,
                        Ok(()),
                        vec!["earlier output".to_owned(), "just now".to_owned()]
                    )
                );
            });
        }
    }
}
