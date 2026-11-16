#![no_main]

use bazhen_protocol::input::has_keystrokes;
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as a person's terminal could send them: reading them never panics, and four
// plain letters after them are a keystroke whatever came before: an X10 mouse report takes three
// bytes of any kind, and nothing else a reply or report holds is a letter.
fuzz_target!(|input: &[u8]| {
    let typed = has_keystrokes(input);
    let mut more = input.to_vec();
    more.extend_from_slice(b"qqqq");
    assert!(has_keystrokes(&more));
    if input.is_empty() {
        assert!(!typed);
    }
});
