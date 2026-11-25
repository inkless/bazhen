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
use crate::events::typed::{TypedEventFrame, TypedRecordedEvent};
use crate::events::{ClientEventFrame, EventFrame, EventStreamQuery};
use crate::mail::{
    AnswerAttentionRequest, AnswerAttentionResponse, DismissAttentionRequest,
    DismissAttentionResponse, HookAck, HookReply, HookRequest, ReplyAttentionRequest,
    ReplyAttentionResponse, ResendAttentionRequest, ResendAttentionResponse, SendMessageRequest,
    SendMessageResponse, WaitMessagesRequest, WaitMessagesResponse,
};
use crate::notices::{
    DevicesResponse, DismissNoticeRequest, DismissNoticeResponse, PairRequest, PairResponse,
    PairingCodeResponse, RevokeDeviceResponse,
};
use crate::roles::RolesResponse;
use crate::shells::{
    CloseShellRequest, OpenShellRequest, RenameShellRequest, RestartShellRequest,
    ShellCommandResponse, ShellDecline, ShellPrompt, ShellReport, UnlinkShellRequest,
};
use crate::stream::{StreamClientFrame, StreamServerFrame};
use crate::tasks::{
    AddTaskNoteRequest, AssignTaskRequest, AssignTaskResponse, BroadcastMessageResponse,
    CreateTaskRequest, CreateTaskResponse, DelegateTaskRequest, EscalateRequest, EscalateResponse,
    FinishTaskRequest, TaskCommandResponse, TaskDetail, UnassignTaskRequest,
};
use crate::terminals::TerminalScreen;
use crate::waits::{WaitRequest, WaitResponse};

/// A generator of the protocol's dialect: JSON Schema 2020-12, each named type under `$defs`, each
/// integer's range stated.
pub fn generator() -> SchemaGenerator {
    SchemaSettings::draft2020_12()
        .with_transform(IntegerRanges)
        .into_generator()
}

/// The largest integer a JavaScript number holds exactly, 2^53 - 1: `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// The range each integer format holds, as the protocol states it: schemars states it for some
/// formats only, and zod reads no format. A JavaScript peer reads a JSON number as a double, so a
/// 64-bit integer is one a double holds exactly, as zod's `.int()` says. A bound the type states
/// is kept. This bounds the schema only: serde reads what the Rust type holds.
#[derive(Debug, Clone)]
struct IntegerRanges;

const INTEGER_RANGES: [(&str, i64, i64); 8] = [
    ("int8", i8::MIN as i64, i8::MAX as i64),
    ("int16", i16::MIN as i64, i16::MAX as i64),
    ("int32", i32::MIN as i64, i32::MAX as i64),
    ("int64", -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER),
    ("uint8", 0, u8::MAX as i64),
    ("uint16", 0, u16::MAX as i64),
    ("uint32", 0, u32::MAX as i64),
    ("uint64", 0, MAX_SAFE_INTEGER),
];

impl Transform for IntegerRanges {
    fn transform(&mut self, schema: &mut Schema) {
        let format = schema.get("format").and_then(serde_json::Value::as_str);
        let range = INTEGER_RANGES
            .iter()
            .find(|(name, ..)| Some(*name) == format)
            .map(|(_, low, high)| (*low, *high));
        if let (Some((low, high)), Some(object)) = (range, schema.as_object_mut()) {
            object.entry("minimum").or_insert(low.into());
            object.entry("maximum").or_insert(high.into());
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
    generator.subschema_for::<AnswerAttentionRequest>();
    generator.subschema_for::<AnswerAttentionResponse>();
    generator.subschema_for::<DelegateTaskRequest>();
    generator.subschema_for::<DismissAttentionRequest>();
    generator.subschema_for::<DismissAttentionResponse>();
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
    generator.subschema_for::<ClientEventFrame>();
    generator.subschema_for::<EventStreamQuery>();
    generator.subschema_for::<TypedEventFrame>();
    generator.subschema_for::<TypedRecordedEvent>();
    generator.subschema_for::<FinishTaskRequest>();
    generator.subschema_for::<FleetAgent>();
    generator.subschema_for::<HealthResponse>();
    generator.subschema_for::<HookAck>();
    generator.subschema_for::<HookReply>();
    generator.subschema_for::<HookRequest>();
    generator.subschema_for::<LaunchAgentRequest>();
    generator.subschema_for::<LaunchAgentResponse>();
    generator.subschema_for::<OpenShellRequest>();
    generator.subschema_for::<PairRequest>();
    generator.subschema_for::<PairResponse>();
    generator.subschema_for::<PairingCodeResponse>();
    generator.subschema_for::<RelaunchAgentRequest>();
    generator.subschema_for::<RenameAgentRequest>();
    generator.subschema_for::<ReplyAttentionRequest>();
    generator.subschema_for::<ReplyAttentionResponse>();
    generator.subschema_for::<ResendAttentionRequest>();
    generator.subschema_for::<ResendAttentionResponse>();
    generator.subschema_for::<RenameShellRequest>();
    generator.subschema_for::<RestartShellRequest>();
    generator.subschema_for::<RespawnAgentRequest>();
    generator.subschema_for::<RevokeDeviceResponse>();
    generator.subschema_for::<RolesResponse>();
    generator.subschema_for::<SendMessageRequest>();
    generator.subschema_for::<SendMessageResponse>();
    generator.subschema_for::<ShellCommandResponse>();
    generator.subschema_for::<ShellDecline>();
    generator.subschema_for::<ShellPrompt>();
    generator.subschema_for::<ShellReport>();
    generator.subschema_for::<SignalAgentRequest>();
    generator.subschema_for::<TerminalScreen>();
    generator.subschema_for::<StateSnapshot>();
    generator.subschema_for::<StopResponse>();
    generator.subschema_for::<StreamClientFrame>();
    generator.subschema_for::<StreamServerFrame>();
    generator.subschema_for::<TaskCommandResponse>();
    generator.subschema_for::<TaskDetail>();
    generator.subschema_for::<UnassignTaskRequest>();
    generator.subschema_for::<UnlinkShellRequest>();
    generator.subschema_for::<WaitMessagesRequest>();
    generator.subschema_for::<WaitMessagesResponse>();
    generator.subschema_for::<WaitRequest>();
    generator.subschema_for::<WaitResponse>();
    add_definitions(generator);
}

/// Adds the definitions the protocol names that no message holds: what a client checks with, and
/// what a program reads from the CLI.
fn add_definitions(generator: &mut SchemaGenerator) {
    generator.subschema_for::<CompactWindowTokens>();
    generator.subschema_for::<FleetAgents>();
    generator.subschema_for::<NoticeAction>();
    generator.subschema_for::<RuntimeHealthState>();
    generator.subschema_for::<ShellCommandLine>();
    generator.subschema_for::<TaskBrief>();
    generator.subschema_for::<TaskTitle>();
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

/// A task's title as a task holds it: trimmed and 1 to 200 long. A request's is [`NewTaskTitle`].
#[derive(Debug)]
pub struct TaskTitle;

impl JsonSchema for TaskTitle {
    fn schema_name() -> Cow<'static, str> {
        "TaskTitle".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "x-bazhen-transform": "trim",
            "minLength": 1,
            "maxLength": crate::text::TASK_TITLE_MAX_CHARS,
        })
    }
}

/// A task's brief: 1 to 20 000 long.
#[derive(Debug)]
pub struct TaskBrief;

impl JsonSchema for TaskBrief {
    fn schema_name() -> Cow<'static, str> {
        "TaskBrief".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "minLength": 1,
            "maxLength": crate::text::TASK_BRIEF_MAX_CHARS,
        })
    }
}

/// Tokens of context a harness is given before it compacts: 100 000 to 10 000 000.
#[derive(Debug)]
pub struct CompactWindowTokens;

impl JsonSchema for CompactWindowTokens {
    fn schema_name() -> Cow<'static, str> {
        "CompactWindowTokens".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "integer",
            "format": "uint32",
            "minimum": 100_000,
            "maximum": 10_000_000,
        })
    }
}

/// A runtime's health when it was read: [`RuntimeReportState`] but `Unused`.
///
/// [`RuntimeReportState`]: crate::daemon::RuntimeReportState
#[derive(Debug)]
pub struct RuntimeHealthState;

impl JsonSchema for RuntimeHealthState {
    fn schema_name() -> Cow<'static, str> {
        "RuntimeHealthState".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "enum": ["healthy", "unreachable", "not-running"],
        })
    }
}

/// An action a notice offers, as this version names them. A notice's `actions` are strings, so a
/// client of another version reads them.
#[derive(Debug)]
pub struct NoticeAction;

impl JsonSchema for NoticeAction {
    fn schema_name() -> Cow<'static, str> {
        "NoticeAction".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({ "type": "string", "enum": ["dismiss"] })
    }
}

/// The agents `bazhen agents --json` prints, in order.
#[derive(Debug)]
pub struct FleetAgents;

impl JsonSchema for FleetAgents {
    fn schema_name() -> Cow<'static, str> {
        "FleetAgents".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        Vec::<FleetAgent>::json_schema(generator)
    }
}

/// A line kept to type back into a shell's replacement without Enter, as
/// [`shell_command_line`](crate::shells::shell_command_line) keeps it: no leading space, control,
/// bidirectional override or character that draws as nothing, and at most
/// [`COMMAND_LINE_MAX_BYTES`](crate::shells::COMMAND_LINE_MAX_BYTES) of UTF-8.
#[derive(Debug)]
pub struct ShellCommandLine;

impl JsonSchema for ShellCommandLine {
    fn schema_name() -> Cow<'static, str> {
        "ShellCommandLine".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "minLength": 1,
            "x-bazhen-check": [
                "commandLineInHistory",
                "commandLineShowable",
                "commandLineVisible",
                "commandLineBytes",
            ],
        })
    }
}

/// A name a person gives a shell: trimmed, 1 to 80 long, with no control character or
/// bidirectional override.
#[derive(Debug)]
pub struct ShellName;

impl JsonSchema for ShellName {
    fn schema_name() -> Cow<'static, str> {
        "ShellName".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "x-bazhen-transform": "trim",
            "minLength": 1,
            "maxLength": crate::shells::SHELL_NAME_MAX_CHARS,
            "x-bazhen-check": "shellName",
        })
    }
}

/// The versions a holder speaks, as the holder protocol's `HolderVersions` bounds them: 1 to 16,
/// each well formed and at most 32 bytes of UTF-8.
#[derive(Debug)]
pub struct HolderVersionList;

impl JsonSchema for HolderVersionList {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "HolderVersionList".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "array",
            "items": { "type": "string", "x-bazhen-check": ["wellFormed", "utf8AtMost32Bytes"] },
            "minItems": 1,
            "maxItems": 16,
        })
    }
}

/// A line a shell reports running, as the report bounds it.
#[derive(Debug)]
pub struct ReportedLine;

impl JsonSchema for ReportedLine {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "ReportedLine".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "maxLength": crate::shells::REPORTED_LINE_MAX_CHARS,
        })
    }
}

/// A terminal's screen as text: well formed, with no control but the newline ending each row.
#[derive(Debug)]
pub struct ScreenText;

impl JsonSchema for ScreenText {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "ScreenText".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "x-bazhen-check": ["wellFormed", "screenText"],
        })
    }
}

/// `true`, the one value a flag that can only be set takes.
#[derive(Debug)]
pub struct OnlyTrue;

impl JsonSchema for OnlyTrue {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "OnlyTrue".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({ "type": "boolean", "const": true })
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
            "x-bazhen-check": ["taskNoteBytes", "noteText"],
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
            "x-bazhen-check": "noteText",
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

/// A string enum of `variants` as serde writes each, in their order: a derive groups the
/// variants a doc comment describes apart from the rest, which loses the order zod's `.options`
/// keeps.
pub(crate) fn in_order<T: serde::Serialize>(variants: &[T]) -> Schema {
    let names: Vec<serde_json::Value> = variants
        .iter()
        .map(|v| serde_json::to_value(v).unwrap_or_default())
        .collect();
    schemars::json_schema!({ "type": "string", "enum": names })
}

/// What the edge gives back of a request it took, or the rule it broke.
fn given<T: serde::Serialize>(
    taken: Result<T, crate::edge::Refused>,
) -> Result<serde_json::Value, String> {
    serde_json::to_value(taken.map_err(|refused| refused.0)?).map_err(|err| err.to_string())
}

/// The edge's verdict on `body` as the message the schema `name` names, or none where the
/// daemon's edge doesn't read that message.
pub fn verdict(name: &str, body: &[u8]) -> Option<Result<serde_json::Value, String>> {
    use crate::edge::edge;
    Some(match name {
        "AddTaskNoteRequest" => given(edge::<AddTaskNoteRequest>(body)),
        "AnswerAttentionRequest" => given(edge::<AnswerAttentionRequest>(body)),
        "AssignTaskRequest" => given(edge::<AssignTaskRequest>(body)),
        "CloseAgentRequest" => given(edge::<CloseAgentRequest>(body)),
        "CloseShellRequest" => given(edge::<CloseShellRequest>(body)),
        "CreateTaskRequest" => given(edge::<CreateTaskRequest>(body)),
        "DelegateTaskRequest" => given(edge::<DelegateTaskRequest>(body)),
        "DismissAttentionRequest" => given(edge::<DismissAttentionRequest>(body)),
        "DismissNoticeRequest" => given(edge::<DismissNoticeRequest>(body)),
        "EscalateRequest" => given(edge::<EscalateRequest>(body)),
        "FinishTaskRequest" => given(edge::<FinishTaskRequest>(body)),
        "OpenShellRequest" => given(edge::<OpenShellRequest>(body)),
        "PairRequest" => given(edge::<PairRequest>(body)),
        "RelaunchAgentRequest" => given(edge::<RelaunchAgentRequest>(body)),
        "RenameShellRequest" => given(edge::<RenameShellRequest>(body)),
        "ReplyAttentionRequest" => given(edge::<ReplyAttentionRequest>(body)),
        "ResendAttentionRequest" => given(edge::<ResendAttentionRequest>(body)),
        "RespawnAgentRequest" => given(edge::<RespawnAgentRequest>(body)),
        "RestartShellRequest" => given(edge::<RestartShellRequest>(body)),
        "SendMessageRequest" => given(edge::<SendMessageRequest>(body)),
        "ShellDecline" => given(edge::<ShellDecline>(body)),
        "ShellPrompt" => given(edge::<ShellPrompt>(body)),
        "ShellReport" => given(edge::<ShellReport>(body)),
        "SignalAgentRequest" => given(edge::<SignalAgentRequest>(body)),
        "UnassignTaskRequest" => given(edge::<UnassignTaskRequest>(body)),
        "UnlinkShellRequest" => given(edge::<UnlinkShellRequest>(body)),
        _ => return None,
    })
}
