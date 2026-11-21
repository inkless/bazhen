//! Text the protocol checks before it takes it: a task note's, a new task's title, and how a note
//! is quoted.

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

/// The most UTF-16 units a task's title has, and its brief.
pub const TASK_TITLE_MAX_UNITS: usize = 200;
pub const TASK_BRIEF_MAX_UNITS: usize = 20_000;

/// A title a request gives a task, trimmed, if it is 1 to 200 UTF-16 units and holds nothing that
/// could end or disguise the line of mail it goes on: no control character, bidirectional
/// override, invisible or tag character.
pub fn new_task_title(text: &str) -> Option<&str> {
    let text = trim(text);
    let units = text.encode_utf16().count();
    ((1..=TASK_TITLE_MAX_UNITS).contains(&units)
        && !text
            .chars()
            .any(|c| unshowable(c) || invisible(c) || tag(c)))
    .then_some(text)
}

/// `text` without the white space JavaScript's `trim` takes off each end, which isn't quite
/// Unicode's: it takes the byte-order mark, and leaves U+0085.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// Whether JavaScript takes `c` for white space, in `trim` and in a regex's `\s`: Unicode's
/// white space with the byte-order mark and without U+0085.
#[must_use]
pub fn is_js_space(c: char) -> bool {
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

/// Whether `value` is a web origin exactly as a browser sends one: `http` or `https`, then the
/// host and any port, and nothing more, each as a URL parser writes it back. So no path, query,
/// fragment or user, no default port, and no host a parser would spell another way: uppercase,
/// not ASCII, percent-encoded, an IPv4 address in any form but dotted decimal, or an IPv6 address
/// in any form but its shortest.
pub fn is_origin(value: &str) -> bool {
    let (rest, default_port) = if let Some(rest) = value.strip_prefix("https://") {
        (rest, "443")
    } else if let Some(rest) = value.strip_prefix("http://") {
        (rest, "80")
    } else {
        return false;
    };
    let (host_ok, port) = if let Some(v6) = rest.strip_prefix('[') {
        let Some((address, after)) = v6.split_once(']') else {
            return false;
        };
        let port = match after.strip_prefix(':') {
            Some(port) => Some(port),
            None if after.is_empty() => None,
            None => return false,
        };
        (is_shortest_ipv6(address), port)
    } else {
        match rest.split_once(':') {
            Some((host, port)) => (is_canonical_host(host), Some(port)),
            None => (is_canonical_host(rest), None),
        }
    };
    host_ok && port.is_none_or(|port| is_canonical_port(port, default_port))
}

/// A port as a URL writes it: digits with no leading zero, at most 65535, and not the scheme's
/// own, which a URL leaves out.
fn is_canonical_port(port: &str, default_port: &str) -> bool {
    port.bytes().all(|b| b.is_ascii_digit())
        && (port == "0" || !port.starts_with('0'))
        && port.parse::<u16>().is_ok()
        && port != default_port
}

/// A host outside brackets as a URL parser leaves it: a domain it neither lowercases nor
/// encodes, or an IPv4 address in dotted decimal. A host whose last label reads as a number is
/// taken for an address, which then has to be one.
fn is_canonical_host(host: &str) -> bool {
    // ASCII a domain keeps as it is: a parser lowercases uppercase, and refuses the rest.
    let kept = |b: u8| {
        b.is_ascii_lowercase() || b.is_ascii_digit() || b"!\"$&'()*+,-.;=_`{}~".contains(&b)
    };
    if host.is_empty() || !host.bytes().all(kept) {
        return false;
    }
    if !ends_in_a_number(host) {
        return true;
    }
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            part.bytes().all(|b| b.is_ascii_digit())
                && (*part == "0" || !part.starts_with('0'))
                && part.parse::<u8>().is_ok()
        })
}

/// Whether a URL parser takes `host` for an IPv4 address: its last label, past one trailing dot,
/// is all digits, or `0x` then hex digits.
fn ends_in_a_number(host: &str) -> bool {
    let host = match host.strip_suffix('.') {
        Some(rest) if !rest.is_empty() => rest,
        _ => host,
    };
    let last = host.rsplit('.').next().unwrap_or_default();
    if !last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    last.strip_prefix("0x")
        .or_else(|| last.strip_prefix("0X"))
        .is_some_and(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Whether `text` is an IPv6 address as a URL writes it: lowercase hex with no leading zeros, and
/// the first longest run of two or more zero groups as `::`.
fn is_shortest_ipv6(text: &str) -> bool {
    text.parse::<std::net::Ipv6Addr>()
        .is_ok_and(|address| shortest_ipv6(address.segments()) == text)
}

fn shortest_ipv6(groups: [u16; 8]) -> String {
    let mut run: Option<(usize, usize)> = None;
    let mut start = 0;
    while start < groups.len() {
        let len = groups.iter().skip(start).take_while(|&&g| g == 0).count();
        if len >= 2 && run.is_none_or(|(_, longest)| len > longest) {
            run = Some((start, len));
        }
        start += len.max(1);
    }
    let hex = |groups: &[u16]| {
        groups
            .iter()
            .map(|g| format!("{g:x}"))
            .collect::<Vec<_>>()
            .join(":")
    };
    match run {
        Some((at, len)) => {
            let (head, rest) = groups.split_at(at);
            format!(
                "{}::{}",
                hex(head),
                hex(rest.get(len..).unwrap_or_default())
            )
        }
        None => hex(&groups),
    }
}
