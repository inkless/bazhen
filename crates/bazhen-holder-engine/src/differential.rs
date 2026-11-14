//! The engine against a bare alacritty terminal that keeps all of its history itself.
//! Fed the same output in the same pieces, the two hold the same screen, cursor and history, row
//! for row. alacritty keeps the primary grid private while the alternate screen is up, so history
//! is compared only while the primary screen is up.

use alacritty_terminal::grid::{Dimensions, Row};
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::Processor;
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use proptest::prelude::*;

use super::*;

const ALL_OF_IT: usize = 1_000_000;

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
    Repeat(u16),
    SaveCursor,
    RestoreCursor,
    TabForward(u8),
    Substitute,
    WriteHistory,
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
            Self::Repeat(n) => format!("\x1b[{n}b"),
            Self::SaveCursor => "\x1b7".into(),
            Self::RestoreCursor => "\x1b8".into(),
            Self::TabForward(n) => format!("\x1b[{n}I"),
            Self::Substitute => "\x1a".into(),
            Self::WriteHistory => return None,
        })
    }
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
        1 => (0u16..200).prop_map(Action::Repeat),
        1 => Just(Action::SaveCursor),
        1 => Just(Action::RestoreCursor),
        1 => (0u8..4).prop_map(Action::TabForward),
        1 => Just(Action::Substitute),
        1 => Just(Action::WriteHistory),
    ]
}

/// The reference: alacritty alone, with room for all the history a case makes, and the engine's
/// workarounds for alacritty's and vte's bugs, which aren't what the test compares.
struct FullHistory {
    term: Term<Sink>,
    parser: Processor,
    utf8: Utf8Seam,
    replies: Sink,
}

impl FullHistory {
    fn new(size: Size) -> Self {
        let replies = Sink::default();
        Self {
            term: Term::new(config(ALL_OF_IT), &size, replies.clone()),
            parser: Processor::new(),
            utf8: Utf8Seam::default(),
            replies,
        }
    }

    fn advance(&mut self, bytes: &[u8]) {
        let (finish, rest) = self.utf8.finish(bytes);
        self.parser.advance(&mut self.term, finish);
        self.parser.advance(&mut self.term, rest);
        if !rest.is_empty() {
            self.utf8.note(rest);
        }
        self.parser.stop_sync(&mut self.term);
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
    if full.alternate() {
        return None;
    }
    let mut history = String::new();
    engine.write_history(&mut history);
    let cols = engine.size.cols;
    let (ours, theirs) = (drawn(&history, cols), drawn(&full.history(), cols));
    (ours != theirs).then(|| {
        format!(
            "history\nengine:\n{}reference:\n{}",
            shown(&ours),
            shown(&theirs)
        )
    })
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
    let mut engine = Engine::new(size, HistoryRows(ALL_OF_IT));
    let mut full = FullHistory::new(size);
    let mut pending = String::new();
    for action in actions {
        if let Some(bytes) = action.bytes() {
            pending.push_str(&bytes);
            continue;
        }
        feed(&mut engine, &mut full, &pending, cuts);
        pending.clear();
        assert_same(&engine, &full);
        if let Action::WriteHistory = action {
            engine.write_history(&mut String::new());
        }
    }
    feed(&mut engine, &mut full, &pending, cuts);
    assert_same(&engine, &full);
    assert_eq!(engine.take_replies(), full.replies.0.take().into_bytes());
    (engine, full)
}

fn assert_same(engine: &Engine, full: &FullHistory) {
    assert_eq!(engine.stats().overflows, 0, "{engine:?}");
    if let Some(difference) = difference(engine, full) {
        panic!("the engine and the reference differ in their {difference}");
    }
}

fn size() -> impl Strategy<Value = Size> {
    (2u16..30, 1u16..12).prop_map(|(cols, rows)| Size { cols, rows })
}

fn cuts() -> impl Strategy<Value = Vec<usize>> {
    prop::collection::vec(1usize..400, 1..8)
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
        let mut ours = engine.history.rows_for_test();
        ours.extend(encoded(engine.term.grid()));
        let theirs = encoded(full.term.grid());
        prop_assert!(engine.history.rows() <= limit);
        prop_assert_eq!(ours.len(), theirs.len().min(limit + engine.term.grid().history_size()));
        prop_assert_eq!(&ours[..], &theirs[theirs.len() - ours.len()..]);
    }
}
