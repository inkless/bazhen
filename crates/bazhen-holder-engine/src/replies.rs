//! What the terminal writes back to the program: alacritty's answers to its queries, and the
//! engine's own to those alacritty leaves to a window it doesn't have.
//!
//! Every answer is fixed text or numbers, never text a program chose, so no query can make the
//! terminal type for it. They wait, up to [`MOST_REPLY_BYTES`], until the holder takes them.

use std::cell::RefCell;
use std::rc::Rc;

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::vte::ansi::NamedColor;

/// The most bytes of replies kept untaken: a program that floods queries without reading their
/// answers gets no more.
pub const MOST_REPLY_BYTES: usize = 64 << 10;

/// XTVERSION's answer, as the daemon has given it: the name alone.
pub(crate) const VERSION: &str = "\x1bP>|bazhen\x1b\\";

/// Whether `replies` is whole replies, as the engine writes them: each starts with ESC and is a
/// CSI up to its final byte, or an OSC or DCS up to BEL or ST, with no ESC inside but ST's.
pub fn replies_are_whole(replies: &[u8]) -> bool {
    let mut rest = replies;
    while !rest.is_empty() {
        let end = match rest {
            [0x1b, b'[', body @ ..] => body
                .iter()
                .position(|b| (0x40..=0x7e).contains(b))
                .map(|at| at + 3),
            [0x1b, b']' | b'P', body @ ..] => {
                match body.iter().position(|&b| b == 0x07 || b == 0x1b) {
                    Some(at) if body.get(at) == Some(&0x07) => Some(at + 3),
                    Some(at) if body.get(at + 1) == Some(&b'\\') => Some(at + 4),
                    _ => None,
                }
            }
            _ => None,
        };
        let Some(after) = end.and_then(|end| rest.get(end..)) else {
            return false;
        };
        rest = after;
    }
    true
}

/// A colour, as the program is told it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// The text and background a program is told it is drawn in, when it asks and hasn't set them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Colours {
    pub text: Rgb,
    pub background: Rgb,
}

#[derive(Debug, Default)]
struct Replies {
    text: String,
    dropped: u64,
    /// A reply was dropped since the last take: every one after it is too, so the program never
    /// sees a later answer without the earlier one, as DA1 without the XTVERSION it follows.
    dropping: bool,
    colours: Option<Colours>,
}

/// Collects the replies: alacritty's through its events, the engine's through [`Sink::push`].
#[derive(Debug, Clone, Default)]
pub(crate) struct Sink(Rc<RefCell<Replies>>);

impl Sink {
    /// Keeps `reply` whole, or drops it whole if it would take the untaken replies past the cap,
    /// and then every reply after it until the next take.
    pub(crate) fn push(&self, reply: &str) {
        let mut replies = self.0.borrow_mut();
        replies.dropping |= replies.text.len() + reply.len() > MOST_REPLY_BYTES;
        if replies.dropping {
            replies.dropped += 1;
        } else {
            replies.text.push_str(reply);
        }
    }

    pub(crate) fn take(&self) -> Vec<u8> {
        let mut replies = self.0.borrow_mut();
        replies.dropping = false;
        std::mem::take(&mut replies.text).into_bytes()
    }

    pub(crate) fn dropped(&self) -> u64 {
        self.0.borrow().dropped
    }

    pub(crate) fn set_colours(&self, colours: Option<Colours>) {
        self.0.borrow_mut().colours = colours;
    }

    /// Answers a colour query for `index`, alacritty's colour table index, in the form alacritty
    /// writes: the program's own colour if it set one, else the text or background given. A
    /// palette entry or the cursor colour no one set goes unanswered, as no colours are known.
    pub(crate) fn answer_colour(
        &self,
        set: Option<alacritty_terminal::vte::ansi::Rgb>,
        prefix: &str,
        index: usize,
        terminator: &str,
    ) {
        let given = self.0.borrow().colours.and_then(|colours| {
            if index == NamedColor::Foreground as usize {
                Some(colours.text)
            } else if index == NamedColor::Background as usize {
                Some(colours.background)
            } else {
                None
            }
        });
        let Some(Rgb { r, g, b }) = set
            .map(|c| Rgb {
                r: c.r,
                g: c.g,
                b: c.b,
            })
            .or(given)
        else {
            return;
        };
        self.push(&format!(
            "\x1b]{prefix};rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}{terminator}"
        ));
    }
}

impl EventListener for Sink {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(reply) => self.push(&reply),
            // A window's size in pixels isn't known here, which tmux's client accepts as zero
            // and waits for: it holds a lone Esc until it's told.
            Event::TextAreaSizeRequest(format) => self.push(&format(WindowSize {
                num_lines: 0,
                num_cols: 0,
                cell_width: 0,
                cell_height: 0,
            })),
            #[cfg(test)]
            Event::Title(title) => crate::tests::TITLE.with_borrow_mut(|last| *last = title),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Engine, HistoryRows, Size};

    const DARK: Colours = Colours {
        text: Rgb {
            r: 0xea,
            g: 0xeb,
            b: 0xee,
        },
        background: Rgb {
            r: 0x0f,
            g: 0x0f,
            b: 0x10,
        },
    };

    fn engine() -> Engine {
        Engine::new(Size { cols: 20, rows: 5 }, HistoryRows(100))
    }

    fn replies(engine: &mut Engine, reads: &[&str]) -> String {
        for read in reads {
            engine.advance(read.as_bytes());
        }
        String::from_utf8(engine.take_replies()).unwrap()
    }

    #[test]
    fn the_text_and_background_asked_for_are_the_colours_given_with_the_query_s_terminator() {
        let mut engine = engine();
        engine.set_colours(Some(DARK));
        assert_eq!(
            replies(&mut engine, &["\x1b]11;?\x07"]),
            "\x1b]11;rgb:0f0f/0f0f/1010\x07"
        );
        assert_eq!(
            replies(&mut engine, &["\x1b]10;?;?\x1b\\"]),
            "\x1b]10;rgb:eaea/ebeb/eeee\x1b\\\x1b]11;rgb:0f0f/0f0f/1010\x1b\\"
        );
    }

    #[test]
    fn a_colour_the_program_set_is_answered_over_the_colours_given() {
        let mut engine = engine();
        engine.set_colours(Some(DARK));
        let set = "\x1b]11;#ff0001\x07\x1b]4;1;#010203\x07\x1b]12;#a0b0c0\x07";
        assert_eq!(
            replies(
                &mut engine,
                &[set, "\x1b]11;?\x07\x1b]4;1;?\x07\x1b]12;?\x07"]
            ),
            "\x1b]11;rgb:ffff/0000/0101\x07\x1b]4;1;rgb:0101/0202/0303\x07\x1b]12;rgb:a0a0/b0b0/c0c0\x07"
        );
    }

    #[test]
    fn a_colour_neither_given_nor_set_goes_unanswered() {
        let mut engine = engine();
        assert_eq!(replies(&mut engine, &["\x1b]10;?\x07\x1b]11;?\x07"]), "");
        engine.set_colours(Some(DARK));
        assert_eq!(replies(&mut engine, &["\x1b]4;1;?\x07\x1b]12;?\x07"]), "");
        engine.set_colours(None);
        assert_eq!(replies(&mut engine, &["\x1b]11;?\x07"]), "");
    }

    #[test]
    fn xtversion_is_answered_in_its_place_among_the_queries_around_it() {
        let expected = format!("\x1b[1;1R{VERSION}\x1b[?6c");
        let mut engine = engine();
        assert_eq!(replies(&mut engine, &["\x1b[6n\x1b[>q\x1b[c"]), expected);
        assert_eq!(
            replies(&mut engine, &["\x1b[6n\x1b[>", "0q\x1b[c"]),
            expected
        );
        assert_eq!(replies(&mut engine, &["\x1b[>1q\x1b[?>q"]), "");
    }

    #[test]
    fn the_text_area_in_pixels_is_answered_as_zero() {
        assert_eq!(replies(&mut engine(), &["\x1b[14t"]), "\x1b[4;0;0t");
    }

    #[test]
    fn a_reply_that_fills_the_cap_exactly_is_kept_and_one_byte_more_is_not() {
        let sink = Sink::default();
        sink.push(&"x".repeat(MOST_REPLY_BYTES - 2));
        sink.push("ab");
        assert_eq!((sink.take().len(), sink.dropped()), (MOST_REPLY_BYTES, 0));
        sink.push(&"x".repeat(MOST_REPLY_BYTES - 1));
        sink.push("ab");
        assert_eq!(
            (sink.take().len(), sink.dropped()),
            (MOST_REPLY_BYTES - 1, 1)
        );
    }

    #[test]
    fn once_a_reply_is_dropped_every_reply_after_it_is_until_the_next_take() {
        let mut engine = engine();
        // Room for DA1's 5 bytes, but not XTVERSION's 12, which comes first.
        let cpr = "\x1b[1;1R";
        let fill = (MOST_REPLY_BYTES - 10) / cpr.len();
        engine.advance("\x1b[6n".repeat(fill).as_bytes());
        let untaken = fill * cpr.len();
        assert!(MOST_REPLY_BYTES - untaken >= 5 && MOST_REPLY_BYTES - untaken < VERSION.len());
        engine.advance(b"\x1b[>q\x1b[c");
        let taken = String::from_utf8(engine.take_replies()).unwrap();
        assert_eq!(taken, cpr.repeat(fill));
        assert_eq!(engine.stats().dropped_replies, 2);
        assert_eq!(replies(&mut engine, &["\x1b[c"]), "\x1b[?6c");
    }

    #[test]
    fn past_the_cap_untaken_replies_are_dropped_whole_and_counted() {
        let mut engine = engine();
        let cpr = "\x1b[1;1R";
        let fit = MOST_REPLY_BYTES / cpr.len();
        engine.advance("\x1b[6n".repeat(fit + 100).as_bytes());
        assert_eq!(engine.stats().dropped_replies, 100);
        let taken = String::from_utf8(engine.take_replies()).unwrap();
        assert_eq!(taken, cpr.repeat(fit));
        assert_eq!(replies(&mut engine, &["\x1b[6n"]), cpr);
    }

    #[test]
    fn replies_are_whole_only_when_every_sequence_ends_before_the_next_starts() {
        let whole = [
            "",
            "\x1b[1;1R\x1b[?6c",
            "\x1b]11;rgb:0f0f/0f0f/1010\x07",
            VERSION,
        ];
        for replies in whole {
            assert!(replies_are_whole(replies.as_bytes()), "{replies:?}");
        }
        let cut = [
            "\x1b[1;1",
            "\x1b]11;rgb:ff",
            // An OSC cut short, then a whole DCS: the DCS's ST must not end the OSC.
            "\x1b]11;rgb:ff\x1bP>|bazhen\x1b\\",
            "\x1b]11;rgb:ff\x1b[c\x07",
            "x\x1b[c",
        ];
        for replies in cut {
            assert!(!replies_are_whole(replies.as_bytes()), "{replies:?}");
        }
    }

    #[test]
    fn no_query_is_answered_with_text_the_program_wrote() {
        let mut engine = engine();
        let asks = [
            "\x1b]2;ls\r\x07\x1b[21t",
            "\x1b]52;c;bHMK\x07\x1b]52;c;?\x07",
            "\x1bP$qm\x1b\\",
            "\x1b[?u\x1b[?4m",
        ];
        assert_eq!(replies(&mut engine, &asks), "");
    }
}
