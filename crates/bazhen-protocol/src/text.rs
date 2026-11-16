//! Text the protocol checks before it takes it: a task note's, and how a note is quoted.

/// The most UTF-8 bytes a task note has.
pub const TASK_NOTE_MAX_BYTES: usize = 4000;

/// A rule a note's text breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteRule {
    Empty,
    TooLong,
    Unsafe,
}

impl NoteRule {
    /// The rule as the protocol words it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "Too small: expected string to have >=1 characters",
            Self::TooLong => "a note is at most 4000 UTF-8 bytes",
            Self::Unsafe => {
                "a note can't hold control characters but newline and tab, or invisible characters"
            }
        }
    }
}

/// The rules a note's text breaks, in the order the protocol checks them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteRefused(pub Vec<NoteRule>);

impl std::fmt::Display for NoteRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let rules: Vec<&str> = self.0.iter().map(|r| r.as_str()).collect();
        f.write_str(&rules.join("; "))
    }
}

impl std::error::Error for NoteRefused {}

/// A note's text as the protocol takes it: trimmed, then held to its limit and its characters.
///
/// # Errors
///
/// `NoteRefused`, with each rule the text breaks.
pub fn task_note_text(text: &str) -> Result<String, NoteRefused> {
    let text = trim(text);
    let broken: Vec<NoteRule> = [
        (text.is_empty(), NoteRule::Empty),
        (text.len() > TASK_NOTE_MAX_BYTES, NoteRule::TooLong),
        (!note_safe(text), NoteRule::Unsafe),
    ]
    .into_iter()
    .filter_map(|(broken, rule)| broken.then_some(rule))
    .collect();
    if broken.is_empty() {
        Ok(text.to_owned())
    } else {
        Err(NoteRefused(broken))
    }
}

/// `text` without the white space JavaScript's `trim` takes off each end, which isn't quite
/// Unicode's: it takes the byte-order mark, and leaves U+0085.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// No control character but newline and tab, no bidirectional override, nothing that draws as
/// nothing, and no tag character.
fn note_safe(text: &str) -> bool {
    !text
        .chars()
        .any(|c| (unshowable(c) && c != '\n' && c != '\t') || invisible(c) || tag(c))
}

/// C0 and C1 control characters, and the bidirectional embeddings, overrides and isolates.
fn unshowable(c: char) -> bool {
    matches!(
        c,
        '\0'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
    )
}

/// Zero-width spaces and joiners, the directional marks, the word joiner and invisible operators,
/// the byte-order mark, and the line and paragraph separators.
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{61c}'
            | '\u{200b}'..='\u{200f}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{2060}'..='\u{2064}'
            | '\u{feff}'
    )
}

/// The tag characters, which draw as nothing anywhere but a model reads as text.
fn tag(c: char) -> bool {
    matches!(c, '\u{e0000}'..='\u{e007f}')
}

/// A note as it is shown under who wrote it: each line led by `> `, an empty one by `>`.
pub fn quote_note(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            if line.is_empty() {
                ">".to_owned()
            } else {
                format!("> {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Whether `origin` is plain HTTP to a host other than this one, which anyone on the network can
/// read. It takes an origin as the daemon's config holds one, canonical: a lowercase scheme, then
/// the host and any port, and nothing more. It reads only that much, where a URL parser would
/// read anything.
pub fn is_plain_remote(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().map(|h| format!("[{h}]")),
        None => authority.split(':').next().map(str::to_owned),
    };
    let host = host.unwrap_or_default().to_ascii_lowercase();
    !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]")
}
