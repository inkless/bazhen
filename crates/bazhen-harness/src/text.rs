//! Text as packages/core cuts and dates it.

/// At most `max` UTF-16 units of `text`, never half a surrogate pair (`whole`, in core).
pub(crate) fn whole(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return text.get(..at).unwrap_or(text);
        }
    }
    text
}

/// The text's length as JavaScript counts it, in UTF-16 units.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The latest time a JavaScript Date holds, in Unix seconds.
const LAST_DATE_SECONDS: i64 = 8_640_000_000_000;

/// The days in 400 Gregorian years, after which the calendar repeats.
const CYCLE_DAYS: i64 = 146_097;

/// A time a harness gives in whole Unix seconds, as `Date.prototype.toISOString` writes it; none
/// for anything else (`isoOfUnixSeconds`, in core). A year past 9999 takes six digits and a sign.
pub(crate) fn iso_of_unix_seconds(seconds: f64) -> Option<String> {
    // NaN is no integer, and fails both.
    if seconds.fract() != 0.0 || seconds.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    let seconds: i64 = format!("{seconds:.0}").parse().ok()?;
    if seconds > LAST_DATE_SECONDS {
        return None;
    }
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    // A date past jiff's last year is one within it, whole cycles on.
    let date = jiff::civil::date(1970, 1, 1)
        .checked_add(jiff::Span::new().try_days(days % CYCLE_DAYS).ok()?)
        .ok()?;
    let year = i64::from(date.year()) + days / CYCLE_DAYS * 400;
    let year = if year > 9999 {
        format!("+{year:06}")
    } else {
        format!("{year:04}")
    };
    Some(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        date.month(),
        date.day(),
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_text_at_a_count_of_utf16_units_never_inside_a_pair() {
        assert_eq!(whole("abc", 2), "ab");
        assert_eq!(whole("a😀b", 2), "a");
        assert_eq!(whole("a😀b", 3), "a😀");
        assert_eq!(whole("ab", 5), "ab");
        assert_eq!(utf16_len("a😀"), 3);
    }

    #[test]
    fn dates_whole_unix_seconds_as_to_iso_string_does_from_the_epoch_to_the_last_date() {
        assert_eq!(
            iso_of_unix_seconds(1_700_000_000.0).as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(
            iso_of_unix_seconds(951_782_400.0).as_deref(),
            Some("2000-02-29T00:00:00.000Z")
        );
        assert_eq!(
            iso_of_unix_seconds(12_622_780_800.0).as_deref(),
            Some("2370-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_of_unix_seconds(253_402_300_800.0).as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_of_unix_seconds(8.64e12).as_deref(),
            Some("+275760-09-13T00:00:00.000Z")
        );
        for refused in [0.0, -1.0, 1.5, 8.64e12 + 1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(iso_of_unix_seconds(refused), None, "{refused}");
        }
    }
}
