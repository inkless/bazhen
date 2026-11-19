//! The daemon as a process, stopped by a signal as `main.ts` is: SIGTERM or SIGINT ends it with 0
//! and says which, and one heard while it drains ends it at once.

use std::io::{Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
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

/// The daemon on `home`, in the foreground with its output piped, once its socket answers.
fn daemon(home: &Home) -> Res<Child> {
    let port = std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_bazhen-daemon"))
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
            let _ = ended_within_bound(child);
            return Err("the daemon never answered on its socket".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Ok(child)
}

/// The child's exit code and what it said on stderr, once it ends; `None` for the code if it
/// hadn't by the bound, when it is killed.
fn ended_within_bound(child: Child) -> Res<(Option<i32>, String)> {
    let (tell, exited) = mpsc::channel();
    let pid = child.id();
    let waiter = thread::spawn(move || {
        let _ = tell.send(child.wait_with_output());
    });
    if let Ok(output) = exited.recv_timeout(BOUND) {
        let output = output?;
        let said = String::from_utf8_lossy(&output.stderr).into_owned();
        return Ok((output.status.code(), said));
    }
    // The child is the test's own and unreaped, so its pid is still its own.
    bazhen_test_signal::signal(pid, Signal::KILL).map_err(|e| format!("{e:?}"))?;
    waiter.join().map_err(|_| "the waiter panicked")?;
    Ok((None, String::new()))
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
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn sigterm_stops_it_with_0_saying_so_and_leaves_no_socket() {
    bazhen_test_signal::require_sandbox().unwrap();
    assert_eq!(
        stopped_by("SIGTERM", Signal::TERM).unwrap(),
        (Some(0), true, true)
    );
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn sigint_stops_it_with_0_saying_so_and_leaves_no_socket() {
    bazhen_test_signal::require_sandbox().unwrap();
    assert_eq!(
        stopped_by("SIGINT", Signal::INT).unwrap(),
        (Some(0), true, true)
    );
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_second_signal_ends_the_drain_at_once() {
    bazhen_test_signal::require_sandbox().unwrap();
    let home = Home::new("second").unwrap();
    let child = daemon(&home).unwrap();
    // A request still arriving, which the drain would wait its 5 s for.
    let mut held = UnixStream::connect(home.socket()).unwrap();
    held.write_all(b"GET /v1/health HTTP/1.1\r\n").unwrap();
    let pid = child.id();
    bazhen_test_signal::signal(pid, Signal::TERM).unwrap();
    // Its socket goes once it stops listening, so the next is heard during the drain.
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
