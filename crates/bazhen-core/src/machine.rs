//! What a machine says when it is handed an event its state doesn't take.

/// An event `from` doesn't accept, named as packages/core's `InvalidTransition` names it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{machine} cannot handle {event} while {from}")]
pub struct InvalidTransition {
    pub machine: &'static str,
    pub from: &'static str,
    pub event: &'static str,
}
