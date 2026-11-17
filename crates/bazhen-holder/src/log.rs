//! The holder's log: best effort and bounded. A full disk, a lost directory or a log that won't
//! open costs log lines, never the holder or its terminal.

use std::fmt::Debug;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, TryLockError};

use tracing_subscriber::fmt::MakeWriter;

/// The size past which the log is moved aside, so a holder keeps at most about twice this.
pub const LOG_CAP: u64 = 1 << 20;

/// Where a log's lines go: a file to append to, which can be moved aside when it is full.
pub trait LogFiles: Debug + Send {
    type File: Write + Debug + Send;

    /// Opens the current file to append to, with its length.
    ///
    /// # Errors
    ///
    /// When the file can't be opened or created.
    fn open(&mut self) -> io::Result<(Self::File, u64)>;

    /// Moves the current file aside, over whatever was aside before.
    ///
    /// # Errors
    ///
    /// When the file can't be moved.
    fn rotate(&mut self) -> io::Result<()>;
}

/// A log beside the holder's socket: `<terminalId>.log`, and `<terminalId>.log.1` once moved
/// aside. Only its owner may read it, and a symlink in its place is refused.
#[derive(Debug)]
pub struct DiskLog {
    path: PathBuf,
    aside: PathBuf,
}

impl DiskLog {
    pub fn beside(socket: &Path) -> Self {
        Self {
            path: socket.with_extension("log"),
            aside: socket.with_extension("log.1"),
        }
    }
}

impl LogFiles for DiskLog {
    type File = File;

    fn open(&mut self) -> io::Result<(File, u64)> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&self.path)?;
        let len = file.metadata()?.len();
        Ok((file, len))
    }

    fn rotate(&mut self) -> io::Result<()> {
        std::fs::rename(&self.path, &self.aside)
    }
}

/// Writes whole lines to `F`'s current file, moving it aside before a line would take it past
/// `cap`. A line it can't write is dropped and counted, and the count goes before the next line it
/// can. It never reports a failure to its caller.
#[derive(Debug)]
pub struct BoundedLog<F: LogFiles> {
    files: F,
    file: Option<F::File>,
    written: u64,
    cap: u64,
    dropped: u64,
}

impl<F: LogFiles> BoundedLog<F> {
    pub fn new(files: F, cap: u64) -> Self {
        Self {
            files,
            file: None,
            written: 0,
            cap,
            dropped: 0,
        }
    }

    /// The lines dropped since the last one written.
    pub const fn dropped(&self) -> u64 {
        self.dropped
    }

    fn line(&mut self, line: &[u8]) {
        let note = (self.dropped > 0).then(|| format!("{} log lines dropped\n", self.dropped));
        let len = note
            .as_ref()
            .map_or(0, String::len)
            .saturating_add(line.len());
        if !self.make_room(u64::try_from(len).unwrap_or(u64::MAX)) {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        let Some(file) = &mut self.file else {
            return;
        };
        let written = note
            .as_ref()
            .map_or(Ok(()), |note| file.write_all(note.as_bytes()))
            .and_then(|()| file.write_all(line));
        if written.is_ok() {
            self.written = self.written.saturating_add(len as u64);
            self.dropped = 0;
        } else {
            // Part of it may be on disk: reopening reads the length again, so the cap holds.
            self.file = None;
            self.dropped = self.dropped.saturating_add(1);
        }
    }

    /// Opens the file if it isn't open, and moves it aside first if `len` more bytes would take
    /// it past the cap. False when there is nowhere to write within the cap.
    fn make_room(&mut self, len: u64) -> bool {
        for _ in 0..2 {
            if self.file.is_none() {
                match self.files.open() {
                    Ok((file, written)) => {
                        self.file = Some(file);
                        self.written = written;
                    }
                    Err(_) => return false,
                }
            }
            if self.written == 0 || self.written.saturating_add(len) <= self.cap {
                return true;
            }
            self.file = None;
            if self.files.rotate().is_err() {
                return false;
            }
        }
        false
    }
}

impl<F: LogFiles> Write for BoundedLog<F> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.line(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The log, handed to one event at a time. An event that finds it in use drops its line rather
/// than wait: the holder has one thread, so the log is in use only when a panic inside its own
/// write logs, and waiting for it would hang the holder with its child alive.
#[derive(Debug)]
pub struct Shared<W>(Mutex<W>);

impl<W> Shared<W> {
    pub const fn new(log: W) -> Self {
        Self(Mutex::new(log))
    }
}

/// One event's line: written to the log, or dropped.
#[derive(Debug)]
pub enum Line<'a, W> {
    Held(MutexGuard<'a, W>),
    Dropped,
}

impl<W: Write> Write for Line<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Held(log) => log.write(buf),
            Self::Dropped => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Held(log) => log.flush(),
            Self::Dropped => Ok(()),
        }
    }
}

impl<'a, W: Write + 'a> MakeWriter<'a> for Shared<W> {
    type Writer = Line<'a, W>;

    fn make_writer(&'a self) -> Self::Writer {
        match self.0.try_lock() {
            Ok(log) => Line::Held(log),
            // A panic mid-write leaves the log as whole as any failed write does.
            Err(TryLockError::Poisoned(poisoned)) => Line::Held(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => Line::Dropped,
        }
    }
}

/// Sends the process's `tracing` events to a bounded log beside `socket`. Lines carry no ANSI
/// colour and no module path.
pub fn init(socket: &Path) {
    let writer = Shared::new(BoundedLog::new(DiskLog::beside(socket), LOG_CAP));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(writer)
        .with_target(false)
        .finish();
    // Fails only when a subscriber is already set, which then keeps logging.
    let _ = tracing::subscriber::set_global_default(subscriber);
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Debug, Default)]
    struct Disk {
        current: Vec<u8>,
        aside: Vec<u8>,
        full: bool,
        unopenable: bool,
    }

    #[derive(Debug, Clone, Default)]
    struct Fake(Arc<Mutex<Disk>>);

    #[derive(Debug)]
    struct FakeFile(Arc<Mutex<Disk>>);

    impl Write for FakeFile {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut disk = self.0.lock().unwrap();
            if disk.full {
                return Err(io::Error::from(io::ErrorKind::StorageFull));
            }
            disk.current.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl LogFiles for Fake {
        type File = FakeFile;

        fn open(&mut self) -> io::Result<(FakeFile, u64)> {
            let disk = self.0.lock().unwrap();
            if disk.unopenable {
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
            Ok((FakeFile(Arc::clone(&self.0)), disk.current.len() as u64))
        }

        fn rotate(&mut self) -> io::Result<()> {
            let mut disk = self.0.lock().unwrap();
            disk.aside = std::mem::take(&mut disk.current);
            Ok(())
        }
    }

    fn text(bytes: &[u8]) -> String {
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[test]
    fn moves_the_log_aside_before_a_line_would_take_it_past_the_cap() {
        let fake = Fake::default();
        let mut log = BoundedLog::new(fake.clone(), 100);
        for n in 0..10 {
            log.write_all(format!("line {n:02} ..................\n").as_bytes())
                .unwrap();
        }
        let disk = fake.0.lock().unwrap();
        assert!(disk.current.len() <= 100, "{}", disk.current.len());
        assert!(disk.aside.len() <= 100, "{}", disk.aside.len());
        assert!(text(&disk.current).ends_with("line 09 ..................\n"));
        assert!(
            text(&disk.aside).starts_with("line 06"),
            "{}",
            text(&disk.aside)
        );
    }

    #[test]
    fn a_full_disk_drops_lines_and_says_so_once_it_can() {
        let fake = Fake::default();
        let mut log = BoundedLog::new(fake.clone(), 1000);
        log.write_all(b"before\n").unwrap();
        fake.0.lock().unwrap().full = true;
        log.write_all(b"lost one\n").unwrap();
        log.write_all(b"lost two\n").unwrap();
        assert_eq!(log.dropped(), 2);
        fake.0.lock().unwrap().full = false;
        log.write_all(b"after\n").unwrap();
        assert_eq!(log.dropped(), 0);
        assert_eq!(
            text(&fake.0.lock().unwrap().current),
            "before\n2 log lines dropped\nafter\n"
        );
    }

    #[test]
    fn the_note_of_dropped_lines_counts_toward_the_cap() {
        let fake = Fake::default();
        let mut log = BoundedLog::new(fake.clone(), 40);
        log.write_all(&[b'x'; 30]).unwrap();
        fake.0.lock().unwrap().full = true;
        log.write_all(b"lost\n").unwrap();
        fake.0.lock().unwrap().full = false;
        log.write_all(b"kept\n").unwrap();
        let disk = fake.0.lock().unwrap();
        assert_eq!(text(&disk.current), "1 log lines dropped\nkept\n");
        assert_eq!(disk.aside.len(), 30);
    }

    #[test]
    fn a_log_that_wont_open_drops_lines_until_it_does() {
        let fake = Fake::default();
        fake.0.lock().unwrap().unopenable = true;
        let mut log = BoundedLog::new(fake.clone(), 1000);
        log.write_all(b"lost\n").unwrap();
        assert_eq!(log.dropped(), 1);
        fake.0.lock().unwrap().unopenable = false;
        log.write_all(b"kept\n").unwrap();
        assert_eq!(
            text(&fake.0.lock().unwrap().current),
            "1 log lines dropped\nkept\n"
        );
    }

    #[test]
    fn an_event_that_finds_the_log_in_use_drops_its_line_rather_than_wait() {
        let fake = Fake::default();
        let shared = Arc::new(Shared::new(BoundedLog::new(fake.clone(), LOG_CAP)));
        let held = shared.make_writer();
        let (done, waited) = std::sync::mpsc::channel();
        let nested = Arc::clone(&shared);
        // On a thread of its own, so a writer that waits fails the test instead of hanging it.
        std::thread::spawn(move || {
            let mut line = nested.make_writer();
            let dropped = matches!(line, Line::Dropped);
            line.write_all(b"from a panic inside a write\n").unwrap();
            drop(line);
            done.send(dropped).unwrap();
        });
        let dropped = waited.recv_timeout(std::time::Duration::from_secs(5));
        assert_eq!(dropped, Ok(true), "the second writer waited for the first");
        drop(held);
        shared.make_writer().write_all(b"kept\n").unwrap();
        assert_eq!(text(&fake.0.lock().unwrap().current), "kept\n");
    }

    #[test]
    fn a_log_a_panic_left_locked_still_takes_lines() {
        let fake = Fake::default();
        let shared = Shared::new(BoundedLog::new(fake.clone(), LOG_CAP));
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = shared.make_writer();
            panic!("inside a write");
        }));
        assert!(panicked.is_err());
        let mut line = shared.make_writer();
        assert!(
            matches!(line, Line::Held(_)),
            "a poisoned log dropped the line"
        );
        line.write_all(b"after\n").unwrap();
        drop(line);
        assert_eq!(text(&fake.0.lock().unwrap().current), "after\n");
    }

    #[test]
    fn the_log_on_disk_keeps_its_lines_until_full_then_moves_them_aside() {
        let dir = Scratch::new("aside");
        let dir = dir.path();
        let socket = dir.join("term.sock");
        let mut log = BoundedLog::new(DiskLog::beside(&socket), LOG_CAP);
        log.write_all(b"one\n").unwrap();
        log.write_all(b"two\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("term.log")).unwrap(),
            "one\ntwo\n"
        );
        assert!(
            !dir.join("term.log.1").exists(),
            "moved aside under the cap"
        );
        let mut log = BoundedLog::new(DiskLog::beside(&socket), 10);
        log.write_all(b"three\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("term.log.1")).unwrap(),
            "one\ntwo\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("term.log")).unwrap(),
            "three\n"
        );
    }

    /// A directory of this run's own, made empty and removed when dropped, whether the test
    /// passed or not, so no earlier run's files are read by a later one under the same pid.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "bz-holder-log-{name}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_log_on_disk_is_its_owners_alone_and_refuses_a_symlink() {
        let dir = std::env::temp_dir().join(format!("bz-holder-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("term.sock");
        let mut log = BoundedLog::new(DiskLog::beside(&socket), LOG_CAP);
        log.write_all(b"hello\n").unwrap();
        let path = dir.join("term.log");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\n");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);

        let linked = dir.join("linked.sock");
        std::os::unix::fs::symlink(dir.join("elsewhere"), dir.join("linked.log")).unwrap();
        let mut log = BoundedLog::new(DiskLog::beside(&linked), LOG_CAP);
        log.write_all(b"refused\n").unwrap();
        assert_eq!(log.dropped(), 1);
        assert!(!dir.join("elsewhere").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
