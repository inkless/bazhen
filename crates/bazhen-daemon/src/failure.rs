//! A failure's own text as a command answers with it, as `failureDetail` in
//! `apps/daemon/src/commands.ts` makes it: searched no further than [`SEARCHED_MAX`] UTF-16 units,
//! with the secrets a config line, an environment, a request or a Debug print echoes taken out,
//! and cut to [`DETAIL_MAX`] grapheme clusters, never through one.
//!
//! The patterns are TypeScript's, read as JavaScript reads them without the `u` flag: `i`, `\w`
//! and `\b` know ASCII alone, `\s` is JavaScript's white space, `.` stops at every line
//! terminator, and a repetition counts UTF-16 units. Each is matched over [`Units`], a copy of the
//! text with one byte for each UTF-16 unit, so a pattern counts what JavaScript counts.
//!
//! One difference is known: where a repetition's limit falls between the two halves of a
//! character outside the BMP, JavaScript keeps the second half after `[redacted]`, a lone
//! surrogate no Rust string can hold, and this takes the whole character out.
//! `packages/protocol/fixtures/details/` holds TypeScript's answers, and the tests hold this to
//! them.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex_automata::meta::Regex;
use regex_automata::util::captures::Captures;
use regex_automata::util::syntax;
use regex_automata::{Input, Span};
use unicode_segmentation::UnicodeSegmentation as _;

use crate::devices::whole;

/// The most of a failure's text an answer carries (`DETAIL_MAX` in `commands.ts`).
pub const DETAIL_MAX: usize = 500;

/// How much of a failure's text is searched: the rest is dropped first, which also bounds the
/// search's cost, since a name that turns out not to be a secret's has its value searched again.
const SEARCHED_MAX: usize = 16 * DETAIL_MAX;

/// The byte [`Units`] holds for U+2028 and U+2029, white space that also ends a line.
const LINE_END: u8 = 0x80;
/// The byte [`Units`] holds for every other character outside ASCII that `\s` matches.
const OTHER_SPACE: u8 = 0x81;
/// The byte [`Units`] holds for each UTF-16 unit of any other character outside ASCII: no class
/// the patterns name holds it, and every class they negate does.
const OTHER: u8 = 0x82;

/// JavaScript's `\s`, the inside of a class, as [`Units`] holds it.
const SPACE: &str = r"\t\n\x0B\x0C\r \x80\x81";

/// JavaScript's `\w` without `u`, the inside of a class.
const WORD: &str = "0-9A-Za-z_";

/// A failure's own message, as an `Error`'s `message` is, without its causes', made safe to answer
/// with.
pub(crate) fn detail(err: &dyn std::error::Error) -> String {
    failure_detail(&err.to_string())
}

/// `text` made safe to store and answer with: searched, redacted and cut, as `failureDetail` is.
pub fn failure_detail(text: &str) -> String {
    let Some(patterns) = PATTERNS.as_ref() else {
        return "[redacted]".to_owned();
    };
    cut(patterns.redacted(&searched(text)))
}

/// The first [`SEARCHED_MAX`] UTF-16 units, cut back to the last white space and ending `…`: a
/// secret cut in two could escape a pattern that needs its end, as a URL's password does its `@`.
fn searched(text: &str) -> Cow<'_, str> {
    if text.chars().map(char::len_utf16).sum::<usize>() <= SEARCHED_MAX {
        return Cow::Borrowed(text);
    }
    let head = whole(text, SEARCHED_MAX);
    let end = head.rfind([' ', '\n', '\t']).unwrap_or(0);
    Cow::Owned(format!("{}…", head.get(..end).unwrap_or_default()))
}

/// At most [`DETAIL_MAX`] grapheme clusters, the last of them `…` where it was cut.
fn cut(text: String) -> String {
    let mut clusters = text.grapheme_indices(true);
    let Some((kept, _)) = clusters.nth(DETAIL_MAX - 1) else {
        return text;
    };
    if clusters.next().is_none() {
        return text;
    }
    format!("{}…", text.get(..kept).unwrap_or_default())
}

/// JavaScript's `\s`: U+FEFF is in it, and U+0085 is not.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// A text as the patterns read it, one byte for each UTF-16 unit: ASCII as itself, lowercase where
/// the pattern ignores case, and anything else as [`LINE_END`], [`OTHER_SPACE`] or [`OTHER`].
/// Offsets into it map back to the text's.
struct Units<'a> {
    text: &'a str,
    hay: Vec<u8>,
    /// The text's offset for each of `hay`'s, and one past its end. The second unit of a
    /// character outside the BMP maps to the character's end, so a span that ends between its
    /// halves takes the whole character.
    at: Vec<usize>,
}

impl<'a> Units<'a> {
    fn new(text: &'a str, fold: bool) -> Self {
        let mut hay = Vec::with_capacity(text.len());
        let mut at = Vec::with_capacity(text.len() + 1);
        for (i, c) in text.char_indices() {
            let unit = match u8::try_from(c) {
                Ok(b) if b.is_ascii() => {
                    if fold {
                        b.to_ascii_lowercase()
                    } else {
                        b
                    }
                }
                _ if matches!(c, '\u{2028}' | '\u{2029}') => LINE_END,
                _ if js_space(c) => OTHER_SPACE,
                _ => OTHER,
            };
            hay.push(unit);
            at.push(i);
            if c.len_utf16() == 2 {
                hay.push(OTHER);
                at.push(i + c.len_utf8());
            }
        }
        at.push(text.len());
        Self { text, hay, at }
    }

    fn text_at(&self, offset: usize) -> usize {
        self.at.get(offset).copied().unwrap_or(self.text.len())
    }

    /// The text that `hay[from..to]` stands for.
    fn text(&self, from: usize, to: usize) -> &'a str {
        self.text
            .get(self.text_at(from)..self.text_at(to))
            .unwrap_or_default()
    }

    fn span(&self, span: Span) -> &'a str {
        self.text(span.start, span.end)
    }
}

/// `pattern`'s matches in `text`, each replaced by what `with` makes of it, or kept where it
/// makes nothing, as `String.prototype.replace` does with a global pattern.
fn replace(
    text: &str,
    pattern: &Regex,
    fold: bool,
    with: impl Fn(&Units<'_>, &Captures) -> Option<String>,
) -> String {
    let units = Units::new(text, fold);
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for caps in pattern.captures_iter(&units.hay) {
        let Some(found) = caps.get_match() else {
            continue;
        };
        if let Some(replaced) = with(&units, &caps) {
            out.push_str(units.text(copied, found.start()));
            out.push_str(&replaced);
            copied = found.end();
        }
    }
    out.push_str(units.text(copied, units.hay.len()));
    out
}

fn group(caps: &Captures, index: usize) -> Span {
    caps.get_group(index).unwrap_or(Span { start: 0, end: 0 })
}

/// A name a secret is kept under: `api_key`, `experimental_bearer_token`, `x-api-key`,
/// `password`, though not `max_tokens`.
fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let token = name
        .match_indices("token")
        .any(|(at, word)| name.as_bytes().get(at + word.len()) != Some(&b's'));
    token
        || name == "auth"
        || [
            "key",
            "secret",
            "passwd",
            "password",
            "credential",
            "bearer",
            "authorization",
            "authorisation",
            "cookie",
        ]
        .iter()
        .any(|word| name.contains(word))
}

/// Names that, before a colon and a plain word, are prose (`token: expired`), not a value.
const PROSE_NAMES: [&str; 3] = ["key", "token", "auth"];

/// A value that starts with a plain word: letters, then white space or the end.
fn plain_word(value: &str) -> bool {
    let rest = value.trim_start_matches(|c: char| c.is_ascii_alphabetic());
    rest.len() < value.len() && rest.chars().next().is_none_or(js_space)
}

/// Credentials looks encoded; prose after `basic` or `bearer` is lowercase letters.
fn encoded(value: &str) -> bool {
    value
        .bytes()
        .any(|b| b.is_ascii_digit() || b.is_ascii_uppercase() || b"+/=".contains(&b))
}

/// The patterns of `commands.ts`, each as a Rust regex that matches what it matches there.
struct Patterns {
    /// A private key's PEM block, cut short or whole.
    pem: Regex,
    /// A provider's extra headers, whose names are anyone's (`http_headers = { "X-Corp" = … }`).
    headers: Regex,
    /// A URL's user and password.
    userinfo: Regex,
    /// The shapes well-known keys take.
    shapes: Regex,
    /// An HTTP authorization scheme and its credentials, with or without a header name.
    scheme: Regex,
    /// `name = value` or `name: value`, as a TOML or env line, JSON, or Rust's Debug output
    /// shows it, with the name in groups 1 to 6, one for each quote it can be in, its operator in
    /// 8, and its value in 9.
    assignment: Regex,
}

static PATTERNS: LazyLock<Option<Patterns>> = LazyLock::new(|| Patterns::new().ok());

/// `pattern` over [`Units`]' bytes, where `.` and a negated class match one byte, so one unit.
fn units_regex(pattern: &str) -> Result<Regex, Box<regex_automata::meta::BuildError>> {
    Regex::builder()
        .syntax(syntax::Config::new().unicode(false).utf8(false))
        .build(pattern)
        .map_err(Box::new)
}

impl Patterns {
    fn new() -> Result<Self, Box<regex_automata::meta::BuildError>> {
        let s = SPACE;
        let w = WORD;
        let name = format!("([{w}.-]{{1,64}})");
        // JavaScript's `(\\?["']?)name\1`, a quote matched again, as the quotes a backtracker
        // tries in turn, so the first that matches is the one JavaScript takes.
        let quoted =
            format!(r#"(?:\\"{name}\\"|\\'{name}\\'|\\{name}\\|"{name}"|'{name}'|{name})"#);
        let dot = r"[^\n\r\x80]";
        Ok(Self {
            // TypeScript bounds the block's body at 16384 units, more than [`searched`] ever
            // leaves, so the bound is left out: it would cost megabytes and match nothing more.
            pem: units_regex(
                r"-----BEGIN [A-Z0-9 ]{1,64}-----(?:(?s:.)*?-----END [A-Z0-9 ]{1,64}-----|(?s:.)*)",
            )?,
            headers: units_regex(&format!(
                r#"((?:env_)?http_headers["']?[ \t]{{0,64}}[=:][{s}]{{0,64}}(?:some\([{s}]{{0,64}})?)\{{[^}}]{{0,4096}}\}}?"#
            ))?,
            userinfo: units_regex(&format!(r"([{w}]{{1,32}}://)[^/@{s}]{{1,256}}@"))?,
            shapes: units_regex(&format!(
                r"\b(?:sk-[{w}-]{{16,512}}|[sr]k_(?:live|test)_[{w}]{{16,512}}|gh[pousr]_[{w}]{{20,512}}|github_pat_[{w}]{{20,512}}|glpat-[{w}-]{{20,512}}|hf_[{w}]{{20,512}}|xox[abprs]-[{w}-]{{10,512}}|AKIA[0-9A-Z]{{16}}|AIza[{w}-]{{35}}|eyJ[{w}-]{{8,2048}}\.eyJ[{w}-]{{8,2048}}\.[{w}-]{{8,2048}})"
            ))?,
            scheme: units_regex(&format!(
                r"\b(bearer|basic)([{s}]{{1,8}})([{w}.~+/=-]{{8,2048}})"
            ))?,
            assignment: units_regex(&format!(
                r#"{quoted}([ \t]{{0,64}}([=:])[{s}]{{0,64}}(?:some\([{s}]{{0,64}})?)((?:(?:bearer|basic|digest|token)[{s}]{{1,8}})?(?:"""(?s:.){{0,4096}}?(?:"""|$)|\\"(?:[^"\\\n]|\\[^"]){{0,4096}}(?:\\")?|"(?:[^"\\\n]|\\{dot})*"?|'(?:[^'\\\n]|\\{dot})*'?|[^\n]{{1,512}}))"#
            ))?,
        })
    }

    fn redacted(&self, text: &str) -> String {
        let secret = |_: &Units<'_>, _: &Captures| Some("[redacted]".to_owned());
        let bare = replace(text, &self.pem, false, secret);
        let bare = replace(&bare, &self.headers, true, |units, caps| {
            Some(format!("{}{{[redacted]}}", units.span(group(caps, 1))))
        });
        let bare = replace(&bare, &self.userinfo, false, |units, caps| {
            Some(format!("{}[redacted]@", units.span(group(caps, 1))))
        });
        let bare = replace(&bare, &self.shapes, false, secret);
        let bare = replace(&bare, &self.scheme, true, |units, caps| {
            let value = group(caps, 3);
            encoded(units.span(value)).then(|| {
                let found = caps.get_match().map_or(value.start, |m| m.start());
                format!("{}[redacted]", units.text(found, value.start))
            })
        });
        self.assignments(&bare)
    }

    /// Each assignment to a secret's name with its value taken out. Where a name is no secret's,
    /// what looked like its value is searched again, as it may hold one: `error: api_key = …`.
    fn assignments(&self, text: &str) -> String {
        let units = Units::new(text, true);
        let mut caps = self.assignment.create_captures();
        let mut out = String::with_capacity(text.len());
        let mut copied = 0;
        let mut from = 0;
        loop {
            let input = Input::new(&units.hay).range(from..);
            self.assignment.search_captures(&input, &mut caps);
            let Some(found) = caps.get_match() else {
                break;
            };
            let name = (1..=6)
                .find_map(|i| caps.get_group(i))
                .map_or("", |span| units.span(span));
            let value = group(&caps, 9);
            let prose = units.span(group(&caps, 8)) == ":"
                && plain_word(units.span(value))
                && PROSE_NAMES.contains(&name.to_ascii_lowercase().as_str());
            if secret_name(name) && !prose {
                out.push_str(units.text(copied, value.start));
                out.push_str("[redacted]");
                copied = found.end();
                from = found.end();
            } else {
                from = value.start;
            }
        }
        out.push_str(units.text(copied, units.hay.len()));
        out
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        text: String,
        detail: String,
    }

    /// What TypeScript's `failureDetail` answered for each text, as `moon run :schema` records it.
    fn cases() -> Vec<Case> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/protocol/fixtures/details/cases.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn builds_every_pattern() {
        Patterns::new().map(|_| ()).unwrap();
    }

    #[test]
    fn answers_each_recorded_failure_as_typescript_does_secrets_taken_out_and_cut() {
        let cases = cases();
        assert!(cases.len() >= 90, "too few cases: {}", cases.len());
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let got = failure_detail(&case.text);
                (got != case.detail).then(|| {
                    let brief = |text: &str| format!("{:?}", whole(text, 120));
                    let (text, want) = (brief(&case.text), brief(&case.detail));
                    format!("{text}\n  got  {}\n  want {want}", brief(&got))
                })
            })
            .collect();
        assert!(
            wrong.is_empty(),
            "{} of {} wrong:\n{}",
            wrong.len(),
            cases.len(),
            wrong.join("\n")
        );
    }

    #[derive(Debug, thiserror::Error)]
    #[error("{0}")]
    struct Failed(String, #[source] std::io::Error);

    #[test]
    fn answers_a_failure_by_its_own_message_not_its_causes() {
        let cause = std::io::Error::other("the cause, api_key = s3cr3t");
        assert_eq!(
            detail(&Failed("tmux gone; api_key = s3cr3t".to_owned(), cause)),
            "tmux gone; api_key = [redacted]"
        );
    }

    /// `failure_detail(text)`, or `None` when it takes longer than any text of this size should.
    fn within_a_bound(text: String) -> Option<String> {
        let (sent, answer) = mpsc::channel();
        std::thread::spawn(move || sent.send(failure_detail(&text)));
        answer.recv_timeout(Duration::from_secs(10)).ok()
    }

    #[test]
    fn reads_a_run_of_what_could_start_a_name_in_bounded_time() {
        assert!(within_a_bound("key".repeat(2_600)).is_some());
    }

    #[test]
    fn reads_a_megabyte_of_what_could_start_a_key_in_bounded_time() {
        assert!(within_a_bound("eyJ-".repeat(250_000)).is_some());
    }

    #[test]
    fn reads_a_megabyte_of_names_that_are_no_secrets_in_bounded_time() {
        assert!(within_a_bound("a:".repeat(500_000)).is_some());
    }
}
