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
    self, Count, ErrorBody, ErrorCode, Exited, Foreground, HelloReply, HelloRequest, Offset,
    OkBody, ProcessSpec, ProtocolVersion, Respawned, Size, StartTime, Stats, SubscribeFrom, Tags,
    TerminalId, Versions,
};
use bazhen_holder_proto::{PROTOCOL_VERSION, Reply, Request, RequestId, negotiate, request_name};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::process::Pid;

use crate::child::{CLOSE_GRACE, SignalRefused};
use crate::conn::{Connection, READ_CHUNK};
use crate::engine::Screen;
use crate::holder::{Holder, InputRefused, readiness};
use crate::pty::{self, Pty, WindowSize};
use crate::rss;
use crate::signals::Wakeups;
use crate::socket::{self, RECHECK_EVERY, Socket};
use crate::start::{child_start, process_problem};
use crate::start_time::{self, StartTimeError};

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
/// How many times `foreground` reads the group again when it changed while its start was read.
const FOREGROUND_TRIES: usize = 3;

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
    /// The connection whose `input` and `resize` the holder takes.
    writer: Option<u64>,
    /// The latest size asked for this turn, applied once all are read, so a storm of resizes
    /// costs one `SIGWINCH`.
    resize: Option<Size>,
    close_requested: bool,
    /// Where in the output the current generation starts: the offsets its peers see count from
    /// here.
    base: u64,
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
                resize: None,
                close_requested: false,
                base: 0,
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
    pub fn run(mut self, holder: &mut Holder<Screen>) -> io::Result<()> {
        while !self.turn(holder)? {}
        Ok(())
    }

    /// One turn of the loop; true once a `close` is done.
    ///
    /// # Errors
    ///
    /// When `poll` fails for any reason but an interrupting signal.
    pub fn turn(&mut self, holder: &mut Holder<Screen>) -> io::Result<bool> {
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
        for i in 0..self.conns.len() {
            if ready.conns.get(i).copied().unwrap_or(false)
                && let Some(conn) = self.conns.get_mut(i)
            {
                conn.receive(&mut self.buffer);
            }
            // A respawn is answered here, with every connection at hand, and the connection's
            // requests after it then go on being answered.
            while let Some(conn) = self.conns.get_mut(i)
                && let Some((id, spec)) = serve(conn, &mut self.shared, holder, now)
            {
                self.respawn(i, id, &spec, holder);
            }
            // Freed here as well as after the writes, so a writer's `hello` later in this turn
            // can take the slot of one that hung up earlier in it.
            if let Some(conn) = self.conns.get(i)
                && self.shared.writer == Some(conn.id())
                && !conn.is_open()
            {
                self.shared.writer = None;
            }
        }
        self.apply_resize(holder);
        holder.flush_input();
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
            conn.flush(now, holder.output().ring());
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
    fn send_exit(&mut self, holder: &Holder<Screen>) {
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
        let at = holder.output().ring().end();
        for conn in self.conns.iter_mut().filter(|conn| conn.is_open()) {
            conn.queue_event(at, frame.clone());
        }
    }

    /// Starts `spec` in place of the child, whose exit is published, as its next generation, on a
    /// fresh PTY of the terminal's size, and tells every connection past `hello`: `respawned` comes
    /// after the old child's output and its `exited`, and before anything of the new one, the
    /// asker's `ok` included. Refused while the holder is closing, since it would exit and leave
    /// the new child unwatched; while the child runs (`running`); for a generation not above the
    /// current one; or when the system won't start it, which leaves the terminal as it was.
    fn respawn(
        &mut self,
        asker: usize,
        id: RequestId,
        spec: &ProcessSpec,
        holder: &mut Holder<Screen>,
    ) {
        if let Some((code, why)) = respawn_refusal(&self.shared, holder, spec) {
            if let Some(conn) = self.conns.get_mut(asker) {
                refuse(conn, id, "respawn", code, why);
            }
            return;
        }
        let spawned = Pty::open(WindowSize::from(self.shared.terminal.size))
            .map_err(|e| e.to_string())
            .and_then(|(pty, slave)| {
                let child = pty::spawn(slave, spec, holder.reaper()).map_err(|e| e.to_string())?;
                Ok((pty, child))
            });
        let (pty, child) = match spawned {
            Ok(spawned) => spawned,
            Err(why) => {
                tracing::warn!(error = why, "could not respawn the child");
                if let Some(conn) = self.conns.get_mut(asker) {
                    let why = format!("could not start it: {why}");
                    refuse(conn, id, "respawn", ErrorCode::Failed, &why);
                }
                return;
            }
        };
        let started = child_start(child.pid(), self.shared.terminal.holder_start);
        let respawned = protocol_pid(child.pid()).and_then(|child_pid| {
            Reply::Respawned(Respawned {
                generation: spec.generation,
                child_pid,
                child_start: started,
            })
            .encode()
            .ok()
        });
        // Told to no one, the respawn can't happen: the new child and its session are ended, and
        // the terminal stays as it was.
        let Some(frame) = respawned else {
            tracing::error!("could not say the respawn; ending its child");
            holder.retire(child);
            if let Some(conn) = self.conns.get_mut(asker) {
                refuse(
                    conn,
                    id,
                    "respawn",
                    ErrorCode::Failed,
                    "the holder can't say it",
                );
            }
            return;
        };
        let at = holder.output().ring().end();
        holder.respawn(pty, child, spec.generation);
        holder.output_mut().engine_mut().set_theme(spec.theme);
        tracing::info!(generation = spec.generation.get(), "child respawned");
        self.shared.base = at;
        self.shared.terminal.child_start = started;
        self.shared.exit_sent = false;
        for conn in self.conns.iter_mut().filter(|conn| conn.is_open()) {
            conn.queue_respawned(at, frame.clone());
        }
        if let Some(conn) = self.conns.get_mut(asker) {
            ok(conn, id, "respawn");
        }
    }

    /// Sets the size asked for last this turn: the terminal's program redraws on each `SIGWINCH`.
    /// The engine takes it at the same point of the output, after every byte read before it.
    fn apply_resize(&mut self, holder: &mut Holder<Screen>) {
        let Some(asked) = self.shared.resize.take() else {
            return;
        };
        let window = WindowSize::from(asked);
        let Some(size) = window.size() else {
            return;
        };
        match holder.resize(window) {
            Ok(()) => {
                self.shared.terminal.size = size;
                let size = bazhen_holder_engine::Size {
                    cols: window.cols(),
                    rows: window.rows(),
                };
                holder.output_mut().engine_mut().resize(size);
            }
            Err(error) => tracing::warn!(%error, "could not resize the terminal"),
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

    /// Whether a close is done: the child's exit is published, every session the holder started
    /// has ended (`Holder::ended`), and the connections have read what they are owed or run out of
    /// time; or `CLOSE_GIVE_UP` has passed without that.
    fn close_done(&mut self, holder: &Holder<Screen>, now: Instant) -> bool {
        let until = match self.closing {
            None => return false,
            Some(Closing::Ending { since }) if holder.exit().is_none() || !holder.ended() => {
                if now >= since + CLOSE_GIVE_UP {
                    tracing::error!(
                        "the terminal's processes outlived their kill; exiting without them"
                    );
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

    fn poll(&self, holder: &Holder<Screen>, timeout: Option<&Timespec>) -> io::Result<Ready> {
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
            fds.push(PollFd::from_borrowed_fd(fd, holder.master_interest()));
            fds.len() - 1
        });
        let listener = listener.map(|fd| {
            fds.push(PollFd::from_borrowed_fd(fd, PollFlags::IN));
            fds.len() - 1
        });
        let first_conn = fds.len();
        fds.extend(self.conns.iter().map(|conn| {
            PollFd::from_borrowed_fd(conn.fd(), conn.interest(holder.output().ring().end()))
        }));
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

/// Why `spec` can't replace the child now, if it can't.
fn respawn_refusal(
    shared: &Shared,
    holder: &Holder<Screen>,
    spec: &ProcessSpec,
) -> Option<(ErrorCode, &'static str)> {
    if shared.close_requested {
        return Some((ErrorCode::Failed, "the terminal is closing"));
    }
    if holder.exit().is_none() {
        return Some((ErrorCode::Running, "the child still runs"));
    }
    if spec.generation <= holder.generation() {
        let why = "a respawn's generation must be above the current one";
        return Some((ErrorCode::StaleGeneration, why));
    }
    process_problem(&spec.argv, &spec.cwd, &spec.env).map(|why| (ErrorCode::Invalid, why))
}

/// Answers every request the connection has read, while it is read, but a `respawn`, which needs
/// every connection: it is handed back, with the rest left to answer after it.
fn serve(
    conn: &mut Connection,
    shared: &mut Shared,
    holder: &mut Holder<Screen>,
    now: Instant,
) -> Option<(RequestId, ProcessSpec)> {
    while let Some(next) = conn.next_request() {
        match next {
            Ok(Request::Respawn { id, body }) if conn.is_open() => return Some((id, body)),
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
                return None;
            }
        }
    }
    None
}

fn answer(
    conn: &mut Connection,
    shared: &mut Shared,
    holder: &mut Holder<Screen>,
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
        Request::Subscribe { id, body } => subscribe(conn, holder, shared.base, id, body.from),
        Request::Input { id, bytes } => input(conn, shared, holder, id, &bytes),
        Request::Resize { id, body } => {
            if shared.writer == Some(conn.id()) {
                shared.resize = Some(body);
                ok(conn, id, "resize");
            } else {
                let why = "only the connection with the writer slot resizes";
                refuse(conn, id, "resize", ErrorCode::NotWriter, why);
            }
        }
        Request::Signal { id, body } => match holder.signal(body.signal) {
            Ok(()) => ok(conn, id, "signal"),
            Err(SignalRefused::Exited) => {
                refuse(
                    conn,
                    id,
                    "signal",
                    ErrorCode::Exited,
                    "the child has exited",
                );
            }
            Err(SignalRefused::Failed(errno)) => {
                tracing::warn!(error = %errno, "could not signal the child");
                let why = format!("the system refused the signal: {errno}");
                refuse(conn, id, "signal", ErrorCode::Failed, &why);
            }
            Err(SignalRefused::Guarded(refused)) => {
                tracing::error!(%refused, "the guard refused to signal the child");
                let why = format!("the holder refused the signal: {refused}");
                refuse(conn, id, "signal", ErrorCode::Failed, &why);
            }
        },
        Request::SetTags { id, body } => {
            shared.terminal.tags = body.tags;
            ok(conn, id, "set-tags");
        }
        Request::SetTheme { id, body } => {
            holder.output_mut().engine_mut().set_theme(body.theme);
            ok(conn, id, "set-theme");
        }
        Request::Stats { id } => {
            if let Some(body) = stats(holder) {
                send(conn, &Reply::Stats { id, body });
            } else {
                let why = "the holder's memory is past what the protocol can say";
                refuse(conn, id, "stats", ErrorCode::Failed, why);
            }
        }
        Request::Foreground { id } => match foreground(&shared.terminal, holder) {
            Ok(body) => send(conn, &Reply::Foreground { id, body }),
            Err((code, why)) => refuse(conn, id, "foreground", code, why),
        },
        Request::Close { id } => {
            ok(conn, id, "close");
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

/// Queues the writer's input for the child; anyone else's is refused.
fn input(
    conn: &mut Connection,
    shared: &Shared,
    holder: &mut Holder<Screen>,
    id: RequestId,
    bytes: &[u8],
) {
    if shared.writer != Some(conn.id()) {
        let why = "only the connection with the writer slot sends input";
        refuse(conn, id, "input", ErrorCode::NotWriter, why);
        return;
    }
    match holder.offer_input(bytes) {
        Ok(()) => {}
        Err(InputRefused::Exited) => {
            let why = "the child has exited";
            refuse(conn, id, "input", ErrorCode::Exited, why);
        }
        Err(InputRefused::Full(_)) => {
            let why = "the program isn't reading its input: input is refused until the queue \
                       drains";
            refuse(conn, id, "input", ErrorCode::InputFull, why);
        }
    }
}

/// Moves the connection's subscription to `from`, or to the holder's offset now without one.
/// `base` is where the current generation starts in the output, which its offsets count from.
fn subscribe(
    conn: &mut Connection,
    holder: &Holder<Screen>,
    base: u64,
    id: RequestId,
    from: Option<SubscribeFrom>,
) {
    let end = holder.output().ring().end();
    let offset = match from {
        Some(from) if from.generation != holder.generation() => {
            let why = "that offset is of another generation's output";
            refuse(conn, id, "subscribe", ErrorCode::StaleGeneration, why);
            return;
        }
        Some(from) if from.offset.get() > end.saturating_sub(base) => {
            let why = "that offset is past the holder's";
            refuse(conn, id, "subscribe", ErrorCode::OutOfRange, why);
            return;
        }
        Some(from) => base + from.offset.get(),
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
    holder: &mut Holder<Screen>,
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
    let Some(reply) = hello_reply(shared, holder, &version.to_string(), writer) else {
        let why = "the holder's state is outside what the protocol can say";
        refuse(conn, id, "hello", ErrorCode::Failed, why);
        conn.hang_up(now);
        return;
    };
    if writer {
        shared.writer = Some(conn.id());
    }
    send(conn, &Reply::Hello { id, body: reply });
    conn.open(shared.base);
}

/// The terminal's foreground group and when its leader started. The terminal can name a group
/// with no member left, whose number may since be any process's, so the start counts only if,
/// after it is read, the terminal still names the group, the process at its number still leads it
/// in the child's session, and that process's start, read again, is the same. A pid that numbers
/// a live group is never given to a new process, so the start is that group's leader's.
fn foreground(
    terminal: &Terminal,
    holder: &Holder<Screen>,
) -> Result<Foreground, (ErrorCode, &'static str)> {
    if holder.child_exited() {
        return Err((ErrorCode::Exited, "the child has exited"));
    }
    let failed = |why| (ErrorCode::Failed, why);
    let child = holder.child_pid();
    let child_pid = protocol_pid(child).ok_or(failed("a pid the protocol can't carry"))?;
    for _ in 0..FOREGROUND_TRIES {
        let pgid = holder
            .foreground_group()
            .ok_or(failed("the terminal has no foreground group"))?;
        let start = if pgid == child {
            Ok(terminal.child_start)
        } else {
            start_time::of(pgid)
        };
        if holder.foreground_group() != Some(pgid) {
            continue;
        }
        let pgid_start = start.map_err(|e| match e {
            StartTimeError::Absent(_) => failed("the foreground group's leader has exited"),
            StartTimeError::Unreadable { .. } => failed("its leader's start can't be read"),
        })?;
        let leads = rustix::process::getpgid(Some(pgid)).ok() == Some(pgid)
            && rustix::process::getsid(Some(pgid)).ok() == Some(child);
        if !leads {
            return Err(failed(
                "the foreground group has no leader in the terminal's session",
            ));
        }
        if pgid != child && start_time::of(pgid).ok() != Some(pgid_start) {
            continue;
        }
        return Ok(Foreground {
            child_pid,
            child_start: terminal.child_start,
            pgid: protocol_pid(pgid).ok_or(failed("a pid the protocol can't carry"))?,
            pgid_start,
        });
    }
    Err(failed("the foreground group kept changing"))
}

fn protocol_pid(pid: Pid) -> Option<body::Pid> {
    body::Pid::new(u64::try_from(pid.as_raw_nonzero().get()).ok()?).ok()
}

/// What the terminal holds in memory, and the holder's resident set, read now.
fn stats(holder: &mut Holder<Screen>) -> Option<Stats> {
    let ring_bytes = holder.output().ring().held();
    let walled = holder.output_mut().engine_mut();
    let engine = walled.stats();
    let resets = walled.resets();
    let count = |n: usize| Count::new(u64::try_from(n).ok()?).ok();
    Some(Stats {
        engine_bytes: count(engine.map_or(0, |e| e.engine_bytes.saturating_add(e.history_bytes)))?,
        rss: rss::resident_bytes().and_then(|bytes| Count::new(bytes).ok()),
        ring_bytes: Count::new(ring_bytes).ok()?,
        history_lines: count(engine.map_or(0, |e| e.history_rows))?,
        engine_resets: Some(Count::new(u64::from(resets)).ok()?),
    })
}

fn hello_reply(
    shared: &Shared,
    holder: &mut Holder<Screen>,
    version: &str,
    writer: bool,
) -> Option<HelloReply> {
    let offset = Offset::new(holder.output().ring().end().checked_sub(shared.base)?).ok()?;
    let walled = holder.output_mut().engine_mut();
    let (title, alternate, engine) = (walled.title(), walled.alternate(), walled.alive());
    let terminal = &shared.terminal;
    Some(HelloReply {
        version: ProtocolVersion::new(version).ok()?,
        protocol: Versions::spoken(),
        terminal_id: terminal.terminal_id.clone(),
        tags: terminal.tags.clone(),
        generation: holder.generation(),
        holder_pid: terminal.holder_pid,
        holder_start: terminal.holder_start,
        child_pid: protocol_pid(holder.child_pid())?,
        child_start: terminal.child_start,
        exit: holder.exit().map(|exit| exit.status.clone()),
        size: terminal.size,
        offset,
        title,
        alternate,
        history_lines: terminal.history_lines,
        writer,
        engine: Some(engine),
    })
}

fn ok(conn: &mut Connection, id: RequestId, request: &str) {
    let request = request.to_owned();
    send(
        conn,
        &Reply::Ok {
            id,
            body: OkBody { request },
        },
    );
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
    use crate::ring::Ring;

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
        conn.open(0);
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

    /// A holder whose engine panics on `FAIL` in the output, serving `script` under `sh -c`.
    struct Failing {
        server: Server,
        holder: Holder<Screen>,
        dir: std::path::PathBuf,
    }

    impl Failing {
        fn start(name: &str, script: &str) -> Self {
            use bazhen_holder_proto::body::{Argv, Env, Generation, NonEmpty};

            use crate::child::Reaper;
            use crate::engine::{Walled, tests::failing};

            let dir = std::env::temp_dir().join(format!("bz-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
            let socket = Socket::bind(&dir.join("t.sock")).unwrap();
            let size = Size {
                cols: body::Cols::new(80).unwrap(),
                rows: body::Rows::new(24).unwrap(),
            };
            let mut env = std::collections::BTreeMap::new();
            env.insert("PATH".to_owned(), std::env::var("PATH").unwrap());
            let process = ProcessSpec {
                argv: Argv::new(vec!["sh".into(), "-c".into(), script.into()]).unwrap(),
                cwd: NonEmpty::new("/").unwrap(),
                env: Env::new(env).unwrap(),
                generation: Generation::new(0).unwrap(),
                theme: None,
            };
            let reaper = Reaper::new().unwrap();
            let (pty, slave) = Pty::open(WindowSize::from(size)).unwrap();
            let child = pty::spawn(slave, &process, &reaper).unwrap();
            let engine_size = bazhen_holder_engine::Size { cols: 80, rows: 24 };
            let history = bazhen_holder_engine::HistoryRows(100);
            let engine = Walled::new(failing, engine_size, history, None);
            let screen = Screen::new(Ring::new(1 << 16), engine);
            let holder = Holder::new(pty, reaper, child, process.generation, screen);
            let terminal = Terminal {
                terminal_id: TerminalId::new("t").unwrap(),
                tags: Tags::new(std::collections::BTreeMap::new()).unwrap(),
                size,
                history_lines: Count::new(100).unwrap(),
                holder_pid: body::Pid::new(1).unwrap(),
                holder_start: StartTime::new(0).unwrap(),
                child_start: StartTime::new(0).unwrap(),
            };
            let rebind = Wakeups::new(libc::SIGUSR1).unwrap();
            let server = Server::new(socket, terminal, rebind, Instant::now());
            Self {
                server,
                holder,
                dir,
            }
        }

        fn output(&self) -> String {
            let ring = self.holder.output().ring();
            let bytes = ring.read(ring.start(), usize::MAX).unwrap();
            String::from_utf8_lossy(bytes).into_owned()
        }

        /// Turns the loop until `done`, for five seconds at most.
        fn until(&mut self, what: &str, done: impl Fn(&Self) -> bool) {
            let give_up = Instant::now() + Duration::from_secs(5);
            while !done(self) {
                assert!(Instant::now() < give_up, "{what} never happened");
                let polled = self.server.turn(&mut self.holder);
                assert!(!polled.unwrap(), "the holder closed");
            }
        }

        /// The answer to `request`, from a connection of its own after its `hello`.
        fn ask(&mut self, request: &Request) -> Vec<Reply> {
            let mut peer = UnixStream::connect(self.dir.join("t.sock")).unwrap();
            peer.set_nonblocking(true).unwrap();
            let hello = Request::Hello {
                id: RequestId(1),
                body: HelloRequest {
                    protocol: Versions::spoken(),
                    writer: None,
                },
            };
            peer.write_all(&[hello.encode().unwrap(), request.encode().unwrap()].concat())
                .unwrap();
            let mut decoder = bazhen_holder_proto::reply_decoder();
            let mut replies = Vec::new();
            let mut chunk = vec![0; 1 << 16];
            let give_up = Instant::now() + Duration::from_secs(5);
            while replies.len() < 2 {
                assert!(Instant::now() < give_up, "no answer to {request:?}");
                assert!(!self.server.turn(&mut self.holder).unwrap());
                if let Ok(n) = peer.read(&mut chunk) {
                    decoder.push(&chunk[..n]);
                }
                while let Some(reply) = decoder.next_frame().unwrap() {
                    replies.push(reply);
                }
            }
            replies
        }

        fn hello_and_stats(&mut self) -> (HelloReply, Stats) {
            match self.ask(&Request::Stats { id: RequestId(2) }).as_slice() {
                [
                    Reply::Hello { body: hello, .. },
                    Reply::Stats { body: stats, .. },
                ] => (hello.clone(), *stats),
                other => panic!("answered {other:?}"),
            }
        }
    }

    impl Drop for Failing {
        fn drop(&mut self) {
            self.holder.close(Instant::now());
            let give_up = Instant::now() + CLOSE_GIVE_UP;
            while self.holder.exit().is_none() && Instant::now() < give_up {
                let _ = self.server.turn(&mut self.holder);
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_holder_whose_engine_fails_keeps_its_child_and_answers_with_a_new_engine() {
        bazhen_test_signal::require_sandbox().unwrap();
        let script = "stty -echoctl; printf '<fail>'; sleep 0.2; printf '\\033[6n'; exec sleep 30";
        let mut failing = Failing::start("engine-fails", script);
        failing.until("the query's answer, echoed", |f| {
            f.output().contains("[1;1R")
        });
        assert!(failing.holder.exit().is_none(), "the child ended");
        let (hello, stats) = failing.hello_and_stats();
        assert_eq!(hello.engine, Some(true));
        assert_eq!(stats.engine_resets.map(Count::get), Some(1));
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_holder_whose_engine_keeps_failing_runs_on_without_one() {
        bazhen_test_signal::require_sandbox().unwrap();
        let script = "while :; do printf '<fail>'; sleep 0.02; done";
        let mut failing = Failing::start("engine-gone", script);
        failing.until("the engine given up", |f| {
            !f.holder.output().engine().alive()
        });
        let end = failing.holder.output().ring().end();
        failing.until("more output", |f| f.holder.output().ring().end() > end);
        assert!(failing.holder.exit().is_none(), "the child ended");
        let (hello, stats) = failing.hello_and_stats();
        assert_eq!(hello.engine, Some(false));
        assert_eq!(
            stats.engine_resets.map(Count::get),
            Some(u64::from(crate::engine::MOST_ENGINE_RESETS))
        );
        assert_eq!(stats.history_lines.get(), 0);
    }
}
