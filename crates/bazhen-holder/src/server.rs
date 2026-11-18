//! The holder's loop: one `poll` over the child's side (`Holder`), the socket, and every
//! connection, until a `close` has ended the child and its answers are written.
//!
//! A turn, in order: the master is read into the ring; each connection already open is read once
//! and its requests answered; new connections are accepted; every connection is written to; the
//! child is reaped and its exit published; and the socket is looked for. Answers go out in the
//! order their requests were read.

use std::collections::VecDeque;
use std::io;
use std::time::{Duration, Instant};

use bazhen_holder_engine::TooLarge;
use bazhen_holder_proto::body::{
    self, Alternate, Count, ErrorBody, ErrorCode, Exited, Foreground, HelloReply, HelloRequest,
    Offset, OkBody, PasteRequest, ProcessSpec, ProtocolVersion, Resized, Respawned, ScreenRequest,
    Size, StartTime, Stats, SubscribeFrom, Tags, TerminalId, Title, Versions,
};
use bazhen_holder_proto::{
    MOST_SNAPSHOT_TEXT, PROTOCOL_VERSION, Reply, Request, RequestId, SNAPSHOT_HEAD, SnapshotFrame,
    negotiate, request_name,
};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::process::Pid;

use crate::child::{CLOSE_GRACE, SignalRefused};
use crate::conn::{AfterSnapshot, Connection, READ_CHUNK, State};
use crate::engine::Screen;
use crate::holder::{Exit, Holder, InputRefused, readiness};
use crate::pty::{self, Pty, WindowSize};
use crate::rss;
use crate::signals::Wakeups;
use crate::socket::{self, RECHECK_EVERY, Socket};
use crate::start::{child_start, process_problem};
use crate::start_time::{self, StartTimeError};

/// The most connections served at once. The daemon holds one; `bazhen terminals attach --direct` and
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
/// The most text a `screen` answer carries: any screen and thousands of rows of history, and,
/// escaped as JSON, far under the reply cap.
const MOST_SCREEN_TEXT: usize = 1 << 20;
/// The most rows of history a `screen` answer reads, as many as the daemon lets a reader ask for;
/// a request for more reads this many.
const MOST_SCREEN_HISTORY: usize = 10_000;
/// The largest snapshot frame, header and all.
pub const LARGEST_SNAPSHOT: usize = SNAPSHOT_HEAD + MOST_SNAPSHOT_TEXT;
/// The most bytes of snapshots owed at once across a holder's connections: two of the largest,
/// 128 MiB. Each connection owes one at most, as its queue stops taking requests past
/// `QUEUE_MARK`, so without this sixteen could owe a gigabyte. The bound is per holder, so a host
/// with many terminals whose viewers all stop reading owes that much for each.
pub const SNAPSHOTS_IN_FLIGHT: usize = 2 * LARGEST_SNAPSHOT;

/// When a snapshot may be answered: alone always, and beside others only if the largest one
/// could be still fits under the bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SnapshotRoom {
    in_flight: usize,
    most: usize,
}

impl SnapshotRoom {
    const HOLDER: Self = Self {
        in_flight: SNAPSHOTS_IN_FLIGHT,
        most: LARGEST_SNAPSHOT,
    };

    const fn takes(self, owed: usize) -> bool {
        owed == 0 || owed.saturating_add(self.most) <= self.in_flight
    }
}

/// The states last reported to the connections, which a change is reported against.
#[derive(Debug, Default)]
struct Published {
    title: String,
    alternate: bool,
}

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
    /// The bytes of snapshots the connections are owed, as of the last count.
    owed_snapshots: usize,
    snapshot_room: SnapshotRoom,
    /// The connections whose snapshots wait for room, in the order they are answered: the
    /// writer's first, as the daemon holds it and its input waits behind its snapshot, then the
    /// longest waiting, so a stream of newcomers can't keep one waiting.
    line: VecDeque<u64>,
    /// How long a peer that owes snapshot bytes must have left them unread before it may be
    /// dropped for one that waits: `STUCK_TO_EVICT`.
    stuck_to_evict: Duration,
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
    published: Published,
}

/// What one `poll` found ready.
#[derive(Debug, Default)]
struct Ready {
    master: bool,
    rebind: bool,
    listener: bool,
    /// What `poll` found for each connection, in order.
    conns: Vec<PollFlags>,
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
                owed_snapshots: 0,
                snapshot_room: SnapshotRoom::HOLDER,
                line: VecDeque::new(),
                stuck_to_evict: STUCK_TO_EVICT,
            },
            published: Published::default(),
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
        self.publish(holder);
        self.send_exit(holder);
        if ready.rebind {
            self.rebind_wakeups.clear();
            self.recheck_at = now;
        }
        if self.accept_paused_until.is_some_and(|until| now >= until) {
            self.accept_paused_until = None;
        }
        self.shared.owed_snapshots = owed_snapshots(&self.conns);
        self.shared.line = snapshot_line(&self.conns, self.shared.writer);
        // Connections already open first, so one whose `hello` is waiting is read before a
        // newcomer can take its place.
        for i in 0..self.conns.len() {
            if let Some(conn) = self.conns.get_mut(i) {
                let revents = ready.conns.get(i).copied().unwrap_or_else(PollFlags::empty);
                conn.polled(revents, &mut self.buffer);
            }
            // A respawn is answered here, with every connection at hand, and the connection's
            // requests after it then go on being answered.
            while let Some(conn) = self.conns.get_mut(i)
                && let Some((id, spec)) = serve(conn, &mut self.shared, holder, now)
            {
                self.respawn(i, id, &spec, holder);
            }
            // Freed here as well as after the writes, so a writer's `hello` later in this turn can
            // take the slot of one that can send no more. A writer that hangs up and then
            // reconnects finds it free: its end of input is read no later than the turn that
            // reads the new connection's `hello`, and before it, since older connections are
            // served first.
            if let Some(conn) = self.conns.get(i)
                && self.shared.writer == Some(conn.id())
                && !conn.may_send()
            {
                self.shared.writer = None;
            }
        }
        self.apply_resize(holder);
        // A respawn resets the title and the screen.
        self.publish(holder);
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
        self.evict_stuck_snapshots(now);
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

    /// Reports the title and the screen, where they changed since last reported, to every
    /// connection past `hello`, as of the output's end: the end of this turn's reads, not the byte
    /// that changed them, so a change and its reverse within a turn report nothing, and a
    /// snapshot gives the exact state.
    fn publish(&mut self, holder: &mut Holder<Screen>) {
        let at = holder.output().ring().end();
        let walled = holder.output_mut().engine_mut();
        let (title, alternate) = (walled.title(), walled.alternate());
        let Some(offset) = self.offset_of(at) else {
            return;
        };
        if title != self.published.title {
            self.published.title.clone_from(&title);
            let title = Reply::Title(Title {
                offset,
                text: title,
            });
            self.broadcast(State::Title, at, &title);
        }
        if alternate != self.published.alternate {
            self.published.alternate = alternate;
            let alternate = Reply::Alternate(Alternate {
                offset,
                on: alternate,
            });
            self.broadcast(State::Alternate, at, &alternate);
        }
    }

    /// `at` as the current generation's peers count it.
    fn offset_of(&self, at: u64) -> Option<Offset> {
        Offset::new(at.checked_sub(self.shared.base)?).ok()
    }

    /// Queues `reply`, a report of `state` as of `at`, to every connection past `hello`.
    fn broadcast(&mut self, state: State, at: u64, reply: &Reply) {
        let frame = match reply.encode() {
            Ok(frame) => frame,
            Err(error) => {
                tracing::warn!(%error, "could not encode a report");
                return;
            }
        };
        for conn in self.conns.iter_mut().filter(|conn| conn.is_open()) {
            conn.queue_state(state, at, frame.clone());
        }
    }

    /// While a snapshot waits for room, drops the connections whose peers have left a snapshot
    /// unread longest, for `stuck_to_evict` at least, until there is room: a peer that stopped
    /// reading can't keep the daemon from its snapshot. Never the writer's: the daemon holds it,
    /// and the room is for it.
    fn evict_stuck_snapshots(&mut self, now: Instant) {
        if !self.conns.iter().any(Connection::holds_a_snapshot) {
            return;
        }
        let (writer, stuck_for) = (self.shared.writer, self.shared.stuck_to_evict);
        while !self.shared.snapshot_room.takes(owed_snapshots(&self.conns)) {
            let longest = self
                .conns
                .iter_mut()
                .filter(|conn| conn.owed_snapshot() > 0 && Some(conn.id()) != writer)
                .filter_map(|conn| conn.stuck_since().map(|since| (since, conn)))
                .filter(|(since, _)| now.saturating_duration_since(*since) >= stuck_for)
                .min_by_key(|(since, _)| *since);
            let Some((_, conn)) = longest else {
                return;
            };
            tracing::info!("dropped a connection that left its snapshot unread");
            conn.drop_now();
        }
    }

    /// Sends the child's exit, once it is published, to every connection past `hello`, at the
    /// offset it came at, so a subscriber gets it after every byte the child wrote before it. A
    /// connection that says `hello` later finds it in the hello reply.
    fn send_exit(&mut self, holder: &Holder<Screen>) {
        let Some(exit) = holder.exit().filter(|_| !self.shared.exit_sent) else {
            return;
        };
        self.shared.exit_sent = true;
        let Some(frame) = exited_frame(exit) else {
            return;
        };
        let at = holder.output().ring().end();
        for conn in self.conns.iter_mut().filter(|conn| conn.is_open()) {
            conn.queue_exited(at, frame.clone());
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
        holder.output_mut().engine_mut().respawned(spec.theme);
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
                let at = holder.output().ring().end();
                if let Some(offset) = self.offset_of(at) {
                    let resized = Reply::Resized(Resized {
                        offset,
                        cols: self.shared.terminal.size.cols,
                        rows: self.shared.terminal.size.rows,
                    });
                    self.broadcast(State::Resized, at, &resized);
                }
            }
            Err(error) => tracing::warn!(%error, "could not resize the terminal"),
        }
    }

    /// Frees the writer slot once no connection that may send holds it: one whose peer ended its
    /// side, hung up, dropped or replaced sends no more input.
    fn release_writer(&mut self) {
        if let Some(id) = self.shared.writer
            && !self.conns.iter().any(|c| c.id() == id && c.may_send())
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
        let waiting = waiting_now(&self.conns, self.shared.snapshot_room, now);
        [
            self.socket
                .as_ref()
                .filter(|_| self.closing.is_none())
                .map(|_| self.recheck_at),
            self.accept_paused_until,
            closing,
            waiting,
            evicting_at(&self.conns, &self.shared),
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
        let revents = |i: usize| fds.get(i).map_or_else(PollFlags::empty, PollFd::revents);
        let ready = |i: usize| !revents(i).is_empty();
        Ok(Ready {
            master: master.is_some_and(ready),
            rebind: ready(1),
            listener: listener.is_some_and(ready),
            conns: (first_conn..fds.len()).map(revents).collect(),
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

/// Now, if any connection has a whole request waiting, or a snapshot that waited for room and
/// now has it: its peer may say nothing more until it is answered, and with nothing to read or
/// write its socket wakes nothing.
fn waiting_now(conns: &[Connection], room: SnapshotRoom, now: Instant) -> Option<Instant> {
    let snapshot_answerable =
        || conns.iter().any(Connection::holds_a_snapshot) && room.takes(owed_snapshots(conns));
    (conns.iter().any(Connection::has_request) || snapshot_answerable()).then_some(now)
}

/// While a snapshot waits for room, when a connection that owes snapshot bytes, the writer's
/// aside, will have been stuck long enough to drop.
fn evicting_at(conns: &[Connection], shared: &Shared) -> Option<Instant> {
    if !conns.iter().any(Connection::holds_a_snapshot) {
        return None;
    }
    conns
        .iter()
        .filter(|conn| conn.owed_snapshot() > 0 && Some(conn.id()) != shared.writer)
        .filter_map(Connection::stuck_since)
        .map(|since| since + shared.stuck_to_evict)
        .min()
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
        let after_snapshot = conn.take_after_snapshot();
        match next {
            Ok(Request::Respawn { id, body }) if conn.is_open() => return Some((id, body)),
            Ok(request) => {
                answer(conn, shared, holder, request, now, after_snapshot);
                if conn.holds_a_snapshot() {
                    return None;
                }
            }
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

/// Answers `request`. `after_snapshot` is where the output stood at a snapshot this connection
/// was answered just before it, which a `subscribe` without `from` starts at.
fn answer(
    conn: &mut Connection,
    shared: &mut Shared,
    holder: &mut Holder<Screen>,
    request: Request,
    now: Instant,
    after_snapshot: Option<AfterSnapshot>,
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
        Request::Subscribe { id, body } => {
            subscribe(
                conn,
                holder,
                shared.base,
                id,
                body.from.ok_or(after_snapshot),
            );
        }
        Request::Snapshot { id } => snapshot(conn, shared, holder, id, now),
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
        Request::Paste { id, body } => paste(conn, holder, id, &body),
        Request::Screen { id, body } => screen(conn, holder, id, body),
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
        // Answered by `serve`, as it needs every connection.
        other @ Request::Respawn { .. } => {
            let why = "this holder doesn't serve that request";
            refuse(conn, id, &other.name(), ErrorCode::UnknownRequest, why);
        }
    }
}

/// Answers a snapshot of the terminal as of the output's end, once the holder has room for it
/// (`SnapshotRoom`) and no other has waited longer, the writer's aside: until then it waits as
/// the connection's next request.
fn snapshot(
    conn: &mut Connection,
    shared: &mut Shared,
    holder: &mut Holder<Screen>,
    id: RequestId,
    now: Instant,
) {
    let writer = shared.writer == Some(conn.id());
    // The writer goes ahead of the line only while it owes nothing, so a writer that snapshots
    // in a loop can't keep the rest waiting.
    let ahead = writer && conn.owed_snapshot() == 0;
    let behind = !ahead && shared.line.front().is_some_and(|&first| first != conn.id());
    if behind || !shared.snapshot_room.takes(shared.owed_snapshots) {
        conn.hold(Request::Snapshot { id }, now);
        return;
    }
    shared.line.retain(|&waiting| waiting != conn.id());
    let at = holder.output().ring().end();
    let Some(offset) = at
        .checked_sub(shared.base)
        .and_then(|o| Offset::new(o).ok())
    else {
        let why = "the holder's offset is past what the protocol can say";
        refuse(conn, id, "snapshot", ErrorCode::Failed, why);
        return;
    };
    let walled = holder.output_mut().engine_mut();
    let mut frame = SnapshotFrame::default();
    // An engine that fails as it writes is replaced by an empty one, which the snapshot is then
    // of: the screen is lost.
    let mut written = walled.snapshot(MOST_SNAPSHOT_TEXT, frame.text());
    if written.is_none() && walled.alive() {
        written = walled.snapshot(MOST_SNAPSHOT_TEXT, frame.text());
    }
    if written.is_none() && walled.alive() {
        let why = "the terminal engine failed writing it, twice";
        refuse(conn, id, "snapshot", ErrorCode::Failed, why);
        return;
    }
    let dropped = match written {
        Some(Ok(dropped)) => u32::try_from(dropped).unwrap_or(u32::MAX),
        Some(Err(TooLarge)) => {
            let why = "the screens alone are over the snapshot's cap";
            refuse(conn, id, "snapshot", ErrorCode::SnapshotTooLarge, why);
            return;
        }
        None => {
            let why = "the terminal engine has failed for good";
            refuse(conn, id, "snapshot", ErrorCode::Unavailable, why);
            return;
        }
    };
    match frame.finish(id, offset, dropped) {
        Ok(bytes) => {
            shared.owed_snapshots = shared.owed_snapshots.saturating_add(bytes.len());
            conn.queue_snapshot(bytes, at);
        }
        Err(error) => {
            tracing::warn!(%error, "could not encode a snapshot");
            refuse(
                conn,
                id,
                "snapshot",
                ErrorCode::Failed,
                "the holder can't say it",
            );
        }
    }
}

/// The screen shown as plain text, after the history asked for, whether or not the child has
/// exited. An engine that fails as it writes is replaced by an empty one, which the text is then
/// of, as for a snapshot.
/// A screen answer isn't counted in `SNAPSHOTS_IN_FLIGHT`: each is at most about 2 MiB, its text
/// with every char escaped as JSON at worst, and a connection that stops reading owes no more of
/// them than its queue takes before `QUEUE_MARK`.
fn screen(conn: &mut Connection, holder: &mut Holder<Screen>, id: RequestId, body: ScreenRequest) {
    match screen_text(holder, body) {
        Ok(body) => send(conn, &Reply::Screen { id, body }),
        Err((code, why)) => refuse(conn, id, "screen", code, why),
    }
}

fn screen_text(
    holder: &mut Holder<Screen>,
    request: ScreenRequest,
) -> Result<body::Screen, (ErrorCode, &'static str)> {
    let history = screen_history(request.history);
    let walled = holder.output_mut().engine_mut();
    let mut text = String::new();
    let mut written = walled.text(history, MOST_SCREEN_TEXT, &mut text);
    if written.is_none() && walled.alive() {
        written = walled.text(history, MOST_SCREEN_TEXT, &mut text);
    }
    let rows = match written {
        Some(Ok(rows)) => rows,
        Some(Err(TooLarge)) => {
            return Err((
                ErrorCode::SnapshotTooLarge,
                "the screen alone is over the text's cap",
            ));
        }
        None if walled.alive() => {
            return Err((
                ErrorCode::Failed,
                "the terminal engine failed writing it, twice",
            ));
        }
        None => {
            return Err((
                ErrorCode::Unavailable,
                "the terminal engine has failed for good",
            ));
        }
    };
    let failed = (ErrorCode::Failed, "the holder can't say it");
    let rows = u64::try_from(rows)
        .ok()
        .and_then(|rows| Count::new(rows).ok());
    body::Screen::new(text, rows.ok_or(failed)?).map_err(|_| failed)
}

/// The rows of history a request asks for, at most `MOST_SCREEN_HISTORY`.
fn screen_history(asked: Count) -> usize {
    usize::try_from(asked.get()).map_or(MOST_SCREEN_HISTORY, |rows| rows.min(MOST_SCREEN_HISTORY))
}

/// The child's `exited`, as it is sent.
fn exited_frame(exit: &Exit) -> Option<Vec<u8>> {
    let exited = Reply::Exited(Exited {
        generation: exit.generation,
        status: exit.status.clone(),
    });
    exited
        .encode()
        .inspect_err(|error| tracing::warn!(%error, "could not encode the exit"))
        .ok()
}

/// The connections whose snapshots wait, in the order they are answered: the writer's, then the
/// longest waiting first.
fn snapshot_line(conns: &[Connection], writer: Option<u64>) -> VecDeque<u64> {
    let mut waiting: Vec<(bool, Instant, u64)> = conns
        .iter()
        .filter_map(|conn| {
            let since = conn.held_since()?;
            Some((Some(conn.id()) != writer, since, conn.id()))
        })
        .collect();
    waiting.sort_unstable();
    waiting.into_iter().map(|(_, _, id)| id).collect()
}

/// The bytes of snapshots every connection is owed.
fn owed_snapshots(conns: &[Connection]) -> usize {
    conns.iter().map(Connection::owed_snapshot).sum()
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

/// Types a paste if the program would read it as text now (`Holder::paste`), deciding the marks
/// from the engine's bracketed-paste mode in the same turn.
fn paste(conn: &mut Connection, holder: &mut Holder<Screen>, id: RequestId, body: &PasteRequest) {
    let bracketed = holder.output_mut().engine_mut().bracketed_paste();
    match holder.paste(body.generation(), body.text(), body.brackets(), bracketed) {
        Ok(()) => ok(conn, id, "paste"),
        Err(refused) => {
            let (code, why) = refused.answer();
            refuse(conn, id, "paste", code, why);
        }
    }
}

/// Moves the connection's subscription to `from`. Without one, it starts where the snapshot the
/// connection was answered just before stood, so a snapshot and a `subscribe` sent together
/// lose no output between them even when the snapshot's size holds the `subscribe` a turn;
/// with neither, at the holder's offset now. A snapshot from before a respawn starts it at the
/// new generation's 0. `base` is where the current generation starts in the output, which its
/// offsets count from.
fn subscribe(
    conn: &mut Connection,
    holder: &Holder<Screen>,
    base: u64,
    id: RequestId,
    from: Result<SubscribeFrom, Option<AfterSnapshot>>,
) {
    let end = holder.output().ring().end();
    // A snapshot that moved the subscription there itself has its output under way already.
    let moved = matches!(from, Err(Some(AfterSnapshot { moved: true, .. })));
    let offset = match from {
        Ok(from) if from.generation != holder.generation() => {
            let why = "that offset is of another generation's output";
            refuse(conn, id, "subscribe", ErrorCode::StaleGeneration, why);
            return;
        }
        Ok(from) if from.offset.get() > end.saturating_sub(base) => {
            let why = "that offset is past the holder's";
            refuse(conn, id, "subscribe", ErrorCode::OutOfRange, why);
            return;
        }
        Ok(from) => base + from.offset.get(),
        Err(Some(snapshot)) if snapshot.at < base => {
            let why = "a respawn came between the snapshot and this subscription: snapshot again";
            refuse(conn, id, "subscribe", ErrorCode::StaleGeneration, why);
            return;
        }
        Err(Some(snapshot)) => snapshot.at,
        Err(None) => end,
    };
    let request = "subscribe".to_owned();
    match (Reply::Ok {
        id,
        body: OkBody { request },
    })
    .encode()
    {
        Ok(frame) => {
            if moved {
                conn.queue(frame);
            } else {
                conn.queue_subscribed(frame, offset);
            }
            if let Some(frame) = holder.exit().and_then(exited_frame) {
                conn.requeue_exited(end, frame);
            }
        }
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
        let leads = bazhen_pid::group(pgid).ok().flatten() == Some(pgid)
            && bazhen_pid::session(Some(pgid)).ok().flatten() == Some(child);
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
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
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
            let _ = peer
                .read(&mut drained)
                .expect("the peer was sent nothing to read");
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
            Self::with(name, script, crate::engine::tests::failing, 100)
        }

        /// A holder serving `script` under `sh -c`, with engines `make` makes, keeping `history`
        /// rows.
        fn with(name: &str, script: &str, make: crate::engine::MakeVt, history: usize) -> Self {
            use bazhen_holder_proto::body::{Argv, Env, Generation, NonEmpty};

            use crate::child::Reaper;
            use crate::engine::Walled;

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
            let history = bazhen_holder_engine::HistoryRows(history);
            let engine = Walled::new(make, engine_size, history, None);
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
            let give_up = Instant::now() + Duration::from_secs(10);
            while replies.len() < 2 {
                assert!(Instant::now() < give_up, "no answer to {request:?}");
                assert!(!self.server.turn(&mut self.holder).unwrap());
                read_into(&mut peer, &mut decoder, &mut replies);
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
        match failing
            .ask(&Request::Snapshot { id: RequestId(3) })
            .as_slice()
        {
            [_, Reply::Error { body, .. }] => assert_eq!(body.code, "unavailable"),
            other => panic!("answered {other:?}"),
        }
    }

    /// 100,000 rows of 79 columns: a snapshot of eight megabytes, several times what a peer's
    /// socket takes unread.
    const BIG: &str = "yes 0123456789012345678901234567890123456789012345678901234567890123456789012345678 \
                       | head -n 100000";
    /// All of `BIG` as the terminal passes it on: each row and its `\r\n`.
    const BIG_BYTES: u64 = 100_000 * 81;

    fn hello_request() -> Request {
        hello_as(false)
    }

    fn hello_as(writer: bool) -> Request {
        Request::Hello {
            id: RequestId(1),
            body: HelloRequest {
                protocol: Versions::spoken(),
                writer: Some(writer),
            },
        }
    }

    /// Reads what `peer` has been sent so far into `replies`.
    fn read_into(
        peer: &mut UnixStream,
        decoder: &mut bazhen_holder_proto::FrameDecoder<Reply>,
        replies: &mut Vec<Reply>,
    ) {
        let mut chunk = vec![0; 1 << 20];
        while let Ok(n) = peer.read(&mut chunk) {
            if n == 0 {
                break;
            }
            decoder.push(&chunk[..n]);
        }
        while let Some(reply) = decoder.next_frame().unwrap() {
            replies.push(reply);
        }
    }

    fn snapshot_request(id: u32) -> Request {
        Request::Snapshot { id: RequestId(id) }
    }

    fn subscribe_request(id: u32) -> Request {
        Request::Subscribe {
            id: RequestId(id),
            body: body::SubscribeRequest { from: None },
        }
    }

    impl Failing {
        /// A connection that has sent `requests` in one write and reads nothing yet.
        fn peer(&self, requests: &[Request]) -> UnixStream {
            let peer = UnixStream::connect(self.dir.join("t.sock")).unwrap();
            peer.set_nonblocking(true).unwrap();
            let bytes: Vec<u8> = requests.iter().flat_map(|r| r.encode().unwrap()).collect();
            (&peer).write_all(&bytes).unwrap();
            peer
        }

        fn owed(&self) -> usize {
            owed_snapshots(&self.server.conns)
        }

        fn holding(&self) -> bool {
            self.server.conns.iter().any(Connection::holds_a_snapshot)
        }

        fn holders(&self) -> usize {
            self.server
                .conns
                .iter()
                .filter(|c| c.holds_a_snapshot())
                .count()
        }

        fn owing(&self) -> usize {
            self.server
                .conns
                .iter()
                .filter(|c| c.owed_snapshot() > 0)
                .count()
        }

        /// A holder that has read all of `BIG`, with room for `fit` of its snapshots at once,
        /// whose stuck peers may be dropped after `stuck`.
        fn big(name: &str, fit: usize, stuck: Duration) -> Self {
            let mut big = Self::with(name, BIG, crate::engine::engine, 100_000);
            big.until_within("the output read", 60, |b| b.holder.exit().is_some());
            let size = match big.ask(&snapshot_request(2)).as_slice() {
                [_, Reply::Snapshot { bytes, .. }] => {
                    bytes.len() + bazhen_holder_proto::SNAPSHOT_HEAD
                }
                other => panic!("answered {other:?}"),
            };
            big.server.shared.snapshot_room = SnapshotRoom {
                in_flight: fit * size,
                most: size,
            };
            big.server.shared.stuck_to_evict = stuck;
            big
        }

        /// As `until`, for `seconds` at most, checking after each turn that the bound holds.
        fn until_within(&mut self, what: &str, seconds: u64, done: impl Fn(&Self) -> bool) {
            let give_up = Instant::now() + Duration::from_secs(seconds);
            while !done(self) {
                assert!(Instant::now() < give_up, "{what} never happened");
                assert!(!self.server.turn(&mut self.holder).unwrap());
                let room = self.server.shared.snapshot_room;
                assert!(
                    self.owed() <= room.in_flight.max(room.most),
                    "{} owed",
                    self.owed()
                );
            }
        }
    }

    /// Ends the test process, failing, with `stalled` unless dropped within `within`. A turn
    /// that never returns can't fail an assertion: the test's own thread is the one in it, and a
    /// holder can't move to another, as its engine isn't `Send`.
    struct StallWatch {
        _alive: std::sync::mpsc::Sender<()>,
    }

    impl StallWatch {
        fn new(within: Duration, stalled: &'static str) -> Self {
            let (alive, watched) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || {
                if watched.recv_timeout(within) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
                    // Past the test harness's capture, which an exit would never print.
                    let _ = writeln!(std::io::stderr(), "{stalled}");
                    std::process::exit(101);
                }
            });
            Self { _alive: alive }
        }
    }

    /// Long enough that no peer is dropped for being stuck however slow the host.
    const NEVER: Duration = Duration::from_secs(3600);

    #[test]
    fn the_holders_bound_fits_two_of_the_largest_snapshots_and_no_more() {
        let mut largest = bazhen_holder_proto::SnapshotFrame::default();
        largest
            .text()
            .push_str(&"x".repeat(bazhen_holder_proto::MOST_SNAPSHOT_TEXT));
        let frame = largest
            .finish(RequestId(1), Offset::new(0).unwrap(), 0)
            .unwrap();
        assert_eq!(frame.len(), LARGEST_SNAPSHOT);
        let room = SnapshotRoom::HOLDER;
        assert!(room.takes(0) && room.takes(LARGEST_SNAPSHOT));
        assert!(!room.takes(LARGEST_SNAPSHOT + 1));
        assert_eq!(SNAPSHOTS_IN_FLIGHT, 128 << 20 | 8);
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn snapshots_owed_across_connections_stay_under_the_bound_and_one_held_is_served_once_read() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut big = Failing::big("snapshot-bound", 2, NEVER);
        let mut peers: Vec<UnixStream> = (0..3)
            .map(|i| big.peer(&[hello_request(), snapshot_request(10 + i)]))
            .collect();
        big.until_within("a snapshot held for room", 30, Failing::holding);
        assert_eq!((big.holders(), big.owing()), (1, 2));
        let (mut decoder, mut first) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        // Reading the first frees what it is owed as it reads, and the held one is answered
        // once that makes room.
        let give_up = Instant::now() + Duration::from_secs(30);
        let room = big.server.shared.snapshot_room;
        while big.holding() {
            assert!(
                Instant::now() < give_up,
                "the held snapshot was never answered"
            );
            read_into(&mut peers[0], &mut decoder, &mut first);
            assert!(!big.server.turn(&mut big.holder).unwrap());
            assert!(big.owed() <= room.in_flight, "{} owed", big.owed());
        }
        assert!(
            big.server.conns.iter().all(|c| !c.is_gone()),
            "one was evicted"
        );
        assert!(big.owing() >= 2, "the held snapshot was not answered");
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn only_a_peer_stuck_owing_a_snapshot_is_dropped_for_one_that_waits_and_never_the_writer() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut big = Failing::big("snapshot-evict", 10, NEVER);
        let _writer = big.peer(&[hello_as(true), snapshot_request(10)]);
        // Stuck a turn before the others, so the eviction deadline's leaving it out is seen.
        big.until_within("the writer stuck on its snapshot", 30, |b| {
            b.server
                .conns
                .iter()
                .any(|c| Some(c.id()) == b.server.shared.writer && c.stuck_since().is_some())
        });
        // Stuck next, on output alone: the ring's 64 KiB fill a send buffer shrunk before it
        // subscribes, where `admit`'s would take them all.
        let plain = big.server.next_id + 1;
        let plain_peer = big.peer(&[hello_request()]);
        big.until_within("the plain peer accepted", 30, |b| b.server.next_id == plain);
        let accepted = big.server.conns.iter().find(|c| c.id() == plain).unwrap();
        rustix::net::sockopt::set_socket_send_buffer_size(accepted.fd(), 4096).unwrap();
        let from_the_start = Request::Subscribe {
            id: RequestId(3),
            body: body::SubscribeRequest {
                from: Some(SubscribeFrom {
                    generation: body::Generation::new(0).unwrap(),
                    offset: Offset::new(0).unwrap(),
                }),
            },
        };
        (&plain_peer)
            .write_all(&from_the_start.encode().unwrap())
            .unwrap();
        big.until_within("the plain peer stuck owing no snapshot", 30, |b| {
            b.server
                .conns
                .iter()
                .any(|c| c.id() == plain && c.stuck_since().is_some() && c.owed_snapshot() == 0)
        });
        let _peers: Vec<UnixStream> = (11..14)
            .map(|id| big.peer(&[hello_request(), snapshot_request(id)]))
            .collect();
        big.until_within("four unread snapshots", 30, |b| {
            b.server
                .conns
                .iter()
                .filter(|c| c.owed_snapshot() > 0 && c.stuck_since().is_some())
                .count()
                == 4
        });
        // Room for what is owed now, less a byte, beside the largest: dropping any one peer makes
        // room for the one held, and dropping a second is more than room needs.
        let most = big.server.shared.snapshot_room.most;
        big.server.shared.snapshot_room.in_flight = big.owed() + most - 1;
        big.server.shared.stuck_to_evict = Duration::from_millis(200);
        let writer = big.server.shared.writer;
        let longest = big
            .server
            .conns
            .iter()
            .filter(|c| c.owed_snapshot() > 0 && Some(c.id()) != writer)
            .filter_map(|c| c.stuck_since().map(|since| (since, c.id())))
            .min()
            .map(|(_, id)| id);
        let _held = big.peer(&[hello_request(), snapshot_request(14)]);
        // What is armed builds one snapshot of `BIG` and waits out `stuck_to_evict`: a few seconds
        // on a Linux host, and an estimated 25 at most on CI's macOS runner, whose suite is five
        // times slower. Two minutes is five times that, and far under a test's time cap.
        let watch = StallWatch::new(
            Duration::from_secs(120),
            "a turn never returned: the eviction went on picking peers whose drop makes no room, \
             as a dropped one owing no snapshot is",
        );
        big.until_within("a snapshot held for room", 30, Failing::holding);
        // The loop wakes for the drop when the first peer owing a snapshot, the writer aside, has
        // been stuck long enough, though nothing else happens.
        let first_stuck = big
            .server
            .conns
            .iter()
            .filter(|c| c.owed_snapshot() > 0 && Some(c.id()) != writer)
            .filter_map(Connection::stuck_since)
            .min()
            .unwrap();
        assert_eq!(
            evicting_at(&big.server.conns, &big.server.shared),
            Some(first_stuck + big.server.shared.stuck_to_evict)
        );
        big.until_within("the held snapshot answered", 30, |b| !b.holding());
        drop(watch);
        let ids: Vec<u64> = big.server.conns.iter().map(Connection::id).collect();
        assert!(
            ids.iter().any(|&id| Some(id) == writer),
            "the writer was dropped"
        );
        assert!(
            !ids.iter().any(|&id| Some(id) == longest),
            "the longest stuck was kept"
        );
        assert!(ids.contains(&plain), "a peer owing no snapshot was dropped");
        assert_eq!(ids.len(), 5, "more were dropped than made room");
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_close_ends_once_all_owed_is_written_and_not_before_its_time_if_not() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut f = Failing::start("close-done", "exit 0");
        let _peer = f.peer(&[hello_request()]);
        f.until_within("the child's exit, and the peer open", 30, |b| {
            b.holder.exit().is_some() && b.server.conns.iter().any(Connection::is_open)
        });
        f.holder.close(Instant::now());
        f.until_within("the child's session ended", 30, |b| b.holder.ended());
        let now = Instant::now();
        f.server.closing = Some(Closing::Ending { since: now });
        assert!(
            f.server.close_done(&f.holder, now),
            "a close owing nothing waited"
        );
        f.server.conns[0].queue(vec![0; 8]);
        f.server.closing = Some(Closing::Ending { since: now });
        assert!(
            !f.server.close_done(&f.holder, now),
            "a close ended with bytes owed"
        );
        assert!(
            f.server.close_done(&f.holder, now + CLOSE_FLUSH_WITHIN),
            "a close waited past its time"
        );
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_subscriber_is_pushed_the_title_and_the_switch_to_the_alternate_screen() {
        bazhen_test_signal::require_sandbox().unwrap();
        let script = "read _; printf '\\033]0;hi\\007\\033[?1049h'; exec sleep 30";
        let mut f = Failing::start("title-pushed", script);
        let mut peer = f.peer(&[hello_as(true), subscribe_request(2)]);
        let (mut decoder, mut replies) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        f.until("the subscription", |f| {
            f.server.conns.iter().any(Connection::is_open)
        });
        let input = Request::Input {
            id: RequestId(3),
            bytes: b"\n".to_vec(),
        };
        (&peer).write_all(&input.encode().unwrap()).unwrap();
        let give_up = Instant::now() + Duration::from_secs(10);
        let pushed = |replies: &[Reply]| {
            let title = replies
                .iter()
                .any(|r| matches!(r, Reply::Title(t) if t.text == "hi"));
            let alternate = replies
                .iter()
                .any(|r| matches!(r, Reply::Alternate(a) if a.on));
            (title, alternate)
        };
        while pushed(&replies) != (true, true) {
            assert!(
                Instant::now() < give_up,
                "the title or the switch was never pushed: {replies:?}"
            );
            assert!(!f.server.turn(&mut f.holder).unwrap());
            read_into(&mut peer, &mut decoder, &mut replies);
        }
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_snapshot_draws_the_screen_once() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut f = Failing::start("snapshot-once", "printf 'xyzzy'; exec sleep 30");
        f.until("the output", |f| f.output().contains("xyzzy"));
        match f.ask(&snapshot_request(2)).as_slice() {
            [_, Reply::Snapshot { bytes, .. }] => {
                let text = String::from_utf8_lossy(bytes);
                assert_eq!(text.matches("xyzzy").count(), 1, "{text:?}");
            }
            other => panic!("answered {other:?}"),
        }
    }

    #[test]
    fn a_screen_reads_the_history_asked_for_up_to_the_most() {
        let read: Vec<usize> = [0, 7, 10_000, 10_001, u64::from(u32::MAX)]
            .into_iter()
            .map(|rows| screen_history(Count::new(rows).unwrap()))
            .collect();
        assert_eq!(read, [0, 7, 10_000, 10_000, 10_000]);
    }

    fn screen_request(history: u64) -> Request {
        Request::Screen {
            id: RequestId(2),
            body: ScreenRequest {
                history: Count::new(history).unwrap(),
            },
        }
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_connection_without_the_writer_slot_reads_the_screen_and_history_as_text() {
        bazhen_test_signal::require_sandbox().unwrap();
        let script = "for n in $(seq 1 30); do printf '%s\\r\\n' $n; done; printf '\\033[31mred'; exec sleep 30";
        let mut f = Failing::start("screen-text", script);
        f.until("the output", |f| f.output().contains("red"));
        match f.ask(&screen_request(2)).as_slice() {
            [Reply::Hello { body: hello, .. }, Reply::Screen { body, .. }] => {
                assert!(!hello.writer);
                let rows: Vec<String> = (8..=30).map(|n| n.to_string()).collect();
                assert_eq!(body.text(), format!("6\n7\n{}\nred\n", rows.join("\n")));
                assert_eq!(body.history().get(), 2);
            }
            other => panic!("answered {other:?}"),
        }
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_screen_is_read_after_its_child_has_exited() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut f = Failing::start("screen-exited", "printf 'last words'");
        f.until("the child's exit", |f| f.holder.exit().is_some());
        match f.ask(&screen_request(0)).as_slice() {
            [_, Reply::Screen { body, .. }] => assert_eq!(body.text(), "last words\n"),
            other => panic!("answered {other:?}"),
        }
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_screen_with_no_engine_left_is_refused_unavailable() {
        bazhen_test_signal::require_sandbox().unwrap();
        let script = "while :; do printf '<fail>'; sleep 0.02; done";
        let mut f = Failing::start("screen-no-engine", script);
        f.until("the engine given up", |f| {
            !f.holder.output().engine().alive()
        });
        match f.ask(&screen_request(0)).as_slice() {
            [_, Reply::Error { body, .. }] => assert_eq!(body.code, "unavailable"),
            other => panic!("answered {other:?}"),
        }
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_subscription_from_an_offset_streams_from_that_offset() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut f = Failing::start("subscribe-from", "printf '0123456789'; exec sleep 30");
        f.until("the output", |f| f.output().contains("0123456789"));
        let subscribe = Request::Subscribe {
            id: RequestId(2),
            body: body::SubscribeRequest {
                from: Some(body::SubscribeFrom {
                    generation: f.holder.generation(),
                    offset: Offset::new(4).unwrap(),
                }),
            },
        };
        let mut peer = f.peer(&[hello_request(), subscribe]);
        let (mut decoder, mut replies) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        let give_up = Instant::now() + Duration::from_secs(10);
        let first = loop {
            assert!(Instant::now() < give_up, "no output: {replies:?}");
            assert!(!f.server.turn(&mut f.holder).unwrap());
            read_into(&mut peer, &mut decoder, &mut replies);
            if let Some(first) = replies.iter().find_map(|r| match r {
                Reply::Data { offset, bytes } => Some((offset.get(), bytes.clone())),
                _ => None,
            }) {
                break first;
            }
        };
        assert_eq!(first.0, 4);
        assert!(first.1.starts_with(b"456789"), "{first:?}");
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_subscription_after_a_snapshot_of_a_terminal_yet_to_write_is_answered() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut f = Failing::start("subscribe-at-zero", "exec sleep 30");
        let mut peer = f.peer(&[hello_request(), snapshot_request(2), subscribe_request(3)]);
        let (mut decoder, mut replies) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        let give_up = Instant::now() + Duration::from_secs(10);
        let answer = loop {
            assert!(Instant::now() < give_up, "the subscribe was never answered");
            assert!(!f.server.turn(&mut f.holder).unwrap());
            read_into(&mut peer, &mut decoder, &mut replies);
            if let Some(answer) = replies.iter().find_map(|r| match r {
                Reply::Error { body, .. } => Some(body.code.clone()),
                Reply::Ok { body, .. } if body.request == "subscribe" => Some("ok".to_owned()),
                _ => None,
            }) {
                break answer;
            }
        };
        assert_eq!(answer, "ok", "{replies:?}");
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_respawn_sent_before_hello_is_refused_and_respawns_nothing() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut f = Failing::start("respawn-first", "exec sleep 30");
        let mut env = std::collections::BTreeMap::new();
        env.insert("PATH".to_owned(), std::env::var("PATH").unwrap());
        let respawn = Request::Respawn {
            id: RequestId(2),
            body: ProcessSpec {
                argv: body::Argv::new(vec!["sleep".into(), "30".into()]).unwrap(),
                cwd: body::NonEmpty::new("/").unwrap(),
                env: body::Env::new(env).unwrap(),
                generation: body::Generation::new(1).unwrap(),
                theme: None,
            },
        };
        let mut peer = f.peer(&[respawn]);
        let (mut decoder, mut replies) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        let give_up = Instant::now() + Duration::from_secs(10);
        while replies.is_empty() {
            assert!(Instant::now() < give_up, "the respawn was never answered");
            assert!(!f.server.turn(&mut f.holder).unwrap());
            read_into(&mut peer, &mut decoder, &mut replies);
        }
        assert!(
            matches!(&replies[0], Reply::Error { body, .. } if body.code == "invalid"),
            "{replies:?}"
        );
        assert_eq!(f.holder.generation().get(), 0);
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn an_accept_with_no_connection_waiting_goes_on_accepting() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut f = Failing::start("accept-idle", "sleep 30");
        f.server.accept(Instant::now());
        assert_eq!(f.server.accept_paused_until, None);
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn the_writers_snapshot_is_answered_before_older_ones() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut big = Failing::big("snapshot-writer-first", 1, NEVER);
        let mut first = big.peer(&[hello_request(), snapshot_request(10)]);
        let _older = big.peer(&[hello_request(), snapshot_request(11)]);
        big.until_within("the older held", 30, |b| b.holders() == 1);
        let writer = big.peer(&[hello_as(true)]);
        big.until_within("the writer's hello", 30, |b| {
            b.server.shared.writer.is_some()
        });
        (&writer)
            .write_all(&snapshot_request(12).encode().unwrap())
            .unwrap();
        big.until_within("the writer held", 30, |b| b.holders() == 2);
        let (mut decoder, mut replies) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        let give_up = Instant::now() + Duration::from_secs(30);
        while big.holders() == 2 {
            assert!(Instant::now() < give_up, "the first was never read");
            read_into(&mut first, &mut decoder, &mut replies);
            assert!(!big.server.turn(&mut big.holder).unwrap());
        }
        let writer = big.server.shared.writer;
        let held: Vec<bool> = big
            .server
            .conns
            .iter()
            .filter(|c| c.holds_a_snapshot())
            .map(|c| Some(c.id()) == writer)
            .collect();
        assert_eq!(
            held,
            [false],
            "an older snapshot went ahead of the writer's"
        );
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_snapshot_that_waited_longest_is_answered_before_a_newer_one() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut big = Failing::big("snapshot-order", 1, NEVER);
        let mut first = big.peer(&[hello_request(), snapshot_request(10)]);
        let newer = big.peer(&[hello_request()]);
        let _older = big.peer(&[hello_request(), snapshot_request(12)]);
        big.until_within("the second held", 30, |b| b.holders() == 1);
        (&newer)
            .write_all(&snapshot_request(11).encode().unwrap())
            .unwrap();
        big.until_within("the newer held", 30, |b| b.holders() == 2);
        let (mut decoder, mut replies) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        let give_up = Instant::now() + Duration::from_secs(30);
        while big.holders() == 2 {
            assert!(Instant::now() < give_up, "the first was never read");
            read_into(&mut first, &mut decoder, &mut replies);
            assert!(!big.server.turn(&mut big.holder).unwrap());
        }
        let ids: Vec<u64> = big.server.conns.iter().map(Connection::id).collect();
        let holding: Vec<u64> = big
            .server
            .conns
            .iter()
            .filter(|c| c.holds_a_snapshot())
            .map(Connection::id)
            .collect();
        // The newer asks from the connection opened earlier, so order of connections alone would
        // answer it first.
        assert_eq!(
            holding,
            [ids[1]],
            "the newer was answered ahead of the older"
        );
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_subscribe_sent_with_a_snapshot_starts_at_its_offset_though_the_snapshot_holds_it_a_turn() {
        bazhen_test_signal::require_sandbox().unwrap();
        let script = format!("{BIG}; while :; do echo tick; sleep 0.005; done");
        let mut big = Failing::with("seam", &script, crate::engine::engine, 100_000);
        big.until_within("the output read", 60, |b| {
            b.holder.output().ring().end() >= BIG_BYTES
        });
        let mut peer = big.peer(&[hello_request(), snapshot_request(2), subscribe_request(3)]);
        // Unread, the snapshot holds the subscribe back, and the child's output moves on.
        big.until_within("the snapshot past the mark", 30, |b| {
            b.server
                .conns
                .iter()
                .any(|c| c.queued() >= crate::conn::QUEUE_MARK)
        });
        let at = big.holder.output().ring().end();
        big.until_within("more output", 30, |b| b.holder.output().ring().end() > at);
        let (mut decoder, mut replies) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        let give_up = Instant::now() + Duration::from_secs(30);
        while !replies.iter().any(|r| matches!(r, Reply::Data { .. })) {
            assert!(Instant::now() < give_up, "no output after the snapshot");
            read_into(&mut peer, &mut decoder, &mut replies);
            assert!(!big.server.turn(&mut big.holder).unwrap());
        }
        let snapshot = replies.iter().find_map(|r| match r {
            Reply::Snapshot { offset, .. } => Some(offset.get()),
            _ => None,
        });
        let first = replies.iter().find_map(|r| match r {
            Reply::Data { offset, .. } => Some(offset.get()),
            _ => None,
        });
        assert_eq!(snapshot, Some(at));
        // A gap would mean the ring lapped the subscription, and the seam went untested.
        assert!(
            !replies.iter().any(|r| matches!(r, Reply::Gap(_))),
            "the ring lapped the subscription"
        );
        assert_eq!(
            first, snapshot,
            "output between the snapshot and the subscription was lost"
        );
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_subscriber_that_snapshots_again_while_output_goes_on_is_sent_no_byte_twice() {
        bazhen_test_signal::require_sandbox().unwrap();
        let script = format!("{BIG}; while :; do echo tick; sleep 0.005; done");
        let mut big = Failing::with("resnapshot", &script, crate::engine::engine, 100_000);
        big.until_within("the output read", 60, |b| {
            b.holder.output().ring().end() >= BIG_BYTES
        });
        let mut peer = big.peer(&[hello_request(), subscribe_request(2)]);
        let (mut decoder, mut replies) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        let give_up = Instant::now() + Duration::from_secs(30);
        while !replies.iter().any(|r| matches!(r, Reply::Data { .. })) {
            assert!(Instant::now() < give_up, "no output to the subscriber");
            assert!(!big.server.turn(&mut big.holder).unwrap());
            read_into(&mut peer, &mut decoder, &mut replies);
        }
        let attach = [snapshot_request(3), subscribe_request(4)];
        let bytes: Vec<u8> = attach.iter().flat_map(|r| r.encode().unwrap()).collect();
        (&peer).write_all(&bytes).unwrap();
        // Unread, the snapshot holds the subscribe back, and the child's output moves on.
        big.until_within("the snapshot past the mark", 30, |b| {
            b.server
                .conns
                .iter()
                .any(|c| c.queued() >= crate::conn::QUEUE_MARK)
        });
        let at = big.holder.output().ring().end();
        big.until_within("more output", 30, |b| b.holder.output().ring().end() > at);
        let answered = |replies: &[Reply]| {
            replies.iter().position(|r| {
                matches!(
                    r,
                    Reply::Ok {
                        id: RequestId(4),
                        ..
                    }
                )
            })
        };
        let give_up = Instant::now() + Duration::from_secs(30);
        while answered(&replies).is_none_or(|i| replies.len() < i + 3) {
            assert!(Instant::now() < give_up, "the subscribe was never answered");
            read_into(&mut peer, &mut decoder, &mut replies);
            assert!(!big.server.turn(&mut big.holder).unwrap());
        }
        let mut end = 0;
        for reply in &replies {
            match reply {
                Reply::Data { offset, bytes } => {
                    assert!(
                        offset.get() >= end,
                        "{} sent again, after {end}",
                        offset.get()
                    );
                    end = offset.get() + bytes.len() as u64;
                }
                Reply::Gap(gap) => end = gap.to.get(),
                Reply::Snapshot { offset, .. } => {
                    assert!(offset.get() >= end);
                    end = offset.get();
                }
                _ => {}
            }
        }
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_subscribe_after_a_snapshot_a_respawn_overtook_is_refused() {
        bazhen_test_signal::require_sandbox().unwrap();
        // Output after the snapshot, which the respawn then overtakes.
        let script = "stty -echo; printf before; read _; printf after";
        let mut failing = Failing::with("respawn-seam", script, crate::engine::engine, 100);
        failing.until("the output", |f| f.output().contains("before"));
        let writer = failing.peer(&[hello_as(true)]);
        let mut viewer = failing.peer(&[hello_request(), snapshot_request(2)]);
        let (mut decoder, mut replies) = (bazhen_holder_proto::reply_decoder(), Vec::new());
        let give_up = Instant::now() + Duration::from_secs(10);
        while !replies.iter().any(|r| matches!(r, Reply::Snapshot { .. })) {
            assert!(Instant::now() < give_up, "no snapshot");
            assert!(!failing.server.turn(&mut failing.holder).unwrap());
            read_into(&mut viewer, &mut decoder, &mut replies);
        }
        let input = Request::Input {
            id: RequestId(3),
            bytes: b"\n".to_vec(),
        };
        (&writer).write_all(&input.encode().unwrap()).unwrap();
        failing.until("the exit", |f| f.holder.exit().is_some());
        assert!(failing.output().contains("after"));
        let mut env = std::collections::BTreeMap::new();
        env.insert("PATH".to_owned(), std::env::var("PATH").unwrap());
        let spec = ProcessSpec {
            argv: body::Argv::new(vec!["sleep".into(), "30".into()]).unwrap(),
            cwd: body::NonEmpty::new("/").unwrap(),
            env: body::Env::new(env).unwrap(),
            generation: body::Generation::new(1).unwrap(),
            theme: None,
        };
        let respawn = Request::Respawn {
            id: RequestId(2),
            body: spec,
        };
        let mut respawner = failing.peer(&[hello_request(), respawn]);
        let (mut respawner_decoder, mut answers) =
            (bazhen_holder_proto::reply_decoder(), Vec::new());
        let give_up = Instant::now() + Duration::from_secs(10);
        while !answers.iter().any(|r| {
            matches!(
                r,
                Reply::Ok {
                    id: RequestId(2),
                    ..
                }
            )
        }) {
            assert!(
                Instant::now() < give_up,
                "the respawn was never answered: {answers:?}"
            );
            assert!(!failing.server.turn(&mut failing.holder).unwrap());
            read_into(&mut respawner, &mut respawner_decoder, &mut answers);
        }
        (&viewer)
            .write_all(&subscribe_request(3).encode().unwrap())
            .unwrap();
        let give_up = Instant::now() + Duration::from_secs(10);
        let refused = loop {
            assert!(Instant::now() < give_up, "the subscribe was never answered");
            assert!(!failing.server.turn(&mut failing.holder).unwrap());
            read_into(&mut viewer, &mut decoder, &mut replies);
            if let Some(answer) = replies.iter().find_map(|r| match r {
                Reply::Error { body, .. } => Some(body.code.clone()),
                Reply::Ok { body, .. } if body.request == "subscribe" => Some("ok".to_owned()),
                _ => None,
            }) {
                break answer;
            }
        };
        assert_eq!(refused, "stale-generation");
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_snapshot_whose_engine_fails_once_comes_from_the_empty_engine_after_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut failing = Failing::start("snapshot-fails-once", "printf before; exec sleep 30");
        failing.until("the output", |f| f.output().contains("before"));
        crate::engine::tests::fail_snapshots(1);
        match failing.ask(&snapshot_request(2)).as_slice() {
            [_, Reply::Snapshot { bytes, .. }] => {
                let text = String::from_utf8_lossy(bytes);
                assert!(
                    !text.contains("before"),
                    "the failed engine's screen came back"
                );
            }
            other => panic!("answered {other:?}"),
        }
        let (hello, stats) = failing.hello_and_stats();
        assert_eq!(hello.engine, Some(true));
        assert_eq!(stats.engine_resets.map(Count::get), Some(1));
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_snapshot_whose_engine_fails_twice_is_refused_failed() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut failing = Failing::start("snapshot-fails-twice", "exec sleep 30");
        crate::engine::tests::fail_snapshots(2);
        match failing.ask(&snapshot_request(2)).as_slice() {
            [_, Reply::Error { body, .. }] => assert_eq!(body.code, "failed"),
            other => panic!("answered {other:?}"),
        }
        assert_eq!(failing.hello_and_stats().0.engine, Some(true));
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_writer_that_still_owes_a_snapshot_waits_its_turn_for_the_next() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut failing = Failing::with("writer-loop", "exec sleep 30", crate::engine::engine, 100);
        let (ours, _peer) = UnixStream::pair().unwrap();
        ours.set_nonblocking(true).unwrap();
        let now = Instant::now();
        let mut writer = Connection::new(100, ours, now);
        writer.open(0);
        failing.server.shared.writer = Some(100);
        let waiting = 7;
        failing.server.shared.line = VecDeque::from([waiting]);
        let shared = &mut failing.server.shared;
        snapshot(&mut writer, shared, &mut failing.holder, RequestId(1), now);
        assert!(
            !writer.holds_a_snapshot(),
            "the writer waited though it owed nothing"
        );
        assert!(writer.owed_snapshot() > 0);
        let shared = &mut failing.server.shared;
        snapshot(&mut writer, shared, &mut failing.holder, RequestId(2), now);
        assert!(
            writer.holds_a_snapshot(),
            "a writer still owing one went ahead again"
        );
    }

    /// A connection to `failing`'s socket that has sent a `hello` asking for the writer slot.
    fn asks_to_write(failing: &Failing) -> UnixStream {
        let mut peer = UnixStream::connect(failing.dir.join("t.sock")).unwrap();
        peer.set_nonblocking(true).unwrap();
        let hello = Request::Hello {
            id: RequestId(1),
            body: HelloRequest {
                protocol: Versions::spoken(),
                writer: Some(true),
            },
        };
        peer.write_all(&hello.encode().unwrap()).unwrap();
        peer
    }

    /// Turns the loop until `peer`'s `hello` is answered.
    fn hello_answer(failing: &mut Failing, peer: &mut UnixStream) -> HelloReply {
        let mut decoder = bazhen_holder_proto::reply_decoder();
        let mut chunk = vec![0; 1 << 16];
        let give_up = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < give_up, "the hello was never answered");
            assert!(!failing.server.turn(&mut failing.holder).unwrap());
            if let Ok(n) = peer.read(&mut chunk) {
                decoder.push(&chunk[..n]);
            }
            match decoder.next_frame().unwrap() {
                Some(Reply::Hello { body, .. }) => return body,
                Some(other) => panic!("hello was answered {other:?}"),
                None => {}
            }
        }
    }

    /// The old writer's end of input and the newcomer's connect reach the holder in one turn, as
    /// they do when a writer hangs up and reconnects at once: the newcomer's `hello`, read in a
    /// later turn, finds the slot free.
    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_writers_hang_up_frees_the_slot_for_a_hello_in_the_next_turn() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut failing = Failing::start("writer-hands-over", "exec sleep 30");
        let mut old = asks_to_write(&failing);
        assert!(hello_answer(&mut failing, &mut old).writer);
        drop(old);
        let mut new = asks_to_write(&failing);
        assert!(hello_answer(&mut failing, &mut new).writer);
    }
}
