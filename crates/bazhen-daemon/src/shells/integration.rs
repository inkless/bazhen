//! The snippets shells source from their rc files to report the lines they run
//! (`shells/integration.ts`), each the TypeScript daemon's own file, written where new shells are
//! told to find them.

use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::Path;

use crate::private_dir::{UnsafePrivateDir, ensure_private_dir};

/// The shells an integration snippet is written for, each in a file named after it.
pub(crate) const INTEGRATED_SHELLS: [(&str, &str); 3] = [
    (
        "zsh",
        include_str!("../../../../apps/daemon/src/shells/integration/zsh"),
    ),
    (
        "bash",
        include_str!("../../../../apps/daemon/src/shells/integration/bash"),
    ),
    (
        "fish",
        include_str!("../../../../apps/daemon/src/shells/integration/fish"),
    ),
];

/// What a new shell is told to report its lines with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Integration {
    /// The hook client the snippets run, as `BAZHEN_HOOK`.
    pub(crate) hook: String,
    /// Where the snippets are, as `BAZHEN_SHELL_INTEGRATION`.
    pub(crate) dir: String,
}

/// Why the snippets weren't written, so no shell is pointed at them.
#[derive(Debug, thiserror::Error)]
pub(crate) enum UnsafeSnippet {
    #[error(transparent)]
    Dir(#[from] UnsafePrivateDir),
    #[error("{path} can't be written: {source}")]
    Unwritten {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

/// Writes the snippets shells source from their rc files into `dir`. Whatever a snippet says,
/// every shell runs as it starts, so only this user may write one: the directory is 0700 and each
/// file 0600, both this user's. A file is written whole under another name and renamed into place,
/// so a shell starting meanwhile sources the old one or the new, never half. A directory that
/// isn't this user's, or anything but a file where a snippet goes, is refused rather than replaced.
pub(crate) fn install_shell_integration(dir: &Path, uid: u32) -> Result<(), UnsafeSnippet> {
    ensure_private_dir(dir, uid)?;
    for (shell, snippet) in INTEGRATED_SHELLS {
        let path = dir.join(shell);
        let next = dir.join(format!("{shell}.tmp"));
        let unwritten = |source| UnsafeSnippet::Unwritten {
            path: path.display().to_string(),
            source,
        };
        match std::fs::remove_file(&next) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(unwritten(err)),
            _ => {}
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&next)
            .and_then(|mut file| {
                // The umask may have taken more than group and other away.
                file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
                file.write_all(snippet.as_bytes())
            })
            .map_err(unwritten)?;
        std::fs::rename(&next, &path).map_err(unwritten)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::MetadataExt as _;

    use super::*;
    use crate::testing::TempDir;

    fn me() -> u32 {
        rustix::process::getuid().as_raw()
    }

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path).unwrap().mode() & 0o777
    }

    #[test]
    fn writes_each_snippet_this_user_s_alone_in_a_directory_only_it_can_reach() {
        let root = TempDir::new("integration-writes");
        let dir = root.path().join("shell-integration");
        install_shell_integration(&dir, me()).unwrap();
        let written: Vec<(String, u32)> = INTEGRATED_SHELLS
            .iter()
            .map(|(shell, _)| {
                let path = dir.join(shell);
                (std::fs::read_to_string(&path).unwrap(), mode(&path))
            })
            .collect();
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(names, ["bash", "fish", "zsh"]);
        assert_eq!(
            written,
            INTEGRATED_SHELLS.map(|(_, snippet)| (snippet.to_owned(), 0o600))
        );
        assert!(
            written[0].0.contains("shell-report"),
            "the zsh snippet reports its lines"
        );
    }

    #[test]
    fn puts_its_own_snippet_back_over_one_changed_and_tightens_a_directory_left_open() {
        let root = TempDir::new("integration-again");
        let dir = root.path().join("shell-integration");
        install_shell_integration(&dir, me()).unwrap();
        std::fs::write(dir.join("zsh"), "echo changed\n").unwrap();
        std::fs::set_permissions(dir.join("zsh"), std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::write(dir.join("bash.tmp"), "half").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        install_shell_integration(&dir, me()).unwrap();
        assert_eq!(
            (
                std::fs::read_to_string(dir.join("zsh")).unwrap(),
                mode(&dir.join("zsh")),
                mode(&dir),
                dir.join("bash.tmp").exists(),
            ),
            (INTEGRATED_SHELLS[0].1.to_owned(), 0o600, 0o700, false)
        );
    }

    /// The umask is the process's, but nextest runs each test in a process of its own.
    struct Umask(rustix::fs::Mode);

    impl Umask {
        fn set(mask: u32) -> Self {
            Self(rustix::process::umask(rustix::fs::Mode::from_raw_mode(
                mask,
            )))
        }
    }

    impl Drop for Umask {
        fn drop(&mut self) {
            rustix::process::umask(self.0);
        }
    }

    #[test]
    fn writes_each_snippet_0600_under_a_umask_that_takes_this_user_s_write_away() {
        let root = TempDir::new("integration-umask");
        let dir = root.path().join("shell-integration");
        let umask = Umask::set(0o277);
        install_shell_integration(&dir, me()).unwrap();
        drop(umask);
        assert_eq!(
            INTEGRATED_SHELLS.map(|(shell, _)| mode(&dir.join(shell))),
            [0o600; 3]
        );
    }

    #[test]
    fn refuses_a_snippet_s_place_taken_by_a_directory() {
        let root = TempDir::new("integration-taken");
        let dir = root.path().join("shell-integration");
        std::fs::create_dir_all(dir.join("bash/kept")).unwrap();
        let taken = install_shell_integration(&dir, me()).unwrap_err();
        assert!(
            matches!(&taken, UnsafeSnippet::Unwritten { path, .. } if path.ends_with("/bash")),
            "{taken}"
        );
        assert!(dir.join("bash/kept").is_dir(), "the directory is kept");
    }

    #[test]
    fn refuses_a_directory_not_owned_by_the_user_it_writes_for() {
        let root = TempDir::new("integration-other");
        let other = install_shell_integration(&root.path().join("other"), me() + 1).unwrap_err();
        assert!(
            matches!(&other, UnsafeSnippet::Dir(_)) && other.to_string().contains("owned by uid"),
            "{other}"
        );
    }
}
