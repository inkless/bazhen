//! A waiter whose harness has gone stops: once nothing can read its stdout and stderr, it ends,
//! whether the daemon is holding its request or it is asking again after the daemon dropped one.
//! While its harness still reads, it goes on waiting.

use std::error::Error;
use std::fs;
use std::io::Write as _;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

const BINARY: &str = env!("CARGO_BIN_EXE_bazhen-hook");
/// Past the waiter's check, once a second, with room for a loaded runner.
const BOUND: Duration = Duration::from_secs(5);

/// What the stub daemon does with each request.
#[derive(Clone, Copy)]
enum Daemon {
    /// Holds it unanswered, as for an idle agent.
    Holds,
    /// Drops it, as a daemon going down does, so the waiter asks again a second later.
    Drops,
}

/// A directory of the test's own, removed however the test ends.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A waiter running against a stub daemon, its stdout and stderr still read by the test.
struct Waiter {
    child: Child,
    _dir: Scratch,
}

/// Starts `bazhen-hook wait` against a stub that does `daemon` with each request, and returns
/// once the stub has taken `requests` of them or the waiter has ended.
fn waiter(daemon: Daemon, name: &str, requests: usize) -> Result<Waiter> {
    // Under /tmp: a socket path must fit in about 104 bytes.
    let dir = Scratch(PathBuf::from(format!(
        "/tmp/bz-hook-orphan-{}-{name}",
        std::process::id()
    )));
    fs::create_dir_all(&dir.0)?;
    let socket = dir.0.join("bazhen.sock");
    let listener = UnixListener::bind(&socket)?;
    let taken = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&taken);
    // Left blocked in accept when the test ends, which ends its process.
    thread::spawn(move || {
        let mut held: Vec<UnixStream> = Vec::new();
        for conn in listener.incoming().flatten() {
            counted.fetch_add(1, Ordering::SeqCst);
            if let Daemon::Holds = daemon {
                held.push(conn);
            }
        }
    });

    let child = Command::new(BINARY)
        .arg("wait")
        .env_clear()
        .env("BAZHEN_AGENT_ID", "agent_orphan")
        .env("BAZHEN_SOCKET", &socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut waiter = Waiter { child, _dir: dir };
    waiter
        .child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(b"{}")?;
    let by = Instant::now() + BOUND;
    while taken.load(Ordering::SeqCst) < requests {
        // One that ends before it asks leaves how it ended for the test's assertion to say.
        if waiter.child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() > by {
            return Err(
                format!("the stub took fewer than {requests} requests within {BOUND:?}").into(),
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
    Ok(waiter)
}

impl Waiter {
    /// Closes the test's ends of the waiter's stdout and stderr, as its harness dying does.
    fn unread(mut self) -> Self {
        drop(self.child.stdout.take());
        drop(self.child.stderr.take());
        self
    }

    /// How the waiter ended within `BOUND`; `None` if it was still running then, when it is
    /// killed.
    fn ended(mut self) -> Result<Option<ExitStatus>> {
        Ok(bazhen_test_signal::end_within(&mut self.child, BOUND)?)
    }
}

/// However a test ends, no waiter it started outlives it.
impl Drop for Waiter {
    fn drop(&mut self) {
        let _ = bazhen_test_signal::end_within(&mut self.child, Duration::ZERO);
    }
}

fn code(ended: Option<ExitStatus>) -> Option<i32> {
    ended.and_then(|status| status.code())
}

/// How two waiters against the same stub ended within `BOUND` of each other: one its harness
/// still reads, then one nothing reads any more.
fn read_then_unread(
    daemon: Daemon,
    name: &str,
    requests: usize,
) -> Result<(Option<ExitStatus>, Option<i32>)> {
    let read = waiter(daemon, &format!("{name}-read"), requests)?;
    let unread = waiter(daemon, &format!("{name}-unread"), requests)?
        .unread()
        .ended()?;
    Ok((read.ended()?, code(unread)))
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn a_held_waiter_ends_quietly_once_nothing_reads_it_and_waits_on_while_read() -> Result<()> {
    bazhen_test_signal::require_sandbox()?;
    assert_eq!(read_then_unread(Daemon::Holds, "held", 1)?, (None, Some(0)));
    Ok(())
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn a_waiter_asking_again_ends_quietly_once_nothing_reads_it_and_asks_on_while_read() -> Result<()> {
    bazhen_test_signal::require_sandbox()?;
    assert_eq!(
        read_then_unread(Daemon::Drops, "asking", 2)?,
        (None, Some(0))
    );
    Ok(())
}
