//! A waiter whose harness has gone stops: once nothing can read its stdout and stderr, it ends,
//! whether the daemon is holding its request or it is asking again after the daemon dropped one.
//! While its harness still reads, it goes on waiting.
//!
//! The `sh` + `curl` script can't see its stdout's reader go. The harness runs it in place of its
//! shell, so the harness is its parent, and the script stops asking again once that parent has
//! gone and it was handed to another.

use std::error::Error;
use std::fs;
use std::io::{Read as _, Write as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

const BINARY: &str = env!("CARGO_BIN_EXE_bazhen-hook");
const SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/bazhen-hook.sh");
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
    stub: Stub,
}

/// A stub daemon on a socket in a directory of its own, doing `daemon` with each request.
struct Stub {
    dir: Scratch,
    taken: Arc<AtomicUsize>,
}

impl Stub {
    fn start(daemon: Daemon, name: &str) -> Result<Self> {
        // Under /tmp: a socket path must fit in about 104 bytes.
        let dir = Scratch(PathBuf::from(format!(
            "/tmp/bz-hook-orphan-{}-{name}",
            std::process::id()
        )));
        fs::create_dir_all(&dir.0)?;
        let listener = UnixListener::bind(dir.0.join("bazhen.sock"))?;
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
        Ok(Self { dir, taken })
    }

    fn socket(&self) -> PathBuf {
        self.dir.0.join("bazhen.sock")
    }

    fn taken(&self) -> usize {
        self.taken.load(Ordering::SeqCst)
    }
}

/// A waiter's environment: an agent's, its daemon at `socket`.
fn agent_env<'a>(command: &'a mut Command, socket: &Path) -> &'a mut Command {
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("BAZHEN_AGENT_ID", "agent_orphan")
        .env("BAZHEN_SOCKET", socket)
}

/// Starts `client wait` against a stub that does `daemon` with each request, and returns once
/// the stub has taken `requests` of them or the waiter has ended.
fn waiter(client: &str, daemon: Daemon, name: &str, requests: usize) -> Result<Waiter> {
    let stub = Stub::start(daemon, name)?;
    let child = agent_env(Command::new(client).arg("wait"), &stub.socket())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut waiter = Waiter { child, stub };
    waiter
        .child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(b"{}")?;
    let by = Instant::now() + BOUND;
    while waiter.stub.taken() < requests {
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
    let read = waiter(BINARY, daemon, &format!("{name}-read"), requests)?;
    let unread = waiter(BINARY, daemon, &format!("{name}-unread"), requests)?
        .unread()
        .ended()?;
    Ok((read.ended()?, code(unread)))
}

#[test]
#[ignore = "signals processes; runs in make test-real ARGS=rust"]
fn a_held_waiter_ends_quietly_once_nothing_reads_it_and_waits_on_while_read() -> Result<()> {
    bazhen_test_signal::require_sandbox()?;
    assert_eq!(read_then_unread(Daemon::Holds, "held", 1)?, (None, Some(0)));
    Ok(())
}

#[test]
#[ignore = "signals processes; runs in make test-real ARGS=rust"]
fn a_waiter_asking_again_ends_quietly_once_nothing_reads_it_and_asks_on_while_read() -> Result<()> {
    bazhen_test_signal::require_sandbox()?;
    assert_eq!(
        read_then_unread(Daemon::Drops, "asking", 2)?,
        (None, Some(0))
    );
    Ok(())
}

/// The script's waiter under a parent that goes while the test still reads its stdout. A
/// leader the test started, in a group of its own, runs a parent `sh`, which starts the waiter
/// and ends at the test's word; the leader stays, so the waiter is reached through its group.
/// The waiter alone holds the pipe the test reads, so the pipe's end is the waiter's.
struct Orphan {
    leader: Child,
    ended: mpsc::Receiver<()>,
    stub: Stub,
}

const ORPHAN: &str = r#"exec 3>&1 >/dev/null
sh -c '"$0" wait >&3 3>&- & exec 3>&-; read -r _' "$0"
exec 3>&-
read -r _"#;

impl Orphan {
    /// Starts the waiter against a stub that drops each request, and returns once the stub has
    /// taken one, so the waiter has its first parent's pid by then.
    fn start(name: &str) -> Result<Self> {
        let stub = Stub::start(Daemon::Drops, name)?;
        let mut leader = agent_env(&mut Command::new("/bin/sh"), &stub.socket())
            .args(["-c", ORPHAN, SCRIPT])
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut out = leader.stdout.take().ok_or("no stdout")?;
        let (tx, ended) = mpsc::channel();
        thread::spawn(move || {
            let _ = out.read_to_end(&mut Vec::new());
            let _ = tx.send(());
        });
        let orphan = Self {
            leader,
            ended,
            stub,
        };
        let by = Instant::now() + BOUND;
        while orphan.stub.taken() < 1 {
            if Instant::now() > by {
                return Err(format!("the stub took no request within {BOUND:?}").into());
            }
            thread::sleep(Duration::from_millis(20));
        }
        Ok(orphan)
    }

    /// Ends the waiter's parent, as its harness dying does, and says whether the waiter then
    /// ended within `BOUND`.
    fn parent_gone(&mut self) -> Result<bool> {
        self.leader
            .stdin
            .as_mut()
            .ok_or("no stdin")?
            .write_all(b"\n")?;
        Ok(self.ended.recv_timeout(BOUND).is_ok())
    }
}

/// However a test ends, nothing it started outlives it.
impl Drop for Orphan {
    fn drop(&mut self) {
        let _ =
            bazhen_test_signal::signal_group(self.leader.id(), bazhen_test_signal::Signal::KILL);
        let _ = self.leader.wait();
    }
}

#[test]
#[ignore = "signals processes; runs in make test-real ARGS=rust"]
fn the_scripts_waiter_stops_asking_once_its_parent_has_gone_and_asks_on_under_its_parent()
-> Result<()> {
    bazhen_test_signal::require_sandbox()?;
    let kept = waiter(SCRIPT, Daemon::Drops, "script-kept", 1)?;
    let orphaned = Orphan::start("script-orphaned")?.parent_gone()?;
    assert_eq!((kept.ended()?, orphaned), (None, true));
    Ok(())
}
