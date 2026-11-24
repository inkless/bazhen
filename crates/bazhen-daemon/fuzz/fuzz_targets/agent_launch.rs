#![no_main]

use bazhen_daemon::agent_launch::launch_request;
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as a body POST /v1/agents could be sent: reading them never panics, and a
// launch taken holds to its schema's rules beyond its shape.
fuzz_target!(|bytes: &[u8]| {
    if let Ok(req) = launch_request(bytes) {
        assert!((1..=200).contains(&req.idempotency_key.encode_utf16().count()));
        assert!(!req.cwd.is_empty());
        assert_ne!(req.project.as_deref(), Some(""));
        assert!(
            req.compact_window_tokens
                .is_none_or(|tokens| (100_000..=10_000_000).contains(&tokens))
        );
    }
});
