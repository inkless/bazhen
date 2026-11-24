//! The Rust types against the fixtures `moon run :schema` writes from the TypeScript protocol: each
//! message decodes from every wire example and encodes back to what zod made of it, and every
//! check gives the protocol's verdict. A fixture file no type here reads fails the test.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use bazhen_protocol::agents::{
    Activity, AgentCommandResponse, CallerResponse, CloseAgentRequest, FleetAgent, HarnessId,
    LaunchAgentRequest, LaunchAgentResponse, RelaunchAgentRequest, RenameAgentRequest,
    RespawnAgentRequest, SignalAgentRequest, StateSnapshot, Usage, UsageLimit,
};
use bazhen_protocol::daemon::{
    DoctorResponse, EnvRefreshRequest, EnvRefreshResponse, ErrorResponse, HealthResponse,
    StopResponse,
};
use bazhen_protocol::detach_keys::DetachKeys;
use bazhen_protocol::edge::{EdgeCheck, edge};
use bazhen_protocol::events::typed::{TypedEvent, TypedRecordedEvent};
use bazhen_protocol::events::{
    ClientEventFrame, EVENT_KINDS, Event, EventFrame, EventStreamQuery, event_kind, typed,
};
use bazhen_protocol::ids::{TaskId, is_id};
use bazhen_protocol::input::{has_keystrokes, without_replies};
use bazhen_protocol::mail::{
    AttentionKind, MESSAGE_WAIT_MAX_MS, MailboxState, SendMessageRequest, SendMessageResponse,
    WaitMessagesRequest, WaitMessagesResponse,
};
use bazhen_protocol::names::{AGENT_NAME_MAX, AgentName, AgentRef, Role};
use bazhen_protocol::notices::{
    DEVICE_NAME_MAX, DEVICE_PAIRED, DevicesResponse, DismissNoticeRequest, DismissNoticeResponse,
    PAIRING_ALPHABET, PAIRING_CODE_LENGTH, PairRequest, PairResponse, PairingCodeResponse,
    RevokeDeviceResponse,
};
use bazhen_protocol::roles::RolesResponse;
use bazhen_protocol::shells::{
    CloseShellRequest, OpenShellRequest, RenameShellRequest, RestartShellRequest,
    ShellCommandResponse, ShellDecline, ShellPrompt, ShellReport,
};
use bazhen_protocol::stream::{STREAM_FRAME_MAX_BYTES, StreamClientFrame, StreamServerFrame};
use bazhen_protocol::tasks::{
    AddTaskNoteRequest, AssignTaskRequest, AssignTaskResponse, BroadcastMessageResponse,
    CreateTaskRequest, CreateTaskResponse, DelegateTaskRequest, EscalateRequest, EscalateResponse,
    FinishTaskRequest, TaskCommandResponse, TaskDetail, UnassignTaskRequest,
};
use bazhen_protocol::terminals::TerminalScreen;
use bazhen_protocol::text::{
    TASK_NOTE_MAX_BYTES, is_origin, is_plain_remote, quote_note, task_note_text,
};
use bazhen_protocol::time::timestamp_ms;
use bazhen_protocol::waits::{AgentCondition, ShellCondition, WaitRequest, WaitResponse};
use bazhen_protocol::wire;
use schemars::JsonSchema;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

type Result<T> = std::result::Result<T, String>;

/// Whether a text reads as some type.
type Reads = fn(&str) -> bool;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/fixtures/api")
}

/// A fixture file, read as the CLI reads the daemon's answers: a lone surrogate as U+FFFD.
fn read(file: &str) -> Result<Value> {
    let bytes = fs::read(fixtures().join(file)).map_err(|e| format!("{file}: {e}"))?;
    wire::from_slice(&bytes).map_err(|e| format!("{file}: {e}"))
}

/// JSON values equal as JavaScript sees them: a number is a number, however `serde_json` holds
/// it.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// Where `encoded` and `parsed` first differ, at the JSON pointer `at` into them, and what each
/// holds there; none when they don't.
fn difference(encoded: &Value, parsed: &Value, at: &str) -> Option<String> {
    let shown = |held: Option<&Value>| held.map_or_else(|| "nothing".to_owned(), Value::to_string);
    match (encoded, parsed) {
        (Value::Object(x), Value::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            keys.into_iter()
                .find_map(|key| match (x.get(key), y.get(key)) {
                    (Some(a), Some(b)) => difference(a, b, &format!("{at}/{key}")),
                    (a, b) => Some(format!(
                        "{at}/{key}: written {}, parsed {}",
                        shown(a),
                        shown(b)
                    )),
                })
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (a, b))| difference(a, b, &format!("{at}/{i}"))),
        _ if same(encoded, parsed) => None,
        _ => Some(format!("{at}: written {encoded}, parsed {parsed}")),
    }
}

/// The examples this build writes back other than the protocol parses them, each named by its
/// message, its branch and where they first differ, with what owns the difference. The list only
/// shrinks: an entry no example shows fails.
const KNOWN_REWRITES: &[(&str, &str)] = &[(
    "RecordedEvent (type=task.created), /payload/delegatedFrom: written null, parsed nothing",
    "the port of the task store",
)];

/// What a message's examples showed.
struct Report {
    examples: usize,
    /// Each entry of [`KNOWN_REWRITES`] an example showed.
    rewritten: Vec<String>,
    /// Each field, at its path in an example, that the schema takes left out or null where serde
    /// refuses it. The schema may refuse what serde takes: it holds the protocol's contract, which
    /// can be stricter than the reader.
    unlike: Vec<String>,
}

/// Every example of the message `name` decodes as `T` and encodes back to its parsed form, and
/// each of its fields is left out and nulled in turn, for serde's answer and the schema's.
fn round_trips<T: DeserializeOwned + Serialize + JsonSchema>(name: &str) -> Result<Report> {
    examined::<T>(name, |wire| {
        serde_json::from_value(wire.clone()).map_err(|e| e.to_string())
    })
}

/// As [`round_trips`], for a request the daemon's edge reads: decoded as the edge takes it, which
/// gives it back as zod parses it.
fn round_trips_at_edge<T: DeserializeOwned + Serialize + JsonSchema + EdgeCheck>(
    name: &str,
) -> Result<Report> {
    examined::<T>(name, |wire| {
        edge::<T>(wire.to_string().as_bytes()).map_err(|refused| refused.to_string())
    })
}

/// As [`round_trips`], for an event as a client of this build reads it off the stream, against
/// the protocol's `Event`: a payload its type sends whole read through its Rust type, and one it
/// cuts left with only the keys it sends.
fn round_trips_typed(name: &str) -> Result<Report> {
    let mut generator = bazhen_protocol::schema::generator();
    let cut: Vec<&str> = EVENT_KINDS
        .iter()
        .filter(|kind| {
            typed::payload(kind, &mut generator)
                .is_some_and(|payload| typed::streamed(kind, &payload).is_some())
        })
        .map(|kind| kind.name)
        .collect();
    let decode = |wire: &Value| -> Result<Event> {
        let mut event: Event = serde_json::from_value(wire.clone()).map_err(|e| e.to_string())?;
        if let Some(kind) = event_kind(&event.kind).filter(|kind| cut.contains(&kind.name)) {
            if let Some(payload) = event.payload.as_object_mut() {
                payload.retain(|key, _| kind.streamed.contains(&key.as_str()));
            }
        } else if let Some(read) = typed::read(&event.kind, event.payload.clone()) {
            event.payload = read.map_err(|e| format!("{}: {e}", event.kind))?;
        }
        Ok(event)
    };
    examined_as(name, &Schema::of::<TypedEvent>(), decode, |wire| {
        decode(&wire).is_ok()
    })
}

/// As [`round_trips`], for an event's type and its payload as the store records it, against the
/// protocol's `RecordedEvent`: the payload read whole through its type's Rust payload.
fn round_trips_recorded(name: &str) -> Result<Report> {
    let decode = |wire: &Value| -> Result<Value> {
        let kind = wire.get("type").and_then(Value::as_str).ok_or("no type")?;
        let payload = wire.get("payload").cloned().ok_or("no payload")?;
        let read = typed::read(kind, payload).ok_or(format!("{kind}: no payload type"))?;
        Ok(serde_json::json!({ "type": kind, "payload": read? }))
    };
    examined_as(name, &Schema::of::<TypedRecordedEvent>(), decode, |wire| {
        decode(&wire).is_ok()
    })
}

fn examined<T: DeserializeOwned + Serialize + JsonSchema>(
    name: &str,
    decode: impl Fn(&Value) -> Result<T>,
) -> Result<Report> {
    examined_as(name, &Schema::of::<T>(), decode, |wire| {
        serde_json::from_value::<T>(wire).is_ok()
    })
}

/// As [`examined`], against `schema`, with `reads` saying whether the reader takes each example
/// with a field left out or null.
fn examined_as<T: Serialize>(
    name: &str,
    schema: &Schema,
    decode: impl Fn(&Value) -> Result<T>,
    reads: impl Fn(Value) -> bool,
) -> Result<Report> {
    let examples = read(&format!("{name}.json"))?;
    let examples = examples.as_array().ok_or(format!("{name}: not a list"))?;
    let mut unlike = Vec::new();
    let mut rewritten = Vec::new();
    for example in examples {
        let what = example.get("name").cloned().unwrap_or_default();
        let wire = example.get("wire").cloned().unwrap_or_default();
        let parsed = example.get("parsed").cloned().unwrap_or_default();
        let decoded = decode(&wire).map_err(|e| format!("{name}, {what}: {e}"))?;
        let encoded = serde_json::to_value(&decoded).map_err(|e| format!("{name}, {what}: {e}"))?;
        if let Some(at) = difference(&encoded, &parsed, "") {
            let branch = wire
                .get("type")
                .and_then(Value::as_str)
                .map_or_else(String::new, |kind| format!(" (type={kind})"));
            let named = format!("{name}{branch}, {at}");
            if !KNOWN_REWRITES.iter().any(|(known, _)| *known == named) {
                return Err(format!(
                    "{name}, {what}:\n  encoded {encoded}\n  parsed  {parsed}"
                ));
            }
            rewritten.push(named);
            continue;
        }
        for (at, field) in schema.fields(&wire) {
            let left_out = reads(edited(&wire, &at, None));
            let null = reads(edited(&wire, &at, Some(Value::Null)));
            if field.optional && !left_out {
                unlike.push(format!(
                    "{name}, {at}: the schema takes it left out, serde doesn't"
                ));
            }
            if field.nullable && !null {
                unlike.push(format!(
                    "{name}, {at}: the schema takes it null, serde doesn't"
                ));
            }
        }
        if let Some(text) = example.get("text").and_then(Value::as_str) {
            let printed =
                serde_json::to_string(&decoded).map_err(|e| format!("{name}, {what}: {e}"))?;
            if printed != text {
                return Err(format!(
                    "{name}, {what} prints its keys out of order:\n  {printed}\n  {text}"
                ));
            }
        }
    }
    unlike.sort();
    unlike.dedup();
    Ok(Report {
        examples: examples.len(),
        rewritten,
        unlike,
    })
}

type RoundTrip = fn(&str) -> Result<Report>;

/// Each message the fixtures hold, and the type that reads it.
const MESSAGES: &[(&str, RoundTrip)] = &[
    ("AddTaskNoteRequest", round_trips::<AddTaskNoteRequest>),
    ("AgentCommandResponse", round_trips::<AgentCommandResponse>),
    ("AssignTaskRequest", round_trips::<AssignTaskRequest>),
    ("AssignTaskResponse", round_trips::<AssignTaskResponse>),
    (
        "BroadcastMessageResponse",
        round_trips::<BroadcastMessageResponse>,
    ),
    ("CallerResponse", round_trips::<CallerResponse>),
    ("ClientEventFrame", round_trips::<ClientEventFrame>),
    ("CloseAgentRequest", round_trips::<CloseAgentRequest>),
    (
        "CloseShellRequest",
        round_trips_at_edge::<CloseShellRequest>,
    ),
    (
        "CreateTaskRequest",
        round_trips_at_edge::<CreateTaskRequest>,
    ),
    ("CreateTaskResponse", round_trips::<CreateTaskResponse>),
    ("DelegateTaskRequest", round_trips::<DelegateTaskRequest>),
    ("DevicesResponse", round_trips::<DevicesResponse>),
    (
        "DismissNoticeRequest",
        round_trips_at_edge::<DismissNoticeRequest>,
    ),
    (
        "DismissNoticeResponse",
        round_trips::<DismissNoticeResponse>,
    ),
    ("DoctorResponse", round_trips::<DoctorResponse>),
    ("EnvRefreshRequest", round_trips::<EnvRefreshRequest>),
    ("EnvRefreshResponse", round_trips::<EnvRefreshResponse>),
    ("ErrorResponse", round_trips::<ErrorResponse>),
    ("EscalateRequest", round_trips::<EscalateRequest>),
    ("EscalateResponse", round_trips::<EscalateResponse>),
    ("Event", round_trips_typed),
    ("RecordedEvent", round_trips_recorded),
    ("EventEnvelopeFrame", round_trips::<EventFrame>),
    ("EventStreamQuery", round_trips::<EventStreamQuery>),
    ("FinishTaskRequest", round_trips::<FinishTaskRequest>),
    ("FleetAgent", round_trips::<FleetAgent>),
    ("HealthResponse", round_trips::<HealthResponse>),
    ("LaunchAgentRequest", round_trips::<LaunchAgentRequest>),
    ("LaunchAgentResponse", round_trips::<LaunchAgentResponse>),
    ("OpenShellRequest", round_trips_at_edge::<OpenShellRequest>),
    ("PairRequest", round_trips_at_edge::<PairRequest>),
    ("PairResponse", round_trips::<PairResponse>),
    ("PairingCodeResponse", round_trips::<PairingCodeResponse>),
    ("RelaunchAgentRequest", round_trips::<RelaunchAgentRequest>),
    ("RenameAgentRequest", round_trips::<RenameAgentRequest>),
    (
        "RenameShellRequest",
        round_trips_at_edge::<RenameShellRequest>,
    ),
    (
        "RestartShellRequest",
        round_trips_at_edge::<RestartShellRequest>,
    ),
    ("RespawnAgentRequest", round_trips::<RespawnAgentRequest>),
    ("RevokeDeviceResponse", round_trips::<RevokeDeviceResponse>),
    ("RolesResponse", round_trips::<RolesResponse>),
    ("SendMessageRequest", round_trips::<SendMessageRequest>),
    ("SendMessageResponse", round_trips::<SendMessageResponse>),
    ("ShellCommandResponse", round_trips::<ShellCommandResponse>),
    ("ShellDecline", round_trips_at_edge::<ShellDecline>),
    ("ShellPrompt", round_trips_at_edge::<ShellPrompt>),
    ("ShellReport", round_trips_at_edge::<ShellReport>),
    ("SignalAgentRequest", round_trips::<SignalAgentRequest>),
    ("TerminalScreen", round_trips::<TerminalScreen>),
    ("StateSnapshot", round_trips::<StateSnapshot>),
    ("StopResponse", round_trips::<StopResponse>),
    ("StreamClientFrame", round_trips::<StreamClientFrame>),
    ("StreamServerFrame", round_trips::<StreamServerFrame>),
    ("TaskCommandResponse", round_trips::<TaskCommandResponse>),
    ("TaskDetail", round_trips::<TaskDetail>),
    ("UnassignTaskRequest", round_trips::<UnassignTaskRequest>),
    ("WaitMessagesRequest", round_trips::<WaitMessagesRequest>),
    ("WaitMessagesResponse", round_trips::<WaitMessagesResponse>),
    ("WaitRequest", round_trips::<WaitRequest>),
    ("WaitResponse", round_trips::<WaitResponse>),
];

#[test]
fn every_message_decodes_its_examples_and_encodes_what_the_protocol_makes_of_them() {
    for (name, round_trip) in MESSAGES {
        assert!(
            round_trip(name).unwrap().examples > 0,
            "{name} has no examples"
        );
    }
}

#[test]
fn each_known_rewrite_is_one_an_example_shows() {
    let shown: BTreeSet<String> = MESSAGES
        .iter()
        .flat_map(|(name, round_trip)| round_trip(name).unwrap().rewritten)
        .collect();
    let known: BTreeSet<String> = KNOWN_REWRITES
        .iter()
        .map(|(at, _)| (*at).to_owned())
        .collect();
    assert_eq!(shown, known);
}

#[test]
fn the_schema_takes_a_field_left_out_or_null_only_where_serde_does() {
    let unlike: Vec<String> = MESSAGES
        .iter()
        .flat_map(|(name, round_trip)| round_trip(name).unwrap().unlike)
        .collect();
    assert!(unlike.is_empty(), "{}", unlike.join("\n"));
}

#[test]
fn the_schema_names_the_attention_kinds_the_protocol_names_and_each_reads_as_a_known_kind() {
    let path = fixtures().join("../../schema/AttentionKind.json");
    let protocol: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let names = &protocol["enum"];
    let schema = Schema::of::<AttentionKind>();
    assert_eq!(&schema.resolved(&schema.root)["enum"], names);
    for name in names.as_array().unwrap() {
        let kind: AttentionKind = serde_json::from_value(name.clone()).unwrap();
        assert!(AttentionKind::KNOWN.contains(&kind), "{name}");
    }
}

/// The schema of `T`, or of its property `key`, past every `$ref`, keeping only `keys`.
fn tagged<T: JsonSchema>(key: Option<&str>, keys: &[&str]) -> Value {
    let schema = Schema::of::<T>();
    let mut at = schema.resolved(&schema.root);
    if let Some(key) = key {
        at = schema.resolved(
            at.get("properties")
                .and_then(|p| p.get(key))
                .unwrap_or(&Value::Null),
        );
    }
    keys.iter()
        .filter_map(|k| at.get(*k).map(|v| ((*k).to_owned(), v.clone())))
        .collect::<serde_json::Map<_, _>>()
        .into()
}

#[test]
fn each_refinement_the_protocol_makes_is_named_where_it_makes_it() {
    let keys = [
        "x-bazhen-transform",
        "minLength",
        "maxLength",
        "x-bazhen-check",
    ];
    let title = serde_json::json!({
        "x-bazhen-transform": "trim", "minLength": 1, "maxLength": 200, "x-bazhen-check": "newTaskTitle",
    });
    assert_eq!(tagged::<CreateTaskRequest>(Some("title"), &keys), title);
    assert_eq!(tagged::<DelegateTaskRequest>(Some("title"), &keys), title);
    assert_eq!(
        tagged::<AddTaskNoteRequest>(Some("text"), &keys),
        serde_json::json!({ "x-bazhen-transform": "trim", "minLength": 1, "x-bazhen-check": ["taskNoteBytes", "noteText"] })
    );
    assert_eq!(
        tagged::<FinishTaskRequest>(Some("note"), &keys),
        serde_json::json!({ "maxLength": 20_000, "x-bazhen-check": "noteText" })
    );
    assert_eq!(
        tagged::<EscalateRequest>(Some("summary"), &keys),
        serde_json::json!({ "x-bazhen-transform": "trim", "minLength": 1, "maxLength": 2000 })
    );
    assert_eq!(
        tagged::<DelegateTaskRequest>(None, &keys),
        serde_json::json!({ "x-bazhen-check": "agentOrLaunch" })
    );
    assert_eq!(
        tagged::<OpenShellRequest>(None, &keys),
        serde_json::json!({ "x-bazhen-check": "linkedShellTakesNoCwd" })
    );
    assert_eq!(
        tagged::<TerminalScreen>(Some("text"), &keys),
        serde_json::json!({ "x-bazhen-check": ["wellFormed", "screenText"] })
    );
}

#[test]
fn each_refinement_the_holder_protocol_makes_is_named_where_it_makes_it() {
    use bazhen_holder_proto::body::{
        Argv, Env, ErrorBody, ExitStatus, HelloReply, OkBody, PasteRequest, Screen, SpawnSpec,
        Title,
    };
    let keys = ["minLength", "x-bazhen-check"];
    let well_formed = serde_json::json!({ "x-bazhen-check": "wellFormed" });
    let checks = |names: &[&str]| serde_json::json!({ "x-bazhen-check": names });
    assert_eq!(
        tagged::<PasteRequest>(Some("text"), &keys),
        checks(&["wellFormed", "noControl"])
    );
    assert_eq!(
        tagged::<PasteRequest>(None, &keys),
        serde_json::json!({ "x-bazhen-check": "unmarkedPasteIsAscii" })
    );
    assert_eq!(
        tagged::<Screen>(Some("text"), &keys),
        checks(&["wellFormed", "screenText"])
    );
    let non_empty = serde_json::json!({ "minLength": 1, "x-bazhen-check": ["wellFormed"] });
    assert_eq!(tagged::<SpawnSpec>(Some("cwd"), &keys), non_empty);
    assert_eq!(tagged::<SpawnSpec>(Some("socket"), &keys), non_empty);
    assert_eq!(tagged::<HelloReply>(Some("title"), &keys), well_formed);
    assert_eq!(tagged::<Title>(Some("text"), &keys), well_formed);
    assert_eq!(tagged::<OkBody>(Some("request"), &keys), well_formed);
    for key in ["request", "code", "message"] {
        assert_eq!(tagged::<ErrorBody>(Some(key), &keys), well_formed, "{key}");
    }
    let argv = Schema::of::<Argv>();
    assert_eq!(
        argv.resolved(&argv.root)["items"]["x-bazhen-check"],
        "wellFormed"
    );
    let env = Schema::of::<Env>();
    let env = env.resolved(&env.root);
    assert_eq!(env["propertyNames"]["x-bazhen-check"], "wellFormed");
    assert_eq!(env["additionalProperties"]["x-bazhen-check"], "wellFormed");
    let exit = Schema::of::<ExitStatus>();
    let signalled = exit.resolved(&exit.root)["oneOf"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["properties"]["type"]["const"] == "signalled");
    assert_eq!(
        signalled.map(|b| &b["properties"]["signal"]["x-bazhen-check"]),
        Some(&Value::from("wellFormed"))
    );
}

/// The text `T` writes for `x` at `key` of `template`, read back, and whether the schema takes it
/// there.
fn writes_what_the_schema_takes<T: DeserializeOwned + Serialize + JsonSchema>(
    template: &Value,
    key: &str,
    x: f64,
) -> Result<(String, bool)> {
    let mut wire = template.clone();
    if let Value::Object(fields) = &mut wire {
        fields.insert(key.to_owned(), Value::from(x));
    }
    let decoded: T = serde_json::from_value(wire).map_err(|e| format!("{key}, {x}: {e}"))?;
    let text = serde_json::to_string(&decoded).map_err(|e| format!("{key}, {x}: {e}"))?;
    let written: Value = serde_json::from_str(&text).map_err(|e| format!("{text}: {e}"))?;
    let schema = Schema::of::<T>();
    let property = schema
        .resolved(&schema.root)
        .get("properties")
        .and_then(|p| p.get(key))
        .ok_or(format!("no property {key}"))?;
    let value = written.get(key).ok_or(format!("{text} has no {key}"))?;
    let takes = schema.fits(property, value);
    Ok((text, takes))
}

#[test]
fn a_number_written_as_javascript_writes_it_is_one_the_schema_takes_and_only_a_finite_one_is_read()
{
    let activity = serde_json::json!({
        "value": "idle", "source": "native", "confidence": 0.5, "observedAt": "2026-01-01T00:00:00.000Z",
    });
    let limit = serde_json::json!({ "window": "5h", "usedPercent": 0.5 });
    let usage = serde_json::json!({ "contextUsedPercent": 0.5 });
    let numbers = [
        1.0,
        0.1,
        -0.0,
        1e21,
        1.5e-7,
        f64::MAX,
        f64::MIN_POSITIVE,
        -2.0,
    ];
    for x in numbers {
        for (text, takes) in [
            writes_what_the_schema_takes::<Activity>(&activity, "confidence", x).unwrap(),
            writes_what_the_schema_takes::<UsageLimit>(&limit, "usedPercent", x).unwrap(),
            writes_what_the_schema_takes::<Usage>(&usage, "contextUsedPercent", x).unwrap(),
        ] {
            assert!(takes, "{x}: {text}");
        }
    }
    let reads: [(&Value, Reads); 3] = [
        (&activity, |t| serde_json::from_str::<Activity>(t).is_ok()),
        (&limit, |t| serde_json::from_str::<UsageLimit>(t).is_ok()),
        (&usage, |t| serde_json::from_str::<Usage>(t).is_ok()),
    ];
    for (template, read) in reads {
        assert!(read(&template.to_string()));
        for not_finite in ["1e400", "-1e400", "NaN", "Infinity"] {
            let text = template.to_string().replace("0.5", not_finite);
            assert!(!read(&text), "{text}");
        }
    }
}

/// The example `wire` with the field at `at` left out, or set to `value`.
fn edited(wire: &Value, at: &str, value: Option<Value>) -> Value {
    let mut wire = wire.clone();
    let (parent, key) = at.rsplit_once('/').unwrap_or_default();
    let key = key.replace("~1", "/").replace("~0", "~");
    if let Some(Value::Object(parent)) = wire.pointer_mut(parent) {
        match value {
            Some(value) => {
                parent.insert(key, value);
            }
            None => {
                parent.remove(&key);
            }
        }
    }
    wire
}

/// What a schema says of one field of an object.
struct Field {
    optional: bool,
    nullable: bool,
}

/// A message's schema, with the definitions it names.
struct Schema {
    root: Value,
    definitions: serde_json::Map<String, Value>,
}

impl Schema {
    fn of<T: JsonSchema>() -> Self {
        let mut generator = bazhen_protocol::schema::generator();
        let root = generator.subschema_for::<T>().to_value();
        Self {
            root,
            definitions: generator.take_definitions(true),
        }
    }

    /// `schema`, past every `$ref`.
    fn resolved<'a>(&'a self, mut schema: &'a Value) -> &'a Value {
        while let Some(name) = schema
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|r| r.strip_prefix("#/$defs/"))
        {
            match self.definitions.get(name) {
                Some(named) => schema = named,
                None => break,
            }
        }
        schema
    }

    /// The one branch of `schema` that `value` fits, past every `$ref` and union; none when no
    /// branch or more than one does.
    fn branch<'a>(&'a self, schema: &'a Value, value: &Value) -> Option<&'a Value> {
        let schema = self.resolved(schema);
        let Some(branches) = schema
            .get("anyOf")
            .or_else(|| schema.get("oneOf"))
            .and_then(Value::as_array)
        else {
            return Some(schema);
        };
        let mut fitting = branches.iter().filter(|b| self.fits(b, value));
        match (fitting.next(), fitting.next()) {
            (Some(only), None) => self.branch(only, value),
            _ => None,
        }
    }

    /// Whether `value` is of `schema`'s type and holds its constants and required fields.
    fn fits(&self, schema: &Value, value: &Value) -> bool {
        let schema = self.resolved(schema);
        if schema == &Value::Bool(true) {
            return true;
        }
        if let Some(branches) = schema
            .get("anyOf")
            .or_else(|| schema.get("oneOf"))
            .and_then(Value::as_array)
        {
            return branches.iter().any(|b| self.fits(b, value));
        }
        if let Some(constant) = schema.get("const") {
            return constant == value;
        }
        if let Some(Value::Array(values)) = schema.get("enum") {
            return values.contains(value);
        }
        let typed = |name: &str| match schema.get("type") {
            Some(Value::String(t)) => t == name,
            Some(Value::Array(ts)) => ts.iter().any(|t| t == name),
            _ => false,
        };
        match value {
            Value::Null => typed("null"),
            Value::Bool(_) => typed("boolean"),
            Value::Number(n) => typed("number") || (typed("integer") && (n.is_i64() || n.is_u64())),
            Value::String(_) => typed("string"),
            Value::Array(_) => typed("array"),
            Value::Object(object) => {
                let required = schema
                    .get("required")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str);
                let properties = schema.get("properties").and_then(Value::as_object);
                typed("object")
                    && required.into_iter().all(|r| object.contains_key(r))
                    && properties.into_iter().flatten().all(|(k, p)| {
                        object
                            .get(k)
                            .is_none_or(|v| p.get("const").is_none_or(|c| c == v))
                    })
            }
        }
    }

    /// Whether `schema` takes null.
    fn nullable(&self, schema: &Value) -> bool {
        self.fits(schema, &Value::Null)
    }

    /// Each field of every object in `wire`, by its JSON pointer, with what the schema says of
    /// it: a field of a union no branch alone fits is skipped, as is a record's.
    fn fields(&self, wire: &Value) -> Vec<(String, Field)> {
        let mut found = Vec::new();
        self.walk(&self.root, wire, "", &mut found);
        found
    }

    fn walk(&self, schema: &Value, value: &Value, at: &str, found: &mut Vec<(String, Field)>) {
        let Some(schema) = self.branch(schema, value) else {
            return;
        };
        match value {
            Value::Object(object) => {
                let properties = schema.get("properties").and_then(Value::as_object);
                let required: BTreeSet<&str> = schema
                    .get("required")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                for (key, field) in object {
                    let Some(property) = properties.and_then(|p| p.get(key)) else {
                        continue;
                    };
                    let path = format!("{at}/{}", key.replace('~', "~0").replace('/', "~1"));
                    found.push((
                        path.clone(),
                        Field {
                            optional: !required.contains(key.as_str()),
                            nullable: self.nullable(property),
                        },
                    ));
                    self.walk(property, field, &path, found);
                }
            }
            Value::Array(items) => {
                if let Some(each) = schema.get("items") {
                    for (i, item) in items.iter().enumerate() {
                        self.walk(each, item, &format!("{at}/{i}"), found);
                    }
                }
            }
            _ => {}
        }
    }
}

#[test]
fn every_fixture_file_is_a_message_a_type_here_reads() {
    let written: BTreeSet<String> = fs::read_dir(fixtures())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|f| f != "checks.json")
        .collect();
    let read: BTreeSet<String> = MESSAGES.iter().map(|(n, _)| format!("{n}.json")).collect();
    assert_eq!(written, read);
}

fn checks() -> Result<Value> {
    read("checks.json")
}

fn cases(check: &str) -> Result<Vec<Value>> {
    checks()?
        .get(check)
        .and_then(Value::as_array)
        .cloned()
        .ok_or(format!("checks.json has no {check}"))
}

fn input(case: &Value) -> &str {
    case.get("input")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// A case's verdict: the value the protocol took, or its message for refusing it.
fn verdict(case: &Value) -> std::result::Result<String, String> {
    let text = |key: &str| {
        case.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    if case.get("ok") == Some(&Value::Bool(true)) {
        Ok(text("value"))
    } else {
        Err(text("message"))
    }
}

/// Each section of `checks.json` a test here reads; one it doesn't fails.
const CHECKS: [&str; 12] = [
    "agentName",
    "agentRef",
    "constants",
    "datetime",
    "detachKeys",
    "keystrokes",
    "origin",
    "plainRemote",
    "quoteNote",
    "role",
    "taskId",
    "taskNoteText",
];

#[test]
fn every_section_of_the_checks_is_one_a_test_here_reads() {
    let checks = checks().unwrap();
    let written: BTreeSet<&str> = checks
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(written, CHECKS.into_iter().collect());
}

#[test]
fn a_time_is_read_as_the_protocol_takes_it_and_javascript_reads_it() {
    for case in cases("datetime").unwrap() {
        let expected = (case["ok"] == true).then(|| case["ms"].as_i64().unwrap());
        assert_eq!(timestamp_ms(input(&case)), expected, "{case}");
    }
}

#[test]
fn names_and_references_are_what_the_protocol_takes() {
    for case in cases("agentName").unwrap() {
        let got = AgentName::parse(input(&case)).map(|n| n.as_str().to_owned());
        assert_eq!(got.map_err(|e| e.to_string()), verdict(&case), "{case}");
    }
    for case in cases("agentRef").unwrap() {
        let got = AgentRef::parse(input(&case)).map(|r| r.as_str().to_owned());
        assert_eq!(got.map_err(|e| e.to_string()), verdict(&case), "{case}");
    }
    for case in cases("role").unwrap() {
        assert_eq!(
            Role::parse(input(&case)).is_some(),
            case["ok"] == true,
            "{case}"
        );
    }
    for case in cases("taskId").unwrap() {
        assert_eq!(
            TaskId::parse(input(&case)).is_some(),
            case["ok"] == true,
            "{case}"
        );
        assert_eq!(is_id("task", input(&case)), case["ok"] == true, "{case}");
    }
}

#[test]
fn a_note_is_trimmed_and_held_to_its_limit_and_characters_as_the_protocol_holds_it() {
    for case in cases("taskNoteText").unwrap() {
        let got = task_note_text(input(&case)).map_err(|e| e.to_string());
        assert_eq!(got, verdict(&case), "{case}");
    }
}

#[test]
fn notes_are_quoted_and_origins_judged_as_the_protocol_does() {
    for case in cases("quoteNote").unwrap() {
        assert_eq!(
            quote_note(input(&case)),
            case["quoted"].as_str().unwrap(),
            "{case}"
        );
    }
    for case in cases("plainRemote").unwrap() {
        assert_eq!(
            is_plain_remote(input(&case)),
            case["plain"] == true,
            "{case}"
        );
    }
}

#[test]
fn an_origin_is_one_only_as_a_browser_sends_it() {
    for case in cases("origin").unwrap() {
        assert_eq!(is_origin(input(&case)), case["origin"] == true, "{case}");
    }
}

#[test]
fn detach_keys_are_read_as_the_daemon_reads_them_and_shown_as_it_shows_them() {
    for case in cases("detachKeys").unwrap() {
        let got = DetachKeys::parse(input(&case)).map(|k| k.to_string());
        assert_eq!(got.map_err(|e| e.to_string()), verdict(&case), "{case}");
    }
}

/// A view's input as the TypeScript reads it: one byte per character.
fn latin1(text: &str) -> Result<Vec<u8>> {
    text.chars()
        .map(|c| u8::try_from(u32::from(c)).map_err(|_| format!("{c:?} isn't one byte")))
        .collect()
}

#[test]
fn input_holds_keystrokes_as_the_protocol_reads_it() {
    for case in cases("keystrokes").unwrap() {
        let bytes = latin1(input(&case)).unwrap();
        assert_eq!(has_keystrokes(&bytes), case["keystrokes"] == true, "{case}");
    }
}

#[test]
fn input_keeps_what_the_protocol_keeps_once_the_terminal_s_replies_are_taken_out() {
    for case in cases("keystrokes").unwrap() {
        let kept = case["withoutReplies"].as_str().unwrap();
        assert_eq!(
            without_replies(&latin1(input(&case)).unwrap()),
            latin1(kept).unwrap(),
            "{case}"
        );
    }
}

#[test]
fn the_constants_are_the_protocols() {
    let checks = checks().unwrap();
    let constants = &checks["constants"];
    assert_eq!(constants["messageWaitMaxMs"], MESSAGE_WAIT_MAX_MS);
    assert_eq!(constants["taskNoteMaxBytes"], TASK_NOTE_MAX_BYTES);
    assert_eq!(constants["agentNameMax"], AGENT_NAME_MAX);
    assert_eq!(constants["streamFrameMaxBytes"], STREAM_FRAME_MAX_BYTES);
    assert_eq!(constants["pairingAlphabet"], PAIRING_ALPHABET);
    assert_eq!(constants["pairingCodeLength"], PAIRING_CODE_LENGTH);
    assert_eq!(constants["deviceNameMax"], DEVICE_NAME_MAX);
    assert_eq!(constants["devicePaired"], DEVICE_PAIRED);
    let harnesses: Vec<&str> = HarnessId::ALL.iter().map(|h| h.as_str()).collect();
    assert_eq!(constants["harnesses"], serde_json::json!(harnesses));
    let all = [
        MailboxState::Queued,
        MailboxState::Offered,
        MailboxState::Emitted,
        MailboxState::Seen,
        MailboxState::QueuedInCodex,
        MailboxState::Delivered,
        MailboxState::Undeliverable,
    ];
    let mut settled: Vec<&str> = all
        .iter()
        .filter(|s| s.settled())
        .map(|s| s.as_str())
        .collect();
    settled.sort_unstable();
    assert_eq!(constants["settled"], serde_json::json!(settled));
    let agent: Vec<&str> = AgentCondition::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(constants["agentConditions"], serde_json::json!(agent));
    let shell: Vec<&str> = ShellCondition::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(constants["shellConditions"], serde_json::json!(shell));
}
