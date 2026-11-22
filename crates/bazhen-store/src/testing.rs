//! What the store's tests share.

use std::path::PathBuf;

/// A directory of the test's own, removed when the test ends, whether or not it passed.
pub(crate) struct TempDir(PathBuf);

impl TempDir {
    pub(crate) fn new(name: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("bz-store-{name}-{}-{n}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    pub(crate) fn db(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // A directory left in the temp dir costs nothing a test would see.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What a snapshot is told of the daemon in a test.
pub(crate) fn view() -> crate::SnapshotView {
    crate::SnapshotView {
        host: "testhost".to_owned(),
    }
}
