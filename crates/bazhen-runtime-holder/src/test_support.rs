//! What this crate's tests share: temporary directories and a runtime.

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// A wait no test should reach: a test still waiting then fails rather than hangs.
const STUCK: Duration = Duration::from_secs(60);

pub(crate) fn me() -> u32 {
    rustix::process::getuid().as_raw()
}

/// A directory of the test's own under `/tmp`, short enough for a socket in it to bind, mode 0700,
/// removed when the test ends, whether or not it passed.
#[derive(Debug)]
pub(crate) struct TempDir(PathBuf);

impl TempDir {
    pub(crate) fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = PathBuf::from(format!(
            "/tmp/bz-rh-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(dir)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs `future` on a runtime of its own, failing the test once it has waited `STUCK`.
pub(crate) fn block_on<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async { tokio::time::timeout(STUCK, future).await })
        .expect("the test waited on something that never came")
}
