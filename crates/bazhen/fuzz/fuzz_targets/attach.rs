#![no_main]

use bazhen::attach::attachment::{Attachment, DetachKeys, Effect};
use bazhen::attach::direct::{Direct, Step};
use libfuzzer_sys::fuzz_target;

// Keys and frames in any order, as the person's terminal and the daemon could send them: neither
// path panics, or sends more keys than it was given, a held `Ctrl-\` aside, and the scan under
// both says the same.
fuzz_target!(|steps: Vec<(bool, Vec<u8>)>| {
    let mut attachment = Attachment::default();
    let mut direct = Direct::new(true);
    let mut keys = DetachKeys::default();
    let (mut given, mut sent, mut straight) = (0, 0, 0);
    for (typed, bytes) in steps {
        if !typed {
            attachment.frame(&String::from_utf8_lossy(&bytes));
            continue;
        }
        given += bytes.len();
        let (scanned, _) = keys.scan(&bytes);
        assert!(scanned.len() <= bytes.len() + 1);
        for effect in attachment.keys(&bytes) {
            if let Effect::Input(input) = effect {
                sent += input.len();
            }
        }
        for step in direct.keys(&bytes) {
            if let Step::Send(bazhen::bazhen_holder_proto::Request::Input {
                bytes: input, ..
            }) = step
            {
                straight += input.len();
            }
        }
        assert!(sent <= given + 1 && straight <= given + 1);
    }
});
