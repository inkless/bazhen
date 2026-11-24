//! The event stream's schema with each event's payload typed: zod's `Event`, `EventFrame` and
//! `EVENTS`. serde reads an event as far as its envelope ([`super::Event`]), so these are schemas
//! only. Each registered type's branch pins `type` and `entityType`, which serde's adjacent tagging
//! can't do per variant.

use std::borrow::Cow;
use std::collections::BTreeSet;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use super::{EVENT_KINDS, EventKind};
use crate::agent_events::{
    AgentCompacted, AgentExited, AgentExternalRefUpdated, AgentFailed, AgentLaunched,
    AgentProcessAdopted, AgentReady, AgentRelaunchRejected, AgentRelaunchRequested, AgentRenamed,
    AgentRespawnRejected, AgentRestarted, AgentRunning, AgentSignalled, AgentTranscriptRecorded,
};
use crate::agents::{Activity, Usage};
use crate::mail_events::{
    AttentionAnswered, AttentionClosed, AttentionOpened, MailAccepted, MailOffered, MailQueued,
    MailRequeued, MailSeen, MailUndeliverable, MessageObserved,
};
use crate::task_events::{
    AssignmentEnded, AssignmentGranted, TaskFinished, TaskNoted, TaskOwnerChanged,
};

/// A registered type's payload: its schema, and how this build reads one and writes it back.
#[derive(Debug, Clone, Copy)]
pub struct Payload {
    schema: fn(&mut SchemaGenerator) -> Schema,
    read: fn(Value) -> Result<Value, String>,
}

const fn of<T: JsonSchema + DeserializeOwned + Serialize>() -> Payload {
    Payload {
        schema: body::<T>,
        read: through::<T>,
    }
}

/// `T`'s schema inline, as the generator's transforms leave it: they apply only to what it puts
/// under `$defs`.
fn body<T: JsonSchema>(generator: &mut SchemaGenerator) -> Schema {
    let mut schema = T::json_schema(generator);
    for transform in generator.transforms_mut() {
        transform.transform(&mut schema);
    }
    schema
}

fn through<T: DeserializeOwned + Serialize>(payload: Value) -> Result<Value, String> {
    let read: T = serde_json::from_value(payload).map_err(|e| e.to_string())?;
    serde_json::to_value(read).map_err(|e| e.to_string())
}

/// Each registered type's payload, as the store records it.
pub const PAYLOADS: &[(&str, Payload)] = &[
    (
        "environment.registered",
        of::<super::EnvironmentRegistered>(),
    ),
    (
        "environment.harness_version",
        of::<super::EnvironmentHarnessVersion>(),
    ),
    ("agent.launched", of::<AgentLaunched>()),
    ("agent.renamed", of::<AgentRenamed>()),
    ("agent.running", of::<AgentRunning>()),
    ("agent.ready", of::<AgentReady>()),
    ("agent.failed", of::<AgentFailed>()),
    ("agent.lost", of::<super::Noted>()),
    ("agent.process_adopted", of::<AgentProcessAdopted>()),
    ("agent.respawn_requested", of::<super::Noted>()),
    ("agent.respawned", of::<AgentRestarted>()),
    ("agent.respawn_rejected", of::<AgentRespawnRejected>()),
    ("agent.relaunch_requested", of::<AgentRelaunchRequested>()),
    ("agent.relaunched", of::<AgentRestarted>()),
    ("agent.relaunch_rejected", of::<AgentRelaunchRejected>()),
    (
        "agent.external_ref_updated",
        of::<AgentExternalRefUpdated>(),
    ),
    ("agent.transcript_recorded", of::<AgentTranscriptRecorded>()),
    ("agent.signalled", of::<AgentSignalled>()),
    ("agent.activity", of::<Activity>()),
    ("agent.usage", of::<Usage>()),
    ("agent.compacted", of::<AgentCompacted>()),
    ("agent.exited", of::<AgentExited>()),
    ("agent.closing", of::<super::Noted>()),
    ("agent.closed", of::<super::Noted>()),
    ("terminal.opened", of::<super::TerminalOpened>()),
    ("terminal.running", of::<super::TerminalIncarnation>()),
    ("terminal.failed", of::<super::TerminalFailed>()),
    (
        "terminal.process_adopted",
        of::<super::TerminalIncarnation>(),
    ),
    ("terminal.lost", of::<super::TerminalNoted>()),
    ("terminal.closing", of::<super::TerminalNoted>()),
    ("terminal.closed", of::<super::TerminalClosed>()),
    (
        "terminal.foreground_changed",
        of::<super::TerminalForegroundChanged>(),
    ),
    (
        "terminal.needs_restart",
        of::<super::TerminalNeedsRestart>(),
    ),
    ("terminal.restart_cleared", of::<super::TerminalNoted>()),
    ("terminal.unlinked", of::<super::TerminalNoted>()),
    ("terminal.renamed", of::<super::TerminalRenamed>()),
    ("attachment.started", of::<super::AttachmentStarted>()),
    ("attachment.ended", of::<super::AttachmentEnded>()),
    ("mailbox.queued", of::<MailQueued>()),
    ("mailbox.offered", of::<MailOffered>()),
    ("mailbox.emitted", of::<super::Noted>()),
    ("mailbox.seen", of::<MailSeen>()),
    ("mailbox.delivered", of::<super::Noted>()),
    ("mailbox.accepted", of::<MailAccepted>()),
    ("mailbox.undeliverable", of::<MailUndeliverable>()),
    ("message.observed", of::<MessageObserved>()),
    ("mailbox.requeued", of::<MailRequeued>()),
    ("attention.opened", of::<AttentionOpened>()),
    ("attention.answered", of::<AttentionAnswered>()),
    ("attention.closed", of::<AttentionClosed>()),
    ("device.paired", of::<super::DevicePaired>()),
    ("device.revoked", of::<super::DeviceRevoked>()),
    ("notice.opened", of::<super::NoticeOpened>()),
    ("notice.closed", of::<super::NoticeClosed>()),
    ("lease.granted", of::<super::LeaseGranted>()),
    ("task.created", of::<super::TaskCreated>()),
    ("task.finished", of::<TaskFinished>()),
    ("task.owner_changed", of::<TaskOwnerChanged>()),
    ("task.noted", of::<TaskNoted>()),
    ("assignment.granted", of::<AssignmentGranted>()),
    ("assignment.ended", of::<AssignmentEnded>()),
];

/// `kind`'s payload as the store records it, or none for a type with no payload listed.
pub fn payload(kind: &EventKind, generator: &mut SchemaGenerator) -> Option<Schema> {
    let (_, payload) = PAYLOADS.iter().find(|(name, _)| *name == kind.name)?;
    Some((payload.schema)(generator))
}

/// `payload` read through the Rust type of the event type named `kind` and written back, as this
/// build reads it whole off the store; none for a type with no payload listed.
pub fn read(kind: &str, payload: Value) -> Option<Result<Value, String>> {
    let (_, entry) = PAYLOADS.iter().find(|(name, _)| *name == kind)?;
    Some((entry.read)(payload))
}

/// `payload` cut to the keys a client is sent; or none where it keeps them all.
pub fn streamed(kind: &EventKind, payload: &Schema) -> Option<Schema> {
    let keys: BTreeSet<&str> = payload
        .get("properties")
        .and_then(Value::as_object)
        .map_or_else(BTreeSet::new, |properties| {
            properties.keys().map(String::as_str).collect()
        });
    if keys == kind.streamed.iter().copied().collect() {
        return None;
    }
    let mut cut = payload.clone();
    if let Some(properties) = cut.get_mut("properties").and_then(Value::as_object_mut) {
        properties.retain(|key, _| kind.streamed.contains(&key.as_str()));
    }
    if let Some(required) = cut.get_mut("required").and_then(Value::as_array_mut) {
        required.retain(|key| key.as_str().is_some_and(|k| kind.streamed.contains(&k)));
    }
    Some(cut)
}

/// One event as the stream sends it, of any registered type, with its payload checked.
#[derive(Debug)]
pub struct TypedEvent;

impl JsonSchema for TypedEvent {
    fn schema_name() -> Cow<'static, str> {
        "Event".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let envelope = super::Event::json_schema(generator);
        let branches: Vec<Value> = EVENT_KINDS
            .iter()
            .filter_map(|kind| {
                let payload = payload(kind, generator)?;
                let sent = streamed(kind, &payload).unwrap_or(payload);
                let mut branch = envelope.clone();
                let properties = branch.get_mut("properties")?.as_object_mut()?;
                properties.insert("type".to_owned(), pinned(kind.name));
                properties.insert("entityType".to_owned(), pinned(kind.entity));
                properties.insert("payload".to_owned(), sent.to_value());
                Some(branch.to_value())
            })
            .collect();
        json_schema!({ "anyOf": branches })
    }
}

fn pinned(value: &str) -> Value {
    serde_json::json!({ "type": "string", "const": value })
}

/// An event's type and its payload as the store records it, whole, of which the stream sends the
/// part [`streamed`] leaves: zod's `RecordedEvent`, which no client is sent.
#[derive(Debug)]
pub struct TypedRecordedEvent;

impl JsonSchema for TypedRecordedEvent {
    fn schema_name() -> Cow<'static, str> {
        "RecordedEvent".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let branches: Vec<Value> = EVENT_KINDS
            .iter()
            .filter_map(|kind| {
                let payload = payload(kind, generator)?;
                Some(serde_json::json!({
                    "type": "object",
                    "properties": { "type": pinned(kind.name), "payload": payload },
                    "required": ["type", "payload"],
                }))
            })
            .collect();
        json_schema!({ "anyOf": branches })
    }
}

/// A text frame the daemon sends on `/v1/events`, each event's payload checked.
#[derive(Debug)]
pub struct TypedEventFrame;

impl JsonSchema for TypedEventFrame {
    fn schema_name() -> Cow<'static, str> {
        "EventFrame".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let event = generator.subschema_for::<TypedEvent>();
        let reason = generator.subschema_for::<super::ResetReason>();
        json_schema!({
            "oneOf": [
                {
                    "type": "object",
                    "properties": { "type": pinned("event"), "event": event },
                    "required": ["type", "event"],
                },
                {
                    "type": "object",
                    "properties": { "type": pinned("reset"), "reason": reason },
                    "required": ["type", "reason"],
                },
            ],
        })
    }
}

/// zod's `EVENTS`: each registered type's entity, its payload, and the narrower form it is
/// streamed in where it has one.
pub fn registry(generator: &mut SchemaGenerator) -> Value {
    let entries: Map<String, Value> = EVENT_KINDS
        .iter()
        .filter_map(|kind| {
            let payload = payload(kind, generator)?;
            let mut entry = Map::new();
            entry.insert("entity".to_owned(), kind.entity.into());
            if let Some(streamed) = streamed(kind, &payload) {
                entry.insert("streamed".to_owned(), streamed.to_value());
            }
            entry.insert("payload".to_owned(), payload.to_value());
            Some((kind.name.to_owned(), Value::Object(entry)))
        })
        .collect();
    Value::Object(entries)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn lists_a_payload_for_each_registered_type_and_for_no_other() {
        let registered: BTreeSet<&str> = EVENT_KINDS.iter().map(|kind| kind.name).collect();
        let listed: Vec<&str> = PAYLOADS.iter().map(|(name, _)| *name).collect();
        let unlisted: Vec<&&str> = registered.iter().filter(|n| !listed.contains(n)).collect();
        let unknown: Vec<&&str> = listed.iter().filter(|n| !registered.contains(*n)).collect();
        assert_eq!((unlisted, unknown), (vec![], vec![]));
        assert_eq!(listed.len(), registered.len(), "a type listed twice");
    }

    #[test]
    fn sends_only_keys_its_payload_has() {
        let mut generator = crate::schema::generator();
        let mut strays = Vec::new();
        for kind in EVENT_KINDS {
            let payload = payload(kind, &mut generator).unwrap_or_default();
            let properties = payload.get("properties").and_then(Value::as_object);
            for key in kind.streamed {
                if !properties.is_some_and(|p| p.contains_key(*key)) {
                    strays.push(format!("{}: {key}", kind.name));
                }
            }
        }
        assert_eq!(strays, Vec::<String>::new());
    }

    #[test]
    fn cuts_a_payload_to_the_keys_its_type_streams_and_keeps_the_rest_whole() {
        let mut generator = crate::schema::generator();
        let kind = super::super::event_kind("task.created").unwrap();
        let recorded = payload(kind, &mut generator).unwrap();
        let cut = streamed(kind, &recorded).unwrap().to_value();
        let keys: BTreeSet<&str> = cut["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            BTreeSet::from(["title", "ownerAgentId", "parentTaskId", "delegatedFrom"])
        );
        assert!(
            !cut["required"]
                .as_array()
                .unwrap()
                .contains(&"brief".into()),
            "{cut}"
        );
        let whole = super::super::event_kind("terminal.renamed").unwrap();
        assert_eq!(
            streamed(whole, &payload(whole, &mut generator).unwrap()),
            None
        );
    }
}
