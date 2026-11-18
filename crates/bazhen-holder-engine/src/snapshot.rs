//! A terminal's whole state as VT, for a fresh terminal of the engine's size: its history, both
//! screens, both cursors and their saved cursors, its modes, the colours and titles a program set.
//!
//! The order is [`Modes::write_for_engine`]'s, with the screens and cursors put between, and each
//! screen's text drawn before any charset is designated: a designation maps the ASCII after it.
//!
//! 1. Colours a program set, then the title stack and title.
//! 2. For an engine only, the hidden screen's keys.
//! 3. The primary's history and screen, as one run of lines: the screen's last row ends with no
//!    line break, so exactly the history scrolls off.
//! 4. Under the alternate screen, the primary's cursor, `?1049h`, and the alternate screen.
//! 5. The modes, and for an engine only, the shown screen's keys.
//! 6. The shown screen's saved cursor, then its cursor: DECSTBM and DECOM home the cursor.
//!
//! A snapshot is written against a byte budget, never built and then cut. A first pass counts
//! all but the history; the history then takes what room is left, its newest rows first, from a
//! line's start. Nothing holds more than a row of it at a time.

use std::fmt::Write as _;
use std::ops::Range;

use alacritty_terminal::grid::{Cursor, Dimensions, Grid};
use alacritty_terminal::index::Column;
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{CharsetIndex, NamedColor};

use crate::encode::{Ending, Lines, Pen, drawable, encode_row};
use crate::history::History;
use crate::modes::{Origin, designations, write_charsets};

use crate::{Engine, PrimaryShown, Sink, scrollback_line};

/// A snapshot whose screens, cursors and modes alone take more than its budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the terminal's screens and modes alone take more than the snapshot's budget")]
pub struct TooLarge;

/// The most a row of history writes past its text: a space for a spacer the row before owed, one
/// that makes a blank row a line wrapped into wrap, an erase to the row's end, and a CRLF.
const MOST_PAST_A_ROW: usize = 7;

/// The most the rest writes past what the count found with no history before it: the spacer
/// the last row of history may owe the screen's first.
const SLACK: usize = 8;

/// Who a snapshot is for. A viewer is never given the keys a program asked for (see
/// [`crate::Keys`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum For {
    Viewer,
    Engine,
}

/// Where a snapshot goes, a row at a time, refusing what would pass its budget.
pub(crate) trait Out {
    fn put(&mut self, text: &str) -> Result<(), TooLarge>;

    /// Room for the `bytes` about to be put, so a string grows once to them, not by doubling
    /// past them.
    fn reserve(&mut self, _bytes: usize) {}
}

/// Counts what a snapshot would write.
#[derive(Debug)]
struct Count {
    left: usize,
}

impl Out for Count {
    fn put(&mut self, text: &str) -> Result<(), TooLarge> {
        self.left = self.left.checked_sub(text.len()).ok_or(TooLarge)?;
        Ok(())
    }
}

#[derive(Debug)]
struct Bounded<'a> {
    out: &'a mut String,
    left: usize,
}

impl Out for Bounded<'_> {
    fn put(&mut self, text: &str) -> Result<(), TooLarge> {
        self.left = self.left.checked_sub(text.len()).ok_or(TooLarge)?;
        self.out.push_str(text);
        Ok(())
    }

    fn reserve(&mut self, bytes: usize) {
        self.out.reserve(bytes.min(self.left));
    }
}

impl Engine {
    /// Appends the terminal's state to `out` for a viewer (an emulator Bazhen owns, never the
    /// user's own terminal) of the engine's size, freshly reset, in no more than `most` bytes.
    /// History gives way first, its oldest lines. Returns how many rows of history were left out,
    /// counted as [`Stats::history_rows`](crate::Stats) counts them: rows, not logical lines,
    /// which a holder reporting `dropped_lines` must say or convert.
    ///
    /// Divergences a snapshot can't avoid, from state no VT sets in a fresh terminal or a reflow
    /// leaves behind:
    /// - A cursor outside the scroll region under DECOM comes back clamped into it.
    /// - A wrap mark on the last row (a region past the bottom or a scroll down leaves one), or
    ///   inside a row, and a cursor a reflow left waiting to wrap off the last column, come back
    ///   unmarked.
    /// - A cursor waiting to wrap is made to wait by printing its cell again, which unmarks that
    ///   row's wrap and, for a wide char, the spacer it left in the row before.
    /// - The cell a wide char didn't fit in comes back as a space in no colour when the row after
    ///   doesn't start with that char.
    /// - A wide char with no room for its spacer, in the last column as an insert or a narrowing
    ///   leaves it, or with a char written over its spacer, comes back as the blank it has room
    ///   to draw, in its pen; over it, alacritty would clear the cell before it too.
    /// - A spacer an erase left without its wide char comes back as a blank, which alacritty
    ///   prints over as one, where over the spacer it would clear what it printed.
    /// - A line of history kept at another width, from before a resize, that runs on into the
    ///   rows at this width ends where they start, so that they start in the first column.
    /// - A REP before the program prints again repeats the snapshot's last char, not the
    ///   program's. terminfo's `rep` never does: it prints the char first.
    ///
    /// # Errors
    ///
    /// [`TooLarge`] if the screens, cursors and modes alone take more than `most`; `out` is then
    /// as it was.
    pub fn snapshot(&mut self, most: usize, out: &mut String) -> Result<usize, TooLarge> {
        self.snapshot_to(For::Viewer, most, out)
    }

    /// [`Engine::snapshot`] for another engine, with the kitty flags and modifyOtherKeys the
    /// program asked for.
    ///
    /// # Errors
    ///
    /// As [`Engine::snapshot`].
    pub fn snapshot_for_engine(
        &mut self,
        most: usize,
        out: &mut String,
    ) -> Result<usize, TooLarge> {
        self.snapshot_to(For::Engine, most, out)
    }

    fn snapshot_to(&mut self, who: For, most: usize, out: &mut String) -> Result<usize, TooLarge> {
        let start = out.len();
        let written = self.snapshot_into(who, most, &mut Bounded { out, left: most });
        if written.is_err() {
            out.truncate(start);
        }
        written
    }

    pub(crate) fn snapshot_into(
        &mut self,
        who: For,
        most: usize,
        out: &mut dyn Out,
    ) -> Result<usize, TooLarge> {
        let (all, _) = self.history_skip(None);
        let mut count = Count { left: most };
        self.emit(who, all, &mut count)?;
        let room = count.left.saturating_sub(SLACK);
        let (skip, history) = self.history_skip(Some(room));
        out.reserve(most - count.left + history + SLACK);
        self.emit(who, skip, out)?;
        Ok(skip)
    }

    /// How many of the oldest rows of history to leave out for the rest to take no more than
    /// `room` bytes, `None` for all of them: the newest rows that fit, from the start of a line.
    /// And the most bytes the rows kept take.
    ///
    /// History is the store's rows and then the primary grid's own scrollback, under the
    /// alternate screen too, where a resize may have reflowed rows into it that
    /// [`Engine::write_history`] doesn't yet serve: they come back when the screen ends.
    fn history_skip(&mut self, room: Option<usize>) -> (usize, usize) {
        let Some(history) = (self.history_rows.0 > 0).then_some(&self.history) else {
            return (0, 0);
        };
        with_primary(&mut self.term, |grid| {
            let scrolled = grid.history_size();
            let total = history.rows() + scrolled;
            let Some(room) = room else {
                return (total, 0);
            };
            let mut text = String::new();
            let scrollback = (0..scrolled).rev().map(|n| {
                text.clear();
                let ending = encode_row(&grid[scrollback_line(scrolled, n)], &mut text);
                (text.len(), ending.wrapped)
            });
            let stored = (history.iter().rev()).map(|(text, ending)| (text.len(), ending.wrapped));
            let mut index = total;
            let mut start = (index, 0);
            let mut used = 0;
            for (len, wrapped) in scrollback.chain(stored) {
                // The rows from `index` on fit, and a line starts there unless this row runs
                // into it.
                if !wrapped {
                    start = (index, used);
                }
                used += len + MOST_PAST_A_ROW;
                if used > room {
                    return start;
                }
                index -= 1;
            }
            (0, used)
        })
    }

    /// Writes the snapshot, leaving out the oldest `skip` rows of history.
    fn emit(&mut self, who: For, skip: usize, out: &mut dyn Out) -> Result<(), TooLarge> {
        let modes = self.modes();
        let active = self.tracker.active_charset();
        let alternate = self.alternate();
        let mut text = String::new();
        write_colours(self.term.colors(), &mut text);
        self.tracker.write_titles(&mut text);
        if alternate {
            if who == For::Engine {
                modes.write_keys_inactive(&mut text);
            }
        } else {
            // The alternate screen keeps its saved cursor from one visit to the next, and its keys:
            // both are set from a visit to it in the fresh terminal, before anything else is drawn.
            let saved =
                (self.tracker.alternate_saved()).filter(|saved| **saved != Cursor::default());
            let keys = who == For::Engine && !modes.keys.kitty_requested_hidden.is_empty();
            if saved.is_some() || keys {
                text.push_str("\x1b[?1049h");
                if keys {
                    modes.write_keys_hidden(&mut text);
                }
                if let Some(saved) = saved.cloned() {
                    let cols = self.size.cols();
                    write_cursor(&saved, None, cols, CharsetIndex::G0, None, &mut text);
                    text.push_str("\x1b7");
                }
                // xterm.js keeps one set of charsets for both screens: none may carry over.
                text.push_str("\x1b[?1049l\x1b(B\x1b)B\x1b*B\x1b+B");
            }
        }
        out.put(&text)?;
        text.clear();
        let history = (self.history_rows.0 > 0).then_some(&self.history);
        with_primary(&mut self.term, |grid| {
            let rows = history.map(History::iter);
            write_rows(grid, rows, skip, &mut text, out)?;
            if alternate {
                // The shown charset is G0 in the fresh terminal until the modes are written.
                write_cursor(
                    &grid.cursor,
                    Some(grid),
                    grid.columns(),
                    CharsetIndex::G0,
                    None,
                    &mut text,
                );
            }
            Ok::<(), TooLarge>(())
        })?;
        if alternate {
            // `?1049h` hands the primary's pen and charsets to the alternate screen.
            text.push_str("\x1b[?1049h\x1b[0m\x1b(B\x1b[H");
            write_screen(self.term.grid(), &mut text, out)?;
        }
        modes.write(&mut text);
        if who == For::Engine {
            modes.write_keys(&mut text);
        }
        let grid = self.term.grid();
        let origin = modes.screen.origin == Origin::Region;
        // The saved cursor may stand outside the region: written with DECOM off, which unsetting
        // doesn't move the cursor for.
        if origin {
            text.push_str("\x1b[?6l");
        }
        write_cursor(
            &grid.saved_cursor,
            Some(grid),
            grid.columns(),
            active,
            None,
            &mut text,
        );
        text.push_str("\x1b7");
        if origin {
            text.push_str("\x1b[?6h");
        }
        let region = origin.then_some(modes.screen.region);
        write_cursor(
            &grid.cursor,
            Some(grid),
            grid.columns(),
            active,
            region,
            &mut text,
        );
        out.put(&text)
    }
}

/// Calls `f` with the primary grid: shown, or brought into reach from under the alternate screen.
pub(crate) fn with_primary<R>(term: &mut Term<Sink>, f: impl FnOnce(&Grid<Cell>) -> R) -> R {
    if let Some(primary) = PrimaryShown::new(term) {
        return f(primary.grid());
    }
    f(term.grid())
}

/// The alternate screen's rows, from the top: it has no history.
fn write_screen(grid: &Grid<Cell>, text: &mut String, out: &mut dyn Out) -> Result<(), TooLarge> {
    write_rows(grid, None::<std::iter::Empty<(&str, Ending)>>, 0, text, out)
}

/// Writes the rows of history from `skip` on, the store's `stored` and then the grid's own
/// scrollback, then the grid's screen, its last row with no line break: at the engine's size
/// each row of the screen takes one, so the history scrolls off.
fn write_rows<'a>(
    grid: &Grid<Cell>,
    stored: Option<impl Iterator<Item = (&'a str, Ending)>>,
    skip: usize,
    text: &mut String,
    out: &mut dyn Out,
) -> Result<(), TooLarge> {
    let mut lines = Lines::erasing(text, grid.columns());
    let flush = |lines: &mut Lines<'_>, out: &mut dyn Out| {
        out.put(lines.text())?;
        lines.text().clear();
        Ok::<(), TooLarge>(())
    };
    if let Some(stored) = stored {
        let mut index = 0;
        for (row, ending) in stored {
            if index >= skip {
                lines.row(row, ending);
                flush(&mut lines, out)?;
            }
            index += 1;
        }
        // Rows kept from before a resize are at their old width. A line of them that runs on into
        // the grid's rows would rejoin at this width and move every row after it: it ends where
        // the grid's rows start.
        if !lines.at_a_row_start() {
            lines.end_line();
        }
        let scrolled = grid.history_size();
        for n in 0..scrolled {
            if index >= skip {
                lines.grid_row(&grid[scrollback_line(scrolled, n)]);
                flush(&mut lines, out)?;
            }
            index += 1;
        }
    }
    let rows = grid.screen_lines();
    for n in 0..rows {
        lines.grid_row(&grid[scrollback_line(0, n)]);
        if n + 1 == rows {
            let last = lines.text();
            if last.ends_with("\r\n") {
                last.truncate(last.len() - 2);
            }
        }
        flush(&mut lines, out)?;
    }
    // Not `Lines::finish`: nothing follows the last row, and the space a spacer it ends in is
    // owed would wrap it, and scroll the screen.
    Ok(())
}

/// Writes `cursor`: where it is, relative to `region` under DECOM; waiting to wrap, by printing
/// the cell under it again in the shown charset `active`, made ASCII for it; its pen; and its
/// charsets. The cells are `grid`'s, or with none, blank: a screen `cols` wide yet to be drawn.
fn write_cursor(
    cursor: &Cursor<Cell>,
    grid: Option<&Grid<Cell>>,
    cols: usize,
    active: CharsetIndex,
    region: Option<Range<u16>>,
    out: &mut String,
) {
    let point = cursor.point;
    let line = usize::try_from(point.line.0).unwrap_or(0);
    let blank = Cell::default();
    let cell_at = |column: usize| match grid {
        Some(grid) if line < grid.screen_lines() && column < grid.columns() => {
            &grid[point.line][Column(column)]
        }
        _ => &blank,
    };
    let waits = cursor.input_needs_wrap && point.column.0 + 1 == cols;
    let mut column = point.column.0;
    // On a wide char's spacer, the char is printed from its first column; a spacer an erase left
    // alone is printed as the blank it is.
    if waits
        && column > 0
        && cell_at(column).flags.contains(Flags::WIDE_CHAR_SPACER)
        && cell_at(column - 1).flags.contains(Flags::WIDE_CHAR)
    {
        column -= 1;
    }
    let row = match region {
        Some(region) => line.saturating_sub(region.start.into()) + 1,
        None => line + 1,
    };
    let _ = write!(out, "\x1b[{row};{}H", column + 1);
    if waits {
        let cell = cell_at(column);
        out.push_str(if active == CharsetIndex::G1 {
            "\x1b)B"
        } else {
            "\x1b(B"
        });
        Pen::of(cell).write(out);
        if column + 1 == cols && cell.flags.contains(Flags::WIDE_CHAR) {
            // No room for its spacer: printed, it would wrap (see `encode_row`).
            out.push(' ');
        } else {
            out.push(drawable(cell.c));
            out.extend(cell.zerowidth().unwrap_or_default());
        }
    }
    Pen::of(&cursor.template).write(out);
    write_charsets(out, designations(cursor));
}

/// OSC 4, 10, 11 and 12 for each colour a program set.
fn write_colours(colours: &Colors, out: &mut String) {
    for index in 0..=NamedColor::Cursor as usize {
        let Some(rgb) = colours[index] else {
            continue;
        };
        let _ = match index {
            0..256 => write!(out, "\x1b]4;{index};"),
            i if i == NamedColor::Foreground as usize => write!(out, "\x1b]10;"),
            i if i == NamedColor::Background as usize => write!(out, "\x1b]11;"),
            _ => write!(out, "\x1b]12;"),
        };
        let _ = write!(out, "#{:02x}{:02x}{:02x}\x1b\\", rgb.r, rgb.g, rgb.b);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use alacritty_terminal::index::Line;

    use super::*;
    use crate::{HistoryRows, Modes, Size};

    const SIZE: Size = Size { cols: 20, rows: 5 };

    fn engine() -> Engine {
        Engine::new(SIZE, HistoryRows(100))
    }

    fn after(output: &str) -> Engine {
        let mut engine = engine();
        engine.advance(output.as_bytes());
        engine
    }

    /// A fresh engine of the same size given `engine`'s snapshot.
    pub(crate) fn restored(engine: &mut Engine) -> Engine {
        let mut out = String::new();
        engine.snapshot_for_engine(usize::MAX, &mut out).unwrap();
        let mut fresh = Engine::new(engine.size, engine.history_rows);
        fresh.advance(out.as_bytes());
        fresh.take_replies();
        fresh
    }

    /// A cursor as a snapshot carries it: where, whether it waits to wrap, its pen and charsets.
    type CursorState = ((i32, usize), bool, String);

    fn cursor(cursor: &Cursor<Cell>) -> CursorState {
        let mut pen = String::new();
        Pen::of(&cursor.template).write(&mut pen);
        write_charsets(&mut pen, designations(cursor));
        (
            (cursor.point.line.0, cursor.point.column.0),
            cursor.input_needs_wrap,
            pen,
        )
    }

    /// A screen's rows as encoded, each with whether it wraps, and its cursor and saved cursor. The
    /// cell a wide char didn't fit in can come back as a space in any colour (before a row that
    /// doesn't start with that char, or once the char is printed again for a cursor waiting on
    /// it), so a row's last cell, if blank, is read as a blank in no colour, and the text compared
    /// without the spaces it ends in.
    type ScreenState = (Vec<(String, bool)>, CursorState, CursorState);

    fn screen(grid: &Grid<Cell>) -> ScreenState {
        let last = grid.screen_lines().saturating_sub(1);
        // Printing a waiting cursor's cell again unmarks its row's wrap.
        let waiting: Vec<usize> = [&grid.cursor, &grid.saved_cursor]
            .iter()
            .filter(|cursor| cursor.input_needs_wrap)
            .filter_map(|cursor| usize::try_from(cursor.point.line.0).ok())
            .collect();
        let rows = (0..grid.screen_lines())
            .map(|n| {
                let mut row = grid[Line(i32::try_from(n).unwrap())].clone();
                // The cell a wide char didn't fit in, the last, is read as a blank in no colour,
                // and so is a blank there, or a wide char with no room for its spacer.
                if let Some(cell) = row.last_mut() {
                    let blank = matches!(cell.c, ' ' | '\t')
                        && !cell.flags.intersects(Flags::WIDE_CHAR_SPACER);
                    let alone = Flags::LEADING_WIDE_CHAR_SPACER.union(Flags::WIDE_CHAR);
                    if blank || cell.flags.intersects(alone) {
                        let wraps = cell.flags.contains(Flags::WRAPLINE);
                        *cell = Cell::default();
                        cell.flags.set(Flags::WRAPLINE, wraps);
                    }
                }
                let mut text = String::new();
                let ending = encode_row(&row, &mut text);
                // Nothing follows the last row to wrap into, so its mark can't come back.
                let wraps = ending.wrapped && n != last && !waiting.contains(&n);
                (text.trim_end_matches(' ').to_owned(), wraps)
            })
            .collect();
        (rows, cursor(&grid.cursor), cursor(&grid.saved_cursor))
    }

    /// Everything a snapshot carries: history, the shown screen, the primary under the
    /// alternate screen, the modes, the title and the colours a program set.
    #[derive(Debug, PartialEq)]
    pub(crate) struct State {
        pub(crate) history: String,
        pub(crate) shown: ScreenState,
        pub(crate) primary: Option<ScreenState>,
        pub(crate) modes: Modes,
        pub(crate) title: Option<String>,
        pub(crate) colours: String,
    }

    pub(crate) fn state(engine: &mut Engine) -> State {
        let mut history = String::new();
        engine.write_history(&mut history);
        let primary = PrimaryShown::new(&mut engine.term).map(|shown| screen(shown.grid()));
        let mut colours = String::new();
        write_colours(engine.term.colors(), &mut colours);
        State {
            history,
            shown: screen(engine.term.grid()),
            primary,
            modes: engine.modes(),
            title: engine.title().map(str::to_owned),
            colours,
        }
    }

    fn assert_restores(output: &str) {
        let mut original = after(output);
        let mut fresh = restored(&mut original);
        assert_eq!(state(&mut fresh), state(&mut original), "{output:?}");
    }

    #[test]
    fn history_the_screen_and_the_cursor_come_back() {
        let lines = (0..40).fold(String::new(), |mut out, i| {
            let _ = write!(out, "\x1b[3{}mline {i}\r\n", i % 8);
            out
        });
        assert_restores(&(lines + "\x1b[0m$ ls\x1b[2;5H\x1b[1;4;38;5;9m"));
    }

    #[test]
    fn a_line_wrapped_from_history_onto_the_screen_comes_back_whole() {
        assert_restores(&("x".repeat(20 * 7 + 3) + "\r\n"));
    }

    #[test]
    fn a_cursor_waiting_to_wrap_comes_back_waiting() {
        let full = "x".repeat(19) + "y";
        assert_restores(&full);
        let mut fresh = restored(&mut after(&full));
        fresh.advance(b"z");
        assert_eq!(fresh.term.grid().cursor.point.line, Line(1));
        // A wide char in the last two columns: the cursor waits on its spacer.
        assert_restores(&("x".repeat(18) + "\u{4e2d}"));
        // With DEC line drawing in G0, the cell printed again is still the x it was.
        assert_restores(&("x".repeat(20) + "\x1b(0"));
    }

    #[test]
    fn a_wide_char_an_insert_left_in_the_last_column_moves_no_row() {
        // ICH rotates the row: 中 ends in the last column, its spacer gone.
        assert_restores(&("x".repeat(18) + "\u{4e2d}\x1b[1;1H\x1b[@"));
        // And with a cursor waiting on it, and one saved there.
        assert_restores(&("x".repeat(18) + "\u{4e2d}\x1b[1;1H\x1b[@\x1b[1;20H\x1b7"));
    }

    #[test]
    fn a_spacer_a_widening_left_inside_a_row_moves_no_row() {
        // Under the alternate screen alacritty widens without reflowing: the spacer 中 left in the
        // last column of 9 is now inside a row of 10.
        let mut original = Engine::new(Size { cols: 9, rows: 3 }, HistoryRows(100));
        // The row after it no longer starts with 中.
        original.advance("\x1b[?1049h\x1b[41mabcdefgh\u{4e2d}\x1b[2;1H\x1b[2Kxy".as_bytes());
        original.resize(Size { cols: 10, rows: 3 });
        let mut fresh = restored(&mut original);
        assert_eq!(state(&mut fresh).shown, state(&mut original).shown);
    }

    #[test]
    fn a_cursor_waiting_on_a_spacer_an_erase_left_alone_comes_back_waiting() {
        // ECH leaves column 19 a spacer with no wide char before it, under a waiting cursor.
        assert_restores(&("x".repeat(18) + "\u{4e2d}\x1b7\x1b[1;19H\x1b[X\x1b8"));
    }

    #[test]
    fn under_decom_the_cursor_comes_back_in_its_region_and_the_saved_one_anywhere() {
        assert_restores("\x1b[2;4r\x1b[?6h\x1b[2;3H");
        assert_restores("\x1b[5;10H\x1b7\x1b[2;3r\x1b[?6h\x1b[2;2H");
    }

    #[test]
    fn the_primary_s_line_drawing_comes_back_under_the_alternate_screen_s_ascii() {
        assert_restores("\x1b(0lqqk\r\n\x1b[?1049h\x1b(Bvim\x1b[2;3H");
    }

    #[test]
    fn after_a_resize_under_the_alternate_screen_vim_s_exit_puts_the_prompt_back() {
        let mut original = after(
            &((0..30).fold(String::new(), |mut out, i| {
                let _ = write!(out, "{i}\r\n");
                out
            }) + "$ vim a-long-name"),
        );
        // The prompt rewraps at the new width: the reflow moves the cursor, not its saved copy.
        original.advance(b"\x1b[?1049h\x1b[Hediting");
        original.resize(Size { cols: 12, rows: 4 });
        let mut fresh = restored(&mut original);
        // Under the alternate screen, history is served as it was at the switch: the row the
        // resize reflowed into the primary's scrollback joins it when the screen ends.
        let without_history = |engine: &mut Engine| State {
            history: String::new(),
            ..state(engine)
        };
        assert_eq!(without_history(&mut fresh), without_history(&mut original));
        for engine in [&mut original, &mut fresh] {
            engine.advance(b"\x1b[?1049l\x1b8!");
        }
        assert_eq!(state(&mut fresh), state(&mut original));
    }

    #[test]
    fn after_vim_s_exit_the_screen_a_resize_left_under_it_comes_back_in_place() {
        // A line of history kept at 2 columns runs on into the screen, which the resize under
        // the alternate screen reflowed to 5.
        let mut original = Engine::new(Size { cols: 2, rows: 1 }, HistoryRows(100));
        original.advance("bce\u{301}bc\x1b[?1049h".as_bytes());
        original.resize(Size { cols: 5, rows: 2 });
        let mut fresh = restored(&mut original);
        for engine in [&mut original, &mut fresh] {
            engine.advance("\x1b[?1049l\u{4e2d}".as_bytes());
        }
        assert_eq!(state(&mut fresh).shown, state(&mut original).shown);
    }

    #[test]
    fn the_alternate_screen_s_saved_cursor_comes_back_for_its_next_visit() {
        let mut original = after("\x1b[?1049h\x1b[3;4H\x1b(0\x1b7\x1b[?1049l");
        let mut fresh = restored(&mut original);
        for engine in [&mut original, &mut fresh] {
            engine.advance(b"\x1b[?1049h\x1b8");
        }
        assert_eq!(state(&mut fresh), state(&mut original));
        assert_eq!(fresh.term.grid().cursor.point.column, Column(3));
    }

    #[test]
    fn the_title_stack_comes_back_and_pops_as_it_would_have() {
        let stack = "\x1b[22t\x1b]2;one\x07\x1b[22t\x1b]2;two\x07\x1b[22t\x1b]2;three\x07";
        let mut original = after(stack);
        let mut fresh = restored(&mut original);
        for _ in 0..4 {
            assert_eq!(fresh.title(), original.title());
            fresh.advance(b"\x1b[23t");
            original.advance(b"\x1b[23t");
        }
        assert_eq!(fresh.title(), None);
    }

    #[test]
    fn a_title_comes_back_with_no_control_char_to_end_it_early() {
        let fresh = restored(&mut after("\x1b]2;a\u{9c}b\x07"));
        assert_eq!(fresh.title(), Some("ab"));
        assert_eq!(fresh.term.grid()[Line(0)][Column(0)].c, ' ');
    }

    #[test]
    fn colours_a_program_set_come_back() {
        assert_restores(
            "\x1b]4;1;#010203\x07\x1b]10;#a0b0c0\x07\x1b]11;#0f0f10\x07\x1b]12;#ff0000\x07",
        );
    }

    #[test]
    fn a_viewer_s_snapshot_asks_for_no_keys() {
        let mut original = after("\x1b[>4;2m\x1b[>5u\x1b[?1049h\x1b[>3u");
        let mut out = String::new();
        original.snapshot(usize::MAX, &mut out).unwrap();
        for intro in ["\x1b[>", "\x1b[<", "\x1b[="] {
            assert!(!out.contains(intro), "{intro:?}");
        }
        let mut out = String::new();
        original.snapshot_for_engine(usize::MAX, &mut out).unwrap();
        assert!(out.contains("\x1b[>5u") && out.contains("\x1b[>3u"));
    }

    #[test]
    fn a_snapshot_changes_nothing_on_either_screen() {
        // A prompt that a narrowing rewraps, which moves the cursor and not its saved copy.
        let set = "\x1b[31m$ vim a-long-name\x1b[2;3H\x1b7\x1b[1;18H\x1b(0";
        for output in [
            set.to_owned(),
            format!("{set}\x1b[?1049h\x1b[3;2Hvi\x1b7\x1b[1;1H"),
        ] {
            let mut snapshotted = after(&output);
            let mut untouched = after(&output);
            snapshotted.resize(Size { cols: 15, rows: 4 });
            untouched.resize(Size { cols: 15, rows: 4 });
            snapshotted
                .snapshot(usize::MAX, &mut String::new())
                .unwrap();
            assert_eq!(state(&mut snapshotted), state(&mut untouched), "{output:?}");
            for engine in [&mut snapshotted, &mut untouched] {
                engine.advance(b"\x1b[?1049l\x1b8x");
            }
            assert_eq!(state(&mut snapshotted), state(&mut untouched), "{output:?}");
        }
    }

    /// An `Out` that fails past `most` bytes, and says how many it was given and the most at
    /// once: what the snapshot held before it passed them on.
    struct AtMost {
        given: usize,
        largest: usize,
        most: usize,
    }

    impl Out for AtMost {
        fn put(&mut self, text: &str) -> Result<(), TooLarge> {
            self.given += text.len();
            self.largest = self.largest.max(text.len());
            assert!(self.given <= self.most, "{} past {}", self.given, self.most);
            Ok(())
        }
    }

    fn snapshot_size(engine: &mut Engine) -> usize {
        let mut out = String::new();
        engine.snapshot(usize::MAX, &mut out).unwrap();
        out.len()
    }

    #[test]
    fn past_its_budget_a_snapshot_leaves_out_the_oldest_lines_whole() {
        // Each line takes two rows, so only an even count of rows can be left out.
        let line = |i: usize| format!("{i:03}{}\r\n", "-".repeat(22));
        let lines: String = (0..100).map(line).collect();
        let mut original = Engine::new(SIZE, HistoryRows(1000));
        original.advance(lines.as_bytes());
        let whole = snapshot_size(&mut original);
        for most in [whole - 1, whole - 100, whole / 2] {
            let mut out = String::new();
            let dropped = original.snapshot_for_engine(most, &mut out).unwrap();
            assert!(out.len() <= most, "{} past {most}", out.len());
            assert!(dropped > 0 && dropped.is_multiple_of(2), "{dropped}");
            let mut fresh = Engine::new(SIZE, HistoryRows(1000));
            fresh.advance(out.as_bytes());
            let mut history = String::new();
            fresh.write_history(&mut history);
            let mut kept = String::new();
            original.write_history(&mut kept);
            assert!(kept.ends_with(&history), "{history:?} against {kept:?}");
            assert_eq!(history.len(), kept.len() - dropped / 2 * line(0).len());
        }
    }

    #[test]
    fn a_snapshot_grows_its_string_once_and_no_further_than_its_budget() {
        let mut original = Engine::new(SIZE, HistoryRows(1000));
        original.advance("a line of history\r\n".repeat(500).as_bytes());
        let whole = snapshot_size(&mut original);
        let mut out = String::new();
        let most = whole / 2;
        assert!(original.snapshot(most, &mut out).is_ok());
        assert!(out.capacity() <= most, "{} past {most}", out.capacity());
        assert!(
            out.capacity() < 2 * out.len(),
            "{} for {}",
            out.capacity(),
            out.len()
        );
    }

    #[test]
    fn a_snapshot_whose_screens_pass_its_budget_writes_nothing() {
        let mut original = after("\x1b[41mx\x1b[42my\x1b[43mz");
        let whole = snapshot_size(&mut original);
        let mut out = String::from("before");
        assert_eq!(original.snapshot(whole - 1, &mut out), Err(TooLarge));
        assert_eq!(out, "before");
    }

    #[test]
    fn a_snapshot_never_gives_more_than_its_budget_to_where_it_goes() {
        // Cells each in their own colours, under a longer history: half the budget leaves out some
        // history, and less than the screens takes none.
        let size = Size {
            cols: 100,
            rows: 30,
        };
        let mut original = Engine::new(size, HistoryRows(10_000));
        original.advance("history line\r\n".repeat(5000).as_bytes());
        let mut cells = String::new();
        for n in 0..300u32 {
            let [_, r, g, b] = n.to_be_bytes();
            let _ = write!(
                cells,
                "\x1b[1;3;4:3;38;2;{r};{g};{b};48;2;{b};{g};{r};58;2;{g};{r};{b}mx"
            );
        }
        original.advance(cells.as_bytes());
        let whole = snapshot_size(&mut original);
        let mut history = String::new();
        original.write_history(&mut history);
        // Each line of history erases the rest of its row, `ESC [ K`, as a snapshot writes it.
        let all_but_history = whole - history.len() - 3 * history.matches("\r\n").count();
        for most in [whole / 2, all_but_history + 10, all_but_history - 1] {
            let mut out = AtMost {
                given: 0,
                largest: 0,
                most,
            };
            let result = original.snapshot_into(For::Viewer, most, &mut out);
            if most < all_but_history {
                assert_eq!((result, out.given), (Err(TooLarge), 0));
            } else {
                assert!(result.is_ok(), "{most}");
                // A row at a time, or the modes and cursors: never the history at once.
                assert!(
                    out.largest < whole / 8,
                    "{} at once of {whole}",
                    out.largest
                );
            }
        }
    }
}
