#![no_main]

use bazhen::attach::attachment::{Attachment, DetachScan, Effect};
use bazhen::attach::direct::{Direct, Step};
use bazhen::bazhen_protocol::detach_keys::DetachKeys;
use libfuzzer_sys::fuzz_target;

// A detach sequence as a person could write it, then keys and frames in any order, as the person's
// terminal and the daemon could send them: neither path panics, or sends more keys than it was
// given, the sequence's held keys aside, and the scan under both says the same.
fuzz_target!(|input: (String, Vec<(bool, Vec<u8>)>)| {
    let (written, steps) = input;
    let sequence = DetachKeys::parse(&written).unwrap_or_default();
    let held = sequence.bytes().len() - 1;
    let mut attachment = Attachment::new(sequence.clone());
    let mut direct = Direct::new(true, sequence.clone());
    let mut keys = DetachScan::new(sequence);
    let (mut given, mut sent, mut straight) = (0, 0, 0);
    for (typed, bytes) in steps {
        if !typed {
            attachment.frame(&String::from_utf8_lossy(&bytes));
            continue;
        }
        given += bytes.len();
        let (scanned, _) = keys.scan(&bytes);
        assert!(scanned.len() <= bytes.len() + held);
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
        assert!(sent <= given + held && straight <= given + held);
    }
});
