#![expect(
    unsafe_code,
    reason = "libc's sysctl is the one call that says when a macOS process started, a zombie \
              included, and rustix doesn't cover it; only unsafe can call it"
)]

//! What only macOS's own calls can tell the holder.

use std::io;
use std::ptr;

use rustix::process::Pid;

use crate::start_time::StartTimeError;

/// `sizeof(struct kinfo_proc)` on LP64 macOS, `arm64` and `x86_64` alike: `struct extern_proc`
/// and `struct eproc` (XNU `bsd/sys/proc.h`, `bsd/sys/sysctl.h`). libc doesn't define the struct,
/// so the kernel's answer is read as bytes, and a size other than this one is refused rather than
/// read as the wrong layout.
const KINFO_PROC_SIZE: usize = 648;

/// `kp_proc.p_un.__p_starttime.tv_sec`, what `ps` prints for `lstart`. `extern_proc` begins with
/// the `p_un` union, whose `timeval` begins with `tv_sec`, a 64-bit `time_t`: the struct's first
/// 8 bytes. A zombie still answers `KERN_PROC_PID`, where `proc_pidinfo` answers `ESRCH`.
pub(crate) fn start_seconds(pid: Pid) -> Result<u64, StartTimeError> {
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
    let seconds = info
        .first_chunk::<8>()
        .map(|bytes| i64::from_ne_bytes(*bytes))
        .ok_or_else(|| unreadable(io::Error::other("no start time")))?;
    u64::try_from(seconds).map_err(|e| unreadable(io::Error::other(e)))
}
