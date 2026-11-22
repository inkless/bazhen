//! Installs the built `bazhen-holder` where the daemon runs it from, as `install.ts` does: a
//! directory named by the binary's content, which nothing writes again once it is there. A holder
//! runs for as long as its terminal does, so the next build installs beside it, never over it,
//! and the old directory goes only once no process of this user runs it and it is older than
//! `FRESH`.
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
use bazhen_holder::process;
use bazhen_holder::start_time::{self, StartTimeError};
use bazhen_host_guard::holder::{HOLDER_COMMAND, holder_build_of, is_holder_build};
use rustix::io::Errno;
use rustix::process::{Pid, getpid};

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

/// What the kernel shows of one process it listed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Seen {
    /// Gone since it was listed.
    Gone,
    /// Its owner may not be read, so it is another user's: this user may read each of its own,
    /// and a `/proc` mounted `hidepid` hides only other users'.
    Unowned,
    /// Its owner couldn't be read for another reason, as a lack of file descriptors: whose it
    /// is, and what it runs, are unknown.
    Unknown,
    /// Run by `uid`, with `argv`, `None` when they can't be read.
    Of {
        uid: u32,
        argv: Option<Vec<OsString>>,
    },
}

/// What the kernel shows of `pid` now. Reading only: nothing here reaches a process.
fn seen(pid: Pid) -> Seen {
    seen_by(pid, process::uid, process::args, |pid| {
        matches!(start_time::of(pid), Err(StartTimeError::Absent(_)))
    })
}

/// What `seen` makes of `pid`'s owner as `uid_of` reads it, and of its arguments as `args_of`
/// does, `gone` saying whether it has no process any more.
fn seen_by(
    pid: Pid,
    uid_of: impl Fn(Pid) -> io::Result<u32>,
    args_of: impl Fn(Pid) -> io::Result<Vec<OsString>>,
    gone: impl Fn(Pid) -> bool,
) -> Seen {
    let uid = match uid_of(pid) {
        Ok(uid) => uid,
        Err(e)
            if e.kind() == io::ErrorKind::NotFound
                || e.raw_os_error() == Some(Errno::SRCH.raw_os_error()) =>
        {
            return Seen::Gone;
        }
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return Seen::Unowned,
        Err(_) => return Seen::Unknown,
    };
    match args_of(pid) {
        Ok(argv) => Seen::Of {
            uid,
            argv: Some(argv),
        },
        Err(_) if gone(pid) => Seen::Gone,
        Err(_) => Seen::Of { uid, argv: None },
    }
}

/// The builds in `dir` that some process of `uid` runs, as `runningBuilds` in `install.ts`
/// finds them with `ps`: every process the kernel lists, whether or not a ledger names it, so a
/// holder the ledger lost, or recorded with no start, still keeps its build. `None` when that
/// list can't be vouched for as whole, so that nothing is taken for unused: it can't be read,
/// it doesn't show this process as `uid`'s, a process's owner or one of `uid`'s arguments can't
/// be read, or `dir` isn't a path `holder_build_of` can read.
pub fn running_builds(dir: &Path, uid: u32) -> Option<BTreeSet<String>> {
    running_builds_with(dir, uid, getpid(), process::pids(), seen)
}

fn running_builds_with(
    dir: &Path,
    uid: u32,
    me: Pid,
    pids: io::Result<Vec<Pid>>,
    see: impl Fn(Pid) -> Seen,
) -> Option<BTreeSet<String>> {
    dir.to_str()?;
    let mut builds = BTreeSet::new();
    let mut listed_me = false;
    for pid in pids.ok()? {
        match see(pid) {
            Seen::Gone | Seen::Unowned => {}
            Seen::Of { uid: owner, .. } if owner != uid => {}
            Seen::Unknown | Seen::Of { argv: None, .. } => return None,
            Seen::Of {
                argv: Some(argv), ..
            } => {
                listed_me |= pid == me;
                if let Some(build) = holder_build_of(&argv, dir) {
                    builds.insert(build.to_owned());
                }
            }
        }
    }
    listed_me.then_some(builds)
}

/// Removes the builds in `dir` that neither `installed` nor any process of `uid` uses, as
/// `prune_holder_builds` does: none when `running_builds` can't say which run.
pub fn prune_unused_holders(
    dir: &Path,
    uid: u32,
    installed: Option<&InstalledHolder>,
) -> Vec<String> {
    let running = running_builds(dir, uid);
    prune_unused_with(dir, uid, installed, running, SystemTime::now())
}

fn prune_unused_with(
    dir: &Path,
    uid: u32,
    installed: Option<&InstalledHolder>,
    running: Option<BTreeSet<String>>,
    now: SystemTime,
) -> Vec<String> {
    let Some(mut keep) = running else {
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

    /// The pid the test's kernel lists as this process.
    const SELF: i32 = 4242;

    fn pid(raw: i32) -> Pid {
        Pid::from_raw(raw).unwrap()
    }

    /// A process of `uid` running `argv`.
    fn of(uid: u32, argv: &[OsString]) -> Seen {
        Seen::Of {
            uid,
            argv: Some(argv.to_vec()),
        }
    }

    /// This user's process running the program at `path`.
    fn running(path: impl Into<OsString>) -> Seen {
        of(me(), &[path.into()])
    }

    /// The kernel as a test has it: this process, as this user's, then each of `seen`.
    fn kernel(seen: Vec<(i32, Seen)>) -> (io::Result<Vec<Pid>>, impl Fn(Pid) -> Seen) {
        let seen: Vec<_> = [(SELF, running("bazhen-daemon"))]
            .into_iter()
            .chain(seen)
            .collect();
        let pids = seen.iter().map(|(raw, _)| pid(*raw)).collect();
        let see = move |p: Pid| {
            seen.iter()
                .find(|(raw, _)| pid(*raw) == p)
                .map_or(Seen::Gone, |(_, s)| s.clone())
        };
        (Ok(pids), see)
    }

    fn builds_in(dir: &Path, seen: Vec<(i32, Seen)>) -> Option<BTreeSet<String>> {
        let (pids, see) = kernel(seen);
        running_builds_with(dir, me(), pid(SELF), pids, see)
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
        // The second runs whole as the first is about to rename its copy in, so the first finds
        // its rename lost to it; a third then finds the build there.
        let second = RefCell::new(None);
        let race = || *second.borrow_mut() = Some(install_holder(&options).ok());
        let seams = Seams {
            before_rename: Some(&race),
            ..Seams::default()
        };
        let first = install_holder_with(&options, &seams).ok();
        let third = install_holder(&options).ok();
        let binaries = [first, second.take().flatten(), third].map(|i| i.map(|i| i.binary));
        let build = build_of_text("build one");
        let binary = home.dir.join(&build).join(HOLDER_COMMAND);
        assert_eq!(
            (binaries, home.ls()),
            (
                [Some(binary.clone()), Some(binary.clone()), Some(binary)],
                vec![build]
            )
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
    fn are_those_some_process_of_this_user_runs_from_the_directory() {
        let home = home();
        let elsewhere = home.root.join("elsewhere").join(OLD).join("bazhen-holder");
        let running = builds_in(
            &home.dir,
            vec![
                (77, running(home.at(RUNNING))),
                (78, of(me() + 1, &[home.at(OLD)])),
                (79, of(me(), &["vim".into(), home.at(OLD)])),
                (80, running("/usr/bin/sleep")),
                (81, running(elsewhere)),
                (82, Seen::Unowned),
                (
                    83,
                    Seen::Of {
                        uid: me() + 1,
                        argv: None,
                    },
                ),
            ],
        );
        assert_eq!(running, Some(BTreeSet::from([RUNNING.to_owned()])));
    }

    #[test]
    fn keep_their_builds_and_the_one_just_installed_even_with_no_holder_on_it() {
        let home = home();
        let installed = home.install();
        age(&home.dir.join(&installed.build));
        home.plant(OLD);
        home.plant(RUNNING);
        let running = builds_in(&home.dir, vec![(77, running(home.at(RUNNING)))]);
        let removed = prune_unused_with(
            &home.dir,
            me(),
            Some(&installed),
            running,
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
    fn are_unknown_when_the_list_fails_or_doesn_t_show_this_process_as_this_user_s() {
        let home = home();
        let (_, see) = kernel(vec![(77, running(home.at(RUNNING)))]);
        let failed = running_builds_with(
            &home.dir,
            me(),
            pid(SELF),
            Err(io::Error::other("no list")),
            &see,
        );
        let unlisted = running_builds_with(&home.dir, me(), pid(SELF), Ok(vec![pid(77)]), &see);
        let another_s =
            running_builds_with(&home.dir, me(), pid(SELF), Ok(vec![pid(SELF)]), |_| {
                of(me() + 1, &["bazhen-daemon".into()])
            });
        assert_eq!((failed, unlisted, another_s), (None, None, None));
    }

    #[test]
    fn are_unknown_when_a_process_of_this_user_s_arguments_can_t_be_read_and_then_none_go() {
        let home = home();
        home.plant(OLD);
        let unreadable = Seen::Of {
            uid: me(),
            argv: None,
        };
        let running = builds_in(&home.dir, vec![(77, unreadable)]);
        assert_eq!(running, None);
        assert_eq!(
            prune_unused_with(&home.dir, me(), None, running, SystemTime::now()),
            Vec::<String>::new()
        );
        assert_eq!(home.ls(), vec![OLD.to_owned()]);
    }

    #[test]
    fn takes_a_process_for_gone_or_another_s_only_when_the_kernel_says_so_and_else_knows_nothing() {
        let home = home();
        let owner = |errno: Errno| {
            seen_by(
                pid(77),
                |_| Err(io::Error::from_raw_os_error(errno.raw_os_error())),
                |_| Ok(vec![]),
                |_| false,
            )
        };
        let read = [Errno::NOENT, Errno::SRCH, Errno::ACCESS, Errno::MFILE].map(owner);
        assert_eq!(
            (read, builds_in(&home.dir, vec![(77, Seen::Unknown)])),
            ([Seen::Gone, Seen::Gone, Seen::Unowned, Seen::Unknown], None)
        );
    }

    /// `holder_build_of` reads a directory only as text, so under one that isn't, a holder's
    /// build would go unseen.
    #[test]
    fn are_unknown_under_a_directory_that_is_not_text() {
        use std::os::unix::ffi::OsStrExt as _;
        let dir = Path::new(std::ffi::OsStr::from_bytes(b"/tmp/zo\xffe/holder"));
        let argv = [dir.join(RUNNING).join("bazhen-holder").into_os_string()];
        assert_eq!(builds_in(dir, vec![(77, of(me(), &argv))]), None);
    }

    #[test]
    fn are_read_from_the_kernel_which_lists_this_process() {
        let home = home();
        assert_eq!(running_builds(&home.dir, me()), Some(BTreeSet::new()));
    }

    /// A child the test started, killed through the test's chokepoint and reaped however the
    /// test ends, so a failure leaves no sleeper running.
    struct Sleeper(std::process::Child);

    impl Sleeper {
        fn pid(&self) -> Pid {
            Pid::from_raw(i32::try_from(self.0.id()).unwrap()).unwrap()
        }

        fn end(&mut self) {
            // Unreaped, its pid is still its own: no other process can have it.
            if let Ok(None) = self.0.try_wait() {
                let _ = bazhen_test_signal::signal(self.0.id(), bazhen_test_signal::Signal::KILL);
                let _ = self.0.wait();
            }
        }
    }

    impl Drop for Sleeper {
        fn drop(&mut self) {
            self.end();
        }
    }

    /// The tests' own sleeper (`bazhen-test-sleeper`), which the workspace's tests build into the
    /// target directory this test binary is under, looked for no higher than that directory,
    /// which cargo marks with `CACHEDIR.TAG`. Not `sleep`: where that is a multicall coreutils, it
    /// runs nothing once copied under another name.
    fn test_sleeper() -> PathBuf {
        let exe = std::env::current_exe().unwrap();
        let mut within = Vec::new();
        for dir in exe.ancestors().skip(1) {
            within.push(dir);
            if dir.join("CACHEDIR.TAG").is_file() {
                break;
            }
        }
        within
            .into_iter()
            .map(|dir| dir.join("bazhen-test-sleeper"))
            .find(|sleeper| sleeper.is_file())
            .unwrap_or_else(|| {
                panic!(
                    "no bazhen-test-sleeper in the target directory above {}: run the \
                     workspace's tests, which build it",
                    exe.display()
                )
            })
    }

    /// The test container's: a copy of the tests' sleeper named as the holder, installed and run
    /// from its build while the next build installs beside it.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn keeps_a_build_a_live_holder_runs_while_the_next_installs_then_prunes_it_once_it_ends() {
        bazhen_test_signal::require_sandbox().unwrap();
        let home = home();
        fs::copy(test_sleeper(), &home.source).unwrap();
        let old = home.install();
        let mut sleeper = Sleeper(
            std::process::Command::new(&old.binary)
                .arg("300")
                .spawn()
                .unwrap(),
        );
        // It runs from its build once it has exec'd, which may be a moment after the spawn.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while process::args(sleeper.pid())
            .ok()
            .and_then(|argv| argv.into_iter().next())
            != Some(old.binary.clone().into_os_string())
        {
            assert!(
                std::time::Instant::now() < deadline,
                "the sleeper never exec'd"
            );
            std::thread::yield_now();
        }
        fs::write(&home.source, "the next build, which nothing here runs").unwrap();
        let next = home.install();
        age(&home.dir.join(&old.build));
        let while_running = (
            running_builds(&home.dir, me()),
            prune_unused_holders(&home.dir, me(), Some(&next)),
        );
        sleeper.end();
        let after = prune_unused_holders(&home.dir, me(), Some(&next));
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
