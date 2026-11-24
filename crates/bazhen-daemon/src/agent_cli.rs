//! The `bazhen` agents run (`env/agent-cli.ts`), beside the one built with this daemon: a
//! different one is another build, which the agents' commands can't be sure to speak the
//! daemon's protocol with.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};

use bazhen_protocol::daemon::AgentCli;
use rustix::fs::{Access, access};

use crate::env::Env;

/// What doctor reads the agents' `bazhen` from: the captured environment's `PATH` and `HOME`, and
/// the CLI built beside the daemon.
#[derive(Debug, Clone)]
pub(crate) struct Lookup {
    path: Option<OsString>,
    home: Option<OsString>,
    built: PathBuf,
}

impl Lookup {
    /// The agents' `bazhen` as `env`, the environment captured for them, finds it, beside the CLI
    /// built beside `exe`, the daemon.
    pub(crate) fn of(env: &Env, exe: &Path) -> Self {
        let var = |name: &str| env.get(OsStr::new(name)).cloned();
        Self {
            path: var("PATH"),
            home: var("HOME"),
            built: exe
                .parent()
                .unwrap_or_else(|| Path::new("/"))
                .join("bazhen"),
        }
    }

    /// The first `bazhen` on the `PATH`, as a shell finds it, and the build, each resolved
    /// through links, so a link to the build is the build and a copy is not. A relative `PATH`
    /// entry means the agent's own directory, which isn't known here, so it is skipped.
    pub(crate) fn read(&self) -> AgentCli {
        let home = self.home.as_deref();
        let on_path = self
            .path
            .as_deref()
            .map_or(&[][..], OsStr::as_bytes)
            .split(|&b| b == b':')
            .map(|entry| expanded(OsStr::from_bytes(entry), home))
            .filter(|dir| dir.is_absolute())
            .find_map(|dir| runnable(&dir.join("bazhen")));
        AgentCli {
            expected: runnable(&self.built),
            on_path,
        }
    }
}

/// `file` as a shell would run it, resolved through links; none for anything it would skip.
fn runnable(file: &Path) -> Option<String> {
    let found = std::fs::metadata(file).ok()?;
    if !found.is_file() || access(file, Access::EXEC_OK).is_err() {
        return None;
    }
    let real = std::fs::canonicalize(file).ok()?;
    Some(real.to_string_lossy().into_owned())
}

/// `entry` as bash reads a `PATH` entry: a leading `~` is the home directory, when that is
/// absolute.
fn expanded(entry: &OsStr, home: Option<&OsStr>) -> PathBuf {
    let entry = Path::new(entry);
    let Some(home) = home.map(Path::new).filter(|home| home.is_absolute()) else {
        return entry.to_owned();
    };
    // Only a whole first component of `~` is one: `~user` is left as it is.
    entry
        .strip_prefix("~")
        .map_or_else(|_| entry.to_owned(), |rest| home.join(rest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;
    use std::os::unix::fs::{PermissionsExt as _, symlink};

    struct Root {
        _dir: TempDir,
        path: PathBuf,
        built: PathBuf,
    }

    fn root() -> Root {
        let dir = TempDir::new("agent-cli");
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let release = root.join("target/release");
        std::fs::create_dir_all(&release).unwrap();
        let built = release.join("bazhen");
        std::fs::write(&built, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&built, std::fs::Permissions::from_mode(0o755)).unwrap();
        Root {
            _dir: dir,
            path: root,
            built,
        }
    }

    impl Root {
        fn dir(&self, name: &str) -> PathBuf {
            let path = self.path.join(name);
            std::fs::create_dir(&path).unwrap();
            path
        }

        fn read(&self, vars: &[(&str, &str)]) -> AgentCli {
            read_beside(vars, &self.built)
        }
    }

    /// What doctor reads for `vars` from a daemon beside `built`.
    fn read_beside(vars: &[(&str, &str)], built: &Path) -> AgentCli {
        let env: Env = vars
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect();
        Lookup::of(&env, &built.with_file_name("bazhen-daemon")).read()
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn is_the_daemons_build_when_a_link_on_the_path_points_at_it() {
        let root = root();
        let bin = root.dir("bin");
        symlink(&root.built, bin.join("bazhen")).unwrap();
        let path = format!("/usr/nonexistent:{}", bin.display());
        assert_eq!(
            root.read(&[("PATH", &path)]),
            AgentCli {
                expected: Some(text(&root.built)),
                on_path: Some(text(&root.built)),
            }
        );
    }

    #[test]
    fn reads_a_leading_tilde_in_a_path_entry_as_the_captured_home_as_bash_does() {
        let root = root();
        let bin = root.dir("bin");
        symlink(&root.built, bin.join("bazhen")).unwrap();
        let home = root.path.to_string_lossy().into_owned();
        assert_eq!(
            [
                root.read(&[("PATH", "~/bin"), ("HOME", &home)]).on_path,
                root.read(&[("PATH", "~/bin")]).on_path,
                root.read(&[("PATH", "~/bin"), ("HOME", "home")]).on_path,
            ],
            [Some(text(&root.built)), None, None]
        );
    }

    #[test]
    fn is_another_build_when_the_path_holds_a_copy() {
        let root = root();
        let bin = root.dir("bin");
        std::fs::copy(&root.built, bin.join("bazhen")).unwrap();
        assert_eq!(
            root.read(&[("PATH", &bin.to_string_lossy())]),
            AgentCli {
                expected: Some(text(&root.built)),
                on_path: Some(text(&bin.join("bazhen"))),
            }
        );
    }

    #[test]
    fn is_the_first_of_two_on_the_path_as_a_shell_finds_it() {
        let root = root();
        let first = root.dir("first");
        let second = root.dir("second");
        std::fs::copy(&root.built, first.join("bazhen")).unwrap();
        symlink(&root.built, second.join("bazhen")).unwrap();
        let path = format!("{}:{}", first.display(), second.display());
        assert_eq!(
            root.read(&[("PATH", &path)]).on_path,
            Some(text(&first.join("bazhen")))
        );
    }

    #[test]
    fn skips_what_a_shell_would_a_file_that_cant_run_a_dangling_link_a_directory() {
        let root = root();
        let plain = root.dir("plain");
        std::fs::write(plain.join("bazhen"), "").unwrap();
        std::fs::set_permissions(plain.join("bazhen"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        let dangling = root.dir("dangling");
        symlink(root.path.join("missing"), dangling.join("bazhen")).unwrap();
        let folder = root.dir("folder");
        std::fs::create_dir(folder.join("bazhen")).unwrap();
        let good = root.dir("good");
        symlink(&root.built, good.join("bazhen")).unwrap();
        let path = [plain, dangling, folder, good]
            .map(|dir| dir.to_string_lossy().into_owned())
            .join(":");
        assert_eq!(
            root.read(&[("PATH", &path)]).on_path,
            Some(text(&root.built))
        );
    }

    #[test]
    fn is_none_when_the_path_is_unset_empty_relative_or_holds_no_bazhen() {
        let root = root();
        let bin = root.dir("bin");
        symlink(&root.built, bin.join("bazhen")).unwrap();
        let empty = root.dir("empty").to_string_lossy().into_owned();
        let relative = bin
            .strip_prefix("/")
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let found: Vec<_> = [
            vec![],
            vec![("PATH", "")],
            vec![("PATH", relative.as_str())],
            vec![("PATH", empty.as_str())],
        ]
        .iter()
        .map(|vars| root.read(vars).on_path)
        .collect();
        assert_eq!(found, [None, None, None, None]);
    }

    #[test]
    fn says_no_build_is_beside_the_daemon_when_none_was_built() {
        let root = root();
        let missing = root.path.join("missing/bazhen");
        assert_eq!(
            read_beside(&[("PATH", "")], &missing),
            AgentCli {
                expected: None,
                on_path: None,
            }
        );
    }
}
