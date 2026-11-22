//! The start-up lock (`socket/lock.ts`): an exclusive `flock` on a file beside the socket, held for
//! the daemon's whole life. A daemon holds it while it starts, serves, drains and is stuck, so
//! start-up never takes over a socket whose daemon lives, whatever a probe of the socket says. On
//! macOS a stuck daemon's full backlog refuses a connect as a stale socket does, and two starts
//! can both probe before either binds; only the lock tells those apart.

use std::fs::{File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rustix::fs::{FlockOperation, flock};
use rustix::io::Errno;

use crate::probe::Answer;

/// How often a start waits on a lock another daemon holds.
const RETRY: Duration = Duration::from_millis(100);

/// The lock, held until it is dropped or the process ends, however it ends. The file is
/// close-on-exec, so no child, a holder that outlives the daemon included, keeps it held.
#[derive(Debug)]
pub(crate) struct Lock {
    _file: File,
}

/// Why a start didn't get the lock, or got it over a socket something else still holds.
#[derive(Debug, thiserror::Error)]
pub(crate) enum Claim {
    /// A daemon answers on the socket.
    #[error("a daemon answers")]
    Running,
    /// The lock is this start's, but something holds the socket without answering.
    #[error("no answer ({seen})")]
    Silent { seen: String },
    /// Another daemon held the lock throughout the wait, and never answered on the socket.
    #[error("held")]
    Held,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// The lock file for the daemon on `socket`. It is never removed: a daemon that removed it could
/// let a second one lock a fresh file while a third still holds the old one.
pub(crate) fn lock_of(socket: &Path) -> PathBuf {
    let mut path = socket.as_os_str().to_owned();
    path.push(".lock");
    PathBuf::from(path)
}

/// The lock at `path`, or `None` while another open of it holds it, in this process or another.
pub(crate) fn try_lock(path: &Path) -> std::io::Result<Option<Lock>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?;
    lock_opened(file, path)
}

/// The lock on `file`, opened at `path`, or `None` while it is held, or once `path` names another
/// file: one removed between the open and the lock may have been made afresh and locked by
/// another start, which a lock on the old one wouldn't hold off.
fn lock_opened(file: File, path: &Path) -> std::io::Result<Option<Lock>> {
    match flock(&file, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) if same_file(&file, path)? => Ok(Some(Lock { _file: file })),
        Ok(()) | Err(Errno::WOULDBLOCK) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn same_file(file: &File, path: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::MetadataExt as _;
    let held = file.metadata()?;
    match std::fs::metadata(path) {
        Ok(named) => Ok((named.dev(), named.ino()) == (held.dev(), held.ino())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

/// The lock at `path`, taken only where nothing answers `probe`. While another daemon holds it,
/// silently, it may be starting, or stopping with its socket already gone, so the lock is tried
/// again for up to `wait` before the start gives up.
pub(crate) fn claim(
    path: &Path,
    wait: Duration,
    mut probe: impl FnMut() -> Answer,
) -> Result<Lock, Claim> {
    let begun = Instant::now();
    loop {
        if let Some(lock) = try_lock(path)? {
            // A daemon of a build without the lock, or one whose lock file someone removed.
            return match probe() {
                Answer::Nothing => Ok(lock),
                Answer::Silent { seen } => Err(Claim::Silent { seen }),
                Answer::Daemon { .. } => Err(Claim::Running),
            };
        }
        if matches!(probe(), Answer::Daemon { .. }) {
            return Err(Claim::Running);
        }
        if begun.elapsed() >= wait {
            return Err(Claim::Held);
        }
        std::thread::sleep(RETRY);
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::process::{Child, Command, Stdio};

    use super::*;
    use crate::session::in_own_session;
    use crate::testing::TempDir;

    const QUICK: Duration = Duration::from_millis(300);

    fn daemon() -> Answer {
        Answer::Daemon { protocol_id: None }
    }

    #[test]
    fn the_lock_file_sits_beside_the_socket() {
        assert_eq!(
            lock_of(Path::new("/h/run/bazhen.sock")),
            PathBuf::from("/h/run/bazhen.sock.lock")
        );
    }

    #[test]
    fn a_second_open_is_held_off_even_in_this_process_until_the_first_lets_go() {
        let dir = TempDir::new("lock-twice");
        let path = dir.path().join("bazhen.sock.lock");
        let first = try_lock(&path).unwrap();
        let second = try_lock(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        drop(first);
        let after = try_lock(&path).unwrap();
        assert!(second.is_none());
        assert!(after.is_some());
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn takes_a_free_lock_only_where_nothing_answers_on_the_socket() {
        let dir = TempDir::new("lock-free");
        let path = dir.path().join("bazhen.sock.lock");
        let answers = [
            Answer::Nothing,
            Answer::Silent {
                seen: "timed out".to_owned(),
            },
            daemon(),
        ];
        let claimed = answers.map(|answer| match claim(&path, QUICK, || answer.clone()) {
            Ok(_) => "taken".to_owned(),
            Err(err) => err.to_string(),
        });
        assert_eq!(
            claimed,
            ["taken", "no answer (timed out)", "a daemon answers"]
        );
    }

    #[test]
    fn a_held_lock_whose_daemon_answers_is_a_daemon_running() {
        let dir = TempDir::new("lock-running");
        let path = dir.path().join("bazhen.sock.lock");
        let _held = try_lock(&path).unwrap().unwrap();
        let begun = Instant::now();
        let claimed = claim(&path, Duration::from_secs(5), daemon);
        assert!(matches!(claimed, Err(Claim::Running)), "{claimed:?}");
        assert!(begun.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_held_lock_whose_daemon_never_answers_is_given_up_on_after_the_wait() {
        let dir = TempDir::new("lock-held");
        let path = dir.path().join("bazhen.sock.lock");
        let _held = try_lock(&path).unwrap().unwrap();
        let begun = Instant::now();
        let claimed = claim(&path, QUICK, || Answer::Nothing);
        let took = begun.elapsed();
        assert!(matches!(claimed, Err(Claim::Held)), "{claimed:?}");
        assert!(took >= QUICK && took < QUICK * 3, "{took:?}");
    }

    #[test]
    fn a_lock_let_go_during_the_wait_is_taken() {
        let dir = TempDir::new("lock-released");
        let path = dir.path().join("bazhen.sock.lock");
        let held = try_lock(&path).unwrap().unwrap();
        let letting_go = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(held);
        });
        let claimed = claim(&path, Duration::from_secs(5), || Answer::Nothing);
        letting_go.join().unwrap();
        assert!(claimed.is_ok(), "{claimed:?}");
    }

    /// A child the daemon starts, in a session of its own, waiting on its stdin until the test
    /// closes it.
    fn child(stdout: Stdio) -> Child {
        in_own_session(&mut Command::new("/bin/sh"))
            .args(["-c", "read line || true"])
            .stdin(Stdio::piped())
            .stdout(stdout)
            .spawn()
            .unwrap()
    }

    fn end(mut child: Child) {
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn a_child_started_while_the_lock_is_held_doesnt_keep_it_once_the_daemon_lets_go() {
        let dir = TempDir::new("lock-child");
        let path = dir.path().join("bazhen.sock.lock");
        let lock = try_lock(&path).unwrap().unwrap();
        let spawned = child(Stdio::null());
        drop(lock);
        let after = try_lock(&path).unwrap();
        end(spawned);
        assert!(after.is_some(), "a child kept the lock");
    }

    #[test]
    fn a_child_handed_the_lock_file_keeps_it_held() {
        let dir = TempDir::new("lock-handed");
        let path = dir.path().join("bazhen.sock.lock");
        let file = File::create(&path).unwrap();
        flock(&file, FlockOperation::NonBlockingLockExclusive).unwrap();
        let spawned = child(Stdio::from(file.try_clone().unwrap()));
        drop(file);
        let while_it_runs = try_lock(&path).unwrap();
        end(spawned);
        let once_it_ended = try_lock(&path).unwrap();
        assert!(
            while_it_runs.is_none(),
            "the test can't see a lock a child keeps"
        );
        assert!(once_it_ended.is_some());
    }

    #[test]
    fn a_lock_on_a_file_since_replaced_at_its_path_is_no_lock() {
        let dir = TempDir::new("lock-replaced");
        let path = dir.path().join("bazhen.sock.lock");
        let opened = File::create(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, "").unwrap();
        let on_the_old = lock_opened(opened, &path).unwrap();
        let on_the_new = try_lock(&path).unwrap();
        assert!(on_the_old.is_none());
        assert!(
            on_the_new.is_some(),
            "the lock on the old file wasn't let go"
        );
    }
}
