//! Transient systemd user scopes: the argv that starts a command in one, whether this machine's
//! user manager enforces a memory cap on one, and which scope a process runs in.
//!
//! `systemd-run --scope` asks the manager over D-Bus to make a scope of its own pid, then execs the
//! command, which keeps that pid. Nothing here signals but `run_bounded`'s kill of a step that
//! outlives its time: systemd moves the process, and only the kernel kills, inside the scope, past
//! its cap.

use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::future::Future;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rustix::process::Pid;
use tokio::process::Command;

use crate::group::{Ended, Ran, run_kept};

/// The first systemd whose scopes take `OOMPolicy`; older ones refuse the property.
pub const MIN_SYSTEMD: u32 = 253;
/// Where every terminal's scope goes: a dash in a slice's name nests it under `bazhen.slice`.
pub const TERMINALS_SLICE: &str = "bazhen-terminals.slice";
/// The least a memory cap may be: below it a terminal's own shell and holder can't start.
pub const MIN_MEMORY_MAX: u64 = 64 * 1024 * 1024;
const TERMINAL_UNIT_PREFIX: &str = "bazhen-terminal-";
/// A probe scope's unit, named apart from a terminal's, so it is never taken for one.
const PROBE_UNIT_PREFIX: &str = "bazhen-probe-";
const STEP_TIMEOUT: Duration = Duration::from_secs(10);
const STDERR_MAX: usize = 2_000;
/// The largest size a cap may name, as the TypeScript daemon reads the same config.
const SIZE_MAX: u64 = (1 << 53) - 1;
/// How far a cap the kernel shows may lie below the bytes asked: it rounds down to a page.
const PAGE_SLACK: u64 = 64 * 1024;
/// The shell a probe scope runs, by a path every POSIX system has. The probe uses only its
/// builtins, since a scope's environment names no `PATH`.
const PROBE_SHELL: &str = "/bin/sh";

/// What a probe scope reads of its own caps and its slice's, one `name=value` line each, from
/// inside, because a user manager without the memory controller takes `MemoryMax` and enforces
/// nothing. A file it can't read writes no line, and a cgroup at the root has no slice. `$1` and
/// `$2`, the cgroup mount and the file naming the cgroup, are for its tests.
pub const PROBE_SCRIPT: &str = r#"
mount=${1:-/sys/fs/cgroup}
cg=
while IFS= read -r line; do
  case $line in 0::/*) cg=${line#0::} ;; esac
done 2>/dev/null < "${2:-/proc/self/cgroup}"
[ -n "$cg" ] || exit 0
cg=${cg%/}
at() { [ -r "$1" ] && { IFS= read -r v && printf '%s=%s\n' "$2" "$v"; } < "$1"; } 2>/dev/null
at "$mount$cg/memory.max" memory
at "$mount$cg/memory.swap.max" swap
case $cg in /*) at "$mount${cg%/*}/memory.max" slice ;; esac
exit 0
"#;

/// The memory caps terminals get, as systemd's `MemoryMax=` and `MemorySwapMax=` take them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalCaps {
    /// Each terminal's scope's memory.
    pub terminal: String,
    /// All terminals' memory together: `TERMINALS_SLICE`.
    pub total: String,
    /// Each terminal's scope's swap.
    pub swap: String,
}

/// Each cap as the kernel enforces it: bytes, or `None` for none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Enforced {
    pub terminal: Option<u64>,
    pub total: Option<u64>,
    pub swap: Option<u64>,
}

/// New terminals start contained, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scoped {
    pub systemd: u32,
    /// Whether each scope takes `OOMPolicy=continue`; before 253 the kernel's kill is all.
    pub oom_policy: bool,
    pub caps: TerminalCaps,
    pub enforced: Enforced,
    /// The `systemd-run` every scope starts through, by absolute path.
    pub systemd_run: PathBuf,
    /// Where the user manager's bus is, which `systemd-run` needs and a holder's env lacks.
    pub runtime_dir: OsString,
}

/// Whether new terminals start contained, and if not, why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Containment {
    Scoped(Scoped),
    Uncontained { why: String },
}

/// Caps no scope may be given, refused before anything runs.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "refusing caps terminal {:?}, total {:?}, swap {:?}: {why}",
    caps.terminal,
    caps.total,
    caps.swap
)]
pub struct CapsRefused {
    pub caps: TerminalCaps,
    pub why: &'static str,
}

/// What starts a command in a scope: argv to put before it, and the env it needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeLaunch {
    pub argv: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

/// What a probe read from inside a scope.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeReading {
    pub memory: Option<String>,
    pub swap: Option<String>,
    pub slice: Option<String>,
}

/// How a step of the probe ran: its exit code (`None` for a signal or a failure to start), its
/// stdout, and what it said went wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Step {
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
}

/// The OS calls `probe_containment` makes, replaced in its tests.
pub(crate) trait ProbeDeps {
    fn os(&self) -> &str;
    fn var(&self, name: &str) -> Option<OsString>;
    fn which(&self, command: &str) -> Option<PathBuf>;
    /// The machine's memory, which a percentage cap is taken of.
    fn total_memory(&self) -> Option<u64>;
    /// Twelve hex digits no earlier unit had.
    fn random(&self) -> String;
    fn run(
        &self,
        file: &Path,
        args: &[String],
        env: &[(&str, &OsStr)],
    ) -> impl Future<Output = Step> + Send;
}

/// The `systemd-run` arguments that start the command after them in a scope of the user manager.
#[must_use]
pub fn scope_args(unit: &str, slice: &str, properties: &[String]) -> Vec<String> {
    let mut args = vec![
        "--user".to_owned(),
        "--scope".to_owned(),
        "--quiet".to_owned(),
        format!("--unit={unit}"),
        format!("--slice={slice}"),
    ];
    for property in properties {
        args.extend(["-p".to_owned(), property.clone()]);
    }
    args.push("--".to_owned());
    args
}

/// The systemd a `systemd-run --version` names.
#[must_use]
pub fn systemd_version(stdout: &[u8]) -> Option<u32> {
    let rest = stdout.strip_prefix(b"systemd ")?;
    let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
    std::str::from_utf8(rest.get(..digits)?).ok()?.parse().ok()
}

/// A probe's stdout as a reading, or `None` for anything but its lines. A name it doesn't know is
/// passed over.
#[must_use]
pub fn parse_probe(stdout: &[u8]) -> Option<ProbeReading> {
    let text = std::str::from_utf8(stdout).ok()?;
    let mut reading = ProbeReading::default();
    for line in text.lines() {
        let (name, value) = line.split_once('=')?;
        let field = match name {
            "memory" => &mut reading.memory,
            "swap" => &mut reading.swap,
            "slice" => &mut reading.slice,
            _ => continue,
        };
        *field = Some(value.to_owned());
    }
    Some(reading)
}

/// The unified-hierarchy cgroup a `/proc/<pid>/cgroup` names.
#[must_use]
pub fn cgroup_of(text: &[u8]) -> Option<&str> {
    text.split(|b| *b == b'\n').find_map(|line| {
        let path = std::str::from_utf8(line.strip_prefix(b"0::")?).ok()?;
        (path.starts_with('/') && !path.contains(char::is_whitespace)).then_some(path)
    })
}

/// The machine's memory a `/proc/meminfo` names, in bytes.
#[must_use]
pub fn mem_total(meminfo: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(meminfo).ok()?;
    let line = text.lines().find_map(|l| l.strip_prefix("MemTotal:"))?;
    let kib = line.trim().strip_suffix(" kB")?.trim_end();
    if kib.is_empty() || !kib.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    kib.parse::<u64>().ok()?.checked_mul(1024)
}

/// A size in bytes, as `<n>[K|M|G|T]` gives it.
fn size_bytes(text: &str) -> Option<u64> {
    let (digits, unit) = [
        ('K', 1 << 10),
        ('M', 1 << 20),
        ('G', 1 << 30),
        ('T', 1 << 40),
    ]
    .into_iter()
    .find_map(|(suffix, unit)| Some((text.strip_suffix(suffix)?, unit)))
    .unwrap_or((text, 1));
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let bytes = digits.parse::<u64>().ok()?.checked_mul(unit)?;
    (bytes <= SIZE_MAX).then_some(bytes)
}

/// A whole percentage from 1 to 100, as `<n>%` gives it.
fn percentage(text: &str) -> Option<u64> {
    let digits = text.strip_suffix('%')?;
    if !(1..=3).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|p| (1..=100).contains(p))
}

/// Why `value` can't cap a terminal's memory, or all terminals', or `None` when it can: bytes
/// with an optional K, M, G or T of at least 64M, a whole percentage of RAM from 1 to 100, or
/// `infinity`.
#[must_use]
pub fn memory_max_refusal(value: &str) -> Option<&'static str> {
    if value == "infinity" || percentage(value).is_some() {
        return None;
    }
    match size_bytes(value) {
        None => Some(
            "must be bytes with an optional K, M, G or T, a whole percentage from 1% to 100%, \
             or infinity",
        ),
        Some(bytes) if bytes < MIN_MEMORY_MAX => {
            Some("must be at least 64M, or a terminal can't start")
        }
        Some(_) => None,
    }
}

/// Why `value` can't cap a terminal's swap, or `None` when it can: bytes, 0 included, or
/// `infinity`.
#[must_use]
pub fn swap_max_refusal(value: &str) -> Option<&'static str> {
    (value != "infinity" && size_bytes(value).is_none())
        .then_some("must be bytes with an optional K, M, G or T, 0 for none, or infinity")
}

/// A cap as the kernel shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shown {
    /// `max`: no cap.
    Max,
    Bytes(u64),
}

/// A cap as the kernel shows it, or `None` for no reading.
fn kernel_bytes(text: Option<&str>) -> Option<Shown> {
    let value = text?.trim();
    if value == "max" {
        return Some(Shown::Max);
    }
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value
        .parse()
        .ok()
        .filter(|b| *b <= SIZE_MAX)
        .map(Shown::Bytes)
}

/// Whether the kernel's reading is the cap asked: `max` for `infinity`; the bytes asked, rounded
/// down to a page; or a percentage of the machine's memory, within a percent of it, as systemd
/// takes its memory from what the kernel says it has.
fn enforces(asked: &str, got: Option<Shown>, total_memory: u64) -> bool {
    if asked == "infinity" {
        return got == Some(Shown::Max);
    }
    let Some(Shown::Bytes(got)) = got else {
        return false;
    };
    if let Some(percent) = percentage(asked) {
        let shown = u128::from(got) * 100;
        let wanted = u128::from(total_memory) * u128::from(percent);
        return shown.abs_diff(wanted) <= u128::from(total_memory);
    }
    size_bytes(asked).is_some_and(|bytes| got <= bytes && bytes - got < PAGE_SLACK)
}

fn shown(text: Option<&str>) -> &str {
    text.map_or("nothing", str::trim)
}

fn said(step: &Step) -> String {
    let stderr = step.stderr.trim();
    if stderr.is_empty() {
        return step
            .code
            .map_or_else(|| "no exit code".to_owned(), |c| format!("exit {c}"));
    }
    stderr.chars().take(STDERR_MAX).collect()
}

fn uncontained(why: impl Into<String>) -> Containment {
    Containment::Uncontained { why: why.into() }
}

/// A unit name no earlier unit had, so a journal line or a scope still collected never matches.
fn unique_unit(prefix: &str, random: &str) -> String {
    format!("{prefix}-{random}.scope")
}

/// The properties of a terminal's scope.
fn terminal_properties(caps: &TerminalCaps, oom_policy: bool) -> Vec<String> {
    let mut properties = vec![
        format!("MemoryMax={}", caps.terminal),
        // Uncapped, a runaway at its memory cap would go on into swap and stall every terminal
        // before the kernel killed it.
        format!("MemorySwapMax={}", caps.swap),
    ];
    if oom_policy {
        // Past its cap the kernel kills the scope's biggest process, a runaway rather than its
        // small holder, and the default policy would then stop the holder too.
        properties.push("OOMPolicy=continue".to_owned());
    }
    // A scope whose processes were killed fails, and would stay listed until reset.
    properties.push("CollectMode=inactive-or-failed".to_owned());
    properties
}

/// Whether this machine can contain each terminal in a scope with `caps`: it sets the terminals'
/// slice to `caps.total`, then starts a scope as a terminal's would be and reads both caps back
/// from inside it.
///
/// # Errors
///
/// A cap systemd wouldn't take, before anything runs.
pub async fn probe_containment(caps: &TerminalCaps) -> Result<Containment, CapsRefused> {
    probe_with(caps, &Host).await
}

pub(crate) async fn probe_with(
    caps: &TerminalCaps,
    deps: &impl ProbeDeps,
) -> Result<Containment, CapsRefused> {
    let refusal = memory_max_refusal(&caps.terminal)
        .or_else(|| memory_max_refusal(&caps.total))
        .or_else(|| swap_max_refusal(&caps.swap));
    if let Some(why) = refusal {
        return Err(CapsRefused {
            caps: caps.clone(),
            why,
        });
    }
    Ok(probe_caps(caps, deps).await)
}

async fn probe_caps(caps: &TerminalCaps, deps: &impl ProbeDeps) -> Containment {
    if deps.os() != "linux" {
        return uncontained(format!("{} has no cgroups", deps.os()));
    }
    let Some(runtime_dir) = deps
        .var("XDG_RUNTIME_DIR")
        .filter(|dir| Path::new(dir).is_absolute())
    else {
        return uncontained("XDG_RUNTIME_DIR isn't set, so no systemd user manager can be reached");
    };
    let (Some(systemd_run), Some(systemctl)) = (deps.which("systemd-run"), deps.which("systemctl"))
    else {
        return uncontained("systemd-run or systemctl isn't on PATH");
    };
    let Some(total_memory) = deps.total_memory() else {
        return uncontained("/proc/meminfo names no MemTotal, so no percentage cap can be checked");
    };
    let env = [("XDG_RUNTIME_DIR", runtime_dir.as_os_str())];
    let version = deps
        .run(&systemd_run, &["--version".to_owned()], &env)
        .await;
    let Some(systemd) = systemd_version(&version.stdout) else {
        return uncontained(format!("systemd-run --version failed: {}", said(&version)));
    };
    let set_args = ["--user", "set-property", "--runtime", TERMINALS_SLICE]
        .map(str::to_owned)
        .into_iter()
        .chain([format!("MemoryMax={}", caps.total)])
        .collect::<Vec<_>>();
    let set = deps.run(&systemctl, &set_args, &env).await;
    if set.code != Some(0) {
        return uncontained(format!(
            "systemctl couldn't set {TERMINALS_SLICE}'s cap: {}",
            said(&set)
        ));
    }
    let oom_policy = systemd >= MIN_SYSTEMD;
    let pid = rustix::process::getpid().as_raw_pid();
    let unit = unique_unit(&format!("{PROBE_UNIT_PREFIX}{pid}"), &deps.random());
    let mut probe_args = scope_args(
        &unit,
        TERMINALS_SLICE,
        &terminal_properties(caps, oom_policy),
    );
    probe_args.extend([PROBE_SHELL, "-c", PROBE_SCRIPT].map(str::to_owned));
    let probe = deps.run(&systemd_run, &probe_args, &env).await;
    let reading = (probe.code == Some(0))
        .then(|| parse_probe(&probe.stdout))
        .flatten();
    let Some(reading) = reading else {
        return uncontained(format!("a probe scope wouldn't start: {}", said(&probe)));
    };
    let enforced = match enforced(caps, &reading, systemd, total_memory) {
        Ok(enforced) => enforced,
        Err(why) => return uncontained(why),
    };
    Containment::Scoped(Scoped {
        systemd,
        oom_policy,
        caps: caps.clone(),
        enforced,
        systemd_run,
        runtime_dir,
    })
}

/// Each cap as the kernel enforces it, from a probe's `reading`, or why the kernel doesn't
/// enforce one as asked.
fn enforced(
    caps: &TerminalCaps,
    reading: &ProbeReading,
    systemd: u32,
    total_memory: u64,
) -> Result<Enforced, String> {
    let mut enforced = Enforced {
        terminal: None,
        total: None,
        swap: None,
    };
    let slice_cap = format!("{TERMINALS_SLICE}'s memory.max");
    let read = [
        (
            &caps.terminal,
            "a scope's memory.max",
            &reading.memory,
            &mut enforced.terminal,
        ),
        (
            &caps.total,
            slice_cap.as_str(),
            &reading.slice,
            &mut enforced.total,
        ),
        (
            &caps.swap,
            "a scope's memory.swap.max",
            &reading.swap,
            &mut enforced.swap,
        ),
    ];
    for (asked, what, text, into) in read {
        let shown_as = kernel_bytes(text.as_deref());
        if !enforces(asked, shown_as, total_memory) {
            return Err(format!(
                "systemd {systemd} was asked for {asked}, but the kernel shows {what} as {}, so \
                 it doesn't enforce that cap here",
                shown(text.as_deref())
            ));
        }
        *into = match shown_as {
            Some(Shown::Bytes(bytes)) => Some(bytes),
            _ => None,
        };
    }
    Ok(enforced)
}

/// The launch that starts `terminal_id`'s holder in a scope of its own, under `scoped`, named with
/// `random`, which no earlier launch had.
#[must_use]
pub fn terminal_scope(scoped: &Scoped, terminal_id: &str, random: &str) -> ScopeLaunch {
    let unit = unique_unit(&format!("{TERMINAL_UNIT_PREFIX}{terminal_id}"), random);
    let properties = terminal_properties(&scoped.caps, scoped.oom_policy);
    let mut argv = vec![scoped.systemd_run.clone().into_os_string()];
    argv.extend(
        scope_args(&unit, TERMINALS_SLICE, &properties)
            .into_iter()
            .map(OsString::from),
    );
    ScopeLaunch {
        argv,
        env: vec![("XDG_RUNTIME_DIR".into(), scoped.runtime_dir.clone())],
    }
}

/// Whether a cgroup path is a terminal's scope in the terminals' slice, as `/proc/<pid>/cgroup`
/// names it.
#[must_use]
pub fn is_terminal_scope(cgroup: &str) -> bool {
    let mut parts = cgroup.rsplit('/');
    let (Some(unit), Some(slice), Some(parent)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let named = unit
        .strip_prefix(TERMINAL_UNIT_PREFIX)
        .and_then(|rest| rest.strip_suffix(".scope"))
        .is_some_and(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        });
    named && slice == TERMINALS_SLICE && parent == "bazhen.slice"
}

/// Whether `pid` runs in a terminal's scope: `None` where that can't be read, as for a process
/// that has gone or an OS without cgroups.
#[must_use]
pub fn in_terminal_scope(pid: Pid) -> Option<bool> {
    in_terminal_scope_by(pid, |path| std::fs::read(path).ok())
}

fn in_terminal_scope_by(pid: Pid, read: impl Fn(&str) -> Option<Vec<u8>>) -> Option<bool> {
    let text = read(&format!("/proc/{}/cgroup", pid.as_raw_pid()))?;
    cgroup_of(&text).map(is_terminal_scope)
}

/// The first executable named `command` on `path`.
fn which(command: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(command))
        .find(|file| {
            file.metadata().is_ok_and(|m| m.is_file())
                && rustix::fs::access(file, rustix::fs::Access::EXEC_OK).is_ok()
        })
}

/// A step as the probe reads it: what went wrong, where the command said nothing of it.
fn step_of(ran: Ran) -> Step {
    let code = match &ran.ended {
        Ended::Exited(status) => status.code(),
        _ => None,
    };
    let mut stderr = String::from_utf8_lossy(&ran.stderr).into_owned();
    if stderr.trim().is_empty() {
        stderr = match &ran.ended {
            Ended::Exited(status) if status.success() => String::new(),
            Ended::Exited(status) => status.to_string(),
            Ended::TimedOut => format!("it outlived {}s", STEP_TIMEOUT.as_secs()),
            Ended::Unstarted(e) => format!("it couldn't start: {e}"),
            Ended::Unwaited(e) => format!("it couldn't be waited for: {e}"),
        };
    }
    Step {
        code,
        stdout: ran.stdout,
        stderr,
    }
}

/// This machine.
struct Host;

impl ProbeDeps for Host {
    fn os(&self) -> &str {
        std::env::consts::OS
    }

    fn var(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }

    fn which(&self, command: &str) -> Option<PathBuf> {
        which(command, std::env::var_os("PATH").as_deref())
    }

    fn total_memory(&self) -> Option<u64> {
        mem_total(&std::fs::read("/proc/meminfo").ok()?)
    }

    fn random(&self) -> String {
        let mut bytes = [0; 6];
        let read = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes));
        if read.is_err() {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            bytes.copy_from_slice(&nanos.to_le_bytes()[..6]);
        }
        bytes.iter().fold(String::new(), |mut hex, b| {
            let _ = write!(hex, "{b:02x}");
            hex
        })
    }

    async fn run(&self, file: &Path, args: &[String], env: &[(&str, &OsStr)]) -> Step {
        let mut command = Command::new(file);
        command.args(args).env_clear().envs(env.iter().copied());
        match run_kept(command, STEP_TIMEOUT).await {
            Ok(ran) => step_of(ran),
            Err(e) => Step {
                code: None,
                stdout: Vec::new(),
                stderr: e.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::future::Future;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use rustix::process::Pid;

    use super::{
        CapsRefused, Containment, Enforced, PROBE_SCRIPT, ProbeDeps, ProbeReading, Scoped, Step,
        TERMINALS_SLICE, TerminalCaps, cgroup_of, in_terminal_scope_by, is_terminal_scope,
        mem_total, memory_max_refusal, parse_probe, probe_with, scope_args, swap_max_refusal,
        systemd_version, terminal_scope,
    };

    const GIB: u64 = 1 << 30;
    /// The fake machine's memory, which a percentage cap is taken of.
    const MACHINE: u64 = 64 * GIB;
    const RUN: &str = "/usr/bin/systemd-run";
    const CTL: &str = "/usr/bin/systemctl";
    const XDG: &str = "/run/user/1000";

    fn caps() -> TerminalCaps {
        TerminalCaps {
            terminal: "50%".into(),
            total: "80%".into(),
            swap: "0".into(),
        }
    }

    fn reads(lines: &str) -> Step {
        ok(lines)
    }

    fn ok(stdout: &str) -> Step {
        Step {
            code: Some(0),
            stdout: stdout.as_bytes().to_vec(),
            stderr: String::new(),
        }
    }

    fn failed(stderr: &str) -> Step {
        Step {
            code: Some(1),
            stdout: Vec::new(),
            stderr: stderr.into(),
        }
    }

    /// What a probe scope reads under `caps()` on the fake machine.
    fn good_reading() -> String {
        format!("memory={}\nslice={}\nswap=0\n", 32 * GIB, MACHINE * 8 / 10)
    }

    fn scoped(oom_policy: bool) -> Scoped {
        Scoped {
            systemd: if oom_policy { 255 } else { 252 },
            oom_policy,
            caps: caps(),
            enforced: Enforced {
                terminal: Some(32 * GIB),
                total: Some(51 * GIB),
                swap: Some(0),
            },
            systemd_run: RUN.into(),
            runtime_dir: XDG.into(),
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Call {
        file: PathBuf,
        args: Vec<String>,
        env: Vec<(String, OsString)>,
    }

    /// A user manager that answers as its fields say, and records what it was asked.
    struct Fake {
        os: &'static str,
        env: Vec<(&'static str, &'static str)>,
        on_path: Vec<&'static str>,
        total_memory: Option<u64>,
        version: String,
        set: Step,
        probe: Step,
        calls: Mutex<Vec<Call>>,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                os: "linux",
                env: vec![
                    ("XDG_RUNTIME_DIR", XDG),
                    ("PATH", "/usr/bin"),
                    ("HOME", "/home/u"),
                ],
                on_path: vec!["systemd-run", "systemctl"],
                total_memory: Some(MACHINE),
                version: "systemd 255 (255.4)\n+PAM".into(),
                set: ok(""),
                probe: reads(&good_reading()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }

        fn probe_args(&self) -> Vec<String> {
            self.calls()
                .into_iter()
                .find(|c| c.args.iter().any(|a| a == PROBE_SCRIPT))
                .expect("no probe scope was started")
                .args
        }
    }

    impl ProbeDeps for Fake {
        fn os(&self) -> &str {
            self.os
        }

        fn var(&self, name: &str) -> Option<OsString> {
            self.env
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.into())
        }

        fn which(&self, command: &str) -> Option<PathBuf> {
            self.on_path
                .contains(&command)
                .then(|| Path::new("/usr/bin").join(command))
        }

        fn total_memory(&self) -> Option<u64> {
            self.total_memory
        }

        fn random(&self) -> String {
            "0123456789ab".into()
        }

        fn run(
            &self,
            file: &Path,
            args: &[String],
            env: &[(&str, &OsStr)],
        ) -> impl Future<Output = Step> + Send {
            self.calls.lock().unwrap().push(Call {
                file: file.into(),
                args: args.to_vec(),
                env: env
                    .iter()
                    .map(|(n, v)| ((*n).into(), (*v).into()))
                    .collect(),
            });
            let step = if args.first().is_some_and(|a| a == "--version") {
                ok(&self.version)
            } else if file == Path::new(CTL) {
                self.set.clone()
            } else {
                self.probe.clone()
            };
            std::future::ready(step)
        }
    }

    fn probe(caps: &TerminalCaps, fake: &Fake) -> Result<Containment, CapsRefused> {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(probe_with(caps, fake))
    }

    fn values_after(args: &[impl AsRef<OsStr>], flag: &str) -> Vec<String> {
        args.windows(2)
            .filter(|w| w[0].as_ref() == flag)
            .map(|w| w[1].as_ref().to_string_lossy().into_owned())
            .collect()
    }

    fn why(got: Result<Containment, CapsRefused>) -> String {
        match got {
            Ok(Containment::Uncontained { why }) => why,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn puts_each_property_behind_its_own_p_and_ends_at_the_commands_dashes() {
        assert_eq!(
            scope_args("u.scope", "s.slice", &["A=1".into(), "B=2".into()]),
            [
                "--user",
                "--scope",
                "--quiet",
                "--unit=u.scope",
                "--slice=s.slice",
                "-p",
                "A=1",
                "-p",
                "B=2",
                "--"
            ]
        );
    }

    #[test]
    fn contains_them_when_the_kernel_shows_every_cap_asked_from_inside_a_probe_scope() {
        assert_eq!(
            probe(&caps(), &Fake::new()),
            Ok(Containment::Scoped(Scoped {
                systemd: 255,
                oom_policy: true,
                caps: caps(),
                enforced: Enforced {
                    terminal: Some(32 * GIB),
                    total: Some(MACHINE * 8 / 10),
                    swap: Some(0),
                },
                systemd_run: RUN.into(),
                runtime_dir: XDG.into(),
            }))
        );
    }

    #[test]
    fn sets_the_terminals_slice_to_the_total_cap_before_the_probe() {
        let fake = Fake::new();
        probe(&caps(), &fake).unwrap();
        let calls = fake.calls();
        let set = calls.iter().position(|c| c.file == Path::new(CTL)).unwrap();
        assert_eq!(
            calls[set].args,
            [
                "--user",
                "set-property",
                "--runtime",
                TERMINALS_SLICE,
                "MemoryMax=80%"
            ]
        );
        let probed = calls
            .iter()
            .position(|c| c.args.iter().any(|a| a == PROBE_SCRIPT))
            .unwrap();
        assert!(set < probed);
    }

    #[test]
    fn probes_with_a_terminals_own_properties_in_the_terminals_slice_through_a_shell() {
        let fake = Fake::new();
        probe(&caps(), &fake).unwrap();
        let args = fake.probe_args();
        assert_eq!(
            values_after(&args, "-p"),
            [
                "MemoryMax=50%",
                "MemorySwapMax=0",
                "OOMPolicy=continue",
                "CollectMode=inactive-or-failed"
            ]
        );
        assert!(args.contains(&format!("--slice={TERMINALS_SLICE}")));
        let pid = rustix::process::getpid().as_raw_pid();
        assert!(args.contains(&format!("--unit=bazhen-probe-{pid}-0123456789ab.scope")));
        assert_eq!(
            args[args.len() - 4..],
            ["--", "/bin/sh", "-c", PROBE_SCRIPT]
        );
    }

    #[test]
    fn reaches_systemd_with_the_buss_directory_alone_as_a_holders_launch_will() {
        let fake = Fake::new();
        probe(&caps(), &fake).unwrap();
        let calls = fake.calls();
        assert_eq!(calls.len(), 3);
        for call in calls {
            assert_eq!(call.env, [("XDG_RUNTIME_DIR".into(), XDG.into())]);
        }
    }

    #[test]
    fn leaves_oom_policy_out_before_systemd_253_which_would_refuse_it() {
        let fake = Fake {
            version: "systemd 252 (252.1)".into(),
            ..Fake::new()
        };
        let Ok(Containment::Scoped(got)) = probe(&caps(), &fake) else {
            panic!("not scoped")
        };
        assert_eq!((got.systemd, got.oom_policy), (252, false));
        assert!(!fake.probe_args().iter().any(|a| a.starts_with("OOMPolicy")));
    }

    #[test]
    fn takes_infinity_as_no_cap_which_the_kernel_shows_as_max() {
        let fake = Fake {
            probe: reads("memory=max\nslice=max\nswap=max\n"),
            ..Fake::new()
        };
        let none = TerminalCaps {
            terminal: "infinity".into(),
            total: "infinity".into(),
            swap: "infinity".into(),
        };
        let Ok(Containment::Scoped(got)) = probe(&none, &fake) else {
            panic!("not scoped")
        };
        assert_eq!(
            got.enforced,
            Enforced {
                terminal: None,
                total: None,
                swap: None
            }
        );
    }

    #[test]
    fn takes_a_size_the_kernel_rounds_down_to_its_page() {
        let shown = 300_000_000 - 3_456;
        let fake = Fake {
            probe: reads(&format!(
                "memory={shown}\nslice={}\nswap=0\n",
                MACHINE * 8 / 10
            )),
            ..Fake::new()
        };
        let asked = TerminalCaps {
            terminal: "300000000".into(),
            ..caps()
        };
        let Ok(Containment::Scoped(got)) = probe(&asked, &fake) else {
            panic!("not scoped")
        };
        assert_eq!(got.enforced.terminal, Some(shown));
    }

    #[test]
    fn leaves_them_uncontained_where_no_user_manager_can_be_asked_and_says_why() {
        let cases: [(&str, Fake, &str); 8] = [
            (
                "macOS",
                Fake {
                    os: "macos",
                    ..Fake::new()
                },
                "macos has no cgroups",
            ),
            (
                "no XDG_RUNTIME_DIR",
                Fake {
                    env: vec![("PATH", "/usr/bin")],
                    ..Fake::new()
                },
                "XDG_RUNTIME_DIR isn't set",
            ),
            (
                "a relative XDG_RUNTIME_DIR",
                Fake {
                    env: vec![("XDG_RUNTIME_DIR", "run/user/1000")],
                    ..Fake::new()
                },
                "XDG_RUNTIME_DIR isn't set",
            ),
            (
                "no systemd-run",
                Fake {
                    on_path: vec!["systemctl"],
                    ..Fake::new()
                },
                "systemd-run or systemctl isn't on PATH",
            ),
            (
                "no machine memory",
                Fake {
                    total_memory: None,
                    ..Fake::new()
                },
                "names no MemTotal",
            ),
            (
                "no version",
                Fake {
                    version: String::new(),
                    ..Fake::new()
                },
                "systemd-run --version failed",
            ),
            (
                "an unset slice",
                Fake {
                    set: failed("Failed to connect to bus: No medium found"),
                    ..Fake::new()
                },
                "couldn't set bazhen-terminals.slice's cap: Failed to connect to bus",
            ),
            (
                "a probe that won't start",
                Fake {
                    probe: failed("Unit already exists"),
                    ..Fake::new()
                },
                "a probe scope wouldn't start: Unit already exists",
            ),
        ];
        for (name, fake, expected) in cases {
            let got = why(probe(&caps(), &fake));
            assert!(got.contains(expected), "{name}: {got}");
        }
    }

    #[test]
    fn leaves_them_uncontained_where_the_kernel_shows_another_cap_and_says_why() {
        let good = good_reading();
        let cases: [(&str, Fake, &str); 4] = [
            (
                "no cap the manager took",
                Fake {
                    probe: reads(&good.replacen(&format!("memory={}", 32 * GIB), "memory=max", 1)),
                    ..Fake::new()
                },
                "was asked for 50%, but the kernel shows a scope's memory.max as max",
            ),
            (
                "another cap",
                Fake {
                    probe: reads(&good.replacen(
                        &format!("slice={}", MACHINE * 8 / 10),
                        &format!("slice={}", 8 * GIB),
                        1,
                    )),
                    ..Fake::new()
                },
                "was asked for 80%, but the kernel shows bazhen-terminals.slice's memory.max as 8589934592",
            ),
            (
                "uncapped swap",
                Fake {
                    probe: reads(&good.replacen("swap=0", "swap=max", 1)),
                    ..Fake::new()
                },
                "was asked for 0, but the kernel shows a scope's memory.swap.max as max",
            ),
            (
                "no memory controller",
                Fake {
                    probe: reads(""),
                    ..Fake::new()
                },
                "the kernel shows a scope's memory.max as nothing",
            ),
        ];
        for (name, fake, expected) in cases {
            let got = why(probe(&caps(), &fake));
            assert!(got.contains(expected), "{name}: {got}");
        }
    }

    #[test]
    fn leaves_them_uncontained_when_the_kernel_shows_bytes_above_or_a_page_below_the_cap() {
        for shown in [512 << 20, (256 << 20) - (64 << 10)] {
            let fake = Fake {
                probe: reads(&format!(
                    "memory={shown}\nslice={}\nswap=0\n",
                    MACHINE * 8 / 10
                )),
                ..Fake::new()
            };
            let asked = TerminalCaps {
                terminal: "256M".into(),
                ..caps()
            };
            assert!(
                why(probe(&asked, &fake)).contains("asked for 256M"),
                "{shown}"
            );
        }
    }

    #[test]
    fn refuses_a_cap_systemd_wouldnt_take_before_running_anything() {
        let fake = Fake::new();
        let asked = TerminalCaps {
            terminal: "0".into(),
            ..caps()
        };
        assert_eq!(
            probe(&asked, &fake),
            Err(CapsRefused {
                caps: asked.clone(),
                why: "must be at least 64M, or a terminal can't start",
            })
        );
        assert_eq!(fake.calls(), []);
    }

    #[test]
    fn takes_the_memory_caps_a_terminal_may_be_given() {
        for size in [
            "64M", "8G", "1T", "67108864", "1%", "50%", "100%", "infinity",
        ] {
            assert_eq!(memory_max_refusal(size), None, "{size}");
        }
    }

    #[test]
    fn refuses_any_other_memory_cap_saying_why() {
        for (size, why) in [
            ("0", "at least 64M"),
            ("1K", "at least 64M"),
            ("63M", "at least 64M"),
            ("0%", "a whole percentage"),
            ("101%", "a whole percentage"),
            ("12.345%", "a whole percentage"),
            ("12.5%", "a whole percentage"),
            ("8GB", "a whole percentage"),
            ("8g", "a whole percentage"),
            ("-1", "a whole percentage"),
            ("", "a whole percentage"),
            ("max", "a whole percentage"),
            ("9007199254740992", "a whole percentage"),
            ("+64M", "a whole percentage"),
        ] {
            assert!(
                memory_max_refusal(size).is_some_and(|r| r.contains(why)),
                "{size:?}"
            );
        }
    }

    #[test]
    fn takes_bytes_or_infinity_for_swap_and_refuses_anything_else() {
        for size in ["0", "512M", "4G", "infinity"] {
            assert_eq!(swap_max_refusal(size), None, "{size}");
        }
        for size in ["10%", "4GB", "-1", "", "none"] {
            assert!(
                swap_max_refusal(size).is_some_and(|r| r.contains("0 for none")),
                "{size:?}"
            );
        }
    }

    #[test]
    fn names_a_scope_of_the_terminals_own_unique_to_this_launch_in_the_terminals_slice() {
        let launch = terminal_scope(&scoped(true), "term_abc", "0123456789ab");
        assert_eq!(launch.argv[0], RUN);
        assert!(
            launch
                .argv
                .contains(&"--unit=bazhen-terminal-term_abc-0123456789ab.scope".into())
        );
        assert!(
            launch
                .argv
                .contains(&format!("--slice={TERMINALS_SLICE}").into())
        );
        assert_eq!(launch.argv.last().unwrap(), "--");
    }

    #[test]
    fn caps_a_terminals_memory_and_swap_and_keeps_its_holder_through_an_oom_kill() {
        assert_eq!(
            values_after(&terminal_scope(&scoped(true), "t", "0").argv, "-p"),
            [
                "MemoryMax=50%",
                "MemorySwapMax=0",
                "OOMPolicy=continue",
                "CollectMode=inactive-or-failed"
            ]
        );
        assert_eq!(
            values_after(&terminal_scope(&scoped(false), "t", "0").argv, "-p"),
            [
                "MemoryMax=50%",
                "MemorySwapMax=0",
                "CollectMode=inactive-or-failed"
            ]
        );
    }

    #[test]
    fn launches_a_terminals_scope_with_the_buss_directory_alone() {
        assert_eq!(
            terminal_scope(&scoped(true), "t", "0").env,
            [("XDG_RUNTIME_DIR".into(), XDG.into())]
        );
    }

    #[test]
    fn knows_a_terminals_scope_by_its_unit_slice_and_parent() {
        let base = "/user.slice/user-1000.slice/user@1000.service";
        for (cgroup, contained) in [
            (
                format!("{base}/bazhen.slice/{TERMINALS_SLICE}/bazhen-terminal-term_a-0f.scope"),
                true,
            ),
            (
                format!("{base}/bazhen.slice/bazhen-tests.slice/bazhen-terminal-term_a-0f.scope"),
                false,
            ),
            (
                format!("{base}/app.slice/{TERMINALS_SLICE}/bazhen-terminal-term_a-0f.scope"),
                false,
            ),
            (
                format!("{base}/bazhen.slice/{TERMINALS_SLICE}/bazhen-capped-1-0f.scope"),
                false,
            ),
            (
                format!("{base}/bazhen.slice/{TERMINALS_SLICE}/bazhen-terminal-.scope"),
                false,
            ),
            (
                format!("{base}/bazhen.slice/{TERMINALS_SLICE}/bazhen-terminal-a.b.scope"),
                false,
            ),
            (
                format!("{base}/app.slice/app-cosmic-term-20805.scope"),
                false,
            ),
            (format!("{TERMINALS_SLICE}/bazhen-terminal-a.scope"), false),
        ] {
            assert_eq!(is_terminal_scope(&cgroup), contained, "{cgroup}");
        }
    }

    #[test]
    fn reads_a_processs_cgroup_from_proc_and_says_nothing_of_one_it_cant_read() {
        let base = "/user.slice/user-1000.slice/user@1000.service";
        let cgroup =
            format!("0::{base}/bazhen.slice/{TERMINALS_SLICE}/bazhen-terminal-term_a-0f.scope\n");
        let read = |path: &str| (path == "/proc/42/cgroup").then(|| cgroup.clone().into_bytes());
        let pid = |raw| Pid::from_raw(raw).unwrap();
        assert_eq!(in_terminal_scope_by(pid(42), read), Some(true));
        assert_eq!(in_terminal_scope_by(pid(43), read), None);
    }

    #[test]
    fn names_the_unified_cgroup_only() {
        assert_eq!(
            cgroup_of(b"1:name=systemd:/a\n0::/b/c.scope\n"),
            Some("/b/c.scope")
        );
        for text in [
            &b""[..],
            b"0::",
            b"0::relative",
            b"0::/has space",
            b"10::/b",
        ] {
            assert_eq!(cgroup_of(text), None, "{text:?}");
        }
    }

    #[test]
    fn keeps_the_probe_fields_it_knows_and_passes_over_others() {
        assert_eq!(
            parse_probe(b"memory=1\nother=x\nslice=max\n"),
            Some(ProbeReading {
                memory: Some("1".into()),
                swap: None,
                slice: Some("max".into()),
            })
        );
        assert_eq!(parse_probe(b""), Some(ProbeReading::default()));
        for stdout in [&b"not a reading"[..], b"memory=1\njunk\n", b"\xff=1"] {
            assert_eq!(parse_probe(stdout), None, "{stdout:?}");
        }
    }

    /// A directory of the test's own, removed when the test ends, whether or not it passed.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("bz-host-guard-{name}-{}-{n}", std::process::id()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, file: &str, text: &str) {
            let path = self.0.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            // A directory left in the temp dir costs nothing a test would see.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The script a probe scope runs, run here by `/bin/sh` with no environment, as a scope would
    /// run it, against a cgroup mount of the test's own where every cap differs: a scope's, its
    /// slice's, at the root and a level below it, with caps missing, and with no cgroup named.
    #[test]
    fn reads_the_caps_of_the_cgroup_it_was_started_in_with_builtins_alone() {
        let dir = TempDir::new("probe");
        for (file, text) in [
            ("mnt/memory.max", "1\n"),
            ("mnt/a.slice/memory.max", "2\n"),
            ("mnt/a.slice/s.scope/memory.max", "3\n"),
            ("mnt/a.slice/s.scope/memory.swap.max", "4\n"),
            ("mnt/r.scope/memory.max", "5\n"),
            ("mnt/memory.swap.max", "6\n"),
            ("mnt/b.slice/t.scope/memory.max", "7\n"),
            ("no_slice_cap", "0::/b.slice/t.scope\n"),
            ("nested", "1:name=x:/elsewhere\n0::/a.slice/s.scope\n"),
            ("below_root", "0::/r.scope\n"),
            ("root", "0::/\n"),
            ("none", "1:name=x:/elsewhere\n"),
        ] {
            dir.write(file, text);
        }
        let mount = dir.0.join("mnt");
        for (proc_file, expected) in [
            ("nested", "memory=3\nswap=4\nslice=2\n"),
            ("below_root", "memory=5\nslice=1\n"),
            ("root", "memory=1\nswap=6\n"),
            ("no_slice_cap", "memory=7\n"),
            ("none", ""),
            ("missing", ""),
        ] {
            let out = std::process::Command::new(super::PROBE_SHELL)
                .arg("-c")
                .arg(PROBE_SCRIPT)
                .arg("probe")
                .arg(&mount)
                .arg(dir.0.join(proc_file))
                .env_clear()
                .output()
                .unwrap();
            assert_eq!(
                (
                    out.status.code(),
                    out.stdout.as_slice(),
                    out.stderr.as_slice()
                ),
                (Some(0), expected.as_bytes(), &b""[..]),
                "{proc_file}"
            );
        }
    }

    /// Only an executable file in an absolute directory, as the scope's `systemd-run` is kept.
    #[test]
    fn finds_a_command_as_an_executable_file_in_an_absolute_directory_alone() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = TempDir::new("which");
        for (file, mode) in [
            ("plain/cmd", 0o644),
            ("good/cmd", 0o755),
            ("later/cmd", 0o755),
        ] {
            dir.write(file, "");
            std::fs::set_permissions(dir.0.join(file), std::fs::Permissions::from_mode(mode))
                .unwrap();
        }
        std::fs::create_dir_all(dir.0.join("folder/cmd")).unwrap();
        let path =
            |dirs: &[&str]| std::env::join_paths(dirs.iter().map(|d| dir.0.join(d))).unwrap();
        let all = path(&["plain", "folder", "good", "later"]);
        assert_eq!(
            super::which("cmd", Some(&all)),
            Some(dir.0.join("good/cmd"))
        );
        assert_eq!(super::which("cmd", Some(&path(&["plain", "folder"]))), None);
        // The same directory, named from here: it resolves, but a scope's directory may differ.
        let up = std::env::current_dir().unwrap().components().count() - 1;
        let relative =
            "../".repeat(up) + dir.0.join("good").to_str().unwrap().trim_start_matches('/');
        assert!(Path::new(&relative).join("cmd").is_file(), "{relative}");
        assert_eq!(super::which("cmd", Some(OsStr::new(&relative))), None);
        assert_eq!(super::which("cmd", None), None);
    }

    /// What a step says, where the command said nothing of it, and with nothing of this process's
    /// environment but what it was given.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn runs_a_step_with_the_environment_it_was_given_alone() {
        bazhen_test_signal::require_sandbox().unwrap();
        let host = super::Host;
        let run = |program: &str, args: &[&str]| {
            let args = args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(host.run(
                    Path::new(program),
                    &args,
                    &[("XDG_RUNTIME_DIR", OsStr::new("/run/x"))],
                ))
        };
        assert_eq!(run("/usr/bin/env", &[]), ok("XDG_RUNTIME_DIR=/run/x\n"));
        let failed = run("/bin/sh", &["-c", "exit 4"]);
        assert_eq!(
            (failed.code, failed.stderr.as_str()),
            (Some(4), "exit status: 4")
        );
    }

    #[test]
    fn reads_the_systemd_version_and_the_machines_memory() {
        assert_eq!(systemd_version(b"systemd 255 (255.4)\n+PAM"), Some(255));
        for stdout in [
            &b""[..],
            b"systemd x",
            b"systemd 99999999999",
            b"libsystemd 255",
        ] {
            assert_eq!(systemd_version(stdout), None, "{stdout:?}");
        }
        assert_eq!(
            mem_total(b"MemFree: 1 kB\nMemTotal:       16318412 kB\n"),
            Some(16_318_412 * 1024)
        );
        for meminfo in [
            &b""[..],
            b"MemTotal: kB",
            b"MemTotal: 12 MB",
            b"MemTotal: -1 kB",
        ] {
            assert_eq!(mem_total(meminfo), None, "{meminfo:?}");
        }
    }
}
