//! Installs the built `bazhen-holder` where the daemon runs it from, as `install.ts` does: a
//! directory named by the binary's content, which nothing writes again once it is there. A holder
//! runs for as long as its terminal does, so the next build installs beside it, never over it,
//! and the old directory goes only once no holder runs it and it is older than `FRESH`.
//!
//! Every call here blocks on the filesystem: the daemon runs it off its runtime.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::hash::{BuildHasher as _, Hasher as _, RandomState};
use std::io;
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bazhen_client::sha256::{hex, sha256};
use bazhen_host_guard::holder::{
    HOLDER_COMMAND, HolderProcess, HolderUse, holder_build_of, is_holder_build, vouch,
};

/// How old a directory must be before a prune may remove it: younger, it may be another start's
/// install, still copying, or a build it has just installed and not yet started a holder from.
pub const FRESH: Duration = Duration::from_mins(10);

/// What `install_holder` installs, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallOptions {
    /// The built binary.
    pub source: PathBuf,
    /// What the installed binary is named in its build's directory: the holder's, unless another
    /// binary is installed the same way.
    pub command: String,
    /// Where builds are installed, each in a directory of its own.
    pub dir: PathBuf,
    pub uid: u32,
}

impl InstallOptions {
    /// The holder built at `source`, installed in `dir` for the user `uid`.
    pub fn new(source: PathBuf, dir: PathBuf, uid: u32) -> Self {
        Self {
            source,
            command: HOLDER_COMMAND.to_owned(),
            dir,
            uid,
        }
    }
}

/// The build new holders run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledHolder {
    /// What new holders run.
    pub binary: PathBuf,
    /// The first 16 hex digits of the binary's SHA-256, which name its directory.
    pub build: String,
    /// The directory every build is installed in.
    pub install_dir: PathBuf,
}

/// Why no build was installed.
#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("{} isn't built; run `moon run :build`", .binary.display())]
    NotBuilt { binary: PathBuf },
    #[error("refusing {} for {command} builds: {why}", .dir.display())]
    Refused {
        dir: PathBuf,
        command: String,
        why: String,
    },
    #[error("{command} couldn't be installed: {source}")]
    Failed {
        command: String,
        #[source]
        source: io::Error,
    },
}

/// What `install_holder_with` lets its tests do between its steps.
#[derive(Default)]
struct Seams<'a> {
    /// Called once the copy is made, before it is hashed.
    after_copy: Option<&'a dyn Fn()>,
    /// Called just before the finished copy is renamed into place.
    before_rename: Option<&'a dyn Fn()>,
}

/// Eight hex digits no other call of this process gives.
fn tag() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(NEXT.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    hasher.write_u128(nanos);
    format!("{:08x}", hasher.finish() & 0xffff_ffff)
}

fn is_hex(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `.tmp-` and 8 hex digits: an install's copy, still being made, or left by one that stopped.
fn is_temp(name: &str) -> bool {
    name.strip_prefix(".tmp-")
        .is_some_and(|tag| tag.len() == 8 && is_hex(tag))
}

/// `.bad-`, a build, `-` and 8 hex digits: what held a build's name but not its bytes.
fn is_bad(name: &str) -> bool {
    name.strip_prefix(".bad-")
        .and_then(|rest| rest.split_once('-'))
        .is_some_and(|(build, tag)| is_holder_build(build) && tag.len() == 8 && is_hex(tag))
}

fn writable_by_others(mode: u32) -> bool {
    mode & 0o022 != 0
}

/// The build `file` is: the first 16 hex digits of its SHA-256.
fn build_of(file: &Path) -> io::Result<String> {
    let digest = sha256(&fs::read(file)?);
    Ok(hex(digest.get(..8).unwrap_or_default()))
}

/// Why `dir` can't hold builds, or `None` when it can. It is made if missing, and never repaired:
/// whoever else can write it would choose what every new holder runs. Its ancestors are not
/// checked: they are the user's state directory and above, which the daemon trusts as it does for
/// its database.
fn dir_refusal(dir: &Path, uid: u32) -> Option<String> {
    if let Err(e) = fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
    {
        return Some(format!("it can't be made: {e}"));
    }
    let meta = match fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(e) => return Some(format!("it can't be read: {e}")),
    };
    if meta.file_type().is_symlink() {
        return Some("it is a symlink".to_owned());
    }
    if !meta.is_dir() {
        return Some("it isn't a directory".to_owned());
    }
    if meta.uid() != uid {
        return Some(format!("it belongs to uid {}", meta.uid()));
    }
    if writable_by_others(meta.mode()) {
        return Some("other users may write it".to_owned());
    }
    None
}

/// Whether `path` holds `build` as installed: this user's, writable by no one else, its hash.
fn holds(path: &Path, build: &str, uid: u32, command: &str) -> bool {
    let ours = |meta: &fs::Metadata| meta.uid() == uid && !writable_by_others(meta.mode());
    let binary = path.join(command);
    match (fs::symlink_metadata(path), fs::symlink_metadata(&binary)) {
        (Ok(dir), Ok(file)) if dir.is_dir() && ours(&dir) && file.is_file() && ours(&file) => {
            build_of(&binary).is_ok_and(|b| b == build)
        }
        _ => false,
    }
}

/// Sets `path`'s times to now.
fn touch(path: &Path) -> io::Result<()> {
    let now = rustix::fs::Timespec {
        tv_sec: 0,
        tv_nsec: rustix::fs::UTIME_NOW,
    };
    let times = rustix::fs::Timestamps {
        last_access: now,
        last_modification: now,
    };
    rustix::fs::utimensat(rustix::fs::CWD, path, &times, rustix::fs::AtFlags::empty())
        .map_err(io::Error::from)
}

/// Installs `options.source` in `options.dir`, under its build, unless it already is. The copy
/// is made in a temporary directory and renamed into place, so no holder finds it half written;
/// the build is the copy's hash, not the source's, which a build running meanwhile could change.
/// Something else under the build's name is moved aside, never written over: a holder may run
/// it, and macOS kills a signed binary changed under it.
///
/// # Errors
///
/// When nothing is built at the source, the directory is refused, or the copy fails.
pub fn install_holder(options: &InstallOptions) -> Result<InstalledHolder, InstallError> {
    install_holder_with(options, &Seams::default())
}

fn install_holder_with(
    options: &InstallOptions,
    seams: &Seams<'_>,
) -> Result<InstalledHolder, InstallError> {
    let InstallOptions {
        source,
        command,
        dir,
        uid,
    } = options;
    if fs::symlink_metadata(source).is_err() {
        return Err(InstallError::NotBuilt {
            binary: source.clone(),
        });
    }
    if let Some(why) = dir_refusal(dir, *uid) {
        return Err(InstallError::Refused {
            dir: dir.clone(),
            command: command.clone(),
            why,
        });
    }
    let temp = dir.join(format!(".tmp-{}", tag()));
    let installed = place(options, &temp, seams).map_err(|source| InstallError::Failed {
        command: command.clone(),
        source,
    });
    // Gone once renamed into place; a copy that failed goes with it, or is left to a prune.
    let _ = fs::remove_dir_all(&temp);
    installed
}

fn place(options: &InstallOptions, temp: &Path, seams: &Seams<'_>) -> io::Result<InstalledHolder> {
    let InstallOptions {
        source,
        command,
        dir,
        uid,
    } = options;
    fs::DirBuilder::new().mode(0o700).create(temp)?;
    let copy = temp.join(command);
    fs::copy(source, &copy)?;
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o500))?;
    fs::File::open(&copy)?.sync_all()?;
    if let Some(after_copy) = seams.after_copy {
        after_copy();
    }
    let build = build_of(&copy)?;
    let target = dir.join(&build);
    let installed = InstalledHolder {
        binary: target.join(command),
        build: build.clone(),
        install_dir: dir.clone(),
    };
    // Read once, before the check: an install that renames its copy in meanwhile is whole.
    if fs::symlink_metadata(&target).is_ok() {
        if holds(&target, &build, *uid, command) {
            // Fresh again, so a prune by another start that installed some other build leaves it.
            touch(&target)?;
            return Ok(installed);
        }
        match fs::rename(&target, dir.join(format!(".bad-{build}-{}", tag()))) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    if let Some(before_rename) = seams.before_rename {
        before_rename();
    }
    if let Err(e) = fs::rename(temp, &target) {
        // Another install of the same build got there first.
        let lost = matches!(
            e.kind(),
            io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::AlreadyExists
        );
        if !(lost && holds(&target, &build, *uid, command)) {
            return Err(e);
        }
    }
    // Best effort: the rename stands either way, and some filesystems can't sync a directory.
    let _ = fs::File::open(dir).and_then(|d| d.sync_all());
    Ok(installed)
}

/// Removes from `dir` every build not in `keep`, what installs moved aside, and the temporary
/// directories of installs that stopped, by name, and builds and temporary directories only once
/// older than `FRESH` at `now`. Nothing else there is touched, and no link is followed: what was
/// moved aside may be a link, which is unlinked. What it removed, by name; nothing from a
/// directory `install_holder` would refuse.
pub fn prune_holder_builds(
    dir: &Path,
    uid: u32,
    keep: &BTreeSet<String>,
    now: SystemTime,
) -> Vec<String> {
    if dir_refusal(dir, uid).is_some() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > FRESH);
        let directory = meta.is_dir();
        let unused = is_bad(&name)
            || (directory
                && old
                && if is_holder_build(&name) {
                    !keep.contains(&name)
                } else {
                    is_temp(&name)
                });
        if !unused {
            continue;
        }
        let gone = if directory {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        // One that can't be removed is left for the next start.
        if gone.is_ok() {
            removed.push(name);
        }
    }
    removed
}

/// What the kernel shows of a holder the ledger names.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Seen {
    /// No holder runs as it: gone, or its pid reused.
    Gone,
    /// It runs, with these arguments.
    Running(Vec<OsString>),
    /// It runs, but its arguments couldn't be read.
    Unreadable,
}

/// Whether `vouch` shows `holder` running, by its name and start, and with which arguments.
fn seen(holder: HolderProcess) -> Seen {
    // Made only to check the pid is still the holder: it is never spent on a signal.
    if vouch(holder, HolderUse::Kill).is_none() {
        return Seen::Gone;
    }
    match bazhen_holder::process::args(holder.pid) {
        Ok(argv) => Seen::Running(argv),
        Err(_) => Seen::Unreadable,
    }
}

/// The builds in `dir` that the live holders among `holders` run, each vouched for by the kernel
/// now; `None` when one runs but its arguments can't be read, so that nothing is taken for
/// unused.
pub fn running_builds(dir: &Path, holders: &[HolderProcess]) -> Option<BTreeSet<String>> {
    running_builds_with(dir, holders, seen)
}

fn running_builds_with(
    dir: &Path,
    holders: &[HolderProcess],
    see: impl Fn(HolderProcess) -> Seen,
) -> Option<BTreeSet<String>> {
    let mut builds = BTreeSet::new();
    for &holder in holders {
        match see(holder) {
            Seen::Gone => {}
            Seen::Unreadable => return None,
            Seen::Running(argv) => {
                if let Some(build) = holder_build_of(&argv, dir) {
                    builds.insert(build.to_owned());
                }
            }
        }
    }
    Some(builds)
}

/// Removes the builds in `dir` that neither `installed` nor any live holder among `holders` uses,
/// as `prune_holder_builds` does: none when a live holder's build can't be read.
pub fn prune_unused_holders(
    dir: &Path,
    uid: u32,
    installed: Option<&InstalledHolder>,
    holders: &[HolderProcess],
) -> Vec<String> {
    prune_unused_with(dir, uid, installed, holders, seen, SystemTime::now())
}

fn prune_unused_with(
    dir: &Path,
    uid: u32,
    installed: Option<&InstalledHolder>,
    holders: &[HolderProcess],
    see: impl Fn(HolderProcess) -> Seen,
    now: SystemTime,
) -> Vec<String> {
    let Some(mut keep) = running_builds_with(dir, holders, see) else {
        return Vec::new();
    };
    if let Some(installed) = installed {
        keep.insert(installed.build.clone());
    }
    prune_holder_builds(dir, uid, &keep, now)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::os::unix::fs::symlink;

    use rustix::process::{Pid, getpid};

    use super::*;
    use crate::test_support::{TempDir, me};

    const OLD: &str = "0000000000000000";
    const KEPT: &str = "1111111111111111";
    const RUNNING: &str = "2222222222222222";

    /// A home with its state directory's `holder` directory to install in, not yet made, and a
    /// built binary.
    struct Home {
        _root: TempDir,
        root: PathBuf,
        dir: PathBuf,
        source: PathBuf,
    }

    fn home() -> Home {
        let root = TempDir::new();
        let path = root.path().to_owned();
        let source = path.join("bazhen-holder");
        fs::write(&source, "build one").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        Home {
            dir: path.join("state").join("holder"),
            root: path,
            source,
            _root: root,
        }
    }

    impl Home {
        fn options(&self) -> InstallOptions {
            InstallOptions::new(self.source.clone(), self.dir.clone(), me())
        }

        fn install(&self) -> InstalledHolder {
            install_holder(&self.options()).unwrap()
        }

        fn ls(&self) -> Vec<String> {
            ls(&self.dir)
        }

        /// A build directory named `name`, holding a binary, made `FRESH` and a minute ago.
        fn plant(&self, name: &str) {
            let dir = self.dir.join(name);
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&dir)
                .unwrap();
            let binary = dir.join("bazhen-holder");
            fs::write(&binary, name).unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o500)).unwrap();
            age(&dir);
        }

        fn prune(&self, keep: &[&str]) -> Vec<String> {
            let keep = keep.iter().map(|b| (*b).to_owned()).collect();
            sorted(prune_holder_builds(
                &self.dir,
                me(),
                &keep,
                SystemTime::now(),
            ))
        }

        fn at(&self, build: &str) -> OsString {
            self.dir.join(build).join("bazhen-holder").into_os_string()
        }
    }

    fn sorted(mut names: Vec<String>) -> Vec<String> {
        names.sort();
        names
    }

    fn ls(dir: &Path) -> Vec<String> {
        sorted(
            fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect(),
        )
    }

    fn build_of_text(text: &str) -> String {
        hex(&sha256(text.as_bytes())[..8])
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().mode() & 0o777
    }

    fn chmod(path: &Path, mode: u32) {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    /// Sets `path`'s times, not a link's target's, to `ago` before now.
    fn set_age(path: &Path, ago: Duration) {
        let then = SystemTime::now() - ago;
        let secs = then.duration_since(UNIX_EPOCH).unwrap().as_secs();
        let at = rustix::fs::Timespec {
            tv_sec: i64::try_from(secs).unwrap(),
            tv_nsec: 0,
        };
        let times = rustix::fs::Timestamps {
            last_access: at,
            last_modification: at,
        };
        rustix::fs::utimensat(
            rustix::fs::CWD,
            path,
            &times,
            rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
        )
        .unwrap();
    }

    /// As old as a build must be before a prune takes it, and a minute more.
    fn age(path: &Path) {
        set_age(path, FRESH + Duration::from_mins(1));
    }

    fn holder(pid: i32) -> HolderProcess {
        HolderProcess {
            pid: Pid::from_raw(pid).unwrap(),
            start: 1_700_000_000,
        }
    }

    /// The kernel as a test has it: what each pid runs, and nothing at any other.
    fn kernel(seen: Vec<(i32, Seen)>) -> impl Fn(HolderProcess) -> Seen {
        move |h| {
            seen.iter()
                .find(|(pid, _)| *pid == h.pid.as_raw_pid())
                .map_or(Seen::Gone, |(_, s)| s.clone())
        }
    }

    fn running(path: impl Into<OsString>) -> Seen {
        Seen::Running(vec![path.into()])
    }

    #[test]
    fn installs_another_binary_the_same_way_under_its_own_name_and_finds_it_installed_again() {
        let home = home();
        let options = InstallOptions {
            command: "bazhen-peer".to_owned(),
            ..home.options()
        };
        let first = install_holder(&options).unwrap();
        let again = install_holder(&options).unwrap();
        let binary = home
            .dir
            .join(build_of_text("build one"))
            .join("bazhen-peer");
        assert_eq!(
            (first.binary, again.binary.clone(), mode(&binary)),
            (binary.clone(), binary, 0o500)
        );
    }

    #[test]
    fn copies_the_build_under_its_hash_read_only_in_a_directory_only_this_user_can_reach() {
        let home = home();
        let installed = home.install();
        let build = build_of_text("build one");
        let binary = home.dir.join(&build).join("bazhen-holder");
        assert_eq!(
            installed,
            InstalledHolder {
                binary: binary.clone(),
                build: build.clone(),
                install_dir: home.dir.clone(),
            }
        );
        assert_eq!(
            (
                fs::read_to_string(&binary).unwrap(),
                mode(&binary),
                mode(&home.dir.join(&build)),
                mode(&home.dir),
                home.ls(),
            ),
            ("build one".to_owned(), 0o500, 0o700, 0o700, vec![build])
        );
    }

    #[test]
    fn reuses_an_installed_build_without_writing_it_again() {
        let home = home();
        let first = home.install().binary;
        let inode = fs::metadata(&first).unwrap().ino();
        let second = home.install().binary;
        assert_eq!(
            (
                second.clone(),
                fs::metadata(&second).unwrap().ino(),
                home.ls()
            ),
            (first, inode, vec![build_of_text("build one")])
        );
    }

    #[test]
    fn makes_a_reused_build_fresh_again_so_another_start_s_prune_doesn_t_take_it_for_unused() {
        let home = home();
        home.install();
        set_age(&home.dir.join(build_of_text("build one")), 2 * FRESH);
        home.install();
        assert_eq!(
            (home.prune(&[]), home.ls()),
            (vec![], vec![build_of_text("build one")])
        );
    }

    #[test]
    fn installs_a_new_build_beside_the_old_one_which_a_running_holder_keeps_unchanged() {
        let home = home();
        let old = home.install().binary;
        let inode = fs::metadata(&old).unwrap().ino();
        fs::write(&home.source, "build two").unwrap();
        let next = home.install().binary;
        assert_eq!(
            (
                next.clone(),
                fs::metadata(&old).unwrap().ino(),
                fs::read_to_string(&old).unwrap(),
                fs::read_to_string(&next).unwrap(),
                home.ls(),
            ),
            (
                home.dir
                    .join(build_of_text("build two"))
                    .join("bazhen-holder"),
                inode,
                "build one".to_owned(),
                "build two".to_owned(),
                sorted(vec![build_of_text("build one"), build_of_text("build two")]),
            )
        );
    }

    #[test]
    fn moves_aside_what_holds_the_build_s_name_but_not_its_bytes_rather_than_write_over_it() {
        let home = home();
        let build = build_of_text("build one");
        let squatter = home.dir.join(&build);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&squatter)
            .unwrap();
        fs::write(squatter.join("bazhen-holder"), "something else").unwrap();
        chmod(&squatter.join("bazhen-holder"), 0o500);
        let binary = home.install().binary;
        let aside: Vec<_> = home
            .ls()
            .into_iter()
            .filter(|name| name.starts_with(&format!(".bad-{build}-")))
            .map(|name| fs::read_to_string(home.dir.join(name).join("bazhen-holder")).unwrap())
            .collect();
        assert_eq!(
            (fs::read_to_string(binary).unwrap(), aside),
            ("build one".to_owned(), vec!["something else".to_owned()])
        );
    }

    #[test]
    fn moves_aside_an_installed_build_another_user_may_write() {
        let home = home();
        let binary = home.install().binary;
        chmod(&binary, 0o520);
        home.install();
        let aside = home
            .ls()
            .iter()
            .filter(|name| name.starts_with(".bad-"))
            .count();
        assert_eq!((mode(&binary), aside), (0o500, 1));
    }

    #[test]
    fn takes_the_build_another_install_renamed_into_place_first() {
        let home = home();
        let other = RefCell::new(None);
        let race = || *other.borrow_mut() = Some(home.install());
        let seams = Seams {
            before_rename: Some(&race),
            ..Seams::default()
        };
        let installed = install_holder_with(&home.options(), &seams).unwrap();
        assert_eq!(
            (Some(installed.clone()), installed.build, home.ls()),
            (
                other.take(),
                build_of_text("build one"),
                vec![build_of_text("build one")]
            )
        );
    }

    #[test]
    fn names_the_build_by_what_was_copied_though_a_build_rewrites_the_source_meanwhile() {
        let home = home();
        let rewrite = || fs::write(&home.source, "build two").unwrap();
        let seams = Seams {
            after_copy: Some(&rewrite),
            ..Seams::default()
        };
        let installed = install_holder_with(&home.options(), &seams).unwrap();
        assert_eq!(
            (installed.build, home.ls()),
            (build_of_text("build one"), vec![build_of_text("build one")])
        );
    }

    #[test]
    fn installs_once_when_two_installs_run_together() {
        let home = home();
        let options = home.options();
        let binaries: BTreeSet<_> = std::thread::scope(|s| {
            let installs: Vec<_> = (0..3)
                .map(|_| s.spawn(|| install_holder(&options).unwrap().binary))
                .collect();
            installs.into_iter().map(|t| t.join().unwrap()).collect()
        });
        assert_eq!(
            (binaries.len(), home.ls()),
            (1, vec![build_of_text("build one")])
        );
    }

    #[test]
    fn says_why_when_nothing_is_built_and_makes_nothing() {
        let home = home();
        fs::remove_file(&home.source).unwrap();
        let refused = install_holder(&home.options()).unwrap_err();
        assert!(
            matches!(refused, InstallError::NotBuilt { .. }),
            "{refused}"
        );
        assert!(refused.to_string().contains("isn't built"), "{refused}");
        assert!(!home.dir.exists());
    }

    #[test]
    fn leaves_no_copy_behind_when_the_copy_fails() {
        let home = home();
        fs::remove_file(&home.source).unwrap();
        fs::create_dir(&home.source).unwrap();
        let failed = install_holder(&home.options()).unwrap_err();
        assert!(
            failed.to_string().contains("couldn't be installed"),
            "{failed}"
        );
        assert_eq!(home.ls(), Vec::<String>::new());
    }

    #[test]
    fn refuses_a_directory_someone_else_could_write_or_redirect_and_never_repairs_it() {
        let home = home();
        let elsewhere = home.root.join("elsewhere");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&elsewhere)
            .unwrap();
        fs::create_dir(home.root.join("state")).unwrap();
        symlink(&elsewhere, &home.dir).unwrap();
        let linked = install_holder(&home.options()).unwrap_err().to_string();
        fs::remove_file(&home.dir).unwrap();
        fs::DirBuilder::new().mode(0o700).create(&home.dir).unwrap();
        chmod(&home.dir, 0o770);
        let open = install_holder(&home.options()).unwrap_err().to_string();
        let left = mode(&home.dir);
        chmod(&home.dir, 0o700);
        let foreign = install_holder(&InstallOptions {
            uid: me() + 1,
            ..home.options()
        })
        .unwrap_err()
        .to_string();
        assert!(linked.contains("it is a symlink"), "{linked}");
        assert!(open.contains("other users may write it"), "{open}");
        assert!(
            foreign.contains(&format!("it belongs to uid {}", me())),
            "{foreign}"
        );
        assert_eq!(
            (left, ls(&elsewhere), home.ls()),
            (0o770, Vec::<String>::new(), Vec::<String>::new())
        );
    }

    #[test]
    fn removes_only_builds_not_kept_and_what_installs_moved_aside() {
        let home = home();
        let aside = format!(".bad-{OLD}-01234567");
        for name in [OLD, KEPT, aside.as_str()] {
            home.plant(name);
        }
        assert_eq!(
            (home.prune(&[KEPT]), home.ls()),
            (sorted(vec![aside, OLD.to_owned()]), vec![KEPT.to_owned()])
        );
    }

    #[test]
    fn leaves_a_build_or_an_install_s_temporary_directory_too_young_to_be_done_with() {
        let home = home();
        for name in [OLD, KEPT, ".tmp-0123abcd", ".tmp-89abcdef"] {
            home.plant(name);
        }
        touch(&home.dir.join(KEPT)).unwrap();
        touch(&home.dir.join(".tmp-89abcdef")).unwrap();
        assert_eq!(
            (home.prune(&[]), home.ls()),
            (
                sorted(vec![".tmp-0123abcd".to_owned(), OLD.to_owned()]),
                sorted(vec![".tmp-89abcdef".to_owned(), KEPT.to_owned()]),
            )
        );
    }

    #[test]
    fn unlinks_what_was_moved_aside_whatever_it_is_and_follows_no_link() {
        let home = home();
        let outside = home.root.join("outside");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&home.dir)
            .unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), "").unwrap();
        let linked = format!(".bad-{OLD}-01234567");
        let file = format!(".bad-{KEPT}-01234567");
        symlink(&outside, home.dir.join(&linked)).unwrap();
        fs::write(home.dir.join(&file), "").unwrap();
        assert_eq!(
            (home.prune(&[]), home.ls(), ls(&outside)),
            (sorted(vec![file, linked]), vec![], vec!["keep".to_owned()])
        );
    }

    #[test]
    fn touches_nothing_it_didn_t_make_whatever_its_name() {
        let home = home();
        let outside = home.root.join("outside");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&home.dir)
            .unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), "").unwrap();
        for name in [OLD, ".tmp-0123abcd"] {
            symlink(&outside, home.dir.join(name)).unwrap();
            age(&home.dir.join(name));
        }
        for name in ["notes", "00000000", &format!("{OLD}0")] {
            fs::create_dir(home.dir.join(name)).unwrap();
            age(&home.dir.join(name));
        }
        fs::write(home.dir.join(KEPT), "").unwrap();
        let before = home.ls();
        assert_eq!(
            (home.prune(&[]), home.ls(), ls(&outside)),
            (vec![], before, vec!["keep".to_owned()])
        );
    }

    #[test]
    fn removes_nothing_from_a_directory_it_would_refuse_to_install_in() {
        let home = home();
        home.plant(OLD);
        chmod(&home.dir, 0o770);
        assert_eq!((home.prune(&[]), home.ls()), (vec![], vec![OLD.to_owned()]));
        chmod(&home.dir, 0o700);
    }

    #[test]
    fn are_the_builds_the_live_holders_run_from_the_directory() {
        let home = home();
        let elsewhere = home.root.join("elsewhere").join(OLD).join("bazhen-holder");
        let see = kernel(vec![
            (77, running(home.at(RUNNING))),
            (78, running(elsewhere)),
            (79, Seen::Running(vec!["vim".into(), home.at(OLD)])),
            (80, running("/usr/bin/sleep")),
        ]);
        let holders: Vec<_> = (76..=80).map(holder).collect();
        assert_eq!(
            running_builds_with(&home.dir, &holders, see),
            Some(BTreeSet::from([RUNNING.to_owned()]))
        );
    }

    #[test]
    fn keeps_the_builds_live_holders_run_and_the_one_just_installed_even_with_no_holder_on_it() {
        let home = home();
        let installed = home.install();
        age(&home.dir.join(&installed.build));
        home.plant(OLD);
        home.plant(RUNNING);
        let removed = prune_unused_with(
            &home.dir,
            me(),
            Some(&home.install()),
            &[holder(77), holder(78)],
            kernel(vec![(77, running(home.at(RUNNING)))]),
            SystemTime::now(),
        );
        assert_eq!(
            (removed, home.ls(), installed.binary.exists()),
            (
                vec![OLD.to_owned()],
                sorted(vec![installed.build, RUNNING.to_owned()]),
                true
            )
        );
    }

    #[test]
    fn are_unknown_when_a_live_holder_s_arguments_can_t_be_read_and_then_nothing_is_removed() {
        let home = home();
        home.plant(OLD);
        let see = || kernel(vec![(77, Seen::Unreadable)]);
        let holders = [holder(77)];
        assert_eq!(running_builds_with(&home.dir, &holders, see()), None);
        assert_eq!(
            prune_unused_with(&home.dir, me(), None, &holders, see(), SystemTime::now()),
            Vec::<String>::new()
        );
        assert_eq!(home.ls(), vec![OLD.to_owned()]);
    }

    #[test]
    fn are_read_from_the_kernel_which_shows_no_holder_at_this_test_s_pid() {
        let home = home();
        let pid = getpid();
        let start = bazhen_holder::start_time::of(pid).unwrap().get();
        let nobody = HolderProcess {
            pid: Pid::from_raw(i32::MAX).unwrap(),
            start,
        };
        assert_eq!(
            running_builds(&home.dir, &[HolderProcess { pid, start }, nobody]),
            Some(BTreeSet::new())
        );
    }

    /// The test container's: a copy of `sleep` named as the holder, which the kernel names so
    /// too, installed and run from its build while the next build installs beside it.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn keeps_a_build_a_live_holder_runs_while_the_next_installs_then_prunes_it_once_it_ends() {
        bazhen_test_signal::require_sandbox().unwrap();
        let home = home();
        let sleep = ["/bin/sleep", "/usr/bin/sleep"]
            .into_iter()
            .find(|path| Path::new(path).exists())
            .unwrap();
        fs::copy(sleep, &home.source).unwrap();
        let old = home.install();
        let mut child = std::process::Command::new(&old.binary)
            .arg("300")
            .spawn()
            .unwrap();
        let pid = Pid::from_raw(i32::try_from(child.id()).unwrap()).unwrap();
        // The kernel names it as the holder once it has exec'd, which may be a moment after.
        let start = loop {
            if bazhen_holder::process::comm(pid).is_ok_and(|c| c == "bazhen-holder") {
                break bazhen_holder::start_time::of(pid).unwrap().get();
            }
            std::thread::yield_now();
        };
        let live = [HolderProcess { pid, start }];
        fs::write(&home.source, "the next build, which nothing here runs").unwrap();
        let next = home.install();
        age(&home.dir.join(&old.build));
        let while_running = (
            running_builds(&home.dir, &live),
            prune_unused_holders(&home.dir, me(), Some(&next), &live),
        );
        bazhen_test_signal::signal(child.id(), bazhen_test_signal::Signal::KILL).unwrap();
        child.wait().unwrap();
        let after = prune_unused_holders(&home.dir, me(), Some(&next), &live);
        assert_eq!(
            (while_running, after, home.ls()),
            (
                (Some(BTreeSet::from([old.build.clone()])), vec![]),
                vec![old.build],
                vec![next.build]
            )
        );
    }
}
