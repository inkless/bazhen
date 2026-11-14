use std::cell::RefCell;
use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::rc::Rc;

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, Rgb};

use crate::pty::Size;
use crate::snapshot;

#[derive(Debug, Default)]
struct Shared {
    replies: Vec<u8>,
    title: Option<String>,
    size: Option<Size>,
}

#[derive(Clone)]
struct Listener(Rc<RefCell<Shared>>);

impl fmt::Debug for Listener {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Listener")
    }
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let mut shared = self.0.borrow_mut();
        match event {
            Event::PtyWrite(text) => shared.replies.extend_from_slice(text.as_bytes()),
            Event::ColorRequest(index, format) => {
                let reply = format(default_color(index));
                shared.replies.extend_from_slice(reply.as_bytes());
            }
            Event::TextAreaSizeRequest(format) => {
                let size = shared.size.unwrap_or(Size { cols: 80, rows: 24 });
                let reply = format(WindowSize {
                    num_lines: size.rows,
                    num_cols: size.cols,
                    cell_width: 8,
                    cell_height: 16,
                });
                shared.replies.extend_from_slice(reply.as_bytes());
            }
            Event::Title(title) => shared.title = Some(title),
            Event::ResetTitle => shared.title = None,
            _ => {}
        }
    }
}

/// xterm.js's defaults, which is what a viewer shows until a theme is set.
fn default_color(index: usize) -> Rgb {
    const ANSI: [(u8, u8, u8); 16] = [
        (0x00, 0x00, 0x00),
        (0xcd, 0x31, 0x31),
        (0x0d, 0xbc, 0x79),
        (0xe5, 0xe5, 0x10),
        (0x24, 0x72, 0xc8),
        (0xbc, 0x3f, 0xbc),
        (0x11, 0xa8, 0xcd),
        (0xe5, 0xe5, 0xe5),
        (0x66, 0x66, 0x66),
        (0xf1, 0x4c, 0x4c),
        (0x23, 0xd1, 0x8b),
        (0xf5, 0xf5, 0x43),
        (0x3b, 0x8e, 0xea),
        (0xd6, 0x70, 0xd6),
        (0x29, 0xb8, 0xdb),
        (0xe5, 0xe5, 0xe5),
    ];
    let level = |v: usize| {
        if v == 0 {
            0
        } else {
            u8::try_from(55 + v * 40).unwrap_or(255)
        }
    };
    let (r, g, b) = match index {
        0..16 => ANSI.get(index).copied().unwrap_or_default(),
        16..232 => {
            let i = index - 16;
            (level(i / 36), level(i / 6 % 6), level(i % 6))
        }
        232..256 => {
            let v = u8::try_from(8 + (index - 232) * 10).unwrap_or(255);
            (v, v, v)
        }
        256 => (0xff, 0xff, 0xff),
        _ => (0x00, 0x00, 0x00),
    };
    Rgb { r, g, b }
}

/// Recognises XTVERSION (`CSI > q`, `CSI > 0 q`), which `alacritty_terminal` does not answer,
/// across read boundaries.
#[derive(Debug, Default)]
struct XtVersion {
    state: u8,
}

impl XtVersion {
    const REPLY: &'static [u8] = b"\x1bP>|bz-holder(spike)\x1b\\";

    fn scan(&mut self, bytes: &[u8]) -> usize {
        let mut hits = 0;
        for &b in bytes {
            self.state = match (self.state, b) {
                (_, 0x1b) => 1,
                (1, b'[') => 2,
                (2, b'>') => 3,
                (3, b'0') => 4,
                (3 | 4, b'q') => {
                    hits += 1;
                    0
                }
                _ => 0,
            };
        }
        hits
    }
}

pub(crate) struct Engine {
    term: Term<Listener>,
    parser: Processor,
    shared: Rc<RefCell<Shared>>,
    size: Size,
    history: usize,
    xtversion: XtVersion,
    resets: u64,
}

impl fmt::Debug for Engine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Engine")
            .field("size", &self.size)
            .field("resets", &self.resets)
            .finish_non_exhaustive()
    }
}

impl Engine {
    pub(crate) fn new(size: Size, history: usize) -> Self {
        let shared = Rc::new(RefCell::new(Shared {
            size: Some(size),
            ..Shared::default()
        }));
        Self {
            term: new_term(size, history, &shared),
            parser: Processor::new(),
            shared,
            size,
            history,
            xtversion: XtVersion::default(),
            resets: 0,
        }
    }

    /// Parses `bytes`. A panic in the engine resets it: the screen is lost, the holder lives.
    pub(crate) fn advance(&mut self, bytes: &[u8]) -> bool {
        let term = &mut self.term;
        let parser = &mut self.parser;
        let parsed = catch_unwind(AssertUnwindSafe(|| {
            parser.advance(term, bytes);
            // A headless engine has no frame to hold back, and buffering a synchronized update
            // would delay query replies and put the screen behind the ring's offset.
            if parser.sync_bytes_count() > 0 {
                parser.stop_sync(term);
            }
        }));
        for _ in 0..self.xtversion.scan(bytes) {
            self.shared
                .borrow_mut()
                .replies
                .extend_from_slice(XtVersion::REPLY);
        }
        if parsed.is_err() {
            self.resets += 1;
            self.term = new_term(self.size, self.history, &self.shared);
            self.parser = Processor::new();
            return false;
        }
        true
    }

    pub(crate) fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.shared.borrow_mut().replies)
    }

    pub(crate) fn resize(&mut self, size: Size) {
        self.size = size;
        self.shared.borrow_mut().size = Some(size);
        self.term
            .resize(TermSize::new(size.cols.into(), size.rows.into()));
    }

    pub(crate) fn snapshot(&mut self) -> Vec<u8> {
        snapshot::serialize(&mut self.term)
    }

    pub(crate) fn title(&self) -> Option<String> {
        self.shared.borrow().title.clone()
    }

    pub(crate) fn alternate(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    pub(crate) fn history_lines(&self) -> usize {
        self.term.grid().history_size()
    }

    /// What the engine's grids hold, as rows × columns × cell size. alacritty stores every row
    /// at full width, so this is close to what it allocates.
    pub(crate) fn engine_bytes(&self) -> usize {
        let grid = self.term.grid();
        grid.total_lines() * grid.columns() * size_of::<Cell>()
    }

    pub(crate) fn resets(&self) -> u64 {
        self.resets
    }
}

fn new_term(size: Size, history: usize, shared: &Rc<RefCell<Shared>>) -> Term<Listener> {
    let config = Config {
        scrolling_history: history,
        ..Config::default()
    };
    Term::new(
        config,
        &TermSize::new(size.cols.into(), size.rows.into()),
        Listener(Rc::clone(shared)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpr_is_answered_with_the_cursor_position_where_the_query_was_written() {
        let mut engine = Engine::new(Size { cols: 20, rows: 5 }, 100);
        engine.advance(b"ab\r\ncd\x1b[6n");
        assert_eq!(engine.take_replies(), b"\x1b[2;3R");
    }

    #[test]
    fn xtversion_split_across_reads_is_answered_once() {
        let mut engine = Engine::new(Size { cols: 20, rows: 5 }, 100);
        engine.advance(b"\x1b[");
        engine.advance(b">0q");
        assert_eq!(engine.take_replies(), XtVersion::REPLY);
    }

    #[test]
    fn a_query_inside_a_synchronized_update_is_answered_at_once() {
        let mut engine = Engine::new(Size { cols: 20, rows: 5 }, 100);
        engine.advance(b"\x1b[?2026hxy\x1b[6n");
        assert_eq!(engine.take_replies(), b"\x1b[1;3R");
    }
}
