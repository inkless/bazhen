//! A terminal's rows as plain text, for a reader rather than a viewer: no pen, no modes, no
//! cursor, and nothing a terminal would read as a control.

use alacritty_terminal::grid::{Dimensions, Grid, Row};
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::{Cell, Flags};

use crate::encode::{drawable, past_pen};
use crate::snapshot::{TooLarge, with_primary};
use crate::{Engine, scrollback_line};

const SPACERS: Flags = Flags::WIDE_CHAR_SPACER.union(Flags::LEADING_WIDE_CHAR_SPACER);

impl Engine {
    /// Appends the newest `history` rows of the primary screen's history, then the screen shown,
    /// to `out` as plain text in no more than `most` bytes: a line a row, each ended by `\n`, with
    /// the blanks a row ends in and the empty rows the screen ends in left out. History gives way
    /// first, its oldest rows. A char a terminal would act on rather than draw is written as
    /// U+FFFD, so the text can be printed to any terminal as it is. Returns how many rows of
    /// history were written.
    ///
    /// # Errors
    ///
    /// [`TooLarge`] if the screen alone takes more than `most`; `out` is then as it was.
    pub fn text(
        &mut self,
        history: usize,
        most: usize,
        out: &mut String,
    ) -> Result<usize, TooLarge> {
        let mut screen = String::new();
        write_screen(self.term.grid(), &mut screen);
        let room = most.checked_sub(screen.len()).ok_or(TooLarge)?;
        let wanted = if self.history_rows.0 > 0 { history } else { 0 };
        let stored = &self.history;
        let written = with_primary(&mut self.term, |grid| {
            let scrolled = grid.history_size();
            let newest_first = (0..scrolled)
                .rev()
                .map(|n| Source::Grid(&grid[scrollback_line(scrolled, n)]))
                .chain(stored.iter().rev().map(|(text, _)| Source::Stored(text)));
            let mut row = String::new();
            let mut used = 0;
            let mut fits = 0;
            for source in newest_first.take(wanted) {
                row.clear();
                source.write(&mut row);
                used += row.len() + 1;
                if used > room {
                    break;
                }
                fits += 1;
            }
            let oldest_first = stored
                .iter()
                .map(|(text, _)| Source::Stored(text))
                .chain((0..scrolled).map(|n| Source::Grid(&grid[scrollback_line(scrolled, n)])));
            let held = stored.rows() + scrolled;
            for source in oldest_first.skip(held - fits) {
                source.write(out);
                out.push('\n');
            }
            fits
        });
        out.push_str(&screen);
        Ok(written)
    }
}

/// A row of history: one alacritty still holds, or one the store holds as encoded.
enum Source<'a> {
    Grid(&'a Row<Cell>),
    Stored(&'a str),
}

impl Source<'_> {
    fn write(&self, out: &mut String) {
        let start = out.len();
        match self {
            Self::Grid(row) => write_row(row, out),
            Self::Stored(text) => past_pen(text).for_each(|c| push_printable(c, out)),
        }
        trim_blanks(out, start);
    }
}

/// The screen's rows from the top, but the empty rows it ends in.
fn write_screen(grid: &Grid<Cell>, out: &mut String) {
    let mut kept = out.len();
    for line in 0..grid.screen_lines() {
        let start = out.len();
        write_row(&grid[Line(i32::try_from(line).unwrap_or(i32::MAX))], out);
        trim_blanks(out, start);
        let empty = out.len() == start;
        out.push('\n');
        if !empty {
            kept = out.len();
        }
    }
    out.truncate(kept);
}

fn write_row(row: &Row<Cell>, out: &mut String) {
    for cell in row {
        if cell.flags.intersects(SPACERS) {
            continue;
        }
        push_printable(drawable(cell.c), out);
        for &mark in cell.zerowidth().unwrap_or_default() {
            push_printable(mark, out);
        }
    }
}

fn push_printable(c: char, out: &mut String) {
    out.push(if c.is_control() { '\u{fffd}' } else { c });
}

/// Drops the spaces `out` ends in, back to `start`.
fn trim_blanks(out: &mut String, start: usize) {
    while out.len() > start && out.ends_with(' ') {
        out.pop();
    }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::index::Column;

    use super::*;
    use crate::{HistoryRows, Size};

    const SIZE: Size = Size { cols: 20, rows: 5 };

    fn after(output: &str) -> Engine {
        let mut engine = Engine::new(SIZE, HistoryRows(100));
        engine.advance(output.as_bytes());
        engine
    }

    fn text(engine: &mut Engine, history: usize) -> (String, usize) {
        let mut out = String::new();
        let written = engine.text(history, usize::MAX, &mut out).unwrap();
        (out, written)
    }

    /// Twelve numbered lines on a five-row screen: seven rows of history, six in the store and
    /// the newest in alacritty's scrollback.
    fn twelve_lines() -> Engine {
        let lines: Vec<String> = (1..=12).map(|n| n.to_string()).collect();
        after(&lines.join("\r\n"))
    }

    #[test]
    fn a_screen_reads_as_its_rows_without_the_blanks_rows_and_the_screen_end_in() {
        let mut engine = after("one\r\n  two   \r\n\r\nfour");

        assert_eq!(text(&mut engine, 0), ("one\n  two\n\nfour\n".to_owned(), 0));
    }

    #[test]
    fn a_wide_char_reads_once_a_mark_after_its_char_and_a_tab_as_blanks() {
        let mut engine = after("\u{5bbd}x\r\ne\u{301}\r\na\tb");

        assert_eq!(text(&mut engine, 0).0, "\u{5bbd}x\ne\u{301}\na       b\n");
    }

    #[test]
    fn a_stored_row_reads_without_its_pen_and_a_control_in_it_as_a_replacement() {
        let mut out = String::new();

        Source::Stored("\x1b[31ma\x07b\x1b[0m\u{9b}c  ").write(&mut out);

        assert_eq!(out, "a\u{fffd}b\u{fffd}c");
    }

    #[test]
    fn a_control_left_in_a_cell_reads_as_a_replacement() {
        let mut row = Row::<Cell>::new(3);
        row[Column(0)].c = 'a';
        row[Column(1)].c = '\u{1b}';
        row[Column(2)].c = '\u{9b}';
        let mut out = String::new();

        Source::Grid(&row).write(&mut out);

        assert_eq!(out, "a\u{fffd}\u{fffd}");
    }

    #[test]
    fn history_reads_oldest_first_from_the_store_then_alacrittys_scrollback_then_the_screen() {
        let mut engine = twelve_lines();
        assert_eq!(
            (engine.history.rows(), engine.term.grid().history_size()),
            (6, 1)
        );

        let (out, written) = text(&mut engine, 100);

        assert_eq!(out, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n");
        assert_eq!(written, 7);
    }

    #[test]
    fn only_the_newest_rows_of_history_asked_for_are_read() {
        let mut engine = twelve_lines();

        assert_eq!(
            text(&mut engine, 3),
            ("5\n6\n7\n8\n9\n10\n11\n12\n".to_owned(), 3)
        );
    }

    #[test]
    fn the_alternate_screen_is_read_after_the_primarys_history() {
        let mut engine = twelve_lines();
        engine.advance(b"\x1b[?1049h\x1b[Htop");

        assert_eq!(text(&mut engine, 2), ("6\n7\ntop\n".to_owned(), 2));
    }

    #[test]
    fn history_gives_way_to_the_budget_its_newest_rows_kept() {
        let mut engine = twelve_lines();
        let screen = "8\n9\n10\n11\n12\n";
        let mut out = String::new();

        let written = engine.text(100, screen.len() + 5, &mut out).unwrap();

        assert_eq!((out.as_str(), written), ("6\n7\n8\n9\n10\n11\n12\n", 2));
    }

    #[test]
    fn a_screen_past_the_budget_is_too_large_and_leaves_out_as_it_was() {
        let mut engine = after("a long first row");
        let mut out = "kept".to_owned();

        assert_eq!(engine.text(0, 5, &mut out), Err(TooLarge));
        assert_eq!(out, "kept");
    }

    #[test]
    fn a_terminal_keeping_no_history_reads_none() {
        let lines: Vec<String> = (1..=12).map(|n| n.to_string()).collect();
        let mut engine = Engine::new(SIZE, HistoryRows(0));
        engine.advance(lines.join("\r\n").as_bytes());

        assert_eq!(text(&mut engine, 100), ("8\n9\n10\n11\n12\n".to_owned(), 0));
    }
}
