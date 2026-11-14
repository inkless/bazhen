//! The rows that have left alacritty's scrollback, oldest first, each as the bytes
//! [`encode_row`](crate::encode::encode_row) wrote for it.
//!
//! Rows are packed into blocks so a row costs its bytes plus an offset, not an allocation; the
//! oldest row goes when the store holds more than its limit, and its block when it was the last.

use std::collections::VecDeque;

use crate::encode::Lines;

const BLOCK_BYTES: usize = 64 * 1024;

#[derive(Debug)]
struct Block {
    text: String,
    /// Where each row ends in `text`, and whether it wraps into the next.
    rows: Vec<RowEnd>,
}

/// Where a row ends in its block's text, and whether it wraps into the next row, in four bytes:
/// a store of short rows holds more of these than text.
#[derive(Debug, Clone, Copy)]
struct RowEnd(u32);

impl RowEnd {
    const WRAPPED: u32 = 1 << 31;

    fn new(end: usize, wrapped: bool) -> Self {
        // A block holds 64 KiB, or one row: never 2 GiB.
        let end = u32::try_from(end)
            .unwrap_or(Self::WRAPPED - 1)
            .min(Self::WRAPPED - 1);
        Self(if wrapped { end | Self::WRAPPED } else { end })
    }

    fn end(self) -> usize {
        usize::try_from(self.0 & !Self::WRAPPED).unwrap_or(usize::MAX)
    }

    fn wrapped(self) -> bool {
        self.0 & Self::WRAPPED != 0
    }
}

#[derive(Debug)]
pub(crate) struct History {
    blocks: VecDeque<Block>,
    /// Rows of the front block already evicted.
    evicted: usize,
    rows: usize,
    limit: usize,
}

impl History {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            blocks: VecDeque::new(),
            evicted: 0,
            rows: 0,
            limit,
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

    pub(crate) fn push(&mut self, row: &str, wrapped: bool) {
        let fits = self
            .blocks
            .back()
            .is_some_and(|b| b.text.len() + row.len() <= b.text.capacity());
        if !fits {
            self.blocks.push_back(Block {
                text: String::with_capacity(BLOCK_BYTES.max(row.len())),
                rows: Vec::new(),
            });
        }
        if let Some(block) = self.blocks.back_mut() {
            block.text.push_str(row);
            block.rows.push(RowEnd::new(block.text.len(), wrapped));
            self.rows += 1;
        }
        while self.rows > self.limit {
            self.evict();
        }
    }

    fn evict(&mut self) {
        let Some(front) = self.blocks.front() else {
            return;
        };
        self.evicted += 1;
        self.rows -= 1;
        if self.evicted >= front.rows.len() {
            self.blocks.pop_front();
            self.evicted = 0;
        }
    }

    pub(crate) fn clear(&mut self) {
        self.blocks.clear();
        self.evicted = 0;
        self.rows = 0;
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
                    row.wrapped(),
                );
                start = row.end();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE_END: bool = false;
    const WRAPS: bool = true;

    fn written(history: &History) -> String {
        let mut out = String::new();
        history.write(&mut Lines::new(&mut out));
        out
    }

    #[test]
    fn rows_are_written_oldest_first_and_a_wrapped_row_runs_into_the_next() {
        let mut history = History::new(10);
        history.push("one", LINE_END);
        history.push("tw", WRAPS);
        history.push("o", LINE_END);
        assert_eq!(written(&history), "one\r\ntwo\r\n");
        assert_eq!(history.rows(), 3);
    }

    #[test]
    fn past_the_limit_the_oldest_rows_go_first() {
        let mut history = History::new(2);
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
        let mut history = History::new(3);
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
    fn clearing_empties_the_store() {
        let mut history = History::new(10);
        history.push("a", LINE_END);
        history.clear();
        assert_eq!(written(&history), "");
        assert_eq!((history.rows(), history.bytes()), (0, 0));
    }

    #[test]
    fn a_limit_of_zero_keeps_nothing() {
        let mut history = History::new(0);
        history.push("a", LINE_END);
        assert_eq!((history.rows(), written(&history)), (0, String::new()));
    }
}
