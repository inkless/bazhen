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
use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::Processor;
use alacritty_terminal::vte::{Parser, Perform as _};

use crate::budget::{Budget, Stop};
use crate::encode::{Lines, encode_row};
use crate::history::History;
use crate::seam::Utf8Seam;

/// A terminal's size in cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

impl Size {
    /// alacritty indexes past the row when a wide char arrives in a one-column terminal, so the
    /// engine never has fewer than two.
    fn usable(self) -> Self {
        Self {
            cols: self.cols.max(2),
            rows: self.rows.max(1),
        }
    }

    fn cols(self) -> usize {
        self.cols.into()
    }

    fn rows(self) -> usize {
        self.rows.into()
    }
}

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

/// What an engine holds, for `bazhen doctor`.
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
    /// The row a drain leaves in alacritty's scrollback, encoded, and whether it wraps: alacritty
    /// keeps the primary grid private while the alternate screen is up.
    kept: Option<(String, bool)>,
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
    /// An engine for a terminal of `size` that keeps up to `history_rows` rows of history.
    pub fn new(size: Size, history_rows: usize) -> Self {
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
            history: History::new(history_rows),
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
                    // vte reads a byte whenever it isn't told to stop; were it not to, both
                    // parsers must still see the same bytes.
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
                Some(Stop::Reset) => self.history.clear(),
                Some(Stop::ClearHistory) if !self.alternate() => self.history.clear(),
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

    /// What the terminal wrote back to the program since the last call.
    pub fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut *self.replies.0.borrow_mut()).into_bytes()
    }

    /// Appends the history, oldest row first, as VT text: one line after another, each ended by
    /// CRLF, so a viewer of any width rewraps each line as it reads it.
    pub fn write_history(&self, out: &mut String) {
        self.write_lines(&mut Lines::new(out));
    }

    fn write_lines(&self, lines: &mut Lines<'_>) {
        self.history.write(lines);
        if !self.alternate() {
            write_scrollback(self.term.grid(), lines);
        } else if let Some((text, wrapped)) = &self.kept {
            lines.row(text, *wrapped);
        }
    }

    pub fn stats(&self) -> Stats {
        // The primary grid's screen and the scrollback its storage is sized for, and the
        // alternate screen: alacritty allocates every row at full width.
        let grids = self.scrollback + 2 * self.size.rows();
        let scrolled = if self.alternate() {
            0
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
        self.kept = (grid.history_size() > 0).then(|| {
            let mut text = String::new();
            let wrapped = encode_row(&grid[Line(-1)], &mut text);
            (text, wrapped)
        });
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
    grid.update_history(kept);
    grid.update_history(limit);
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

/// The rows of scrollback a drain leaves in alacritty.
const KEPT_ROWS: usize = 1;

/// Room for the rows a drain leaves, the most one stretch can scroll, and one more, so a full
/// scrollback means a lost row.
fn scrollback_limit(budget: &Budget) -> usize {
    KEPT_ROWS + budget.most_rows_per_stretch() + 1
}

fn config(scrollback: usize) -> Config {
    Config {
        scrolling_history: scrollback,
        ..Config::default()
    }
}

/// The `n`th oldest row of a scrollback `scrolled` rows deep.
fn scrollback_line(scrolled: usize, n: usize) -> Line {
    let to_i32 = |v: usize| i32::try_from(v).unwrap_or(i32::MAX);
    Line(to_i32(n) - to_i32(scrolled))
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

    #[test]
    fn a_query_inside_a_synchronized_update_is_answered_at_once() {
        let mut engine = Engine::new(SIZE, 100);
        engine.advance(b"\x1b[?2026hxy\x1b[6n");
        assert_eq!(engine.take_replies(), b"\x1b[1;3R");
    }

    #[test]
    fn rows_that_leave_the_screen_move_to_the_store_in_order() {
        let mut engine = Engine::new(SIZE, 1000);
        engine.advance(lines(0..100).as_bytes());
        assert_eq!(history(&mut engine), lines(0..96));
        assert_eq!(engine.history.rows(), 95);
        assert_eq!(engine.term.grid().history_size(), KEPT_ROWS);
    }

    #[test]
    fn a_flood_in_one_read_overflows_nothing() {
        let mut engine = Engine::new(SIZE, 100_000);
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
        let mut engine = Engine::new(SIZE, 30);
        engine.advance(lines(0..200).as_bytes());
        assert_eq!(engine.history.rows(), 30);
        assert_eq!(history(&mut engine), lines(196 - 30 - KEPT_ROWS..196));
    }

    #[test]
    fn a_reset_clears_the_history_even_from_the_alternate_screen() {
        let mut engine = Engine::new(SIZE, 1000);
        engine.advance(lines(0..50).as_bytes());
        engine.advance(b"\x1b[?1049h\x1bcafter");
        assert_eq!(history(&mut engine), "");
    }

    #[test]
    fn clearing_history_clears_the_store_but_not_from_the_alternate_screen() {
        let mut engine = Engine::new(SIZE, 1000);
        engine.advance(lines(0..50).as_bytes());
        engine.advance(b"\x1b[?1049h\x1b[3J\x1b[?1049l");
        assert_eq!(history(&mut engine), lines(0..46));
        engine.advance(b"\x1b[3J");
        assert_eq!(history(&mut engine), "");
    }

    #[test]
    fn a_char_repeated_thousands_of_times_overflows_nothing() {
        let mut engine = Engine::new(Size { cols: 2, rows: 1 }, 100_000);
        engine.advance(b"x\x1b[65535b");
        let stats = engine.stats();
        assert_eq!(stats.overflows, 0);
        assert_eq!(stats.history_rows, 65_536 / 2 - 1);
    }
}
