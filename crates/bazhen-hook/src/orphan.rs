//! A waiter whose harness has gone: nothing is left to read its reply, so it stops waiting.

use std::io;
use std::os::fd::AsFd;
use std::process;
use std::thread;
use std::time::Duration;

use rustix::event::{PollFd, PollFlags, Timespec, poll};

const CHECK_EVERY: Duration = Duration::from_secs(1);

/// Whether nothing can read `fd` any more: a pipe whose read end has closed reports POLLERR, and
/// a socket whose peer has closed reports POLLHUP. A poll that fails says neither.
pub(crate) fn reader_gone(fd: impl AsFd) -> bool {
    let mut fds = [PollFd::new(&fd, PollFlags::OUT)];
    let now = Timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    poll(&mut fds, Some(&now)).is_ok()
        && fds[0].revents().intersects(PollFlags::ERR | PollFlags::HUP)
}

/// Ends the process, as the hook ends on any failure, once its stdout or stderr has no reader:
/// the harness that ran it, and holds their other ends, has gone. A daemon holding its request
/// sees it abort.
pub(crate) fn exit_when_unread() {
    // A hook that can't start the thread waits as it would without it.
    let _ = thread::Builder::new().spawn(|| {
        loop {
            if reader_gone(io::stdout()) || reader_gone(io::stderr()) {
                process::exit(0);
            }
            thread::sleep(CHECK_EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use std::io::pipe;
    use std::os::unix::net::UnixStream;

    use super::*;

    #[test]
    fn a_pipe_has_no_reader_once_its_read_end_closes() -> io::Result<()> {
        let (reader, writer) = pipe()?;
        let open = reader_gone(&writer);
        drop(reader);
        assert_eq!((open, reader_gone(&writer)), (false, true));
        Ok(())
    }

    #[test]
    fn a_socket_has_no_reader_once_its_peer_closes() -> io::Result<()> {
        let (hook, harness) = UnixStream::pair()?;
        let open = reader_gone(&hook);
        drop(harness);
        assert_eq!((open, reader_gone(&hook)), (false, true));
        Ok(())
    }
}
