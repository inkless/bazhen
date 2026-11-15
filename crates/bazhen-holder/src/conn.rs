//! One connection to the holder: the requests it has sent, the frames it is owed, and when it
//! ends. Every buffer here is bounded, whatever the peer does, and nothing a peer does stalls the
//! holder or reaches another connection: the socket is non-blocking, and a peer that stops reading
//! stops being read.

use std::collections::VecDeque;
use std::io::{self, Read as _, Write as _};
use std::os::fd::{AsFd as _, BorrowedFd};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use bazhen_holder_proto::{FrameDecoder, Malformed, Request, request_decoder};
use rustix::event::PollFlags;

/// The most read from a connection in one turn.
pub const READ_CHUNK: usize = 64 << 10;
/// Past this many queued bytes, a connection's requests wait unread: the peer isn't reading its
/// answers, so it gets no more of them. Only its own writes block.
pub const QUEUE_MARK: usize = 256 << 10;
/// The most written to a connection in one turn, in bytes and in writes, so one fast reader, or
/// a queue of many small frames, can't hold the loop.
const WRITE_PER_TURN: usize = 1 << 20;
const WRITES_PER_TURN: usize = 128;
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
    queue: VecDeque<Vec<u8>>,
    queued: usize,
    /// How much of the queue's first frame is written.
    written: usize,
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
    /// is queued, since a turn's writes are capped and may stop before the peer's buffer fills.
    pub fn interest(&self) -> PollFlags {
        let mut flags = PollFlags::empty();
        if self.reading() {
            flags |= PollFlags::IN;
        }
        if !self.queue.is_empty() && !self.is_gone() {
            flags |= PollFlags::OUT;
        }
        flags
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
            Err(_) => self.drop_now(),
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
        self.queue.push_back(frame);
    }

    /// Writes what is queued, up to `WRITE_PER_TURN`, until the peer's buffer is full. A failed
    /// write, such as to a peer that has gone, drops the connection.
    pub fn flush(&mut self, now: Instant) {
        let mut budget = WRITE_PER_TURN;
        for _ in 0..WRITES_PER_TURN {
            if budget == 0 || self.is_gone() {
                return;
            }
            let Some(front) = self.queue.front() else {
                self.stuck_since = None;
                return;
            };
            let pending = front.get(self.written..).unwrap_or_default();
            let cut = pending.get(..pending.len().min(budget)).unwrap_or_default();
            match (&self.stream).write(cut) {
                Ok(0) => self.drop_now(),
                Ok(n) => {
                    self.stuck_since = None;
                    budget -= n;
                    self.written += n;
                    if self.written == front.len() {
                        self.queued = self.queued.saturating_sub(front.len());
                        self.queue.pop_front();
                        self.written = 0;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    self.stuck_since.get_or_insert(now);
                    return;
                }
                Err(_) => self.drop_now(),
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
    pub fn is_finished(&self, now: Instant) -> bool {
        // The end of input is read only once no whole request waits, and nothing is read after it.
        let answered = self.input_ended && self.queue.is_empty();
        match self.phase {
            Phase::Gone => true,
            Phase::Opening { until } => answered || now >= until,
            Phase::HangingUp { until } => self.queue.is_empty() || now >= until,
            Phase::Open => answered,
        }
    }
}

#[cfg(test)]
mod tests {
    use bazhen_holder_proto::RequestId;

    use super::*;

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
            conn.flush(now);
        }
        assert!(conn.next_request().is_none(), "read past the mark");
        assert!(
            !conn.has_request(),
            "a request waiting past the mark counts as one to serve"
        );
        assert!(!conn.interest().contains(PollFlags::IN));
        assert!(conn.interest().contains(PollFlags::OUT));
        assert_eq!(conn.stuck_since(), Some(now));
        let mut drained = vec![0; 1 << 20];
        while conn.queued() > 0 {
            let n = peer.read(&mut drained).unwrap();
            assert!(n > 0);
            conn.flush(now);
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
            conn.flush(now);
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
        conn.flush(now);
        assert_eq!(conn.queued(), 10 * 8);
        assert_eq!(conn.stuck_since(), None);
        assert!(conn.interest().contains(PollFlags::OUT));
        conn.flush(now);
        assert_eq!(conn.queued(), 0);
        assert!(!conn.interest().contains(PollFlags::OUT));
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
        conn.flush(now);
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
        assert!(!conn.interest().contains(PollFlags::IN));
        assert!(!conn.is_finished(now), "ended with an answer still owed");
        conn.flush(now);
        assert!(conn.is_finished(now));
        let (mut conn, peer) = pair(now);
        drop(peer);
        conn.queue(vec![1; 10]);
        conn.flush(now);
        assert!(conn.is_gone());
        assert_eq!(conn.interest(), PollFlags::empty());
    }

    /// Writing nothing, or reading into nothing, returns 0, which is how a gone or finished peer
    /// reads: neither may be taken for one.
    #[test]
    fn an_empty_frame_or_buffer_ends_nothing() {
        let now = Instant::now();
        let (mut conn, mut peer) = pair(now);
        conn.open();
        conn.queue(Vec::new());
        conn.flush(now);
        assert!(!conn.is_gone());
        // With bytes waiting, a read into nothing returns 0 at once.
        peer.write_all(&[0]).unwrap();
        conn.receive(&mut []);
        assert!(conn.interest().contains(PollFlags::IN));
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
        assert!(!conn.interest().contains(PollFlags::IN));
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
            conn.flush(now);
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
        assert!(!conn.interest().contains(PollFlags::IN));
        peer.write_all(&close_request(2)).unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert_eq!(conn.next_request().unwrap().unwrap().id(), RequestId(1));
        assert!(!conn.has_request(), "read while a request waited");
        conn.receive(&mut vec![0; READ_CHUNK]);
        assert_eq!(conn.next_request().unwrap().unwrap().id(), RequestId(2));
    }
}
