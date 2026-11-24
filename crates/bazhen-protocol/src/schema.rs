//! The API's messages as JSON Schema, which `cargo xtask schema` writes the TypeScript protocol
//! from.

use std::borrow::Cow;
use std::marker::PhantomData;

use schemars::generate::SchemaSettings;
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

/// A generator of the protocol's dialect: JSON Schema 2020-12, each named type under `$defs`.
pub fn generator() -> SchemaGenerator {
    SchemaSettings::draft2020_12().into_generator()
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
