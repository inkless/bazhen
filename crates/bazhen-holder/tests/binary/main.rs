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
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _};
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rustix::process::{Pid, Resource, Rlimit, Signal, getrlimit, getsid, kill_process, setrlimit};

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

fn start_time(pid: u32) -> Option<String> {
    ps("lstart=", pid)
}

fn own_start() -> &'static str {
    static START: OnceLock<String> = OnceLock::new();
    START.get_or_init(|| start_time(std::process::id()).unwrap_or_default())
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

/// Kills the holders of test processes that died before their guards ran, and forgets them.
fn sweep() -> Result<()> {
    for entry in std::fs::read_dir(ledger()?)? {
        let path = entry?.path();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        let (Some(pid), [holder_start, owner, owner_start]) = (
            path.file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.parse::<u32>().ok()),
            lines.as_slice(),
        ) else {
            continue;
        };
        let owner_alive = owner
            .parse::<u32>()
            .ok()
            .and_then(start_time)
            .is_some_and(|start| start == *owner_start);
        if owner_alive {
            continue;
        }
        let ours = start_time(pid).is_some_and(|start| start == *holder_start)
            && ps("comm=", pid).is_some_and(|comm| comm.ends_with("bazhen-holder"));
        if ours && let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) {
            let _ = kill_process(pid, Signal::KILL);
        }
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// A holder this test started, killed when the test ends if it is still the same process.
struct Started {
    pid: u32,
    start: String,
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
        } else if !self.reaped
            && start_time(self.pid).is_some_and(|start| start == self.start)
            && ps("comm=", self.pid).is_some_and(|comm| comm.ends_with("bazhen-holder"))
            && let Ok(pid) = self.pid()
        {
            // `exit` timed out, and its thread still waits for the holder.
            let _ = kill_process(pid, Signal::KILL);
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
    std::fs::write(
        &entry,
        format!("{start}\n{}\n{}\n", std::process::id(), own_start()),
    )?;
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

/// Fails when `needed` more PTYs would take the machine near its limit, as the TypeScript
/// suites' setup does (`ptysInUse` in tests/support/global-setup.ts).
fn require_ptys(needed: u64) -> Result<()> {
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
    if used + needed > cutoff {
        return Err(format!("{used} PTYs in use, and {needed} more would pass {cutoff}").into());
    }
    Ok(())
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
        let mut holder = spawn(&bytes, &Start::default()).unwrap();
        assert_eq!(holder.first_line().unwrap(), "ready\n", "holder {n}");
        holders.push(holder);
    }
}
