#![no_main]

use bazhen_daemon::said::{MAX_TOKEN, Said, read};
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as a view could send them in a stream's text frame: reading them never
// panics, and what is taken holds to what a view may ask for, its size 2 to 1000 columns and
// rows, and its resume token no longer than the cap.
fuzz_target!(|bytes: &[u8]| {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return;
    };
    let fits = |n: u64| (2..=1000).contains(&n);
    match read(text) {
        Some(Said::Hello { size, resumes, .. }) => {
            assert!(fits(size.cols.get()) && fits(size.rows.get()));
            assert!(resumes.is_none_or(|r| r.token.encode_utf16().count() <= MAX_TOKEN));
        }
        Some(Said::Resize(size)) => assert!(fits(size.cols.get()) && fits(size.rows.get())),
        Some(Said::Engage | Said::Epoch(_) | Said::Ping) | None => {}
    }
});
