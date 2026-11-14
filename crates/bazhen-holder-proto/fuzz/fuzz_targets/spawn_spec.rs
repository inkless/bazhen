#![no_main]

use bazhen_holder_proto::decode_spawn_spec;
use libfuzzer_sys::fuzz_target;

// Any bytes, as a holder's stdin could hold them: the reader may not panic, and a spec it accepts
// encodes back to JSON it reads as the same spec.
fuzz_target!(|data: &[u8]| {
    if let Ok(spec) = decode_spawn_spec(data) {
        let json = serde_json::to_vec(&spec).expect("an accepted spec encodes");
        assert_eq!(decode_spawn_spec(&json).ok(), Some(spec));
    }
});
