//! The API's messages as JSON Schema, which `cargo xtask schema` writes the TypeScript protocol
//! from.

use std::borrow::Cow;
use std::marker::PhantomData;

use schemars::generate::SchemaSettings;
use schemars::transform::{Transform, transform_subschemas};
use schemars::{JsonSchema, Schema, SchemaGenerator};

use crate::agents::{
    AgentCommandResponse, CallerResponse, CloseAgentRequest, FleetAgent, LaunchAgentRequest,
    LaunchAgentResponse, RelaunchAgentRequest, RenameAgentRequest, RespawnAgentRequest,
    SignalAgentRequest, StateSnapshot,
};
use crate::daemon::{
    DoctorResponse, EnvRefreshRequest, EnvRefreshResponse, ErrorResponse, HealthResponse,
    StopResponse,
};
use crate::events::EventFrame;
use crate::mail::{
    SendMessageRequest, SendMessageResponse, WaitMessagesRequest, WaitMessagesResponse,
};
use crate::notices::{
    DevicesResponse, DismissNoticeRequest, DismissNoticeResponse, PairRequest, PairResponse,
    PairingCodeResponse, RevokeDeviceResponse,
};
use crate::roles::RolesResponse;
use crate::shells::{CloseShellRequest, OpenShellRequest, ShellCommandResponse};
use crate::stream::{StreamClientFrame, StreamServerFrame};
use crate::tasks::{
    AddTaskNoteRequest, AssignTaskRequest, AssignTaskResponse, BroadcastMessageResponse,
    CreateTaskRequest, CreateTaskResponse, DelegateTaskRequest, EscalateRequest, EscalateResponse,
    FinishTaskRequest, TaskCommandResponse, TaskDetail, UnassignTaskRequest,
};
use crate::terminals::TerminalScreen;
use crate::waits::{WaitRequest, WaitResponse};

/// A generator of the protocol's dialect: JSON Schema 2020-12, each named type under `$defs`, its
/// 64-bit integers held to what JavaScript reads exactly.
pub fn generator() -> SchemaGenerator {
    SchemaSettings::draft2020_12()
        .with_transform(SafeIntegers)
        .into_generator()
}

/// The largest integer a JavaScript number holds exactly, 2^53 - 1: `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// A JavaScript peer reads a JSON number as a double, so the protocol's 64-bit integers are those
/// a double holds exactly, as zod's `.int()` says. This bounds the schema only: serde still reads
/// any `u64` or `i64`.
#[derive(Debug, Clone)]
struct SafeIntegers;

impl Transform for SafeIntegers {
    fn transform(&mut self, schema: &mut Schema) {
        let format = schema.get("format").and_then(serde_json::Value::as_str);
        let signed = match format {
            Some("uint64") => false,
            Some("int64") => true,
            _ => return transform_subschemas(self, schema),
        };
        if let Some(object) = schema.as_object_mut() {
            object.entry("maximum").or_insert(MAX_SAFE_INTEGER.into());
            if signed {
                object
                    .entry("minimum")
                    .or_insert((-MAX_SAFE_INTEGER).into());
            }
        }
        transform_subschemas(self, schema);
    }
}

/// Adds every message of the API to `generator`'s definitions, with each type it names.
pub fn add_messages(generator: &mut SchemaGenerator) {
    generator.subschema_for::<AddTaskNoteRequest>();
    generator.subschema_for::<AgentCommandResponse>();
    generator.subschema_for::<AssignTaskRequest>();
    generator.subschema_for::<AssignTaskResponse>();
    generator.subschema_for::<BroadcastMessageResponse>();
    generator.subschema_for::<CallerResponse>();
    generator.subschema_for::<CloseAgentRequest>();
    generator.subschema_for::<CloseShellRequest>();
    generator.subschema_for::<CreateTaskRequest>();
    generator.subschema_for::<CreateTaskResponse>();
    generator.subschema_for::<DelegateTaskRequest>();
    generator.subschema_for::<DevicesResponse>();
    generator.subschema_for::<DismissNoticeRequest>();
    generator.subschema_for::<DismissNoticeResponse>();
    generator.subschema_for::<DoctorResponse>();
    generator.subschema_for::<EnvRefreshRequest>();
    generator.subschema_for::<EnvRefreshResponse>();
    generator.subschema_for::<ErrorResponse>();
    generator.subschema_for::<EscalateRequest>();
    generator.subschema_for::<EscalateResponse>();
    generator.subschema_for::<EventFrame>();
    generator.subschema_for::<FinishTaskRequest>();
    generator.subschema_for::<FleetAgent>();
    generator.subschema_for::<HealthResponse>();
    generator.subschema_for::<LaunchAgentRequest>();
    generator.subschema_for::<LaunchAgentResponse>();
    generator.subschema_for::<OpenShellRequest>();
    generator.subschema_for::<PairRequest>();
    generator.subschema_for::<PairResponse>();
    generator.subschema_for::<PairingCodeResponse>();
    generator.subschema_for::<RelaunchAgentRequest>();
    generator.subschema_for::<RenameAgentRequest>();
    generator.subschema_for::<RespawnAgentRequest>();
    generator.subschema_for::<RevokeDeviceResponse>();
    generator.subschema_for::<RolesResponse>();
    generator.subschema_for::<SendMessageRequest>();
    generator.subschema_for::<SendMessageResponse>();
    generator.subschema_for::<ShellCommandResponse>();
    generator.subschema_for::<SignalAgentRequest>();
    generator.subschema_for::<TerminalScreen>();
    generator.subschema_for::<StateSnapshot>();
    generator.subschema_for::<StopResponse>();
    generator.subschema_for::<StreamClientFrame>();
    generator.subschema_for::<StreamServerFrame>();
    generator.subschema_for::<TaskCommandResponse>();
    generator.subschema_for::<TaskDetail>();
    generator.subschema_for::<UnassignTaskRequest>();
    generator.subschema_for::<WaitMessagesRequest>();
    generator.subschema_for::<WaitMessagesResponse>();
    generator.subschema_for::<WaitRequest>();
    generator.subschema_for::<WaitResponse>();
}

/// The schema of a field that must be there and may be null, as `Option::deserialize` reads an
/// `Option`: schemars leaves out of `required` only a field whose type is an `Option`, which this
/// isn't, so it stays in.
#[derive(Debug)]
pub struct Required<T>(PhantomData<T>);

impl<T: JsonSchema> JsonSchema for Required<T> {
    fn inline_schema() -> bool {
        Option::<T>::inline_schema()
    }

    fn schema_name() -> Cow<'static, str> {
        Option::<T>::schema_name()
    }

    fn schema_id() -> Cow<'static, str> {
        Option::<T>::schema_id()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        Option::<T>::json_schema(generator)
    }
}

/// A title a request gives a task: trimmed, 1 to 200 long, and fit for a line of mail.
#[derive(Debug)]
pub struct NewTaskTitle;

impl JsonSchema for NewTaskTitle {
    fn schema_name() -> Cow<'static, str> {
        "NewTaskTitle".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "x-bazhen-transform": "trim",
            "minLength": 1,
            "maxLength": 200,
            "x-bazhen-check": "newTaskTitle",
        })
    }
}

/// What a task note says: trimmed, not empty, and within its UTF-8 budget and fit for a note,
/// which `checks.ts` holds it to.
#[derive(Debug)]
pub struct TaskNoteText;

impl JsonSchema for TaskNoteText {
    fn schema_name() -> Cow<'static, str> {
        "TaskNoteText".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "x-bazhen-transform": "trim",
            "minLength": 1,
            "x-bazhen-check": "taskNoteText",
        })
    }
}

/// What the one who finishes a task says of it: a message's length, and fit for a note.
#[derive(Debug)]
pub struct FinishNoteText;

impl JsonSchema for FinishNoteText {
    fn schema_name() -> Cow<'static, str> {
        "FinishNoteText".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "maxLength": 20_000,
            "x-bazhen-check": "finishNoteText",
        })
    }
}

/// The key a request is made once by: 1 to 200 long.
#[derive(Debug)]
pub struct IdempotencyKey;

impl JsonSchema for IdempotencyKey {
    fn schema_name() -> Cow<'static, str> {
        "IdempotencyKey".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({ "type": "string", "minLength": 1, "maxLength": 200 })
    }
}

/// An instant as zod's `iso.datetime()` takes it: a real date of the Gregorian calendar, then a
/// time in UTC to the second or any fraction of one, with `Z`.
pub const TIMESTAMP_PATTERN: &str = r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$";

/// An instant: [`TIMESTAMP_PATTERN`].
#[derive(Debug)]
pub struct Timestamp;

impl JsonSchema for Timestamp {
    fn schema_name() -> Cow<'static, str> {
        "Timestamp".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({ "type": "string", "pattern": TIMESTAMP_PATTERN })
    }
}

/// An event's place in the log: from 1, and within what JavaScript reads exactly.
#[derive(Debug)]
pub struct EventId;

impl JsonSchema for EventId {
    fn schema_name() -> Cow<'static, str> {
        "EventId".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({ "type": "integer", "minimum": 1, "maximum": MAX_SAFE_INTEGER })
    }
}
