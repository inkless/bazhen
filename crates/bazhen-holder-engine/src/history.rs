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
    /// The text of the rows held.
    text_bytes: usize,
    most_bytes: usize,
}

impl History {
    /// A store of at most `limit` rows, and of at most `most_bytes` bytes of their text: a row
    /// of text drawn in a new colour every cell runs to kilobytes.
    pub(crate) fn new(limit: usize, most_bytes: usize) -> Self {
        Self {
            blocks: VecDeque::new(),
            evicted: 0,
            rows: 0,
            limit,
            text_bytes: 0,
            most_bytes,
        }
    }

    pub(crate) fn rows(&self) -> usize {
        self.rows
    }

    /// The memory the store holds, spare capacity included.
    pub(crate) fn bytes(&self) -> usize {
        self.blocks
            .iter()
            .map(|b| b.text.capacity() + b.rows.capacity() * size_of::<RowEnd>())
            .sum()
    }

    pub(crate) fn push(&mut self, row: &str, ending: Ending) {
        let fits = self.blocks.back().is_some_and(|b| {
            b.text.len() + row.len() <= b.text.capacity() && b.rows.len() < BLOCK_ROWS
        });
        if !fits {
            self.blocks.push_back(Block {
                text: String::with_capacity(BLOCK_BYTES.max(row.len())),
                rows: Vec::new(),
            });
        }
        if let Some(block) = self.blocks.back_mut() {
            block.text.push_str(row);
            block.rows.push(RowEnd::new(block.text.len(), ending));
            self.rows += 1;
            self.text_bytes += row.len();
        }
        while self.rows > self.limit || self.text_bytes > self.most_bytes {
            self.evict();
        }
    }

    fn evict(&mut self) {
        let Some(front) = self.blocks.front() else {
            return;
        };
        let end = |n: Option<usize>| n.and_then(|n| front.rows.get(n)).map_or(0, |r| r.end());
        let length = end(Some(self.evicted)) - end(self.evicted.checked_sub(1));
        self.text_bytes -= length.min(self.text_bytes);
        self.evicted += 1;
        self.rows -= 1;
        if self.evicted >= front.rows.len() {
            self.blocks.pop_front();
            self.evicted = 0;
        }
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
        self.text_bytes = 0;
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
        assert!(history.bytes() <= 2 * (BLOCK_BYTES + 1024));
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
    fn past_its_bytes_the_oldest_rows_go_first() {
        let mut history = History::new(10, 5);
        for row in ["ab", "cd", "ef"] {
            history.push(row, LINE_END);
        }
        assert_eq!(written(&history), "cd\r\nef\r\n");
        assert_eq!(history.rows(), 2);
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
