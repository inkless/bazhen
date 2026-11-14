#![no_main]

use bazhen_hook::pane_title::body;
use libfuzzer_sys::fuzz_target;

// A pane id arrives from tmux as text and is written into JSON without escaping, so whatever body
// accepts must need none: no quote, backslash or control character can reach the request.
fuzz_target!(|pane: &str| {
    if let Some(json) = body(pane) {
        assert!(
            !pane
                .chars()
                .any(|c| c == '"' || c == '\\' || c.is_control()),
            "{pane:?}"
        );
        assert_eq!(json, format!("{{\"pane\":\"{pane}\"}}").into_bytes());
    }
});
