//! The number JavaScript's `Number(text)` makes of a variable, which the TypeScript daemon's
//! config reads `BAZHEN_PORT` with.

use bazhen_protocol::text::trim;

/// `Number(text)`: a decimal, `Infinity` or a `0x`, `0o` or `0b` literal, signed only in decimal,
/// between any white space; 0 for none at all, and NaN for anything else.
pub(crate) fn number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return in_radix(digits, radix);
        }
    }
    let (negative, body) = match text.strip_prefix('-') {
        Some(body) => (true, body),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let magnitude = if body == "Infinity" {
        f64::INFINITY
    } else if is_decimal(body) {
        body.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    };
    if negative { -magnitude } else { magnitude }
}

/// Digits in `radix`, at least one; NaN for anything else. Exact up to 2^53, past which the value
/// stays past it, as JavaScript's does.
fn in_radix(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0.0;
    for c in digits.chars() {
        let Some(digit) = c.to_digit(radix) else {
            return f64::NAN;
        };
        value = value * f64::from(radix) + f64::from(digit);
    }
    value
}

/// Whether `text` is an unsigned decimal literal as `Number` reads one: digits with an optional
/// fraction, or a fraction alone, then an optional exponent.
fn is_decimal(text: &str) -> bool {
    let (mantissa, exponent) = match text.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, Some(exponent)),
        None => (text, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok =
        digits(whole) && digits(fraction) && !(whole.is_empty() && fraction.is_empty());
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    mantissa_ok && exponent_ok
}

#[cfg(test)]
mod tests {
    use super::number;

    #[test]
    fn reads_a_number_as_javascript_does() {
        for (text, expected) in [
            ("7000", 7000.0),
            ("", 0.0),
            ("  ", 0.0),
            (" 7000 ", 7000.0),
            ("\u{feff}7\u{2028}", 7.0),
            ("+7", 7.0),
            ("1e3", 1000.0),
            ("1E+3", 1000.0),
            ("5.", 5.0),
            (".5", 0.5),
            ("0x1F", 31.0),
            ("0B11", 3.0),
            ("0o17", 15.0),
            ("00012", 12.0),
            ("-Infinity", f64::NEG_INFINITY),
            ("1e400", f64::INFINITY),
        ] {
            assert_eq!(number(text).to_bits(), expected.to_bits(), "{text:?}");
        }
        assert!(number("-0").is_sign_negative());
        for text in [
            "abc", "-0x10", "0x", "1_000", "e5", "1e", ".", "--1", "inf", "infinity", "NaN",
            "1.2.3", "1e5.5", "0x1g", "\u{85}1",
        ] {
            assert!(number(text).is_nan(), "{text:?}");
        }
    }
}
