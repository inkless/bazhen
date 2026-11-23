//! The daemon as a process, stopped by a signal as `main.ts` is: SIGTERM or SIGINT ends it with 0
//! and says which, and one heard while it drains ends it at once.

use std::fmt::Write as _;
use std::io::{Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use bazhen_test_signal::Signal;

/// Longer than any start or exit takes, short of the test's own timeout.
const BOUND: Duration = Duration::from_secs(10);

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// A home of the test's own, removed when this drops.
struct Home(PathBuf);

impl Home {
    fn new(name: &str) -> Res<Self> {
        let dir = std::env::temp_dir().join(format!("bz-daemon-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }

    fn socket(&self) -> PathBuf {
        self.0.join("run/bazhen.sock")
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The daemon, copied under `home` as `moon run :build` lays it out, with the holder the
/// workspace's tests build beside it: a daemon whose default runtime is the holder refuses to
/// start with no holder build, as `main.ts` does, and cargo builds none at `release-holder`.
/// The holder is the one cargo built beside this daemon, in the same profile's directory.
fn daemon_binary(home: &Home) -> Res<PathBuf> {
    let holder = Path::new(env!("CARGO_BIN_EXE_bazhen-daemon")).with_file_name("bazhen-holder");
    if !holder.is_file() {
        return Err(format!(
            "no {}: run the workspace's tests, which build it",
            holder.display()
        )
        .into());
    }
    let build = home.0.join("target");
    std::fs::create_dir_all(build.join("release"))?;
    std::fs::create_dir_all(build.join("release-holder"))?;
    let daemon = build.join("release/bazhen-daemon");
    std::fs::copy(env!("CARGO_BIN_EXE_bazhen-daemon"), &daemon)?;
    std::fs::copy(holder, build.join("release-holder/bazhen-holder"))?;
    Ok(daemon)
}

/// The daemon on `home`, in the foreground with its output piped, once its socket answers.
fn daemon(home: &Home) -> Res<Child> {
    daemon_by(home, Command::new(daemon_binary(home)?))
}

/// `daemon`, run by `command`, which execs it.
fn daemon_by(home: &Home, mut command: Command) -> Res<Child> {
    let port = std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port();
    let mut child = command
        .env_clear()
        .env("HOME", &home.0)
        .env("BAZHEN_HOME", &home.0)
        .env("BAZHEN_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let started = Instant::now();
    while UnixStream::connect(home.socket()).is_err() {
        if child.try_wait()?.is_some() {
            return Err(format!("the daemon exited: {:?}", child.wait_with_output()?).into());
        }
        if started.elapsed() > BOUND {
            let doing = doing(child.id(), home);
            let ended = ended_within_bound(child);
            // A killed daemon can't remove its socket, and the start removes any socket left
            // before it binds, so one there now was bound since the bound passed: slow, not stuck.
            let late = home.socket().exists();
            return Err(format!(
                "the daemon never answered on its socket within {BOUND:?}\n{doing}\n\
                 bound its socket by the time it ended: {late}\nended: {ended:?}"
            )
            .into());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Ok(child)
}

/// The child's exit code and what it said on stderr, once it ends; `None` for the code if it
/// hadn't by the bound, when it is killed, with what it had said by then.
fn ended_within_bound(mut child: Child) -> Res<(Option<i32>, String)> {
    let stderr = drained(child.stderr.take());
    let stdout = drained(child.stdout.take());
    let ended = bazhen_test_signal::end_within(&mut child, BOUND)?;
    stdout.join().map_err(|_| "the stdout reader panicked")?;
    let said = stderr.join().map_err(|_| "the stderr reader panicked")?;
    Ok((
        ended.and_then(|status| status.code()),
        String::from_utf8_lossy(&said).into_owned(),
    ))
}

/// Everything `pipe` gives until it closes, read on a thread of its own so that a child writing
/// to it is never stopped by a full pipe.
fn drained(pipe: Option<impl std::io::Read + Send + 'static>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    })
}

/// What the test can read of its own child `pid` while it runs, without signalling it, and every
/// file under `home` but the builds copied there: where a start that never answered had got to.
fn doing(pid: u32, home: &Home) -> String {
    let mut files = String::new();
    list(&home.0, &home.0, &home.0.join("target"), &mut files);
    format!("{}\nunder {}:\n{files}", process(pid), home.0.display())
}

/// Each of `pid`'s threads, as Linux's `/proc` shows them: its name, its state, the kernel function
/// it sleeps in, and how long it has run on a CPU and waited for one; then each child it has, by
/// name and state, read best-effort: those pids are its, not the test's, and may be gone or
/// reused by the time they are read. Where there is no `/proc`, why none were read.
fn process(pid: u32) -> String {
    let read = |path: &Path| {
        std::fs::read_to_string(path).map_or_else(|e| format!("({e})"), |s| s.trim().to_owned())
    };
    // The state is the first field after the name, which is in parentheses and may hold either.
    let state = |stat: &str| {
        stat.rsplit_once(") ")
            .and_then(|(_, rest)| rest.split(' ').next())
            .unwrap_or("?")
            .to_owned()
    };
    let tasks = match std::fs::read_dir(format!("/proc/{pid}/task")) {
        Ok(tasks) => tasks,
        Err(e) => return format!("pid {pid}: no threads to read ({e})"),
    };
    let mut threads: Vec<_> = tasks.flatten().map(|task| task.path()).collect();
    threads.sort();
    let mut out = format!("pid {pid}, {} thread(s):", threads.len());
    let mut children = Vec::new();
    for thread in threads {
        let sched = read(&thread.join("schedstat"));
        let mut ns = sched.split(' ').map(|n| {
            n.parse().map_or_else(
                |_| "?".to_owned(),
                |n| format!("{:.2?}", Duration::from_nanos(n)),
            )
        });
        let (ran, waited) = (ns.next(), ns.next());
        let _ = write!(
            out,
            "\n  {} {:?} state {} in {} ran {} waited {}",
            thread
                .file_name()
                .map_or("?".into(), |n| n.to_string_lossy()),
            read(&thread.join("comm")),
            state(&read(&thread.join("stat"))),
            read(&thread.join("wchan")),
            ran.unwrap_or_default(),
            waited.unwrap_or_default(),
        );
        if let Ok(pids) = std::fs::read_to_string(thread.join("children")) {
            children.extend(
                pids.split_whitespace()
                    .filter_map(|p| p.parse::<u32>().ok()),
            );
        }
    }
    for child in children {
        let at = PathBuf::from(format!("/proc/{child}"));
        let _ = write!(
            out,
            "\n  child {child} {:?} state {}",
            read(&at.join("comm")),
            state(&read(&at.join("stat")))
        );
    }
    out
}

/// Every file under `dir` but `skip`, as its path from `root` and its size, one a line.
fn list(root: &Path, dir: &Path, skip: &Path, out: &mut String) {
    let mut entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(entries) => entries.flatten().map(|e| e.path()).collect(),
        Err(e) => {
            let _ = writeln!(out, "  {} ({e})", dir.display());
            return;
        }
    };
    entries.sort();
    for path in entries.into_iter().filter(|p| p != skip) {
        let shown = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .display()
            .to_string();
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => {
                let _ = writeln!(out, "  {shown}/");
                list(root, &path, skip, out);
            }
            Ok(meta) => {
                let _ = writeln!(out, "  {shown} {}", meta.len());
            }
            Err(e) => {
                let _ = writeln!(out, "  {shown} ({e})");
            }
        }
    }
}

/// The daemon stopped by `signal`, named `name`: its code, whether it said so, and whether its
/// socket is gone.
fn stopped_by(name: &str, signal: Signal) -> Res<(Option<i32>, bool, bool)> {
    let home = Home::new(name)?;
    let child = daemon(&home)?;
    bazhen_test_signal::signal(child.id(), signal).map_err(|e| format!("{e:?}"))?;
    let (code, said) = ended_within_bound(child)?;
    let line = format!("bazhen daemon stopped ({name})");
    Ok((code, said.contains(&line), !home.socket().exists()))
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn sigterm_stops_it_with_0_saying_so_and_leaves_no_socket() {
    bazhen_test_signal::require_sandbox().unwrap();
    assert_eq!(
        stopped_by("SIGTERM", Signal::TERM).unwrap(),
        (Some(0), true, true)
    );
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn sigint_stops_it_with_0_saying_so_and_leaves_no_socket() {
    bazhen_test_signal::require_sandbox().unwrap();
    assert_eq!(
        stopped_by("SIGINT", Signal::INT).unwrap(),
        (Some(0), true, true)
    );
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn a_second_signal_ends_the_drain_at_once() {
    bazhen_test_signal::require_sandbox().unwrap();
    let home = Home::new("second").unwrap();
    let child = daemon(&home).unwrap();
    // A request still arriving, which the drain would wait its 5 s for.
    let mut held = UnixStream::connect(home.socket()).unwrap();
    held.write_all(b"GET /v1/health HTTP/1.1\r\n").unwrap();
    let pid = child.id();
    bazhen_test_signal::signal(pid, Signal::TERM).unwrap();
    // Its socket goes as its drain begins, just before it stops listening, so the next is heard
    // during the drain.
    let started = Instant::now();
    while home.socket().exists() && started.elapsed() < BOUND {
        thread::sleep(Duration::from_millis(20));
    }
    bazhen_test_signal::signal(pid, Signal::TERM).unwrap();
    let hurried = Instant::now();
    let (code, said) = ended_within_bound(child).unwrap();
    let took = hurried.elapsed();
    let mut rest = Vec::new();
    let _ = held.read_to_end(&mut rest);
    assert_eq!(
        (code, said.contains("bazhen daemon stopped (SIGTERM)")),
        (Some(0), true)
    );
    assert!(took < Duration::from_secs(2), "{took:?}");
}

/// A shell that ignores SIGCHLD, as a careless parent may, and then execs `program`, which
/// inherits that across the exec. It is bash: dash takes `trap "" CHLD` but leaves SIGCHLD as it
/// was, and a shell started with SIGCHLD ignored gives it a handler of its own, so `program` is
/// what the shell execs, never another shell.
#[cfg(target_os = "linux")]
fn ignoring_sigchld(program: &str) -> Command {
    let mut command = Command::new("bash");
    command.args(["-c", r#"trap "" CHLD; exec "$0" "$@""#, program]);
    command
}

/// What `ps` shows of `pid`: the file name it runs, and whether it ignores SIGCHLD. macOS's `ps`
/// names the path it was run by, where Linux's names the file alone. Only Linux's has a
/// `sigignore` column: macOS's says "keyword not found", so all that reads it is Linux's.
#[cfg(target_os = "linux")]
fn ignores_sigchld_as(pid: u32) -> Res<(String, bool)> {
    // One `-o` each: BSD's ps reads all after a column's `=` as its header, commas and all.
    let out = Command::new("ps")
        .args(["-o", "comm=", "-o", "sigignore=", "-p", &pid.to_string()])
        .output()?;
    let said = String::from_utf8(out.stdout)?;
    let (comm, mask) = said.trim().rsplit_once(' ').ok_or_else(|| {
        format!(
            "ps showed no process ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )
    })?;
    let name = std::path::Path::new(comm.trim())
        .file_name()
        .ok_or("ps showed no name")?;
    Ok((name.to_string_lossy().into_owned(), ignored_in(mask)?))
}

/// Whether `ps` shows SIGCHLD ignored by `pid`.
#[cfg(target_os = "linux")]
fn ignores_sigchld(pid: u32) -> Res<bool> {
    Ok(ignores_sigchld_as(pid)?.1)
}

/// Whether a `sigignore` mask, in hex, has SIGCHLD's bit.
#[cfg(target_os = "linux")]
fn ignored_in(mask: &str) -> Res<bool> {
    let mask = u64::from_str_radix(mask.trim(), 16)?;
    let bit = Signal::CHILD.as_raw() - 1;
    Ok(mask >> bit & 1 == 1)
}

/// The control for the daemon's: what the shell execs, here a `sleep` that ends by itself, still
/// ignores SIGCHLD once `ps` shows it is the `sleep`. Nothing is signalled.
#[test]
#[cfg(target_os = "linux")]
fn a_shell_that_ignores_sigchld_leaves_what_it_execs_ignoring_it() {
    let mut child = ignoring_sigchld("sleep").arg("2").spawn().unwrap();
    let started = Instant::now();
    let shown = loop {
        let shown = ignores_sigchld_as(child.id()).unwrap();
        if shown.0 == "sleep" || started.elapsed() > BOUND {
            break shown;
        }
        thread::sleep(Duration::from_millis(20));
    };
    child.wait().unwrap();
    assert_eq!(shown, ("sleep".to_owned(), true));
}

/// Started by a parent that ignored SIGCHLD, the daemon gives it its default before it starts
/// any child, so the kernel keeps each one for it to wait for.
#[test]
#[cfg(target_os = "linux")]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn started_with_sigchld_ignored_it_gives_sigchld_its_default() {
    bazhen_test_signal::require_sandbox().unwrap();
    let home = Home::new("sigchld").unwrap();
    let daemon = daemon_binary(&home).unwrap();
    let child = daemon_by(&home, ignoring_sigchld(daemon.to_str().unwrap())).unwrap();
    let ignored = ignores_sigchld(child.id());
    bazhen_test_signal::signal(child.id(), Signal::TERM).unwrap();
    let (code, _) = ended_within_bound(child).unwrap();
    assert!(!ignored.unwrap());
    assert_eq!(code, Some(0));
}

/// With no holder build beside it, the daemon refuses to start, saying why and how to run its
/// terminals on tmux instead, as `main.ts` does. It is run from a copy, so no holder built at
/// `target/release-holder` is beside it. One that starts anyway is stopped through its socket.
/// It runs only on a disposable host all the same: a daemon past its refusal would go on to its
/// start-up steps, and nothing here can show those come after it.
#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn refuses_to_start_with_no_holder_build_to_run_new_terminals_on() {
    bazhen_test_signal::require_sandbox().unwrap();
    let home = Home::new("no-holder").unwrap();
    let daemon = home.0.join("target/release/bazhen-daemon");
    std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_bazhen-daemon"), &daemon).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = Command::new(&daemon)
        .env_clear()
        .env("HOME", &home.0)
        .env("BAZHEN_HOME", &home.0)
        .env("BAZHEN_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while child.try_wait().unwrap().is_none() && started.elapsed() < BOUND {
        if let Ok(mut socket) = UnixStream::connect(home.socket()) {
            socket
                .write_all(
                    b"POST /v1/daemon/stop HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n",
                )
                .unwrap();
            // Killed if the stop doesn't end it, so a failing run leaves no daemon behind.
            let ended = ended_within_bound(child);
            panic!("the daemon started with no holder build: {ended:?}");
        }
        thread::sleep(Duration::from_millis(20));
    }
    // Killed if it is still starting at the bound, neither refused nor bound.
    let (code, said) = ended_within_bound(child).unwrap();
    assert_eq!(code, Some(1), "{said}");
    assert!(
        said.contains("bazhen: no holder can be started for new terminals: ")
            && said.contains("release-holder/bazhen-holder isn't built; run `moon run :build`")
            && said.contains("set runtime.default = \"tmux\" in "),
        "{said}"
    );
    assert!(!home.socket().exists());
}
