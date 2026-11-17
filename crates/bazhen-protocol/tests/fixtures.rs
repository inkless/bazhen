//! The Rust types against the fixtures `pnpm schema` writes from the TypeScript protocol: each
//! message decodes from every wire example and encodes back to what zod made of it, and every
//! check gives the protocol's verdict. A fixture file no type here reads fails the test.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use bazhen_protocol::agents::{
    AgentCommandResponse, CallerResponse, FleetAgent, HarnessId, RenameAgentRequest, StateSnapshot,
};
use bazhen_protocol::daemon::{
    DoctorResponse, EnvRefreshRequest, EnvRefreshResponse, HealthResponse, StopResponse,
};
use bazhen_protocol::ids::{TaskId, is_id};
use bazhen_protocol::input::has_keystrokes;
use bazhen_protocol::mail::{
    MESSAGE_WAIT_MAX_MS, MailboxState, SendMessageRequest, SendMessageResponse,
    WaitMessagesRequest, WaitMessagesResponse,
};
use bazhen_protocol::names::{AGENT_NAME_MAX, AgentName, AgentRef, Role};
use bazhen_protocol::notices::{
    DevicesResponse, DismissNoticeRequest, DismissNoticeResponse, PairingCodeResponse,
    RevokeDeviceResponse,
};
use bazhen_protocol::roles::RolesResponse;
use bazhen_protocol::stream::{STREAM_FRAME_MAX_BYTES, StreamClientFrame, StreamServerFrame};
use bazhen_protocol::tasks::{
    AddTaskNoteRequest, AssignTaskRequest, AssignTaskResponse, BroadcastMessageResponse,
    CreateTaskRequest, CreateTaskResponse, DelegateTaskRequest, EscalateRequest, EscalateResponse,
    FinishTaskRequest, TaskCommandResponse, TaskDetail, UnassignTaskRequest,
};
use bazhen_protocol::text::{TASK_NOTE_MAX_BYTES, is_plain_remote, quote_note, task_note_text};
use bazhen_protocol::time::timestamp_ms;
use bazhen_protocol::wire;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

type Result<T> = std::result::Result<T, String>;

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

/// Every example of the message `name` decodes as `T` and encodes back to its parsed form; how
/// many there were.
fn round_trips<T: DeserializeOwned + Serialize>(name: &str) -> Result<usize> {
    let examples = read(&format!("{name}.json"))?;
    let examples = examples.as_array().ok_or(format!("{name}: not a list"))?;
    for example in examples {
        let what = example.get("name").cloned().unwrap_or_default();
        let wire = example.get("wire").cloned().unwrap_or_default();
        let parsed = example.get("parsed").cloned().unwrap_or_default();
        let decoded: T =
            serde_json::from_value(wire).map_err(|e| format!("{name}, {what}: {e}"))?;
        let encoded = serde_json::to_value(&decoded).map_err(|e| format!("{name}, {what}: {e}"))?;
        if !same(&encoded, &parsed) {
            return Err(format!(
                "{name}, {what}:\n  encoded {encoded}\n  parsed  {parsed}"
            ));
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
    Ok(examples.len())
}

type RoundTrip = fn(&str) -> Result<usize>;

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
    ("CreateTaskRequest", round_trips::<CreateTaskRequest>),
    ("CreateTaskResponse", round_trips::<CreateTaskResponse>),
    ("DelegateTaskRequest", round_trips::<DelegateTaskRequest>),
    ("DevicesResponse", round_trips::<DevicesResponse>),
    ("DismissNoticeRequest", round_trips::<DismissNoticeRequest>),
    (
        "DismissNoticeResponse",
        round_trips::<DismissNoticeResponse>,
    ),
    ("DoctorResponse", round_trips::<DoctorResponse>),
    ("EnvRefreshRequest", round_trips::<EnvRefreshRequest>),
    ("EnvRefreshResponse", round_trips::<EnvRefreshResponse>),
    ("EscalateRequest", round_trips::<EscalateRequest>),
    ("EscalateResponse", round_trips::<EscalateResponse>),
    ("FinishTaskRequest", round_trips::<FinishTaskRequest>),
    ("FleetAgent", round_trips::<FleetAgent>),
    ("HealthResponse", round_trips::<HealthResponse>),
    ("PairingCodeResponse", round_trips::<PairingCodeResponse>),
    ("RenameAgentRequest", round_trips::<RenameAgentRequest>),
    ("RevokeDeviceResponse", round_trips::<RevokeDeviceResponse>),
    ("RolesResponse", round_trips::<RolesResponse>),
    ("SendMessageRequest", round_trips::<SendMessageRequest>),
    ("SendMessageResponse", round_trips::<SendMessageResponse>),
    ("StateSnapshot", round_trips::<StateSnapshot>),
    ("StopResponse", round_trips::<StopResponse>),
    ("StreamClientFrame", round_trips::<StreamClientFrame>),
    ("StreamServerFrame", round_trips::<StreamServerFrame>),
    ("TaskCommandResponse", round_trips::<TaskCommandResponse>),
    ("TaskDetail", round_trips::<TaskDetail>),
    ("UnassignTaskRequest", round_trips::<UnassignTaskRequest>),
    ("WaitMessagesRequest", round_trips::<WaitMessagesRequest>),
    ("WaitMessagesResponse", round_trips::<WaitMessagesResponse>),
];

#[test]
fn every_message_decodes_its_examples_and_encodes_what_the_protocol_makes_of_them() {
    for (name, round_trip) in MESSAGES {
        assert!(round_trip(name).unwrap() > 0, "{name} has no examples");
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
const CHECKS: [&str; 10] = [
    "agentName",
    "agentRef",
    "constants",
    "datetime",
    "keystrokes",
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
fn input_holds_keystrokes_as_the_protocol_reads_it() {
    for case in cases("keystrokes").unwrap() {
        // One byte per character, as the TypeScript reads a view's input.
        let bytes: Vec<u8> = input(&case)
            .chars()
            .map(|c| u8::try_from(u32::from(c)).unwrap())
            .collect();
        assert_eq!(has_keystrokes(&bytes), case["keystrokes"] == true, "{case}");
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
}
