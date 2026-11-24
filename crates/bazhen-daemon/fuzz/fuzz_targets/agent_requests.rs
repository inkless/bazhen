#![no_main]

use bazhen_daemon::agent_requests::{launch_request, rename_request};
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as a body POST /v1/agents or POST /v1/agents/:id/rename could be sent:
// reading them never panics, and a request taken holds to its schema's rules beyond its shape.
fuzz_target!(|bytes: &[u8]| {
    let key = |key: &str| (1..=200).contains(&key.encode_utf16().count());
    if let Ok(req) = launch_request(bytes) {
        assert!(key(&req.idempotency_key));
        assert!(!req.cwd.is_empty());
        assert_ne!(req.project.as_deref(), Some(""));
        assert!(
            req.compact_window_tokens
                .is_none_or(|tokens| (100_000..=10_000_000).contains(&tokens))
        );
    }
    if let Ok(req) = rename_request(bytes) {
        assert!(key(&req.idempotency_key));
    }
});
