#![no_main]

use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::wire::{from_slice, well_formed};
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as a daemon's answer could hold them: nothing panics, making text well formed
// twice changes nothing more, and a snapshot decodes from it or fails on its shape, never on a
// string's surrogates, so text once made well formed decodes the same again.
fuzz_target!(|json: &[u8]| {
    let once = well_formed(json);
    assert_eq!(well_formed(&once), once);
    let first: Result<StateSnapshot, _> = from_slice(json);
    let again: Result<StateSnapshot, _> = from_slice(&once);
    assert_eq!(first.ok(), again.ok());
});
