//! What the crate's tests share.

use std::fs::File;
use std::path::{Path, PathBuf};

use bazhen_client::paths::lock_of;
use rustix::fs::{FlockOperation, flock};

/// A directory of the test's own, removed when the guard drops. `name` tells one test's from
/// another's, so tests of one process don't share one.
pub(crate) struct Dir(pub(crate) PathBuf);

impl Dir {
    pub(crate) fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("bz-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub(crate) fn socket(&self) -> PathBuf {
        self.0.join("bazhen.sock")
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Holds the lock beside `socket` as a daemon does: exclusively, on a file of its own.
pub(crate) fn hold(socket: &Path) -> File {
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
