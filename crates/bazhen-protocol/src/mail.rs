//! Mail between agents, its states, and the items agents raise for the human.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::ids::{AgentId, AttentionId, MessageId, ObservedId};
use crate::names::Refused;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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

/// The largest hook reply body a hook client takes; it fails open on a larger one.
pub const HOOK_REPLY_MAX_BYTES: usize = 1 << 20;

/// The hook client's own contract, apart from the build's protocol: a hook already running in an
/// agent's session outlives a daemon upgrade, so it keeps working while the major is the same.
/// Within a major, [`HookRequest`] and [`HookReply`] change only by addition, never renaming,
/// removing or tightening what has shipped, and the minor is bumped with each addition.
pub const HOOK_PROTOCOL_VERSION: &str = "1.0";

/// The `Content-Type` of a framed [`HookReply`].
pub const HOOK_REPLY_TYPE: &str = "application/vnd.bazhen.hook-reply";

/// A protocol's version, `<major>.<minor>`: the rule bazhen-holder-proto's `ProtocolVersion::new`
/// holds the holder's version to.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ProtocolVersion(String);

impl ProtocolVersion {
    pub fn parse(text: &str) -> Option<Self> {
        let (major, minor) = text.split_once('.')?;
        let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
        (digits(major) && digits(minor)).then(|| Self(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What the hook client sends for every hook a harness runs, over the daemon's Unix socket
/// (foundation-design §5.6).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct HookRequest {
    pub protocol_version: ProtocolVersion,
    pub agent_id: AgentId,
    pub event: HookEvent,
    pub pid: i64,
    pub ppid: i64,
    /// The harness's own hook input, any JSON, null included: its text as the client sent it,
    /// which the harness's adapter reads as `JSON.parse` would. A lone surrogate's escape and any
    /// depth pass through, where reading it here as a value would refuse them.
    // The empty description keeps the doc out of the schema, which stays `true`: as an object
    // with a description and no type, the zod writer would refuse it.
    #[cfg_attr(
        feature = "schema",
        schemars(with = "serde_json::Value", description = "")
    )]
    pub payload: Box<serde_json::value::RawValue>,
}

/// The hook a request is for, as the hook client names it: the harness's event, or `wait`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct HookEvent(String);

impl HookEvent {
    pub fn parse(text: &str) -> Option<Self> {
        (!text.is_empty()).then(|| Self(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One offer of a message, `<message id>-<offer id>`: plain token characters, so every client
/// echoes it verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct OfferToken(String);

impl OfferToken {
    pub fn parse(text: &str) -> Option<Self> {
        let (message, offer) = text.strip_prefix("msg_")?.split_once('-')?;
        let hex = message.len() == 32
            && message
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        let plain = (1..=32).contains(&offer.len())
            && offer
                .bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase());
        (hex && plain).then(|| Self(text.to_owned()))
    }

    /// The token for one offer of a message.
    pub fn of(message: &MessageId, offer: &str) -> Option<Self> {
        Self::parse(&format!("{message}-{offer}"))
    }

    /// The id of the message it is an offer of.
    pub fn message(&self) -> &str {
        self.0
            .split_once('-')
            .map_or(self.0.as_str(), |(message, _)| message)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What the hook client prints and exits with, verbatim; it knows no harness format.
///
/// On the wire it is framed rather than JSON, so a client with no JSON parser can read it byte for
/// byte: `Content-Type` is [`HOOK_REPLY_TYPE`], `Content-Length` is set, `Bazhen-Exit-Code`
/// carries `exit_code`, `Bazhen-Offered` the comma-separated `offered` tokens,
/// `Bazhen-Stdout-Bytes` the UTF-8 length of `stdout`, and the body is `stdout` then `stderr`. A
/// client fails open on anything else, or on a body over [`HOOK_REPLY_MAX_BYTES`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct HookReply {
    pub exit_code: u8,
    pub stdout: String,
    pub stderr: String,
    /// One token per message this reply hands to the harness, which the client acks once it has
    /// written: the message's id and this offer's own, so an ack names the offer it confirms and a
    /// late one for an earlier offer of the same message confirms nothing.
    pub offered: Vec<OfferToken>,
}

/// The hook client's word that it wrote a reply's offered messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct HookAck {
    pub agent_id: AgentId,
    pub offered: Vec<OfferToken>,
}

impl TryFrom<String> for ProtocolVersion {
    type Error = Refused;
    fn try_from(value: String) -> Result<Self, Refused> {
        Self::parse(&value).ok_or_else(|| Refused::new("a protocol version", value))
    }
}

impl TryFrom<String> for HookEvent {
    type Error = Refused;
    fn try_from(value: String) -> Result<Self, Refused> {
        Self::parse(&value).ok_or_else(|| Refused::new("a hook event", value))
    }
}

impl TryFrom<String> for OfferToken {
    type Error = Refused;
    fn try_from(value: String) -> Result<Self, Refused> {
        Self::parse(&value).ok_or_else(|| Refused::new("an offer token", value))
    }
}

impl From<ProtocolVersion> for String {
    fn from(version: ProtocolVersion) -> Self {
        version.0
    }
}

impl From<HookEvent> for String {
    fn from(event: HookEvent) -> Self {
        event.0
    }
}

impl From<OfferToken> for String {
    fn from(token: OfferToken) -> Self {
        token.0
    }
}

impl fmt::Display for OfferToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for ProtocolVersion {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "ProtocolVersion".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "type": "string", "pattern": "^[0-9]+\\.[0-9]+$" })
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for HookEvent {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "HookEvent".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "type": "string", "minLength": 1 })
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for OfferToken {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "OfferToken".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "pattern": "^msg_[0-9a-f]{32}-[0-9a-z]{1,32}$",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: MessageId,
    pub agent_id: AgentId,
    pub state: MailboxState,
}

/// A message one agent sent another through its harness's own channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ObservedMessage {
    pub id: ObservedId,
    pub from: AgentId,
    pub to: AgentId,
    pub summary: String,
    pub accepted: bool,
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::Timestamp"))]
    pub at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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

impl AttentionKind {
    /// Every kind this build knows: all but `Unknown`.
    pub const KNOWN: [Self; 7] = [
        Self::Approval,
        Self::Question,
        Self::Failed,
        Self::Undeliverable,
        Self::Escalation,
        Self::TaskDone,
        Self::StuckStarting,
    ];

    /// The kind's name, as it is stored and written.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Approval => "approval",
            Self::Question => "question",
            Self::Failed => "failed",
            Self::Undeliverable => "undeliverable",
            Self::Escalation => "escalation",
            Self::TaskDone => "task_done",
            Self::StuckStarting => "stuck_starting",
            Self::Unknown(name) => name,
        }
    }
}

/// The protocol's kinds, closed: `Unknown` lets this build read a newer daemon's answer, and the
/// protocol names no such kind.
#[cfg(feature = "schema")]
impl schemars::JsonSchema for AttentionKind {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "AttentionKind".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let names: Vec<&str> = Self::KNOWN.iter().map(Self::as_str).collect();
        schemars::json_schema!({ "type": "string", "enum": names })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub id: AttentionId,
    pub agent_id: AgentId,
    pub state: AttentionState,
    #[cfg_attr(
        feature = "schema",
        schemars(with = "crate::schema::Required<AttentionCloseReason>")
    )]
    pub close_reason: Option<AttentionCloseReason>,
    pub summary: String,
    pub kind: AttentionKind,
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::Required<String>"))]
    pub task_id: Option<String>,
    #[cfg_attr(
        feature = "schema",
        schemars(with = "crate::schema::Required<MessageId>")
    )]
    pub message_id: Option<MessageId>,
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::Timestamp"))]
    pub opened_at: String,
    pub actions: Vec<AttentionAction>,
}

/// `POST /v1/agents/:id/messages`, and a task's broadcast.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::IdempotencyKey"))]
    pub idempotency_key: String,
    #[cfg_attr(feature = "schema", schemars(length(min = 1, max = 20_000)))]
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResponse {
    pub message_id: MessageId,
    #[cfg_attr(feature = "schema", schemars(with = "Vec<crate::schema::EventId>"))]
    pub event_ids: Vec<u64>,
}

/// `POST /v1/messages/wait`: answered once every message is settled, or at `timeout_ms`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WaitMessagesRequest {
    #[cfg_attr(feature = "schema", schemars(length(min = 1, max = 100)))]
    pub message_ids: Vec<MessageId>,
    #[cfg_attr(feature = "schema", schemars(range(max = crate::mail::MESSAGE_WAIT_MAX_MS)))]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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

    #[test]
    fn names_each_attention_kind_as_it_is_written() {
        let unknown = AttentionKind::Unknown("a_kind_from_later".to_owned());
        for kind in AttentionKind::KNOWN.into_iter().chain([unknown]) {
            let written = serde_json::to_value(&kind).unwrap();
            assert_eq!(written.as_str(), Some(kind.as_str()), "{kind:?}");
        }
    }
}
