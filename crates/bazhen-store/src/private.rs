//! `keepPrivate` from store.ts: the database and its journals readable and writable by this user
//! only, as they hold what no other user may read.

use std::path::{Path, PathBuf};

use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

use rustix::io::Errno;

use crate::OpenError;

/// Makes the database at `path`, and the journals beside it, mode 0600. `SQLite` makes a journal
/// with the database's mode, so a new database is made 0600, and one made before is tightened with
/// the journals a daemon killed mid-write leaves. Each file is changed through a descriptor opened
/// without following a symlink, so one planted in its place can't redirect the change, and
/// non-blocking, so a FIFO there fails the open rather than wait for a reader. Anything but a
/// regular file `uid` owns is refused rather than taken over.
pub(crate) fn keep_private(path: &Path, uid: u32) -> Result<(), OpenError> {
    let journal = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    // Not following a symlink, and not waiting on a FIFO's reader.
    let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK;
    for file in [path.to_owned(), journal("-wal"), journal("-shm")] {
        let refuse = |reason: String| OpenError::Unsafe {
            path: file.clone(),
            reason,
        };
        let database = file == path;
        let opened = std::fs::OpenOptions::new()
            .write(true)
            .create(database)
            .append(database)
            .mode(0o600)
            .custom_flags(flags)
            .open(&file);
        let handle = match opened {
            Ok(handle) => handle,
            Err(err) => match err.raw_os_error().map(Errno::from_raw_os_error) {
                // A journal SQLite hasn't made yet will be made with the database's mode.
                Some(Errno::NOENT) if !database => continue,
                Some(Errno::LOOP) => return Err(refuse("it is a symlink".into())),
                Some(Errno::NXIO | Errno::ISDIR) => {
                    return Err(refuse("it is not a regular file".into()));
                }
                _ => return Err(err.into()),
            },
        };
        let meta = handle.metadata()?;
        if !meta.is_file() {
            return Err(refuse("it is not a regular file".into()));
        }
        if meta.uid() != uid {
            return Err(refuse(format!("it is owned by uid {}", meta.uid())));
        }
        handle.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use rustix::fs::{FileType, Mode};

    use super::*;

    /// A directory of the test's own, removed when the test ends, whether or not it passed.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("bz-store-{name}-{}-{n}", std::process::id()));
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

    fn me() -> u32 {
        rustix::process::getuid().as_raw()
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn reason(result: Result<(), OpenError>) -> String {
        match result {
            Err(OpenError::Unsafe { reason, .. }) => reason,
            other => panic!("not refused as unsafe: {other:?}"),
        }
    }

    #[test]
    fn makes_a_new_database_0600_and_tightens_an_old_one_with_its_journals() {
        let dir = TempDir::new("modes");
        let fresh = dir.0.join("fresh.db");
        let old = dir.0.join("old.db");
        for file in ["old.db", "old.db-wal", "old.db-shm"] {
            let file = dir.0.join(file);
            std::fs::write(&file, "").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        keep_private(&fresh, me()).unwrap();
        keep_private(&old, me()).unwrap();
        assert_eq!(
            ["fresh.db", "old.db", "old.db-wal", "old.db-shm"].map(|f| mode(&dir.0.join(f))),
            [0o600; 4]
        );
        assert!(!dir.0.join("fresh.db-wal").exists());
    }

    #[test]
    fn refuses_a_symlink_in_any_files_place_changing_nothing_it_points_at() {
        let dir = TempDir::new("symlink");
        let target = dir.0.join("target");
        std::fs::write(&target, "").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        let db = dir.0.join("a.db");
        let wal = dir.0.join("b.db-wal");
        symlink(&target, &db).unwrap();
        symlink(&target, &wal).unwrap();
        assert_eq!(
            [
                reason(keep_private(&db, me())),
                reason(keep_private(&dir.0.join("b.db"), me()))
            ],
            ["it is a symlink", "it is a symlink"]
        );
        assert_eq!(mode(&target), 0o644);
    }

    #[test]
    fn refuses_a_fifo_a_directory_or_a_device_at_once() {
        let dir = TempDir::new("kinds");
        let fifo = dir.0.join("f.db-wal");
        rustix::fs::mknodat(
            rustix::fs::CWD,
            &fifo,
            FileType::Fifo,
            Mode::from_raw_mode(0o600),
            0,
        )
        .unwrap();
        std::fs::create_dir(dir.0.join("d.db")).unwrap();
        assert_eq!(
            [
                reason(keep_private(&dir.0.join("f.db"), me())),
                reason(keep_private(&dir.0.join("d.db"), me())),
                reason(keep_private(Path::new("/dev/null"), me())),
            ],
            ["it is not a regular file"; 3]
        );
    }

    #[test]
    fn refuses_a_file_another_user_owns() {
        let dir = TempDir::new("owner");
        let db = dir.0.join("a.db");
        let other = me() + 1;
        assert_eq!(
            reason(keep_private(&db, other)),
            format!("it is owned by uid {}", me())
        );
    }

    #[test]
    fn says_which_file_it_refused_and_why() {
        let err = OpenError::Unsafe {
            path: "/h/bazhen.db-wal".into(),
            reason: "it is a symlink".into(),
        };
        assert_eq!(
            err.to_string(),
            "refusing to open /h/bazhen.db-wal as Bazhen's database: it is a symlink"
        );
    }
}
