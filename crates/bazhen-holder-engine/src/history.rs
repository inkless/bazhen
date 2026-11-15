//! The rows that have left alacritty's scrollback, oldest first, each as the bytes
//! [`encode_row`](crate::encode::encode_row) wrote for it.
//!
//! Rows are packed into blocks so a row costs its bytes plus an offset, not an allocation; the
//! oldest row goes when the store holds more rows or bytes than its limits, and its block when
//! it was the last.

use std::collections::VecDeque;

use crate::encode::{Ending, Lines};

const BLOCK_BYTES: usize = 64 * 1024;
/// A block closes at this many rows too: rows of no text, a flood of blank lines, would
/// otherwise all go to one block, which no eviction could free while it took more.
const BLOCK_ROWS: usize = 4096;

#[derive(Debug)]
struct Block {
    text: String,
    /// Where each row ends in `text`, and how.
    rows: Vec<RowEnd>,
}

impl Block {
    /// The memory the block holds, whatever of it is used.
    fn held(&self) -> usize {
        self.text.capacity() + self.rows.capacity() * size_of::<RowEnd>()
    }
}

/// Where a row ends in its block's text, and how, in four bytes: a store of short rows holds
/// more of these than text.
#[derive(Debug, Clone, Copy)]
struct RowEnd(u32);

impl RowEnd {
    const WRAPPED: u32 = 1 << 31;
    const SPACER: u32 = 1 << 30;
    const WIDE_START: u32 = 1 << 29;
    const END: u32 = Self::WIDE_START - 1;

    fn new(end: usize, ending: Ending) -> Self {
        // A block holds 64 KiB, or one row: never 512 MiB.
        let end = u32::try_from(end).unwrap_or(Self::END).min(Self::END);
        let flag = |on: bool, bit: u32| if on { bit } else { 0 };
        Self(
            end | flag(ending.wrapped, Self::WRAPPED)
                | flag(ending.spacer, Self::SPACER)
                | flag(ending.wide_start, Self::WIDE_START),
        )
    }

    fn end(self) -> usize {
        usize::try_from(self.0 & Self::END).unwrap_or(usize::MAX)
    }

    fn ending(self) -> Ending {
        Ending {
            wrapped: self.0 & Self::WRAPPED != 0,
            spacer: self.0 & Self::SPACER != 0,
            wide_start: self.0 & Self::WIDE_START != 0,
        }
    }
}

#[derive(Debug)]
pub(crate) struct History {
    blocks: VecDeque<Block>,
    /// Rows of the front block already evicted.
    evicted: usize,
    rows: usize,
    limit: usize,
    /// The memory the blocks hold: their text's capacity and their rows'.
    held: usize,
    most_bytes: usize,
}

impl History {
    /// A store of at most `limit` rows, in blocks holding at most `most_bytes` bytes: a row
    /// of text drawn in a new colour every cell runs to kilobytes.
    pub(crate) fn new(limit: usize, most_bytes: usize) -> Self {
        Self {
            blocks: VecDeque::new(),
            evicted: 0,
            rows: 0,
            limit,
            held: 0,
            most_bytes,
        }
    }

    pub(crate) fn rows(&self) -> usize {
        self.rows
    }

    /// The memory the store holds, spare capacity included.
    pub(crate) fn bytes(&self) -> usize {
        self.held
    }

    pub(crate) fn push(&mut self, row: &str, ending: Ending) {
        let fits = self.blocks.back().is_some_and(|b| {
            b.text.len() + row.len() <= b.text.capacity() && b.rows.len() < BLOCK_ROWS
        });
        if !fits {
            let block = Block {
                text: String::with_capacity(BLOCK_BYTES.max(row.len())),
                rows: Vec::with_capacity(BLOCK_ROWS),
            };
            self.held += block.held();
            self.blocks.push_back(block);
        }
        if let Some(block) = self.blocks.back_mut() {
            block.text.push_str(row);
            block.rows.push(RowEnd::new(block.text.len(), ending));
            self.rows += 1;
        }
        while self.rows > self.limit || self.held > self.most_bytes {
            if !self.evict() {
                break;
            }
        }
    }

    /// Evicts the oldest row, and its block if it was the block's last. Returns whether there
    /// was a row.
    fn evict(&mut self) -> bool {
        let Some(front) = self.blocks.front() else {
            return false;
        };
        self.evicted += 1;
        self.rows -= 1;
        if self.evicted >= front.rows.len() {
            if let Some(block) = self.blocks.pop_front() {
                self.held -= block.held().min(self.held);
            }
            self.evicted = 0;
        }
        true
    }

    /// Takes the newest line off the store, its rows oldest first, but no more than `most` of
    /// them, and none after a row `more` says is enough: the rest of a longer line stays, ending
    /// in a row that wraps.
    pub(crate) fn pop_line(
        &mut self,
        most: usize,
        mut more: impl FnMut(&str) -> bool,
    ) -> Vec<(String, Ending)> {
        let mut line = Vec::new();
        while line.len() < most {
            let Some(row) = self.pop_row() else {
                break;
            };
            let enough = !more(&row.0);
            line.push(row);
            if enough || !self.newest_wraps() {
                break;
            }
        }
        line.reverse();
        line
    }

    /// Whether the newest row wraps, so its line goes on past the store.
    pub(crate) fn newest_wraps(&self) -> bool {
        self.rows > 0
            && self
                .blocks
                .back()
                .and_then(|block| block.rows.last())
                .is_some_and(|row| row.ending().wrapped)
    }

    fn pop_row(&mut self) -> Option<(String, Ending)> {
        if self.rows == 0 {
            return None;
        }
        let evicted = if self.blocks.len() == 1 {
            self.evicted
        } else {
            0
        };
        let block = self.blocks.back_mut()?;
        let row = block.rows.pop()?;
        let start = block.rows.last().map_or(0, |r| r.end());
        let text = block
            .text
            .get(start..row.end())
            .unwrap_or_default()
            .to_owned();
        block.text.truncate(start);
        self.rows -= 1;
        if block.rows.len() <= evicted {
            if let Some(block) = self.blocks.pop_back() {
                self.held -= block.held().min(self.held);
            }
            if self.blocks.is_empty() {
                self.evicted = 0;
            }
        }
        Some((text, row.ending()))
    }

    /// Every row held, oldest first, as stored.
    #[cfg(test)]
    pub(crate) fn rows_for_test(&self) -> Vec<(String, Ending)> {
        let mut rows = Vec::new();
        for (index, block) in self.blocks.iter().enumerate() {
            let skip = if index == 0 { self.evicted } else { 0 };
            let mut start = skip
                .checked_sub(1)
                .and_then(|before| block.rows.get(before))
                .map_or(0, |r| r.end());
            for row in block.rows.iter().skip(skip) {
                let text = block.text.get(start..row.end()).unwrap_or_default();
                rows.push((text.to_owned(), row.ending()));
                start = row.end();
            }
        }
        rows
    }

    pub(crate) fn clear(&mut self) {
        self.blocks.clear();
        self.evicted = 0;
        self.rows = 0;
        self.held = 0;
    }

    /// Writes every row, oldest first.
    pub(crate) fn write(&self, lines: &mut Lines<'_>) {
        for (index, block) in self.blocks.iter().enumerate() {
            let skip = if index == 0 { self.evicted } else { 0 };
            let mut start = match skip.checked_sub(1) {
                Some(before) => block.rows.get(before).map_or(0, |r| r.end()),
                None => 0,
            };
            for row in block.rows.iter().skip(skip) {
                lines.row(
                    block.text.get(start..row.end()).unwrap_or_default(),
                    row.ending(),
                );
                start = row.end();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE_END: Ending = Ending {
        wrapped: false,
        spacer: false,
        wide_start: false,
    };
    const WRAPS: Ending = Ending {
        wrapped: true,
        ..LINE_END
    };
    const ANY_SIZE: usize = usize::MAX;
    const ALL: fn(&str) -> bool = |_| true;

    fn written(history: &History) -> String {
        let mut out = String::new();
        history.write(&mut Lines::new(&mut out));
        out
    }

    #[test]
    fn rows_are_written_oldest_first_and_a_wrapped_row_runs_into_the_next() {
        let mut history = History::new(10, ANY_SIZE);
        history.push("one", LINE_END);
        history.push("tw", WRAPS);
        history.push("o", LINE_END);
        assert_eq!(written(&history), "one\r\ntwo\r\n");
        assert_eq!(history.rows(), 3);
    }

    #[test]
    fn past_the_limit_the_oldest_rows_go_first() {
        let mut history = History::new(2, ANY_SIZE);
        for row in ["a", "b", "c", "d"] {
            history.push(row, LINE_END);
        }
        assert_eq!(written(&history), "c\r\nd\r\n");
        assert_eq!(history.rows(), 2);
    }

    #[test]
    fn a_block_is_freed_once_its_last_row_is_evicted() {
        // Two rows to a block.
        let row = "x".repeat(BLOCK_BYTES / 2);
        let mut history = History::new(3, ANY_SIZE);
        for _ in 0..4 {
            history.push(&row, LINE_END);
        }
        assert_eq!((history.blocks.len(), history.evicted), (2, 1));
        // The fifth evicts the first block's second row, and the block goes with it.
        history.push(&row, LINE_END);
        assert_eq!((history.blocks.len(), history.evicted), (2, 0));
        assert_eq!(history.rows(), 3);
        assert!(history.bytes() <= 2 * (BLOCK_BYTES + BLOCK_ROWS * size_of::<RowEnd>()));
    }

    #[test]
    fn rows_of_no_text_still_fill_blocks_that_eviction_frees() {
        let mut history = History::new(10, ANY_SIZE);
        for _ in 0..50 * BLOCK_ROWS {
            history.push("", LINE_END);
        }
        assert_eq!(history.rows(), 10);
        let two_blocks = 2 * (BLOCK_BYTES + BLOCK_ROWS * size_of::<RowEnd>());
        assert!(history.bytes() <= two_blocks, "{}", history.bytes());
    }

    #[test]
    fn past_its_bytes_the_oldest_blocks_go_first() {
        // Rows too long to share a block, and room for two blocks.
        let block = BLOCK_BYTES + BLOCK_ROWS * size_of::<RowEnd>();
        let mut history = History::new(10, 2 * block);
        let rows: Vec<String> = ["a", "b", "c"]
            .map(|c| c.repeat(BLOCK_BYTES / 2 + 1))
            .into();
        for row in &rows {
            history.push(row, LINE_END);
        }
        assert_eq!(history.rows(), 2);
        assert_eq!(written(&history), format!("{}\r\n{}\r\n", rows[1], rows[2]));
        assert!(history.bytes() <= 2 * block);
    }

    #[test]
    fn the_newest_line_comes_off_whole_and_in_order() {
        let mut history = History::new(3, ANY_SIZE);
        for (row, ending) in [
            ("gone", LINE_END),
            ("a", WRAPS),
            ("b", WRAPS),
            ("c", LINE_END),
        ] {
            history.push(row, ending);
        }
        history.push("d", WRAPS);
        assert_eq!(history.pop_line(10, ALL), vec![("d".to_owned(), WRAPS)]);
        let rows: Vec<_> = history
            .pop_line(10, ALL)
            .into_iter()
            .map(|(text, _)| text)
            .collect();
        assert_eq!(rows, ["b", "c"]);
        assert_eq!((history.rows(), written(&history)), (0, String::new()));
        assert_eq!(history.pop_line(10, ALL), []);
        history.push("e", LINE_END);
        assert_eq!(written(&history), "e\r\n");
    }

    #[test]
    fn a_line_longer_than_asked_for_comes_off_from_its_end() {
        let mut history = History::new(10, ANY_SIZE);
        for row in ["a", "b", "c"] {
            history.push(row, WRAPS);
        }
        history.push("d", LINE_END);
        let rows: Vec<_> = history
            .pop_line(2, ALL)
            .into_iter()
            .map(|(text, _)| text)
            .collect();
        assert_eq!(rows, ["c", "d"]);
        assert!(history.newest_wraps());
        assert_eq!(written(&history), "ab");
    }

    #[test]
    fn a_line_comes_off_no_further_than_the_row_that_is_enough() {
        let mut history = History::new(10, ANY_SIZE);
        for row in ["a", "bb", "ccc"] {
            history.push(row, WRAPS);
        }
        history.push("dddd", LINE_END);
        let mut bytes = 0;
        let rows: Vec<_> = history
            .pop_line(10, |row| {
                bytes += row.len();
                bytes < 7
            })
            .into_iter()
            .map(|(text, _)| text)
            .collect();
        assert_eq!(rows, ["ccc", "dddd"]);
        assert_eq!(written(&history), "abb");
    }

    #[test]
    fn clearing_empties_the_store() {
        let mut history = History::new(10, ANY_SIZE);
        history.push("a", LINE_END);
        history.clear();
        assert_eq!(written(&history), "");
        assert_eq!((history.rows(), history.bytes()), (0, 0));
    }

    #[test]
    fn a_limit_of_zero_keeps_nothing() {
        let mut history = History::new(0, ANY_SIZE);
        history.push("a", LINE_END);
        assert_eq!((history.rows(), written(&history)), (0, String::new()));
    }
}
