use std::collections::BTreeMap;
use std::fmt;

use crate::body::MAX_SAFE_INTEGER;

/// The version this build speaks. Within a major, changes are additive only, and the minor is
/// bumped with any addition.
pub const PROTOCOL_VERSION: &str = "1.0";

/// A `major.minor` version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
}

impl Version {
    /// `major.minor` in ASCII digits, each part a safe integer as the TypeScript peer reads it; a
    /// part too long for one is no version, rather than another number.
    pub fn parse(text: &str) -> Option<Self> {
        let (major, minor) = text.split_once('.')?;
        Some(Self {
            major: safe_part(major)?,
            minor: safe_part(minor)?,
        })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

fn safe_part(part: &str) -> Option<u64> {
    if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    part.parse().ok().filter(|n| *n <= MAX_SAFE_INTEGER)
}

fn top_minors<S: AsRef<str>>(versions: &[S]) -> BTreeMap<u64, u64> {
    let mut tops = BTreeMap::new();
    for version in versions.iter().filter_map(|v| Version::parse(v.as_ref())) {
        let top = tops.entry(version.major).or_insert(version.minor);
        *top = (*top).max(version.minor);
    }
    tops
}

/// The version two peers both speak: the highest major they share, at the lower of their two
/// minors in it. `None` when they share no major. An entry that isn't a version is skipped.
pub fn negotiate<A: AsRef<str>, B: AsRef<str>>(ours: &[A], theirs: &[B]) -> Option<Version> {
    let ours = top_minors(ours);
    let theirs = top_minors(theirs);
    ours.iter().rev().find_map(|(major, minor)| {
        theirs.get(major).map(|their| Version {
            major: *major,
            minor: (*minor).min(*their),
        })
    })
}

/// True when this build shares a major with `theirs`.
pub(crate) fn speaks<B: AsRef<str>>(theirs: &[B]) -> bool {
    negotiate(&[PROTOCOL_VERSION], theirs).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agreed(ours: &[&str], theirs: &[&str]) -> Option<String> {
        negotiate(ours, theirs).map(|v| v.to_string())
    }

    #[test]
    fn agrees_on_the_highest_shared_major_at_the_lower_minor() {
        assert_eq!(
            agreed(&["1.4", "2.3"], &["1.9", "2.1"]).as_deref(),
            Some("2.1")
        );
        assert_eq!(agreed(&["1.2"], &["1.4"]).as_deref(), Some("1.2"));
    }

    #[test]
    fn reads_leading_zeros_as_the_number_and_prints_it_plainly() {
        assert_eq!(agreed(&["1.0"], &["01.07"]).as_deref(), Some("1.0"));
    }

    #[test]
    fn skips_a_part_past_the_largest_safe_integer() {
        assert_eq!(
            Version::parse("1.9007199254740991").map(|v| v.minor),
            Some(MAX_SAFE_INTEGER)
        );
        assert_eq!(Version::parse("1.9007199254740992"), None);
    }

    #[test]
    fn refuses_anything_but_digits_dot_digits() {
        for text in ["1", "1.", ".1", "1.0.0", "-1.0", "1.0 ", "+1.0", "١.٠"] {
            assert_eq!(Version::parse(text), None, "{text}");
        }
    }
}
