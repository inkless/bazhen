//! A message as it arrives: JSON the daemon wrote with `JSON.stringify`, which writes a lone
//! surrogate (half an emoji, cut by UTF-16 units) as an escape such as `\ud83d`. That is no
//! character, and `serde_json` refuses it, so one such string would fail a whole snapshot. Each is
//! read as U+FFFD instead, which is what Node prints for one.

use std::borrow::Cow;

use serde::de::DeserializeOwned;

/// `T` from the JSON in `json`, each lone surrogate escape in it read as U+FFFD.
///
/// # Errors
///
/// When the JSON isn't a `T`.
pub fn from_slice<T: DeserializeOwned>(json: &[u8]) -> Result<T, serde_json::Error> {
    serde_json::from_slice(&well_formed(json))
}

const REPLACEMENT: &[u8] = b"\\ufffd";

/// `json` with each escape of a lone surrogate replaced by U+FFFD's; a pair's two escapes, and
/// everything else, as they were.
pub fn well_formed(json: &[u8]) -> Cow<'_, [u8]> {
    if !json.windows(2).any(|w| w == b"\\u") {
        return Cow::Borrowed(json);
    }
    let mut out = Vec::with_capacity(json.len());
    let mut i = 0;
    while let Some(&byte) = json.get(i) {
        let escaped = json.get(i + 1).copied();
        if byte != b'\\' || escaped.is_none() {
            out.push(byte);
            i += 1;
            continue;
        }
        let unit = (escaped == Some(b'u')).then(|| hex4(json, i + 2)).flatten();
        match unit {
            Some(0xd800..=0xdbff) => {
                let low = (json.get(i + 6..i + 8) == Some(b"\\u"))
                    .then(|| hex4(json, i + 8))
                    .flatten()
                    .filter(|low| (0xdc00..=0xdfff).contains(low));
                if low.is_some() {
                    out.extend_from_slice(json.get(i..i + 12).unwrap_or_default());
                    i += 12;
                } else {
                    out.extend_from_slice(REPLACEMENT);
                    i += 6;
                }
            }
            Some(0xdc00..=0xdfff) => {
                out.extend_from_slice(REPLACEMENT);
                i += 6;
            }
            _ => {
                out.extend_from_slice(json.get(i..i + 2).unwrap_or_default());
                i += 2;
            }
        }
    }
    Cow::Owned(out)
}

/// The UTF-16 unit the four hex digits at `at` name.
fn hex4(json: &[u8], at: usize) -> Option<u16> {
    let digits = std::str::from_utf8(json.get(at..at + 4)?).ok()?;
    if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(digits, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(json: &str) -> String {
        String::from_utf8(well_formed(json.as_bytes()).into_owned()).unwrap()
    }

    #[test]
    fn reads_a_lone_surrogate_as_u_fffd_and_keeps_a_pair() {
        assert_eq!(text(r#""a\ud83d""#), r#""a\ufffd""#);
        assert_eq!(text(r#""\udc4db""#), r#""\ufffdb""#);
        assert_eq!(text(r#""\ud83d\ud83d\udc4d""#), r#""\ufffd\ud83d\udc4d""#);
        assert_eq!(text(r#""\ud83d\udc4d""#), r#""\ud83d\udc4d""#);
        assert_eq!(text(r#""\\ud83d""#), r#""\\ud83d""#);
        assert_eq!(text(r#""\u00e9\n""#), r#""\u00e9\n""#);
    }

    #[test]
    fn decodes_a_message_holding_one_that_serde_json_alone_refuses() {
        let json = br#"{"name":"phone\ud83d"}"#;
        assert!(serde_json::from_slice::<serde_json::Value>(json).is_err());
        let value: serde_json::Value = from_slice(json).unwrap();
        assert_eq!(value["name"], "phone\u{fffd}");
    }
}
