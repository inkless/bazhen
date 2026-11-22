//! Whether a daemon is there when none answers: no socket and no start-up lock held is a daemon
//! that isn't running, and anything else may be one that is starting, stopping, stuck or busy.

use std::fs::File;
use std::io::{self, ErrorKind};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use bazhen_client::paths::lock_of;
use rustix::fs::{FlockOperation, flock};
use rustix::io::Errno;

/// How long a look for the daemon waits for its socket to take a connection. On Linux a connect
/// blocks for as long as a wedged daemon's backlog stays full.
const PROBE: Duration = Duration::from_millis(500);

/// What is known of a daemon that didn't answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Presence {
    /// Nothing is at the socket and no daemon holds the lock: not running.
    Absent,
    /// A daemon holds the lock but has no socket. Since the daemon removes its socket as its
    /// drain begins and keeps the lock to the end, that is a daemon stopping, though one that
    /// hasn't bound yet looks the same.
    Unbound { lock: PathBuf },
    /// The socket is there, or the lock is held behind it, yet nothing answers: the daemon may be
    /// stuck or busy. `why` says what was seen.
    Unanswering(String),
}

/// What the daemon at `socket` is, going by a connect to it and by its start-up lock.
pub(crate) fn presence(socket: &Path) -> Presence {
    let (tell, told) = mpsc::channel();
    let path = socket.to_path_buf();
    thread::spawn(move || {
        // A connect that outlived PROBE has no one left to tell.
        let _ = tell.send(UnixStream::connect(path));
    });
    let lock = lock_of(socket);
    presence_of(told.recv_timeout(PROBE).ok(), || held(&lock), &lock)
}

/// `Ok` only for a daemon surely not there, whatever else is known of it, for the callers that
/// must never act behind a daemon that may be: the reason says what was seen.
pub(crate) fn daemon_absent(socket: &Path) -> Result<(), String> {
    match presence(socket) {
        Presence::Absent => Ok(()),
        Presence::Unbound { lock } => Err(format!(
            "a daemon holds {} but has no socket: it is stopping, or still starting",
            lock.display()
        )),
        Presence::Unanswering(why) => Err(why),
    }
}

/// `connected` is what the connect gave, or `None` when it didn't finish in time. `held` asks
/// the lock only where the socket alone can't say.
fn presence_of(
    connected: Option<io::Result<UnixStream>>,
    held: impl FnOnce() -> io::Result<bool>,
    lock: &Path,
) -> Presence {
    let kind = match &connected {
        Some(Err(e)) => e.kind(),
        Some(Ok(_)) => return Presence::Unanswering("something listens on its socket".to_owned()),
        None => {
            return Presence::Unanswering("its socket is too busy to take a connection".to_owned());
        }
    };
    if !matches!(kind, ErrorKind::NotFound | ErrorKind::ConnectionRefused) {
        let why = connected.and_then(Result::err).map(|e| e.to_string());
        return Presence::Unanswering(format!(
            "its socket can't be reached: {}",
            why.unwrap_or_default()
        ));
    }
    match (held(), kind) {
        (Ok(false), _) => Presence::Absent,
        (Ok(true), ErrorKind::NotFound) => Presence::Unbound {
            lock: lock.to_path_buf(),
        },
        // macOS refuses a connect to a full backlog as it does a stale socket.
        (Ok(true), _) => Presence::Unanswering(format!(
            "a daemon holds {}, yet its socket refuses connections",
            lock.display()
        )),
        (Err(e), _) => Presence::Unanswering(format!("its lock can't be read: {e}")),
    }
}

/// Whether a daemon holds the lock at `path`. It looks without creating the file, and its own
/// shared lock lasts only until the file closes: a start that meets it waits and tries again.
fn held(path: &Path) -> io::Result<bool> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    match flock(&file, FlockOperation::NonBlockingLockShared) {
        Ok(()) => Ok(false),
        Err(Errno::WOULDBLOCK) => Ok(true),
        Err(e) => Err(e.into()),
    }
}

/// What a command says of a daemon that has no socket and holds the lock.
pub(crate) fn unbound_text(lock: &Path) -> String {
    format!(
        "bazhen is stopping or still starting: a daemon holds {} but has no socket; try again in a \
         moment",
        lock.display()
    )
}

/// What a command says of a daemon that may be there and doesn't answer.
pub(crate) fn unanswering_text(socket: &Path, why: &str) -> String {
    format!(
        "bazhen doesn't answer on {} and may be stuck or busy ({why})",
        socket.display()
    )
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixListener;

    use super::*;
    use crate::testing::Dir;

    impl Dir {
        fn socket(&self) -> PathBuf {
            self.0.join("bazhen.sock")
        }
    }

    /// Holds the lock beside `socket` as a daemon does: exclusively, on a file of its own.
    fn hold(socket: &Path) -> File {
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_of(socket))
            .unwrap();
        flock(&file, FlockOperation::NonBlockingLockExclusive).unwrap();
        file
    }

    #[test]
    fn takes_a_connect_that_never_finished_for_a_daemon_that_may_be_there() {
        let lock = Path::new("/none.lock");
        let seen = presence_of(None, || Ok(false), lock);
        assert!(matches!(seen, Presence::Unanswering(_)), "{seen:?}");
    }

    #[test]
    fn says_not_running_where_nothing_is_or_nothing_listens_and_no_lock_is_held() {
        let dir = Dir::new("absent-nothing");
        let nothing = dir.0.join("nothing.sock");
        let stale = dir.0.join("stale.sock");
        drop(UnixListener::bind(&stale).unwrap());
        assert_eq!(
            [presence(&nothing), presence(&stale)],
            [Presence::Absent, Presence::Absent]
        );
    }

    #[test]
    fn a_lock_file_nobody_holds_is_no_daemon() {
        let dir = Dir::new("free");
        drop(hold(&dir.socket()));
        assert_eq!(presence(&dir.socket()), Presence::Absent);
    }

    #[test]
    fn a_held_lock_with_no_socket_is_a_daemon_stopping_and_the_look_does_not_take_it() {
        let dir = Dir::new("unbound");
        let daemon = hold(&dir.socket());
        let seen = presence(&dir.socket());
        // Control: the look left no lock behind, so it is still the daemon's alone to let go of.
        let again = presence(&dir.socket());
        assert_eq!(
            [&seen, &again],
            [&Presence::Unbound {
                lock: lock_of(&dir.socket())
            }; 2]
        );
        drop(daemon);
        assert_eq!(presence(&dir.socket()), Presence::Absent);
    }

    #[test]
    fn a_look_at_the_lock_does_not_hold_off_the_daemons_own_start() {
        let dir = Dir::new("start");
        drop(hold(&dir.socket()));
        presence(&dir.socket());
        let started = File::options()
            .read(true)
            .write(true)
            .open(lock_of(&dir.socket()))
            .unwrap();
        assert!(flock(&started, FlockOperation::NonBlockingLockExclusive).is_ok());
    }

    #[test]
    fn a_socket_that_listens_without_answering_may_be_stuck_whether_or_not_a_lock_is_held() {
        let dir = Dir::new("stuck");
        let _listening = UnixListener::bind(dir.socket()).unwrap();
        let before = presence(&dir.socket());
        let _daemon = hold(&dir.socket());
        let after = presence(&dir.socket());
        assert!(
            matches!(&before, Presence::Unanswering(w) if w == "something listens on its socket"),
            "{before:?}"
        );
        assert_eq!(before, after);
    }

    #[test]
    fn a_refused_connect_with_the_lock_held_is_a_daemon_that_may_be_stuck() {
        let dir = Dir::new("refused");
        drop(UnixListener::bind(dir.socket()).unwrap());
        let _daemon = hold(&dir.socket());
        let seen = presence(&dir.socket());
        assert!(
            matches!(&seen, Presence::Unanswering(w) if w.contains("refuses connections")),
            "{seen:?}"
        );
    }

    #[test]
    fn a_lock_that_cannot_be_read_may_be_a_daemon() {
        if rustix::process::geteuid().is_root() {
            return;
        }
        let dir = Dir::new("unreadable");
        drop(hold(&dir.socket()));
        std::fs::set_permissions(
            lock_of(&dir.socket()),
            std::os::unix::fs::PermissionsExt::from_mode(0o000),
        )
        .unwrap();
        let seen = presence(&dir.socket());
        assert!(
            matches!(&seen, Presence::Unanswering(w) if w.starts_with("its lock can't be read")),
            "{seen:?}"
        );
    }

    #[test]
    fn takes_the_daemon_for_gone_only_where_nothing_is_or_nothing_listens() {
        if rustix::process::geteuid().is_root() {
            return;
        }
        let dir = Dir::new("sealed");
        let sealed = dir.0.join("sealed");
        std::fs::create_dir(&sealed).unwrap();
        let unreachable = sealed.join("bazhen.sock");
        let _behind = UnixListener::bind(&unreachable).unwrap();
        std::fs::set_permissions(&sealed, std::os::unix::fs::PermissionsExt::from_mode(0o000))
            .unwrap();
        let seen = daemon_absent(&unreachable);
        std::fs::set_permissions(&sealed, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        assert!(seen.is_err());
    }
}
