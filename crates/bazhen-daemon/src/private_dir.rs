//! `config/private-dir.ts`: a directory only this user can reach, for the daemon's socket.

use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::Path;

/// Why a directory can't be the daemon's private one.
#[derive(Debug, thiserror::Error)]
#[error("refusing to use {path} as a private directory: {reason}")]
pub(crate) struct UnsafePrivateDir {
    path: String,
    reason: String,
}

/// Creates `path` mode 0700, or tightens it to that, so only this user can reach what is in it.
/// Anything `uid` doesn't own, or a symlink that could redirect what is in it, is refused rather
/// than repaired.
pub(crate) fn ensure_private_dir(path: &Path, uid: u32) -> Result<(), UnsafePrivateDir> {
    let refuse = |reason: String| UnsafePrivateDir {
        path: path.display().to_string(),
        reason,
    };
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|_| refuse("it cannot be created".into()))?;
    let meta =
        std::fs::symlink_metadata(path).map_err(|_| refuse("it cannot be created".into()))?;
    if meta.file_type().is_symlink() {
        return Err(refuse("it is a symlink".into()));
    }
    if meta.uid() != uid {
        return Err(refuse(format!("it is owned by uid {}", meta.uid())));
    }
    if meta.mode() & 0o777 != 0o700 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| refuse("it cannot be made private".into()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> u32 {
        rustix::process::getuid().as_raw()
    }

    /// A directory of the test's own, removed when the test ends, whether or not it passed.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("bz-daemon-{name}-{}-{n}", std::process::id()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            // A directory left in the temp dir costs nothing a test would see.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn makes_a_new_directory_0700_and_tightens_an_old_one() {
        let dir = TempDir::new("private");
        let new = dir.0.join("a/run");
        let old = dir.0.join("old");
        std::fs::create_dir(&old).unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&new, me()).unwrap();
        ensure_private_dir(&old, me()).unwrap();
        assert_eq!([mode(&new), mode(&old)], [0o700, 0o700]);
    }

    #[test]
    fn refuses_a_symlink_or_another_users_directory() {
        let dir = TempDir::new("refused");
        let target = dir.0.join("target");
        std::fs::create_dir(&target).unwrap();
        let link = dir.0.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(
            [
                ensure_private_dir(&link, me()).unwrap_err().to_string(),
                ensure_private_dir(&target, me() + 1)
                    .unwrap_err()
                    .to_string(),
            ],
            [
                format!(
                    "refusing to use {} as a private directory: it is a symlink",
                    link.display()
                ),
                format!(
                    "refusing to use {} as a private directory: it is owned by uid {}",
                    target.display(),
                    me()
                ),
            ]
        );
    }
}
