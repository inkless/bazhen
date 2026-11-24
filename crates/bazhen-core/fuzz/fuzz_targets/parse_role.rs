#![no_main]

use bazhen_core::role_file::{FILE_MAX, PROMPT_MAX, RoleSource, parse_role};
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as a user's role file could hold them: parse_role never panics, and a role it
// reads has a title of 1 to 80 code points with no space at either end, and a prompt of 1 to
// PROMPT_MAX UTF-16 units. The same bytes behind a front matter opening reach the YAML reader,
// which most random bytes otherwise don't.
fuzz_target!(|bytes: &[u8]| {
    if bytes.len() > FILE_MAX {
        return;
    }
    let mut framed = b"---\n".to_vec();
    framed.extend_from_slice(bytes);
    for text in [bytes, framed.as_slice()] {
        if let Ok(role) = parse_role("tester", text, RoleSource::User) {
            let title = role.title.chars().count();
            assert!((1..=80).contains(&title));
            assert_eq!(role.title.trim(), role.title);
            let prompt = role.prompt.encode_utf16().count();
            assert!((1..=PROMPT_MAX).contains(&prompt));
        }
    }
});
