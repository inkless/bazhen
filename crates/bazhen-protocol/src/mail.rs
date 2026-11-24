//! Mail between agents, its states, and the items agents raise for the human.

use serde::{Deserialize, Serialize};

use crate::ids::{AgentId, AttentionId, MessageId, ObservedId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailboxState {
    Queued,
    Offered,
    Emitted,
    Seen,
    QueuedInCodex,
    Delivered,
    Undeliverable,
}

impl MailboxState {
    /// Where a waiting sender stops: the agent has the message in a prompt it read, or will never
    /// get it.
    pub fn settled(self) -> bool {
        matches!(self, Self::Seen | Self::Delivered | Self::Undeliverable)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Offered => "offered",
            Self::Emitted => "emitted",
            Self::Seen => "seen",
            Self::QueuedInCodex => "queued_in_codex",
            Self::Delivered => "delivered",
            Self::Undeliverable => "undeliverable",
        }
    }
}

/// The longest a sender may wait on its messages, in milliseconds.
pub const MESSAGE_WAIT_MAX_MS: u64 = 600_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: MessageId,
    pub agent_id: AgentId,
    pub state: MailboxState,
}

/// A message one agent sent another through its harness's own channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedMessage {
    pub id: ObservedId,
    pub from: AgentId,
    pub to: AgentId,
    pub summary: String,
    pub accepted: bool,
    pub at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttentionState {
    Open,
    Closed,
}

impl AttentionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionCloseReason {
    Answered,
    AnsweredInTui,
    TimedOut,
    Superseded,
    AgentClosed,
    Stale,
    Replied,
    Dismissed,
    Resent,
}

impl AttentionCloseReason {
    pub const ALL: [Self; 9] = [
        Self::Answered,
        Self::AnsweredInTui,
        Self::TimedOut,
        Self::Superseded,
        Self::AgentClosed,
        Self::Stale,
        Self::Replied,
        Self::Dismissed,
        Self::Resent,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::AnsweredInTui => "answered_in_tui",
            Self::TimedOut => "timed_out",
            Self::Superseded => "superseded",
            Self::AgentClosed => "agent_closed",
            Self::Stale => "stale",
            Self::Replied => "replied",
            Self::Dismissed => "dismissed",
            Self::Resent => "resent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    Approval,
    Question,
    Failed,
    Undeliverable,
    Escalation,
    TaskDone,
    StuckStarting,
    /// A kind added after this build, kept as the daemon named it, so the whole answer it came in
    /// still reads and is written out again unchanged.
    #[serde(untagged)]
    Unknown(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttentionAction {
    Allow,
    Deny,
    Reply,
    Resend,
    Dismiss,
}

/// Something an agent or a task raised for the human.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub id: AttentionId,
    pub agent_id: AgentId,
    pub state: AttentionState,
    pub close_reason: Option<AttentionCloseReason>,
    pub summary: String,
    pub kind: AttentionKind,
    pub task_id: Option<String>,
    pub message_id: Option<MessageId>,
    pub opened_at: String,
    pub actions: Vec<AttentionAction>,
}

/// `POST /v1/agents/:id/messages`, and a task's broadcast.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub idempotency_key: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResponse {
    pub message_id: MessageId,
    pub event_ids: Vec<u64>,
}

/// `POST /v1/messages/wait`: answered once every message is settled, or at `timeout_ms`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitMessagesRequest {
    pub message_ids: Vec<MessageId>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitMessagesResponse {
    pub messages: Vec<Message>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_attention_kind_newer_than_this_build_reads_and_writes_as_the_daemon_named_it() {
        let kind: AttentionKind = serde_json::from_str(r#""a_kind_from_later""#).unwrap();
        assert_eq!(kind, AttentionKind::Unknown("a_kind_from_later".to_owned()));
        assert_eq!(
            serde_json::to_string(&kind).unwrap(),
            r#""a_kind_from_later""#
        );
        let known: AttentionKind = serde_json::from_str(r#""stuck_starting""#).unwrap();
        assert_eq!(known, AttentionKind::StuckStarting);
    }
}
