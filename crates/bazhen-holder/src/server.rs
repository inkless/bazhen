//! The holder's loop: one `poll` over the child's side (`Holder`), the socket, and every
//! connection, until a `close` has ended the child and its answers are written.
//!
//! A turn, in order: the master is read into the ring; each connection already open is read once
//! and its requests answered; new connections are accepted; every connection is written to; the
//! child is reaped and its exit published; and the socket is looked for. Answers go out in the
//! order their requests were read.

use std::io;
use std::time::{Duration, Instant};

use bazhen_holder_proto::body::{
    self, Count, ErrorBody, ErrorCode, Exited, HelloReply, HelloRequest, Offset, OkBody,
    ProtocolVersion, Size, StartTime, SubscribeFrom, Tags, TerminalId, Versions,
};
use bazhen_holder_proto::{PROTOCOL_VERSION, Reply, Request, RequestId, negotiate, request_name};
use rustix::event::{PollFd, PollFlags, Timespec, poll};

use crate::child::CLOSE_GRACE;
use crate::conn::{Connection, READ_CHUNK};
use crate::holder::{Holder, readiness};
use crate::ring::Ring;
use crate::signals::Wakeups;
use crate::socket::{self, RECHECK_EVERY, Socket};

/// The most connections served at once. The daemon holds one; `bazhen attach --direct` and
/// `doctor` add a few.
pub const MAX_CONNECTIONS: usize = 16;
/// How long the holder stops accepting after an accept fails for a reason that won't pass by
/// itself, such as running out of fds, so a listener that stays readable can't spin the loop.
const ACCEPT_PAUSE: Duration = Duration::from_secs(1);
/// How long, once a closed holder's child has ended, its connections have to read what they are
/// owed before it exits.
const CLOSE_FLUSH_WITHIN: Duration = Duration::from_secs(1);
/// How long after a close the holder waits for its child to end before it exits without it: five
/// seconds past the kill, which comes `CLOSE_GRACE` in. A child in uninterruptible sleep can't be
/// reaped, and the holder's socket is gone.
const CLOSE_GIVE_UP: Duration = CLOSE_GRACE.saturating_add(Duration::from_secs(5));
/// How long a new connection is safe from being replaced, so it can be read and say `hello`.
pub const NEW_GRACE: Duration = Duration::from_millis(250);
/// How long a connection's peer must have left its buffer full before a new connection may
/// replace it: a daemon that falls behind for a moment isn't the one to drop.
pub const STUCK_TO_EVICT: Duration = Duration::from_secs(1);

/// What `hello` says of the terminal that doesn't change while it runs.
#[derive(Debug, Clone)]
pub struct Terminal {
    pub terminal_id: TerminalId,
    pub tags: Tags,
    pub size: Size,
    pub history_lines: Count,
    pub holder_pid: body::Pid,
    pub holder_start: StartTime,
    pub child_start: StartTime,
}

/// What answering one connection can change for all of them.
#[derive(Debug)]
struct Shared {
    terminal: Terminal,
    /// The connection whose `input` the holder takes.
    writer: Option<u64>,
    close_requested: bool,
    /// Whether the child's exit has been sent to the connections open when it was published.
    exit_sent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Closing {
    /// The child is being ended, since `since`.
    Ending { since: Instant },
    /// The child has ended; connections are read what they are owed until then.
    Flushing { until: Instant },
}

#[derive(Debug)]
pub struct Server {
    socket: Option<Socket>,
    conns: Vec<Connection>,
    shared: Shared,
    rebind_wakeups: Wakeups,
    recheck_at: Instant,
    accept_paused_until: Option<Instant>,
    next_id: u64,
    closing: Option<Closing>,
    buffer: Box<[u8]>,
}

/// What one `poll` found ready.
#[derive(Debug, Default)]
struct Ready {
    master: bool,
    rebind: bool,
    listener: bool,
    conns: Vec<bool>,
}

impl Server {
    /// Serves `socket`; a `SIGUSR1`, which `rebind` wakes on, asks for it to be looked for.
    pub(crate) fn new(socket: Socket, terminal: Terminal, rebind: Wakeups, now: Instant) -> Self {
        Self {
            socket: Some(socket),
            conns: Vec::new(),
            shared: Shared {
                terminal,
                writer: None,
                close_requested: false,
                exit_sent: false,
            },
            rebind_wakeups: rebind,
            recheck_at: now + RECHECK_EVERY,
            accept_paused_until: None,
            next_id: 0,
            closing: None,
            buffer: vec![0; READ_CHUNK].into_boxed_slice(),
        }
    }

    /// Serves until a `close` is done.
    ///
    /// # Errors
    ///
    /// When `poll` fails for any reason but an interrupting signal.
    pub fn run(mut self, holder: &mut Holder<Ring>) -> io::Result<()> {
        while !self.turn(holder)? {}
        Ok(())
    }

    /// One turn of the loop; true once a `close` is done.
    ///
    /// # Errors
    ///
    /// When `poll` fails for any reason but an interrupting signal.
    pub fn turn(&mut self, holder: &mut Holder<Ring>) -> io::Result<bool> {
        let deadline = [holder.deadline(), self.deadline(Instant::now())]
            .into_iter()
            .flatten()
            .min();
        let timeout = deadline
            .map(|at| Timespec::try_from(at.saturating_duration_since(Instant::now())))
            .transpose()
            .map_err(io::Error::other)?;
        let ready = self.poll(holder, timeout.as_ref())?;
        let now = Instant::now();
        holder.after_poll(ready.master, now);
        self.send_exit(holder);
        if ready.rebind {
            self.rebind_wakeups.clear();
            self.recheck_at = now;
        }
        if self.accept_paused_until.is_some_and(|until| now >= until) {
            self.accept_paused_until = None;
        }
        // Connections already open first, so one whose `hello` is waiting is read before a
        // newcomer can take its place.
        for (i, conn) in self.conns.iter_mut().enumerate() {
            if ready.conns.get(i).copied().unwrap_or(false) {
                conn.receive(&mut self.buffer);
            }
            serve(conn, &mut self.shared, holder, now);
            // Freed here as well as after the writes, so a writer's `hello` later in this turn
            // can take the slot of one that hung up earlier in it.
            if self.shared.writer == Some(conn.id()) && !conn.is_open() {
                self.shared.writer = None;
            }
        }
        if ready.listener {
            self.accept(now);
        }
        if self.shared.close_requested && self.closing.is_none() {
            tracing::info!("closing");
            holder.close(now);
            // The lock is kept until the holder exits, so no new holder starts a second child
            // for the terminal while this one's may still run.
            if let Some(socket) = &self.socket {
                socket.remove();
            }
            self.closing = Some(Closing::Ending { since: now });
        }
        for conn in &mut self.conns {
            conn.flush(now, holder.output());
        }
        self.release_writer();
        self.conns.retain(|conn| !conn.is_finished(now));
        if self.close_done(holder, now) {
            return Ok(true);
        }
        if self.closing.is_none() && now >= self.recheck_at {
            if let Some(socket) = &mut self.socket {
                socket.recheck();
            }
            self.recheck_at = now + RECHECK_EVERY;
        }
        Ok(false)
    }

    /// Sends the child's exit, once it is published, to every connection past `hello`, at the
    /// offset it came at, so a subscriber gets it after every byte the child wrote before it. A
    /// connection that says `hello` later finds it in the hello reply.
    fn send_exit(&mut self, holder: &Holder<Ring>) {
        let Some(exit) = holder.exit().filter(|_| !self.shared.exit_sent) else {
            return;
        };
        self.shared.exit_sent = true;
        let exited = Reply::Exited(Exited {
            generation: exit.generation,
            status: exit.status.clone(),
        });
        let frame = match exited.encode() {
            Ok(frame) => frame,
            Err(error) => {
                tracing::warn!(%error, "could not encode the exit");
                return;
            }
        };
        let at = holder.output().end();
        for conn in self.conns.iter_mut().filter(|conn| conn.is_open()) {
            conn.queue_event(at, frame.clone());
        }
    }

    /// Frees the writer slot once no open connection holds it: one hanging up, dropped or
    /// replaced sends no more input.
    fn release_writer(&mut self) {
        if let Some(id) = self.shared.writer
            && !self.conns.iter().any(|c| c.id() == id && c.is_open())
        {
            self.shared.writer = None;
        }
    }

    /// Whether a close is done: the child has ended and its connections have read what they are
    /// owed or run out of time, or the child has outlived its kill by `CLOSE_GIVE_UP`.
    fn close_done(&mut self, holder: &Holder<Ring>, now: Instant) -> bool {
        let until = match self.closing {
            None => return false,
            Some(Closing::Ending { since }) if holder.exit().is_none() => {
                if now >= since + CLOSE_GIVE_UP {
                    tracing::error!("the child outlived its kill; exiting without it");
                    return true;
                }
                return false;
            }
            Some(Closing::Ending { .. }) => now + CLOSE_FLUSH_WITHIN,
            Some(Closing::Flushing { until }) => until,
        };
        self.closing = Some(Closing::Flushing { until });
        let written = self
            .conns
            .iter()
            .all(|conn| conn.queued() == 0 || conn.is_gone());
        written || now >= until
    }

    fn listening(&self) -> bool {
        self.socket.is_some() && self.closing.is_none() && self.accept_paused_until.is_none()
    }

    /// When the loop must turn with nothing ready: now, if a connection has a whole request
    /// waiting, since its peer may say nothing more until it is answered.
    fn deadline(&self, now: Instant) -> Option<Instant> {
        let closing = match self.closing {
            Some(Closing::Ending { since }) => Some(since + CLOSE_GIVE_UP),
            Some(Closing::Flushing { until }) => Some(until),
            None => None,
        };
        let waiting = waiting_now(&self.conns, now);
        [
            self.socket
                .as_ref()
                .filter(|_| self.closing.is_none())
                .map(|_| self.recheck_at),
            self.accept_paused_until,
            closing,
            waiting,
        ]
        .into_iter()
        .chain(self.conns.iter().map(Connection::deadline))
        .flatten()
        .min()
    }

    fn poll(&self, holder: &Holder<Ring>, timeout: Option<&Timespec>) -> io::Result<Ready> {
        let listener = self
            .socket
            .as_ref()
            .filter(|_| self.listening())
            .map(|socket| rustix::fd::AsFd::as_fd(socket.listener()));
        let mut fds = vec![
            PollFd::from_borrowed_fd(holder.wakeups(), PollFlags::IN),
            PollFd::from_borrowed_fd(self.rebind_wakeups.fd(), PollFlags::IN),
        ];
        let master = holder.master().map(|fd| {
            fds.push(PollFd::from_borrowed_fd(fd, PollFlags::IN));
            fds.len() - 1
        });
        let listener = listener.map(|fd| {
            fds.push(PollFd::from_borrowed_fd(fd, PollFlags::IN));
            fds.len() - 1
        });
        let first_conn = fds.len();
        fds.extend(
            self.conns.iter().map(|conn| {
                PollFd::from_borrowed_fd(conn.fd(), conn.interest(holder.output().end()))
            }),
        );
        if !readiness(poll(&mut fds, timeout))? {
            return Ok(Ready::default());
        }
        let ready = |i: usize| fds.get(i).is_some_and(|fd| !fd.revents().is_empty());
        Ok(Ready {
            master: master.is_some_and(ready),
            rebind: ready(1),
            listener: listener.is_some_and(ready),
            conns: (first_conn..fds.len()).map(ready).collect(),
        })
    }

    fn accept(&mut self, now: Instant) {
        for _ in 0..MAX_CONNECTIONS {
            let Some(socket) = &self.socket else {
                return;
            };
            let stream = match socket.listener().accept() {
                Ok((stream, _)) => stream,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    tracing::warn!(%error, "could not accept a connection; pausing");
                    self.accept_paused_until = Some(now + ACCEPT_PAUSE);
                    return;
                }
            };
            if let Err(error) = socket::admit(&stream) {
                tracing::warn!(%error, "refused a connection");
                continue;
            }
            if self.conns.iter().filter(|c| !c.is_gone()).count() >= MAX_CONNECTIONS {
                let Some(victim) = self.victim(now) else {
                    tracing::warn!("refused a connection: every one is in use");
                    continue;
                };
                tracing::info!("dropped a connection to make room for a new one");
                victim.drop_now();
            }
            self.next_id += 1;
            self.conns.push(Connection::new(self.next_id, stream, now));
        }
    }

    /// The connection a new one replaces when all are in use, so a daemon reconnecting to a full
    /// holder gets in: the one whose peer has left its buffer full longest, for at least
    /// `STUCK_TO_EVICT`; else the oldest still to say `hello`; else the oldest that doesn't hold
    /// the writer slot, which the daemon takes, as the one that sends input. Never one younger
    /// than `NEW_GRACE`, which may not have been read yet: newcomers would otherwise replace each
    /// other, a reconnecting daemon among them. None when only the writer's, or newcomers', are
    /// left to choose.
    ///
    /// Peers share the holder's uid, so this guards against accident, not malice: a client that
    /// takes the writer slot before the daemon leaves it read-only, and a loop of connections can
    /// keep replacing it.
    fn victim(&mut self, now: Instant) -> Option<&mut Connection> {
        let writer = self.shared.writer;
        let live = || {
            self.conns.iter().enumerate().filter(|(_, c)| {
                !c.is_gone() && now.saturating_duration_since(c.accepted()) >= NEW_GRACE
            })
        };
        let stuck = live()
            .filter_map(|(i, c)| c.stuck_since().map(|since| (since, i)))
            .filter(|(since, _)| now.saturating_duration_since(*since) >= STUCK_TO_EVICT)
            .min()
            .map(|(_, i)| i);
        let oldest = |keep: &dyn Fn(&Connection) -> bool| {
            live()
                .filter(|(_, c)| keep(c))
                .min_by_key(|(_, c)| c.accepted())
                .map(|(i, _)| i)
        };
        let i = stuck
            .or_else(|| oldest(&Connection::is_opening))
            .or_else(|| oldest(&|c| Some(c.id()) != writer))?;
        self.conns.get_mut(i)
    }
}

/// Now, if any connection has a whole request waiting: its peer may say nothing more until it is
/// answered, and with nothing to read or write its socket wakes nothing.
fn waiting_now(conns: &[Connection], now: Instant) -> Option<Instant> {
    conns.iter().any(Connection::has_request).then_some(now)
}

/// Answers every request the connection has read, while it is read.
fn serve(conn: &mut Connection, shared: &mut Shared, holder: &Holder<Ring>, now: Instant) {
    while let Some(next) = conn.next_request() {
        match next {
            Ok(request) => answer(conn, shared, holder, request, now),
            Err(refused) => {
                if let Some((code, id)) = refused.invalid_request() {
                    let name = request_name(code);
                    refuse(conn, id, &name, ErrorCode::Invalid, refused.reason());
                    conn.hang_up(now);
                } else {
                    tracing::info!("a malformed frame; dropping its connection");
                    conn.drop_now();
                }
                return;
            }
        }
    }
}

fn answer(
    conn: &mut Connection,
    shared: &mut Shared,
    holder: &Holder<Ring>,
    request: Request,
    now: Instant,
) {
    let id = request.id();
    if !conn.is_open() {
        if let Request::Hello { id, body } = &request {
            hello(conn, shared, holder, *id, body, now);
        } else {
            let why = "a connection says hello before anything else";
            refuse(conn, id, &request.name(), ErrorCode::Invalid, why);
            conn.hang_up(now);
        }
        return;
    }
    match request {
        Request::Hello { .. } => {
            let why = "hello was already answered";
            refuse(conn, id, "hello", ErrorCode::Invalid, why);
            conn.hang_up(now);
        }
        Request::Subscribe { id, body } => subscribe(conn, holder, id, body.from),
        Request::Close { id } => {
            let request = "close".to_owned();
            send(
                conn,
                &Reply::Ok {
                    id,
                    body: OkBody { request },
                },
            );
            shared.close_requested = true;
        }
        Request::Unknown { code, id } => {
            let why = "this holder doesn't know that request";
            refuse(
                conn,
                id,
                &request_name(code),
                ErrorCode::UnknownRequest,
                why,
            );
        }
        other => {
            let why = "this holder doesn't serve that request";
            refuse(conn, id, &other.name(), ErrorCode::UnknownRequest, why);
        }
    }
}

/// Moves the connection's subscription to `from`, or to the holder's offset now without one.
fn subscribe(
    conn: &mut Connection,
    holder: &Holder<Ring>,
    id: RequestId,
    from: Option<SubscribeFrom>,
) {
    let end = holder.output().end();
    let offset = match from {
        Some(from) if from.generation != holder.generation() => {
            let why = "that offset is of another generation's output";
            refuse(conn, id, "subscribe", ErrorCode::StaleGeneration, why);
            return;
        }
        Some(from) if from.offset.get() > end => {
            let why = "that offset is past the holder's";
            refuse(conn, id, "subscribe", ErrorCode::OutOfRange, why);
            return;
        }
        Some(from) => from.offset.get(),
        None => end,
    };
    let request = "subscribe".to_owned();
    match (Reply::Ok {
        id,
        body: OkBody { request },
    })
    .encode()
    {
        Ok(frame) => conn.queue_subscribed(frame, offset),
        Err(error) => {
            tracing::warn!(%error, "could not encode a reply");
            conn.drop_now();
        }
    }
}

fn hello(
    conn: &mut Connection,
    shared: &mut Shared,
    holder: &Holder<Ring>,
    id: RequestId,
    body: &HelloRequest,
    now: Instant,
) {
    let Some(version) = negotiate(&[PROTOCOL_VERSION], body.protocol.as_slice()) else {
        let mut error = ErrorBody::new(
            "hello",
            ErrorCode::NoSharedVersion,
            "the holder shares no protocol major with the client",
        );
        error.protocol = Some(Versions::spoken());
        send(conn, &Reply::Error { id, body: error });
        conn.hang_up(now);
        return;
    };
    let writer = body.writer == Some(true) && shared.writer.is_none();
    let Some(reply) = hello_reply(&shared.terminal, holder, &version.to_string(), writer) else {
        let why = "the holder's state is outside what the protocol can say";
        refuse(conn, id, "hello", ErrorCode::Failed, why);
        conn.hang_up(now);
        return;
    };
    if writer {
        shared.writer = Some(conn.id());
    }
    send(conn, &Reply::Hello { id, body: reply });
    conn.open();
}

fn hello_reply(
    terminal: &Terminal,
    holder: &Holder<Ring>,
    version: &str,
    writer: bool,
) -> Option<HelloReply> {
    let child_pid = u64::try_from(holder.child_pid().as_raw_nonzero().get()).ok()?;
    Some(HelloReply {
        version: ProtocolVersion::new(version).ok()?,
        protocol: Versions::spoken(),
        terminal_id: terminal.terminal_id.clone(),
        tags: terminal.tags.clone(),
        generation: holder.generation(),
        holder_pid: terminal.holder_pid,
        holder_start: terminal.holder_start,
        child_pid: body::Pid::new(child_pid).ok()?,
        child_start: terminal.child_start,
        exit: holder.exit().map(|exit| exit.status.clone()),
        size: terminal.size,
        offset: Offset::new(holder.output().end()).ok()?,
        title: String::new(),
        alternate: false,
        history_lines: terminal.history_lines,
        writer,
    })
}

fn refuse(conn: &mut Connection, id: RequestId, request: &str, code: ErrorCode, why: &str) {
    let body = ErrorBody::new(request, code, why);
    send(conn, &Reply::Error { id, body });
}

/// Queues `reply`; a reply that can't be encoded ends the connection, which can't be told.
fn send(conn: &mut Connection, reply: &Reply) {
    match reply.encode() {
        Ok(frame) => conn.queue(frame),
        Err(error) => {
            tracing::warn!(%error, "could not encode a reply");
            conn.drop_now();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read as _, Write as _};
    use std::os::unix::fs::DirBuilderExt as _;
    use std::os::unix::net::UnixStream;

    use bazhen_holder_proto::RequestId;
    use rustix::event::PollFlags;

    use super::*;
    use crate::conn::QUEUE_MARK;

    /// A request that waited past the mark is answerable once the peer has read, but its socket
    /// then has nothing to say and nothing owed: only the loop's deadline wakes it to answer.
    #[test]
    fn a_request_left_waiting_once_its_peer_has_read_brings_the_deadline_to_now() {
        let now = Instant::now();
        let dir = std::env::temp_dir().join(format!("bz-server-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let socket = Socket::bind(&dir.join("t1.sock")).unwrap();
        let terminal = Terminal {
            terminal_id: TerminalId::new("t1").unwrap(),
            tags: Tags::new(std::collections::BTreeMap::new()).unwrap(),
            size: Size {
                cols: body::Cols::new(80).unwrap(),
                rows: body::Rows::new(24).unwrap(),
            },
            history_lines: Count::new(0).unwrap(),
            holder_pid: body::Pid::new(1).unwrap(),
            holder_start: StartTime::new(0).unwrap(),
            child_start: StartTime::new(0).unwrap(),
        };
        let rebind = Wakeups::new(libc::SIGUSR1).unwrap();
        let mut server = Server::new(socket, terminal, rebind, now);
        let (ours, mut peer) = UnixStream::pair().unwrap();
        ours.set_nonblocking(true).unwrap();
        let mut conn = Connection::new(1, ours, now);
        conn.open();
        peer.write_all(&Request::Stats { id: RequestId(1) }.encode().unwrap())
            .unwrap();
        conn.receive(&mut vec![0; READ_CHUNK]);
        conn.queue(vec![0; QUEUE_MARK]);
        let ring = Ring::new(1);
        let mut drained = vec![0; 1 << 20];
        while conn.queued() > 0 {
            conn.flush(now, &ring);
            let _ = peer.read(&mut drained).unwrap();
        }
        assert_eq!(conn.interest(ring.end()), PollFlags::empty());
        server.conns.push(conn);
        assert_eq!(server.deadline(now), Some(now));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
