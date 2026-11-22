//! The modes the engine tracks against what alacritty does with them. What alacritty keeps to
//! itself is read from how a terminal fed the same output behaves: where a tab lands, where a
//! line feed scrolls, what a `q` prints. Kitty's flags, which alacritty ignores with them off,
//! are held against an alacritty that has them on.

use alacritty_terminal::index::Column;
use alacritty_terminal::vte::ansi::{CursorStyle as Style, KeyboardModes, StdSyncHandler};

use super::*;
use crate::modes::MOST_KEYBOARD_MODES;

/// The engine, the reference, and a second reference that ends a column wider, to find whether
/// the last column has a tab stop: a tab always stops there.
struct Case {
    engine: Engine,
    full: FullHistory,
    wide: FullHistory,
    resized: bool,
}

impl Case {
    fn new(size: Size) -> Self {
        Self {
            engine: Engine::new(size, HistoryRows(100)),
            full: FullHistory::new(size),
            wide: FullHistory::new(size),
            resized: false,
        }
    }

    fn play(&mut self, actions: &[Action], cuts: &[usize]) {
        for action in actions {
            // After a resize the engine's cursor may stand elsewhere than the reference's (see
            // `Engine::resize`), and a tab stop set where it stands would differ with it.
            let here = matches!(action, Action::TabStopHere | Action::TabClearHere);
            if self.resized && here {
                continue;
            }
            match (action.bytes(), action) {
                (Some(bytes), _) => self.feed(bytes.as_bytes(), cuts),
                (None, &Action::Resize(cols, rows)) => {
                    let size = Size { cols, rows };
                    self.engine.resize(size);
                    self.full.resize(size);
                    self.wide.resize(size);
                    self.resized = true;
                }
                (None, _) => {}
            }
            assert_whole("engine", &self.engine.term);
            assert_whole("reference", &self.full.term);
            assert_whole("wider reference", &self.wide.term);
        }
    }

    fn feed(&mut self, stream: &[u8], cuts: &[usize]) {
        let mut rest = stream;
        for &cut in cuts.iter().cycle() {
            if rest.is_empty() {
                break;
            }
            let (piece, after) = rest.split_at(cut.min(rest.len()));
            self.engine.advance(piece);
            self.full.advance(piece);
            self.wide.advance(piece);
            rest = after;
        }
    }

    /// Probes the references, which it leaves changed, against what the engine says.
    fn assert_mirrored(mut self) {
        let modes = self.engine.modes();
        let style = modes
            .cursor
            .style
            .unwrap_or_else(|| CursorStyle::from(Style::default()));
        assert_eq!(CursorStyle::from(self.full.term.cursor_style()), style);
        // A resize under the alternate screen moves the primary's cursor out of sight.
        if self.full.alternate() && !self.resized {
            let copy = self.engine.tracker.primary().cloned();
            self.full.feed(b"\x1b[?1049l");
            let grid = self.full.term.grid();
            assert_eq!(copy.as_ref(), Some(&grid.cursor), "the primary's cursor");
            assert_eq!(copy.as_ref(), Some(&grid.saved_cursor), "its saved cursor");
        }
        let cols = self.full.term.columns();
        assert_eq!(
            tab_stops(&mut self.full, &mut self.wide),
            modes.screen.tab_stops,
            "tab stops, {cols} columns"
        );
        assert_eq!(region(&mut self.full), modes.screen.region, "the region");
        assert_eq!(
            shifted_out(&mut self.full),
            modes.screen.active_charset == ActiveCharset::G1,
            "the active charset"
        );
    }
}

fn column(full: &FullHistory) -> usize {
    full.term.grid().cursor.point.column.0
}

fn line(full: &FullHistory) -> i32 {
    full.term.grid().cursor.point.line.0
}

/// Column 0 by a back tab from column 1, which lands there only on a stop; the columns between
/// by tabs from column 0; the last by a tab from the column before it, a column wider.
fn tab_stops(full: &mut FullHistory, wide: &mut FullHistory) -> Vec<u16> {
    let cols = full.term.columns();
    let mut stops = Vec::new();
    full.feed(b"\x1b[2G\x1b[Z");
    if column(full) == 0 {
        stops.push(0);
    }
    full.feed(b"\x1b[1G");
    for _ in 0..cols {
        full.feed(b"\t");
        let at = column(full);
        if at + 1 >= cols {
            break;
        }
        stops.push(at);
    }
    wide.resize(Size {
        cols: u16::try_from(cols + 1).unwrap(),
        rows: u16::try_from(wide.term.screen_lines()).unwrap(),
    });
    wide.feed(format!("\x1b[{}G\t", cols - 1).as_bytes());
    if column(wide) == cols - 1 {
        stops.push(cols - 1);
    }
    stops
        .into_iter()
        .map(|c| u16::try_from(c).unwrap())
        .collect()
}

/// A line feed stays on the region's last row, or the screen's; a reverse index on the region's
/// first, or the screen's. A region set past the bottom is empty, and shows only in that a line
/// feed on the last row scrolls nothing.
fn region(full: &mut FullHistory) -> std::ops::Range<u16> {
    let rows = full.term.screen_lines();
    full.feed(b"\x1b[?6l");
    let (mut feeds, mut indexes) = (Vec::new(), Vec::new());
    for row in 0..rows {
        let at = i32::try_from(row).unwrap();
        full.feed(format!("\x1b[{};1H\n", row + 1).as_bytes());
        if line(full) == at {
            feeds.push(row);
        }
        full.feed(format!("\x1b[{};1H\x1bM", row + 1).as_bytes());
        if line(full) == at {
            indexes.push(row);
        }
    }
    let start = indexes.into_iter().find(|&row| row != 0).unwrap_or(0);
    let end = feeds
        .into_iter()
        .find(|&row| row + 1 != rows)
        .map_or(rows, |row| row + 1);
    let to_u16 = |row: usize| u16::try_from(row).unwrap();
    if (start, end) == (0, rows) {
        full.feed(format!("\x1b[2J\x1b[1;1HX\x1b[{rows};1H\n").as_bytes());
        if full.term.grid()[Line(0)][Column(0)].c == 'X' {
            return to_u16(rows)..to_u16(rows);
        }
    }
    to_u16(start)..to_u16(end)
}

/// With G0 ASCII and G1 DEC line drawing, whether a `q` prints as a line.
fn shifted_out(full: &mut FullHistory) -> bool {
    full.feed(b"\x1b(B\x1b)0\x1b[1Gq");
    let row = Line(line(full));
    full.term.grid()[row][Column(0)].c == '─'
}

const PRIVATE: [u16; 18] = [
    1, 3, 6, 7, 9, 12, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1042, 1049, 2004,
];

fn mode_change() -> impl Strategy<Value = Action> {
    prop_oneof![
        2 => Just(Action::TabStopHere),
        2 => (0u8..32).prop_map(Action::TabStopAt),
        1 => Just(Action::TabClearHere),
        1 => (0u8..32).prop_map(Action::TabClearAt),
        1 => Just(Action::TabClearAll),
        1 => Just(Action::ShiftOut),
        1 => Just(Action::ShiftIn),
        2 => (0u8..4, any::<bool>()).prop_map(|(slot, drawing)| Action::Designate(slot, drawing)),
        4 => (prop::sample::select(&PRIVATE[..]), any::<bool>())
            .prop_map(|(mode, on)| Action::Private(mode, on)),
        1 => any::<bool>().prop_map(Action::Keypad),
        1 => (prop::sample::select(&[4u8, 20][..]), any::<bool>())
            .prop_map(|(mode, on)| Action::Ansi(mode, on)),
        1 => (0u8..8).prop_map(Action::CursorStyle),
        1 => (0u8..4).prop_map(Action::CursorShape),
        2 => (0u8..32).prop_map(Action::KittyPush),
        1 => (0u8..4).prop_map(Action::KittyPop),
        1 => (0u8..32, 0u8..5).prop_map(|(flags, how)| Action::KittySet(flags, how)),
        1 => (3u8..6, 0u8..4).prop_map(|(resource, value)| Action::ModifyOtherKeys(resource, value)),
        1 => Just(Action::SoftReset),
        2 => (0u8..16, 0u8..16).prop_map(|(top, bottom)| Action::Region(top, bottom)),
    ]
}

pub(super) fn stream() -> impl Strategy<Value = Action> {
    prop_oneof![
        3 => mode_change(),
        2 => output_and_resizes(),
    ]
}

/// What a case does after a restore: anything whose effect on the modes doesn't hang on where
/// the cursor is, or on the saved cursor, which a restore of the modes alone doesn't bring back.
fn after_a_restore() -> impl Strategy<Value = Action> {
    stream().prop_filter("depends on the cursor", |action| {
        !matches!(
            action,
            Action::RestoreCursor | Action::TabStopHere | Action::TabClearHere
        )
    })
}

fn restore(modes: &Modes) -> String {
    let mut out = String::new();
    modes.write_for_engine(&mut out);
    out
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn the_modes_alacritty_keeps_to_itself_are_tracked_as_it_keeps_them(
        size in size(),
        actions in prop::collection::vec(stream(), 0..80),
        cuts in cuts(),
    ) {
        let mut case = Case::new(size);
        case.play(&actions, &cuts);
        case.assert_mirrored();
    }

    #[test]
    fn a_fresh_engine_given_the_modes_goes_on_as_the_engine_they_came_from(
        size in size(),
        before in prop::collection::vec(stream(), 0..60),
        after in prop::collection::vec(after_a_restore(), 0..30),
        cuts in cuts(),
    ) {
        let mut original = Case::new(size);
        original.play(&before, &cuts);
        let modes = original.engine.modes();
        let mut fresh = Case::new(original.engine.size);
        fresh.play(&[Action::Text(restore(&modes))], &cuts);
        prop_assert_eq!(&fresh.engine.modes(), &modes);
        original.play(&after, &cuts);
        fresh.play(&after, &cuts);
        prop_assert_eq!(fresh.engine.modes(), original.engine.modes());
        fresh.assert_mirrored();
    }

    #[test]
    fn the_kitty_flags_in_force_are_those_alacritty_with_kitty_on_holds(
        size in size(),
        actions in prop::collection::vec(prop_oneof![
            4 => (0u8..32).prop_map(Action::KittyPush),
            2 => (0u8..4).prop_map(Action::KittyPop),
            1 => Just(Action::AltOn),
            1 => Just(Action::AltOff),
            1 => Just(Action::Reset),
            1 => text().prop_map(Action::Text),
        ], 0..60),
    ) {
        // alacritty's set changes the flags in force but not its stack, where kitty changes the
        // stack's top: sets are left to the unit tests.
        let mut engine = Engine::new(size, HistoryRows(100));
        let kitty = Config { kitty_keyboard: true, ..config(100) };
        let mut oracle = Term::new(kitty, &size, Sink::default());
        let mut parser = Processor::<StdSyncHandler>::new();
        for action in &actions {
            let full = engine.modes().keys.kitty_requested.len() >= MOST_KEYBOARD_MODES;
            if full && matches!(action, Action::KittyPush(_)) {
                continue;
            }
            let bytes = action.bytes().unwrap_or_default();
            engine.advance(bytes.as_bytes());
            parser.advance(&mut oracle, bytes.as_bytes());
            let top = engine.modes().keys.kitty_requested.last().map_or(0, |flags| flags.0);
            let ours = TermMode::from(KeyboardModes::from_bits_truncate(top));
            prop_assert_eq!(*oracle.mode() & TermMode::KITTY_KEYBOARD_PROTOCOL, ours);
        }
    }
}
