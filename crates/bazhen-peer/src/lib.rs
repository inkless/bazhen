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

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io;
use std::iter;
use std::os::fd::BorrowedFd;
use std::path::Path;

use bazhen_holder::{process, start_time};
use rustix::process::{Pid, geteuid};

/// Past any real process tree's depth: a walk this long is a cycle, and is refused.
pub const MAX_ANCESTORS: usize = 256;

/// The process at the other end of a connection, the session it is in (`None` for one led from
/// outside the daemon's PID namespace, which no terminal the daemon runs can lead), the nearest
/// Codex app-server among it and its ancestors, and every ancestor it has, nearest first, through
/// init or the first process of its PID namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub pid: Pid,
    pub session: Option<Pid>,
    pub codex_server: Option<Pid>,
    pub ancestors: Vec<Pid>,
}

/// One line of decimals: the pid, the session or 0, the Codex app-server or 0, then each ancestor. The
/// app-server comes before the ancestors, so a reader that expects no such field reads one of them
/// as it, which refuses the call rather than passing it as the human's.
impl fmt::Display for Peer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let session = self.session.map_or(0, Pid::as_raw_pid);
        let codex_server = self.codex_server.map_or(0, Pid::as_raw_pid);
        write!(f, "{} {session} {codex_server}", self.pid.as_raw_pid())?;
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
    let ancestors = ancestors(pid, process::parent)?;
    let line: Vec<Pid> = iter::once(pid).chain(ancestors.iter().copied()).collect();
    let peer = Peer {
        pid,
        session: bazhen_pid::session(Some(pid))?,
        codex_server: codex_of(&line, own_args, process::environ)?,
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
    let mut found = Vec::new();
    let mut at = pid;
    while !at.is_init() {
        let Some(next) = parent(at)? else {
            return Ok(found);
        };
        if found.len() == MAX_ANCESTORS {
            return Err(Refused::Endless);
        }
        found.push(next);
        at = next;
    }
    Ok(found)
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

/// The Codex app-server nearest the caller on `line` (`codex_server`), or else the caller itself
/// when the environment it started with, as `environ` reads it, names a Codex thread: a command
/// Codex ran that left the server's tree, as one backgrounded by a shell that has exited.
///
/// # Errors
///
/// `Unreadable` when a process of this user on the line, or the caller's environment, can't be
/// read.
pub fn codex_of(
    line: &[Pid],
    args: impl Fn(Pid) -> io::Result<Option<Vec<OsString>>>,
    environ: impl Fn(Pid) -> io::Result<Vec<OsString>>,
) -> Result<Option<Pid>, Refused> {
    let Some(&caller) = line.first() else {
        return Ok(None);
    };
    // First: a caller that exits after it is read leaves a zombie whose environment is empty and
    // whose arguments are too, which the walk then refuses.
    let marked = environ(caller)?
        .iter()
        .any(|var| var.as_encoded_bytes().starts_with(b"CODEX_THREAD_ID="));
    if let Some(server) = codex_server(line, args)? {
        return Ok(Some(server));
    }
    Ok(marked.then_some(caller))
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
    use std::collections::HashMap;
    use std::os::fd::AsFd as _;
    use std::os::unix::net::UnixStream;
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
    fn prints_one_line_of_the_pid_the_session_no_codex_server_and_each_ancestor() {
        let peer = Peer {
            pid: pid(50),
            session: Some(pid(45)),
            codex_server: None,
            ancestors: vec![pid(40), pid(1)],
        };
        assert_eq!(peer.to_string(), "50 45 0 40 1");
    }

    #[test]
    fn prints_0_for_a_session_led_from_outside_the_namespace() {
        let peer = Peer {
            pid: pid(50),
            session: None,
            codex_server: Some(pid(40)),
            ancestors: vec![pid(40), pid(1)],
        };
        assert_eq!(peer.to_string(), "50 0 40 40 1");
    }

    #[test]
    fn prints_the_codex_server_before_the_ancestors() {
        let peer = Peer {
            pid: pid(50),
            session: Some(pid(50)),
            codex_server: Some(pid(40)),
            ancestors: vec![pid(40), pid(1)],
        };
        assert_eq!(peer.to_string(), "50 50 40 40 1");
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
        let env = |vars: &'static [&'static str]| move |_: Pid| Ok(os(vars));
        assert_eq!(
            codex_of(&line, table(), env(&["HOME=/h", "CODEX_THREAD_ID=thr-1"])).unwrap(),
            Some(pid(50)),
        );
        assert_eq!(
            codex_of(&line, table(), env(&["HOME=/h", "CODEX_HOME=/c"])).unwrap(),
            None
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
            Ok(if exited.get() {
                Vec::new()
            } else {
                os(&["CODEX_THREAD_ID=thr-1"])
            })
        };
        assert_eq!(
            codex_of(&[pid(50), pid(1)], args, environ).unwrap(),
            Some(pid(50))
        );
    }

    #[test]
    fn names_the_server_over_the_caller_s_own_environment() {
        let line = [pid(50), pid(40), pid(1)];
        let table = argv(&[(50, Some(&["bazhen"])), (40, Some(SERVER)), (1, None)]);
        let marked = |_: Pid| Ok(os(&["CODEX_THREAD_ID=thr-1"]));
        assert_eq!(codex_of(&line, table, marked).unwrap(), Some(pid(40)));
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
}
