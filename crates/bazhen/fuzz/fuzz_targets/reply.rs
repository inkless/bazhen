#![no_main]

use bazhen::bazhen_protocol::agents::StateSnapshot;
use bazhen::reply::{LIMITS, Unread, decode};
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as the daemon's socket could send them: decoding a snapshot or a doctor's
// answer never panics, and a refusal carries the body it refused, which is never longer than what
// came.
fuzz_target!(|response: &[u8]| {
    let decoded: Result<StateSnapshot, Unread> = decode(response, LIMITS);
    match decoded {
        Ok(_) | Err(Unread::Garbled) => {}
        Err(Unread::Refused { body, .. }) => assert!(body.len() <= response.len() * 3),
    }
});
