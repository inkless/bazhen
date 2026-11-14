//! vte 0.15 loses bytes when a char is split across two calls to `advance`: the call that
//! completes the char also consumes up to two bytes after it, unparsed (`advance_partial_utf8`
//! returns the valid bytes it buffered, not the char's length). A PTY read splits chars anywhere,
//! so after a call that ends inside a char, the bytes that finish it go in a call of their own,
//! which takes vte's path that counts right.

#[derive(Debug, Default)]
pub(crate) struct Utf8Seam {
    /// Continuation bytes the last call left a char waiting for.
    owed: usize,
}

impl Utf8Seam {
    /// Splits off the start of `bytes` that finishes the char the last call left unfinished.
    pub(crate) fn finish<'a>(&mut self, bytes: &'a [u8]) -> (&'a [u8], &'a [u8]) {
        let n = self.owed.min(bytes.len());
        self.owed -= n;
        bytes.split_at_checked(n).unwrap_or((bytes, &[]))
    }

    /// Notes whether `fed`, just given to the parser, ends inside a char.
    pub(crate) fn note(&mut self, fed: &[u8]) {
        self.owed = 0;
        for (back, &byte) in fed.iter().rev().take(3).enumerate() {
            let len: usize = match byte {
                0x80..=0xbf => continue,
                0xc0..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf7 => 4,
                _ => return,
            };
            self.owed = len.saturating_sub(back + 1);
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};

    use super::*;
    use crate::{Sink, Size, config};
    use alacritty_terminal::term::Term;

    /// The cursor's column after `stream` is fed in the two pieces `cut` splits it into.
    fn column_after(stream: &[u8], cut: usize, seam: bool) -> usize {
        let mut term = Term::new(config(10), &Size { cols: 20, rows: 2 }, Sink::default());
        let mut parser = Processor::<StdSyncHandler>::new();
        let mut utf8 = Utf8Seam::default();
        let (first, second) = stream.split_at(cut);
        parser.advance(&mut term, first);
        utf8.note(first);
        let (finish, rest) = if seam {
            utf8.finish(second)
        } else {
            (&[][..], second)
        };
        parser.advance(&mut term, finish);
        parser.advance(&mut term, rest);
        term.grid().cursor.point.column.0
    }

    #[test]
    fn a_char_split_across_reads_loses_nothing_after_it() {
        // The tab moves the cursor to column 8, and the wide char after it takes two columns.
        let stream = "e\u{301}\t中".as_bytes();
        assert_ne!(
            column_after(stream, 2, false),
            10,
            "vte no longer drops the tab"
        );
        for cut in 1..stream.len() {
            assert_eq!(column_after(stream, cut, true), 10, "cut at {cut}");
        }
    }

    #[test]
    fn it_owes_what_a_char_still_needs_and_nothing_after_a_whole_one() {
        let mut seam = Utf8Seam::default();
        for (fed, owed) in [
            (&b"a\xf0"[..], 3),
            (b"\xf0\x9f", 2),
            (b"\xf0\x9f\x98", 1),
            (b"\xf0\x9f\x98\x80", 0),
            (b"\xc3", 1),
            (b"\xc3\xa9", 0),
            (b"x", 0),
            (b"\x80\x80\x80", 0),
        ] {
            seam.note(fed);
            assert_eq!(seam.owed, owed, "{fed:x?}");
        }
        seam.note(b"\xe4");
        assert_eq!(seam.finish(b"\xb8"), (&b"\xb8"[..], &b""[..]));
        assert_eq!(seam.finish(b"\xadz"), (&b"\xad"[..], &b"z"[..]));
        assert_eq!(seam.finish(b"q"), (&b""[..], &b"q"[..]));
    }
}
