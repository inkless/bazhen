//! An attention item's lifecycle, as packages/core's attention.ts has it: every close is final,
//! so an answer that arrives after any of them is refused rather than applied to a request that
//! no longer exists.

use bazhen_protocol::mail::{AttentionCloseReason, AttentionState};

use crate::machine::InvalidTransition;

/// The state closing an item in `from` for `reason` leads to.
///
/// # Errors
///
/// [`InvalidTransition`] when the item is already closed.
pub fn next(
    from: AttentionState,
    reason: AttentionCloseReason,
) -> Result<AttentionState, InvalidTransition> {
    match from {
        AttentionState::Open => Ok(AttentionState::Closed),
        AttentionState::Closed => Err(InvalidTransition {
            machine: "attention item",
            from: from.as_str(),
            event: reason.as_str(),
        }),
    }
}

/// Whether `from` can still be closed.
pub fn accepts(from: AttentionState) -> bool {
    from == AttentionState::Open
}
