//! The terminal engine a holder keeps for its terminal: alacritty's emulator for the screen, and
//! a compact store for the history that has scrolled off it.
//!
//! alacritty stores every row at full width, so ten thousand rows of history cost tens of
//! megabytes. The engine keeps a few screens of scrollback in alacritty, and moves older rows
//! into [`History`](history::History) as SGR-encoded text, typically a tenth of the size.
//! History is counted in rows, as tmux's `history-limit` counts it, so its memory stays bounded
//! however long a line a program prints.

mod budget;
mod capped;
mod encode;
mod history;
mod modes;
mod osc;
mod replies;
mod seam;
mod snapshot;

#[cfg(test)]
mod differential;

use std::fmt;

use alacritty_terminal::grid::{Dimensions, Grid, Row};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use alacritty_terminal::vte::{Parser, Perform as _};

use crate::budget::{Budget, Stop};
use crate::capped::Capped;
use crate::encode::{Ending, Lines, encode_row};
use crate::history::History;
use crate::modes::Tracker;
pub use crate::modes::{
    ActiveCharset, Charset, CursorModes, CursorStyle, KeyMode, Keys, KittyFlags, LineFeed, Modes,
    Mouse, MouseEncoding, MouseTracking, Origin, Screen, Shape,
};
use crate::osc::OscCap;
use crate::replies::Sink;
pub use crate::replies::{Colours, MOST_REPLY_BYTES, Rgb, replies_are_whole};
use crate::seam::Utf8Seam;
pub use crate::snapshot::TooLarge;

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
/// each count, so one long line can't take more than its share, and 0 keeps none.
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
    /// Replies dropped because those before them went untaken.
    pub dropped_replies: u64,
}

/// A terminal's screen and history: the program's output goes in through [`Engine::advance`],
/// and what the terminal answers comes back through [`Engine::take_replies`].
pub struct Engine {
    term: Term<Sink>,
    parser: Processor,
    lookahead: Parser,
    budget: Budget,
    osc: OscCap,
    utf8: Utf8Seam,
    history: History,
    tracker: Tracker,
    replies: Sink,
    size: Size,
    /// alacritty's scrollback limit for the primary grid.
    scrollback: usize,
    history_rows: HistoryRows,
    /// The row a drain leaves in alacritty's scrollback, encoded: alacritty keeps the primary grid
    /// private while the alternate screen is up.
    kept: Option<(String, Ending)>,
    /// The primary grid's rows and cells when the alternate screen came up: a reflow while it's
    /// up redraws them at another width, but adds nothing.
    primary: Primary,
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
            osc: OscCap::default(),
            utf8: Utf8Seam::default(),
            history: History::new(history.0.saturating_sub(KEPT_ROWS), MOST_HISTORY_BYTES),
            tracker: Tracker::new(size.cols(), size.rows()),
            history_rows: history,
            replies,
            size,
            scrollback,
            kept: None,
            primary: Primary::default(),
            encoded: String::new(),
            overflows: 0,
        }
    }

    /// Feeds the program's output to the terminal.
    pub fn advance(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while !rest.is_empty() {
            let (keep, drop) = self.osc.split(rest);
            let (passed, after) = rest.split_at_checked(keep).unwrap_or((rest, &[]));
            self.advance_passed(passed);
            rest = after.get(drop..).unwrap_or_default();
        }
    }

    fn advance_passed(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while !rest.is_empty() {
            let (finish, _) = self.utf8.finish(rest);
            self.budget.start();
            let finishing = !finish.is_empty();
            let mut read = 0;
            if finishing {
                // Parsed on their own, and a stretch of their own: they may end a sequence, a REP
                // or a switch to the alternate screen, as much as finish a char.
                self.lookahead.advance(&mut self.budget, finish);
                read = finish.len();
            }
            while !finishing && read < rest.len() && !self.budget.terminated() {
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
            let switch = (stop == Some(Stop::AltScreen) && !self.alternate()).then(|| {
                // The switch ends the stretch and starts at its last ESC, or in an earlier read.
                let at = stretch.iter().rposition(|&byte| byte == 0x1b).unwrap_or(0);
                stretch.split_at(at)
            });
            if let Some((before, switch)) = switch {
                // The rows the primary screen scrolled before the switch are drained while
                // alacritty still shows them, and the one it keeps is copied.
                self.parse(before);
                self.drain();
                self.keep_newest();
                self.parse(switch);
            } else {
                self.parse(stretch);
            }
            if !finishing {
                self.utf8.note(stretch);
            }
            match stop {
                Some(Stop::Reset) => self.clear_history(),
                // alacritty keeps 4,096 titles; the engine undoes a push past its own limit.
                Some(Stop::TitlePush) => self.parse(b"\x1b[23t"),
                // Answered as the stretch ends at it, after every query before it.
                Some(Stop::Version) => self.replies.push(replies::VERSION),
                Some(Stop::ClearHistory) if !self.alternate() => self.clear_history(),
                _ => {}
            }
            self.drain();
            rest = after;
        }
    }

    fn parse(&mut self, bytes: &[u8]) {
        self.parser.advance(
            &mut Capped(&mut self.term, &mut self.tracker, &self.replies),
            bytes,
        );
        if self.parser.sync_bytes_count() > 0 {
            // A synchronized update only holds back a frame, and a headless engine draws none:
            // buffering it would leave queries inside it unanswered.
            self.parser.stop_sync(&mut Capped(
                &mut self.term,
                &mut self.tracker,
                &self.replies,
            ));
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
    ///
    /// Under the alternate screen, the primary's saved cursor is made its cursor again, as the
    /// reflow left it: xterm's meaning, where `?1049h` saves the cursor it switches from.
    /// alacritty reflows the cursor and only clamps the saved one, so they would part.
    pub fn resize(&mut self, size: Size) {
        let size = size.usable();
        if size == self.size {
            // alacritty doesn't reflow to the size it has either.
            return;
        }
        let room = if self.alternate() {
            self.primary.room(size)
        } else {
            self.refill_for(size);
            self.kept = None;
            // Reflow can split a row into one per cell it holds, and a row-shrink pushes up to a
            // screen into history: no row may fall off alacritty's scrollback before it's
            // drained. Past the cap, the overflow count says rows may have gone.
            let split = self
                .size
                .cols()
                .div_ceil(size.cols().saturating_sub(1).max(1));
            self.scrollback
                .saturating_add(self.size.rows())
                .saturating_mul(split)
                .saturating_add(size.rows())
                .min(MOST_RESIZE_ROOM)
        };
        self.set_scrollback(room);
        self.term.resize(size);
        // Brought into reach and put back, which sets the primary's saved cursor to its cursor.
        drop(PrimaryShown::new(&mut self.term));
        mark_widened_rows(&mut self.term);
        self.tracker.resize(
            (self.size.cols(), self.size.rows()),
            (size.cols(), size.rows()),
        );
        self.size = size;
        self.budget.resize(size.cols(), size.rows());
        self.drain();
    }

    /// What the terminal wrote back to the program since the last call. They pile up until
    /// taken, so take them after every [`Engine::advance`]: from the first that would take them
    /// past [`MOST_REPLY_BYTES`], every reply is dropped whole until the next take.
    pub fn take_replies(&mut self) -> Vec<u8> {
        self.replies.take()
    }

    /// The text and background a program that asks (OSC 10 and 11) is told, unless it set its
    /// own. With none, those queries go unanswered.
    pub fn set_colours(&mut self, colours: Option<Colours>) {
        self.replies.set_colours(colours);
    }

    /// Appends the history, oldest row first, as VT text: one line after another, each ended by
    /// CRLF, so a viewer of any width rewraps each line as it reads it.
    pub fn write_history(&self, out: &mut String) {
        let mut lines = Lines::new(out);
        self.write_lines(&mut lines);
        lines.finish();
    }

    fn write_lines(&self, lines: &mut Lines<'_>) {
        // With no history kept, the row a drain leaves in alacritty isn't history either.
        if self.history_rows.0 == 0 {
            return;
        }
        self.history.write(lines);
        if !self.alternate() {
            write_scrollback(self.term.grid(), lines);
        } else if let Some((text, ending)) = &self.kept {
            lines.row(text, *ending);
        }
    }

    /// The title the program set, if it set one.
    pub fn title(&self) -> Option<&str> {
        self.tracker.title()
    }

    /// The modes the program has set.
    pub fn modes(&self) -> Modes {
        self.tracker.modes(&self.term)
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
            history_rows: (self.history.rows() + scrolled).min(self.history_rows.0),
            overflows: self.overflows,
            dropped_replies: self.replies.dropped(),
        }
    }

    /// Gives alacritty back the newest lines of the store a resize to `size` may pull from
    /// history: a row-grow fills the new rows from it, and a reflow that rejoins wrapped rows
    /// pulls rows down to keep the cursor's line, or drops rows below the cursor if history runs
    /// out. Enough for the old screen and the new, counted at the new width: at the old one, a
    /// widening would take as many more rows as it joins into one.
    fn refill_for(&mut self, size: Size) {
        self.refill_within(size, MOST_REFILL_CELLS);
    }

    /// [`Engine::refill_for`], taking back no more than `most_cells`.
    fn refill_within(&mut self, size: Size, most_cells: usize) {
        let wanted = self.size.rows() + size.rows();
        let grid = self.term.grid_mut();
        let refilled = refill(grid, &mut self.history, wanted, size.cols(), most_cells);
        self.scrollback = self.scrollback.max(refilled);
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
    }

    /// Copies the row a drain leaves in alacritty's scrollback, for the alternate screen to
    /// serve. Only then: the row changes without scrolling, as when the wide char under it is
    /// overwritten and alacritty unmarks the spacer it ends in.
    fn keep_newest(&mut self) {
        let grid = self.term.grid();
        let rows = grid.history_size() + grid.screen_lines();
        self.primary = Primary {
            rows,
            cells: rows * grid.columns(),
        };
        self.kept = (grid.history_size() > 0).then(|| {
            let mut text = String::new();
            let ending = encode_row(&grid[Line(-1)], &mut text);
            (text, ending)
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

/// The stored rows a refill may take however small the screens: a line wrapped over many rows of
/// a small screen, a long command at a prompt, comes back whole, so the reflow keeps its cursor in
/// place. `MOST_REFILL_CELLS` still bounds them.
const LEAST_REFILL_ROWS: usize = 4096;

/// The most cells a refill gives back: the old screen and the new at the largest size, 48 MB in
/// alacritty.
const MOST_REFILL_CELLS: usize = 1 << 21;

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

/// The primary grid, brought into reach while the alternate screen is up, and put back when this
/// is dropped, however that happens: alacritty keeps it in a private field.
///
/// The alternate grid is moved out, and alacritty's `swap_alt` from the alternate screen, a plain
/// swap, shows the primary. To put it back, `swap_alt` from the primary screen hands the primary's
/// cursor to the grid shown (a stand-in, which is then dropped for the alternate grid) and sets
/// the primary's saved cursor to its cursor. Under the alternate screen they are already equal,
/// set so at the switch and by [`Engine::resize`], so nothing changes.
pub(crate) struct PrimaryShown<'a> {
    term: &'a mut Term<Sink>,
    alternate: Option<Grid<Cell>>,
}

impl fmt::Debug for PrimaryShown<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PrimaryShown").finish_non_exhaustive()
    }
}

impl<'a> PrimaryShown<'a> {
    /// `None` with the primary screen already up.
    pub(crate) fn new(term: &'a mut Term<Sink>) -> Option<Self> {
        if !term.mode().contains(TermMode::ALT_SCREEN) {
            return None;
        }
        let alternate = std::mem::replace(term.grid_mut(), Grid::new(1, 2, 0));
        term.swap_alt();
        Some(Self {
            term,
            alternate: Some(alternate),
        })
    }

    pub(crate) fn grid(&self) -> &Grid<Cell> {
        self.term.grid()
    }
}

impl Drop for PrimaryShown<'_> {
    fn drop(&mut self) {
        self.term.swap_alt();
        if let Some(alternate) = self.alternate.take() {
            *self.term.grid_mut() = alternate;
        }
    }
}

/// The primary grid while the alternate screen is up.
#[derive(Debug, Default, Clone, Copy)]
struct Primary {
    rows: usize,
    cells: usize,
}

impl Primary {
    /// The scrollback the primary grid needs at `size`. Its rows hold no more than its cells,
    /// at a cell a row less for a wide char that doesn't fit, plus a row for each line's end:
    /// however many resizes came before, as many as the next row-shrink pushes into history.
    fn room(self, size: Size) -> usize {
        let per_row = size.cols().saturating_sub(1).max(1);
        self.cells
            .div_ceil(per_row)
            .saturating_add(self.rows)
            .saturating_add(size.rows())
            .min(MOST_RESIZE_ROOM)
    }
}

/// Puts the newest lines of the store back into `grid`'s scrollback, rewrapped to its width,
/// until it holds `wanted` rows at `cols` wide, the width it's about to take, or the store is
/// empty. A line that runs on from the store into the scrollback comes back whole first, so that
/// a reflow sees all of it. No more than `REFILL_BOUND` times `wanted` stored rows come back, or
/// `LEAST_REFILL_ROWS`, nor more than `most_cells` cells, however long their lines: the rest of a
/// longer line stays in the store. Returns how many rows the scrollback holds.
fn refill(
    grid: &mut Grid<Cell>,
    history: &mut History,
    wanted: usize,
    cols: usize,
    most_cells: usize,
) -> usize {
    let mut got = grid.history_size();
    let mut left = (REFILL_BOUND * wanted).max(LEAST_REFILL_ROWS);
    let mut cells_left = most_cells;
    let mut taken = Vec::new();
    let mut counter = RowCounter::new(cols);
    while left > 0
        && cells_left > 0
        && (got < wanted || (taken.is_empty() && history.newest_wraps()))
    {
        // Counted as it comes off: a line of a minified file can run to thousands of rows.
        let line = history.pop_line(left, |row| {
            cells_left = cells_left.saturating_sub(encode::cells(row));
            cells_left > 0
        });
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
    // Rows at the width the grid has: alacritty reflows them to the new one.
    let rows = rows_of(&text, grid.columns(), open);
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
    let mut parser = Processor::<StdSyncHandler>::new();
    for line in text.split_inclusive("\r\n") {
        let (line, ends) = line
            .strip_suffix("\r\n")
            .map_or((line, false), |line| (line, true));
        parser.advance(&mut term, line.as_bytes());
        // A wrap that scrolls fills the new row with the pen's background, which the cells
        // past a line's end never had: they go back to blank, unless the line filled its row.
        // The last line, if it goes on, is no different: its row is marked as wrapping, and
        // the reflow would take them for the line's.
        if !term.grid().cursor.input_needs_wrap {
            parser.advance(&mut term, b"\x1b[0m\x1b[K");
        }
        if ends {
            parser.advance(&mut term, b"\r\n");
        }
    }
    let grid = term.grid_mut();
    let scrolled = grid.history_size();
    // Moved, not copied: a refill's rows can take tens of megabytes.
    let mut rows: Vec<_> = (0..scrolled)
        .map(|n| std::mem::take(&mut grid[scrollback_line(scrolled, n)]))
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
    use std::cell::RefCell;
    use std::fmt::Write as _;

    use alacritty_terminal::index::Column;

    use super::*;

    const SIZE: Size = Size { cols: 20, rows: 5 };

    thread_local! {
        /// The last title alacritty set, on this test's thread.
        pub(crate) static TITLE: RefCell<String> = const { RefCell::new(String::new()) };
    }

    fn history(engine: &mut Engine) -> String {
        let mut out = String::new();
        engine.write_history(&mut out);
        out
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

    fn lines(range: std::ops::Range<usize>) -> String {
        range.map(|i| i.to_string() + "\r\n").collect()
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
        assert_eq!(engine.history.rows(), 96 - KEPT_ROWS);
        assert_eq!(engine.term.grid().history_size(), KEPT_ROWS);
    }

    #[test]
    fn a_flood_in_one_read_overflows_nothing() {
        let mut engine = Engine::new(SIZE, HistoryRows(20_000));
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
        assert_eq!(engine.stats().history_rows, 30);
        assert_eq!(history(&mut engine), lines(196 - 30..196));
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
        let mut engine = Engine::new(Size { cols: 2, rows: 1 }, HistoryRows(40_000));
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
    fn a_history_limit_of_zero_keeps_nothing() {
        let mut engine = Engine::new(SIZE, HistoryRows(0));
        engine.advance(lines(0..50).as_bytes());
        assert_eq!(history(&mut engine), "");
        assert_eq!(engine.stats().history_rows, 0);
    }

    #[test]
    fn under_the_alternate_screen_history_holds_what_scrolled_in_every_read_before() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        engine.advance(lines(0..50).as_bytes());
        engine.advance(lines(50..60).as_bytes());
        engine.advance(b"\x1b[?1049hvim");
        assert_eq!(history(&mut engine), lines(0..56));
    }

    #[test]
    fn under_the_alternate_screen_history_holds_the_newest_row_as_it_was_at_the_switch() {
        let mut engine = Engine::new(Size { cols: 4, rows: 2 }, HistoryRows(100));
        // 文 doesn't fit after abc: the row ends in a spacer, in blue, and scrolls away.
        engine.advance("\x1b[44mabc文\r\n".as_bytes());
        // Overwriting 文 unmarks the spacer, in a row already scrolled.
        engine.advance(b"\x1b[Hx");
        let before = history(&mut engine);
        engine.advance(b"\x1b[?1049h");
        assert_eq!(history(&mut engine), before);
    }

    #[test]
    fn a_repeat_the_bytes_finishing_a_split_char_end_still_has_room_for_its_rows() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        // A lead byte inside the CSI: the next read's first bytes finish it, and they hold the
        // REP's final byte, which scrolls 400 rows.
        engine.advance(b"x\x1b[8104\xe6");
        engine.advance(b"b");
        let stats = engine.stats();
        assert_eq!((stats.overflows, stats.history_rows), (0, 8105 / 20 - 4));
    }

    #[test]
    fn a_char_split_across_reads_that_scrolls_a_row_still_keeps_history_to_its_limit() {
        let mut engine = Engine::new(Size { cols: 2, rows: 2 }, HistoryRows(1));
        engine.advance(b"xyabcd\xe4");
        // 中 wraps the line, and ab scrolls after xy.
        engine.advance(b"\xb8\xad");
        assert_eq!(history(&mut engine), "ab");
    }

    #[test]
    fn a_cell_holds_no_more_than_tmux_s_21_bytes_of_marks() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        // Two marks fit; a flood of repeats adds none past the cap.
        engine.advance("e\u{301}\u{302}".as_bytes());
        let cell = engine.term.grid()[Line(0)][Column(0)].clone();
        assert_eq!(cell.zerowidth(), Some(&['\u{301}', '\u{302}'][..]));
        engine.advance(&"\x1b[65535b".repeat(64).into_bytes());
        let cell = &engine.term.grid()[Line(0)][Column(0)];
        let marks: usize = cell
            .zerowidth()
            .unwrap_or_default()
            .iter()
            .map(|c| c.len_utf8())
            .sum();
        assert!(
            cell.c.len_utf8() + marks <= capped::MOST_CELL_BYTES,
            "{marks}"
        );
        assert_eq!(engine.term.grid().cursor.point.column, Column(1));
    }

    #[test]
    fn a_title_past_the_osc_cap_arrives_cut_short() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        let title = "x".repeat(64 * 1024);
        engine.advance(format!("\x1b]0;{title}\x07").as_bytes());
        // The payload starts `0;`.
        let got = TITLE.with_borrow(String::len);
        assert_eq!(got, osc::MOST_OSC_BYTES - 2);
    }

    #[test]
    fn a_link_is_kept_on_no_cell() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        engine.advance(b"\x1b]8;;https://example.com\x07a\x1b]8;;\x07");
        let cell = &engine.term.grid()[Line(0)][Column(0)];
        assert_eq!((cell.c, cell.hyperlink()), ('a', None));
    }

    #[test]
    fn marks_on_a_wide_char_count_its_bytes_not_its_spacer_s() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        engine.advance(
            "中"
                .bytes()
                .chain("\u{301}".repeat(20).bytes())
                .collect::<Vec<_>>()
                .as_slice(),
        );
        let cell = &engine.term.grid()[Line(0)][Column(0)];
        // 中 takes 3 bytes and each mark 2: 9 fit in 21.
        assert_eq!(cell.zerowidth().map(<[char]>::len), Some(9));
    }

    #[test]
    fn marks_on_the_last_cell_of_a_row_waiting_to_wrap_count_that_cell_s_bytes() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        engine.advance("x".repeat(19).as_bytes());
        engine.advance("\u{301}".repeat(20).as_bytes());
        engine.advance("y".as_bytes());
        engine.advance("\u{301}".repeat(20).as_bytes());
        let row = &engine.term.grid()[Line(0)];
        let marks = |column: usize| row[Column(column)].zerowidth().map(<[char]>::len);
        // The cursor waits on y, the last cell, and its marks go on it: 10 fit beside it.
        assert_eq!((marks(18), marks(19)), (Some(10), Some(10)));
    }

    #[test]
    fn an_osc_string_with_no_end_still_lets_the_output_after_it_through() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        engine.advance(b"\x1b]0;");
        for _ in 0..64 {
            engine.advance("y\n".repeat(32 * 1024).as_bytes());
        }
        engine.advance(b"\x07done");
        assert_eq!(screen(&engine)[0], "done");
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
        let mut engine = Engine::new(Size { cols: 4, rows: 3 }, HistoryRows(100));
        engine.advance(b"\x1b[41m\n\n\n\n");
        engine.resize(Size { cols: 8, rows: 3 });
        engine.advance(b"\x1b[0m");
        // Once the line feeds have gone round alacritty's storage, they reuse the rows drawn red,
        // and each must come in cleared.
        for feed in 0..300 {
            engine.advance(b"\n");
            let row = &engine.term.grid()[Line(2)];
            let red = row.into_iter().any(|cell| cell.bg != Cell::default().bg);
            assert!(!red, "line feed {feed}");
        }
    }

    #[test]
    fn a_widening_gives_back_the_rows_it_needs_counted_at_the_new_width() {
        let mut engine = Engine::new(Size { cols: 2, rows: 1 }, HistoryRows(10_000));
        engine.advance("ab\r\n".repeat(10_000).as_bytes());
        engine.refill_for(Size {
            cols: 1000,
            rows: 1000,
        });
        // A row a line at either width: the old screen's and the new's. Counted at the old
        // width, a widening 500 times over would take every row.
        assert_eq!(engine.term.grid().history_size(), 1 + 1000);
    }

    #[test]
    fn a_line_thousands_of_rows_long_comes_back_only_as_far_as_a_resize_needs() {
        // A minified file, 900 rows of one line in the store, against a budget of 40 rows: at the
        // largest size, 2^21 cells against 9,000 rows of 24 KB each.
        let size = Size {
            cols: 100,
            rows: 100,
        };
        let mut engine = Engine::new(size, HistoryRows(1000));
        engine.advance("x".repeat(1000 * 100).as_bytes());
        let budget = 40 * 100;
        engine.refill_within(
            Size {
                cols: 99,
                rows: 100,
            },
            budget,
        );
        // The budget's rows, and the rows at either end of them: the one that goes past, the one
        // a drain leaves, and the last, which goes on.
        let rows = engine.term.grid().history_size();
        assert!(rows <= budget / 100 + 3, "{rows}");
    }

    #[test]
    fn after_resizes_under_the_alternate_screen_it_still_serves_the_primary_s_history() {
        let mut engine = Engine::new(SIZE, HistoryRows(1000));
        // Lines that wrap, so the reflows redraw the row a drain leaves.
        let dashes = "-".repeat(25);
        let long = (0..50).fold(String::new(), |mut out, i| {
            let _ = write!(out, "{i:02}{dashes}\r\n");
            out
        });
        engine.advance(long.as_bytes());
        engine.advance(b"\x1b[?1049h");
        engine.resize(Size { cols: 4, rows: 5 });
        engine.resize(Size { cols: 40, rows: 5 });
        engine.advance(b"\x1b[?1049l");
        let before = history(&mut engine);
        engine.advance(b"\x1b[?1049h");
        assert_eq!(history(&mut engine), before);
    }

    #[test]
    fn resizes_under_the_alternate_screen_leave_the_engine_no_larger_than_their_widest() {
        let size = Size {
            cols: 160,
            rows: 50,
        };
        let mut engine = Engine::new(size, HistoryRows(10_000));
        engine.advance(lines(0..1000).as_bytes());
        engine.advance(b"\x1b[?1049h");
        engine.resize(Size { cols: 20, rows: 50 });
        let narrowed = engine.stats().engine_bytes;
        for _ in 0..10 {
            engine.resize(size);
            engine.resize(Size { cols: 20, rows: 50 });
        }
        assert_eq!(engine.stats().engine_bytes, narrowed);
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
