#![no_main]

use bazhen_hook::framing::{Framing, content_length, header, is_truncated, reply_end};
use bazhen_hook::{LIMITS, parse_reply};
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as the daemon's socket could send them: no decoder may panic, a reply
// parse_reply accepts is one the reader saw end where it does, and didn't take for cut short,
// what the reader stops at it still sees end there, and a reader that got the bytes in two reads,
// split where the first byte says, stops where one that got them whole does.
// The header parsers are driven on the same bytes read as text, as a head would reach them.
fuzz_target!(|response: &[u8]| {
    let reply = parse_reply(response);
    let end = reply_end(response, LIMITS);
    let truncated = is_truncated(response, LIMITS);
    if reply.is_some() {
        assert_eq!(end, Some(response.len()));
        assert!(!truncated);
    }
    if let Some(end) = end {
        assert_eq!(reply_end(&response[..end], LIMITS), Some(end));
    }
    let split = usize::from(response.first().copied().unwrap_or(0)) * response.len() / 256;
    let mut framing = Framing::new(LIMITS);
    let first = framing.end_of(&response[..split]);
    assert_eq!(first, reply_end(&response[..split], LIMITS));
    if first.is_none() {
        assert_eq!(framing.end_of(response), end);
    }
    if let Ok(head) = std::str::from_utf8(response) {
        let length = header(head, "Content-Length")
            .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|v| v.parse().ok());
        assert_eq!(content_length(head), length);
    }
});
