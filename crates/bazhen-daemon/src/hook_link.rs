//! The hook client agents and shells run (`mailbox/hook-link.ts`): a copy of the build under its
//! content's hash, which no rebuild or move of the checkout touches, reached through a hard link
//! each start points at it.

use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use bazhen_runtime_holder::{InstallOptions, install_holder, prune_holder_builds};

use crate::private_dir::ensure_private_dir;

const HOOK_COMMAND: &str = "bazhen-hook";

/// The hook client built beside the daemon at `exe`, if one is.
pub(crate) fn built_beside(exe: &Path) -> Option<PathBuf> {
    let built = exe.parent()?.join(HOOK_COMMAND);
    built.is_file().then_some(built)
}

/// Where in `dir` a start links the hook client, whether or not one is built.
pub(crate) fn link_in(dir: &Path) -> PathBuf {
    dir.join(HOOK_COMMAND)
}

/// The hook client as a start installed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstalledHook {
    /// What hooks are given to run.
    pub(crate) path: PathBuf,
    /// The file `path` runs.
    pub(crate) client: PathBuf,
}

/// A path in `dir` that runs `client`, for hooks that outlive this daemon: running agents and
/// shells keep the path they were given, and each start points it at wherever the client now is.
/// It is a hard link, renamed over the old one, so a hook running meanwhile never finds the path
/// missing: the name is always there, and it names a file, never a link to follow. A symbolic link
/// renamed over can't promise that, since on macOS a reader following the old one as it is
/// replaced fails with EINVAL. `dir` must be private to `uid`, since whoever can write it chooses
/// what every hook runs. Where it can't be made, as across file systems, `client` itself, said.
fn stable_link(dir: &Path, client: &Path, uid: u32) -> PathBuf {
    let link = link_in(dir);
    let next = dir.join(format!("{HOOK_COMMAND}.tmp"));
    let made = ensure_private_dir(dir, uid)
        .map_err(|err| err.to_string())
        .and_then(|()| relink(client, &next, &link).map_err(|err| err.to_string()));
    match made {
        Ok(()) => link,
        Err(err) => {
            tracing::warn!(
                "hooks run {} by its own path, which a move breaks: {err}",
                client.display()
            );
            client.to_owned()
        }
    }
}

/// Points `link` at `client` through a new hard link at `next`, renamed over it.
fn relink(client: &Path, next: &Path, link: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(next) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err),
        _ => {}
    }
    std::fs::hard_link(client, next)?;
    std::fs::rename(next, link)
}

/// The build in `dir` that `link` is a hard link to, if it is one: the one whose copy is the same
/// file.
fn linked_build(link: &Path, dir: &Path) -> Option<String> {
    let file = |path: &Path| {
        std::fs::symlink_metadata(path)
            .ok()
            .filter(std::fs::Metadata::is_file)
            .map(|meta| (meta.dev(), meta.ino()))
    };
    let linked = file(link)?;
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|entry| file(&entry.path().join(HOOK_COMMAND)) == Some(linked))
        .and_then(|entry| entry.file_name().to_str().map(str::to_owned))
}

/// Installs `source` in `dir` under its content's hash and points the link at that copy. Once
/// the link is made, hooks reach a build only through it, so the builds it no longer names are
/// removed. Where no link can be made, hooks are given the copy by its own path, which a later
/// start can't tell is in use, so nothing is removed.
pub(crate) fn install_hook_client(source: &Path, dir: &Path, uid: u32) -> InstalledHook {
    install_with(source, dir, uid, || {})
}

/// [`install_hook_client`], calling `before_prune` once the link is made, before the builds it
/// doesn't name are removed.
fn install_with(source: &Path, dir: &Path, uid: u32, before_prune: impl FnOnce()) -> InstalledHook {
    // Tightened first: the install refuses a directory others may write, and never repairs one.
    let installed = ensure_private_dir(dir, uid)
        .map_err(|err| err.to_string())
        .and_then(|()| {
            install_holder(&InstallOptions {
                source: source.to_owned(),
                command: HOOK_COMMAND.to_owned(),
                dir: dir.to_owned(),
                uid,
            })
            .map_err(|err| err.to_string())
        });
    let installed = match installed {
        Ok(installed) => Some(installed),
        Err(reason) => {
            tracing::warn!("hooks run {} from the checkout: {reason}", source.display());
            None
        }
    };
    let client = installed
        .as_ref()
        .map_or_else(|| source.to_owned(), |installed| installed.binary.clone());
    let path = stable_link(dir, &client, uid);
    if let Some(installed) = &installed
        && path != client
    {
        before_prune();
        // Another start on this state may have pointed the link at its own build since.
        let keep: BTreeSet<String> = [Some(installed.build.clone()), linked_build(&path, dir)]
            .into_iter()
            .flatten()
            .collect();
        let removed = prune_holder_builds(dir, uid, &keep, SystemTime::now());
        if !removed.is_empty() {
            tracing::info!(
                "removed hook client builds nothing names: {}",
                removed.join(", ")
            );
        }
    }
    InstalledHook { path, client }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shells::tests::Said;
    use crate::testing::TempDir;
    use bazhen_runtime_holder::FRESH;
    use std::os::unix::fs::{PermissionsExt as _, symlink};
    use std::sync::atomic::{AtomicBool, Ordering};

    fn uid() -> u32 {
        rustix::process::getuid().as_raw()
    }

    struct Clients {
        _dir: TempDir,
        root: PathBuf,
        first: PathBuf,
        second: PathBuf,
    }

    fn dir() -> Clients {
        let dir = TempDir::new("hook-link");
        let root = dir.path().to_owned();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (first, second) = (root.join("first-client"), root.join("second-client"));
        std::fs::write(&first, "").unwrap();
        std::fs::write(&second, "").unwrap();
        Clients {
            _dir: dir,
            root,
            first,
            second,
        }
    }

    /// Which file `path` is, by its device and inode.
    fn file(path: &Path) -> (u64, u64) {
        let meta = std::fs::metadata(path).unwrap();
        (meta.dev(), meta.ino())
    }

    #[test]
    fn names_the_client_through_a_link_the_next_start_points_at_a_moved_client() {
        let d = dir();
        let path = stable_link(&d.root, &d.first, uid());
        let before = file(&path);
        assert_eq!(stable_link(&d.root, &d.second, uid()), path);
        assert_eq!([before, file(&path)], [file(&d.first), file(&d.second)]);
    }

    #[test]
    fn never_leaves_the_link_missing_while_it_is_pointed_somewhere_else() {
        let d = dir();
        let path = stable_link(&d.root, &d.first, uid());
        let said = Said::default();
        let _logging = said.logging();
        let done = AtomicBool::new(false);
        let misses = std::thread::scope(|scope| {
            let probe = scope.spawn(|| {
                let mut misses = 0;
                while !done.load(Ordering::Relaxed) {
                    if !path.exists() {
                        misses += 1;
                    }
                }
                misses
            });
            for i in 0..2_000 {
                stable_link(
                    &d.root,
                    if i % 2 == 0 { &d.second } else { &d.first },
                    uid(),
                );
            }
            done.store(true, Ordering::Relaxed);
            probe.join().unwrap()
        });
        assert_eq!((misses, said.text()), (0, String::new()));
    }

    #[test]
    fn replaces_a_half_made_link_a_stopped_daemon_left_behind() {
        let d = dir();
        symlink(&d.first, d.root.join("bazhen-hook.tmp")).unwrap();
        let path = stable_link(&d.root, &d.second, uid());
        assert_eq!(path, d.root.join("bazhen-hook"));
        assert_eq!(file(&path), file(&d.second));
    }

    #[test]
    fn gives_back_the_client_itself_and_says_so_where_no_link_can_be_made() {
        let d = dir();
        let said = Said::default();
        let _logging = said.logging();
        let in_file = d.first.join("state");
        assert_eq!(stable_link(&in_file, &d.second, uid()), d.second);
        assert_eq!(said.times(&d.second.display().to_string()), 1);
    }

    #[test]
    fn links_nothing_in_a_directory_another_user_owns_since_its_owner_would_choose_what_runs() {
        let d = dir();
        let said = Said::default();
        let _logging = said.logging();
        let path = stable_link(&d.root, &d.second, uid() + 1);
        assert_eq!(
            (
                path,
                said.times("owned by uid"),
                d.root.join("bazhen-hook").exists()
            ),
            (d.second, 1, false)
        );
    }

    #[test]
    fn gives_back_the_client_itself_where_something_else_already_holds_the_links_name() {
        let d = dir();
        std::fs::create_dir_all(d.root.join("bazhen-hook/kept")).unwrap();
        let said = Said::default();
        let _logging = said.logging();
        assert_eq!(stable_link(&d.root, &d.second, uid()), d.second);
        assert_eq!(said.times(&d.second.display().to_string()), 1);
    }

    /// The name `install_holder` gives a build of `bytes`: its SHA-256's first 16 hex digits.
    fn build_of(bytes: &str) -> String {
        crate::tokens::hash_of(bytes).chars().take(16).collect()
    }

    /// What running `path` would run.
    fn runs(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    struct Install {
        _d: Clients,
        state: PathBuf,
        source: PathBuf,
    }

    fn installing() -> Install {
        let d = dir();
        let state = d.root.join("state/hook");
        std::fs::create_dir(d.root.join("state")).unwrap();
        std::fs::create_dir(d.root.join("checkout")).unwrap();
        let source = d.root.join("checkout/bazhen-hook");
        std::fs::write(&source, "build one").unwrap();
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o755)).unwrap();
        Install {
            _d: d,
            state,
            source,
        }
    }

    impl Install {
        fn install(&self) -> InstalledHook {
            install_hook_client(&self.source, &self.state, uid())
        }

        /// Dates every build back past the fresh window, as a start long before would.
        fn age(&self) {
            let then = SystemTime::now() - 2 * FRESH;
            for entry in std::fs::read_dir(&self.state).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.len() == 16 && name.bytes().all(|b| b.is_ascii_hexdigit()) {
                    std::fs::File::open(entry.path())
                        .unwrap()
                        .set_modified(then)
                        .unwrap();
                }
            }
        }

        fn rebuild(&self) {
            std::fs::write(&self.source, "build two").unwrap();
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<_> = std::fs::read_dir(&self.state)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    #[test]
    fn keeps_hooks_running_once_the_checkouts_client_is_deleted() {
        let i = installing();
        let InstalledHook { path, client } = i.install();
        std::fs::remove_file(&i.source).unwrap();
        assert_eq!(
            (path.clone(), client, runs(&path)),
            (
                i.state.join("bazhen-hook"),
                i.state.join(build_of("build one")).join("bazhen-hook"),
                "build one".to_owned()
            )
        );
    }

    #[test]
    fn points_hooks_at_a_rebuilt_client_and_removes_the_copy_nothing_names_any_more() {
        let i = installing();
        i.install();
        i.age();
        i.rebuild();
        let InstalledHook { path, .. } = i.install();
        let mut expected = vec![build_of("build two"), "bazhen-hook".to_owned()];
        expected.sort();
        assert_eq!((runs(&path), i.names()), ("build two".to_owned(), expected));
    }

    #[test]
    fn keeps_the_build_another_start_pointed_the_link_at_while_this_one_installed_its_own() {
        let i = installing();
        let other = i.install();
        i.rebuild();
        let InstalledHook { path, .. } = install_with(&i.source, &i.state, uid(), || {
            i.age();
            stable_link(&i.state, &other.client, uid());
        });
        let mut expected = vec![
            build_of("build one"),
            build_of("build two"),
            "bazhen-hook".to_owned(),
        ];
        expected.sort();
        assert_eq!((runs(&path), i.names()), ("build one".to_owned(), expected));
    }

    #[test]
    fn keeps_a_copy_hooks_were_given_by_its_own_path_while_no_link_can_be_made() {
        let i = installing();
        std::fs::create_dir_all(i.state.join("bazhen-hook/kept")).unwrap();
        let before = i.install();
        i.age();
        i.rebuild();
        let after = i.install();
        std::fs::remove_file(&i.source).unwrap();
        assert_eq!(
            [runs(&before.path), runs(&after.path)],
            ["build one", "build two"]
        );
    }

    #[test]
    fn installs_into_a_hook_directory_an_older_start_left_open_to_its_group() {
        let i = installing();
        std::fs::create_dir(&i.state).unwrap();
        std::fs::set_permissions(&i.state, std::fs::Permissions::from_mode(0o770)).unwrap();
        let said = Said::default();
        let _logging = said.logging();
        let InstalledHook { path, .. } = i.install();
        std::fs::remove_file(&i.source).unwrap();
        assert_eq!(
            (runs(&path), said.times("hook")),
            ("build one".to_owned(), 0)
        );
    }

    /// The link is the copy itself, not a path to it: removing the build it was made from, as a
    /// prune by an older daemon that can't tell a hard link is in use would, leaves it runnable,
    /// where a symbolic link to the same copy (the control) is left naming nothing.
    #[test]
    fn keeps_hooks_running_once_the_build_the_link_was_made_from_is_removed() {
        let i = installing();
        let InstalledHook { path, client } = i.install();
        let symbolic = i.state.join("symbolic");
        symlink(&client, &symbolic).unwrap();
        std::fs::remove_dir_all(client.parent().unwrap()).unwrap();
        assert_eq!(
            [
                std::fs::read_to_string(&path).ok(),
                std::fs::read_to_string(&symbolic).ok()
            ],
            [Some("build one".to_owned()), None]
        );
    }

    /// The link hooks are given is a file only its owner may run, in a directory only its owner
    /// may enter, and running it by that path runs the client.
    #[test]
    fn runs_the_client_by_the_links_path_which_only_its_owner_may_run() {
        let i = installing();
        std::fs::write(&i.source, "#!/bin/sh\necho hooked\n").unwrap();
        let InstalledHook { path, .. } = i.install();
        let mode = |path: &Path| std::fs::symlink_metadata(path).unwrap().mode() & 0o7777;
        let out = std::process::Command::new(&path).output().unwrap();
        assert_eq!(
            (
                mode(&path),
                mode(&i.state),
                std::fs::symlink_metadata(&path).unwrap().is_file(),
                String::from_utf8_lossy(&out.stdout).into_owned()
            ),
            (0o500, 0o700, true, "hooked\n".to_owned())
        );
    }

    #[test]
    fn gives_hooks_the_checkouts_client_and_says_so_where_nothing_can_be_installed() {
        let i = installing();
        let said = Said::default();
        let _logging = said.logging();
        let installed = install_hook_client(&i.source, &i.state, uid() + 1);
        assert_eq!(
            (installed, said.times("hooks run")),
            (
                InstalledHook {
                    path: i.source.clone(),
                    client: i.source.clone(),
                },
                2
            )
        );
    }
}
