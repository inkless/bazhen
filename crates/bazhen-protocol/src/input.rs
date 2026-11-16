//! What a view's input holds, as `packages/protocol/src/input.ts` reads it: the terminal's replies
//! to queries and its focus and mouse reports are not keystrokes, and only keystrokes ask for the
//! lease. The patterns are the TypeScript's, matched here by hand; `checks.json` holds the two to
//! the same verdicts.

const ESC: u8 = 0x1b;
const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// Whether `input` holds anything a person typed or pasted: anything beyond the terminal's
/// replies, outside a paste, and its focus and mouse reports.
#[must_use]
pub fn has_keystrokes(input: &[u8]) -> bool {
    !strip(&without_replies(input), event_report).is_empty()
}

/// `input` without the terminal's replies to queries; a paste is kept whole, to its end or to the
/// end of the input.
fn without_replies(input: &[u8]) -> Vec<u8> {
    let mut kept = Vec::with_capacity(input.len());
    let mut rest = input;
    loop {
        let Some(at) = find(rest, PASTE_START) else {
            kept.extend(strip(rest, reply));
            return kept;
        };
        let (before, paste) = rest.split_at(at);
        kept.extend(strip(before, reply));
        let body = paste.get(PASTE_START.len()..).unwrap_or_default();
        let end =
            find(body, PASTE_END).map_or(paste.len(), |e| PASTE_START.len() + e + PASTE_END.len());
        let (whole, after) = paste.split_at(end.min(paste.len()));
        kept.extend_from_slice(whole);
        rest = after;
    }
}

/// `text` with every non-overlapping match of `matches`, from the left, taken out.
fn strip(text: &[u8], matches: fn(&[u8]) -> Option<usize>) -> Vec<u8> {
    let mut kept = Vec::with_capacity(text.len());
    let mut at = 0;
    while let Some(rest) = text.get(at..).filter(|r| !r.is_empty()) {
        match matches(rest) {
            Some(n) if n > 0 => at += n,
            _ => {
                kept.extend(rest.first());
                at += 1;
            }
        }
    }
    kept
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// A position in bytes being matched.
#[derive(Debug, Clone, Copy)]
struct At<'a> {
    text: &'a [u8],
    at: usize,
}

impl At<'_> {
    fn peek(self) -> Option<u8> {
        self.text.get(self.at).copied()
    }

    /// Past `byte`, if it is next.
    fn byte(self, byte: u8) -> Option<Self> {
        (self.peek()? == byte).then_some(Self {
            at: self.at + 1,
            ..self
        })
    }

    /// Past the next byte, if it is one of `bytes`.
    fn one_of(self, bytes: &[u8]) -> Option<Self> {
        bytes.contains(&self.peek()?).then_some(Self {
            at: self.at + 1,
            ..self
        })
    }

    /// Past as many bytes as `keep` takes, none or more.
    fn many(mut self, keep: fn(u8) -> bool) -> Self {
        while self.peek().is_some_and(keep) {
            self.at += 1;
        }
        self
    }

    /// Past one digit or more.
    fn digits(self) -> Option<Self> {
        let past = self.many(|b| b.is_ascii_digit());
        (past.at > self.at).then_some(past)
    }

    /// Past `n` bytes of any kind.
    fn any(self, n: usize) -> Option<Self> {
        (self.at + n <= self.text.len()).then_some(Self {
            at: self.at + n,
            ..self
        })
    }
}

/// The length of the focus or mouse report `text` starts with: `CSI I`, `CSI O`, and mouse
/// reports in the SGR, urxvt and X10 encodings.
fn event_report(text: &[u8]) -> Option<usize> {
    let csi = At { text, at: 0 }.byte(ESC)?.byte(b'[')?;
    let report = csi
        .one_of(b"IO")
        .or_else(|| {
            let a = csi.byte(b'<')?.digits()?.byte(b';')?.digits()?.byte(b';')?;
            a.digits()?.one_of(b"Mm")
        })
        .or_else(|| {
            let a = csi.digits()?.byte(b';')?.digits()?.byte(b';')?.digits()?;
            a.byte(b'M')
        })
        .or_else(|| csi.byte(b'M')?.any(3))?;
    Some(report.at)
}

/// The length of the reply to a query that `text` starts with: device attributes, a status
/// report, mode and setting reports, window reports, colours and XTVERSION. A plain cursor
/// position report is no reply here: Shift+F3 sends one.
fn reply(text: &[u8]) -> Option<usize> {
    let esc = At { text, at: 0 }.byte(ESC)?;
    let csi_reply = || {
        let csi = esc.byte(b'[')?;
        csi.one_of(b"?>")
            .map(|a| a.many(|b| b.is_ascii_digit() || b == b';'))
            .and_then(|a| a.byte(b'c'))
            .or_else(|| csi.byte(b'0')?.byte(b'n'))
            .or_else(|| {
                let a = csi.byte(b'?')?.digits()?.byte(b';')?.digits()?;
                a.byte(b'R')
            })
            .or_else(|| {
                let a = csi.byte(b'?').unwrap_or(csi);
                a.digits()?.byte(b';')?.digits()?.byte(b'$')?.byte(b'y')
            })
            .or_else(|| {
                let mut a = csi.digits()?;
                while let Some(next) = a.byte(b';').and_then(At::digits) {
                    a = next;
                }
                a.byte(b't')
            })
    };
    let dcs_reply = || {
        let a = esc.byte(b'P')?.many(|b| b != ESC);
        a.byte(ESC)?.byte(b'\\')
    };
    let osc_reply = || {
        let osc = esc.byte(b']')?;
        let colour = osc
            .byte(b'4')
            .and_then(|a| a.byte(b';')?.digits())
            .or_else(|| osc.byte(b'1')?.one_of(b"012"))?;
        let a = colour
            .byte(b';')?
            .byte(b'r')?
            .byte(b'g')?
            .byte(b'b')?
            .byte(b':')?;
        let a = a.many(|b| b.is_ascii_hexdigit() || b == b'/');
        a.byte(0x07).or_else(|| a.byte(ESC)?.byte(b'\\'))
    };
    let end = csi_reply().or_else(dcs_reply).or_else(osc_reply)?;
    Some(end.at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_typing_for_keystrokes_and_reports_and_replies_for_none() {
        let cases: [(&[u8], bool); 8] = [
            (b"ls\r", true),
            (b"\x1b[A", true),
            (b"\x1b[I\x1b[O", false),
            (b"\x1b[<35;10;5M", false),
            (b"\x1b[?62;22c", false),
            (b"\x1b[?62;22c\x1b[Ix", true),
            (b"\x1b[200~\x1b[?62;22c\x1b[201~", true),
            (b"", false),
        ];
        for (input, keystrokes) in cases {
            assert_eq!(has_keystrokes(input), keystrokes, "{input:?}");
        }
    }
}
