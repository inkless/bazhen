//! Opening a PTY master, past the race in which macOS answers ENXIO.

use std::io;
use std::os::fd::OwnedFd;

use rustix::io::Errno;

/// How many times `open_master` opens a master that fails with ENXIO before giving up.
const MASTER_TRIES: usize = 8;

/// Opens a PTY master with `open`, again while it fails with ENXIO, up to `MASTER_TRIES` times.
///
/// XNU picks a new master's slot in its PTY table when `/dev/ptmx` is looked up, and claims it
/// only when it is opened, with the table's lock dropped between. A lookup that finds the table
/// full picks the slot past its end; if another PTY closes before the open, the table isn't
/// grown, and the open fails with ENXIO (`ptmx_clone`, `ptmx_get_ioctl` and `ptcopen` in XNU's
/// `bsd/kern/tty_ptmx.c` and `tty_dev.c`). A fresh open looks the slot up again and finds the
/// freed one. A failed open made no fd, so a retry leaves nothing to close.
pub(crate) fn open_master(
    mut open: impl FnMut() -> rustix::io::Result<OwnedFd>,
) -> io::Result<OwnedFd> {
    let mut tries = 1;
    loop {
        match open() {
            Err(Errno::NXIO) if tries < MASTER_TRIES => tries += 1,
            opened => return Ok(opened?),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs::File;

    use super::*;

    /// An opener that fails with `errno` `failures` times, then opens `/dev/null`, counting calls.
    fn opener(
        errno: Errno,
        failures: usize,
        calls: &mut usize,
    ) -> impl FnMut() -> rustix::io::Result<OwnedFd> {
        move || {
            *calls += 1;
            assert!(
                *calls <= MASTER_TRIES,
                "opened {calls} times, past {MASTER_TRIES}"
            );
            if *calls <= failures {
                return Err(errno);
            }
            Ok(OwnedFd::from(File::open("/dev/null").unwrap()))
        }
    }

    #[test]
    fn opens_the_master_again_after_enxio_until_it_opens() {
        let mut calls = 0;
        open_master(opener(Errno::NXIO, MASTER_TRIES - 1, &mut calls)).unwrap();
        assert_eq!(calls, MASTER_TRIES);
    }

    #[test]
    fn gives_up_on_a_master_that_fails_with_enxio_every_time() {
        let mut calls = 0;
        let error = open_master(opener(Errno::NXIO, usize::MAX, &mut calls)).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ENXIO));
        assert_eq!(calls, MASTER_TRIES);
    }

    #[test]
    fn does_not_open_the_master_again_after_another_error() {
        let mut calls = 0;
        let error = open_master(opener(Errno::MFILE, 1, &mut calls)).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EMFILE));
        assert_eq!(calls, 1);
    }
}
