//! A terminal's session: every process in it found and signalled, and none outside it.
//!
//! A session's id is its leader's pid, so while the holder hasn't reaped the leader no new
//! session can be given that number, and a process whose session is that id is the terminal's.
//! A pass lists every process and keeps those whose session is that id; the guard then holds each
//! one and checks it again before it signals (`guard::signal_member`), so a pid that ends and is
//! given to another process between the listing and the signal is never signalled.

use std::collections::HashSet;
use std::io;
use std::time::{Duration, Instant};

use rustix::io::Errno;
use rustix::process::{Pid, Signal};

use crate::child::CLOSE_GRACE;
use crate::guard::{self, Refused, SendError};

/// How often an ending looks at its session once the leader has exited, and sends `SIGKILL` again
/// once the grace is over: each look is one listing of every process.
pub const SWEEP_EVERY: Duration = Duration::from_millis(50);
/// How many `SIGKILL` passes an ending makes before it gives up on what is left.
pub const KILL_SWEEPS: u32 = 10;
/// How many empty passes in a row end a session. One isn't enough: a pass lists every process
/// first, so a member's child started after the listing is missed if the member then exits.
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
        self.pass(Some(signal))
    }

    /// Finds every live process in the session, and signals none.
    pub fn count(self) -> Sweep {
        self.pass(None)
    }

    fn pass(self, signal: Option<Signal>) -> Sweep {
        self.pass_listed(os::pids(), signal)
    }

    /// One pass over `listing`, every process's pid as some moment found them, or why they
    /// couldn't be listed.
    fn pass_listed(self, listing: io::Result<Vec<Pid>>, signal: Option<Signal>) -> Sweep {
        match listing {
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
pub struct Ending<L: Listing = Processes> {
    session: Session,
    listing: L,
    hung_up: bool,
    kill_at: Instant,
    next_pass: Instant,
    kills_left: u32,
    empty_in_a_row: u32,
    /// Members that have refused a signal, each logged once.
    refused: HashSet<Pid>,
    over: bool,
}

/// Where an ending lists the processes it looks among.
pub trait Listing {
    /// Every process's pid.
    ///
    /// # Errors
    ///
    /// When the processes can't be listed.
    fn pids(&mut self) -> io::Result<Vec<Pid>>;
}

/// The system's processes, as they are at each listing.
#[derive(Debug, Default, Clone, Copy)]
pub struct Processes;

impl Listing for Processes {
    fn pids(&mut self) -> io::Result<Vec<Pid>> {
        os::pids()
    }
}

impl Ending {
    /// An ending whose first step, due at once, hangs the session up.
    pub fn start(session: Session, now: Instant) -> Self {
        Self::new(session, now, Processes)
    }
}

impl<L: Listing> Ending<L> {
    /// `start`, listing the processes by `listing`, which only a test, to stand in for a listing
    /// that raced a process's start, gives as anything but `Processes`.
    fn new(session: Session, now: Instant, listing: L) -> Self {
        Self {
            session,
            listing,
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

    /// Makes the pass that is due, if one is.
    pub fn step(&mut self, leader_exited: bool, now: Instant) {
        if self.deadline(leader_exited).is_none_or(|at| now < at) {
            return;
        }
        self.next_pass = now + SWEEP_EVERY;
        if !self.hung_up {
            // A stopped process acts on `SIGHUP` only once continued.
            for signal in [Signal::HUP, Signal::CONT] {
                let sweep = self.pass(Some(signal));
                self.note_refused(&sweep);
            }
            self.hung_up = true;
            return;
        }
        if !self.killing() && now < self.kill_at {
            let sweep = self.pass(None);
            self.count_empty(&sweep);
            return;
        }
        let sweep = self.pass(Some(Signal::KILL));
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

    fn pass(&mut self, signal: Option<Signal>) -> Sweep {
        self.session.pass_listed(self.listing.pids(), signal)
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

    use super::{Member, member_state};

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
        let own = stat
            .split(|&b| b == b' ')
            .next()
            .and_then(|field| std::str::from_utf8(field).ok())
            .and_then(|field| field.parse::<i32>().ok());
        if own == Some(getpid().as_raw_pid()) {
            Ok(())
        } else {
            Err(io::Error::other(
                "/proc is another PID namespace's, so the holder can't find a terminal's \
                 processes by it: mount a /proc of this namespace",
            ))
        }
    }

    pub(super) fn pids() -> io::Result<Vec<Pid>> {
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
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(Errno::SRCH.raw_os_error()) =>
            {
                return Member::Outside;
            }
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

    use super::Member;

    pub(super) fn pids() -> io::Result<Vec<Pid>> {
        crate::macos::pids()
    }

    pub(super) fn visit(pid: Pid, session: Pid, signal: Option<Signal>) -> Member {
        crate::macos::visit(pid, session, signal)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::{BufRead as _, BufReader};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use bazhen_holder_proto::body::{Argv, Env, Generation, NonEmpty, ProcessSpec};
    use rustix::process::{WaitId, WaitIdOptions, waitid};

    use super::*;
    use crate::child::{ChildProcess, Reaper};
    use crate::pty::{self, Pty, WindowSize};

    const DEADLINE: Duration = Duration::from_secs(5);

    /// A child leading a session on a PTY of its own, killed with its group and reaped when the
    /// test ends.
    struct Leader {
        _pty: Pty,
        _reaper: Reaper,
        child: ChildProcess,
    }

    impl Drop for Leader {
        fn drop(&mut self) {
            if let Ok(session) = Session::led_by(self.child.pid()) {
                let _ = session.signal(Signal::KILL);
            }
            let _ = rustix::process::waitpid(
                Some(self.child.pid()),
                rustix::process::WaitOptions::empty(),
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
                _pty: pty,
                _reaper: reaper,
                child,
            }
        }

        fn session(&self) -> Session {
            Session::led_by(self.child.pid()).unwrap()
        }

        fn exited(&self) -> bool {
            waitid(
                WaitId::Pid(self.child.pid()),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            )
            .is_ok_and(|status| status.is_some())
        }

        /// Waits until the leader has exited, leaving it unreaped.
        fn wait_exited(&self) {
            waitid(
                WaitId::Pid(self.child.pid()),
                WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
            )
            .unwrap();
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
    fn an_exited_leader_left_unreaped_is_not_counted() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start("exit 3");
        leader.wait_exited();
        assert_eq!(leader.session().count(), Sweep::default());
    }

    #[test]
    fn this_system_can_sweep_a_session() {
        supported().unwrap();
    }

    /// Each listing in turn, `None` for the system's own, then the system's: a listing made
    /// before a process started misses it, as one does when a member starts a job after a pass
    /// has listed the processes.
    #[derive(Debug)]
    struct Stale(std::collections::VecDeque<Option<Vec<Pid>>>);

    impl Listing for Stale {
        fn pids(&mut self) -> io::Result<Vec<Pid>> {
            match self.0.pop_front().flatten() {
                Some(pids) => Ok(pids),
                None => Processes.pids(),
            }
        }
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn an_ending_kills_what_a_pass_missed_and_ends_only_after_two_empty_passes() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start(&format!("trap '' HUP; {JOB}"));
        let job = job_pid(&leader);
        let alone = Some(vec![leader.child.pid()]);
        let listings = [None, None, alone, Some(vec![])];
        let past = Instant::now().checked_sub(CLOSE_GRACE).unwrap();
        let mut ending = Ending::new(leader.session(), past, Stale(listings.into()));
        let give_up = Instant::now() + DEADLINE;
        while !ending.is_over() {
            assert!(Instant::now() < give_up, "the ending never ended");
            if ending
                .deadline(leader.exited())
                .is_some_and(|at| at > Instant::now())
            {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let exited = leader.exited();
            ending.step(exited, Instant::now());
            if !exited && ending.killing() {
                leader.wait_exited();
            }
        }
        assert!(
            rustix::process::test_kill_process(job).is_err(),
            "the job a pass missed outlived the ending"
        );
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn an_ending_ends_without_waiting_out_the_grace_when_the_hangup_leaves_nothing() {
        bazhen_test_signal::require_sandbox().unwrap();
        let leader = Leader::start("sleep 30");
        let now = Instant::now();
        let mut ending = Ending::start(leader.session(), now);
        assert_eq!(ending.deadline(false), Some(now));
        ending.step(false, now);
        until("the leader has exited", || leader.exited());
        let mut at = now;
        for _ in 0..EMPTY_PASSES {
            assert!(!ending.is_over());
            at = ending.deadline(true).unwrap();
            ending.step(true, at);
        }
        assert!(ending.is_over());
        assert_eq!(at, now + SWEEP_EVERY * EMPTY_PASSES);
        assert!(at < now + CLOSE_GRACE);
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
