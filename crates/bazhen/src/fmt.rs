//! How values are written for a person or a path: ages, sizes, local times, names made safe to
//! print, and path segments.

use std::io::Read;

/// The Unicode format characters (`\p{Cf}`, Unicode 17, as Node's regex knows them), which draw as
/// nothing yet can reorder or hide text.
const FORMAT: [(u32, u32); 21] = [
    (0xad, 0xad),
    (0x600, 0x605),
    (0x61c, 0x61c),
    (0x6dd, 0x6dd),
    (0x70f, 0x70f),
    (0x890, 0x891),
    (0x8e2, 0x8e2),
    (0x180e, 0x180e),
    (0x200b, 0x200f),
    (0x202a, 0x202e),
    (0x2060, 0x2064),
    (0x2066, 0x206f),
    (0xfeff, 0xfeff),
    (0xfff9, 0xfffb),
    (0x110bd, 0x110bd),
    (0x110cd, 0x110cd),
    (0x13430, 0x1343f),
    (0x1bca0, 0x1bca3),
    (0x1d173, 0x1d17a),
    (0xe0001, 0xe0001),
    (0xe0020, 0xe007f),
];

/// A name a browser chose, safe to write to a terminal: each control or format character a `?`.
pub(crate) fn printable(name: &str) -> String {
    name.chars()
        .map(|c| {
            let code = u32::from(c);
            let control = c.is_control();
            let format = FORMAT.iter().any(|&(from, to)| (from..=to).contains(&code));
            if control || format { '?' } else { c }
        })
        .collect()
}

/// A path segment as JavaScript's `encodeURIComponent` writes it.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte);
        if keep {
            out.push(char::from(byte));
        } else {
            let digit =
                |n: u8| char::from_digit(u32::from(n), 16).map_or('0', |c| c.to_ascii_uppercase());
            out.extend(['%', digit(byte >> 4), digit(byte & 0x0f)]);
        }
    }
    out
}

/// An age as a person reads it at a glance: its largest whole unit.
pub(crate) fn ago(seconds: u64) -> String {
    match seconds {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}

/// Whole seconds from a time on the wire to `now_ms`, never negative.
pub(crate) fn age_seconds(at: &str, now_ms: i64) -> u64 {
    let then = bazhen_protocol::time::timestamp_ms(at).unwrap_or(now_ms);
    u64::try_from((now_ms - then).max(0) / 1000).unwrap_or(0)
}

/// `bytes` in GiB to one decimal, rounded as JavaScript's `toFixed(1)` rounds: a tie upward, where
/// Rust's `{:.1}` would round it to even.
pub(crate) fn gib(bytes: u64) -> String {
    const GIB: u128 = 1 << 30;
    let tenths = (u128::from(bytes) * 20 + GIB) / (2 * GIB);
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// A time on the wire as the clock of this machine shows it, by a `strftime` pattern; the time as
/// it came when it can't be read.
pub(crate) fn local(at: &str, pattern: &str) -> String {
    let Some(ts) = bazhen_protocol::time::timestamp_ms(at)
        .and_then(|ms| jiff::Timestamp::from_millisecond(ms).ok())
    else {
        return at.to_owned();
    };
    ts.to_zoned(jiff::tz::TimeZone::system())
        .strftime(pattern)
        .to_string()
}

/// A fresh random UUID, as each command's idempotency key.
///
/// # Errors
///
/// When the system's random source can't be read.
pub(crate) fn uuid() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    let [
        b0,
        b1,
        b2,
        b3,
        b4,
        b5,
        b6,
        b7,
        b8,
        b9,
        b10,
        b11,
        b12,
        b13,
        b14,
        b15,
    ] = bytes;
    let b6 = (b6 & 0x0f) | 0x40;
    let b8 = (b8 & 0x3f) | 0x80;
    Ok(format!(
        "{b0:02x}{b1:02x}{b2:02x}{b3:02x}-{b4:02x}{b5:02x}-{b6:02x}{b7:02x}-{b8:02x}{b9:02x}-\
         {b10:02x}{b11:02x}{b12:02x}{b13:02x}{b14:02x}{b15:02x}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_a_gib_half_up_as_to_fixed_does() {
        let gib_bytes = 1u64 << 30;
        assert_eq!(gib(gib_bytes / 4), "0.3");
        assert_eq!(gib(gib_bytes * 31), "31.0");
        assert_eq!(gib(gib_bytes / 20 * 3 - 1), "0.1");
        assert_eq!(gib(0), "0.0");
    }

    #[test]
    fn encodes_a_path_segment_as_encode_uri_component_does() {
        assert_eq!(encode_uri_component("BZ-127"), "BZ-127");
        assert_eq!(encode_uri_component("a b/é?"), "a%20b%2F%C3%A9%3F");
        assert_eq!(encode_uri_component("!~*'()._"), "!~*'()._");
    }

    #[test]
    fn makes_control_and_format_characters_safe_to_print() {
        assert_eq!(
            printable("\u{1b}[2Jphone\u{200b}\u{e0041}\u{ad}é"),
            "?[2Jphone???é"
        );
    }

    #[test]
    fn says_an_age_by_its_largest_whole_unit() {
        let ages: Vec<String> = [0, 59, 60, 3599, 3600, 86_399, 86_400, 200_000]
            .into_iter()
            .map(ago)
            .collect();
        assert_eq!(ages, ["0s", "59s", "1m", "59m", "1h", "23h", "1d", "2d"]);
    }

    #[test]
    fn makes_a_version_4_uuid() {
        let id = uuid().unwrap();
        let groups: Vec<usize> = id.split('-').map(str::len).collect();
        assert_eq!(groups, [8, 4, 4, 4, 12]);
        assert_eq!(id.chars().nth(14), Some('4'));
        assert!("89ab".contains(id.chars().nth(19).unwrap()));
        assert_ne!(uuid().unwrap(), id);
    }
}
