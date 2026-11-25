#![no_main]

use bazhen_daemon::failure::{DETAIL_MAX, failure_detail};
use libfuzzer_sys::fuzz_target;
use unicode_segmentation::UnicodeSegmentation;

// Any text at all, as a failure from tmux or a holder could hold it: answering with it never
// panics, and the answer is cut to the clusters a person counts. Not run twice to the same
// answer, as TypeScript's isn't: an unquoted value runs to 512 units, so `api_key=` and 600
// more takes a second `[redacted]` the second time.
fuzz_target!(|bytes: &[u8]| {
    if let Ok(text) = std::str::from_utf8(bytes) {
        let detail = failure_detail(text);
        assert!(detail.graphemes(true).count() <= DETAIL_MAX, "{detail:?}");
    }
});
