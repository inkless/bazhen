//! The person's own terminal while `bazhen attach` holds it: raw, its size, and wake-ups when the
//! size changes or the process is asked to stop.

use std::io::{self, ErrorKind, Read as _, Write as _};
use std::os::fd::{AsFd as _, BorrowedFd};
use std::os::unix::net::UnixStream;

use rustix::termios::{OptionalActions, Termios, isatty, tcgetattr, tcgetwinsize, tcsetattr};
use signal_hook::SigId;

use super::attachment::Size;

/// What an attached program may have turned on in the person's terminal, turned off: the
/// alternate screen, mouse and focus reports, bracketed paste and the application keypad; and the
/// cursor shown, past the last line the program drew.
const LEAVE: &str = concat!(
    "\x1b[?1049l",
    "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l",
    "\x1b[?1004l",
    "\x1b[?2004l",
    "\x1b[?1l\x1b>",
    "\x1b[?25h\x1b[0m\r\n",
);
/// Clears the screen before the terminal's own is drawn over it.
const ENTER: &str = "\x1b[H\x1b[2J";

/// Whether stdin and stdout are both a terminal, which attaching takes over.
pub(crate) fn interactive() -> bool {
    isatty(io::stdin()) && isatty(io::stdout())
}

/// The size of the person's terminal, as a view may give it.
pub(crate) fn size() -> io::Result<Size> {
    let ws = tcgetwinsize(io::stdout())?;
    Ok(Size::clamped(ws.ws_col, ws.ws_row))
}

/// The person's terminal in raw mode, as it was before once this drops, or once the process
/// panics: a release build aborts on a panic, which runs no `Drop`.
#[derive(Debug)]
pub(crate) struct Raw {
    before: Termios,
}

impl Raw {
    pub(crate) fn enter() -> io::Result<Self> {
        let before = tcgetattr(io::stdin())?;
        let mut raw = before.clone();
        raw.make_raw();
        tcsetattr(io::stdin(), OptionalActions::Flush, &raw)?;
        let saved = before.clone();
        let panicked = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore(&saved);
            panicked(info);
        }));
        let raw = Self { before };
        clear()?;
        Ok(raw)
    }
}

/// Clears the screen for a snapshot to be drawn on.
pub(crate) fn clear() -> io::Result<()> {
    io::stdout().write_all(ENTER.as_bytes())?;
    io::stdout().flush()
}

/// Puts the person's terminal back as `before` had it, as well as it can be: nothing is left to
/// report a failure to, and a terminal that's gone needs none of it.
fn restore(before: &Termios) {
    let _ = io::stdout().write_all(LEAVE.as_bytes());
    let _ = io::stdout().flush();
    let _ = tcsetattr(io::stdin(), OptionalActions::Flush, before);
}

impl Drop for Raw {
    fn drop(&mut self) {
        restore(&self.before);
        // The default hook again, as there is no raw terminal left to put back; a hook can't be
        // changed while unwinding.
        if !std::thread::panicking() {
            drop(std::panic::take_hook());
        }
    }
}

/// Signals as a readable fd, for the attachment's `poll`; the handlers go when it drops. Each
/// signal it watches no longer does what it would by default: the loop acts on it.
#[derive(Debug)]
pub(crate) struct Wakeups {
    wakeups: UnixStream,
    handlers: Vec<SigId>,
}

impl Wakeups {
    /// The terminal's size changing.
    pub(crate) fn resizes() -> io::Result<Self> {
        Self::watch(&[signal_hook::consts::SIGWINCH])
    }

    /// Being asked to stop: by `kill`, the terminal hanging up, or an interrupt from outside it,
    /// as a raw terminal sends none of its own.
    pub(crate) fn stops() -> io::Result<Self> {
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
        Self::watch(&[SIGTERM, SIGHUP, SIGINT])
    }

    fn watch(signals: &[std::ffi::c_int]) -> io::Result<Self> {
        let (wakeups, sender) = UnixStream::pair()?;
        wakeups.set_nonblocking(true)?;
        let mut handlers = Vec::with_capacity(signals.len());
        for &signal in signals {
            handlers.push(signal_hook::low_level::pipe::register(
                signal,
                sender.try_clone()?,
            )?);
        }
        Ok(Self { wakeups, handlers })
    }

    pub(crate) fn fd(&self) -> BorrowedFd<'_> {
        self.wakeups.as_fd()
    }

    /// Empties the wake-ups, so `fd` waits for the next signal.
    pub(crate) fn clear(&self) {
        let mut drained = [0u8; 64];
        loop {
            match (&self.wakeups).read(&mut drained) {
                Ok(n) if n > 0 => {}
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                _ => return,
            }
        }
    }
}

impl Drop for Wakeups {
    fn drop(&mut self) {
        for &handler in &self.handlers {
            signal_hook::low_level::unregister(handler);
        }
    }
}
