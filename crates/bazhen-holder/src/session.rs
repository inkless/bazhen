//! A terminal's session: every process in it found and signalled, and none outside it.
//!
//! A session's id is its leader's pid, so while the holder hasn't reaped the leader no new
//! session can be given that number, and a process whose session is that id is the terminal's.
//! A step lists every process once, with the session each was in (`Listing`); each pass keeps
//! those whose session is that id and reads each again, and the guard then holds each one and
//! checks it again before it signals (`guard::signal_member`), so a pid that ends and is given to
//! another process between the listing and the signal is never signalled.

use std::collections::HashSet;
use std::io;
use std::time::{Duration, Instant};

use rustix::io::Errno;
use rustix::process::{Pid, Signal};

use crate::child::CLOSE_GRACE;
use crate::guard::{self, Refused, SendError};

/// How often an ending looks at its session once the leader has exited, and sends `SIGKILL` again
/// once the grace is over: each look is a pass over its step's listing of every process.
pub const SWEEP_EVERY: Duration = Duration::from_millis(50);
/// How many `SIGKILL` passes an ending makes before it gives up on what is left.
pub const KILL_SWEEPS: u32 = 10;
/// How many empty passes in a row end a session. One isn't enough: a pass works from its step's
/// listing, made before it, so a member's child started after the listing is missed if the member
/// then exits.
pub const EMPTY_PASSES: u32 = 2;

/// What one pass over the session found.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Sweep {
    /// The live members the pass signalled, or found, when it only counted.
    pub reached: Vec<Pid>,
    /// The members that refused the signal: another user's, as a `sudo` is.
    pub refused: Vec<Pid>,
    /// The pass couldn't list the processes, or failed on one for a reason that may pass.
    pub incomplete: bool,
}

impl Sweep {
    /// Whether the pass found no member it could signal, and missed none.
    pub fn is_empty(&self) -> bool {
        self.reached.is_empty() && !self.incomplete
    }
}

/// What one process turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Member {
    /// Not in the session, a zombie, or gone.
    Outside,
    Reached,
    Refused,
    Failed,
}

impl Member {
    /// What a send through the guard made of `pid`.
    pub(crate) fn of_send(pid: Pid, sent: Result<(), SendError>) -> Self {
        match sent {
            Ok(()) => Self::Reached,
            // EINVAL: the pid was given to a thread of another process before it was held.
            Err(SendError::Os(Errno::SRCH | Errno::INVAL)) => Self::Outside,
            Err(SendError::Os(Errno::PERM)) => Self::Refused,
            Err(SendError::Refused(refused)) => {
                tracing::warn!(pid = pid.as_raw_nonzero(), %refused, "the guard refused a signal");
                Self::Failed
            }
            Err(SendError::Os(errno)) => {
                tracing::warn!(pid = pid.as_raw_nonzero(), %errno, "could not signal a process");
                Self::Failed
            }
        }
    }
}

/// What `/proc/<pid>/stat` says of a process and the session `session`: `Reached` for a live
/// member, `Outside` for a process of another session or a zombie, `Failed` for a line that can't
/// be read. A thread group whose first thread has exited shows `Z` while its other threads run,
/// so it is a zombie only once it has no thread but that one.
pub fn member_state(stat: &[u8], session: i32) -> Member {
    let number = |n| {
        crate::start_time::stat_field(stat, n)
            .and_then(|field| std::str::from_utf8(field).ok())
            .and_then(|field| field.parse::<i64>().ok())
    };
    let state = crate::start_time::stat_field(stat, 3);
    match (state, number(6), number(20)) {
        (Some(b"X"), _, _) => Member::Outside,
        (Some(b"Z"), _, Some(threads)) if threads <= 1 => Member::Outside,
        (Some(_), Some(sid), Some(_)) if sid == i64::from(session) => Member::Reached,
        (Some(_), Some(_), Some(_)) => Member::Outside,
        _ => Member::Failed,
    }
}

/// A process as a step's listing saw it: its pid, and the session it was in, `None` when that
/// couldn't be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Listed {
    pub(crate) pid: Pid,
    pub(crate) session: Option<i32>,
}

/// Every process, listed once for all the passes of one holder step, and only once a pass asks.
///
/// A pass skips only what the listing saw in another session, and reads again every process it
/// keeps before it signals. A process can't join a session, only leave its own for a new one
/// numbered by its own pid, and a session's id is its leader's unreaped pid, so a process listed
/// outside stays outside unless its pid is given to a new process. A pass made later in the step
/// than the listing so misses only a process started since, as a pass that listed for itself
/// misses one started after its own listing; the next step, `SWEEP_EVERY` on, lists again and
/// finds it. The hangup's `SIGCONT` pass shares its `SIGHUP` pass's listing, so it continues what
/// that pass hung up: a process started in between was forked by a running member, since a
/// stopped process can't fork.
#[derive(Debug)]
pub struct Listing {
    list: fn() -> io::Result<Vec<Listed>>,
    listed: Option<Vec<Listed>>,
}

impl Default for Listing {
    fn default() -> Self {
        Self::new()
    }
}

impl Listing {
    /// A listing of this system's processes, not yet made.
    pub fn new() -> Self {
        Self::by(list)
    }

    /// A listing that `list` makes.
    pub(crate) const fn by(list: fn() -> io::Result<Vec<Listed>>) -> Self {
        Self { list, listed: None }
    }

    /// The pids listed in `session`, or whose session couldn't be read, in the order listed.
    /// Lists first if no pass has yet; a listing that failed isn't kept, so the next pass lists
    /// again.
    fn candidates(&mut self, session: Pid) -> io::Result<Vec<Pid>> {
        let listed = match &mut self.listed {
            Some(listed) => listed,
            None => self.listed.insert((self.list)()?),
        };
        let session = session.as_raw_pid();
        Ok(listed
            .iter()
            .filter(|seen| seen.session.is_none_or(|sid| sid == session))
            .map(|seen| seen.pid)
            .collect())
    }
}

/// Every process of this system, with its session.
pub(crate) fn list() -> io::Result<Vec<Listed>> {
    os::list()
}

/// The session a child leads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Session(Pid);

impl Session {
    /// The session `leader` leads, once it is proven the holder's own child, unreaped: every pass
    /// relies on that, so that its pid can't number another session.
    ///
    /// # Errors
    ///
    /// When `leader` isn't such a child (`guard::vet_leader`).
    pub(crate) fn led_by(leader: Pid) -> Result<Self, Refused> {
        guard::vet_leader(leader)?;
        Ok(Self(leader))
    }

    /// Sends `signal` to every live process in the session, its leader included.
    pub fn signal(self, signal: Signal) -> Sweep {
        self.pass(Some(signal), &mut Listing::new())
    }

    /// Finds every live process in the session, and signals none.
    pub fn count(self) -> Sweep {
        self.pass(None, &mut Listing::new())
    }

    fn pass(self, signal: Option<Signal>, listing: &mut Listing) -> Sweep {
        match listing.candidates(self.0) {
            Ok(pids) => self.pass_among(pids, signal),
            Err(error) => {
                tracing::error!(%error, "could not list the processes to find a session's");
                Sweep {
                    incomplete: true,
                    ..Sweep::default()
                }
            }
        }
    }

    /// One pass over `candidates`, which may name any process.
    pub(crate) fn pass_among(
        self,
        candidates: impl IntoIterator<Item = Pid>,
        signal: Option<Signal>,
    ) -> Sweep {
        #[cfg(test)]
        bazhen_test_signal::require_sandbox().unwrap();
        let mut sweep = Sweep::default();
        // The leader first, so it can't see its jobs end first and act on it: a shell's `wait`
        // returns, a supervisor starts them again.
        let mut pids: Vec<Pid> = candidates.into_iter().collect();
        if let Some(at) = pids.iter().position(|pid| *pid == self.0) {
            pids.swap(0, at);
        }
        for pid in pids {
            match os::visit(pid, self.0, signal) {
                Member::Outside => {}
                Member::Reached => sweep.reached.push(pid),
                Member::Refused => sweep.refused.push(pid),
                Member::Failed => sweep.incomplete = true,
            }
        }
        sweep
    }
}

/// A session being ended: `SIGHUP` and `SIGCONT` at its first step, and `SIGKILL` from
/// `CLOSE_GRACE` on, pass after pass, until `EMPTY_PASSES` passes in a row find the session empty
/// or `KILL_SWEEPS` passes have been made. The leader's exit is the caller's to tell, since only
/// it waits for the leader.
#[derive(Debug)]
pub struct Ending<S: Sweeper = Session> {
    sweeper: S,
    hung_up: bool,
    kill_at: Instant,
    next_pass: Instant,
    kills_left: u32,
    empty_in_a_row: u32,
    /// Members that have refused a signal, each logged once.
    refused: HashSet<Pid>,
    over: bool,
}

/// What makes an ending's passes over its session.
pub trait Sweeper {
    /// One pass over `listing`: `signal` sent to every live member of the session, or, with
    /// `None`, none sent.
    fn sweep(&mut self, signal: Option<Signal>, listing: &mut Listing) -> Sweep;
}

impl Sweeper for Session {
    fn sweep(&mut self, signal: Option<Signal>, listing: &mut Listing) -> Sweep {
        self.pass(signal, listing)
    }
}

impl Ending {
    /// An ending whose first step, due at once, hangs the session up.
    pub fn start(session: Session, now: Instant) -> Self {
        Self::new(session, now)
    }
}

impl<S: Sweeper> Ending<S> {
    /// `start`, making its passes by `sweeper`, which only a test gives as anything but a
    /// `Session`: product code can end only a session `Session::led_by` has vetted.
    fn new(sweeper: S, now: Instant) -> Self {
        Self {
            sweeper,
            hung_up: false,
            kill_at: now + CLOSE_GRACE,
            next_pass: now,
            kills_left: KILL_SWEEPS,
            empty_in_a_row: 0,
            refused: HashSet::new(),
            over: false,
        }
    }

    /// Whether the session has been found empty, or what was left given up on.
    pub const fn is_over(&self) -> bool {
        self.over
    }

    /// When the next pass is due: the hangup, the first kill, the next once killing, and while
    /// waiting for the kill after the leader's exit, the next look.
    pub fn deadline(&self, leader_exited: bool) -> Option<Instant> {
        if self.over {
            None
        } else if !self.hung_up || self.killing() {
            Some(self.next_pass)
        } else if leader_exited {
            Some(self.next_pass.min(self.kill_at))
        } else {
            Some(self.kill_at)
        }
    }

    /// Makes the pass that is due, if one is, over `listing`, the step's.
    pub fn step(&mut self, leader_exited: bool, now: Instant, listing: &mut Listing) {
        if self.deadline(leader_exited).is_none_or(|at| now < at) {
            return;
        }
        self.next_pass = now + SWEEP_EVERY;
        if !self.hung_up {
            // A stopped process acts on `SIGHUP` only once continued.
            for signal in [Signal::HUP, Signal::CONT] {
                let sweep = self.pass(Some(signal), listing);
                self.note_refused(&sweep);
            }
            self.hung_up = true;
            return;
        }
        if !self.killing() && now < self.kill_at {
            let sweep = self.pass(None, listing);
            self.count_empty(&sweep);
            return;
        }
        let sweep = self.pass(Some(Signal::KILL), listing);
        self.note_refused(&sweep);
        self.kills_left = self.kills_left.saturating_sub(1);
        if leader_exited {
            self.count_empty(&sweep);
        }
        if !self.over && self.kills_left == 0 {
            let left: Vec<i32> = sweep
                .reached
                .iter()
                .map(|pid| pid.as_raw_nonzero().get())
                .collect();
            tracing::error!(
                ?left,
                "processes of the session outlived every kill; leaving them"
            );
            self.over = true;
        }
    }

    fn pass(&mut self, signal: Option<Signal>, listing: &mut Listing) -> Sweep {
        self.sweeper.sweep(signal, listing)
    }

    fn count_empty(&mut self, sweep: &Sweep) {
        if sweep.is_empty() {
            self.empty_in_a_row += 1;
        } else {
            self.empty_in_a_row = 0;
        }
        if self.empty_in_a_row >= EMPTY_PASSES {
            tracing::info!("the session has ended");
            self.over = true;
        }
    }

    fn killing(&self) -> bool {
        self.kills_left < KILL_SWEEPS
    }

    fn note_refused(&mut self, sweep: &Sweep) {
        for pid in &sweep.refused {
            if self.refused.insert(*pid) {
                tracing::warn!(
                    pid = pid.as_raw_nonzero(),
                    "a process of the session is another user's, which a close can't end"
                );
            }
        }
    }
}

/// Whether this system can sweep a session: on Linux, whether it has `pidfd_open` (5.3 on) and
/// a `/proc` of its own PID namespace, whose pids are the ones it signals by.
///
/// # Errors
///
/// When it can't, with why.
pub fn supported() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    os::supported()?;
    Ok(())
}

#[cfg(target_os = "linux")]
mod os {
    use std::io;

    use rustix::io::Errno;
    use rustix::process::{Pid, PidfdFlags, Signal, getpid, pidfd_open};

    use super::{Listed, Member, member_state};

    pub(super) fn supported() -> io::Result<()> {
        match pidfd_open(getpid(), PidfdFlags::empty()) {
            Ok(_) => crate::linux::may_send_through_a_pidfd().map_err(|error| {
                io::Error::other(format!(
                    "pidfd_send_signal, which the holder needs to end a terminal's processes \
                     without reaching another's, is refused: {error}"
                ))
            })?,
            Err(Errno::NOSYS) => {
                return Err(io::Error::other(
                    "this kernel has no pidfd_open, which the holder needs to end a terminal's \
                     processes without reaching another's: it needs Linux 5.3 or later",
                ));
            }
            Err(errno) => {
                return Err(io::Error::other(format!(
                    "pidfd_open, which the holder needs to end a terminal's processes without \
                     reaching another's, is refused: {errno}"
                )));
            }
        }
        let stat = std::fs::read("/proc/self/stat")?;
        if crate::start_time::own_pid(&stat) == Some(getpid().as_raw_pid()) {
            Ok(())
        } else {
            Err(io::Error::other(
                "/proc is another PID namespace's, so the holder can't find a terminal's \
                 processes by it: mount a /proc of this namespace",
            ))
        }
    }

    pub(super) fn list() -> io::Result<Vec<Listed>> {
        Ok(pids()?
            .into_iter()
            .filter_map(|pid| {
                seen(
                    pid,
                    std::fs::read(format!("/proc/{}/stat", pid.as_raw_nonzero())),
                )
            })
            .collect())
    }

    /// What a read of `pid`'s `/proc/<pid>/stat` puts in the listing: nothing for a process
    /// gone, and a session left unknown for one that couldn't be read.
    pub(super) fn seen(pid: Pid, stat: io::Result<Vec<u8>>) -> Option<Listed> {
        match stat {
            Ok(stat) => Some(Listed {
                pid,
                session: listed_session(&stat),
            }),
            Err(error) if gone(&error) => None,
            Err(_) => Some(Listed { pid, session: None }),
        }
    }

    /// The session a `/proc/<pid>/stat` line says its process is in, `None` for a line
    /// `member_state` can't read, so that `visit` reads it again and fails the pass.
    fn listed_session(stat: &[u8]) -> Option<i32> {
        let session = crate::start_time::session_field(stat)?;
        (member_state(stat, session) != Member::Failed).then_some(session)
    }

    /// Whether a read of a process's `stat` failed because it has no process any more.
    fn gone(error: &io::Error) -> bool {
        error.kind() == io::ErrorKind::NotFound
            || error.raw_os_error() == Some(Errno::SRCH.raw_os_error())
    }

    fn pids() -> io::Result<Vec<Pid>> {
        let mut pids = Vec::new();
        for entry in std::fs::read_dir("/proc")? {
            let name = entry?.file_name();
            if let Some(pid) = name
                .to_str()
                .and_then(|n| n.parse().ok())
                .and_then(Pid::from_raw)
            {
                pids.push(pid);
            }
        }
        Ok(pids)
    }

    pub(super) fn visit(pid: Pid, session: Pid, signal: Option<Signal>) -> Member {
        let stat = match std::fs::read(format!("/proc/{}/stat", pid.as_raw_nonzero())) {
            Ok(stat) => stat,
            Err(error) if gone(&error) => return Member::Outside,
            Err(error) => {
                tracing::warn!(pid = pid.as_raw_nonzero(), %error, "could not read a process");
                return Member::Failed;
            }
        };
        match (member_state(&stat, session.as_raw_pid()), signal) {
            (Member::Reached, Some(signal)) => {
                Member::of_send(pid, crate::guard::signal_member(pid, session, signal))
            }
            (state, _) => state,
        }
    }
}

#[cfg(target_os = "macos")]
mod os {
    use std::io;

    use rustix::process::{Pid, Signal};

    use super::{Listed, Member};

    /// A process whose session can't be read, or is led from outside this PID namespace, is left
    /// out: `visit` counts it outside.
    pub(super) fn list() -> io::Result<Vec<Listed>> {
        Ok(crate::macos::pids()?
            .into_iter()
            .filter_map(|pid| {
                let session = bazhen_pid::session(Some(pid)).ok().flatten()?;
                Some(Listed {
                    pid,
                    session: Some(session.as_raw_pid()),
                })
            })
            .collect())
    }

    pub(super) fn visit(pid: Pid, session: Pid, signal: Option<Signal>) -> Member {
        crate::macos::visit(pid, session, signal)
    }
}

/// How many listings the counting sources of a test on this thread have made.
#[cfg(test)]
pub(crate) mod listings {
    use std::cell::Cell;

    std::thread_local! {
        static MADE: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) fn made() -> usize {
        MADE.with(Cell::get)
    }

    pub(crate) fn count_one() {
        MADE.with(|made| made.set(made.get() + 1));
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, VecDeque};
    use std::io::{BufRead as _, BufReader};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use bazhen_holder_proto::body::{Argv, Env, Generation, NonEmpty, ProcessSpec};
    use proptest::prelude::*;
    use rustix::process::{WaitId, WaitIdOptions, waitid};

    use super::*;
    use crate::child::{ChildProcess, Reaper};
    use crate::pty::{self, Pty, WindowSize};

    const DEADLINE: Duration = Duration::from_secs(5);

    /// A child leading a session on a PTY of its own, its session killed and the child reaped
    /// when the test ends.
    struct Leader {
        pty: Pty,
        _reaper: Reaper,
        child: ChildProcess,
    }

    impl Drop for Leader {
        fn drop(&mut self) {
            if let Ok(session) = Session::led_by(self.child.pid()) {
                let _ = session.signal(Signal::KILL);
            }
            // A test that failed is reported by its own failure, not by a leader it left behind.
            if !std::thread::panicking() {
                self.wait_exited();
            }
            let _ = rustix::process::waitpid(
                Some(self.child.pid()),
                rustix::process::WaitOptions::NOHANG,
            );
        }
    }

    impl Leader {
        fn start(script: &str) -> Self {
            let mut env = BTreeMap::new();
            env.insert("PATH".to_owned(), std::env::var("PATH").unwrap());
            let process = ProcessSpec {
                argv: Argv::new(vec!["sh".to_owned(), "-c".to_owned(), script.to_owned()]).unwrap(),
                cwd: NonEmpty::new("/").unwrap(),
                env: Env::new(env).unwrap(),
                generation: Generation::new(0).unwrap(),
                theme: None,
            };
            let reaper = Reaper::new().unwrap();
            let (pty, slave) = Pty::open(WindowSize::clamped(80, 24)).unwrap();
            let child = pty::spawn(slave, &process, &reaper).unwrap();
            Self {
                pty,
                _reaper: reaper,
                child,
            }
        }

        fn session(&self) -> Session {
            Session::led_by(self.child.pid()).unwrap()
        }

        /// Waits until the leader has exited, leaving it unreaped, and reads what its terminal
        /// writes meanwhile, as the holder does. This is the only way a test waits for a leader.
        /// On macOS a killed session's processes don't finish exiting while their terminal holds
        /// output nobody has read, and `sh` with job control on can write there at any moment
        /// (`sh: child setpgid (…): Operation not permitted`), so a wait that doesn't read the
        /// master can wait forever.
        fn wait_exited(&self) {
            let mut output = Vec::new();
            let give_up = Instant::now() + DEADLINE;
            while !self.exited() {
                self.read_output(&mut output);
                if Instant::now() >= give_up {
                    let state = Command::new("ps")
                        .args(["-o", "pid=,stat=,command=", "-p"])
                        .arg(self.child.pid().as_raw_pid().to_string())
                        .output()
                        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned());
                    panic!(
                        "timed out waiting until the leader has exited: {state:?}, its terminal \
                         having written {:?}",
                        String::from_utf8_lossy(&output)
                    );
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn exited(&self) -> bool {
            waitid(
                WaitId::Pid(self.child.pid()),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            )
            .unwrap()
            .is_some()
        }

        /// Reads what the terminal has written, waiting for nothing more: the master doesn't block.
        fn read_output(&self, output: &mut Vec<u8>) {
            let mut chunk = [0u8; 4096];
            loop {
                match rustix::io::read(self.pty.master(), &mut chunk) {
                    Ok(n) if n > 0 => output.extend_from_slice(chunk.get(..n).unwrap_or_default()),
                    Err(Errno::INTR) => {}
                    _ => return,
                }
            }
        }

        /// Whether the terminal has written anything not yet read.
        fn has_output(&self) -> bool {
            let mut fds = [rustix::event::PollFd::from_borrowed_fd(
                self.pty.master(),
                rustix::event::PollFlags::IN,
            )];
            let now = rustix::event::Timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            rustix::event::poll(&mut fds, Some(&now)).unwrap() > 0
        }
    }

    fn until(what: &str, mut done: impl FnMut() -> bool) {
        let give_up = Instant::now() + DEADLINE;
        while !done() {
            assert!(Instant::now() < give_up, "timed out waiting until {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The pids a sweep reached, in order.
    fn sorted(mut pids: Vec<Pid>) -> Vec<Pid> {
        pids.sort_unstable_by_key(|pid| pid.as_raw_nonzero());
        pids
    }

    /// A leader that waits for a job in a group of its own, which ignores `SIGHUP`.
    const JOB: &str = "set -m; (trap '' HUP; exec sleep 30) & wait";

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_count_finds_the_leader_and_a_job_in_a_group_of_its_own() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start(JOB);
        let job = job_pid(&leader);
        let sweep = leader.session().count();
        assert_eq!(sorted(sweep.reached), sorted(vec![leader.child.pid(), job]));
        assert!(!sweep.incomplete);
    }

    /// The one member of the session that isn't its leader, once it has started.
    fn job_pid(leader: &Leader) -> Pid {
        let mut found = None;
        until("the job has started", || {
            found = leader
                .session()
                .count()
                .reached
                .into_iter()
                .find(|pid| *pid != leader.child.pid());
            found.is_some()
        });
        found.unwrap()
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_signal_reaches_a_job_in_a_group_of_its_own_and_the_leader() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start(JOB);
        let job = job_pid(&leader);
        assert_ne!(
            rustix::process::getpgid(Some(job)).unwrap(),
            leader.child.pid()
        );
        let sweep = leader.session().signal(Signal::KILL);
        assert_eq!(sorted(sweep.reached), sorted(vec![leader.child.pid(), job]));
        leader.wait_exited();
        until("the job is gone", || leader.session().count().is_empty());
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_pass_signals_the_leader_before_its_jobs_whatever_order_it_lists_them_in() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start(&format!("trap '' HUP; {JOB}"));
        let job = job_pid(&leader);
        let sweep = leader
            .session()
            .pass_among([job, leader.child.pid()], Some(Signal::KILL));
        assert_eq!(sweep.reached, vec![leader.child.pid(), job]);
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_process_outside_the_session_is_never_signalled_though_it_is_a_candidate() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start(JOB);
        let mut stranger = Command::new("sh")
            .args(["-c", "trap 'echo hup' HUP; echo armed; read _; echo done"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(stranger.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        assert_eq!(line, "armed\n");
        let pid = Pid::from_child(&stranger);
        let sweep = leader.session().pass_among([pid], Some(Signal::HUP));
        drop(stranger.stdin.take());
        let mut rest = String::new();
        std::io::Read::read_to_string(&mut stdout, &mut rest).unwrap();
        stranger.wait().unwrap();
        assert_eq!(sweep, Sweep::default());
        assert_eq!(rest, "done\n");
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_pid_with_no_process_counts_as_nothing() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start(JOB);
        let mut gone = Command::new("true").spawn().unwrap();
        let pid = Pid::from_child(&gone);
        gone.wait().unwrap();
        let sweep = leader.session().pass_among([pid], Some(Signal::HUP));
        assert_eq!(sweep, Sweep::default());
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_leader_killed_with_its_output_unread_is_still_seen_to_exit() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start("echo unread; exec sleep 30");
        until("the leader has written", || leader.has_output());
        let sweep = leader.session().signal(Signal::KILL);
        assert_eq!(sweep.reached, vec![leader.child.pid()]);
        leader.wait_exited();
    }

    /// The drop is how most tests end their leader, so it is held to the same bound: run on a
    /// thread of its own, a drop that blocks fails here instead of hanging the test.
    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_leader_dropped_with_its_output_unread_is_ended_and_reaped() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start("echo unread; exec sleep 30");
        until("the leader has written", || leader.has_output());
        let pid = leader.child.pid();
        let (dropped, done) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            drop(leader);
            let _ = dropped.send(());
        });
        assert_eq!(
            done.recv_timeout(DEADLINE * 2),
            Ok(()),
            "the drop never returned"
        );
        let reaped = waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
        );
        assert_eq!(reaped.err(), Some(Errno::CHILD));
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn an_exited_leader_left_unreaped_is_not_counted() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start("exit 3");
        leader.wait_exited();
        assert_eq!(leader.session().count(), Sweep::default());
    }

    /// Runs this process out of file descriptors, and holds them until the result is dropped.
    /// Each test runs in a process of its own, so this touches no other test, and its own limit
    /// is lowered first, so the system's file table is never what runs out. Linux only: there a
    /// pass reads processes from /proc, which takes a descriptor; macOS asks the kernel by
    /// `proc_listpids` and `proc_pidinfo`, which take none.
    #[cfg(target_os = "linux")]
    fn out_of_descriptors() -> Vec<std::fs::File> {
        let limit = rustix::process::getrlimit(rustix::process::Resource::Nofile);
        rustix::process::setrlimit(
            rustix::process::Resource::Nofile,
            rustix::process::Rlimit {
                current: Some(64),
                maximum: limit.maximum,
            },
        )
        .unwrap();
        let mut held = Vec::new();
        loop {
            match std::fs::File::open("/dev/null") {
                Ok(file) => held.push(file),
                Err(error) if error.raw_os_error() == Some(libc::EMFILE) => return held,
                Err(error) => panic!("opening /dev/null: {error}"),
            }
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_pass_that_cant_list_the_processes_is_incomplete_not_empty() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start(JOB);
        let session = leader.session();
        let held = out_of_descriptors();
        let sweep = session.count();
        drop(held);
        assert!(sweep.incomplete, "{sweep:?}");
        assert!(!sweep.is_empty());
    }

    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_member_that_cant_be_read_makes_the_pass_incomplete_not_empty() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start(JOB);
        let session = leader.session();
        let held = out_of_descriptors();
        let sweep = session.pass_among([leader.child.pid()], None);
        drop(held);
        assert!(sweep.incomplete, "{sweep:?}");
        assert!(!sweep.is_empty());
    }

    #[test]
    fn a_member_that_refuses_the_close_is_logged_once_with_its_pid() {
        let refusing = Sweep {
            refused: vec![Pid::from_raw(NO_PROCESS).unwrap()],
            ..Sweep::default()
        };
        let now = Instant::now();
        // The hangup is two passes, SIGHUP then SIGCONT, and the pid refuses both.
        let log = crate::test_log::logged(|| {
            scripted([refusing.clone(), refusing], now).step(false, now, &mut unlisted());
        });
        assert_eq!(log.matches("another user's").count(), 1, "{log}");
        assert!(log.contains(&format!("pid={NO_PROCESS}")), "{log}");
    }

    #[test]
    fn this_system_can_sweep_a_session() {
        supported().unwrap();
    }

    /// A session's passes, stood in for: each records its signal and returns the next sweep the
    /// script gives, or an empty one once the script has run out. It signals nothing.
    #[derive(Debug, Default)]
    struct Scripted {
        sweeps: VecDeque<Sweep>,
        passes: Vec<(Option<Signal>, Sweep)>,
    }

    impl Sweeper for Scripted {
        fn sweep(&mut self, signal: Option<Signal>, _: &mut Listing) -> Sweep {
            let sweep = self.sweeps.pop_front().unwrap_or_default();
            self.passes.push((signal, sweep.clone()));
            sweep
        }
    }

    fn scripted(sweeps: impl IntoIterator<Item = Sweep>, now: Instant) -> Ending<Scripted> {
        Ending::new(
            Scripted {
                sweeps: sweeps.into_iter().collect(),
                passes: Vec::new(),
            },
            now,
        )
    }

    fn signals(ending: &Ending<Scripted>) -> Vec<Option<Signal>> {
        ending
            .sweeper
            .passes
            .iter()
            .map(|(signal, _)| *signal)
            .collect()
    }

    /// Above the largest `pid_max` the kernel allows, so no process has it: a pid the test
    /// scripts a pass to reach names nothing, should anything ever signal it.
    const NO_PROCESS: i32 = 4_194_305;

    fn reaching(pids: &[i32]) -> Sweep {
        Sweep {
            reached: pids
                .iter()
                .map(|pid| Pid::from_raw(*pid).unwrap())
                .collect(),
            ..Sweep::default()
        }
    }

    /// A step's listing, for passes that never read it.
    fn unlisted() -> Listing {
        fn never() -> io::Result<Vec<Listed>> {
            panic!("a scripted pass listed the processes")
        }
        Listing::by(never)
    }

    fn listed(pid: i32, session: Option<i32>) -> Listed {
        Listed {
            pid: Pid::from_raw(pid).unwrap(),
            session,
        }
    }

    /// The sessions of `three_sessions`' processes, one each.
    const SESSIONS: [i32; 3] = [NO_PROCESS + 10, NO_PROCESS + 11, NO_PROCESS + 12];

    /// Three processes, the first in the first of `SESSIONS` and so on, counted as one listing.
    fn three_sessions() -> Vec<Listed> {
        listings::count_one();
        SESSIONS
            .iter()
            .zip(NO_PROCESS..)
            .map(|(session, pid)| listed(pid, Some(*session)))
            .collect()
    }

    /// Passes that only ask their step's listing for their session's candidates, and signal
    /// nothing.
    #[derive(Debug)]
    struct Querying {
        session: Pid,
        found: Vec<Vec<Pid>>,
    }

    impl Sweeper for Querying {
        fn sweep(&mut self, _: Option<Signal>, listing: &mut Listing) -> Sweep {
            self.found.push(listing.candidates(self.session).unwrap());
            Sweep::default()
        }
    }

    #[test]
    fn a_step_lists_once_for_every_ending_that_makes_a_pass_and_not_at_all_for_none() {
        let now = Instant::now();
        let mut endings: Vec<Ending<Querying>> = SESSIONS
            .iter()
            .map(|session| {
                let session = Pid::from_raw(*session).unwrap();
                Ending::new(
                    Querying {
                        session,
                        found: Vec::new(),
                    },
                    now,
                )
            })
            .collect();
        let step = |endings: &mut Vec<Ending<Querying>>, at| {
            let mut listing = Listing::by(|| Ok(three_sessions()));
            for ending in endings {
                ending.step(false, at, &mut listing);
            }
        };
        step(&mut endings, now);
        assert_eq!(listings::made(), 1, "the hangups, two passes each");
        step(&mut endings, now + CLOSE_GRACE / 2);
        assert_eq!(listings::made(), 1, "a step none of them has a pass due in");
        step(&mut endings, now + CLOSE_GRACE);
        assert_eq!(listings::made(), 2, "the kills");
        for (at, ending) in endings.iter().enumerate() {
            let own = vec![Pid::from_raw(NO_PROCESS + i32::try_from(at).unwrap()).unwrap()];
            assert_eq!(ending.sweeper.found, vec![own; 3], "ending {at}");
        }
    }

    #[test]
    fn a_listing_keeps_the_sessions_processes_and_those_it_couldnt_read_in_listed_order() {
        let mut listing = Listing::by(|| {
            let session = Some(NO_PROCESS + 10);
            Ok(vec![
                listed(NO_PROCESS + 4, session),
                listed(NO_PROCESS + 1, Some(NO_PROCESS + 11)),
                listed(NO_PROCESS + 3, None),
                listed(NO_PROCESS + 2, Some(0)),
                listed(NO_PROCESS, session),
            ])
        });
        let session = Pid::from_raw(NO_PROCESS + 10).unwrap();
        let kept = listing.candidates(session).unwrap();
        let expected: Vec<Pid> = [NO_PROCESS + 4, NO_PROCESS + 3, NO_PROCESS]
            .into_iter()
            .map(|pid| Pid::from_raw(pid).unwrap())
            .collect();
        assert_eq!(kept, expected);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn a_process_whose_stat_cant_be_read_or_made_sense_of_is_listed_with_its_session_unknown() {
        let pid = Pid::from_raw(NO_PROCESS).unwrap();
        let unknown = Some(Listed { pid, session: None });
        let unreadable = io::Error::from_raw_os_error(libc::EMFILE);
        assert_eq!(os::seen(pid, Err(unreadable)), unknown);
        let no_threads = b"42 (a) S 1 42 42".as_slice();
        let bad_threads = b"42 (a) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 x 0 100".as_slice();
        for line in [no_threads, bad_threads] {
            assert_eq!(member_state(line, 42), Member::Failed);
            assert_eq!(os::seen(pid, Ok(line.to_vec())), unknown, "{line:?}");
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn a_process_gone_is_left_out_and_one_read_is_listed_in_its_session_zombie_or_not() {
        let pid = Pid::from_raw(NO_PROCESS).unwrap();
        for errno in [libc::ENOENT, libc::ESRCH] {
            assert_eq!(
                os::seen(pid, Err(io::Error::from_raw_os_error(errno))),
                None
            );
        }
        let in_42 = Some(Listed {
            pid,
            session: Some(42),
        });
        for (state, threads) in [("S", 1), ("Z", 1), ("Z", 3), ("X", 1)] {
            assert_eq!(
                os::seen(pid, Ok(stat(state, 42, threads))),
                in_42,
                "{state}"
            );
        }
    }

    #[test]
    fn a_failed_listing_is_made_again_by_the_next_pass_and_one_made_is_kept() {
        fn fails_once() -> io::Result<Vec<Listed>> {
            if listings::made() == 0 {
                listings::count_one();
                return Err(io::Error::from_raw_os_error(libc::EMFILE));
            }
            Ok(three_sessions())
        }
        let session = Pid::from_raw(SESSIONS[0]).unwrap();
        let mut listing = Listing::by(fails_once);
        assert!(listing.candidates(session).is_err());
        let own = vec![Pid::from_raw(NO_PROCESS).unwrap()];
        assert_eq!(listing.candidates(session).unwrap(), own);
        assert_eq!(listing.candidates(session).unwrap(), own);
        assert_eq!(listings::made(), 2);
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn passes_over_one_listing_each_find_their_own_session_and_no_other() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (first, second) = (Leader::start(JOB), Leader::start(JOB));
        let (first_job, second_job) = (job_pid(&first), job_pid(&second));
        let mut listing = Listing::new();
        let found = first.session().sweep(None, &mut listing);
        assert_eq!(
            sorted(found.reached),
            sorted(vec![first.child.pid(), first_job])
        );
        let found = second.session().sweep(None, &mut listing);
        assert_eq!(
            sorted(found.reached),
            sorted(vec![second.child.pid(), second_job])
        );
    }

    #[test]
    fn an_ending_kills_what_a_pass_missed_and_ends_only_after_two_empty_passes() {
        let (leader, job) = (NO_PROCESS, NO_PROCESS + 1);
        let now = Instant::now();
        let hangup = [reaching(&[leader, job]), reaching(&[leader, job])];
        // The second kill's listing was made before the job started, so it found nothing.
        let kills = [reaching(&[leader]), Sweep::default(), reaching(&[job])];
        let mut ending = scripted(hangup.into_iter().chain(kills), now);
        ending.step(false, now, &mut unlisted());
        let mut at = now + CLOSE_GRACE;
        for _ in 0..4 {
            ending.step(true, at, &mut unlisted());
            assert!(!ending.is_over());
            at = ending.deadline(true).unwrap();
        }
        ending.step(true, at, &mut unlisted());
        assert!(ending.is_over());
        let kill = Some(Signal::KILL);
        let hup = [Some(Signal::HUP), Some(Signal::CONT)];
        assert_eq!(signals(&ending), [hup.as_slice(), &[kill; 5]].concat());
    }

    #[test]
    fn an_ending_ends_without_waiting_out_the_grace_when_the_hangup_leaves_nothing() {
        let now = Instant::now();
        let mut ending = scripted([], now);
        assert_eq!(ending.deadline(false), Some(now));
        ending.step(false, now, &mut unlisted());
        let mut at = now;
        for _ in 0..2 {
            assert!(!ending.is_over());
            at = ending.deadline(true).unwrap();
            ending.step(true, at, &mut unlisted());
        }
        assert!(ending.is_over());
        assert_eq!(at, now + Duration::from_millis(100));
        assert!(at < now + GRACE);
        assert_eq!(ending.deadline(true), None);
        let hup = [Some(Signal::HUP), Some(Signal::CONT)];
        assert_eq!(signals(&ending), [hup.as_slice(), &[None, None]].concat());
    }

    /// An ending's rules as `docs/holder.md` gives them to users, rather than as the constants
    /// say: a constant that drifts from what is documented fails the property too.
    const GRACE: Duration = Duration::from_secs(2);
    const EVERY: Duration = Duration::from_millis(50);
    const EMPTY_IN_A_ROW: usize = 2;
    const KILLS: usize = 10;

    /// A pass an ending made, as the test saw it.
    #[derive(Debug, Clone)]
    struct Made {
        at: Instant,
        signal: Option<Signal>,
        sweep: Sweep,
        leader_exited: bool,
    }

    /// What an ending that started at `start` and has made `history` must be.
    struct Rules<'a> {
        start: Instant,
        history: &'a [Made],
    }

    impl Rules<'_> {
        fn kills(&self) -> usize {
            self.history
                .iter()
                .filter(|made| made.signal == Some(Signal::KILL))
                .count()
        }

        /// Counts, and kills once the leader has exited: the passes whose emptiness ends it.
        fn counted(&self) -> impl Iterator<Item = &Made> {
            self.history.iter().filter(|made| match made.signal {
                None => true,
                Some(signal) => signal == Signal::KILL && made.leader_exited,
            })
        }

        fn over(&self) -> bool {
            let last: Vec<&Made> = self.counted().collect();
            let empty_run = last
                .iter()
                .rev()
                .take_while(|made| made.sweep.reached.is_empty() && !made.sweep.incomplete)
                .count();
            self.kills() >= KILLS || empty_run >= EMPTY_IN_A_ROW
        }

        fn deadline(&self, leader_exited: bool) -> Option<Instant> {
            let grace_over = self.start + GRACE;
            match self.history.last() {
                _ if self.over() => None,
                None => Some(self.start),
                Some(last) if self.kills() > 0 => Some(last.at + EVERY),
                Some(last) if leader_exited => Some((last.at + EVERY).min(grace_over)),
                Some(_) => Some(grace_over),
            }
        }

        /// The signals of the passes a step at `now` makes, in order.
        fn step(&self, leader_exited: bool, now: Instant) -> Vec<Option<Signal>> {
            match self.deadline(leader_exited) {
                Some(at) if now >= at => {}
                _ => return Vec::new(),
            }
            if self.history.is_empty() {
                vec![Some(Signal::HUP), Some(Signal::CONT)]
            } else if self.kills() == 0 && now < self.start + GRACE {
                vec![None]
            } else {
                vec![Some(Signal::KILL)]
            }
        }
    }

    /// When a step is made, against the deadline the ending gave.
    #[derive(Debug, Clone, Copy)]
    enum When {
        AtTheDeadline,
        Before(Duration),
        After(Duration),
    }

    fn sweeps() -> impl Strategy<Value = Sweep> {
        let pids = |most: usize| {
            proptest::collection::vec(NO_PROCESS..NO_PROCESS + 1000, 0..=most).prop_map(|pids| {
                pids.into_iter()
                    .map(|pid| Pid::from_raw(pid).unwrap())
                    .collect()
            })
        };
        (
            prop_oneof![3 => Just(Vec::new()), 1 => pids(3)],
            pids(2),
            proptest::bool::weighted(0.15),
        )
            .prop_map(|(reached, refused, incomplete)| Sweep {
                reached,
                refused,
                incomplete,
            })
    }

    fn whens() -> impl Strategy<Value = When> {
        prop_oneof![
            4 => Just(When::AtTheDeadline),
            2 => (1u64..50_000_000).prop_map(|ns| When::Before(Duration::from_nanos(ns))),
            2 => (0u64..120).prop_map(|ms| When::After(Duration::from_millis(ms))),
            1 => (0u64..3_000).prop_map(|ms| When::After(Duration::from_millis(ms))),
        ]
    }

    proptest! {
        /// Whatever each pass finds, whenever the ending is stepped, and whenever the leader
        /// exits, the ending hangs up first, then counts or kills on time, and is over exactly
        /// when two counted passes in a row find nothing or ten kills have been sent.
        #[test]
        fn an_ending_follows_its_rules_whatever_the_passes_find_and_whenever_it_is_stepped(
            script in proptest::collection::vec(sweeps(), 0..40),
            exits_at in proptest::option::weighted(0.75, 0usize..15),
            steps in proptest::collection::vec(whens(), 1..80),
        ) {
            let start = Instant::now();
            let mut ending = scripted(script, start);
            let mut history: Vec<Made> = Vec::new();
            let mut now = start;
            for (index, when) in steps.into_iter().enumerate() {
                let exited = exits_at.is_some_and(|at| index >= at);
                let rules = Rules { start, history: &history };
                let due = ending.deadline(exited);
                prop_assert_eq!(due, rules.deadline(exited), "step {}", index);
                now = match (due, when) {
                    (None, _) => now + Duration::from_millis(1),
                    (Some(at), When::AtTheDeadline) => at,
                    (Some(at), When::Before(by)) => at.checked_sub(by).unwrap(),
                    (Some(at), When::After(by)) => at + by,
                }
                .max(now);
                let expected = rules.step(exited, now);
                let before = ending.sweeper.passes.len();
                ending.step(exited, now, &mut unlisted());
                let made = &ending.sweeper.passes[before..];
                let signals: Vec<Option<Signal>> = made.iter().map(|(signal, _)| *signal).collect();
                prop_assert_eq!(signals, expected, "step {}", index);
                history.extend(made.iter().map(|(signal, sweep)| Made {
                    at: now,
                    signal: *signal,
                    sweep: sweep.clone(),
                    leader_exited: exited,
                }));
                let rules = Rules { start, history: &history };
                prop_assert_eq!(ending.is_over(), rules.over(), "step {}", index);
            }
        }
    }

    /// A `/proc/<pid>/stat` line, whose name holds `) Z 9 9 9`, as a program can name itself.
    fn stat(state: &str, session: i32, threads: u32) -> Vec<u8> {
        format!(
            "42 (a) Z 9 9 9) {state} 1 42 {session} 0 -1 0 0 0 0 0 0 0 0 0 20 0 {threads} 0 100\n"
        )
        .into_bytes()
    }

    #[test]
    fn a_live_process_of_the_session_is_a_member_and_one_of_another_session_is_not() {
        assert_eq!(member_state(&stat("S", 42, 1), 42), Member::Reached);
        assert_eq!(member_state(&stat("R", 42, 1), 9), Member::Outside);
    }

    #[test]
    fn a_zombie_or_a_dead_process_is_not_a_member() {
        for (state, threads) in [("Z", 1), ("Z", 0), ("X", 1), ("X", 4)] {
            assert_eq!(
                member_state(&stat(state, 42, threads), 42),
                Member::Outside,
                "{state} with {threads} threads"
            );
        }
    }

    #[test]
    fn a_process_whose_first_thread_has_exited_while_others_run_is_a_member() {
        assert_eq!(member_state(&stat("Z", 42, 3), 42), Member::Reached);
    }

    #[test]
    fn a_send_the_guard_refuses_fails_the_pass_rather_than_count_as_outside() {
        let pid = Pid::from_raw(42).unwrap();
        let refused = SendError::Refused(Refused::NotOne(0));
        assert_eq!(Member::of_send(pid, Err(refused)), Member::Failed);
    }

    #[test]
    fn a_pid_gone_or_given_to_a_thread_before_it_was_held_is_outside() {
        let pid = Pid::from_raw(42).unwrap();
        for errno in [Errno::SRCH, Errno::INVAL] {
            assert_eq!(
                Member::of_send(pid, Err(SendError::Os(errno))),
                Member::Outside
            );
        }
        let other = SendError::Os(Errno::PERM);
        assert_eq!(Member::of_send(pid, Err(other)), Member::Refused);
    }

    #[test]
    fn a_line_that_cant_be_read_fails_the_pass() {
        for line in [b"".as_slice(), b"42 (a) S 1 42", b"42 (a) S 1 42 x"] {
            assert_eq!(member_state(line, 42), Member::Failed);
        }
    }
}
