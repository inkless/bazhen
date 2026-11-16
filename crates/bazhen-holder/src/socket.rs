//! The holder's socket: where it binds, who may connect, and keeping it bound.
//!
//! The socket lives in a directory only its user can enter, which is what keeps other users out
//! on every OS; the peer's uid is checked on accept as well. Beside it, `<terminalId>.lock` is
//! held locked for the holder's whole life, so two holders never serve one terminal: the second
//! is refused before it touches the socket, and a socket found there by the one holding the lock
//! can only be a dead holder's.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rustix::fs::{
    FileType, FlockOperation, Mode, Timespec, Timestamps, UTIME_NOW, flock, fstat, futimens,
};
use rustix::process::{fchdir, geteuid, umask};
use thiserror::Error;

/// The longest socket path, in bytes: macOS's `sun_path` holds 104, its NUL included. Held on
/// every OS, so a terminal made on Linux has a path that would work on macOS too.
pub const MAX_SOCKET_PATH: usize = 103;

/// How often the holder looks for its socket, to bind it again if something removed it (macOS
/// cleans temporary directories). `SIGUSR1` asks for a look at once.
pub const RECHECK_EVERY: Duration = Duration::from_secs(5);

/// How often the lock's times are renewed, so a cleaner that removes files by age passes it over.
/// Cleaners count in days (`systemd-tmpfiles` ten for `/tmp`, macOS three for `$TMPDIR`), and a
/// write every few seconds would only churn the disk. It counts awake time only, as `Instant`
/// does, so after a suspend a renewal can come up to this long late by the wall clock.
const RENEW_EVERY: Duration = Duration::from_hours(1);

/// What each accepted connection asks the kernel to buffer for it: the default on macOS is about
/// 8 KiB, which a subscriber keeping up with a flood would fill every few writes. The kernel may
/// grant less.
pub const SEND_BUFFER: usize = 1 << 20;

#[derive(Debug, Error)]
pub enum BindError {
    #[error("{0} isn't a directory private to this user")]
    NotPrivate(String),
    #[error("{0}")]
    Taken(String),
    #[error("could not bind {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: io::Error,
    },
}

/// Why `path` can't be a holder's socket, if it can't: it must be absolute, since the holder
/// works from `/`, and fit in `MAX_SOCKET_PATH`.
pub fn path_problem(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return Some(format!("the socket path {path:?} isn't absolute"));
    }
    if path.len() > MAX_SOCKET_PATH {
        return Some(format!(
            "the socket path is {} bytes, over {MAX_SOCKET_PATH}",
            path.len()
        ));
    }
    let name = Path::new(path).file_name();
    if name.is_none_or(std::ffi::OsStr::is_empty) || path.ends_with('/') {
        return Some(format!("the socket path {path:?} names no file"));
    }
    None
}

/// A socket just bound, and which file it is.
#[derive(Debug)]
struct Listening {
    listener: UnixListener,
    identity: Identity,
}

/// Whether a recheck found the terminal's lock still this holder's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lock {
    Held,
    /// The name had gone or named another file, and this holder has locked the file there now.
    Retaken,
    /// Another holder holds the file at the name.
    Lost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
}

impl Identity {
    fn of(meta: &std::fs::Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
        }
    }
}

/// A bound socket, and the lock that makes it this holder's.
#[derive(Debug)]
pub struct Socket {
    path: PathBuf,
    listener: UnixListener,
    identity: Identity,
    lock: File,
    renewed_at: Instant,
    replaced_seen: bool,
    lock_lost_seen: bool,
    /// A lock taken back with a dead winner's socket still to replace: kept until a bind
    /// succeeds, so one failed attempt doesn't leave that socket there for good.
    takeover_pending: bool,
}

impl Socket {
    /// Binds `path`, which `path_problem` passes.
    ///
    /// # Errors
    ///
    /// `NotPrivate` when its directory isn't one only this user can enter, `Taken` when another
    /// holder holds the terminal or something other than a socket is at the path, `Io` when a step
    /// fails.
    pub fn bind(path: &Path) -> Result<Self, BindError> {
        in_private_dir(path, |name| {
            let lock = lock(&name.with_extension("lock"), path)?;
            renew(&lock);
            let Listening { listener, identity } = replace(name, path)?;
            Ok(Self {
                path: path.to_owned(),
                listener,
                identity,
                lock,
                renewed_at: Instant::now(),
                replaced_seen: false,
                lock_lost_seen: false,
                takeover_pending: false,
            })
        })
    }

    pub const fn listener(&self) -> &UnixListener {
        &self.listener
    }

    /// Binds the socket again if its path is gone. If this holder has just taken back a lock it
    /// had lost, a socket at the path is the dead winner's, as with any socket `bind` finds under
    /// the lock, and is replaced too. The directory is checked again first. Anything else at the
    /// path is left alone, and logged once.
    ///
    /// The lock is checked first, and nothing is bound without it. A cleaner that removed the lock
    /// would let a second holder lock a new file and take this socket for a dead one's; this
    /// holder locks a new one at the name if it can. That leaves a window, from the removal to
    /// the next recheck (`RECHECK_EVERY`, or sooner on `SIGUSR1`), in which a second holder can
    /// still win, and renewing the lock's times closes it only against cleaners that go by age.
    ///
    /// A holder that has lost the lock to another stays up, bound to nothing new: exiting would
    /// end the user's child, which the other holder doesn't hold. It keeps the connections it has,
    /// and tries the lock again at each recheck.
    pub fn recheck(&mut self) {
        self.recheck_with(replace);
    }

    /// `recheck`, binding with `bind`, which the tests make fail.
    fn recheck_with(&mut self, bind: fn(&Path, &Path) -> Result<Listening, BindError>) {
        match self.keep_lock() {
            Lock::Lost => return,
            Lock::Held => {}
            Lock::Retaken => self.takeover_pending = true,
        }
        match std::fs::symlink_metadata(&self.path) {
            Ok(meta) if Identity::of(&meta) == self.identity => self.takeover_pending = false,
            Ok(meta) if self.takeover_pending && meta.file_type().is_socket() => {
                self.bind_again(bind);
            }
            Ok(_) => {
                if !self.replaced_seen {
                    tracing::warn!("something else is at the socket's path; leaving it");
                    self.replaced_seen = true;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => self.bind_again(bind),
            Err(error) => tracing::warn!(%error, "could not look for the socket"),
        }
    }

    fn bind_again(&mut self, bind: fn(&Path, &Path) -> Result<Listening, BindError>) {
        let path = self.path.clone();
        match in_private_dir(&self.path, |name| bind(name, &path)) {
            Ok(Listening { listener, identity }) => {
                self.listener = listener;
                self.identity = identity;
                self.replaced_seen = false;
                self.takeover_pending = false;
                tracing::info!("the socket was gone or dead, and is bound again");
            }
            Err(error) => tracing::warn!(%error, "could not bind the socket again"),
        }
    }

    /// Whether this holder holds the lock at the lock's name: the file it locked, or, if the name
    /// is gone or names another file, a new one it has locked there now. Renews the lock's times
    /// once `RENEW_EVERY` has passed.
    fn keep_lock(&mut self) -> Lock {
        if self.renewed_at.elapsed() >= RENEW_EVERY {
            renew(&self.lock);
            self.renewed_at = Instant::now();
        }
        let name = self.path.with_extension("lock");
        let linked = match (self.lock.metadata(), std::fs::symlink_metadata(&name)) {
            (Ok(held), Ok(named)) => Identity::of(&held) == Identity::of(&named),
            _ => false,
        };
        if linked {
            return Lock::Held;
        }
        let socket = self.path.clone();
        match in_private_dir(&self.path, |dir_name| {
            lock(&dir_name.with_extension("lock"), &socket)
        }) {
            Ok(lock) => {
                renew(&lock);
                self.renewed_at = Instant::now();
                self.lock = lock;
                self.lock_lost_seen = false;
                tracing::warn!("the lock file was gone, and is locked again");
                Lock::Retaken
            }
            Err(error) => {
                if !self.lock_lost_seen {
                    tracing::warn!(%error, "lost the terminal's lock; binding nothing until it is back");
                    self.lock_lost_seen = true;
                }
                Lock::Lost
            }
        }
    }

    /// Removes the socket, if what is at its path is still this one. The listener and the lock
    /// stay open until the `Socket` is dropped.
    pub fn remove(&self) {
        let removed = in_private_dir(&self.path, |name| match std::fs::symlink_metadata(name) {
            Ok(meta) if Identity::of(&meta) == self.identity => {
                std::fs::remove_file(name).map_err(io_error(name))
            }
            _ => Ok(()),
        });
        if let Err(error) = removed {
            tracing::warn!(%error, "could not remove the socket");
        }
    }
}

fn io_error(path: &Path) -> impl Fn(io::Error) -> BindError + '_ {
    move |source| BindError::Io {
        path: path.display().to_string(),
        source,
    }
}

/// Runs `f` on the socket's file name from inside its directory, once that is shown to be a real
/// directory of this user's that no one else may enter. Working from the directory's fd means
/// nothing can swap it between the check and `f`. The holder is back in `/` afterwards.
fn in_private_dir<T>(
    path: &Path,
    f: impl FnOnce(&Path) -> Result<T, BindError>,
) -> Result<T, BindError> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(BindError::NotPrivate(path.display().to_string()));
    };
    let not_private = || BindError::NotPrivate(dir.display().to_string());
    let opened = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(dir)
        .map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP | libc::ENOTDIR) => not_private(),
            _ => io_error(dir)(e),
        })?;
    let stat = fstat(&opened).map_err(|e| io_error(dir)(e.into()))?;
    let others = Mode::RWXG | Mode::RWXO;
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory
        || stat.st_uid != geteuid().as_raw()
        || Mode::from_raw_mode(stat.st_mode).intersects(others)
    {
        return Err(not_private());
    }
    fchdir(&opened).map_err(|e| io_error(dir)(e.into()))?;
    let done = f(Path::new(name));
    let back = std::env::set_current_dir("/").map_err(io_error(Path::new("/")));
    let value = done?;
    back?;
    Ok(value)
}

/// Opens and locks `name`, the terminal's lock file. It is never removed by a holder: removing a
/// held lock would let two later holders each lock a different file of that name.
fn lock(name: &Path, socket: &Path) -> Result<File, BindError> {
    let io = io_error(name);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(name);
    let not_plain = |why: &dyn std::fmt::Display| {
        BindError::Taken(format!("{} isn't a plain file: {why}", name.display()))
    };
    // A symlink, a directory and a socket at the name refuse the open itself.
    let file = file.map_err(|e| match e.raw_os_error() {
        Some(libc::ELOOP | libc::EISDIR | libc::ENXIO | libc::EOPNOTSUPP) => not_plain(&e),
        _ => io(e),
    })?;
    let stat = fstat(&file).map_err(|e| io(e.into()))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(not_plain(&"another kind of file"));
    }
    match flock(&file, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(file),
        Err(rustix::io::Errno::WOULDBLOCK) => Err(BindError::Taken(format!(
            "another holder serves {}",
            socket.display()
        ))),
        Err(e) => Err(io(e.into())),
    }
}

/// Sets the lock's access and modification times to now: a lock file outlives its holders, so
/// the one a holder opens may be old enough for a cleaner to take.
fn renew(lock: &File) {
    let now = Timespec {
        tv_sec: 0,
        tv_nsec: UTIME_NOW,
    };
    let times = Timestamps {
        last_access: now,
        last_modification: now,
    };
    if let Err(error) = futimens(lock, &times) {
        tracing::debug!(%error, "could not renew the lock's times");
    }
}

/// Binds `name` in the current directory, for `socket`, under the lock: a socket already there
/// can only be a dead holder's, and is removed; anything else there is refused.
fn replace(name: &Path, socket: &Path) -> Result<Listening, BindError> {
    let io = io_error(socket);
    match std::fs::symlink_metadata(name) {
        Ok(meta) if meta.file_type().is_socket() => std::fs::remove_file(name).map_err(&io)?,
        Ok(_) => {
            return Err(BindError::Taken(format!(
                "{} is taken by something other than a socket",
                socket.display()
            )));
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(io(e)),
    }
    listen(name).map_err(io)
}

/// Binds `name` in the current directory, born `0600`: the umask is set only around the bind,
/// since the child gets the holder's.
fn listen(name: &Path) -> io::Result<Listening> {
    let previous = umask(Mode::from_raw_mode(0o177));
    let bound = UnixListener::bind(name);
    umask(previous);
    let listener = bound?;
    listener.set_nonblocking(true)?;
    let identity = Identity::of(&std::fs::symlink_metadata(name)?);
    Ok(Listening { listener, identity })
}

/// Readies an accepted connection, or refuses it: one from another user is refused, and so is one
/// whose user can't be read.
///
/// # Errors
///
/// When the connection is refused or can't be readied.
pub fn admit(stream: &UnixStream) -> io::Result<()> {
    let peer = peer_uid(stream)?;
    if refuses(peer, geteuid().as_raw()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("a connection from uid {peer}"),
        ));
    }
    stream.set_nonblocking(true)?;
    if let Err(error) = rustix::net::sockopt::set_socket_send_buffer_size(stream, SEND_BUFFER) {
        tracing::debug!(%error, "could not raise a connection's send buffer");
    }
    Ok(())
}

/// Whether a peer of uid `peer` is refused by a holder of uid `own`: any other user is, root
/// included, since the directory is what lets anyone in and root needs no holder's leave.
const fn refuses(peer: u32, own: u32) -> bool {
    peer != own
}

fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    use std::os::fd::AsFd as _;
    crate::process::peer_uid(stream.as_fd())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};

    use super::*;

    /// A directory of the test's own, mode 0700, under the system's temporary one.
    fn private_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bz-sock-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        dir
    }

    #[test]
    fn a_socket_path_is_absolute_names_a_file_and_fits_on_every_os() {
        assert_eq!(path_problem("/run/holders/t1.sock"), None);
        let longest = format!("/{}", "a".repeat(MAX_SOCKET_PATH - 1));
        assert_eq!(path_problem(&longest), None);
        for bad in ["t1.sock", "./t1.sock", "/run/holders/", "/"] {
            assert!(path_problem(bad).is_some(), "{bad}");
        }
        assert!(path_problem(&format!("{longest}a")).is_some());
    }

    #[test]
    fn binds_a_socket_only_its_user_may_use_and_removes_only_its_own() {
        let dir = private_dir("bind");
        let path = dir.join("t1.sock");
        let socket = Socket::bind(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(std::env::current_dir().unwrap(), Path::new("/"));
        UnixStream::connect(&path).unwrap();
        socket.remove();
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_a_directory_others_may_enter_a_symlink_or_a_file() {
        let dir = private_dir("refuse");
        let open = dir.join("open");
        std::fs::DirBuilder::new()
            .mode(0o750)
            .create(&open)
            .unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o750)).unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        let file = dir.join("file");
        File::create(&file).unwrap();
        for parent in [&open, &link, &file] {
            let refused = Socket::bind(&parent.join("t1.sock"));
            assert!(
                matches!(refused, Err(BindError::NotPrivate(_))),
                "{parent:?}: {refused:?}"
            );
        }
        assert!(!open.join("t1.lock").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_second_holder_for_a_terminal_is_refused_and_leaves_the_first_bound() {
        let dir = private_dir("twice");
        let path = dir.join("t1.sock");
        let first = Socket::bind(&path).unwrap();
        assert!(matches!(Socket::bind(&path), Err(BindError::Taken(_))));
        UnixStream::connect(&path).unwrap();
        drop(first);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaces_a_dead_holders_socket_but_nothing_else() {
        let dir = private_dir("stale");
        let path = dir.join("t1.sock");
        drop(UnixListener::bind(&path).unwrap());
        let socket = Socket::bind(&path).unwrap();
        UnixStream::connect(&path).unwrap();
        socket.remove();
        std::fs::write(&path, b"").unwrap();
        assert!(matches!(Socket::bind(&path), Err(BindError::Taken(_))));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn binds_again_once_its_socket_is_removed_and_leaves_anothers_alone() {
        let dir = private_dir("recheck");
        let path = dir.join("t1.sock");
        let mut socket = Socket::bind(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        socket.recheck();
        UnixStream::connect(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let other = UnixListener::bind(&path).unwrap();
        socket.recheck();
        socket.remove();
        assert!(path.exists(), "removed a socket that wasn't its own");
        drop(other);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_a_peer_of_any_other_user_root_included() {
        assert!(!refuses(501, 501));
        assert!(refuses(502, 501));
        assert!(refuses(0, 501));
    }

    #[test]
    fn locks_the_terminal_again_once_a_cleaner_removes_the_lock() {
        let dir = private_dir("relock");
        let path = dir.join("t1.sock");
        let mut socket = Socket::bind(&path).unwrap();
        let lock = dir.join("t1.lock");
        std::fs::remove_file(&lock).unwrap();
        socket.recheck();
        assert!(matches!(Socket::bind(&path), Err(BindError::Taken(_))));
        // A file nobody holds at the name, as a restore from backup could leave.
        std::fs::remove_file(&lock).unwrap();
        File::create(&lock).unwrap();
        socket.recheck();
        assert!(matches!(Socket::bind(&path), Err(BindError::Taken(_))));
        UnixStream::connect(&path).unwrap();
        drop(socket);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A holder that won the lock while this one had lost it, and then died, leaves its socket
    /// and an unheld lock behind: this one takes both back.
    #[test]
    fn takes_the_terminal_back_from_a_holder_that_won_its_lock_and_died() {
        let dir = private_dir("takeback");
        let path = dir.join("t1.sock");
        let lock = dir.join("t1.lock");
        let mut first = Socket::bind(&path).unwrap();
        std::fs::remove_file(&lock).unwrap();
        let second = Socket::bind(&path).unwrap();
        drop(second);
        let old = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        first.recheck();
        UnixStream::connect(&path).unwrap();
        assert!(matches!(Socket::bind(&path), Err(BindError::Taken(_))));
        let modified = std::fs::metadata(&lock).unwrap().modified().unwrap();
        assert!(
            modified > old + Duration::from_hours(24 * 365),
            "relocked but not renewed"
        );
        first.remove();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_recheck_that_finds_its_own_socket_leaves_it_and_warns_of_nothing() {
        let dir = private_dir("own");
        let path = dir.join("t1.sock");
        let mut socket = Socket::bind(&path).unwrap();
        // As after its lock was taken back: a socket that isn't its own would then be replaced.
        socket.takeover_pending = true;
        socket.recheck_with(|_, _| panic!("bound again over its own socket"));
        assert!(!socket.takeover_pending);
        socket.recheck_with(|_, _| panic!("bound again over its own socket"));
        assert!(
            !socket.replaced_seen,
            "took its own socket for something else"
        );
        socket.remove();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn says_once_that_something_else_is_at_its_path() {
        let dir = private_dir("other");
        let path = dir.join("t1.sock");
        let mut socket = Socket::bind(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, "").unwrap();
        let log = crate::test_log::logged(|| {
            socket.recheck();
            socket.recheck();
        });
        let said = log
            .matches("something else is at the socket's path")
            .count();
        assert_eq!(said, 1, "{log}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn says_once_that_it_lost_its_lock() {
        let dir = private_dir("lostlog");
        let path = dir.join("t1.sock");
        let mut first = Socket::bind(&path).unwrap();
        std::fs::remove_file(dir.join("t1.lock")).unwrap();
        let second = Socket::bind(&path).unwrap();
        let log = crate::test_log::logged(|| {
            first.recheck();
            first.recheck();
        });
        assert_eq!(log.matches("lost the terminal's lock").count(), 1, "{log}");
        drop((first, second));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keeps_trying_to_take_the_terminal_back_after_a_bind_that_failed() {
        let dir = private_dir("retry");
        let path = dir.join("t1.sock");
        let mut first = Socket::bind(&path).unwrap();
        std::fs::remove_file(dir.join("t1.lock")).unwrap();
        drop(Socket::bind(&path).unwrap());
        first.recheck_with(|_, _| Err(BindError::NotPrivate("a failed bind".to_owned())));
        assert!(UnixStream::connect(&path).is_err(), "the failed bind bound");
        first.recheck();
        UnixStream::connect(&path).unwrap();
        first.remove();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn renews_an_old_lock_file_as_it_binds() {
        let dir = private_dir("oldlock");
        let path = dir.join("t1.sock");
        let lock = dir.join("t1.lock");
        let old = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let times = std::fs::FileTimes::new()
            .set_accessed(old)
            .set_modified(old);
        File::create(&lock).unwrap().set_times(times).unwrap();
        let socket = Socket::bind(&path).unwrap();
        let meta = std::fs::metadata(&lock).unwrap();
        let recent = old + Duration::from_hours(24 * 365);
        assert!(meta.modified().unwrap() > recent);
        assert!(meta.accessed().unwrap() > recent);
        drop(socket);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_holder_that_lost_its_lock_binds_nothing() {
        let dir = private_dir("lost");
        let path = dir.join("t1.sock");
        let mut first = Socket::bind(&path).unwrap();
        std::fs::remove_file(dir.join("t1.lock")).unwrap();
        let second = Socket::bind(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        first.recheck();
        assert!(!path.exists(), "bound without the lock");
        drop(second);
        first.recheck();
        assert!(path.exists(), "never bound again once the lock was free");
        drop(first);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn renews_the_locks_times_so_a_cleaner_going_by_age_passes_it_over() {
        let dir = private_dir("touch");
        let path = dir.join("t1.sock");
        let mut socket = Socket::bind(&path).unwrap();
        let lock = dir.join("t1.lock");
        let old = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let times = std::fs::FileTimes::new()
            .set_accessed(old)
            .set_modified(old);
        File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_times(times)
            .unwrap();
        socket.renewed_at = Instant::now().checked_sub(RENEW_EVERY).unwrap();
        socket.recheck();
        let meta = std::fs::metadata(&lock).unwrap();
        let recent = old + Duration::from_hours(24 * 365);
        assert!(meta.modified().unwrap() > recent);
        assert!(meta.accessed().unwrap() > recent);
        drop(socket);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_a_lock_name_that_isnt_a_plain_file_as_taken() {
        let dir = private_dir("lockname");
        let path = dir.join("t1.sock");
        std::os::unix::fs::symlink("/etc/hosts", dir.join("t1.lock")).unwrap();
        assert!(matches!(Socket::bind(&path), Err(BindError::Taken(_))));
        std::fs::remove_file(dir.join("t1.lock")).unwrap();
        std::fs::create_dir(dir.join("t1.lock")).unwrap();
        assert!(matches!(Socket::bind(&path), Err(BindError::Taken(_))));
        std::fs::remove_dir(dir.join("t1.lock")).unwrap();
        drop(UnixListener::bind(dir.join("t1.lock")).unwrap());
        assert!(matches!(Socket::bind(&path), Err(BindError::Taken(_))));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn admits_a_connection_from_its_own_user_and_raises_its_send_buffer() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        let before = rustix::net::sockopt::socket_send_buffer_size(&ours).unwrap();
        admit(&ours).unwrap();
        assert_eq!(peer_uid(&ours).unwrap(), geteuid().as_raw());
        let after = rustix::net::sockopt::socket_send_buffer_size(&ours).unwrap();
        assert!(after > before, "the send buffer stayed at {before}");
    }
}
