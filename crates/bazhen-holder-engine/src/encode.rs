//! Writes grid rows as plain VT: their characters with the SGR that draws them. Written from
//! column 0 of a terminal of the same width, in the default pen, [`Lines`] reproduces each row's
//! cells and where it wraps; at another width, a viewer rewraps each line as it reads it.
//!
//! Only the pen is written: a cell's OSC 8 hyperlink is not, so a link's text reaches history
//! as plain text.

use alacritty_terminal::grid::Row;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use unicode_width::UnicodeWidthChar as _;

const LAYOUT_FLAGS: Flags = Flags::WRAPLINE
    .union(Flags::WIDE_CHAR)
    .union(Flags::WIDE_CHAR_SPACER)
    .union(Flags::LEADING_WIDE_CHAR_SPACER);

/// How a row starts and ends, which is what [`Lines`] needs to join it to its neighbours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ending {
    /// It wraps into the next row.
    pub(crate) wrapped: bool,
    /// It ends in the cell a wide char didn't fit in, which isn't written: see [`Lines`].
    pub(crate) spacer: bool,
    /// Its first cell is a wide char.
    pub(crate) wide_start: bool,
}

/// Appends `row`'s cells to `out`, with the pen back at the default, and says how it ends. A row
/// that wraps is written in full, so that writing the next one wraps there too; one that doesn't
/// stops at its last cell that isn't blank.
pub(crate) fn encode_row(row: &Row<Cell>, out: &mut String) -> Ending {
    let wrapped = row
        .last()
        .is_some_and(|cell| cell.flags.contains(Flags::WRAPLINE));
    // Whether the first cell is written as a wide char.
    let mut wide_start = false;
    let mut spacer = false;
    let end = if wrapped {
        row.len()
    } else {
        row.into_iter()
            .rposition(|cell| !is_blank(cell))
            .map_or(0, |last| last + 1)
    };
    let mut pen = Pen::default();
    let mut covered = false;
    let last = row.len().saturating_sub(1);
    let cells: Vec<&Cell> = row.into_iter().collect();
    for (column, &cell) in cells.iter().take(end).enumerate() {
        if std::mem::replace(&mut covered, cell.flags.contains(Flags::WIDE_CHAR)) {
            continue;
        }
        // The cell a wide char didn't fit in, when the row wraps there. Anywhere else, as a
        // widening that doesn't reflow leaves it, it is the blank it draws.
        if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) && wrapped && column == last {
            spacer = true;
            continue;
        }
        pen = write_pen(out, pen, Pen::of(cell));
        wide_start |= column == 0 && cell.flags.contains(Flags::WIDE_CHAR);
        out.push(drawable(cell.c));
        for &mark in cell.zerowidth().unwrap_or_default() {
            out.push(mark);
        }
    }
    if pen != Pen::default() {
        out.push_str("\x1b[0m");
    }
    Ending {
        wrapped,
        spacer,
        wide_start,
    }
}

/// Writes encoded rows in order: a wrapped row runs into the next, and CRLF ends each line.
///
/// A row that ends in the cell a wide char didn't fit in is followed, nearly always, by a row
/// that starts with that char, which wraps there by itself, so the cell isn't written: a viewer of
/// another width would show it as a stray space. When the next row starts otherwise (a line
/// inserted between them), the cell is written as a space, which keeps that row's cells in place.
#[derive(Debug)]
pub(crate) struct Lines<'a> {
    out: &'a mut String,
    /// The last row wrapped: the line goes on in whatever is written next.
    open: bool,
    /// The last row ended in the cell a wide char didn't fit in.
    spacer: bool,
    /// The width the rows are drawn at, when a line's end must erase what follows it.
    erase_at: Option<usize>,
    /// The column the line so far ends in at `erase_at`, printed as a terminal that wide prints
    /// it, whatever width its rows were kept at: `erase_at` itself for a cursor waiting to wrap.
    column: usize,
}

impl<'a> Lines<'a> {
    pub(crate) fn new(out: &'a mut String) -> Self {
        Self {
            out,
            open: false,
            spacer: false,
            erase_at: None,
            column: 0,
        }
    }

    /// Lines for a terminal `cols` wide, each erasing the rest of its row once it ends. A wrap
    /// that scrolls fills the new row with the background of the pen that wraps, which is the
    /// pen of the next row's first cell: the cells past a line's end never had it.
    pub(crate) fn erasing(out: &'a mut String, cols: usize) -> Self {
        Self {
            erase_at: Some(cols.max(1)),
            ..Self::new(out)
        }
    }

    pub(crate) fn row(&mut self, text: &str, ending: Ending) {
        let start = self.out.len();
        self.out.push_str(text);
        self.end_row(start, ending);
    }

    /// Encodes `row` and writes it.
    pub(crate) fn grid_row(&mut self, row: &Row<Cell>) {
        let start = self.out.len();
        let ending = encode_row(row, self.out);
        self.end_row(start, ending);
    }

    /// What has been written since the last time this was emptied: a snapshot passes it on row
    /// by row, so it never holds more than a row.
    pub(crate) fn text(&mut self) -> &mut String {
        self.out
    }

    /// Whether the last row wrapped, so the line goes on in whatever is written next.
    pub(crate) fn is_open(&self) -> bool {
        self.open
    }

    /// Writes what the last row still owes: a spacer, which whatever comes next may need.
    pub(crate) fn finish(self) {
        if self.spacer {
            self.out.push(' ');
        }
    }

    fn end_row(&mut self, start: usize, ending: Ending) {
        let wrote = self.out.len() > start;
        // It fills the row before's last cell, so it can't be the cell that wraps; drawn at
        // another width, only where the line ends a cell short of a row's end, or it would start
        // the next row.
        let owed = self.erase_at.is_none_or(|cols| self.column + 1 == cols);
        if std::mem::take(&mut self.spacer) && !ending.wide_start && owed {
            self.out.insert(start, ' ');
        }
        if self.open && !wrote {
            // A blank row a line wrapped into: one cell makes the wrap happen.
            self.out.push(' ');
        }
        if let Some(cols) = self.erase_at {
            self.column = printed_to(self.column, self.out.get(start..).unwrap_or_default(), cols);
        }
        self.open = ending.wrapped;
        self.spacer = ending.spacer;
        if !ending.wrapped {
            self.close_line();
        }
    }

    /// Whether the line so far ends where a row does at `erase_at`, so what is written next starts
    /// a row of its own: waiting to wrap, or in the last cell, which a spacer it owes fills or a
    /// wide char that comes next wraps from.
    pub(crate) fn at_a_row_start(&self) -> bool {
        self.erase_at.is_none_or(|cols| {
            !self.open || self.column == cols || (self.spacer && self.column + 1 == cols)
        })
    }

    /// Ends the line where it is, for what follows to start a row of its own.
    pub(crate) fn end_line(&mut self) {
        if self.open {
            self.open = false;
            self.spacer = false;
            self.close_line();
        }
    }

    fn close_line(&mut self) {
        // Not from a cursor waiting to wrap in the last column: that would erase the cell.
        if self.erase_at.is_some_and(|cols| self.column != cols) {
            self.out.push_str("\x1b[K");
        }
        self.out.push_str("\r\n");
        self.column = 0;
    }
}

/// The column a terminal `cols` wide ends in after printing `text`, the SGR in it skipped, from
/// `column`: as alacritty prints, a char past a waiting cursor wraps first, and a wide char with
/// one cell left wraps and leaves it. `cols` is a cursor waiting to wrap. It assumes autowrap
/// on, as in a fresh terminal: a snapshot writes the modes after the rows.
fn printed_to(mut column: usize, text: &str, cols: usize) -> usize {
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            chars.by_ref().find(|&c| c == 'm');
            continue;
        }
        let width = c.width().unwrap_or(0);
        if width == 0 {
            continue;
        }
        if column >= cols || (width == 2 && column + 2 > cols) {
            column = 0;
        }
        column = (column + width).min(cols);
    }
    column
}

/// The char a cell is written as. A tab leaves its mark in the cell it started from, which draws a
/// blank; the cells it skipped are written as they are.
pub(crate) fn drawable(c: char) -> char {
    if c == '\t' { ' ' } else { c }
}

/// The cells a row [`encode_row`] wrote draws: its chars' widths, past the SGR it writes.
pub(crate) fn cells(text: &str) -> usize {
    past_pen(text).map(|c| c.width().unwrap_or(0)).sum()
}

/// The chars a row [`encode_row`] wrote, past the SGR it writes.
pub(crate) fn past_pen(text: &str) -> impl Iterator<Item = char> + '_ {
    let mut chars = text.chars();
    std::iter::from_fn(move || {
        loop {
            match chars.next()? {
                '\x1b' => {
                    chars.by_ref().find(|&c| c == 'm');
                }
                c => return Some(c),
            }
        }
    })
}

/// The attributes that make a space visible: a foreground colour alone doesn't.
pub(crate) const VISIBLE_ON_A_SPACE: Flags = Flags::INVERSE
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

/// The attributes a cell is drawn in, or a cursor draws in next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Pen {
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
    pub(crate) fn of(cell: &Cell) -> Self {
        Self {
            fg: cell.fg,
            bg: cell.bg,
            underline: cell.extra.as_ref().and(cell.underline_color()),
            flags: cell.flags.difference(LAYOUT_FLAGS),
        }
    }

    /// SGR from a reset: the whole pen, whatever came before.
    pub(crate) fn write(&self, out: &mut String) {
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

    #[test]
    fn a_row_s_cells_are_its_chars_widths_past_its_sgr() {
        let mut t = term(12, 1);
        feed(
            &mut t,
            "\x1b[1;38;5;9;48;2;1;2;3ma中e\u{301}\x1b[4:3;58:5:1mb\x1b[0m c".as_bytes(),
        );
        let mut text = String::new();
        encode_row(&t.grid()[Line(0)], &mut text);
        assert_eq!(cells(&text), 7);
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
        lines.finish();
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
    fn a_wide_char_that_did_not_fit_moves_to_the_next_row_and_its_cell_is_left_unwritten() {
        let (original, replayed) = round_trip("abcde中".as_bytes(), 6);
        assert!(
            original[0][5]
                .flags
                .contains(Flags::LEADING_WIDE_CHAR_SPACER)
        );
        assert_eq!(original, replayed);
    }

    #[test]
    fn rewrapped_wider_a_wide_char_that_wrapped_leaves_no_space_before_it() {
        let mut narrow = term(6, 2);
        feed(&mut narrow, "abcde中".as_bytes());
        let mut encoded = String::new();
        let mut lines = Lines::new(&mut encoded);
        lines.grid_row(&narrow.grid()[Line(0)]);
        lines.grid_row(&narrow.grid()[Line(1)]);
        lines.finish();
        assert_eq!(encoded, "abcde中\r\n");
    }

    #[test]
    fn a_space_a_row_owes_isn_t_written_once_its_line_fills_the_row() {
        // Kept at 4 columns, abc ended in 中's spacer, and xyz was written over 中. At 3 columns
        // abc fills its row, so the space would start the next one.
        let mut out = String::new();
        let mut lines = Lines::erasing(&mut out, 3);
        let ending = |wrapped, spacer| Ending {
            wrapped,
            spacer,
            wide_start: false,
        };
        lines.row("abc", ending(true, true));
        lines.row("xyz", ending(false, false));
        assert_eq!(out, "abcxyz\r\n");
    }

    #[test]
    fn a_blank_row_after_a_wide_char_s_spacer_still_takes_a_row_of_its_own() {
        // The wide char left for the next row, which was then erased and wraps no further.
        let stream = "abc中\x1b[2K\r\nx".as_bytes();
        let (original, replayed) = round_trip(stream, 4);
        // The spacer comes back as the space it draws, still wrapping into the blank row.
        assert_eq!(original[1..], replayed[1..]);
        assert!(replayed[0][3].flags.contains(Flags::WRAPLINE));
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
