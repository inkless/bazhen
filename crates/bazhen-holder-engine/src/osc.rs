//! Caps the bytes of an OSC string before the parsers see them.
//!
//! vte gathers an OSC string's bytes in a buffer with no limit until the string ends, and keeps
//! the buffer's capacity after, in the read-ahead and in alacritty alike; and alacritty keeps
//! titles, which OSC strings set, on a stack 4,096 deep. `ESC ]` and then bytes with no end
//! would grow both without bound. The engine passes the first `MOST_OSC_BYTES` of a string's
//! payload and drops the rest, so a longer title or link arrives cut short.
//!
//! An OSC string starts at `ESC ]` and ends at BEL, at CAN or SUB, or at the next ESC (the
//! start of ST, or of any other sequence), as vte reads it (`advance_osc_string`). Any ESC
//! starts a new sequence in vte, whatever came before, so that is all the state this needs. After
//! an ESC, vte executes a C0 control and ignores DEL and any byte past ASCII, still waiting for
//! the byte that says which sequence it is (`advance_esc`).

/// The most bytes of one OSC string's payload the parsers see: a title or a link longer than
/// this is cut short.
pub(crate) const MOST_OSC_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Other,
    Escape,
    Osc,
}

#[derive(Debug, Default)]
pub(crate) struct OscCap {
    state: State,
    /// Payload bytes of the current OSC string passed so far.
    passed: usize,
}

impl OscCap {
    /// How many bytes from the start of `bytes` to parse, and how many after those to drop.
    pub(crate) fn split(&mut self, bytes: &[u8]) -> (usize, usize) {
        let mut keep = 0;
        for &byte in bytes {
            if self.drops(byte) {
                break;
            }
            keep += 1;
        }
        let rest = bytes.get(keep..).unwrap_or_default();
        let drop = rest.iter().take_while(|&&byte| self.drops(byte)).count();
        (keep, drop)
    }

    /// Moves past `byte`, and says whether it goes over the cap.
    fn drops(&mut self, byte: u8) -> bool {
        // A C0 control, DEL or a byte past ASCII leaves vte still after an ESC.
        let still_after_esc = matches!(byte, 0x00..=0x17 | 0x19 | 0x1c..=0x1f | 0x7f..=0xff);
        match (self.state, byte) {
            (_, 0x1b) => self.state = State::Escape,
            (State::Escape, b']') => {
                self.state = State::Osc;
                self.passed = 0;
            }
            (State::Escape, _) if still_after_esc => {}
            (State::Osc, 0x07 | 0x18 | 0x1a) | (State::Escape, _) => self.state = State::Other,
            (State::Osc, _) if self.passed < MOST_OSC_BYTES => self.passed += 1,
            (State::Osc, _) => return true,
            (State::Other, _) => {}
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::vte::{Parser, Perform};
    use proptest::prelude::*;

    use super::*;

    /// vte's `MAX_OSC_PARAMS`.
    const MOST_OSC_PARAMS: usize = 16;

    /// What of `bytes`, fed in pieces of `piece`, the parsers see.
    fn passed(bytes: &[u8], piece: usize) -> Vec<u8> {
        let mut cap = OscCap::default();
        let mut out = Vec::new();
        for mut chunk in bytes.chunks(piece) {
            while !chunk.is_empty() {
                let (keep, drop) = cap.split(chunk);
                out.extend_from_slice(&chunk[..keep]);
                chunk = &chunk[keep + drop..];
            }
        }
        out
    }

    #[test]
    fn an_osc_string_past_the_cap_is_cut_and_still_ends() {
        let long = "x".repeat(MOST_OSC_BYTES + 500);
        let stream = format!("a\x1b]0;{long}\x07b");
        let payload: String = format!("0;{long}").chars().take(MOST_OSC_BYTES).collect();
        let expected = format!("a\x1b]{payload}\x07b");
        for piece in [1, 7, 4096] {
            assert_eq!(
                passed(stream.as_bytes(), piece),
                expected.as_bytes(),
                "{piece}"
            );
        }
    }

    #[test]
    fn every_ending_ends_the_string_and_the_next_starts_its_count_afresh() {
        let long = "y".repeat(MOST_OSC_BYTES);
        for end in ["\x07", "\x1b\\", "\x18", "\x1a"] {
            let stream = format!("\x1b]{long}{end}\x1b]{long}{end}");
            assert_eq!(passed(stream.as_bytes(), 100), stream.as_bytes(), "{end:?}");
        }
    }

    #[test]
    fn a_control_byte_after_esc_still_leaves_the_string_after_it_capped() {
        let long = "x".repeat(MOST_OSC_BYTES + 500);
        for between in ["\0", "\n", "\x1b", "\x7f", "\u{e9}"] {
            let stream = format!("\x1b{between}]0;{long}\x07");
            let passed = passed(stream.as_bytes(), 64);
            assert_eq!(passed.len(), stream.len() - 500 - 2, "{between:?}");
        }
    }

    #[test]
    fn a_string_of_many_params_is_cut_at_the_cap_too() {
        let params = "x;".repeat(MOST_OSC_BYTES);
        let stream = format!("\x1b]{params}\x07");
        assert_eq!(passed(stream.as_bytes(), 64).len(), MOST_OSC_BYTES + 3);
    }

    #[test]
    fn bytes_outside_an_osc_string_all_pass() {
        let stream = "]]] \x1b[31m]text\x1b(B]\x1b]short\x07".repeat(300);
        assert_eq!(passed(stream.as_bytes(), 13), stream.as_bytes());
    }

    /// The most payload bytes of any OSC string vte dispatched.
    #[derive(Default)]
    struct Longest(usize);

    impl Perform for Longest {
        fn osc_dispatch(&mut self, params: &[&[u8]], _: bool) {
            // vte keeps no `;`: the payload is the params and a `;` between each.
            let bytes =
                params.iter().map(|p| p.len()).sum::<usize>() + params.len().saturating_sub(1);
            self.0 = self.0.max(bytes);
        }
    }

    /// Bytes that move vte between its states, and runs long enough to pass the cap.
    fn piece() -> impl Strategy<Value = Vec<u8>> {
        prop_oneof![
            prop::sample::select(vec![
                0x1b_u8, b']', 0x07, 0x18, 0x1a, 0x00, b'\n', 0x7f, 0x9c, 0xc3, 0xe9, b'[', b'P',
                b'X', b'^', b'_', b'\\', b' ', b'(', b'0', b'a', b';',
            ])
            .prop_map(|byte| vec![byte]),
            (1usize..3 * MOST_OSC_BYTES).prop_map(|n| vec![b'x'; n]),
        ]
    }

    proptest! {
        #[test]
        fn vte_never_holds_more_of_an_osc_string_than_the_cap(
            pieces in prop::collection::vec(piece(), 1..60),
            cut in 1usize..200,
        ) {
            let mut stream: Vec<u8> = pieces.concat();
            // Past 16 params vte stops recording where they end, but still keeps their bytes,
            // which `Longest` would miss: no string here has more.
            let separators = pieces.iter().filter(|piece| piece.as_slice() == b";").count();
            prop_assume!(separators < MOST_OSC_PARAMS);
            // Ends whatever string is open, so vte dispatches what it held.
            stream.push(0x07);
            let mut parser = Parser::new();
            let mut longest = Longest::default();
            let mut cap = OscCap::default();
            for mut chunk in stream.chunks(cut) {
                while !chunk.is_empty() {
                    let (keep, drop) = cap.split(chunk);
                    parser.advance(&mut longest, &chunk[..keep]);
                    chunk = &chunk[keep + drop..];
                }
            }
            prop_assert!(longest.0 <= MOST_OSC_BYTES, "{}", longest.0);
        }
    }
}
