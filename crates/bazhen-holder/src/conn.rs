//! One connection to the holder: the requests it has sent, the frames it is owed, and when it
//! ends. Every buffer here is bounded, whatever the peer does, and nothing a peer does stalls the
//! holder or reaches another connection: the socket is non-blocking, and a peer that stops reading
//! stops being read.

use std::collections::VecDeque;
use std::io::{self, Read as _, Write as _};
use std::os::fd::{AsFd as _, BorrowedFd};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use bazhen_holder_proto::body::{Gap, Offset};
use bazhen_holder_proto::{FrameDecoder, Malformed, Reply, Request, request_decoder};
use rustix::event::PollFlags;

use crate::ring::Ring;

/// The most read from a connection in one turn.
pub const READ_CHUNK: usize = 64 << 10;
/// Past this many queued bytes, a connection's requests wait unread: the peer isn't reading its
/// answers, so it gets no more of them. Only its own writes block.
pub const QUEUE_MARK: usize = 256 << 10;
/// The most written to a connection in one turn, in bytes and in writes, so one fast reader, or
/// a queue of many small frames, can't hold the loop.
const WRITE_PER_TURN: usize = 1 << 20;
const WRITES_PER_TURN: usize = 128;
/// The most output one `data` frame carries: a subscriber costs this much buffer however far
/// behind it is, since output is copied from the ring only into the frame being written.
pub const DATA_FRAME: usize = 64 << 10;
/// How long a new connection has to say `hello`.
pub const HELLO_WITHIN: Duration = Duration::from_secs(5);
/// How long a connection being hung up has to read what it is owed.
pub const HANG_UP_WITHIN: Duration = Duration::from_secs(1);
/// The most `resized` a subscriber that lags is owed: past them, it is sent a `gap` to the
/// newest, and the older go, so a writer that resizes endlessly can't grow its queue.
pub const MOST_QUEUED_RESIZES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Accepted, and `hello` not yet answered.
    Opening {
        until: Instant,
    },
    Open,
    /// Read no more; dropped once what is queued is written, or at `until`.
    HangingUp {
        until: Instant,
    },
    /// Dropped at the end of the turn, whatever is queued.
    Gone,
}

/// A frame owed to the peer: an answer, written as soon as those before it are, or an event that
/// happened at an offset of the output, written to a subscriber only once its output has reached
/// that offset. A subscription's `ok` carries where its output starts, which takes effect only
/// once the `ok` goes out, so what was owed under the old subscription goes first. A `respawned`
/// carries where the new generation starts, from which offsets count once it goes out.
#[derive(Debug)]
struct Queued {
    at: Option<u64>,
    frame: Vec<u8>,
    subscribes: Option<u64>,
    rebases: Option<u64>,
    /// A snapshot, whose bytes count as owed until written.
    snapshot: bool,
    /// The child's `exited`.
    exit: bool,
    /// A state the connection is owed only the latest of.
    state: Option<State>,
    /// With `subscribes`, output the new subscription is sent a `gap` over, up to here: it was
    /// owed more `resized` than are kept.
    skip_to: Option<u64>,
}

/// Where the output stood at the snapshot a connection was answered just before, and whether the
/// snapshot moved the connection's subscription there itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AfterSnapshot {
    pub at: u64,
    pub moved: bool,
}

/// Where the frame being written came from: the queue, whose bytes count against the mark until
/// written, and a snapshot's as owed too; output and gaps from the ring count against neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    Ring,
    Queue,
    Snapshot,
}

/// A state the holder reports each time it changes, true as of the offset it comes at: a
/// connection is owed only the latest of each, so however often a program changes them, it is
/// never owed more than one of each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Title,
    Alternate,
    Resized,
}

#[derive(Debug)]
pub struct Connection {
    id: u64,
    stream: UnixStream,
    decoder: FrameDecoder<Request>,
    /// The next whole request, taken from the decoder ahead: while it waits, the socket isn't
    /// read, so the decoder holds at most one read and one partial frame.
    next: Option<Result<Request, Malformed>>,
    /// The peer has ended its side: nothing more is read, and the connection ends once every whole
    /// request it sent is answered and written.
    input_ended: bool,
    /// A malformed frame has been handed over. The decoder refuses everything after one, so
    /// nothing more is read or handed over: the caller hangs the connection up or drops it.
    refused: bool,
    phase: Phase,
    queue: VecDeque<Queued>,
    queued: usize,
    /// The frame being written, how much of it is, and where it came from.
    out: Vec<u8>,
    written: usize,
    out_from: Origin,
    /// The offset of the next output this connection is sent, while it is subscribed.
    cursor: Option<u64>,
    /// Where in the output the generation this connection was last told of starts: offsets it is
    /// sent count from here.
    base: u64,
    /// Since when a write has found the peer's buffer full, with nothing written since.
    stuck_since: Option<Instant>,
    accepted: Instant,
    /// The bytes of snapshots queued or being written, not yet written.
    owed_snapshot: usize,
    /// Where the output stood at the snapshot this connection was answered last, until its next
    /// request takes it.
    after_snapshot: Option<AfterSnapshot>,
    /// A snapshot asked for while the holder had no room for it, answered once it has, and since
    /// when it has waited: the requests after it wait behind it.
    held: Option<(Request, Instant)>,
    /// Since when the snapshot just handed back over had waited, for it to keep its place if it
    /// waits again.
    held_from: Option<Instant>,
    /// Output the subscriber is sent a `gap` over rather than the output: it was owed more
    /// `resized` than it is kept.
    skip_to: Option<u64>,
}

impl Connection {
    /// Takes an accepted stream, already non-blocking.
    pub fn new(id: u64, stream: UnixStream, now: Instant) -> Self {
        Self {
            id,
            stream,
            decoder: request_decoder(),
            next: None,
            input_ended: false,
            refused: false,
            phase: Phase::Opening {
                until: now + HELLO_WITHIN,
            },
            queue: VecDeque::new(),
            out: Vec::new(),
            out_from: Origin::Ring,
            cursor: None,
            base: 0,
            queued: 0,
            written: 0,
            stuck_since: None,
            accepted: now,
            owed_snapshot: 0,
            after_snapshot: None,
            held: None,
            held_from: None,
            skip_to: None,
        }
    }

    pub const fn id(&self) -> u64 {
        self.id
    }

    pub fn fd(&self) -> BorrowedFd<'_> {
        self.stream.as_fd()
    }

    /// Whether `hello` has been answered and the connection not hung up.
    pub fn is_open(&self) -> bool {
        self.phase == Phase::Open
    }

    /// Whether more requests may come: open, and its peer hasn't ended its side. One that has
    /// is still answered, but can send no input.
    pub fn may_send(&self) -> bool {
        self.is_open() && !self.input_ended
    }

    pub fn is_opening(&self) -> bool {
        matches!(self.phase, Phase::Opening { .. })
    }

    pub fn is_gone(&self) -> bool {
        self.phase == Phase::Gone
    }

    pub const fn stuck_since(&self) -> Option<Instant> {
        self.stuck_since
    }

    pub const fn accepted(&self) -> Instant {
        self.accepted
    }

    pub const fn queued(&self) -> usize {
        self.queued
    }

    /// The bytes of snapshots it is owed and hasn't been written yet: none once it is gone.
    pub fn owed_snapshot(&self) -> usize {
        if self.is_gone() {
            0
        } else {
            self.owed_snapshot
        }
    }

    /// Whether a snapshot it asked for waits for the holder to have room, and would be answered
    /// once there is.
    pub fn holds_a_snapshot(&self) -> bool {
        self.held_since().is_some()
    }

    /// Since when the snapshot it holds has waited, while it would be answered.
    pub fn held_since(&self) -> Option<Instant> {
        self.held
            .as_ref()
            .filter(|_| self.answering())
            .map(|(_, since)| *since)
    }

    /// Puts back `snapshot`, which the holder has no room to answer: it is the connection's next
    /// request again, and nothing after it is answered first. One that waited before keeps the
    /// time it began waiting.
    pub fn hold(&mut self, snapshot: Request, now: Instant) {
        let since = self.held_from.take().unwrap_or(now);
        self.held = Some((snapshot, since));
    }

    /// The offset of the snapshot this connection was answered last, if its last request was
    /// that snapshot: whatever request comes next takes it.
    pub const fn take_after_snapshot(&mut self) -> Option<AfterSnapshot> {
        self.after_snapshot.take()
    }

    /// Queues a snapshot of the output as of `at`: its bytes are owed until written. One sent
    /// to a subscriber, its subscription in force or queued, moves the subscription to `at` as
    /// it goes out: a subscriber is never sent output from before its snapshot after it, as a
    /// lagging one that snapshots again, as `gap` tells it to, would be.
    pub fn queue_snapshot(&mut self, frame: Vec<u8>, at: u64) {
        if self.is_gone() || frame.is_empty() {
            return;
        }
        let moved = self.subscribed();
        self.owed_snapshot = self.owed_snapshot.saturating_add(frame.len());
        self.queued = self.queued.saturating_add(frame.len());
        self.after_snapshot = Some(AfterSnapshot { at, moved });
        self.queue.push_back(Queued {
            at: None,
            frame,
            subscribes: moved.then_some(at),
            rebases: None,
            snapshot: true,
            exit: false,
            state: None,
            skip_to: None,
        });
    }

    /// Queues `state` as of offset `at`, in place of one of its kind still queued: it goes after
    /// everything queued, so it never comes before an `exited` or `respawned` queued earlier. A
    /// subscriber draws the output between two sizes at the first, so it keeps every `resized`
    /// queued since the latest subscription but one at the same offset, up to
    /// `MOST_QUEUED_RESIZES`, past which it is sent a `gap` to the newest.
    pub fn queue_state(&mut self, state: State, at: u64, frame: Vec<u8>) {
        if self.is_gone() || frame.is_empty() {
            return;
        }
        // Only what the latest subscription is owed: what is queued before it moves goes to the
        // subscription before.
        let since = self.latest_subscription();
        let drawn_at = state == State::Resized && self.subscribed();
        let replaced = |q: &Queued| q.state == Some(state) && (!drawn_at || q.at == Some(at));
        if let Some(i) = self.queue.iter().skip(since).position(replaced)
            && let Some(old) = self.queue.remove(since + i)
        {
            self.queued = self.queued.saturating_sub(old.frame.len());
        }
        let ours = |q: &Queued| q.state == Some(state);
        let resizes = self.queue.iter().skip(since).filter(|q| ours(q)).count();
        if drawn_at && resizes >= MOST_QUEUED_RESIZES {
            let (dropped, kept): (Vec<Queued>, Vec<Queued>) =
                self.queue.drain(since..).partition(|q| ours(q));
            let freed: usize = dropped.iter().map(|q| q.frame.len()).sum();
            self.queue.extend(kept);
            self.queued = self.queued.saturating_sub(freed);
            match since.checked_sub(1).and_then(|i| self.queue.get_mut(i)) {
                Some(subscription) => subscription.skip_to = Some(at),
                None => self.skip_to = Some(at),
            }
        }
        self.queued = self.queued.saturating_add(frame.len());
        self.queue.push_back(Queued {
            at: Some(at),
            frame,
            subscribes: None,
            rebases: None,
            snapshot: false,
            exit: false,
            state: Some(state),
            skip_to: None,
        });
    }

    /// `hello` is answered, in the generation that starts at `base`: the connection takes any
    /// request from here.
    pub fn open(&mut self, base: u64) {
        if self.is_opening() {
            self.phase = Phase::Open;
            self.base = base;
        }
    }

    /// Reads no more, and ends once what is queued is written or `HANG_UP_WITHIN` has passed.
    pub fn hang_up(&mut self, now: Instant) {
        if matches!(self.phase, Phase::Opening { .. } | Phase::Open) {
            self.phase = Phase::HangingUp {
                until: now + HANG_UP_WITHIN,
            };
        }
    }

    /// Ends the connection this turn, unwritten frames and all.
    pub fn drop_now(&mut self) {
        self.phase = Phase::Gone;
    }

    /// Whether the connection's requests are answered now: open or opening, and with its queue
    /// under the mark.
    fn answering(&self) -> bool {
        matches!(self.phase, Phase::Opening { .. } | Phase::Open) && self.queued < QUEUE_MARK
    }

    /// Whether a subscription draws the output queued from here: one in force, or one queued.
    fn subscribed(&self) -> bool {
        self.live_cursor().is_some()
            || (!self.input_ended && self.queue.iter().any(|q| q.subscribes.is_some()))
    }

    /// Where in the queue what the latest subscription is owed starts: after the last frame that
    /// moves the subscription, or at the front.
    fn latest_subscription(&self) -> usize {
        self.queue
            .iter()
            .rposition(|q| q.subscribes.is_some())
            .map_or(0, |i| i + 1)
    }

    /// Does what `poll` found for it, `revents`: reads while it reads. One that no longer reads
    /// and whose peer has gone is dropped: its socket would report the hang-up every turn.
    pub fn polled(&mut self, revents: PollFlags, buffer: &mut [u8]) {
        if revents.is_empty() {
            return;
        }
        if !self.reading() && revents.intersects(PollFlags::HUP | PollFlags::ERR) {
            tracing::info!("a peer hung up while it wasn't read; dropping its connection");
            self.drop_now();
            return;
        }
        self.receive(buffer);
    }

    /// Whether its socket is read now: while it is answered, has more to say, and has no whole
    /// request waiting.
    fn reading(&self) -> bool {
        self.answering()
            && !self.input_ended
            && !self.refused
            && self.next.is_none()
            && self.held.is_none()
    }

    /// Whether a whole request waits to be answered now. The loop must serve such a connection
    /// without waiting on `poll`: its socket may have nothing more to say until it is answered.
    pub fn has_request(&self) -> bool {
        self.answering() && self.next.is_some() && self.held.is_none()
    }

    /// What `poll` should wait for: to read while the socket is read, and to write while anything
    /// is owed, output up to `end` included, since a turn's writes are capped and may stop before
    /// the peer's buffer fills.
    pub fn interest(&self, end: u64) -> PollFlags {
        let mut flags = PollFlags::empty();
        if self.reading() {
            flags |= PollFlags::IN;
        }
        let owed = !self.out.is_empty()
            || !self.queue.is_empty()
            || self.live_cursor().is_some_and(|cursor| cursor < end);
        if owed && !self.is_gone() {
            flags |= PollFlags::OUT;
        }
        flags
    }

    /// The cursor, while the subscription lasts: it ends with the connection's input, after which
    /// no output is started or owed, and no event waits on output.
    fn live_cursor(&self) -> Option<u64> {
        self.cursor.filter(|_| !self.input_ended)
    }

    /// Queues a subscription's `ok`, after which output goes from `from` on: subscribing again
    /// moves it. Until the `ok` goes out, the subscription before it, if any, still has its output
    /// and events sent.
    pub fn queue_subscribed(&mut self, frame: Vec<u8>, from: u64) {
        if self.is_gone() || frame.is_empty() {
            return;
        }
        self.queued = self.queued.saturating_add(frame.len());
        self.queue.push_back(Queued {
            at: None,
            frame,
            subscribes: Some(from),
            rebases: None,
            snapshot: false,
            exit: false,
            state: None,
            skip_to: None,
        });
    }

    /// One read, into the decoder, while the socket is read. An end of input stops the reading
    /// but not the answers: the peer may have sent whole requests and half-closed to wait for
    /// them. A failed read drops the connection.
    pub fn receive(&mut self, buffer: &mut [u8]) {
        if !self.reading() {
            return;
        }
        let limit = buffer.len().min(READ_CHUNK);
        // An empty buffer would read as an end of input.
        let Some(chunk) = buffer.get_mut(..limit).filter(|chunk| !chunk.is_empty()) else {
            return;
        };
        match (&self.stream).read(chunk) {
            Ok(0) => self.input_ended = true,
            Ok(n) => {
                self.decoder.push(chunk.get(..n).unwrap_or_default());
                self.take_next();
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(error) => {
                tracing::warn!(%error, "a read failed; dropping its connection");
                self.drop_now();
            }
        }
    }

    fn take_next(&mut self) {
        if self.next.is_none() && !self.refused {
            self.next = self.decoder.next_frame().transpose();
        }
    }

    /// The next request read, while the connection is answered: none once its queue is past the
    /// mark, so the rest wait until the peer has read its answers. A malformed frame is handed over
    /// once, and nothing after it.
    pub fn next_request(&mut self) -> Option<Result<Request, Malformed>> {
        if !self.answering() {
            return None;
        }
        if let Some((held, since)) = self.held.take() {
            self.held_from = Some(since);
            return Some(Ok(held));
        }
        self.held_from = None;
        let next = self.next.take();
        if matches!(next, Some(Err(_))) {
            self.refused = true;
        }
        self.take_next();
        next
    }

    /// Queues a frame to be written after those already queued. The queue has no cap of its own:
    /// it stays bounded because requests stop being handed over past `QUEUE_MARK`, and each is
    /// answered with at most one bounded reply. Whatever queues more than an answer (a stream of
    /// output) must bound itself, as by pulling from the ring only as the peer reads.
    pub fn queue(&mut self, frame: Vec<u8>) {
        // An empty frame would write nothing, which reads as a peer that has gone.
        if self.is_gone() || frame.is_empty() {
            return;
        }
        self.queued = self.queued.saturating_add(frame.len());
        self.queue.push_back(Queued {
            at: None,
            frame,
            subscribes: None,
            rebases: None,
            snapshot: false,
            exit: false,
            state: None,
            skip_to: None,
        });
    }

    /// Queues the child's `exited`, at `at`, the output's end when it was published: a subscriber
    /// gets it once it has been sent the output before it, and any other connection as soon as
    /// the frames before it.
    pub fn queue_exited(&mut self, at: u64, frame: Vec<u8>) {
        self.push_event(at, frame, None, true);
    }

    /// Queues `exited` again, at `at`, after a subscription's `ok`, in place of one still queued
    /// for the same generation (none is queued after a `respawned` but its own): a subscription
    /// to an exited child ends with its `exited`, after the last of its output.
    pub fn requeue_exited(&mut self, at: u64, frame: Vec<u8>) {
        let generation = self
            .queue
            .iter()
            .rposition(|queued| queued.rebases.is_some())
            .map_or(0, |i| i + 1);
        let queued = self
            .queue
            .iter()
            .skip(generation)
            .position(|queued| queued.exit);
        if let Some(i) = queued
            && let Some(old) = self.queue.remove(generation + i)
        {
            self.queued = self.queued.saturating_sub(old.frame.len());
        }
        self.queue_exited(at, frame);
    }

    /// Queues `respawned`, an event at `at` where the new generation's output starts: once it is
    /// sent, offsets count from there.
    pub fn queue_respawned(&mut self, at: u64, frame: Vec<u8>) {
        self.push_event(at, frame, Some(at), false);
    }

    fn push_event(&mut self, at: u64, frame: Vec<u8>, rebases: Option<u64>, exit: bool) {
        if self.is_gone() || frame.is_empty() {
            return;
        }
        self.queued = self.queued.saturating_add(frame.len());
        self.queue.push_back(Queued {
            at: Some(at),
            frame,
            subscribes: None,
            rebases,
            snapshot: false,
            exit,
            state: None,
            skip_to: None,
        });
    }

    /// The next frame to write: the queue's first if it is an answer, or an event the output has
    /// reached; else, while subscribed, a `gap` if the ring has dropped the cursor's output, or
    /// output from the cursor up to the first queued event. An event waiting on output never
    /// blocks the output that frees it, and neither output nor a gap crosses one, so none spans a
    /// respawn.
    fn next_frame(&mut self, ring: &Ring) -> Option<(Vec<u8>, Origin)> {
        let live = self.live_cursor();
        let gate = match self.queue.front() {
            Some(front)
                if front
                    .at
                    .is_none_or(|at| live.is_none_or(|cursor| cursor >= at)) =>
            {
                let front = self.queue.pop_front()?;
                if let Some(from) = front.subscribes {
                    self.cursor = Some(from);
                    self.skip_to = front.skip_to;
                }
                if let Some(base) = front.rebases {
                    self.base = base;
                }
                let from = if front.snapshot {
                    Origin::Snapshot
                } else {
                    Origin::Queue
                };
                return Some((front.frame, from));
            }
            Some(front) => front.at,
            None => None,
        };
        let cursor = live?;
        let encoded = |reply: Reply| match reply.encode() {
            Ok(frame) => Some(frame),
            Err(error) => {
                tracing::warn!(%error, "could not encode output");
                None
            }
        };
        let limit = gate.unwrap_or(u64::MAX).min(ring.end());
        let skip = self.skip_to.map_or(ring.start(), |to| to.max(ring.start()));
        if self.skip_to.is_some_and(|to| cursor >= to) {
            self.skip_to = None;
        }
        if cursor < skip {
            let to = skip.min(limit);
            let gap = Gap {
                from: self.offset(cursor)?,
                to: self.offset(to)?,
            };
            self.cursor = Some(to);
            return encoded(Reply::Gap(gap)).map(|frame| (frame, Origin::Ring));
        }
        let room = usize::try_from(limit.checked_sub(cursor)?).unwrap_or(usize::MAX);
        let bytes = ring.read(cursor, room.min(DATA_FRAME))?;
        if bytes.is_empty() {
            return None;
        }
        let offset = self.offset(cursor)?;
        let frame = encoded(Reply::Data {
            offset,
            bytes: bytes.to_vec(),
        })?;
        self.cursor = Some(cursor.saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX)));
        Some((frame, Origin::Ring))
    }

    /// `offset` as the protocol carries it, counted from the start of the connection's generation.
    /// One past its range, 2^53 bytes of output in, can't be sent, so the connection is dropped
    /// rather than left owed output it can never write.
    fn offset(&mut self, offset: u64) -> Option<Offset> {
        let carried = offset
            .checked_sub(self.base)
            .and_then(|offset| Offset::new(offset).ok());
        if carried.is_none() {
            tracing::error!(offset, "output past what the protocol can carry; dropping");
            self.drop_now();
        }
        carried
    }

    /// Writes what is owed, output from `ring` included, up to `WRITE_PER_TURN`, until the peer's
    /// buffer is full. A frame is written whole, in parts if need be, before the next is chosen. A
    /// failed write, such as to a peer that has gone, drops the connection.
    pub fn flush(&mut self, now: Instant, ring: &Ring) {
        let mut budget = WRITE_PER_TURN;
        for _ in 0..WRITES_PER_TURN {
            if budget == 0 || self.is_gone() {
                return;
            }
            if self.out.is_empty() {
                let Some((frame, from)) = self.next_frame(ring) else {
                    self.stuck_since = None;
                    return;
                };
                self.out = frame;
                self.out_from = from;
                self.written = 0;
            }
            let pending = self.out.get(self.written..).unwrap_or_default();
            let cut = pending.get(..pending.len().min(budget)).unwrap_or_default();
            match (&self.stream).write(cut) {
                Ok(0) => self.drop_now(),
                Ok(n) => {
                    self.stuck_since = None;
                    budget -= n;
                    self.written += n;
                    if self.out_from == Origin::Snapshot {
                        self.owed_snapshot = self.owed_snapshot.saturating_sub(n);
                    }
                    if self.written == self.out.len() {
                        if self.out_from != Origin::Ring {
                            self.queued = self.queued.saturating_sub(self.out.len());
                        }
                        self.out.clear();
                        self.written = 0;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    self.stuck_since.get_or_insert(now);
                    return;
                }
                Err(error) => {
                    tracing::warn!(%error, "a write failed; dropping its connection");
                    self.drop_now();
                }
            }
        }
    }

    /// When this connection next needs looking at, with nothing to read or write.
    pub fn deadline(&self) -> Option<Instant> {
        match self.phase {
            Phase::Opening { until } | Phase::HangingUp { until } => Some(until),
            Phase::Open | Phase::Gone => None,
        }
    }

    /// Whether the connection is over: dropped, hung up with all written or out of time, never
    /// said `hello` in time, or ended by its peer with every whole request answered and written.
    /// A subscription ends with its peer's input: a peer that has ended its side is owed answers,
    /// not output, which a live child would make endless.
    pub fn is_finished(&self, now: Instant) -> bool {
        // The end of input is read only once no whole request waits, and nothing is read after it.
        let written = self.queue.is_empty() && self.out.is_empty();
        let answered = self.input_ended && written && self.held.is_none();
        match self.phase {
            Phase::Gone => true,
            Phase::Opening { until } => answered || now >= until,
            Phase::HangingUp { until } => written || now >= until,
            Phase::Open => answered,
        }
    }
}

#[cfg(test)]
mod tests {
    use bazhen_holder_proto::RequestId;

    use super::*;

    /// The peer's side, reading frames as they come: one decoder for the connection's life, since
    /// a frame may arrive across reads.
    struct Peer {
        stream: UnixStream,
        decoder: bazhen_holder_proto::FrameDecoder<Reply>,
    }

    impl Peer {
        fn of(stream: UnixStream) -> Self {
            stream.set_nonblocking(true).unwrap();
            Self {
                stream,
                decoder: bazhen_holder_proto::reply_decoder(),
            }
        }

        /// Every whole frame sent since the last call.
        fn sent(&mut self) -> Vec<Reply> {
            let mut chunk = vec![0; 1 << 16];
            loop {
                match self.stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => self.decoder.push(&chunk[..n]),
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) => panic!("{e}"),
                }
            }
            std::iter::from_fn(|| self.decoder.next_frame().unwrap()).collect()
        }
    }

    fn subscribed(now: Instant, from: u64) -> (Connection, Peer) {
        let (mut conn, peer) = pair(now);
        conn.queue_subscribed(ok_frame(1), from);
        (conn, Peer::of(peer))
    }

    fn ok_frame(id: u32) -> Vec<u8> {
        let request = "subscribe".to_owned();
        let body = bazhen_holder_proto::body::OkBody { request };
        Reply::Ok {
            id: RequestId(id),
            body,
        }
        .encode()
        .unwrap()
    }

    fn exited_frame() -> Vec<u8> {
        let exited = bazhen_holder_proto::body::Exited {
            generation: bazhen_holder_proto::body::Generation::new(0).unwrap(),
            status: bazhen_holder_proto::body::ExitStatus::Unknown,
        };
        Reply::Exited(exited).encode().unwrap()
    }

    fn ring_of(capacity: usize, bytes: &[u8]) -> Ring {
        let mut ring = Ring::new(capacity);
        ring.push(bytes);
        ring
    }

    /// (offset, bytes) of a data frame, or None for any other.
    fn data(reply: &Reply) -> Option<(u64, &[u8])> {
        match reply {
            Reply::Data { offset, bytes } => Some((offset.get(), bytes)),
            _ => None,
        }
    }

    fn is_ok(reply: &Reply, id: u32) -> bool {
        matches!(reply, Reply::Ok { id: got, .. } if *got == RequestId(id))
    }

    #[test]
    fn a_subscription_is_answered_before_any_of_its_output() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        conn.flush(now, &ring_of(64, b"hello"));
        let replies = peer.sent();
        assert!(is_ok(&replies[0], 1));
        assert_eq!(data(&replies[1]), Some((0, &b"hello"[..])));
        assert_eq!(replies.len(), 2);
    }

    /// An event waits for the output before it, and doesn't stop that output going out, nor the
    /// answers queued after it once it has gone.
    #[test]
    fn an_event_goes_after_the_output_before_it_and_holds_up_nothing_else() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        let ring = ring_of(64, b"0123456789");
        conn.queue_exited(6, exited_frame());
        conn.queue(ok_frame(2));
        conn.flush(now, &ring);
        let replies = peer.sent();
        assert!(is_ok(&replies[0], 1));
        assert_eq!(data(&replies[1]), Some((0, &b"012345"[..])));
        assert!(matches!(replies[2], Reply::Exited(_)));
        assert!(is_ok(&replies[3], 2));
        assert_eq!(data(&replies[4]), Some((6, &b"6789"[..])));
    }

    /// Subscribing again, back or to the end, while a live subscription has an event waiting on
    /// its output: that output and the event go first, then the `ok`, then the new output.
    #[test]
    fn subscribing_again_waits_for_what_the_old_subscription_was_owed() {
        let now = Instant::now();
        for (from, after) in [(2, &b"23456789ab"[..]), (12, &b""[..])] {
            let (mut conn, mut peer) = subscribed(now, 0);
            conn.queue_exited(10, exited_frame());
            conn.flush(now, &ring_of(64, b"012345"));
            let first = peer.sent();
            assert_eq!(data(&first[1]), Some((0, &b"012345"[..])), "{from}");
            conn.queue_subscribed(ok_frame(2), from);
            conn.flush(now, &ring_of(64, b"0123456789ab"));
            let replies = peer.sent();
            assert_eq!(data(&replies[0]), Some((6, &b"6789"[..])), "{from}");
            assert!(matches!(replies[1], Reply::Exited(_)), "{from}");
            assert!(is_ok(&replies[2], 2), "{from}");
            let rest: Vec<u8> = replies[3..]
                .iter()
                .flat_map(|reply| data(reply).unwrap().1.to_vec())
                .collect();
            assert_eq!(rest, after, "{from}");
        }
    }

    fn respawned_frame() -> Vec<u8> {
        Reply::Respawned(bazhen_holder_proto::body::Respawned {
            generation: bazhen_holder_proto::body::Generation::new(1).unwrap(),
            child_pid: bazhen_holder_proto::body::Pid::new(7).unwrap(),
            child_start: bazhen_holder_proto::body::StartTime::new(0).unwrap(),
        })
        .encode()
        .unwrap()
    }

    /// Output before a respawn keeps its offsets; output after it counts from 0, and no data
    /// frame holds output of both.
    #[test]
    fn output_after_a_respawn_counts_from_zero_and_no_frame_spans_it() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        conn.queue_exited(4, exited_frame());
        conn.queue_respawned(6, respawned_frame());
        conn.flush(now, &ring_of(64, b"0123ab456789"));
        let replies = peer.sent();
        assert!(is_ok(&replies[0], 1));
        assert_eq!(data(&replies[1]), Some((0, &b"0123"[..])));
        assert!(matches!(replies[2], Reply::Exited(_)));
        assert_eq!(data(&replies[3]), Some((4, &b"ab"[..])));
        assert!(matches!(replies[4], Reply::Respawned(_)));
        assert_eq!(data(&replies[5]), Some((0, &b"456789"[..])));
        assert_eq!(replies.len(), 6);
    }

    /// A subscriber the ring lapped across a respawn is told of a gap to the end of the old
    /// generation, then of the respawn, then of a gap from 0 in the new one.
    #[test]
    fn a_gap_across_a_respawn_ends_at_it_and_goes_on_from_zero() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        conn.queue_respawned(4, respawned_frame());
        conn.flush(now, &ring_of(4, b"0123456789"));
        let replies = peer.sent();
        let gaps: Vec<(u64, u64)> = replies
            .iter()
            .filter_map(|reply| match reply {
                Reply::Gap(gap) => Some((gap.from.get(), gap.to.get())),
                _ => None,
            })
            .collect();
        assert_eq!(gaps, [(0, 4), (0, 2)]);
        assert!(matches!(replies[2], Reply::Respawned(_)));
        assert_eq!(data(&replies[4]).map(|(offset, _)| offset), Some(2));
        let rest: Vec<u8> = replies[4..]
            .iter()
            .flat_map(|reply| data(reply).unwrap().1.to_vec())
            .collect();
        assert_eq!(rest, b"6789");
    }

    /// A connection that says `hello` after a respawn counts offsets from the new generation's
    /// start.
    #[test]
    fn a_connection_opened_after_a_respawn_counts_from_its_start() {
        let now = Instant::now();
        let (mut conn, peer) = pair(now);
        let mut peer = Peer::of(peer);
        conn.open(6);
        conn.queue_subscribed(ok_frame(1), 6);
        conn.flush(now, &ring_of(64, b"012345abc"));
        let replies = peer.sent();
        assert_eq!(data(&replies[1]), Some((0, &b"abc"[..])));
    }

    #[test]
    fn a_connection_not_subscribed_gets_an_event_at_once() {
        let now = Instant::now();
        let (mut conn, peer) = pair(now);
        let mut peer = Peer::of(peer);
        conn.queue_exited(1_000, exited_frame());
        conn.flush(now, &ring_of(64, b"0123"));
        assert!(matches!(peer.sent().as_slice(), [Reply::Exited(_)]));
    }

    #[test]
    fn a_subscriber_the_ring_has_lapped_gets_a_gap_then_output_from_its_start() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        conn.flush(now, &ring_of(16, &[7; 40]));
        let replies = peer.sent();
        match &replies[1] {
            Reply::Gap(gap) => assert_eq!((gap.from.get(), gap.to.get()), (0, 24)),
            other => panic!("sent {other:?}"),
        }
        // The buffer wraps at offset 32, so the output comes in two frames.
        let mut offset = 24;
        let mut after = Vec::new();
        for reply in &replies[2..] {
            let (at, bytes) = data(reply).unwrap();
            assert_eq!(at, offset);
            offset += bytes.len() as u64;
            after.extend_from_slice(bytes);
        }
        assert_eq!(after, [7; 16]);
    }

    #[test]
    fn output_goes_out_whole_in_order_and_in_frames_of_at_most_64_kib() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        let all: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
        let ring = ring_of(1 << 20, &all);
        let mut got = Vec::new();
        while got.len() < all.len() {
            conn.flush(now, &ring);
            for reply in peer.sent() {
                let Some((offset, bytes)) = data(&reply) else {
                    continue;
                };
                assert_eq!(offset, got.len() as u64);
                assert!(bytes.len() <= DATA_FRAME);
                got.extend_from_slice(bytes);
            }
        }
        assert_eq!(got, all);
        assert!(!conn.interest(ring.end()).contains(PollFlags::OUT));
    }

    #[test]
    fn a_caught_up_subscriber_asks_poll_for_nothing_until_there_is_output() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        let ring = ring_of(64, b"abcdef");
        conn.flush(now, &ring);
        peer.sent();
        assert!(!conn.interest(ring.end()).contains(PollFlags::OUT));
        assert!(conn.interest(ring.end() + 1).contains(PollFlags::OUT));
    }

    /// A peer that has ended its side is owed its answers, not output a live child would make
    /// endless: its subscription ends with its input.
    #[test]
    fn a_subscription_ends_with_its_peers_input() {
        let now = Instant::now();
        let (mut conn, peer) = pair(now);
        conn.open(0);
        conn.queue_subscribed(ok_frame(1), 0);
        conn.queue_exited(10, exited_frame());
        let mut peer = Peer::of(peer);
        peer.stream.shutdown(std::net::Shutdown::Write).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        // More than a turn writes, so ending with the input differs from ending once caught up.
        let ring = ring_of(2 * WRITE_PER_TURN, &vec![7; 2 * WRITE_PER_TURN]);
        let mut sent = Vec::new();
        while !conn.is_finished(now) && sent.len() < 1000 {
            conn.flush(now, &ring);
            sent.extend(peer.sent());
        }
        assert!(conn.is_finished(now));
        assert!(is_ok(&sent[0], 1));
        assert!(matches!(sent[1], Reply::Exited(_)));
        assert_eq!(sent.len(), 2, "output sent after the input ended");
        assert!(!conn.interest(ring.end()).contains(PollFlags::OUT));
    }

    fn no_output() -> Ring {
        Ring::new(1)
    }

    fn pair(now: Instant) -> (Connection, UnixStream) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_nonblocking(true).unwrap();
        (Connection::new(1, ours, now), theirs)
    }

    fn close_request(id: u32) -> Vec<u8> {
        Request::Close { id: RequestId(id) }.encode().unwrap()
    }

    #[test]
    fn hands_over_requests_in_the_order_they_were_written_however_they_were_cut() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        let mut bytes = close_request(1);
        bytes.extend(close_request(2));
        let (first, second) = bytes.split_at(7);
        let mut buffer = vec![0; READ_CHUNK];
        peer.write_all(first).unwrap();
        conn.receive(&mut buffer);
        assert!(conn.next_request().is_none());
        peer.write_all(second).unwrap();
        conn.receive(&mut buffer);
        let ids: Vec<_> = std::iter::from_fn(|| conn.next_request())
            .map(|r| r.unwrap().id())
            .collect();
        assert_eq!(ids, [RequestId(1), RequestId(2)]);
    }

    #[test]
    fn a_peer_that_reads_nothing_stops_being_read_past_the_mark() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        peer.write_all(&close_request(1)).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        while conn.queued() < QUEUE_MARK {
            conn.queue(vec![0; 64 << 10]);
            conn.flush(now, &no_output());
        }
        assert!(conn.next_request().is_none(), "read past the mark");
        assert!(
            !conn.has_request(),
            "a request waiting past the mark counts as one to serve"
        );
        assert!(!conn.interest(0).contains(PollFlags::IN));
        assert!(conn.interest(0).contains(PollFlags::OUT));
        assert_eq!(conn.stuck_since(), Some(now));
        let mut drained = vec![0; 1 << 20];
        while conn.queued() > 0 {
            let n = peer.read(&mut drained).unwrap();
            assert!(n > 0);
            conn.flush(now, &no_output());
        }
        assert_eq!(conn.next_request().unwrap().unwrap().id(), RequestId(1));
        assert_eq!(conn.stuck_since(), None);
    }

    #[test]
    fn writes_every_frame_whole_and_in_order() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        // Each larger than the socket's buffer, so every frame is written in parts.
        let frames: Vec<Vec<u8>> = (0u8..20).map(|n| vec![n; 300_000]).collect();
        let mut expected = Vec::new();
        for frame in &frames {
            conn.queue(frame.clone());
            expected.extend_from_slice(frame);
        }
        let mut got = Vec::new();
        let mut chunk = vec![0; 1 << 16];
        while got.len() < expected.len() {
            conn.flush(now, &no_output());
            let n = peer.read(&mut chunk).unwrap();
            got.extend_from_slice(&chunk[..n]);
        }
        assert_eq!(got, expected);
        assert_eq!(conn.queued(), 0);
    }

    /// A turn that stops writing for its cap, not a full buffer, must still wake the next one.
    #[test]
    fn a_turn_that_stops_at_its_cap_leaves_the_rest_to_the_next() {
        let now = Instant::now();
        let (mut conn, _peer) = pair(now);
        for _ in 0..WRITES_PER_TURN + 10 {
            conn.queue(vec![7; 8]);
        }
        conn.flush(now, &no_output());
        assert_eq!(conn.queued(), 10 * 8);
        assert_eq!(conn.stuck_since(), None);
        assert!(conn.interest(0).contains(PollFlags::OUT));
        conn.flush(now, &no_output());
        assert_eq!(conn.queued(), 0);
        assert!(!conn.interest(0).contains(PollFlags::OUT));
    }

    #[test]
    fn a_hang_up_ends_once_written_or_out_of_time_and_reads_nothing_more() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        conn.queue(vec![1; 10]);
        conn.hang_up(now);
        peer.write_all(&close_request(1)).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert!(conn.next_request().is_none());
        assert!(!conn.is_finished(now));
        assert!(conn.is_finished(now + HANG_UP_WITHIN));
        conn.flush(now, &no_output());
        assert!(conn.is_finished(now));
    }

    #[test]
    fn a_connection_that_never_says_hello_ends_in_time_and_one_that_does_stays() {
        let now = Instant::now();
        let (mut conn, _peer) = pair(now);
        assert_eq!(conn.deadline(), Some(now + HELLO_WITHIN));
        assert!(conn.is_finished(now + HELLO_WITHIN));
        conn.open(0);
        assert!(!conn.is_finished(now + HELLO_WITHIN * 10));
        assert_eq!(conn.deadline(), None);
    }

    #[test]
    fn a_peer_that_ends_its_side_is_read_no_more_and_one_that_goes_is_dropped() {
        let now = Instant::now();
        let (mut conn, peer) = pair(now);
        conn.open(0);
        conn.queue(vec![1; 10]);
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert!(!conn.interest(0).contains(PollFlags::IN));
        assert!(!conn.is_finished(now), "ended with an answer still owed");
        conn.flush(now, &no_output());
        assert!(conn.is_finished(now));
        let (mut conn, peer) = pair(now);
        drop(peer);
        conn.queue(vec![1; 10]);
        conn.flush(now, &no_output());
        assert!(conn.is_gone());
        assert_eq!(conn.interest(0), PollFlags::empty());
    }

    /// Writing nothing, or reading into nothing, returns 0, which is how a gone or finished peer
    /// reads: neither may be taken for one.
    #[test]
    fn an_empty_frame_or_buffer_ends_nothing() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        conn.open(0);
        conn.queue(Vec::new());
        conn.flush(now, &no_output());
        assert!(!conn.is_gone());
        // With bytes waiting, a read into nothing returns 0 at once.
        peer.write_all(&[0]).unwrap();
        conn.receive(&mut []);
        assert!(conn.interest(0).contains(PollFlags::IN));
        assert!(!conn.is_finished(now));
    }

    /// The decoder refuses every frame after a malformed one, so a connection that handed one
    /// over has nothing more to hand over, however much the peer sends.
    #[test]
    fn hands_over_a_malformed_frame_once_and_nothing_after_it() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        conn.open(0);
        peer.write_all(&u32::MAX.to_be_bytes()).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert!(matches!(conn.next_request(), Some(Err(_))));
        assert!(!conn.has_request());
        assert!(conn.next_request().is_none());
        peer.write_all(&close_request(1)).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert!(conn.next_request().is_none());
        assert!(!conn.interest(0).contains(PollFlags::IN));
    }

    /// A peer that sends its requests, ends its side and then reads is owed every answer.
    #[test]
    fn answers_every_request_sent_before_the_peer_ended_its_side() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        conn.open(0);
        peer.write_all(&[close_request(1), close_request(2)].concat())
            .unwrap();
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert_eq!(conn.next_request().unwrap().unwrap().id(), RequestId(1));
        conn.queue(vec![0; QUEUE_MARK]);
        assert!(conn.next_request().is_none(), "answered past the mark");
        let mut drained = vec![0; 1 << 20];
        while conn.queued() > 0 {
            conn.flush(now, &no_output());
            let _ = peer.read(&mut drained).unwrap();
        }
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert!(conn.has_request());
        assert_eq!(conn.next_request().unwrap().unwrap().id(), RequestId(2));
        assert!(!conn.is_finished(now));
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert!(conn.is_finished(now), "the end of input was never read");
    }

    /// While a whole request waits, the socket isn't read, so what the peer sends after it stays
    /// in the kernel's buffer rather than the decoder.
    #[test]
    fn reads_nothing_more_while_a_whole_request_waits() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        peer.write_all(&close_request(1)).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert!(conn.has_request());
        assert!(!conn.interest(0).contains(PollFlags::IN));
        peer.write_all(&close_request(2)).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert_eq!(conn.next_request().unwrap().unwrap().id(), RequestId(1));
        assert!(!conn.has_request(), "read while a request waited");
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert_eq!(conn.next_request().unwrap().unwrap().id(), RequestId(2));
    }

    fn title_frame(offset: u64, text: &str) -> Vec<u8> {
        let title = bazhen_holder_proto::body::Title {
            offset: Offset::new(offset).unwrap(),
            text: text.to_owned(),
        };
        Reply::Title(title).encode().unwrap()
    }

    fn names(replies: &[Reply]) -> Vec<String> {
        replies
            .iter()
            .map(|reply| match reply {
                Reply::Title(title) => format!("title {}", title.text),
                Reply::Exited(_) => "exited".to_owned(),
                Reply::Respawned(_) => "respawned".to_owned(),
                Reply::Ok { .. } => "ok".to_owned(),
                other => format!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn a_state_queued_again_replaces_the_one_still_queued_and_goes_behind_what_came_since() {
        let now = Instant::now();
        let (mut conn, peer) = pair(now);
        let mut peer = Peer::of(peer);
        conn.open(0);
        conn.queue_state(State::Title, 0, title_frame(0, "first"));
        conn.queue_exited(0, exited_frame());
        conn.queue_state(State::Title, 0, title_frame(0, "second"));
        let queued = conn.queued();
        conn.flush(now, &no_output());
        assert_eq!(names(&peer.sent()), ["exited", "title second"]);
        assert_eq!(
            queued,
            exited_frame().len() + title_frame(0, "second").len(),
            "the replaced one still counted"
        );
    }

    #[test]
    fn a_snapshots_bytes_are_owed_until_written_and_not_once_its_connection_is_gone() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        conn.open(0);
        let frame = vec![1; 4 << 20];
        conn.queue_snapshot(frame.clone(), 7);
        assert_eq!(conn.owed_snapshot(), frame.len());
        conn.flush(now, &no_output());
        let left = conn.owed_snapshot();
        assert!(0 < left && left < frame.len(), "{left} of a snapshot owed");
        let mut chunk = vec![0; 1 << 20];
        while conn.owed_snapshot() > 0 {
            let _ = peer.read(&mut chunk).unwrap();
            conn.flush(now, &no_output());
        }
        conn.queue_snapshot(frame, 9);
        conn.drop_now();
        assert_eq!(conn.owed_snapshot(), 0);
    }

    #[test]
    fn a_held_snapshot_comes_back_before_the_requests_after_it_and_keeps_its_connection() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        conn.open(0);
        peer.write_all(&Request::Snapshot { id: RequestId(1) }.encode().unwrap())
            .unwrap();
        peer.write_all(&close_request(2)).unwrap();
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        let snapshot = conn.next_request().unwrap().unwrap();
        conn.hold(snapshot, now);
        assert!(
            !conn.has_request(),
            "a held snapshot counts as a request to answer now"
        );
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert!(
            !conn.is_finished(now),
            "it ended with its snapshot unanswered"
        );
        assert_eq!(conn.next_request().unwrap().unwrap().id(), RequestId(1));
        assert_eq!(conn.next_request().unwrap().unwrap().id(), RequestId(2));
    }

    #[test]
    fn exited_queued_again_replaces_its_generations_but_not_one_before_a_respawn() {
        let now = Instant::now();
        let (mut conn, peer) = pair(now);
        let mut peer = Peer::of(peer);
        conn.open(0);
        conn.queue_exited(0, exited_frame());
        conn.queue_respawned(0, respawned_frame());
        conn.queue_exited(0, exited_frame());
        conn.queue_subscribed(ok_frame(1), 0);
        conn.requeue_exited(0, exited_frame());
        conn.flush(now, &no_output());
        assert_eq!(names(&peer.sent()), ["exited", "respawned", "ok", "exited"]);
    }

    fn snapshot_frame(text_bytes: usize) -> Vec<u8> {
        let mut frame = bazhen_holder_proto::SnapshotFrame::default();
        frame.text().push_str(&"s".repeat(text_bytes));
        frame
            .finish(RequestId(2), Offset::new(0).unwrap(), 0)
            .unwrap()
    }

    fn resized_frame(offset: u64) -> Vec<u8> {
        let resized = bazhen_holder_proto::body::Resized {
            offset: Offset::new(offset).unwrap(),
            cols: bazhen_holder_proto::body::Cols::new(100).unwrap(),
            rows: bazhen_holder_proto::body::Rows::new(30).unwrap(),
        };
        Reply::Resized(resized).encode().unwrap()
    }

    /// Flushes and reads until the peer has been sent everything owed and the ring's output.
    fn drain(conn: &mut Connection, peer: &mut Peer, ring: &Ring) -> Vec<Reply> {
        let now = Instant::now();
        let mut sent = Vec::new();
        for _ in 0..1000 {
            conn.flush(now, ring);
            sent.extend(peer.sent());
            if conn.interest(ring.end()).is_empty()
                || !conn.interest(ring.end()).contains(PollFlags::OUT)
            {
                break;
            }
        }
        sent
    }

    #[test]
    fn a_subscriber_that_snapshots_again_is_sent_no_output_from_before_the_snapshot_after_it() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        conn.open(0);
        let mut ring = ring_of(1 << 20, &[b'a'; 100]);
        let _ = drain(&mut conn, &mut peer, &ring);
        // Output it lags behind, then a snapshot past the mark as of the end, its subscribe unread.
        ring.push(&[b'b'; 100]);
        conn.queue_snapshot(snapshot_frame(QUEUE_MARK), 200);
        let mut sent = drain(&mut conn, &mut peer, &ring);
        ring.push(&[b'c'; 50]);
        sent.extend(drain(&mut conn, &mut peer, &ring));
        let snapshot = sent
            .iter()
            .position(|reply| matches!(reply, Reply::Snapshot { .. }))
            .unwrap();
        let after: Vec<u64> = sent[snapshot..]
            .iter()
            .filter_map(|r| data(r).map(|(at, _)| at))
            .collect();
        assert_eq!(
            after.first(),
            Some(&200),
            "output from before the snapshot followed it"
        );
        assert!(
            sent[..snapshot]
                .iter()
                .filter_map(data)
                .all(|(at, _)| at < 200)
        );
    }

    #[test]
    fn a_connection_whose_snapshot_waits_ends_once_its_peer_hangs_up() {
        let now = Instant::now();
        let (mut conn, peer) = pair(now);
        conn.open(0);
        conn.hold(Request::Snapshot { id: RequestId(1) }, now);
        drop(peer);
        // Linux reports the hang-up on a socket polled for nothing, which is what spun the loop;
        // macOS registers nothing for it, so there the loop only ever sees the hang-up below.
        #[cfg(target_os = "linux")]
        {
            let mut fds = [rustix::event::PollFd::from_borrowed_fd(
                conn.fd(),
                conn.interest(0),
            )];
            let timeout = rustix::event::Timespec {
                tv_sec: 5,
                tv_nsec: 0,
            };
            rustix::event::poll(&mut fds, Some(&timeout)).unwrap();
            let revents = fds[0].revents();
            assert!(revents.contains(PollFlags::HUP), "{revents:?}");
        }
        conn.polled(PollFlags::HUP, &mut vec![0; READ_CHUNK]);
        assert!(conn.is_finished(now), "it would spin on the hang-up");
    }

    #[test]
    fn a_subscriber_that_lags_is_sent_each_resize_at_its_offset() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        conn.open(0);
        conn.queue_state(State::Resized, 10, resized_frame(10));
        conn.queue_state(State::Resized, 20, resized_frame(20));
        let ring = ring_of(1 << 10, &[b'x'; 30]);
        let sent = drain(&mut conn, &mut peer, &ring);
        let order: Vec<String> = sent
            .iter()
            .map(|reply| match reply {
                Reply::Data { offset, bytes } => format!("data {}+{}", offset.get(), bytes.len()),
                Reply::Resized(resized) => format!("resized {}", resized.offset.get()),
                other => names(std::slice::from_ref(other)).concat(),
            })
            .collect();
        assert_eq!(
            order,
            [
                "ok",
                "data 0+10",
                "resized 10",
                "data 10+10",
                "resized 20",
                "data 20+10"
            ]
        );
    }

    #[test]
    fn a_subscriber_owed_more_resizes_than_are_kept_gets_a_gap_to_the_newest() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        conn.open(0);
        let newest = 10 * (MOST_QUEUED_RESIZES as u64 + 1);
        for n in 1..=MOST_QUEUED_RESIZES as u64 + 1 {
            conn.queue_state(State::Resized, 10 * n, resized_frame(10 * n));
        }
        let ring = ring_of(1 << 10, &[b'x'; 200]);
        let sent = drain(&mut conn, &mut peer, &ring);
        let resizes: Vec<u64> = sent
            .iter()
            .filter_map(|r| match r {
                Reply::Resized(resized) => Some(resized.offset.get()),
                _ => None,
            })
            .collect();
        assert_eq!(resizes, [newest]);
        assert!(
            sent.iter().any(
                |r| matches!(r, Reply::Gap(gap) if gap.from.get() == 0 && gap.to.get() == newest)
            ),
            "{sent:?}"
        );
        assert_eq!(
            sent.iter().filter_map(data).map(|(at, _)| at).next(),
            Some(newest)
        );
    }

    #[test]
    fn a_snapshot_after_a_subscription_still_queued_moves_it_to_the_snapshot() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        conn.open(0);
        conn.queue_snapshot(snapshot_frame(10), 200);
        let ring = ring_of(1 << 20, &[b'a'; 250]);
        let sent = drain(&mut conn, &mut peer, &ring);
        let offsets: Vec<u64> = sent
            .iter()
            .filter_map(|r| data(r).map(|(at, _)| at))
            .collect();
        assert_eq!(offsets, [200], "output from before the snapshot was sent");
        assert_eq!(
            conn.take_after_snapshot(),
            Some(AfterSnapshot {
                at: 200,
                moved: true
            })
        );
    }

    #[test]
    fn resizes_owed_to_a_subscription_being_replaced_are_kept_past_the_new_ones_cap() {
        let now = Instant::now();
        let (mut conn, mut peer) = subscribed(now, 0);
        conn.open(0);
        conn.queue_state(State::Resized, 10, resized_frame(10));
        conn.queue_subscribed(ok_frame(2), 0);
        let newest = 10 * (MOST_QUEUED_RESIZES as u64 + 2);
        for n in 2..=MOST_QUEUED_RESIZES as u64 + 2 {
            conn.queue_state(State::Resized, 10 * n, resized_frame(10 * n));
        }
        let ring = ring_of(1 << 10, &[b'x'; 200]);
        let sent = drain(&mut conn, &mut peer, &ring);
        let resizes: Vec<u64> = sent
            .iter()
            .filter_map(|r| match r {
                Reply::Resized(resized) => Some(resized.offset.get()),
                _ => None,
            })
            .collect();
        assert_eq!(resizes, [10, newest], "the old subscription's resize went");
        let gap = sent.iter().position(|r| matches!(r, Reply::Gap(_)));
        let second_ok = sent.iter().rposition(|r| {
            matches!(
                r,
                Reply::Ok {
                    id: RequestId(2),
                    ..
                }
            )
        });
        assert!(
            gap > second_ok,
            "the gap came before its subscription: {sent:?}"
        );
    }
}
