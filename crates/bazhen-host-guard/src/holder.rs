//! Starts `bazhen-holder` processes, and checks that a pid is still a holder, by its name and its
//! start time, before it is signalled: a pid reused since by anything else is left alone.
//!
//! A holder is reached only by a proof `vouch` makes from what the kernel says of its pid now,
//! which one signal takes, once, within a second. The signal goes only to a process shown again to
//! be the holder as it is sent: on Linux, one a pidfd holds before it is read, so a pid reused
//! within that second reaches nothing else. The forms with seams, which take a reading of a
//! process and a send and so could vouch for any pid, stay in this module and its tests.

use std::collections::BTreeMap;
use std::error::Error as StdError;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _};
use std::os::unix::process::ExitStatusExt as _;
use std::path::{Component, Path, PathBuf};
use std::pin::{Pin, pin};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bazhen_holder::{process, start_time};
use bazhen_holder_proto::body::SpawnSpec;
use futures_util::future::{Either, select};
use rustix::process::{Pid, RawPid, Signal};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};
use tokio::task::JoinSet;
use tokio::time::{Instant, sleep, timeout, timeout_at};

use crate::scope::ScopeLaunch;
use crate::{Error, Target, Unsafe};

/// The name the kernel keeps for a holder, as its binary is named.
pub const HOLDER_COMMAND: &str = "bazhen-holder";
/// How far two readings of one process's start may lie apart, as a clock step can move one.
pub const START_SKEW_S: u64 = 2;
/// The longest socket path a holder binds: macOS's `sun_path` less its NUL.
pub const HOLDER_SOCKET_MAX_BYTES: usize = 103;
/// The longest spawn spec a holder reads: holder/1's request cap.
pub const HOLDER_SPEC_MAX_BYTES: usize = bazhen_holder_proto::MAX_REQUEST_BYTES;
/// How long a holder has to say `ready` once it runs.
pub const HOLDER_READY: Duration = Duration::from_secs(5);
/// How long a launcher has to exec the holder, `systemd-run`'s call to the user manager
/// included: one still running then is ended, and the holder never given its spec.
pub const HOLDER_LAUNCH: Duration = Duration::from_secs(10);
/// A start no process has, for a holder whose process couldn't be read: recorded under it, it
/// names the pid, and no vouch ever matches it.
pub const UNKNOWN_START: u64 = 0;
/// How long a proof stands once it is made: a pid can be reused at any time after.
pub const PROOF_LIFE: Duration = Duration::from_secs(1);

/// What a holder writes on stdout once it serves its socket, and nothing before.
const READY: &[u8] = b"ready\n";
/// The most of a holder's first stdout line read: anything longer isn't `ready`.
const FIRST_LINE_MAX: usize = 64;
/// The most of a holder's stderr kept for its failure.
const STDERR_MAX: usize = 8 * 1024;
/// How long a holder that never said `ready` has to show as the holder, to be killed.
const VOUCH: Duration = Duration::from_secs(1);
const VOUCH_POLL: Duration = Duration::from_millis(20);
/// How long the stderr of a holder that exited has to arrive, after its exit.
const STDERR_WAIT: Duration = Duration::from_millis(200);
/// The longest wait a start takes, for `ready` or for a launcher.
const WAIT_MAX: Duration = Duration::from_mins(1);
const WAIT_MIN: Duration = Duration::from_millis(1);
const CPU_SECONDS_MAX: u32 = 24 * 60 * 60;

/// A holder, as the ledger records it: its pid, and when it started in epoch seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HolderProcess {
    pub pid: Pid,
    pub start: u64,
}

/// The signal a proof is made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HolderUse {
    /// SIGKILL, which ends it.
    Kill,
    /// SIGUSR1, which tells it to bind its socket again.
    Rebind,
}

/// That a holder's pid was its own when the kernel was read: the one signal it was made for takes
/// it, once, within `PROOF_LIFE`. Only `vouch` and this module's seams make one.
#[derive(Debug, PartialEq, Eq)]
pub struct HolderProof {
    holder: HolderProcess,
    made_for: HolderUse,
    made: std::time::Instant,
}

impl HolderProof {
    pub fn holder(&self) -> HolderProcess {
        self.holder
    }

    fn made_now(holder: HolderProcess, made_for: HolderUse) -> Self {
        Self {
            holder,
            made_for,
            made: std::time::Instant::now(),
        }
    }

    /// The holder it lets `made_for` reach at `now`, spending it, unless it was made for the
    /// other signal, or more than `PROOF_LIFE` before `now`, or after it.
    fn admits(self, made_for: HolderUse, now: std::time::Instant) -> Result<HolderProcess, Error> {
        let target = Target::Process(self.holder.pid);
        if self.made_for != made_for {
            return Err(Error::Unsafe {
                target,
                why: Unsafe::Unvouched,
            });
        }
        match now.checked_duration_since(self.made) {
            Some(age) if age <= PROOF_LIFE => Ok(self.holder),
            _ => Err(Error::Unsafe {
                target,
                why: Unsafe::Stale,
            }),
        }
    }
}

/// What the kernel says of a pid now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reading {
    /// A process runs it: the name it runs as, and when it started in epoch seconds.
    Running { comm: OsString, start: u64 },
    /// No process has it.
    Absent,
    /// Its process couldn't be read, and why.
    Unreadable(String),
}

impl fmt::Display for Reading {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Running { comm, start } => {
                write!(f, "{} started at {start}", comm.to_string_lossy())
            }
            Self::Absent => f.write_str("no process has it"),
            Self::Unreadable(why) => write!(f, "it couldn't be read: {why}"),
        }
    }
}

/// What the kernel says of `pid`: when it started, its name, and when it started again, so a
/// pid reused between the reads reads as unreadable rather than as half of each process.
pub(crate) fn read_process(pid: Pid) -> Reading {
    let start = match start_time::of(pid) {
        Ok(start) => start.get(),
        Err(start_time::StartTimeError::Absent(_)) => return Reading::Absent,
        Err(e) => return Reading::Unreadable(e.to_string()),
    };
    let comm = process::comm(pid);
    match (start_time::of(pid), comm) {
        (Ok(again), Ok(comm)) if again.get() == start => Reading::Running { comm, start },
        (Ok(_), Ok(_)) => Reading::Unreadable("its start changed while it was read".to_owned()),
        (Err(start_time::StartTimeError::Absent(_)), _) => Reading::Absent,
        (Err(e), _) => Reading::Unreadable(e.to_string()),
        (Ok(_), Err(e)) => Reading::Unreadable(format!("its name: {e}")),
    }
}

/// Whether `reading` is a `bazhen-holder` that started within `START_SKEW_S` of `holder.start`.
fn is_holder(reading: &Reading, holder: HolderProcess) -> bool {
    match reading {
        Reading::Running { comm, start } => {
            Path::new(comm).file_name() == Some(OsStr::new(HOLDER_COMMAND))
                && start.abs_diff(holder.start) <= START_SKEW_S
        }
        Reading::Absent | Reading::Unreadable(_) => false,
    }
}

/// Whether `reading`, made of a pid a send has pinned, shows `holder` still there: `false` for
/// another process or none, which the holder has left; a refusal for one that can't be read,
/// which may still be the holder.
fn shown(holder: HolderProcess, reading: &Reading) -> Result<bool, Unsafe> {
    match reading {
        Reading::Unreadable(_) => Err(Unsafe::Unshown),
        Reading::Running { .. } | Reading::Absent => Ok(is_holder(reading, holder)),
    }
}

/// Sends `signal` to `holder` if the kernel shows it is still that holder once its pid is pinned.
fn send_holder(holder: HolderProcess, signal: Signal) -> Result<bool, Error> {
    crate::send_pinned(holder.pid, signal, || {
        shown(holder, &read_process(holder.pid))
    })
}

/// A proof for `made_for`, if `reading` shows the holder.
fn vouched(holder: HolderProcess, made_for: HolderUse, reading: &Reading) -> Option<HolderProof> {
    is_holder(reading, holder).then(|| HolderProof::made_now(holder, made_for))
}

/// What `read` shows at `holder.pid`, as `vouch` reads it; `None` for init or below, which is
/// never read.
fn reading_of(holder: HolderProcess, read: impl FnOnce(Pid) -> Reading) -> Option<Reading> {
    (holder.pid.as_raw_pid() > 1).then(|| read(holder.pid))
}

/// Whether the kernel shows `holder.pid` as the `bazhen-holder` that started within
/// `START_SKEW_S` of `holder.start`, by the reading `vouch` makes: whether a kill's proof would be
/// made now. It makes none, so a caller that only reads, as an inventory does, holds nothing a
/// signal could be sent with.
pub fn is_vouchable(holder: HolderProcess) -> bool {
    vouchable_by(holder, read_process)
}

/// `is_vouchable`, on what `read` shows, so its tests can show it a holder without starting one.
fn vouchable_by(holder: HolderProcess, read: impl FnOnce(Pid) -> Reading) -> bool {
    reading_of(holder, read).is_some_and(|reading| is_holder(&reading, holder))
}

/// Whether this pid still belongs to the recorded holder. An unreadable process may still be
/// the holder; init, an empty pid or one now held by another process cannot be.
pub fn holder_running(holder: HolderProcess) -> Option<bool> {
    running_by(holder, read_process)
}

fn running_by(holder: HolderProcess, read: impl FnOnce(Pid) -> Reading) -> Option<bool> {
    reading_of(holder, read).map_or(Some(false), |reading| shown(holder, &reading).ok())
}

/// A proof `kill_holder` or `rebind_holder` takes, as `made_for` says, if the kernel shows
/// `holder.pid` as a `bazhen-holder` that started within `START_SKEW_S` of `holder.start`;
/// `None` for init or below, a pid with no process, an unreadable one, or one that is something
/// else now. A rebind's is also `None` for a holder this process started that hasn't said
/// `ready`, or has exited.
pub fn vouch(holder: HolderProcess, made_for: HolderUse) -> Option<HolderProof> {
    if made_for == HolderUse::Rebind && unfit(holder) {
        return None;
    }
    vouched(holder, made_for, &reading_of(holder, read_process)?)
}

/// Sends SIGKILL to the holder `proof` was made for, and to it alone, once the kernel shows its
/// pid is still that holder. Whether it was still there.
///
/// # Errors
///
/// When `proof` was made for a rebind, or is stale, or the floor refuses the pid, or what has
/// the pid can't be read, or the kernel refuses the send.
pub fn kill_holder(proof: HolderProof) -> Result<bool, Error> {
    kill_holder_by(proof, std::time::Instant::now(), send_holder)
}

fn kill_holder_by(
    proof: HolderProof,
    now: std::time::Instant,
    send: impl FnOnce(HolderProcess, Signal) -> Result<bool, Error>,
) -> Result<bool, Error> {
    send(proof.admits(HolderUse::Kill, now)?, Signal::KILL)
}

/// Sends SIGUSR1 to the holder `proof` was made for, which tells it to bind its socket again,
/// once the kernel shows its pid is still that holder. Whether it was sent: nothing is to a
/// holder this process started that hasn't said `ready` or has exited, since the proof was made
/// too, or to one gone.
///
/// # Errors
///
/// When `proof` was made for a kill, or is stale, or the floor refuses the pid, or what has the
/// pid can't be read, or the kernel refuses the send.
pub fn rebind_holder(proof: HolderProof) -> Result<bool, Error> {
    rebind_holder_by(proof, std::time::Instant::now(), send_holder)
}

fn rebind_holder_by(
    proof: HolderProof,
    now: std::time::Instant,
    send: impl FnOnce(HolderProcess, Signal) -> Result<bool, Error>,
) -> Result<bool, Error> {
    let holder = proof.admits(HolderUse::Rebind, now)?;
    if unfit(holder) {
        return Ok(false);
    }
    send(holder, Signal::USR1)
}

/// Tells a holder to bind its socket again, as one whose socket file was deleted needs: SIGUSR1,
/// once the kernel shows `holder.pid` is that holder. One this process started is sent nothing
/// unless it has said `ready` and not exited. Whether it was sent.
///
/// # Errors
///
/// When the floor refuses the pid, or what has the pid can't be read as it is sent, or the
/// kernel refuses the send.
pub async fn rebind_holder_socket(holder: HolderProcess) -> Result<bool, Error> {
    rebind_holder_with(holder, async |pid| read_process(pid), rebind_holder).await
}

async fn rebind_holder_with(
    holder: HolderProcess,
    read: impl AsyncFnOnce(Pid) -> Reading,
    send: impl FnOnce(HolderProof) -> Result<bool, Error>,
) -> Result<bool, Error> {
    if holder.pid.as_raw_pid() <= 1 || unfit(holder) {
        return Ok(false);
    }
    let reading = read(holder.pid).await;
    // Checked again after the read, and then sent with no wait between: an exit seen meanwhile
    // counts.
    match vouched(holder, HolderUse::Rebind, &reading) {
        Some(proof) if !unfit(holder) => send(proof),
        _ => Ok(false),
    }
}

/// What this process knows of a holder it started.
#[derive(Debug, Clone, Copy)]
struct Own {
    start: u64,
    ready: bool,
    exited: bool,
}

/// The holders this process started, by pid. One that hasn't said `ready`, or has exited, or
/// whose handle was let go, is never sent a rebind, whatever the kernel says of its pid. Kept
/// until another holder this process starts takes the pid, so an exit is never forgotten.
static OWN: Mutex<BTreeMap<RawPid, Own>> = Mutex::new(BTreeMap::new());

fn own() -> MutexGuard<'static, BTreeMap<RawPid, Own>> {
    OWN.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether `holder` is one this process started that may not be sent a rebind. One it didn't
/// start is fit, once the kernel shows it is the holder.
fn unfit(holder: HolderProcess) -> bool {
    own().get(&holder.pid.as_raw_pid()).is_some_and(|mine| {
        !mine.ready || mine.exited || mine.start.abs_diff(holder.start) > START_SKEW_S
    })
}

/// Marks the holder started at `start` under `pid` as exited, or let go of.
fn mark_exited(pid: Pid, start: u64) {
    if let Some(mine) = own().get_mut(&pid.as_raw_pid())
        && mine.start == start
    {
        mine.exited = true;
    }
}

fn mark_ready(pid: Pid, start: u64) {
    if let Some(mine) = own().get_mut(&pid.as_raw_pid())
        && mine.start == start
    {
        mine.ready = true;
    }
}

/// Whether `build` names a holder build: the first 16 hex digits of the SHA-256 of its binary.
pub fn is_holder_build(build: &str) -> bool {
    build.len() == 16
        && build
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Where a holder build is installed under `install_dir`.
pub fn installed_holder(install_dir: &Path, build: &str) -> PathBuf {
    install_dir.join(build).join(HOLDER_COMMAND)
}

/// The build a process runs, from its arguments, when its `argv[0]` is a holder installed under
/// `install_dir`; `None` for anything else. A holder runs with `argv[0]` as the daemon gave it,
/// through the limits shell's `exec` too.
pub fn holder_build_of<'a>(argv: &'a [OsString], install_dir: &Path) -> Option<&'a str> {
    let first = argv.first()?.to_str()?;
    let rest = first
        .strip_prefix(install_dir.to_str()?)?
        .strip_prefix('/')?;
    let (build, name) = rest.split_once('/')?;
    (is_holder_build(build) && name == HOLDER_COMMAND).then_some(build)
}

/// Where `root`'s holders bind: one directory, inside the run root, holding nothing else.
pub fn holders_dir(root: &Path) -> PathBuf {
    root.join("holders")
}

/// The socket of the holder for `terminal_id` under `root`.
pub fn holder_socket(root: &Path, terminal_id: &str) -> PathBuf {
    holders_dir(root).join(format!("{terminal_id}.sock"))
}

/// Whether `id` is of the form a terminal id takes.
fn is_terminal_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Whether `path` is absolute and as `resolve` would leave it: no `.` or `..`, no slash doubled
/// or trailing.
fn is_normalized(path: &Path) -> bool {
    let rebuilt: PathBuf = path.components().collect();
    path.is_absolute()
        && !path.components().any(|c| c == Component::ParentDir)
        && rebuilt.as_os_str() == path.as_os_str()
}

/// Why a holder for `terminal_id` may not bind `socket` under the run root `root`, by path
/// alone, or `None` when it may: it must be exactly `holder_socket(root, terminal_id)`, short
/// enough for every OS to bind. A terminal id of the form Bazhen makes, 37 bytes, leaves the root
/// 52.
pub fn holder_socket_refusal(socket: &Path, root: &Path, terminal_id: &str) -> Option<String> {
    if !is_terminal_id(terminal_id) {
        return Some(format!("{terminal_id:?} is no terminal id"));
    }
    if !is_normalized(root) {
        return Some(format!(
            "its root {} is not an absolute, normalized path",
            root.display()
        ));
    }
    let expected = holder_socket(root, terminal_id);
    if socket.as_os_str() != expected.as_os_str() {
        return Some(format!("it is not {}", expected.display()));
    }
    let bytes = socket.as_os_str().len();
    if bytes > HOLDER_SOCKET_MAX_BYTES {
        return Some(format!(
            "it is {bytes} bytes, over the {HOLDER_SOCKET_MAX_BYTES} a socket path may be"
        ));
    }
    None
}

/// Why `binary` can't be run as a holder, or `None` when it can: it must be an absolute path to
/// a regular file named `bazhen-holder`, as the kernel will name it, or a link to one, since the
/// spec it is sent on stdin would be a script to a shell. The file must be this user's, and not
/// writable by every user, who could otherwise choose what the next holder runs. Its group may
/// write it: a umask of 002 builds every binary so, under a group of the user alone.
fn binary_refusal(binary: &Path) -> Option<String> {
    let named = |path: &Path| path.file_name() == Some(OsStr::new(HOLDER_COMMAND));
    if !binary.is_absolute() {
        return Some("it isn't absolute".to_owned());
    }
    if !named(binary) {
        return Some(format!("it isn't named {HOLDER_COMMAND}"));
    }
    let Ok(real) = std::fs::canonicalize(binary) else {
        return Some("it doesn't exist".to_owned());
    };
    if !named(&real) {
        return Some(format!("it links to {}", real.display()));
    }
    let meta = match std::fs::metadata(&real) {
        Ok(meta) => meta,
        Err(e) => return Some(format!("it can't be read: {e}")),
    };
    if !meta.is_file() {
        return Some("it isn't a regular file".to_owned());
    }
    let uid = rustix::process::getuid().as_raw();
    if meta.uid() != uid {
        return Some(format!("it belongs to uid {}", meta.uid()));
    }
    if meta.mode() & 0o002 != 0 {
        return Some("every user may write it".to_owned());
    }
    None
}

/// Why `root` can't hold holders' sockets, or `None` when it can: it must be a directory only
/// this user can enter.
fn root_refusal(root: &Path, uid: u32) -> Option<String> {
    let shown = root.display();
    let Ok(meta) = std::fs::metadata(root) else {
        return Some(format!("its root {shown} does not exist"));
    };
    if !meta.is_dir() {
        return Some(format!("its root {shown} is not a directory"));
    }
    if meta.uid() != uid {
        return Some(format!("its root {shown} belongs to another user"));
    }
    if meta.mode() & 0o077 != 0 {
        return Some(format!("its root {shown} is open to other users"));
    }
    None
}

/// Makes `root`'s holders directory if it isn't there, and refuses unless `root` is a directory
/// of this user's that no one else can enter, and the holders directory one too, not a link to
/// one.
fn private_holders_dir(root: &Path, socket: &str) -> Result<(), StartError> {
    let uid = rustix::process::getuid().as_raw();
    let refuse = |why: String| StartError::Socket {
        socket: socket.to_owned(),
        why,
    };
    if let Some(why) = root_refusal(root, uid) {
        return Err(refuse(why));
    }
    let dir = holders_dir(root);
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Err(e) if e.kind() != io::ErrorKind::AlreadyExists => {
            return Err(StartError::HoldersDir { dir, source: e });
        }
        _ => {}
    }
    let meta = std::fs::symlink_metadata(&dir).map_err(|source| StartError::HoldersDir {
        dir: dir.clone(),
        source,
    })?;
    let shown = dir.display();
    if !meta.is_dir() {
        return Err(refuse(format!("{shown} is not a directory")));
    }
    if meta.uid() != uid {
        return Err(refuse(format!("{shown} belongs to another user")));
    }
    if meta.mode() & 0o077 != 0 {
        return Err(refuse(format!("{shown} is open to other users")));
    }
    Ok(())
}

/// Whether `name` may be one in the holder's own environment. Anything else,
/// `BASH_FUNC_ulimit%%` say, could redefine what the limits shell runs.
fn is_env_name(name: &OsStr) -> bool {
    match name.as_bytes().split_first() {
        Some((first, rest)) => {
            (first.is_ascii_alphabetic() || *first == b'_')
                && rest.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
        }
        None => false,
    }
}

/// Limits a holder runs under, set by a fixed `/bin/sh` that then execs it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HolderLimits {
    /// The CPU-seconds it may use, as `ulimit -t`: one that spins dies of SIGXCPU instead. From 1
    /// to a day.
    pub cpu_seconds: Option<u32>,
}

/// The argv that runs `binary` under `limits` in `scope`: the scope's launcher, then a fixed
/// shell that sets the limits, each exec'ing what follows, or the binary alone.
fn holder_argv(
    binary: &Path,
    limits: HolderLimits,
    scope: Option<&ScopeLaunch>,
) -> Result<Vec<OsString>, StartError> {
    let limited = match limits.cpu_seconds {
        None => vec![binary.as_os_str().to_owned()],
        Some(cpu) if (1..=CPU_SECONDS_MAX).contains(&cpu) => vec![
            OsString::from("/bin/sh"),
            OsString::from("-c"),
            OsString::from(format!(r#"ulimit -t {cpu} && exec "$0" "$@""#)),
            binary.as_os_str().to_owned(),
        ],
        Some(cpu) => return Err(StartError::CpuSeconds(cpu)),
    };
    let Some(scope) = scope else {
        return Ok(limited);
    };
    match scope.argv.first() {
        Some(launcher) if Path::new(launcher).is_absolute() => {
            Ok(scope.argv.iter().cloned().chain(limited).collect())
        }
        launcher => Err(StartError::Launcher(launcher.cloned().unwrap_or_default())),
    }
}

/// What `start_holder` starts, and how.
#[derive(Debug, Clone)]
pub struct StartHolderOptions {
    /// The binary, by absolute path.
    pub binary: PathBuf,
    /// The private run root, whose `holders` directory the spec's socket must be in.
    pub root: PathBuf,
    /// The spawn spec, sent on stdin as JSON.
    pub spec: SpawnSpec,
    /// The holder's own environment; its child's travels in the spec.
    pub env: BTreeMap<OsString, OsString>,
    /// Where the holder is started from; it moves to `/` before it starts anything.
    pub cwd: PathBuf,
    /// How long it has to say `ready` once it runs: up to a minute.
    pub ready: Duration,
    /// How long its launchers have to exec it: up to a minute.
    pub launch: Duration,
    pub limits: HolderLimits,
    /// The scope it starts in, as `terminal_scope` gives it: its launcher runs first and execs
    /// the rest, so the holder keeps the pid that was spawned. Its environment joins the
    /// holder's own.
    pub scope: Option<ScopeLaunch>,
}

impl StartHolderOptions {
    /// `spec`'s holder, from `binary` under `root`, with no environment, from `/`, with the
    /// default waits, no limits and no scope.
    pub fn new(binary: PathBuf, root: PathBuf, spec: SpawnSpec) -> Self {
        Self {
            binary,
            root,
            spec,
            env: BTreeMap::new(),
            cwd: PathBuf::from("/"),
            ready: HOLDER_READY,
            launch: HOLDER_LAUNCH,
            limits: HolderLimits::default(),
            scope: None,
        }
    }
}

/// Why a holder wasn't started: refused before anything was spawned, or failed once it was.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("refusing holder binary {}: {why}", .binary.display())]
    Binary { binary: PathBuf, why: String },
    #[error("refusing the holder's environment names {0}")]
    EnvNames(String),
    #[error("{name} {wait:?} isn't between 1 ms and 60 s")]
    Wait { name: &'static str, wait: Duration },
    #[error("refusing holder socket {socket}: {why}")]
    Socket { socket: String, why: String },
    #[error("the spawn spec can't be written: {0}")]
    SpecUnwritten(String),
    #[error("the spawn spec is {0} bytes, over the {HOLDER_SPEC_MAX_BYTES} a holder reads")]
    SpecSize(usize),
    #[error("cpu_seconds {0} isn't between 1 and {CPU_SECONDS_MAX}")]
    CpuSeconds(u32),
    #[error("refusing scope launcher {}: it isn't absolute", .0.to_string_lossy())]
    Launcher(OsString),
    #[error("making {}: {source}", .dir.display())]
    HoldersDir { dir: PathBuf, source: io::Error },
    #[error(transparent)]
    Failed(#[from] HolderStartFailed),
}

/// How a holder that didn't say `ready` ended, if it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    /// It exited, or a signal ended it.
    Exited(ExitStatus),
    /// It said nothing in time.
    Silent,
    /// Its binary couldn't be run at all.
    Unstarted,
    /// Its launcher didn't run it in time.
    Unlaunched,
    /// Its process couldn't be read as it started, so it may still run.
    Unchecked,
}

impl fmt::Display for Ending {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exited(status) => match (status.code(), status.signal()) {
                (Some(code), _) => write!(f, "it exited {code}"),
                (None, Some(signal)) => write!(f, "signal {signal} ended it"),
                (None, None) => write!(f, "it ended as {status}"),
            },
            Self::Silent => f.write_str("it said nothing in time"),
            Self::Unstarted => f.write_str("it couldn't be run"),
            Self::Unlaunched => f.write_str("its launcher didn't run it in time"),
            Self::Unchecked => f.write_str("the kernel couldn't say what it is"),
        }
    }
}

/// The holder didn't say `ready`: how it ended, if it did, and what it wrote on stderr.
#[derive(Debug)]
pub struct HolderStartFailed {
    pub ending: Ending,
    pub stderr: String,
    /// What else happened, each part led by its own `, ` or `; `.
    pub detail: String,
    /// Whether it may still run: one the kernel didn't show as the holder is never killed.
    pub running: bool,
    /// What stopped the start, when it wasn't the holder.
    pub cause: Option<Box<dyn StdError + Send + Sync>>,
}

impl fmt::Display for HolderStartFailed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let stderr = self.stderr.trim();
        let stderr = if stderr.is_empty() {
            "(no stderr)"
        } else {
            stderr
        };
        write!(
            f,
            "the holder didn't start: {}{}: {stderr}",
            self.ending, self.detail
        )
    }
}

impl StdError for HolderStartFailed {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| -> &(dyn StdError + 'static) { cause })
    }
}

/// A holder that said `ready`, and its handle, which reaps it once it exits.
pub struct StartedHolder {
    pub holder: HolderProcess,
    child: Box<dyn OwnChild>,
}

impl fmt::Debug for StartedHolder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StartedHolder")
            .field("holder", &self.holder)
            .finish_non_exhaustive()
    }
}

impl StartedHolder {
    /// Waits for it to exit, and reaps it: from then on it is sent no rebind.
    ///
    /// # Errors
    ///
    /// When it can't be waited for.
    pub async fn exited(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait().await;
        mark_exited(self.holder.pid, self.holder.start);
        status
    }
}

impl Drop for StartedHolder {
    /// Let go of, it is never sent a rebind: nothing here would see it exit, and its pid be
    /// reused.
    fn drop(&mut self) {
        mark_exited(self.holder.pid, self.holder.start);
    }
}

/// A child this process spawned and holds unreaped until it is waited for.
pub(crate) trait OwnChild: Send {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>>;
    fn wait(&mut self) -> Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send + '_>>;
    /// Sends it SIGKILL, unless it has exited. Whether it was sent.
    fn end(&mut self) -> Result<bool, Error>;
}

impl OwnChild for tokio::process::Child {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        tokio::process::Child::try_wait(self)
    }

    fn wait(&mut self) -> Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send + '_>> {
        Box::pin(tokio::process::Child::wait(self))
    }

    fn end(&mut self) -> Result<bool, Error> {
        if matches!(tokio::process::Child::try_wait(self), Ok(Some(_))) {
            return Ok(false);
        }
        match self
            .id()
            .and_then(|id| RawPid::try_from(id).ok())
            .and_then(Pid::from_raw)
        {
            Some(pid) => crate::signal_child(pid, Signal::KILL),
            None => Ok(false),
        }
    }
}

type Writer = Pin<Box<dyn AsyncWrite + Send>>;

/// A spawned child, with its pipes.
pub(crate) struct Spawned {
    pub(crate) pid: Pid,
    pub(crate) stdin: Writer,
    pub(crate) stdout: Pin<Box<dyn AsyncRead + Send>>,
    pub(crate) stderr: Pin<Box<dyn AsyncRead + Send>>,
    pub(crate) child: Box<dyn OwnChild>,
}

impl fmt::Debug for Spawned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Spawned")
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

/// The OS calls a start makes, replaced in its tests so no real process is reached.
pub(crate) trait StartDeps: Sync {
    fn spawn(
        &self,
        argv: &[OsString],
        env: &BTreeMap<OsString, OsString>,
        cwd: &Path,
    ) -> io::Result<Spawned>;
    fn read(&self, pid: Pid) -> impl Future<Output = Reading> + Send;
    fn kill(&self, proof: HolderProof) -> Result<bool, Error>;
}

/// The real OS.
#[derive(Debug)]
struct Host;

impl StartDeps for Host {
    fn spawn(
        &self,
        argv: &[OsString],
        env: &BTreeMap<OsString, OsString>,
        cwd: &Path,
    ) -> io::Result<Spawned> {
        let (program, rest) = argv
            .split_first()
            .ok_or_else(|| io::Error::other("no program to run"))?;
        let mut child = tokio::process::Command::new(program)
            .args(rest)
            .env_clear()
            .envs(env)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let missing = || io::Error::other("the started holder has no pid or pipe");
        let pid = child
            .id()
            .and_then(|id| RawPid::try_from(id).ok())
            .and_then(Pid::from_raw)
            .ok_or_else(missing)?;
        let stdin = child.stdin.take().ok_or_else(missing)?;
        let stdout = child.stdout.take().ok_or_else(missing)?;
        let stderr = child.stderr.take().ok_or_else(missing)?;
        Ok(Spawned {
            pid,
            stdin: Box::pin(stdin),
            stdout: Box::pin(stdout),
            stderr: Box::pin(stderr),
            child: Box::new(child),
        })
    }

    fn read(&self, pid: Pid) -> impl Future<Output = Reading> + Send {
        std::future::ready(read_process(pid))
    }

    fn kill(&self, proof: HolderProof) -> Result<bool, Error> {
        kill_holder(proof)
    }
}

/// What a caller is told of a holder once it runs, before it reads its spec, so the caller can
/// record it before it can outlive the start. An error stops the start, and the holder is ended.
pub type Recorded = Result<(), Box<dyn StdError + Send + Sync>>;

/// Starts a holder, as a plain child, since it starts a session of its own and a group leader
/// can't, and returns once it says `ready`, when its socket takes connections. Anything else
/// fails with `HolderStartFailed`, and a holder still running then is killed, if the kernel shows
/// it is the holder; one it can't vouch for is left alone and named in the error.
///
/// `on_started` is called once the holder runs and before it reads its spec. For a holder whose
/// process couldn't be read, it is called only once it has been given no spec and still runs,
/// with `UNKNOWN_START`.
///
/// A holder killed after it started its program leaves that program to the hangup its terminal's
/// closing sends, as after any holder's SIGKILL: one that ignores SIGHUP runs on, orphaned.
///
/// # Errors
///
/// Every refusal before anything is spawned, and `Failed` for a holder that didn't say `ready`.
pub async fn start_holder<F, Fut>(
    options: StartHolderOptions,
    on_started: F,
) -> Result<StartedHolder, StartError>
where
    F: FnOnce(HolderProcess) -> Fut + Send,
    Fut: Future<Output = Recorded> + Send,
{
    start_holder_with(options, on_started, &Host).await
}

/// A holder's environment, by name.
type Env = BTreeMap<OsString, OsString>;

/// What a start spawns, once every check before a spawn passes: the spawn spec as JSON, the
/// holder's environment with its scope's, and its argv.
#[derive(Debug)]
struct Checked {
    payload: Vec<u8>,
    env: Env,
    argv: Vec<OsString>,
}

fn checked(options: &StartHolderOptions) -> Result<Checked, StartError> {
    let StartHolderOptions {
        binary,
        root,
        spec,
        env,
        ready,
        launch,
        limits,
        scope,
        ..
    } = options;
    if let Some(why) = binary_refusal(binary) {
        return Err(StartError::Binary {
            binary: binary.clone(),
            why,
        });
    }
    let mut merged = env.clone();
    if let Some(scope) = scope {
        merged.extend(scope.env.iter().cloned());
    }
    let bad: Vec<_> = merged
        .keys()
        .filter(|name| !is_env_name(name))
        .map(|name| name.to_string_lossy().into_owned())
        .collect();
    if !bad.is_empty() {
        return Err(StartError::EnvNames(bad.join(", ")));
    }
    for (name, wait) in [("ready", *ready), ("launch", *launch)] {
        if !(WAIT_MIN..=WAIT_MAX).contains(&wait) {
            return Err(StartError::Wait { name, wait });
        }
    }
    let socket = spec.socket.as_str();
    if let Some(why) = holder_socket_refusal(Path::new(socket), root, spec.terminal_id.as_str()) {
        return Err(StartError::Socket {
            socket: socket.to_owned(),
            why,
        });
    }
    let payload = serde_json::to_vec(spec).map_err(|e| StartError::SpecUnwritten(e.to_string()))?;
    if payload.len() > HOLDER_SPEC_MAX_BYTES {
        return Err(StartError::SpecSize(payload.len()));
    }
    let argv = holder_argv(binary, *limits, scope.as_ref())?;
    private_holders_dir(root, socket)?;
    Ok(Checked {
        payload,
        env: merged,
        argv,
    })
}

async fn start_holder_with<D, F, Fut>(
    options: StartHolderOptions,
    on_started: F,
    deps: &D,
) -> Result<StartedHolder, StartError>
where
    D: StartDeps,
    F: FnOnce(HolderProcess) -> Fut + Send,
    Fut: Future<Output = Recorded> + Send,
{
    let Checked { payload, env, argv } = checked(&options)?;
    let Spawned {
        pid,
        stdin,
        mut stdout,
        stderr,
        child,
    } = match deps.spawn(&argv, &env, &options.cwd) {
        Ok(spawned) => spawned,
        Err(e) => {
            return Err(StartError::Failed(HolderStartFailed {
                ending: Ending::Unstarted,
                stderr: e.to_string(),
                detail: String::new(),
                running: false,
                cause: None,
            }));
        }
    };
    let mut run = Run::new(pid, stdin, stderr, child);
    let mut reading = deps.read(pid).await;
    // A read failing once is often only that: it is tried again, for as long as a vouch would be.
    let read_until = Instant::now() + VOUCH;
    while !matches!(reading, Reading::Running { .. }) && !run.gone() && Instant::now() < read_until
    {
        sleep(VOUCH_POLL).await;
        reading = deps.read(pid).await;
    }
    let Reading::Running { start, .. } = reading else {
        return Err(run.unchecked(&reading, on_started).await.into());
    };
    let holder = HolderProcess { pid, start };
    run.record(start);
    if let Err(cause) = on_started(holder).await {
        let detail = ", as recording it failed".to_owned();
        return Err(run.failure(detail, holder, Some(cause), deps).await.into());
    }
    // The spec goes only to the holder itself: written while a launcher still runs, it would wait
    // in the pipe for a holder exec'd after this start had failed, which would run it unrecorded.
    if !execed(holder, &reading, &mut run, deps, options.launch).await {
        return Err(run.unlaunched().await.into());
    }
    let deadline = Instant::now() + options.ready;
    if let Some(mut stdin) = run.stdin.take() {
        // A holder that exits before it reads its spec breaks the pipe: its exit says why.
        let _ = timeout_at(deadline, async {
            stdin.write_all(&payload).await?;
            stdin.shutdown().await
        })
        .await;
    }
    let said = first_line(&mut stdout, run.child.as_mut(), deadline).await;
    if said.as_deref() != Some(READY) {
        let detail = match said {
            None => String::new(),
            Some(line) => format!(", saying {}", quoted(&line)),
        };
        return Err(run.failure(detail, holder, None, deps).await.into());
    }
    mark_ready(pid, start);
    Ok(StartedHolder {
        holder,
        child: run.child,
    })
}

/// `line` as a JSON string, as JavaScript's `JSON.stringify` shows it.
fn quoted(line: &[u8]) -> String {
    let text = String::from_utf8_lossy(line);
    serde_json::to_string(&text).unwrap_or_else(|_| format!("{text:?}"))
}

/// A start under way: the child it spawned, its stdin until the spec is written or the start
/// gives up, and its stderr, read as it comes.
struct Run {
    pid: Pid,
    child: Box<dyn OwnChild>,
    stdin: Option<Writer>,
    ending: Option<ExitStatus>,
    /// The start it was recorded under, once it was.
    recorded: Option<u64>,
    stderr: Arc<Mutex<Vec<u8>>>,
    reading: JoinSet<()>,
}

impl Run {
    fn new(
        pid: Pid,
        stdin: Writer,
        stderr: Pin<Box<dyn AsyncRead + Send>>,
        child: Box<dyn OwnChild>,
    ) -> Self {
        let kept = Arc::new(Mutex::new(Vec::new()));
        let mut reading = JoinSet::new();
        reading.spawn(keep_stderr(stderr, Arc::clone(&kept)));
        Self {
            pid,
            child,
            stdin: Some(stdin),
            ending: None,
            recorded: None,
            stderr: kept,
            reading,
        }
    }

    /// Records it as a holder this process started, which hasn't said `ready`.
    fn record(&mut self, start: u64) {
        self.recorded = Some(start);
        let exited = self.gone();
        own().insert(
            self.pid.as_raw_pid(),
            Own {
                start,
                ready: false,
                exited,
            },
        );
    }

    /// Whether it has exited, as its handle says now.
    fn gone(&mut self) -> bool {
        if self.ending.is_none()
            && let Ok(Some(status)) = self.child.try_wait()
        {
            self.ending = Some(status);
            if let Some(start) = self.recorded {
                mark_exited(self.pid, start);
            }
        }
        self.ending.is_some()
    }

    /// Waits up to `wait` for it to exit.
    async fn exits_within(&mut self, wait: Duration) {
        let _ = timeout(wait, self.child.wait()).await;
        self.gone();
    }

    /// Waits up to `STDERR_WAIT` for its stderr to end, and what it said.
    async fn said(&mut self) -> String {
        let _ = timeout(STDERR_WAIT, self.reading.join_next()).await;
        self.reading.abort_all();
        let kept = self.stderr.lock().unwrap_or_else(PoisonError::into_inner);
        whole_text(&kept)
    }

    /// Leaves a holder that didn't start to itself: nothing here reads it, waits for it, or sends
    /// it a rebind. Tokio reaps it once it exits.
    fn let_go(self) {
        if let Some(start) = self.recorded {
            mark_exited(self.pid, start);
        }
    }

    /// A holder whose process couldn't be read, given no spec: it should exit, and one that
    /// doesn't in time may still run, so it is recorded, under a start no vouch matches, for a
    /// person.
    async fn unchecked<F, Fut>(mut self, reading: &Reading, on_started: F) -> HolderStartFailed
    where
        F: FnOnce(HolderProcess) -> Fut,
        Fut: Future<Output = Recorded>,
    {
        self.stdin = None;
        self.exits_within(STDERR_WAIT).await;
        let running = !self.gone();
        let cause = if running {
            on_started(HolderProcess {
                pid: self.pid,
                start: UNKNOWN_START,
            })
            .await
            .err()
        } else {
            None
        };
        let stderr = self.said().await;
        let ending = self.ending.map_or(Ending::Unchecked, Ending::Exited);
        self.let_go();
        HolderStartFailed {
            ending,
            stderr,
            detail: format!(", as {reading}"),
            running,
            cause,
        }
    }

    /// A launcher that didn't exec the holder in time, ended through the child's own handle:
    /// still the child spawned here and unreaped, whatever it runs now. One it execs after this
    /// finds no spec and exits.
    async fn unlaunched(mut self) -> HolderStartFailed {
        self.stdin = None;
        let sent = if self.gone() {
            Ok(false)
        } else {
            self.child.end()
        };
        self.exits_within(STDERR_WAIT).await;
        let stderr = self.said().await;
        let running = !self.gone();
        let pid = self.pid.as_raw_pid();
        let detail = match (running, sent) {
            (false, _) => String::new(),
            (true, Err(e)) => format!("; pid {pid} couldn't be sent SIGKILL: {e}"),
            (true, Ok(_)) => format!("; pid {pid} was sent SIGKILL and hasn't exited yet"),
        };
        let ending = self.ending.map_or(Ending::Unlaunched, Ending::Exited);
        self.let_go();
        HolderStartFailed {
            ending,
            stderr,
            detail,
            running,
            cause: None,
        }
    }

    /// A holder that started and didn't say `ready`, killed once the kernel shows it is the
    /// holder.
    async fn failure<D: StartDeps>(
        mut self,
        detail: String,
        holder: HolderProcess,
        cause: Option<Box<dyn StdError + Send + Sync>>,
        deps: &D,
    ) -> HolderStartFailed {
        self.stdin = None;
        // Before the kill, whose end would read as the holder's own.
        self.gone();
        let ending = self.ending.map_or(Ending::Silent, Ending::Exited);
        let (running, note) = self.end_unready(holder, deps).await;
        let stderr = self.said().await;
        self.let_go();
        HolderStartFailed {
            ending,
            stderr,
            detail: match note {
                Some(note) => format!("{detail}; {note}"),
                None => detail,
            },
            running,
            cause,
        }
    }

    /// Kills a holder that never said `ready`, once the kernel shows it is the holder, as a
    /// launcher that execs it soon does; one that exits meanwhile needs nothing. One the kernel
    /// never shows as the holder is ended through the child's own handle, which reaches it only
    /// while it is unreaped and so still the process spawned here, whatever it runs now. Whether
    /// it may still run, and what to say of it.
    async fn end_unready<D: StartDeps>(
        &mut self,
        holder: HolderProcess,
        deps: &D,
    ) -> (bool, Option<String>) {
        let deadline = Instant::now() + VOUCH;
        let mut proof = None;
        while !self.gone() && proof.is_none() && Instant::now() < deadline {
            proof = vouched(holder, HolderUse::Kill, &deps.read(holder.pid).await);
            if proof.is_none() {
                sleep(VOUCH_POLL).await;
            }
        }
        if self.gone() {
            return (false, None);
        }
        let pid = holder.pid.as_raw_pid();
        let Some(proof) = proof else {
            return match self.child.end() {
                Ok(true) => {
                    let note = "the kernel doesn't show it is the holder, so it was killed through \
                                its own handle";
                    (false, Some(note.to_owned()))
                }
                Ok(false) => (false, None),
                Err(e) => {
                    let note = format!(
                        "pid {pid} is left running, as the kernel doesn't show it is the holder \
                         and it couldn't be sent SIGKILL: {e}"
                    );
                    (true, Some(note))
                }
            };
        };
        match deps.kill(proof) {
            Ok(true) => (false, Some("it was killed".to_owned())),
            Ok(false) => (false, None),
            Err(e) => (true, Some(format!("pid {pid} may still run: {e}"))),
        }
    }
}

/// Whether `holder.pid` runs the holder itself within `wait`, as the kernel shows it once every
/// launcher before it has exec'd: false for one that exits first, or still runs something else.
async fn execed<D: StartDeps>(
    holder: HolderProcess,
    first: &Reading,
    run: &mut Run,
    deps: &D,
    wait: Duration,
) -> bool {
    let deadline = Instant::now() + wait;
    let mut reading = first.clone();
    while !is_holder(&reading, holder) {
        if run.gone() || Instant::now() >= deadline {
            return false;
        }
        sleep(VOUCH_POLL).await;
        reading = deps.read(holder.pid).await;
    }
    !run.gone()
}

/// Reads a child's stderr as it comes, keeping its first `STDERR_MAX` bytes and dropping the
/// rest, so a child that writes more never blocks on it.
async fn keep_stderr(mut from: Pin<Box<dyn AsyncRead + Send>>, into: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0; 4096];
    loop {
        match from.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let mut kept = into.lock().unwrap_or_else(PoisonError::into_inner);
                let room = STDERR_MAX.saturating_sub(kept.len());
                kept.extend_from_slice(chunk.get(..n.min(room)).unwrap_or_default());
            }
        }
    }
}

/// `bytes` as text, less a character the cap cut in two, and with any other bytes that aren't
/// UTF-8 replaced.
fn whole_text(bytes: &[u8]) -> String {
    let cut = match std::str::from_utf8(bytes) {
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        _ => bytes.len(),
    };
    String::from_utf8_lossy(bytes.get(..cut).unwrap_or(bytes)).into_owned()
}

/// The child's first line, its `\n` kept, or its first `FIRST_LINE_MAX` bytes when it says more
/// with none; `None` when it ends first, or says none by `deadline`. It stops reading once it has
/// decided.
async fn first_line(
    stdout: &mut Pin<Box<dyn AsyncRead + Send>>,
    child: &mut dyn OwnChild,
    deadline: Instant,
) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut chunk = [0; FIRST_LINE_MAX + 1];
    loop {
        let read = {
            let reading = pin!(stdout.read(&mut chunk));
            match timeout_at(deadline, select(reading, child.wait())).await {
                Ok(Either::Left((read, _))) => read,
                Ok(Either::Right(_)) | Err(_) => return None,
            }
        };
        match read {
            Ok(0) | Err(_) => {
                let _ = timeout_at(deadline, child.wait()).await;
                return None;
            }
            Ok(n) => out.extend_from_slice(chunk.get(..n).unwrap_or_default()),
        }
        if let Some(end) = out.iter().position(|&b| b == b'\n') {
            out.truncate(end + 1);
            return Some(out);
        }
        if out.len() > FIRST_LINE_MAX {
            out.truncate(FIRST_LINE_MAX);
            return Some(out);
        }
    }
}

#[cfg(test)]
mod tests {
    //! The guard with a reading and a send that are recorded, and starts with a fake child, a fake
    //! reading and a kill that is recorded, never sent: no process is started or signalled, except
    //! by the tests marked as running only in a sandbox.

    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt as _;
    use std::os::unix::process::ExitStatusExt as _;
    use std::path::{Path, PathBuf};
    use std::process::ExitStatus;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use bazhen_holder_proto::body::SpawnSpec;
    use futures_util::future::join;
    use rustix::process::{Pid, RawPid, Signal};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _, DuplexStream};
    use tokio::sync::watch;
    use tokio::time::{Instant, sleep};

    use super::{
        Ending, HolderProcess, HolderProof, HolderUse, OwnChild, PROOF_LIFE, Reading, Recorded,
        Spawned, StartDeps, StartError, StartHolderOptions, StartedHolder, UNKNOWN_START,
        holder_build_of, holder_socket, holder_socket_refusal, holders_dir, installed_holder,
        is_holder_build, kill_holder_by, read_process, rebind_holder_by, rebind_holder_with, shown,
        start_holder_with, vouched, whole_text,
    };
    use crate::{Error, Target, Unsafe};

    /// Above every system's pid limit, so even a broken guard reaches no process.
    const PID: RawPid = (1 << 22) + 1;
    const START: u64 = 1_794_630_000;

    /// The fake holder's pid, which every fake takes from here, checked against this system's
    /// limit first.
    fn pid() -> Pid {
        assert!(
            i64::from(PID) > pid_limit(),
            "{PID} isn't above {}",
            pid_limit()
        );
        Pid::from_raw(PID).unwrap()
    }

    fn holder() -> HolderProcess {
        HolderProcess {
            pid: pid(),
            start: START,
        }
    }

    /// The most a pid can be here: Linux says; macOS's is fixed.
    fn pid_limit() -> i64 {
        std::fs::read_to_string("/proc/sys/kernel/pid_max")
            .ok()
            .and_then(|max| max.trim().parse().ok())
            .unwrap_or(99_999)
    }

    fn running(comm: &str, start: u64) -> Reading {
        Reading::Running {
            comm: OsString::from(comm),
            start,
        }
    }

    fn holder_at(start: u64) -> Reading {
        running("bazhen-holder", start)
    }

    fn stranger() -> Reading {
        running("sleep", START)
    }

    fn launcher_at(start: u64) -> Reading {
        running("systemd-run", start)
    }

    fn unreadable() -> Reading {
        Reading::Unreadable("ps failed".to_owned())
    }

    fn proof(made_for: HolderUse) -> HolderProof {
        vouched(holder(), made_for, &holder_at(START)).unwrap()
    }

    /// Whatever would be sent, recorded instead.
    #[derive(Debug, Default)]
    struct Sends(Mutex<Vec<(Pid, Signal)>>);

    impl Sends {
        fn send(&self) -> impl FnOnce(HolderProcess, Signal) -> Result<bool, Error> + '_ {
            |holder, signal| {
                assert_eq!(holder, self::holder());
                self.0.lock().unwrap().push((holder.pid, signal));
                Ok(true)
            }
        }

        fn sent(&self) -> Vec<(Pid, Signal)> {
            self.0.lock().unwrap().clone()
        }
    }

    fn refused(why: Unsafe) -> Result<bool, Error> {
        Err(Error::Unsafe {
            target: Target::Process(pid()),
            why,
        })
    }

    #[test]
    fn vouches_for_a_bazhen_holder_that_started_when_the_ledger_says() {
        let proof = vouched(holder(), HolderUse::Kill, &holder_at(START + 2)).unwrap();
        assert_eq!(proof.holder(), holder());
    }

    #[test]
    fn distinguishes_an_unreadable_holder_from_one_that_is_gone() {
        let readings = [holder_at(START), Reading::Absent, unreadable(), stranger()];
        assert_eq!(
            readings.map(|reading| super::running_by(holder(), |_| reading)),
            [Some(true), Some(false), None, Some(false)]
        );
    }

    #[test]
    fn finds_a_holder_vouchable_only_where_the_kernel_shows_one_that_started_when_it_says() {
        let read = std::cell::Cell::new(0);
        let shown = |reading: Reading| {
            let read = &read;
            move |at: Pid| {
                assert_eq!(at, pid());
                read.set(read.get() + 1);
                reading
            }
        };
        let vouchable = [
            holder_at(START + super::START_SKEW_S),
            holder_at(START + super::START_SKEW_S + 1),
            stranger(),
            Reading::Absent,
            unreadable(),
        ]
        .map(|reading| super::vouchable_by(holder(), shown(reading)));
        assert_eq!(vouchable, [true, false, false, false, false]);
        // Init is never read, whatever would be shown there.
        let init = HolderProcess {
            pid: Pid::from_raw(1).unwrap(),
            start: START,
        };
        let before = read.get();
        assert!(!super::vouchable_by(init, |_| holder_at(START)));
        assert_eq!((before, read.get()), (5, 5));
    }

    #[test]
    fn finds_no_holder_vouchable_at_a_free_pid_at_this_process_or_at_init() {
        let me = rustix::process::getpid();
        let my_start = bazhen_holder::start_time::of(me).unwrap().get();
        let at = |pid, start| super::is_vouchable(HolderProcess { pid, start });
        assert_eq!(
            [
                at(pid(), START),
                at(me, my_start),
                at(Pid::from_raw(1).unwrap(), 0)
            ],
            [false; 3]
        );
    }

    #[test]
    fn vouches_for_nothing_else_at_the_pid() {
        let others = [
            running("bazhen-holderx", START),
            running("sleep", START),
            holder_at(START + 3),
            holder_at(START - 3),
            Reading::Absent,
            unreadable(),
        ];
        for other in others {
            assert!(
                vouched(holder(), HolderUse::Kill, &other).is_none(),
                "{other:?}"
            );
        }
    }

    /// Read again once its pid is pinned, a holder that has left is sent nothing, and one that
    /// can't be read, which may still run, is refused rather than taken for gone.
    #[test]
    fn shows_a_pinned_pid_as_the_holder_only_where_the_kernel_shows_it_still() {
        let shows = [
            holder_at(START),
            holder_at(START + super::START_SKEW_S),
            holder_at(START + super::START_SKEW_S + 1),
            running("bazhen-holderx", START),
            stranger(),
            Reading::Absent,
            unreadable(),
        ]
        .map(|reading| shown(holder(), &reading));
        assert_eq!(
            shows,
            [
                Ok(true),
                Ok(true),
                Ok(false),
                Ok(false),
                Ok(false),
                Ok(false),
                Err(Unsafe::Unshown)
            ]
        );
    }

    /// Taken by value, a proof is spent by the one call that takes it.
    #[test]
    fn kills_only_a_holder_vouched_for_in_the_last_second_and_only_once() {
        let sends = Sends::default();
        let stale = proof(HolderUse::Kill);
        let later = stale.made + PROOF_LIFE + Duration::from_millis(1);
        assert_eq!(
            kill_holder_by(stale, later, sends.send()),
            refused(Unsafe::Stale)
        );
        let early = proof(HolderUse::Kill);
        let before = early.made.checked_sub(Duration::from_millis(1)).unwrap();
        assert_eq!(
            kill_holder_by(early, before, sends.send()),
            refused(Unsafe::Stale)
        );
        let fresh = proof(HolderUse::Kill);
        let now = fresh.made;
        assert_eq!(kill_holder_by(fresh, now, sends.send()), Ok(true));
        assert_eq!(sends.sent(), [(pid(), Signal::KILL)]);
    }

    #[test]
    fn sends_sigusr1_only_to_a_holder_vouched_for_a_rebind_in_the_last_second_and_only_once() {
        let sends = Sends::default();
        let stale = proof(HolderUse::Rebind);
        let later = stale.made + PROOF_LIFE + Duration::from_millis(1);
        assert_eq!(
            rebind_holder_by(stale, later, sends.send()),
            refused(Unsafe::Stale)
        );
        let fresh = proof(HolderUse::Rebind);
        let now = fresh.made;
        assert_eq!(rebind_holder_by(fresh, now, sends.send()), Ok(true));
        assert_eq!(sends.sent(), [(pid(), Signal::USR1)]);
    }

    #[test]
    fn never_takes_a_proof_made_for_the_other_kind_of_signal() {
        let sends = Sends::default();
        let for_kill = proof(HolderUse::Kill);
        let now = for_kill.made;
        assert_eq!(
            rebind_holder_by(for_kill, now, sends.send()),
            refused(Unsafe::Unvouched)
        );
        let for_rebind = proof(HolderUse::Rebind);
        let now = for_rebind.made;
        assert_eq!(
            kill_holder_by(for_rebind, now, sends.send()),
            refused(Unsafe::Unvouched)
        );
        assert_eq!(sends.sent(), []);
    }

    /// A wait no test takes, by the paused clock: one that waits on nothing else ends there.
    const STUCK: Duration = Duration::from_secs(600);

    /// A runtime whose clock moves only when every task waits, so a test's waits take no time,
    /// and a test left waiting on nothing fails at once rather than hangs.
    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .start_paused(true)
            .build()
            .unwrap()
            .block_on(async { tokio::time::timeout(STUCK, future).await })
            .expect("the test waited on nothing that would come")
    }

    /// A rebind that records the holder each proof was made for.
    fn rebinds(
        sent: &Mutex<Vec<HolderProcess>>,
    ) -> impl FnOnce(HolderProof) -> Result<bool, Error> {
        |proof| {
            sent.lock().unwrap().push(proof.holder());
            Ok(true)
        }
    }

    #[test]
    fn rebinds_a_holder_the_kernel_shows_and_nothing_else_at_its_pid() {
        let sent = Mutex::new(Vec::new());
        block_on(async {
            for other in [stranger(), holder_at(START + 9), Reading::Absent] {
                let read = async |_| other;
                assert_eq!(
                    rebind_holder_with(holder(), read, rebinds(&sent)).await,
                    Ok(false)
                );
            }
            let read = async |_| holder_at(START);
            assert_eq!(
                rebind_holder_with(holder(), read, rebinds(&sent)).await,
                Ok(true)
            );
        });
        assert_eq!(*sent.lock().unwrap(), [holder()]);
    }

    #[test]
    fn may_be_only_the_terminal_s_own_socket_in_the_run_root_s_holders_directory() {
        let root = Path::new("/run/bz");
        assert_eq!(
            holder_socket_refusal(&holder_socket(root, "term_1"), root, "term_1"),
            None
        );
        let refused = [
            ("/run/bz/holders/term_2.sock", "term_1"),
            ("/run/bz/term_1.sock", "term_1"),
            ("/run/bz/holders/x/../term_1.sock", "term_1"),
            ("run/bz/holders/term_1.sock", "term_1"),
            ("/tmp/holders/term_1.sock", "term_1"),
            ("/run/bz/holders/a/b.sock", "a/b"),
            ("/run/bz/holders/.sock", ""),
        ];
        let allowed: Vec<_> = refused
            .iter()
            .filter(|(socket, id)| holder_socket_refusal(Path::new(socket), root, id).is_none())
            .collect();
        assert_eq!(allowed, [] as [&(&str, &str); 0]);
    }

    #[test]
    fn is_refused_over_103_bytes_which_macos_can_t_bind() {
        let fits = PathBuf::from(format!(
            "/{}",
            "r".repeat(103 - "/holders/".len() - "x.sock".len() - 1)
        ));
        assert_eq!(
            holder_socket_refusal(&holder_socket(&fits, "x"), &fits, "x"),
            None
        );
        let over = PathBuf::from(format!("{}r", fits.display()));
        let why = holder_socket_refusal(&holder_socket(&over, "x"), &over, "x");
        assert!(
            why.as_deref().is_some_and(|why| why.contains("103")),
            "{why:?}"
        );
    }

    #[test]
    fn is_refused_under_a_root_that_isn_t_absolute_and_normalized() {
        for root in [
            "/run/bz/",
            "/run//bz",
            "/run/./bz",
            "/run/x/../bz",
            "run/bz",
        ] {
            let socket = Path::new("/run/bz/holders/t.sock");
            let why = holder_socket_refusal(socket, Path::new(root), "t").unwrap();
            assert!(why.contains("root"), "{root}: {why}");
        }
    }

    const INSTALL: &str = "/home/u/.local/state/bazhen/holder";
    const BUILD: &str = "0123456789abcdef";

    fn argv(words: &[&str]) -> Vec<OsString> {
        words.iter().map(OsString::from).collect()
    }

    #[test]
    fn is_read_from_an_argv_0_installed_under_the_directory_with_or_without_arguments() {
        let dir = Path::new(INSTALL);
        let installed = installed_holder(dir, BUILD);
        let installed = installed.to_str().unwrap();
        assert_eq!(holder_build_of(&argv(&[installed]), dir), Some(BUILD));
        assert_eq!(
            holder_build_of(&argv(&[installed, "--flag"]), dir),
            Some(BUILD)
        );
        assert!(is_holder_build(BUILD));
    }

    #[test]
    fn is_none_for_any_other_process_however_close_its_path() {
        let dir = Path::new(INSTALL);
        let installed = format!("{INSTALL}/{BUILD}/bazhen-holder");
        let script = r#"ulimit -t 5 && exec "$0" "$@""#;
        let others = [
            argv(&["/bin/sh", "-c", script, &installed]),
            argv(&["vim", &installed]),
            argv(&[&format!("{INSTALL}x/{BUILD}/bazhen-holder")]),
            argv(&[&format!("{INSTALL}/{BUILD}0/bazhen-holder")]),
            argv(&[&format!("{INSTALL}/0123456789ABCDEF/bazhen-holder")]),
            argv(&[&format!("{INSTALL}/{BUILD}/bazhen-holderx")]),
            argv(&[&format!("{INSTALL}/{BUILD}/sub/bazhen-holder")]),
            argv(&[&format!("{INSTALL}/{BUILD}")]),
            argv(&[&format!("{INSTALL}/.tmp-01234567/bazhen-holder")]),
            argv(&[&format!("{INSTALL}/{BUILD}/bazhen-holder --flag")]),
            argv(&[]),
        ];
        for other in &others {
            assert_eq!(holder_build_of(other, dir), None, "{other:?}");
        }
    }

    #[test]
    fn keeps_whole_characters_of_a_cut_stderr() {
        let cut = "é".as_bytes().get(..1).unwrap();
        assert_eq!(whole_text(&[b"ab".as_slice(), cut].concat()), "ab");
        assert_eq!(whole_text(b"a\xffb"), "a\u{fffd}b");
    }

    /// A directory of the test's own, private to this user, removed when this drops.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "bz-hg-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A regular file named as the holder is, which nothing here runs: the spawn is a fake.
    fn binary(dir: &TempDir) -> PathBuf {
        let binary = dir.path().join("bazhen-holder");
        std::fs::write(&binary, "").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        binary
    }

    fn spec_for(root: &Path, extra: &[(&str, serde_json::Value)]) -> SpawnSpec {
        let mut spec = serde_json::json!({
            "argv": ["sh"], "cwd": "/", "env": {}, "generation": 0, "protocol": ["1.0"],
            "terminalId": "term_1", "socket": holder_socket(root, "term_1"), "tags": {},
            "size": { "cols": 80, "rows": 24 },
        });
        for (key, value) in extra {
            spec[*key] = value.clone();
        }
        serde_json::from_value(spec).unwrap()
    }

    /// What a test holds of a fake child: the far ends of its pipes, its exit, and the signals
    /// sent through its own handle, none of which reaches a process.
    struct Far {
        stdin: Option<DuplexStream>,
        stdout: Option<DuplexStream>,
        stderr: Option<DuplexStream>,
        exit: Arc<watch::Sender<Option<ExitStatus>>>,
        signalled: Arc<Mutex<Vec<Signal>>>,
        reaped: Arc<AtomicBool>,
    }

    impl Far {
        /// Has something other than its handle reap it, so its pid may be another's.
        fn reaped_elsewhere(&self) {
            self.reaped.store(true, Ordering::Relaxed);
        }

        /// Everything written to its stdin, once that ends.
        async fn sent(&mut self) -> Vec<u8> {
            let mut sent = Vec::new();
            if let Some(stdin) = &mut self.stdin {
                stdin.read_to_end(&mut sent).await.unwrap();
            }
            sent
        }

        async fn says(&mut self, text: &[u8]) {
            self.stdout.as_mut().unwrap().write_all(text).await.unwrap();
        }

        async fn complains(&mut self, text: &[u8]) {
            self.stderr.as_mut().unwrap().write_all(text).await.unwrap();
        }

        fn exits(&mut self, code: i32) {
            self.stderr = None;
            exit(&self.exit, code);
        }

        fn signalled(&self) -> Vec<Signal> {
            self.signalled.lock().unwrap().clone()
        }
    }

    fn exit(exit: &watch::Sender<Option<ExitStatus>>, code: i32) {
        exit.send_replace(Some(ExitStatus::from_raw(code << 8)));
    }

    #[derive(Debug)]
    struct FakeChild {
        exit: watch::Receiver<Option<ExitStatus>>,
        signalled: Arc<Mutex<Vec<Signal>>>,
        reaped: Arc<AtomicBool>,
    }

    impl OwnChild for FakeChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            Ok(*self.exit.borrow())
        }

        fn wait(
            &mut self,
        ) -> std::pin::Pin<Box<dyn Future<Output = std::io::Result<ExitStatus>> + Send + '_>>
        {
            Box::pin(async move {
                if let Ok(status) = self.exit.wait_for(Option::is_some).await
                    && let Some(status) = *status
                {
                    return Ok(status);
                }
                std::future::pending().await
            })
        }

        /// As `signal_child` does, it refuses a child something else reaped.
        fn end(&mut self) -> Result<bool, Error> {
            if self.reaped.load(Ordering::Relaxed) {
                return Err(Error::Unsafe {
                    target: Target::Process(pid()),
                    why: Unsafe::Reaped,
                });
            }
            self.signalled.lock().unwrap().push(Signal::KILL);
            Ok(true)
        }
    }

    fn fake() -> (Spawned, Far) {
        let (stdin, far_stdin) = tokio::io::duplex(1 << 21);
        let (far_stdout, stdout) = tokio::io::duplex(1 << 16);
        let (far_stderr, stderr) = tokio::io::duplex(1 << 16);
        let (exit, exited) = watch::channel(None);
        let signalled = Arc::new(Mutex::new(Vec::new()));
        let reaped = Arc::new(AtomicBool::new(false));
        let spawned = Spawned {
            pid: pid(),
            stdin: Box::pin(stdin),
            stdout: Box::pin(stdout),
            stderr: Box::pin(stderr),
            child: Box::new(FakeChild {
                exit: exited,
                signalled: Arc::clone(&signalled),
                reaped: Arc::clone(&reaped),
            }),
        };
        let far = Far {
            stdin: Some(far_stdin),
            stdout: Some(far_stdout),
            stderr: Some(far_stderr),
            exit: Arc::new(exit),
            signalled,
            reaped,
        };
        (spawned, far)
    }

    type Read = Box<dyn Fn(usize) -> Reading + Send + Sync>;

    fn always(reading: Reading) -> Read {
        Box::new(move |_| reading.clone())
    }

    /// Each of `steps` in turn, the last of them again from then on.
    fn in_turn(steps: Vec<Reading>) -> Read {
        Box::new(move |n| steps[n.min(steps.len() - 1)].clone())
    }

    /// The OS as a start sees it: one fake child to spawn, a reading, and a kill recorded.
    struct Fakes {
        child: Mutex<Option<Spawned>>,
        spawned: Mutex<Vec<(Vec<OsString>, super::Env)>>,
        read: Read,
        reads: AtomicUsize,
        kills: Mutex<Vec<HolderProcess>>,
    }

    impl Fakes {
        fn new(child: Option<Spawned>, read: Read) -> Self {
            Self {
                child: Mutex::new(child),
                spawned: Mutex::new(Vec::new()),
                read,
                reads: AtomicUsize::new(0),
                kills: Mutex::new(Vec::new()),
            }
        }

        fn reads(&self) -> usize {
            self.reads.load(Ordering::Relaxed)
        }

        fn kills(&self) -> Vec<HolderProcess> {
            self.kills.lock().unwrap().clone()
        }

        fn spawned(&self) -> Vec<(Vec<OsString>, super::Env)> {
            self.spawned.lock().unwrap().clone()
        }
    }

    impl StartDeps for Fakes {
        fn spawn(
            &self,
            argv: &[OsString],
            env: &BTreeMap<OsString, OsString>,
            _cwd: &Path,
        ) -> std::io::Result<Spawned> {
            self.spawned
                .lock()
                .unwrap()
                .push((argv.to_vec(), env.clone()));
            self.child.lock().unwrap().take().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "spawn /opt/bazhen/bazhen-holder ENOENT",
                )
            })
        }

        async fn read(&self, _pid: Pid) -> Reading {
            let reading = (self.read)(self.reads.fetch_add(1, Ordering::Relaxed));
            // As a real read would, it lets the rest of the runtime run.
            tokio::task::yield_now().await;
            reading
        }

        fn kill(&self, proof: HolderProof) -> Result<bool, Error> {
            self.kills.lock().unwrap().push(proof.holder());
            Ok(true)
        }
    }

    /// A start's root and the directory of its binary, which must outlive it.
    struct Dirs {
        root: TempDir,
        _bin: TempDir,
    }

    /// A start's directories and options, with a 2 s wait for `ready`.
    fn setup() -> (Dirs, StartHolderOptions) {
        let root = TempDir::new();
        let bin = TempDir::new();
        let mut options = StartHolderOptions::new(
            binary(&bin),
            root.path().to_owned(),
            spec_for(root.path(), &[]),
        );
        options.ready = Duration::from_secs(2);
        (Dirs { root, _bin: bin }, options)
    }

    async fn unrecorded(_: HolderProcess) -> Recorded {
        Ok(())
    }

    /// The start of `options` against `fakes`, alongside what the fake child does, `far`.
    async fn started<T>(
        options: StartHolderOptions,
        fakes: &Fakes,
        far: impl Future<Output = T>,
    ) -> (Result<StartedHolder, StartError>, T) {
        join(start_holder_with(options, unrecorded, fakes), far).await
    }

    fn failed(result: Result<StartedHolder, StartError>) -> super::HolderStartFailed {
        match result {
            Err(StartError::Failed(failed)) => failed,
            other => panic!("not a failed start: {other:?}"),
        }
    }

    fn exited(code: i32) -> Ending {
        Ending::Exited(ExitStatus::from_raw(code << 8))
    }

    #[test]
    fn sends_the_spec_on_stdin_and_resolves_on_ready_leaving_the_holder_unwaited_for() {
        let (dirs, options) = setup();
        let root = &dirs.root;
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let spec = options.spec.clone();
        let binary = options.binary.clone();
        let (started, sent) = block_on(started(options, &fakes, async {
            let sent = far.sent().await;
            far.says(b"ready\n").await;
            sent
        }));
        assert_eq!(started.unwrap().holder, holder());
        assert_eq!(serde_json::from_slice::<SpawnSpec>(&sent).unwrap(), spec);
        assert_eq!(fakes.kills(), []);
        assert_eq!(
            fakes.spawned(),
            [(vec![binary.into_os_string()], BTreeMap::new())]
        );
        let mode = std::fs::metadata(holders_dir(root.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn fails_with_the_exit_code_and_stderr_of_a_holder_that_exits_first_and_kills_nothing() {
        let (_dirs, options) = setup();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let (started, ()) = block_on(started(options, &fakes, async {
            far.sent().await;
            far.complains(b"bazhen-holder: invalid spawn spec: no argv\n")
                .await;
            far.exits(2);
        }));
        let failed = failed(started);
        assert_eq!((failed.ending, failed.running), (exited(2), false));
        assert!(failed.stderr.contains("no argv"), "{failed}");
        assert_eq!((fakes.kills(), fakes.reads()), (vec![], 1));
    }

    #[test]
    fn survives_a_holder_that_exits_before_it_reads_its_spec_breaking_the_pipe() {
        let (_dirs, options) = setup();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        far.stdin = None;
        let (started, ()) = block_on(started(options, &fakes, async {
            sleep(Duration::from_millis(100)).await;
            far.exits(9);
        }));
        let failed = failed(started);
        assert_eq!((failed.ending, failed.running), (exited(9), false));
        assert_eq!(fakes.kills(), []);
    }

    #[test]
    fn kills_a_holder_that_says_anything_but_ready_once_by_a_proof_for_its_pid_and_start() {
        let (_dirs, options) = setup();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let (started, ()) = block_on(started(options, &fakes, async {
            far.sent().await;
            far.says(b"hello\n").await;
        }));
        let failed = failed(started);
        assert!(
            failed
                .to_string()
                .contains(r#"saying "hello\n"; it was killed"#),
            "{failed}"
        );
        assert!(!failed.running);
        assert_eq!(fakes.kills(), [holder()]);
    }

    #[test]
    fn takes_a_first_line_no_longer_than_it_reads_rather_than_waiting_on_one_that_never_ends() {
        let (_dirs, options) = setup();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let (started, ()) = block_on(started(options, &fakes, async {
            far.sent().await;
            far.says("x".repeat(100).as_bytes()).await;
        }));
        let failed = failed(started);
        let said = format!("saying \"{}\"", "x".repeat(64));
        assert!(failed.to_string().contains(&said), "{failed}");
        assert_eq!(fakes.kills().len(), 1);
    }

    #[test]
    fn keeps_no_more_of_stderr_than_it_reports() {
        let (_dirs, options) = setup();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let (started, ()) = block_on(started(options, &fakes, async {
            far.sent().await;
            far.complains("e".repeat(20_000).as_bytes()).await;
            far.exits(1);
        }));
        assert_eq!(failed(started).stderr, "e".repeat(8 * 1024));
    }

    #[test]
    fn kills_a_silent_holder_once_and_only_after_the_kernel_has_shown_it_is_the_holder() {
        let (_dirs, mut options) = setup();
        options.ready = Duration::from_millis(50);
        let (child, _far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let (started, ()) = block_on(started(options, &fakes, async {}));
        let failed = failed(started);
        assert_eq!((failed.ending, failed.running), (Ending::Silent, false));
        assert_eq!((fakes.kills(), fakes.reads()), (vec![holder()], 2));
    }

    /// Unreaped, its own child's pid is still its own, whatever the kernel shows it runs.
    #[test]
    fn ends_its_own_child_through_its_handle_when_the_kernel_shows_a_stranger_at_its_pid() {
        let (_dirs, mut options) = setup();
        options.ready = Duration::from_millis(50);
        let (child, far) = fake();
        let fakes = Fakes::new(Some(child), in_turn(vec![holder_at(START), stranger()]));
        let (started, ()) = block_on(started(options, &fakes, async {}));
        let failed = failed(started);
        assert!(
            failed.to_string().contains("killed through its own handle"),
            "{failed}"
        );
        assert!(!failed.running);
        assert_eq!(
            (fakes.kills(), far.signalled()),
            (vec![], vec![Signal::KILL])
        );
    }

    /// Reaped by something else, its pid may be another process's, which nothing here reaches.
    #[test]
    fn leaves_a_stranger_at_the_holder_s_pid_alone_names_it_and_says_it_may_still_run() {
        let (_dirs, mut options) = setup();
        options.ready = Duration::from_millis(50);
        let (child, far) = fake();
        far.reaped_elsewhere();
        let fakes = Fakes::new(Some(child), in_turn(vec![holder_at(START), stranger()]));
        let (started, ()) = block_on(started(options, &fakes, async {}));
        let failed = failed(started);
        assert!(
            failed
                .to_string()
                .contains(&format!("pid {PID} is left running")),
            "{failed}"
        );
        assert!(failed.running);
        assert_eq!((fakes.kills(), far.signalled()), (vec![], vec![]));
    }

    /// A reused pid's start differs, and a pid is reused only once its child was reaped.
    #[test]
    fn leaves_a_holder_alone_whose_start_no_longer_matches_as_a_reused_pid_s_wouldn_t() {
        let (_dirs, mut options) = setup();
        options.ready = Duration::from_millis(50);
        let (child, far) = fake();
        far.reaped_elsewhere();
        let readings = in_turn(vec![holder_at(START), holder_at(START + 60)]);
        let fakes = Fakes::new(Some(child), readings);
        let (started, ()) = block_on(started(options, &fakes, async {}));
        assert!(failed(started).running);
        assert_eq!((fakes.kills(), far.signalled()), (vec![], vec![]));
    }

    #[test]
    fn fails_a_binary_that_can_t_be_run_as_one_that_never_started() {
        let (_dirs, options) = setup();
        let fakes = Fakes::new(None, always(holder_at(START)));
        let (started, ()) = block_on(started(options, &fakes, async {}));
        let failed = failed(started);
        assert_eq!(failed.ending, Ending::Unstarted);
        assert!(failed.to_string().contains("ENOENT"), "{failed}");
        assert_eq!(fakes.reads(), 0);
    }

    #[test]
    fn ends_a_holder_whose_recording_fails_before_it_reads_its_spec_with_that_as_the_cause() {
        let (_dirs, mut options) = setup();
        options.ready = Duration::from_millis(50);
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let recorded = Mutex::new(Vec::new());
        let on_started = async |holder| -> Recorded {
            recorded.lock().unwrap().push(holder);
            Err("no ledger".into())
        };
        let (started, sent) = block_on(join(
            start_holder_with(options, on_started, &fakes),
            far.sent(),
        ));
        let failed = failed(started);
        let cause = failed.cause.as_ref().map(ToString::to_string);
        assert_eq!(cause.as_deref(), Some("no ledger"));
        assert_eq!(*recorded.lock().unwrap(), [holder()]);
        assert_eq!((sent, fakes.kills()), (vec![], vec![holder()]));
    }

    #[test]
    fn runs_the_binary_under_its_cpu_limit_through_a_fixed_shell_that_execs_it() {
        let (_dirs, mut options) = setup();
        options.env = [(OsString::from("PATH"), OsString::from("/bin"))].into();
        options.limits.cpu_seconds = Some(10);
        let binary = options.binary.clone().into_os_string();
        let env = options.env.clone();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let (started, ()) = block_on(started(options, &fakes, async {
            far.sent().await;
            far.says(b"ready\n").await;
        }));
        started.unwrap();
        let shell = argv(&["/bin/sh", "-c", r#"ulimit -t 10 && exec "$0" "$@""#]);
        assert_eq!(fakes.spawned(), [([shell, vec![binary]].concat(), env)]);
    }

    #[test]
    fn kills_nothing_when_the_holder_exits_while_the_kernel_is_read_to_vouch_for_it() {
        let (_dirs, mut options) = setup();
        options.ready = Duration::from_millis(50);
        let (child, far) = fake();
        let exit_now = Arc::clone(&far.exit);
        let read: Read = Box::new(move |n| {
            if n == 1 {
                exit(&exit_now, 137);
            }
            holder_at(START)
        });
        let fakes = Fakes::new(Some(child), read);
        let (started, ()) = block_on(started(options, &fakes, async {}));
        assert!(!failed(started).running);
        assert_eq!(fakes.kills(), []);
        drop(far);
    }

    #[test]
    fn says_a_holder_the_kernel_can_t_read_as_it_starts_may_still_run_and_records_it_for_a_person()
    {
        let (_dirs, mut options) = setup();
        options.ready = Duration::from_millis(50);
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(unreadable()));
        let recorded = Mutex::new(Vec::new());
        let on_started = async |holder| -> Recorded {
            recorded.lock().unwrap().push(holder);
            Ok(())
        };
        let (started, sent) = block_on(join(
            start_holder_with(options, on_started, &fakes),
            far.sent(),
        ));
        let failed = failed(started);
        assert_eq!((failed.ending, failed.running), (Ending::Unchecked, true));
        assert_eq!(
            (fakes.kills(), sent, far.signalled()),
            (vec![], vec![], vec![])
        );
        let unknown = HolderProcess {
            pid: pid(),
            start: UNKNOWN_START,
        };
        assert_eq!(*recorded.lock().unwrap(), [unknown]);
        assert!(fakes.reads() > 1);
    }

    #[test]
    fn reads_the_kernel_again_when_it_fails_at_first_and_starts_the_holder_once_it_reads() {
        let (_dirs, options) = setup();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), in_turn(vec![unreadable(), holder_at(START)]));
        let recorded = Mutex::new(Vec::new());
        let on_started = async |holder| -> Recorded {
            recorded.lock().unwrap().push(holder);
            Ok(())
        };
        let (started, ()) = block_on(join(
            start_holder_with(options, on_started, &fakes),
            async {
                far.sent().await;
                far.says(b"ready\n").await;
            },
        ));
        assert_eq!(started.unwrap().holder, holder());
        assert_eq!(*recorded.lock().unwrap(), [holder()]);
    }

    #[test]
    fn says_one_the_kernel_can_t_read_but_that_exits_once_it_finds_no_spec_has_ended() {
        let (_dirs, mut options) = setup();
        options.ready = Duration::from_millis(50);
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(unreadable()));
        let (started, ()) = block_on(started(options, &fakes, async {
            far.sent().await;
            far.exits(2);
        }));
        let failed = failed(started);
        assert_eq!((failed.ending, failed.running), (exited(2), false));
    }

    #[test]
    fn runs_under_a_cpu_limit_of_1_second_or_of_a_day_the_bounds_it_takes() {
        let mut shells = Vec::new();
        for cpu in [1, 86_400] {
            let (_dirs, mut options) = setup();
            options.limits.cpu_seconds = Some(cpu);
            let (child, mut far) = fake();
            let fakes = Fakes::new(Some(child), always(holder_at(START)));
            let (started, ()) = block_on(started(options, &fakes, async {
                far.sent().await;
                far.says(b"ready\n").await;
            }));
            started.unwrap();
            shells.push(fakes.spawned()[0].0[2].clone());
        }
        let expected = [
            r#"ulimit -t 1 && exec "$0" "$@""#,
            r#"ulimit -t 86400 && exec "$0" "$@""#,
        ];
        assert_eq!(shells, expected.map(OsString::from));
    }

    const SYSTEMD_RUN: &str = "/usr/bin/systemd-run";

    fn scope() -> super::ScopeLaunch {
        super::ScopeLaunch {
            argv: argv(&[
                SYSTEMD_RUN,
                "--user",
                "--scope",
                "--unit=bazhen-terminal-term_1-ab.scope",
                "--",
            ]),
            env: vec![(
                OsString::from("XDG_RUNTIME_DIR"),
                OsString::from("/run/user/1000"),
            )],
        }
    }

    fn files(fakes: &Fakes) -> Vec<OsString> {
        fakes
            .spawned()
            .into_iter()
            .map(|(argv, _)| argv[0].clone())
            .collect()
    }

    #[test]
    fn runs_the_scope_s_launcher_first_which_execs_the_cpu_limit_s_shell_which_execs_it() {
        let (_dirs, mut options) = setup();
        options.env = [(OsString::from("PATH"), OsString::from("/bin"))].into();
        options.limits.cpu_seconds = Some(10);
        options.scope = Some(scope());
        let binary = options.binary.clone().into_os_string();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let (started, ()) = block_on(started(options, &fakes, async {
            far.sent().await;
            far.says(b"ready\n").await;
        }));
        started.unwrap();
        let shell = argv(&["/bin/sh", "-c", r#"ulimit -t 10 && exec "$0" "$@""#]);
        let env = [
            (OsString::from("PATH"), OsString::from("/bin")),
            (
                OsString::from("XDG_RUNTIME_DIR"),
                OsString::from("/run/user/1000"),
            ),
        ];
        assert_eq!(
            fakes.spawned(),
            [([scope().argv, shell, vec![binary]].concat(), env.into())]
        );
    }

    #[test]
    fn records_and_returns_the_spawned_pid_with_its_start_which_the_exec_keeps_as_the_holder_s() {
        let (_dirs, mut options) = setup();
        options.scope = Some(scope());
        let (child, mut far) = fake();
        let fakes = Fakes::new(
            Some(child),
            in_turn(vec![launcher_at(START), holder_at(START)]),
        );
        let recorded = Mutex::new(Vec::new());
        let on_started = async |holder| -> Recorded {
            recorded.lock().unwrap().push(holder);
            Ok(())
        };
        let (started, ()) = block_on(join(
            start_holder_with(options, on_started, &fakes),
            async {
                far.sent().await;
                far.says(b"ready\n").await;
            },
        ));
        assert_eq!(started.unwrap().holder, holder());
        assert_eq!(*recorded.lock().unwrap(), [holder()]);
        assert_eq!(files(&fakes), [OsString::from(SYSTEMD_RUN)]);
    }

    #[test]
    fn gives_a_launcher_that_hasn_t_exec_d_the_holder_in_time_no_spec_and_ends_it_by_its_own_handle()
     {
        let (_dirs, mut options) = setup();
        options.scope = Some(scope());
        options.launch = Duration::from_millis(100);
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(launcher_at(START)));
        let (started, sent) = block_on(started(options, &fakes, far.sent()));
        let failed = failed(started);
        assert_eq!((failed.ending, failed.running), (Ending::Unlaunched, true));
        assert!(
            failed
                .to_string()
                .contains(&format!("pid {PID} was sent SIGKILL")),
            "{failed}"
        );
        assert_eq!((sent, far.signalled()), (vec![], vec![Signal::KILL]));
        assert_eq!(fakes.kills(), []);
        assert_eq!(files(&fakes), [OsString::from(SYSTEMD_RUN)]);
    }

    #[test]
    fn writes_the_spec_only_once_the_kernel_shows_the_holder_exec_d_and_times_ready_from_then() {
        let (_dirs, mut options) = setup();
        options.scope = Some(scope());
        options.ready = Duration::from_millis(150);
        let exec_at = Instant::now() + Duration::from_millis(300);
        let read: Read = Box::new(move |_| {
            if Instant::now() < exec_at {
                launcher_at(START)
            } else {
                holder_at(START)
            }
        });
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), read);
        let (started, sent_at) = block_on(started(options, &fakes, async {
            let mut first = [0];
            far.stdin
                .as_mut()
                .unwrap()
                .read_exact(&mut first)
                .await
                .unwrap();
            let sent_at = Instant::now();
            far.sent().await;
            far.says(b"ready\n").await;
            sent_at
        }));
        assert_eq!(started.unwrap().holder, holder());
        assert!(sent_at >= exec_at);
    }

    #[test]
    fn fails_with_the_launcher_s_exit_and_stderr_when_systemd_can_t_make_the_scope() {
        let (_dirs, mut options) = setup();
        options.scope = Some(scope());
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(launcher_at(START)));
        let (started, sent) = block_on(started(options, &fakes, async {
            far.complains(b"Failed to start transient scope unit: Unit already exists.\n")
                .await;
            far.exits(1);
            far.sent().await
        }));
        let failed = failed(started);
        assert_eq!((failed.ending, failed.running), (exited(1), false));
        assert!(
            failed
                .stderr
                .contains("Failed to start transient scope unit"),
            "{failed}"
        );
        assert_eq!(
            (fakes.kills(), far.signalled(), sent),
            (vec![], vec![], vec![])
        );
        assert_eq!(files(&fakes), [OsString::from(SYSTEMD_RUN)]);
    }

    /// What a start of `options` is refused with, having spawned nothing.
    fn refusal(options: StartHolderOptions) -> String {
        let (child, _far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let (started, ()) = block_on(started(options, &fakes, async {}));
        assert_eq!(fakes.spawned(), []);
        match started {
            Err(StartError::Failed(failed)) => panic!("spawned, and failed: {failed}"),
            Err(refused) => refused.to_string(),
            Ok(started) => panic!("started {started:?}"),
        }
    }

    fn assert_refused(options: StartHolderOptions, with: &str) {
        let refused = refusal(options);
        assert!(refused.contains(with), "{refused:?} doesn't say {with:?}");
    }

    #[test]
    fn refuses_a_launcher_that_isn_t_an_absolute_path_before_spawning() {
        let (_dirs, mut options) = setup();
        options.scope = Some(super::ScopeLaunch {
            argv: argv(&["systemd-run", "--user", "--scope", "--"]),
            env: vec![],
        });
        assert_refused(options, "refusing scope launcher systemd-run");
    }

    #[test]
    fn refuses_a_socket_outside_the_run_root_s_holders_directory() {
        let (dirs, mut options) = setup();
        let root = &dirs.root;
        let outside = root.path().join("term_1.sock");
        options.spec = spec_for(root.path(), &[("socket", outside.to_str().unwrap().into())]);
        assert_refused(options, "refusing holder socket");
    }

    #[test]
    fn refuses_a_run_root_or_a_holders_directory_others_can_enter_or_a_link_for_one() {
        let (open, open_options) = setup();
        std::fs::set_permissions(open.root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_refused(open_options, "open to other users");
        let (open_dir, open_dir_options) = setup();
        let dir = holders_dir(open_dir.root.path());
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_refused(open_dir_options, "open to other users");
        let (linked, linked_options) = setup();
        let elsewhere = TempDir::new();
        std::os::unix::fs::symlink(elsewhere.path(), holders_dir(linked.root.path())).unwrap();
        assert_refused(linked_options, "not a directory");
    }

    #[test]
    fn refuses_a_spec_over_what_a_holder_reads_a_relative_binary_and_a_wait_out_of_range() {
        let (big, big_options) = setup();
        let pad = serde_json::json!({ "PAD": "x".repeat(1 << 20) });
        let mut options = big_options.clone();
        options.spec = spec_for(big.root.path(), &[("env", pad)]);
        assert_refused(options, "over the 1048576");
        let (_dirs, mut relative) = setup();
        relative.binary = PathBuf::from("bazhen-holder");
        assert_refused(relative, "isn't absolute");
        for (ready, launch) in [
            (Duration::ZERO, super::HOLDER_LAUNCH),
            (Duration::from_secs(61), super::HOLDER_LAUNCH),
            (super::HOLDER_READY, Duration::ZERO),
        ] {
            let (_dirs, mut waits) = setup();
            (waits.ready, waits.launch) = (ready, launch);
            assert_refused(waits, "isn't between 1 ms and 60 s");
        }
        for cpu in [0, 86_401] {
            let (_dirs, mut limited) = setup();
            limited.limits.cpu_seconds = Some(cpu);
            assert_refused(limited, "cpu_seconds");
        }
    }

    #[test]
    fn refuses_a_binary_that_isn_t_a_regular_file_named_as_the_holder_or_links_elsewhere() {
        let links = TempDir::new();
        let to_shell = links.path().join("bazhen-holder");
        std::os::unix::fs::symlink("/bin/sh", &to_shell).unwrap();
        let dirs = TempDir::new();
        let dir_named = dirs.path().join("bazhen-holder");
        std::fs::create_dir(&dir_named).unwrap();
        let empty = TempDir::new();
        for (binary, with) in [
            (PathBuf::from("/bin/sh"), "isn't named bazhen-holder"),
            (to_shell, "links to"),
            (dir_named, "isn't a regular file"),
            (empty.path().join("bazhen-holder"), "doesn't exist"),
        ] {
            let (_dirs, mut options) = setup();
            options.binary = binary;
            assert_refused(options, with);
        }
    }

    #[test]
    fn refuses_a_binary_every_user_may_write_who_would_choose_what_the_next_holder_runs() {
        for mode in [0o757, 0o777] {
            let (_dirs, mut options) = setup();
            let dir = TempDir::new();
            let binary = dir.path().join("bazhen-holder");
            std::fs::write(&binary, "").unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(mode)).unwrap();
            options.binary = binary;
            assert_refused(options, "every user may write it");
        }
    }

    #[test]
    fn refuses_an_environment_name_that_isn_t_a_plain_identifier_which_a_shell_could_run() {
        let (_dirs, mut options) = setup();
        options.env = [
            (OsString::from("PATH"), OsString::from("/bin")),
            (
                OsString::from("BASH_FUNC_ulimit%%"),
                OsString::from("() { :; }"),
            ),
        ]
        .into();
        assert_refused(options, "BASH_FUNC_ulimit%%");
    }

    /// A holder started that said `ready`, with its fake child.
    async fn ready_holder(
        fakes: &Fakes,
        options: StartHolderOptions,
        far: &mut Far,
    ) -> StartedHolder {
        let (started, ()) = started(options, fakes, async {
            far.sent().await;
            far.says(b"ready\n").await;
        })
        .await;
        started.unwrap()
    }

    #[test]
    fn sends_nothing_before_it_said_ready_or_once_it_has_exited_whatever_the_kernel_says() {
        let (_dirs, options) = setup();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let sent = Mutex::new(Vec::new());
        let shown = async |_| holder_at(START);
        block_on(async {
            let start = start_holder_with(options, unrecorded, &fakes);
            let before = async {
                far.sent().await;
                let before = rebind_holder_with(holder(), shown, rebinds(&sent)).await;
                far.says(b"ready\n").await;
                before
            };
            let (started, before) = join(start, before).await;
            let mut started = started.unwrap();
            let ready = rebind_holder_with(holder(), shown, rebinds(&sent)).await;
            far.exits(0);
            started.exited().await.unwrap();
            let after = rebind_holder_with(holder(), shown, rebinds(&sent)).await;
            assert_eq!([before, ready, after], [Ok(false), Ok(true), Ok(false)]);
        });
        assert_eq!(*sent.lock().unwrap(), [holder()]);
    }

    #[test]
    fn sends_nothing_to_one_that_exits_while_the_kernel_is_read() {
        let (_dirs, options) = setup();
        let (child, mut far) = fake();
        let fakes = Fakes::new(Some(child), always(holder_at(START)));
        let sent = Mutex::new(Vec::new());
        block_on(async {
            let mut started = ready_holder(&fakes, options, &mut far).await;
            let exit_now = Arc::clone(&far.exit);
            let exits_meanwhile = async |_| {
                exit(&exit_now, 0);
                tokio::task::yield_now().await;
                holder_at(START)
            };
            let (rebound, waited) = join(
                rebind_holder_with(holder(), exits_meanwhile, rebinds(&sent)),
                started.exited(),
            )
            .await;
            waited.unwrap();
            assert_eq!(rebound, Ok(false));
        });
        assert_eq!(*sent.lock().unwrap(), []);
    }

    /// A copy of the tests' own sleeper (`bazhen-test-sleeper`, which the workspace's tests build
    /// into the target directory this test binary is somewhere under) named as the holder, which
    /// the kernel names so too. Not a copy of `sleep`: where that is a multicall coreutils, it
    /// runs nothing under this name.
    fn sleeper(dir: &TempDir) -> PathBuf {
        let exe = std::env::current_exe().unwrap();
        let built = exe
            .ancestors()
            .skip(1)
            .map(|d| d.join("bazhen-test-sleeper"))
            .find(|p| p.is_file())
            .unwrap_or_else(|| {
                panic!(
                    "no bazhen-test-sleeper above {}: run the workspace's tests, which build it",
                    exe.display()
                )
            });
        let copy = dir.path().join("bazhen-holder");
        std::fs::copy(built, &copy).unwrap();
        copy
    }

    /// The kernel names a child after its parent's code until it has exec'd, and a spawn returns
    /// once the exec has closed its close-on-exec pipe, which is before it sets the name. So the
    /// name is read until it is the holder's, within a bound.
    fn holder_of(child: &std::process::Child) -> HolderProcess {
        let pid = Pid::from_raw(RawPid::try_from(child.id()).unwrap()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let reading = read_process(pid);
            match reading {
                Reading::Running { comm, start } if comm == "bazhen-holder" => {
                    return HolderProcess { pid, start };
                }
                Reading::Running { .. } | Reading::Unreadable(_)
                    if std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                other => panic!("never became bazhen-holder within 5s: {other:?}"),
            }
        }
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn kills_a_real_holder_by_its_proof_alone() {
        bazhen_test_signal::require_sandbox().unwrap();
        let dir = TempDir::new();
        let mut child = std::process::Command::new(sleeper(&dir))
            .arg("30")
            .spawn()
            .unwrap();
        let holder = holder_of(&child);
        let proof = super::vouch(holder, HolderUse::Kill).unwrap();
        assert_eq!(super::kill_holder(proof), Ok(true));
        assert_eq!(child.wait().unwrap().signal(), Some(Signal::KILL.as_raw()));
        assert!(super::vouch(holder, HolderUse::Kill).is_none());
    }

    /// A process the test started, at a pid a fresh proof names: as a holder's pid reused by
    /// another process after it was vouched for would be, but held unreaped, so the pid stays its
    /// own whatever is sent.
    fn stranger_vouched_for(made_for: HolderUse) -> (std::process::Child, HolderProof) {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = Pid::from_raw(RawPid::try_from(child.id()).unwrap()).unwrap();
        let start = bazhen_holder::start_time::of(pid).unwrap().get();
        let holder = HolderProcess { pid, start };
        (child, vouched(holder, made_for, &holder_at(start)).unwrap())
    }

    /// How long a process sent nothing is watched for an end that would show it was sent one.
    const STILL: Duration = Duration::from_millis(500);

    /// The pid is read again once it is pinned, so a kill reaches only the holder still there.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn kills_nothing_at_a_vouched_pid_another_process_has_now() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (mut stranger, proof) = stranger_vouched_for(HolderUse::Kill);
        let sent = super::kill_holder(proof);
        let ended = bazhen_test_signal::end_within(&mut stranger, STILL).unwrap();
        assert_eq!((sent, ended.map(|e| e.signal())), (Ok(false), None));
    }

    /// SIGUSR1 ends a process with no handler for it, as a holder's reused pid would have.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn rebinds_nothing_at_a_vouched_pid_another_process_has_now() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (mut stranger, proof) = stranger_vouched_for(HolderUse::Rebind);
        let sent = super::rebind_holder(proof);
        let ended = bazhen_test_signal::end_within(&mut stranger, STILL).unwrap();
        assert_eq!((sent, ended.map(|e| e.signal())), (Ok(false), None));
    }

    /// The sleeper has no handler for SIGUSR1, so the rebind ends it, which shows it was sent.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn rebinds_a_real_holder_this_process_didn_t_start_through_start_holder() {
        bazhen_test_signal::require_sandbox().unwrap();
        let dir = TempDir::new();
        let mut child = std::process::Command::new(sleeper(&dir))
            .arg("30")
            .spawn()
            .unwrap();
        let holder = holder_of(&child);
        assert_eq!(block_on(super::rebind_holder_socket(holder)), Ok(true));
        assert_eq!(child.wait().unwrap().signal(), Some(Signal::USR1.as_raw()));
    }

    /// The real start, through `Host`: the tests' sleeper named as the holder, which the kernel
    /// names so too, from the moment a launcher, here a shell, execs it with the seconds that it
    /// needs, as the holder is run with none. It never says `ready`, so once its wait is up it is
    /// killed by a proof for its pid and start. The shell can't stand in for it: run as a script,
    /// the holder's name is the kernel's only until the script execs something else.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn kills_a_real_silent_holder_once_the_kernel_shows_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        let root = TempDir::new();
        let bin = TempDir::new();
        let spec = spec_for(root.path(), &[]);
        let mut options = StartHolderOptions::new(sleeper(&bin), root.path().to_owned(), spec);
        options.ready = Duration::from_millis(200);
        options.launch = Duration::from_secs(5);
        options.scope = Some(super::ScopeLaunch {
            argv: argv(&["/bin/sh", "-c", r#"exec "$0" 10"#]),
            env: vec![],
        });
        let started = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(super::start_holder(options, unrecorded));
        let failed = failed(started);
        assert_eq!(
            (failed.ending, failed.running),
            (Ending::Silent, false),
            "{failed}"
        );
        assert!(failed.detail.ends_with("; it was killed"), "{failed}");
    }
}
