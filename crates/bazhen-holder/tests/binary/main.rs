//! The `bazhen-holder` binary, run as a spawner would run it: the spec on stdin, `ready` or an
//! exit code back.
//!
//! A holder here ends only by a signal, in a session of its own, so nothing the test runner does
//! reaches it. Each one therefore:
//! - starts through `sh -c 'ulimit -t 2 && exec "$0" "$@"'`, so a holder that spins dies of
//!   `SIGXCPU` within 2 CPU-seconds, and `exec` keeps its pid; a flood's holder gets 10, since
//!   on macOS it moves its output in many small reads;
//! - runs a child that ends by itself;
//! - is recorded in a ledger with its start time and its owning test process's, killed by a guard
//!   when its test ends, and swept by a later test if its owner died first, whichever target
//!   directory either ran from. A sweep kills nothing unless its start time and command still
//!   match the entry, so a reused pid is left alone.

use std::collections::BTreeMap;
use std::error::Error;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rustix::process::{Pid, Resource, Rlimit, Signal, getrlimit, getsid, setrlimit};

mod socket;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const HOLDER: &str = env!("CARGO_BIN_EXE_bazhen-holder");
const DEADLINE: Duration = Duration::from_secs(5);

fn ps(field: &str, pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", field, "-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?.trim().to_owned();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// How far two readings of one process's start may lie apart: host-guard's `START_SKEW_S`, since
/// the TypeScript harness writes this ledger too, from `ps`.
const START_SKEW_S: u64 = 2;

/// When `pid` started, in epoch seconds. Read for pids no test holds too, so every use compares
/// it with a start recorded when the pid was known to be the one meant.
fn start_time(pid: u32) -> Option<u64> {
    let pid = Pid::from_raw(i32::try_from(pid).ok()?)?;
    bazhen_holder::start_time::of(pid).ok().map(u64::from)
}

fn same_start(a: u64, b: u64) -> bool {
    a.abs_diff(b) <= START_SKEW_S
}

/// This process's start, which every entry it writes names it by. One it can't read refuses
/// the write: an owner of unknown start would read as dead to every sweep, its holders killed in
/// use.
fn own_start() -> Result<u64> {
    static START: OnceLock<Option<u64>> = OnceLock::new();
    START
        .get_or_init(|| start_time(std::process::id()))
        .ok_or_else(|| "can't read when this test process started".into())
}

/// Whether `comm`, as `ps -o comm=` gives it, names the holder: on macOS it is a whole path.
fn is_holder(comm: &str) -> bool {
    Path::new(comm)
        .file_name()
        .is_some_and(|name| name == "bazhen-holder")
}

/// Where the TypeScript and the Rust holder tests put their homes, and so their sockets.
const TEST_HOMES: [&str; 2] = ["/tmp/bz-h-", "/tmp/bz-hb-"];

/// Whether `socket` is a test holder's, so its holder is one a sweep may kill.
fn in_test_home(socket: &str) -> bool {
    TEST_HOMES.iter().any(|home| socket.starts_with(home)) && !socket.contains("/../")
}

/// What `ps` says of an entry's owner, for the sweep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Owner {
    Started(u64),
    Absent,
    Unreadable,
}

fn owner_of(pid: u32) -> Owner {
    let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) else {
        return Owner::Unreadable;
    };
    match bazhen_holder::start_time::of(pid) {
        Ok(start) => Owner::Started(start.get()),
        Err(bazhen_holder::start_time::StartTimeError::Absent(_)) => Owner::Absent,
        Err(_) => Owner::Unreadable,
    }
}

/// Whether an entry's owner is provably gone: no process, or another one at its pid. One `ps`
/// can't read may live.
fn owner_gone(entry: &Entry, owner: Owner) -> bool {
    match owner {
        Owner::Absent => true,
        Owner::Started(start) => !same_start(start, entry.owner_start),
        Owner::Unreadable => false,
    }
}

/// One ledger entry: a file named by the holder's pid, holding the holder's start, its owner's
/// pid and its owner's start, each in epoch seconds on a line of its own.
/// `tests/support/holder-ledger.ts` reads and writes the same, and
/// `tests/support/fixtures/holder-ledger-entry` pins the format for both.
#[derive(Debug, PartialEq, Eq)]
struct Entry {
    holder: u32,
    holder_start: u64,
    owner: u32,
    owner_start: u64,
    socket: String,
}

impl Entry {
    fn parse(name: &str, text: &str) -> Option<Self> {
        let lines: Vec<&str> = text.strip_suffix('\n')?.split('\n').collect();
        let [holder_start, owner, owner_start, socket] = lines.as_slice() else {
            return None;
        };
        let digits = |text: &str| text.bytes().all(|b| b.is_ascii_digit()).then_some(());
        digits(name)?;
        digits(holder_start)?;
        digits(owner)?;
        digits(owner_start)?;
        Some(Self {
            holder: name.parse().ok()?,
            holder_start: holder_start.parse().ok()?,
            owner: owner.parse().ok()?,
            owner_start: owner_start.parse().ok()?,
            socket: Some(*socket).filter(|s| !s.is_empty())?.to_owned(),
        })
    }

    fn text(&self) -> String {
        format!(
            "{}\n{}\n{}\n{}\n",
            self.holder_start, self.owner, self.owner_start, self.socket
        )
    }
}

/// One ledger per user, whatever target directory the tests were built in, so a holder that a
/// falsify run left is swept by the next plain run too. It must be the user's own and private.
fn ledger() -> Result<PathBuf> {
    let uid = rustix::process::getuid().as_raw();
    let base = std::env::var_os("XDG_RUNTIME_DIR").map_or_else(std::env::temp_dir, PathBuf::from);
    let dir = base.join(format!("bazhen-test-holders-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let meta = std::fs::symlink_metadata(&dir)?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err(format!("{} isn't a private directory of this user's", dir.display()).into());
    }
    Ok(dir)
}

/// How old a ledger file that isn't an entry must be before the sweep removes it.
const STALE: Duration = Duration::from_hours(24);

/// Kills the holders of test processes that died before their guards ran, and forgets them.
fn sweep() -> Result<()> {
    for entry in std::fs::read_dir(ledger()?)? {
        let path = entry?.path();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let Some(entry) = Entry::parse(name, &text) else {
            // Half of one can't be read, as entries are renamed into place: this is something
            // else, removed once surely abandoned, as the TypeScript sweep does.
            let age = std::fs::symlink_metadata(&path)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok());
            if age.is_some_and(|age| age > STALE) {
                let _ = std::fs::remove_file(path);
            }
            continue;
        };
        if !owner_gone(&entry, owner_of(entry.owner)) {
            continue;
        }
        let pid = entry.holder;
        if in_test_home(&entry.socket) {
            kill_holder(pid, entry.holder_start)?;
        }
        // A holder started since, at the same pid, has an entry of its own here.
        if std::fs::read_to_string(&path).is_ok_and(|now| now == text) {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// Kills the holder at `pid` if it is still the one that started at `start`, checked once the
/// process is pinned, so a pid reused since is left alone. A holder already gone is fine; a
/// refused target is a fault in the ledger or the test, so it is an error, never skipped.
fn kill_holder(pid: u32, start: u64) -> std::result::Result<(), bazhen_test_signal::Refused> {
    let ours = || {
        start_time(pid).is_some_and(|now| same_start(now, start))
            && ps("comm=", pid).is_some_and(|comm| is_holder(&comm))
    };
    match bazhen_test_signal::signal_if(pid, Signal::KILL, ours) {
        Ok(_) | Err(bazhen_test_signal::Refused::Failed(_, rustix::io::Errno::SRCH)) => Ok(()),
        Err(refused) => Err(refused),
    }
}

/// A holder this test started, killed when the test ends if it is still the same process.
struct Started {
    pid: u32,
    start: u64,
    entry: PathBuf,
    child: Option<Child>,
    /// `exit` has waited for the holder, so its pid may already be another process's.
    reaped: bool,
}

impl Started {
    /// How the holder stands: still running, or how it ended, a signal such as `SIGXCPU`
    /// included, for a test whose connection the holder dropped to say why.
    fn state(&mut self) -> String {
        match self.child.as_mut().map(Child::try_wait) {
            Some(Ok(None)) => "still runs".to_owned(),
            Some(Ok(Some(status))) => format!("ended: {status}"),
            Some(Err(error)) => format!("can't say: {error}"),
            None => "was already waited for".to_owned(),
        }
    }

    /// `state()` once the holder has ended, or after `within` if it hasn't: a holder that closed
    /// its stdout may still be on its way out.
    fn end(&mut self, within: Duration) -> String {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline
            && self
                .child
                .as_mut()
                .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        self.state()
    }

    fn pid(&self) -> Result<Pid> {
        Pid::from_raw(i32::try_from(self.pid)?).ok_or_else(|| "not a pid".into())
    }

    /// The first line the holder writes to stdout, or "" if it closes stdout first.
    fn first_line(&mut self) -> Result<String> {
        let stdout = self
            .child
            .as_mut()
            .and_then(|c| c.stdout.take())
            .ok_or("no stdout")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(line);
        });
        Ok(rx.recv_timeout(DEADLINE)?)
    }

    /// Waits for the holder to exit, with its exit code and what it wrote to stderr.
    fn exit(&mut self) -> Result<(Option<i32>, String)> {
        let mut child = self.child.take().ok_or("already waited for")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            let _ = tx.send(child.wait().map(|status| (status.code(), stderr)));
        });
        let exited = rx.recv_timeout(DEADLINE)??;
        self.reaped = true;
        Ok(exited)
    }
}

impl Drop for Started {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Not yet reaped, so the pid is still this holder's.
            let _ = child.kill();
            let _ = child.wait();
        } else if !self.reaped {
            // `exit` timed out, and its thread still waits for the holder.
            let ended = kill_holder(self.pid, self.start);
            assert!(
                ended.is_ok() || std::thread::panicking(),
                "couldn't end holder {}: {ended:?}",
                self.pid
            );
        }
        let _ = std::fs::remove_file(&self.entry);
    }
}

#[derive(Default)]
struct Start<'a> {
    /// Shell run before the holder starts, whose state it inherits.
    prelude: &'a str,
    /// Starts the holder as the leader of a process group of its own, but not of a session.
    own_group: bool,
    /// Starts the holder with `SIGCHLD` and `SIGUSR1` blocked, as a careless spawner could. A
    /// shell can't block a signal, so this goes through `python3`, which execs the shell.
    blocked_signals: bool,
    stderr: bool,
    /// CPU-seconds the holder may use before `SIGXCPU` ends it, 2 if none: enough for any test
    /// but a flood, which moves its output in many small reads on macOS, in a debug build.
    cpu_seconds: Option<u32>,
}

fn spawn(spec: &[u8], how: &Start<'_>) -> Result<Started> {
    let cpu = how.cpu_seconds.unwrap_or(2);
    let script = format!("{} ulimit -t {cpu} && exec \"$0\" \"$@\"", how.prelude);
    let mut command = if how.blocked_signals {
        let block = "import os, signal, sys; \
            signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD, signal.SIGUSR1}); \
            os.execvp('sh', ['sh', '-c'] + sys.argv[1:])";
        let mut python = Command::new("python3");
        python.args(["-c", block]);
        python
    } else {
        let mut sh = Command::new("sh");
        sh.arg("-c");
        sh
    };
    command
        .args([&script, HOLDER])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if how.stderr {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    if how.own_group {
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    let start = start_time(pid).ok_or("the holder is already gone")?;
    let entry = ledger()?.join(pid.to_string());
    let socket = serde_json::from_slice::<serde_json::Value>(spec)
        .ok()
        .and_then(|spec| spec.get("socket")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "(no socket)".to_owned());
    let text = Entry {
        holder: pid,
        holder_start: start,
        owner: std::process::id(),
        owner_start: own_start()?,
        socket,
    }
    .text();
    // Whole or not at all, so no sweep reads half of it.
    let partial = entry.with_extension("partial");
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&partial)?
        .write_all(text.as_bytes())?;
    std::fs::rename(&partial, &entry)?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let started = Started {
        pid,
        start,
        entry,
        child: Some(child),
        reaped: false,
    };
    // A holder that refused the spec early may have closed stdin already.
    let _ = stdin.write_all(spec);
    drop(stdin);
    Ok(started)
}

/// The socket's directory, which must be private to the user and short enough for a socket path
/// on macOS (103 bytes), so under `/tmp` rather than the target directory. Removed when dropped,
/// after the holders the test started, which are declared after it.
struct Home(PathBuf);

impl std::ops::Deref for Home {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn home(name: &str) -> Result<Home> {
    let dir = PathBuf::from(format!("/tmp/bz-hb-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    Ok(Home(dir))
}

fn spec(home: &Path, argv: &[&str], change: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
    let mut env = BTreeMap::new();
    env.insert("PATH", std::env::var("PATH").unwrap_or_default());
    let mut spec = serde_json::json!({
        "protocol": ["1.0"],
        "terminalId": "t1",
        "socket": home.join("t1.sock"),
        "tags": {},
        "size": {"cols": 80, "rows": 24},
        "argv": argv,
        "cwd": "/",
        "env": env,
        "generation": 0,
    });
    change(&mut spec);
    serde_json::to_vec(&spec).unwrap_or_default()
}

fn wait_for_file(path: &Path, done: impl Fn(&str) -> bool) -> Result<String> {
    let deadline = Instant::now() + DEADLINE;
    loop {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        if done(&text) {
            return Ok(text);
        }
        if Instant::now() >= deadline {
            return Err(format!("{} never got there: {text:?}", path.display()).into());
        }
        // A file another process writes has nothing to wait on; this checks it every 20 ms.
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The PTYs in use, and how many the tests may take the machine to, as the TypeScript suites'
/// setup counts them (`ptysInUse` in tests/support/global-setup.ts).
fn ptys() -> Result<(u64, u64)> {
    let read = |name: &str| -> Option<u64> {
        std::fs::read_to_string(format!("/proc/sys/kernel/pty/{name}"))
            .ok()?
            .trim()
            .parse()
            .ok()
    };
    let (used, cutoff) = if let (Some(used), Some(max)) = (read("nr"), read("max")) {
        (used, max * 420 / 511)
    } else {
        let used = std::fs::read_dir("/dev")?
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("ttys"))
            .count();
        (u64::try_from(used)?, 420)
    };
    let cutoff = match std::env::var("BZ_PTY_CUTOFF") {
        Ok(raw) if !raw.is_empty() => raw.parse()?,
        _ => cutoff,
    };
    Ok((used, cutoff))
}

/// Fails when `needed` more PTYs would take the machine past the cutoff `ptys` gives.
fn require_ptys(needed: u64) -> Result<()> {
    let (used, cutoff) = ptys()?;
    if used + needed > cutoff {
        return Err(format!("{used} PTYs in use, and {needed} more would pass {cutoff}").into());
    }
    Ok(())
}

/// This user's processes, the PTYs in use and this process's fds, with the limits each meets,
/// for a test that starts many holders to say which one it ran into.
fn machine() -> String {
    let uid = rustix::process::getuid().as_raw().to_string();
    let processes = Command::new("ps")
        .args(["-U", &uid, "-o", "pid="])
        .output()
        .map_or_else(
            |e| format!("unknown ({e})"),
            |out| {
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .count()
                    .to_string()
            },
        );
    let ptys = ptys().map_or_else(
        |e| format!("unknown ({e})"),
        |(used, cutoff)| format!("{used} (the tests' cutoff {cutoff})"),
    );
    let fds = std::fs::read_dir("/dev/fd").map_or_else(
        |e| format!("unknown ({e})"),
        |listing| listing.count().to_string(),
    );
    let names: &[&str] = if cfg!(target_os = "macos") {
        &["kern.maxproc", "kern.maxprocperuid", "kern.tty.ptmx_max"]
    } else {
        &["kernel.pid_max", "kernel.threads-max", "kernel.pty.max"]
    };
    let sysctl = Command::new("sysctl").args(names).output().map_or_else(
        |e| format!("unknown ({e})"),
        |out| {
            let text = String::from_utf8_lossy(&out.stdout) + String::from_utf8_lossy(&out.stderr);
            text.trim().replace('\n', ", ")
        },
    );
    let limit = |resource| {
        let Rlimit { current, maximum } = getrlimit(resource);
        format!("{current:?} of {maximum:?}")
    };
    format!(
        "this user's processes: {processes}, nproc {}; PTYs in use: {ptys}; this process's fds: \
         {fds}, nofile {}; {sysctl}",
        limit(Resource::Nproc),
        limit(Resource::Nofile),
    )
}

#[test]
fn refuses_a_spec_that_isnt_one_with_exit_2() {
    sweep().unwrap();
    let how = Start {
        stderr: true,
        ..Start::default()
    };
    let mut holder = spawn(b"{}", &how).unwrap();
    let (code, stderr) = holder.exit().unwrap();
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("invalid spawn spec"), "{stderr}");
}

#[test]
fn refuses_a_nul_in_argv_with_exit_2() {
    sweep().unwrap();
    let home = home("nul").unwrap();
    let how = Start {
        stderr: true,
        ..Start::default()
    };
    let mut holder = spawn(&spec(&home, &["sh", "-c", "a\0b"], |_| {}), &how).unwrap();
    let (code, stderr) = holder.exit().unwrap();
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("NUL"), "{stderr}");
}

#[test]
fn refuses_a_daemon_it_shares_no_major_with_with_exit_3() {
    sweep().unwrap();
    let home = home("major").unwrap();
    let bytes = spec(&home, &["true"], |s| {
        s["protocol"] = serde_json::json!(["99.0"]);
    });
    let how = Start {
        stderr: true,
        ..Start::default()
    };
    let mut holder = spawn(&bytes, &how).unwrap();
    let (code, stderr) = holder.exit().unwrap();
    assert_eq!(code, Some(3), "{stderr}");
}

#[test]
fn refuses_to_start_as_a_group_leader_outside_its_own_session_with_exit_4() {
    sweep().unwrap();
    let home = home("group").unwrap();
    let how = Start {
        own_group: true,
        stderr: true,
        ..Start::default()
    };
    let mut holder = spawn(&spec(&home, &["true"], |_| {}), &how).unwrap();
    let (code, stderr) = holder.exit().unwrap();
    assert_eq!(code, Some(4), "{stderr}");
    assert!(stderr.contains("session leader"), "{stderr}");
}

#[test]
fn a_program_that_cant_start_exits_1_before_ready() {
    sweep().unwrap();
    let home = home("missing").unwrap();
    let how = Start {
        stderr: true,
        ..Start::default()
    };
    let mut holder = spawn(&spec(&home, &["/nonexistent/program"], |_| {}), &how).unwrap();
    assert_eq!(holder.first_line().unwrap(), "");
    let (code, stderr) = holder.exit().unwrap();
    assert_eq!(code, Some(1), "{stderr}");
    assert!(stderr.contains("could not start the child"), "{stderr}");
}

#[test]
fn says_ready_and_leads_a_session_of_its_own() {
    sweep().unwrap();
    let home = home("ready").unwrap();
    let mut holder = spawn(&spec(&home, &["sleep", "30"], |_| {}), &Start::default()).unwrap();
    assert_eq!(holder.first_line().unwrap(), "ready\n");
    let pid = holder.pid().unwrap();
    assert_eq!(getsid(Some(pid)).unwrap(), pid);
    let log = wait_for_file(&home.join("t1.log"), |t| t.contains("holder started")).unwrap();
    assert!(log.contains("program=\"sleep\""), "{log}");
    assert!(
        !log.contains("PATH"),
        "the log holds the environment: {log}"
    );
}

#[test]
fn logs_the_exit_of_a_child_that_exits_at_once() {
    sweep().unwrap();
    let home = home("at-once").unwrap();
    let mut holder = spawn(&spec(&home, &["true"], |_| {}), &Start::default()).unwrap();
    assert_eq!(holder.first_line().unwrap(), "ready\n");
    wait_for_file(&home.join("t1.log"), |t| {
        t.contains("child exited status=exited 0")
    })
    .unwrap();
}

#[test]
fn an_fd_leaked_into_the_holder_does_not_reach_the_child() {
    sweep().unwrap();
    let home = home("leak").unwrap();
    let report = home.join("fd7");
    let script = r#"if [ -e /dev/fd/7 ] || [ -h /dev/fd/7 ]; then echo open; else echo closed; fi > "$0"; exec sleep 30"#;
    let bytes = spec(
        &home,
        &["sh", "-c", script, report.to_str().unwrap_or_default()],
        |_| {},
    );
    let how = Start {
        prelude: "exec 7</dev/null;",
        ..Start::default()
    };
    let mut holder = spawn(&bytes, &how).unwrap();
    assert_eq!(holder.first_line().unwrap(), "ready\n");
    let seen = wait_for_file(&report, |t| t.ends_with('\n')).unwrap();
    assert_eq!(seen, "closed\n");
}

#[test]
fn the_child_starts_with_default_signals_whatever_the_holder_ignored() {
    sweep().unwrap();
    let home = home("signals").unwrap();
    let report = home.join("signals");
    let script = r#"for s in INT HUP TERM USR1; do sh -c "kill -s $s \$\$"; echo "$s=$?"; done > "$0"
        exec sleep 30"#;
    let bytes = spec(
        &home,
        &["sh", "-c", script, report.to_str().unwrap_or_default()],
        |_| {},
    );
    let how = Start {
        prelude: "trap '' INT HUP TERM USR1;",
        ..Start::default()
    };
    let mut holder = spawn(&bytes, &how).unwrap();
    assert_eq!(holder.first_line().unwrap(), "ready\n");
    let seen = wait_for_file(&report, |t| t.lines().count() == 4).unwrap();
    for line in seen.lines() {
        assert!(
            !line.ends_with("=0"),
            "{line} survived its own signal: {seen}"
        );
    }
}

#[test]
fn a_hundred_holders_start_from_a_spawner_whose_soft_nofile_is_256() {
    sweep().unwrap();
    require_ptys(100).unwrap();
    let limit = getrlimit(Resource::Nofile);
    setrlimit(
        Resource::Nofile,
        Rlimit {
            current: Some(256),
            maximum: limit.maximum,
        },
    )
    .unwrap();
    let home = home("hundred").unwrap();
    let mut holders = Vec::new();
    for n in 0..100 {
        let bytes = spec(&home, &["sleep", "30"], |s| {
            s["terminalId"] = format!("t{n}").into();
            s["socket"] = home.join(format!("t{n}.sock")).to_string_lossy().into();
        });
        // A file rather than a pipe, so the spawner holds no fd for each holder it keeps.
        let stderr = home.join(format!("t{n}.err"));
        let prelude = format!("exec 2>'{}';", stderr.display());
        let how = Start {
            prelude: &prelude,
            ..Start::default()
        };
        let mut holder = spawn(&bytes, &how).unwrap();
        let line = holder.first_line();
        assert!(
            line.as_ref().is_ok_and(|line| line == "ready\n"),
            "holder {n} said {line:?}, not ready, and {}; its stderr: {:?}; its log: {:?}; {}",
            holder.end(DEADLINE),
            std::fs::read_to_string(&stderr).unwrap_or_default(),
            std::fs::read_to_string(home.join(format!("t{n}.log"))).unwrap_or_default(),
            machine(),
        );
        holders.push(holder);
    }
}

/// The TypeScript harness reads and writes this ledger too: both hold to one checked-in entry.
#[test]
fn reads_and_writes_the_ledger_entry_the_typescript_harness_does() {
    let fixture = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/support/fixtures/holder-ledger-entry"
    );
    let text = std::fs::read_to_string(fixture).unwrap();
    let entry = Entry::parse("4242", &text).unwrap();
    assert_eq!(
        entry,
        Entry {
            holder: 4242,
            holder_start: 1_794_630_000,
            owner: 4243,
            owner_start: 1_794_629_990,
            socket: "/tmp/bz-h-abc/run/holders/t1.sock".to_owned(),
        }
    );
    assert_eq!(entry.text(), text);
    let unended = text.strip_suffix('\n').unwrap();
    for bad in [unended, "1794630000\n4243\n1794629990\n"] {
        assert_eq!(Entry::parse("4242", bad), None, "{bad:?}");
    }
}

/// An owner `ps` can't read may live: its holders are spared, never killed in use.
#[test]
fn a_sweep_counts_an_owner_gone_only_when_it_provably_is() {
    let fixture = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/support/fixtures/holder-ledger-entry"
    );
    let entry = Entry::parse("4242", &std::fs::read_to_string(fixture).unwrap()).unwrap();
    assert!(owner_gone(&entry, Owner::Absent));
    assert!(owner_gone(&entry, Owner::Started(entry.owner_start + 60)));
    assert!(!owner_gone(&entry, Owner::Started(entry.owner_start + 2)));
    assert!(!owner_gone(&entry, Owner::Unreadable));
    assert!(in_test_home(&entry.socket));
    assert!(!in_test_home("/home/u/.bazhen/run/holders/t1.sock"));
    assert!(is_holder("/x/bazhen-holder") && is_holder("bazhen-holder"));
    assert!(!is_holder("bazhen-holderx") && !is_holder("/x/notbazhen-holder"));
}
