//! The handler the engine parses into: alacritty's terminal, but with a limit on the
//! zero-width chars (combining marks, variation selectors) one cell holds.
//!
//! alacritty pushes every zero-width char onto the cell before the cursor, with no limit, and
//! REP repeats one 65,535 times for eight bytes of input: a program could grow one cell, and the
//! row it moves into history, without bound. Like tmux, which keeps 21 bytes a cell
//! (`UTF8_SIZE`), the engine drops a zero-width char that would take a cell past 21 bytes.
//!
//! It tells [`Tracker`] of the calls that change a mode alacritty keeps to itself or ignores,
//! before passing them on, so the tracker sees them with alacritty's cursor as it was.
//!
//! It keeps a wide char whole or gone, as xterm, VTE and xterm.js do. alacritty's erases, inserts
//! and deletes change only the cells in their range, so one that takes in half a wide char leaves
//! the other half: a char with no spacer, or a spacer with no char. After each of them the cursor's
//! row is mended, the half left over blanked in the cursor's background as the erase's own cells
//! are. Insert mode needs a step before as well: alacritty's shift brings the cells it pushes off
//! the row round to the cursor's cell, and writing over a spacer there clears the char before the
//! cursor, so those cells are blanked first.
//!
//! It keeps a row's line ending, whether it wraps into the next, as xterm, VTE and xterm.js keep
//! it: with the row, not with a cell. alacritty marks it on the row's last cell, so an insert or
//! delete that shifts that cell carries the mark along the row, and text written into it drops
//! the mark. Around each, the mark is taken off the cursor's row and put back on its last cell.
//! An insert in insert mode with a wrap pending wraps first, as alacritty would, so that the row
//! it shifts is the cursor's.
//!
//! It answers colour queries itself, as alacritty leaves them to a window that knows its colours:
//! the program's own colour, if it set one, else what the engine was given.
//!
//! It drops OSC 8 hyperlinks too: alacritty keeps a link on every cell drawn while it is set, up
//! to an OSC string's 1 KiB each, so a link per cell would cost a GiB at the largest size, and the
//! engine serves none (only the pen is encoded). Every other call goes to alacritty as it is, but
//! OSC 22's mouse pointer shape, which a terminal with no window has no use for, and whose type
//! vte doesn't export.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::Term;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color;
use alacritty_terminal::vte::ansi::{
    Attr, CharsetIndex, ClearMode, CursorShape, CursorStyle, Handler, Hyperlink, KeyboardModes,
    KeyboardModesApplyBehavior, LineClearMode, Mode, ModifyOtherKeys, NamedPrivateMode,
    PrivateMode, Rgb, ScpCharPath, ScpUpdateMode, StandardCharset, TabulationClearMode,
};
use unicode_width::UnicodeWidthChar as _;

use crate::modes::Tracker;
use crate::replies::Sink;

/// The most bytes of UTF-8 one cell holds, its char and the zero-width chars on it, as tmux's
/// `UTF8_SIZE`.
pub(crate) const MOST_CELL_BYTES: usize = 21;

/// Whether row `line` wraps into the next, held while a call changes its last cell.
#[derive(Clone, Copy)]
struct LineEnding {
    line: Line,
    wraps: bool,
}

pub(crate) struct Capped<'a>(
    pub(crate) &'a mut Term<Sink>,
    pub(crate) &'a mut Tracker,
    pub(crate) &'a Sink,
);

impl std::fmt::Debug for Capped<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Capped").finish_non_exhaustive()
    }
}

impl Capped<'_> {
    /// Whether the cell alacritty would put zero-width `mark` on is too full for it: the one
    /// before the cursor, or the cursor's own when it waits to wrap, or the wide char a spacer
    /// belongs to.
    fn marks_full(&self, mark: char) -> bool {
        let grid = self.0.grid();
        let cursor = &grid.cursor;
        let mut column = cursor.point.column;
        if !cursor.input_needs_wrap {
            column.0 = column.saturating_sub(1);
        }
        let line = cursor.point.line;
        if line.0 < 0 || line.0 >= i32::try_from(grid.screen_lines()).unwrap_or(i32::MAX) {
            return false;
        }
        let row = &grid[line];
        if column.0 >= row.len() {
            return false;
        }
        if row[column].flags.contains(Flags::WIDE_CHAR_SPACER) {
            column.0 = column.saturating_sub(1);
        }
        let cell = &row[Column(column.0)];
        let marks: usize = cell
            .zerowidth()
            .unwrap_or_default()
            .iter()
            .map(|c| c.len_utf8())
            .sum();
        cell.c.len_utf8() + marks + mark.len_utf8() > MOST_CELL_BYTES
    }

    /// Blanks each half of a wide char on the cursor's row whose other half is gone, keeping the
    /// row's wrap.
    fn mend_wide_chars(&mut self) {
        let grid = self.0.grid_mut();
        let bg = grid.cursor.template.bg;
        let line = grid.cursor.point.line;
        let row = &mut grid[line];
        let columns = row.len();
        for column in 0..columns {
            let flags = row[Column(column)].flags;
            let whole = if flags.contains(Flags::WIDE_CHAR) {
                column + 1 < columns
                    && row[Column(column + 1)]
                        .flags
                        .contains(Flags::WIDE_CHAR_SPACER)
            } else if flags.contains(Flags::WIDE_CHAR_SPACER) {
                column > 0 && row[Column(column - 1)].flags.contains(Flags::WIDE_CHAR)
            } else {
                true
            };
            if !whole {
                let cell = &mut row[Column(column)];
                *cell = bg.into();
                cell.flags.insert(flags & Flags::WRAPLINE);
            }
        }
    }

    /// Blanks the cells at the end of the cursor's row that inserting a char `width` wide pushes
    /// off it, when alacritty will shift the row, and says whether it will: it brings them round
    /// to the cursor's cell, and writing over a spacer there would clear the char before the
    /// cursor.
    fn blank_what_an_insert_pushes_off(&mut self, width: usize) -> bool {
        let grid = self.0.grid_mut();
        let columns = grid.columns();
        let cursor = &grid.cursor;
        if cursor.input_needs_wrap || cursor.point.column.0 + width >= columns {
            return false;
        }
        let bg = cursor.template.bg;
        let line = cursor.point.line;
        for cell in &mut grid[line][Column(columns - width)..] {
            *cell = bg.into();
        }
        true
    }

    /// Takes the mark that the cursor's row wraps off its last cell, where a shift would move it
    /// and a write would drop it.
    fn take_line_ending(&mut self) -> LineEnding {
        let grid = self.0.grid_mut();
        let line = grid.cursor.point.line;
        let wraps = grid[line][..].last_mut().is_some_and(|cell| {
            let wraps = cell.flags.contains(Flags::WRAPLINE);
            cell.flags.remove(Flags::WRAPLINE);
            wraps
        });
        LineEnding { line, wraps }
    }

    /// Puts `ending` back on its row's last cell. Only a shift leaves it exactly as it was: text
    /// that doesn't fit wraps the row itself, and that stands.
    fn keep_line_ending(&mut self, ending: LineEnding, exactly: bool) {
        if let Some(cell) = self.0.grid_mut()[ending.line][..].last_mut() {
            if exactly {
                cell.flags.set(Flags::WRAPLINE, ending.wraps);
            } else if ending.wraps {
                cell.flags.insert(Flags::WRAPLINE);
            }
        }
    }

    /// Wraps a waiting cursor, as alacritty's `wrapline` does before it prints: marks the
    /// row as wrapping, feeds a line and returns to the first column.
    fn wrap(&mut self) {
        let grid = self.0.grid_mut();
        let point = grid.cursor.point;
        grid[point.line][point.column].flags.insert(Flags::WRAPLINE);
        <Term<Sink> as Handler>::linefeed(self.0);
        <Term<Sink> as Handler>::carriage_return(self.0);
    }

    fn alternate(&self) -> bool {
        self.0.mode().contains(TermMode::ALT_SCREEN)
    }

    /// What a private mode set or reset changes that alacritty keeps to itself.
    fn track_private_mode(&mut self, mode: PrivateMode, set: bool) {
        let PrivateMode::Named(mode) = mode else {
            return;
        };
        match mode {
            // DECCOLM sets the region to the whole screen as DECSTBM would: a 1-row screen keeps it.
            NamedPrivateMode::ColumnMode => self.1.set_region(1, None, self.0.screen_lines()),
            NamedPrivateMode::BlinkingCursor => self.1.set_cursor_blinking(set),
            NamedPrivateMode::SwapScreenAndSetRestoreCursor if set && !self.alternate() => {
                self.1.alternate_on(&self.0.grid().cursor);
            }
            NamedPrivateMode::SwapScreenAndSetRestoreCursor if !set && self.alternate() => {
                self.1.alternate_off(&self.0.grid().saved_cursor);
            }
            _ => {}
        }
    }
}

impl Handler for Capped<'_> {
    fn set_title(&mut self, a: Option<String>) {
        self.1.set_title(a.clone());
        <Term<Sink> as Handler>::set_title(self.0, a);
    }

    fn set_cursor_style(&mut self, a: Option<CursorStyle>) {
        self.1.set_cursor_style(a);
        <Term<Sink> as Handler>::set_cursor_style(self.0, a);
    }

    fn set_cursor_shape(&mut self, a: CursorShape) {
        self.1.set_cursor_shape(a);
        <Term<Sink> as Handler>::set_cursor_shape(self.0, a);
    }

    fn input(&mut self, a: char) {
        let width = a.width();
        if width == Some(0) && self.marks_full(a) {
            return;
        }
        let Some(width) = width.filter(|&width| width > 0) else {
            <Term<Sink> as Handler>::input(self.0, a);
            return;
        };
        let mode = *self.0.mode();
        let (insert, wraps) = (
            mode.contains(TermMode::INSERT),
            mode.contains(TermMode::LINE_WRAP),
        );
        let columns = self.0.columns();
        if self.0.grid().cursor.input_needs_wrap && wraps && (insert || width >= columns) {
            self.wrap();
        }
        let cursor = &self.0.grid().cursor;
        let reaches_the_last_cell = if cursor.input_needs_wrap {
            !wraps
        } else {
            insert || cursor.point.column.0 + width >= columns
        };
        if !reaches_the_last_cell {
            <Term<Sink> as Handler>::input(self.0, a);
            return;
        }
        let ending = self.take_line_ending();
        let shifts = insert && self.blank_what_an_insert_pushes_off(width);
        <Term<Sink> as Handler>::input(self.0, a);
        if insert {
            self.mend_wide_chars();
        }
        self.keep_line_ending(ending, shifts);
    }

    fn goto(&mut self, a0: i32, a1: usize) {
        <Term<Sink> as Handler>::goto(self.0, a0, a1);
    }

    fn goto_line(&mut self, a: i32) {
        <Term<Sink> as Handler>::goto_line(self.0, a);
    }

    fn goto_col(&mut self, a: usize) {
        <Term<Sink> as Handler>::goto_col(self.0, a);
    }

    fn insert_blank(&mut self, a: usize) {
        let ending = self.take_line_ending();
        <Term<Sink> as Handler>::insert_blank(self.0, a);
        self.mend_wide_chars();
        self.keep_line_ending(ending, true);
    }

    fn move_up(&mut self, a: usize) {
        <Term<Sink> as Handler>::move_up(self.0, a);
    }

    fn move_down(&mut self, a: usize) {
        <Term<Sink> as Handler>::move_down(self.0, a);
    }

    fn identify_terminal(&mut self, a: Option<char>) {
        <Term<Sink> as Handler>::identify_terminal(self.0, a);
    }

    fn device_status(&mut self, a: usize) {
        <Term<Sink> as Handler>::device_status(self.0, a);
    }

    fn move_forward(&mut self, a: usize) {
        <Term<Sink> as Handler>::move_forward(self.0, a);
    }

    fn move_backward(&mut self, a: usize) {
        <Term<Sink> as Handler>::move_backward(self.0, a);
    }

    fn move_down_and_cr(&mut self, a: usize) {
        <Term<Sink> as Handler>::move_down_and_cr(self.0, a);
    }

    fn move_up_and_cr(&mut self, a: usize) {
        <Term<Sink> as Handler>::move_up_and_cr(self.0, a);
    }

    fn put_tab(&mut self, a: u16) {
        <Term<Sink> as Handler>::put_tab(self.0, a);
    }

    fn backspace(&mut self) {
        <Term<Sink> as Handler>::backspace(self.0);
    }

    fn carriage_return(&mut self) {
        <Term<Sink> as Handler>::carriage_return(self.0);
    }

    fn linefeed(&mut self) {
        <Term<Sink> as Handler>::linefeed(self.0);
    }

    fn bell(&mut self) {
        <Term<Sink> as Handler>::bell(self.0);
    }

    fn substitute(&mut self) {
        <Term<Sink> as Handler>::substitute(self.0);
    }

    fn newline(&mut self) {
        <Term<Sink> as Handler>::newline(self.0);
    }

    fn set_horizontal_tabstop(&mut self) {
        self.1.set_tab(self.0.grid().cursor.point.column);
        <Term<Sink> as Handler>::set_horizontal_tabstop(self.0);
    }

    fn scroll_up(&mut self, a: usize) {
        <Term<Sink> as Handler>::scroll_up(self.0, a);
    }

    fn scroll_down(&mut self, a: usize) {
        <Term<Sink> as Handler>::scroll_down(self.0, a);
    }

    fn insert_blank_lines(&mut self, a: usize) {
        <Term<Sink> as Handler>::insert_blank_lines(self.0, a);
    }

    fn delete_lines(&mut self, a: usize) {
        <Term<Sink> as Handler>::delete_lines(self.0, a);
    }

    fn erase_chars(&mut self, a: usize) {
        <Term<Sink> as Handler>::erase_chars(self.0, a);
        self.mend_wide_chars();
    }

    /// The row keeps its line ending, as in xterm.js, the web client's renderer, so that what the
    /// engine restores is what the browser showed. xterm and VTE end the row at a delete instead.
    fn delete_chars(&mut self, a: usize) {
        let ending = self.take_line_ending();
        <Term<Sink> as Handler>::delete_chars(self.0, a);
        self.mend_wide_chars();
        self.keep_line_ending(ending, true);
    }

    fn move_backward_tabs(&mut self, a: u16) {
        <Term<Sink> as Handler>::move_backward_tabs(self.0, a);
    }

    fn move_forward_tabs(&mut self, a: u16) {
        <Term<Sink> as Handler>::move_forward_tabs(self.0, a);
    }

    fn save_cursor_position(&mut self) {
        <Term<Sink> as Handler>::save_cursor_position(self.0);
    }

    fn restore_cursor_position(&mut self) {
        <Term<Sink> as Handler>::restore_cursor_position(self.0);
    }

    fn clear_line(&mut self, a: LineClearMode) {
        <Term<Sink> as Handler>::clear_line(self.0, a);
        self.mend_wide_chars();
    }

    fn clear_screen(&mut self, a: ClearMode) {
        <Term<Sink> as Handler>::clear_screen(self.0, a);
        self.mend_wide_chars();
    }

    fn clear_tabs(&mut self, a: TabulationClearMode) {
        self.1.clear_tabs(&a, self.0.grid().cursor.point.column);
        <Term<Sink> as Handler>::clear_tabs(self.0, a);
    }

    fn set_tabs(&mut self, a: u16) {
        <Term<Sink> as Handler>::set_tabs(self.0, a);
    }

    fn reset_state(&mut self) {
        *self.1 = Tracker::new(self.0.columns(), self.0.screen_lines());
        <Term<Sink> as Handler>::reset_state(self.0);
    }

    fn reverse_index(&mut self) {
        <Term<Sink> as Handler>::reverse_index(self.0);
    }

    fn terminal_attribute(&mut self, a: Attr) {
        <Term<Sink> as Handler>::terminal_attribute(self.0, a);
    }

    fn set_mode(&mut self, a: Mode) {
        <Term<Sink> as Handler>::set_mode(self.0, a);
    }

    fn unset_mode(&mut self, a: Mode) {
        <Term<Sink> as Handler>::unset_mode(self.0, a);
    }

    fn report_mode(&mut self, a: Mode) {
        <Term<Sink> as Handler>::report_mode(self.0, a);
    }

    fn set_private_mode(&mut self, a: PrivateMode) {
        self.track_private_mode(a, true);
        <Term<Sink> as Handler>::set_private_mode(self.0, a);
    }

    fn unset_private_mode(&mut self, a: PrivateMode) {
        self.track_private_mode(a, false);
        <Term<Sink> as Handler>::unset_private_mode(self.0, a);
    }

    fn report_private_mode(&mut self, a: PrivateMode) {
        <Term<Sink> as Handler>::report_private_mode(self.0, a);
    }

    fn set_scrolling_region(&mut self, a0: usize, a1: Option<usize>) {
        self.1.set_region(a0, a1, self.0.screen_lines());
        <Term<Sink> as Handler>::set_scrolling_region(self.0, a0, a1);
    }

    fn set_keypad_application_mode(&mut self) {
        <Term<Sink> as Handler>::set_keypad_application_mode(self.0);
    }

    fn unset_keypad_application_mode(&mut self) {
        <Term<Sink> as Handler>::unset_keypad_application_mode(self.0);
    }

    fn set_active_charset(&mut self, a: CharsetIndex) {
        self.1.set_active_charset(a);
        <Term<Sink> as Handler>::set_active_charset(self.0, a);
    }

    fn configure_charset(&mut self, a0: CharsetIndex, a1: StandardCharset) {
        <Term<Sink> as Handler>::configure_charset(self.0, a0, a1);
    }

    fn set_color(&mut self, a0: usize, a1: Rgb) {
        <Term<Sink> as Handler>::set_color(self.0, a0, a1);
    }

    fn dynamic_color_sequence(&mut self, a0: String, a1: usize, a2: &str) {
        // vte asks for no colour past the cursor's, but a table index is checked all the same.
        let set = (a1 < color::COUNT).then(|| self.0.colors()[a1]).flatten();
        self.2.answer_colour(set, &a0, a1, a2);
    }

    fn reset_color(&mut self, a: usize) {
        <Term<Sink> as Handler>::reset_color(self.0, a);
    }

    fn clipboard_store(&mut self, a0: u8, a1: &[u8]) {
        <Term<Sink> as Handler>::clipboard_store(self.0, a0, a1);
    }

    fn clipboard_load(&mut self, a0: u8, a1: &str) {
        <Term<Sink> as Handler>::clipboard_load(self.0, a0, a1);
    }

    fn decaln(&mut self) {
        <Term<Sink> as Handler>::decaln(self.0);
    }

    fn push_title(&mut self) {
        self.1.push_title();
        <Term<Sink> as Handler>::push_title(self.0);
    }

    fn pop_title(&mut self) {
        self.1.pop_title();
        <Term<Sink> as Handler>::pop_title(self.0);
    }

    fn text_area_size_pixels(&mut self) {
        <Term<Sink> as Handler>::text_area_size_pixels(self.0);
    }

    fn text_area_size_chars(&mut self) {
        <Term<Sink> as Handler>::text_area_size_chars(self.0);
    }

    /// Dropped: see the module's doc.
    fn set_hyperlink(&mut self, _: Option<Hyperlink>) {}

    fn report_keyboard_mode(&mut self) {
        <Term<Sink> as Handler>::report_keyboard_mode(self.0);
    }

    fn push_keyboard_mode(&mut self, a: KeyboardModes) {
        self.1.push_keys(a);
        <Term<Sink> as Handler>::push_keyboard_mode(self.0, a);
    }

    fn pop_keyboard_modes(&mut self, a: u16) {
        self.1.pop_keys(a);
        <Term<Sink> as Handler>::pop_keyboard_modes(self.0, a);
    }

    fn set_keyboard_mode(&mut self, a0: KeyboardModes, a1: KeyboardModesApplyBehavior) {
        self.1.set_keys(a0, a1);
        <Term<Sink> as Handler>::set_keyboard_mode(self.0, a0, a1);
    }

    fn set_modify_other_keys(&mut self, a: ModifyOtherKeys) {
        self.1.set_modify_other_keys(a);
        <Term<Sink> as Handler>::set_modify_other_keys(self.0, a);
    }

    fn report_modify_other_keys(&mut self) {
        <Term<Sink> as Handler>::report_modify_other_keys(self.0);
    }

    fn set_scp(&mut self, a0: ScpCharPath, a1: ScpUpdateMode) {
        <Term<Sink> as Handler>::set_scp(self.0, a0, a1);
    }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::term::cell::Cell;
    use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, StdSyncHandler};

    use super::*;
    use crate::{Size, config};

    /// `stream` fed through [`Capped`] to a terminal `rows` high and 6 wide.
    fn fed(rows: u16, stream: &str) -> Term<Sink> {
        let sink = Sink::default();
        let mut term = Term::new(config(10), &Size { cols: 6, rows }, sink.clone());
        let mut tracker = Tracker::new(6, rows.into());
        Processor::<StdSyncHandler>::new().advance(
            &mut Capped(&mut term, &mut tracker, &sink),
            stream.as_bytes(),
        );
        term
    }

    /// Row `line`'s cells: a blank as `.`, a wide char's spacer as `>`, and a `|` after a cell
    /// marked as wrapping.
    fn cells(term: &Term<Sink>, line: i32) -> String {
        let row = &term.grid()[Line(line)];
        let mut out = String::new();
        for column in 0..term.columns() {
            let cell: &Cell = &row[Column(column)];
            out.push(match cell.c {
                _ if cell.flags.contains(Flags::WIDE_CHAR_SPACER) => '>',
                ' ' => '.',
                c => c,
            });
            if cell.flags.contains(Flags::WRAPLINE) {
                out.push('|');
            }
        }
        out
    }

    /// The row `stream` leaves in a terminal one row high: xterm.js's, in every case below.
    fn row(stream: &str) -> String {
        cells(&fed(1, stream), 0)
    }

    #[test]
    fn an_erase_from_a_wide_char_s_second_half_clears_its_first() {
        assert_eq!(row("ab中cd\x1b[4G\x1b[K"), "ab....");
        assert_eq!(row("ab中cd\x1b[4G\x1b[J"), "ab....");
        assert_eq!(row("ab中cd\x1b[4G\x1b[X"), "ab..cd");
    }

    #[test]
    fn an_erase_to_a_wide_char_s_first_half_clears_its_second() {
        assert_eq!(row("ab中cd\x1b[3G\x1b[1K"), "....cd");
        assert_eq!(row("ab中cd\x1b[3G\x1b[1J"), "....cd");
        assert_eq!(row("ab中cd\x1b[3G\x1b[X"), "ab..cd");
    }

    #[test]
    fn an_erase_beside_a_wide_char_leaves_it_whole() {
        assert_eq!(row("ab中cd\x1b[5G\x1b[K"), "ab中>..");
        assert_eq!(row("ab中cd\x1b[2G\x1b[1K"), "..中>cd");
        assert_eq!(row("ab中cd\x1b[1G\x1b[2X"), "..中>cd");
    }

    #[test]
    fn a_delete_of_half_a_wide_char_clears_the_other_half() {
        assert_eq!(row("ab中cd\x1b[4G\x1b[P"), "ab.cd.");
        assert_eq!(row("ab中cd\x1b[3G\x1b[P"), "ab.cd.");
    }

    #[test]
    fn an_insert_inside_a_wide_char_clears_both_halves() {
        assert_eq!(row("ab中cd\x1b[4G\x1b[@"), "ab...c");
        assert_eq!(row("ab中cd\x1b[4G\x1b[4hX"), "ab.X.c");
        assert_eq!(row("ab中cd\x1b[4G\x1b[4h文"), "ab.文>.");
    }

    #[test]
    fn an_insert_that_pushes_a_wide_char_s_second_half_off_the_row_clears_the_first() {
        assert_eq!(row("abcd中\x1b[1G\x1b[@"), ".abcd.");
        assert_eq!(row("abcd中\x1b[1G\x1b[4hX"), "Xabcd.");
    }

    #[test]
    fn text_inserted_before_a_row_ending_in_a_wide_char_keeps_the_char_before_it() {
        // alacritty's shift brings the spacer pushed off the end round to the cursor's cell, and
        // writing over a spacer clears the char before it.
        assert_eq!(row("abcd中\x1b[3G\x1b[4hX"), "abXcd.");
    }

    #[test]
    fn text_inserted_with_a_wrap_pending_shifts_the_next_row_and_clears_what_it_pushes_off() {
        let term = fed(2, "\x1b[2;1Hwxyz中\x1b[1;1Habcdef\x1b[4hX");
        assert_eq!(cells(&term, 0), "abcdef|");
        assert_eq!(cells(&term, 1), "Xwxyz.");
    }

    #[test]
    fn a_half_left_by_an_erase_is_cleared_in_the_erase_s_background() {
        let term = fed(1, "ab中cd\x1b[41m\x1b[4G\x1b[K");
        let row = &term.grid()[Line(0)];
        assert_eq!(row[Column(2)].bg, Color::Named(NamedColor::Red));
        assert_eq!(row[Column(2)].c, ' ');
    }

    /// Rows 0 and 1 of a terminal two rows high, after `abcdefgh` wraps row 0 and `stream`.
    fn after_a_wrap(stream: &str) -> (String, String) {
        let term = fed(2, &("abcdefgh".to_owned() + stream));
        (cells(&term, 0), cells(&term, 1))
    }

    #[test]
    fn an_insert_keeps_the_row_s_line_ending() {
        assert_eq!(after_a_wrap("\x1b[1;1H\x1b[@").0, ".abcde|");
        assert_eq!(after_a_wrap("\x1b[1;1H\x1b[9@").0, "......|");
        assert_eq!(after_a_wrap("\x1b[1;3H\x1b[@").0, "ab.cde|");
    }

    #[test]
    fn text_inserted_keeps_the_row_s_line_ending() {
        assert_eq!(after_a_wrap("\x1b[1;1H\x1b[4hX").0, "Xabcde|");
        assert_eq!(after_a_wrap("\x1b[1;1H\x1b[4h中").0, "中>abcd|");
        assert_eq!(after_a_wrap("\x1b[1;6H\x1b[4hX").0, "abcdeX|");
    }

    #[test]
    fn a_delete_keeps_the_row_s_line_ending_on_its_last_cell() {
        // xterm and VTE end the row there instead; xterm.js, the client, keeps it.
        assert_eq!(after_a_wrap("\x1b[1;1H\x1b[P").0, "bcdef.|");
        assert_eq!(after_a_wrap("\x1b[1;1H\x1b[P\x1b[2P").0, "def...|");
    }

    #[test]
    fn text_written_into_the_last_cell_keeps_the_row_s_line_ending() {
        assert_eq!(after_a_wrap("\x1b[1;6HX").0, "abcdeX|");
        assert_eq!(after_a_wrap("\x1b[1;5H中").0, "abcd中>|");
        assert_eq!(
            after_a_wrap("\x1b[1;6HXY"),
            ("abcdeX|".into(), "Yh....".into())
        );
    }

    #[test]
    fn a_wide_char_that_doesn_t_fit_still_wraps_the_row() {
        let term = fed(2, "abcde中");
        assert_eq!(
            (cells(&term, 0), cells(&term, 1)),
            ("abcde.|".into(), "中>....".into())
        );
        let term = fed(2, "abcde\x1b[4h中");
        assert_eq!(
            (cells(&term, 0), cells(&term, 1)),
            ("abcde.|".into(), "中>....".into())
        );
    }

    #[test]
    fn text_inserted_with_a_wrap_pending_keeps_the_next_row_s_line_ending() {
        let term = fed(3, "\x1b[2;1Huvwxyz12\x1b[1;1Habcdef\x1b[4hX");
        let rows: Vec<String> = (0..3).map(|line| cells(&term, line)).collect();
        assert_eq!(rows, ["abcdef|", "Xuvwxy|", "12...."]);
    }

    /// The cursor `stream` leaves alacritty's on its own, and through [`Capped`].
    fn cursors(rows: u16, stream: &str) -> [(Line, Column, bool); 2] {
        let mut term = Term::new(config(10), &Size { cols: 6, rows }, Sink::default());
        Processor::<StdSyncHandler>::new().advance(&mut term, stream.as_bytes());
        let at = |term: &Term<Sink>| {
            let cursor = &term.grid().cursor;
            (
                cursor.point.line,
                cursor.point.column,
                cursor.input_needs_wrap,
            )
        };
        [at(&term), at(&fed(rows, stream))]
    }

    #[test]
    fn text_inserted_with_a_wrap_pending_wraps_where_alacritty_does() {
        for stream in [
            "\x1b[2;1Huvwxyz12\x1b[1;1Habcdef\x1b[4hX",
            // The last row: the screen scrolls.
            "\x1b[3;1Habcdef\x1b[4hX",
            // Below the region, on the last row: the cursor stays and the row wraps into itself.
            "\x1b[1;2r\x1b[3;1Habcdef\x1b[4hX",
            // With wrapping off, nothing wraps.
            "\x1b[?7l\x1b[1;1Habcdef\x1b[4hX",
        ] {
            let [alone, capped] = cursors(3, stream);
            assert_eq!(capped, alone, "{stream:?}");
        }
        let term = fed(2, "\x1b[2;1Habcdef\x1b[4hX");
        assert_eq!(
            (cells(&term, 0), cells(&term, 1)),
            ("abcdef|".into(), "X.....".into())
        );
        let term = fed(3, "\x1b[1;2r\x1b[3;1Habcdef\x1b[4hX");
        assert_eq!(cells(&term, 2), "Xabcde|");
    }
}
