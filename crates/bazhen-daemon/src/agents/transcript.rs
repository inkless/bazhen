//! Reads a harness session's transcript for the line it can be resumed from
//! (`agents/transcript.ts`), the harness judging each line. The path is a hook's to name, so what
//! is there is never trusted to be a file, nor to end.

use std::collections::HashSet;
use std::fs::File;
use std::io::ErrorKind;
use std::os::unix::fs::{FileExt as _, OpenOptionsExt as _};
use std::sync::Mutex;

use rustix::fs::OFlags;

/// How much is read at a time.
const CHUNK_BYTES: usize = 16 * 1024;
/// A session's first entry is among its transcript's first few lines, in a resumed one too, which
/// appends; each metadata line ahead of it is a few hundred bytes. A line still open here that is
/// half this long is no metadata but an entry holding a large paste, such as an image.
const LIMIT_BYTES: usize = 1024 * 1024;

/// Reads transcripts, saying once for each path why one can't be read.
pub(crate) struct TranscriptReader {
    chunk_bytes: usize,
    limit_bytes: usize,
    warn: Box<dyn Fn(&str) + Send + Sync>,
    warned: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for TranscriptReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TranscriptReader")
            .field("chunk_bytes", &self.chunk_bytes)
            .field("limit_bytes", &self.limit_bytes)
            .finish_non_exhaustive()
    }
}

impl TranscriptReader {
    pub(crate) fn new(warn: Box<dyn Fn(&str) + Send + Sync>) -> Self {
        Self::with_limits(warn, CHUNK_BYTES, LIMIT_BYTES)
    }

    fn with_limits(
        warn: Box<dyn Fn(&str) + Send + Sync>,
        chunk_bytes: usize,
        limit_bytes: usize,
    ) -> Self {
        Self {
            chunk_bytes: chunk_bytes.max(1),
            limit_bytes,
            warn,
            warned: Mutex::default(),
        }
    }

    /// Whether `line` says one of the transcript's complete lines, read in order, is the one
    /// looked for. A line still without its newline may be mid-write and is not judged, unless it
    /// runs on past half the limit. A path that can't be read holds none; why is said once for
    /// each path, but for a file not there yet, which is how every session starts.
    pub(crate) fn scan(&self, path: &str, line: &mut dyn FnMut(&str) -> bool) -> bool {
        // A FIFO there mustn't block the daemon, nor a terminal become the controlling terminal
        // of the session the daemon leads.
        let flags = (OFlags::NONBLOCK | OFlags::NOCTTY).bits().cast_signed();
        let file = match std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open(path)
        {
            Ok(file) => file,
            Err(err) if err.kind() == ErrorKind::NotFound => return false,
            Err(err) => return self.unreadable(path, &err.to_string()),
        };
        match file.metadata() {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return self.unreadable(path, "it isn't a regular file"),
            Err(err) => return self.unreadable(path, &err.to_string()),
        }
        match self.holds(&file, line) {
            Ok(holds) => holds,
            Err(err) => self.unreadable(path, &err.to_string()),
        }
    }

    fn holds(&self, file: &File, line: &mut dyn FnMut(&str) -> bool) -> std::io::Result<bool> {
        let mut chunk = vec![0; self.chunk_bytes];
        let mut open: Vec<u8> = Vec::new();
        let mut read = 0;
        while read < self.limit_bytes {
            let want = self.chunk_bytes.min(self.limit_bytes - read);
            let into = chunk.get_mut(..want).unwrap_or_default();
            let n = file.read_at(into, u64::try_from(read).unwrap_or(u64::MAX))?;
            if n == 0 {
                return Ok(false);
            }
            read += n;
            let mut bytes = into.get(..n).unwrap_or_default();
            while let Some(end) = bytes.iter().position(|&b| b == b'\n') {
                let (rest, after) = bytes.split_at(end);
                let judged = if open.is_empty() {
                    line(&String::from_utf8_lossy(rest))
                } else {
                    open.extend_from_slice(rest);
                    let whole = line(&String::from_utf8_lossy(&open));
                    open.clear();
                    whole
                };
                if judged {
                    return Ok(true);
                }
                bytes = after.get(1..).unwrap_or_default();
            }
            open.extend_from_slice(bytes);
        }
        Ok(open.len() >= self.limit_bytes / 2)
    }

    fn unreadable(&self, path: &str, why: &str) -> bool {
        let first = self
            .warned
            .lock()
            .map_or(true, |mut warned| warned.insert(path.to_owned()));
        if first {
            (self.warn)(&format!(
                "the transcript {path} can't be read, so its session isn't offered to resume: {why}"
            ));
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::Path;
    use std::sync::Arc;

    use super::*;
    use crate::testing::TempDir;

    const METADATA: [&str; 3] = [
        r#"{"type":"mode","mode":"normal"}"#,
        r#"{"type":"permission-mode","permissionMode":"default"}"#,
        r#"{"type":"atis-latch","atis":""}"#,
    ];
    const USER: &str = r#"{"type":"user","message":{"role":"user","content":"hello"}}"#;

    /// The line looked for, as a harness would judge it.
    fn is_user(line: &str) -> bool {
        line == USER
    }

    struct Reader {
        reader: TranscriptReader,
        warnings: Arc<Mutex<Vec<String>>>,
    }

    impl Reader {
        fn holds(&self, path: &Path) -> bool {
            self.reader.scan(path.to_str().unwrap(), &mut is_user)
        }

        fn warnings(&self) -> Vec<String> {
            self.warnings.lock().unwrap().clone()
        }
    }

    fn reader_with(chunk_bytes: usize, limit_bytes: usize) -> Reader {
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let said = Arc::clone(&warnings);
        let warn = Box::new(move |m: &str| said.lock().unwrap().push(m.to_owned()));
        Reader {
            reader: TranscriptReader::with_limits(warn, chunk_bytes, limit_bytes),
            warnings,
        }
    }

    fn reader() -> Reader {
        reader_with(CHUNK_BYTES, LIMIT_BYTES)
    }

    fn transcript(dir: &TempDir, text: &str) -> std::path::PathBuf {
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, text).unwrap();
        path
    }

    fn lines(dir: &TempDir, lines: &[&str]) -> std::path::PathBuf {
        transcript(
            dir,
            &lines.iter().flat_map(|l| [*l, "\n"]).collect::<String>(),
        )
    }

    #[test]
    fn holds_one_from_the_first_line_the_harness_resumes_from_and_none_before_it() {
        let [before, after] = [TempDir::new("transcript"), TempDir::new("transcript")];
        let r = reader();
        assert_eq!(
            [
                r.holds(&lines(&before, &METADATA)),
                r.holds(&lines(&after, &[METADATA[0], USER, METADATA[1]])),
            ],
            [false, true]
        );
    }

    #[test]
    fn holds_none_for_a_file_not_there_yet_and_says_nothing_of_it() {
        let dir = TempDir::new("transcript");
        let r = reader();
        assert!(!r.holds(&dir.path().join("missing.jsonl")));
        assert_eq!(r.warnings(), Vec::<String>::new());
    }

    #[test]
    fn holds_none_for_what_isnt_a_regular_file_at_once_for_a_fifo_and_says_so_once_per_path() {
        let dir = TempDir::new("transcript");
        let fifo = dir.path().join("fifo.jsonl");
        rustix::fs::mkfifoat(rustix::fs::CWD, &fifo, rustix::fs::Mode::RUSR).unwrap();
        let r = reader();
        assert_eq!(
            [r.holds(&fifo), r.holds(&fifo), r.holds(dir.path())],
            [false, false, false]
        );
        let said = |path: &Path| {
            format!(
                "the transcript {} can't be read, so its session isn't offered to resume: it \
                 isn't a regular file",
                path.display()
            )
        };
        assert_eq!(r.warnings(), [said(&fifo), said(dir.path())]);
    }

    #[test]
    fn holds_none_for_a_file_it_may_not_read_and_says_why() {
        let dir = TempDir::new("transcript");
        let path = lines(&dir, &[USER]);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let r = reader();
        assert!(!r.holds(&path));
        let warnings = r.warnings();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings.iter().all(|w| w.contains("Permission denied")),
            "{warnings:?}"
        );
    }

    #[test]
    fn finds_a_line_split_across_reads() {
        let dir = TempDir::new("transcript");
        let path = lines(&dir, &[METADATA[0], METADATA[1], METADATA[2], USER]);
        assert!(reader_with(7, LIMIT_BYTES).holds(&path));
    }

    #[test]
    fn reads_on_past_a_line_that_isnt_json() {
        let [with, without] = [TempDir::new("transcript"), TempDir::new("transcript")];
        let r = reader();
        assert_eq!(
            [
                r.holds(&lines(&with, &["{not json", USER])),
                r.holds(&lines(&without, &["{not json"])),
            ],
            [true, false]
        );
    }

    #[test]
    fn doesnt_judge_a_last_line_still_without_its_newline_which_may_be_mid_write() {
        let dir = TempDir::new("transcript");
        let path = transcript(&dir, &format!("{}\n{USER}", METADATA.join("\n")));
        assert!(!reader().holds(&path));
    }

    #[test]
    fn stops_at_its_limit_taking_a_line_still_open_there_for_an_entry_as_a_large_paste_is() {
        let [pasted, many] = [TempDir::new("transcript"), TempDir::new("transcript")];
        let head = METADATA.join("\n").len() + 1;
        let paste = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{}"}}}}"#,
            "x".repeat(4096)
        );
        let snapshot = r#"{"type":"file-history-snapshot","messageId":"m","snapshot":{}}"#;
        let mut padded = METADATA.to_vec();
        padded.extend([snapshot; 40]);
        padded.push(USER);
        let r = reader_with(256, head + 1024);
        assert_eq!(
            [
                r.holds(&lines(
                    &pasted,
                    &[METADATA[0], METADATA[1], METADATA[2], &paste]
                )),
                r.holds(&lines(&many, &padded)),
            ],
            [true, false]
        );
    }

    mod properties {
        use proptest::prelude::*;

        use super::*;

        /// What reading `bytes` with these limits hands on and answers, worked out whole: each
        /// line ended within the first `limit` bytes, and, once the limit is reached, whether
        /// the line still open there is half as long.
        fn expected(bytes: &[u8], limit: usize) -> (Vec<String>, bool) {
            let read = bytes.get(..limit.min(bytes.len())).unwrap();
            let mut parts: Vec<&[u8]> = read.split(|&b| b == b'\n').collect();
            let open = parts.pop().unwrap_or_default();
            let lines = parts
                .iter()
                .map(|l| String::from_utf8_lossy(l).into_owned())
                .collect();
            (lines, bytes.len() >= limit && open.len() >= limit / 2)
        }

        proptest! {
            #[test]
            fn hands_on_each_line_ended_within_its_limit_whatever_its_reads_cut(
                bytes in proptest::collection::vec(
                    prop_oneof![Just(b'\n'), Just(b'a'), Just(0xff_u8), any::<u8>()],
                    0..600,
                ),
                chunk in 1_usize..64,
                limit in 1_usize..512,
            ) {
                let dir = TempDir::new("transcript-property");
                let path = dir.path().join("t.jsonl");
                std::fs::write(&path, &bytes).unwrap();
                let reader = TranscriptReader::with_limits(Box::new(|_| {}), chunk, limit);
                let mut handed = Vec::new();
                let holds = reader.scan(path.to_str().unwrap(), &mut |line| {
                    handed.push(line.to_owned());
                    false
                });
                prop_assert_eq!((handed, holds), expected(&bytes, limit));
            }
        }
    }
}
