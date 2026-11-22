#![expect(
    unsafe_code,
    reason = "libc's sysctl is the one call that says when a macOS process started, a zombie \
              included, that lists every process, and that names a process's arguments \
              (KERN_PROCARGS2), and its environment, sized by KERN_ARGMAX; rustix doesn't cover \
              it, and only unsafe can call it; and rustix's kevent, which watches a process for \
              its exit, is unsafe; and proc_pidinfo, the one call that names another process's \
              parent and user"
)]

//! What only macOS's own calls can tell the holder.

use std::ffi::OsString;
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStringExt as _;
use std::ptr;
use std::time::Duration;

use rustix::event::kqueue::{Event, EventFilter, EventFlags, ProcessEvents, kevent, kqueue};
use rustix::io::Errno;
use rustix::process::{Pid, Signal};

use crate::process::{procargs2_args, procargs2_env};
use crate::session::Member;
use crate::start_time::StartTimeError;

/// `sizeof(struct kinfo_proc)` on LP64 macOS, `arm64` and `x86_64` alike: `struct extern_proc`
/// and `struct eproc` (XNU `bsd/sys/proc.h`, `bsd/sys/sysctl.h`). libc doesn't define the struct,
/// so the kernel's answer is read as bytes, and a size other than this one is refused rather than
/// read as the wrong layout.
const KINFO_PROC_SIZE: usize = 648;
/// `kp_proc.p_stat`, after `p_un` (16 bytes), `p_vmspace` and `p_sigacts` (8 each) and `p_flag`
/// (4), and `kp_proc.p_pid`, the next 4-byte-aligned field after it.
const P_STAT_AT: usize = 36;
const P_PID_AT: usize = 40;
/// How many times `pids` asks again when processes were started between its two `sysctl` calls.
const LIST_TRIES: usize = 4;

/// `kp_proc.p_un.__p_starttime.tv_sec`, what `ps` prints for `lstart`. `extern_proc` begins with
/// the `p_un` union, whose `timeval` begins with `tv_sec`, a 64-bit `time_t`: the struct's first
/// 8 bytes. A zombie still answers `KERN_PROC_PID`, where `proc_pidinfo` answers `ESRCH`.
pub(crate) fn start_seconds(pid: Pid) -> Result<u64, StartTimeError> {
    let raw = pid.as_raw_nonzero().get();
    let unreadable = |source: io::Error| StartTimeError::Unreadable { pid: raw, source };
    let info = kinfo(pid)?;
    let seconds = info
        .first_chunk::<8>()
        .map(|bytes| i64::from_ne_bytes(*bytes))
        .ok_or_else(|| unreadable(io::Error::other("no start time")))?;
    u64::try_from(seconds).map_err(|e| unreadable(io::Error::other(e)))
}

/// `pid`'s `kinfo_proc`, as bytes.
fn kinfo(pid: Pid) -> Result<[u8; KINFO_PROC_SIZE], StartTimeError> {
    let raw = pid.as_raw_nonzero().get();
    let unreadable = |source: io::Error| StartTimeError::Unreadable { pid: raw, source };
    let mut name = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, raw];
    let mut info = [0u8; KINFO_PROC_SIZE];
    let mut len: libc::size_t = KINFO_PROC_SIZE;
    let name_len = libc::c_uint::try_from(name.len()).map_err(io::Error::other);
    let name_len = name_len.map_err(unreadable)?;
    // SAFETY: `name` holds `name_len` ints; `info` is writable for `len` bytes, which the kernel
    // writes no more than and updates to what it wrote; no new value is set (null, 0).
    let status = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            name_len,
            info.as_mut_ptr().cast(),
            &raw mut len,
            ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return Err(unreadable(io::Error::last_os_error()));
    }
    // A pid with no process is a success that writes nothing.
    if len == 0 {
        return Err(StartTimeError::Absent(raw));
    }
    if len != KINFO_PROC_SIZE {
        return Err(unreadable(io::Error::other(format!(
            "a kinfo_proc of {len} bytes, not {KINFO_PROC_SIZE}"
        ))));
    }
    Ok(info)
}

/// Every process's pid, from `KERN_PROC_ALL`'s `kinfo_proc`s.
pub(crate) fn pids() -> io::Result<Vec<Pid>> {
    let mut name = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_ALL];
    let name_len = libc::c_uint::try_from(name.len()).map_err(io::Error::other)?;
    for _ in 0..LIST_TRIES {
        let mut len: libc::size_t = 0;
        // SAFETY: `name` holds `name_len` ints; with no buffer (null) the kernel only writes the
        // size it needs to `len`; no new value is set (null, 0).
        let sized = unsafe {
            libc::sysctl(
                name.as_mut_ptr(),
                name_len,
                ptr::null_mut(),
                &raw mut len,
                ptr::null_mut(),
                0,
            )
        };
        if sized != 0 {
            return Err(io::Error::last_os_error());
        }
        // Room for processes started before the second call.
        len += len / 8 + KINFO_PROC_SIZE;
        let mut buffer = vec![0u8; len];
        // SAFETY: `name` holds `name_len` ints; `buffer` is writable for `len` bytes, which the
        // kernel writes no more than and updates to what it wrote; no new value is set (null, 0).
        let listed = unsafe {
            libc::sysctl(
                name.as_mut_ptr(),
                name_len,
                buffer.as_mut_ptr().cast(),
                &raw mut len,
                ptr::null_mut(),
                0,
            )
        };
        if listed != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOMEM) {
                continue;
            }
            return Err(error);
        }
        buffer.truncate(len);
        if !buffer.len().is_multiple_of(KINFO_PROC_SIZE) {
            return Err(io::Error::other(format!(
                "a kinfo_proc list of {len} bytes, not a whole number of {KINFO_PROC_SIZE}"
            )));
        }
        let (infos, _) = buffer.as_chunks::<KINFO_PROC_SIZE>();
        return Ok(infos
            .iter()
            .filter_map(|info| info.get(P_PID_AT..)?.first_chunk::<4>().copied())
            .filter_map(|bytes| Pid::from_raw(i32::from_ne_bytes(bytes)))
            .collect());
    }
    Err(io::Error::other(
        "processes kept starting while they were listed",
    ))
}

/// What `pid` is to `session`: a live member, or outside it, a zombie or gone. The guard checks
/// a member again, under a watch for its exit, before it signals it (`guard::signal_member`).
pub(crate) fn visit(pid: Pid, session: Pid, signal: Option<Signal>) -> Member {
    // A session that can't be read, the process gone or another user's to ask about, is outside:
    // a member that exited is no longer one, and the guard refuses what it can't prove.
    if bazhen_pid::session(Some(pid)).ok().flatten() != Some(session) {
        return Member::Outside;
    }
    match kinfo(pid) {
        Ok(info) if info.get(P_STAT_AT).copied() == u8::try_from(libc::SZOMB).ok() => {
            return Member::Outside;
        }
        Ok(_) => {}
        Err(StartTimeError::Absent(_)) => return Member::Outside,
        Err(StartTimeError::Unreadable { .. }) => return Member::Failed,
    }
    match signal {
        None => Member::Reached,
        Some(signal) => Member::of_send(pid, crate::guard::signal_member(pid, session, signal)),
    }
}

/// A kqueue watching one process for its exit, from when it is made.
#[derive(Debug)]
pub(crate) struct ExitWatch(OwnedFd);

impl ExitWatch {
    /// # Errors
    ///
    /// `ESRCH` when `pid` has no process, or a zombie's; any other refusal.
    pub(crate) fn new(pid: Pid) -> Result<Self, Errno> {
        let queue = kqueue()?;
        let watch = Event::new(
            EventFilter::Proc {
                pid,
                flags: ProcessEvents::EXIT,
            },
            EventFlags::ADD,
            ptr::null_mut(),
        );
        let mut none: [MaybeUninit<Event>; 0] = [];
        // SAFETY: kevent requires every fd an event names to outlive the kqueue; a process event
        // names none.
        unsafe { kevent(&queue, &[watch], &mut none, Some(Duration::ZERO)) }?;
        Ok(Self(queue))
    }

    /// Whether the process has exited since the watch was made.
    ///
    /// # Errors
    ///
    /// When the kqueue can't be read.
    pub(crate) fn exited(&self) -> Result<bool, Errno> {
        let mut seen: [MaybeUninit<Event>; 1] = [MaybeUninit::uninit()];
        // SAFETY: as in `new`; this call only reads what the watch has seen.
        let (events, _) = unsafe { kevent(&self.0, &[], &mut seen, Some(Duration::ZERO)) }?;
        Ok(!events.is_empty())
    }
}

/// `pid`'s parent, from `proc_pidinfo`'s `proc_bsdshortinfo`, which, unlike `proc_bsdinfo`, it
/// gives for another user's process too.
pub(crate) fn parent(pid: Pid) -> Option<Pid> {
    Pid::from_raw(i32::try_from(short_info(pid).ok()?.pbsi_ppid).ok()?)
}

/// The name `pid` runs as, from its `proc_bsdshortinfo`: the file name of the program it last
/// executed, cut to 16 bytes.
pub(crate) fn comm(pid: Pid) -> io::Result<OsString> {
    let info = short_info(pid)?;
    let name: Vec<u8> = info
        .pbsi_comm
        .iter()
        .map(|c| {
            let [byte] = c.to_ne_bytes();
            byte
        })
        .take_while(|&byte| byte != 0)
        .collect();
    Ok(OsString::from_vec(name))
}

/// The effective uid `pid` runs as, from its `proc_bsdshortinfo`.
pub(crate) fn uid(pid: Pid) -> io::Result<u32> {
    short_info(pid).map(|info| info.pbsi_uid)
}

/// `pid`'s `proc_bsdshortinfo`, which `proc_pidinfo` gives for another user's process too. The
/// error is the call's own, `ESRCH` for a pid with no process or a zombie's, so a caller can tell
/// a process gone from one it couldn't read.
fn short_info(pid: Pid) -> io::Result<libc::proc_bsdshortinfo> {
    let mut info = MaybeUninit::<libc::proc_bsdshortinfo>::uninit();
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdshortinfo>())
        .map_err(io::Error::other)?;
    // SAFETY: `info` is writable for `size` bytes, which the call writes no more than, and it
    // returns how many it wrote.
    let written = unsafe {
        libc::proc_pidinfo(
            pid.as_raw_pid(),
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written <= 0 {
        return Err(io::Error::last_os_error());
    }
    if written != size {
        return Err(io::Error::other(format!(
            "process {pid:?}'s record came short: {written} of {size} bytes"
        )));
    }
    // SAFETY: the call wrote the whole struct, which is plain integers and bytes.
    Ok(unsafe { info.assume_init() })
}

/// The arguments `pid` runs with, from `sysctl(KERN_PROCARGS2)`, which `ps` reads too. The kernel
/// answers it only for a process of this user.
pub(crate) fn args(pid: Pid) -> io::Result<Vec<OsString>> {
    procargs2_args(&procargs2(pid)?)
        .ok_or_else(|| io::Error::other(format!("process {pid:?}'s arguments can't be read")))
}

/// The environment `pid` started with, from the same answer.
pub(crate) fn environ(pid: Pid) -> io::Result<Vec<OsString>> {
    procargs2_env(&procargs2(pid)?)
        .ok_or_else(|| io::Error::other(format!("process {pid:?}'s environment can't be read")))
}

/// `pid`'s `KERN_PROCARGS2` answer, in a buffer of `KERN_ARGMAX` bytes, as `ps` reads it.
fn procargs2(pid: Pid) -> io::Result<Vec<u8>> {
    let mut max_name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let max_name_len = libc::c_uint::try_from(max_name.len()).map_err(io::Error::other)?;
    let mut max: libc::c_int = 0;
    let mut max_len: libc::size_t = std::mem::size_of::<libc::c_int>();
    // SAFETY: `max_name` holds `max_name_len` ints; `max` is writable for `max_len` bytes, which
    // the kernel writes no more than; no new value is set (null, 0).
    let sized = unsafe {
        libc::sysctl(
            max_name.as_mut_ptr(),
            max_name_len,
            (&raw mut max).cast(),
            &raw mut max_len,
            ptr::null_mut(),
            0,
        )
    };
    if sized != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut len = usize::try_from(max).map_err(io::Error::other)?;
    let mut buffer = vec![0u8; len];
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid.as_raw_pid()];
    let name_len = libc::c_uint::try_from(name.len()).map_err(io::Error::other)?;
    // SAFETY: `name` holds `name_len` ints; `buffer` is writable for `len` bytes, which the kernel
    // writes no more than and updates to what it wrote; no new value is set (null, 0).
    let read = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            name_len,
            buffer.as_mut_ptr().cast(),
            &raw mut len,
            ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(len);
    Ok(buffer)
}
