//! Writes an engine's state as plain VT: replayed into a fresh terminal of the same size, with
//! history at least as deep, it reproduces history, screen, wrap, attributes, cursor and modes.

use std::fmt::Write as _;

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::{Cursor, Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{CharsetIndex, Color, NamedColor, StandardCharset};

const LAYOUT_FLAGS: Flags = Flags::WRAPLINE
    .union(Flags::WIDE_CHAR)
    .union(Flags::WIDE_CHAR_SPACER)
    .union(Flags::LEADING_WIDE_CHAR_SPACER);

pub(crate) fn serialize<L: EventListener>(term: &mut Term<L>) -> Vec<u8> {
    let mut out = String::with_capacity(64 * 1024);
    out.push_str("\x1b[0m");
    if term.mode().contains(TermMode::ALT_SCREEN) {
        // alacritty keeps the primary grid private while the alternate screen is up. swap_alt is
        // public; swapping back clears the alternate grid, so a clone of it is put back after.
        let alternate = term.grid().clone();
        term.swap_alt();
        write_rows(&mut out, term.grid());
        write_cursor(
            &mut out,
            &term.grid().cursor,
            term.grid().columns(),
            term.grid(),
        );
        term.swap_alt();
        *term.grid_mut() = alternate;
        out.push_str("\x1b[0m\x1b[?1049h\x1b[H");
    }
    let grid = term.grid();
    write_rows(&mut out, grid);
    write_cursor_saved(&mut out, &grid.saved_cursor);
    write_modes(&mut out, *term.mode());
    write_cursor(&mut out, &grid.cursor, grid.columns(), grid);
    out.into_bytes()
}

fn write_rows(out: &mut String, grid: &Grid<Cell>) {
    let columns = grid.columns();
    let history = i32::try_from(grid.history_size()).unwrap_or(i32::MAX);
    let bottom = i32::try_from(grid.screen_lines()).unwrap_or(i32::MAX) - 1;
    let mut pen = Pen::default();
    for line in -history..=bottom {
        let row = &grid[Line(line)];
        let wrapped = row[Column(columns - 1)].flags.contains(Flags::WRAPLINE);
        let end = if wrapped {
            columns
        } else {
            (0..columns)
                .rev()
                .find(|&c| !is_blank(&row[Column(c)]))
                .map_or(0, |c| c + 1)
        };
        for column in 0..end {
            let cell = &row[Column(column)];
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            write_cell(out, &mut pen, cell);
        }
        if !wrapped && line != bottom {
            if pen != Pen::default() {
                out.push_str("\x1b[0m");
                pen = Pen::default();
            }
            out.push_str("\r\n");
        }
    }
    if pen != Pen::default() {
        out.push_str("\x1b[0m");
    }
}

fn write_cell(out: &mut String, pen: &mut Pen, cell: &Cell) {
    let next = Pen::of(cell);
    if cell.c == '\t' && next == Pen::default() {
        // A tab moves the cursor without writing; alacritty records it in the cell it started at.
        out.push_str("\x1b[C");
        return;
    }
    if next != *pen {
        next.write(out);
        *pen = next;
    }
    out.push(if cell.c == '\t' { ' ' } else { cell.c });
    if let Some(marks) = cell.zerowidth() {
        out.extend(marks);
    }
}

fn is_blank(cell: &Cell) -> bool {
    (cell.c == ' ' || cell.c == '\t') && Pen::of(cell) == Pen::default()
}

fn write_cursor_saved(out: &mut String, cursor: &Cursor<Cell>) {
    let _ = write!(
        out,
        "\x1b[{};{}H",
        cursor.point.line.0 + 1,
        cursor.point.column.0 + 1
    );
    Pen::of(&cursor.template).write(out);
    out.push_str("\x1b7");
}

fn write_cursor(out: &mut String, cursor: &Cursor<Cell>, columns: usize, grid: &Grid<Cell>) {
    let (line, column) = (cursor.point.line, cursor.point.column);
    let _ = write!(out, "\x1b[{};{}H", line.0 + 1, column.0 + 1);
    if cursor.input_needs_wrap && column.0 + 1 == columns {
        // The cursor sits past the last column, waiting to wrap. Rewriting that cell puts a
        // fresh terminal in the same state, where a cursor move can't.
        let cell = &grid[line][column];
        let mut pen = Pen::default();
        out.push_str("\x1b[0m");
        write_cell(out, &mut pen, cell);
    }
    Pen::of(&cursor.template).write(out);
    if cursor.charsets[CharsetIndex::G0] == StandardCharset::SpecialCharacterAndLineDrawing {
        out.push_str("\x1b(0");
    }
}

fn write_modes(out: &mut String, mode: TermMode) {
    let set = [
        (TermMode::APP_CURSOR, "\x1b[?1h"),
        (TermMode::APP_KEYPAD, "\x1b="),
        (TermMode::MOUSE_REPORT_CLICK, "\x1b[?1000h"),
        (TermMode::MOUSE_DRAG, "\x1b[?1002h"),
        (TermMode::MOUSE_MOTION, "\x1b[?1003h"),
        (TermMode::FOCUS_IN_OUT, "\x1b[?1004h"),
        (TermMode::UTF8_MOUSE, "\x1b[?1005h"),
        (TermMode::SGR_MOUSE, "\x1b[?1006h"),
        (TermMode::BRACKETED_PASTE, "\x1b[?2004h"),
        (TermMode::INSERT, "\x1b[4h"),
        (TermMode::LINE_FEED_NEW_LINE, "\x1b[20h"),
        (TermMode::ORIGIN, "\x1b[?6h"),
    ];
    for (flag, sequence) in set {
        if mode.contains(flag) {
            out.push_str(sequence);
        }
    }
    if !mode.contains(TermMode::SHOW_CURSOR) {
        out.push_str("\x1b[?25l");
    }
    if !mode.contains(TermMode::LINE_WRAP) {
        out.push_str("\x1b[?7l");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Pen {
    fg: Color,
    bg: Color,
    underline: Option<Color>,
    flags: Flags,
}

impl Default for Pen {
    fn default() -> Self {
        Self {
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            underline: None,
            flags: Flags::empty(),
        }
    }
}

impl Pen {
    fn of(cell: &Cell) -> Self {
        Self {
            fg: cell.fg,
            bg: cell.bg,
            underline: cell.underline_color(),
            flags: cell.flags.difference(LAYOUT_FLAGS),
        }
    }

    fn write(&self, out: &mut String) {
        out.push_str("\x1b[0");
        let attributes = [
            (Flags::BOLD, ";1"),
            (Flags::DIM, ";2"),
            (Flags::ITALIC, ";3"),
            (Flags::UNDERLINE, ";4"),
            (Flags::DOUBLE_UNDERLINE, ";4:2"),
            (Flags::UNDERCURL, ";4:3"),
            (Flags::DOTTED_UNDERLINE, ";4:4"),
            (Flags::DASHED_UNDERLINE, ";4:5"),
            (Flags::INVERSE, ";7"),
            (Flags::HIDDEN, ";8"),
            (Flags::STRIKEOUT, ";9"),
        ];
        for (flag, code) in attributes {
            if self.flags.contains(flag) {
                out.push_str(code);
            }
        }
        write_color(out, self.fg, 30, 90, 38);
        write_color(out, self.bg, 40, 100, 48);
        if let Some(color) = self.underline {
            write_color(out, color, 0, 0, 58);
        }
        out.push('m');
    }
}

fn write_color(out: &mut String, color: Color, base: u16, bright: u16, extended: u16) {
    match color {
        Color::Named(named) => {
            let index = named as u16;
            let dim_black = NamedColor::DimBlack as u16;
            let index = match index {
                0..16 => index,
                i if (dim_black..dim_black + 8).contains(&i) => i - dim_black,
                _ => return,
            };
            if base == 0 {
                let _ = write!(out, ";{extended}:5:{index}");
            } else if index < 8 {
                let _ = write!(out, ";{}", base + index);
            } else {
                let _ = write!(out, ";{}", bright + index - 8);
            }
        }
        Color::Indexed(index) => {
            let _ = write!(out, ";{extended};5;{index}");
        }
        Color::Spec(rgb) => {
            let _ = write!(out, ";{extended};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::engine::Engine;
    use crate::pty::Size;

    fn round_trip(stream: &[u8], size: Size) -> (Vec<u8>, Vec<u8>) {
        let mut original = Engine::new(size, 100);
        original.advance(stream);
        let first = original.snapshot();
        let mut replayed = Engine::new(size, 100);
        replayed.advance(&first);
        (first, replayed.snapshot())
    }

    #[test]
    fn a_snapshot_replayed_into_a_fresh_engine_snapshots_the_same() {
        let size = Size { cols: 10, rows: 3 };
        let stream = b"one\r\n\x1b[31mtwo\x1b[0m\r\nthree is a long wrapped line\r\n\x1b[44m  \x1b[K\x1b[0mx";
        let (first, second) = round_trip(stream, size);
        assert_eq!(
            String::from_utf8_lossy(&first),
            String::from_utf8_lossy(&second)
        );
    }

    #[test]
    fn history_under_an_alternate_screen_survives_a_snapshot() {
        let size = Size { cols: 10, rows: 3 };
        let stream = b"a\r\nb\r\nc\r\nd\r\n\x1b[?1049h\x1b[Halt";
        let (first, second) = round_trip(stream, size);
        let text = String::from_utf8_lossy(&first);
        assert!(text.contains("a\r\nb\r\nc\r\nd"), "{text:?}");
        assert!(text.contains("\x1b[?1049h"), "{text:?}");
        assert_eq!(first, second);
    }
}
