#![expect(
    unsafe_code,
    reason = "Command::pre_exec runs a closure between fork and exec, where libc's sigprocmask \
              and signal reset the mask and the dispositions; libc's sigprocmask unblocks the \
              holder's own wake-up signals; and libc::close closes an fd no Rust value owns; only \
              unsafe can register the one or call the others"
)]

//! A terminal's PTY, and the child that runs on it as the leader of a session of its own.

use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::os::unix::process::CommandExt as _;
use std::process::{Command, Stdio};
use std::ptr;

use bazhen_holder_proto::body::{Cols, ProcessSpec, Rows, Size};
use rustix::io::{FdFlags, fcntl_setfd, ioctl_fionbio};
use rustix::process::Pid;
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use rustix::termios::{
    InputModes, OptionalActions, Winsize, tcgetattr, tcgetpgrp, tcsetattr, tcsetwinsize,
};
use thiserror::Error;

use crate::child::{ChildProcess, Reaper};
use crate::ptmx::open_master;
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

    /// The size as the protocol carries it; `None` past what it can.
    pub fn size(self) -> Option<Size> {
        Some(Size {
            cols: Cols::new(u64::from(self.cols)).ok()?,
            rows: Rows::new(u64::from(self.rows)).ok()?,
        })
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
/// the terminal up, and the kernel then sends `SIGHUP` to the session's leader, and to no other
/// process of the session: ending those is `session::Ending`'s.
#[derive(Debug)]
pub struct Pty {
    /// Declared, and so dropped, before `_slave`: the master's close disconnects the terminal, so
    /// the held slave's close, then the last, doesn't wait for output no one will read.
    master: OwnedFd,
    /// The slave, held open for the PTY's life. When a child's exit closes the slave's last open,
    /// macOS discards the output the master hasn't read, after waiting for it at most about
    /// 600 ms; while this one is open, a session leader's exit waits until the master has read it.
    /// Linux keeps unread output, and holding the slave there would keep the master from reading
    /// EIO.
    #[cfg(target_os = "macos")]
    _slave: OwnedFd,
}

/// The slave side, until a child takes it as its terminal. On Linux the holder keeps no slave of
/// its own, so the master reads EIO once every process on it has closed it. On macOS the master
/// reads end of file once the session leader's exit has revoked the terminal.
#[derive(Debug)]
pub struct Slave(OwnedFd);

impl AsFd for Slave {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }
}

impl Pty {
    /// Opens a PTY pair of `size`. Neither end becomes the caller's controlling terminal, both are
    /// close-on-exec, and the master doesn't block.
    ///
    /// # Errors
    ///
    /// When the system has no PTY to give, or refuses one of the calls that set it up.
    pub fn open(size: WindowSize) -> io::Result<(Self, Slave)> {
        let master = open_master(|| openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY))
            .map_err(|e| failed("opening the master", e))?;
        fcntl_setfd(&master, FdFlags::CLOEXEC)
            .map_err(|e| failed("making the master close-on-exec", e))?;
        grantpt(&master).map_err(|e| failed("granting the slave", e))?;
        unlockpt(&master).map_err(|e| failed("unlocking the slave", e))?;
        let name = ptsname(&master, Vec::new()).map_err(|e| failed("naming the slave", e))?;
        let slave = open_terminal(&name)
            .map_err(|e| failed(&format!("opening the slave {}", name.to_string_lossy()), e))?;
        let slave = OwnedFd::from(slave);
        let mut termios = tcgetattr(&slave).map_err(|e| failed("reading the slave's modes", e))?;
        termios.input_modes.insert(InputModes::IUTF8);
        tcsetattr(&slave, OptionalActions::Now, &termios)
            .map_err(|e| failed("setting the slave's modes", e))?;
        ioctl_fionbio(&master, true).map_err(|e| failed("making the master non-blocking", e))?;
        let pty = Self {
            master,
            #[cfg(target_os = "macos")]
            _slave: slave
                .try_clone()
                .map_err(|e| failed("keeping a slave of the holder's own", e))?,
        };
        pty.set_size(size)
            .map_err(|e| failed("sizing the PTY", e))?;
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

/// `error`, with the step of `Pty::open` that failed before it, and its kind kept.
fn failed(step: &str, error: impl Into<io::Error>) -> io::Error {
    let error = error.into();
    io::Error::new(error.kind(), format!("{step}: {error}"))
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
/// waiting out its grace. The dispositions go first, so no signal is unblocked while the holder's
/// handler for it is still installed.
fn become_session_leader() -> io::Result<()> {
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
    rustix::process::setsid()?;
    rustix::process::ioctl_tiocsctty(rustix::stdio::stdin())?;
    Ok(())
}

/// Unblocks `SIGCHLD` and `SIGUSR1` in the holder itself: its loop wakes on them, and a spawner
/// may have left them blocked, which would leave a child's exit unseen until the next deadline and
/// a rebind asked for in vain.
///
/// # Errors
///
/// When the mask can't be changed.
pub fn unblock_wakeup_signals() -> io::Result<()> {
    let mut set = MaybeUninit::<libc::sigset_t>::uninit();
    // SAFETY: sigemptyset(3) only writes the set it is given, which lives on this stack frame.
    if unsafe { libc::sigemptyset(set.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: sigemptyset succeeded, so it initialised the set.
    let mut set = unsafe { set.assume_init() };
    for signal in [libc::SIGCHLD, libc::SIGUSR1] {
        // SAFETY: `set` is initialised, and `signal` is a valid signal on every OS.
        if unsafe { libc::sigaddset(&raw mut set, signal) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    // SAFETY: `set` is initialised and the old mask isn't asked for. The holder has one thread, so
    // the process mask is that thread's.
    if unsafe { libc::sigprocmask(libc::SIG_UNBLOCK, &raw const set, ptr::null_mut()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Closes every fd above 2 that this process inherited, so none reaches the child, nor keeps open
/// whatever its spawner leaked.
///
/// An inherited fd is one without `FD_CLOEXEC`, since exec closed every fd that had it. So this is
/// sound as long as every fd the process owns is close-on-exec, and `start` calls it first, before
/// the holder opens anything. std, `signal-hook` and `Pty::open` set the flag on every fd they
/// make; rustix doesn't by default, so `clippy.toml` disallows the rustix calls that make an fd
/// without it.
///
/// # Errors
///
/// When `/dev/fd` can't be listed.
pub(crate) fn close_inherited_fds() -> io::Result<()> {
    let mut listed = Vec::new();
    for entry in std::fs::read_dir("/dev/fd")? {
        if let Ok(fd) = entry?.file_name().to_string_lossy().parse::<RawFd>()
            && fd > 2
        {
            listed.push(fd);
        }
    }
    for fd in listed {
        // SAFETY: fcntl(F_GETFD) only reads the fd's flags. An fd no longer open, such as the
        // listing's own, answers -1 (EBADF) and is skipped.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags == -1 || flags & libc::FD_CLOEXEC != 0 {
            continue;
        }
        // SAFETY: `fd` has no FD_CLOEXEC, so it was inherited across exec: no Rust value in this
        // crate owns it (see above), and closing it invalidates no handle.
        let _ = unsafe { libc::close(fd) };
    }
    Ok(())
}

/// Opens the terminal at `path` to read and write, never as the caller's controlling terminal.
/// std sets `O_CLOEXEC` on it.
///
/// # Errors
///
/// When it can't be opened.
pub fn open_terminal(path: &std::ffi::CStr) -> io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOCTTY)
        .open(std::ffi::OsStr::from_bytes(path.to_bytes()))
}
