//! At most one stream per viewed terminal, however many views are open, its output fanned out to
//! every view, as `apps/daemon/src/stream/hub.ts` keeps them. The lease decides whose size the
//! terminal takes and whose keystrokes reach it.
//!
//! Each terminal's events are taken by a task of its own, which applies each under the terminal's
//! lock, so a view's output, its geometry and its lease frames go out in one order. A view opens on
//! a snapshot seamed to the output held for it while the snapshot was on its way.
//!
//! Locks are taken in one order: a terminal's, then the watched streams, the parked streams or
//! the snapshots being sent. Each of those three is held only to read or change it, never while
//! another lock is taken, and two terminals' are never held at once.

use std::collections::HashMap;
use std::fmt::{self, Display};
use std::future::Future;
use std::pin::pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bazhen_holder_proto::body::{self, Exited, Size};
use bazhen_protocol::agents;
use bazhen_protocol::events::AttachmentEndReason;
use bazhen_protocol::ids::{AttachmentId, TerminalId};
use bazhen_protocol::input::{has_keystrokes, without_replies};
use bazhen_protocol::stream::{AttachmentMode, EndedReason, Resumes, StreamServerFrame};
use futures_util::future::{Either, select};
use tokio::sync::{OnceCell, watch};
use tokio::task::AbortHandle;
use tokio::time::Instant;
use tokio_util::task::TaskTracker;

use super::lease::{Epoch, Lease};
use super::screen::{Opening, Snapshot};
use super::seam::{Held, Position, RESPAWN_RESET, held_bytes, seam};
use super::view::{Behind, Outbox};

/// A terminal's stream, which every view of it shares.
pub(crate) trait TerminalStream: Send + Sync + 'static {
    type Error: Display + Send + 'static;

    /// The terminal's size, as the stream last knew it applied: what a snapshot taken now is
    /// drawn at. Called under the terminal's lock, so it must not block.
    fn size(&self) -> Size;

    /// Input for the program. Called under the terminal's lock, so it must not block: it hands
    /// the input on to be written.
    fn write(&self, input: &[u8]);

    /// Resolves once the terminal has the size, and the stream's event saying so is queued.
    fn resize(&self, size: Size) -> impl Future<Output = Result<(), Self::Error>> + Send;

    /// Resolves once every event up to where the snapshot was taken is queued.
    fn snapshot(&self) -> impl Future<Output = Result<Snapshot, Self::Error>> + Send;

    /// Ends the stream; its events end with a [`StreamEvent::Closed`]. It hangs up only, and
    /// never ends the terminal or its process: the signal scan passes over the hub's closes of a
    /// stream (`NON_SIGNALLING_CLOSES` in `scripts/check-standards.ts`) on that promise.
    fn close(&self);
}

/// What a terminal's stream tells, in order. They must keep being taken, or the stream stalls.
pub(crate) trait TerminalEvents: Send + 'static {
    fn recv(&mut self) -> impl Future<Output = Option<StreamEvent>> + Send;
}

/// One thing a terminal's stream tells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StreamEvent {
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
pub(crate) enum StreamEnd {
    Ended,
    /// It fell too far behind the terminal's output.
    Behind,
}

/// A stream just opened, with the snapshot it opened on.
#[derive(Debug)]
pub(crate) struct Opened<S, E> {
    pub(crate) snapshot: Snapshot,
    /// The size the snapshot was drawn at. The stream's own may have moved on by the time it
    /// is read.
    pub(crate) size: Size,
    /// How much history above its screen the terminal keeps.
    pub(crate) history_lines: u64,
    pub(crate) stream: S,
    pub(crate) events: E,
}

/// Where the hub opens terminals' streams.
pub(crate) trait Runtime: Send + Sync + 'static {
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
pub(crate) trait AttachmentLog: Send + Sync + 'static {
    type Error: Display + Send + 'static;

    fn started(&self, attachment: &AttachmentId, terminal: &TerminalId, mode: AttachmentMode);

    fn ended(&self, attachment: &AttachmentId, reason: AttachmentEndReason);

    fn granted(&self, terminal: &TerminalId, attachment: &AttachmentId, epoch: Epoch);

    /// The epoch of the terminal's last grant, so a new one is always higher.
    ///
    /// # Errors
    ///
    /// When it can't be read; the terminal isn't opened.
    fn epoch(
        &self,
        terminal: &TerminalId,
    ) -> impl Future<Output = Result<Epoch, Self::Error>> + Send;

    /// Whether the terminal is being closed, so its stream's end ends views as closed.
    fn closing(&self, terminal: &TerminalId) -> impl Future<Output = bool> + Send;

    /// Its process exited, as its stream told: recorded before any view is told, to act on.
    fn exited(
        &self,
        terminal: &TerminalId,
        exit: &Exited,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

/// One view of a terminal, as it asks to open.
#[derive(Debug)]
pub(crate) struct Viewer {
    pub(crate) mode: AttachmentMode,
    /// The name of the paired device the view is on, if it is on one.
    pub(crate) device_name: Option<String>,
    pub(crate) outbox: Outbox,
}

/// Who input comes from. Every write passes the lease, the filter and the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Writer {
    View(AttachmentId),
}

/// Why a view's own side ended: it closed, or its socket stopped answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LeaveReason {
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
pub(crate) struct Attachment {
    pub(crate) id: AttachmentId,
    pub(crate) resume_token: String,
}

/// Why a view didn't open.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum JoinError {
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

/// How far the hub lets views fall behind, how many it serves, and how long it keeps a stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HubOptions {
    /// A view this far behind its terminal's output is ended, never sent a stream with a hole.
    pub(crate) max_unsent_bytes: usize,
    /// The most views a terminal may have; one more is turned away.
    pub(crate) max_views: usize,
    /// The most snapshot bytes not yet written to their views, across every terminal. Over it,
    /// views whose snapshots have stalled are ended to make room, and failing that the view that
    /// opens is turned away. It can be passed for a while: a snapshot that opens while none is
    /// being sent is taken whatever its size, and one let in on the room stalled views would free
    /// stays in if one of them is spared, its snapshot having moved on since it was chosen.
    pub(crate) max_snapshot_bytes: usize,
    /// A snapshot goes to its view a piece of this many bytes at a time, each once the last is
    /// written.
    pub(crate) snapshot_chunk_bytes: usize,
    /// A view whose snapshot has had nothing written for this long has stalled.
    pub(crate) snapshot_stall: Duration,
    /// How long a stream outlives its last view, unless another stream of its terminal sends
    /// output first.
    pub(crate) linger: Duration,
}

impl Default for HubOptions {
    fn default() -> Self {
        Self {
            max_unsent_bytes: 4 << 20,
            max_views: 16,
            // Three of the largest snapshot a 200-column terminal can have. Taking a snapshot
            // briefly needs several times its size again, uncounted here; only one is taken at
            // a time.
            max_snapshot_bytes: 200 << 20,
            snapshot_chunk_bytes: 1 << 20,
            // A link slower than about 100 KB/s.
            snapshot_stall: Duration::from_secs(10),
            // Codex 0.166 can drop a prompt it has just taken if its client detaches within
            // milliseconds of the Enter, as it does when the person closes the last view straight
            // after pressing it. It sends a prompt on within a few hundred ms even under load.
            linger: Duration::from_secs(2),
        }
    }
}

/// Every viewed terminal's stream and views.
///
/// A stream whose last view has left is parked, not closed: it stays for [`HubOptions::linger`],
/// or until another stream of its terminal first sends output, whichever comes first. A view that
/// opens meanwhile gets a stream of its own. So a stream that has sent output is never closed in
/// favour of one that hasn't yet, and the program is not left without a working stream the moment
/// a view closes.
pub(crate) struct Hub<R: Runtime, L> {
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
    /// Streams whose last view has left, by terminal, oldest first.
    parked: Mutex<HashMap<TerminalId, Vec<Parked<R::Stream>>>>,
    /// Views whose snapshots are still being written to them, across every terminal, oldest
    /// first.
    loading: Mutex<Vec<Loading<R::Stream>>>,
}

/// A stream whose last view has left, and the timer that closes it.
struct Parked<S> {
    watched: Arc<Watched<S>>,
    timer: AbortHandle,
}

/// A view whose snapshot is still being written to its socket.
struct Loading<S> {
    id: AttachmentId,
    watched: Arc<Watched<S>>,
    /// The snapshot's size: all of it is held until the last of it is written.
    bytes: usize,
    /// When a piece of it was last written, or it began.
    since: Instant,
}

/// A view chosen to end for its stalled snapshot, as it was when chosen.
struct Stalled<S> {
    watched: Arc<Watched<S>>,
    id: AttachmentId,
    since: Instant,
}

/// How opening a terminal's stream went; joins that come while it opens wait for the one opening
/// it, and are told the same.
struct Slot<S> {
    opened: OnceCell<Result<Arc<Watched<S>>, JoinError>>,
}

impl<S> Default for Slot<S> {
    fn default() -> Self {
        Self {
            opened: OnceCell::new(),
        }
    }
}

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
    /// Whether the stream has sent output, which shows it works.
    sent_output: bool,
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
    /// How many bytes of output are held.
    held: usize,
    /// What of the snapshot may still be in the socket's queue, which the view may lag by on top
    /// of [`HubOptions::max_unsent_bytes`]: a large history alone must not end the view. That is
    /// the one piece on its way, if any.
    snapshot_bytes: usize,
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

/// A view whose join hasn't finished. A join dropped part way, as when its socket goes, ends the
/// view as its leaving would: nothing else knows of it, its held output would grow for good, and
/// its stream would never close.
struct Joining<R: Runtime, L: AttachmentLog> {
    hub: Arc<Shared<R, L>>,
    watched: Arc<Watched<R::Stream>>,
    id: AttachmentId,
    done: bool,
}

impl<R: Runtime, L: AttachmentLog> Drop for Joining<R, L> {
    fn drop(&mut self) {
        if !self.done {
            let mut state = self.watched.lock();
            self.hub.end(
                &self.watched,
                &mut state,
                &self.id,
                AttachmentEndReason::ClientClosed,
            );
        }
    }
}

/// Why taking a view's snapshot stopped.
enum Taking {
    Gone,
    Failed(String),
}

impl<R: Runtime, L: AttachmentLog> Hub<R, L> {
    /// The hub's tasks run on `tasks`.
    pub(crate) fn new(runtime: R, log: L, options: HubOptions, tasks: TaskTracker) -> Self {
        Self {
            shared: Arc::new(Shared {
                runtime,
                log,
                options,
                tasks,
                watched: Mutex::new(HashMap::new()),
                parked: Mutex::new(HashMap::new()),
                loading: Mutex::new(Vec::new()),
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
    pub(crate) async fn join(
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
    pub(crate) fn write(&self, terminal: &TerminalId, writer: &Writer, input: &[u8]) {
        self.shared.write(terminal, writer, input);
    }

    /// The person engaged the view: an interactive one takes the lease.
    pub(crate) fn engage(&self, terminal: &TerminalId, attachment: &AttachmentId) {
        self.shared.on(terminal, |hub, watched, state| {
            hub.engage(watched, state, attachment);
        });
    }

    /// The epoch the view's following input is typed under.
    pub(crate) fn declare_epoch(
        &self,
        terminal: &TerminalId,
        attachment: &AttachmentId,
        epoch: u64,
    ) {
        self.shared.on(terminal, |_, _, state| {
            if let Some(view) = state.view_mut(attachment) {
                view.declared = Some(Epoch::new(epoch));
            }
        });
    }

    /// The view's window is `size`; the terminal takes it if the view sets its size.
    pub(crate) fn resize(&self, terminal: &TerminalId, attachment: &AttachmentId, size: Size) {
        self.shared.on(terminal, |hub, watched, state| {
            if let Some(view) = state.view_mut(attachment) {
                view.size = size;
                hub.fit_to(watched, state, None);
            }
        });
    }

    /// The view's own side ended.
    pub(crate) fn leave(
        &self,
        terminal: &TerminalId,
        attachment: &AttachmentId,
        reason: LeaveReason,
    ) {
        self.shared.on(terminal, |hub, watched, state| {
            hub.end(watched, state, attachment, reason.into());
        });
    }

    /// Closes every stream, parked or still viewed, as the daemon stops: a parked one doesn't
    /// wait out its linger, and each view still open ends as its stream does.
    pub(crate) fn close(&self) {
        let parked: Vec<_> = lock(&self.shared.parked)
            .drain()
            .flat_map(|(_, streams)| streams)
            .collect();
        for found in parked {
            found.timer.abort();
            found.watched.stream.close();
        }
        let watched: Vec<_> = lock(&self.shared.watched)
            .values()
            .filter_map(|slot| slot.opened.get()?.as_ref().ok().cloned())
            .collect();
        for watched in watched {
            watched.stream.close();
        }
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
            if state.views.len() - usize::from(replacing.is_some()) >= self.options.max_views {
                drop(state);
                self.log.started(&id, terminal, mode);
                self.log.ended(&id, AttachmentEndReason::AttachFailed);
                return Err(JoinError::Refused(format!(
                    "this terminal already has {} views open",
                    self.options.max_views
                )));
            }
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
                held: 0,
                snapshot_bytes: 0,
                told_dropped: false,
            });
            if !opened {
                self.fit_to(&watched, &mut state, replacing.as_ref());
            }
            (from, exited, replacing)
        };
        let mut joining = Joining {
            hub: Arc::clone(self),
            watched: Arc::clone(&watched),
            id: id.clone(),
            done: false,
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
        self.begin(&watched, &id, seamed, shown.vt().len(), replacing.as_ref())
            .await?;
        self.send_snapshot(&watched, &id, shown.vt()).await?;
        let mut state = watched.lock();
        let Some(view) = state.view_mut(&id) else {
            return Err(JoinError::Ended);
        };
        view.outbox.notify(StreamServerFrame::SnapshotEnd);
        let rest = view.queue.take().unwrap_or_default();
        view.held = 0;
        if rest.iter().any(|item| pass(&view.outbox, item).is_err()) {
            self.evict(&watched, &mut state, &id);
            return Err(JoinError::Ended);
        }
        // Last: a view may send input and engage as soon as it is told.
        view.outbox.notify(StreamServerFrame::Attached {
            attachment_id: id.clone(),
            resume_token: Some(resume_token.clone()),
        });
        joining.done = true;
        Ok(Attachment { id, resume_token })
    }

    /// Cuts what was held for the view where its snapshot ends, makes room for the snapshot's
    /// `bytes`, ends the attachment it replaces, and tells it the snapshot starts.
    async fn begin(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        id: &AttachmentId,
        seamed: Seamed,
        bytes: usize,
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
        // What the snapshot covers is never sent, so it neither stays held nor counts against
        // the view.
        view.held = rest.iter().map(held_bytes).sum();
        view.queue = Some(rest);
        drop(state);
        if !self.make_room(watched, id, bytes) {
            self.end(
                watched,
                &mut watched.lock(),
                id,
                AttachmentEndReason::AttachFailed,
            );
            return Err(JoinError::Refused(
                "too many views are still loading their screens; reopen this terminal in a moment"
                    .to_owned(),
            ));
        }
        let mut state = watched.lock();
        if state.view(id).is_none() {
            self.unload(id);
            return Err(JoinError::Ended);
        }
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
        // Every join waiting on an open shares its outcome, as the TypeScript hub's shared
        // promise does: one that failed fails them all, and the slot is forgotten so the next
        // join opens afresh. A waiter that opened again itself would hold a stream no longer in
        // the map, which nothing could reach or close.
        let watched = slot
            .opened
            .get_or_init(|| {
                opened = true;
                self.open(terminal, size)
            })
            .await
            .clone();
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
        let epoch = self.log.epoch(terminal).await.map_err(|err| {
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
                sent_output: false,
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
            if let StreamEvent::Closed(end) = event {
                // Read before the terminal's lock is taken: it may wait on the store.
                let closing = self.log.closing(&watched.terminal).await;
                self.closed(watched, &mut watched.lock(), end, closing);
                watched.moved();
                return;
            }
            self.apply(watched, event);
            watched.moved();
        }
    }

    fn apply(self: &Arc<Self>, watched: &Arc<Watched<R::Stream>>, event: StreamEvent) {
        let mut state = watched.lock();
        let mut first_output = false;
        match event {
            StreamEvent::Data { at, output } => {
                first_output = !std::mem::replace(&mut state.sent_output, true);
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
            // Taken by `take_events`, which reads whether the terminal is closing first.
            StreamEvent::Closed(end) => self.closed(watched, &mut state, end, false),
        }
        drop(state);
        // Its first output shows the stream works; the parked ones before it may go. It may be
        // parked itself, if its last view left before it sent anything, and stays parked.
        if first_output {
            self.release_all_but(watched);
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

    /// Passes `item` to every view, or holds it for one whose snapshot is on its way, and ends
    /// each view that is then too far behind.
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
                view.held += held_bytes(item);
            } else if pass(&view.outbox, item).is_err() {
                behind.push(view.id.clone());
                continue;
            }
            let lags_by = (view.outbox.unsent() + view.held).saturating_sub(view.snapshot_bytes);
            if lags_by > self.options.max_unsent_bytes {
                behind.push(view.id.clone());
            }
        }
        for id in &behind {
            self.evict(watched, state, id);
        }
    }

    /// The stream closed: every view's stream ends with it, as closed if its terminal is
    /// `closing`.
    fn closed(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        state: &mut State,
        end: StreamEnd,
        closing: bool,
    ) {
        // The stream also ends when the holder is lost while the terminal lives on.
        let reason = if closing {
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
        if let Some(parked) = self.unpark(watched) {
            parked.timer.abort();
        }
        for view in state.views.drain(..) {
            self.unload(&view.id);
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
        for piece in shown.chunks(self.options.snapshot_chunk_bytes.max(1)) {
            let written = {
                let mut state = watched.lock();
                let Some(view) = state.view_mut(id) else {
                    return Err(JoinError::Ended);
                };
                view.snapshot_bytes = piece.len();
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
            // Under the terminal's lock, so a view ending for a stalled snapshot is seen to
            // have moved on, or ends before it does.
            let mut state = watched.lock();
            if let Some(view) = state.view_mut(id) {
                view.snapshot_bytes = 0;
            }
            if let Some(loading) = lock(&self.loading).iter_mut().find(|l| &l.id == id) {
                loading.since = Instant::now();
            }
            drop(state);
        }
        self.unload(id);
        Ok(())
    }

    /// Whether a snapshot of `bytes` may be sent to `id` now; if it may, it counts as held from
    /// now until the last of it is written. Over the cap, views whose snapshots have stalled are
    /// ended, oldest first, until it fits, and none are ended if that would not make room; a view
    /// still reading its own is never ended for it. A snapshot is never refused while no other is
    /// being sent, however large it is.
    fn make_room(
        self: &Arc<Self>,
        watched: &Arc<Watched<R::Stream>>,
        id: &AttachmentId,
        bytes: usize,
    ) -> bool {
        let Some(stalled) = self.admit(watched, id, bytes) else {
            return false;
        };
        self.end_stalled(stalled);
        true
    }

    /// Counts a snapshot of `bytes` for `id` as being sent if it fits, or would once the views
    /// it returns, whose snapshots have stalled, are ended; `None` if it would not.
    fn admit(
        &self,
        watched: &Arc<Watched<R::Stream>>,
        id: &AttachmentId,
        bytes: usize,
    ) -> Option<Vec<Stalled<R::Stream>>> {
        let now = Instant::now();
        let fits = |held: usize| {
            held == 0 || held.saturating_add(bytes) <= self.options.max_snapshot_bytes
        };
        let mut loading = lock(&self.loading);
        let mut pending = 0;
        let mut freeable = 0;
        let mut stalled = vec![];
        for l in loading.iter() {
            pending += l.bytes;
            if now.saturating_duration_since(l.since) < self.options.snapshot_stall {
                continue;
            }
            freeable += l.bytes;
            stalled.push(l);
        }
        if !fits(pending - freeable) {
            return None;
        }
        let mut ending = vec![];
        for l in stalled {
            if fits(pending) {
                break;
            }
            pending -= l.bytes;
            ending.push(Stalled {
                watched: Arc::clone(&l.watched),
                id: l.id.clone(),
                since: l.since,
            });
        }
        loading.push(Loading {
            id: id.clone(),
            watched: Arc::clone(watched),
            bytes,
            since: now,
        });
        Some(ending)
    }

    /// Ends each view chosen for its stalled snapshot, under its terminal's lock, unless it has
    /// moved on since: written a piece, or the last of it, in the meantime. A view is told it is
    /// attached, and has a piece counted written, only under that lock.
    fn end_stalled(self: &Arc<Self>, stalled: Vec<Stalled<R::Stream>>) {
        for chosen in stalled {
            let mut state = chosen.watched.lock();
            let still = lock(&self.loading)
                .iter()
                .any(|l| l.id == chosen.id && l.since == chosen.since);
            if still {
                self.evict(&chosen.watched, &mut state, &chosen.id);
            }
        }
    }

    /// The view's snapshot is no longer being sent.
    fn unload(&self, id: &AttachmentId) {
        lock(&self.loading).retain(|l| &l.id != id);
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
        self.unload(id);
        self.log.ended(id, reason);
        let was_driver = state.lease.holder() == Some(id);
        state.lease = state.lease.release(id);
        watched.moved();
        if state.views.is_empty() {
            state.closed = true;
            self.forget_watched(watched);
            self.park(watched);
            return;
        }
        if was_driver {
            announce_lease(state);
        }
        self.fit_to(watched, state, None);
    }

    /// Keeps a stream whose last view has left until [`HubOptions::linger`] has passed.
    fn park(self: &Arc<Self>, watched: &Arc<Watched<R::Stream>>) {
        // Held while the timer starts, so it can't come due before it is parked.
        let mut parked = lock(&self.parked);
        let hub = Arc::clone(self);
        let lingering = Arc::clone(watched);
        // From now, not from when the timer first runs.
        let due = Instant::now() + self.options.linger;
        let timer = self
            .tasks
            .spawn(async move {
                tokio::time::sleep_until(due).await;
                hub.release(&lingering);
            })
            .abort_handle();
        parked
            .entry(watched.terminal.clone())
            .or_default()
            .push(Parked {
                watched: Arc::clone(watched),
                timer,
            });
    }

    /// Takes `watched` out of its terminal's parked streams, if it is one.
    fn unpark(&self, watched: &Arc<Watched<R::Stream>>) -> Option<Parked<R::Stream>> {
        let mut parked = lock(&self.parked);
        let streams = parked.get_mut(&watched.terminal)?;
        let index = streams
            .iter()
            .position(|p| Arc::ptr_eq(&p.watched, watched))?;
        let found = streams.remove(index);
        if streams.is_empty() {
            parked.remove(&watched.terminal);
        }
        Some(found)
    }

    /// Closes a parked stream.
    fn release(&self, watched: &Arc<Watched<R::Stream>>) {
        if let Some(found) = self.unpark(watched) {
            found.timer.abort();
            found.watched.stream.close();
        }
    }

    /// Closes every parked stream of `kept`'s terminal but `kept`.
    fn release_all_but(&self, kept: &Arc<Watched<R::Stream>>) {
        let others: Vec<_> = lock(&self.parked)
            .get(&kept.terminal)
            .into_iter()
            .flatten()
            .filter(|p| !Arc::ptr_eq(&p.watched, kept))
            .map(|p| Arc::clone(&p.watched))
            .collect();
        for other in &others {
            self.release(other);
        }
    }

    /// Runs `act` on the terminal's state, if it is watched.
    fn on(
        self: &Arc<Self>,
        terminal: &TerminalId,
        act: impl FnOnce(&Arc<Self>, &Arc<Watched<R::Stream>>, &mut State),
    ) {
        let slot = lock(&self.watched).get(terminal).cloned();
        if let Some(Ok(watched)) = slot.as_ref().and_then(|slot| slot.opened.get()) {
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
            .and_then(|slot| slot.opened.get())
            .is_some_and(|w| w.as_ref().is_ok_and(|w| Arc::ptr_eq(w, watched)));
        if current {
            map.remove(&watched.terminal);
        }
    }
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
pub(crate) mod tests {
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
    use crate::testing::{paused, runtime};

    /// What a view is told when every snapshot being sent is still being read.
    const STILL_LOADING: &str =
        "too many views are still loading their screens; reopen this terminal in a moment";

    pub(crate) fn size(cols: u64, rows: u64) -> Size {
        Size {
            cols: Cols::new(cols).unwrap(),
            rows: Rows::new(rows).unwrap(),
        }
    }

    pub(crate) fn standard() -> Size {
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
        /// Why snapshots asked for fail, when they do.
        snapshot_fails: Option<String>,
        /// How far from where the stream is a snapshot asked for says it was taken.
        skew: i64,
        /// The runtime's other terminals.
        others: Vec<(TerminalId, Fake)>,
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

        /// Every stream on it closes as too far behind its output, and their snapshots fail.
        fn fall_behind(&mut self) {
            self.tell(&StreamEvent::Closed(StreamEnd::Behind));
            self.clients.clear();
            self.held.clear();
        }
    }

    /// A runtime with one terminal, whose program echoes nothing.
    #[derive(Clone)]
    pub(crate) struct Fake(Arc<Mutex<Terminal>>);

    impl Fake {
        pub(crate) fn new(history: &str, history_lines: u64) -> Self {
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
                snapshot_fails: None,
                skew: 0,
                others: Vec::new(),
            })))
        }

        /// Another terminal on the same runtime, named `terminal`, with `history` above its screen.
        fn another(&self, terminal: &TerminalId, history: &str) -> Self {
            let other = Self::new(history, 10_000);
            self.terminal()
                .others
                .push((terminal.clone(), other.clone()));
            other
        }

        fn falls_behind(&self) {
            self.terminal().fall_behind();
        }

        fn fail_snapshots(&self, why: &str) {
            self.terminal().snapshot_fails = Some(why.to_owned());
        }

        /// Snapshots asked for from now on say they were taken `by` bytes from where they were.
        fn skew_snapshots(&self, by: i64) {
            self.terminal().skew = by;
        }

        /// How long a view's snapshot of the terminal is now.
        fn snapshot_len(&self) -> usize {
            self.terminal().snapshot_now().vt().len()
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

        pub(crate) fn vanish(&self) {
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

        pub(crate) fn written(&self) -> Vec<String> {
            self.terminal().written.clone()
        }

        pub(crate) fn resizes(&self) -> Vec<Size> {
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

    pub(crate) struct FakeStream {
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
                if let Some(why) = &t.snapshot_fails {
                    return Err(why.clone());
                }
                if let Some(hook) = t.before_snapshot.take() {
                    hook(&mut t);
                }
                let now = t.snapshot_now();
                let now = Snapshot::new(
                    now.vt().to_vec(),
                    Position {
                        generation: now.at().generation,
                        offset: now.at().offset.checked_add_signed(t.skew).unwrap(),
                    },
                );
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

    pub(crate) struct FakeEvents(mpsc::UnboundedReceiver<StreamEvent>);

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
            terminal: &TerminalId,
            at: Option<Size>,
        ) -> impl Future<Output = Result<Opened<FakeStream, FakeEvents>, String>> + Send {
            let other = self
                .terminal()
                .others
                .iter()
                .find(|(id, _)| id == terminal)
                .map(|(_, other)| other.clone());
            std::future::ready(Ok(other.unwrap_or_else(|| self.clone()).opened(at)))
        }
    }

    impl Fake {
        /// A stream opened on this terminal.
        fn opened(&self, at: Option<Size>) -> Opened<FakeStream, FakeEvents> {
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
            Opened {
                snapshot,
                size: drawn_at,
                history_lines: t.history_lines,
                stream: FakeStream {
                    terminal: self.clone(),
                    client,
                },
                events: FakeEvents(rx),
            }
        }
    }

    #[derive(Default)]
    pub(crate) struct Book {
        events: Vec<String>,
        closing: bool,
        refuse_exits: Option<String>,
        /// What else to note as an exit is recorded, once its recording has given every task a
        /// chance to run.
        as_exit_recorded: Option<Box<dyn Fn() -> String + Send>>,
    }

    /// What the hub records, as lines.
    #[derive(Clone, Default)]
    pub(crate) struct Log(Arc<Mutex<Book>>);

    impl Log {
        fn push(&self, event: String) {
            self.0.lock().unwrap().events.push(event);
        }

        pub(crate) fn events(&self) -> Vec<String> {
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

        fn epoch(&self, _: &TerminalId) -> impl Future<Output = Result<Epoch, String>> + Send {
            std::future::ready(Ok(Epoch::new(4)))
        }

        fn closing(&self, _: &TerminalId) -> impl Future<Output = bool> + Send {
            std::future::ready(self.0.lock().unwrap().closing)
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
        /// Sends of output begun and not yet finished.
        in_flight: usize,
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

        fn in_flight(&self) -> usize {
            self.record().in_flight
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
        /// Each send of output waits for a permit from this, when it is set, and fails once it is
        /// closed, as a socket that has gone does.
        stalls: Option<Arc<Semaphore>>,
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

        async fn output(&mut self, output: Vec<u8>) -> Result<(), ()> {
            if let Some(gate) = &self.stalls {
                self.seen.record().in_flight += 1;
                let permit = gate.acquire().await;
                self.seen.record().in_flight -= 1;
                permit.map_err(|_| ())?.forget();
            }
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
            Ok(())
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
        /// The most output it may have unsent.
        most_unsent: usize,
        stalls: Option<Arc<Semaphore>>,
        /// The terminal it opens, when not the test's own.
        terminal: Option<TerminalId>,
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
                most_unsent: MOST_UNSENT,
                stalls: None,
                terminal: None,
            }
        }

        fn of(self, terminal: &TerminalId) -> Self {
            Self {
                terminal: Some(terminal.clone()),
                ..self
            }
        }

        /// Its socket sends output only with a permit from `gate`.
        fn stalling(self, gate: &Arc<Semaphore>) -> Self {
            Self {
                stalls: Some(Arc::clone(gate)),
                ..self
            }
        }

        fn lagging_by(self, most_unsent: usize) -> Self {
            Self {
                most_unsent,
                ..self
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
            Self::with_options(rt, HubOptions::default())
        }

        fn with_options(rt: Fake, options: HubOptions) -> Self {
            let log = Log::default();
            let tasks = TaskTracker::new();
            let hub = Hub::new(rt.clone(), log.clone(), options, tasks.clone());
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
            let (_, joined, seen) = self.joining(ask);
            (joined, seen)
        }

        /// Starts a view opening, and returns the task that opens it too.
        fn joining(
            &self,
            ask: Ask,
        ) -> (
            tokio::task::JoinHandle<()>,
            oneshot::Receiver<Result<Attachment, JoinError>>,
            Seen,
        ) {
            let (outbox, inbox) = view::queue(ask.most_unsent);
            let seen = Seen::default();
            let terminal = ask.terminal.unwrap_or_else(|| self.terminal.clone());
            let mut socket = Recorder {
                seen: seen.clone(),
                declares: ask.declares.then(|| (self.hub.clone(), terminal.clone())),
                epoch: 0,
                id: None,
                on_output: ask.on_output,
                stalls: ask.stalls,
            };
            self.tasks.spawn(async move {
                let _ = write_to(inbox, &mut socket).await;
                socket.seen.record().closed = true;
            });
            let (answer, joined) = oneshot::channel();
            let hub = self.hub.clone();
            let viewer = Viewer {
                mode: ask.mode,
                device_name: ask.device_name,
                outbox,
            };
            let (at, resumes) = (ask.size, ask.resumes);
            let join = self.tasks.spawn(async move {
                let _ = answer.send(hub.join(&terminal, viewer, at, resumes).await);
            });
            (join, joined, seen)
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

        /// Starts an observer opening whose socket writes output only as the test lets it, as a
        /// slow reader's does, and waits until the first piece of its snapshot is on its way.
        async fn loading(&self, ask: Ask) -> Slow {
            let gate = Arc::new(Semaphore::new(0));
            let (joined, seen) = self.start(ask.stalling(&gate));
            settle().await;
            assert_eq!(
                seen.in_flight(),
                1,
                "the first piece of its snapshot is on its way"
            );
            Slow { gate, joined, seen }
        }

        /// A clock as the hub reads it, moved on by `ms`, and every task that can run then, run.
        async fn later(&self, ms: u64) {
            tokio::time::advance(Duration::from_millis(ms)).await;
            settle().await;
        }
    }

    /// A view opening whose socket writes its output only as the test lets it.
    struct Slow {
        gate: Arc<Semaphore>,
        joined: oneshot::Receiver<Result<Attachment, JoinError>>,
        seen: Seen,
    }

    impl Slow {
        /// Writes the piece of output on its way.
        async fn write(&self) {
            self.gate.add_permits(1);
            settle().await;
        }

        /// Writes everything it was sent, and goes on writing as fast as it is sent more.
        async fn catch_up(&self) {
            self.gate.add_permits(Semaphore::MAX_PERMITS >> 1);
            settle().await;
        }

        /// Its socket goes, which settles every send it had.
        async fn disconnect(&self) {
            self.gate.close();
            settle().await;
        }
    }

    /// Hub options as the tests of room for views use them: snapshots go 100 bytes at a time,
    /// and stall after a second.
    fn room() -> HubOptions {
        HubOptions {
            snapshot_chunk_bytes: 100,
            snapshot_stall: Duration::from_secs(1),
            ..HubOptions::default()
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

    /// How many views have been ended as too far behind.
    fn evicted(log: &Log) -> usize {
        log.events()
            .iter()
            .filter(|e| e.ends_with(" evicted_slow"))
            .count()
    }

    fn attach_failed(log: &Log) -> usize {
        log.events()
            .iter()
            .filter(|e| e.ends_with(" attach_failed"))
            .count()
    }

    fn refused(message: &str) -> Result<(), JoinError> {
        Err(JoinError::Refused(message.to_owned()))
    }

    fn ended_slow() -> StreamServerFrame {
        StreamServerFrame::Ended {
            reason: EndedReason::EvictedSlow,
        }
    }

    /// The fake's runtime, whose first open fails once every task that can run has run.
    #[derive(Clone)]
    struct Flaky {
        inner: Fake,
        fails: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Runtime for Flaky {
        type Stream = FakeStream;
        type Events = FakeEvents;
        type Error = String;

        async fn attach(
            &self,
            terminal: &TerminalId,
            at: Option<Size>,
        ) -> Result<Opened<FakeStream, FakeEvents>, String> {
            yields(8).await;
            if self.fails.swap(false, std::sync::atomic::Ordering::SeqCst) {
                return Err("the holder went away".to_owned());
            }
            self.inner.attach(terminal, at).await
        }
    }

    /// An interactive view whose socket writes whatever it is sent, for a hub of any runtime.
    fn viewer(tasks: &TaskTracker) -> Viewer {
        let (outbox, inbox) = view::queue(MOST_UNSENT);
        let mut socket = Recorder {
            seen: Seen::default(),
            declares: None,
            epoch: 0,
            id: None,
            on_output: None,
            stalls: None,
        };
        tasks.spawn(async move {
            let _ = write_to(inbox, &mut socket).await;
        });
        Viewer {
            mode: AttachmentMode::Interactive,
            device_name: None,
            outbox,
        }
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
        fn closes_the_stream_once_the_last_view_has_been_gone_a_moment_and_only_then() {
            paused().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                let b = h.interactive().await;
                h.leave(&a).await;
                h.leave(&b).await;
                let ended = h.log.events().last().cloned();
                h.later(1999).await;
                let meanwhile = h.rt.closes();
                h.later(1).await;
                assert_eq!(
                    (ended, meanwhile, h.rt.closes()),
                    (Some(format!("ended {} client_closed", b.id)), 0, 1)
                );
            });
        }

        #[test]
        fn gives_a_view_that_comes_back_meanwhile_a_stream_of_its_own_and_lets_the_old_one_go_once_it_sends_output()
         {
            paused().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                h.leave(&first).await;
                let back = h.interactive().await;
                let counts = || (h.rt.attaches().len(), h.rt.closes());
                let before_it_sent = counts();
                h.print("out").await;
                let once = counts();
                h.later(2000).await;
                assert_eq!(
                    (before_it_sent, once, counts(), back.seen.last_output()),
                    ((2, 0), (2, 1), (2, 1), Some("out".to_owned()))
                );
            });
        }

        #[test]
        fn keeps_a_stream_that_sent_output_while_a_view_whose_stream_sent_none_comes_and_goes() {
            paused().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                h.print("drawn").await;
                h.leave(&first).await;
                let second = h.interactive().await;
                h.leave(&second).await;
                let counts = || (h.rt.attaches().len(), h.rt.closes());
                let both_parked = counts();
                h.print("the second one's first output").await;
                let second_sent = counts();
                h.later(2000).await;
                assert_eq!(
                    (both_parked, second_sent, counts()),
                    ((2, 0), (2, 1), (2, 2))
                );
            });
        }

        #[test]
        fn leaves_nothing_to_close_when_its_terminal_goes_while_the_stream_lingers() {
            paused().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                h.leave(&first).await;
                h.rt.vanish();
                settle().await;
                let tasks = h.tasks.len();
                h.later(2000).await;
                assert_eq!((tasks, h.rt.closes()), (0, 0));
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
        #[test]
        fn gives_every_join_waiting_on_an_open_that_fails_its_failure_and_opens_afresh_after() {
            paused().block_on(async {
                let rt = Fake::new("earlier output", 100);
                let flaky = Flaky {
                    inner: rt.clone(),
                    fails: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                };
                let tasks = TaskTracker::new();
                let hub = Hub::new(flaky, Log::default(), HubOptions::default(), tasks.clone());
                let terminal = TerminalId::mint(1, [7; 16]);
                let joins: Vec<_> = (0..2)
                    .map(|_| {
                        let (hub, terminal, viewer) =
                            (hub.clone(), terminal.clone(), viewer(&tasks));
                        tasks.spawn(
                            async move { hub.join(&terminal, viewer, standard(), None).await },
                        )
                    })
                    .collect();
                let mut joined = vec![];
                for join in joins {
                    joined.push(join.await.unwrap().map(|a| a.id));
                }
                let next = hub
                    .join(&terminal, viewer(&tasks), standard(), None)
                    .await
                    .unwrap();
                settle().await;
                hub.leave(&terminal, &next.id, LeaveReason::ClientClosed);
                tokio::time::advance(HubOptions::default().linger).await;
                settle().await;
                let failed = Err(JoinError::Open("the holder went away".to_owned()));
                assert_eq!(
                    (joined, rt.attaches().len(), rt.closes()),
                    (vec![failed.clone(), failed], 1, 1)
                );
            });
        }

        #[test]
        fn ends_a_view_whose_join_is_dropped_while_its_snapshot_is_on_its_way() {
            paused().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                h.rt.hold_snapshots();
                let (join, _, late) = h.joining(Ask::interactive());
                settle().await;
                join.abort();
                settle().await;
                h.rt.release();
                h.leave(&first).await;
                h.later(2000).await;
                assert_eq!(
                    (late.closed(), h.log.starting("ended").len(), h.rt.closes()),
                    (true, 2, 1)
                );
            });
        }

        #[test]
        fn closes_the_stream_when_the_join_of_its_only_view_is_dropped() {
            paused().block_on(async {
                let h = H::new();
                let gate = Arc::new(Semaphore::new(0));
                let (join, _, _) = h.joining(Ask::interactive().stalling(&gate));
                settle().await;
                join.abort();
                settle().await;
                h.later(2000).await;
                assert_eq!((h.log.starting("ended").len(), h.rt.closes()), (1, 1));
            });
        }

        #[test]
        fn ends_a_view_too_far_behind_its_live_output_and_tells_it_why() {
            runtime().block_on(async {
                let h = H::new();
                let other = h.interactive().await;
                // Its screen goes out; the output after it waits.
                let gate = Arc::new(Semaphore::new(1));
                let slow = h
                    .view(Ask::observer().lagging_by(400).stalling(&gate))
                    .await;
                h.print(&"a".repeat(250)).await;
                h.print(&"b".repeat(250)).await;
                gate.add_permits(8);
                settle().await;
                assert_eq!(
                    (
                        slow.seen.last_frame(),
                        slow.seen.closed(),
                        h.log.events().last().cloned(),
                        other.seen.last_output()
                    ),
                    (
                        Some(StreamServerFrame::Ended {
                            reason: EndedReason::EvictedSlow
                        }),
                        true,
                        Some(format!("ended {} evicted_slow", slow.id)),
                        Some("b".repeat(250))
                    )
                );
            });
        }

        #[test]
        fn ends_a_view_whose_output_held_while_it_opened_is_more_than_it_may_lag_by() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.rt.hold_snapshots();
                let (joined, late) = h.start(Ask::observer().lagging_by(512));
                settle().await;
                h.rt.take();
                for _ in 0..3 {
                    h.print(&"x".repeat(200)).await;
                }
                h.rt.release();
                let joined = joined.await.unwrap();
                settle().await;
                assert_eq!(
                    (
                        joined,
                        late.attached(),
                        late.last_frame(),
                        h.log.events().last().map(|e| e.ends_with(" evicted_slow"))
                    ),
                    (
                        Err(JoinError::Ended),
                        false,
                        Some(StreamServerFrame::Ended {
                            reason: EndedReason::EvictedSlow
                        }),
                        Some(true)
                    )
                );
            });
        }

        #[test]
        fn ends_a_view_whose_screen_is_more_than_it_may_lag_by() {
            runtime().block_on(async {
                let h = H::new();
                let (joined, late) = h.open(Ask::observer().lagging_by(16)).await;
                assert_eq!(
                    (
                        joined,
                        late.attached(),
                        late.last_frame(),
                        h.log.events().last().map(|e| e.ends_with(" evicted_slow"))
                    ),
                    (
                        Err(JoinError::Ended),
                        false,
                        Some(StreamServerFrame::Ended {
                            reason: EndedReason::EvictedSlow
                        }),
                        Some(true)
                    )
                );
            });
        }

        #[test]
        fn sizes_the_terminal_to_a_driver_that_comes_back_at_another_size_before_its_snapshot() {
            runtime().block_on(async {
                let h = H::new();
                let laptop = h.interactive().await;
                h.engage(&laptop).await;
                let token = laptop.seen.token();
                let back = h
                    .view(
                        Ask::interactive()
                            .at(size(100, 30))
                            .resuming(&laptop.id, token),
                    )
                    .await;
                assert_eq!(
                    (
                        back.seen.geometries().first().cloned(),
                        h.rt.resizes(),
                        h.rt.asked()
                    ),
                    (
                        Some(geometry(100, 30)),
                        vec![size(100, 30)],
                        vec!["resize 100x30".to_owned(), "snapshot".to_owned()]
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

        fn lagging_by_100() -> H {
            H::with_options(
                Fake::new("earlier output", 10_000),
                HubOptions {
                    max_unsent_bytes: 100,
                    ..HubOptions::default()
                },
            )
        }

        #[test]
        fn ends_a_view_that_falls_too_far_behind_and_keeps_serving_the_others() {
            runtime().block_on(async {
                let h = lagging_by_100();
                // Its screen goes out; the output after it waits.
                let gate = Arc::new(Semaphore::new(1));
                let slow = h.view(Ask::observer().stalling(&gate)).await;
                let fast = h.interactive().await;
                h.print(&"x".repeat(98)).await;
                h.print("one").await;
                h.print("two").await;
                gate.add_permits(Semaphore::MAX_PERMITS >> 1);
                settle().await;
                let fast_log = fast.seen.log();
                assert_eq!(
                    (
                        slow.seen.last_frame(),
                        slow.seen.closed(),
                        slow.seen.last_output(),
                        fast_log[fast_log.len() - 2..].to_vec(),
                        h.log.events().last().cloned(),
                        h.rt.closes()
                    ),
                    (
                        Some(ended_slow()),
                        true,
                        Some("one".to_owned()),
                        vec!["one".to_owned(), "two".to_owned()],
                        Some(format!("ended {} evicted_slow", slow.id)),
                        0
                    )
                );
            });
        }

        #[test]
        fn counts_output_held_during_a_view_s_snapshot_as_unsent() {
            runtime().block_on(async {
                let h = lagging_by_100();
                h.interactive().await;
                h.rt.hold_snapshots();
                let (joined, late) = h.start(Ask::interactive());
                settle().await;
                h.print(&"x".repeat(60)).await;
                h.print(&"x".repeat(60)).await;
                h.rt.release();
                let joined = joined.await.unwrap();
                settle().await;
                assert_eq!(
                    (joined, late.last_frame(), late.closed()),
                    (Err(JoinError::Ended), Some(ended_slow()), true)
                );
            });
        }

        #[test]
        fn stops_counting_output_held_during_a_view_s_snapshot_once_it_has_been_passed_on() {
            runtime().block_on(async {
                let h = lagging_by_100();
                h.interactive().await;
                h.rt.hold_snapshots();
                let (joined, late) = h.start(Ask::interactive());
                settle().await;
                // After the snapshot, so held for the view and passed on once it is sent.
                h.rt.take();
                h.print(&"x".repeat(60)).await;
                h.rt.release();
                joined.await.unwrap().unwrap();
                settle().await;
                h.print(&"y".repeat(60)).await;
                assert_eq!(
                    (late.closed(), late.last_output()),
                    (false, Some("y".repeat(60)))
                );
            });
        }

        #[test]
        fn holds_a_view_to_the_plain_limit_once_its_snapshot_is_written() {
            runtime().block_on(async {
                let h = H::with_options(
                    Fake::new(&"h".repeat(500), 10_000),
                    HubOptions {
                        max_unsent_bytes: 100,
                        ..HubOptions::default()
                    },
                );
                let gate = Arc::new(Semaphore::new(1));
                let slow = h.view(Ask::observer().stalling(&gate)).await;
                let ended = format!("ended {} evicted_slow", slow.id);
                h.print(&"a".repeat(99)).await;
                h.print("x").await;
                let at_the_limit = h.log.events().contains(&ended);
                h.print("y").await;
                gate.add_permits(Semaphore::MAX_PERMITS >> 1);
                settle().await;
                assert_eq!(
                    (
                        at_the_limit,
                        h.log.events().contains(&ended),
                        slow.seen.last_frame()
                    ),
                    (false, true, Some(ended_slow()))
                );
            });
        }
    }

    mod room_for_views {
        use super::*;

        /// A hub over a terminal with a long history, with options given the size of that
        /// terminal's snapshot, and that size.
        fn measured(options: impl FnOnce(usize) -> HubOptions) -> (H, usize) {
            let rt = Fake::new(&"h".repeat(500), 10_000);
            let snapshot = rt.snapshot_len();
            (H::with_options(rt, options(snapshot)), snapshot)
        }

        fn budget(max_snapshot_bytes: usize) -> HubOptions {
            HubOptions {
                max_snapshot_bytes,
                ..room()
            }
        }

        fn two_views_each() -> H {
            H::with_options(
                Fake::new("earlier output", 10_000),
                HubOptions {
                    max_views: 2,
                    ..room()
                },
            )
        }

        #[test]
        fn turns_a_view_away_once_its_terminal_has_as_many_as_it_may_and_leaves_the_others_be() {
            runtime().block_on(async {
                let h = two_views_each();
                let a = h.interactive().await;
                let b = h.interactive().await;
                let (joined, c) = h.open(Ask::interactive()).await;
                let events = h.log.events();
                let [.., started, ended] = events.as_slice() else {
                    panic!("nothing was recorded");
                };
                let id = started.strip_prefix("started ").unwrap();
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        a.seen.closed(),
                        b.seen.closed(),
                        c.frames(),
                        ended.clone()
                    ),
                    (
                        refused("this terminal already has 2 views open"),
                        false,
                        false,
                        vec![],
                        format!("ended {id} attach_failed")
                    )
                );
            });
        }

        #[test]
        fn turns_a_view_away_at_the_cap_that_names_another_view_s_attachment_without_its_token() {
            runtime().block_on(async {
                let h = two_views_each();
                let first = h.interactive().await;
                h.interactive().await;
                let (joined, _) = h
                    .open(Ask::interactive().resuming(&first.id, "not its token".to_owned()))
                    .await;
                assert_eq!(
                    (joined.map(|_| ()), first.seen.closed()),
                    (refused("this terminal already has 2 views open"), false)
                );
            });
        }

        #[test]
        fn lets_a_view_reattach_to_a_terminal_that_has_as_many_views_as_it_may_but_no_new_one() {
            runtime().block_on(async {
                let h = two_views_each();
                let gone = h.interactive().await;
                h.interactive().await;
                let back = h
                    .view(Ask::interactive().resuming(&gone.id, gone.seen.token()))
                    .await;
                let (fresh, _) = h.open(Ask::interactive()).await;
                assert_eq!(
                    (
                        fresh.map(|_| ()),
                        back.seen.last_frame().map(|f| type_of(&f))
                    ),
                    (
                        refused("this terminal already has 2 views open"),
                        Some("attached".to_owned())
                    )
                );
            });
        }

        #[test]
        fn sends_a_snapshot_a_piece_at_a_time_each_once_the_last_is_written_and_loses_none_of_it() {
            runtime().block_on(async {
                let (h, snapshot) = measured(|_| room());
                // Room for the frames before the snapshot and one piece of it, and no more.
                let frames: usize = [
                    StreamServerFrame::SnapshotStart {
                        history_lines: Some(10_000),
                    },
                    geometry(80, 24),
                    lease(false, false, 4),
                ]
                .iter()
                .map(|f| serde_json::to_string(f).unwrap().len())
                .sum();
                let reading = h.loading(Ask::observer().lagging_by(frames + 100)).await;
                let pieces = snapshot.div_ceil(100);
                for _ in 0..pieces {
                    reading.write().await;
                }
                let joined = reading.joined.await.unwrap();
                let sent = reading.seen.log();
                let shown = rows_of(&mut replayed(h.rt.terminal().snapshot_now().vt()), 10_000);
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        sent.len(),
                        sent.iter().all(|piece| piece.len() <= 100),
                        screen_of(&reading.seen)
                    ),
                    (Ok(()), pieces, true, shown)
                );
            });
        }

        #[test]
        fn ends_a_view_whose_snapshot_has_stalled_when_another_needs_the_room_the_oldest_first() {
            paused().block_on(async {
                let (h, snapshot) = measured(|snap| budget(snap * 5 / 2));
                let oldest = h.loading(Ask::observer()).await;
                h.later(10).await;
                let older = h.loading(Ask::observer()).await;
                h.later(1000).await;
                let late = h.observer().await;
                oldest.catch_up().await;
                let joined = oldest.joined.await.unwrap();
                assert_eq!(
                    (
                        oldest.seen.last_frame(),
                        oldest.seen.closed(),
                        older.seen.in_flight(),
                        evicted(&h.log),
                        late.seen.output().len(),
                        joined
                    ),
                    (
                        Some(ended_slow()),
                        true,
                        1,
                        1,
                        snapshot,
                        Err(JoinError::Ended)
                    )
                );
            });
        }

        /// Chooses the views to end for a snapshot of `bytes` to `newcomer`, lets `meanwhile` run,
        /// then ends those chosen; how many were, and the newcomer's room given back.
        async fn chosen_then_ended<F: Future<Output = ()>>(
            h: &H,
            bytes: usize,
            meanwhile: F,
        ) -> usize {
            let shared = &h.hub.shared;
            let slot = lock(&shared.watched).get(&h.terminal).cloned().unwrap();
            let watched = Arc::clone(slot.opened.get().unwrap().as_ref().unwrap());
            let newcomer = AttachmentId::mint(1, [9; 16]);
            let chosen = shared.admit(&watched, &newcomer, bytes).unwrap();
            let count = chosen.len();
            meanwhile.await;
            shared.end_stalled(chosen);
            shared.unload(&newcomer);
            count
        }

        #[test]
        fn spares_a_view_chosen_for_its_stalled_snapshot_that_writes_a_piece_before_it_is_ended() {
            paused().block_on(async {
                let (h, snapshot) = measured(|snap| budget(snap * 3 / 2));
                let reading = h.loading(Ask::observer()).await;
                h.later(1000).await;
                let chosen = chosen_then_ended(&h, snapshot, reading.write()).await;
                reading.catch_up().await;
                let joined = reading.joined.await.unwrap();
                assert_eq!(
                    (
                        chosen,
                        evicted(&h.log),
                        joined.map(|_| ()),
                        reading.seen.closed()
                    ),
                    (1, 0, Ok(()), false)
                );
            });
        }

        #[test]
        fn spares_a_view_chosen_for_its_stalled_snapshot_that_finishes_before_it_is_ended() {
            paused().block_on(async {
                let (h, snapshot) = measured(|snap| budget(snap * 3 / 2));
                let reading = h.loading(Ask::observer()).await;
                h.later(1000).await;
                let chosen = chosen_then_ended(&h, snapshot, reading.catch_up()).await;
                let joined = reading.joined.await.unwrap();
                settle().await;
                assert_eq!(
                    (
                        chosen,
                        evicted(&h.log),
                        joined.map(|_| ()),
                        reading.seen.closed(),
                        reading
                            .seen
                            .last_frame()
                            .map(|f| matches!(f, StreamServerFrame::Attached { .. }))
                    ),
                    (1, 0, Ok(()), false, Some(true))
                );
            });
        }

        #[test]
        fn turns_a_view_away_when_every_snapshot_being_sent_is_still_being_read() {
            paused().block_on(async {
                let (h, _) = measured(|snap| budget(snap * 11 / 5));
                let first = h.loading(Ask::observer()).await;
                let second = h.loading(Ask::observer()).await;
                h.later(900).await;
                first.write().await;
                second.write().await;
                h.later(600).await;
                let (joined, _) = h.open(Ask::observer()).await;
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        evicted(&h.log),
                        h.log.events().last().map(|e| e.ends_with(" attach_failed"))
                    ),
                    (refused(STILL_LOADING), 0, Some(true))
                );
            });
        }

        #[test]
        fn counts_a_snapshot_in_full_until_the_last_of_it_is_written_since_all_of_it_is_held() {
            paused().block_on(async {
                let (h, snapshot) = measured(|snap| budget(snap * 3 / 2));
                let reading = h.loading(Ask::observer()).await;
                let mut left = snapshot;
                while left > snapshot / 2 {
                    reading.write().await;
                    left -= 100;
                }
                let still_reading = reading.seen.in_flight();
                let (joined, _) = h.open(Ask::observer()).await;
                assert_eq!(
                    (still_reading, joined.map(|_| ()), evicted(&h.log)),
                    (1, refused(STILL_LOADING), 0)
                );
            });
        }

        #[test]
        fn leaves_a_reattaching_view_s_earlier_attachment_be_when_there_is_no_room_for_it() {
            paused().block_on(async {
                let (h, _) = measured(|snap| budget(snap * 3 / 2));
                let gone = h.interactive().await;
                h.engage(&gone).await;
                let _reading = h.loading(Ask::observer()).await;
                let (joined, back) = h
                    .open(Ask::interactive().resuming(&gone.id, gone.seen.token()))
                    .await;
                h.input(&gone, "still driving").await;
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        gone.seen.closed(),
                        h.log.starting(&format!("ended {}", gone.id)),
                        h.rt.written().last().cloned(),
                        back.frames()
                            .iter()
                            .any(|f| matches!(f, StreamServerFrame::SnapshotStart { .. }))
                    ),
                    (
                        refused(STILL_LOADING),
                        false,
                        vec![],
                        Some("still driving".to_owned()),
                        false
                    )
                );
            });
        }

        #[test]
        fn lets_a_view_lag_by_the_piece_of_its_snapshot_on_its_way_and_no_further_and_frees_its_room_when_it_ends()
         {
            paused().block_on(async {
                let (h, _) = measured(|snap| HubOptions {
                    max_unsent_bytes: 100,
                    ..budget(snap * 3 / 2)
                });
                let slow = h.loading(Ask::observer()).await;
                h.print(&"x".repeat(100)).await;
                let at_the_limit = evicted(&h.log);
                h.print("y").await;
                let late = h.observer().await;
                slow.catch_up().await;
                let joined = slow.joined.await.unwrap();
                assert_eq!(
                    (
                        at_the_limit,
                        slow.seen.last_frame(),
                        late.seen.last_frame().map(|f| type_of(&f)),
                        joined
                    ),
                    (
                        0,
                        Some(ended_slow()),
                        Some("attached".to_owned()),
                        Err(JoinError::Ended)
                    )
                );
            });
        }

        #[test]
        fn never_ends_a_view_that_has_its_whole_snapshot_to_make_room() {
            paused().block_on(async {
                let (h, _) = measured(|snap| budget(snap * 5 / 2));
                let opened = h.observer().await;
                h.later(5000).await;
                let _reading = h.loading(Ask::observer()).await;
                let (joined, _) = h.open(Ask::observer()).await;
                assert_eq!(
                    (joined.map(|_| ()), opened.seen.closed(), evicted(&h.log)),
                    (Ok(()), false, 0)
                );
            });
        }

        #[test]
        fn ends_no_stalled_view_when_ending_them_all_would_still_leave_no_room() {
            paused().block_on(async {
                let (h, _) = measured(|snap| budget(snap * 5 / 2));
                let _stalled = h.loading(Ask::observer()).await;
                let reading = h.loading(Ask::observer()).await;
                h.later(1000).await;
                reading.write().await;
                let larger = TerminalId::mint(2, [8; 16]);
                h.rt.another(&larger, &"h".repeat(2000));
                let (joined, _) = h.open(Ask::observer().of(&larger)).await;
                assert_eq!(
                    (joined.map(|_| ()), evicted(&h.log)),
                    (refused(STILL_LOADING), 0)
                );
            });
        }

        #[test]
        fn never_ends_a_view_for_a_stalled_snapshot_while_there_is_room() {
            paused().block_on(async {
                let (h, _) = measured(|snap| budget(snap * 3));
                let slow = h.loading(Ask::observer()).await;
                h.later(1_000_000).await;
                let (joined, _) = h.open(Ask::observer()).await;
                assert_eq!(
                    (joined.map(|_| ()), slow.seen.in_flight(), evicted(&h.log)),
                    (Ok(()), 1, 0)
                );
            });
        }

        #[test]
        fn ends_a_stalled_view_of_one_terminal_for_a_view_of_another() {
            paused().block_on(async {
                let (h, _) = measured(|snap| budget(snap * 3 / 2));
                let stalled = h.loading(Ask::observer()).await;
                h.later(1000).await;
                let other = TerminalId::mint(2, [8; 16]);
                h.rt.another(&other, &"h".repeat(500));
                let (joined, _) = h.open(Ask::observer().of(&other)).await;
                stalled.catch_up().await;
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        stalled.seen.closed(),
                        stalled.seen.last_frame()
                    ),
                    (Ok(()), true, Some(ended_slow()))
                );
            });
        }

        #[test]
        fn sends_a_snapshot_larger_than_the_cap_only_while_no_other_is_being_sent() {
            paused().block_on(async {
                let (h, _) = measured(|snap| budget(snap / 2));
                let alone = h.loading(Ask::observer()).await;
                let (joined, _) = h.open(Ask::observer()).await;
                assert_eq!(
                    (joined.map(|_| ()), alone.seen.in_flight(), evicted(&h.log)),
                    (refused(STILL_LOADING), 1, 0)
                );
            });
        }

        #[test]
        fn lets_a_view_whose_socket_closes_mid_snapshot_finish_opening_and_frees_its_room() {
            paused().block_on(async {
                let (h, _) = measured(|snap| budget(snap * 3 / 2));
                let closing = h.loading(Ask::observer()).await;
                closing.disconnect().await;
                let joined = closing.joined.await.unwrap();
                let (late, seen) = h.open(Ask::observer()).await;
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        late.map(|_| ()),
                        seen.last_frame().map(|f| type_of(&f))
                    ),
                    (Ok(()), Ok(()), Some("attached".to_owned()))
                );
            });
        }

        #[test]
        fn frees_the_room_of_a_view_whose_stream_closes_while_its_snapshot_is_on_its_way() {
            paused().block_on(async {
                let (h, _) = measured(|snap| budget(snap * 3 / 2));
                let cut_off = h.loading(Ask::observer()).await;
                h.rt.falls_behind();
                settle().await;
                let joined = cut_off.joined.await.unwrap();
                let (late, seen) = h.open(Ask::observer()).await;
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        late.map(|_| ()),
                        seen.last_frame().map(|f| type_of(&f))
                    ),
                    (Err(JoinError::Ended), Ok(()), Some("attached".to_owned()))
                );
            });
        }
    }

    mod snapshot_streams {
        use super::*;

        #[test]
        fn tells_the_views_open_the_size_applied_once_when_a_resize_is_accepted() {
            runtime().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                h.view(Ask::interactive().at(size(120, 48))).await;
                assert_eq!(
                    first.seen.geometries(),
                    vec![geometry(80, 24), geometry(120, 48)]
                );
            });
        }

        #[test]
        fn passes_a_size_applied_while_a_snapshot_is_on_its_way_between_the_output_around_it() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                let late = h.loading(Ask::observer()).await;
                h.print("before").await;
                h.rt.terminal().sized_elsewhere(size(60, 40));
                settle().await;
                h.print("after").await;
                late.catch_up().await;
                let joined = late.joined.await.unwrap();
                let (order, log) = (late.seen.order(), late.seen.log());
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        order[order.len() - 4..].to_vec(),
                        log[log.len() - 2..].to_vec()
                    ),
                    (
                        Ok(()),
                        ["bytes", "geometry", "bytes", "attached"]
                            .map(str::to_owned)
                            .to_vec(),
                        vec!["before".to_owned(), "after".to_owned()]
                    )
                );
            });
        }

        #[test]
        fn opens_a_view_on_output_from_both_sides_of_the_point_its_snapshot_was_taken_at() {
            runtime().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                h.print("one ").await;
                h.rt.hold_snapshots();
                let (joined, late) = h.start(Ask::interactive());
                settle().await;
                h.print("two ").await;
                h.rt.take();
                h.print("three ").await;
                h.rt.release();
                joined.await.unwrap().unwrap();
                settle().await;
                h.print("four").await;
                let all = ["earlier output", "one two three four"].map(str::to_owned);
                assert_eq!(
                    (screen_of(&first.seen), screen_of(&late)),
                    (all.to_vec(), all.to_vec())
                );
            });
        }

        /// A view opened on a terminal respawned before or after its snapshot was taken, and the
        /// view open all along.
        async fn respawned_around_a_snapshot(taken_first: bool) -> (Seen, Seen) {
            let h = H::new();
            let first = h.interactive().await;
            h.print("\x1b[?1049hALTDRAWN\x1b[?2004h").await;
            h.rt.hold_snapshots();
            let (joined, late) = h.start(Ask::interactive());
            settle().await;
            if taken_first {
                h.rt.take();
            }
            h.rt.exits(0);
            h.rt.respawned(1);
            h.print("respawned ").await;
            if !taken_first {
                h.rt.take();
            }
            h.print("more").await;
            h.rt.release();
            joined.await.unwrap().unwrap();
            settle().await;
            (first.seen, late)
        }

        fn shown(view: &Seen) -> (bool, Option<String>, impl PartialEq + fmt::Debug) {
            let screen = replayed(&view.output());
            (
                screen.alternate(),
                screen_of(view).last().cloned(),
                screen.modes(),
            )
        }

        #[test]
        fn opens_a_view_of_a_terminal_respawned_before_its_snapshot_was_taken_as_the_views_already_open()
         {
            runtime().block_on(async {
                let (first, late) = respawned_around_a_snapshot(false).await;
                let respawned = Some("respawned more".to_owned());
                assert_eq!((shown(&late), shown(&first).1), (shown(&first), respawned));
            });
        }

        #[test]
        fn opens_a_view_of_a_terminal_respawned_after_its_snapshot_was_taken_as_the_views_already_open()
         {
            runtime().block_on(async {
                let (first, late) = respawned_around_a_snapshot(true).await;
                let respawned = Some("respawned more".to_owned());
                assert_eq!((shown(&late), shown(&first).1), (shown(&first), respawned));
            });
        }

        #[test]
        fn opens_a_view_of_a_terminal_respawned_that_has_sent_nothing_since() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.rt.respawned(1);
                settle().await;
                let (mut joined, late) = h.start(Ask::interactive());
                settle().await;
                assert_eq!(
                    (
                        joined.try_recv().map(|r| r.map(|_| ())),
                        late.last_frame().map(|f| type_of(&f))
                    ),
                    (Ok(Ok(())), Some("attached".to_owned()))
                );
            });
        }

        #[test]
        fn refuses_a_view_whose_snapshot_is_older_than_the_output_it_can_carry_on_from() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.rt.skew_snapshots(-1);
                h.print("one ").await;
                let (joined, late) = h.open(Ask::interactive()).await;
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        late.frames()
                            .iter()
                            .any(|f| matches!(f, StreamServerFrame::SnapshotStart { .. })),
                        late.output(),
                        attach_failed(&h.log)
                    ),
                    (
                        refused("this terminal's screen could not be read; reopen it"),
                        false,
                        vec![],
                        1
                    )
                );
            });
        }

        #[test]
        fn never_holds_a_view_to_output_its_snapshot_already_shows() {
            runtime().block_on(async {
                let h = H::with_options(
                    Fake::new("earlier output", 10_000),
                    HubOptions {
                        max_unsent_bytes: 100,
                        ..HubOptions::default()
                    },
                );
                h.interactive().await;
                h.rt.hold_snapshots();
                let gate = Arc::new(Semaphore::new(0));
                let (joined, late) = h.start(Ask::observer().stalling(&gate));
                settle().await;
                h.print(&"x".repeat(60)).await;
                h.rt.take();
                h.rt.release();
                settle().await;
                let on_its_way = late.in_flight();
                h.print(&"y".repeat(60)).await;
                gate.add_permits(Semaphore::MAX_PERMITS >> 1);
                let joined = joined.await.unwrap();
                settle().await;
                assert_eq!(
                    (on_its_way, joined.map(|_| ()), screen_of(&late)),
                    (
                        1,
                        Ok(()),
                        vec![
                            "earlier output".to_owned(),
                            format!("{}{}", "x".repeat(60), "y".repeat(20)),
                            "y".repeat(40)
                        ]
                    )
                );
            });
        }

        #[test]
        fn ends_a_view_whose_snapshot_fails_and_serves_the_others_on() {
            runtime().block_on(async {
                let h = H::new();
                let first = h.interactive().await;
                h.rt.fail_snapshots("no snapshot");
                let (joined, late) = h.open(Ask::interactive()).await;
                h.print("still here").await;
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        late.attached(),
                        attach_failed(&h.log),
                        first.seen.last_output()
                    ),
                    (
                        Err(JoinError::Snapshot("no snapshot".to_owned())),
                        false,
                        1,
                        Some("still here".to_owned())
                    )
                );
            });
        }

        #[test]
        fn never_tells_a_view_it_is_attached_when_the_stream_falls_behind_while_its_snapshot_is_taken()
         {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.rt.hold_snapshots();
                let (joined, late) = h.start(Ask::interactive());
                settle().await;
                h.rt.falls_behind();
                let joined = joined.await.unwrap();
                settle().await;
                assert_eq!(
                    (
                        joined.map(|_| ()),
                        late.attached(),
                        late.last_frame(),
                        late.closed(),
                        evicted(&h.log)
                    ),
                    (Err(JoinError::Ended), false, Some(ended_slow()), true, 2)
                );
            });
        }
    }

    mod a_snapshot_stream_that_closes {
        use super::*;

        #[test]
        fn ends_every_view_as_too_far_behind_as_its_stream_falls_behind() {
            runtime().block_on(async {
                let h = H::new();
                let a = h.interactive().await;
                h.rt.falls_behind();
                settle().await;
                assert_eq!(
                    (
                        a.seen.last_frame(),
                        a.seen.closed(),
                        h.log.events().last().cloned()
                    ),
                    (
                        Some(ended_slow()),
                        true,
                        Some(format!("ended {} evicted_slow", a.id))
                    )
                );
            });
        }

        #[test]
        fn opens_a_view_that_comes_back_after_falling_behind_on_a_fresh_snapshot() {
            runtime().block_on(async {
                let h = H::new();
                h.interactive().await;
                h.print("missed ").await;
                h.rt.falls_behind();
                settle().await;
                h.rt.print("while away");
                let (joined, back) = h.open(Ask::interactive()).await;
                assert_eq!(
                    (joined.map(|_| ()), h.rt.attaches().len(), screen_of(&back)),
                    (
                        Ok(()),
                        2,
                        vec!["earlier output".to_owned(), "missed while away".to_owned()]
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
