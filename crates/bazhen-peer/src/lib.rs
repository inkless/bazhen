//! Who is at the other end of a connection to the daemon's socket: the process, its session, and
//! its ancestors, which the daemon matches against the terminals it runs to tell an agent's call
//! from the human's (foundation-design §9.1). Node can't read a Unix socket's peer credentials,
//! so the daemon asks this. It only reads: nothing here reaches a process.
//!
//! Every answer is whole or refused. A walk that stops at a process it can't read might have
//! passed an agent's terminal, and a peer that has gone, or whose pid another process now holds,
//! isn't the one the kernel named at accept: either would read as no agent's, so neither is
//! answered. Nor is a peer the kernel can't name, outside the daemon's PID namespace, as a host
//! process calling a daemon in a container is.
//!
//! It also names the Codex app-server above the caller, if there is one. Codex runs an agent's tool
//! commands in that server, which is in no terminal, so without it the daemon would take them for
//! the human's.
//!
//! The caller's environment is read for `CODEX_THREAD_ID` only, which the caller sets for itself.
//! One the kernel withholds only because the caller runs as another of this user's groups, as a
//! `newgrp` or `sg` shell does, is said to be withheld rather than refused: that says nothing of
//! Codex, and the daemon takes the thread the call presents instead.

use std::cell::Cell;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io;
use std::os::fd::BorrowedFd;
use std::path::Path;
use std::thread;
use std::time::Duration;

#[cfg(target_os = "linux")]
use bazhen_holder::process::Credentials;
use bazhen_holder::{process, start_time};
use rustix::process::{Pid, geteuid};

/// Past any real process tree's depth: a walk this long is a cycle, and is refused.
pub const MAX_ANCESTORS: usize = 256;

/// How many times `line_of` reads a caller's line before it refuses one that keeps changing.
pub const LINE_TRIES: usize = 8;

/// How long `line_of` waits after its first try, doubled after each one but the last: 127 ms in
/// all, over `LINE_TRIES`. An exiting process has no arguments to show from when it gives up its
/// memory until it hands its children on, which a loaded machine can stretch past a few tries
/// made back to back.
pub const FIRST_PAUSE: Duration = Duration::from_millis(1);

/// The process at the other end of a connection, the session it is in (`None` for one led from
/// outside the daemon's PID namespace, which no terminal the daemon runs can lead), what its line
/// says of Codex (`codex_of`), and every ancestor it has, nearest first, through init or the first
/// process of its PID namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub pid: Pid,
    pub session: Option<Pid>,
    pub codex_server: Option<Pid>,
    pub environment_withheld: bool,
    pub ancestors: Vec<Pid>,
}

/// One line of decimals: the pid, the session or 0, the Codex app-server or 0, 1 when the caller's
/// environment was withheld or else 0, then each ancestor. A daemon of another build would read
/// these fields as other ones, the flag as an ancestor's pid; the daemon installs and runs the
/// reader of its own build, so the two always agree.
impl fmt::Display for Peer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let session = self.session.map_or(0, Pid::as_raw_pid);
        let codex_server = self.codex_server.map_or(0, Pid::as_raw_pid);
        let withheld = u8::from(self.environment_withheld);
        write!(
            f,
            "{} {session} {codex_server} {withheld}",
            self.pid.as_raw_pid()
        )?;
        for ancestor in &self.ancestors {
            write!(f, " {}", ancestor.as_raw_pid())?;
        }
        Ok(())
    }
}

/// Why no peer is named.
#[derive(Debug, thiserror::Error)]
pub enum Refused {
    /// The socket isn't a connected Unix socket, or a process on the way can't be read.
    #[error("a process on the caller's line can't be read: {0}")]
    Unreadable(#[from] io::Error),
    /// Another user is at the other end, whom the daemon never serves.
    #[error("the caller runs as uid {uid}, another user")]
    Foreign { uid: u32 },
    /// The pid's process started after the connection was accepted, so it took a pid its caller
    /// gave up.
    #[error(
        "the caller's pid is held by a process that started at {started}, \
         after the connection was accepted at {accepted}"
    )]
    Replaced { started: u64, accepted: u64 },
    /// The walk went past `MAX_ANCESTORS` without reaching a process with no parent.
    #[error("the caller's ancestors go past {MAX_ANCESTORS} processes")]
    Endless,
}

/// Who is at the other end of `socket`, accepted at `accepted` (epoch seconds), as the kernel names
/// it (`bazhen_pid::peer_pid`). Its start is read again once the walk is done: a process that started
/// since the connection was accepted holds a pid its caller gave up.
///
/// # Errors
///
/// As `Refused` says.
pub fn of(socket: BorrowedFd<'_>, accepted: u64) -> Result<Peer, Refused> {
    let uid = bazhen_pid::peer_uid(socket)?;
    if uid != geteuid().as_raw() {
        return Err(Refused::Foreign { uid });
    }
    let pid = bazhen_pid::peer_pid(socket)?;
    let started = started(pid, accepted)?;
    let (ancestors, codex) = line_of(pid, step, own_args, own_environ, thread::sleep)?;
    let peer = Peer {
        pid,
        session: bazhen_pid::session(Some(pid))?,
        codex_server: codex.server,
        environment_withheld: codex.environment_withheld,
        ancestors,
    };
    if self::started(pid, accepted)? != started {
        return Err(Refused::Replaced { started, accepted });
    }
    Ok(peer)
}

/// When `pid`'s process started, refused when that was after `accepted`.
fn started(pid: Pid, accepted: u64) -> Result<u64, Refused> {
    let started =
        u64::from(start_time::of(pid).map_err(|e| Refused::Unreadable(io::Error::other(e)))?);
    if started > accepted {
        return Err(Refused::Replaced { started, accepted });
    }
    Ok(started)
}

/// What one read of a process says of its place on a line: its parent, and when it started, in the
/// finest unit the OS keeps, which a process that took its pid since would show another of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub parent: Option<Pid>,
    pub started: u64,
}

/// `pid`'s ancestors as `parent` names them, nearest first, through init or a process with no
/// parent.
///
/// # Errors
///
/// `Unreadable` when a process on the way can't be read, and `Endless` past `MAX_ANCESTORS`.
pub fn ancestors(
    pid: Pid,
    parent: impl Fn(Pid) -> io::Result<Option<Pid>>,
) -> Result<Vec<Pid>, Refused> {
    let walked = walk(pid, |at| {
        Ok(Step {
            parent: parent(at)?,
            started: 0,
        })
    })?;
    Ok(walked.into_iter().skip(1).map(|(at, _)| at).collect())
}

/// `pid` and its ancestors as `step` reads each, nearest first, through init or a process with no
/// parent, with when each started; init's, which no process can take over, isn't read.
///
/// # Errors
///
/// As `ancestors`.
fn walk(pid: Pid, step: impl Fn(Pid) -> io::Result<Step>) -> Result<Vec<(Pid, u64)>, Refused> {
    let mut walked = Vec::new();
    let mut at = pid;
    while !at.is_init() {
        let Step { parent, started } = step(at)?;
        walked.push((at, started));
        let Some(next) = parent else {
            return Ok(walked);
        };
        if walked.len() > MAX_ANCESTORS {
            return Err(Refused::Endless);
        }
        at = next;
    }
    walked.push((at, 0));
    Ok(walked)
}

/// `pid`'s parent and start in clock ticks since boot, from one read of its `stat`. A zombie has
/// already handed its children on, so it is on no line.
#[cfg(target_os = "linux")]
fn step(pid: Pid) -> io::Result<Step> {
    let stat = std::fs::read(format!("/proc/{}/stat", pid.as_raw_pid()))?;
    if start_time::has_exited(&stat) {
        return Err(io::Error::other(format!("process {pid:?} has exited")));
    }
    let unread = |what: &str| io::Error::other(format!("process {pid:?} names no {what}"));
    let parent = start_time::parent_field(&stat).ok_or_else(|| unread("parent"))?;
    let started = start_time::start_ticks(&stat).ok_or_else(|| unread("start"))?;
    Ok(Step {
        parent: Pid::from_raw(parent),
        started,
    })
}

/// `pid`'s parent and its start in epoch seconds, the finest that macOS's readers here keep.
#[cfg(target_os = "macos")]
fn step(pid: Pid) -> io::Result<Step> {
    Ok(Step {
        parent: process::parent(pid)?,
        started: u64::from(start_time::of(pid).map_err(io::Error::other)?),
    })
}

/// Whether `args` are a Codex app-server's: `codex`, by the file name of `argv[0]`, with
/// `app-server` as one of its arguments, whole. The TUI's `--remote unix:///…/app-server-control.sock`
/// only contains it.
#[must_use]
pub fn is_codex_app_server(args: &[OsString]) -> bool {
    let Some((binary, rest)) = args.split_first() else {
        return false;
    };
    let named = Path::new(binary).file_name().is_some_and(|name| {
        name == OsStr::new("codex") || name.as_encoded_bytes().starts_with(b"codex-")
    });
    named && rest.iter().any(|arg| arg == "app-server")
}

/// The first of `line` that is a Codex app-server, as `args` reads each one's arguments: `None`
/// for another user's process, which this user's Codex never is.
///
/// # Errors
///
/// `Unreadable` when a process of this user can't be read: it might have been the server.
pub fn codex_server(
    line: &[Pid],
    args: impl Fn(Pid) -> io::Result<Option<Vec<OsString>>>,
) -> Result<Option<Pid>, Refused> {
    for &pid in line {
        match args(pid)? {
            Some(args) if args.is_empty() => {
                return Err(Refused::Unreadable(io::Error::other(format!(
                    "process {pid:?} shows no arguments"
                ))));
            }
            Some(args) if is_codex_app_server(&args) => return Ok(Some(pid)),
            _ => {}
        }
    }
    Ok(None)
}

/// What a caller's line says of Codex: the app-server nearest the caller, or else the caller
/// itself when its environment names a Codex thread; and whether its environment was withheld.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Codex {
    pub server: Option<Pid>,
    pub environment_withheld: bool,
}

/// The Codex app-server nearest the caller on `line` (`codex_server`), or else the caller itself
/// when the environment it started with, as `environ` reads it, names a Codex thread: a command
/// Codex ran that left the server's tree, as one backgrounded by a shell that has exited. An
/// environment `environ` reads as `None` was withheld, and marks no caller.
///
/// # Errors
///
/// `Unreadable` when a process of this user on the line, or the caller's environment, can't be
/// read.
pub fn codex_of(
    line: &[Pid],
    args: impl Fn(Pid) -> io::Result<Option<Vec<OsString>>>,
    environ: impl Fn(Pid) -> io::Result<Option<Vec<OsString>>>,
) -> Result<Codex, Refused> {
    let Some(&caller) = line.first() else {
        return Ok(Codex {
            server: None,
            environment_withheld: false,
        });
    };
    // First: a caller that exits after it is read leaves a zombie whose environment is empty and
    // whose arguments are too, which the walk then refuses.
    let environment = environ(caller)?;
    let marked = environment
        .iter()
        .flatten()
        .any(|var| var.as_encoded_bytes().starts_with(b"CODEX_THREAD_ID="));
    let server = codex_server(line, args)?.or(marked.then_some(caller));
    Ok(Codex {
        server,
        environment_withheld: environment.is_none(),
    })
}

/// `pid`'s ancestors and what its line says of Codex, as `step`, `args` and `environ` read them,
/// from a line that held still while it was read: walked, each process on it read, then walked
/// again, and answered only when both walks name the same processes, each by its pid and its
/// start, and every read succeeded.
///
/// A process that exits leaves the line: it shows no arguments from when it gives up its memory,
/// and the kernel hands its children to another parent before it is a zombie, after which its pid
/// says nothing of the caller. So a read that fails, or a second walk that differs, is tried again
/// from the caller, `pause`d for `FIRST_PAUSE`, doubled after each try, up to `LINE_TRIES` times,
/// and never pieced together from two walks: a process that took a pid meanwhile is on neither
/// walk of a try that is answered. What is answered is the line a caller connecting a moment later
/// would be read with. The caller is the one process that has to stay. A read of it that fails
/// says it has exited, and it never comes back, so it is refused then, with no pause: a try after
/// could only read a process that took its pid. So the first read of it, before any pause, says
/// when it started, and a read of it on any walk after, of any try, that says another time is of a
/// process that took the pid its caller gave up.
///
/// # Errors
///
/// `Unreadable` when the caller can't be read or its pid changed hands, or no try held still: then
/// the last try's refusal, or that its walks differed.
pub fn line_of(
    pid: Pid,
    step: impl Fn(Pid) -> io::Result<Step>,
    args: impl Fn(Pid) -> io::Result<Option<Vec<OsString>>>,
    environ: impl Fn(Pid) -> io::Result<Option<Vec<OsString>>>,
    pause: impl Fn(Duration),
) -> Result<(Vec<Pid>, Codex), Refused> {
    let caller = Cell::new(None);
    let replaced = Cell::new(false);
    let gone = Cell::new(false);
    let step = |at: Pid| {
        let read = match step(at) {
            Ok(read) => read,
            Err(e) if at == pid => {
                gone.set(true);
                return Err(io::Error::other(format!("the caller has gone: {e}")));
            }
            Err(e) => return Err(e),
        };
        if at == pid {
            let pinned = caller.get().unwrap_or(read.started);
            caller.set(Some(pinned));
            replaced.set(replaced.get() || pinned != read.started);
        }
        Ok(read)
    };
    let mut refused = Refused::Endless;
    let mut wait = FIRST_PAUSE;
    for tried in 1..=LINE_TRIES {
        let read = walk(pid, step).and_then(|walked| {
            let line: Vec<Pid> = walked.iter().map(|&(at, _)| at).collect();
            let codex = codex_of(&line, &args, &environ)?;
            Ok((walked, codex))
        });
        let read = read.and_then(|read| Ok((walk(pid, step)?, read)));
        if replaced.get() {
            return Err(Refused::Unreadable(io::Error::other(
                "the caller's pid was taken by another process while its line was read",
            )));
        }
        refused = match read {
            Ok((again, (walked, codex))) if again == walked => {
                let ancestors = walked.into_iter().skip(1).map(|(at, _)| at).collect();
                return Ok((ancestors, codex));
            }
            Ok(_) => Refused::Unreadable(io::Error::other(
                "the caller's line changed while it was read",
            )),
            Err(refused) => refused,
        };
        if gone.get() {
            return Err(refused);
        }
        if tried < LINE_TRIES {
            pause(wait);
            wait = wait.saturating_mul(2);
        }
    }
    Err(refused)
}

/// Whether the kernel withholds a process's environment, its `environ` file `owner`'s, from a
/// reader with credentials `ours` for the process's group alone. The kernel shows it only to a
/// reader whose filesystem uid is the process's real, effective and saved uid, whose filesystem gid
/// is its real, effective and saved gid, and only while the process is dumpable
/// (`__ptrace_may_access`), and a process that isn't dumpable has its `environ` owned by root.
/// So: `owner` is our filesystem uid, all four of its uids are that uid, and all four of its gids
/// are one group that isn't our filesystem gid, as a `newgrp` or `sg` shell's are. Gids that
/// differ among themselves are a set-group-id program's, and are not taken for this.
#[cfg(target_os = "linux")]
fn withheld_for_group(owner: u32, theirs: Credentials, ours: Credentials) -> bool {
    let [.., uid] = ours.uids;
    let [.., gid] = ours.gids;
    let [group, ..] = theirs.gids;
    owner == uid && theirs.uids == [uid; 4] && theirs.gids == [group; 4] && group != gid
}

/// `read`, or `None` when it was denied and `withholds` says the denial is the group's
/// (`withheld_for_group`). Any other error stays one.
///
/// # Errors
///
/// `read`'s error, unless it was withheld; or `withholds`'s.
#[cfg(target_os = "linux")]
fn withheld_or(
    read: io::Result<Vec<OsString>>,
    withholds: impl FnOnce() -> io::Result<bool>,
) -> io::Result<Option<Vec<OsString>>> {
    match read {
        Ok(vars) => Ok(Some(vars)),
        Err(denied) if denied.kind() == io::ErrorKind::PermissionDenied => {
            if withholds()? {
                Ok(None)
            } else {
                Err(denied)
            }
        }
        Err(other) => Err(other),
    }
}

/// `pid`'s environment, or `None` when the kernel withholds it for `pid`'s group alone.
#[cfg(target_os = "linux")]
fn own_environ(pid: Pid) -> io::Result<Option<Vec<OsString>>> {
    withheld_or(process::environ(pid), || group_withholds(pid))
}

/// `pid`'s environment. macOS denies another process's environment by rules of its own, none of
/// them taken for withholding.
#[cfg(target_os = "macos")]
fn own_environ(pid: Pid) -> io::Result<Option<Vec<OsString>>> {
    process::environ(pid).map(Some)
}

/// Whether the kernel withholds `pid`'s environment from this process for `pid`'s group alone.
#[cfg(target_os = "linux")]
fn group_withholds(pid: Pid) -> io::Result<bool> {
    withholds_from(pid, process::credentials(rustix::process::getpid())?)
}

/// Whether the kernel withholds `pid`'s environment from a reader with credentials `ours` for
/// `pid`'s group alone.
#[cfg(target_os = "linux")]
fn withholds_from(pid: Pid, ours: Credentials) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt as _;
    let owner = std::fs::metadata(format!("/proc/{}/environ", pid.as_raw_pid()))?.uid();
    Ok(withheld_for_group(owner, process::credentials(pid)?, ours))
}

/// `pid`'s arguments when it runs as this user, else `None`.
fn own_args(pid: Pid) -> io::Result<Option<Vec<OsString>>> {
    if process::uid(pid)? != geteuid().as_raw() {
        return Ok(None);
    }
    process::args(pid).map(Some)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::os::fd::AsFd as _;
    use std::os::unix::net::UnixStream;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rustix::process::{getpid, getppid, getsid};

    use super::*;

    fn pid(raw: i32) -> Pid {
        Pid::from_raw(raw).unwrap()
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    /// A parent table: a pid not in it can't be read, and one mapped to 0 has no parent.
    fn table(parents: &[(i32, i32)]) -> impl Fn(Pid) -> io::Result<Option<Pid>> + use<> {
        let parents: HashMap<i32, i32> = parents.iter().copied().collect();
        move |p| match parents.get(&p.as_raw_pid()) {
            Some(&parent) => Ok(Pid::from_raw(parent)),
            None => Err(io::Error::other("gone")),
        }
    }

    #[test]
    fn walks_the_ancestors_nearest_first_through_init() {
        let walked = ancestors(pid(50), table(&[(50, 40), (40, 30), (30, 1)])).unwrap();
        assert_eq!(walked, [pid(40), pid(30), pid(1)]);
    }

    #[test]
    fn ends_the_walk_at_a_process_with_no_parent() {
        let walked = ancestors(pid(50), table(&[(50, 40), (40, 0)])).unwrap();
        assert_eq!(walked, [pid(40)]);
    }

    #[test]
    fn refuses_a_walk_through_a_process_it_can_t_read() {
        let walked = ancestors(pid(50), table(&[(50, 40)]));
        assert!(matches!(walked, Err(Refused::Unreadable(_))));
    }

    #[test]
    fn says_why_it_refused_on_one_line() {
        let reasons = [
            Refused::Unreadable(io::Error::other("no process 4242")),
            Refused::Foreign { uid: 1001 },
            Refused::Replaced {
                started: 1_794_630_123,
                accepted: 1_794_630_100,
            },
            Refused::Endless,
        ]
        .map(|refused| refused.to_string());
        assert_eq!(
            reasons,
            [
                "a process on the caller's line can't be read: no process 4242",
                "the caller runs as uid 1001, another user",
                "the caller's pid is held by a process that started at 1794630123, \
                 after the connection was accepted at 1794630100",
                "the caller's ancestors go past 256 processes",
            ],
        );
    }

    #[test]
    fn refuses_a_cycle() {
        let walked = ancestors(pid(50), table(&[(50, 60), (60, 50)]));
        assert!(matches!(walked, Err(Refused::Endless)));
    }

    #[test]
    fn names_this_process_its_session_and_parent_at_the_other_end_of_its_own_pair() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        let peer = of(ours.as_fd(), now()).unwrap();
        assert_eq!(
            (peer.pid, peer.session, peer.ancestors.first().copied()),
            (getpid(), Some(getsid(None).unwrap()), getppid()),
        );
    }

    #[test]
    fn refuses_a_peer_whose_process_started_after_the_connection_was_accepted() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        let before_this_process = 0;
        assert!(matches!(
            of(ours.as_fd(), before_this_process),
            Err(Refused::Replaced { .. })
        ));
    }

    #[test]
    fn prints_one_line_of_the_pid_the_session_no_codex_server_no_withholding_and_each_ancestor() {
        let peer = Peer {
            pid: pid(50),
            session: Some(pid(45)),
            codex_server: None,
            environment_withheld: false,
            ancestors: vec![pid(40), pid(1)],
        };
        assert_eq!(peer.to_string(), "50 45 0 0 40 1");
    }

    #[test]
    fn prints_0_for_a_session_led_from_outside_the_namespace() {
        let peer = Peer {
            pid: pid(50),
            session: None,
            codex_server: Some(pid(40)),
            environment_withheld: false,
            ancestors: vec![pid(40), pid(1)],
        };
        assert_eq!(peer.to_string(), "50 0 40 0 40 1");
    }

    #[test]
    fn prints_the_codex_server_before_the_ancestors() {
        let peer = Peer {
            pid: pid(50),
            session: Some(pid(50)),
            codex_server: Some(pid(40)),
            environment_withheld: false,
            ancestors: vec![pid(40), pid(1)],
        };
        assert_eq!(peer.to_string(), "50 50 40 0 40 1");
    }

    #[test]
    fn prints_1_after_the_codex_server_for_a_withheld_environment() {
        let peer = Peer {
            pid: pid(50),
            session: Some(pid(45)),
            codex_server: None,
            environment_withheld: true,
            ancestors: vec![pid(40), pid(1)],
        };
        assert_eq!(peer.to_string(), "50 45 0 1 40 1");
    }

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn knows_a_codex_app_server_by_its_binary_and_its_whole_subcommand() {
        for args in [
            &[
                "/h/.codex/packages/app-server-daemon/releases/0.169.0/bin/codex",
                "app-server",
                "--listen",
                "unix://",
                "--managed-daemon",
            ][..],
            &["codex", "app-server"],
            &["codex", "-c", "x=1", "app-server", "--listen", "stdio://"],
            &[
                "/opt/codex-x86_64-unknown-linux-musl",
                "app-server",
                "--listen",
                "unix://",
            ],
            &["codex-aarch64-apple-darwin", "app-server"],
            &[
                "/h/.codex/packages/app-server-daemon/releases/0.169.0/bin/codex",
                "app-server",
                "daemon",
                "pid-update-loop",
            ],
        ] {
            assert!(is_codex_app_server(&os(args)), "{args:?}");
        }
    }

    #[test]
    fn takes_no_other_process_for_a_codex_app_server() {
        for args in [
            &[
                "codex",
                "resume",
                "t",
                "--remote",
                "unix:///h/.codex/app-server-control/app-server-control.sock",
            ][..],
            &["codex"],
            &[
                "node",
                "/usr/lib/node_modules/@openai/codex/bin/codex.js",
                "app-server",
            ],
            &["/bin/codex-app-server", "app-server2"],
            &["/bin/notcodex", "app-server"],
            &["/bin/codexx", "app-server"],
            &["/bin/codex-x86_64", "app-server-control"],
            &["bash", "-lc", "codex app-server"],
            &["app-server"],
            &[],
        ] {
            assert!(!is_codex_app_server(&os(args)), "{args:?}");
        }
    }

    /// Arguments by pid: a pid not in it can't be read, and one mapped to `None` is another user's.
    fn argv(
        table: &[(i32, Option<&[&str]>)],
    ) -> impl Fn(Pid) -> io::Result<Option<Vec<OsString>>> + use<> {
        let table: HashMap<i32, Option<Vec<OsString>>> =
            table.iter().map(|(p, a)| (*p, a.map(os))).collect();
        move |p| match table.get(&p.as_raw_pid()) {
            Some(args) => Ok(args.clone()),
            None => Err(io::Error::other("gone")),
        }
    }

    const SERVER: &[&str] = &["/r/bin/codex", "app-server", "--listen", "unix://"];

    #[test]
    fn names_the_nearest_codex_app_server_on_the_line() {
        let table = argv(&[
            (50, Some(&["bash", "-lc", "bazhen devices"])),
            (40, Some(SERVER)),
            (30, Some(SERVER)),
            (1, None),
        ]);
        let line = [pid(50), pid(40), pid(30), pid(1)];
        assert_eq!(codex_server(&line, table).unwrap(), Some(pid(40)));
    }

    #[test]
    fn names_the_caller_itself_when_it_is_the_server() {
        let table = argv(&[(40, Some(SERVER)), (1, None)]);
        assert_eq!(
            codex_server(&[pid(40), pid(1)], table).unwrap(),
            Some(pid(40))
        );
    }

    #[test]
    fn names_no_server_on_a_line_without_one() {
        let table = argv(&[
            (50, Some(&["bazhen", "devices"])),
            (40, Some(&["fish"])),
            (1, None),
        ]);
        assert_eq!(
            codex_server(&[pid(50), pid(40), pid(1)], table).unwrap(),
            None
        );
    }

    #[test]
    fn skips_another_user_s_process_without_reading_it() {
        let table = argv(&[(50, Some(&["bazhen", "devices"])), (40, None), (1, None)]);
        assert_eq!(
            codex_server(&[pid(50), pid(40), pid(1)], table).unwrap(),
            None
        );
    }

    #[test]
    fn refuses_a_line_through_a_process_of_this_user_with_no_arguments() {
        let table = argv(&[
            (50, Some(&["bazhen", "devices"])),
            (40, Some(&[])),
            (1, None),
        ]);
        let read = codex_server(&[pid(50), pid(40), pid(1)], table);
        assert!(matches!(read, Err(Refused::Unreadable(_))));
    }

    #[test]
    fn marks_a_caller_whose_environment_names_a_codex_thread_though_no_server_is_above_it() {
        let line = [pid(50), pid(1)];
        let table = || argv(&[(50, Some(&["bazhen", "devices"])), (1, None)]);
        let env = |vars: &'static [&'static str]| move |_: Pid| Ok(Some(os(vars)));
        assert_eq!(
            codex_of(&line, table(), env(&["HOME=/h", "CODEX_THREAD_ID=thr-1"])).unwrap(),
            Codex {
                server: Some(pid(50)),
                environment_withheld: false
            },
        );
        assert_eq!(
            codex_of(&line, table(), env(&["HOME=/h", "CODEX_HOME=/c"])).unwrap(),
            Codex {
                server: None,
                environment_withheld: false
            },
        );
    }

    #[test]
    fn reads_the_caller_s_environment_before_its_arguments_which_an_exit_between_would_empty() {
        let exited = std::cell::Cell::new(false);
        let args = |p: Pid| {
            exited.set(true);
            argv(&[(50, Some(&["bazhen", "devices"])), (1, None)])(p)
        };
        let environ = |_: Pid| {
            Ok(Some(if exited.get() {
                Vec::new()
            } else {
                os(&["CODEX_THREAD_ID=thr-1"])
            }))
        };
        assert_eq!(
            codex_of(&[pid(50), pid(1)], args, environ).unwrap().server,
            Some(pid(50))
        );
    }

    #[test]
    fn names_the_server_over_the_caller_s_own_environment() {
        let line = [pid(50), pid(40), pid(1)];
        let table = argv(&[(50, Some(&["bazhen"])), (40, Some(SERVER)), (1, None)]);
        let marked = |_: Pid| Ok(Some(os(&["CODEX_THREAD_ID=thr-1"])));
        assert_eq!(
            codex_of(&line, table, marked).unwrap().server,
            Some(pid(40))
        );
    }

    #[test]
    fn says_a_withheld_environment_marks_no_caller_and_leaves_the_server_named() {
        let withheld = |_: Pid| Ok(None);
        let alone = argv(&[(50, Some(&["bazhen"])), (1, None)]);
        let served = argv(&[(50, Some(&["bazhen"])), (40, Some(SERVER)), (1, None)]);
        assert_eq!(
            [
                codex_of(&[pid(50), pid(1)], alone, withheld).unwrap(),
                codex_of(&[pid(50), pid(40), pid(1)], served, withheld).unwrap(),
            ],
            [
                Codex {
                    server: None,
                    environment_withheld: true
                },
                Codex {
                    server: Some(pid(40)),
                    environment_withheld: true
                },
            ],
        );
    }

    /// The reader's uid and gid, apart so that a rule reading one for the other is told apart.
    #[cfg(target_os = "linux")]
    const READER_UID: u32 = 1000;
    #[cfg(target_os = "linux")]
    const READER_GID: u32 = 2000;
    #[cfg(target_os = "linux")]
    const READER: Credentials = Credentials {
        uids: [READER_UID; 4],
        gids: [READER_GID; 4],
    };

    /// A `newgrp libvirt` shell's credentials: every uid the reader's, every gid group 141.
    #[cfg(target_os = "linux")]
    const GROUP_SHELL: Credentials = Credentials {
        uids: [READER_UID; 4],
        gids: [141; 4],
    };

    #[cfg(target_os = "linux")]
    fn group_withheld(owner: u32, theirs: Credentials) -> bool {
        withheld_for_group(owner, theirs, READER)
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[cfg(target_os = "linux")]
    fn takes_a_denial_for_the_group_s_when_every_uid_is_the_reader_s_and_every_gid_one_other() {
        assert!(group_withheld(READER_UID, GROUP_SHELL));
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[cfg(target_os = "linux")]
    fn takes_no_denial_for_the_group_s_from_a_process_that_isn_t_dumpable() {
        assert!(!group_withheld(0, GROUP_SHELL));
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[cfg(target_os = "linux")]
    fn takes_no_denial_for_the_group_s_when_any_uid_isn_t_the_reader_s() {
        for slot in 0..4 {
            let mut theirs = GROUP_SHELL;
            theirs.uids[slot] = 0;
            assert!(!group_withheld(READER_UID, theirs), "uid {slot}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[cfg(target_os = "linux")]
    fn takes_no_denial_for_the_group_s_when_the_gids_differ_among_themselves() {
        for slot in 0..4 {
            let mut theirs = GROUP_SHELL;
            theirs.gids[slot] = READER_GID;
            assert!(!group_withheld(READER_UID, theirs), "gid {slot}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[cfg(target_os = "linux")]
    fn compares_with_the_reader_s_filesystem_uid_and_gid() {
        let reader = |uid: u32, gid: u32| Credentials {
            uids: [1, 1, 1, uid],
            gids: [1, 1, 1, gid],
        };
        assert_eq!(
            [
                withheld_for_group(READER_UID, GROUP_SHELL, reader(READER_UID, READER_GID)),
                withheld_for_group(READER_UID, GROUP_SHELL, reader(READER_UID, 141)),
                withheld_for_group(READER_UID, GROUP_SHELL, reader(1, READER_GID)),
            ],
            [true, false, false],
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[cfg(target_os = "linux")]
    fn takes_no_denial_for_the_group_s_when_every_gid_is_the_reader_s() {
        let theirs = Credentials {
            gids: [READER_GID; 4],
            ..GROUP_SHELL
        };
        assert!(!group_withheld(READER_UID, theirs));
    }

    #[cfg(target_os = "linux")]
    fn denied(kind: io::ErrorKind) -> io::Result<Vec<OsString>> {
        Err(io::Error::from(kind))
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[cfg(target_os = "linux")]
    fn withholds_only_a_denied_read_that_the_group_explains() {
        let read = [
            withheld_or(denied(io::ErrorKind::PermissionDenied), || Ok(true)),
            withheld_or(Ok(os(&["HOME=/h"])), || Ok(true)),
        ];
        assert_eq!(read.map(Result::unwrap), [None, Some(os(&["HOME=/h"]))]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[cfg(target_os = "linux")]
    fn keeps_a_denial_the_group_doesn_t_explain_and_every_other_error() {
        let kept = [
            withheld_or(denied(io::ErrorKind::PermissionDenied), || Ok(false)),
            withheld_or(denied(io::ErrorKind::PermissionDenied), || {
                Err(io::Error::other("gone"))
            }),
            withheld_or(denied(io::ErrorKind::NotFound), || Ok(true)),
            withheld_or(Err(io::Error::other("ESRCH")), || Ok(true)),
        ];
        assert!(kept.iter().all(Result::is_err), "{kept:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn takes_no_denial_of_init_s_or_this_process_s_environment_for_the_group_s() {
        let init = Pid::from_raw(1).unwrap();
        assert_eq!(
            [
                group_withholds(init).unwrap(),
                group_withholds(getpid()).unwrap()
            ],
            [false, false],
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn takes_this_process_for_a_group_shell_to_a_reader_of_another_group() {
        let ours = process::credentials(getpid()).unwrap();
        let [.., gid] = ours.gids;
        let other_group = Credentials {
            gids: [gid.wrapping_add(1); 4],
            ..ours
        };
        let other_user = Credentials {
            uids: ours.uids.map(|uid| uid.wrapping_add(1)),
            ..other_group
        };
        assert_eq!(
            [
                withholds_from(getpid(), other_group).unwrap(),
                withholds_from(getpid(), other_user).unwrap(),
            ],
            [true, false],
        );
    }

    #[test]
    fn reads_this_process_s_own_environment_whole() {
        let path = std::env::var_os("PATH").unwrap();
        let mut entry = OsString::from("PATH=");
        entry.push(path);
        assert!(own_environ(getpid()).unwrap().unwrap().contains(&entry));
    }

    #[test]
    fn refuses_a_caller_whose_environment_it_can_t_read() {
        let table = argv(&[(50, Some(&["bazhen"])), (1, None)]);
        let unreadable = |_: Pid| Err(io::Error::other("gone"));
        let read = codex_of(&[pid(50), pid(1)], table, unreadable);
        assert!(matches!(read, Err(Refused::Unreadable(_))));
    }

    #[test]
    fn refuses_a_line_through_a_process_of_this_user_it_can_t_read() {
        let table = argv(&[(50, Some(&["bazhen", "devices"])), (1, None)]);
        let read = codex_server(&[pid(50), pid(40), pid(1)], table);
        assert!(matches!(read, Err(Refused::Unreadable(_))));
    }

    #[test]
    fn reads_this_process_s_own_arguments_as_its_user_s() {
        let ours: Vec<OsString> = std::env::args_os().collect();
        assert_eq!(own_args(getpid()).unwrap(), Some(ours));
    }

    const NO_CODEX: Codex = Codex {
        server: None,
        environment_withheld: false,
    };

    /// Arguments that read as a shell's for every pid but `pid`'s, which `then` answers, and
    /// init's, another user's.
    fn shells_but(
        pid: i32,
        then: impl Fn() -> io::Result<Option<Vec<OsString>>>,
    ) -> impl Fn(Pid) -> io::Result<Option<Vec<OsString>>> {
        move |p| match p.as_raw_pid() {
            1 => Ok(None),
            raw if raw == pid => then(),
            _ => Ok(Some(os(&["sh"]))),
        }
    }

    fn no_environment() -> impl Fn(Pid) -> io::Result<Option<Vec<OsString>>> {
        |_| Ok(Some(Vec::new()))
    }

    /// A step to `parent`, of a process that started at `started`.
    fn to(parent: i32, started: u64) -> Step {
        Step {
            parent: Pid::from_raw(parent),
            started,
        }
    }

    /// Each pause `line_of` asks for, which a test takes note of rather than waits out.
    fn pauses() -> (Rc<RefCell<Vec<Duration>>>, impl Fn(Duration)) {
        let taken = Rc::new(RefCell::new(Vec::new()));
        let noted = Rc::clone(&taken);
        (taken, move |pause| noted.borrow_mut().push(pause))
    }

    fn ms(each: &[u64]) -> Vec<Duration> {
        each.iter().copied().map(Duration::from_millis).collect()
    }

    #[test]
    fn reads_again_a_line_an_ancestor_left_while_its_arguments_were_read_and_answers_the_line_left()
    {
        let exited = Cell::new(false);
        let step = |p: Pid| match p.as_raw_pid() {
            50 if exited.get() => Ok(to(1, 5)),
            50 => Ok(to(40, 5)),
            40 if exited.get() => Err(io::Error::other("process 40 has exited")),
            40 => Ok(to(30, 4)),
            30 => Ok(to(1, 3)),
            _ => Ok(to(0, 0)),
        };
        let args = shells_but(40, || {
            exited.set(true);
            Ok(Some(Vec::new()))
        });
        let (taken, pause) = pauses();
        let answer = line_of(pid(50), step, args, no_environment(), pause).unwrap();
        assert_eq!(answer, (vec![pid(1)], NO_CODEX));
        assert_eq!(*taken.borrow(), ms(&[1]));
    }

    #[test]
    fn waits_out_an_ancestor_that_shows_no_arguments_while_it_exits_until_it_hands_the_caller_on() {
        let reads = Cell::new(0);
        let handed_on = || reads.get() >= 5;
        let step = |p: Pid| match p.as_raw_pid() {
            50 if handed_on() => Ok(to(1, 5)),
            50 => Ok(to(40, 5)),
            40 => Ok(to(1, 4)),
            _ => Ok(to(0, 0)),
        };
        let args = shells_but(40, || {
            reads.set(reads.get() + 1);
            Ok(Some(Vec::new()))
        });
        let (taken, pause) = pauses();
        let answer = line_of(pid(50), step, args, no_environment(), pause).unwrap();
        assert_eq!(answer, (vec![pid(1)], NO_CODEX));
        assert_eq!(*taken.borrow(), ms(&[1, 2, 4, 8, 16]));
    }

    #[test]
    fn refuses_a_line_that_changes_each_time_it_is_read_after_tries_that_wait_127_ms_in_all() {
        let walks = Cell::new(0);
        let step = |p: Pid| match p.as_raw_pid() {
            50 => {
                walks.set(walks.get() + 1);
                Ok(to(if walks.get() % 2 == 1 { 40 } else { 41 }, 5))
            }
            40 | 41 => Ok(to(1, 4)),
            _ => Ok(to(0, 0)),
        };
        let (taken, pause) = pauses();
        let refused = line_of(
            pid(50),
            step,
            shells_but(0, || Ok(None)),
            no_environment(),
            pause,
        );
        assert_eq!(
            refused.map_err(|refused| refused.to_string()),
            Err("a process on the caller's line can't be read: \
                 the caller's line changed while it was read"
                .to_owned())
        );
        assert_eq!(walks.get(), 2 * LINE_TRIES);
        assert_eq!(*taken.borrow(), ms(&[1, 2, 4, 8, 16, 32, 64]));
    }

    #[test]
    fn answers_no_line_pieced_from_an_ancestor_and_the_process_that_took_its_pid() {
        let walks = Cell::new(0);
        let step = |p: Pid| match p.as_raw_pid() {
            50 => {
                walks.set(walks.get() + 1);
                Ok(to(if walks.get() == 1 { 40 } else { 1 }, 5))
            }
            40 => Ok(to(99, 7)),
            99 => Ok(to(1, 6)),
            _ => Ok(to(0, 0)),
        };
        let args = |p: Pid| match p.as_raw_pid() {
            1 => Ok(None),
            99 => Ok(Some(os(SERVER))),
            _ => Ok(Some(os(&["sh"]))),
        };
        let answer = line_of(pid(50), step, args, no_environment(), |_| {}).unwrap();
        assert_eq!(answer, (vec![pid(1)], NO_CODEX));
    }

    #[test]
    fn answers_no_line_through_a_pid_another_process_took_in_place_between_the_walks() {
        let walks = Cell::new(0);
        let step = |p: Pid| match p.as_raw_pid() {
            50 => Ok(to(40, 5)),
            40 => {
                walks.set(walks.get() + 1);
                Ok(to(1, if walks.get() == 1 { 3 } else { 4 }))
            }
            _ => Ok(to(0, 0)),
        };
        let args = |p: Pid| match p.as_raw_pid() {
            1 => Ok(None),
            40 if walks.get() == 1 => Ok(Some(os(SERVER))),
            _ => Ok(Some(os(&["sh"]))),
        };
        let answer = line_of(pid(50), step, args, no_environment(), |_| {}).unwrap();
        assert_eq!(answer, (vec![pid(40), pid(1)], NO_CODEX));
    }

    #[test]
    fn refuses_a_caller_whose_pid_another_process_took_while_its_line_was_read() {
        let walks = Cell::new(0);
        let step = |p: Pid| match p.as_raw_pid() {
            50 => {
                walks.set(walks.get() + 1);
                Ok(to(1, if walks.get() == 1 { 5 } else { 6 }))
            }
            _ => Ok(to(0, 0)),
        };
        let refused = line_of(
            pid(50),
            step,
            shells_but(0, || Ok(None)),
            no_environment(),
            |_| {},
        );
        assert_eq!(
            refused.map_err(|refused| refused.to_string()),
            Err("a process on the caller's line can't be read: \
                 the caller's pid was taken by another process while its line was read"
                .to_owned())
        );
    }

    #[test]
    fn refuses_a_caller_whose_pid_another_process_took_after_a_try_that_failed() {
        let walks = Cell::new(0);
        let step = |p: Pid| match p.as_raw_pid() {
            50 => {
                walks.set(walks.get() + 1);
                Ok(if walks.get() == 1 {
                    to(40, 5)
                } else {
                    to(1, 6)
                })
            }
            40 => Ok(to(1, 4)),
            _ => Ok(to(0, 0)),
        };
        let args = shells_but(40, || Err(io::Error::other("gone")));
        let refused = line_of(pid(50), step, args, no_environment(), |_| {});
        assert_eq!(
            refused.map_err(|refused| refused.to_string()),
            Err("a process on the caller's line can't be read: \
                 the caller's pid was taken by another process while its line was read"
                .to_owned())
        );
    }

    #[test]
    fn refuses_at_once_a_caller_it_can_t_read_never_answering_the_process_that_takes_its_pid() {
        let caller_reads = Cell::new(0);
        let step = |p: Pid| match p.as_raw_pid() {
            50 => {
                caller_reads.set(caller_reads.get() + 1);
                if caller_reads.get() == 1 {
                    Err(io::Error::other("process Pid(50) has exited"))
                } else {
                    Ok(to(40, 6))
                }
            }
            40 => Ok(to(1, 4)),
            _ => Ok(to(0, 0)),
        };
        let args = |p: Pid| match p.as_raw_pid() {
            1 => Ok(None),
            40 => Ok(Some(os(SERVER))),
            _ => Ok(Some(os(&["sh"]))),
        };
        let (taken, pause) = pauses();
        let refused = line_of(pid(50), step, args, no_environment(), pause);
        assert_eq!(
            refused.as_ref().map_err(ToString::to_string),
            Err("a process on the caller's line can't be read: \
                 the caller has gone: process Pid(50) has exited"
                .to_owned())
        );
        assert!(matches!(refused, Err(Refused::Unreadable(_))));
        assert_eq!(*taken.borrow(), ms(&[]));
        assert_eq!(caller_reads.get(), 1);
    }

    #[test]
    fn refuses_with_no_pause_a_caller_that_goes_between_the_walks_of_a_try() {
        let caller_reads = Cell::new(0);
        let step = |p: Pid| match p.as_raw_pid() {
            50 => {
                caller_reads.set(caller_reads.get() + 1);
                if caller_reads.get() == 1 {
                    Ok(to(40, 5))
                } else {
                    Err(io::Error::other("process Pid(50) has exited"))
                }
            }
            40 => Ok(to(1, 4)),
            _ => Ok(to(0, 0)),
        };
        let (taken, pause) = pauses();
        let refused = line_of(
            pid(50),
            step,
            shells_but(0, || Ok(None)),
            no_environment(),
            pause,
        );
        assert_eq!(*taken.borrow(), ms(&[]));
        assert_eq!(caller_reads.get(), 2);
        assert_eq!(
            refused.as_ref().map_err(ToString::to_string),
            Err("a process on the caller's line can't be read: \
                 the caller has gone: process Pid(50) has exited"
                .to_owned())
        );
        assert!(matches!(refused, Err(Refused::Unreadable(_))));
    }

    #[test]
    fn refuses_a_line_that_holds_still_through_a_process_that_shows_no_arguments() {
        let step = |p: Pid| match p.as_raw_pid() {
            50 => Ok(to(40, 5)),
            40 => Ok(to(1, 4)),
            _ => Ok(to(0, 0)),
        };
        let refused = line_of(
            pid(50),
            step,
            shells_but(40, || Ok(Some(Vec::new()))),
            no_environment(),
            |_| {},
        );
        assert_eq!(
            refused.map_err(|refused| refused.to_string()),
            Err("a process on the caller's line can't be read: \
                 process Pid(40) shows no arguments"
                .to_owned())
        );
    }
}
