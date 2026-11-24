//! A mailbox message's delivery, and how Bazhen labels a message to an agent, as packages/core's
//! mailbox.ts has them. Delivery is at least once; a delivered message is final, so it is never
//! offered again.

use bazhen_protocol::mail::MailboxState;

use crate::machine::InvalidTransition;

/// - `Offer`: a waiter or a `PostToolUse` hook takes the message; `Ack`: the hook client wrote it.
/// - `Seen`: a wake's `UserPromptSubmit` carried its id; `Confirm`: the receiving turn's Stop, or,
///   for Codex, the turn that carries its label. A wake held back (a dialog open in the TUI) can
///   land after its message went back to the queue or out again: its prompt still means the agent
///   has it, so it is seen from those states too, and never offered again.
/// - `Accept`: `codex queue` stored it; only the turn that carries it delivers it, and that turn
///   may start before the queue command has returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailboxEvent {
    Offer,
    Ack,
    Seen,
    Confirm,
    Accept,
    Requeue,
    GiveUp,
    AgentClosed,
}

impl MailboxEvent {
    pub const ALL: [Self; 8] = [
        Self::Offer,
        Self::Ack,
        Self::Seen,
        Self::Confirm,
        Self::Accept,
        Self::Requeue,
        Self::GiveUp,
        Self::AgentClosed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offer => "offer",
            Self::Ack => "ack",
            Self::Seen => "seen",
            Self::Confirm => "confirm",
            Self::Accept => "accept",
            Self::Requeue => "requeue",
            Self::GiveUp => "give_up",
            Self::AgentClosed => "agent_closed",
        }
    }
}

fn to(from: MailboxState, event: MailboxEvent) -> Option<MailboxState> {
    use MailboxEvent as E;
    use MailboxState as S;
    Some(match (from, event) {
        (S::Queued, E::Offer) => S::Offered,
        (S::Queued, E::Accept) => S::QueuedInCodex,
        (S::Queued | S::Emitted | S::Seen | S::QueuedInCodex, E::Confirm) => S::Delivered,
        (S::Queued | S::Offered | S::Emitted, E::Seen) => S::Seen,
        (S::Queued, E::GiveUp)
        | (S::Queued | S::Offered | S::Emitted | S::Seen | S::QueuedInCodex, E::AgentClosed) => {
            S::Undeliverable
        }
        (S::Offered, E::Ack) => S::Emitted,
        (S::Offered | S::Emitted | S::Seen, E::Requeue) => S::Queued,
        _ => return None,
    })
}

/// The state `event` leads to.
///
/// # Errors
///
/// [`InvalidTransition`] when `from` doesn't take `event`.
pub fn next(from: MailboxState, event: MailboxEvent) -> Result<MailboxState, InvalidTransition> {
    to(from, event).ok_or(InvalidTransition {
        machine: "mailbox message",
        from: from.as_str(),
        event: event.as_str(),
    })
}

/// Whether `from` takes `event`.
pub fn accepts(from: MailboxState, event: MailboxEvent) -> bool {
    to(from, event).is_some()
}

/// A state that takes no event is final.
pub fn is_final(state: MailboxState) -> bool {
    MailboxEvent::ALL.iter().all(|&e| to(state, e).is_none())
}

const LABEL_PREFIX: &str = "Message for you from Bazhen (";

/// How Bazhen introduces a message to an agent. A harness confirms a message by finding its label
/// in the turn that took it, so a label must only ever be one Bazhen wrote: see [`quote_labels`].
pub fn mail_label(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}):")
}

/// A body as an agent reads it, with every label it quotes marked as a quote. Marking the prefix
/// rather than whole labels catches every label whatever id it names, so a quoted one can't
/// confirm another message. The stored body keeps what was written.
pub fn quote_labels(body: &str) -> String {
    body.replace(LABEL_PREFIX, "Message for you from Bazhen [quoted] (")
}

/// The id of the message `text` starts with, labelled as Bazhen labels it: `msg_`, then ASCII
/// letters and digits, then `):` and a newline.
pub fn leading_mail_id(text: &str) -> Option<&str> {
    let (id, _) = text.strip_prefix(LABEL_PREFIX)?.split_once("):\n")?;
    let tail = id.strip_prefix("msg_")?;
    (!tail.is_empty() && tail.bytes().all(|b| b.is_ascii_alphanumeric())).then_some(id)
}
