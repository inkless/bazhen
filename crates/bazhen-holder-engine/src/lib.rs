//! The terminal engine a holder keeps for its terminal: alacritty's emulator for the screen, and
//! a compact store for the history that has scrolled off it.
//!
//! alacritty stores every row at full width, so ten thousand rows of history cost tens of
//! megabytes. The engine keeps a few screens of scrollback in alacritty, and moves older rows
//! into [`History`](history::History) as SGR-encoded text, typically a tenth of the size.
//! History is counted in rows, as tmux's `history-limit` counts it, so its memory stays bounded
//! however long a line a program prints.

mod budget;
mod encode;
mod history;
mod seam;

#[cfg(test)]
mod differential;

use std::cell::RefCell;
use std::fmt;
use std::rc::Rc;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Grid, Row};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use alacritty_terminal::vte::{Parser, Perform as _};

use crate::budget::{Budget, Stop};
use crate::encode::{Ending, Lines, encode_row};
use crate::history::History;
use crate::seam::Utf8Seam;

/// A terminal's size in cells. The engine works at no fewer than 2 columns and 1 row, and no more
/// than 1,000 of either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

impl Size {
    /// alacritty indexes past the row when a wide char arrives in a one-column terminal, so the
    /// engine never has fewer than two; and it allocates every cell, 24 bytes each, so a size
    /// someone mistyped can't take gigabytes.
    fn usable(self) -> Self {
        Self {
            cols: self.cols.clamp(2, MOST_CELLS_A_SIDE),
            rows: self.rows.clamp(1, MOST_CELLS_A_SIDE),
        }
    }

    fn cols(self) -> usize {
        self.cols.into()
    }

    fn rows(self) -> usize {
        self.rows.into()
    }
}

const MOST_CELLS_A_SIDE: u16 = 1000;

/// How many rows of history an engine keeps, as tmux's `history-limit` counts them: wrapped rows
/// each count, so one long line can't take more than its share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryRows(pub usize);

/// The most bytes of history text an engine keeps, whatever the rows hold: 10,000 rows of text
/// drawn in a new colour every cell would otherwise take over 100 MB.
const MOST_HISTORY_BYTES: usize = 32 << 20;

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows()
    }

    fn screen_lines(&self) -> usize {
        self.rows()
    }

    fn columns(&self) -> usize {
        self.cols()
    }
}

/// What an engine holds in memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    /// alacritty's grids: their rows at full width.
    pub engine_bytes: usize,
    /// The history store, spare capacity included.
    pub history_bytes: usize,
    /// Rows of history, in the store and in alacritty's scrollback.
    pub history_rows: usize,
    /// Times alacritty's scrollback filled up, which may have dropped a row. Always zero unless
    /// the engine misjudged how far the stream could scroll.
    pub overflows: u64,
}

/// Collects what alacritty writes back to the program: its answers to CPR, DA and DSR.
#[derive(Debug, Clone, Default)]
struct Sink(Rc<RefCell<String>>);

impl EventListener for Sink {
    fn send_event(&self, event: Event) {
        if let Event::PtyWrite(reply) = event {
            self.0.borrow_mut().push_str(&reply);
        }
    }
}

/// A terminal's screen and history: the program's output goes in through [`Engine::advance`],
/// and what the terminal answers comes back through [`Engine::take_replies`].
pub struct Engine {
    term: Term<Sink>,
    parser: Processor,
    lookahead: Parser,
    budget: Budget,
    utf8: Utf8Seam,
    history: History,
    replies: Sink,
    size: Size,
    /// alacritty's scrollback limit for the primary grid.
    scrollback: usize,
    /// The row a drain leaves in alacritty's scrollback, encoded: alacritty keeps the primary grid
    /// private while the alternate screen is up.
    kept: Option<(String, Ending)>,
    encoded: String,
    overflows: u64,
}

impl fmt::Debug for Engine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Engine")
            .field("size", &self.size)
            .field("history", &self.history)
            .field("scrollback", &self.scrollback)
            .field("overflows", &self.overflows)
            .finish_non_exhaustive()
    }
}

impl Engine {
    /// An engine for a terminal of `size` that keeps up to `history` rows of history.
    pub fn new(size: Size, history: HistoryRows) -> Self {
        let size = size.usable();
        let budget = Budget::new(size.cols(), size.rows());
        let scrollback = scrollback_limit(&budget);
        let replies = Sink::default();
        let mut term = Term::new(config(scrollback), &size, replies.clone());
        *term.grid_mut() = presized(size.rows(), size.cols(), scrollback);
        Self {
            term,
            parser: Processor::new(),
            lookahead: Parser::new(),
            budget,
            utf8: Utf8Seam::default(),
            history: History::new(history.0, MOST_HISTORY_BYTES),
            replies,
            size,
            scrollback,
            kept: None,
            encoded: String::new(),
            overflows: 0,
        }
    }

    /// Feeds the program's output to the terminal.
    pub fn advance(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while !rest.is_empty() {
            let (finish, after) = self.utf8.finish(rest);
            if !finish.is_empty() {
                self.lookahead.advance(&mut self.budget, finish);
                self.parser.advance(&mut self.term, finish);
                rest = after;
                continue;
            }
            self.budget.start();
            let mut read = 0;
            while read < rest.len() && !self.budget.terminated() {
                let ahead = rest.get(read..).unwrap_or_default();
                let window = ahead
                    .get(..whole_chars(ahead, self.budget.room()))
                    .unwrap_or(ahead);
                let more = self
                    .lookahead
                    .advance_until_terminated(&mut self.budget, window);
                if more == 0 {
                    // vte reads at least a byte unless told to stop. If it ever doesn't, the
                    // read-ahead takes the window whole, so both parsers still see the same bytes.
                    self.lookahead.advance(&mut self.budget, window);
                    read += window.len();
                } else {
                    read += more;
                }
            }
            let (stretch, after) = rest.split_at_checked(read).unwrap_or((rest, &[]));
            let room = KEPT_ROWS + self.budget.scrolled() + 1;
            if room > self.scrollback && !self.alternate() {
                // A REP can scroll more than a stretch is sized for: room for it, until the
                // drain after it.
                self.scrollback = room;
                self.term.grid_mut().update_history(room);
            }
            let stop = self.budget.stop();
            let switch = (stop == Some(Stop::AltScreen) && !self.alternate())
                .then(|| stretch.iter().rposition(|&byte| byte == 0x1b))
                .flatten();
            if let Some((before, switch)) = switch.and_then(|at| stretch.split_at_checked(at)) {
                // The switch ends the stretch and starts at its last ESC: the rows the primary
                // screen scrolled before it are drained while alacritty still shows them.
                self.parse(before);
                self.drain();
                self.parse(switch);
            } else {
                self.parse(stretch);
            }
            self.utf8.note(stretch);
            match stop {
                Some(Stop::Reset) => self.clear_history(),
                Some(Stop::ClearHistory) if !self.alternate() => self.clear_history(),
                _ => {}
            }
            self.drain();
            rest = after;
        }
    }

    fn parse(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        if self.parser.sync_bytes_count() > 0 {
            // A synchronized update only holds back a frame, and a headless engine draws none:
            // buffering it would leave queries inside it unanswered.
            self.parser.stop_sync(&mut self.term);
        }
    }

    /// Resizes the terminal, reflowing it as alacritty does.
    ///
    /// Two ways the result can differ from a terminal that held all its history itself:
    /// - Blank cells and line breaks: the engine gives alacritty back the history a reflow pulls
    ///   from rewrapped from its text, where that terminal reflows its rows as they were. Every
    ///   cell that draws something is the same, and in the same order.
    /// - Under the alternate screen alacritty keeps the primary grid private, so the primary
    ///   screen reflows with only the row of history a drain leaves: on return it can differ,
    ///   and alacritty may drop rows below the primary's cursor.
    pub fn resize(&mut self, size: Size) {
        let size = size.usable();
        // A resize pulls rows back from history: a row-grow fills the new rows from it, and a
        // reflow that rejoins wrapped rows pulls rows down to keep the cursor's line, or drops
        // rows below the cursor if history runs out. A column-grow can join every `widen` rows
        // into one, so alacritty gets back enough of the store for the old screen and the new.
        if !self.alternate() {
            let widen = size.cols().div_ceil(self.size.cols()).max(1);
            let wanted = widen * (self.size.rows() + size.rows());
            let refilled = refill(self.term.grid_mut(), &mut self.history, wanted);
            self.scrollback = self.scrollback.max(refilled);
            self.kept = None;
        }
        // Reflow can split a row into one per cell it holds, and a row-shrink pushes up to a
        // screen into history: no row may fall off alacritty's scrollback before it's drained.
        // Under the alternate screen the limit stays raised until a drain, so each resize builds
        // on the last; past the cap, the overflow count says rows may have gone.
        let split = self
            .size
            .cols()
            .div_ceil(size.cols().saturating_sub(1).max(1));
        let room = self
            .scrollback
            .saturating_add(self.size.rows())
            .saturating_mul(split)
            .saturating_add(size.rows())
            .min(MOST_RESIZE_ROOM);
        self.set_scrollback(room);
        self.term.resize(size);
        mark_widened_rows(&mut self.term);
        self.size = size;
        self.budget.resize(size.cols(), size.rows());
        self.drain();
    }

    /// What the terminal wrote back to the program since the last call. They pile up until
    /// taken, so take them after every [`Engine::advance`].
    pub fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut *self.replies.0.borrow_mut()).into_bytes()
    }

    /// Appends the history, oldest row first, as VT text: one line after another, each ended by
    /// CRLF, so a viewer of any width rewraps each line as it reads it.
    pub fn write_history(&self, out: &mut String) {
        let mut lines = Lines::new(out);
        self.write_lines(&mut lines);
        lines.finish();
    }

    fn write_lines(&self, lines: &mut Lines<'_>) {
        self.history.write(lines);
        if !self.alternate() {
            write_scrollback(self.term.grid(), lines);
        } else if let Some((text, ending)) = &self.kept {
            lines.row(text, *ending);
        }
    }

    /// What the engine holds in memory, and how many rows of history.
    pub fn stats(&self) -> Stats {
        // The primary grid's screen and the scrollback its storage is sized for, and the
        // alternate screen: alacritty allocates every row at full width.
        let grids = self.scrollback + 2 * self.size.rows();
        let scrolled = if self.alternate() {
            usize::from(self.kept.is_some())
        } else {
            self.term.grid().history_size()
        };
        Stats {
            engine_bytes: grids * self.size.cols() * size_of::<Cell>(),
            history_bytes: self.history.bytes(),
            history_rows: self.history.rows() + scrolled,
            overflows: self.overflows,
        }
    }

    fn set_scrollback(&mut self, rows: usize) {
        self.scrollback = rows;
        if self.alternate() {
            self.term.set_options(config(rows));
        } else {
            self.term.grid_mut().update_history(rows);
        }
    }

    fn clear_history(&mut self) {
        self.history.clear();
        self.kept = None;
    }

    fn alternate(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    /// Moves alacritty's scrollback into the store, leaving it room for the next stretch.
    /// Only the primary grid has history, and it can't scroll while the alternate screen is up.
    fn drain(&mut self) {
        if self.alternate() {
            return;
        }
        let limit = scrollback_limit(&self.budget);
        let grid = self.term.grid_mut();
        if move_to_store(
            grid,
            &mut self.history,
            &mut self.encoded,
            &mut self.scrollback,
            limit,
        ) {
            self.overflows += 1;
        }
        let grid = self.term.grid();
        // The kept row changes only when a row scrolled after it, or history was cleared.
        if grid.history_size() != KEPT_ROWS || self.kept.is_none() {
            self.kept = (grid.history_size() > 0).then(|| {
                let mut text = String::new();
                let ending = encode_row(&grid[Line(-1)], &mut text);
                (text, ending)
            });
        }
    }
}

/// Moves `grid`'s scrollback but its newest row into `history`, and gives it room for `limit`
/// rows. Returns whether the scrollback was full, which may have lost a row.
fn move_to_store(
    grid: &mut Grid<Cell>,
    history: &mut History,
    encoded: &mut String,
    scrollback: &mut usize,
    limit: usize,
) -> bool {
    let scrolled = grid.history_size();
    // alacritty's clear screen looks back into history and, finding none, scrolls a row more
    // than it does with some: the newest row stays.
    let kept = scrolled.min(KEPT_ROWS);
    let moved = scrolled - kept;
    for n in 0..moved {
        encoded.clear();
        let wrapped = encode_row(&grid[scrollback_line(scrolled, n)], encoded);
        history.push(encoded, wrapped);
    }
    if *scrollback == limit {
        grid.update_history(kept);
        grid.update_history(limit);
    } else {
        // A REP or a resize raised the limit: storage sized to the usual one gives back the rest.
        let rows = (moved..scrolled)
            .map(|n| std::mem::take(&mut grid[scrollback_line(scrolled, n)]))
            .collect();
        replace_scrollback(grid, rows, limit);
    }
    let overflowed = scrolled >= *scrollback;
    *scrollback = limit;
    overflowed
}

/// `len`, or a little more so as not to end inside a char: vte loses bytes after a char split
/// across calls (see [`seam`]).
fn whole_chars(bytes: &[u8], len: usize) -> usize {
    let continuations = bytes
        .iter()
        .skip(len)
        .take(budget::MOST_CONTINUATIONS)
        .take_while(|&&byte| (0x80..0xc0).contains(&byte))
        .count();
    len + continuations
}

/// How many times the rows a resize needs a refill may take off the store to finish a line.
const REFILL_BOUND: usize = 8;

/// The most rows of scrollback a resize makes room for.
const MOST_RESIZE_ROOM: usize = 1 << 20;

/// The rows of scrollback a drain leaves in alacritty.
const KEPT_ROWS: usize = 1;

/// Room for the rows a drain leaves, the most one stretch can scroll, a row the bytes finishing
/// a split char may wrap before the next stretch counts, and one more, so a full scrollback means
/// a lost row.
fn scrollback_limit(budget: &Budget) -> usize {
    KEPT_ROWS + budget.most_rows_per_stretch() + 2
}

fn config(scrollback: usize) -> Config {
    Config {
        scrolling_history: scrollback,
        ..Config::default()
    }
}

/// The `n`th oldest row of a scrollback `scrolled` rows deep; `n` from `scrolled` up is the
/// screen. alacritty's grid indexing panics past its rows, so callers keep `n` below
/// `scrolled` plus the screen's rows, from the grid they index.
fn scrollback_line(scrolled: usize, n: usize) -> Line {
    let to_i32 = |v: usize| i32::try_from(v).unwrap_or(i32::MAX);
    Line(to_i32(n) - to_i32(scrolled))
}

/// alacritty's `Row::grow` widens a row with default cells but leaves its count of cells to
/// clear as it was, so a row that was filled with a background colour keeps those cells when it
/// is next cleared, and shows them when it is reused. Writing to a row's last cell makes the
/// next clear take the whole row. Only the active grid's rows can be reached.
fn mark_widened_rows(term: &mut Term<Sink>) {
    let grid = term.grid_mut();
    let scrolled = grid.history_size();
    for n in 0..scrolled + grid.screen_lines() {
        let row = &mut grid[scrollback_line(scrolled, n)];
        if let Some(last) = row.len().checked_sub(1) {
            let _: &mut Cell = &mut row[Column(last)];
        }
    }
}

/// Puts the newest lines of the store back into `grid`'s scrollback, rewrapped to its width,
/// until it holds `wanted` rows or the store is empty. A line that runs on from the store into
/// the scrollback comes back whole first, so that a reflow sees all of it. No more than
/// `REFILL_BOUND` times `wanted` stored rows come back, however long their lines: the rest of a
/// longer line stays in the store. Returns how many rows the scrollback holds.
fn refill(grid: &mut Grid<Cell>, history: &mut History, wanted: usize) -> usize {
    let cols = grid.columns();
    let mut got = grid.history_size();
    let mut left = REFILL_BOUND * wanted.max(1);
    let mut taken = Vec::new();
    let mut counter = RowCounter::new(cols);
    while left > 0 && (got < wanted || (taken.is_empty() && history.newest_wraps())) {
        let line = history.pop_line(left);
        if line.is_empty() {
            break;
        }
        left = left.saturating_sub(line.len());
        let mut text = String::new();
        write_rows(&mut Lines::new(&mut text), &line);
        got += counter.rows(&text);
        taken.push(line);
    }
    if taken.is_empty() {
        return got;
    }
    let mut text = String::new();
    let mut lines = Lines::new(&mut text);
    for line in taken.iter().rev() {
        write_rows(&mut lines, line);
    }
    write_scrollback(grid, &mut lines);
    let open = lines.is_open();
    let rows = rows_of(&text, cols, open);
    let refilled = rows.len();
    replace_scrollback(grid, rows, 0);
    refilled
}

fn write_rows(lines: &mut Lines<'_>, rows: &[(String, Ending)]) {
    for (text, ending) in rows {
        lines.row(text, *ending);
    }
}

/// Counts the rows alacritty draws lines in, with one terminal for every line counted: its
/// storage grows a thousand rows at a time, which a terminal per line would pay each time.
struct RowCounter {
    term: Term<Sink>,
    parser: Processor,
}

impl fmt::Debug for RowCounter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RowCounter").finish_non_exhaustive()
    }
}

impl RowCounter {
    fn new(cols: usize) -> Self {
        let size = Size {
            cols: u16::try_from(cols).unwrap_or(u16::MAX),
            rows: 1,
        };
        Self {
            term: Term::new(config(usize::MAX), &size, Sink::default()),
            parser: Processor::new(),
        }
    }

    /// The rows `text`, whole lines each ended by CRLF, takes.
    fn rows(&mut self, text: &str) -> usize {
        self.parser.advance(&mut self.term, text.as_bytes());
        let rows = self.term.grid().history_size();
        self.term.grid_mut().clear_history();
        rows
    }
}

/// The rows alacritty draws `text` in at `cols` wide. The last row of an open text, whose line
/// goes on, is kept and marked as wrapping, as alacritty marks it once the line goes on.
fn rows_of(text: &str, cols: usize, open: bool) -> Vec<Row<Cell>> {
    let size = Size {
        cols: u16::try_from(cols).unwrap_or(u16::MAX),
        rows: 1,
    };
    let mut term = Term::new(config(text.len() + 1), &size, Sink::default());
    Processor::<StdSyncHandler>::new().advance(&mut term, text.as_bytes());
    let grid = term.grid();
    let scrolled = grid.history_size();
    let mut rows: Vec<_> = (0..scrolled)
        .map(|n| grid[scrollback_line(scrolled, n)].clone())
        .collect();
    if open {
        let mut last = grid[Line(0)].clone();
        // A row that wraps with a cell to spare wrapped for a wide char that didn't fit: the
        // cell holds the spacer, which the text leaves unwritten.
        let spare = !grid.cursor.input_needs_wrap && grid.cursor.point.column.0 + 1 == cols;
        if let Some(cell) = last.last_mut() {
            cell.flags.insert(Flags::WRAPLINE);
            if spare {
                cell.flags.insert(Flags::LEADING_WIDE_CHAR_SPACER);
            }
        }
        rows.push(last);
    }
    rows
}

/// An empty grid whose storage already has `room` rows for scrollback.
///
/// alacritty grows a grid's storage by at least a thousand rows at a time, and keeps them while
/// fewer than a thousand go unused: for the few screens of scrollback the engine keeps, that
/// is 3.8 MB at 160 columns, and most of what each engine would cost. A grid made tall and then
/// shrunk to the screen keeps the rows it shrank off, and its scrollback grows into those.
fn presized(lines: usize, cols: usize, room: usize) -> Grid<Cell> {
    let mut grid = Grid::new(lines + room, cols, room);
    grid.resize(false, lines, cols);
    grid
}

/// Gives `grid` `rows` as its scrollback, with storage for `room` rows of it, keeping its screen
/// and cursors.
fn replace_scrollback(grid: &mut Grid<Cell>, rows: Vec<Row<Cell>>, room: usize) {
    let lines = grid.screen_lines();
    let screen = Line(0)..scrollback_line(0, lines);
    let mut rebuilt = presized(lines, grid.columns(), room.max(rows.len()));
    for row in rows {
        rebuilt[Line(0)] = row;
        rebuilt.scroll_up(&screen, 1);
    }
    for n in 0..lines {
        let line = scrollback_line(0, n);
        std::mem::swap(&mut rebuilt[line], &mut grid[line]);
    }
    rebuilt.cursor = grid.cursor.clone();
    rebuilt.saved_cursor = grid.saved_cursor.clone();
    *grid = rebuilt;
}

fn write_scrollback(grid: &Grid<Cell>, lines: &mut Lines<'_>) {
    let scrolled = grid.history_size();
    for n in 0..scrolled {
        lines.grid_row(&grid[scrollback_line(scrolled, n)]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: Size = Size { cols: 20, rows: 5 };

    fn history(engine: &mut Engine) -> String {
        let mut out = String::new();
        engine.write_history(&mut out);
        out
    }

    fn lines(range: std::ops::Range<usize>) -> String {
        range.map(|i| i.to_string() + "\r\n").collect()
    }

    fn screen(engine: &Engine) -> Vec<String> {
        let grid = engine.term.grid();
        (0..grid.screen_lines())
            .map(|n| {
                let mut text = String::new();
                encode_row(&grid[scrollback_line(0, n)], &mut text);
                text
            })
            .collect()
    }

    #[test]
    fn a_query_inside_a_synchronized_update_is_answered_at_once() {
        let mut engine = Engine::new(SIZE, HistoryRows(100));
        engine.advance(b"\x1b[?2026hxy\x1b[6n");
        assert_eq!(engine.take_replies(), b"\x1b[1;3R");
    }

    #[test]
    fn rows_that_leave_the_screen_move_to_the_store_in_order() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        engine.advance(lines(0..100).as_bytes());
        assert_eq!(history(&mut engine), lines(0..96));
        assert_eq!(engine.history.rows(), 95);
        assert_eq!(engine.term.grid().history_size(), KEPT_ROWS);
    }

    #[test]
    fn a_flood_in_one_read_overflows_nothing() {
        let mut engine = Engine::new(SIZE, HistoryRows(100_000));
        let flood = "\n".repeat(10_000) + &"\x1b[99S".repeat(1000) + &"x".repeat(50_000);
        engine.advance(flood.as_bytes());
        let stats = engine.stats();
        assert_eq!(stats.overflows, 0);
        // The first line feeds fill the screen, and the last row of x's is on it.
        let lines = 10_000 - (SIZE.rows() - 1);
        assert_eq!(
            stats.history_rows,
            lines + 1000 * SIZE.rows() + 50_000 / SIZE.cols() - 1
        );
    }

    #[test]
    fn the_history_limit_counts_rows_and_drops_the_oldest() {
        let mut engine = Engine::new(SIZE, HistoryRows(30));
        engine.advance(lines(0..200).as_bytes());
        assert_eq!(engine.history.rows(), 30);
        assert_eq!(history(&mut engine), lines(196 - 30 - KEPT_ROWS..196));
    }

    #[test]
    fn a_reset_clears_the_history_even_from_the_alternate_screen() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        engine.advance(lines(0..50).as_bytes());
        engine.advance(b"\x1b[?1049h\x1bcafter");
        assert_eq!(history(&mut engine), "");
    }

    #[test]
    fn clearing_history_clears_the_store_but_not_from_the_alternate_screen() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        engine.advance(lines(0..50).as_bytes());
        engine.advance(b"\x1b[?1049h\x1b[3J\x1b[?1049l");
        assert_eq!(history(&mut engine), lines(0..46));
        engine.advance(b"\x1b[3J");
        assert_eq!(history(&mut engine), "");
    }

    #[test]
    fn a_char_repeated_thousands_of_times_overflows_nothing() {
        let mut engine = Engine::new(Size { cols: 2, rows: 1 }, HistoryRows(100_000));
        engine.advance(b"x\x1b[65535b");
        let stats = engine.stats();
        assert_eq!(stats.overflows, 0);
        assert_eq!(stats.history_rows, 65_536 / 2 - 1);
    }

    #[test]
    fn under_the_alternate_screen_history_holds_what_scrolled_before_the_switch() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        // One read: the rows scroll and the switch follows in the same stretch.
        engine.advance((lines(0..50) + "\x1b[?1049hvim").as_bytes());
        assert_eq!(history(&mut engine), lines(0..46));
        assert_eq!(engine.stats().history_rows, 46);
    }

    #[test]
    fn a_thousand_lines_in_one_read_cross_stretches_in_order() {
        let mut engine = Engine::new(SIZE, HistoryRows(10_000));
        engine.advance(lines(0..1000).as_bytes());
        assert_eq!(history(&mut engine), lines(0..996));
    }

    #[test]
    fn widening_brings_back_enough_history_to_fill_the_screen() {
        let mut engine = Engine::new(Size { cols: 2, rows: 5 }, HistoryRows(1000));
        engine.advance("abcdefgh\r\n".repeat(30).as_bytes());
        engine.resize(SIZE);
        let screen = screen(&engine);
        assert_eq!(screen[..4], ["abcdefgh"; 4], "{screen:?}");
        let mut all = history(&mut engine);
        all.extend(
            screen
                .iter()
                .filter(|row| !row.is_empty())
                .map(|row| format!("{row}\r\n")),
        );
        assert_eq!(all, "abcdefgh\r\n".repeat(30));
    }

    #[test]
    fn a_row_coloured_before_a_widening_is_cleared_in_full_when_reused() {
        let mut term = Term::new(config(100), &Size { cols: 4, rows: 1 }, Sink::default());
        let mut parser = Processor::<StdSyncHandler>::new();
        parser.advance(&mut term, b"\x1b[41m\n\n\n\n");
        term.resize(Size { cols: 8, rows: 1 });
        mark_widened_rows(&mut term);
        // Clearing history leaves the widened rows for the next line feeds to reuse.
        parser.advance(&mut term, b"\x1b[0m\x1b[3J\n\n");
        let row = &term.grid()[Line(0)];
        assert!(row.into_iter().all(|cell| cell.bg == Cell::default().bg));
    }

    #[test]
    fn a_line_running_from_the_store_onto_the_screen_rejoins_when_widened() {
        let mut engine = Engine::new(Size { cols: 2, rows: 3 }, HistoryRows(1000));
        let line: String = ('a'..='z').cycle().take(60).collect();
        engine.advance(line.as_bytes());
        engine.resize(Size { cols: 20, rows: 3 });
        let rows: Vec<String> = line
            .as_bytes()
            .chunks(20)
            .map(|row| String::from_utf8_lossy(row).into_owned())
            .collect();
        assert_eq!(screen(&engine), rows);
        assert_eq!(history(&mut engine), "");
    }

    #[test]
    fn after_narrowing_a_flood_of_text_in_one_read_overflows_nothing() {
        let mut engine = Engine::new(SIZE, HistoryRows(100_000));
        engine.resize(Size { cols: 2, rows: 5 });
        engine.advance("x".repeat(2000).as_bytes());
        let stats = engine.stats();
        assert_eq!(stats.overflows, 0);
        assert_eq!(stats.history_rows, 2000 / 2 - 5);
    }
}
