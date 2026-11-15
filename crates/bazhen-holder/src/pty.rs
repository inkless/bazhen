#![expect(
    unsafe_code,
    reason = "Command::pre_exec runs a closure between fork and exec, where libc's sigprocmask \
              and signal reset the mask and the dispositions; only unsafe can register the one \
              or call the others"
)]

//! A terminal's PTY, and the child that runs on it as the leader of a session of its own.

use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::process::CommandExt as _;
use std::process::{Command, Stdio};
use std::ptr;

use bazhen_holder_proto::body::{ProcessSpec, Size};
use rustix::fs::{Mode, OFlags};
use rustix::io::{FdFlags, fcntl_setfd, ioctl_fionbio};
use rustix::process::Pid;
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use rustix::termios::{
    InputModes, OptionalActions, Winsize, tcgetattr, tcgetpgrp, tcsetattr, tcsetwinsize,
};
use thiserror::Error;

use crate::child::{ChildProcess, Reaper};
use crate::signals;

/// The terminal type the holder presents: the one its engine emulates and browsers render.
const TERM: &str = "xterm-256color";

/// A PTY's size in cells, never zero: a zero-sized PTY panics some programs and engines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowSize {
    cols: u16,
    rows: u16,
}

impl WindowSize {
    pub fn clamped(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.max(1),
            rows: rows.max(1),
        }
    }

    pub const fn cols(self) -> u16 {
        self.cols
    }

    pub const fn rows(self) -> u16 {
        self.rows
    }

    fn winsize(self) -> Winsize {
        Winsize {
            ws_row: self.rows,
            ws_col: self.cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }
}

impl From<Size> for WindowSize {
    fn from(size: Size) -> Self {
        let cell = |n: u64| u16::try_from(n).unwrap_or(u16::MAX);
        Self::clamped(cell(size.cols.get()), cell(size.rows.get()))
    }
}

#[derive(Debug, Error)]
pub enum SpawnError {
    #[error("could not hand the PTY to the child: {0}")]
    Slave(#[source] io::Error),
    #[error("could not start the child: {0}")]
    Start(#[source] io::Error),
}

/// The master side of a PTY, which the holder keeps for the terminal's whole life. Closing it hangs
/// the terminal up, and the kernel then sends `SIGHUP` to the session on it.
#[derive(Debug)]
pub struct Pty {
    master: OwnedFd,
}

/// The slave side, until a child takes it as its terminal. The holder keeps no slave of its own,
/// so the master reads EIO (Linux) or end of file (macOS) once every process on it has closed it.
#[derive(Debug)]
pub struct Slave(OwnedFd);

impl Pty {
    /// Opens a PTY pair of `size`. Neither end becomes the caller's controlling terminal, both are
    /// close-on-exec, and the master doesn't block.
    ///
    /// # Errors
    ///
    /// When the system has no PTY to give, or refuses one of the calls that set it up.
    pub fn open(size: WindowSize) -> io::Result<(Self, Slave)> {
        let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY)?;
        fcntl_setfd(&master, FdFlags::CLOEXEC)?;
        grantpt(&master)?;
        unlockpt(&master)?;
        let name = ptsname(&master, Vec::new())?;
        let slave = rustix::fs::open(
            name.as_c_str(),
            OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        let mut termios = tcgetattr(&slave)?;
        termios.input_modes.insert(InputModes::IUTF8);
        tcsetattr(&slave, OptionalActions::Now, &termios)?;
        ioctl_fionbio(&master, true)?;
        let pty = Self { master };
        pty.set_size(size)?;
        Ok((pty, Slave(slave)))
    }

    pub fn master(&self) -> BorrowedFd<'_> {
        self.master.as_fd()
    }

    /// # Errors
    ///
    /// When the system refuses the new size.
    pub fn set_size(&self, size: WindowSize) -> io::Result<()> {
        tcsetwinsize(&self.master, size.winsize())?;
        Ok(())
    }

    /// The terminal's foreground process group, or `None` when it has none, as once its session
    /// leader has exited.
    pub fn foreground_group(&self) -> Option<Pid> {
        tcgetpgrp(&self.master).ok()
    }
}

/// Starts `process` on `slave` as the leader of a new session, whose controlling terminal the PTY
/// is. The child's environment is `process.env` alone, with `TERM` set to the holder's; its
/// signal mask is empty and its dispositions are the defaults, whatever the holder inherited; its
/// umask and resource limits are the holder's. `reaper` must exist before the child does, so no exit goes unseen.
///
/// # Errors
///
/// `Slave` when the slave can't be duplicated for the child's stdio, `Start` when the child
/// doesn't reach `exec`: a missing program or cwd, a NUL in an argument, or a failed setup step.
pub fn spawn(
    slave: Slave,
    process: &ProcessSpec,
    _reaper: &Reaper,
) -> Result<ChildProcess, SpawnError> {
    let (program, args) = process
        .argv
        .as_slice()
        .split_first()
        .ok_or_else(|| SpawnError::Start(io::Error::other("argv is empty")))?;
    let stdin = slave.0.try_clone().map_err(SpawnError::Slave)?;
    let stdout = slave.0.try_clone().map_err(SpawnError::Slave)?;
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(process.env.as_map())
        .env("TERM", TERM)
        .current_dir(process.cwd.as_str())
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(slave.0));
    // SAFETY: the closure runs in the forked child before exec, where only async-signal-safe
    // calls are sound. `become_session_leader` makes only sigemptyset(3), sigprocmask(2),
    // signal(2), setsid(2) and ioctl(TIOCSCTTY), which are, and allocates nothing and takes no
    // lock.
    unsafe {
        command.pre_exec(become_session_leader);
    }
    let child = command.spawn().map_err(SpawnError::Start)?;
    Ok(ChildProcess::new(Pid::from_child(&child)))
}

/// Runs in the child between fork and exec, where std has already put the slave on fds 0–2 and
/// reset `SIGPIPE`. std keeps the holder's signal mask, and exec keeps both the mask and every
/// ignored signal, so both go back to their defaults here, as tmux does for a pane: a blocked or
/// ignored `SIGINT` would leave Ctrl-C doing nothing, and a blocked `SIGHUP` would leave a close
/// waiting out its grace.
fn become_session_leader() -> io::Result<()> {
    let mut none = MaybeUninit::<libc::sigset_t>::uninit();
    // SAFETY: sigemptyset(3) is async-signal-safe and only writes the set it is given, which lives
    // on this stack frame.
    if unsafe { libc::sigemptyset(none.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: sigemptyset succeeded, so it initialised the set.
    let none = unsafe { none.assume_init() };
    // SAFETY: sigprocmask(2) is async-signal-safe; `none` is an initialised set and the old mask
    // isn't asked for. The child is single-threaded until exec, so the process mask is the thread's.
    if unsafe { libc::sigprocmask(libc::SIG_SETMASK, &raw const none, ptr::null_mut()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    for (signal, _) in signals::NAMED {
        if !signals::catchable(signal) {
            continue;
        }
        // SAFETY: signal(2) is async-signal-safe, and `signal` is a valid, catchable signal.
        let previous = unsafe { libc::signal(signal, libc::SIG_DFL) };
        if previous == libc::SIG_ERR {
            return Err(io::Error::last_os_error());
        }
    }
    rustix::process::setsid()?;
    rustix::process::ioctl_tiocsctty(rustix::stdio::stdin())?;
    Ok(())
}
