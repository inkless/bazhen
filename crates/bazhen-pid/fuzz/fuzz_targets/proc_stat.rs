#![no_main]

use bazhen_pid::stat::{has_exited, own_pid, parent_field, session_field, start_ticks, stat_field};
use libfuzzer_sys::fuzz_target;

// Any bytes, as `/proc/<pid>/stat` could hold them once a program names itself: no reader may
// panic, and what precedes the last `)` never changes the start or any field, as a name in front of
// it can't. The pid is the first token, whatever follows.
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
    let (parent, session, exited) = (parent_field(data), session_field(data), has_exited(data));
    if data.contains(&b')') {
        assert_eq!(
            (
                parent_field(&named),
                session_field(&named),
                has_exited(&named)
            ),
            (parent, session, exited)
        );
    }
    assert_eq!(own_pid(&[b"7 ".as_slice(), data].concat()), Some(7));
    let _ = own_pid(data);
});
