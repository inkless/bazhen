#![no_main]

use std::fmt::Debug;

use bazhen_holder_proto::{
    EncodeError, FrameDecoder, Reply, Request, reply_decoder, request_decoder,
};
use libfuzzer_sys::fuzz_target;

// Any bytes, as a connection could read them, cut where the first byte says, into each decoder.
// Neither may panic; every frame one returns re-encodes to bytes that decode to the same frame,
// unless it is of a type this build doesn't know, which has nothing to encode; and once a
// decoder refuses a frame it refuses everything after.
fuzz_target!(|data: &[u8]| {
    let Some((cut, stream)) = data.split_first() else {
        return;
    };
    let (head, tail) = stream.split_at(usize::from(*cut).min(stream.len()));
    drive(request_decoder, Request::encode, head, tail);
    drive(reply_decoder, Reply::encode, head, tail);
});

fn drive<F: PartialEq + Debug>(
    decoder: fn() -> FrameDecoder<F>,
    encode: fn(&F) -> Result<Vec<u8>, EncodeError>,
    head: &[u8],
    tail: &[u8],
) {
    let mut frames = decoder();
    for chunk in [head, tail] {
        frames.push(chunk);
        loop {
            match frames.next_frame() {
                Ok(Some(frame)) => round_trip(decoder, encode, &frame),
                Ok(None) => break,
                Err(_) => {
                    frames.push(b"\0\0\0\x05\x43\0\0\0\0");
                    assert!(frames.next_frame().is_err());
                    return;
                }
            }
        }
    }
}

fn round_trip<F: PartialEq + Debug>(
    decoder: fn() -> FrameDecoder<F>,
    encode: fn(&F) -> Result<Vec<u8>, EncodeError>,
    frame: &F,
) {
    let bytes = match encode(frame) {
        Ok(bytes) => bytes,
        Err(EncodeError::Unknown(_)) => return,
        Err(e) => panic!("{frame:?} decoded but doesn't encode: {e}"),
    };
    let mut again = decoder();
    again.push(&bytes);
    assert_eq!(again.next_frame().ok().flatten().as_ref(), Some(frame));
}
