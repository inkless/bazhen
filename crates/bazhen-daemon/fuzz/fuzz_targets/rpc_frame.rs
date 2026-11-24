#![no_main]

use bazhen_daemon::rpc::{Frame, Inbound, decode};
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as a harness's server could send them in a text frame: reading them never
// panics, and what is taken is a reply to an id the daemon could have sent, or a message of the
// server's own with a method.
fuzz_target!(|bytes: &[u8]| {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return;
    };
    match decode(text) {
        Some(Frame::Inbound(
            Inbound::Request { method, .. } | Inbound::Notification { method, .. },
        )) => {
            let value: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(value["method"], method.as_str());
        }
        Some(Frame::Reply { id, .. }) => {
            let value: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(value["id"].as_u64(), Some(id));
            assert!(value.get("method").is_none());
        }
        None => {}
    }
});
