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
    /// Only until the child is spawned: a slave the holder keeps would stop the master from ever
    /// reading the end of the output, so the holder could never tell its clients the child exited.
    slave: Option<OwnedFd>,
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
        Ok(Self {
            master,
            slave: Some(slave),
        })
    }

    pub(crate) fn resize(&self, size: Size) -> io::Result<()> {
        tcsetwinsize(&self.master, size.winsize())?;
        Ok(())
    }

    /// Spawns `command` as the leader of a new session whose controlling terminal is the PTY, and
    /// gives up the holder's slave: once the child and anything it passed the PTY to have closed
    /// theirs, the master reads the end of the output. Callable once.
    pub(crate) fn spawn(&mut self, command: &mut Command) -> io::Result<Child> {
        let slave = self
            .slave
            .take()
            .ok_or_else(|| io::Error::other("the PTY's child was already spawned"))?;
        command
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave));
        // SAFETY: the closure runs in the forked child before exec. It calls only setsid(2) and
        // ioctl(TIOCSCTTY), both async-signal-safe, allocates nothing and takes no lock.
        unsafe {
            command.pre_exec(|| {
                rustix::process::setsid()?;
                rustix::process::ioctl_tiocsctty(rustix::stdio::stdin())?;
                Ok(())
            });
        }
        let child = command.spawn();
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        child
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

#[cfg(test)]
mod tests {
    use std::io::{ErrorKind, Read};
    use std::time::{Duration, Instant};

    use super::{Command, Pty, Size};

    #[test]
    fn master_reads_the_end_once_the_child_exits() -> std::io::Result<()> {
        let mut pty = Pty::open(Size { cols: 80, rows: 24 })?;
        // Kept alive past the read, as a caller's Command can be: the slave it was given must not be.
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf last-words"]);
        let mut child = pty.spawn(&mut command)?;
        child.wait()?;
        let mut master = std::fs::File::from(pty.master.try_clone()?);
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        let deadline = Instant::now() + Duration::from_secs(5);
        let ended = loop {
            match master.read(&mut buf) {
                Ok(0) => break true,
                Ok(n) => out.extend_from_slice(buf.get(..n).unwrap_or_default()),
                Err(e) if e.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break false,
                Err(_) => break true,
            }
        };
        assert!(ended, "the master never read the end of the output");
        assert!(String::from_utf8_lossy(&out).contains("last-words"));
        drop(command);
        Ok(())
    }
}
