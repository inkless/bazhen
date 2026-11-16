#![no_main]

use bazhen::attach::attachment::{Attachment, Effect};
use libfuzzer_sys::fuzz_target;

// Keys and frames in any order, as the person's terminal and the daemon could send them: the
// attachment never panics, and never sends more keys than it was given, a held `Ctrl-\` aside.
fuzz_target!(|steps: Vec<(bool, Vec<u8>)>| {
    let mut attachment = Attachment::default();
    let mut given = 0;
    let mut sent = 0;
    for (keys, bytes) in steps {
        let effects = if keys {
            given += bytes.len();
            attachment.keys(&bytes)
        } else {
            attachment.frame(&String::from_utf8_lossy(&bytes))
        };
        for effect in effects {
            if let Effect::Input(typed) = effect {
                sent += typed.len();
            }
        }
        assert!(sent <= given + 1);
    }
});
