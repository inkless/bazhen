//! A number written as JavaScript's `JSON.stringify` writes it. serde writes a whole `f64` as `1.0`
//! and the TypeScript daemon as `1`, so an event payload or a JSON column holding one would differ
//! byte for byte between the two.
//!
//! JavaScript writes the shortest digits that read back as the same number, and where two are as
//! short and as near, the even one: Rust's float formatting rounds those ties up instead. It writes
//! them plainly from 1e-6 up to 1e21 and past those bounds in exponent form, with a sign after the
//! `e`. Negative zero is `0`, and a number that isn't finite is `null`. ryu-js writes all of it as
//! ECMAScript's `Number::toString` does.

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

/// Deserializes a whole number as JavaScript reads one: `2`, `2.0` and `2e0` are the same number,
/// which zod's `.int()` takes however JSON writes it. A number written with a fraction or exponent
/// is taken up to the largest safe integer, past which an `f64` isn't exact; one written as digits
/// is taken as it is, and held to that bound by the edge, as serde's `u64` was.
///
/// # Errors
///
/// When the value isn't a whole, non-negative number.
pub fn whole<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    struct Whole;

    impl serde::de::Visitor<'_> for Whole {
        type Value = u64;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a whole, non-negative number")
        }

        fn visit_u64<E: serde::de::Error>(self, n: u64) -> Result<u64, E> {
            Ok(n)
        }

        fn visit_i64<E: serde::de::Error>(self, n: i64) -> Result<u64, E> {
            u64::try_from(n).map_err(|_| E::invalid_value(serde::de::Unexpected::Signed(n), &self))
        }

        fn visit_f64<E: serde::de::Error>(self, x: f64) -> Result<u64, E> {
            // Rust writes a whole f64 as its digits, with no exponent, and negative zero as `-0`.
            let text = x.to_string();
            let digits = if text == "-0" { "0" } else { &text };
            digits
                .parse()
                .ok()
                .filter(|n| *n <= crate::edge::MAX_SAFE_INTEGER)
                .ok_or_else(|| E::invalid_value(serde::de::Unexpected::Float(x), &self))
        }
    }

    deserializer.deserialize_any(Whole)
}

/// Deserializes a whole number that may be negative, as [`whole`] does a non-negative one: `-2`,
/// `-2.0` and `-2e0` are the same number. One written with a fraction or exponent is taken within
/// the safe integers; one written as digits as it is, and held to them by the edge.
///
/// # Errors
///
/// A number with a fraction, a whole one past the safe integers written as a float, one written as
/// digits past `i64`, and anything not a number.
pub fn whole_signed<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    struct Signed;

    impl serde::de::Visitor<'_> for Signed {
        type Value = i64;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a whole number")
        }

        fn visit_i64<E: serde::de::Error>(self, n: i64) -> Result<i64, E> {
            Ok(n)
        }

        fn visit_u64<E: serde::de::Error>(self, n: u64) -> Result<i64, E> {
            i64::try_from(n)
                .map_err(|_| E::invalid_value(serde::de::Unexpected::Unsigned(n), &self))
        }

        fn visit_f64<E: serde::de::Error>(self, x: f64) -> Result<i64, E> {
            // Rust writes a whole f64 as its digits, with no exponent, and negative zero as `-0`.
            x.to_string()
                .parse::<i64>()
                .ok()
                .filter(|n| n.unsigned_abs() <= crate::edge::MAX_SAFE_INTEGER)
                .ok_or_else(|| E::invalid_value(serde::de::Unexpected::Float(x), &self))
        }
    }

    deserializer.deserialize_any(Signed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[derive(serde::Serialize)]
    struct One(#[serde(serialize_with = "number")] f64);

    #[derive(serde::Deserialize)]
    struct Whole(#[serde(deserialize_with = "whole")] u64);

    fn read_whole(text: &str) -> Option<u64> {
        serde_json::from_str::<Whole>(text).ok().map(|w| w.0)
    }

    #[test]
    fn reads_a_whole_number_however_json_writes_it_and_an_inexact_one_not_at_all() {
        for (text, read) in [
            ("0", Some(0)),
            ("2", Some(2)),
            ("2.0", Some(2)),
            ("2e0", Some(2)),
            ("-0.0", Some(0)),
            ("9007199254740991", Some(9_007_199_254_740_991)),
            ("9007199254740991.0", Some(9_007_199_254_740_991)),
            ("2.5", None),
            ("9007199254740992", Some(9_007_199_254_740_992)),
            ("9007199254740992.0", None),
            ("-1", None),
            ("\"2\"", None),
            ("null", None),
        ] {
            assert_eq!(read_whole(text), read, "{text}");
        }
    }

    #[derive(serde::Deserialize)]
    struct Signed(#[serde(deserialize_with = "whole_signed")] i64);

    #[test]
    fn reads_a_whole_number_of_either_sign_however_json_writes_it() {
        let read = |text: &str| serde_json::from_str::<Signed>(text).ok().map(|w| w.0);
        for (text, expected) in [
            ("-2", Some(-2)),
            ("-2.0", Some(-2)),
            ("2e0", Some(2)),
            ("-0.0", Some(0)),
            ("-9007199254740991.0", Some(-9_007_199_254_740_991)),
            ("-9007199254740992.0", None),
            ("-9223372036854775808", Some(i64::MIN)),
            ("9223372036854775808", None),
            ("-2.5", None),
            ("\"2\"", None),
            ("null", None),
        ] {
            assert_eq!(read(text), expected, "{text}");
        }
    }

    fn written(x: f64) -> String {
        serde_json::to_string(&One(x)).unwrap()
    }

    #[derive(serde::Deserialize)]
    struct Case {
        bits: String,
        text: String,
        tie: bool,
    }

    /// What Node's `JSON.stringify` writes for each number `make schema` records.
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

    #[test]
    fn reads_each_number_as_json_parse_does_to_the_nearest_double() {
        // Node's JSON.parse of each, as the double's bits. serde_json's default parse misses the
        // nearest by a unit on each; its `float_roundtrip` feature doesn't.
        for (text, bits) in [
            ("1.818278397972953e245", 0x72da_a12a_71e7_7155_u64),
            ("7.856605151738947e-160", 0x1ee6_1763_e9dd_d4b0),
            ("1.1459324015945358e-106", 0x29f0_d208_9e6d_3e4e),
            ("2.2250738585072011e-308", 0x000f_ffff_ffff_ffff),
            ("3.363491038161739523e-23", 0x3b44_54c0_12ab_c946),
            ("1.017748214402220190e136", 0x5c2c_0139_c717_e041),
        ] {
            let read: f64 = serde_json::from_str(text).unwrap();
            assert_eq!(read.to_bits(), bits, "{text}");
        }
    }

    proptest! {
        /// A whole number written as digits is read as itself, and one up to the largest safe
        /// integer as itself however JSON writes it; past that bound, only as digits, where the
        /// edge holds it to the bound.
        #[test]
        fn reads_a_whole_number_as_digits_and_a_safe_one_however_json_writes_it(
            n in prop_oneof![
                any::<u64>(),
                0..=crate::edge::MAX_SAFE_INTEGER,
                (crate::edge::MAX_SAFE_INTEGER - 2)..=(crate::edge::MAX_SAFE_INTEGER + 2),
            ]
        ) {
            prop_assert_eq!(read_whole(&n.to_string()), Some(n));
            let safe = (n <= crate::edge::MAX_SAFE_INTEGER).then_some(n);
            for written in [format!("{n}.0"), format!("{n}e0"), format!("{n}.000")] {
                prop_assert_eq!(read_whole(&written), safe, "{}", written);
            }
            prop_assert_eq!(read_whole(&format!("-{n}")), (n == 0).then_some(0));
        }

        /// A fraction a double holds is refused, as zod's `.int()` refuses it: below 2^48 a
        /// double's step is at most 1/16, so no tenth rounds to a whole.
        #[test]
        fn refuses_a_number_with_a_fraction(n in 0..(1_u64 << 48), tenths in 1..10_u8) {
            prop_assert_eq!(read_whole(&format!("{n}.{tenths}")), None);
        }

        /// Every finite number reads back as itself, written plainly from 1e-6 up to 1e21 and
        /// with a signed exponent past those bounds, as JavaScript writes it.
        #[test]
        fn writes_every_finite_number_so_it_reads_back_in_javascript_s_form(
            bits in any::<u64>()
        ) {
            let x = f64::from_bits(bits);
            prop_assume!(x.is_finite());
            let text = written(x);
            // Negative zero is written `0`, which reads back as positive zero.
            let zero = x.abs().to_bits() == 0;
            let expected = if zero { 0 } else { bits };
            prop_assert_eq!(text.parse::<f64>().unwrap().to_bits(), expected);
            let read: f64 = serde_json::from_str(&text).unwrap();
            prop_assert_eq!(read.to_bits(), expected, "{}", text);
            let plain = zero || (1e-6..1e21).contains(&x.abs());
            prop_assert_eq!(!text.contains('e'), plain, "{}", text);
            prop_assert!(plain || text.contains("e+") || text.contains("e-"), "{}", text);
        }
    }
}
