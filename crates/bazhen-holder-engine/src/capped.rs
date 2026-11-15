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
//! It answers colour queries itself, as alacritty leaves them to a window that knows its colours:
//! the program's own colour, if it set one, else what the engine was given.
//!
//! It drops OSC 8 hyperlinks too: alacritty keeps a link on every cell drawn while it is set, up
//! to an OSC string's 1 KiB each, so a link per cell would cost a GiB at the largest size, and the
//! engine serves none (only the pen is encoded). Every other call goes to alacritty as it is, but
//! OSC 22's mouse pointer shape, which a terminal with no window has no use for, and whose type
//! vte doesn't export.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Column;
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
        if a.width() == Some(0) && self.marks_full(a) {
            return;
        }
        <Term<Sink> as Handler>::input(self.0, a);
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
        <Term<Sink> as Handler>::insert_blank(self.0, a);
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
    }

    fn delete_chars(&mut self, a: usize) {
        <Term<Sink> as Handler>::delete_chars(self.0, a);
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
    }

    fn clear_screen(&mut self, a: ClearMode) {
        <Term<Sink> as Handler>::clear_screen(self.0, a);
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
