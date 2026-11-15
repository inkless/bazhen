//! The holder's loop: one `poll` over the `SIGCHLD` wake-ups and the PTY master. It reads the
//! child's output into an `Output`, reaps the child, and publishes its exit once the output that
//! came before the exit has been read.

use std::io;
use std::os::fd::BorrowedFd;
use std::time::{Duration, Instant};

use bazhen_holder_proto::body::{self, ExitStatus, Generation};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::process::Pid;

use crate::child::{ChildProcess, Reaper, SignalRefused};
use crate::input::{InputFull, InputQueue};
use crate::pty::{Pty, WindowSize};

/// How long, after the child is reaped, output it wrote before exiting may still arrive before the
/// exit is published. Reading the end of the output (EIO or 0) publishes it sooner.
pub const EXIT_DRAIN: Duration = Duration::from_millis(100);

/// What a read of the master is cut into, and the most read in one turn: enough that a flood
/// moves, little enough that one flooding child can't hold the loop, and a quarter of the ring,
/// so a turn's reading can't lap a subscriber that the turn before left caught up.
const READ_CHUNK: usize = 64 << 10;
const MAX_READ_PER_TURN: usize = 256 << 10;

/// Where the child's output goes, in order.
pub trait Output {
    fn write(&mut self, bytes: &[u8]);
}

/// An `Output` that keeps nothing.
#[derive(Debug, Default)]
pub struct Discard;

impl Output for Discard {
    fn write(&mut self, _bytes: &[u8]) {}
}

/// A child's end, as `holder/1` reports it: which generation, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exit {
    pub generation: Generation,
    pub status: ExitStatus,
}

/// One terminal: its PTY, its child and where the child's output goes.
///
/// The `Pty` must outlive any unwind that drops the rest: closing the master hangs the terminal
/// up, and the kernel then sends `SIGHUP` to the child's session. An unwind boundary inside the
/// loop, such as the engine's, keeps the `Holder`, and so the master, outside it.
///
/// Once the master reads EIO or 0 it leaves the poll set for good: a process that opens the
/// terminal again afterwards isn't read, and blocks once the PTY's buffer fills.
#[derive(Debug)]
pub struct Holder<O: Output> {
    pty: Pty,
    reaper: Reaper,
    child: ChildProcess,
    generation: Generation,
    output: O,
    chunk: Box<[u8]>,
    master_open: bool,
    draining_until: Option<Instant>,
    exit: Option<Exit>,
    input: InputQueue,
}

/// Why `input` was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputRefused {
    /// The child's exit is published: nothing more reaches the terminal.
    Exited,
    Full(InputFull),
}

impl<O: Output> Holder<O> {
    /// Takes over a child just spawned, and reaps it at once if it has already exited.
    pub fn new(
        pty: Pty,
        reaper: Reaper,
        child: ChildProcess,
        generation: Generation,
        output: O,
    ) -> Self {
        let mut holder = Self {
            pty,
            reaper,
            child,
            generation,
            output,
            chunk: vec![0; READ_CHUNK].into_boxed_slice(),
            master_open: true,
            draining_until: None,
            exit: None,
            input: InputQueue::default(),
        };
        holder.step(Instant::now());
        holder
    }

    /// The child's exit, once it has been reaped and its output drained.
    pub fn exit(&self) -> Option<&Exit> {
        self.exit.as_ref()
    }

    pub const fn output(&self) -> &O {
        &self.output
    }

    pub const fn generation(&self) -> Generation {
        self.generation
    }

    pub const fn child_pid(&self) -> Pid {
        self.child.pid()
    }

    /// What tells the holder its children exit, which a child must be spawned after.
    pub const fn reaper(&self) -> &Reaper {
        &self.reaper
    }

    /// Replaces the child, whose exit is published, with `child` of `generation`, on `pty`. The old
    /// PTY is closed, so nothing left of the old session writes into the new generation's output
    /// or reads its input, and no terminal mode the old program set reaches the new one.
    pub fn respawn(&mut self, pty: Pty, child: ChildProcess, generation: Generation) {
        self.pty = pty;
        self.child = child;
        self.generation = generation;
        self.master_open = true;
        self.draining_until = None;
        self.exit = None;
        self.input.clear();
        self.step(Instant::now());
    }

    /// Readable once the child may have exited.
    pub fn wakeups(&self) -> BorrowedFd<'_> {
        self.reaper.fd()
    }

    /// Whether the child has been reaped, its exit published or not.
    pub fn child_reaped(&self) -> bool {
        self.child.exit().is_some()
    }

    /// The master, while it may still have output to read.
    pub fn master(&self) -> Option<BorrowedFd<'_>> {
        self.master_open.then(|| self.pty.master())
    }

    /// What `poll` should wait for on the master: output, and room for input while any waits.
    pub fn master_interest(&self) -> PollFlags {
        if self.input.is_empty() {
            PollFlags::IN
        } else {
            PollFlags::IN | PollFlags::OUT
        }
    }

    /// Queues input for the child, whole or not at all.
    ///
    /// # Errors
    ///
    /// `Exited` once the child's exit is published or nothing holds the terminal open to read it,
    /// `Full` when the queue can't take it.
    pub fn offer_input(&mut self, bytes: &[u8]) -> Result<(), InputRefused> {
        if self.exit.is_some() || !self.master_open {
            return Err(InputRefused::Exited);
        }
        self.input.offer(bytes).map_err(InputRefused::Full)
    }

    /// Writes queued input to the master as far as it takes it. A master that refuses it for good
    /// has no reader left, so the input is dropped.
    pub fn flush_input(&mut self) {
        if self.input.is_empty() || !self.master_open {
            return;
        }
        if let Err(error) = self.input.write_to(self.pty.master()) {
            tracing::warn!(%error, queued = self.input.len(), "input can't reach the child; dropped");
            self.input.clear();
        }
    }

    /// Sets the terminal's size, which sends `SIGWINCH` to its foreground group.
    ///
    /// # Errors
    ///
    /// When the system refuses the size.
    pub fn resize(&self, size: WindowSize) -> io::Result<()> {
        self.pty.set_size(size)
    }

    /// The terminal's foreground process group (`Pty::foreground_group`).
    pub fn foreground_group(&self) -> Option<Pid> {
        self.pty.foreground_group()
    }

    /// Sends `signal` to the child's process group (`ChildProcess::signal`).
    ///
    /// # Errors
    ///
    /// `Exited` once the child is reaped, `Failed` when the system refuses.
    pub fn signal(&self, signal: body::Signal) -> Result<(), SignalRefused> {
        self.child.signal(signal)
    }

    /// Starts ending the child (`ChildProcess::close`).
    pub fn close(&mut self, now: Instant) {
        self.child.close(self.pty.foreground_group(), now);
    }

    /// Does what a `poll` found to do: reads the master if it was ready, reaps, and publishes.
    pub fn after_poll(&mut self, master_ready: bool, now: Instant) {
        self.reaper.clear();
        if master_ready {
            self.read_master();
        }
        self.step(now);
    }

    /// Waits for the next thing to do, and does it, with nothing but the child to serve: the
    /// holder's own loop is `Server::run`. Waits with no timeout when no deadline is pending.
    ///
    /// # Errors
    ///
    /// When `poll` fails for any reason but an interrupting signal.
    pub fn turn(&mut self) -> io::Result<()> {
        let timeout = match self.deadline() {
            Some(at) => Some(
                Timespec::try_from(at.saturating_duration_since(Instant::now()))
                    .map_err(io::Error::other)?,
            ),
            None => None,
        };
        let master_ready = {
            let wakeups = self.wakeups();
            // A master nothing holds open any more reports `POLLHUP` whatever is asked, so it
            // leaves the set rather than wake every turn.
            let mut fds: Vec<PollFd<'_>> = [Some(wakeups), self.master()]
                .into_iter()
                .flatten()
                .map(|fd| PollFd::from_borrowed_fd(fd, PollFlags::IN))
                .collect();
            readiness(poll(&mut fds, timeout.as_ref()))?
                && fds.get(1).is_some_and(|fd| !fd.revents().is_empty())
        };
        self.after_poll(master_ready, Instant::now());
        Ok(())
    }

    /// When the process side next needs a turn with nothing ready: the end of an exit's drain, or a
    /// close's kill.
    pub fn deadline(&self) -> Option<Instant> {
        match (self.draining_until, self.child.close_deadline()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn read_master(&mut self) {
        let mut read = 0;
        while read < MAX_READ_PER_TURN {
            match rustix::io::read(self.pty.master(), &mut *self.chunk) {
                Ok(0) => {
                    self.master_closed();
                    return;
                }
                Ok(n) => {
                    read += n;
                    self.output.write(self.chunk.get(..n).unwrap_or_default());
                }
                Err(rustix::io::Errno::INTR) => {}
                Err(rustix::io::Errno::AGAIN) => return,
                // EIO once nothing holds the slave open (Linux): the output is over, the
                // terminal isn't.
                Err(_) => {
                    self.master_closed();
                    return;
                }
            }
        }
    }

    /// The master's output is over: nothing holds the terminal open, so nothing will read input
    /// either, and what is queued is dropped.
    fn master_closed(&mut self) {
        self.master_open = false;
        if !self.input.is_empty() {
            tracing::warn!(
                queued = self.input.len(),
                "input no reader is left for; dropped"
            );
        }
        self.input.clear();
    }

    /// Reaps the child, starts its drain, and publishes its exit once the output has ended or
    /// the drain is over.
    fn step(&mut self, now: Instant) {
        if self.exit.is_none()
            && self.draining_until.is_none()
            && let Some(status) = self.child.reap().map(describe)
        {
            tracing::info!(status, "child reaped");
            self.draining_until = Some(now + EXIT_DRAIN);
        }
        if let Some(until) = self.draining_until
            && (!self.master_open || now >= until)
            && let Some(status) = self.child.exit()
        {
            tracing::info!(status = %describe(status), "child exited");
            self.exit = Some(Exit {
                generation: self.generation,
                status: status.clone(),
            });
            self.draining_until = None;
            self.input.clear();
        }
        self.child.close_step(self.pty.foreground_group(), now);
    }
}

/// Whether a `poll` found anything ready. An interrupting signal is a turn with nothing ready,
/// never an error: `SIGCHLD` interrupts `poll` whenever a child exits.
pub(crate) fn readiness(polled: rustix::io::Result<usize>) -> io::Result<bool> {
    match polled {
        Ok(ready) => Ok(ready > 0),
        Err(rustix::io::Errno::INTR) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// `exited 0`, `signalled SIGTERM` or `unknown`, for the log.
pub fn describe(status: &ExitStatus) -> String {
    match status {
        ExitStatus::Exited { code } => format!("exited {}", code.get()),
        ExitStatus::Signalled { signal } => format!("signalled {signal}"),
        ExitStatus::Unknown => "unknown".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use bazhen_holder_proto::body::{Argv, Env, NonEmpty, ProcessSpec};

    use super::*;
    use crate::pty::{self, WindowSize};

    const DEADLINE: Duration = Duration::from_secs(5);

    fn holder(argv: &[&str]) -> Holder<Discard> {
        let mut env = BTreeMap::new();
        env.insert("PATH".to_owned(), std::env::var("PATH").unwrap());
        let process = ProcessSpec {
            argv: Argv::new(argv.iter().map(|&a| a.to_owned()).collect()).unwrap(),
            cwd: NonEmpty::new("/").unwrap(),
            env: Env::new(env).unwrap(),
            generation: Generation::new(3).unwrap(),
            theme: None,
        };
        let reaper = Reaper::new().unwrap();
        let (pty, slave) = Pty::open(WindowSize::clamped(80, 24)).unwrap();
        let child = pty::spawn(slave, &process, &reaper).unwrap();
        Holder::new(pty, reaper, child, process.generation, Discard)
    }

    /// Turns until the exit is published, and says whether that was before the drain's deadline:
    /// in the same step as the reap, or on a turn the deadline hadn't reached.
    fn published_before_the_drain_was_over(holder: &mut Holder<Discard>) -> bool {
        let give_up = Instant::now() + DEADLINE;
        let mut draining_until = holder.draining_until;
        while holder.exit().is_none() {
            assert!(Instant::now() < give_up, "the exit was never published");
            holder.turn().unwrap();
            if holder.exit().is_none() {
                draining_until = holder.draining_until;
            }
        }
        draining_until.is_none_or(|until| Instant::now() < until)
    }

    #[test]
    fn the_exit_is_published_once_the_output_ends_without_waiting_out_the_drain() {
        let mut holder = holder(&["sh", "-c", "echo bye; exit 6"]);
        assert!(published_before_the_drain_was_over(&mut holder));
        let exit = holder.exit().unwrap();
        assert_eq!(exit.generation.get(), 3);
        assert_eq!(describe(&exit.status), "exited 6");
    }

    /// Linux only in effect: macOS revokes the terminal when its session leader exits, so the
    /// output always ends with the leader there, and only the case above can happen.
    #[test]
    fn the_exit_waits_out_the_drain_while_something_still_holds_the_terminal() {
        let mut holder = holder(&["sh", "-c", "read _; exit 0"]);
        let name = rustix::pty::ptsname(holder.pty.master(), Vec::new()).unwrap();
        let held = pty::open_terminal(&name).unwrap();
        rustix::io::write(holder.pty.master(), b"\n").unwrap();
        let early = published_before_the_drain_was_over(&mut holder);
        drop(held);
        if std::env::consts::OS == "linux" {
            assert!(
                !early,
                "the exit was published while the terminal was still held"
            );
        }
        assert_eq!(describe(&holder.exit().unwrap().status), "exited 0");
    }

    #[test]
    fn a_signal_that_interrupts_the_poll_is_a_turn_with_nothing_ready() {
        assert!(!readiness(Err(rustix::io::Errno::INTR)).unwrap());
        assert!(!readiness(Ok(0)).unwrap());
        assert!(readiness(Ok(1)).unwrap());
        assert!(readiness(Err(rustix::io::Errno::BADF)).is_err());
    }
}
