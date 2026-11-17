//! The holder's child on real PTYs: its session and terminal, its fds and signals, how its exit
//! is seen, and how a close ends it. Every wait has a deadline. A guard kills the group of any
//! child a test leaves running; a job a test starts on purpose in a group of its own ends by
//! itself within 30 s.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::io::ErrorKind;
use std::os::fd::{AsRawFd as _, BorrowedFd, OwnedFd, RawFd};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use bazhen_holder::child::{CLOSE_GRACE, ChildProcess, Reaper};
use bazhen_holder::pty::{self, Pty, WindowSize};
use bazhen_holder::session::SWEEP_EVERY;
use bazhen_holder_proto::body::{
    Argv, Cols, Env, ExitStatus, Generation, NonEmpty, ProcessSpec, Rows, Size,
};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::process::{Pid, Signal, WaitOptions, getpgid, getsid, test_kill_process, waitpid};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const DEADLINE: Duration = Duration::from_secs(5);
const OUTPUT_CAP: usize = 64 << 10;

struct Running {
    pty: Pty,
    reaper: Reaper,
    child: ChildProcess,
    output: Vec<u8>,
    master_open: bool,
    _ended: EndsChild,
}

/// Kills the child's group and reaps it if the test ends with the child still running. A child
/// already reaped is left alone, since its pid may by then be another process's. It reads the
/// terminal while it waits, through a master of its own, since on macOS a killed process doesn't
/// finish exiting while its terminal holds output nobody has read; and it waits at most
/// `DEADLINE`, so a child that never exits fails the test instead of hanging it.
struct EndsChild {
    pid: Pid,
    master: OwnedFd,
}

impl Drop for EndsChild {
    fn drop(&mut self) {
        if let Ok(None) = waitpid(Some(self.pid), WaitOptions::NOHANG) {
            let _ = bazhen_test_signal::signal_group(self.pid.as_raw_nonzero().get(), Signal::KILL);
            let deadline = Instant::now() + DEADLINE;
            let mut chunk = [0u8; 4096];
            while let Ok(None) = waitpid(Some(self.pid), WaitOptions::NOHANG) {
                if Instant::now() >= deadline {
                    // A test that failed is reported by its own failure, not by a child it left.
                    assert!(std::thread::panicking(), "the killed child never exited");
                    return;
                }
                // The master doesn't block, so this reads only what is already there.
                while matches!(rustix::io::read(&self.master, &mut chunk), Ok(n) if n > 0) {}
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

fn process(argv: &[&str]) -> Result<ProcessSpec> {
    let mut env = BTreeMap::new();
    env.insert("PATH".to_owned(), std::env::var("PATH")?);
    Ok(ProcessSpec {
        argv: Argv::new(argv.iter().map(|&a| a.to_owned()).collect())?,
        cwd: NonEmpty::new("/")?,
        env: Env::new(env)?,
        generation: Generation::new(0)?,
        theme: None,
    })
}

fn start(argv: &[&str]) -> Result<Running> {
    let reaper = Reaper::new()?;
    let (pty, slave) = Pty::open(WindowSize::clamped(80, 24))?;
    let child = pty::spawn(slave, &process(argv)?, &reaper)?;
    let ended = EndsChild {
        pid: child.pid(),
        master: pty.master().try_clone_to_owned()?,
    };
    Ok(Running {
        pty,
        reaper,
        child,
        output: Vec::new(),
        master_open: true,
        _ended: ended,
    })
}

/// Reads what the master has, keeping at most `OUTPUT_CAP` bytes of it.
fn read_master(running: &mut Running) {
    let mut chunk = [0u8; 4096];
    loop {
        match rustix::io::read(running.pty.master(), &mut chunk) {
            Ok(0) => {
                running.master_open = false;
                return;
            }
            Ok(n) => {
                let room = OUTPUT_CAP.saturating_sub(running.output.len());
                running.output.extend(chunk.iter().take(n.min(room)));
            }
            Err(rustix::io::Errno::INTR) => {}
            Err(rustix::io::Errno::AGAIN) => return,
            Err(_) => {
                running.master_open = false;
                return;
            }
        }
    }
}

/// Waits for the reaper or the master, reading the master, for at most `timeout`.
fn wait_once(running: &mut Running, timeout: Duration) -> Result<()> {
    let timeout = Timespec::try_from(timeout)?;
    let master: BorrowedFd<'_> = running.pty.master();
    let wakeups = running.reaper.fd();
    let mut fds = vec![PollFd::new(&wakeups, PollFlags::IN)];
    if running.master_open {
        fds.push(PollFd::new(&master, PollFlags::IN));
    }
    match poll(&mut fds, Some(&timeout)) {
        Ok(_) | Err(rustix::io::Errno::INTR) => {}
        Err(e) => return Err(e.into()),
    }
    drop(fds);
    read_master(running);
    Ok(())
}

/// Waits until the child's exit is seen, checking only when `SIGCHLD` has woken the reaper, so an exit
/// the reaper misses times out rather than being found by a later poll.
fn wait_exit(running: &mut Running) -> Result<ExitStatus> {
    let deadline = Instant::now() + DEADLINE;
    loop {
        let readable = {
            let wakeups = running.reaper.fd();
            let mut fds = [PollFd::new(&wakeups, PollFlags::IN)];
            match poll(&mut fds, Some(&Timespec::try_from(Duration::ZERO)?)) {
                Ok(n) => n > 0,
                Err(rustix::io::Errno::INTR) => false,
                Err(e) => return Err(e.into()),
            }
        };
        if readable {
            running.reaper.clear();
            if let Some(status) = running.child.poll_exit() {
                let status = status.clone();
                read_master(running);
                return Ok(status);
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("the child's exit was never seen".into());
        }
        wait_once(running, left.min(Duration::from_millis(100)))?;
    }
}

/// Waits until `done` holds, for at most `DEADLINE`, reading the master meanwhile.
fn wait_for(running: &mut Running, mut done: impl FnMut(&Running) -> bool) -> Result<()> {
    let deadline = Instant::now() + DEADLINE;
    while !done(running) {
        if Instant::now() >= deadline {
            return Err("timed out".into());
        }
        wait_once(running, Duration::from_millis(20))?;
    }
    Ok(())
}

/// A file a child writes its report to, removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn path(&self) -> &Path {
        &self.0
    }

    fn arg(&self) -> &str {
        self.0.to_str().unwrap_or_default()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn scratch(name: &str) -> Result<Scratch> {
    let path = std::env::temp_dir().join(format!("bz-holder-{}-{name}", std::process::id()));
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(Scratch(path))
}

fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn pid_in(path: &Path) -> Result<Pid> {
    let raw: i32 = read_text(path).trim().parse()?;
    Pid::from_raw(raw).ok_or_else(|| "not a pid".into())
}

fn exited(code: i64) -> Result<ExitStatus> {
    Ok(ExitStatus::Exited {
        code: bazhen_holder_proto::body::ExitCode::new(code)?,
    })
}

fn signalled(name: &str) -> ExitStatus {
    ExitStatus::Signalled {
        signal: name.to_owned(),
    }
}

/// The fds this process has open, from `/dev/fd`, less the one the listing itself holds while it
/// runs: the lowest fd free, which a file opened and closed just before shows.
fn own_fds() -> Result<BTreeSet<RawFd>> {
    let listing = std::fs::File::open("/dev/null")?.as_raw_fd();
    let mut fds = BTreeSet::new();
    for entry in std::fs::read_dir("/dev/fd")? {
        if let Ok(fd) = entry?.file_name().to_string_lossy().parse::<RawFd>() {
            fds.insert(fd);
        }
    }
    fds.remove(&listing);
    Ok(fds)
}

/// The fds `pid` has open: from `/proc` where there is one, from `lsof` where there isn't (macOS).
fn fds_of(pid: Pid) -> Result<BTreeSet<RawFd>> {
    let proc = PathBuf::from(format!("/proc/{}/fd", pid.as_raw_nonzero()));
    let mut fds = BTreeSet::new();
    if proc.is_dir() {
        for entry in std::fs::read_dir(proc)? {
            fds.insert(entry?.file_name().to_string_lossy().parse::<RawFd>()?);
        }
        return Ok(fds);
    }
    let listing = Command::new("lsof")
        .args([
            "-a",
            "-p",
            &pid.as_raw_nonzero().to_string(),
            "-d",
            "0-65535",
            "-F",
            "f",
        ])
        .output()?;
    for line in String::from_utf8(listing.stdout)?.lines() {
        if let Some(fd) = line.strip_prefix('f').and_then(|n| n.parse::<RawFd>().ok()) {
            fds.insert(fd);
        }
    }
    Ok(fds)
}

/// Kills a grandchild a test left on purpose, if it is still in the child's group: a pid that has
/// left the group may already be another process's.
fn kill_grandchild(grandchild: Pid, child: Pid) {
    if getpgid(Some(grandchild)).is_ok_and(|group| group == child) {
        let _ = bazhen_test_signal::signal(grandchild.as_raw_nonzero().get(), Signal::KILL);
    }
}

/// Waits, for at most `DEADLINE`, until `pid` has died: gone, or a zombie its new parent hasn't
/// reaped yet, which happens where PID 1 is slow to reap or never does.
fn wait_gone(pid: Pid) -> Result<()> {
    let deadline = Instant::now() + DEADLINE;
    let zombie = || {
        Command::new("ps")
            .args(["-o", "state=", "-p", &pid.as_raw_nonzero().to_string()])
            .output()
            .is_ok_and(|out| out.stdout.starts_with(b"Z"))
    };
    while test_kill_process(pid).is_ok() && !zombie() {
        if Instant::now() >= deadline {
            return Err(format!("{} still exists", pid.as_raw_nonzero()).into());
        }
        // Not our child, so nothing to wait on: init reaps it once it dies.
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

/// Starts a grandchild that ignores `SIGHUP` and writes its own pid to the file named by `$0` once
/// it does, so a test that reads the pid knows the grandchild can no longer be hung up.
const HUP_IGNORING_GRANDCHILD: &str =
    r#"(trap '' HUP; exec sh -c 'echo $$ > "$1"; exec sleep 30' sh "$0") &"#;

/// Prints which of signals 1–31 the process running it has blocked, as `blocked=2,15`.
const BLOCKED_PROBE: &str = r#"my $old = POSIX::SigSet->new;
sigprocmask(SIG_BLOCK, POSIX::SigSet->new, $old) or die "sigprocmask: $!";
print "blocked=", join(",", grep { $old->ismember($_) } 1..31), "\n";"#;

/// Blocks `SIGINT` and `SIGTERM`, then execs its arguments, which inherit the mask.
const BLOCK_THEN_EXEC: &str = r#"sigprocmask(SIG_BLOCK, POSIX::SigSet->new(SIGINT, SIGTERM))
    or die "sigprocmask: $!";
exec { $ARGV[0] } @ARGV or die "exec: $!";"#;

const BLOCKED_RUN: &str = "BZ_HOLDER_TEST_BLOCKED_RUN";

#[test]
fn the_child_leads_a_session_whose_controlling_terminal_is_the_pty() {
    let mut running = start(&["sh", "-c", ": </dev/tty; echo tty=$?; read _"]).unwrap();
    let pid = running.child.pid();
    assert_eq!(getsid(Some(pid)).unwrap(), pid);
    assert_eq!(getpgid(Some(pid)).unwrap(), pid);
    wait_for(&mut running, |r| r.output.windows(5).any(|w| w == b"tty=0")).unwrap();
    assert_eq!(running.pty.foreground_group(), Some(pid));
    rustix::io::write(running.pty.master(), b"\n").unwrap();
    assert_eq!(wait_exit(&mut running).unwrap(), exited(0).unwrap());
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn the_child_gets_no_fd_the_holder_opened() {
    bazhen_test_signal::require_sandbox().unwrap();
    let before = own_fds().unwrap();
    let mut running = start(&["sh", "-c", "echo started; read _"]).unwrap();
    let opened: BTreeSet<_> = own_fds().unwrap().difference(&before).copied().collect();
    assert!(!opened.is_empty(), "the PTY and the reaper opened fds");
    // Only once the child has started: until then the dynamic loader holds fds of its own.
    wait_for(&mut running, |r| {
        r.output.windows(7).any(|w| w == b"started")
    })
    .unwrap();
    let child = fds_of(running.child.pid()).unwrap();
    assert!(child.is_superset(&BTreeSet::from([0, 1, 2])), "{child:?}");
    assert!(
        child.is_disjoint(&opened),
        "the child has {child:?} of {opened:?}"
    );
    assert!(
        child.iter().all(|fd| *fd <= 2 || before.contains(fd)),
        "the child has fds this process doesn't: {child:?}"
    );
    close_now(&mut running).unwrap();
    assert_eq!(wait_exit(&mut running).unwrap(), signalled("SIGHUP"));
}

#[test]
fn a_child_that_exits_at_once_is_still_seen_to_exit() {
    let mut running = start(&["true"]).unwrap();
    assert_eq!(wait_exit(&mut running).unwrap(), exited(0).unwrap());
}

/// Longer than macOS lets a session leader's exit wait for the master to read what it wrote, about
/// 600 ms, before it discards that output and lets the exit go ahead.
const UNREAD_FOR: Duration = Duration::from_millis(1500);

/// How long `read_to_end` waits for more output before it takes what it has as all there is.
const QUIET: Duration = Duration::from_millis(500);

/// Waits until `deadline` without reading the master, looking for the child's exit, and says
/// whether it was seen.
fn exit_seen_unread(running: &mut Running, deadline: Instant) -> Result<bool> {
    loop {
        if running.child.poll_exit().is_some() || running.child.exit().is_some() {
            return Ok(true);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(false);
        }
        let wakeups = running.reaper.fd();
        let mut fds = [PollFd::new(&wakeups, PollFlags::IN)];
        match poll(
            &mut fds,
            Some(&Timespec::try_from(left.min(Duration::from_millis(50)))?),
        ) {
            Ok(_) | Err(rustix::io::Errno::INTR) => {}
            Err(e) => return Err(e.into()),
        }
        running.reaper.clear();
    }
}

/// Reads the master until its output ends, or until it has been quiet for `QUIET`.
fn read_to_end(running: &mut Running) -> Result<()> {
    let deadline = Instant::now() + DEADLINE;
    loop {
        read_master(running);
        if !running.master_open || Instant::now() >= deadline {
            return Ok(());
        }
        let master: BorrowedFd<'_> = running.pty.master();
        let mut fds = [PollFd::new(&master, PollFlags::IN)];
        match poll(&mut fds, Some(&Timespec::try_from(QUIET)?)) {
            Ok(0) => return Ok(()),
            Ok(_) | Err(rustix::io::Errno::INTR) => {}
            Err(e) => return Err(e.into()),
        }
    }
}

#[test]
fn output_a_child_wrote_survives_until_the_master_is_read() {
    let mut running = start(&["printf", "abc"]).unwrap();
    exit_seen_unread(&mut running, Instant::now() + UNREAD_FOR).unwrap();
    read_to_end(&mut running).unwrap();
    let seen = exit_seen_unread(&mut running, Instant::now() + DEADLINE).unwrap();
    assert_eq!(String::from_utf8_lossy(&running.output), "abc");
    assert!(seen, "the exit was never seen");
    assert_eq!(running.child.exit(), Some(&exited(0).unwrap()));
}

#[test]
fn the_exit_is_seen_while_a_grandchild_still_holds_the_terminal() {
    let file = scratch("grandchild").unwrap();
    let script =
        format!(r#"{HUP_IGNORING_GRANDCHILD} while [ ! -s "$0" ]; do sleep 0.05; done; exit 3"#);
    let mut running = start(&["sh", "-c", &script, file.arg()]).unwrap();
    assert_eq!(wait_exit(&mut running).unwrap(), exited(3).unwrap());
    let grandchild = pid_in(file.path()).unwrap();
    let alive = test_kill_process(grandchild);
    kill_grandchild(grandchild, running.child.pid());
    alive.unwrap();
}

#[test]
fn an_exit_status_is_exact() {
    for (script, status) in [
        ("exit 7", exited(7).unwrap()),
        ("kill -s TERM $$", signalled("SIGTERM")),
        ("kill -s KILL $$", signalled("SIGKILL")),
    ] {
        let mut running = start(&["sh", "-c", script]).unwrap();
        assert_eq!(wait_exit(&mut running).unwrap(), status, "{script}");
    }
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_close_hangs_up_the_foreground_group_as_well_as_the_childs() {
    bazhen_test_signal::require_sandbox().unwrap();
    let script = "trap : HUP; set -m; sleep 30; exit 4";
    let mut running = start(&["sh", "-c", script]).unwrap();
    let pid = running.child.pid();
    wait_for(&mut running, |r| {
        r.pty.foreground_group().is_some_and(|group| group != pid)
    })
    .unwrap();
    close_now(&mut running).unwrap();
    assert_eq!(wait_exit(&mut running).unwrap(), exited(4).unwrap());
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_close_continues_a_stopped_child_so_it_acts_on_the_hangup() {
    bazhen_test_signal::require_sandbox().unwrap();
    let mut running = start(&["sh", "-c", "kill -s STOP $$; exit 5"]).unwrap();
    let pid = running.child.pid().as_raw_nonzero().to_string();
    wait_for(&mut running, |_| {
        Command::new("ps")
            .args(["-o", "state=", "-p", &pid])
            .output()
            .is_ok_and(|out| out.stdout.starts_with(b"T"))
    })
    .unwrap();
    close_now(&mut running).unwrap();
    assert_eq!(wait_exit(&mut running).unwrap(), signalled("SIGHUP"));
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_close_kills_a_child_that_ignores_the_hangup_once_the_grace_is_over() {
    bazhen_test_signal::require_sandbox().unwrap();
    let file = scratch("ignores-hup").unwrap();
    let script = r#"trap '' HUP; echo armed > "$0"; exec sleep 30"#;
    let mut running = start(&["sh", "-c", script, file.arg()]).unwrap();
    wait_for(&mut running, |_| read_text(file.path()) == "armed\n").unwrap();
    let now = Instant::now();
    running.child.close(now);
    assert_eq!(running.child.close_deadline(), Some(now));
    running.child.close_step(now);
    assert_eq!(running.child.close_deadline(), Some(now + CLOSE_GRACE));
    running.child.close_step(now + CLOSE_GRACE / 2);
    assert_eq!(running.child.close_deadline(), Some(now + CLOSE_GRACE));
    running.child.close_step(now + CLOSE_GRACE);
    assert_eq!(
        running.child.close_deadline(),
        Some(now + CLOSE_GRACE + SWEEP_EVERY)
    );
    assert_eq!(wait_exit(&mut running).unwrap(), signalled("SIGKILL"));
}

#[test]
fn dropping_the_handles_in_an_unwind_signals_nothing() {
    let file = scratch("unwind").unwrap();
    let script = r#"trap 'echo hup >> "$0"' HUP; trap 'echo usr1 >> "$0"' USR1
        echo armed >> "$0"; i=0; while [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done"#;
    let mut running = start(&["sh", "-c", script, file.arg()]).unwrap();
    wait_for(&mut running, |_| read_text(file.path()) == "armed\n").unwrap();
    let Running {
        pty,
        reaper,
        child,
        _ended,
        ..
    } = running;
    let pid = child.pid();
    let unwound = catch_unwind(AssertUnwindSafe(move || {
        let _held = (reaper, child);
        panic!("unwinding through the handles");
    }));
    assert!(unwound.is_err());
    bazhen_test_signal::signal(pid.as_raw_nonzero().get(), Signal::USR1).unwrap();
    let deadline = Instant::now() + DEADLINE;
    while !read_text(file.path()).contains("usr1") && Instant::now() < deadline {
        let master = pty.master();
        let mut fds = [PollFd::new(&master, PollFlags::empty())];
        // A wait of 20 ms; an EINTR only ends it early.
        let _ = poll(
            &mut fds,
            Some(&Timespec::try_from(Duration::from_millis(20)).unwrap()),
        );
    }
    assert_eq!(read_text(file.path()), "armed\nusr1\n");
    drop(pty);
}

#[test]
fn fifty_spawns_leave_no_fd_behind() {
    let before = own_fds().unwrap();
    for _ in 0..50 {
        let mut running = start(&["true"]).unwrap();
        assert_eq!(wait_exit(&mut running).unwrap(), exited(0).unwrap());
    }
    assert_eq!(own_fds().unwrap(), before);
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_close_kills_the_childs_whole_group_once_the_grace_is_over() {
    bazhen_test_signal::require_sandbox().unwrap();
    let file = scratch("group").unwrap();
    let script = format!("trap '' HUP; {HUP_IGNORING_GRANDCHILD} wait");
    let mut running = start(&["sh", "-c", &script, file.arg()]).unwrap();
    wait_for(&mut running, |_| read_text(file.path()).ends_with('\n')).unwrap();
    let grandchild = pid_in(file.path()).unwrap();
    let now = Instant::now();
    running.child.close(now);
    running.child.close_step(now);
    running.child.close_step(now + CLOSE_GRACE);
    assert_eq!(wait_exit(&mut running).unwrap(), signalled("SIGKILL"));
    let gone = wait_gone(grandchild);
    kill_grandchild(grandchild, running.child.pid());
    gone.unwrap();
}

/// The holder may be started with signals blocked, and exec keeps a mask. This test runs itself
/// again under `perl`, which blocks `SIGINT` and `SIGTERM` before it execs the test, so the run
/// inside spawns the child with them blocked.
#[test]
fn the_child_starts_with_no_signal_blocked_whatever_the_holder_blocked() {
    let name = "the_child_starts_with_no_signal_blocked_whatever_the_holder_blocked";
    if std::env::var_os(BLOCKED_RUN).is_some() {
        let here = Command::new("perl")
            .args(["-MPOSIX", "-e", BLOCKED_PROBE])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&here.stdout), "blocked=2,15\n");
        let mut running = start(&["perl", "-MPOSIX", "-e", BLOCKED_PROBE]).unwrap();
        assert_eq!(wait_exit(&mut running).unwrap(), exited(0).unwrap());
        assert_eq!(String::from_utf8_lossy(&running.output), "blocked=\r\n");
        return;
    }
    let test = std::env::current_exe().unwrap();
    let run = Command::new("perl")
        .args(["-MPOSIX", "-e", BLOCK_THEN_EXEC])
        .arg(&test)
        .args(["--exact", name, "--nocapture"])
        .env(BLOCKED_RUN, "1")
        .output()
        .unwrap();
    let out = format!(
        "{}{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    assert!(run.status.success(), "{out}");
    assert!(
        out.contains("1 passed"),
        "the run inside didn't run the test: {out}"
    );
}

#[test]
fn a_pty_is_never_sized_zero() {
    let zero = WindowSize::clamped(0, 0);
    assert_eq!((zero.cols(), zero.rows()), (1, 1));
    let size = |cols, rows| Size {
        cols: Cols::new(cols).unwrap(),
        rows: Rows::new(rows).unwrap(),
    };
    let from = WindowSize::from(size(0, 0));
    assert_eq!((from.cols(), from.rows()), (1, 1));
    let largest = WindowSize::from(size(1000, 1000));
    assert_eq!((largest.cols(), largest.rows()), (1000, 1000));
    let (pty, _slave) = Pty::open(zero).unwrap();
    let opened = rustix::termios::tcgetwinsize(pty.master()).unwrap();
    assert_eq!((opened.ws_col, opened.ws_row), (1, 1));
}

/// Starts closing the child and makes the close's first pass, its hangup.
fn close_now(running: &mut Running) -> Result<()> {
    bazhen_test_signal::require_sandbox()?;
    let now = Instant::now();
    running.child.close(now);
    running.child.close_step(now);
    Ok(())
}

/// Closes the child and drives the close as the holder's loop does, until the child and its whole
/// session have ended.
fn close_until_ended(running: &mut Running) -> Result<()> {
    bazhen_test_signal::require_sandbox()?;
    running.child.close(Instant::now());
    let deadline = Instant::now() + DEADLINE;
    while !running.child.ended() {
        if Instant::now() >= deadline {
            return Err("the close never ended".into());
        }
        running.child.poll_exit();
        running.child.close_step(Instant::now());
        wait_once(running, Duration::from_millis(20))?;
    }
    Ok(())
}

/// The pids written to `path`, one a line.
fn pids_in(path: &Path) -> Result<Vec<Pid>> {
    read_text(path)
        .lines()
        .map(|line| {
            let raw: i32 = line.trim().parse()?;
            Pid::from_raw(raw).ok_or_else(|| "not a pid".into())
        })
        .collect()
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_close_ends_background_jobs_in_groups_of_their_own_a_nohup_one_included() {
    bazhen_test_signal::require_sandbox().unwrap();
    let file = scratch("jobs").unwrap();
    let script = r#"set -m; sleep 30 & echo $! >> "$0"
        nohup sleep 30 > /dev/null 2>&1 & echo $! >> "$0"; wait"#;
    let mut running = start(&["sh", "-c", script, file.arg()]).unwrap();
    wait_for(&mut running, |_| {
        read_text(file.path()).lines().count() == 2
    })
    .unwrap();
    let jobs = pids_in(file.path()).unwrap();
    for job in &jobs {
        assert_eq!(getpgid(Some(*job)).unwrap(), *job);
    }
    close_until_ended(&mut running).unwrap();
    for job in jobs {
        wait_gone(job).unwrap();
    }
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_background_job_that_traps_the_hangup_is_sent_it() {
    bazhen_test_signal::require_sandbox().unwrap();
    let file = scratch("trapping-job").unwrap();
    let script = r#"set -m
        (trap 'echo hup >> "$0"; exit 0' HUP; echo armed >> "$0"
         i=0; while [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done) &
        wait"#;
    let mut running = start(&["sh", "-c", script, file.arg()]).unwrap();
    wait_for(&mut running, |_| read_text(file.path()) == "armed\n").unwrap();
    close_until_ended(&mut running).unwrap();
    assert_eq!(read_text(file.path()), "armed\nhup\n");
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_close_after_the_child_exited_ends_what_it_left_running() {
    bazhen_test_signal::require_sandbox().unwrap();
    let file = scratch("straggler").unwrap();
    let script = format!("set -m; {HUP_IGNORING_GRANDCHILD} exit 0");
    let mut running = start(&["sh", "-c", &script, file.arg()]).unwrap();
    wait_for(&mut running, |_| read_text(file.path()).ends_with('\n')).unwrap();
    let straggler = pid_in(file.path()).unwrap();
    assert_eq!(wait_exit(&mut running).unwrap(), exited(0).unwrap());
    assert!(test_kill_process(straggler).is_ok());
    close_until_ended(&mut running).unwrap();
    wait_gone(straggler).unwrap();
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn closing_an_exited_child_with_nothing_left_ends_without_waiting_out_the_grace() {
    bazhen_test_signal::require_sandbox().unwrap();
    let mut running = start(&["true"]).unwrap();
    assert_eq!(wait_exit(&mut running).unwrap(), exited(0).unwrap());
    let now = Instant::now();
    running.child.close(now);
    let mut at = now;
    while let Some(next) = running.child.close_deadline() {
        at = next;
        running.child.close_step(at);
    }
    assert!(running.child.ended());
    assert!(at < now + CLOSE_GRACE, "{:?}", at - now);
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn an_exited_child_is_left_unreaped_until_its_session_has_ended() {
    bazhen_test_signal::require_sandbox().unwrap();
    let file = scratch("pinned").unwrap();
    let script = format!("set -m; {HUP_IGNORING_GRANDCHILD} exit 0");
    let mut running = start(&["sh", "-c", &script, file.arg()]).unwrap();
    wait_for(&mut running, |_| read_text(file.path()).ends_with('\n')).unwrap();
    let straggler = pid_in(file.path()).unwrap();
    assert_eq!(wait_exit(&mut running).unwrap(), exited(0).unwrap());
    let pid = running.child.pid();
    let unreaped = || {
        rustix::process::waitid(
            rustix::process::WaitId::Pid(pid),
            rustix::process::WaitIdOptions::EXITED
                | rustix::process::WaitIdOptions::NOHANG
                | rustix::process::WaitIdOptions::NOWAIT,
        )
        .is_ok_and(|status| status.is_some())
    };
    assert!(unreaped());
    close_until_ended(&mut running).unwrap();
    assert!(!unreaped());
    wait_gone(straggler).unwrap();
}
