//! Whether a file or directory is this user's alone to change: theirs, no symlink, and writable
//! by no one their trust doesn't reach. Whoever else can change what a daemon runs or serves
//! chooses what it runs or serves, so it asks this before it trusts a path. Both checks read and
//! never repair: a mode or an owner is the user's to change, not the daemon's.

use std::fmt;
use std::fs::{self, Metadata};
use std::io;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Component, Path, PathBuf};

/// Who besides the owner may write what is trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writers {
    /// The owner alone.
    Owner,
    /// The owner and its group, for a place its group can already change by other means, as a
    /// checkout whose source the group may edit.
    Group,
}

impl Writers {
    /// The mode bits that let someone outside these writers write.
    const fn outside(self) -> u32 {
        match self {
            Self::Owner => 0o022,
            Self::Group => 0o002,
        }
    }
}

/// What makes an entry untrusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Untrusted {
    /// It is a symlink, which another path could take the place of.
    Symlink,
    /// It belongs to this uid, not the user's.
    Owner(u32),
    /// Someone outside the writers trusted may write it.
    Writable,
}

impl fmt::Display for Untrusted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Symlink => f.write_str("it is a symlink"),
            Self::Owner(uid) => write!(f, "it belongs to uid {uid}"),
            Self::Writable => f.write_str("other users may write it"),
        }
    }
}

/// Why the entry `meta` describes, read without following a symlink, isn't `uid`'s alone to
/// change past `writers`, or `None` when it is.
pub fn untrusted(meta: &Metadata, uid: u32, writers: Writers) -> Option<Untrusted> {
    if meta.file_type().is_symlink() {
        Some(Untrusted::Symlink)
    } else if meta.uid() != uid {
        Some(Untrusted::Owner(meta.uid()))
    } else if meta.mode() & writers.outside() != 0 {
        Some(Untrusted::Writable)
    } else {
        None
    }
}

/// A path that isn't trusted, and why.
#[derive(Debug, thiserror::Error)]
pub enum Refused {
    #[error("{} can't be read: {source}", path.display())]
    Unreadable {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{} isn't a plain path inside {}", path.display(), root.display())]
    Outside { path: PathBuf, root: PathBuf },
    #[error("{}: {why}", path.display())]
    Untrusted { path: PathBuf, why: Untrusted },
}

impl Refused {
    /// The entry refused.
    pub fn path(&self) -> &Path {
        match self {
            Self::Unreadable { path, .. }
            | Self::Outside { path, .. }
            | Self::Untrusted { path, .. } => path,
        }
    }
}

/// Why `root`, or an entry from it down to `path`, isn't `uid`'s alone to change past
/// `writers`, naming the first from the top that isn't, or `None` when none is. Each is read as
/// it is, so a symlink anywhere on the way is refused, never followed out. What is above `root`
/// isn't read: it is where `root` was found, which the caller already trusts.
pub fn ancestry_refusal(path: &Path, root: &Path, uid: u32, writers: Writers) -> Option<Refused> {
    let outside = || Refused::Outside {
        path: path.to_path_buf(),
        root: root.to_path_buf(),
    };
    let Ok(below) = path.strip_prefix(root) else {
        return Some(outside());
    };
    let mut at = root.to_path_buf();
    let mut entries = vec![at.clone()];
    for part in below.components() {
        let Component::Normal(name) = part else {
            return Some(outside());
        };
        at.push(name);
        entries.push(at.clone());
    }
    entries
        .into_iter()
        .find_map(|path| match fs::symlink_metadata(&path) {
            Err(source) => Some(Refused::Unreadable { path, source }),
            Ok(meta) => untrusted(&meta, uid, writers).map(|why| Refused::Untrusted { path, why }),
        })
}

#[cfg(test)]
mod tests {
    use std::fs::Permissions;
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    /// A directory of its own under the temp dir, removed once the test is done.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("bz-fs-trust-{}-{n}", std::process::id()));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// This process's uid: the owner of what it makes.
    fn me() -> u32 {
        fs::metadata(&TempDir::new().0).unwrap().uid()
    }

    fn mode(path: &Path, mode: u32) {
        fs::set_permissions(path, Permissions::from_mode(mode)).unwrap();
    }

    /// `root/a/b/c`, each directory with `modes` in turn, `root`'s first.
    fn chain(dir: &TempDir, modes: [u32; 4]) -> (PathBuf, PathBuf) {
        let root = dir.0.join("root");
        let path = root.join("a/b/c");
        fs::create_dir_all(&path).unwrap();
        for (entry, m) in [&root, &root.join("a"), &root.join("a/b"), &path]
            .into_iter()
            .zip(modes)
        {
            mode(entry, m);
        }
        (root, path)
    }

    fn refused(refusal: Option<Refused>) -> Option<(PathBuf, String)> {
        refusal.map(|r| (r.path().to_path_buf(), r.to_string()))
    }

    #[test]
    fn trusts_a_chain_no_one_else_may_write_and_one_only_its_group_may_where_the_group_is_trusted()
    {
        let dir = TempDir::new();
        let (root, path) = chain(&dir, [0o755, 0o750, 0o700, 0o755]);
        let other = TempDir::new();
        let (shared_root, shared) = chain(&other, [0o775, 0o775, 0o770, 0o775]);
        assert_eq!(
            [
                refused(ancestry_refusal(&path, &root, me(), Writers::Owner)),
                refused(ancestry_refusal(
                    &shared,
                    &shared_root,
                    me(),
                    Writers::Group
                )),
            ],
            [None, None]
        );
    }

    #[test]
    fn refuses_the_first_directory_on_the_way_down_that_someone_outside_the_writers_may_write() {
        let dir = TempDir::new();
        let (root, path) = chain(&dir, [0o755, 0o775, 0o757, 0o755]);
        assert_eq!(
            [Writers::Owner, Writers::Group].map(|w| refused(ancestry_refusal(
                &path,
                &root,
                me(),
                w
            ))),
            [
                Some((
                    root.join("a"),
                    format!("{}: other users may write it", root.join("a").display())
                )),
                Some((
                    root.join("a/b"),
                    format!("{}: other users may write it", root.join("a/b").display())
                )),
            ]
        );
    }

    #[test]
    fn refuses_a_chain_another_uid_owns_starting_at_its_root() {
        let dir = TempDir::new();
        let (root, path) = chain(&dir, [0o755; 4]);
        let other = me() + 1;
        assert_eq!(
            refused(ancestry_refusal(&path, &root, other, Writers::Group)),
            Some((
                root.clone(),
                format!("{}: it belongs to uid {}", root.display(), me())
            ))
        );
    }

    #[test]
    fn refuses_a_symlink_on_the_way_rather_than_following_it_out() {
        let dir = TempDir::new();
        let (root, _) = chain(&dir, [0o755; 4]);
        let elsewhere = TempDir::new();
        mode(&elsewhere.0, 0o755);
        std::os::unix::fs::symlink(&elsewhere.0, root.join("a/out")).unwrap();
        let path = root.join("a/out");
        assert_eq!(
            refused(ancestry_refusal(&path, &root, me(), Writers::Group)),
            Some((path.clone(), format!("{}: it is a symlink", path.display())))
        );
    }

    #[test]
    fn refuses_a_path_outside_its_root_or_one_that_climbs_and_one_that_isnt_there() {
        let dir = TempDir::new();
        let (root, path) = chain(&dir, [0o755; 4]);
        let found = [
            ancestry_refusal(&dir.0, &root, me(), Writers::Group),
            ancestry_refusal(&root.join("a/../a/b"), &root, me(), Writers::Group),
            ancestry_refusal(&path.join("gone"), &root, me(), Writers::Group),
        ];
        assert!(
            matches!(
                found,
                [
                    Some(Refused::Outside { .. }),
                    Some(Refused::Outside { .. }),
                    Some(Refused::Unreadable { .. }),
                ]
            ),
            "{found:?}"
        );
    }

    #[test]
    fn calls_a_file_untrusted_for_a_group_write_only_where_the_group_isnt_trusted() {
        let dir = TempDir::new();
        let file = dir.0.join("f");
        fs::write(&file, "x").unwrap();
        mode(&file, 0o664);
        let meta = fs::symlink_metadata(&file).unwrap();
        assert_eq!(
            [
                untrusted(&meta, me(), Writers::Owner),
                untrusted(&meta, me(), Writers::Group),
            ],
            [Some(Untrusted::Writable), None]
        );
    }
}
