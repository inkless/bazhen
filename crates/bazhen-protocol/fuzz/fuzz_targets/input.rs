#![no_main]

use bazhen_protocol::input::{has_keystrokes, without_replies};
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
    // What reaches the program is what the view sent, in order, less what began with an escape:
    // without one it is all kept, text before the first is kept as it is, and letters after it,
    // which end no reply, change nothing before them.
    let kept = without_replies(input);
    let mut left = input.iter();
    assert!(kept.iter().all(|b| left.any(|i| i == b)));
    assert_eq!(without_replies(&more), [kept.as_slice(), b"qqqq"].concat());
    let plain = input.iter().position(|&b| b == 0x1b).unwrap_or(input.len());
    let (text, rest) = input.split_at(plain);
    assert_eq!(
        without_replies(input),
        [text, &without_replies(rest)].concat()
    );
});
