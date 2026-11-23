//! A terminal's streams, as `packages/runtime-holder/src/runtime-stream.ts`. Each stream reads on
//! a connection of its own, subscribed from its snapshot. What streams send, and the snapshots
//! they take later, go through one control connection per terminal, unsubscribed and holding the
//! writer slot:
//!
//! - a holder has one writer slot, which every stream of the terminal shares;
//! - a snapshot sent on a subscribed connection moves its subscription to the snapshot's offset,
//!   so the output between is never sent there, and other views reading it would miss it.
//!
//! The control connection is a task of its own, `Control`'s, taking what its users send on a
//! channel; each stream is another, reading its connection's events and handing them on, in
//! order, to `StreamEvents`.

use std::collections::{HashMap, VecDeque};
use std::future::{Future, poll_fn};
use std::path::PathBuf;
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use bazhen_holder_proto::MAX_REQUEST_BYTES;
use bazhen_holder_proto::body::{Count, Exited, Generation, Offset, Size, Stats};
use bazhen_protocol::ids::TerminalId;
use futures_util::Stream as _;
use futures_util::future::select;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::{CancellationToken, PollSender, WaitForCancellationFutureOwned};
use tokio_util::task::TaskTracker;

use crate::client::{
    Answer, ClientOptions, ConnectError, EVENTS_QUEUED, HolderClient, HolderEvent, HolderEvents,
    HolderRefusal, HolderSnapshot, InputError, MAX_UNSENT_BYTES, RequestError, connect,
};
use crate::locator::HolderLocator;

/// How long a holder that has stopped reading gets to take input, before its connection ends.
pub const DRAIN: Duration = Duration::from_secs(10);
/// How long to wait before asking again for a writer slot another connection holds.
pub const WRITER_RETRY: [Duration; 3] = [
    Duration::from_millis(50),
    Duration::from_millis(200),
    Duration::from_millis(800),
];
/// What one write of input may hold, so it fits a connection's unsent cap with room to spare.
const INPUT_PART: usize = MAX_REQUEST_BYTES;
/// What input frames add to their bytes, at most, for one part.
const PART_OVERHEAD: usize = 64;
/// What a failure of input is told as.
const INPUT: &str = "input";

/// Where a stream is: the generation and offset of the next byte it will deliver. A later
/// generation is past every offset of an earlier one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Position {
    pub generation: Generation,
    pub offset: Offset,
}

/// What a stream tells its consumer, in the order its holder sent it. `Closed` comes last, once.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// Output, `at` its first byte.
    Data {
        at: Position,
        bytes: Vec<u8>,
    },
    /// A new process runs; output from here on is of `generation`, from offset 0.
    Respawned {
        generation: Generation,
    },
    /// The process of the stream's generation exited, told once.
    Exited(Exited),
    Resized(Size),
    /// Sending failed, told once until it works again.
    Failed(StreamFailure),
    Closed(StreamEnd),
}

/// Why a stream closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEnd {
    /// Its connection ended: closed by its consumer, by the runtime's shutdown, or by the holder.
    Ended,
    /// Its holder dropped output it hadn't sent, which a snapshot would have to draw again.
    Behind,
}

/// What failed, input the only thing that does, and why.
#[derive(Debug, Clone)]
pub struct StreamFailure {
    pub what: &'static str,
    pub cause: ControlError,
}

/// Why the control connection failed a stream's input, resize or snapshot.
#[derive(Debug, Clone, thiserror::Error)]
pub enum ControlError {
    #[error("another holder serves the terminal's socket now")]
    AnotherHolder,
    #[error("another connection holds the terminal's writer slot")]
    WriterTaken,
    #[error("the holder stopped taking input")]
    StoppedTakingInput,
    #[error(
        "refused {len} bytes of input: over the {MAX_UNSENT_BYTES} bytes of input a terminal holds unsent"
    )]
    OverUnsent { len: usize },
    #[error(transparent)]
    Refused(HolderRefusal),
    #[error("the terminal's holder can't be reached")]
    Connect(#[source] Arc<ConnectError>),
    #[error(transparent)]
    Request(Arc<RequestError>),
    #[error(transparent)]
    Input(Arc<InputError>),
    #[error("the terminal's streams have all closed")]
    Ended,
    #[error("the terminal was closed")]
    Retired,
}

/// Why a stream's request failed.
#[derive(Debug, thiserror::Error)]
pub enum StreamError {
    #[error("the stream has closed")]
    Closed,
    #[error(
        "holder reports {}x{} after resize to {}x{}",
        .reported.cols.get(),
        .reported.rows.get(),
        .asked.cols.get(),
        .asked.rows.get()
    )]
    Unconfirmed { reported: Size, asked: Size },
    #[error(transparent)]
    Control(ControlError),
    /// The stream's own connection didn't answer.
    #[error(transparent)]
    Reader(RequestError),
    #[error("the holder subscribed the stream without its snapshot")]
    Unsnapshotted,
}

/// A stream attached: the terminal as of `offset` in `generation`, and what follows it.
#[derive(Debug)]
pub struct Attached {
    vt: Vec<u8>,
    pub offset: Offset,
    pub generation: Generation,
    /// How much history the holder keeps, as it said.
    pub history_lines: Count,
    pub stream: HolderStream,
    pub events: StreamEvents,
}

impl Attached {
    /// VT that draws the terminal as of `offset`.
    pub fn vt(&self) -> &[u8] {
        &self.vt
    }
}

/// What a stream tells, as `StreamEvent`s, from its snapshot on. Up to `EVENTS_QUEUED` wait for a
/// consumer that hasn't taken them, past which the stream reads no more from its holder, which
/// then skips it past what it can't hold: the stream ends `Behind`. It ends after `Closed`.
#[derive(Debug)]
pub struct StreamEvents(mpsc::Receiver<StreamEvent>);

impl StreamEvents {
    pub async fn recv(&mut self) -> Option<StreamEvent> {
        self.0.recv().await
    }

    /// The next event, if one is waiting.
    pub fn try_recv(&mut self) -> Option<StreamEvent> {
        self.0.try_recv().ok()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic under the lock leaves the state whole: each change under it is one assignment.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the control connection tells each user.
#[derive(Debug)]
pub(crate) enum Notice {
    Failed(StreamFailure),
    /// Input worked again, after a failure of it.
    Succeeded,
}

#[derive(Debug, Default)]
struct Users {
    next: u64,
    notices: HashMap<u64, mpsc::UnboundedSender<Notice>>,
    /// The last failure, until input works again: a user that comes later hears of it.
    failure: Option<StreamFailure>,
}

/// What a control connection's handles and its task share.
#[derive(Debug, Default)]
struct Shared {
    /// Input given and not yet written, against `MAX_UNSENT_BYTES`.
    queued: Mutex<usize>,
    users: Mutex<Users>,
}

impl Shared {
    fn fail(&self, cause: ControlError) {
        let failure = StreamFailure { what: INPUT, cause };
        let mut users = lock(&self.users);
        users.failure = Some(failure.clone());
        for notices in users.notices.values() {
            // A user whose stream has stopped hears nothing more.
            let _ = notices.send(Notice::Failed(failure.clone()));
        }
    }

    fn succeed(&self) {
        let mut users = lock(&self.users);
        if users.failure.take().is_some() {
            for notices in users.notices.values() {
                let _ = notices.send(Notice::Succeeded);
            }
        }
    }

    fn unqueue(&self, len: usize) {
        let mut queued = lock(&self.queued);
        *queued = queued.saturating_sub(len);
    }
}

/// How a terminal's control connection is opened.
#[derive(Debug, Clone)]
pub(crate) struct Opening {
    pub(crate) socket: PathBuf,
    /// The holder every connection must reach: another at the terminal's socket is refused.
    pub(crate) locator: HolderLocator,
    pub(crate) options: ClientOptions,
    pub(crate) drain: Duration,
    pub(crate) writer_retry: Vec<Duration>,
}

/// A connection to the holder holding its writer slot, and its events, which carry the holder's
/// refusals of input.
#[derive(Debug)]
struct Writer {
    client: HolderClient,
    events: HolderEvents,
    /// Whether `events` may have more.
    reading: bool,
}

impl Writer {
    /// Hangs up, and resolves once its socket has closed.
    fn close(self) -> impl Future<Output = ()> + Send + 'static {
        let Self { client, events, .. } = self;
        drop(events);
        client.end();
        async move { client.closed().await }
    }
}

#[derive(Debug)]
enum Command {
    /// One user's write, whole, so no other's goes out in the middle of it.
    Input(Vec<u8>),
    Resize {
        size: Size,
        reply: oneshot::Sender<Result<(), ControlError>>,
    },
    Snapshot(oneshot::Sender<Result<Answer<HolderSnapshot>, ControlError>>),
    /// No user is left: send what is queued, for `drain` at most, then hang up and stop,
    /// cancelling the token once the connection has closed.
    End(CancellationToken),
    /// The terminal closed: hang up and drop what is queued, cancelling the token once the
    /// connection has closed, and go on for the users left.
    Retire(CancellationToken),
}

/// One terminal's control connection, shared by its users. Opened on first use, and again after
/// it is lost, once the old one's socket has closed, so the holder has freed its writer slot.
/// Input and resizes go out in the order the users gave them.
#[derive(Debug, Clone)]
pub(crate) struct Control {
    locator: HolderLocator,
    commands: mpsc::UnboundedSender<Command>,
    shared: Arc<Shared>,
}

impl Control {
    /// Starts its task in `tasks`, ending with `cancel`; it opens no connection before one is
    /// needed, nor before `after` is cancelled, once the terminal's last control connection has
    /// closed.
    fn start(
        opening: Opening,
        after: Option<CancellationToken>,
        tasks: &TaskTracker,
        cancel: &CancellationToken,
    ) -> Self {
        let (commands, received) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared::default());
        let control = Self {
            locator: opening.locator.clone(),
            commands,
            shared: Arc::clone(&shared),
        };
        let actor = Actor {
            opening,
            after,
            shared,
            writer: None,
            connecting: None,
            busy: None,
            queue: VecDeque::new(),
            waiting: Vec::new(),
            commands: received,
            tasks: tasks.clone(),
            stopped: Box::pin(cancel.clone().cancelled_owned()),
            ending: None,
            listening: true,
        };
        tasks.spawn(actor.run());
        control
    }

    /// Whether it reaches the holder `locator` names.
    fn serves(&self, locator: &HolderLocator) -> bool {
        self.locator.holder_pid == locator.holder_pid
            && self.locator.holder_start == locator.holder_start
    }

    fn is(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.shared, &other.shared)
    }

    /// Queues `bytes` as input; past what a connection holds unsent, refuses them all and says so.
    fn write(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut queued = lock(&self.shared.queued);
        if *queued + bytes.len() > MAX_UNSENT_BYTES {
            drop(queued);
            self.shared
                .fail(ControlError::OverUnsent { len: bytes.len() });
            return;
        }
        // Sent under the lock, as one command, so the task takes users' writes whole and in the
        // order they were counted. One that has stopped sends nothing.
        if self.commands.send(Command::Input(bytes.to_vec())).is_ok() {
            *queued += bytes.len();
        }
    }

    /// Resizes the terminal once what was written before has gone out.
    async fn resize(&self, size: Size) -> Result<(), ControlError> {
        let (reply, resized) = oneshot::channel();
        // A task that has stopped drops the reply, as one that ends with the resize queued does.
        let _ = self.commands.send(Command::Resize { size, reply });
        resized.await.unwrap_or(Err(ControlError::Ended))
    }

    /// A snapshot taken on the control connection, ahead of any input queued.
    async fn snapshot(&self) -> Result<HolderSnapshot, ControlError> {
        let (reply, asked) = oneshot::channel();
        let _ = self.commands.send(Command::Snapshot(reply));
        let answer = asked.await.unwrap_or(Err(ControlError::Ended))?;
        answer.await.map_err(|e| ControlError::Request(Arc::new(e)))
    }

    /// Tells its task to `End` or `Retire`; one that has stopped has nothing open.
    fn stop(&self, command: Command) {
        if let Err(mpsc::error::SendError(Command::End(closed) | Command::Retire(closed))) =
            self.commands.send(command)
        {
            closed.cancel();
        }
    }
}

type Boxed<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// What the task waits for that its users don't.
enum Busy {
    Drained { timed_out: bool },
    Resized,
}

enum Wake {
    Stopped,
    /// An ending's `drain` has passed.
    Deadline,
    Command(Option<Command>),
    Connected(Result<Writer, ControlError>),
    Busy(Busy),
    Event(Option<HolderEvent>),
}

enum Op {
    /// A write, sent from `sent` on in parts of `INPUT_PART` at most.
    Input { bytes: Vec<u8>, sent: usize },
    Resize {
        size: Size,
        reply: oneshot::Sender<Result<(), ControlError>>,
    },
}

/// The task of a control connection.
struct Actor {
    opening: Opening,
    after: Option<CancellationToken>,
    shared: Arc<Shared>,
    writer: Option<Writer>,
    /// A connection opening, the old one taken into it to close first.
    connecting: Option<Boxed<Result<Writer, ControlError>>>,
    /// A drain or a resize the queue waits on.
    busy: Option<Boxed<Busy>>,
    queue: VecDeque<Op>,
    /// Snapshots asked for while no connection is open.
    waiting: Vec<oneshot::Sender<Result<Answer<HolderSnapshot>, ControlError>>>,
    commands: mpsc::UnboundedReceiver<Command>,
    tasks: TaskTracker,
    stopped: Pin<Box<WaitForCancellationFutureOwned>>,
    /// Set once no user is left, while what is queued goes out.
    ending: Option<Ending>,
    /// Until every handle is dropped, which an ending outlives.
    listening: bool,
}

/// An actor sending what is queued before it hangs up, until `deadline`.
struct Ending {
    /// Cancels the `End`'s token once dropped, after the connection has closed.
    _closed: tokio_util::sync::DropGuard,
    deadline: Pin<Box<tokio::time::Sleep>>,
}

impl Actor {
    async fn run(mut self) {
        loop {
            match poll_fn(|cx| self.poll_wake(cx)).await {
                // The last user's handles go with its guard, after its `End`.
                Wake::Command(None) if self.ending.is_some() => self.listening = false,
                Wake::Stopped | Wake::Command(None) => return,
                Wake::Command(Some(Command::End(closed))) => {
                    self.ending = Some(Ending {
                        _closed: closed.drop_guard(),
                        deadline: Box::pin(tokio::time::sleep(self.opening.drain)),
                    });
                }
                Wake::Deadline => {
                    // A connection still opening, or asking again for the writer slot, is given up.
                    self.connecting = None;
                    let unsent = self.unsent();
                    if unsent > 0 {
                        tracing::warn!(
                            bytes = unsent,
                            "dropped input the holder hadn't taken once its terminal's last user left"
                        );
                        self.shared.fail(ControlError::Ended);
                    }
                    self.end().await;
                    return;
                }
                Wake::Command(Some(Command::Retire(closed))) => {
                    // A user left opens no connection before this one has closed.
                    self.after = Some(closed.clone());
                    self.drop_queue(&ControlError::Retired);
                    let closing = self.closing();
                    let stopped = self.stopped_token();
                    self.tasks.spawn(async move {
                        let _closed = closed.drop_guard();
                        let _ = select(pin!(closing), pin!(stopped.cancelled_owned())).await;
                    });
                }
                Wake::Command(Some(command)) => self.take(command),
                Wake::Connected(connected) => self.connected(connected),
                Wake::Busy(Busy::Drained { timed_out: true }) => {
                    if let Some(writer) = &self.writer {
                        writer.client.end();
                    }
                    self.drop_queue(&ControlError::StoppedTakingInput);
                    self.shared.fail(ControlError::StoppedTakingInput);
                }
                Wake::Busy(Busy::Drained { timed_out: false }) => self.send_head(),
                Wake::Event(Some(HolderEvent::Refused { refusal, .. })) => {
                    self.shared.fail(ControlError::Refused(refusal));
                }
                Wake::Event(Some(HolderEvent::Ended(_)) | None) => {
                    if let Some(writer) = &mut self.writer {
                        writer.reading = false;
                    }
                }
                Wake::Busy(Busy::Resized) | Wake::Event(Some(_)) => {}
            }
            self.pump();
            let sent = self.queue.is_empty() && self.busy.is_none() && self.connecting.is_none();
            if self.ending.is_some() && sent {
                self.end().await;
                return;
            }
        }
    }

    /// Hangs up, and stops once the connection has closed, or the runtime has stopped.
    async fn end(&mut self) {
        let _ending = self.ending.take();
        self.drop_queue(&ControlError::Ended);
        let closing = pin!(self.closing());
        let _ = select(closing, self.stopped.as_mut()).await;
    }

    /// The input queued and not yet written.
    fn unsent(&self) -> usize {
        self.queue
            .iter()
            .map(|op| match op {
                Op::Input { bytes, sent } => bytes.len() - sent,
                Op::Resize { .. } => 0,
            })
            .sum()
    }

    /// A token cancelled as `stopped` is, for a task of its own.
    fn stopped_token(&self) -> CancellationToken {
        self.opening.options.cancel.clone()
    }

    fn poll_wake(&mut self, cx: &mut Context<'_>) -> Poll<Wake> {
        if self.stopped.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Wake::Stopped);
        }
        if let Some(ending) = &mut self.ending
            && ending.deadline.as_mut().poll(cx).is_ready()
        {
            return Poll::Ready(Wake::Deadline);
        }
        if let Some(connecting) = &mut self.connecting
            && let Poll::Ready(connected) = connecting.as_mut().poll(cx)
        {
            self.connecting = None;
            return Poll::Ready(Wake::Connected(connected));
        }
        if let Some(busy) = &mut self.busy
            && let Poll::Ready(done) = busy.as_mut().poll(cx)
        {
            self.busy = None;
            return Poll::Ready(Wake::Busy(done));
        }
        if let Some(writer) = &mut self.writer
            && writer.reading
            && let Poll::Ready(event) = Pin::new(&mut writer.events).poll_next(cx)
        {
            return Poll::Ready(Wake::Event(event));
        }
        if !self.listening {
            return Poll::Pending;
        }
        self.commands.poll_recv(cx).map(Wake::Command)
    }

    fn take(&mut self, command: Command) {
        match command {
            Command::Input(bytes) => self.queue.push_back(Op::Input { bytes, sent: 0 }),
            Command::Resize { size, reply } => self.queue.push_back(Op::Resize { size, reply }),
            Command::Snapshot(reply) => match self.open() {
                Some(writer) => drop(reply.send(Ok(writer.client.snapshot()))),
                None => self.waiting.push(reply),
            },
            Command::End(closed) | Command::Retire(closed) => closed.cancel(),
        }
    }

    /// The connection, while it is open.
    fn open(&self) -> Option<&Writer> {
        self.writer
            .as_ref()
            .filter(|writer| writer.client.is_open())
    }

    fn connected(&mut self, connected: Result<Writer, ControlError>) {
        match connected {
            Ok(writer) => {
                for reply in self.waiting.drain(..) {
                    let _ = reply.send(Ok(writer.client.snapshot()));
                }
                self.writer = Some(writer);
            }
            Err(error) => {
                for reply in self.waiting.drain(..) {
                    let _ = reply.send(Err(error.clone()));
                }
                if !self.queue.is_empty() {
                    self.drop_queue(&error);
                    self.shared.fail(error);
                }
            }
        }
    }

    /// Sends what is queued, in order, waiting for room rather than overrunning the connection.
    fn pump(&mut self) {
        while self.connecting.is_none() && self.busy.is_none() {
            let Some(writer) = self.open() else {
                if !self.queue.is_empty() || !self.waiting.is_empty() {
                    self.connecting = Some(self.connect());
                }
                return;
            };
            match self.queue.front() {
                None => return,
                Some(Op::Input { bytes, sent })
                    if writer.client.room() < part(bytes, *sent).len() + PART_OVERHEAD =>
                {
                    let drained = writer.client.drained();
                    let drain = self.opening.drain;
                    self.busy = Some(Box::pin(async move {
                        let timed_out = tokio::time::timeout(drain, drained).await.is_err();
                        Busy::Drained { timed_out }
                    }));
                }
                Some(Op::Input { .. }) => self.send_head(),
                Some(Op::Resize { size, .. }) => {
                    let answer = writer.client.resize(*size);
                    let Some(Op::Resize { reply, .. }) = self.queue.pop_front() else {
                        return;
                    };
                    self.busy = Some(Box::pin(async move {
                        let resized = answer.await.map_err(|e| ControlError::Request(Arc::new(e)));
                        let _ = reply.send(resized);
                        Busy::Resized
                    }));
                }
            }
        }
    }

    /// Writes the next part of the input at the head of the queue, room or not: past a drain, the
    /// connection has room for it, or has ended and refuses it.
    fn send_head(&mut self) {
        let Some(writer) = &self.writer else { return };
        let Some(Op::Input { bytes, sent }) = self.queue.front_mut() else {
            return;
        };
        let next = part(bytes, *sent);
        let written = writer.client.input(next);
        let len = next.len();
        *sent += len;
        if *sent == bytes.len() {
            self.queue.pop_front();
        }
        self.shared.unqueue(len);
        match written {
            Ok(_) => self.shared.succeed(),
            Err(e) => {
                let error = ControlError::Input(Arc::new(e));
                self.drop_queue(&error);
                self.shared.fail(error);
            }
        }
    }

    /// Forgets what is queued: input is dropped, and a resize waiting is failed with `error`, as
    /// is a snapshot waiting for a connection.
    fn drop_queue(&mut self, error: &ControlError) {
        let mut dropped = 0;
        for op in self.queue.drain(..) {
            match op {
                Op::Input { bytes, sent } => dropped += bytes.len() - sent,
                Op::Resize { reply, .. } => drop(reply.send(Err(error.clone()))),
            }
        }
        self.shared.unqueue(dropped);
        for reply in self.waiting.drain(..) {
            let _ = reply.send(Err(error.clone()));
        }
    }

    /// Hangs up the connection, and one still opening once it has, resolving once both have
    /// closed.
    fn closing(&mut self) -> impl Future<Output = ()> + Send + 'static {
        self.busy = None;
        let connecting = self.connecting.take();
        let writer = self.writer.take().map(Writer::close);
        async move {
            let opened = match connecting {
                Some(connecting) => connecting.await.ok().map(Writer::close),
                None => None,
            };
            for closed in [writer, opened].into_iter().flatten() {
                closed.await;
            }
        }
    }

    /// A connection holding the writer slot, of the holder the terminal was attached on, once the
    /// last one has closed: asked for again after each wait in `writer_retry` while another
    /// connection holds the slot.
    fn connect(&mut self) -> Boxed<Result<Writer, ControlError>> {
        let old = self.writer.take().map(Writer::close);
        let after = self.after.clone();
        let opening = self.opening.clone();
        Box::pin(async move {
            if let Some(after) = after {
                after.cancelled_owned().await;
            }
            if let Some(old) = old {
                old.await;
            }
            let options = ClientOptions {
                writer: true,
                ..opening.options.clone()
            };
            let mut waits = opening.writer_retry.iter();
            loop {
                let (client, events) = connect(&opening.socket, &options)
                    .await
                    .map_err(|e| ControlError::Connect(Arc::new(e)))?;
                let hello = client.hello();
                let (refusal, retry) = if !opening.locator.is_holder_of(hello) {
                    (ControlError::AnotherHolder, false)
                } else if hello.writer {
                    return Ok(Writer {
                        client,
                        events,
                        reading: true,
                    });
                } else {
                    (ControlError::WriterTaken, true)
                };
                Writer {
                    client,
                    events,
                    reading: false,
                }
                .close()
                .await;
                match waits.next() {
                    Some(wait) if retry => tokio::time::sleep(*wait).await,
                    _ => return Err(refusal),
                }
            }
        })
    }
}

/// The part of `bytes` sent next, once `sent` of them have been.
fn part(bytes: &[u8], sent: usize) -> &[u8] {
    let rest = bytes.get(sent..).unwrap_or_default();
    rest.get(..INPUT_PART).unwrap_or(rest)
}

/// The control connections of the runtime's terminals, each kept while a user holds a guard of
/// it, and what settles once the last of each terminal's has closed.
#[derive(Debug, Default)]
pub(crate) struct Controls(Mutex<Registry>);

#[derive(Debug, Default)]
struct Registry {
    serving: HashMap<TerminalId, Control>,
    retiring: HashMap<TerminalId, CancellationToken>,
}

impl Controls {
    /// A guard of the control connection for the holder `opening` names, made if no user of it
    /// has one, and what it tells this user. One made for another holder of the terminal is left
    /// to its users, and never reaches this one.
    pub(crate) fn acquire(
        self: &Arc<Self>,
        terminal_id: &TerminalId,
        opening: Opening,
        tasks: &TaskTracker,
        cancel: &CancellationToken,
    ) -> (ControlGuard, mpsc::UnboundedReceiver<Notice>) {
        let mut registry = lock(&self.0);
        registry.retiring.retain(|_, closed| !closed.is_cancelled());
        let control = match registry.serving.get(terminal_id) {
            Some(control) if control.serves(&opening.locator) => control.clone(),
            _ => {
                let after = registry.retiring.get(terminal_id).cloned();
                let control = Control::start(opening, after, tasks, cancel);
                registry
                    .serving
                    .insert(terminal_id.clone(), control.clone());
                control
            }
        };
        let (notices, told) = mpsc::unbounded_channel();
        let user = {
            let mut users = lock(&control.shared.users);
            if let Some(failure) = &users.failure {
                let _ = notices.send(Notice::Failed(failure.clone()));
            }
            let user = users.next;
            users.next += 1;
            users.notices.insert(user, notices);
            user
        };
        drop(registry);
        let guard = ControlGuard {
            controls: Arc::clone(self),
            terminal_id: terminal_id.clone(),
            control,
            user,
        };
        (guard, told)
    }

    fn release(&self, terminal_id: &TerminalId, control: &Control, user: u64) {
        let mut registry = lock(&self.0);
        let idle = {
            let mut users = lock(&control.shared.users);
            users.notices.remove(&user);
            users.notices.is_empty()
        };
        if !idle {
            return;
        }
        if registry
            .serving
            .get(terminal_id)
            .is_some_and(|serving| serving.is(control))
        {
            registry.serving.remove(terminal_id);
        }
        let closed = CancellationToken::new();
        registry
            .retiring
            .insert(terminal_id.clone(), closed.clone());
        control.stop(Command::End(closed));
    }

    /// Hangs up the terminal's control connection, dropping what is queued, as its terminal has
    /// closed; a user left that sends again opens another.
    pub(crate) fn forget(&self, terminal_id: &TerminalId) {
        let mut registry = lock(&self.0);
        if let Some(control) = registry.serving.remove(terminal_id) {
            let closed = CancellationToken::new();
            registry
                .retiring
                .insert(terminal_id.clone(), closed.clone());
            control.stop(Command::Retire(closed));
        }
    }
}

/// A use of a terminal's control connection, which opens on the first input and hangs up once
/// the last guard of it is dropped.
#[derive(Debug)]
pub struct ControlGuard {
    controls: Arc<Controls>,
    terminal_id: TerminalId,
    control: Control,
    user: u64,
}

impl ControlGuard {
    /// Queues `bytes` as the terminal's input, sent in order with every user's. Past what a
    /// terminal holds unsent, all of them are refused, and that is the failure.
    pub fn write(&self, bytes: &[u8]) {
        self.control.write(bytes);
    }

    /// The last failure of input, until input works again.
    pub fn failure(&self) -> Option<StreamFailure> {
        lock(&self.control.shared.users).failure.clone()
    }
}

impl Drop for ControlGuard {
    fn drop(&mut self) {
        self.controls
            .release(&self.terminal_id, &self.control, self.user);
    }
}

/// What a stream's handle and its task share.
#[derive(Debug)]
struct View {
    closed: AtomicBool,
    state: Mutex<ViewState>,
    /// The stream's use of the control connection, given up as soon as either side closes it.
    guard: Mutex<Option<ControlGuard>>,
}

impl View {
    fn release(&self) {
        let guard = lock(&self.guard).take();
        drop(guard);
    }
}

#[derive(Debug)]
struct ViewState {
    size: Size,
    exited: Option<Exited>,
}

#[derive(Debug)]
enum StreamCommand {
    /// Answered once the stream has delivered everything before `at`; dropped if it closes first.
    Hold {
        at: Position,
        reply: oneshot::Sender<()>,
    },
    /// Asks the reader for its stats, which follow the `resized` of a resize applied, and checks
    /// the size it has then.
    Confirm {
        asked: Size,
        reply: oneshot::Sender<Result<(), StreamError>>,
    },
    Close,
}

/// A stream on its own reader connection, its events in `StreamEvents`. Dropping it closes it.
#[derive(Debug)]
pub struct HolderStream {
    commands: mpsc::UnboundedSender<StreamCommand>,
    control: Control,
    view: Arc<View>,
}

impl HolderStream {
    /// The terminal's size, as the stream last heard it.
    pub fn size(&self) -> Size {
        lock(&self.view.state).size
    }

    /// The exit of the stream's process, until a respawn replaces it.
    pub fn exited(&self) -> Option<Exited> {
        lock(&self.view.state).exited.clone()
    }

    pub fn is_closed(&self) -> bool {
        self.view.closed.load(Ordering::Acquire)
    }

    /// Sends `bytes` as input, through the terminal's control connection; nothing once closed. A
    /// failure is told as `StreamEvent::Failed`.
    pub fn write(&self, bytes: &[u8]) {
        if !self.is_closed() {
            self.control.write(bytes);
        }
    }

    /// Resizes the terminal, once the input written before has gone out, and resolves once this
    /// stream has heard the holder resize to it.
    ///
    /// # Errors
    ///
    /// Once the stream has closed; when the control connection fails or the holder refuses; or
    /// when the holder answered with another size, which `size` has then.
    pub async fn resize(&self, size: Size) -> Result<(), StreamError> {
        if self.is_closed() {
            return Err(StreamError::Closed);
        }
        self.control
            .resize(size)
            .await
            .map_err(StreamError::Control)?;
        // The holder applies the resize before it answers the writer. Stats asked for on the
        // reader after are answered after its `resized` and the output before it, even when the
        // offset stays the same; a resize that failed sends no `resized`.
        let (reply, confirmed) = oneshot::channel();
        let asked = StreamCommand::Confirm { asked: size, reply };
        if self.commands.send(asked).is_err() {
            return Err(StreamError::Closed);
        }
        confirmed.await.unwrap_or(Err(StreamError::Closed))
    }

    /// A snapshot taken on the control connection, held until this stream has delivered
    /// everything before it, so its events go on from where it ends.
    ///
    /// # Errors
    ///
    /// `Closed` once the stream has closed, and only once `StreamEvent::Closed` is queued for its
    /// events, behind those it has not taken;
    /// otherwise when the control connection or the holder fails it.
    pub async fn snapshot(&self) -> Result<HolderSnapshot, StreamError> {
        if self.is_closed() {
            return Err(StreamError::Closed);
        }
        let taken = self.control.snapshot().await;
        if self.is_closed() {
            return Err(StreamError::Closed);
        }
        let snapshot = taken.map_err(StreamError::Control)?;
        let at = Position {
            generation: snapshot.generation,
            offset: snapshot.offset,
        };
        let (reply, reached) = oneshot::channel();
        if self
            .commands
            .send(StreamCommand::Hold { at, reply })
            .is_err()
        {
            return Err(StreamError::Closed);
        }
        reached.await.map_err(|_| StreamError::Closed)?;
        Ok(snapshot)
    }

    /// Closes the stream, hanging up its connection: `Closed(Ended)` ends its events. Its use of
    /// the control connection ends at once.
    pub fn close(&self) {
        self.view.release();
        let _ = self.commands.send(StreamCommand::Close);
    }
}

impl Drop for HolderStream {
    fn drop(&mut self) {
        self.view.release();
    }
}

/// Attaches a stream on `reader`, resized first to `size` through the control connection, if
/// given. Its task runs in `tasks` until it closes, or `cancel` is cancelled.
pub(crate) async fn attach(
    reader: HolderClient,
    events: HolderEvents,
    (guard, notices): (ControlGuard, mpsc::UnboundedReceiver<Notice>),
    size: Option<Size>,
    tasks: &TaskTracker,
    cancel: &CancellationToken,
) -> Result<Attached, StreamError> {
    let control = guard.control.clone();
    if let Some(size) = size {
        // Asked before the reader subscribes: its snapshot is drawn at the new size.
        control.resize(size).await.map_err(StreamError::Control)?;
    }
    let size = size.unwrap_or(reader.hello().size);
    let history_lines = reader.hello().history_lines;
    let view = Arc::new(View {
        closed: AtomicBool::new(false),
        state: Mutex::new(ViewState { size, exited: None }),
        guard: Mutex::new(Some(guard)),
    });
    let (out, told) = mpsc::channel(EVENTS_QUEUED);
    let (commands, received) = mpsc::unbounded_channel();
    let (attached, snapshot) = oneshot::channel();
    let pump = Pump {
        attaching: Some(Attaching {
            subscribed: reader.attach(),
            reply: attached,
        }),
        reader,
        events,
        out: PollSender::new(out),
        undelivered: VecDeque::new(),
        view: Arc::clone(&view),
        commands: Some(received),
        notices: Some(notices),
        failing: false,
        at: None,
        snapshot: None,
        confirms: Vec::new(),
        held: Vec::new(),
        ended: false,
        stopped: Box::pin(cancel.clone().cancelled_owned()),
    };
    tasks.spawn(pump.run());
    let stream = HolderStream {
        commands,
        control,
        view,
    };
    let snapshot = snapshot.await.unwrap_or(Err(StreamError::Closed))?;
    Ok(Attached {
        vt: snapshot.bytes,
        offset: snapshot.offset,
        generation: snapshot.generation,
        history_lines,
        stream,
        events: StreamEvents(told),
    })
}

/// The attach's subscription, answered, and where its snapshot goes once it is taken.
struct Attaching {
    subscribed: Answer<()>,
    reply: oneshot::Sender<Result<HolderSnapshot, StreamError>>,
}

struct Confirming {
    answer: Answer<Stats>,
    asked: Size,
    reply: oneshot::Sender<Result<(), StreamError>>,
}

enum Woke {
    Stopped,
    /// Closed, with every event delivered that can be.
    Delivered,
    Command(Option<StreamCommand>),
    Attached(Result<(), RequestError>),
    Confirmed(Confirming, Result<Stats, RequestError>),
    Event(Option<HolderEvent>),
    Notice(Option<Notice>),
}

/// The task of a stream.
struct Pump {
    reader: HolderClient,
    events: HolderEvents,
    out: PollSender<StreamEvent>,
    /// Events made while `out` was full, in order; the reader's are read only once it is empty.
    undelivered: VecDeque<StreamEvent>,
    view: Arc<View>,
    /// Until the stream's handle is dropped.
    commands: Option<mpsc::UnboundedReceiver<StreamCommand>>,
    notices: Option<mpsc::UnboundedReceiver<Notice>>,
    /// Whether a failure has been told that no success has cleared.
    failing: bool,
    attaching: Option<Attaching>,
    /// Where the stream is, from the attach's snapshot on: before it, events describe the state
    /// it shows.
    at: Option<Position>,
    /// The attach's snapshot, until handed on.
    snapshot: Option<HolderSnapshot>,
    confirms: Vec<Confirming>,
    held: Vec<(Position, oneshot::Sender<()>)>,
    ended: bool,
    stopped: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl Pump {
    async fn run(mut self) {
        loop {
            match poll_fn(|cx| self.poll_wake(cx)).await {
                Woke::Stopped => {
                    // The runtime is stopping: what doesn't fit is dropped.
                    self.close(StreamEnd::Ended);
                    return;
                }
                Woke::Delivered => return,
                Woke::Command(None) => {
                    self.commands = None;
                    self.close(StreamEnd::Ended);
                }
                // Closed, what waits on the stream fails.
                Woke::Command(Some(StreamCommand::Hold { .. })) if self.ended => {}
                Woke::Command(Some(StreamCommand::Confirm { reply, .. })) if self.ended => {
                    let _ = reply.send(Err(StreamError::Closed));
                }
                Woke::Command(Some(StreamCommand::Hold { at, reply })) => {
                    if self.at.is_some_and(|now| now >= at) {
                        let _ = reply.send(());
                    } else {
                        self.held.push((at, reply));
                    }
                }
                Woke::Command(Some(StreamCommand::Confirm { asked, reply })) => {
                    let answer = self.reader.stats();
                    self.confirms.push(Confirming {
                        answer,
                        asked,
                        reply,
                    });
                }
                Woke::Attached(subscribed) => self.attached(subscribed),
                Woke::Confirmed(confirming, answered) => self.confirmed(confirming, answered),
                Woke::Event(Some(event)) => self.handle(event),
                Woke::Command(Some(StreamCommand::Close)) | Woke::Event(None) => {
                    self.close(StreamEnd::Ended);
                }
                Woke::Notice(Some(Notice::Failed(failure))) => {
                    if !self.failing {
                        self.failing = true;
                        self.push(StreamEvent::Failed(failure));
                    }
                }
                Woke::Notice(Some(Notice::Succeeded)) => self.failing = false,
                Woke::Notice(None) => self.notices = None,
            }
        }
    }

    fn poll_wake(&mut self, cx: &mut Context<'_>) -> Poll<Woke> {
        if self.stopped.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Woke::Stopped);
        }
        while !self.undelivered.is_empty() {
            match self.out.poll_reserve(cx) {
                Poll::Ready(Ok(())) => {
                    if let Some(event) = self.undelivered.pop_front() {
                        let _ = self.out.send_item(event);
                    }
                }
                // A consumer that dropped its events has the rest dropped.
                Poll::Ready(Err(_)) => self.undelivered.clear(),
                Poll::Pending => break,
            }
        }
        if self.ended && self.undelivered.is_empty() {
            return Poll::Ready(Woke::Delivered);
        }
        if let Some(commands) = &mut self.commands
            && let Poll::Ready(command) = commands.poll_recv(cx)
        {
            return Poll::Ready(Woke::Command(command));
        }
        if self.ended {
            return Poll::Pending;
        }
        if let Some(Attaching { subscribed, .. }) = &mut self.attaching
            && let Poll::Ready(subscribed) = Pin::new(subscribed).poll(cx)
        {
            return Poll::Ready(Woke::Attached(subscribed));
        }
        for at in 0..self.confirms.len() {
            if let Some(confirming) = self.confirms.get_mut(at)
                && let Poll::Ready(answered) = Pin::new(&mut confirming.answer).poll(cx)
            {
                let confirming = self.confirms.swap_remove(at);
                return Poll::Ready(Woke::Confirmed(confirming, answered));
            }
        }
        // Room for what the event makes, or no consumer to make it for: otherwise the reader's
        // events wait in its connection, which reads no more from the holder once they fill it.
        let room = self.undelivered.is_empty() && self.out.poll_reserve(cx).is_ready();
        if room && let Poll::Ready(event) = Pin::new(&mut self.events).poll_next(cx) {
            return Poll::Ready(Woke::Event(event));
        }
        if let Some(notices) = &mut self.notices
            && let Poll::Ready(notice) = notices.poll_recv(cx)
        {
            return Poll::Ready(Woke::Notice(notice));
        }
        Poll::Pending
    }

    fn attached(&mut self, subscribed: Result<(), RequestError>) {
        let Some(Attaching { reply, .. }) = self.attaching.take() else {
            return;
        };
        if let Err(e) = subscribed {
            let _ = reply.send(Err(StreamError::Reader(e)));
            self.close(StreamEnd::Ended);
            return;
        }
        // The snapshot reached the events before the subscription's answer.
        while self.at.is_none() {
            let Some(event) = self.events.try_recv() else {
                break;
            };
            self.handle(event);
        }
        if let Some(snapshot) = self.snapshot.take() {
            let _ = reply.send(Ok(snapshot));
        } else {
            let _ = reply.send(Err(StreamError::Unsnapshotted));
            self.close(StreamEnd::Ended);
        }
    }

    fn confirmed(&mut self, confirming: Confirming, answered: Result<Stats, RequestError>) {
        // Every event the holder sent before its answer is read by now.
        while !self.ended {
            let Some(event) = self.events.try_recv() else {
                break;
            };
            self.handle(event);
        }
        let Confirming { asked, reply, .. } = confirming;
        let confirmed = match answered {
            _ if self.ended => Err(StreamError::Closed),
            Err(e) => Err(StreamError::Reader(e)),
            Ok(_) => {
                let reported = lock(&self.view.state).size;
                if reported == asked {
                    Ok(())
                } else {
                    Err(StreamError::Unconfirmed { reported, asked })
                }
            }
        };
        let _ = reply.send(confirmed);
    }

    fn handle(&mut self, event: HolderEvent) {
        if self.ended {
            return;
        }
        let Some(at) = self.at else {
            self.before_snapshot(event);
            return;
        };
        match event {
            HolderEvent::Data { offset, bytes } => {
                let len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
                let next = Offset::new(offset.get().saturating_add(len)).unwrap_or(offset);
                self.at = Some(Position {
                    generation: at.generation,
                    offset: next,
                });
                let at = Position {
                    generation: at.generation,
                    offset,
                };
                self.push(StreamEvent::Data { at, bytes });
            }
            HolderEvent::Respawned(respawned) => {
                // One the stream's position has already passed told it nothing new.
                let Ok(start) = Offset::new(0) else { return };
                if respawned.generation <= at.generation {
                    return;
                }
                self.at = Some(Position {
                    generation: respawned.generation,
                    offset: start,
                });
                lock(&self.view.state).exited = None;
                self.push(StreamEvent::Respawned {
                    generation: respawned.generation,
                });
            }
            HolderEvent::Exited(exited) => {
                // The holder sends a generation's exit again after a subscription's `ok`, and an
                // earlier generation's belongs to a process a respawn has replaced.
                let mut state = lock(&self.view.state);
                if exited.generation != at.generation || state.exited.is_some() {
                    return;
                }
                state.exited = Some(exited.clone());
                drop(state);
                self.push(StreamEvent::Exited(exited));
                return;
            }
            HolderEvent::Resized(resized) => {
                let size = Size {
                    cols: resized.cols,
                    rows: resized.rows,
                };
                lock(&self.view.state).size = size;
                self.push(StreamEvent::Resized(size));
                return;
            }
            HolderEvent::Gap(_) => {
                self.close(StreamEnd::Behind);
                return;
            }
            HolderEvent::Ended(_) => {
                self.close(StreamEnd::Ended);
                return;
            }
            HolderEvent::Title(_)
            | HolderEvent::Alternate(_)
            | HolderEvent::Refused { .. }
            | HolderEvent::Snapshot(_) => return,
        }
        self.settle();
    }

    /// An event read before the attach's snapshot, which already shows what it did: a resize
    /// only sets the size the snapshot is told with, and a respawn is in it already.
    fn before_snapshot(&mut self, event: HolderEvent) {
        match event {
            HolderEvent::Snapshot(snapshot) => {
                self.at = Some(Position {
                    generation: snapshot.generation,
                    offset: snapshot.offset,
                });
                self.snapshot = Some(snapshot);
            }
            HolderEvent::Resized(resized) => {
                lock(&self.view.state).size = Size {
                    cols: resized.cols,
                    rows: resized.rows,
                };
            }
            HolderEvent::Ended(_) => self.close(StreamEnd::Ended),
            _ => {}
        }
    }

    /// Answers each snapshot held for a place the stream has reached.
    fn settle(&mut self) {
        let Some(now) = self.at else { return };
        let (reached, held): (Vec<_>, Vec<_>) = std::mem::take(&mut self.held)
            .into_iter()
            .partition(|(at, _)| now >= *at);
        self.held = held;
        for (_, reply) in reached {
            let _ = reply.send(());
        }
    }

    /// Delivers `event` after those still undelivered, or keeps it until there is room.
    fn push(&mut self, event: StreamEvent) {
        self.undelivered.push_back(event);
        while let Some(event) = self.undelivered.pop_front() {
            let Some(out) = self.out.get_ref() else {
                self.undelivered.clear();
                return;
            };
            match out.try_send(event) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(event)) => {
                    self.undelivered.push_front(event);
                    return;
                }
                // A consumer that dropped its events has the rest dropped as they come.
                Err(mpsc::error::TrySendError::Closed(_)) => self.undelivered.clear(),
            }
        }
    }

    /// Ends the stream, once: its events end with `Closed(why)`, then what waits on it fails.
    fn close(&mut self, why: StreamEnd) {
        if self.ended {
            return;
        }
        self.ended = true;
        self.reader.end();
        self.view.release();
        self.push(StreamEvent::Closed(why));
        self.view.closed.store(true, Ordering::Release);
        self.held.clear();
        for confirming in self.confirms.drain(..) {
            let _ = confirming.reply.send(Err(StreamError::Closed));
        }
        if let Some(Attaching { reply, .. }) = self.attaching.take() {
            let _ = reply.send(Err(StreamError::Closed));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use bazhen_holder_proto::body::{
        Alternate, ExitCode, ExitStatus, Gap, HelloReply, OkBody, Pid, Resized, Respawned,
        StartTime,
    };
    use bazhen_holder_proto::{Reply, Request, RequestId};
    use futures_util::future::Either;
    use tokio::net::UnixListener;
    use tokio::sync::watch;
    use tokio::task::JoinSet;
    use tokio::time::{Instant, sleep, timeout};

    use super::*;
    use crate::fake_holder::{FakeHolder, fake_hello};
    use crate::fake_host::{FakeHost, START};
    use crate::locator::HolderRef;
    use crate::runtime::{HolderRuntime, RuntimeOptions};
    use crate::sockets::HolderRoot;
    use crate::test_support::{TempDir, block_on, me};

    /// Runs `test` with the clock paused, moving a millisecond at a time once nothing else can
    /// run: the sockets have their turns at each step, and no wait, the test's or the runtime's,
    /// is a real one.
    fn run<F: Future>(test: F) -> F::Output {
        block_on(async {
            tokio::time::pause();
            let ticking = async {
                loop {
                    sleep(Duration::from_millis(1)).await;
                }
            };
            match select(pin!(test), pin!(ticking)).await {
                Either::Left((done, _)) => done,
                Either::Right(_) => panic!("the clock stopped"),
            }
        })
    }

    /// Waits for `done`, a millisecond at a time.
    async fn until(done: impl Fn() -> bool) {
        while !done() {
            sleep(Duration::from_millis(1)).await;
        }
    }

    /// How a fake terminal's holder answers, as `attachable` in `runtime.medium.test.ts`: an
    /// attach with VT `A` at `offset`, then `after`; each snapshot after the first is `later`
    /// bytes on, as output the reader hasn't had yet would be.
    #[derive(Debug, Clone)]
    struct Answers {
        hello: HelloReply,
        /// Whether a connection that asks for the writer slot is given it.
        grants: bool,
        offset: u64,
        later: u64,
        /// Sent ahead of the attach's snapshot, as events the holder had queued first.
        before_snapshot: Vec<Reply>,
        after: Vec<Reply>,
        /// Whether it hangs up the reader once it has subscribed.
        hang_up: bool,
        hold_stats: bool,
        /// Whether it leaves a `close` unanswered.
        hold_close: bool,
    }

    impl Answers {
        /// A holder of `terminal_id` that gives the writer slot and attaches at 5.
        fn of(terminal_id: &TerminalId) -> Self {
            let mut hello = fake_hello();
            hello.terminal_id =
                bazhen_holder_proto::body::TerminalId::new(terminal_id.as_str()).unwrap();
            Self {
                hello,
                grants: true,
                offset: 5,
                later: 0,
                before_snapshot: Vec::new(),
                after: Vec::new(),
                hang_up: false,
                hold_stats: false,
                hold_close: false,
            }
        }
    }

    /// What the test sends a connection's client.
    #[derive(Debug)]
    enum Outgoing {
        Replies(Vec<Reply>),
        HangUp,
    }

    /// One connection to a fake terminal.
    #[derive(Debug, Clone)]
    struct Conn {
        /// Where it is among the terminal's connections.
        index: usize,
        /// Whether its `hello` asked for the writer slot.
        asked: bool,
        /// What it was sent past `hello`.
        requests: Arc<Mutex<Vec<Request>>>,
        outbox: mpsc::UnboundedSender<Outgoing>,
        reading: Arc<watch::Sender<bool>>,
        /// Cancelled once it has hung up, either side.
        hung_up: CancellationToken,
        /// How many of the replies the test gave it it has written.
        sent: Arc<AtomicUsize>,
    }

    impl Conn {
        fn names(&self) -> Vec<String> {
            let requests = self.requests.lock().unwrap();
            requests.iter().map(|r| r.name().into_owned()).collect()
        }

        fn inputs(&self) -> Vec<Vec<u8>> {
            let requests = self.requests.lock().unwrap();
            requests
                .iter()
                .filter_map(|r| match r {
                    Request::Input { bytes, .. } => Some(bytes.clone()),
                    _ => None,
                })
                .collect()
        }

        fn send(&self, replies: Vec<Reply>) {
            self.outbox.send(Outgoing::Replies(replies)).unwrap();
        }
    }

    /// Every connection made to a fake terminal, in order, and what happened to them.
    #[derive(Debug, Clone, Default)]
    struct Seen {
        conns: Arc<Mutex<Vec<Conn>>>,
        log: Arc<Mutex<Vec<String>>>,
        /// When each `hello` asking for the writer slot came.
        asked_at: Arc<Mutex<Vec<Instant>>>,
        snapshots: Arc<AtomicUsize>,
    }

    impl Seen {
        fn conns(&self) -> Vec<Conn> {
            self.conns.lock().unwrap().clone()
        }

        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }

        fn writers(&self) -> Vec<Conn> {
            self.conns().into_iter().filter(|c| c.asked).collect()
        }

        /// The connection the stream subscribed on.
        fn reader(&self) -> Conn {
            self.conns()
                .into_iter()
                .find(|c| c.names().iter().any(|n| n == "subscribe"))
                .expect("no connection subscribed")
        }

        fn requests(&self) -> Vec<String> {
            self.conns().iter().flat_map(Conn::names).collect()
        }

        fn inputs(&self) -> Vec<Vec<u8>> {
            self.conns().iter().flat_map(Conn::inputs).collect()
        }
    }

    fn ok(id: RequestId, request: &str) -> Reply {
        let body = OkBody {
            request: request.to_owned(),
        };
        Reply::Ok { id, body }
    }

    fn stats(id: RequestId) -> Reply {
        let body = Stats {
            engine_bytes: 2048.try_into().unwrap(),
            rss: Some(8192.try_into().unwrap()),
            ring_bytes: 1024.try_into().unwrap(),
            history_lines: 7.try_into().unwrap(),
            engine_resets: None,
        };
        Reply::Stats { id, body }
    }

    fn answer(request: &Request, answers: &Answers, seen: &Seen) -> Vec<Reply> {
        let id = request.id();
        match request {
            Request::Snapshot { .. } => {
                let first = seen.snapshots.fetch_add(1, Ordering::Relaxed) == 0;
                let mut replies = if first {
                    answers.before_snapshot.clone()
                } else {
                    Vec::new()
                };
                let at = answers.offset + if first { 0 } else { answers.later };
                replies.push(Reply::Snapshot {
                    id,
                    offset: Offset::new(at).unwrap(),
                    dropped_lines: 0,
                    bytes: vec![0x41],
                });
                replies
            }
            Request::Subscribe { .. } => {
                let mut replies = vec![ok(id, "subscribe")];
                replies.extend(answers.after.iter().cloned());
                replies
            }
            Request::Stats { .. } if answers.hold_stats => Vec::new(),
            Request::Stats { .. } => vec![stats(id)],
            Request::Close { .. } if answers.hold_close => Vec::new(),
            Request::Input { .. } => Vec::new(),
            _ => vec![ok(id, &request.name())],
        }
    }

    enum Woke {
        Request(Option<Request>),
        Outgoing(Option<Outgoing>),
        Reading,
    }

    async fn connection(mut holder: FakeHolder, answers: Arc<Answers>, seen: Seen) {
        let Some(Request::Hello { id, body }) = holder.next().await else {
            return;
        };
        let asked = body.writer == Some(true);
        let mut hello = answers.hello.clone();
        hello.writer = asked && answers.grants;
        let (outbox, mut outgoing) = mpsc::unbounded_channel();
        let (reading, mut read) = watch::channel(true);
        let conn = {
            let mut conns = seen.conns.lock().unwrap();
            let conn = Conn {
                index: conns.len(),
                asked,
                requests: Arc::default(),
                outbox,
                reading: Arc::new(reading),
                hung_up: CancellationToken::new(),
                sent: Arc::default(),
            };
            conns.push(conn.clone());
            conn
        };
        let n = conn.index;
        let writer = if asked { " writer" } else { "" };
        seen.log.lock().unwrap().push(format!("hello {n}{writer}"));
        if asked {
            seen.asked_at.lock().unwrap().push(Instant::now());
        }
        holder.send(&[Reply::Hello { id, body: hello }]).await;
        let _hung_up = conn.hung_up.clone().drop_guard();
        loop {
            let reads = *read.borrow_and_update();
            let woke = {
                let next = pin!(async {
                    if reads {
                        Woke::Request(holder.next().await)
                    } else {
                        std::future::pending().await
                    }
                });
                let sent = pin!(async { Woke::Outgoing(outgoing.recv().await) });
                let changed = pin!(async {
                    if read.changed().await.is_err() {
                        std::future::pending::<()>().await;
                    }
                    Woke::Reading
                });
                match select(select(next, sent), changed).await {
                    Either::Left((Either::Left((woke, _)) | Either::Right((woke, _)), _))
                    | Either::Right((woke, _)) => woke,
                }
            };
            match woke {
                Woke::Request(None) => {
                    seen.log.lock().unwrap().push(format!("hung up {n}"));
                    return;
                }
                Woke::Request(Some(request)) => {
                    let replies = answer(&request, &answers, &seen);
                    let subscribed = matches!(request, Request::Subscribe { .. });
                    // A holder told to close ends, hanging up every connection.
                    let closed = matches!(request, Request::Close { .. });
                    conn.requests.lock().unwrap().push(request);
                    holder.send(&replies).await;
                    if (closed && !answers.hold_close) || (subscribed && answers.hang_up) {
                        return;
                    }
                }
                Woke::Outgoing(Some(Outgoing::Replies(replies))) => {
                    for reply in replies {
                        holder.send(&[reply]).await;
                        conn.sent.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Woke::Outgoing(Some(Outgoing::HangUp) | None) => return,
                Woke::Reading => {}
            }
        }
    }

    async fn serve(listener: UnixListener, answers: Arc<Answers>, seen: Seen) {
        let mut connections = JoinSet::new();
        while let Ok((stream, _)) = listener.accept().await {
            let holder = FakeHolder::new(stream);
            connections.spawn(connection(holder, Arc::clone(&answers), seen.clone()));
        }
    }

    /// A runtime, and a fake holder at one terminal's socket.
    struct Fixture {
        _dir: TempDir,
        root: HolderRoot,
        runtime: HolderRuntime,
        terminal: HolderRef,
        seen: Seen,
        servers: JoinSet<()>,
    }

    impl Fixture {
        /// The terminal of `attachable`, answering as `edit` makes `Answers`.
        fn attachable(edit: impl FnOnce(&mut Answers)) -> Self {
            Self::with(|_| {}, edit)
        }

        /// As `attachable`, the runtime's options as `options` makes them.
        fn with(
            options: impl FnOnce(&mut RuntimeOptions),
            edit: impl FnOnce(&mut Answers),
        ) -> Self {
            let dir = TempDir::new();
            let root = HolderRoot::of(&dir.path().join("run"), me());
            root.make_private(me()).unwrap();
            let mut runtime_options = RuntimeOptions::new(root.clone());
            runtime_options.hello = Duration::from_secs(5);
            options(&mut runtime_options);
            let runtime = HolderRuntime::with_host(runtime_options, Arc::new(FakeHost::default()));
            let terminal_id = TerminalId::mint(1, [1; 16]);
            let mut answers = Answers::of(&terminal_id);
            edit(&mut answers);
            answers.hello.offset = Offset::new(answers.offset).unwrap();
            let socket = Self::socket_in(&root, &terminal_id);
            let terminal = HolderRef {
                terminal_id,
                locator: HolderLocator::of(socket.clone(), &answers.hello),
            };
            let mut fixture = Self {
                _dir: dir,
                root,
                runtime,
                terminal,
                seen: Seen::default(),
                servers: JoinSet::new(),
            };
            fixture.seen = fixture.serve(answers);
            fixture
        }

        fn socket_in(root: &HolderRoot, terminal_id: &TerminalId) -> PathBuf {
            root.socket(&bazhen_holder_proto::body::TerminalId::new(terminal_id.as_str()).unwrap())
        }

        /// A fake holder answering as `answers` at the terminal's socket.
        fn serve(&mut self, answers: Answers) -> Seen {
            let socket = Self::socket_in(&self.root, &self.terminal.terminal_id);
            let listener = UnixListener::bind(socket).unwrap();
            let seen = Seen::default();
            self.servers
                .spawn(serve(listener, Arc::new(answers), seen.clone()));
            seen
        }

        async fn attach(&self, size: Option<Size>) -> Attached {
            self.runtime.attach(&self.terminal, size).await.unwrap()
        }
    }

    fn size(cols: u64, rows: u64) -> Size {
        Size {
            cols: cols.try_into().unwrap(),
            rows: rows.try_into().unwrap(),
        }
    }

    fn generation(n: u64) -> Generation {
        Generation::new(n).unwrap()
    }

    fn data(offset: u64, text: &str) -> Reply {
        Reply::Data {
            offset: Offset::new(offset).unwrap(),
            bytes: text.as_bytes().to_vec(),
        }
    }

    fn exit(n: u64) -> Exited {
        Exited {
            generation: generation(n),
            status: ExitStatus::Exited {
                code: ExitCode::new(0).unwrap(),
            },
        }
    }

    fn respawned(n: u64) -> Reply {
        Reply::Respawned(Respawned {
            generation: generation(n),
            child_pid: Pid::new(4242).unwrap(),
            child_start: StartTime::new(START).unwrap(),
        })
    }

    /// An event as the tests compare it.
    fn told(event: &StreamEvent) -> String {
        match event {
            StreamEvent::Data { at, bytes } => format!(
                "data {}:{} {}",
                at.generation.get(),
                at.offset.get(),
                String::from_utf8_lossy(bytes)
            ),
            StreamEvent::Respawned { generation } => format!("respawned {}", generation.get()),
            StreamEvent::Exited(exited) => format!("exited {}", exited.generation.get()),
            StreamEvent::Resized(size) => {
                format!("resized {}x{}", size.cols.get(), size.rows.get())
            }
            StreamEvent::Failed(failure) => format!("failed {}: {}", failure.what, failure.cause),
            StreamEvent::Closed(why) => format!("closed {why:?}"),
        }
    }

    /// The next `n` events.
    async fn next(events: &mut StreamEvents, n: usize) -> Vec<String> {
        let mut seen = Vec::new();
        while seen.len() < n {
            let event = events.recv().await.expect("the stream's events ended");
            seen.push(told(&event));
        }
        seen
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn attaches_on_the_holders_snapshot_and_delivers_what_follows_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| a.after = vec![data(5, "ab")]);
            let mut attached = fixture.attach(None).await;
            assert_eq!(
                (
                    attached.offset.get(),
                    attached.generation.get(),
                    attached.vt()
                ),
                (5, 0, [0x41].as_slice())
            );
            assert_eq!(next(&mut attached.events, 1).await, ["data 0:5 ab"]);
            attached.stream.close();
            assert_eq!(next(&mut attached.events, 1).await, ["closed Ended"]);
            assert!(attached.events.recv().await.is_none());
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn attaches_with_the_history_depth_its_holder_says_it_keeps() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| a.hello.history_lines = Count::new(321).unwrap());
            let attached = fixture.attach(None).await;
            assert_eq!(attached.history_lines.get(), 321);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn tells_a_respawn_before_the_next_processs_bytes_and_nothing_of_a_switch_of_screen() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let alternate = Alternate {
                offset: Offset::new(3).unwrap(),
                on: true,
            };
            let fixture = Fixture::attachable(|a| {
                a.offset = 0;
                a.after = vec![
                    data(0, "old"),
                    Reply::Alternate(alternate),
                    respawned(1),
                    data(0, "new"),
                ];
            });
            let mut attached = fixture.attach(None).await;
            assert_eq!(
                next(&mut attached.events, 3).await,
                ["data 0:0 old", "respawned 1", "data 1:0 new"]
            );
            attached.stream.close();
            assert_eq!(next(&mut attached.events, 1).await, ["closed Ended"]);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_a_stream_that_fell_behind_and_one_whose_holder_hung_up_saying_which() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let gap = Gap {
                from: Offset::new(0).unwrap(),
                to: Offset::new(9).unwrap(),
            };
            let behind = Fixture::attachable(|a| {
                a.offset = 0;
                a.after = vec![Reply::Gap(gap), data(9, "past")];
            });
            let ended = Fixture::attachable(|a| {
                a.offset = 0;
                a.hang_up = true;
            });
            let mut whys = Vec::new();
            for fixture in [&behind, &ended] {
                let mut attached = fixture.attach(None).await;
                whys.extend(next(&mut attached.events, 1).await);
                assert!(attached.events.recv().await.is_none());
                assert!(attached.stream.is_closed());
            }
            assert_eq!(whys, ["closed Behind", "closed Ended"]);
            // Behind, the stream hangs up its reader.
            until(|| behind.seen.reader().hung_up.is_cancelled()).await;
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn waits_for_the_reader_to_report_the_applied_size_after_the_writer_accepts_a_resize() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| a.hold_stats = true);
            let mut attached = fixture.attach(None).await;
            let stream = Arc::new(attached.stream);
            let reader = fixture.seen.reader();
            let asked = size(90, 35);
            let mut tasks = JoinSet::new();
            let resizing = Arc::clone(&stream);
            tasks.spawn(async move { resizing.resize(asked).await });
            until(|| fixture.seen.requests().iter().any(|r| r == "resize")).await;
            // The writer has taken its `ok` once it has answered the snapshot asked after it.
            stream.snapshot().await.unwrap();
            until(|| reader.names().iter().any(|r| r == "stats")).await;
            assert!(!tasks.is_empty() && tasks.try_join_next().is_none());
            let barrier = reader
                .requests
                .lock()
                .unwrap()
                .iter()
                .find(|r| matches!(r, Request::Stats { .. }))
                .unwrap()
                .id();
            let resized = Resized {
                offset: Offset::new(5).unwrap(),
                cols: asked.cols,
                rows: asked.rows,
            };
            reader.send(vec![Reply::Resized(resized), stats(barrier)]);
            tasks.join_next().await.unwrap().unwrap().unwrap();
            assert_eq!(stream.size(), asked);
            assert_eq!(next(&mut attached.events, 1).await, ["resized 90x35"]);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn reports_the_confirmed_reader_geometry_if_an_accepted_resize_produced_no_change() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let attached = fixture.attach(None).await;
            let before = attached.stream.size();
            let refused = attached.stream.resize(size(90, 35)).await.unwrap_err();
            assert_eq!(
                refused.to_string(),
                "holder reports 80x24 after resize to 90x35"
            );
            assert_eq!(attached.stream.size(), before);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_every_streams_input_and_resize_on_one_writer_connection_apart_from_its_reader() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let first = fixture.attach(Some(size(90, 30))).await;
            let second = fixture.attach(None).await;
            first.stream.write(b"a");
            second.stream.write(b"b");
            let writers = || -> Vec<Conn> {
                let conns = fixture.seen.conns();
                conns
                    .into_iter()
                    .filter(|c| !c.inputs().is_empty())
                    .collect()
            };
            until(|| writers().iter().flat_map(Conn::names).count() == 3).await;
            let [writer] = writers().try_into().unwrap();
            assert_eq!(writer.names(), ["resize", "input", "input"]);
            assert_eq!(writer.inputs(), [b"a", b"b"]);
            assert!(writer.asked);
            assert!(!fixture.seen.reader().asked);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn opens_a_new_writer_connection_only_once_the_old_one_has_hung_up() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let first = fixture.attach(Some(size(90, 30))).await;
            until(|| fixture.seen.writers().len() == 1).await;
            let old = fixture.seen.writers().remove(0);
            // A holder that has stopped reading holds the old connection's hang-up behind its
            // input.
            old.reading.send_replace(false);
            first.stream.write(&vec![0; 4 << 20]);
            sleep(Duration::from_millis(50)).await;
            first.stream.close();
            let mut second = pin!(
                fixture
                    .runtime
                    .attach(&fixture.terminal, Some(size(91, 30)))
            );
            assert!(
                timeout(Duration::from_millis(200), second.as_mut())
                    .await
                    .is_err()
            );
            assert_eq!(fixture.seen.writers().len(), 1);
            assert!(!old.hung_up.is_cancelled());
            old.reading.send_replace(true);
            let second = second.await.unwrap();
            let log = fixture.seen.log();
            let hung_up = log
                .iter()
                .position(|l| *l == format!("hung up {}", old.index));
            let writer = log.iter().rposition(|l| l.ends_with(" writer"));
            assert!(hung_up.is_some() && hung_up < writer, "{log:?}");
            assert_eq!(fixture.seen.writers().len(), 2);
            assert_eq!(old.inputs().concat().len(), 4 << 20);
            drop(second);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn asks_again_for_a_writer_slot_another_connection_holds_then_says_so_to_streams_later_too() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| a.grants = false);
            let mut attached = fixture.attach(None).await;
            attached.stream.write(b"a");
            assert_eq!(
                next(&mut attached.events, 1).await,
                ["failed input: another connection holds the terminal's writer slot"]
            );
            let asked = fixture.seen.writers();
            assert_eq!(asked.len(), 1 + WRITER_RETRY.len());
            for conn in &asked {
                conn.hung_up.cancelled().await;
            }
            assert_eq!(fixture.seen.inputs(), Vec::<Vec<u8>>::new());
            let mut late = fixture.attach(None).await;
            assert_eq!(
                next(&mut late.events, 1).await,
                ["failed input: another connection holds the terminal's writer slot"]
            );
            assert_eq!(fixture.seen.writers().len(), asked.len());
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn asks_again_for_the_writer_slot_after_each_wait_in_turn_then_gives_up() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| a.grants = false);
            let mut attached = fixture.attach(None).await;
            attached.stream.write(b"a");
            let failed = next(&mut attached.events, 1).await;
            assert_eq!(
                failed,
                ["failed input: another connection holds the terminal's writer slot"]
            );
            let at = fixture.seen.asked_at.lock().unwrap().clone();
            let waits: Vec<Duration> = at.windows(2).map(|w| w[1] - w[0]).collect();
            assert_eq!(waits.len(), WRITER_RETRY.len());
            // Each ask after a wait, its connect and the hang-up before it a few steps more.
            for (waited, wait) in waits.iter().zip(WRITER_RETRY) {
                assert!(
                    *waited >= wait && *waited < wait + Duration::from_millis(40),
                    "waited {waits:?} for {WRITER_RETRY:?}"
                );
            }
            // Nothing asks again once it has given up.
            sleep(Duration::from_secs(5)).await;
            assert_eq!(fixture.seen.writers().len(), 1 + WRITER_RETRY.len());
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn takes_a_respawn_sent_before_the_attachs_snapshot_as_what_it_shows() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let alternate = Alternate {
                offset: Offset::new(0).unwrap(),
                on: true,
            };
            let fixture = Fixture::attachable(|a| {
                a.offset = 0;
                a.before_snapshot = vec![Reply::Alternate(alternate), respawned(1)];
                a.after = vec![data(0, "new")];
            });
            let mut attached = fixture.attach(None).await;
            assert_eq!(attached.generation.get(), 1);
            assert_eq!(next(&mut attached.events, 1).await, ["data 1:0 new"]);
            attached.stream.close();
            assert_eq!(next(&mut attached.events, 1).await, ["closed Ended"]);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn tells_a_stream_its_processs_exit_in_order_with_the_output_once_and_never_a_replaced_ones() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| a.offset = 0);
            let mut attached = fixture.attach(None).await;
            let reader = fixture.seen.reader();
            reader.send(vec![
                data(0, "last"),
                Reply::Exited(exit(0)),
                data(4, "left"),
                Reply::Exited(exit(0)),
            ]);
            assert_eq!(
                next(&mut attached.events, 3).await,
                ["data 0:0 last", "exited 0", "data 0:4 left"]
            );
            assert_eq!(attached.stream.exited(), Some(exit(0)));
            reader.send(vec![respawned(1), Reply::Exited(exit(0)), data(0, "next")]);
            assert_eq!(
                next(&mut attached.events, 2).await,
                ["respawned 1", "data 1:0 next"]
            );
            assert_eq!(attached.stream.exited(), None);
            attached.stream.close();
            assert_eq!(next(&mut attached.events, 1).await, ["closed Ended"]);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_input_past_what_a_terminal_holds_unsent_and_sends_none_of_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let mut attached = fixture.attach(None).await;
            attached.stream.write(&vec![0; MAX_UNSENT_BYTES + 1]);
            let Some(StreamEvent::Failed(failure)) = attached.events.recv().await else {
                panic!("no failure told");
            };
            assert!(matches!(
                failure.cause,
                ControlError::OverUnsent { len } if len == MAX_UNSENT_BYTES + 1
            ));
            assert!(failure.cause.to_string().contains("over the"));
            attached.stream.write(b"a");
            until(|| !fixture.seen.inputs().is_empty()).await;
            assert_eq!(fixture.seen.inputs(), [b"a"]);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_a_streams_input_to_no_other_holder_that_takes_the_terminals_socket() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let mut fixture = Fixture::attachable(|_| {});
            let mut attached = fixture.attach(None).await;
            // The reader stays on the first; a second holder takes the socket's name.
            std::fs::remove_file(&fixture.terminal.locator.socket).unwrap();
            let mut answers = Answers::of(&fixture.terminal.terminal_id);
            answers.hello.holder_start = StartTime::new(START + 9).unwrap();
            let replaced = fixture.serve(answers);
            attached.stream.write(b"a");
            assert_eq!(
                next(&mut attached.events, 1).await,
                ["failed input: another holder serves the terminal's socket now"]
            );
            assert_eq!(replaced.conns().len(), 1);
            assert_eq!(replaced.requests(), Vec::<String>::new());
            assert_eq!(fixture.seen.inputs(), Vec::<Vec<u8>>::new());
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn holds_a_streams_snapshot_until_the_stream_has_delivered_every_byte_before_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| {
                a.offset = 0;
                a.later = 4;
            });
            let mut attached = fixture.attach(None).await;
            let mut snapshot = pin!(attached.stream.snapshot());
            // The control connection's snapshot is at 4, the reader still at 0.
            assert!(
                timeout(Duration::from_millis(50), snapshot.as_mut())
                    .await
                    .is_err()
            );
            fixture.seen.reader().send(vec![data(0, "abcd")]);
            let taken = snapshot.await.unwrap();
            assert_eq!((taken.offset.get(), taken.generation.get()), (4, 0));
            let delivered = attached.events.try_recv().map(|e| told(&e));
            assert_eq!(delivered.as_deref(), Some("data 0:0 abcd"));
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn settles_a_held_snapshot_once_a_respawn_carries_the_stream_past_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| {
                a.offset = 0;
                a.later = 4;
            });
            let mut attached = fixture.attach(None).await;
            let mut snapshot = pin!(attached.stream.snapshot());
            assert!(
                timeout(Duration::from_millis(50), snapshot.as_mut())
                    .await
                    .is_err()
            );
            fixture.seen.reader().send(vec![respawned(1)]);
            let taken = snapshot.await.unwrap();
            assert_eq!((taken.generation.get(), taken.offset.get()), (0, 4));
            let delivered = attached.events.try_recv().map(|e| told(&e));
            assert_eq!(delivered.as_deref(), Some("respawned 1"));
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn rejects_a_pending_snapshot_once_the_stream_has_closed_after_its_closed_event() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| {
                a.offset = 3;
                a.later = 10;
            });
            let mut attached = fixture.attach(None).await;
            let mut snapshot = pin!(attached.stream.snapshot());
            assert!(
                timeout(Duration::from_millis(50), snapshot.as_mut())
                    .await
                    .is_err()
            );
            fixture.seen.reader().outbox.send(Outgoing::HangUp).unwrap();
            assert!(matches!(snapshot.await, Err(StreamError::Closed)));
            let closed = attached.events.try_recv().map(|e| told(&e));
            assert_eq!(closed.as_deref(), Some("closed Ended"));
            let again = attached.stream.snapshot().await.unwrap_err();
            assert_eq!(again.to_string(), "the stream has closed");
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn tells_the_size_a_resize_before_the_attachs_snapshot_set_and_not_as_a_resize() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let resized = Resized {
                offset: Offset::new(0).unwrap(),
                cols: 100.try_into().unwrap(),
                rows: 40.try_into().unwrap(),
            };
            let fixture = Fixture::attachable(|a| {
                a.offset = 0;
                a.before_snapshot = vec![Reply::Resized(resized)];
                a.after = vec![data(0, "drawn")];
            });
            let mut attached = fixture.attach(None).await;
            assert_eq!(attached.stream.size(), size(100, 40));
            assert_eq!(next(&mut attached.events, 1).await, ["data 0:0 drawn"]);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn tells_a_failure_once_until_input_works_again() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let mut attached = fixture.attach(None).await;
            let over = vec![0; MAX_UNSENT_BYTES + 1];
            attached.stream.write(&over);
            attached.stream.write(&over);
            attached.stream.write(b"a");
            until(|| !fixture.seen.inputs().is_empty()).await;
            attached.stream.write(&over);
            let refused = format!(
                "failed input: refused {} bytes of input: over the {MAX_UNSENT_BYTES} bytes of input a terminal holds unsent",
                MAX_UNSENT_BYTES + 1
            );
            assert_eq!(
                next(&mut attached.events, 2).await,
                [refused.clone(), refused]
            );
            let more = timeout(Duration::from_millis(50), attached.events.recv()).await;
            assert!(
                more.is_err(),
                "told {:?}",
                more.ok().flatten().map(|e| told(&e))
            );
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn ends_the_control_connection_of_a_holder_that_stops_taking_input_once_it_has_drained_no_more()
    {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let mut attached = fixture.attach(None).await;
            attached.stream.write(b"a");
            until(|| !fixture.seen.inputs().is_empty()).await;
            let [writer] = fixture.seen.writers().try_into().unwrap();
            writer.reading.send_replace(false);
            // What the holder doesn't read fills the connection's unsent cap, and more waits.
            let started = Instant::now();
            attached.stream.write(&vec![0; MAX_UNSENT_BYTES]);
            sleep(Duration::from_millis(50)).await;
            attached.stream.write(&vec![0; 2 * INPUT_PART]);
            assert_eq!(
                next(&mut attached.events, 1).await,
                ["failed input: the holder stopped taking input"]
            );
            let waited = started.elapsed();
            assert!(
                waited >= DRAIN && waited < DRAIN + Duration::from_secs(1),
                "{waited:?}"
            );
            // Hung up, as the holder sees once it reads again.
            writer.reading.send_replace(true);
            writer.hung_up.cancelled().await;
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn hangs_up_the_control_connection_of_a_terminal_it_closes() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let attached = fixture.attach(None).await;
            attached.stream.write(b"a");
            until(|| !fixture.seen.inputs().is_empty()).await;
            let [writer] = fixture.seen.writers().try_into().unwrap();
            fixture.runtime.close(&fixture.terminal).await.unwrap();
            writer.hung_up.cancelled().await;
            assert!(
                fixture
                    .seen
                    .log()
                    .contains(&format!("hung up {}", writer.index))
            );
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn writes_through_a_terminals_control_connection_with_no_stream_open() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let guard = fixture.runtime.control(&fixture.terminal).unwrap();
            guard.write(b"ls\n");
            until(|| !fixture.seen.inputs().is_empty()).await;
            assert_eq!(fixture.seen.inputs(), [b"ls\n"]);
            let [writer] = fixture.seen.writers().try_into().unwrap();
            assert_eq!(writer.names(), ["input"]);
            assert_eq!(guard.failure().map(|f| f.cause.to_string()), None);
        });
    }

    #[test]
    fn takes_each_write_whole_so_no_other_users_input_goes_out_inside_it() {
        let hello = fake_hello();
        let (commands, mut received) = mpsc::unbounded_channel();
        let control = Control {
            locator: HolderLocator::of(PathBuf::from("/nowhere"), &hello),
            commands,
            shared: Arc::default(),
        };
        let other = control.clone();
        let big: Vec<u8> = (0..=u8::MAX).cycle().take(2 * INPUT_PART + 1).collect();
        control.write(&big);
        other.write(b"b");
        let mut taken = Vec::new();
        while let Ok(command) = received.try_recv() {
            match command {
                Command::Input(bytes) => taken.push(bytes),
                other => panic!("took {other:?}"),
            }
        }
        assert_eq!(taken.len(), 2);
        assert!(taken[0] == big, "the first write was taken in parts");
        assert_eq!(taken[1], b"b");
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_what_a_guard_wrote_before_it_dropped() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let guard = fixture.runtime.control(&fixture.terminal).unwrap();
            // Its connection is still opening as the guard drops.
            guard.write(b"ls\n");
            drop(guard);
            until(|| !fixture.seen.inputs().is_empty()).await;
            assert_eq!(fixture.seen.inputs(), [b"ls\n"]);
            let [writer] = fixture.seen.writers().try_into().unwrap();
            writer.hung_up.cancelled().await;
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn gives_up_the_input_a_dropped_guard_left_once_its_drain_has_passed() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let drain = Duration::from_millis(300);
            let fixture = Fixture::with(|o| o.drain = drain, |a| a.grants = false);
            let guard = fixture.runtime.control(&fixture.terminal).unwrap();
            guard.write(b"ls\n");
            let dropped = Instant::now();
            drop(guard);
            // The next control connection opens once the last has closed.
            let next = fixture.runtime.control(&fixture.terminal).unwrap();
            next.write(b"pwd\n");
            sleep(Duration::from_secs(3)).await;
            let asked = fixture.seen.asked_at.lock().unwrap().clone();
            // Asked at 0, 50 and 250 ms; the ask at 1050 is past the drain, and never made.
            let ending: Vec<_> = asked
                .iter()
                .take_while(|at| **at - dropped < drain)
                .collect();
            assert_eq!(ending.len(), 3, "{asked:?}");
            let opened = asked[3] - dropped;
            assert!(
                opened >= drain && opened < drain + Duration::from_millis(40),
                "the next opened {opened:?} after the drop"
            );
            assert_eq!(fixture.seen.inputs(), Vec::<Vec<u8>>::new());
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn ends_a_stream_whose_consumer_stalls_behind_once_it_reads_again() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| a.offset = 0);
            let mut attached = fixture.attach(None).await;
            let reader = fixture.seen.reader();
            let frame = 4096;
            let frames = 2000;
            let mut replies: Vec<Reply> = (0..frames)
                .map(|n| Reply::Data {
                    offset: Offset::new(u64::try_from(n * frame).unwrap()).unwrap(),
                    bytes: vec![b'x'; frame],
                })
                .collect();
            let end = Offset::new(u64::try_from(frames * frame).unwrap()).unwrap();
            let gap = Gap {
                from: end,
                to: Offset::new(end.get() + 1).unwrap(),
            };
            replies.push(Reply::Gap(gap));
            reader.send(replies);
            // Nothing read: what the stream holds is bounded, so the holder is held up too.
            sleep(Duration::from_secs(2)).await;
            let sent = reader.sent.load(Ordering::Relaxed);
            assert!(
                sent < frames,
                "the holder wrote all {sent} with nothing read"
            );
            let mut data = 0;
            let closed = loop {
                match attached.events.recv().await.expect("the events ended") {
                    StreamEvent::Data { .. } => data += 1,
                    StreamEvent::Closed(why) => break why,
                    other => panic!("told {}", told(&other)),
                }
            };
            assert_eq!((data, closed), (frames, StreamEnd::Behind));
            assert!(attached.events.recv().await.is_none());
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn reconnects_the_users_left_of_a_closed_terminal_only_once_its_old_connection_hung_up() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|_| {});
            let guard = fixture.runtime.control(&fixture.terminal).unwrap();
            guard.write(b"a");
            until(|| !fixture.seen.inputs().is_empty()).await;
            let [old] = fixture.seen.writers().try_into().unwrap();
            // A holder that has stopped reading holds the old connection's hang-up behind its
            // input.
            old.reading.send_replace(false);
            guard.write(&vec![0; 4 << 20]);
            sleep(Duration::from_millis(50)).await;
            fixture.runtime.close(&fixture.terminal).await.unwrap();
            guard.write(b"b");
            sleep(Duration::from_millis(200)).await;
            assert_eq!(fixture.seen.writers().len(), 1);
            assert!(!old.hung_up.is_cancelled());
            old.reading.send_replace(true);
            until(|| fixture.seen.writers().len() == 2).await;
            let log = fixture.seen.log();
            let hung_up = log
                .iter()
                .position(|l| *l == format!("hung up {}", old.index));
            let writer = log.iter().rposition(|l| l.ends_with(" writer"));
            assert!(hung_up.is_some() && hung_up < writer, "{log:?}");
            let new = fixture.seen.writers().remove(1);
            until(|| !new.inputs().is_empty()).await;
            assert_eq!(new.inputs(), [b"b"]);
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn hangs_up_the_control_connection_of_a_terminal_whose_close_was_dropped_part_way() {
        bazhen_test_signal::require_sandbox().unwrap();
        run(async {
            let fixture = Fixture::attachable(|a| a.hold_close = true);
            let guard = fixture.runtime.control(&fixture.terminal).unwrap();
            guard.write(b"a");
            until(|| !fixture.seen.inputs().is_empty()).await;
            let [writer] = fixture.seen.writers().try_into().unwrap();
            let closing = fixture.runtime.close(&fixture.terminal);
            assert!(timeout(Duration::from_millis(200), closing).await.is_err());
            assert!(fixture.seen.requests().iter().any(|r| r == "close"));
            writer.hung_up.cancelled().await;
        });
    }
}
