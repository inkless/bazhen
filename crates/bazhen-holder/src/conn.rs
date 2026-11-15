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
/// once the `ok` goes out, so what was owed under the old subscription goes first.
#[derive(Debug)]
struct Queued {
    at: Option<u64>,
    frame: Vec<u8>,
    subscribes: Option<u64>,
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
    /// The frame being written, how much of it is, and whether it came from the queue, whose
    /// bytes count against the mark until written; output from the ring doesn't.
    out: Vec<u8>,
    written: usize,
    out_queued: bool,
    /// The offset of the next output this connection is sent, while it is subscribed.
    cursor: Option<u64>,
    /// Since when a write has found the peer's buffer full, with nothing written since.
    stuck_since: Option<Instant>,
    accepted: Instant,
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
            out_queued: false,
            cursor: None,
            queued: 0,
            written: 0,
            stuck_since: None,
            accepted: now,
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

    /// `hello` is answered: the connection takes any request from here.
    pub fn open(&mut self) {
        if self.is_opening() {
            self.phase = Phase::Open;
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

    /// Whether its socket is read now: while it is answered, has more to say, and has no whole
    /// request waiting.
    fn reading(&self) -> bool {
        self.answering() && !self.input_ended && !self.refused && self.next.is_none()
    }

    /// Whether a whole request waits to be answered now. The loop must serve such a connection
    /// without waiting on `poll`: its socket may have nothing more to say until it is answered.
    pub fn has_request(&self) -> bool {
        self.answering() && self.next.is_some()
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
        });
    }

    /// Queues an event that happened at offset `at` of the output: a subscriber gets it once it has
    /// been sent the output before it, and any other connection as soon as the frames before it.
    pub fn queue_event(&mut self, at: u64, frame: Vec<u8>) {
        if self.is_gone() || frame.is_empty() {
            return;
        }
        self.queued = self.queued.saturating_add(frame.len());
        self.queue.push_back(Queued {
            at: Some(at),
            frame,
            subscribes: None,
        });
    }

    /// The next frame to write: the queue's first if it is an answer, or an event the output has
    /// reached; else, while subscribed, a `gap` if the ring has dropped the cursor's output, or
    /// output from the cursor up to the first queued event. An event waiting on output never
    /// blocks the output that frees it.
    fn next_frame(&mut self, ring: &Ring) -> Option<(Vec<u8>, bool)> {
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
                }
                return Some((front.frame, true));
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
        if cursor < ring.start() {
            let gap = Gap {
                from: self.offset(cursor)?,
                to: self.offset(ring.start())?,
            };
            self.cursor = Some(ring.start());
            return encoded(Reply::Gap(gap)).map(|frame| (frame, false));
        }
        let limit = gate.unwrap_or(u64::MAX).min(ring.end());
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
        Some((frame, false))
    }

    /// `offset` as the protocol carries it. One past its range, 2^53 bytes of output in, can't be
    /// sent, so the connection is dropped rather than left owed output it can never write.
    fn offset(&mut self, offset: u64) -> Option<Offset> {
        let carried = Offset::new(offset).ok();
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
                let Some((frame, queued)) = self.next_frame(ring) else {
                    self.stuck_since = None;
                    return;
                };
                self.out = frame;
                self.out_queued = queued;
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
                    if self.written == self.out.len() {
                        if self.out_queued {
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
        let answered = self.input_ended && written;
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
        conn.queue_event(6, exited_frame());
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
            conn.queue_event(10, exited_frame());
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

    #[test]
    fn a_connection_not_subscribed_gets_an_event_at_once() {
        let now = Instant::now();
        let (mut conn, peer) = pair(now);
        let mut peer = Peer::of(peer);
        conn.queue_event(1_000, exited_frame());
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
        conn.open();
        conn.queue_subscribed(ok_frame(1), 0);
        conn.queue_event(10, exited_frame());
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
        conn.open();
        assert!(!conn.is_finished(now + HELLO_WITHIN * 10));
        assert_eq!(conn.deadline(), None);
    }

    #[test]
    fn a_peer_that_ends_its_side_is_read_no_more_and_one_that_goes_is_dropped() {
        let now = Instant::now();
        let (mut conn, peer) = pair(now);
        conn.open();
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
        conn.open();
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
        conn.open();
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
        conn.open();
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
}
