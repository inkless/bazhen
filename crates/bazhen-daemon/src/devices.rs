//! Paired devices as the HTTP listener sees them (`auth/devices.ts`): the cookie that carries a
//! device's token, whether a presented token still stands, and the streams a device holds open,
//! which close when it is revoked or lapses. Tokens are 32 random bytes; the store keeps their
//! hash only.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex, PoisonError};

use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;

/// On HTTPS, a `__Host-` cookie: Secure, for this host only, every path. Plain HTTP is loopback
/// in practice, where a cookie can't be held to one port, so other local servers' `/v1` receive
/// it too; it is kept to `/v1` and lapses sooner.
pub(crate) const SECURE_COOKIE: &str = "__Host-bazhen_device";
pub(crate) const LOOPBACK_COOKIE: &str = "bazhen_device";
/// How long a device paired over HTTPS stays paired without being used.
pub(crate) const SECURE_IDLE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// The same for one paired over plain HTTP, whose cookie other local ports can read.
pub(crate) const LOOPBACK_IDLE_MS: i64 = 24 * 60 * 60 * 1000;
/// How stale `last_seen_at` may get before a request writes it, and sets the cookie again.
pub(crate) const TOUCH_EVERY_MS: i64 = 60 * 60 * 1000;
const DEFAULT_NAME: &str = "Browser";
const NAME_MAX: usize = 64;

/// A device token as a request presented it: which of the two cookies carried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Presented {
    pub(crate) token: String,
    pub(crate) secure: bool,
}

/// The `Cookie` header's lines as Node joins them for a server: with `"; "`.
pub(crate) fn cookie_header(headers: &axum::http::HeaderMap) -> Option<String> {
    let mut lines = headers.get_all("cookie").iter().peekable();
    lines.peek()?;
    let latin1 = lines.map(|line| line.as_bytes().iter().map(|&b| char::from(b)).collect());
    Some(latin1.collect::<Vec<String>>().join("; "))
}

/// The device token a `Cookie` header carries, if any, the HTTPS cookie first. Each cookie is
/// read as Hono reads it: its first well-formed value, unquoted and percent-decoded.
pub(crate) fn token_from(header: Option<&str>) -> Option<Presented> {
    let header = header?;
    let cookies = parse_cookies(header);
    if let Some(token) = cookies.get(SECURE_COOKIE) {
        return Some(Presented {
            token: token.clone(),
            secure: true,
        });
    }
    cookies.get(LOOPBACK_COOKIE).map(|token| Presented {
        token: token.clone(),
        secure: false,
    })
}

/// Hono's `parse`: `name=value` pairs split on `;`, each name kept at its first well-formed
/// value.
fn parse_cookies(header: &str) -> HashMap<String, String> {
    let mut cookies = HashMap::new();
    for pair in header.split(';') {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        let name = trim_cookie_space(name);
        if !name.chars().all(relaxed_name_char) || name.is_empty() || cookies.contains_key(name) {
            continue;
        }
        let mut value = trim_cookie_space(value);
        if value.starts_with('"') && value.ends_with('"') {
            // A lone `"` both starts and ends with one, so Hono slices it to nothing.
            value = value.get(1..value.len() - 1).unwrap_or_default();
        }
        if value.chars().all(value_char) {
            cookies.insert(name.to_owned(), percent_decoded(value));
        }
    }
    cookies
}

fn trim_cookie_space(text: &str) -> &str {
    text.trim_matches([' ', '\t'])
}

/// `/^[!#-:<>-[\]-~]+$/`'s characters.
fn relaxed_name_char(c: char) -> bool {
    matches!(c, '!' | '#'..=':' | '<' | '>'..='[' | ']'..='~')
}

/// `/^[ !#-:<-[\]-~]*$/`'s characters.
fn value_char(c: char) -> bool {
    matches!(c, ' ' | '!' | '#'..=':' | '<'..='[' | ']'..='~')
}

/// `value` with each run of `%XX` that decodes as UTF-8 decoded, and every other run kept as it
/// is, as Hono's `tryDecodeURIComponent` keeps what it can't decode.
fn percent_decoded(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while let Some(c) = value.get(i..).and_then(|rest| rest.chars().next()) {
        let start = i;
        let mut run = Vec::new();
        while bytes.get(i) == Some(&b'%') {
            let (Some(hi), Some(lo)) = (hex(bytes.get(i + 1)), hex(bytes.get(i + 2))) else {
                break;
            };
            run.push(hi * 16 + lo);
            i += 3;
        }
        if run.is_empty() {
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        match String::from_utf8(run) {
            Ok(text) => out.push_str(&text),
            Err(_) => out.push_str(value.get(start..i).unwrap_or_default()),
        }
    }
    out
}

fn hex(b: Option<&u8>) -> Option<u8> {
    char::from(*b?)
        .to_digit(16)
        .and_then(|d| u8::try_from(d).ok())
}

/// A token's shape: 32 bytes as unpadded base64url.
pub(crate) fn well_formed(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// What the store keeps of a token.
pub(crate) fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut hex, b| {
            let _ = write!(hex, "{b:02x}");
            hex
        })
}

/// A fresh token, as unpadded base64url.
pub(crate) fn token_of(random: [u8; 32]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(43);
    for chunk in random.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for k in 0..=chunk.len() {
            let index = (n >> (18 - 6 * k)) & 63;
            out.extend(ALPHABET.get(index as usize).copied().map(char::from));
        }
    }
    out
}

/// A device name as it may be stored and shown: printable, trimmed, and not too long. Control
/// and format characters, bidi overrides among them, and the line and paragraph separators could
/// disguise a name or break the line it is shown on.
pub(crate) fn device_name(requested: Option<&str>) -> String {
    let printable: String = requested
        .unwrap_or_default()
        .chars()
        .filter(|&c| !unprintable(c))
        .collect();
    let name = whole(js_trim(&printable), NAME_MAX);
    if name.is_empty() {
        DEFAULT_NAME.to_owned()
    } else {
        name.to_owned()
    }
}

/// `\p{Cc}`, `\p{Cf}` (as of Unicode 16), `\p{Zl}` and `\p{Zp}`.
fn unprintable(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{2028}' | '\u{2029}')
        || matches!(c as u32,
            0xad | 0x600..=0x605 | 0x61c | 0x6dd | 0x70f | 0x890..=0x891 | 0x8e2 | 0x180e
            | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x2064 | 0x2066..=0x206f | 0xfeff
            | 0xfff9..=0xfffb | 0x110bd | 0x110cd | 0x13430..=0x1343f | 0x1bca0..=0x1bca3
            | 0x1d173..=0x1d17a | 0xe0001 | 0xe0020..=0xe007f)
}

/// `String.prototype.trim`: Unicode's white space and the BOM, from both ends.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// At most `max` UTF-16 units of `text`, never half a surrogate pair (`whole`, in core).
fn whole(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return text.get(..at).unwrap_or(text);
        }
    }
    text
}

/// The `Set-Cookie` value that carries a device's token.
pub(crate) fn device_cookie(token: &str, secure: bool) -> String {
    let scope = if secure {
        format!(
            "{SECURE_COOKIE}={token}; Secure; Path=/; Max-Age={}",
            SECURE_IDLE_MS / 1000
        )
    } else {
        format!(
            "{LOOPBACK_COOKIE}={token}; Path=/v1; Max-Age={}",
            LOOPBACK_IDLE_MS / 1000
        )
    };
    format!("{scope}; HttpOnly; SameSite=Strict")
}

/// What the gate needs of a stored device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stored {
    pub(crate) revoked: bool,
    pub(crate) secure: bool,
    pub(crate) last_seen_ms: i64,
}

fn idle_limit(secure: bool) -> i64 {
    if secure {
        SECURE_IDLE_MS
    } else {
        LOOPBACK_IDLE_MS
    }
}

pub(crate) fn lapsed(device: &Stored, now: i64) -> bool {
    now - device.last_seen_ms >= idle_limit(device.secure)
}

/// Whether a presented token's device stands, and if so whether to record its use and set the
/// cookie again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Standing {
    Refused,
    Stands,
    Touch,
}

/// How `device`, found by the token a request `presented`, stands. A request from another
/// machine or over HTTPS (`remote`) takes only a device paired over HTTPS; each cookie carries
/// only the token of a device paired over its scheme. Only a caller that can set the cookie again
/// (`touch`) records the use: one that couldn't would restart the daemon's lifetime but not the
/// browser's.
pub(crate) fn standing(
    device: Option<&Stored>,
    presented_secure: bool,
    remote: bool,
    touch: bool,
    now: i64,
) -> Standing {
    let Some(device) = device else {
        return Standing::Refused;
    };
    if device.revoked || lapsed(device, now) || device.secure != presented_secure {
        return Standing::Refused;
    }
    if remote && !device.secure {
        return Standing::Refused;
    }
    if !touch || now - device.last_seen_ms < TOUCH_EVERY_MS {
        return Standing::Stands;
    }
    Standing::Touch
}

/// The streams each device holds open, and for each whether it had to pair to open.
#[derive(Debug, Clone, Default)]
pub(crate) struct Holds {
    open: Arc<Mutex<HashMap<String, Streams>>>,
}

/// A device's streams, each with whether it had to pair to open.
type Streams = Vec<(CancellationToken, bool)>;

/// A stream's place among its device's: dropped as the stream ends.
#[derive(Debug)]
pub(crate) struct Hold {
    token: CancellationToken,
}

impl Drop for Hold {
    fn drop(&mut self) {
        // A closed stream's entry reads as gone: each change of the map prunes it.
        self.token.cancel();
    }
}

impl Holds {
    /// A stream `device` opens, ending with `until` or when the device is closed out.
    pub(crate) fn hold(&self, device: &str, until: &CancellationToken, required: bool) -> Hold {
        let token = until.child_token();
        let mut open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        open.retain(|_, streams| {
            streams.retain(|(t, _)| !t.is_cancelled());
            !streams.is_empty()
        });
        open.entry(device.to_owned())
            .or_default()
            .push((token.clone(), required));
        Hold { token }
    }

    /// Ends every stream `device` holds.
    pub(crate) fn end_all(&self, device: &str) {
        let streams = self
            .open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(device);
        for (token, _) in streams.unwrap_or_default() {
            token.cancel();
        }
    }

    /// Ends the streams `device` had to pair to open, keeping those that needn't have: closing
    /// one does no good, since its browser would open it again unpaired.
    pub(crate) fn end_required(&self, device: &str) {
        let open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        for (token, required) in open.get(device).into_iter().flatten() {
            if *required {
                token.cancel();
            }
        }
    }

    /// The devices holding a stream open.
    pub(crate) fn devices(&self) -> Vec<String> {
        let open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        open.iter()
            .filter(|(_, streams)| streams.iter().any(|(t, _)| !t.is_cancelled()))
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// The token of a stream held for `hold`, which ends when the hold does.
impl Hold {
    pub(crate) fn token(&self) -> &CancellationToken {
        &self.token
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abcdefghijABCDEFGHIJ0123456789-_abcdefghijk";
    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn reads_the_https_cookie_before_the_loopback_one() {
        assert_eq!(
            [
                token_from(Some(&format!(
                    "bazhen_device=a; __Host-bazhen_device={TOKEN}"
                ))),
                token_from(Some("bazhen_device=b")),
                token_from(Some("other=c")),
                token_from(None),
            ],
            [
                Some(Presented {
                    token: TOKEN.to_owned(),
                    secure: true
                }),
                Some(Presented {
                    token: "b".to_owned(),
                    secure: false
                }),
                None,
                None
            ]
        );
    }

    #[test]
    fn reads_a_cookie_as_hono_does() {
        let read = |header: &str| token_from(Some(header)).map(|p| p.token);
        assert_eq!(
            [
                read("bazhen_device=first; bazhen_device=second"),
                read(" \tbazhen_device = \"quoted\" "),
                read("bazhen_device=%61%62c"),
                read("bazhen_device=%ff%41"),
                read("bazhen_device=bad;value; bazhen_device=ok"),
                read("bazhen_device=a\\b; bazhen_device=later"),
                read("novalue; bazhen_device=x"),
            ],
            [
                Some("first".to_owned()),
                Some("quoted".to_owned()),
                Some("abc".to_owned()),
                Some("%ff%41".to_owned()),
                Some("bad".to_owned()),
                Some("later".to_owned()),
                Some("x".to_owned()),
            ]
        );
    }

    #[test]
    fn joins_cookie_lines_as_node_does() {
        let mut headers = axum::http::HeaderMap::new();
        headers.append("cookie", "a=1".parse().unwrap());
        headers.append("cookie", "bazhen_device=2".parse().unwrap());
        assert_eq!(
            (
                cookie_header(&headers),
                cookie_header(&axum::http::HeaderMap::new())
            ),
            (Some("a=1; bazhen_device=2".to_owned()), None)
        );
    }

    #[test]
    fn a_token_is_43_characters_of_base64url() {
        assert_eq!(
            [
                well_formed(TOKEN),
                well_formed(TOKEN.get(1..).unwrap_or_default()),
                well_formed(&format!("{TOKEN}a")),
                well_formed(&TOKEN.replace('a', "+")),
                well_formed(&TOKEN.replace('a', "=")),
            ],
            [true, false, false, false, false]
        );
    }

    #[test]
    fn mints_a_token_as_unpadded_base64url() {
        let mut random = [0u8; 32];
        random[..6].copy_from_slice(&[0xfb, 0xff, 0xbf, 0x00, 0x10, 0x83]);
        random[31] = 0xff;
        let token = token_of(random);
        assert_eq!(
            (
                token.len(),
                token.get(..8),
                token.get(40..),
                well_formed(&token)
            ),
            (43, Some("-_-_ABCD"), Some("AP8"), true)
        );
    }

    #[test]
    fn hashes_a_token_as_sha256_hex() {
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn names_a_device_printably_and_briefly() {
        let long = "é".repeat(70);
        let astral = format!("{}😀", "a".repeat(63));
        assert_eq!(
            [
                device_name(Some("  Phone\u{202e}\u{7}\n ")),
                device_name(Some("\u{200b} \u{feff}")),
                device_name(None),
                device_name(Some(&long)),
                device_name(Some(&astral)),
                device_name(Some("a\u{2028}b\u{ad}c")),
            ],
            [
                "Phone".to_owned(),
                "Browser".to_owned(),
                "Browser".to_owned(),
                "é".repeat(64),
                "a".repeat(63),
                "abc".to_owned(),
            ]
        );
    }

    #[test]
    fn sets_the_cookie_for_its_scheme() {
        assert_eq!(
            [device_cookie("t", true), device_cookie("t", false)],
            [
                "__Host-bazhen_device=t; Secure; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict",
                "bazhen_device=t; Path=/v1; Max-Age=86400; HttpOnly; SameSite=Strict",
            ]
        );
    }

    fn seen(secure: bool, ago: i64) -> Stored {
        Stored {
            revoked: false,
            secure,
            last_seen_ms: NOW - ago,
        }
    }

    #[test]
    fn a_device_stands_until_revoked_or_idle_past_its_limit() {
        let revoked = Stored {
            revoked: true,
            ..seen(false, 0)
        };
        assert_eq!(
            [
                standing(Some(&seen(false, 0)), false, false, true, NOW),
                standing(Some(&revoked), false, false, true, NOW),
                standing(None, false, false, true, NOW),
                standing(
                    Some(&seen(false, LOOPBACK_IDLE_MS - 1)),
                    false,
                    false,
                    false,
                    NOW
                ),
                standing(
                    Some(&seen(false, LOOPBACK_IDLE_MS)),
                    false,
                    false,
                    false,
                    NOW
                ),
                standing(
                    Some(&seen(true, SECURE_IDLE_MS - 1)),
                    true,
                    true,
                    false,
                    NOW
                ),
                standing(Some(&seen(true, SECURE_IDLE_MS)), true, true, false, NOW),
            ],
            [
                Standing::Stands,
                Standing::Refused,
                Standing::Refused,
                Standing::Stands,
                Standing::Refused,
                Standing::Stands,
                Standing::Refused,
            ]
        );
    }

    #[test]
    fn a_token_stands_only_in_its_own_cookie_and_remotely_only_over_https() {
        assert_eq!(
            [
                standing(Some(&seen(true, 0)), false, false, false, NOW),
                standing(Some(&seen(false, 0)), true, false, false, NOW),
                standing(Some(&seen(false, 0)), false, true, false, NOW),
                standing(Some(&seen(true, 0)), true, true, false, NOW),
            ],
            [
                Standing::Refused,
                Standing::Refused,
                Standing::Refused,
                Standing::Stands
            ]
        );
    }

    #[test]
    fn records_a_use_an_hour_on_where_the_cookie_can_be_set_again() {
        assert_eq!(
            [
                standing(
                    Some(&seen(false, TOUCH_EVERY_MS - 1)),
                    false,
                    false,
                    true,
                    NOW
                ),
                standing(Some(&seen(false, TOUCH_EVERY_MS)), false, false, true, NOW),
                standing(Some(&seen(false, TOUCH_EVERY_MS)), false, false, false, NOW),
            ],
            [Standing::Stands, Standing::Touch, Standing::Stands]
        );
    }

    #[test]
    fn closes_a_devices_streams_or_only_those_it_had_to_pair_for() {
        let holds = Holds::default();
        let stop = CancellationToken::new();
        let needed = holds.hold("dev_a", &stop, true);
        let free = holds.hold("dev_a", &stop, false);
        let other = holds.hold("dev_b", &stop, true);
        holds.end_required("dev_a");
        let after_lapse = [needed.token().is_cancelled(), free.token().is_cancelled()];
        holds.end_all("dev_a");
        assert_eq!(
            (
                after_lapse,
                free.token().is_cancelled(),
                other.token().is_cancelled(),
                holds.devices()
            ),
            ([true, false], true, false, vec!["dev_b".to_owned()])
        );
    }

    #[test]
    fn a_held_stream_ends_with_the_daemon_and_leaves_when_it_ends() {
        let holds = Holds::default();
        let stop = CancellationToken::new();
        let first = holds.hold("dev_a", &stop, true);
        let second = holds.hold("dev_b", &stop, true);
        drop(first);
        let after_drop = holds.devices();
        stop.cancel();
        assert_eq!(
            (after_drop, second.token().is_cancelled()),
            (vec!["dev_b".to_owned()], true)
        );
    }
}
