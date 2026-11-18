//! What the kernel says of another process of this user: its parent, its session, its user and
//! arguments, and who is at the other end of a Unix socket. Reading only: nothing here reaches a
//! process.

use std::ffi::OsString;
use std::io;
use std::os::fd::BorrowedFd;
use std::os::unix::ffi::OsStringExt as _;

use rustix::process::{Pid, RawPid};

/// `pid`'s parent: `None` for a process that has none, init or a PID namespace's first process.
///
/// # Errors
///
/// When `pid` has gone or exited, a zombie included, or its record can't be read: which parent it
/// had is then unknown, or no longer its.
pub fn parent(pid: Pid) -> io::Result<Option<Pid>> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read(format!("/proc/{}/stat", pid.as_raw_pid()))?;
        if crate::start_time::has_exited(&stat) {
            return Err(io::Error::other(format!("process {pid:?} has exited")));
        }
        let raw = crate::start_time::parent_field(&stat)
            .ok_or_else(|| io::Error::other(format!("process {pid:?} names no parent")))?;
        Ok(Pid::from_raw(raw))
    }
    #[cfg(target_os = "macos")]
    {
        if pid.is_init() {
            return Ok(None);
        }
        crate::macos::parent(pid)
            .map(Some)
            .ok_or_else(|| io::Error::other(format!("process {pid:?} can't be read")))
    }
}

/// `raw`, as the kernel answered it for `what`, when it is a pid this process can name. A kernel
/// answers 0 for a process, session or group with no pid in this process's PID namespace, as one
/// outside a container this runs in has.
///
/// # Errors
///
/// When `raw` isn't above 0.
pub fn visible(raw: RawPid, what: &str) -> io::Result<Pid> {
    // Tested before `Pid::from_raw`, which asserts `raw >= 0` in a debug build rather than refusing.
    (raw > 0)
        .then_some(raw)
        .and_then(Pid::from_raw)
        .ok_or_else(|| {
            io::Error::other(format!(
                "{what} has no pid in this process's PID namespace: the kernel answered {raw}"
            ))
        })
}

/// A session's or process group's leader, as the kernel answered it for `what`: `None` for the 0
/// it answers when the leader has no pid in this process's PID namespace.
///
/// # Errors
///
/// When `raw` is below 0.
pub fn leader(raw: RawPid, what: &str) -> io::Result<Option<Pid>> {
    if raw == 0 {
        Ok(None)
    } else {
        visible(raw, what).map(Some)
    }
}

/// The session `pid` is in, by its leader: `None` for a session led from outside this process's PID
/// namespace, as one a container this runs in was started in may be.
///
/// # Errors
///
/// When `pid` has gone, or the kernel won't say.
pub fn session(pid: Pid) -> io::Result<Option<Pid>> {
    #[cfg(target_os = "linux")]
    {
        leader(crate::linux::session(pid)?, "a session's leader")
    }
    #[cfg(target_os = "macos")]
    {
        Ok(Some(rustix::process::getsid(Some(pid))?))
    }
}

/// The effective uid `pid` runs as.
///
/// # Errors
///
/// When `pid` has gone, or its record can't be read.
pub fn uid(pid: Pid) -> io::Result<u32> {
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read(format!("/proc/{}/status", pid.as_raw_pid()))?;
        status_uid(&status)
            .ok_or_else(|| io::Error::other(format!("process {pid:?} names no effective uid")))
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::uid(pid)
    }
}

/// The arguments `pid` runs with, `argv[0]` first, as its memory holds them now.
///
/// # Errors
///
/// When `pid` has gone, or its arguments can't be read: another user's, on macOS.
pub fn args(pid: Pid) -> io::Result<Vec<OsString>> {
    #[cfg(target_os = "linux")]
    {
        Ok(cmdline_args(&std::fs::read(format!(
            "/proc/{}/cmdline",
            pid.as_raw_pid()
        ))?))
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::args(pid)
    }
}

/// The environment `pid` was started with, each `NAME=value` as it was passed.
///
/// # Errors
///
/// When `pid` has gone, or its environment can't be read: another user's.
pub fn environ(pid: Pid) -> io::Result<Vec<OsString>> {
    #[cfg(target_os = "linux")]
    {
        Ok(cmdline_args(&std::fs::read(format!(
            "/proc/{}/environ",
            pid.as_raw_pid()
        ))?))
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::environ(pid)
    }
}

/// The effective uid in a `/proc/<pid>/status`: the second number on its `Uid:` line.
pub fn status_uid(status: &[u8]) -> Option<u32> {
    let line = status
        .split(|&b| b == b'\n')
        .find_map(|line| line.strip_prefix(b"Uid:"))?;
    let effective = line
        .split(u8::is_ascii_whitespace)
        .filter(|field| !field.is_empty())
        .nth(1)?;
    std::str::from_utf8(effective).ok()?.parse().ok()
}

/// The arguments in a `/proc/<pid>/cmdline`, or the variables in a `/proc/<pid>/environ`: each
/// ends in a NUL, the last one maybe not.
pub fn cmdline_args(cmdline: &[u8]) -> Vec<OsString> {
    if cmdline.is_empty() {
        return Vec::new();
    }
    cmdline
        .strip_suffix(b"\0")
        .unwrap_or(cmdline)
        .split(|&b| b == 0)
        .map(|arg| OsString::from_vec(arg.to_vec()))
        .collect()
}

/// The arguments in macOS's `KERN_PROCARGS2` answer: `argc` as a native `int`, the executable's
/// path and the NULs that pad it, then `argc` arguments, each ending in a NUL, then the
/// environment. `None` when it holds fewer arguments than it says. An empty first argument can't
/// be told from the padding, as `ps` can't tell it either, and is skipped with it.
pub fn procargs2_args(procargs: &[u8]) -> Option<Vec<OsString>> {
    let (args, _) = procargs2_split(procargs)?;
    Some(
        args.into_iter()
            .map(|arg| OsString::from_vec(arg.to_vec()))
            .collect(),
    )
}

/// A `KERN_PROCARGS2` answer's arguments, and what follows them.
fn procargs2_split(procargs: &[u8]) -> Option<(Vec<&[u8]>, &[u8])> {
    let (count, rest) = procargs.split_first_chunk::<4>()?;
    let count = usize::try_from(i32::from_ne_bytes(*count)).ok()?;
    let path_end = rest.iter().position(|&b| b == 0)?;
    let (_, padded) = rest.split_at_checked(path_end)?;
    let first = padded.iter().position(|&b| b != 0).unwrap_or(padded.len());
    let (_, mut rest) = padded.split_at_checked(first)?;
    let mut args = Vec::with_capacity(count.min(rest.len()));
    for _ in 0..count {
        let end = rest.iter().position(|&b| b == 0)?;
        let (arg, after) = rest.split_at_checked(end)?;
        args.push(arg);
        rest = after.get(1..)?;
    }
    Some((args, rest))
}

/// The environment in macOS's `KERN_PROCARGS2` answer: each string after the arguments that
/// ends in a NUL, the empty ones left out. `None` when it holds fewer arguments than it says.
pub fn procargs2_env(procargs: &[u8]) -> Option<Vec<OsString>> {
    let (_, rest) = procargs2_split(procargs)?;
    let mut strings: Vec<&[u8]> = rest.split(|&b| b == 0).collect();
    strings.pop();
    Some(
        strings
            .into_iter()
            .filter(|var| !var.is_empty())
            .map(|var| OsString::from_vec(var.to_vec()))
            .collect(),
    )
}

/// The effective uid of the process at the other end of a Unix socket, as it was when it
/// connected.
///
/// # Errors
///
/// When the socket isn't a connected Unix socket.
pub fn peer_uid(socket: BorrowedFd<'_>) -> io::Result<u32> {
    #[cfg(target_os = "linux")]
    {
        Ok(crate::linux::peer_credentials(socket)?.uid)
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::peer_uid(socket)
    }
}

/// The process at the other end of a Unix socket: on Linux the one that connected
/// (`SO_PEERCRED`), on macOS its last user (`LOCAL_PEERPID`). Either may since have exited, or its
/// pid gone to another process, so a caller checks its start time.
///
/// # Errors
///
/// When the socket isn't a connected Unix socket, or names no process this process can see: one
/// outside its PID namespace, as a host process connecting to a socket in a container is.
pub fn peer_pid(socket: BorrowedFd<'_>) -> io::Result<Pid> {
    #[cfg(target_os = "linux")]
    let raw = crate::linux::peer_credentials(socket)?.pid;
    #[cfg(target_os = "macos")]
    let raw = crate::macos::peer_pid(socket)?;
    visible(raw, "the socket's peer")
}

#[cfg(test)]
mod tests {
    use std::os::fd::AsFd as _;
    use std::os::unix::net::UnixStream;

    use proptest::prelude::*;
    use rustix::process::{geteuid, getpid, getppid, getsid, getuid};

    use super::*;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    /// A `KERN_PROCARGS2` answer: `argc`, the path, `pad` NULs, the arguments, the environment.
    fn procargs(count: i32, path: &[u8], pad: usize, args: &[&[u8]], env: &[&[u8]]) -> Vec<u8> {
        let mut out = count.to_ne_bytes().to_vec();
        out.extend_from_slice(path);
        out.extend(std::iter::repeat_n(0, pad + 1));
        for arg in args.iter().chain(env) {
            out.extend_from_slice(arg);
            out.push(0);
        }
        out
    }

    #[test]
    fn reads_this_process_s_effective_uid_and_its_own_arguments() {
        assert_eq!(uid(getpid()).unwrap(), geteuid().as_raw());
        let ours: Vec<OsString> = std::env::args_os().collect();
        assert_eq!(args(getpid()).unwrap(), ours);
    }

    #[test]
    fn reads_the_environment_this_process_started_with() {
        let path = std::env::var_os("PATH").unwrap();
        let mut entry = OsString::from("PATH=");
        entry.push(path);
        assert!(environ(getpid()).unwrap().contains(&entry));
    }

    #[test]
    fn reads_the_environment_of_a_procargs2_answer_after_its_arguments() {
        let answer = procargs(
            2,
            b"/r/bin/bazhen",
            3,
            &[b"bazhen", b"devices"],
            &[
                b"HOME=/h",
                b"CODEX_THREAD_ID=thr-1",
                b"",
                b"executable_path=/r/bin/bazhen",
            ],
        );
        assert_eq!(
            procargs2_env(&answer),
            Some(os(&[
                "HOME=/h",
                "CODEX_THREAD_ID=thr-1",
                "executable_path=/r/bin/bazhen"
            ])),
        );
        let unended = [answer.as_slice(), b"PART"].concat();
        assert_eq!(procargs2_env(&unended), procargs2_env(&answer));
        let short = procargs(3, b"/r/bin/bazhen", 1, &[b"bazhen"], &[b"HOME=/h"]);
        assert_eq!(procargs2_env(&short), None);
    }

    #[test]
    fn reads_no_uid_or_arguments_of_a_process_that_isn_t_there() {
        let absent = Pid::from_raw(i32::MAX).unwrap();
        assert!(uid(absent).is_err());
        assert!(args(absent).is_err());
        assert!(environ(absent).is_err());
    }

    #[test]
    fn takes_the_effective_uid_from_the_status_uid_line() {
        let status =
            b"Name:\tcodex\nUmask:\t0022\nUid:\t1000\t1001\t1002\t1003\nGid:\t5\t5\t5\t5\n";
        assert_eq!(status_uid(status), Some(1001));
    }

    #[test]
    fn names_no_uid_from_a_status_without_a_whole_uid_line() {
        for status in [
            b"".as_slice(),
            b"Name:\tcodex\n",
            b"Uid:\t1000\n",
            b"Uid:\t1000\tx\t1\t1\n",
            b"Gid:\t1000\t1001\n",
            b"NotUid:\t1000\t1001\n",
        ] {
            assert_eq!(status_uid(status), None, "{status:?}");
        }
    }

    #[test]
    fn splits_a_cmdline_at_each_nul() {
        assert_eq!(
            cmdline_args(b"/r/bin/codex\0app-server\0--listen\0unix://\0"),
            os(&["/r/bin/codex", "app-server", "--listen", "unix://"]),
        );
        assert_eq!(cmdline_args(b"codex\0"), os(&["codex"]));
        assert_eq!(cmdline_args(b"retitled"), os(&["retitled"]));
        assert_eq!(cmdline_args(b""), os(&[]));
        assert_eq!(cmdline_args(b"a\0\0b\0"), os(&["a", "", "b"]));
    }

    #[test]
    fn reads_the_arguments_of_a_procargs2_answer_past_the_path_and_its_padding() {
        let answer = procargs(
            3,
            b"/r/bin/codex",
            5,
            &[b"codex", b"app-server", b"--managed-daemon"],
            &[b"HOME=/h"],
        );
        assert_eq!(
            procargs2_args(&answer),
            Some(os(&["codex", "app-server", "--managed-daemon"])),
        );
        assert_eq!(
            procargs2_args(&procargs(1, b"/bin/sh", 0, &[b"sh"], &[])),
            Some(os(&["sh"]))
        );
        assert_eq!(
            procargs2_args(&procargs(0, b"/bin/sh", 2, &[], &[])),
            Some(os(&[]))
        );
    }

    #[test]
    fn refuses_a_procargs2_answer_that_holds_fewer_arguments_than_it_says() {
        let short = procargs(3, b"/r/bin/codex", 1, &[b"codex", b"app-server"], &[]);
        assert_eq!(procargs2_args(&short), None);
        assert_eq!(procargs2_args(&procargs(-1, b"/bin/sh", 0, &[], &[])), None);
        assert_eq!(procargs2_args(b"\x01\x00"), None);
        let unended = [1i32.to_ne_bytes().as_slice(), b"/bin/sh\0sh"].concat();
        assert_eq!(procargs2_args(&unended), None);
    }

    proptest! {
        #[test]
        fn reads_back_any_arguments_written_as_a_cmdline(
            args in proptest::collection::vec(proptest::collection::vec(1u8..=255, 0..16), 1..8),
        ) {
            let cmdline: Vec<u8> = args.iter().flat_map(|a| a.iter().copied().chain([0])).collect();
            let expected: Vec<OsString> = args.into_iter().map(OsString::from_vec).collect();
            prop_assert_eq!(cmdline_args(&cmdline), expected);
        }

        #[test]
        fn reads_back_any_arguments_written_as_procargs2(
            path in proptest::collection::vec(1u8..=255, 1..32),
            pad in 0usize..8,
            args in proptest::collection::vec(proptest::collection::vec(1u8..=255, 1..16), 0..8),
            env in proptest::collection::vec(proptest::collection::vec(1u8..=255, 1..16), 0..4),
        ) {
            let count = i32::try_from(args.len()).unwrap();
            let refs: Vec<&[u8]> = args.iter().map(Vec::as_slice).collect();
            let env: Vec<&[u8]> = env.iter().map(Vec::as_slice).collect();
            let answer = procargs(count, &path, pad, &refs, &env);
            let expected: Vec<OsString> = args.iter().cloned().map(OsString::from_vec).collect();
            let expected_env: Vec<OsString> = env.iter().map(|e| OsString::from_vec(e.to_vec())).collect();
            prop_assert_eq!(procargs2_args(&answer), Some(expected.clone()));
            prop_assert_eq!(procargs2_env(&answer), Some(expected_env));
            for cut in 0..answer.len() {
                let read = procargs2_args(answer.get(..cut).unwrap());
                prop_assert!(read.is_none() || read == Some(expected.clone()), "{read:?} at {cut}");
            }
        }
    }

    #[test]
    fn names_a_pid_above_0_and_refuses_the_0_a_kernel_gives_for_one_outside_this_namespace() {
        assert_eq!(visible(1, "init").unwrap(), Pid::from_raw(1).unwrap());
        assert_eq!(
            visible(i32::MAX, "a pid").unwrap(),
            Pid::from_raw(i32::MAX).unwrap()
        );
        for raw in [0, -1, i32::MIN] {
            let refused = visible(raw, "the socket's peer").unwrap_err();
            assert!(
                refused.to_string().starts_with("the socket's peer "),
                "{raw}: {refused}"
            );
        }
    }

    #[test]
    fn reads_the_0_a_kernel_gives_for_a_leader_outside_this_namespace_as_none() {
        assert_eq!(leader(0, "a leader").unwrap(), None);
        assert_eq!(leader(7, "a leader").unwrap(), Pid::from_raw(7));
        let refused = leader(-1, "a session's leader").unwrap_err();
        assert!(
            refused.to_string().starts_with("a session's leader "),
            "{refused}"
        );
    }

    #[test]
    fn names_this_process_as_the_peer_of_its_own_socket_pair() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        assert_eq!(peer_pid(ours.as_fd()).unwrap(), getpid());
        assert_eq!(peer_uid(ours.as_fd()).unwrap(), getuid().as_raw());
    }

    #[test]
    fn reads_this_process_s_parent_and_session_as_the_kernel_gives_them() {
        assert_eq!(parent(getpid()).unwrap(), getppid());
        assert_eq!(session(getpid()).unwrap(), Some(getsid(None).unwrap()));
    }

    #[test]
    fn reads_no_parent_or_session_of_a_process_that_isn_t_there() {
        let absent = Pid::from_raw(i32::MAX).unwrap();
        assert!(parent(absent).is_err());
        assert!(session(absent).is_err());
    }
}
