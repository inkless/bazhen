//! Framing: a u32 big-endian length of what follows, a u8 kind, then the payload.

pub(crate) const MAX_INBOUND: usize = 1 << 20;

pub(crate) mod kind {
    pub(crate) const HELLO: u8 = 0x01;
    pub(crate) const SNAPSHOT: u8 = 0x02;
    pub(crate) const SUBSCRIBE: u8 = 0x03;
    pub(crate) const INPUT: u8 = 0x04;
    pub(crate) const RESIZE: u8 = 0x05;
    pub(crate) const STATS: u8 = 0x06;
    pub(crate) const CLOSE: u8 = 0x07;

    pub(crate) const R_HELLO: u8 = 0x81;
    pub(crate) const R_SNAPSHOT: u8 = 0x82;
    pub(crate) const R_DATA: u8 = 0x83;
    pub(crate) const R_GAP: u8 = 0x84;
    pub(crate) const R_STATS: u8 = 0x85;
    pub(crate) const R_EXITED: u8 = 0x86;
    pub(crate) const R_ERROR: u8 = 0x87;
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decoded<'a> {
    Frame {
        kind: u8,
        payload: &'a [u8],
        consumed: usize,
    },
    Incomplete,
    Invalid(&'static str),
}

pub(crate) fn decode(buf: &[u8], max: usize) -> Decoded<'_> {
    let Some((len, rest)) = buf.split_first_chunk::<4>() else {
        return Decoded::Incomplete;
    };
    let Ok(len) = usize::try_from(u32::from_be_bytes(*len)) else {
        return Decoded::Invalid("length does not fit");
    };
    if len == 0 {
        return Decoded::Invalid("empty frame");
    }
    if len > max {
        return Decoded::Invalid("frame over the length cap");
    }
    let Some((body, _)) = rest.split_at_checked(len) else {
        return Decoded::Incomplete;
    };
    match body.split_first() {
        Some((&kind, payload)) => Decoded::Frame {
            kind,
            payload,
            consumed: 4 + len,
        },
        None => Decoded::Invalid("empty frame"),
    }
}

pub(crate) fn encode(out: &mut Vec<u8>, kind: u8, parts: &[&[u8]]) {
    let len: usize = 1 + parts.iter().map(|p| p.len()).sum::<usize>();
    out.extend_from_slice(&u32::try_from(len).unwrap_or(u32::MAX).to_be_bytes());
    out.push(kind);
    for part in parts {
        out.extend_from_slice(part);
    }
}

pub(crate) fn encode_at(out: &mut Vec<u8>, kind: u8, offset: u64, bytes: &[u8]) {
    encode(out, kind, &[&offset.to_be_bytes(), bytes]);
}

pub(crate) fn decode_u64(payload: &[u8]) -> Option<u64> {
    payload.first_chunk::<8>().map(|b| u64::from_be_bytes(*b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_round_trips_and_every_truncation_is_incomplete() {
        let mut out = Vec::new();
        encode_at(&mut out, kind::R_DATA, 7, b"hello");
        for cut in 0..out.len() {
            assert_eq!(
                decode(&out[..cut], MAX_INBOUND),
                Decoded::Incomplete,
                "cut {cut}"
            );
        }
        let Decoded::Frame {
            kind,
            payload,
            consumed,
        } = decode(&out, MAX_INBOUND)
        else {
            panic!("whole frame did not decode");
        };
        assert_eq!((kind, consumed), (kind::R_DATA, out.len()));
        assert_eq!(decode_u64(payload), Some(7));
        assert_eq!(&payload[8..], b"hello");
    }

    #[test]
    fn an_oversized_or_empty_frame_is_invalid() {
        assert!(matches!(decode(&[0, 0, 0, 0, 1], 16), Decoded::Invalid(_)));
        assert!(matches!(decode(&[0, 0, 1, 0, 1], 16), Decoded::Invalid(_)));
    }
}
