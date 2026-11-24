//! What the kernel says of another process of this user: its parent, its user, its name, its
//! arguments and its environment. Reading only: nothing here reaches a process.

use std::ffi::OsString;
use std::io;
use std::os::unix::ffi::OsStringExt as _;

use rustix::process::Pid;

pub use bazhen_pid::parent;

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

/// The name the kernel keeps for `pid`, as `ps -o comm` shows it on Linux: the file name of the
/// program it last executed, cut to 15 bytes on Linux and 16 on macOS, unless the process renamed
/// itself since.
///
/// # Errors
///
/// When `pid` has gone, or its name can't be read.
pub fn comm(pid: Pid) -> io::Result<OsString> {
    #[cfg(target_os = "linux")]
    {
        let mut name = std::fs::read(format!("/proc/{}/comm", pid.as_raw_pid()))?;
        if name.last() == Some(&b'\n') {
            name.pop();
        }
        Ok(OsString::from_vec(name))
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::comm(pid)
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

/// Every pid the kernel lists now, this process's among them: `/proc`'s numbered entries on
/// Linux, `KERN_PROC_ALL` on macOS.
///
/// # Errors
///
/// When the list can't be read.
pub fn pids() -> io::Result<Vec<Pid>> {
    #[cfg(target_os = "linux")]
    {
        let mut pids = Vec::new();
        for entry in std::fs::read_dir("/proc")? {
            let name = entry?.file_name();
            if let Some(pid) = name
                .to_str()
                .and_then(|n| n.parse().ok())
                .and_then(Pid::from_raw)
            {
                pids.push(pid);
            }
        }
        Ok(pids)
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::pids()
    }
}

/// A process's uids and its gids, each real, effective, saved and filesystem, in that order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Credentials {
    pub uids: [u32; 4],
    pub gids: [u32; 4],
}

/// `pid`'s uids and gids.
///
/// # Errors
///
/// When `pid` has gone, or its status doesn't name all eight.
#[cfg(target_os = "linux")]
pub fn credentials(pid: Pid) -> io::Result<Credentials> {
    let status = std::fs::read(format!("/proc/{}/status", pid.as_raw_pid()))?;
    status_credentials(&status)
        .ok_or_else(|| io::Error::other(format!("process {pid:?} names no whole credentials")))
}

/// The uids and gids in a `/proc/<pid>/status`: the four numbers on each of its `Uid:` and `Gid:`
/// lines.
pub fn status_credentials(status: &[u8]) -> Option<Credentials> {
    Some(Credentials {
        uids: status_ids(status, b"Uid:")?,
        gids: status_ids(status, b"Gid:")?,
    })
}

/// The effective uid in a `/proc/<pid>/status`: the second number on its `Uid:` line.
pub fn status_uid(status: &[u8]) -> Option<u32> {
    status_ids(status, b"Uid:").map(|[_, effective, _, _]| effective)
}

/// The four numbers on the line of a `/proc/<pid>/status` that starts with `name`.
fn status_ids(status: &[u8], name: &[u8]) -> Option<[u32; 4]> {
    let line = status
        .split(|&b| b == b'\n')
        .find_map(|line| line.strip_prefix(name))?;
    let mut fields = line
        .split(u8::is_ascii_whitespace)
        .filter(|field| !field.is_empty())
        .map(|field| std::str::from_utf8(field).ok()?.parse().ok());
    let ids = [
        fields.next()??,
        fields.next()??,
        fields.next()??,
        fields.next()??,
    ];
    fields.next().is_none().then_some(ids)
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

#[cfg(test)]
mod tests {
    use std::os::unix::ffi::OsStrExt as _;

    use proptest::prelude::*;
    use rustix::process::{geteuid, getpid, getppid};

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

    /// The kernel cuts the name it keeps, so the test binary's own file name begins with it.
    #[test]
    fn reads_this_process_s_name_as_the_file_name_it_was_started_from() {
        let name = comm(getpid()).unwrap();
        let exe = std::env::current_exe().unwrap();
        let file = exe.file_name().unwrap().as_bytes();
        assert!(name.len() >= 15.min(file.len()), "{name:?}");
        assert!(file.starts_with(name.as_bytes()), "{name:?} of {exe:?}");
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
        assert!(comm(absent).is_err());
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
    fn takes_each_uid_and_gid_in_order_from_their_status_lines() {
        let status =
            b"Name:\tfish\nUid:\t1000\t1001\t1002\t1003\nGid:\t141\t142\t143\t144\nGroups:\t4 27\n";
        assert_eq!(
            status_credentials(status),
            Some(Credentials {
                uids: [1000, 1001, 1002, 1003],
                gids: [141, 142, 143, 144],
            }),
        );
    }

    #[test]
    fn names_no_credentials_from_a_status_without_four_of_each() {
        let uid = b"Uid:\t1000\t1000\t1000\t1000\n".as_slice();
        for gid in [
            b"".as_slice(),
            b"Gid:\t141\t141\t141\n",
            b"Gid:\t141\t141\t141\t141\t141\n",
            b"Gid:\t141\t141\tx\t141\n",
            b"NotGid:\t141\t141\t141\t141\n",
        ] {
            let status = [uid, gid].concat();
            assert_eq!(status_credentials(&status), None, "{gid:?}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_this_process_s_real_and_effective_uid_and_gid() {
        use rustix::process::{getegid, getgid, getuid};
        let ours = credentials(getpid()).unwrap();
        assert_eq!(
            ([ours.uids[0], ours.uids[1]], [ours.gids[0], ours.gids[1]]),
            (
                [getuid().as_raw(), geteuid().as_raw()],
                [getgid().as_raw(), getegid().as_raw()],
            ),
        );
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
    fn reads_this_process_s_parent_as_the_kernel_gives_it() {
        assert_eq!(parent(getpid()).unwrap(), getppid());
    }

    #[test]
    fn reads_no_parent_of_a_process_that_isn_t_there() {
        let absent = Pid::from_raw(i32::MAX).unwrap();
        assert!(parent(absent).is_err());
    }
}
