//! Snapshots against the engines they came from: a fresh engine given one goes on as its source,
//! and taking one changes nothing.

use std::fmt::Write as _;

use alacritty_terminal::grid::Grid;

use super::tracked::stream;
use super::*;
use crate::snapshot::tests::{State, restored, state};

/// What resized while `actions` played.
#[derive(Debug, Clone, Copy, Default)]
struct Resized {
    at_all: bool,
    under_alt: bool,
}

/// Plays `actions` to `engine` in pieces `cuts` long.
fn play(engine: &mut Engine, actions: &[Action], cuts: &[usize]) -> Resized {
    let mut resized = Resized::default();
    for action in actions {
        // After a resize the two engines' cursors may stand apart (see `Engine::resize`), and a
        // tab stop set where each stands with them.
        let here = matches!(action, Action::TabStopHere | Action::TabClearHere);
        if resized.at_all && here {
            continue;
        }
        match (action.bytes(), action) {
            (Some(bytes), _) => {
                let mut rest = bytes.as_bytes();
                for &cut in cuts.iter().cycle() {
                    if rest.is_empty() {
                        break;
                    }
                    let (piece, after) = rest.split_at(cut.min(rest.len()));
                    engine.advance(piece);
                    rest = after;
                }
            }
            (None, &Action::Resize(cols, rows)) => {
                resized.under_alt |= engine.modes().screen.alternate;
                resized.at_all |= Size { cols, rows }.usable() != engine.size;
                engine.resize(Size { cols, rows });
            }
            (None, _) => {}
        }
        assert_whole("engine", &engine.term);
    }
    engine.take_replies();
    resized
}

/// A screen as the cells that draw a char, in order, with their pens but nothing of how they are
/// laid out: the bound the engine keeps through a reflow (see the module above), which can leave a
/// row marked as wrapping inside it, a wide char without its spacer, or a spacer of its own in no
/// colour where printing gives it the pen's.
fn drawn_cells(grid: &Grid<Cell>) -> Vec<(String, bool)> {
    // A wide char with no room for its spacer comes back as a blank (see `Engine::snapshot`).
    let rows: Vec<Cells> = (0..grid.screen_lines())
        .map(|n| {
            let mut row = cells(&grid[scrollback_line(0, n)], grid.columns());
            if let Some(cell) = row.last_mut()
                && cell.flags.contains(Flags::WIDE_CHAR)
            {
                cell.c = ' ';
            }
            row
        })
        .collect();
    let drawn = visible(&rows)
        .into_iter()
        .fold(String::new(), |mut out, cell| {
            let marks: String = cell.zerowidth().unwrap_or_default().iter().collect();
            let flags = cell.flags.difference(Flags::WIDE_CHAR);
            let _ = write!(out, "{}{marks}{:?}{:?}{flags:?}|", cell.c, cell.fg, cell.bg);
            out
        });
    vec![(drawn, false)]
}

/// Every cell of history and the screen that draws something, in order, at the engine's width.
fn drawn_in_order(engine: &Engine) -> Vec<Cell> {
    let mut history = String::new();
    engine.write_history(&mut history);
    let last = engine.term.grid().screen_lines().saturating_sub(1);
    let all = history_and_screen(history, &engine.term, last);
    visible(&drawn(&all, engine.size.cols))
}

/// Whether the cells of history and the screen that draw something are the same in order, one
/// side's starting the other's where a widening may have dropped rows below the cursor.
fn same_drawn_in_order(fresh: &Engine, original: &Engine) -> Result<(), TestCaseError> {
    let (ours, theirs) = (drawn_in_order(fresh), drawn_in_order(original));
    prop_assert!(
        ours.starts_with(&theirs) || theirs.starts_with(&ours),
        "{:?} against {:?}",
        text_of(&ours),
        text_of(&theirs)
    );
    Ok(())
}

/// `engine`'s state, its history as the cells it draws at the engine's width: history kept from
/// before a resize is in rows of the old width, which a fresh engine holds at the new one. After
/// a reflow, its screens too are the cells they draw.
fn compared(engine: &mut Engine, history: bool, reflowed: bool) -> State {
    let mut state = state(engine);
    let cols = engine.size.cols;
    state.history = if history {
        text_of(&visible(&drawn(&state.history, cols)))
    } else {
        String::new()
    };
    if reflowed {
        state.shown.0 = drawn_cells(engine.term.grid());
        if let Some(primary) = &mut state.primary
            && let Some(shown) = PrimaryShown::new(&mut engine.term)
        {
            primary.0 = drawn_cells(shown.grid());
        }
    }
    state
}

/// Whether a reflow left a cursor of either screen waiting to wrap off the last column, which
/// printing can't make again: alacritty only waits there after printing in it.
fn waits_off_the_last_column(engine: &mut Engine) -> bool {
    let off = |grid: &Grid<Cell>| {
        [&grid.cursor, &grid.saved_cursor]
            .iter()
            .any(|cursor| cursor.input_needs_wrap && cursor.point.column.0 + 1 != grid.columns())
    };
    let primary = PrimaryShown::new(&mut engine.term).is_some_and(|shown| off(shown.grid()));
    primary || off(engine.term.grid())
}

/// Whether DECRC left the cursor outside the region under DECOM, which no move but DECRC reaches:
/// the snapshot brings it back clamped into the region, a named divergence.
fn outside_its_origin(engine: &Engine) -> bool {
    let modes = engine.modes();
    let line = engine.term.grid().cursor.point.line.0;
    modes.screen.origin == Origin::Region
        && !(i32::from(modes.screen.region.start)..i32::from(modes.screen.region.end))
            .contains(&line)
}

/// Whether either screen's last row is marked as wrapping, which only a region past the bottom
/// or a scroll down leaves: nothing follows it for the snapshot to wrap into, so the mark can't
/// come back, a named divergence that a later scroll carries up the screen.
fn last_row_wraps(engine: &mut Engine) -> bool {
    let wraps = |grid: &Grid<Cell>| {
        let last = scrollback_line(0, grid.screen_lines().saturating_sub(1));
        grid[last]
            .into_iter()
            .last()
            .is_some_and(|cell| cell.flags.contains(Flags::WRAPLINE))
    };
    let primary = PrimaryShown::new(&mut engine.term).is_some_and(|shown| wraps(shown.grid()));
    primary || wraps(engine.term.grid())
}

/// `actions` without the REPs that come before anything is printed: one repeats the last char vte
/// printed, which for the fresh engine is the snapshot's, not the program's, a named divergence.
/// terminfo's `rep` prints the char first.
fn without_a_repeat_before_printing(actions: &[Action]) -> Vec<Action> {
    let mut printed = false;
    actions
        .iter()
        .filter(|action| {
            match action {
                // A tab moves the cursor but prints nothing REP repeats.
                Action::Text(text) if text.chars().any(|c| !c.is_control()) => printed = true,
                Action::Lines(n) if *n > 0 => printed = true,
                _ => {}
            }
            printed || !matches!(action, Action::Repeat(_))
        })
        .cloned()
        .collect()
}

/// Plays `before` to an engine, gives a fresh one its snapshot, plays `after` to both, and holds
/// the fresh one to what the source holds, up to the named divergences.
fn goes_on_as_its_source(
    size: Size,
    before: &[Action],
    after: &[Action],
    cuts: &[usize],
) -> Result<(), TestCaseError> {
    // Room for all of a case's history: history is counted in rows, and rows kept from before
    // a resize are at the old width, so the two would drop different rows at a limit.
    let mut original = Engine::new(size, HistoryRows(ENGINE_ROWS));
    let before_resized = play(&mut original, before, cuts);
    let resized_under_alt = before_resized.under_alt;
    let reflowed = before_resized.at_all;
    prop_assume!(!waits_off_the_last_column(&mut original));
    prop_assume!(!outside_its_origin(&original));
    prop_assume!(!last_row_wraps(&mut original));
    let after = without_a_repeat_before_printing(after);
    let mut fresh = restored(&mut original);
    // A resize under the alternate screen reflows the primary with the one row of history
    // alacritty holds (see `Engine::resize`), where the snapshot gives the fresh engine all of
    // it: the primary, and the history it joins when the screen ends, may part from there.
    // The shown screen and the modes may not.
    let parted = |state: State| State {
        history: String::new(),
        primary: None,
        ..state
    };
    let (ours, theirs) = (
        compared(&mut fresh, !resized_under_alt, reflowed),
        compared(&mut original, !resized_under_alt, reflowed),
    );
    if resized_under_alt && original.modes().screen.alternate {
        prop_assert_eq!(parted(ours), parted(theirs));
    } else if resized_under_alt {
        // The primary is shown again, as each resize left it: its cells stay in order.
        prop_assert_eq!(
            (&ours.modes, &ours.title, &ours.colours),
            (&theirs.modes, &theirs.title, &theirs.colours)
        );
        same_drawn_in_order(&fresh, &original)?;
        return Ok(());
    } else {
        prop_assert_eq!(ours, theirs);
    }
    // After a resize the cursors may stand apart, and so would whatever is printed next: the
    // case ends there.
    let until = after
        .iter()
        .position(|action| matches!(action, Action::Resize(..)))
        .map_or(after.len(), |at| at + 1);
    let after = &after[..until];
    let resized_after = play(&mut original, after, cuts);
    play(&mut fresh, after, cuts);
    let reflowed = reflowed || resized_after.at_all;
    let (ours, theirs) = (
        compared(&mut fresh, true, reflowed),
        compared(&mut original, true, reflowed),
    );
    let resized = resized_under_alt || resized_after.under_alt;
    if resized && original.modes().screen.alternate {
        // As vim stands after a resize: the alternate screen, its cursor and the modes.
        prop_assert_eq!(parted(ours), parted(theirs));
    } else if resized || resized_after.at_all {
        // The two reflow history held differently, the source's rows as they were and the
        // fresh engine's rewrapped from text (see `Engine::resize`), and under the alternate
        // screen the primary with what each holds of it: their line breaks and blanks may
        // part, and either may drop rows below the cursor in a widening. The cells that draw
        // something stay in order, as after vim's `:q`.
        prop_assert_eq!(
            (&ours.modes, &ours.title, &ours.colours),
            (&theirs.modes, &theirs.title, &theirs.colours)
        );
        same_drawn_in_order(&fresh, &original)?;
    } else {
        prop_assert_eq!(ours, theirs);
    }
    Ok(())
}

#[test]
fn a_wide_line_through_resizes_under_vim_comes_back_with_no_cell_twice() {
    // The shrunk case CI found: wide chars at 2 columns, then a resize, the alternate screen
    // resized under, and a new line after it ends.
    let text = |text: &str| Action::Text(text.to_owned());
    let before = [
        text("axyzzyxyzzy中bca文字abc中bc  bc文字xyzzy  文字def   中bcbc  文字"),
        Action::TabStopAt(0),
        text("def 文字def abc😀文字def e\u{301}文字中文字  bcbcxyzzybc  "),
        text("  aa\t a文字def def  文字  e\u{301}中"),
        Action::TabClearAll,
        Action::Resize(14, 1),
        text("中def \t"),
        text("中\t  def  中中"),
        text(
            "def def def 文字  adef a中def def def 中中def abcbcadef 文字中  def def xyzzybcadef a  aa\t  xyzzy",
        ),
        Action::Resize(3, 8),
        Action::AltOn,
        Action::TabStopHere,
        Action::Resize(9, 5),
        Action::AltOff,
        Action::CrLf,
        Action::Lines(1),
    ];
    goes_on_as_its_source(Size { cols: 2, rows: 1 }, &before, &[], &[1]).unwrap();
}

#[test]
fn a_cursor_saved_waiting_on_a_row_that_then_wraps_comes_back_with_the_row_wrapping() {
    // A case the property rarely reaches: the snapshot prints the saved cursor's cell again to
    // make it wait, which must leave the row wrapping.
    let before = [
        Action::Text("a  中  ".into()),
        Action::SaveCursor,
        Action::Text("a".into()),
    ];
    goes_on_as_its_source(Size { cols: 4, rows: 4 }, &before, &[], &[1]).unwrap();
}

proptest! {
    // The named divergences leave out about 4% of cases (30 in 829 over six runs at a limit of
    // 5), well inside the default limit of 1,024 rejects at 512 cases.
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn a_fresh_engine_given_a_snapshot_goes_on_as_the_engine_it_came_from(
        size in size(),
        before in prop::collection::vec(stream(), 0..60),
        after in prop::collection::vec(stream(), 0..30),
        cuts in cuts(),
    ) {
        goes_on_as_its_source(size, &before, &after, &cuts)?;
    }

    #[test]
    fn taking_a_snapshot_changes_nothing_the_engine_holds(
        size in size(),
        pieces in prop::collection::vec(prop::collection::vec(stream(), 0..20), 1..5),
        cuts in cuts(),
    ) {
        let mut snapshotted = Engine::new(size, HistoryRows(100));
        let mut untouched = Engine::new(size, HistoryRows(100));
        for actions in &pieces {
            play(&mut snapshotted, actions, &cuts);
            play(&mut untouched, actions, &cuts);
            snapshotted.snapshot(usize::MAX, &mut String::new()).unwrap();
            prop_assert_eq!(state(&mut snapshotted), state(&mut untouched));
        }
    }
}
