//! Where a home's holders bind their sockets: the `holders` directory of a private root, which is
//! the daemon's run directory, or, when a socket there would be too long to bind, the short root
//! `bazhen_client::paths::holders_dir` gives beside it (`holderRun` in
//! `apps/daemon/src/config/paths.ts`). Each is made this user's alone before a holder binds in it.

use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use bazhen_holder_proto::body::TerminalId;
use bazhen_host_guard::holder::{holder_socket, holders_dir};

/// The root a home's holders bind under, as `StartHolderOptions::root` takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolderRoot(PathBuf);

/// A directory that can't hold holders' sockets: one this user doesn't own, or a link that could
/// send them elsewhere. Refused, never repaired.
#[derive(Debug, thiserror::Error)]
#[error("refusing {} for holder sockets: {why}", .dir.display())]
pub struct UnsafeHolderDir {
    pub dir: PathBuf,
    pub why: String,
    #[source]
    pub source: Option<std::io::Error>,
}

impl HolderRoot {
    /// The root for the daemon whose run directory is `run`, for the user `uid`: `run` itself,
    /// or the short root when a terminal's socket under `run` would be too long to bind.
    pub fn of(run: &Path, uid: u32) -> Self {
        let holders = bazhen_client::paths::holders_dir(run, uid);
        Self(
            holders
                .parent()
                .map_or_else(|| run.to_path_buf(), Path::to_path_buf),
        )
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// The one directory the holders bind in.
    pub fn holders_dir(&self) -> PathBuf {
        holders_dir(&self.0)
    }

    /// The socket of the holder for `terminal_id`.
    pub fn socket(&self, terminal_id: &TerminalId) -> PathBuf {
        holder_socket(&self.0, terminal_id.as_str())
    }

    /// Makes the root and its holders directory, mode 0700, or tightens them to that, so only
    /// `uid` can reach a holder's socket. The short root sits in `/tmp`, where anyone could have
    /// made it first: one `uid` doesn't own is refused.
    ///
    /// # Errors
    ///
    /// When either can't be made, belongs to another user, or is a symlink.
    pub fn make_private(&self, uid: u32) -> Result<(), UnsafeHolderDir> {
        private_dir(&self.0, uid)?;
        private_dir(&self.holders_dir(), uid)
    }
}

/// `ensurePrivateDir` in `apps/daemon/src/config/private-dir.ts`.
fn private_dir(dir: &Path, uid: u32) -> Result<(), UnsafeHolderDir> {
    let refuse = |why: &str, source: Option<std::io::Error>| UnsafeHolderDir {
        dir: dir.to_path_buf(),
        why: why.to_owned(),
        source,
    };
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| refuse("it cannot be created", Some(e)))?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| refuse("it cannot be read", Some(e)))?;
    if meta.file_type().is_symlink() {
        return Err(refuse("it is a symlink", None));
    }
    if !meta.is_dir() {
        return Err(refuse("it isn't a directory", None));
    }
    if meta.uid() != uid {
        return Err(refuse(&format!("it is owned by uid {}", meta.uid()), None));
    }
    if meta.mode() & 0o777 != 0o700 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| refuse("it cannot be made private", Some(e)))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::test_support::{TempDir, me};

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().mode() & 0o777
    }

    #[test]
    fn binds_in_the_run_directory_when_a_socket_there_is_short_enough() {
        let root = HolderRoot::of(Path::new("/run/user/1000/bazhen"), 1000);
        let terminal = TerminalId::new("term_0123").unwrap();
        assert_eq!(
            (root.path(), root.socket(&terminal)),
            (
                Path::new("/run/user/1000/bazhen"),
                PathBuf::from("/run/user/1000/bazhen/holders/term_0123.sock")
            )
        );
    }

    #[test]
    fn binds_under_the_short_root_when_the_run_directory_is_too_long() {
        let run = format!("/home/someone/{}/run", "deep/".repeat(12));
        let root = HolderRoot::of(Path::new(&run), 1000);
        let short = bazhen_client::paths::holders_dir(Path::new(&run), 1000);
        assert!(
            root.path()
                .to_string_lossy()
                .starts_with("/tmp/bazhen-holders-1000-"),
            "{root:?}"
        );
        assert_eq!(root.holders_dir(), short);
    }

    #[test]
    fn makes_the_root_and_its_holders_directory_this_user_s_alone() {
        let dir = TempDir::new();
        let root = HolderRoot(dir.path().join("run"));
        std::fs::create_dir(root.path()).unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        root.make_private(me()).unwrap();
        assert_eq!(
            (mode(root.path()), mode(&root.holders_dir())),
            (0o700, 0o700)
        );
    }

    #[test]
    fn refuses_a_root_that_is_a_link_or_another_user_s() {
        let dir = TempDir::new();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let link = HolderRoot(dir.path().join("link"));
        symlink(&elsewhere, link.path()).unwrap();
        let linked = link.make_private(me()).unwrap_err();
        let foreign = HolderRoot(elsewhere.clone())
            .make_private(me() + 1)
            .unwrap_err();
        assert_eq!(
            (linked.why.as_str(), foreign.why),
            ("it is a symlink", format!("it is owned by uid {}", me()))
        );
        assert!(!elsewhere.join("holders").exists());
    }
}
