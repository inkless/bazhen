//! The holder's log: best effort and bounded. A full disk, a lost directory or a log that won't
//! open costs log lines, never the holder or its terminal.

use std::fmt::Debug;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
        let len = u64::try_from(line.len()).unwrap_or(u64::MAX);
        if !self.make_room(len) {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        let Some(file) = &mut self.file else {
            return;
        };
        if self.dropped > 0 {
            let note = format!("{} log lines dropped\n", self.dropped);
            if file.write_all(note.as_bytes()).is_ok() {
                self.written = self.written.saturating_add(note.len() as u64);
                self.dropped = 0;
            }
        }
        if file.write_all(line).is_ok() {
            self.written = self.written.saturating_add(len);
        } else {
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

/// Sends the process's `tracing` events to a bounded log beside `socket`. Lines carry no ANSI
/// colour and no module path.
pub fn init(socket: &Path) {
    let writer = Mutex::new(BoundedLog::new(DiskLog::beside(socket), LOG_CAP));
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
