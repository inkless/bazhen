#![no_main]

use bazhen_peer::tcp::{End, TIME_WAIT, end_of, row, socket_inode};
use libfuzzer_sys::fuzz_target;

// Any bytes, as `/proc/net/tcp` or `tcp6` could hold them, or as a `/proc/<pid>/fd/<n>` link could
// read: no reader may panic. A line's leading blanks and any fields after the inode never change
// the row read from it, and a row read from a line is its own connection's end unless it is a
// leftover. A link names an inode only as `socket:[<inode>]`.
fuzz_target!(|data: &[u8]| {
    if let Some(inode) = socket_inode(data) {
        assert!(data.starts_with(b"socket:[") && data.ends_with(b"]"));
        assert_eq!(
            socket_inode(format!("socket:[{inode}]").as_bytes()),
            Some(inode)
        );
    }
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    for line in text.lines() {
        let Some(read) = row(line) else {
            continue;
        };
        assert_eq!(row(&format!("  {line}")), Some(read));
        assert_eq!(row(&format!("{line} 0 0")), Some(read));
        let end = if read.state == TIME_WAIT || read.inode == 0 {
            End::Gone
        } else {
            End::Live {
                uid: read.uid,
                inode: read.inode,
            }
        };
        assert_eq!(end_of([read], read.local, read.remote), end);
    }
});
