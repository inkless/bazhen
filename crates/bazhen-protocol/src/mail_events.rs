//! The payloads of the `mailbox.*`, `message.observed` and `attention.*` events, in the order the
//! TypeScript daemon writes them: a key zod's schema marks optional is left out when absent, and
//! one it marks nullable is written null.

use serde::{Deserialize, Serialize};

use crate::ids::{AgentId, MessageId};
use crate::mail::{AttentionCloseReason, AttentionKind};

/// The payload of `mailbox.queued`: a message for an agent, delivered at least once through its
/// harness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailQueued {
    pub agent_id: AgentId,
    pub body: String,
    /// The agent whose own words the body is, after a line naming it that the body starts with;
    /// absent for the human's mail and for mail Bazhen composes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<AgentId>,
}

/// The payload of `mailbox.offered`: a hook took the message to hand to the harness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOffered {
    /// The prompt of the turn a fold's offer is folded into, whose Stop delivers it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
}

/// The payload of `mailbox.seen`: a prompt carrying its id started, and that prompt's end
/// delivers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSeen {
    pub prompt_id: String,
}

/// The payload of `mailbox.accepted`: `codex queue` stored it in Codex, on a live app-server or,
/// `offline`, in the Codex home.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailAccepted {
    pub offline: bool,
}

/// Why a message will never reach its agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UndeliverableReason {
    AgentClosed,
    GaveUp,
}

/// The payload of `mailbox.undeliverable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailUndeliverable {
    pub reason: UndeliverableReason,
}

/// Why a message went back to the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequeueReason {
    NotWritten,
    DaemonRestart,
    /// The session started over, as /clear does, before the agent saw it.
    SessionStarted,
    /// The turn carrying it ended in an API error.
    StopFailed,
    /// The turn that saw it ended with no Stop, as Esc ends one: another turn began.
    Interrupted,
    /// Written, but in no prompt by the second turn end, or a deadline while idle.
    NotSeen,
}

impl RequeueReason {
    /// Whether the agent's side caused it, which counts toward the re-offer cap.
    pub fn is_agent_failure(self) -> bool {
        matches!(self, Self::StopFailed | Self::Interrupted | Self::NotSeen)
    }
}

/// The payload of `mailbox.requeued`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailRequeued {
    pub reason: RequeueReason,
}

/// The payload of `message.observed`: the agent sent another Bazhen agent a message through its
/// harness's own channel, which Bazhen sees sent but can't follow to delivery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageObserved {
    pub from: AgentId,
    pub to: AgentId,
    /// The harness's own label for it, else its first line, at most 120 characters.
    pub summary: String,
    pub text: String,
    /// Whether the harness said it was sent; nothing says it was read.
    pub accepted: bool,
    /// The tool call that sent it, which records it once.
    pub tool_use_id: String,
}

/// The payload of `attention.opened`: something needs the human.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionOpened {
    pub agent_id: AgentId,
    pub summary: String,
    /// Absent on items recorded before kinds, which were all approvals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<AttentionKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<MessageId>,
    /// The tool call it is for, whose result closes it; null if no call was seen to start.
    pub tool_use_id: Option<String>,
    /// Asked by the agent itself, whose turn ending closes it, rather than by a subagent.
    pub main_agent: bool,
}

/// The human's answer to an approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalDecision {
    Allow,
    Deny,
}

/// The payload of `attention.answered`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttentionAnswered {
    pub decision: ApprovalDecision,
}

/// Why an item closed other than by the human's answer, which `attention.answered` records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionClosedReason {
    AnsweredInTui,
    TimedOut,
    Superseded,
    AgentClosed,
    Stale,
    Replied,
    Dismissed,
    Resent,
}

impl AttentionClosedReason {
    /// The close reason it is, as the attention machine and the item's row name it.
    pub fn reason(self) -> AttentionCloseReason {
        match self {
            Self::AnsweredInTui => AttentionCloseReason::AnsweredInTui,
            Self::TimedOut => AttentionCloseReason::TimedOut,
            Self::Superseded => AttentionCloseReason::Superseded,
            Self::AgentClosed => AttentionCloseReason::AgentClosed,
            Self::Stale => AttentionCloseReason::Stale,
            Self::Replied => AttentionCloseReason::Replied,
            Self::Dismissed => AttentionCloseReason::Dismissed,
            Self::Resent => AttentionCloseReason::Resent,
        }
    }
}

/// The payload of `attention.closed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttentionClosed {
    pub reason: AttentionClosedReason,
}
