//! Reads the stream ahead of alacritty and says where to stop, so the rows one stretch of it can
//! push into alacritty's scrollback stay within what the engine left free.
//!
//! It counts, for each action, the most rows it could scroll into history: an over-estimate is
//! only a shorter stretch, but an under-estimate loses rows. Its matching follows vte's own
//! dispatch in `vte::ansi` (`csi_dispatch`, `esc_dispatch`, `execute`), which alacritty runs on
//! the same bytes.

use alacritty_terminal::vte::{Params, Perform};

/// The fewest rows a stretch may scroll before it stops.
const MIN_STRETCH: usize = 128;

/// The most bytes a read may go past `room` to finish a char.
pub(crate) const MOST_CONTINUATIONS: usize = 3;

/// An action after which the engine acts before reading on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stop {
    /// RIS: alacritty clears both grids' scrollback.
    Reset,
    /// ED 3: alacritty clears the active grid's scrollback.
    ClearHistory,
    /// A switch to or from the alternate screen: alacritty keeps the primary grid private while
    /// the alternate screen is up.
    AltScreen,
}

#[derive(Debug)]
pub(crate) struct Budget {
    rows: usize,
    /// The count at which a stretch stops.
    stretch: usize,
    chars_per_row: usize,
    /// The worst-case rows scrolled since the last [`Budget::start`].
    scrolled: usize,
    stop: Option<Stop>,
    /// The cursor may be anywhere, waiting to wrap included, so the next printed char may wrap.
    unknown_column: bool,
    /// Chars printed since the column was last known, less those already counted as a row.
    printed: usize,
}

impl Budget {
    pub(crate) fn new(cols: usize, rows: usize) -> Self {
        let mut budget = Self {
            rows: 1,
            stretch: 1,
            chars_per_row: 1,
            scrolled: 0,
            stop: None,
            unknown_column: true,
            printed: 0,
        };
        budget.resize(cols, rows);
        budget
    }

    pub(crate) fn resize(&mut self, cols: usize, rows: usize) {
        self.rows = rows.max(1);
        // Each stretch costs a call into alacritty and a drain, so a flood of short lines runs
        // faster in longer ones; each row of stretch costs a row of alacritty's scrollback.
        self.stretch = (2 * self.rows).max(MIN_STRETCH);
        // A row holds at least this many chars before the next wraps: each takes at most two
        // cells, and a wide char that doesn't fit in the last cell wraps.
        self.chars_per_row = (cols / 2).max(1);
        self.unknown_column = true;
    }

    /// The most bytes to read before asking again. vte dispatches everything up to the next
    /// ESC in one go, control bytes included, without asking whether to stop; in that stretch a
    /// byte scrolls at most one row, so reading no more than the rows left keeps within them.
    pub(crate) fn room(&self) -> usize {
        self.stretch.saturating_sub(self.scrolled).max(1)
    }

    /// The most rows a stretch can scroll: it stops once the count reaches `stretch`, and the
    /// action that reaches it adds at most a screen, or `room` and the bytes that end a char;
    /// all but REP, whose count [`Budget::scrolled`] gives.
    pub(crate) fn most_rows_per_stretch(&self) -> usize {
        self.stretch + self.rows + MOST_CONTINUATIONS
    }

    /// The most rows the stretch so far could scroll.
    pub(crate) fn scrolled(&self) -> usize {
        self.scrolled
    }

    /// Starts a stretch. Its count must cover every row scrolled within it, so it can't lean
    /// on what the last stretch counted: a wrap counted early there may happen here.
    pub(crate) fn start(&mut self) {
        self.scrolled = 0;
        self.stop = None;
        self.unknown_column = true;
    }

    pub(crate) fn stop(&self) -> Option<Stop> {
        self.stop
    }

    fn scroll(&mut self, rows: usize) {
        self.scrolled += rows.min(self.rows);
    }

    /// A char wraps when the cursor is waiting to wrap, which an unknown column may be, or once
    /// the row is full: at least `chars_per_row` chars since column zero. A tab wraps in the first
    /// case too.
    fn may_wrap(&mut self) {
        if self.unknown_column || self.printed >= self.chars_per_row {
            self.scroll(1);
            self.unknown_column = false;
            self.printed = 0;
        }
    }

    fn column_lost(&mut self) {
        self.unknown_column = true;
    }

    fn column_zero(&mut self) {
        self.unknown_column = false;
        self.printed = 0;
    }
}

/// Whether a private mode set or reset names one of the alternate screen's modes.
fn switches_screen(params: &Params) -> bool {
    params
        .iter()
        .any(|param| matches!(param.first(), Some(47 | 1047 | 1049)))
}

fn first_param(params: &Params) -> usize {
    match params.iter().next() {
        Some(&[param, ..]) => usize::from(param),
        _ => 0,
    }
}

impl Perform for Budget {
    fn print(&mut self, _c: char) {
        self.may_wrap();
        self.printed += 1;
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            // LF, VT, FF: a line feed, which keeps the column.
            0x0a..=0x0c => self.scroll(1),
            // CR
            0x0d => self.column_zero(),
            // HT
            0x09 => {
                self.may_wrap();
                self.column_lost();
            }
            // SUB prints a replacement char.
            0x1a => self.print('?'),
            _ => self.column_lost(),
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        // vte ignores these, and only these, among the ones below.
        let handled = !ignore && intermediates.is_empty();
        let first = first_param(params);
        match action {
            // SGR moves nothing.
            'm' => return,
            'S' | 'M' if handled => self.scroll(first.max(1)),
            'J' if handled && first == 2 => self.scroll(self.rows),
            'J' if handled && first == 3 => self.stop = Some(Stop::ClearHistory),
            // CHT: tabs forward, which wraps as HT does.
            'I' if handled => self.may_wrap(),
            // REP prints the char before it again, up to 65,535 times, in one action: as many
            // rows as printing them would wrap, not bounded by the screen.
            'b' if handled => {
                let repeats = first.max(1);
                self.may_wrap();
                self.scrolled += repeats / self.chars_per_row + 1;
            }
            'h' | 'l' if intermediates == b"?" && switches_screen(params) => {
                self.stop = Some(Stop::AltScreen);
            }
            _ => {}
        }
        self.column_lost();
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        match (byte, intermediates) {
            // IND: a line feed.
            (b'D', []) => self.scroll(1),
            // NEL: a line feed and a carriage return.
            (b'E', []) => {
                self.scroll(1);
                self.column_zero();
            }
            (b'c', []) => {
                self.stop = Some(Stop::Reset);
                self.column_lost();
            }
            _ => self.column_lost(),
        }
    }

    fn terminated(&self) -> bool {
        self.scrolled >= self.stretch || self.stop.is_some()
    }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::vte::Parser;

    use super::*;

    /// A 10-column, 4-row budget whose stretches stop at a screen.
    fn small() -> Budget {
        let mut budget = Budget::new(10, 4);
        budget.stretch = 4;
        budget
    }

    /// How far a 10-column, 4-row budget reads into `bytes` before it stops, the rows it
    /// counted, and why it stopped.
    fn stretch(bytes: &[u8]) -> (usize, usize, Option<Stop>) {
        let mut budget = small();
        budget.start();
        let read = Parser::new().advance_until_terminated(&mut budget, bytes);
        (read, budget.scrolled, budget.stop())
    }

    #[test]
    fn a_line_feed_counts_one_row() {
        assert_eq!(stretch(b"\n\n\n\nmore"), (8, 5, None));
        assert_eq!(stretch(b"\x1bD\x1bE\x0b\x1bDmore").0, 7);
    }

    #[test]
    fn a_scroll_up_counts_its_rows_up_to_the_screen() {
        assert_eq!(stretch(b"\x1b[2S\x1b[2Smore").0, 8);
        assert_eq!(stretch(b"\x1b[99Smore").0, 5);
        assert_eq!(stretch(b"\x1b[0M\x1b[M\x1b[M\x1b[Mmore").0, 13);
    }

    #[test]
    fn a_clear_screen_counts_the_whole_screen_and_a_partial_clear_nothing() {
        assert_eq!(stretch(b"\x1b[2Jmore").0, 4);
        assert_eq!(stretch(b"\x1b[J\x1b[1J\x1b[K"), (10, 0, None));
    }

    #[test]
    fn sequences_vte_ignores_count_nothing() {
        assert_eq!(stretch(b"\x1b[?5S\x1b[?2J\x1b[?3J"), (15, 0, None));
    }

    #[test]
    fn printed_text_counts_a_row_per_half_screen_width_and_one_for_a_pending_wrap() {
        // After a cursor move the first char may wrap; then every fifth char may.
        assert_eq!(stretch(b"\x1b[Habcdefghijklmnop").1, 1 + 3);
        // A carriage return puts the column at zero, and SGR leaves it there.
        assert_eq!(stretch(b"\rab\x1b[1mcde\x1b[0mfghijklmnop").1, 3);
    }

    #[test]
    fn a_run_up_to_the_next_escape_is_read_whole_and_counts_at_most_a_row_a_byte() {
        // vte doesn't stop inside the run, so the engine reads no more than `room` at a time.
        let run = b"\n\n\n\n\n\n\t\tx\x08\x08yz";
        let (read, scrolled, _) = stretch(run);
        assert_eq!(read, run.len());
        assert!(scrolled <= run.len());
        let mut budget = small();
        budget.start();
        let read = Parser::new().advance_until_terminated(&mut budget, b"\n\n\x1b[");
        assert_eq!((read, budget.room()), (4, 2));
    }

    #[test]
    fn it_stops_right_after_a_reset_or_a_history_clear() {
        assert_eq!(stretch(b"ab\x1bcmore"), (4, 1, Some(Stop::Reset)));
        assert_eq!(stretch(b"\x1b[3Jmore"), (4, 0, Some(Stop::ClearHistory)));
        assert_eq!(stretch(b"\x1b[3;1Jmore"), (6, 0, Some(Stop::ClearHistory)));
    }

    #[test]
    fn a_repeat_counts_the_rows_its_chars_could_wrap_however_many() {
        // One for the "x", which may wrap, then one per five chars and one more.
        assert_eq!(stretch(b"x\x1b[999b"), (7, 1 + 999 / 5 + 1, None));
        assert_eq!(stretch(b"x\x1b[?999b").1, 1);
    }

    #[test]
    fn a_tab_forward_or_a_substitute_char_may_wrap_a_waiting_row() {
        // After a cursor move each may wrap: one row each.
        assert_eq!(stretch(b"\x1b[H\x1b[I").1, 1);
        assert_eq!(stretch(b"\x1b[H\x1a").1, 1);
        // With the column known at zero, neither can.
        assert_eq!(stretch(b"\r\x1b[I").1, 0);
        assert_eq!(stretch(b"\r\x1a").1, 0);
    }

    #[test]
    fn it_stops_right_after_a_switch_to_or_from_the_alternate_screen() {
        for switch in ["\x1b[?1049h", "\x1b[?47l", "\x1b[?25;1047h"] {
            let stream = format!("{switch}more");
            assert_eq!(
                stretch(stream.as_bytes()).2,
                Some(Stop::AltScreen),
                "{switch:?}"
            );
            assert_eq!(stretch(stream.as_bytes()).0, switch.len(), "{switch:?}");
        }
        assert_eq!(stretch(b"\x1b[?25h\x1b[1049h").2, None);
    }
}
