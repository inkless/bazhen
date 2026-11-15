//! The engine against a bare alacritty terminal that keeps all of its history itself, the
//! reference. Fed the same output in the same pieces, the two hold the same screen, cursor and
//! history, row for row, until a resize (see [`Engine::resize`]):
//! - With the primary screen up, the engine reflows history it gave back to alacritty rewrapped,
//!   where the reference reflows its rows as they were. From then on the two hold the same cells
//!   that draw something, in the same order, with blank cells and line breaks free. Where
//!   alacritty's own reflow may lose cells, in either, only what it can't touch is compared: a
//!   widening drops rows below the cursor when history runs short, so the cells down to the
//!   cursor's row must agree as far as both go; a wide char whose spacer was erased can be lost
//!   anywhere, and nothing is compared.
//! - With the alternate screen up, the engine reflows the primary screen without its history,
//!   so the primary may differ on return: the alternate screen and cursor are compared until it
//!   ends, and nothing after.
//!
//! alacritty keeps the primary grid private while the alternate screen is up, so history is
//! compared only while the primary screen is up.

use alacritty_terminal::grid::{Dimensions, Row};
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::Processor;
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use proptest::prelude::*;

use super::*;
use crate::replies::VERSION;

mod restored;
mod tracked;

const ALL_OF_IT: usize = 1_000_000;

const VERSION_QUERY: &str = "\x1b[>q";

/// What a program that asks is told its colours are, on both sides.
const COLOURS: Colours = Colours {
    text: Rgb { r: 1, g: 2, b: 3 },
    background: Rgb { r: 4, g: 5, b: 6 },
};
/// More rows than a case makes, so the engine drops none.
const ENGINE_ROWS: usize = 20_000;

#[derive(Debug, Clone)]
enum Action {
    Text(String),
    Lines(u8),
    Sgr(u8, u8, bool),
    CrLf,
    Lf,
    Cr,
    Index,
    NextLine,
    ScrollUp(u8),
    DeleteLines(u8),
    InsertLines(u8),
    EraseDisplay(u8),
    EraseLine,
    MoveTo(u8, u8),
    Region(u8, u8),
    Reset,
    AltOn,
    AltOff,
    SyncOn,
    SyncOff,
    Query,
    /// XTVERSION, `CSI > q`.
    Version,
    /// OSC 10, 11, 4;1 or 12 asked, by `% 4`.
    ColourQuery(u8),
    /// OSC 11 or 4;1 set, by the first `% 2`, to a red of the second.
    SetColour(u8, u8),
    Repeat(u16),
    SaveCursor,
    RestoreCursor,
    TabForward(u8),
    Substitute,
    Resize(u16, u16),
    WriteHistory,
    /// HTS wherever the cursor is.
    TabStopHere,
    /// HTS at a column, from 1.
    TabStopAt(u8),
    /// TBC 0 wherever the cursor is.
    TabClearHere,
    TabClearAt(u8),
    TabClearAll,
    ShiftOut,
    ShiftIn,
    /// G0 to G3, and whether to DEC line drawing.
    Designate(u8, bool),
    /// A DEC private mode set or reset.
    Private(u16, bool),
    Keypad(bool),
    /// SM or RM: 4 is insert, 20 is new line.
    Ansi(u8, bool),
    /// DECSCUSR's parameter.
    CursorStyle(u8),
    /// OSC 50's shape.
    CursorShape(u8),
    KittyPush(u8),
    KittyPop(u8),
    /// The flags, and 1 to set, 2 to add, 3 to clear.
    KittySet(u8, u8),
    /// `CSI > Pp ; Pv m`.
    ModifyOtherKeys(u8, u8),
    SoftReset,
}

impl Action {
    fn bytes(&self) -> Option<String> {
        Some(match self {
            Self::Text(text) => text.clone(),
            Self::Lines(n) => (0..*n)
                .map(|i| "line ".to_owned() + &i.to_string() + "\r\n")
                .collect(),
            Self::Sgr(fg, bg, bold) => format!("\x1b[{};38;5;{fg};48;5;{bg}m", u8::from(*bold)),
            Self::CrLf => "\r\n".into(),
            Self::Lf => "\n".into(),
            Self::Cr => "\r".into(),
            Self::Index => "\x1bD".into(),
            Self::NextLine => "\x1bE".into(),
            Self::ScrollUp(n) => format!("\x1b[{n}S"),
            Self::DeleteLines(n) => format!("\x1b[{n}M"),
            Self::InsertLines(n) => format!("\x1b[{n}L"),
            Self::EraseDisplay(n) => format!("\x1b[{n}J"),
            Self::EraseLine => "\x1b[K".into(),
            Self::MoveTo(row, col) => format!("\x1b[{row};{col}H"),
            Self::Region(top, bottom) => format!("\x1b[{top};{bottom}r"),
            Self::Reset => "\x1bc".into(),
            Self::AltOn => "\x1b[?1049h".into(),
            Self::AltOff => "\x1b[?1049l".into(),
            Self::SyncOn => "\x1b[?2026h".into(),
            Self::SyncOff => "\x1b[?2026l".into(),
            Self::Query => "\x1b[6n".into(),
            Self::Version => VERSION_QUERY.into(),
            Self::ColourQuery(which) => [
                "\x1b]10;?\x07",
                "\x1b]11;?\x1b\\",
                "\x1b]4;1;?\x07",
                "\x1b]12;?\x07",
            ][usize::from(*which % 4)]
            .into(),
            Self::SetColour(which, red) => {
                let slot = if which % 2 == 0 { "11" } else { "4;1" };
                format!("\x1b]{slot};#{red:02x}0000\x07")
            }
            Self::Repeat(n) => format!("\x1b[{n}b"),
            Self::SaveCursor => "\x1b7".into(),
            Self::RestoreCursor => "\x1b8".into(),
            Self::TabForward(n) => format!("\x1b[{n}I"),
            Self::Substitute => "\x1a".into(),
            Self::TabStopHere => "\x1bH".into(),
            Self::TabStopAt(column) => format!("\x1b[{column}G\x1bH"),
            Self::TabClearHere => "\x1b[g".into(),
            Self::TabClearAt(column) => format!("\x1b[{column}G\x1b[0g"),
            Self::TabClearAll => "\x1b[3g".into(),
            Self::ShiftOut => "\x0e".into(),
            Self::ShiftIn => "\x0f".into(),
            Self::Designate(slot, drawing) => {
                let slot = ['(', ')', '*', '+'][usize::from(*slot % 4)];
                format!("\x1b{slot}{}", if *drawing { '0' } else { 'B' })
            }
            Self::Private(mode, on) => format!("\x1b[?{mode}{}", if *on { 'h' } else { 'l' }),
            Self::Keypad(on) => (if *on { "\x1b=" } else { "\x1b>" }).into(),
            Self::Ansi(mode, on) => format!("\x1b[{mode}{}", if *on { 'h' } else { 'l' }),
            Self::CursorStyle(style) => format!("\x1b[{style} q"),
            Self::CursorShape(shape) => format!("\x1b]50;CursorShape={shape}\x07"),
            Self::KittyPush(flags) => format!("\x1b[>{flags}u"),
            Self::KittyPop(count) => format!("\x1b[<{count}u"),
            Self::KittySet(flags, how) => format!("\x1b[={flags};{how}u"),
            Self::ModifyOtherKeys(resource, value) => format!("\x1b[>{resource};{value}m"),
            Self::SoftReset => "\x1b[!p".into(),
            Self::Resize(..) | Self::WriteHistory => return None,
        })
    }
}

/// Text with no wide chars and no tabs, as typed at a prompt.
fn narrow_text() -> impl Strategy<Value = String> {
    let pieces = prop::sample::select(vec!["a", "bc", "def ", " ", "e\u{301}", "xyzzy"]);
    prop::collection::vec(pieces, 1..20).prop_map(|p| p.concat())
}

fn text() -> impl Strategy<Value = String> {
    let pieces = prop::sample::select(vec![
        "a", "bc", "def ", " ", "  ", "\t", "中", "文字", "😀", "e\u{301}", "xyzzy",
    ]);
    prop::collection::vec(pieces, 0..40).prop_map(|p| p.concat())
}

/// One of every action but a resize.
fn output() -> impl Strategy<Value = Action> {
    prop_oneof![
        8 => text().prop_map(Action::Text),
        3 => (0u8..40).prop_map(Action::Lines),
        2 => (any::<u8>(), any::<u8>(), any::<bool>()).prop_map(|(f, b, x)| Action::Sgr(f, b, x)),
        4 => Just(Action::CrLf),
        1 => Just(Action::Lf),
        1 => Just(Action::Cr),
        1 => Just(Action::Index),
        1 => Just(Action::NextLine),
        2 => (0u8..30).prop_map(Action::ScrollUp),
        1 => (0u8..12).prop_map(Action::DeleteLines),
        1 => (0u8..12).prop_map(Action::InsertLines),
        2 => (0u8..4).prop_map(Action::EraseDisplay),
        1 => Just(Action::EraseLine),
        2 => (0u8..14, 0u8..30).prop_map(|(r, c)| Action::MoveTo(r, c)),
        1 => (0u8..10, 0u8..14).prop_map(|(t, b)| Action::Region(t, b)),
        1 => Just(Action::Reset),
        1 => Just(Action::AltOn),
        1 => Just(Action::AltOff),
        1 => Just(Action::SyncOn),
        1 => Just(Action::SyncOff),
        1 => Just(Action::Query),
        1 => Just(Action::Version),
        1 => (0u8..4).prop_map(Action::ColourQuery),
        1 => (0u8..2, any::<u8>()).prop_map(|(which, red)| Action::SetColour(which, red)),
        1 => (0u16..200).prop_map(Action::Repeat),
        1 => Just(Action::SaveCursor),
        1 => Just(Action::RestoreCursor),
        1 => (0u8..4).prop_map(Action::TabForward),
        1 => Just(Action::Substitute),
        1 => Just(Action::WriteHistory),
    ]
}

fn output_and_resizes() -> impl Strategy<Value = Action> {
    prop_oneof![
        12 => output(),
        1 => (1u16..30, 1u16..12).prop_map(|(c, r)| Action::Resize(c, r)),
    ]
}

/// The reference: alacritty alone, with room for all the history a case makes, and the engine's
/// workarounds for alacritty's and vte's bugs and its cap on marks a cell holds, which aren't
/// what the test compares.
struct FullHistory {
    term: Term<Sink>,
    parser: Processor,
    utf8: Utf8Seam,
    replies: Sink,
    /// Not compared: [`Capped`] needs one.
    tracker: Tracker,
    /// How much of [`VERSION_QUERY`] the bytes so far end in: the reference answers XTVERSION by
    /// matching the one form the cases write, not by the engine's read-ahead.
    version_matched: usize,
    /// Its history as it was when the alternate screen came up, which alacritty then keeps
    /// private, and how wide the screen was: a resize under the alternate screen doesn't touch
    /// what either terminal serves, but text that draws the same at one width can differ in its
    /// blanks at another.
    under_alt: (String, u16),
}

impl FullHistory {
    fn new(size: Size) -> Self {
        let replies = Sink::default();
        Self {
            term: Term::new(config(ALL_OF_IT), &size, replies.clone()),
            parser: Processor::new(),
            utf8: Utf8Seam::default(),
            replies,
            tracker: Tracker::new(size.usable().cols(), size.usable().rows()),
            version_matched: 0,
            under_alt: (String::new(), size.cols),
        }
    }

    /// Feeds `bytes`, answering each XTVERSION as it ends.
    fn advance(&mut self, bytes: &[u8]) {
        let query = VERSION_QUERY.as_bytes();
        let mut rest = bytes;
        while !rest.is_empty() {
            let mut end = None;
            for (at, &byte) in rest.iter().enumerate() {
                self.version_matched = match self.version_matched {
                    matched if query.get(matched) == Some(&byte) => matched + 1,
                    _ => usize::from(byte == 0x1b),
                };
                if self.version_matched == query.len() {
                    self.version_matched = 0;
                    end = Some(at + 1);
                    break;
                }
            }
            let (piece, after) = rest.split_at(end.unwrap_or(rest.len()));
            self.advance_noting_alt(piece);
            if end.is_some() {
                self.replies.push(VERSION);
            }
            rest = after;
        }
    }

    /// Feeds `bytes`, noting history just before each `h` that may bring up the alternate
    /// screen: no other byte does.
    fn advance_noting_alt(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while let Some(at) = rest.iter().position(|&byte| byte == b'h') {
            let (before, after) = rest.split_at(at);
            self.feed(before);
            if !self.alternate() {
                let cols = u16::try_from(self.term.grid().columns()).unwrap();
                self.under_alt = (self.history(), cols);
            }
            let (switch, after) = after.split_at(1);
            self.feed(switch);
            rest = after;
        }
        self.feed(rest);
    }

    /// Feeds `bytes`, working around vte's split chars as the engine does.
    fn feed(&mut self, bytes: &[u8]) {
        let (finish, rest) = self.utf8.finish(bytes);
        self.parser.advance(
            &mut Capped(&mut self.term, &mut self.tracker, &self.replies),
            finish,
        );
        self.parser.advance(
            &mut Capped(&mut self.term, &mut self.tracker, &self.replies),
            rest,
        );
        if !rest.is_empty() {
            self.utf8.note(rest);
        }
        self.parser.stop_sync(&mut Capped(
            &mut self.term,
            &mut self.tracker,
            &self.replies,
        ));
    }

    fn resize(&mut self, size: Size) {
        self.term.resize(size.usable());
        mark_widened_rows(&mut self.term);
    }

    fn history(&self) -> String {
        let mut out = String::new();
        write_scrollback(self.term.grid(), &mut Lines::new(&mut out));
        out
    }

    fn alternate(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }
}

/// A row's cells, as wide as the grid: alacritty can leave a row short after a reflow, and
/// `Row` has no equality. A cell reads as the encoder writes it: the mark alacritty leaves where a
/// tab started as a space, and a space drawn in nothing but a foreground colour as a blank.
type Cells = Vec<Cell>;

fn cells(row: &Row<Cell>, cols: usize) -> Cells {
    let mut cells: Cells = row
        .into_iter()
        .map(|cell| {
            let mut cell = cell.clone();
            if cell.c == '\t' {
                cell.c = ' ';
            }
            if cell.c == ' ' && cell.flags.is_empty() && cell.bg == Cell::default().bg {
                cell.fg = Cell::default().fg;
            }
            cell
        })
        .collect();
    cells.resize_with(cols.max(cells.len()), Cell::default);
    cells
}

fn screen(term: &Term<Sink>) -> Vec<Cells> {
    let grid = term.grid();
    (0..grid.screen_lines())
        .map(|n| cells(&grid[scrollback_line(0, n)], grid.columns()))
        .collect()
}

/// Every row a terminal `cols` wide draws `text` in: equal for two texts that draw the same
/// rows. Text the encoder wrote is drawn by the same terminal on both sides, so the few cells it
/// writes differently from how they were drawn (a tab's mark, a space's foreground) don't count.
/// The terminal is tall enough never to scroll: a row a scroll brings in is filled with the
/// background colour of the moment, which the row it stands for may not have been.
fn drawn(text: &str, cols: u16) -> Vec<Cells> {
    let rows = u16::try_from(text.len() + 1).unwrap();
    let mut term = FullHistory::new(Size { cols, rows });
    term.advance(text.as_bytes());
    let grid = term.term.grid();
    (0..=grid.cursor.point.line.0)
        .map(|n| cells(&grid[Line(n)], grid.columns()))
        .collect()
}

/// Rows as text, for a failure to show: `|` ends a row that wraps, `.` marks a spacer, and a
/// cell drawn in anything but the default colours is followed by `'`.
fn shown(rows: &[Cells]) -> String {
    let mut out = String::new();
    for row in rows {
        for cell in row {
            out.push(if cell.flags.intersects(SPACERS) {
                '.'
            } else {
                cell.c
            });
            if cell.fg != Color::Named(NamedColor::Foreground)
                || cell.bg != Color::Named(NamedColor::Background)
            {
                out.push('\'');
            }
        }
        out.push_str(if wraps(row) { "|\n" } else { "\n" });
    }
    out
}

const SPACERS: Flags = Flags::WIDE_CHAR_SPACER.union(Flags::LEADING_WIDE_CHAR_SPACER);

fn wraps(row: &Cells) -> bool {
    row.last()
        .is_some_and(|c| c.flags.contains(Flags::WRAPLINE))
}

/// History and then the screen down to row `last`, as one text.
fn history_and_screen(history: String, term: &Term<Sink>, last: usize) -> String {
    let mut out = history;
    let grid = term.grid();
    let mut lines = Lines::new(&mut out);
    for n in 0..grid.screen_lines().min(last + 1) {
        lines.grid_row(&grid[scrollback_line(0, n)]);
    }
    lines.finish();
    out
}

/// What differs between the two, if anything: screen, cursor, or, with the primary screen up,
/// history.
fn difference(engine: &Engine, full: &FullHistory) -> Option<String> {
    let (ours, theirs) = (screen(&engine.term), screen(&full.term));
    if ours != theirs {
        return Some(format!(
            "screen\nengine:\n{}reference:\n{}",
            shown(&ours),
            shown(&theirs)
        ));
    }
    let (cursor, other) = (&engine.term.grid().cursor, &full.term.grid().cursor);
    if (cursor.point, cursor.input_needs_wrap) != (other.point, other.input_needs_wrap) {
        return Some(format!(
            "cursor: {:?} against {:?}",
            cursor.point, other.point
        ));
    }
    // A reflow moves the saved cursor too, which DECRC shows.
    let (saved, other) = (
        engine.term.grid().saved_cursor.point,
        full.term.grid().saved_cursor.point,
    );
    if saved != other {
        return Some(format!("saved cursor: {saved:?} against {other:?}"));
    }
    let mut history = String::new();
    engine.write_history(&mut history);
    // Under the alternate screen alacritty keeps the primary's history private, and the engine
    // serves what it was when the screen came up.
    let (theirs, cols) = if full.alternate() {
        (&full.under_alt.0, full.under_alt.1)
    } else {
        (&full.history(), engine.size.cols)
    };
    let (ours, theirs) = (drawn(&history, cols), drawn(theirs, cols));
    (ours != theirs).then(|| {
        format!(
            "history\nengine:\n{}reference:\n{}",
            shown(&ours),
            shown(&theirs)
        )
    })
}

/// The cells that draw something, in order: what a resize must not lose or reorder.
fn visible(rows: &[Cells]) -> Vec<Cell> {
    drawing(rows, |cell| cell.c != ' ')
}

/// The cells that draw something, a background, or an attribute a blank shows, in order.
fn coloured(rows: &[Cells]) -> Vec<Cell> {
    drawing(rows, |cell| {
        cell.c != ' '
            || cell.bg != Cell::default().bg
            || cell.flags.intersects(encode::VISIBLE_ON_A_SPACE)
    })
}

fn drawing(rows: &[Cells], draws: fn(&Cell) -> bool) -> Vec<Cell> {
    rows.iter()
        .flatten()
        .filter(|cell| draws(cell) && !cell.flags.intersects(SPACERS))
        .map(|cell| {
            let mut cell = cell.clone();
            cell.flags.remove(Flags::WRAPLINE);
            cell
        })
        .collect()
}

/// How many cells come before the cursor in its line, across the rows it wraps over and into
/// history: `history` writes the history.
fn cursor_offset(term: &Term<Sink>, history: impl FnOnce(&mut Lines<'_>)) -> usize {
    let grid = term.grid();
    let cursor = &grid.cursor;
    let mut text = String::new();
    let mut lines = Lines::new(&mut text);
    history(&mut lines);
    for n in 0..cursor.point.line.0 {
        lines.grid_row(&grid[Line(n)]);
    }
    let line = text.rsplit("\r\n").next().unwrap_or_default();
    encode::cells(line) + cursor.point.column.0 + usize::from(cursor.input_needs_wrap)
}

fn assert_same_cursor_offset(engine: &Engine, full: &FullHistory) {
    let ours = cursor_offset(&engine.term, |lines| engine.write_lines(lines));
    let theirs = cursor_offset(&full.term, |lines| {
        write_scrollback(full.term.grid(), lines);
    });
    assert_eq!(ours, theirs, "the cursor's cells into its line");
}

/// Feeds both terminals `stream`, in pieces of the sizes `cuts` gives in turn.
fn feed(engine: &mut Engine, full: &mut FullHistory, stream: &str, cuts: &[usize]) {
    let mut rest = stream.as_bytes();
    for &cut in cuts.iter().cycle() {
        if rest.is_empty() {
            break;
        }
        let (piece, after) = rest.split_at(cut.min(rest.len()));
        engine.advance(piece);
        full.advance(piece);
        rest = after;
    }
}

/// Plays `actions` to both, checking they hold the same after each that isn't output, and
/// returns them.
fn run(size: Size, actions: &[Action], cuts: &[usize]) -> (Engine, FullHistory) {
    let mut engine = Engine::new(size, HistoryRows(ENGINE_ROWS));
    let mut full = FullHistory::new(size);
    engine.set_colours(Some(COLOURS));
    full.replies.set_colours(Some(COLOURS));
    let mut pending = String::new();
    // A resize under the alternate screen leaves the primary screen free to differ, and with it
    // everything after the alternate screen ends: the case ends there.
    let mut primary_may_differ = false;
    for action in actions {
        if primary_may_differ && matches!(action, Action::AltOff | Action::Reset) {
            return (engine, full);
        }
        if let Some(bytes) = action.bytes() {
            pending.push_str(&bytes);
            continue;
        }
        feed(&mut engine, &mut full, &pending, cuts);
        pending.clear();
        assert_same(&engine, &full);
        match *action {
            Action::Resize(cols, rows) => {
                let size = Size { cols, rows };
                if full.alternate() {
                    engine.resize(size);
                    full.resize(size);
                    primary_may_differ = true;
                    continue;
                }
                let drop_below = may_drop_rows_below_the_cursor(&full.term, size);
                let lose_wide = has_a_wide_char_without_its_spacer(&full.term);
                engine.resize(size);
                full.resize(size);
                if difference(&engine, &full).is_some() {
                    if !lose_wide {
                        let cursors = (&engine.term, &full.term);
                        let last = if drop_below {
                            let line = |term: &Term<Sink>| term.grid().cursor.point.line.0;
                            line(cursors.0).min(line(cursors.1))
                        } else {
                            i32::MAX
                        };
                        assert_same_visible_cells(&engine, &full, last, drop_below, visible);
                    }
                    return (engine, full);
                }
            }
            Action::WriteHistory => engine.write_history(&mut String::new()),
            _ => {}
        }
    }
    feed(&mut engine, &mut full, &pending, cuts);
    assert_same(&engine, &full);
    assert_eq!(engine.take_replies(), full.replies.take());
    (engine, full)
}

fn assert_same(engine: &Engine, full: &FullHistory) {
    assert_eq!(engine.stats().overflows, 0, "{engine:?}");
    if let Some(difference) = difference(engine, full) {
        panic!("the engine and the reference differ in their {difference}");
    }
}

/// The bound on how far a resize may part the two: every cell that draws something, in history
/// and on the screen down to row `last`, the same and in the same order. When rows below the
/// cursor may have been dropped, `last` is the cursor's row and one side may hold more above it
/// than the other, so one side's cells need only start the other's. What follows would differ,
/// so a case ends there.
fn assert_same_visible_cells(
    engine: &Engine,
    full: &FullHistory,
    last: i32,
    cut: bool,
    kept: fn(&[Cells]) -> Vec<Cell>,
) {
    let mut history = String::new();
    engine.write_history(&mut history);
    let cols = engine.size.cols;
    let last = usize::try_from(last).unwrap_or(0);
    let ours = kept(&drawn(
        &history_and_screen(history, &engine.term, last),
        cols,
    ));
    let theirs = kept(&drawn(
        &history_and_screen(full.history(), &full.term, last),
        cols,
    ));
    let same = if cut {
        ours.starts_with(&theirs) || theirs.starts_with(&ours)
    } else {
        ours == theirs
    };
    assert!(
        same,
        "visible cells differ after a resize\nengine: {}\nreference: {}",
        text_of(&ours),
        text_of(&theirs)
    );
}

fn text_of(cells: &[Cell]) -> String {
    cells.iter().map(|cell| cell.c).collect()
}

/// Whether `term` holds a wide char whose spacer was erased. alacritty's reflow moves such a
/// char as if it were narrow, and can lose it; the engine gave the rows back rewrapped from
/// text, where the spacer is whole again.
fn has_a_wide_char_without_its_spacer(term: &Term<Sink>) -> bool {
    let grid = term.grid();
    let scrolled = grid.history_size();
    (0..scrolled + grid.screen_lines()).any(|n| {
        let row = &grid[scrollback_line(scrolled, n)];
        let cells: Vec<&Cell> = row.into_iter().collect();
        cells.windows(2).any(|pair| {
            pair[0].flags.contains(Flags::WIDE_CHAR)
                && !pair[1].flags.contains(Flags::WIDE_CHAR_SPACER)
        })
    })
}

/// Whether `term` holds a row marked as wrapping in a cell but its last. alacritty leaves one when
/// it widens a line the cursor ends, or wraps from a cursor waiting in the first column, and the
/// next reflow reads it again; no text carries it, so the engine, which reflows history from
/// text, can't.
fn has_a_wrap_inside_a_row(term: &Term<Sink>) -> bool {
    let grid = term.grid();
    let scrolled = grid.history_size();
    (0..scrolled + grid.screen_lines()).any(|n| {
        let row = &grid[scrollback_line(scrolled, n)];
        let cells: Vec<&Cell> = row.into_iter().collect();
        cells
            .split_last()
            .is_some_and(|(_, inside)| inside.iter().any(|c| c.flags.contains(Flags::WRAPLINE)))
    })
}

/// Whether a resize to `size` widens the screen while something below the cursor draws.
/// alacritty's reflow then keeps the cursor's row where it was by pulling rows down from history
/// and, short of history, drops rows below the cursor as if they were blank. The reference and
/// the engine hold that history in rows split differently, so either may drop rows the other
/// keeps.
fn may_drop_rows_below_the_cursor(term: &Term<Sink>, size: Size) -> bool {
    let grid = term.grid();
    let below = (grid.cursor.point.line.0 + 1)..i32::try_from(grid.screen_lines()).unwrap();
    usize::from(size.usable().cols) > grid.columns()
        && below
            .into_iter()
            .any(|line| grid[Line(line)].into_iter().any(|c| c.c != ' '))
}

fn size() -> impl Strategy<Value = Size> {
    (2u16..30, 1u16..12).prop_map(|(cols, rows)| Size { cols, rows })
}

fn cuts() -> impl Strategy<Value = Vec<usize>> {
    prop::collection::vec(1usize..400, 1..8)
}

/// A shell's prompt, left with the cursor in its line, then resizes, and text typed after some:
/// the cursor must stay as many cells into the line, and the text land where it did, until
/// alacritty leaves a mark the engine can't follow (see `has_a_wrap_inside_a_row`).
fn cursor_stays_as_far_into_its_line(
    size: Size,
    lines: &[String],
    prompt: &str,
    resizes: &[((u16, u16), Option<String>)],
    cuts: &[usize],
) {
    let mut engine = Engine::new(size, HistoryRows(ENGINE_ROWS));
    let mut full = FullHistory::new(size);
    let stream: String = lines.iter().map(|line| line.clone() + "\r\n").collect();
    feed(&mut engine, &mut full, &(stream + prompt), cuts);
    for ((cols, rows), typed) in resizes {
        if has_a_wrap_inside_a_row(&full.term) {
            return;
        }
        let size = Size {
            cols: *cols,
            rows: *rows,
        };
        engine.resize(size);
        full.resize(size);
        assert_same_cursor_offset(&engine, &full);
        if let Some(typed) = typed {
            feed(&mut engine, &mut full, typed, cuts);
            assert_same_cursor_offset(&engine, &full);
            assert_same_visible_cells(&engine, &full, i32::MAX, false, visible);
        }
    }
}

#[test]
fn narrowed_onto_more_rows_then_fewer_a_prompt_of_wide_chars_keeps_the_cells_alacritty_keeps() {
    // The shrunk case CI found. alacritty adds rows before it reflows the columns, so the rows
    // a heightening pulls from history are counted at the old width, not the new: an engine
    // that gave back too few pads the screen with a blank row the reference doesn't have, and
    // the row-shrink after drops a different row below the cursor on each side.
    cursor_stays_as_far_into_its_line(
        Size { cols: 10, rows: 1 },
        &[String::new(), "\taaa\t字a\taaa\ta中".to_owned()],
        "中中中中",
        &[((3, 7), None), ((2, 6), Some("a".to_owned()))],
        &[1],
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn without_a_resize_the_engine_holds_exactly_what_alacritty_with_all_its_history_does(
        size in size(),
        actions in prop::collection::vec(output(), 0..80),
        cuts in cuts(),
    ) {
        run(size, &actions, &cuts);
    }

    #[test]
    fn a_resize_keeps_every_cell_that_draws_something_in_order(
        size in size(),
        actions in prop::collection::vec(output_and_resizes(), 0..80),
        cuts in cuts(),
    ) {
        run(size, &actions, &cuts);
    }

    #[test]
    fn through_any_resizes_lines_of_text_keep_every_cell_that_draws_something_in_order(
        size in size(),
        actions in prop::collection::vec(prop_oneof![
            4 => text().prop_map(|text| Action::Text(text + "\r\n")),
            1 => (0u8..40).prop_map(Action::Lines),
            2 => (1u16..30, 1u16..12).prop_map(|(c, r)| Action::Resize(c, r)),
        ], 0..60),
        cuts in cuts(),
    ) {
        // Whole lines of text draw nothing below the cursor and leave every wide char its
        // spacer, so no reflow loses a cell, and leave the cursor where a line starts, where
        // what follows lands the same after a reflow that broke lines differently: every resize
        // is compared, not just the first.
        let mut engine = Engine::new(size, HistoryRows(ENGINE_ROWS));
        let mut full = FullHistory::new(size);
        for action in &actions {
            match (action.bytes(), action) {
                (Some(bytes), _) => feed(&mut engine, &mut full, &bytes, &cuts),
                (None, &Action::Resize(cols, rows)) => {
                    engine.resize(Size { cols, rows });
                    full.resize(Size { cols, rows });
                    prop_assert_eq!(engine.stats().overflows, 0);
                    assert_same_visible_cells(&engine, &full, i32::MAX, false, visible);
                }
                (None, _) => {}
            }
        }
    }

    #[test]
    fn through_any_resizes_coloured_lines_keep_every_cell_that_draws_something_or_a_background(
        size in size(),
        lines in prop::collection::vec(
            (any::<u8>(), any::<Option<u8>>(), any::<bool>(), 0usize..5, text(), any::<bool>()),
            0..40,
        ),
        resizes in prop::collection::vec((1u16..30, 1u16..12), 1..8),
        cuts in cuts(),
    ) {
        // Lines in a colour, or on the default background with an attribute a blank shows, their
        // rest erased to the background or not, so that runs of blanks in a colour or inverse or
        // underlined must stay too, as they were drawn. Each ends in the default pen: a line feed
        // in a colour fills the row under the cursor, which a reflow may drop (see
        // `may_drop_rows_below_the_cursor`). The output all comes first: after a reflow the
        // cursor's row may differ, and a wrap in a colour then fills a new row only on one side.
        let mut engine = Engine::new(size, HistoryRows(ENGINE_ROWS));
        let mut full = FullHistory::new(size);
        let mut stream = String::new();
        for (fg, bg, bold, attribute, text, erase) in lines {
            stream += &Action::Sgr(fg, bg.unwrap_or_default(), bold).bytes().unwrap_or_default();
            if bg.is_none() {
                stream += "\x1b[49m";
            }
            stream += ["", "\x1b[7m", "\x1b[4m", "\x1b[4:3m", "\x1b[9m"][attribute];
            stream += &text;
            if erase {
                stream += "\x1b[K";
            }
            stream += "\x1b[0m\r\n";
        }
        feed(&mut engine, &mut full, &stream, &cuts);
        for (cols, rows) in resizes {
            engine.resize(Size { cols, rows });
            full.resize(Size { cols, rows });
            prop_assert_eq!(engine.stats().overflows, 0);
            assert_same_visible_cells(&engine, &full, i32::MAX, false, coloured);
        }
    }

    #[test]
    fn through_any_resizes_the_cursor_stays_as_far_into_its_line(
        size in size(),
        lines in prop::collection::vec(text(), 0..20),
        prompt in text(),
        resizes in prop::collection::vec(
            ((1u16..30, 1u16..12), prop::option::of(narrow_text())), 1..8),
        cuts in cuts(),
    ) {
        cursor_stays_as_far_into_its_line(size, &lines, &prompt, &resizes, &cuts);
    }

    #[test]
    fn past_its_limit_the_store_keeps_the_newest_rows(
        size in size(),
        actions in prop::collection::vec(output(), 0..80),
        cuts in cuts(),
        limit in 0usize..60,
    ) {
        let (_, full) = run(size, &actions, &cuts);
        if full.alternate() {
            return Ok(());
        }
        let mut engine = Engine::new(size, HistoryRows(limit));
        let stream: String = actions.iter().filter_map(Action::bytes).collect();
        let mut rest = stream.as_bytes();
        for &cut in cuts.iter().cycle() {
            if rest.is_empty() {
                break;
            }
            let (piece, after) = rest.split_at(cut.min(rest.len()));
            engine.advance(piece);
            rest = after;
        }
        let encoded = |grid: &alacritty_terminal::Grid<Cell>| -> Vec<(String, Ending)> {
            let scrolled = grid.history_size();
            (0..scrolled)
                .map(|n| {
                    let mut text = String::new();
                    let ending = encode_row(&grid[scrollback_line(scrolled, n)], &mut text);
                    (text, ending)
                })
                .collect()
        };
        // What the engine keeps: the store and the row a drain leaves, unless it keeps none.
        let mut ours = engine.history.rows_for_test();
        if limit > 0 {
            ours.extend(encoded(engine.term.grid()));
        }
        let theirs = encoded(full.term.grid());
        prop_assert_eq!(ours.len(), theirs.len().min(limit));
        prop_assert_eq!(engine.stats().history_rows, ours.len());
        prop_assert_eq!(&ours[..], &theirs[theirs.len() - ours.len()..]);
    }
}
