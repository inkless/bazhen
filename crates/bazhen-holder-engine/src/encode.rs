//! Writes grid rows as plain VT: their characters with the SGR that draws them. Written from
//! column 0 of a terminal of the same width, in the default pen, [`Lines`] reproduces each row's
//! cells and where it wraps; at another width, a viewer rewraps each line as it reads it.

use alacritty_terminal::grid::Row;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

const LAYOUT_FLAGS: Flags = Flags::WRAPLINE
    .union(Flags::WIDE_CHAR)
    .union(Flags::WIDE_CHAR_SPACER)
    .union(Flags::LEADING_WIDE_CHAR_SPACER);

/// Appends `row`'s cells to `out`, with the pen back at the default, and returns whether it
/// wraps into the next row. A row that wraps is written in full, so that writing the next one
/// wraps there too; one that doesn't stops at its last cell that isn't blank.
pub(crate) fn encode_row(row: &Row<Cell>, out: &mut String) -> bool {
    let wrapped = row
        .last()
        .is_some_and(|cell| cell.flags.contains(Flags::WRAPLINE));
    let end = if wrapped {
        row.len()
    } else {
        row.into_iter()
            .rposition(|cell| !is_blank(cell))
            .map_or(0, |last| last + 1)
    };
    let mut pen = Pen::default();
    let mut covered = false;
    for cell in row.into_iter().take(end) {
        // A wide char takes the next cell too when written, whatever that cell holds now: an
        // erase that starts there clears the spacer and leaves the wide char.
        if std::mem::replace(&mut covered, cell.flags.contains(Flags::WIDE_CHAR)) {
            continue;
        }
        if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
            // The cell a wide char didn't fit in. The next row usually starts with that char,
            // which would wrap there anyway, but not always (a line inserted between them): a
            // space keeps the next row's cells where they were.
            pen = write_pen(out, pen, Pen::default());
            out.push(' ');
            continue;
        }
        pen = write_pen(out, pen, Pen::of(cell));
        // A tab leaves its mark in the cell it started from; the cells it skipped are written
        // as they are.
        out.push(if cell.c == '\t' { ' ' } else { cell.c });
        for &mark in cell.zerowidth().unwrap_or_default() {
            out.push(mark);
        }
    }
    if pen != Pen::default() {
        out.push_str("\x1b[0m");
    }
    wrapped
}

/// Writes encoded rows in order: a wrapped row runs into the next, and CRLF ends each line.
#[derive(Debug)]
pub(crate) struct Lines<'a> {
    out: &'a mut String,
    /// The last row wrapped: the line goes on in whatever is written next.
    open: bool,
}

impl<'a> Lines<'a> {
    pub(crate) fn new(out: &'a mut String) -> Self {
        Self { out, open: false }
    }

    pub(crate) fn row(&mut self, text: &str, wrapped: bool) {
        let start = self.out.len();
        self.out.push_str(text);
        self.end_row(start, wrapped);
    }

    /// Encodes `row` and writes it.
    pub(crate) fn grid_row(&mut self, row: &Row<Cell>) {
        let start = self.out.len();
        let wrapped = encode_row(row, self.out);
        self.end_row(start, wrapped);
    }

    fn end_row(&mut self, start: usize, wrapped: bool) {
        if self.open && self.out.len() == start {
            // A blank row a line wrapped into: one cell makes the wrap happen.
            self.out.push(' ');
        }
        self.open = wrapped;
        if !wrapped {
            self.out.push_str("\r\n");
        }
    }
}

/// The attributes that make a space visible: a foreground colour alone doesn't.
const VISIBLE_ON_A_SPACE: Flags = Flags::INVERSE
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::STRIKEOUT);

/// Writes `next` if it differs from `pen`, and returns it.
fn write_pen(out: &mut String, pen: Pen, next: Pen) -> Pen {
    if next != pen {
        next.write(out);
    }
    next
}

/// A space, or a tab's mark, that draws nothing: what a row's unwritten cells hold, and what
/// the encoder may leave off a row's end. It is checked for every cell of every row that leaves
/// the screen, the bulk of the engine's work in a flood, so it tests the fields that most often
/// differ first and leaves out the foreground colour.
fn is_blank(cell: &Cell) -> bool {
    (cell.c == ' ' || cell.c == '\t')
        && cell.extra.is_none()
        && !cell.flags.intersects(VISIBLE_ON_A_SPACE)
        && cell.bg == Color::Named(NamedColor::Background)
}

fn push_number(out: &mut String, mut n: u16) {
    let mut divisor = 10_000;
    while divisor > 1 && n < divisor {
        divisor /= 10;
    }
    while divisor > 0 {
        out.push(char::from(
            b'0' + u8::try_from(n / divisor % 10).unwrap_or(0),
        ));
        n %= divisor;
        divisor /= 10;
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
            underline: cell.extra.as_ref().and(cell.underline_color()),
            flags: cell.flags.difference(LAYOUT_FLAGS),
        }
    }

    fn write(&self, out: &mut String) {
        const ATTRIBUTES: [(Flags, &str); 11] = [
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
        out.push_str("\x1b[0");
        for (flag, code) in ATTRIBUTES {
            if self.flags.contains(flag) {
                out.push_str(code);
            }
        }
        write_color(out, self.fg, Slot::Foreground);
        write_color(out, self.bg, Slot::Background);
        if let Some(color) = self.underline {
            write_color(out, color, Slot::Underline);
        }
        out.push('m');
    }
}

#[derive(Debug, Clone, Copy)]
enum Slot {
    Foreground,
    Background,
    Underline,
}

fn write_color(out: &mut String, color: Color, slot: Slot) {
    let (base, bright, extended) = match slot {
        Slot::Foreground => (30, 90, 38),
        Slot::Background => (40, 100, 48),
        Slot::Underline => (0, 0, 58),
    };
    match color {
        Color::Named(named) => {
            let index = named as u16;
            let dim_black = NamedColor::DimBlack as u16;
            let index = match index {
                0..16 => index,
                i if (dim_black..dim_black + 8).contains(&i) => i - dim_black,
                _ => return,
            };
            out.push(';');
            if let Slot::Underline = slot {
                push_number(out, extended);
                out.push_str(":5:");
                push_number(out, index);
            } else if index < 8 {
                push_number(out, base + index);
            } else {
                push_number(out, bright + index - 8);
            }
        }
        Color::Indexed(index) => {
            out.push(';');
            push_number(out, extended);
            out.push_str(";5;");
            push_number(out, index.into());
        }
        Color::Spec(rgb) => {
            out.push(';');
            push_number(out, extended);
            out.push_str(";2;");
            push_number(out, rgb.r.into());
            out.push(';');
            push_number(out, rgb.g.into());
            out.push(';');
            push_number(out, rgb.b.into());
        }
    }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::index::Line;
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::Processor;

    use super::*;
    use crate::{Sink, Size};

    fn term(cols: u16, rows: u16) -> Term<Sink> {
        Term::new(Config::default(), &Size { cols, rows }, Sink::default())
    }

    fn feed(term: &mut Term<Sink>, bytes: &[u8]) {
        Processor::<alacritty_terminal::vte::ansi::StdSyncHandler>::new().advance(term, bytes);
    }

    /// Encodes every screen row of a terminal fed `stream`, replays the encoding into a fresh
    /// one, and returns both grids' rows.
    fn round_trip(stream: &[u8], cols: u16) -> (Vec<Vec<Cell>>, Vec<Vec<Cell>>) {
        let mut original = term(cols, 4);
        feed(&mut original, stream);
        let mut encoded = String::new();
        let mut lines = Lines::new(&mut encoded);
        for line in 0..4 {
            lines.grid_row(&original.grid()[Line(line)]);
        }
        // A row past the last, for the last line's CRLF to move to.
        let mut replayed = term(cols, 5);
        feed(&mut replayed, encoded.as_bytes());
        let rows = |t: &Term<Sink>| {
            (0..4)
                .map(|l| t.grid()[Line(l)].into_iter().cloned().collect())
                .collect::<Vec<Vec<Cell>>>()
        };
        (rows(&original), rows(&replayed))
    }

    #[test]
    fn colours_and_styles_are_written_as_they_were_drawn() {
        let stream = b"\x1b[1;3;4:3;9;31;48;5;200;58;2;1;2;3mA\x1b[0;2;7;8;38;2;9;8;7;101mB\x1b[0;4:2;95mC\x1b[0;21;44m D";
        let (original, replayed) = round_trip(stream, 10);
        assert_eq!(original, replayed);
    }

    #[test]
    fn wide_chars_and_combining_marks_survive() {
        let (original, replayed) = round_trip("中文e\u{301}😀x".as_bytes(), 10);
        assert_eq!(original, replayed);
    }

    #[test]
    fn a_wrapped_row_carries_on_into_the_next_with_its_blank_cells() {
        let (original, replayed) = round_trip(b"ab\x1b[44m   \x1b[0m  cd efg", 6);
        assert_eq!(original, replayed);
        assert!(original[0].last().unwrap().flags.contains(Flags::WRAPLINE));
    }

    #[test]
    fn a_wide_char_that_did_not_fit_moves_to_the_next_row_and_leaves_a_space() {
        let (mut original, replayed) = round_trip("abcde中".as_bytes(), 6);
        let spacer = &mut original[0][5];
        assert!(spacer.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER));
        spacer.flags.remove(Flags::LEADING_WIDE_CHAR_SPACER);
        assert_eq!(original, replayed);
    }

    #[test]
    fn a_wide_char_whose_spacer_was_erased_still_takes_two_cells() {
        // The erase starts on the spacer and clears it; the row still wraps after "e".
        let stream = "中\x1b[1;2H\x1b[K\x1b[1;3Hbcde\r\nxy".as_bytes();
        let (original, replayed) = round_trip(stream, 6);
        assert_eq!(original[1], replayed[1]);
        assert_eq!(original[0][2..], replayed[0][2..]);
    }

    #[test]
    fn a_row_after_a_wide_char_s_spacer_keeps_its_cells_in_place() {
        // The wide char left for the next row, and a line was inserted before it.
        let stream = "abcde中\x1b[Lxyz".as_bytes();
        let (original, replayed) = round_trip(stream, 6);
        assert_eq!(original[1], replayed[1]);
    }

    #[test]
    fn an_unwrapped_row_drops_its_trailing_default_blanks_but_keeps_coloured_ones() {
        let mut original = term(10, 2);
        feed(&mut original, b"ab  \x1b[41m  \x1b[0m  ");
        let mut encoded = String::new();
        encode_row(&original.grid()[Line(0)], &mut encoded);
        assert_eq!(encoded, "ab  \x1b[0;41m  \x1b[0m");
    }

    #[test]
    fn numbers_are_written_in_decimal() {
        for n in [0, 7, 10, 255, 9999, u16::MAX] {
            let mut out = String::new();
            push_number(&mut out, n);
            assert_eq!(out, n.to_string());
        }
    }
}
