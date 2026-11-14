#![expect(
    unsafe_code,
    reason = "Command::pre_exec runs a closure between fork and exec, which only unsafe can register"
)]

use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

use rustix::fs::{Mode, OFlags};
use rustix::io::{FdFlags, fcntl_setfd};
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use rustix::termios::{InputModes, OptionalActions, Winsize, tcgetattr, tcsetattr, tcsetwinsize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Size {
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

impl Size {
    /// A zero dimension is clamped to 1: a zero-sized PTY panics some engines.
    pub(crate) fn clamped(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.max(2),
            rows: rows.max(1),
        }
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

#[derive(Debug)]
pub(crate) struct Pty {
    pub(crate) master: OwnedFd,
    slave: OwnedFd,
}

impl Pty {
    /// Opens a PTY pair. Neither end becomes the caller's controlling terminal, and both are
    /// close-on-exec, so no child inherits them except through the stdio it is given.
    pub(crate) fn open(size: Size) -> io::Result<Self> {
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
        tcsetwinsize(&slave, size.winsize())?;
        rustix::io::ioctl_fionbio(&master, true)?;
        Ok(Self { master, slave })
    }

    pub(crate) fn resize(&self, size: Size) -> io::Result<()> {
        tcsetwinsize(&self.slave, size.winsize())?;
        Ok(())
    }

    /// Spawns `command` as the leader of a new session whose controlling terminal is the PTY.
    pub(crate) fn spawn(&self, command: &mut Command) -> io::Result<Child> {
        command
            .stdin(Stdio::from(self.slave.try_clone()?))
            .stdout(Stdio::from(self.slave.try_clone()?))
            .stderr(Stdio::from(self.slave.try_clone()?));
        // SAFETY: the closure runs in the forked child before exec. It calls only setsid(2) and
        // ioctl(TIOCSCTTY), both async-signal-safe, allocates nothing and takes no lock.
        unsafe {
            command.pre_exec(|| {
                rustix::process::setsid()?;
                rustix::process::ioctl_tiocsctty(rustix::stdio::stdin())?;
                Ok(())
            });
        }
        command.spawn()
    }
}

/// Spawns `command` in a session of its own, so it outlives whatever started it: a signal to
/// the launcher's session or process group never reaches it.
pub(crate) fn spawn_detached(command: &mut Command) -> io::Result<Child> {
    // SAFETY: the closure runs in the forked child before exec and calls only setsid(2), which
    // is async-signal-safe; it allocates nothing and takes no lock.
    unsafe {
        command.pre_exec(|| {
            rustix::process::setsid()?;
            Ok(())
        });
    }
    command.spawn()
}
