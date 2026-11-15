//! The modes a program sets: what a snapshot restores and what a client acts on.
//!
//! alacritty holds most of them in its public `TermMode`. Some it keeps private: the scroll
//! region, the tab stops, the active charset, the cursor style a program set, and, under the
//! alternate screen, the primary screen's cursor. Others it ignores: kitty's keyboard flags (the
//! engine runs it with them off) and modifyOtherKeys. [`Tracker`] keeps those from the same
//! handler calls alacritty gets, with alacritty's semantics wherever alacritty has any.

use std::fmt::Write as _;
use std::ops::Range;

use alacritty_terminal::grid::Cursor;
use alacritty_terminal::index::Column;
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{
    CharsetIndex, CursorShape, CursorStyle as Style, KeyboardModes, KeyboardModesApplyBehavior,
    ModifyOtherKeys, StandardCharset, TabulationClearMode,
};

use crate::Sink;

/// The kitty flags one screen's stack holds, oldest evicted first, as kitty's protocol says.
pub(crate) const MOST_KEYBOARD_MODES: usize = 16;

/// alacritty's tab stops before a program sets any: every 8th column.
const TAB_EVERY: usize = 8;

/// The modes alacritty keeps to itself or ignores, kept beside it.
#[derive(Debug, Clone)]
pub(crate) struct Tracker {
    region: Range<usize>,
    tabs: Vec<bool>,
    active: CharsetIndex,
    style: Option<Style>,
    /// The primary screen's cursor while the alternate screen is up.
    primary: Option<Cursor<Cell>>,
    /// The alternate screen's saved cursor while the primary screen is up, which alacritty keeps
    /// from one visit to the next, and privately.
    alternate_saved: Option<Cursor<Cell>>,
    keys: KeyStack,
    hidden_keys: KeyStack,
    modify_other_keys: u8,
    /// The title, as alacritty keeps it privately: none until a program sets one.
    title: Option<String>,
    /// `CSI 22 t`'s stack, oldest first. The engine undoes a push past its own limit, so it
    /// holds no more than that limit, of an OSC string each.
    titles: Vec<Option<String>>,
}

impl Tracker {
    pub(crate) fn new(cols: usize, rows: usize) -> Self {
        Self {
            region: 0..rows,
            tabs: (0..cols)
                .map(|column| column.is_multiple_of(TAB_EVERY))
                .collect(),
            active: CharsetIndex::G0,
            style: None,
            primary: None,
            alternate_saved: None,
            keys: KeyStack::default(),
            hidden_keys: KeyStack::default(),
            modify_other_keys: 0,
            title: None,
            titles: Vec::new(),
        }
    }

    pub(crate) fn set_title(&mut self, title: Option<String>) {
        self.title = title;
    }

    pub(crate) fn push_title(&mut self) {
        self.titles.push(self.title.clone());
    }

    /// As alacritty pops: the title comes back only if the stack had one.
    pub(crate) fn pop_title(&mut self) {
        if let Some(title) = self.titles.pop() {
            self.title = title;
        }
    }

    pub(crate) fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    /// The title stack and then the title, for a fresh terminal. A title can be none only before
    /// any is set, so the nones are at the bottom of the stack and are pushed before any title is.
    pub(crate) fn write_titles(&self, out: &mut String) {
        for title in &self.titles {
            write_title(out, title.as_deref());
            out.push_str("\x1b[22t");
        }
        write_title(out, self.title.as_deref());
    }

    /// The alternate screen's saved cursor, while the primary screen is up and if it has been.
    pub(crate) fn alternate_saved(&self) -> Option<&Cursor<Cell>> {
        self.alternate_saved.as_ref()
    }

    pub(crate) fn active_charset(&self) -> CharsetIndex {
        self.active
    }

    /// DECSTBM as alacritty takes it: a region of fewer than two rows is ignored, and both ends
    /// are clamped to the screen, so a region set past the bottom can be empty or one row.
    pub(crate) fn set_region(&mut self, top: usize, bottom: Option<usize>, rows: usize) {
        let bottom = bottom.unwrap_or(rows);
        if top >= bottom {
            return;
        }
        self.region = top.saturating_sub(1).min(rows)..bottom.min(rows);
    }

    pub(crate) fn set_tab(&mut self, column: Column) {
        if let Some(stop) = self.tabs.get_mut(column.0) {
            *stop = true;
        }
    }

    pub(crate) fn clear_tabs(&mut self, mode: &TabulationClearMode, column: Column) {
        match mode {
            TabulationClearMode::Current => {
                if let Some(stop) = self.tabs.get_mut(column.0) {
                    *stop = false;
                }
            }
            TabulationClearMode::All => self.tabs.fill(false),
        }
    }

    pub(crate) fn set_active_charset(&mut self, index: CharsetIndex) {
        self.active = index;
    }

    pub(crate) fn set_cursor_style(&mut self, style: Option<Style>) {
        self.style = style;
    }

    /// OSC 50 and `?12` change one side of the style, from alacritty's default if none was set.
    pub(crate) fn set_cursor_shape(&mut self, shape: CursorShape) {
        self.style.get_or_insert_default().shape = shape;
    }

    pub(crate) fn set_cursor_blinking(&mut self, blinking: bool) {
        self.style.get_or_insert_default().blinking = blinking;
    }

    /// `?1049h`, called only when it switches: the primary's cursor goes out of reach.
    pub(crate) fn alternate_on(&mut self, primary: &Cursor<Cell>) {
        self.primary = Some(primary.clone());
        self.alternate_saved = None;
        std::mem::swap(&mut self.keys, &mut self.hidden_keys);
    }

    /// `?1049l`, called only when it switches, with the alternate screen's saved cursor.
    pub(crate) fn alternate_off(&mut self, alternate_saved: &Cursor<Cell>) {
        self.primary = None;
        self.alternate_saved = Some(alternate_saved.clone());
        std::mem::swap(&mut self.keys, &mut self.hidden_keys);
    }

    pub(crate) fn push_keys(&mut self, flags: KeyboardModes) {
        self.keys.push(flags);
    }

    pub(crate) fn pop_keys(&mut self, count: u16) {
        self.keys.pop(count);
    }

    pub(crate) fn set_keys(&mut self, flags: KeyboardModes, how: KeyboardModesApplyBehavior) {
        self.keys.set(flags, how);
    }

    pub(crate) fn set_modify_other_keys(&mut self, level: ModifyOtherKeys) {
        self.modify_other_keys = match level {
            ModifyOtherKeys::Reset => 0,
            ModifyOtherKeys::EnableExceptWellDefined => 1,
            ModifyOtherKeys::EnableAll => 2,
        };
    }

    /// The size alacritty resized to, from `old`. As alacritty does, the region goes back to the
    /// whole screen, and the tab stops are cut short or extended with the defaults.
    ///
    /// Under the alternate screen alacritty reflows the primary grid, cursor and all, where
    /// nothing can read it: the copy of its cursor is only kept within the new size, so a
    /// reflow that moved it is not followed.
    pub(crate) fn resize(&mut self, old: (usize, usize), (cols, rows): (usize, usize)) {
        self.region = 0..rows;
        if old.0 != cols {
            let mut column = self.tabs.len();
            self.tabs.resize_with(cols, || {
                let stop = column.is_multiple_of(TAB_EVERY);
                column += 1;
                stop
            });
        }
        let last_line = i32::try_from(rows.saturating_sub(1)).unwrap_or(i32::MAX);
        for cursor in [&mut self.primary, &mut self.alternate_saved]
            .into_iter()
            .flatten()
        {
            cursor.point.line.0 = cursor.point.line.0.min(last_line);
            cursor.point.column.0 = cursor.point.column.0.min(cols.saturating_sub(1));
        }
    }

    #[cfg(test)]
    pub(crate) fn primary(&self) -> Option<&Cursor<Cell>> {
        self.primary.as_ref()
    }

    pub(crate) fn modes(&self, term: &Term<Sink>) -> Modes {
        let mode = *term.mode();
        let on = |flag| mode.contains(flag);
        let tracking = if on(TermMode::MOUSE_MOTION) {
            MouseTracking::Motion
        } else if on(TermMode::MOUSE_DRAG) {
            MouseTracking::Drags
        } else if on(TermMode::MOUSE_REPORT_CLICK) {
            MouseTracking::Clicks
        } else {
            MouseTracking::Off
        };
        let encoding = if on(TermMode::SGR_MOUSE) {
            MouseEncoding::Sgr
        } else if on(TermMode::UTF8_MOUSE) {
            MouseEncoding::Utf8
        } else {
            MouseEncoding::Default
        };
        let key_mode = |flag| {
            if on(flag) {
                KeyMode::Application
            } else {
                KeyMode::Normal
            }
        };
        Modes {
            keys: Keys {
                cursor_keys: key_mode(TermMode::APP_CURSOR),
                keypad: key_mode(TermMode::APP_KEYPAD),
                kitty_requested: self.keys.flags(),
                kitty_requested_hidden: self.hidden_keys.flags(),
                modify_other_keys_requested: self.modify_other_keys,
            },
            mouse: Mouse {
                tracking,
                encoding,
                alternate_scroll: on(TermMode::ALTERNATE_SCROLL),
            },
            cursor: CursorModes {
                visible: on(TermMode::SHOW_CURSOR),
                style: self.style.map(CursorStyle::from),
            },
            screen: Screen {
                alternate: on(TermMode::ALT_SCREEN),
                auto_wrap: on(TermMode::LINE_WRAP),
                insert: on(TermMode::INSERT),
                origin: if on(TermMode::ORIGIN) {
                    Origin::Region
                } else {
                    Origin::Screen
                },
                line_feed: if on(TermMode::LINE_FEED_NEW_LINE) {
                    LineFeed::NewLine
                } else {
                    LineFeed::Feed
                },
                region: to_u16(self.region.start)..to_u16(self.region.end),
                tab_stops: (self.tabs.iter().enumerate())
                    .filter(|&(_, &stop)| stop)
                    .map(|(column, _)| to_u16(column))
                    .collect(),
                charsets: designations(&term.grid().cursor),
                active_charset: if self.active == CharsetIndex::G1 {
                    ActiveCharset::G1
                } else {
                    ActiveCharset::G0
                },
                hidden_charsets: self.primary.as_ref().map(designations),
            },
            focus_events: on(TermMode::FOCUS_IN_OUT),
            bracketed_paste: on(TermMode::BRACKETED_PASTE),
            urgency_hints: on(TermMode::URGENCY_HINTS),
        }
    }
}

/// One screen's kitty keyboard flags: the top entry is the flags in force, none means 0.
#[derive(Debug, Clone, Default)]
struct KeyStack(Vec<KeyboardModes>);

impl KeyStack {
    fn push(&mut self, flags: KeyboardModes) {
        if self.0.len() >= MOST_KEYBOARD_MODES {
            self.0.remove(0);
        }
        self.0.push(flags);
    }

    fn pop(&mut self, count: u16) {
        self.0.truncate(self.0.len().saturating_sub(count.into()));
    }

    /// Kitty changes the flags in force, which are the top entry's, and makes one if the stack
    /// is empty.
    fn set(&mut self, flags: KeyboardModes, how: KeyboardModesApplyBehavior) {
        if self.0.is_empty() {
            self.0.push(KeyboardModes::NO_MODE);
        }
        if let Some(top) = self.0.last_mut() {
            *top = match how {
                KeyboardModesApplyBehavior::Replace => flags,
                KeyboardModesApplyBehavior::Union => top.union(flags),
                KeyboardModesApplyBehavior::Difference => top.difference(flags),
            };
        }
    }

    fn flags(&self) -> Vec<KittyFlags> {
        self.0
            .iter()
            .map(|flags| KittyFlags(flags.bits()))
            .collect()
    }
}

/// OSC 2, with no control char: a C1 ST (U+009C) ends an OSC in a viewer that decodes UTF-8 first,
/// and would let the rest of a title through as text.
fn write_title(out: &mut String, title: Option<&str>) {
    if let Some(title) = title {
        out.push_str("\x1b]2;");
        out.extend(title.chars().filter(|c| !c.is_control()));
        out.push_str("\x1b\\");
    }
}

pub(crate) fn designations(cursor: &Cursor<Cell>) -> [Charset; 4] {
    [
        CharsetIndex::G0,
        CharsetIndex::G1,
        CharsetIndex::G2,
        CharsetIndex::G3,
    ]
    .map(|index| match cursor.charsets[index] {
        StandardCharset::Ascii => Charset::Ascii,
        StandardCharset::SpecialCharacterAndLineDrawing => Charset::LineDrawing,
    })
}

fn to_u16(value: usize) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

/// Every mode a program set that a snapshot restores or a client acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Modes {
    pub keys: Keys,
    pub mouse: Mouse,
    pub cursor: CursorModes,
    pub screen: Screen,
    /// `?1004`: focus in and out reported.
    pub focus_events: bool,
    /// `?2004`.
    pub bracketed_paste: bool,
    /// `?1042`.
    pub urgency_hints: bool,
}

/// How the program wants keys sent.
///
/// The kitty flags and modifyOtherKeys are what the program **requested**, not what the engine
/// grants: it doesn't speak either, and doesn't answer kitty's `CSI ? u` query (it always answers
/// DA1), so a program that asks first falls back to legacy keys, and some push flags anyway. A
/// client must not encode keys as `CSI u` while kitty is unadvertised, and must never pass these
/// requests on to a terminal of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keys {
    /// DECCKM, `?1`.
    pub cursor_keys: KeyMode,
    /// DECKPAM and DECKPNM, `ESC =` and `ESC >`.
    pub keypad: KeyMode,
    /// The shown screen's kitty flags stack, oldest first: the last entry is in force. At most
    /// [`MOST_KEYBOARD_MODES`] (16), the oldest evicted first.
    pub kitty_requested: Vec<KittyFlags>,
    /// The other screen's stack: each screen keeps its own.
    pub kitty_requested_hidden: Vec<KittyFlags>,
    /// modifyOtherKeys, `CSI > 4 ; n m`: 0, 1 or 2.
    pub modify_other_keys_requested: u8,
}

/// Kitty's progressive enhancement flags, as a program pushed them: 1 disambiguates escape codes,
/// 2 reports event types, 4 alternate keys, 8 all keys as escape codes, 16 associated text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KittyFlags(pub u8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyMode {
    Normal,
    Application,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mouse {
    pub tracking: MouseTracking,
    pub encoding: MouseEncoding,
    /// `?1007`: the wheel sends arrow keys under the alternate screen. On by default in the
    /// engine, as in alacritty, and off in xterm.
    pub alternate_scroll: bool,
}

/// `?1000`, `?1002`, `?1003`: one at most.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseTracking {
    Off,
    Clicks,
    Drags,
    Motion,
}

/// `?1005`, `?1006`: one at most.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseEncoding {
    Default,
    Utf8,
    Sgr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorModes {
    /// DECTCEM, `?25`.
    pub visible: bool,
    /// The style the program set (DECSCUSR, `?12`, OSC 50), or `None` for the viewer's own.
    pub style: Option<CursorStyle>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorStyle {
    pub shape: Shape,
    pub blinking: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Block,
    Underline,
    Beam,
}

impl From<Style> for CursorStyle {
    fn from(style: Style) -> Self {
        let shape = match style.shape {
            CursorShape::Underline => Shape::Underline,
            CursorShape::Beam => Shape::Beam,
            // vte parses no sequence into a hollow or hidden cursor.
            CursorShape::Block | CursorShape::HollowBlock | CursorShape::Hidden => Shape::Block,
        };
        Self {
            shape,
            blinking: style.blinking,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    /// `?1049`.
    pub alternate: bool,
    /// DECAWM, `?7`.
    pub auto_wrap: bool,
    /// IRM, SM 4.
    pub insert: bool,
    /// DECOM, `?6`.
    pub origin: Origin,
    /// LNM, SM 20.
    pub line_feed: LineFeed,
    /// DECSTBM, the rows it spans, from 0. alacritty clamps both ends to the screen, so a
    /// region set past the bottom is empty, or the last row alone.
    pub region: Range<u16>,
    /// The columns, from 0, with a tab stop.
    pub tab_stops: Vec<u16>,
    /// What G0 to G3 are designated, for the shown screen's cursor.
    pub charsets: [Charset; 4],
    /// SI or SO.
    pub active_charset: ActiveCharset,
    /// The primary screen's cursor's G0 to G3 while the alternate screen is up.
    pub hidden_charsets: Option<[Charset; 4]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Screen,
    Region,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineFeed {
    Feed,
    NewLine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Charset {
    Ascii,
    LineDrawing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveCharset {
    G0,
    G1,
}

/// What a fresh terminal is given to take on these modes, in the order
/// [`Modes::write_for_engine`] gives them, with the screens and cursors between them.
///
/// A viewer here is an emulator Bazhen owns: the web client's xterm.js, or an attach client's own
/// rendering engine. Never the user's own terminal: these bytes turn on mouse tracking, focus
/// reports, bracketed paste and application cursor keys wherever they land, and would leave them
/// on there after the client has gone.
///
/// Each writes every mode it covers, not only those that differ from a default: a viewer's
/// defaults aren't the engine's, and a switch to the alternate screen copies the primary's
/// charsets. DECSTBM and DECOM home the cursor, so the cursor is placed after [`Modes::write`];
/// `?1049h` in either keys writer, or step 3, sets the primary's saved cursor, which goes after.
impl Modes {
    /// The modes of the screen shown, but the requested keys. For an engine or a viewer.
    pub fn write(&self, out: &mut String) {
        let flag = |out: &mut String, mode: u16, on: bool| {
            let _ = write!(out, "\x1b[?{mode}{}", if on { 'h' } else { 'l' });
        };
        flag(out, 1, self.keys.cursor_keys == KeyMode::Application);
        out.push_str(if self.keys.keypad == KeyMode::Application {
            "\x1b="
        } else {
            "\x1b>"
        });
        // Every mouse mode is reset before the one in force is set: xterm turns tracking off at
        // the reset of any of them.
        let tracking = [
            (1000, MouseTracking::Clicks),
            (1002, MouseTracking::Drags),
            (1003, MouseTracking::Motion),
        ];
        exclusive(out, &tracking, self.mouse.tracking);
        let encodings = [(1005, MouseEncoding::Utf8), (1006, MouseEncoding::Sgr)];
        exclusive(out, &encodings, self.mouse.encoding);
        flag(out, 1007, self.mouse.alternate_scroll);
        flag(out, 1004, self.focus_events);
        flag(out, 2004, self.bracketed_paste);
        flag(out, 1042, self.urgency_hints);
        flag(out, 25, self.cursor.visible);
        let style = self.cursor.style.map_or(0, |style| {
            let steady = u8::from(!style.blinking);
            match style.shape {
                Shape::Block => 1 + steady,
                Shape::Underline => 3 + steady,
                Shape::Beam => 5 + steady,
            }
        });
        let _ = write!(out, "\x1b[{style} q");
        flag(out, 7, self.screen.auto_wrap);
        let _ = write!(out, "\x1b[4{}", if self.screen.insert { 'h' } else { 'l' });
        let newline = self.screen.line_feed == LineFeed::NewLine;
        let _ = write!(out, "\x1b[20{}", if newline { 'h' } else { 'l' });
        let region = &self.screen.region;
        // DECSTBM ignores a region of fewer than two rows: one that is empty, or a row, came from
        // a bottom past the screen, which is clamped to it, and comes back from one again.
        let top = region.start.saturating_add(1);
        let bottom = region.end.max(top.saturating_add(1));
        let _ = write!(out, "\x1b[{top};{bottom}r");
        flag(out, 6, self.screen.origin == Origin::Region);
        out.push_str("\x1b[3g");
        for stop in &self.screen.tab_stops {
            let _ = write!(out, "\x1b[{}G\x1bH", stop.saturating_add(1));
        }
        write_charsets(out, self.screen.charsets);
        out.push(match self.screen.active_charset {
            ActiveCharset::G0 => '\x0f',
            ActiveCharset::G1 => '\x0e',
        });
    }

    /// The hidden primary screen's charsets, while the alternate screen is up, for the primary
    /// screen before the switch. Nothing otherwise. For an engine or a viewer.
    pub fn write_inactive(&self, out: &mut String) {
        if let Some(charsets) = self.screen.hidden_charsets {
            write_charsets(out, charsets);
        }
    }

    /// The shown screen's kitty flags and modifyOtherKeys, as requested. For an engine only:
    /// passed to a terminal, they change how its keys are sent.
    pub fn write_keys(&self, out: &mut String) {
        write_kitty(out, &self.keys.kitty_requested);
        let _ = write!(out, "\x1b[>4;{}m", self.keys.modify_other_keys_requested);
    }

    /// The hidden screen's kitty flags, for an engine with the primary screen up: the primary's,
    /// or the alternate screen's, which comes up to take them and goes again. For an engine only.
    ///
    /// The alternate screen's stack is empty in a fresh engine, so an empty one is left alone:
    /// bringing the screen up resets the primary's saved cursor, for nothing.
    pub fn write_keys_inactive(&self, out: &mut String) {
        if self.screen.alternate {
            write_kitty(out, &self.keys.kitty_requested_hidden);
        } else if !self.keys.kitty_requested_hidden.is_empty() {
            out.push_str("\x1b[?1049h");
            write_kitty(out, &self.keys.kitty_requested_hidden);
            out.push_str("\x1b[?1049l");
        }
    }
}

impl Modes {
    /// The hidden screen's kitty flags, with no switch around them.
    pub(crate) fn write_keys_hidden(&self, out: &mut String) {
        write_kitty(out, &self.keys.kitty_requested_hidden);
    }
}

impl Modes {
    /// Everything a fresh engine is given to take on these modes, in order, with nothing to put
    /// between: the hidden screen's keys, the hidden screen's modes, `?1049h` if the alternate
    /// screen is up, the shown screen's modes and then its keys. A snapshot writes the same
    /// steps, its screens and cursors between them.
    pub fn write_for_engine(&self, out: &mut String) {
        self.write_keys_inactive(out);
        self.write_inactive(out);
        if self.screen.alternate {
            out.push_str("\x1b[?1049h");
        }
        self.write(out);
        self.write_keys(out);
    }
}

fn exclusive<T: PartialEq + Copy>(out: &mut String, modes: &[(u16, T)], set: T) {
    for (mode, _) in modes.iter().filter(|(_, value)| *value != set) {
        let _ = write!(out, "\x1b[?{mode}l");
    }
    for (mode, _) in modes.iter().filter(|(_, value)| *value == set) {
        let _ = write!(out, "\x1b[?{mode}h");
    }
}

pub(crate) fn write_charsets(out: &mut String, charsets: [Charset; 4]) {
    for (slot, charset) in ['(', ')', '*', '+'].iter().zip(charsets) {
        let set = match charset {
            Charset::Ascii => 'B',
            Charset::LineDrawing => '0',
        };
        let _ = write!(out, "\x1b{slot}{set}");
    }
}

/// Empties the stack and pushes `stack` back, oldest first.
fn write_kitty(out: &mut String, stack: &[KittyFlags]) {
    let _ = write!(out, "\x1b[<{MOST_KEYBOARD_MODES}u");
    for KittyFlags(flags) in stack {
        let _ = write!(out, "\x1b[>{flags}u");
    }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::index::{Column, Line};

    use super::*;
    use crate::{Engine, HistoryRows, Size, config};

    const SIZE: Size = Size { cols: 20, rows: 5 };

    fn engine() -> Engine {
        Engine::new(SIZE, HistoryRows(100))
    }

    fn after(output: &str) -> Modes {
        let mut engine = engine();
        engine.advance(output.as_bytes());
        engine.modes()
    }

    fn restore(modes: &Modes) -> String {
        let mut out = String::new();
        modes.write_for_engine(&mut out);
        out
    }

    fn restored(modes: &Modes) -> Modes {
        after(&restore(modes))
    }

    fn bits(stack: &[KittyFlags]) -> Vec<u8> {
        stack.iter().map(|flags| flags.0).collect()
    }

    fn pushes(flags: std::ops::RangeInclusive<u8>) -> String {
        flags.fold(String::new(), |mut out, flags| {
            let _ = write!(out, "\x1b[>{flags}u");
            out
        })
    }

    #[test]
    fn a_region_is_kept_as_alacritty_clamps_it() {
        assert_eq!(after("\x1b[2;4r").screen.region, 1..4);
        assert_eq!(
            after("\x1b[2;4r\x1b[4;2r").screen.region,
            1..4,
            "upside down"
        );
        assert_eq!(after("\x1b[2;4r\x1b[3;3r").screen.region, 1..4, "one row");
        assert_eq!(after("\x1b[3;9r").screen.region, 2..5, "past the bottom");
        assert_eq!(after("\x1b[5;9r").screen.region, 4..5, "the last row alone");
        assert_eq!(
            after("\x1b[7;9r").screen.region,
            5..5,
            "all past the bottom"
        );
        assert_eq!(after("\x1b[2;4r\x1b[r").screen.region, 0..5);
    }

    #[test]
    fn a_resize_resets_the_region_but_not_one_to_the_same_size() {
        let mut engine = engine();
        engine.advance(b"\x1b[2;4r");
        engine.resize(SIZE);
        assert_eq!(engine.modes().screen.region, 1..4);
        engine.resize(Size { cols: 20, rows: 8 });
        assert_eq!(engine.modes().screen.region, 0..8);
    }

    #[test]
    fn deccolm_resets_the_region_but_on_a_screen_of_one_row() {
        assert_eq!(after("\x1b[2;4r\x1b[?3h").screen.region, 0..5);
        assert_eq!(after("\x1b[2;4r\x1b[?3l").screen.region, 0..5);
        let mut engine = Engine::new(Size { cols: 20, rows: 1 }, HistoryRows(100));
        engine.advance(b"\x1b[2;3r\x1b[?3l");
        assert_eq!(engine.modes().screen.region, 1..1);
    }

    #[test]
    fn tab_stops_are_set_and_cleared_where_the_cursor_is() {
        assert_eq!(after("").screen.tab_stops, [0, 8, 16]);
        assert_eq!(after("abc\x1bH").screen.tab_stops, [0, 3, 8, 16]);
        assert_eq!(after("\x1b[9G\x1b[g").screen.tab_stops, [0, 16]);
        assert_eq!(after("\x1b[20G\x1bH").screen.tab_stops, [0, 8, 16, 19]);
        // A cursor waiting to wrap is still in the last column.
        let waiting = "x".repeat(20) + "\x1bH";
        assert_eq!(after(&waiting).screen.tab_stops, [0, 8, 16, 19]);
        assert_eq!(after("\x1b[3g\x1b[5G\x1bH").screen.tab_stops, [4]);
    }

    #[test]
    fn a_narrowing_drops_the_stops_past_it_and_a_widening_brings_back_the_defaults() {
        let mut engine = engine();
        engine.advance(b"\x1b[3g\x1b[3G\x1bH\x1b[18G\x1bH");
        engine.resize(Size { cols: 10, rows: 5 });
        assert_eq!(engine.modes().screen.tab_stops, [2]);
        engine.resize(Size { cols: 30, rows: 5 });
        assert_eq!(engine.modes().screen.tab_stops, [2, 16, 24]);
    }

    #[test]
    fn the_saved_cursor_keeps_the_designations_but_not_the_shift() {
        let modes = after("\x1b(0\x0e\x1b7\x1b(B\x0f\x1b8");
        assert_eq!(modes.screen.charsets[0], Charset::LineDrawing);
        assert_eq!(modes.screen.active_charset, ActiveCharset::G0);
        let shifted = after("\x0f\x1b7\x0e\x1b8").screen.active_charset;
        assert_eq!(shifted, ActiveCharset::G1);
    }

    #[test]
    fn the_cursor_style_set_is_told_from_none_set() {
        assert_eq!(after("").cursor.style, None);
        let steady_block = CursorStyle {
            shape: Shape::Block,
            blinking: false,
        };
        assert_eq!(after("\x1b[2 q").cursor.style, Some(steady_block));
        let blinking_block = CursorStyle {
            blinking: true,
            ..steady_block
        };
        assert_eq!(after("\x1b[?12h").cursor.style, Some(blinking_block));
        let beam = CursorStyle {
            shape: Shape::Beam,
            blinking: true,
        };
        assert_eq!(after("\x1b[5 q").cursor.style, Some(beam));
        let osc = after("\x1b]50;CursorShape=2\x07").cursor.style;
        assert_eq!(osc.map(|style| style.shape), Some(Shape::Underline));
        assert_eq!(after("\x1b[5 q\x1b[0 q").cursor.style, None);
        assert_eq!(after("\x1b[5 q\x1bc").cursor.style, None);
    }

    #[test]
    fn leaving_the_alternate_screen_brings_back_the_primary_cursor_as_copied() {
        let mut engine = engine();
        engine.advance(b"\x1b[31m\x1b)0\x1b[3;5H\x1b7\x1b[4;6H\x1b[?1049h");
        let copy = engine.tracker.primary().cloned();
        engine.advance(b"\x1b[0m\x1b)B\x1b[1;1H\x1b[?1049l");
        let grid = engine.term.grid();
        assert_eq!(copy.as_ref(), Some(&grid.cursor));
        assert_eq!(copy.as_ref(), Some(&grid.saved_cursor));
        assert_eq!(engine.tracker.primary(), None);
    }

    #[test]
    fn a_resize_under_the_alternate_screen_only_keeps_the_primary_cursor_within_it() {
        // The named divergence: alacritty reflows the primary grid out of reach, and the copy
        // is moved no further than into the new size, and not back when the size grows.
        let mut engine = engine();
        engine.advance(b"\x1b[5;16H\x1b[?1049h");
        let point = |engine: &Engine| {
            let cursor = engine.tracker.primary();
            cursor.map(|cursor| (cursor.point.line, cursor.point.column))
        };
        engine.resize(Size { cols: 10, rows: 3 });
        assert_eq!(point(&engine), Some((Line(2), Column(9))));
        engine.resize(Size { cols: 30, rows: 8 });
        assert_eq!(point(&engine), Some((Line(2), Column(9))));
    }

    #[test]
    fn the_primary_charsets_are_kept_from_the_switch() {
        let modes = after("\x1b(0\x1b[?1049h\x1b(B");
        assert_eq!(modes.screen.charsets[0], Charset::Ascii);
        assert_eq!(
            modes.screen.hidden_charsets.map(|charsets| charsets[0]),
            Some(Charset::LineDrawing)
        );
        assert_eq!(after("\x1b[?1049h\x1b[?1049l").screen.hidden_charsets, None);
    }

    #[test]
    fn kitty_flags_push_pop_and_set_as_kitty_s_protocol_says() {
        let stack = |output: &str| bits(&after(output).keys.kitty_requested);
        assert_eq!(stack("\x1b[>1u\x1b[>3u"), [1, 3]);
        assert_eq!(stack("\x1b[>1u\x1b[>3u\x1b[<u"), [1]);
        assert_eq!(stack("\x1b[>1u\x1b[>3u\x1b[<5u"), [] as [u8; 0]);
        assert_eq!(stack("\x1b[=5u"), [5], "set on an empty stack");
        assert_eq!(stack("\x1b[>1u\x1b[=6;2u"), [7], "added");
        assert_eq!(stack("\x1b[>7u\x1b[=2;3u"), [5], "cleared");
        assert_eq!(stack("\x1b[>7u\x1b[=2;1u"), [2], "replaced");
        assert_eq!(
            stack("\x1b[>1u\x1b[>2u\x1b[=4u\x1b[<u"),
            [1],
            "set the top only"
        );
    }

    #[test]
    fn past_sixteen_pushes_the_oldest_flags_go() {
        let stack = bits(&after(&pushes(1..=31)).keys.kitty_requested);
        assert_eq!(stack, (16..=31).collect::<Vec<u8>>());
    }

    #[test]
    fn each_screen_keeps_its_own_kitty_flags() {
        let mut engine = engine();
        engine.advance(b"\x1b[>1u\x1b[?1049h\x1b[>2u");
        let keys = |engine: &Engine| {
            let keys = engine.modes().keys;
            (
                bits(&keys.kitty_requested),
                bits(&keys.kitty_requested_hidden),
            )
        };
        assert_eq!(keys(&engine), (vec![2], vec![1]));
        engine.advance(b"\x1b[?1049h");
        assert_eq!(keys(&engine), (vec![2], vec![1]), "already up");
        engine.advance(b"\x1b[?1049l");
        assert_eq!(keys(&engine), (vec![1], vec![2]));
        engine.advance(b"\x1b[?1049l");
        assert_eq!(keys(&engine), (vec![1], vec![2]), "already down");
        engine.advance(b"\x1b[?1049h");
        assert_eq!(keys(&engine), (vec![2], vec![1]), "kept between visits");
    }

    #[test]
    fn modify_other_keys_takes_levels_0_to_2_and_ignores_the_rest() {
        let level = |output: &str| after(output).keys.modify_other_keys_requested;
        assert_eq!(level("\x1b[>4;1m"), 1);
        assert_eq!(level("\x1b[>4;2m"), 2);
        assert_eq!(level("\x1b[>4;2m\x1b[>4m"), 0);
        assert_eq!(level("\x1b[>4;2m\x1b[>4;3m"), 2);
        assert_eq!(level("\x1b[>4;2m\x1b[>5;0m"), 2);
    }

    #[test]
    fn a_reset_under_the_alternate_screen_clears_everything_tracked() {
        let set = "\x1b[2;4r\x1b[3g\x0e\x1b[5 q\x1b[>4;2m\x1b[>1u\x1b[?1049h\x1b[>2u";
        let mut engine = engine();
        engine.advance(set.as_bytes());
        engine.advance(b"\x1bc");
        assert_eq!(engine.modes(), after(""));
        assert_eq!(engine.tracker.primary(), None);
    }

    #[test]
    fn a_soft_reset_changes_nothing_as_vte_doesn_t_parse_it() {
        let set = "\x1b[2;4r\x1b[3g\x0e\x1b[5 q\x1b[>4;2m\x1b[>1u\x1b[?1h";
        assert_eq!(after(&(set.to_owned() + "\x1b[!p")), after(set));
    }

    #[test]
    fn the_engine_doesn_t_speak_kitty_s_protocol() {
        // With it on, a program could push alacritty past its own cap, where alacritty takes
        // from the title stack instead and panics if that is empty.
        assert!(!config(1).kitty_keyboard);
        let mut engine = engine();
        engine.advance(b"\x1b[>1u\x1b[?u\x1b[c");
        assert_eq!(engine.take_replies(), b"\x1b[?6c");
    }

    #[test]
    fn a_region_alacritty_clamped_comes_back() {
        for region in ["\x1b[7;9r", "\x1b[5;9r", "\x1b[2;4r"] {
            let modes = after(region);
            assert_eq!(restored(&modes), modes, "{region:?}");
        }
    }

    #[test]
    fn a_full_kitty_stack_comes_back_oldest_first() {
        let modes = after(&pushes(1..=16));
        assert_eq!(
            restored(&modes).keys.kitty_requested,
            modes.keys.kitty_requested
        );
    }

    #[test]
    fn the_alternate_screen_s_kitty_flags_come_back_while_the_primary_is_up() {
        let modes = after("\x1b[?1049h\x1b[>1u\x1b[?1049l\x1b[>3u");
        assert_eq!(modes.keys.kitty_requested_hidden, [KittyFlags(1)]);
        assert_eq!(restored(&modes), modes);
    }

    #[test]
    fn an_empty_alternate_screen_stack_brings_the_alternate_screen_up_for_nothing() {
        let mut engine = engine();
        engine.advance(b"\x1b[3;5H\x1b7\x1b[1;1H");
        let mut out = String::new();
        engine.modes().write_keys_inactive(&mut out);
        assert_eq!(out, "");
        engine.advance(out.as_bytes());
        assert_eq!(engine.term.grid().saved_cursor.point.column, Column(4));
    }

    #[test]
    fn the_alternate_screen_draws_in_its_own_charsets_not_the_primary_s() {
        let modes = after("\x1b(0\x1b[?1049h\x1b(B");
        let mut engine = engine();
        engine.advance(restore(&modes).as_bytes());
        engine.advance(b"\x1b[1Gq");
        let row = engine.term.grid().cursor.point.line;
        assert_eq!(engine.term.grid()[row][Column(0)].c, 'q');
        assert_eq!(engine.modes(), modes);
    }

    #[test]
    fn what_a_viewer_is_given_asks_for_no_keys() {
        let modes = after("\x1b[>4;2m\x1b[>5u\x1b[?1049h\x1b[>3u\x1b[=1u");
        let mut out = String::new();
        modes.write_inactive(&mut out);
        modes.write(&mut out);
        for intro in ["\x1b[>", "\x1b[<", "\x1b[="] {
            assert!(!out.contains(intro), "{intro:?} in {out:?}");
        }
        let mut keys = String::new();
        modes.write_keys(&mut keys);
        assert!(
            keys.contains("\x1b[>1u") && keys.contains("\x1b[>4;2m"),
            "{keys:?}"
        );
    }

    #[test]
    fn every_mode_is_written_whether_or_not_it_is_a_default() {
        let mut out = String::new();
        after("").write(&mut out);
        for mode in [
            "?1l", "?1000l", "?1002l", "?1003l", "?1005l", "?1006l", "?1007h", "?1004l", "?2004l",
            "?1042h", "?25h", "0 q", "?7h", "4l", "20l", "1;5r", "?6l", "3g",
        ] {
            assert!(out.contains(&format!("\x1b[{mode}")), "{mode} in {out:?}");
        }
        assert!(out.contains("\x1b>") && out.contains("\x1b(B\x1b)B\x1b*B\x1b+B\x0f"));
    }
}
