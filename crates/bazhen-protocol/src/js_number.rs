//! A number written as JavaScript's `JSON.stringify` writes it. serde writes a whole `f64` as `1.0`
//! and the TypeScript daemon as `1`, so an event payload or a JSON column holding one would differ
//! byte for byte between the two.
//!
//! JavaScript writes the shortest digits that read back as the same number, as Rust's `Display`
//! does. It writes them plainly from 1e-6 up to 1e21, as `Display` always does, and past those
//! bounds in exponent form, with a sign after the `e`. Negative zero is `0`, and a number that
//! isn't finite is `null`.

use serde::ser::Error;
use serde::{Serialize as _, Serializer};
use serde_json::value::RawValue;

/// `x`'s text as JavaScript writes it, or none for a number that isn't finite.
fn text(x: f64) -> Option<String> {
    if !x.is_finite() {
        return None;
    }
    if x == 0.0 {
        return Some("0".to_owned());
    }
    let magnitude = x.abs();
    if (1e-6..1e21).contains(&magnitude) {
        return Some(x.to_string());
    }
    let exponent = format!("{x:e}");
    Some(match exponent.split_once('e') {
        Some((digits, power)) if !power.starts_with('-') => format!("{digits}e+{power}"),
        _ => exponent,
    })
}

/// Serializes `x` as JavaScript writes it.
///
/// # Errors
///
/// The serializer's.
pub fn number<S: Serializer>(x: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    match text(*x) {
        None => serializer.serialize_unit(),
        Some(text) => RawValue::from_string(text)
            .map_err(S::Error::custom)?
            .serialize(serializer),
    }
}

/// Serializes a number that may be absent, as JavaScript writes it when it is there.
///
/// # Errors
///
/// The serializer's.
pub fn optional<S: Serializer>(x: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match x {
        Some(x) => number(x, serializer),
        None => serializer.serialize_none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize)]
    struct One(#[serde(serialize_with = "number")] f64);

    /// What `JSON.stringify` gives for each, in Node.
    const AS_JAVASCRIPT_WRITES: [(f64, &str); 14] = [
        (1.0, "1"),
        (-0.0, "0"),
        (0.0, "0"),
        (12.5, "12.5"),
        (0.1, "0.1"),
        (-3.0, "-3"),
        (1e-6, "0.000001"),
        (1.5e-7, "1.5e-7"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (-2.5e30, "-2.5e+30"),
        (123_456.789, "123456.789"),
        (f64::NAN, "null"),
        (f64::INFINITY, "null"),
    ];

    #[test]
    fn writes_each_number_as_json_stringify_does() {
        for (x, want) in AS_JAVASCRIPT_WRITES {
            assert_eq!(serde_json::to_string(&One(x)).unwrap(), want, "{x:?}");
        }
    }

    #[test]
    fn writes_an_absent_number_as_null_and_a_present_one_as_javascript_does() {
        #[derive(serde::Serialize)]
        struct Maybe(#[serde(serialize_with = "optional")] Option<f64>);
        assert_eq!(serde_json::to_string(&Maybe(None)).unwrap(), "null");
        assert_eq!(serde_json::to_string(&Maybe(Some(50.0))).unwrap(), "50");
    }
}
