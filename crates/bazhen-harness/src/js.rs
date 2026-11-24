//! A JSON value as JavaScript's `JSON.parse` gives it, so an adapter reads a harness's report as
//! the TypeScript one did. Every number is a double. An object keeps its keys in JavaScript's
//! order: those that are array indices first, ascending, then the rest as they came, a repeated
//! key keeping its first place and its last value. [`Js::stringify`] writes it as
//! `JSON.stringify` does.

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;

/// One JSON value, as `JSON.parse` gives it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Js {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Js>),
    Object(Vec<(String, Js)>),
}

impl Js {
    /// The JSON text `bytes` holds, read as the TypeScript daemon read a request: as UTF-8, any
    /// other byte replaced, then by `JSON.parse`. A string's lone surrogate, which JavaScript keeps
    /// and a Rust string can't hold, reads as U+FFFD. None for text that isn't JSON, a number past
    /// a double's range, which JavaScript would read as Infinity, and nesting past [`MAX_DEPTH`].
    pub(crate) fn parse(bytes: &[u8]) -> Option<Self> {
        let text = String::from_utf8_lossy(bytes);
        let text = prepared(&text)?;
        let mut deserializer = serde_json::Deserializer::from_str(&text);
        // prepared() has bounded the depth to what a thread's first stack holds.
        deserializer.disable_recursion_limit();
        let js = Self::deserialize(&mut deserializer).ok()?;
        deserializer.end().ok()?;
        Some(js)
    }

    /// `payload[name]`, for an object that has it: `Reflect.get` on anything else is undefined.
    pub(crate) fn field(&self, name: &str) -> Option<&Self> {
        match self {
            Self::Object(entries) => entries.iter().find(|(k, _)| k == name).map(|(_, v)| v),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }

    pub(crate) fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number(x) => Some(*x),
            _ => None,
        }
    }

    /// The text `JSON.stringify` writes for the value.
    pub(crate) fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Self::Number(x) => out.push_str(&number(*x)),
            Self::String(s) => out.push_str(&string(s)),
            Self::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Self::Object(entries) => {
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&string(key));
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// The deepest a value may nest. JavaScript reads any depth; here a value is read, compared,
/// written and dropped by recursion, about 1 KiB of stack a level in a build without
/// optimisation, where 2,500 levels overflow the 2 MiB a thread starts with. This many take a
/// quarter of it, and are four times `serde_json`'s own limit; no hook payload comes near.
pub(crate) const MAX_DEPTH: usize = 512;

/// `text` with each lone surrogate's escape, which `serde_json` refuses, made U+FFFD's; none when
/// it nests deeper than [`MAX_DEPTH`]. One pass: JSON's structure is ASCII, which no byte of a
/// multibyte character is.
fn prepared(text: &str) -> Option<Cow<'_, str>> {
    let bytes = text.as_bytes();
    let mut lone = Vec::new();
    let (mut depth, mut in_string, mut at) = (0_usize, false, 0);
    while let Some(&byte) = bytes.get(at) {
        match (in_string, byte) {
            (_, b'"') => in_string = !in_string,
            (true, b'\\') => {
                let step = match escaped_unit(text, at) {
                    // A pair, which serde_json reads whole.
                    Some(0xD800..=0xDBFF)
                        if matches!(escaped_unit(text, at + 6), Some(0xDC00..=0xDFFF)) =>
                    {
                        12
                    }
                    Some(0xD800..=0xDFFF) => {
                        lone.push(at);
                        6
                    }
                    Some(_) => 6,
                    None => 2,
                };
                at += step;
                continue;
            }
            (false, b'[' | b'{') => {
                depth += 1;
                if depth > MAX_DEPTH {
                    return None;
                }
            }
            (false, b']' | b'}') => depth = depth.saturating_sub(1),
            _ => {}
        }
        at += 1;
    }
    if lone.is_empty() {
        return Some(Cow::Borrowed(text));
    }
    let mut fixed = String::with_capacity(text.len());
    let mut from = 0;
    for start in lone {
        fixed.push_str(text.get(from..start)?);
        fixed.push_str("\\ufffd");
        from = start + 6;
    }
    fixed.push_str(text.get(from..)?);
    Some(Cow::Owned(fixed))
}

/// The UTF-16 unit a `\uXXXX` escape at `at` stands for.
fn escaped_unit(text: &str, at: usize) -> Option<u32> {
    let hex = text.get(at..at + 6)?.strip_prefix("\\u")?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(hex, 16).ok()
}

/// A number as `JSON.stringify` writes it.
fn number(x: f64) -> String {
    #[derive(serde::Serialize)]
    struct One(#[serde(serialize_with = "bazhen_protocol::js_number::number")] f64);
    serde_json::to_string(&One(x)).unwrap_or_else(|_| "null".to_owned())
}

/// A string as `JSON.stringify` writes it: `serde_json` escapes the same characters.
fn string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned())
}

/// Whether a key is an array index, which a JavaScript object orders first, by its value.
fn index(key: &str) -> Option<u32> {
    let canonical =
        key == "0" || (!key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit()));
    key.parse::<u32>()
        .ok()
        .filter(|i| canonical && *i < u32::MAX)
}

impl<'de> Deserialize<'de> for Js {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsVisitor)
    }
}

struct JsVisitor;

impl<'de> Visitor<'de> for JsVisitor {
    type Value = Js;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON")
    }

    fn visit_unit<E>(self) -> Result<Js, E> {
        Ok(Js::Null)
    }

    fn visit_bool<E>(self, b: bool) -> Result<Js, E> {
        Ok(Js::Bool(b))
    }

    // JSON.parse reads every number as the nearest double, as parsing its digits does.
    fn visit_i64<E: serde::de::Error>(self, n: i64) -> Result<Js, E> {
        n.to_string().parse().map(Js::Number).map_err(E::custom)
    }

    fn visit_u64<E: serde::de::Error>(self, n: u64) -> Result<Js, E> {
        n.to_string().parse().map(Js::Number).map_err(E::custom)
    }

    fn visit_f64<E>(self, x: f64) -> Result<Js, E> {
        Ok(Js::Number(x))
    }

    fn visit_str<E>(self, s: &str) -> Result<Js, E> {
        Ok(Js::String(s.to_owned()))
    }

    fn visit_string<E>(self, s: String) -> Result<Js, E> {
        Ok(Js::String(s))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Js, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Js::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Js, A::Error> {
        let mut entries: Vec<(String, Js)> = Vec::new();
        // Where each key sits, so a payload of many keys reads in linear time.
        let mut at: HashMap<String, usize> = HashMap::new();
        while let Some((key, value)) = map.next_entry::<String, Js>()? {
            if let Some(entry) = at.get(&key).and_then(|&i| entries.get_mut(i)) {
                entry.1 = value;
            } else {
                at.insert(key.clone(), entries.len());
                entries.push((key, value));
            }
        }
        // Stable: the other keys keep the order they came in.
        entries.sort_by_key(|(key, _)| index(key).map_or((1, 0), |i| (0, i)));
        Ok(Js::Object(entries))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(text: &str) -> String {
        Js::parse(text.as_bytes()).map_or_else(|| "refused".to_owned(), |js| js.stringify())
    }

    #[test]
    fn orders_an_objects_index_keys_first_ascending_then_the_rest_as_they_came() {
        assert_eq!(
            round_trip(r#"{"b":1,"10":2,"a":3,"2":4,"01":5,"4294967295":6,"4294967294":7}"#),
            r#"{"2":4,"10":2,"4294967294":7,"b":1,"a":3,"01":5,"4294967295":6}"#
        );
    }

    #[test]
    fn keeps_a_repeated_keys_first_place_and_last_value() {
        assert_eq!(round_trip(r#"{"a":1,"b":2,"a":3}"#), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn reads_an_object_of_many_keys_each_repeated_in_one_pass() {
        // 200,000 keys, then each again: well under a second read in one pass, where a search of
        // the keys so far for each takes minutes.
        let keys = 200_000;
        let pairs = |value: usize| (0..keys).map(move |i| format!(r#""k{i}":{value}"#));
        let text = format!(
            "{{{}}}",
            pairs(1).chain(pairs(2)).collect::<Vec<_>>().join(",")
        );
        let start = std::time::Instant::now();
        let Some(Js::Object(entries)) = Js::parse(text.as_bytes()) else {
            panic!("refused")
        };
        let took = start.elapsed();
        assert_eq!(entries.len(), keys);
        assert_eq!(entries.first(), Some(&("k0".to_owned(), Js::Number(2.0))));
        assert_eq!(
            entries.last(),
            Some(&(format!("k{}", keys - 1), Js::Number(2.0)))
        );
        assert!(took.as_secs() < 20, "took {took:?}");
    }

    #[test]
    fn reads_a_lone_surrogate_as_u_fffd_and_a_byte_that_isnt_utf_8_as_the_daemon_did() {
        // What Node's JSON.parse gives, each lone surrogate made well-formed.
        assert_eq!(
            round_trip(
                r#"["\ud83d x","\udc00\ud83d\ude00","\\ud83d",{"\udbff":"\ud800\ud800\udfff"},"\ud83d"]"#
            ),
            r#"["� x","�😀","\\ud83d",{"�":"�𐏿"},"�"]"#
        );
        let read = Js::parse(b"[\"a\xffb\"]").map(|js| js.stringify());
        assert_eq!(read.as_deref(), Some("[\"a\u{fffd}b\"]"));
    }

    #[test]
    fn reads_nesting_to_its_bound_within_a_threads_first_stack_and_none_past_it() {
        let nested = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        let deepest = nested(MAX_DEPTH);
        let read = std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(move || {
                let js = Js::parse(deepest.as_bytes());
                let copy = js.clone();
                (js == copy).then(|| js.map(|js| js.stringify() == deepest))
            })
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(read, Some(Some(true)));
        assert_eq!(Js::parse(nested(MAX_DEPTH + 1).as_bytes()), None);
    }

    #[test]
    fn writes_numbers_and_strings_as_json_stringify_does() {
        assert_eq!(
            round_trip(
                r#"[1e21,1.5,-0,100,1e-7,123456789012345678901,2.2250738585072011e-308,9007199254740993," \u0007"]"#
            ),
            "[1e+21,1.5,0,100,1e-7,123456789012345680000,2.225073858507201e-308,9007199254740992,\"\u{2028}\\u0007\"]"
        );
    }

    #[test]
    fn refuses_text_that_isnt_json_and_a_number_past_a_doubles_range() {
        assert_eq!(round_trip("{not json"), "refused");
        assert_eq!(round_trip("1e400"), "refused");
        assert_eq!(round_trip("1e308"), "1e+308");
    }
}
