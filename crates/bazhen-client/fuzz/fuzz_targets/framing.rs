#![no_main]

use bazhen_client::Limits;
use bazhen_client::framing::{
    Framing, body, content_length, header, headers, is_truncated, reply_end, split_head, status,
};
use libfuzzer_sys::fuzz_target;

// Small limits, so the fuzzer reaches both refusals: a head and a body over them.
const LIMITS: Limits = Limits {
    head: 256,
    body: 1024,
    chunked: true,
};

// Any bytes at all, as the daemon's socket could send them: no decoder may panic, what the reader
// stops at it still sees end there, a response that ends isn't taken for cut short, and a reader
// that got the bytes in two reads, split where the first byte says, stops where one that got them
// whole does. The head parsers are driven on the same bytes read as text, as a head would reach
// them.
fuzz_target!(|response: &[u8]| {
    let end = reply_end(response, LIMITS);
    assert_eq!(is_truncated(response, LIMITS), end.is_none());
    if let Some(end) = end {
        assert!(end <= response.len());
        assert_eq!(reply_end(&response[..end], LIMITS), Some(end));
    }
    let split = usize::from(response.first().copied().unwrap_or(0)) * response.len() / 256;
    let mut framing = Framing::new(LIMITS);
    let first = framing.end_of(&response[..split]);
    assert_eq!(first, reply_end(&response[..split], LIMITS));
    if first.is_none() {
        assert_eq!(framing.end_of(response), end);
    }
    if let Some(end) = end {
        let _ = body(&response[..end], LIMITS);
    }
    if let Some((head, body)) = split_head(response) {
        assert!(head.len() + 4 + body.len() == response.len());
        let _ = status(head);
    }
    if let Ok(head) = std::str::from_utf8(response) {
        let length = header(head, "Content-Length")
            .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|v| v.parse().ok());
        assert_eq!(content_length(head), length);
        let lengths = headers(head, "Content-Length").count();
        assert!(lengths == 1 || header(head, "Content-Length").is_none());
    }
});
