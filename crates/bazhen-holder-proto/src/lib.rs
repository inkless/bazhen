//! `holder/1`: what the daemon and a `bazhen-holder` say over the holder's Unix socket, as
//! `packages/protocol/src/holder.ts` and `holder-frame.ts` define it. Those are the one source:
//! the fixtures they write to `packages/protocol/fixtures/holder/` hold this crate to them.
//!
//! Bytes ↔ values only, with no I/O. Three things a peer could send are refused here and accepted
//! there, and no conforming encoder sends any: an integer spelled as a float (`80.0`, `8e1`,
//! `-0`), a number past a double's range (`1e400`), even in a field nobody reads, and JSON nested
//! deeper than 128 levels.

pub mod body;
mod frame;
mod json;
mod version;

pub use frame::{
    EncodeError, FrameDecoder, MAX_REPLY_BYTES, MAX_REQUEST_BYTES, Malformed, Reply, Request,
    RequestId, reply_code, reply_decoder, request_code, request_decoder, request_name,
};
pub use version::{PROTOCOL_VERSION, Version, negotiate};

use body::{FrozenProtocol, SpawnSpec, Versions};
use thiserror::Error;

/// Why a holder won't start from a spawn spec.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SpawnSpecError {
    /// The daemon speaks no major this build does; the rest of the spec, in a schema this build
    /// doesn't know, is left unread.
    #[error("the daemon shares no major with this holder")]
    NoSharedVersion { protocol: Versions },
    #[error("invalid spawn spec: {0}")]
    Invalid(Malformed),
}

/// The spawn spec a holder reads from its stdin: `protocol` first, which is frozen, then the rest
/// in this build's schema. The holder bounds what it reads; a spec fits in `MAX_REQUEST_BYTES`.
///
/// # Errors
///
/// `NoSharedVersion` when the daemon's versions share no major with this build, `Invalid` when
/// the spec isn't one.
pub fn decode_spawn_spec(bytes: &[u8]) -> Result<SpawnSpec, SpawnSpecError> {
    let invalid = |e: serde_json::Error| SpawnSpecError::Invalid(Malformed::new(e.to_string()));
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(invalid)?;
    let frozen: FrozenProtocol = json::from_ref(&value).map_err(invalid)?;
    if !version::speaks(&frozen.protocol.texts()) {
        return Err(SpawnSpecError::NoSharedVersion {
            protocol: frozen.protocol,
        });
    }
    json::from_value(value).map_err(invalid)
}
