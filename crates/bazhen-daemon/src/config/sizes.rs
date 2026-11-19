//! The memory and swap caps `terminals` takes, as `packages/host-guard/src/scope.ts` checks them:
//! bytes with an optional K, M, G or T, a whole percentage of RAM, or `infinity`.

/// The least a memory cap may be: below it a terminal's own shell and holder can't start.
const MIN_MEMORY_MAX: u128 = 64 * 1024 * 1024;
/// The largest integer JavaScript holds exactly, past which `sizeBytes` takes no size.
const MAX_SAFE_INTEGER: u128 = 9_007_199_254_740_991;

/// A size in bytes, as `<n>[K|M|G|T]` gives it, or `None` for anything else or for more bytes
/// than JavaScript holds exactly.
fn size_bytes(text: &str) -> Option<u128> {
    let (digits, unit) = match text.strip_suffix(['K', 'M', 'G', 'T']) {
        Some(digits) => (digits, text.get(digits.len()..)?),
        None => (text, ""),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let shift = match unit {
        "K" => 10,
        "M" => 20,
        "G" => 30,
        "T" => 40,
        _ => 0,
    };
    // Digits past u128 are past JavaScript's safe integers too.
    let bytes = digits.parse::<u128>().ok()?.checked_mul(1 << shift)?;
    (bytes <= MAX_SAFE_INTEGER).then_some(bytes)
}

/// A whole percentage from 1 to 100, as `<n>%` gives it with one to three digits.
fn is_percentage(text: &str) -> bool {
    text.strip_suffix('%').is_some_and(|digits| {
        (1..=3).contains(&digits.len())
            && digits.bytes().all(|b| b.is_ascii_digit())
            && digits.parse::<u8>().is_ok_and(|p| (1..=100).contains(&p))
    })
}

/// Why `value` can't cap a terminal's memory, or all terminals', or `None` when it can: bytes of
/// at least 64M, a whole percentage of RAM from 1 to 100, or `infinity`.
pub(super) fn memory_max_refusal(value: &str) -> Option<&'static str> {
    if value == "infinity" || is_percentage(value) {
        return None;
    }
    match size_bytes(value) {
        None => Some(
            "must be bytes with an optional K, M, G or T, a whole percentage from 1% to 100%, or infinity",
        ),
        Some(bytes) if bytes < MIN_MEMORY_MAX => {
            Some("must be at least 64M, or a terminal can't start")
        }
        Some(_) => None,
    }
}

/// Why `value` can't cap a terminal's swap, or `None` when it can: bytes, 0 included, or
/// `infinity`.
pub(super) fn swap_max_refusal(value: &str) -> Option<&'static str> {
    if value == "infinity" || size_bytes(value).is_some() {
        None
    } else {
        Some("must be bytes with an optional K, M, G or T, 0 for none, or infinity")
    }
}
