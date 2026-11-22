//! One connection to a holder, as `client.ts`'s `HolderClient` is: `hello` first, then requests
//! whose replies come back to the call that sent them, by id, and events, which go to a stream of
//! their own in the order the holder sent them, ending with how the connection ended.
//!
//! A request is sent as it is called, and its answer is an `Answer` to await; dropping that
//! abandons the request, and an answer arriving later is dropped. A connection that never
//! subscribes still gets what a holder pushes to every connection, `exited`, `respawned` and
//! `title` among them, which is what a watcher of the holder's child holds one for.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::io;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::pin::{Pin, pin};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use bazhen_holder_proto::body::{
    Alternate, Count, ErrorBody, ErrorCode, Exited, Foreground, Gap, Generation, HelloReply,
    HelloRequest, Offset, PasteRequest, ProcessSpec, Resized, Respawned, Screen, ScreenRequest,
    SetTagsRequest, SetThemeRequest, Signal, SignalRequest, Size, Stats, SubscribeFrom,
    SubscribeRequest, Tags, Theme, Title, Versions,
};
use bazhen_holder_proto::{
    EncodeError, FrameDecoder, MAX_REQUEST_BYTES, Reply, Request, RequestId, reply_decoder,
};
use futures_util::future::{Either, select};
use futures_util::stream::Stream;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::request_ids::next_request_id;

/// The most a connection holds written but not yet taken by the holder. A write that would go
/// past it ends the connection rather than queue it, so a holder that stopped reading can't grow
/// the daemon without bound. A caller sending more than one holder keeps up with checks `room`,
/// or awaits `drained`, first.
pub const MAX_UNSENT_BYTES: usize = 8 * MAX_REQUEST_BYTES;
/// How long a hang-up waits for the holder to take what is still unsent.
pub const HANG_UP: Duration = Duration::from_secs(5);
/// How long `connect` waits for the socket and the holder's `hello`.
pub const CONNECT: Duration = Duration::from_secs(5);
/// The events a connection holds for a consumer that hasn't taken them, past which it reads no
/// more from the holder until it does.
pub const EVENTS_QUEUED: usize = 256;
/// What one `input` frame carries: the cap less the type byte and the request id.
const INPUT_CHUNK: usize = MAX_REQUEST_BYTES - 1 - 4;
/// What each `input` frame adds to its bytes: the length, the type byte and the request id.
const INPUT_OVERHEAD: usize = 4 + 1 + 4;
/// The most read from the socket at once.
const READ_CHUNK: usize = 64 << 10;

/// How a connection is opened.
#[derive(Debug, Clone)]
pub struct ClientOptions {
    /// Ask for the slot whose `input` and `resize` the holder takes; `hello().writer` says whether
    /// it was given. To take it over from a connection of this process, `end()` that one and
    /// await its `closed()` first: a connection opened before the holder has seen the old one end
    /// is told `writer: false`, which is then true.
    pub writer: bool,
    /// How long `connect` waits for the socket and `hello`.
    pub connect: Duration,
    /// How long a hang-up waits for the holder to take what is unsent.
    pub hang_up: Duration,
    /// The token whose cancelling ends the connection at once, as the daemon's shutdown does.
    pub cancel: CancellationToken,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            writer: false,
            connect: CONNECT,
            hang_up: HANG_UP,
            cancel: CancellationToken::new(),
        }
    }
}

/// A snapshot, with the generation it is of: the one current as the holder answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolderSnapshot {
    pub offset: Offset,
    pub dropped_lines: u32,
    /// VT that draws the terminal as of `offset`.
    pub bytes: Vec<u8>,
    pub generation: Generation,
}

/// What the holder sends unasked, in the order it sent it. `Snapshot` is an `attach`'s, in its
/// place ahead of the output that follows it; `Refused` is an `input` the holder turned down.
/// `Ended` comes last, once, after which the stream has nothing more.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HolderEvent {
    Data {
        offset: Offset,
        bytes: Vec<u8>,
    },
    Gap(Gap),
    Resized(Resized),
    Title(Title),
    Alternate(Alternate),
    Exited(Exited),
    Respawned(Respawned),
    Snapshot(HolderSnapshot),
    Refused {
        id: RequestId,
        refusal: HolderRefusal,
    },
    Ended(HolderEnd),
}

/// The holder answered a request with `error`. A code newer than this build reads as `Failed`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("holder refused {request}: {raw_code}: {reason}")]
pub struct HolderRefusal {
    pub code: ErrorCode,
    /// The code as the holder sent it.
    pub raw_code: String,
    pub request: String,
    /// Why, as the holder said it.
    pub reason: String,
    /// The holder's versions, sent with `no-shared-version`.
    pub protocol: Option<Versions>,
}

impl From<ErrorBody> for HolderRefusal {
    fn from(body: ErrorBody) -> Self {
        Self {
            code: body.known_code(),
            raw_code: body.code,
            request: body.request,
            reason: body.message,
            protocol: body.protocol,
        }
    }
}

/// Why a connection ended.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HolderEnd {
    /// Hung up, by either side.
    #[error("hung up")]
    Eof,
    /// The holder sent a frame that broke the protocol.
    #[error("broke the protocol: {0}")]
    Malformed(String),
    #[error("{message}")]
    Io {
        kind: io::ErrorKind,
        message: String,
    },
    /// The holder stopped taking what was written.
    #[error("over the unsent cap of {MAX_UNSENT_BYTES} bytes: {unsent} unsent and {more} more")]
    OverCap { unsent: usize, more: usize },
    /// A `subscribe` or `attach` was dropped once sent, after which output could run without its
    /// place being known.
    #[error("{request} abandoned once sent")]
    Abandoned { request: String },
    /// A half of an `attach` was refused, after which output could run without its snapshot.
    #[error("{0}")]
    Refused(HolderRefusal),
}

impl HolderEnd {
    fn io(error: &io::Error) -> Self {
        Self::Io {
            kind: error.kind(),
            message: error.to_string(),
        }
    }
}

/// The connection ended before the request was answered, or before it was sent.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("holder connection ended: {end}")]
pub struct HolderDisconnected {
    pub end: HolderEnd,
}

/// Why a request got no answer.
#[derive(Debug, thiserror::Error)]
pub enum RequestError {
    #[error(transparent)]
    Refused(HolderRefusal),
    #[error(transparent)]
    Disconnected(HolderDisconnected),
    /// The request can't be framed: a body over the cap.
    #[error("the request can't be sent")]
    Unsendable(#[source] EncodeError),
}

/// Why input wasn't sent.
#[derive(Debug, thiserror::Error)]
pub enum InputError {
    /// More than a connection may hold unsent, in one call; none of it was sent.
    #[error(
        "input of {len} bytes is over the {MAX_UNSENT_BYTES} a holder connection holds unsent; send it in parts"
    )]
    TooLarge { len: usize },
    #[error(transparent)]
    Disconnected(HolderDisconnected),
    #[error("the input can't be sent")]
    Unsendable(#[source] EncodeError),
}

/// Why `connect` has no connection.
#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    /// Nothing listens at the socket: no file, or a holder gone and its file left.
    #[error("can't connect to the holder at {}", .path.display())]
    Connect {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("the holder at {} didn't answer hello within {after:?}", .path.display())]
    Timeout { path: PathBuf, after: Duration },
    /// The holder refused `hello`, `no-shared-version` among the reasons, or hung up first.
    #[error("the holder at {} didn't take hello", .path.display())]
    Hello {
        path: PathBuf,
        #[source]
        source: Box<RequestError>,
    },
}

/// The answer to one request. Dropping it abandons the request: the holder may still act on it,
/// and an answer arriving later is dropped. Dropping a `subscribe`'s or an `attach`'s ends the
/// connection, as the holder may already be sending output from a place no one will know.
#[must_use = "a request whose answer is dropped is abandoned"]
pub struct Answer<T>(Pin<Box<dyn Future<Output = Result<T, RequestError>> + Send>>);

impl<T> fmt::Debug for Answer<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Answer").finish_non_exhaustive()
    }
}

impl<T> Future for Answer<T> {
    type Output = Result<T, RequestError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.0.as_mut().poll(cx)
    }
}

impl<T: Send + 'static> Answer<T> {
    fn failed(error: RequestError) -> Self {
        Self(Box::pin(async move { Err(error) }))
    }
}

/// A connection's events, in the order the holder sent them, ending with `HolderEvent::Ended`.
/// They queue up to `EVENTS_QUEUED` for a consumer that hasn't taken them, and the connection
/// reads no more from the holder meanwhile, answers included; once this is dropped, they are
/// dropped as they come. So it is drained or dropped, never left.
#[derive(Debug)]
pub struct HolderEvents(mpsc::Receiver<HolderEvent>);

impl HolderEvents {
    /// The next event, or `None` after `Ended`.
    pub async fn recv(&mut self) -> Option<HolderEvent> {
        self.0.recv().await
    }

    /// The next event if one has come.
    pub fn try_recv(&mut self) -> Option<HolderEvent> {
        self.0.try_recv().ok()
    }
}

impl Stream for HolderEvents {
    type Item = HolderEvent;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<HolderEvent>> {
        self.0.poll_recv(cx)
    }
}

/// An answer as the reader gives it to the request waiting for it.
enum Answered {
    Hello(HelloReply),
    Snapshot(HolderSnapshot),
    Stats(Stats),
    Foreground(Foreground),
    Screen(Screen),
    Ok,
}

impl Answered {
    fn into_hello(self) -> Option<HelloReply> {
        match self {
            Self::Hello(hello) => Some(hello),
            _ => None,
        }
    }

    fn into_snapshot(self) -> Option<HolderSnapshot> {
        match self {
            Self::Snapshot(snapshot) => Some(snapshot),
            _ => None,
        }
    }

    fn into_stats(self) -> Option<Stats> {
        match self {
            Self::Stats(stats) => Some(stats),
            _ => None,
        }
    }

    fn into_foreground(self) -> Option<Foreground> {
        match self {
            Self::Foreground(foreground) => Some(foreground),
            _ => None,
        }
    }

    fn into_screen(self) -> Option<Screen> {
        match self {
            Self::Screen(screen) => Some(screen),
            _ => None,
        }
    }

    fn into_ok(self) -> Option<()> {
        matches!(self, Self::Ok).then_some(())
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Hello(_) => "hello",
            Self::Snapshot(_) => "snapshot",
            Self::Stats(_) => "stats",
            Self::Foreground(_) => "foreground",
            Self::Screen(_) => "screen",
            Self::Ok => "ok",
        }
    }
}

/// What became of an answer offered to the request with its id.
enum Offered {
    Taken,
    /// Of another kind than the request takes.
    Wrong,
    /// Before the answer the request comes after.
    Early,
}

/// Where a request's answer goes.
trait Slot: Send {
    fn offer(self: Box<Self>, answered: Answered, early: bool) -> Offered;
    fn fail(self: Box<Self>, error: RequestError);
}

struct Typed<T> {
    answer: oneshot::Sender<Result<T, RequestError>>,
    take: fn(Answered) -> Option<T>,
}

impl<T: Send> Slot for Typed<T> {
    fn offer(self: Box<Self>, answered: Answered, early: bool) -> Offered {
        match (self.take)(answered) {
            None => Offered::Wrong,
            Some(_) if early => Offered::Early,
            Some(value) => {
                // Only a waiter being dropped has gone, and it abandoned the request.
                let _ = self.answer.send(Ok(value));
                Offered::Taken
            }
        }
    }

    fn fail(self: Box<Self>, error: RequestError) {
        // Only a waiter being dropped has gone, and it abandoned the request.
        let _ = self.answer.send(Err(error));
    }
}

enum To {
    Caller(Box<dyn Slot>),
    /// An `attach`'s snapshot, which goes to the events in its place.
    Events,
}

struct Pending {
    request: String,
    to: To,
    /// Whether the holder refusing it ends the connection.
    ends_on_refusal: bool,
    /// The request whose answer must come first: an answer before it breaks the protocol.
    after: Option<u32>,
}

impl Pending {
    fn fail(self, error: RequestError) {
        if let To::Caller(slot) = self.to {
            slot.fail(error);
        }
    }
}

struct State {
    pending: HashMap<u32, Pending>,
    last_id: u32,
    /// The generation of what the holder sends now: `hello`'s, then each `respawned`'s.
    generation: Option<Generation>,
    end: Option<HolderEnd>,
}

impl State {
    fn take_id(&mut self) -> u32 {
        let id = next_request_id(self.last_id, |id| self.pending.contains_key(&id));
        self.last_id = id;
        id
    }
}

enum Outgoing {
    Frames(Vec<u8>),
    /// Shut down this side, once what is before it is written.
    HangUp,
}

/// What a connection's caller, its reader and its writer share.
struct Shared {
    state: Mutex<State>,
    /// Bytes queued and not yet written to the socket.
    unsent: watch::Sender<usize>,
    outbox: mpsc::UnboundedSender<Outgoing>,
    /// Cancelled once the connection has ended: nothing more is read, or answered.
    ended: CancellationToken,
    /// Cancelled to drop the socket at once, with nothing more written.
    stop: CancellationToken,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic under the lock leaves the state whole: each change under it is one assignment.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn end(&self) -> HolderEnd {
        self.lock().end.clone().unwrap_or(HolderEnd::Eof)
    }

    fn disconnected(&self) -> Option<HolderDisconnected> {
        self.lock()
            .end
            .clone()
            .map(|end| HolderDisconnected { end })
    }

    /// Ends the connection, once, failing every request waiting.
    fn finish(&self, end: HolderEnd) -> bool {
        let waiting = {
            let mut state = self.lock();
            if state.end.is_some() {
                return false;
            }
            state.end = Some(end.clone());
            std::mem::take(&mut state.pending)
        };
        let gone = HolderDisconnected { end };
        for pending in waiting.into_values() {
            pending.fail(RequestError::Disconnected(gone.clone()));
        }
        self.ended.cancel();
        true
    }

    /// Ends the connection and drops the socket at once.
    fn fail(&self, end: HolderEnd) {
        self.finish(end);
        self.stop.cancel();
    }

    /// Ends the connection, leaving what is unsent `hang_up` to reach the holder.
    fn hang_up(&self) {
        if self.finish(HolderEnd::Eof) {
            // The writer holds the receiver until it stops, and then nothing is left to hang up.
            let _ = self.outbox.send(Outgoing::HangUp);
        }
    }

    /// Queues `bytes`, or ends the connection when they would go past the unsent cap.
    fn send(&self, bytes: Vec<u8>) -> Result<(), HolderDisconnected> {
        let more = bytes.len();
        let mut over = None;
        self.unsent.send_if_modified(|unsent| {
            if *unsent + more <= MAX_UNSENT_BYTES {
                *unsent += more;
                true
            } else {
                over = Some(*unsent);
                false
            }
        });
        if let Some(unsent) = over {
            self.fail(HolderEnd::OverCap { unsent, more });
            return Err(HolderDisconnected { end: self.end() });
        }
        // The writer holds the receiver until it stops, and then the connection has ended.
        let _ = self.outbox.send(Outgoing::Frames(bytes));
        Ok(())
    }
}

/// Removes its request from those waiting when its answer is dropped unanswered.
struct Waiter {
    shared: Arc<Shared>,
    id: u32,
    /// The request, when abandoning it ends the connection.
    abandon: Option<&'static str>,
}

impl Drop for Waiter {
    fn drop(&mut self) {
        let removed = self.shared.lock().pending.remove(&self.id);
        if removed.is_some()
            && let Some(request) = self.abandon
        {
            self.shared.fail(HolderEnd::Abandoned {
                request: request.to_owned(),
            });
        }
    }
}

fn waiting<T: Send + 'static>(
    waiter: Waiter,
    answer: oneshot::Receiver<Result<T, RequestError>>,
) -> Answer<T> {
    Answer(Box::pin(async move {
        let shared = Arc::clone(&waiter.shared);
        let answered = answer.await;
        drop(waiter);
        if let Ok(answered) = answered {
            return answered;
        }
        // Dropped unanswered only as the connection ends.
        shared.ended.cancelled().await;
        Err(RequestError::Disconnected(HolderDisconnected {
            end: shared.end(),
        }))
    }))
}

/// Sends a request answered by `take`'s kind of reply or by `error`.
fn ask<T: Send + 'static>(
    shared: &Arc<Shared>,
    build: impl FnOnce(RequestId) -> Request,
    take: fn(Answered) -> Option<T>,
    abandon: Option<&'static str>,
) -> Answer<T> {
    let (answer, answered) = oneshot::channel();
    let (id, frame) = {
        let mut state = shared.lock();
        if let Some(end) = &state.end {
            return Answer::failed(RequestError::Disconnected(HolderDisconnected {
                end: end.clone(),
            }));
        }
        let id = state.take_id();
        let request = build(RequestId(id));
        let frame = match request.encode() {
            Ok(frame) => frame,
            Err(e) => return Answer::failed(RequestError::Unsendable(e)),
        };
        let slot = Typed { answer, take };
        state.pending.insert(
            id,
            Pending {
                request: request.name().into_owned(),
                to: To::Caller(Box::new(slot)),
                ends_on_refusal: false,
                after: None,
            },
        );
        (id, frame)
    };
    let waiter = Waiter {
        shared: Arc::clone(shared),
        id,
        abandon,
    };
    // Over the cap, the connection ends, which fails the request.
    let _ = shared.send(frame);
    waiting(waiter, answered)
}

/// What the reader does with a frame once it is dispatched.
enum Step {
    Nothing,
    Event(HolderEvent),
    End(HolderEnd),
}

/// Gives a frame to the request it answers, or makes it an event.
fn dispatch(state: &mut State, frame: Reply) -> Step {
    match frame {
        Reply::Hello { id, body } => {
            state.generation = Some(body.generation);
            answer(state, id, Answered::Hello(body))
        }
        Reply::Snapshot {
            id,
            offset,
            dropped_lines,
            bytes,
        } => {
            let Some(generation) = state.generation else {
                return Step::End(HolderEnd::Malformed(format!(
                    "snapshot {} before hello",
                    id.0
                )));
            };
            let snapshot = HolderSnapshot {
                offset,
                dropped_lines,
                bytes,
                generation,
            };
            answer(state, id, Answered::Snapshot(snapshot))
        }
        Reply::Stats { id, body } => answer(state, id, Answered::Stats(body)),
        Reply::Foreground { id, body } => answer(state, id, Answered::Foreground(body)),
        Reply::Screen { id, body } => answer(state, id, Answered::Screen(body)),
        Reply::Ok { id, .. } => answer(state, id, Answered::Ok),
        Reply::Error { id, body } => refuse(state, id, body.into()),
        Reply::Data { offset, bytes } => Step::Event(HolderEvent::Data { offset, bytes }),
        Reply::Gap(gap) => Step::Event(HolderEvent::Gap(gap)),
        Reply::Resized(resized) => Step::Event(HolderEvent::Resized(resized)),
        Reply::Title(title) => Step::Event(HolderEvent::Title(title)),
        Reply::Alternate(alternate) => Step::Event(HolderEvent::Alternate(alternate)),
        Reply::Exited(exited) => Step::Event(HolderEvent::Exited(exited)),
        Reply::Respawned(respawned) => {
            state.generation = Some(respawned.generation);
            Step::Event(HolderEvent::Respawned(respawned))
        }
        // This build sends only requests it knows, whose answers it knows too.
        Reply::Unknown { code, id } => {
            match id.and_then(|id| state.pending.get(&id.0).map(|p| (id, p))) {
                Some((id, pending)) => Step::End(HolderEnd::Malformed(format!(
                    "reply {code:#x} answered {} {}",
                    pending.request, id.0
                ))),
                None => Step::Nothing,
            }
        }
    }
}

fn answer(state: &mut State, id: RequestId, answered: Answered) -> Step {
    // An answer to a request abandoned is dropped, as any late answer is.
    let Some(pending) = state.pending.remove(&id.0) else {
        return Step::Nothing;
    };
    let early = pending
        .after
        .is_some_and(|after| state.pending.contains_key(&after));
    let kind = answered.name();
    let offered = match pending.to {
        To::Caller(slot) => slot.offer(answered, early),
        To::Events => match answered {
            Answered::Snapshot(snapshot) => return Step::Event(HolderEvent::Snapshot(snapshot)),
            _ => Offered::Wrong,
        },
    };
    let said = || format!("{kind} answered {} request {}", pending.request, id.0);
    match offered {
        Offered::Taken => Step::Nothing,
        Offered::Wrong => Step::End(HolderEnd::Malformed(said())),
        Offered::Early => Step::End(HolderEnd::Malformed(format!("{} out of turn", said()))),
    }
}

fn refuse(state: &mut State, id: RequestId, refusal: HolderRefusal) -> Step {
    let Some(pending) = state.pending.remove(&id.0) else {
        // An `error` answering an abandoned request is dropped, as any late answer is; input
        // has no answer but this.
        return if refusal.request == "input" {
            Step::Event(HolderEvent::Refused { id, refusal })
        } else {
            Step::Nothing
        };
    };
    let ends = pending.ends_on_refusal;
    pending.fail(RequestError::Refused(refusal.clone()));
    if ends {
        Step::End(HolderEnd::Refused(refusal))
    } else {
        Step::Nothing
    }
}

/// Gives every whole frame read to `dispatch`, and each event to the consumer, in order. Breaks
/// once the connection is to end: with its end, or with none when it has already ended.
async fn take_frames(
    shared: &Shared,
    decoder: &mut FrameDecoder<Reply>,
    events: &mpsc::Sender<HolderEvent>,
) -> ControlFlow<Option<HolderEnd>> {
    loop {
        if shared.ended.is_cancelled() {
            return ControlFlow::Break(None);
        }
        let frame = match decoder.next_frame() {
            Ok(Some(frame)) => frame,
            Ok(None) => return ControlFlow::Continue(()),
            Err(malformed) => {
                return ControlFlow::Break(Some(HolderEnd::Malformed(
                    malformed.reason().to_owned(),
                )));
            }
        };
        let step = dispatch(&mut shared.lock(), frame);
        match step {
            Step::Nothing => {}
            Step::End(end) => return ControlFlow::Break(Some(end)),
            Step::Event(event) => {
                // A consumer that dropped its events has the rest dropped as they come. One that
                // stopped draining them holds the reader here, until the connection ends or is
                // stopped from above.
                let ended = pin!(shared.ended.cancelled());
                let stopped = pin!(shared.stop.cancelled());
                let sending = pin!(events.send(event));
                match select(select(ended, stopped), sending).await {
                    Either::Left((Either::Left(_), _)) => return ControlFlow::Break(None),
                    Either::Left((Either::Right(_), _)) => {
                        return ControlFlow::Break(Some(HolderEnd::Eof));
                    }
                    Either::Right(_) => {}
                }
            }
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin>(
    shared: Arc<Shared>,
    mut read: R,
    events: mpsc::Sender<HolderEvent>,
    last: Option<mpsc::OwnedPermit<HolderEvent>>,
) {
    let mut decoder = reply_decoder();
    let mut chunk = vec![0; READ_CHUNK];
    let end = loop {
        let ended = pin!(shared.ended.cancelled());
        let stopped = pin!(shared.stop.cancelled());
        let reading = pin!(read.read(&mut chunk));
        match select(select(ended, stopped), reading).await {
            // Ended already, by this side or by a request's failure.
            Either::Left((Either::Left(_), _)) => break None,
            // Stopped from above, as the daemon's shutdown does: this side's hang-up.
            Either::Left((Either::Right(_), _)) | Either::Right((Ok(0), _)) => {
                break Some(HolderEnd::Eof);
            }
            Either::Right((Err(e), _)) => break Some(HolderEnd::io(&e)),
            Either::Right((Ok(n), _)) => decoder.push(chunk.get(..n).unwrap_or_default()),
        }
        if let ControlFlow::Break(end) = take_frames(&shared, &mut decoder, &events).await {
            break end;
        }
    };
    if let Some(end) = end {
        shared.fail(end);
    }
    drop(read);
    if let Some(last) = last {
        last.send(HolderEvent::Ended(shared.end()));
    }
}

/// Writes what is queued, in order, until a hang-up.
async fn drain<W: AsyncWrite + Unpin>(
    shared: &Shared,
    write: &mut W,
    outbox: &mut mpsc::UnboundedReceiver<Outgoing>,
) -> io::Result<()> {
    while let Some(outgoing) = outbox.recv().await {
        match outgoing {
            Outgoing::Frames(frames) => {
                write.write_all(&frames).await?;
                shared
                    .unsent
                    .send_modify(|unsent| *unsent = unsent.saturating_sub(frames.len()));
            }
            Outgoing::HangUp => return write.shutdown().await,
        }
    }
    Ok(())
}

async fn write_loop<W: AsyncWrite + Unpin>(
    shared: Arc<Shared>,
    mut write: W,
    mut outbox: mpsc::UnboundedReceiver<Outgoing>,
    hang_up: Duration,
) {
    let written = {
        let mut work = pin!(drain(&shared, &mut write, &mut outbox));
        let flushing = async {
            match select(work.as_mut(), pin!(shared.ended.cancelled())).await {
                Either::Left((done, _)) => Some(done),
                // Hung up: what is unsent has `hang_up` to reach the holder, which may have
                // stopped reading.
                Either::Right(((), _)) => tokio::time::timeout(hang_up, work.as_mut()).await.ok(),
            }
        };
        match select(pin!(shared.stop.cancelled()), pin!(flushing)).await {
            Either::Left(_) => None,
            Either::Right((done, _)) => done,
        }
    };
    if let Some(Err(e)) = written {
        shared.fail(HolderEnd::io(&e));
    }
    drop(write);
    shared.stop.cancel();
}

/// Owns a connection's tasks, and hangs up when dropped.
struct Owner {
    shared: Arc<Shared>,
    tasks: TaskTracker,
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.shared.hang_up();
    }
}

/// A connection to one holder, past `hello`.
pub struct HolderClient {
    owner: Owner,
    hello: HelloReply,
}

impl fmt::Debug for HolderClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HolderClient")
            .field("terminal_id", &self.hello.terminal_id)
            .finish_non_exhaustive()
    }
}

/// Connects to a holder's socket and says `hello`, within `options.connect`. Its events start
/// with what the holder sends after `hello`.
///
/// # Errors
///
/// When nothing listens at `path`, the holder doesn't answer in time, or it refuses `hello`:
/// `no-shared-version`, with its versions, when it shares no major with this build.
pub async fn connect(
    path: &Path,
    options: &ClientOptions,
) -> Result<(HolderClient, HolderEvents), ConnectError> {
    let connecting = async {
        let stream = UnixStream::connect(path)
            .await
            .map_err(|source| ConnectError::Connect {
                path: path.to_path_buf(),
                source,
            })?;
        let (read, write) = stream.into_split();
        open(read, write, options)
            .await
            .map_err(|source| ConnectError::Hello {
                path: path.to_path_buf(),
                source: Box::new(source),
            })
    };
    tokio::time::timeout(options.connect, connecting)
        .await
        .unwrap_or_else(|_| {
            Err(ConnectError::Timeout {
                path: path.to_path_buf(),
                after: options.connect,
            })
        })
}

/// Says `hello` on `read` and `write` and resolves once the holder answers; nothing else is sent
/// before.
pub(crate) async fn open<R, W>(
    read: R,
    write: W,
    options: &ClientOptions,
) -> Result<(HolderClient, HolderEvents), RequestError>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (outbox, queued) = mpsc::unbounded_channel();
    // One more than queued for the consumer, kept for `Ended`, so the end is never lost.
    let (events, received) = mpsc::channel(EVENTS_QUEUED + 1);
    let last = events.clone().reserve_owned().await.ok();
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            pending: HashMap::new(),
            last_id: 0,
            generation: None,
            end: None,
        }),
        unsent: watch::Sender::new(0),
        outbox,
        ended: CancellationToken::new(),
        stop: options.cancel.child_token(),
    });
    let tasks = TaskTracker::new();
    tasks.spawn(read_loop(Arc::clone(&shared), read, events, last));
    tasks.spawn(write_loop(
        Arc::clone(&shared),
        write,
        queued,
        options.hang_up,
    ));
    tasks.close();
    let owner = Owner {
        shared: Arc::clone(&shared),
        tasks,
    };
    let hello = HelloRequest {
        protocol: Versions::spoken(),
        writer: Some(options.writer),
    };
    let hello = ask(
        &shared,
        |id| Request::Hello { id, body: hello },
        Answered::into_hello,
        None,
    )
    .await
    .inspect_err(|_| shared.fail(HolderEnd::Eof))?;
    Ok((HolderClient { owner, hello }, HolderEvents(received)))
}

impl HolderClient {
    fn shared(&self) -> &Arc<Shared> {
        &self.owner.shared
    }

    /// The holder's answer to `hello`.
    pub fn hello(&self) -> &HelloReply {
        &self.hello
    }

    pub fn is_open(&self) -> bool {
        self.shared().lock().end.is_none()
    }

    /// How many bytes may be written now before the cap on unsent bytes ends the connection:
    /// input takes its length plus 9 bytes for each frame of up to 1 MiB. A holder reading slowly
    /// lowers it for a while; it is 0 once the connection has ended.
    pub fn room(&self) -> usize {
        if !self.is_open() {
            return 0;
        }
        MAX_UNSENT_BYTES.saturating_sub(*self.shared().unsent.borrow())
    }

    /// Resolves once everything written has left this process, or the connection has ended. On
    /// a socket that means the kernel holds the bytes, not that the holder has read them. A
    /// caller with more to send than `room` awaits it first; dropping it stops the wait.
    pub fn drained(&self) -> impl Future<Output = ()> + Send + 'static {
        let shared = Arc::clone(self.shared());
        let mut unsent = shared.unsent.subscribe();
        async move {
            let empty = pin!(unsent.wait_for(|unsent| *unsent == 0));
            // Either way it is drained: written, or past writing.
            drop(select(empty, pin!(shared.ended.cancelled())).await);
        }
    }

    /// The generation of what the holder sends now: `hello`'s, then that of each `respawned`
    /// read. Every reply read after a `respawned` is of its generation.
    pub fn generation(&self) -> Generation {
        self.shared()
            .lock()
            .generation
            .unwrap_or(self.hello.generation)
    }

    /// The terminal as of the holder's offset, given here rather than to the events.
    pub fn snapshot(&self) -> Answer<HolderSnapshot> {
        ask(
            self.shared(),
            |id| Request::Snapshot { id },
            Answered::into_snapshot,
            None,
        )
    }

    /// A snapshot and a subscription in one write, which the holder serves from one point, so
    /// the output that follows starts exactly where the snapshot ends. The snapshot goes to the
    /// events ahead of that output; this resolves once the subscription is taken. If either half
    /// fails, or this is dropped, the connection ends, rather than go on with output that may
    /// have no snapshot.
    pub fn attach(&self) -> Answer<()> {
        let shared = self.shared();
        let (answer, answered) = oneshot::channel();
        let (subscribe, frames) = {
            let mut state = shared.lock();
            if let Some(end) = &state.end {
                return Answer::failed(RequestError::Disconnected(HolderDisconnected {
                    end: end.clone(),
                }));
            }
            let snapshot = state.take_id();
            let subscribe = state.take_id();
            let mut frames = match (Request::Snapshot {
                id: RequestId(snapshot),
            })
            .encode()
            {
                Ok(frame) => frame,
                Err(e) => return Answer::failed(RequestError::Unsendable(e)),
            };
            let then = Request::Subscribe {
                id: RequestId(subscribe),
                body: SubscribeRequest { from: None },
            };
            match then.encode() {
                Ok(frame) => frames.extend_from_slice(&frame),
                Err(e) => return Answer::failed(RequestError::Unsendable(e)),
            }
            state.pending.insert(
                snapshot,
                Pending {
                    request: "snapshot".to_owned(),
                    to: To::Events,
                    ends_on_refusal: true,
                    after: None,
                },
            );
            let slot = Typed {
                answer,
                take: Answered::into_ok,
            };
            // The holder answers in the order it read the two: output before the snapshot is
            // unplaceable.
            state.pending.insert(
                subscribe,
                Pending {
                    request: then.name().into_owned(),
                    to: To::Caller(Box::new(slot)),
                    ends_on_refusal: true,
                    after: Some(snapshot),
                },
            );
            (subscribe, frames)
        };
        let waiter = Waiter {
            shared: Arc::clone(shared),
            id: subscribe,
            abandon: Some("attach"),
        };
        // Over the cap, the connection ends, which fails the request.
        let _ = shared.send(frames);
        waiting(waiter, answered)
    }

    /// Moves the connection's one subscription, an attach's included, to output from `from`, or
    /// from the holder's offset.
    pub fn subscribe(&self, from: Option<SubscribeFrom>) -> Answer<()> {
        ask(
            self.shared(),
            |id| Request::Subscribe {
                id,
                body: SubscribeRequest { from },
            },
            Answered::into_ok,
            Some("subscribe"),
        )
    }

    /// Sends input, cut into frames under the cap, and gives their ids. The holder answers input
    /// only to refuse it, as a `Refused` event carrying the id.
    ///
    /// # Errors
    ///
    /// `TooLarge`, sending none of it, for input over `MAX_UNSENT_BYTES` in one call;
    /// `Disconnected` once the connection has ended, or when the input would go past the cap with
    /// what is still unsent, which ends it: a caller sending more than `room` awaits `drained`
    /// first.
    pub fn input(&self, bytes: &[u8]) -> Result<Vec<RequestId>, InputError> {
        let shared = self.shared();
        if let Some(gone) = shared.disconnected() {
            return Err(InputError::Disconnected(gone));
        }
        let size = bytes.len() + bytes.len().div_ceil(INPUT_CHUNK) * INPUT_OVERHEAD;
        if size > MAX_UNSENT_BYTES {
            return Err(InputError::TooLarge { len: bytes.len() });
        }
        let mut ids = Vec::new();
        let mut frames = Vec::with_capacity(size);
        {
            let mut state = shared.lock();
            for chunk in bytes.chunks(INPUT_CHUNK) {
                let id = RequestId(state.take_id());
                let frame = Request::Input {
                    id,
                    bytes: chunk.to_vec(),
                }
                .encode()
                .map_err(InputError::Unsendable)?;
                frames.extend_from_slice(&frame);
                ids.push(id);
            }
        }
        if !frames.is_empty() {
            shared.send(frames).map_err(InputError::Disconnected)?;
        }
        Ok(ids)
    }

    pub fn resize(&self, size: Size) -> Answer<()> {
        ask(
            self.shared(),
            |id| Request::Resize { id, body: size },
            Answered::into_ok,
            None,
        )
    }

    pub fn signal(&self, signal: Signal) -> Answer<()> {
        ask(
            self.shared(),
            |id| Request::Signal {
                id,
                body: SignalRequest { signal },
            },
            Answered::into_ok,
            None,
        )
    }

    /// Types the paste's text into the child only if the program would read it as text now; the
    /// holder refuses with `not-ready` otherwise, typing nothing. Since holder/1.3.
    pub fn paste(&self, paste: PasteRequest) -> Answer<()> {
        ask(
            self.shared(),
            |id| Request::Paste { id, body: paste },
            Answered::into_ok,
            None,
        )
    }

    pub fn respawn(&self, spec: ProcessSpec) -> Answer<()> {
        ask(
            self.shared(),
            |id| Request::Respawn { id, body: spec },
            Answered::into_ok,
            None,
        )
    }

    pub fn set_tags(&self, tags: Tags) -> Answer<()> {
        ask(
            self.shared(),
            |id| Request::SetTags {
                id,
                body: SetTagsRequest { tags },
            },
            Answered::into_ok,
            None,
        )
    }

    pub fn set_theme(&self, theme: Option<Theme>) -> Answer<()> {
        ask(
            self.shared(),
            |id| Request::SetTheme {
                id,
                body: SetThemeRequest { theme },
            },
            Answered::into_ok,
            None,
        )
    }

    pub fn stats(&self) -> Answer<Stats> {
        ask(
            self.shared(),
            |id| Request::Stats { id },
            Answered::into_stats,
            None,
        )
    }

    pub fn foreground(&self) -> Answer<Foreground> {
        ask(
            self.shared(),
            |id| Request::Foreground { id },
            Answered::into_foreground,
            None,
        )
    }

    /// The screen shown as plain text, after the newest `history` rows of history; a reader may
    /// ask, and after the child has exited too. Since holder/1.4.
    pub fn screen(&self, history: Count) -> Answer<Screen> {
        ask(
            self.shared(),
            |id| Request::Screen {
                id,
                body: ScreenRequest { history },
            },
            Answered::into_screen,
            None,
        )
    }

    /// Closes the terminal: once the holder says `ok`, it ends the child and exits. This
    /// resolves on that `ok`, before the holder hangs up; await `ended` to know the connection is
    /// gone.
    pub fn close(&self) -> Answer<()> {
        ask(
            self.shared(),
            |id| Request::Close { id },
            Answered::into_ok,
            None,
        )
    }

    /// Hangs up this connection, leaving the holder running. What is still unsent gets the
    /// `hang_up` it was opened with to reach the holder. Await `closed` before a new connection
    /// that should come after it. Dropping the client does the same.
    pub fn end(&self) {
        self.shared().hang_up();
    }

    /// How the connection ended, once it has.
    pub fn ended(&self) -> impl Future<Output = HolderEnd> + Send + 'static {
        let shared = Arc::clone(self.shared());
        async move {
            shared.ended.cancelled().await;
            shared.end()
        }
    }

    /// Resolves once the socket itself has closed, so the holder can see this side has ended.
    /// `ended` comes sooner, as soon as `end()` is called, while what is unsent may still be
    /// going out.
    pub fn closed(&self) -> impl Future<Output = ()> + Send + 'static {
        let tasks = self.owner.tasks.clone();
        async move { tasks.wait().await }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fmt::Debug;
    use std::sync::atomic::Ordering;

    use bazhen_holder_proto::PROTOCOL_VERSION;
    use bazhen_holder_proto::body::{
        Argv, Env, ExitCode, ExitStatus, NonEmpty, OkBody, TagName, TagValue, TerminalId,
        VersionText,
    };
    use futures_util::FutureExt as _;
    use futures_util::future::join;
    use tokio::net::UnixListener;

    use super::*;
    use crate::fake_holder::{Breakable, Connected, FakeHolder};
    use crate::test_support::{TempDir, block_on};

    type Verb<'a> = Box<dyn Fn() -> Answer<()> + 'a>;
    type Sent = Box<dyn Fn(RequestId) -> Request>;

    fn n<B: TryFrom<u64, Error: Debug>>(value: u64) -> B {
        B::try_from(value).unwrap()
    }

    fn ok(id: RequestId, request: &str) -> Reply {
        Reply::Ok {
            id,
            body: OkBody {
                request: request.to_owned(),
            },
        }
    }

    fn error(id: RequestId, request: &str, code: &str) -> Reply {
        Reply::Error {
            id,
            body: ErrorBody {
                request: request.to_owned(),
                code: code.to_owned(),
                message: String::new(),
                protocol: None,
            },
        }
    }

    fn stats() -> Stats {
        Stats {
            engine_bytes: n(1),
            rss: None,
            ring_bytes: n(2),
            history_lines: n(3),
            engine_resets: None,
        }
    }

    fn foreground() -> Foreground {
        Foreground {
            child_pid: n(10),
            child_start: n(1),
            pgid: n(11),
            pgid_start: n(2),
        }
    }

    fn snap(id: RequestId, offset: u64, bytes: &[u8]) -> Reply {
        Reply::Snapshot {
            id,
            offset: n(offset),
            dropped_lines: 0,
            bytes: bytes.to_vec(),
        }
    }

    fn respawned(generation: u64) -> Respawned {
        Respawned {
            generation: n(generation),
            child_pid: n(9),
            child_start: n(1),
        }
    }

    fn title(text: &str) -> Title {
        Title {
            offset: n(0),
            text: text.to_owned(),
        }
    }

    fn data(offset: u64, bytes: &[u8]) -> Reply {
        Reply::Data {
            offset: n(offset),
            bytes: bytes.to_vec(),
        }
    }

    /// A frame of a type byte this build doesn't know, with a payload.
    fn unknown_frame(code: u8, payload: &[u8]) -> Vec<u8> {
        let length = u32::try_from(payload.len() + 1).unwrap();
        [&length.to_be_bytes()[..], &[code], payload].concat()
    }

    fn input_bytes(request: Request) -> Vec<u8> {
        match request {
            Request::Input { bytes, .. } => bytes,
            other => panic!("not input: {other:?}"),
        }
    }

    fn end_of<T: Debug>(answered: Result<T, RequestError>) -> HolderEnd {
        match answered {
            Err(RequestError::Disconnected(gone)) => gone.end,
            other => panic!("not disconnected: {other:?}"),
        }
    }

    fn refusal_of<T: Debug>(answered: Result<T, RequestError>) -> HolderRefusal {
        match answered {
            Err(RequestError::Refused(refusal)) => refusal,
            other => panic!("not refused: {other:?}"),
        }
    }

    fn malformed(end: &HolderEnd, saying: &str) -> bool {
        matches!(end, HolderEnd::Malformed(message) if message.contains(saying))
    }

    fn unsent(client: &HolderClient) -> usize {
        *client.shared().unsent.borrow()
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_each_verb_answered_ok_as_its_own_request_and_resolves_on_ok() {
        bazhen_test_signal::require_sandbox().unwrap();
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let from = SubscribeFrom {
                generation: n(0),
                offset: n(5),
            };
            let size = Size {
                cols: n(90),
                rows: n(20),
            };
            let paste = PasteRequest::new(n(2), "ls", false).unwrap();
            let spec = ProcessSpec {
                argv: Argv::new(vec!["sh".to_owned()]).unwrap(),
                cwd: NonEmpty::new("/").unwrap(),
                env: Env::new(BTreeMap::new()).unwrap(),
                generation: n(1),
                theme: None,
            };
            let tags = Tags::new(BTreeMap::from([(
                TagName::new("agent").unwrap(),
                TagValue::new("a1").unwrap(),
            )]))
            .unwrap();
            let (p, s, t) = (paste.clone(), spec.clone(), tags.clone());
            let verbs: Vec<(&str, Verb<'_>, Sent)> = vec![
                (
                    "subscribe",
                    Box::new(|| client.subscribe(Some(from))),
                    Box::new(move |id| Request::Subscribe {
                        id,
                        body: SubscribeRequest { from: Some(from) },
                    }),
                ),
                (
                    "resize",
                    Box::new(|| client.resize(size)),
                    Box::new(move |id| Request::Resize { id, body: size }),
                ),
                (
                    "signal",
                    Box::new(|| client.signal(Signal::Sigint)),
                    Box::new(|id| Request::Signal {
                        id,
                        body: SignalRequest {
                            signal: Signal::Sigint,
                        },
                    }),
                ),
                (
                    "paste",
                    Box::new(|| client.paste(paste.clone())),
                    Box::new(move |id| Request::Paste {
                        id,
                        body: p.clone(),
                    }),
                ),
                (
                    "respawn",
                    Box::new(|| client.respawn(spec.clone())),
                    Box::new(move |id| Request::Respawn {
                        id,
                        body: s.clone(),
                    }),
                ),
                (
                    "set-tags",
                    Box::new(|| client.set_tags(tags.clone())),
                    Box::new(move |id| Request::SetTags {
                        id,
                        body: SetTagsRequest { tags: t.clone() },
                    }),
                ),
                (
                    "set-theme",
                    Box::new(|| client.set_theme(None)),
                    Box::new(|id| Request::SetTheme {
                        id,
                        body: SetThemeRequest { theme: None },
                    }),
                ),
                (
                    "close",
                    Box::new(|| client.close()),
                    Box::new(|id| Request::Close { id }),
                ),
            ];
            for (name, verb, sent) in &verbs {
                let answer = verb();
                let request = holder.request().await;
                assert_eq!(request, sent(request.id()), "{name}");
                holder.send(&[ok(request.id(), name)]).await;
                answer.await.unwrap();
            }
        });
    }

    #[test]
    fn asks_to_be_a_reader_unless_told_to_ask_for_the_writer_slot() {
        block_on(async {
            let Connected { client, hello, .. } = FakeHolder::client().await;
            assert_eq!((hello.writer, client.hello().writer), (Some(false), false));
        });
    }

    #[test]
    fn says_hello_first_alone_with_its_version_and_the_writer_flag_it_was_given() {
        block_on(async {
            let Connected {
                client,
                hello,
                writes,
                ..
            } = FakeHolder::client_with(ClientOptions {
                writer: true,
                ..ClientOptions::default()
            })
            .await;
            let versions: Vec<_> = hello
                .protocol
                .as_slice()
                .iter()
                .map(VersionText::as_str)
                .collect();
            assert_eq!(
                (
                    versions,
                    hello.writer,
                    writes.load(Ordering::Relaxed),
                    client.hello().writer
                ),
                (vec![PROTOCOL_VERSION], Some(true), 1, true)
            );
        });
    }

    #[test]
    fn refuses_the_handshake_with_the_holder_s_versions_when_they_share_no_major() {
        block_on(async {
            let (near, far) = UnixStream::pair().unwrap();
            let (read, write) = near.into_split();
            let mut holder = FakeHolder::new(far);
            let theirs = Versions::new(vec![VersionText::new("2.0").unwrap()]).unwrap();
            let holder_side = async {
                let hello = holder.request().await;
                let mut refused = error(hello.id(), "hello", "no-shared-version");
                if let Reply::Error { body, .. } = &mut refused {
                    body.protocol = Some(theirs.clone());
                }
                holder.send(&[refused]).await;
                holder.until_eof().await
            };
            let (opened, after) =
                join(open(read, write, &ClientOptions::default()), holder_side).await;
            let refusal = refusal_of(opened);
            assert_eq!(
                (refusal.code, refusal.protocol, after),
                (ErrorCode::NoSharedVersion, Some(theirs), vec![])
            );
        });
    }

    #[test]
    fn gives_each_answer_to_the_request_with_its_id_when_the_holder_answers_out_of_order() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let stats_answer = client.stats();
            let foreground_answer = client.foreground();
            let first = holder.request().await;
            let second = holder.request().await;
            holder
                .send(&[
                    Reply::Foreground {
                        id: second.id(),
                        body: foreground(),
                    },
                    Reply::Stats {
                        id: first.id(),
                        body: stats(),
                    },
                ])
                .await;
            assert_eq!(
                (
                    stats_answer.await.unwrap(),
                    foreground_answer.await.unwrap()
                ),
                (stats(), foreground())
            );
        });
    }

    #[test]
    fn reads_an_error_code_newer_than_this_build_as_failed_keeping_the_code_sent() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let answer = client.resize(Size {
                cols: n(100),
                rows: n(30),
            });
            let request = holder.request().await;
            holder
                .send(&[error(request.id(), "resize", "melted")])
                .await;
            let refusal = refusal_of(answer.await);
            assert_eq!(
                (refusal.code, refusal.raw_code.as_str(), client.is_open()),
                (ErrorCode::Failed, "melted", true)
            );
        });
    }

    #[test]
    fn drops_the_answer_to_an_abandoned_request_instead_of_giving_it_to_the_next_one() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                mut events,
                ..
            } = FakeHolder::client().await;
            let abandoned = client.stats();
            let late = holder.request().await;
            drop(abandoned);
            let next = client.stats();
            let request = holder.request().await;
            let other = Stats {
                ring_bytes: n(999),
                ..stats()
            };
            holder
                .send(&[
                    Reply::Stats {
                        id: late.id(),
                        body: other,
                    },
                    Reply::Stats {
                        id: request.id(),
                        body: stats(),
                    },
                ])
                .await;
            assert_eq!(next.await.unwrap(), stats());
            assert_eq!((client.is_open(), events.try_recv()), (true, None));
        });
    }

    #[test]
    fn drops_an_error_answering_an_abandoned_request_rather_than_report_refused_input() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                mut events,
                ..
            } = FakeHolder::client().await;
            let abandoned = client.resize(Size {
                cols: n(90),
                rows: n(20),
            });
            let late = holder.request().await;
            drop(abandoned);
            let next = client.stats();
            let request = holder.request().await;
            holder
                .send(&[
                    error(late.id(), "resize", "invalid"),
                    Reply::Stats {
                        id: request.id(),
                        body: stats(),
                    },
                ])
                .await;
            next.await.unwrap();
            assert_eq!(events.try_recv(), None);
        });
    }

    #[test]
    fn cuts_input_over_the_request_cap_into_frames_that_rejoin_to_the_same_bytes() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let bytes: Vec<u8> = (0..=2 * MAX_REQUEST_BYTES)
                .map(|i| u8::try_from(i % 251).unwrap())
                .collect();
            let ids = client.input(&bytes).unwrap();
            let mut frames = Vec::new();
            for _ in 0..3 {
                frames.push(holder.request().await);
            }
            let sent: Vec<_> = frames.iter().map(Request::id).collect();
            let parts: Vec<_> = frames.into_iter().map(input_bytes).collect();
            let full = MAX_REQUEST_BYTES - 1 - 4;
            assert_eq!(sent, ids);
            assert_eq!(
                parts.iter().map(Vec::len).collect::<Vec<_>>(),
                [full, full, bytes.len() - 2 * full]
            );
            assert!(parts.concat() == bytes);
        });
    }

    #[test]
    fn delivers_a_refused_input_as_an_event_carrying_its_id() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                mut events,
                ..
            } = FakeHolder::client().await;
            let ids = client.input(b"a").unwrap();
            let id = holder.request().await.id();
            holder.send(&[error(id, "input", "not-writer")]).await;
            let Some(HolderEvent::Refused {
                id: refused,
                refusal,
            }) = events.recv().await
            else {
                panic!("no refusal");
            };
            assert_eq!((vec![refused], refusal.code), (ids, ErrorCode::NotWriter));
        });
    }

    #[test]
    fn asks_for_the_snapshot_and_the_subscription_in_one_write() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                writes,
                ..
            } = FakeHolder::client().await;
            let _attached = client.attach();
            let snapshot = holder.request().await;
            let subscribe = holder.request().await;
            assert_eq!(
                (snapshot, subscribe, writes.load(Ordering::Relaxed)),
                (
                    Request::Snapshot { id: RequestId(2) },
                    Request::Subscribe {
                        id: RequestId(3),
                        body: SubscribeRequest { from: None }
                    },
                    2
                )
            );
        });
    }

    #[test]
    fn gives_an_attach_s_snapshot_to_the_events_before_output_that_arrives_with_it() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                mut events,
                ..
            } = FakeHolder::client().await;
            let attached = client.attach();
            let snapshot = holder.request().await;
            let subscribe = holder.request().await;
            let vt = [0x1b, 0x63];
            holder
                .send(&[
                    snap(snapshot.id(), 7, &vt),
                    ok(subscribe.id(), "subscribe"),
                    data(7, b"x"),
                ])
                .await;
            attached.await.unwrap();
            let first = events.recv().await;
            let second = events.recv().await;
            assert_eq!(
                (first, second),
                (
                    Some(HolderEvent::Snapshot(HolderSnapshot {
                        offset: n(7),
                        dropped_lines: 0,
                        bytes: vt.to_vec(),
                        generation: n(0),
                    })),
                    Some(HolderEvent::Data {
                        offset: n(7),
                        bytes: b"x".to_vec()
                    })
                )
            );
        });
    }

    #[test]
    fn gives_each_snapshot_the_generation_it_was_answered_in_not_that_of_a_respawn_behind_it() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                mut events,
                ..
            } = FakeHolder::client().await;
            let first = client.snapshot();
            let asked = holder.request().await;
            holder
                .send(&[snap(asked.id(), 0, b""), Reply::Respawned(respawned(3))])
                .await;
            let second = client.snapshot();
            let next = holder.request().await;
            holder.send(&[snap(next.id(), 0, b"")]).await;
            let generations = [
                first.await.unwrap().generation,
                second.await.unwrap().generation,
                client.generation(),
            ];
            assert_eq!(generations, [n(0), n(3), n(3)]);
            let attached = client.attach();
            let s = holder.request().await;
            let sub = holder.request().await;
            holder
                .send(&[snap(s.id(), 0, b""), ok(sub.id(), "subscribe")])
                .await;
            attached.await.unwrap();
            let seen = [events.recv().await, events.recv().await];
            let [
                Some(HolderEvent::Respawned(_)),
                Some(HolderEvent::Snapshot(attach)),
            ] = seen
            else {
                panic!("{seen:?}");
            };
            assert_eq!(attach.generation, n(3));
        });
    }

    #[test]
    fn skips_replies_and_events_of_types_it_doesn_t_know() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                mut events,
                ..
            } = FakeHolder::client().await;
            let bytes = [
                unknown_frame(0xd0, &[1]),
                unknown_frame(0xbe, &[0, 0, 0, 9]),
                Reply::Title(title("vim")).encode().unwrap(),
            ]
            .concat();
            holder.send_raw(&bytes).await;
            assert_eq!(
                (events.recv().await, client.is_open()),
                (Some(HolderEvent::Title(title("vim"))), true)
            );
        });
    }

    #[test]
    fn ends_the_connection_when_a_request_is_answered_by_another_request_s_kind_of_reply() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let stats_answer = client.stats();
            let other = client.snapshot();
            let request = holder.request().await;
            holder.send(&[ok(request.id(), "stats")]).await;
            let ends = [
                end_of(stats_answer.await),
                end_of(other.await),
                client.ended().await,
            ];
            assert!(
                ends.iter()
                    .all(|end| malformed(end, "ok answered stats request 2")),
                "{ends:?}"
            );
            client.closed().await;
        });
    }

    #[test]
    fn ends_the_connection_when_a_request_waiting_is_answered_by_a_reply_it_doesn_t_know() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let answer = client.stats();
            let request = holder.request().await;
            holder
                .send_raw(&unknown_frame(0xbe, &request.id().0.to_be_bytes()))
                .await;
            let end = end_of(answer.await);
            assert!(malformed(&end, "0xbe answered stats 2"), "{end:?}");
        });
    }

    #[test]
    fn ends_the_connection_on_a_malformed_frame_failing_every_request_waiting() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let stats_answer = client.stats();
            let foreground_answer = client.foreground();
            holder.send_raw(&[0, 0, 0, 0]).await;
            let ends = [
                end_of(stats_answer.await),
                end_of(foreground_answer.await),
                client.ended().await,
            ];
            assert!(
                ends.iter()
                    .all(|end| matches!(end, HolderEnd::Malformed(_))),
                "{ends:?}"
            );
            client.closed().await;
        });
    }

    #[test]
    fn ends_the_connection_when_an_attach_is_dropped_once_sent_so_no_output_comes_unsnapshotted() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let attached = client.attach();
            holder.request().await;
            drop(attached);
            assert_eq!(
                client.ended().await,
                HolderEnd::Abandoned {
                    request: "attach".to_owned()
                }
            );
        });
    }

    #[test]
    fn ends_the_connection_when_an_attach_s_subscription_is_answered_before_its_snapshot() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                mut events,
                ..
            } = FakeHolder::client().await;
            let attached = client.attach();
            let snapshot = holder.request().await;
            let subscribe = holder.request().await;
            holder
                .send(&[
                    ok(subscribe.id(), "subscribe"),
                    data(0, b"x"),
                    snap(snapshot.id(), 0, b""),
                ])
                .await;
            let end = end_of(attached.await);
            assert!(malformed(&end, "out of turn"), "{end:?}");
            assert_eq!(events.recv().await, Some(HolderEvent::Ended(end)));
        });
    }

    #[test]
    fn ends_the_connection_when_an_attach_s_snapshot_is_refused_but_its_subscription_taken() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                mut events,
                ..
            } = FakeHolder::client().await;
            let attached = client.attach();
            let snapshot = holder.request().await;
            let subscribe = holder.request().await;
            holder
                .send(&[
                    error(snapshot.id(), "snapshot", "snapshot-too-large"),
                    ok(subscribe.id(), "subscribe"),
                    data(0, b"x"),
                ])
                .await;
            let end = end_of(attached.await);
            let HolderEnd::Refused(refusal) = &end else {
                panic!("{end:?}");
            };
            assert_eq!(
                (refusal.code, client.is_open()),
                (ErrorCode::SnapshotTooLarge, false)
            );
            assert_eq!(events.recv().await, Some(HolderEvent::Ended(end)));
        });
    }

    #[test]
    fn ends_the_connection_when_a_subscribe_is_dropped_once_sent() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let subscribed = client.subscribe(None);
            holder.request().await;
            drop(subscribed);
            assert_eq!(
                client.ended().await,
                HolderEnd::Abandoned {
                    request: "subscribe".to_owned()
                }
            );
        });
    }

    #[test]
    fn keeps_the_connection_when_an_abandoned_request_has_nothing_running_on_the_holder() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let answer = client.stats();
            holder.request().await;
            drop(answer);
            assert!(client.is_open());
        });
    }

    #[test]
    fn keeps_the_connection_when_its_events_are_dropped_dropping_them_as_they_come() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                events,
                ..
            } = FakeHolder::client().await;
            drop(events);
            let answer = client.stats();
            let request = holder.request().await;
            holder
                .send(&[
                    Reply::Title(title("vim")),
                    Reply::Stats {
                        id: request.id(),
                        body: stats(),
                    },
                ])
                .await;
            assert_eq!((answer.await.unwrap(), client.is_open()), (stats(), true));
        });
    }

    #[test]
    fn pushes_what_the_holder_sends_unasked_to_a_connection_that_never_subscribed_then_its_end() {
        block_on(async {
            let Connected {
                client,
                mut holder,
                mut events,
                ..
            } = FakeHolder::client().await;
            let exited = Exited {
                generation: n(0),
                status: ExitStatus::Exited {
                    code: ExitCode::new(0).unwrap(),
                },
            };
            holder
                .send(&[
                    Reply::Exited(exited.clone()),
                    Reply::Respawned(respawned(1)),
                    Reply::Title(title("sh")),
                ])
                .await;
            drop(holder);
            let mut seen = Vec::new();
            while let Some(event) = events.recv().await {
                seen.push(event);
            }
            assert_eq!(
                seen,
                [
                    HolderEvent::Exited(exited),
                    HolderEvent::Respawned(respawned(1)),
                    HolderEvent::Title(title("sh")),
                    HolderEvent::Ended(HolderEnd::Eof),
                ]
            );
            assert_eq!(client.generation(), n(1));
        });
    }

    #[test]
    fn ends_at_once_when_cancelled_while_its_events_are_full_failing_what_waits() {
        block_on(async {
            let cancel = CancellationToken::new();
            let Connected {
                client,
                mut holder,
                events,
                ..
            } = FakeHolder::client_with(ClientOptions {
                cancel: cancel.clone(),
                ..ClientOptions::default()
            })
            .await;
            let mut answer = client.stats();
            let request = holder.request().await;
            let mut sent: Vec<_> = (0..=EVENTS_QUEUED)
                .map(|_| Reply::Title(title("vim")))
                .collect();
            sent.push(Reply::Stats {
                id: request.id(),
                body: stats(),
            });
            holder.send(&sent).await;
            while events.0.len() < EVENTS_QUEUED {
                tokio::task::yield_now().await;
            }
            // The reader holds the event past the queue's end, and the answer behind it.
            for _ in 0..100 {
                tokio::task::yield_now().await;
            }
            let held = ((&mut answer).now_or_never().is_none(), client.is_open());
            cancel.cancel();
            let bound = Duration::from_secs(5);
            let ended = tokio::time::timeout(bound, client.ended()).await.ok();
            let failed = tokio::time::timeout(bound, answer)
                .await
                .ok()
                .map(|answered| match answered {
                    Err(RequestError::Disconnected(gone)) => Some(gone.end),
                    _ => None,
                });
            let closed = tokio::time::timeout(bound, client.closed()).await.is_ok();
            assert_eq!(
                (held, ended, failed, closed),
                (
                    (true, true),
                    Some(HolderEnd::Eof),
                    Some(Some(HolderEnd::Eof)),
                    true
                )
            );
        });
    }

    #[test]
    fn hangs_up_when_asked_ending_its_side_so_the_holder_sees_end_of_file() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            client.end();
            assert!(!client.is_open());
            assert_eq!(client.ended().await, HolderEnd::Eof);
            assert_eq!(holder.until_eof().await, vec![]);
            client.closed().await;
        });
    }

    #[test]
    fn drops_the_socket_when_a_holder_that_stopped_reading_doesn_t_take_the_hang_up() {
        const HUNG_UP: Duration = Duration::from_millis(200);
        block_on(async {
            // Kept, and never read from.
            let Connected {
                client,
                holder: _stopped,
                ..
            } = FakeHolder::client_with(ClientOptions {
                hang_up: HUNG_UP,
                ..ClientOptions::default()
            })
            .await;
            // More than a socket's buffer holds, so the hang-up can't be sent before the wait.
            client.input(&vec![0; MAX_REQUEST_BYTES]).unwrap();
            let before = std::time::Instant::now();
            client.end();
            client.closed().await;
            assert!(before.elapsed() >= HUNG_UP, "{:?}", before.elapsed());
        });
    }

    #[test]
    fn says_closed_once_the_socket_has_closed_which_a_hang_up_still_sending_comes_after_ended() {
        block_on(async {
            let Connected { client, .. } = FakeHolder::client_with(ClientOptions {
                hang_up: Duration::from_millis(20),
                ..ClientOptions::default()
            })
            .await;
            client.input(&vec![0; MAX_REQUEST_BYTES]).unwrap();
            let mut closed = pin!(client.closed());
            client.end();
            client.ended().await;
            assert!(closed.as_mut().now_or_never().is_none());
            closed.await;
        });
    }

    #[test]
    fn ends_its_own_side_when_the_holder_only_half_closes() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            holder.half_close().await;
            assert_eq!(client.ended().await, HolderEnd::Eof);
            assert_eq!(holder.until_eof().await, vec![]);
        });
    }

    #[test]
    fn ends_the_connection_failing_what_waits_once_a_holder_stops_reading() {
        block_on(async {
            let Connected { client, .. } = FakeHolder::client().await;
            let answer = client.stats();
            let chunk = vec![0; MAX_REQUEST_BYTES];
            let mut most = 0;
            let mut refused = None;
            for _ in 0..4 * MAX_UNSENT_BYTES / chunk.len() {
                match client.input(&chunk) {
                    Ok(_) => most = most.max(unsent(&client)),
                    Err(e) => {
                        refused = Some(e);
                        break;
                    }
                }
            }
            assert!(
                matches!(refused, Some(InputError::Disconnected(_))),
                "{refused:?}"
            );
            assert!(most <= MAX_UNSENT_BYTES, "{most}");
            let end = end_of(answer.await);
            assert!(matches!(end, HolderEnd::OverCap { .. }), "{end:?}");
            assert!(end.to_string().contains("over the unsent cap"), "{end}");
            assert_eq!(client.ended().await, end);
            client.closed().await;
        });
    }

    #[test]
    fn takes_two_inputs_near_the_cap_back_to_back_from_a_caller_that_awaits_drained() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let near_cap = vec![0; MAX_UNSENT_BYTES - MAX_REQUEST_BYTES];
            let first = client.input(&near_cap).unwrap();
            assert_eq!(client.room(), MAX_UNSENT_BYTES - unsent(&client));
            assert!(client.room() < near_cap.len());
            let reading = async {
                let mut taken = Vec::new();
                for _ in &first {
                    taken.push(holder.request().await.id());
                }
                taken
            };
            let ((), mut taken) = join(client.drained(), reading).await;
            let second = client.input(&near_cap).unwrap();
            for _ in &second {
                taken.push(holder.request().await.id());
            }
            assert_eq!(taken, [first, second].concat());
            assert!(client.is_open());
        });
    }

    #[test]
    fn stops_waiting_for_drained_when_dropped_leaving_the_connection_open() {
        block_on(async {
            let Connected { client, .. } = FakeHolder::client().await;
            client.input(&vec![0; MAX_REQUEST_BYTES]).unwrap();
            assert!(client.drained().now_or_never().is_none());
            assert!(client.is_open());
        });
    }

    #[test]
    fn resolves_drained_once_the_connection_has_ended_with_bytes_still_unsent() {
        block_on(async {
            let Connected { client, holder, .. } = FakeHolder::client().await;
            client.input(&vec![0; MAX_REQUEST_BYTES]).unwrap();
            let drained = client.drained();
            drop(holder);
            drained.await;
            assert!(!client.is_open());
        });
    }

    #[test]
    fn has_no_room_once_the_connection_has_ended() {
        block_on(async {
            let Connected { client, .. } = FakeHolder::client().await;
            let before = client.room();
            client.end();
            assert_eq!((before, client.room()), (MAX_UNSENT_BYTES, 0));
        });
    }

    #[test]
    fn refuses_an_input_over_what_a_connection_may_hold_unsent_queueing_none_of_it() {
        block_on(async {
            let Connected { client, .. } = FakeHolder::client().await;
            let refused = client.input(&vec![0; MAX_UNSENT_BYTES]);
            assert!(
                matches!(refused, Err(InputError::TooLarge { .. })),
                "{refused:?}"
            );
            assert_eq!((unsent(&client), client.is_open()), (0, true));
        });
    }

    #[test]
    fn ends_with_the_socket_s_error_when_the_stream_fails() {
        block_on(async {
            let (near, far) = UnixStream::pair().unwrap();
            let (read, write) = near.into_split();
            let (read, breaks) = Breakable::new(read);
            let mut holder = FakeHolder::new(far);
            let (opened, _) = join(
                open(read, write, &ClientOptions::default()),
                holder.answer_hello(),
            )
            .await;
            let (client, _events) = opened.unwrap();
            breaks.send(()).unwrap();
            assert_eq!(
                client.ended().await,
                HolderEnd::Io {
                    kind: io::ErrorKind::BrokenPipe,
                    message: "EPIPE".to_owned()
                }
            );
        });
    }

    #[test]
    fn refuses_an_attach_on_a_connection_already_ended() {
        block_on(async {
            let Connected { client, holder, .. } = FakeHolder::client().await;
            drop(holder);
            client.ended().await;
            assert_eq!(end_of(client.attach().await), HolderEnd::Eof);
        });
    }

    #[test]
    fn fails_every_request_waiting_when_the_holder_hangs_up() {
        block_on(async {
            let Connected {
                client, mut holder, ..
            } = FakeHolder::client().await;
            let answer = client.stats();
            holder.request().await;
            drop(holder);
            assert_eq!(end_of(answer.await), HolderEnd::Eof);
            let input = client.input(&[1]);
            assert!(
                matches!(input, Err(InputError::Disconnected(_))),
                "{input:?}"
            );
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn says_hello_over_a_holder_s_socket_and_closes_the_terminal_which_removes_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        block_on(async {
            let dir = TempDir::new();
            let path = dir.path().join("t.sock");
            let (client, _events, holder) = FakeHolder::client_at(&path, |hello| {
                hello.terminal_id = TerminalId::new("t1").unwrap();
            })
            .await;
            let holder_side = async {
                // Taken in, so it hangs up once it has answered.
                let mut holder = holder;
                let close = holder.request().await;
                assert_eq!(close, Request::Close { id: close.id() });
                holder.send(&[ok(close.id(), "close")]).await;
                std::fs::remove_file(&path).unwrap();
            };
            let client_side = async {
                let terminal = client.hello().terminal_id.clone();
                client.close().await.unwrap();
                (terminal, client.ended().await)
            };
            let ((), (terminal, ended)) = join(holder_side, client_side).await;
            assert_eq!(
                (terminal.as_str(), ended, path.exists()),
                ("t1", HolderEnd::Eof, false)
            );
        });
    }

    #[test]
    fn fails_before_hello_with_the_system_s_code_when_there_is_no_socket() {
        block_on(async {
            let dir = TempDir::new();
            let failed = connect(&dir.path().join("t.sock"), &ClientOptions::default()).await;
            let Err(ConnectError::Connect { source, .. }) = failed else {
                panic!("{failed:?}");
            };
            assert_eq!(source.kind(), io::ErrorKind::NotFound);
        });
    }

    #[test]
    fn fails_before_hello_on_a_socket_whose_holder_is_gone() {
        block_on(async {
            let dir = TempDir::new();
            let path = dir.path().join("t.sock");
            // The file outlives the listener, as a dead holder's does.
            drop(UnixListener::bind(&path).unwrap());
            let failed = connect(&path, &ClientOptions::default()).await;
            let Err(ConnectError::Connect { source, .. }) = failed else {
                panic!("{failed:?}");
            };
            assert_eq!(source.kind(), io::ErrorKind::ConnectionRefused);
        });
    }

    #[test]
    fn gives_up_on_a_holder_that_never_answers_hello_and_hangs_up_on_it() {
        block_on(async {
            let dir = TempDir::new();
            let path = dir.path().join("t.sock");
            let listener = UnixListener::bind(&path).unwrap();
            let options = ClientOptions {
                connect: Duration::from_millis(50),
                ..ClientOptions::default()
            };
            let (failed, accepted) = join(connect(&path, &options), listener.accept()).await;
            let Err(ConnectError::Timeout { after, .. }) = failed else {
                panic!("{failed:?}");
            };
            let mut holder = FakeHolder::new(accepted.unwrap().0);
            let sent = holder.until_eof().await;
            assert_eq!(after, options.connect);
            assert!(
                matches!(sent.as_slice(), [Request::Hello { .. }]),
                "{sent:?}"
            );
        });
    }
}
