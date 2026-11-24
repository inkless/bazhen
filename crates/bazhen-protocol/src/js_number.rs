//! A number written as JavaScript's `JSON.stringify` writes it. serde writes a whole `f64` as `1.0`
//! and the TypeScript daemon as `1`, so an event payload or a JSON column holding one would differ
//! byte for byte between the two.
//!
//! JavaScript writes the shortest digits that read back as the same number, and where two are as
//! short and as near, the even one: Rust's float formatting rounds those ties up instead. It writes
//! them plainly from 1e-6 up to 1e21 and past those bounds in exponent form, with a sign after the
//! `e`. Negative zero is `0`, and a number that isn't finite is `null`. ryu-js writes all of it as
//! ECMAScript's Number::toString does.

use serde::ser::Error;
use serde::{Serialize as _, Serializer};
use serde_json::value::RawValue;

/// `x`'s text as JavaScript writes it, or none for a number that isn't finite.
fn text(x: f64) -> Option<String> {
    x.is_finite()
        .then(|| ryu_js::Buffer::new().format_finite(x).to_owned())
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
    use proptest::prelude::*;

    #[derive(serde::Serialize)]
    struct One(#[serde(serialize_with = "number")] f64);

    fn written(x: f64) -> String {
        serde_json::to_string(&One(x)).unwrap()
    }

    #[derive(serde::Deserialize)]
    struct Case {
        bits: String,
        text: String,
        tie: bool,
    }

    /// What Node's `JSON.stringify` writes for each number `moon run :schema` records.
    fn cases() -> Vec<Case> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/protocol/fixtures/numbers/cases.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn writes_each_number_node_recorded_as_json_stringify_does_ties_and_all() {
        let cases = cases();
        assert!(
            cases.iter().filter(|c| c.tie).count() >= 300,
            "too few ties"
        );
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let x = f64::from_bits(u64::from_str_radix(&case.bits, 16).unwrap());
                let got = written(x);
                (got != case.text).then(|| format!("{x:?}: {got}, where Node wrote {}", case.text))
            })
            .collect();
        assert!(
            wrong.is_empty(),
            "{} wrong:\n{}",
            wrong.len(),
            wrong.join("\n")
        );
    }

    #[test]
    fn writes_an_absent_number_as_null_and_a_present_one_as_javascript_does() {
        #[derive(serde::Serialize)]
        struct Maybe(#[serde(serialize_with = "optional")] Option<f64>);
        assert_eq!(serde_json::to_string(&Maybe(None)).unwrap(), "null");
        assert_eq!(serde_json::to_string(&Maybe(Some(50.0))).unwrap(), "50");
    }

    proptest! {
        /// Every finite number reads back as itself, written plainly from 1e-6 up to 1e21 and
        /// with a signed exponent past those bounds, as JavaScript writes it.
        #[test]
        fn writes_every_finite_number_so_it_reads_back_in_javascript_s_form(
            bits in any::<u64>()
        ) {
            let x = f64::from_bits(bits);
            prop_assume!(x.is_finite());
            let text = written(x);
            prop_assert_eq!(text.parse::<f64>().unwrap(), x);
            let plain = x == 0.0 || (1e-6..1e21).contains(&x.abs());
            prop_assert_eq!(!text.contains('e'), plain, "{}", text);
            prop_assert!(plain || text.contains("e+") || text.contains("e-"), "{}", text);
        }
    }
}
