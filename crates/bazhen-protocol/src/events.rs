//! The event stream, `/v1/events`: the frames the daemon sends on it. An event is read as far as
//! its envelope; its payload is kept as it came, so an event type this build doesn't know reads
//! like any other.

use serde::{Deserialize, Serialize};

/// Why the stream couldn't resume from a cursor: older than retention, or not from this store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetReason {
    Stale,
    Foreign,
}

impl ResetReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stale => "stale",
            Self::Foreign => "foreign",
        }
    }
}

/// One event, as the stream sends it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: u64,
    pub ts: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub entity_type: String,
    pub entity_id: String,
    pub actor: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub causation_id: Option<u64>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub correlation_id: Option<String>,
    pub payload: serde_json::Value,
}

/// A text frame the daemon sends on `/v1/events`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum EventFrame {
    Event {
        event: Event,
    },
    /// The cursor can't be resumed: read `/v1/state` again, and resume from its cursor.
    Reset {
        reason: ResetReason,
    },
}
