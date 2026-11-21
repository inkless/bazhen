//! What the daemon's tests share.

use std::path::{Path, PathBuf};

/// A directory of the test's own, removed when the test ends, whether or not it passed.
pub(crate) struct TempDir(PathBuf);

impl TempDir {
    pub(crate) fn new(name: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("bz-daemon-{name}-{}-{n}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // A directory left in the temp dir costs nothing a test would see.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// A runtime whose clock moves only as its timers come due, once nothing else can run.
pub(crate) fn paused() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap()
}

/// A listener at a socket that never accepts, its one-place backlog taken by a connection of its
/// own, so a connect there waits as it would on a daemon stuck with a full backlog. Linux only:
/// macOS refuses such a connect, as it does one to a socket nothing listens on.
#[cfg(target_os = "linux")]
pub(crate) struct FullBacklog {
    _listener: std::os::unix::net::UnixListener,
    _queued: std::os::unix::net::UnixStream,
}

#[cfg(target_os = "linux")]
impl FullBacklog {
    pub(crate) fn at(socket: &Path) -> Self {
        use rustix::net::{
            AddressFamily, SocketAddrUnix, SocketType, bind, listen, socket as open,
        };
        let fd = open(AddressFamily::UNIX, SocketType::STREAM, None).unwrap();
        bind(&fd, &SocketAddrUnix::new(socket).unwrap()).unwrap();
        listen(&fd, 0).unwrap();
        Self {
            _listener: std::os::unix::net::UnixListener::from(fd),
            _queued: std::os::unix::net::UnixStream::connect(socket).unwrap(),
        }
    }
}
