#![no_main]

use bazhen_holder::rss::resident_pages;
use bazhen_holder::session::member_state;
use bazhen_holder::start_time::{boot_time, epoch_seconds, start_ticks, stat_field};
use libfuzzer_sys::fuzz_target;

// Any bytes, as `/proc/<pid>/stat` could hold them once a program names itself, or as
// `/proc/self/statm` could: no reader may panic, and what precedes the last `)` never changes the
// start or any field, as a name in front of it can't.
fuzz_target!(|data: &[u8]| {
    let ticks = start_ticks(data);
    let named = [b"1 (any) name".as_slice(), data].concat();
    if data.contains(&b')') {
        assert_eq!(start_ticks(&named), ticks);
    }
    for n in 0..64 {
        let field = stat_field(data, n);
        if data.contains(&b')') {
            assert_eq!(stat_field(&named, n), field);
        }
    }
    let state = member_state(data, 42);
    if data.contains(&b')') {
        assert_eq!(member_state(&named, 42), state);
    }
    let _ = boot_time(data);
    let _ = epoch_seconds(data, data, 100);
    let _ = resident_pages(data);
});
