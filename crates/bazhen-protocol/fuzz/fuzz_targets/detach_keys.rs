#![no_main]

use bazhen_protocol::detach_keys::{DETACH_KEYS_MAX, DetachKeys};
use libfuzzer_sys::fuzz_target;

// Any text, as a flag or config.toml could give it: reading it never panics, and a sequence it
// names has 1 to DETACH_KEYS_MAX keys, doesn't start with Escape, and shows one word per key.
fuzz_target!(|text: &str| {
    if let Ok(keys) = DetachKeys::parse(text) {
        let bytes = keys.bytes();
        assert!((1..=DETACH_KEYS_MAX).contains(&bytes.len()) && bytes[0] != 0x1b);
        assert_eq!(keys.to_string().split(' ').count(), bytes.len());
    }
});
