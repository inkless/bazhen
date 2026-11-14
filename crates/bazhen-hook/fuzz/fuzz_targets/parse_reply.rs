#![no_main]

use bazhen_hook::{content_length, header, is_truncated, parse_reply, promised_end};
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as the daemon's socket could send them: no decoder may panic, and a reply
// parse_reply accepts is one the reader saw end where it does, and didn't take for cut short.
// The header parsers are driven on the same bytes read as text, as a head would reach them.
fuzz_target!(|response: &[u8]| {
    let reply = parse_reply(response);
    let end = promised_end(response);
    let truncated = is_truncated(response);
    if reply.is_some() {
        assert_eq!(end, Some(response.len()));
        assert!(!truncated);
    }
    if let Ok(head) = std::str::from_utf8(response) {
        let length = header(head, "Content-Length").and_then(|v| v.parse().ok());
        assert_eq!(content_length(head), length);
    }
});
