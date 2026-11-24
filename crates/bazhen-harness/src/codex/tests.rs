//! The Codex adapter, read against what the TypeScript daemon makes of the same messages.

use super::*;
use crate::SessionRef;
use bazhen_protocol::agents::{ExternalRefKind, UsageLimit};
use bazhen_protocol::ids::AgentId;
use bazhen_protocol::mail_events::ApprovalDecision;
use proptest::prelude::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const THREAD: &str = "019a8f3c-5b7e-7d21-9f4a-0c1e2d3b4a51";

fn fixture(file: &str) -> Value {
    let path = format!(
        "{}/../../packages/protocol/fixtures/codex/{file}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn js(value: &Value) -> Js {
    Js::parse(value.to_string().as_bytes()).unwrap()
}

fn limit(limit: Option<LimitStop>) -> Value {
    match limit {
        Some(LimitStop::Quota) => json!("quota"),
        Some(LimitStop::Rate) => json!("rate"),
        None => Value::Null,
    }
}

/// What each of the TypeScript adapter's readers made of a message, by its key in the fixture.
fn reads(method: &str, params: &Js) -> Vec<(&'static str, Value)> {
    let resolved = approvals::read_resolved(method, params).map(|id| match id {
        approvals::RequestId::Number(n) => json!(n),
        approvals::RequestId::Text(s) => json!(s),
    });
    vec![
        (
            "approval",
            json!(approvals::read_approval(method, params).map(|a| json!({
                "threadId": a.thread_id, "itemId": a.item_id, "summary": a.summary,
            }))),
        ),
        (
            "question",
            json!(approvals::read_question(method, params).map(|q| json!({
                "threadId": q.thread_id, "itemId": q.item_id, "key": q.key,
                "summary": q.summary, "answers": q.answers,
            }))),
        ),
        ("resolved", json!(resolved)),
        (
            "userMessage",
            json!(mail::read_user_message(method, params).map(|m| json!({
                "threadId": m.thread_id, "messageId": m.message_id,
            }))),
        ),
        (
            "threadStatus",
            json!(signals::read_thread_status(method, params).map(|s| json!({
                "threadId": s.thread_id, "activity": s.activity, "notLoaded": s.not_loaded,
            }))),
        ),
        (
            "turn",
            json!(signals::read_turn(method, params).map(|t| json!({
                "threadId": t.thread_id, "started": t.started, "ended": t.ended,
                "error": t.error, "limit": limit(t.limit),
            }))),
        ),
        (
            "rateLimits",
            json!(signals::read_rate_limits(method, params)),
        ),
        (
            "itemStarted",
            json!(signals::read_item_started(method, params).map(|i| json!({
                "threadId": i.thread_id, "userInput": i.user_input,
            }))),
        ),
        (
            "compaction",
            json!(signals::read_compaction(method, params)),
        ),
        (
            "threadStarted",
            json!(threads::read_thread_started(method, params)),
        ),
    ]
}

/// Numbers compared as JavaScript holds them, so `4` and `4.0` are one.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

#[test]
fn reads_every_recorded_message_as_the_typescript_adapter_did() {
    let cases = fixture("messages.json");
    let cases = cases.as_array().unwrap();
    assert!(cases.len() > 100, "{} cases", cases.len());
    let mut checked = 0;
    for case in cases {
        let name = &case["name"];
        let method = case["method"].as_str().unwrap();
        let params = js(case.get("params").unwrap_or(&Value::Null));
        for (key, got) in reads(method, &params) {
            let want = &case["read"][key];
            assert!(same(&got, want), "{name} {key}: got {got}, want {want}");
            checked += 1;
        }
    }
    assert_eq!(checked, cases.len() * 10);
}

#[test]
fn reads_a_terminal_title_as_the_typescript_adapter_did() {
    let cases = fixture("titles.json");
    let cases = cases["titles"].as_array().unwrap();
    assert!(cases.len() > 10, "{} cases", cases.len());
    for case in cases {
        let title = case["title"].as_str().unwrap();
        let got = json!(threads::title_prefix(title));
        assert_eq!(got, case["prefix"], "{title:?}");
    }
}

fn harness() -> Codex {
    Codex::new()
}

fn agent() -> AgentId {
    AgentId::parse("agent_0190a1b2c3d47abc8def0123456789a1").unwrap()
}

/// One notification, as the daemon hands it over for the agent bound to its thread, or none.
fn notify(codex: &Codex, bound: Option<&AgentId>, method: &str, params: &Value) -> Vec<Keyed> {
    let params = params.to_string();
    let report = Report::Notification {
        method,
        params: params.as_bytes(),
    };
    let ingested = codex.ingest(
        report,
        &IngestContext {
            agent: bound,
            ..IngestContext::default()
        },
    );
    assert_eq!((ingested.reply, ingested.origin), (Reply::Quiet, None));
    ingested.observed
}

fn status(kind: &str) -> Value {
    json!({ "threadId": THREAD, "status": { "type": kind } })
}

fn turn(status: Option<&str>) -> Value {
    let mut turn = json!({ "id": "t1", "items": [] });
    if let Some(status) = status {
        turn["status"] = json!(status);
    }
    json!({ "threadId": THREAD, "turn": turn })
}

fn activity(value: ActivityValue, detail: Option<&str>) -> Keyed {
    on(
        THREAD,
        Observed::Activity(HarnessActivity {
            value,
            detail: detail.map(str::to_owned),
            limit: None,
        }),
    )
}

#[test]
fn a_bound_threads_status_is_its_activity_under_the_thread() {
    let codex = harness();
    let a = agent();
    let got = notify(&codex, Some(&a), "thread/status/changed", &status("idle"));
    assert_eq!(got, vec![activity(ActivityValue::Idle, None)]);
}

#[test]
fn an_unloaded_thread_reads_unknown_and_asks_to_be_picked_up_again() {
    let codex = harness();
    let a = agent();
    let got = notify(
        &codex,
        Some(&a),
        "thread/status/changed",
        &status("notLoaded"),
    );
    assert_eq!(
        got,
        vec![
            activity(ActivityValue::Unknown, None),
            on(THREAD, Observed::Unloaded)
        ]
    );
}

#[test]
fn the_idle_after_a_failed_turn_doesnt_hide_it_until_a_turn_starts() {
    let codex = harness();
    let a = agent();
    let failed = json!({
        "threadId": THREAD,
        "turn": { "id": "t1", "items": [], "status": "failed",
                  "error": { "message": "boom", "codexErrorInfo": "usageLimitExceeded" } },
    });
    let got = notify(&codex, Some(&a), "turn/completed", &failed);
    let [fail, act] = got.as_slice() else {
        panic!("{got:?}")
    };
    assert_eq!(
        fail.fact,
        Observed::TurnFailed {
            prompt_id: None,
            error: Some("usageLimitExceeded".to_owned())
        }
    );
    let Observed::Activity(act) = &act.fact else {
        panic!("{act:?}")
    };
    assert_eq!(
        (act.value, act.detail.as_deref(), act.limit),
        (
            ActivityValue::Failed,
            Some("usageLimitExceeded"),
            Some(LimitStop::Quota)
        )
    );
    let idle = notify(&codex, Some(&a), "thread/status/changed", &status("idle"));
    assert_eq!(idle, vec![]);
    let started = notify(&codex, Some(&a), "turn/started", &turn(None));
    assert_eq!(
        started,
        vec![
            on(THREAD, Observed::TurnStarted),
            activity(ActivityValue::Working, None)
        ]
    );
    let idle = notify(&codex, Some(&a), "thread/status/changed", &status("idle"));
    assert_eq!(idle, vec![activity(ActivityValue::Idle, None)]);
}

#[test]
fn a_thread_no_agent_is_on_any_more_is_forgotten() {
    let codex = harness();
    let a = agent();
    let failed = json!({
        "threadId": THREAD,
        "turn": { "id": "t1", "items": [], "status": "failed", "error": null },
    });
    assert_eq!(notify(&codex, Some(&a), "turn/completed", &failed).len(), 2);
    assert_eq!(
        notify(&codex, None, "thread/status/changed", &status("idle")),
        vec![]
    );
    let idle = notify(&codex, Some(&a), "thread/status/changed", &status("idle"));
    assert_eq!(idle, vec![activity(ActivityValue::Idle, None)]);
}

#[test]
fn a_turn_that_doesnt_say_how_it_ended_is_left_to_the_threads_status() {
    let codex = harness();
    let a = agent();
    let completed = notify(&codex, Some(&a), "turn/completed", &turn(Some("completed")));
    assert_eq!(completed, vec![activity(ActivityValue::Idle, None)]);
    let unsaid = json!({ "threadId": THREAD, "turn": { "id": "t1", "items": [] } });
    assert_eq!(notify(&codex, Some(&a), "turn/completed", &unsaid), vec![]);
}

#[test]
fn an_interrupted_thread_is_labelled_until_the_new_servers_own_turn_shows_itself() {
    let codex = harness();
    let a = agent();
    codex
        .threads()
        .labels
        .insert(THREAD.to_owned(), INTERRUPTED);
    let idle = notify(&codex, Some(&a), "thread/status/changed", &status("idle"));
    assert_eq!(idle, vec![activity(ActivityValue::Idle, Some(INTERRUPTED))]);
    let started = notify(&codex, Some(&a), "turn/started", &turn(None));
    assert_eq!(
        started,
        vec![
            on(THREAD, Observed::TurnStarted),
            activity(ActivityValue::Working, None)
        ]
    );
    let item = json!({
        "threadId": THREAD, "turnId": "t1",
        "item": { "type": "reasoning", "id": "r1", "summary": [], "content": [] },
    });
    let got = notify(&codex, Some(&a), "item/started", &item);
    assert_eq!(
        got,
        vec![activity(ActivityValue::Working, Some(AUTO_CONTINUED))]
    );
    // Only the first item tells.
    assert_eq!(notify(&codex, Some(&a), "item/started", &item), vec![]);
    let done = notify(&codex, Some(&a), "turn/completed", &turn(Some("completed")));
    assert_eq!(done, vec![activity(ActivityValue::Idle, None)]);
}

#[test]
fn a_turn_the_user_starts_on_an_interrupted_thread_is_not_the_servers_own() {
    let codex = harness();
    let a = agent();
    codex
        .threads()
        .labels
        .insert(THREAD.to_owned(), INTERRUPTED);
    notify(&codex, Some(&a), "turn/started", &turn(None));
    let input = json!({
        "threadId": THREAD, "turnId": "t1",
        "item": { "type": "userMessage", "id": "u1",
                  "content": [{ "type": "text", "text": "hello" }] },
    });
    assert_eq!(notify(&codex, Some(&a), "item/started", &input), vec![]);
    let item = json!({
        "threadId": THREAD, "turnId": "t1",
        "item": { "type": "reasoning", "id": "r1", "summary": [], "content": [] },
    });
    assert_eq!(notify(&codex, Some(&a), "item/started", &item), vec![]);
}

#[test]
fn a_turn_that_takes_one_of_bazhens_messages_says_so_under_its_thread() {
    let codex = harness();
    let a = agent();
    let id = "msg_0190000000007000800000000000001";
    let text = mail::read_user_message(
        "item/started",
        &js(&json!({
            "threadId": THREAD,
            "item": { "type": "userMessage", "content": [{ "type": "text", "text": "" }] },
        })),
    );
    assert_eq!(text.and_then(|m| m.message_id), None);
    let input = json!({
        "threadId": THREAD, "turnId": "t1",
        "item": { "type": "userMessage", "id": "u1",
                  "content": [{ "type": "text", "text": format!("{}\nhi", bazhen_core::mail::mail_label(id)) }] },
    });
    let got = notify(&codex, Some(&a), "item/started", &input);
    assert_eq!(
        got,
        vec![on(
            THREAD,
            Observed::MailTaken {
                message_id: id.to_owned()
            }
        )]
    );
}

#[test]
fn a_message_taken_on_a_thread_no_agent_is_on_is_still_said_to_be_taken() {
    let codex = harness();
    let id = "msg_0190000000007000800000000000001";
    let input = json!({
        "threadId": THREAD, "turnId": "t1",
        "item": { "type": "userMessage", "id": "u1",
                  "content": [{ "type": "text", "text": format!("{}\nhi", bazhen_core::mail::mail_label(id)) }] },
    });
    assert_eq!(
        notify(&codex, None, "item/started", &input),
        vec![on(
            THREAD,
            Observed::MailTaken {
                message_id: id.to_owned()
            }
        )]
    );
}

#[test]
fn compaction_rate_limits_and_new_threads_are_the_threads_and_the_accounts() {
    let codex = harness();
    let a = agent();
    let compacted = json!({ "threadId": THREAD, "turnId": "t1",
        "item": { "type": "contextCompaction", "id": "c1" } });
    assert_eq!(
        notify(&codex, Some(&a), "item/completed", &compacted),
        vec![on(
            THREAD,
            Observed::Compacted {
                sign: CompactedSign::CodexItem
            }
        )]
    );
    let limits = json!({ "rateLimits": { "limitId": "codex",
        "primary": { "usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1_763_003_600 },
    } });
    assert_eq!(
        notify(&codex, None, "account/rateLimits/updated", &limits),
        vec![account(Observed::AccountLimits(vec![UsageLimit {
            window: "codex.primary".to_owned(),
            used_percent: 12.0,
            resets_at: Some("2025-11-13T03:13:20.000Z".to_owned()),
        }]))]
    );
    let started = json!({ "thread": { "id": THREAD } });
    assert_eq!(
        notify(&codex, None, "thread/started", &started),
        vec![account(Observed::SessionAnnounced {
            session: SessionKey(THREAD.to_owned())
        })]
    );
}

fn ask(codex: &Codex, bound: Option<&AgentId>, method: &str, params: &Value, id: &str) -> Ingested {
    let params = params.to_string();
    let report = Report::ServerRequest {
        method,
        params: params.as_bytes(),
        id,
    };
    codex.ingest(
        report,
        &IngestContext {
            agent: bound,
            ..IngestContext::default()
        },
    )
}

fn tool(call: &str) -> ToolKey {
    ToolKey {
        key: format!("[\"{THREAD}\",\"{call}\"]"),
        caller: None,
        prompt_id: None,
    }
}

fn command() -> Value {
    json!({ "threadId": THREAD, "turnId": "t1", "itemId": "call-1",
            "command": "rm -rf build", "reason": "outside the sandbox" })
}

#[test]
fn an_approval_is_held_for_the_inbox_with_no_deadline() {
    let codex = harness();
    let a = agent();
    let got = ask(
        &codex,
        Some(&a),
        "item/commandExecution/requestApproval",
        &command(),
        "7",
    );
    assert_eq!(
        got,
        Ingested {
            observed: vec![on(
                THREAD,
                Observed::ApprovalAsked {
                    key: tool("call-1"),
                    summary: "Run rm -rf build (outside the sandbox)".to_owned(),
                    question: false,
                }
            )],
            origin: None,
            reply: Reply::Hold(Held::Approval {
                key: tool("call-1"),
                wait_ms: None
            }),
            reply_gate: Gate::None,
        }
    );
    let pending = Pending::ServerRequest {
        method: "item/commandExecution/requestApproval",
        key: &tool("call-1"),
    };
    let allow = codex.answer(&pending, Resolution::Decision(ApprovalDecision::Allow));
    assert_eq!(allow, Answer::Rpc(r#"{"decision":"accept"}"#.to_owned()));
    let deny = codex.answer(&pending, Resolution::Decision(ApprovalDecision::Deny));
    assert_eq!(deny, Answer::Rpc(r#"{"decision":"decline"}"#.to_owned()));
    assert_eq!(
        codex.answer(&pending, Resolution::Nothing),
        Answer::Unavailable
    );
}

#[test]
fn a_request_answered_in_the_tui_is_settled_by_its_id() {
    let codex = harness();
    let a = agent();
    ask(
        &codex,
        Some(&a),
        "item/commandExecution/requestApproval",
        &command(),
        "7",
    );
    ask(
        &codex,
        Some(&a),
        "item/fileChange/requestApproval",
        &json!({
            "threadId": THREAD, "turnId": "t1", "itemId": "call-2",
        }),
        "\"x\"",
    );
    let other = notify(
        &codex,
        None,
        "serverRequest/resolved",
        &json!({ "threadId": THREAD, "requestId": 8 }),
    );
    assert_eq!(other, vec![]);
    let settled = |call: &str| {
        vec![on(
            THREAD,
            Observed::ApprovalSettled {
                key: tool(call),
                how: Settled::AnsweredInTui,
            },
        )]
    };
    let resolved = json!({ "threadId": THREAD, "requestId": 7 });
    assert_eq!(
        notify(&codex, None, "serverRequest/resolved", &resolved),
        settled("call-1")
    );
    assert_eq!(
        notify(&codex, None, "serverRequest/resolved", &resolved),
        vec![]
    );
    let text = json!({ "threadId": THREAD, "requestId": "x" });
    assert_eq!(
        notify(&codex, None, "serverRequest/resolved", &text),
        settled("call-2")
    );
}

#[test]
fn a_single_free_text_question_is_answered_with_the_humans_text() {
    let codex = harness();
    let a = agent();
    let params = json!({ "threadId": THREAD, "turnId": "t1", "itemId": "call-3",
        "questions": [{ "id": "q1", "header": "Name", "question": "What should it be called?" }] });
    let got = ask(&codex, Some(&a), "item/tool/requestUserInput", &params, "9");
    assert_eq!(
        got.observed,
        vec![on(
            THREAD,
            Observed::ApprovalAsked {
                key: tool("call-3"),
                summary: "What should it be called?".to_owned(),
                question: true,
            }
        )]
    );
    assert_eq!(
        got.reply,
        Reply::Hold(Held::Approval {
            key: tool("call-3"),
            wait_ms: None
        })
    );
    let pending = Pending::ServerRequest {
        method: "item/tool/requestUserInput",
        key: &tool("call-3"),
    };
    assert_eq!(
        codex.answer(&pending, Resolution::Text("Ada")),
        Answer::Rpc(r#"{"answers":{"q1":{"answers":["Ada"]}}}"#.to_owned())
    );
    // Answered once.
    assert_eq!(
        codex.answer(&pending, Resolution::Text("Ada")),
        Answer::Unavailable
    );
}

#[test]
fn a_question_only_the_tui_can_answer_is_shown_and_not_held() {
    let codex = harness();
    let a = agent();
    let params = json!({ "threadId": THREAD, "turnId": "t1", "itemId": "call-4", "reason": "" });
    let got = ask(
        &codex,
        Some(&a),
        "item/permissions/requestApproval",
        &params,
        "10",
    );
    assert_eq!(
        got,
        Ingested {
            observed: vec![on(
                THREAD,
                Observed::QuestionAsked {
                    key: tool("call-4"),
                    summary: "Grant more permissions".to_owned(),
                }
            )],
            ..Ingested::nothing()
        }
    );
}

#[test]
fn a_request_for_no_agent_bazhen_runs_or_none_for_the_human_is_left_to_the_tui() {
    let codex = harness();
    let a = agent();
    let unbound = ask(
        &codex,
        None,
        "item/commandExecution/requestApproval",
        &command(),
        "7",
    );
    assert_eq!(unbound, Ingested::nothing());
    let other = ask(
        &codex,
        Some(&a),
        "item/tool/call",
        &json!({ "threadId": THREAD }),
        "8",
    );
    assert_eq!(other, Ingested::nothing());
    let resolved = json!({ "threadId": THREAD, "requestId": 7 });
    assert_eq!(
        notify(&codex, None, "serverRequest/resolved", &resolved),
        vec![]
    );
}

fn titled(title: &str, bound: Option<&AgentId>, session: Option<&SessionRef>) -> Vec<Keyed> {
    let codex = harness();
    let ingested = codex.ingest(
        Report::TerminalTitle { title },
        &IngestContext {
            agent: bound,
            session,
            ..IngestContext::default()
        },
    );
    assert_eq!(ingested.reply, Reply::Quiet);
    ingested.observed
}

#[test]
fn a_title_naming_the_agents_thread_says_its_tui_is_up_and_any_other_is_followed() {
    let a = agent();
    let session = SessionRef {
        kind: ExternalRefKind::CodexThread,
        id: THREAD.to_owned(),
    };
    let fact = |fact| vec![Keyed::agent(&a, Gate::None, fact)];
    let cut = "019a8f3c-5b7e-7d21-9f4a-0c1e2...";
    assert_eq!(
        titled(cut, Some(&a), Some(&session)),
        fact(Observed::Ready {
            sign: ReadySign::CodexTitle
        })
    );
    let other = "019a8f40-0000-7000-8000-000000000003";
    assert_eq!(
        titled(other, Some(&a), Some(&session)),
        fact(Observed::TitleNames {
            candidate: other.to_owned()
        })
    );
    assert_eq!(
        titled(cut, Some(&a), None),
        fact(Observed::TitleNames {
            candidate: "019a8f3c-5b7e-7d21-9f4a-0c1e2".to_owned()
        })
    );
    assert_eq!(
        titled("", Some(&a), Some(&session)),
        fact(Observed::Release)
    );
    assert_eq!(
        titled(" \t\u{feff}", Some(&a), Some(&session)),
        fact(Observed::Release)
    );
    assert_eq!(
        titled("my project", Some(&a), Some(&session)),
        fact(Observed::TitleNames {
            candidate: "my project".to_owned()
        })
    );
    assert_eq!(titled(cut, None, Some(&session)), vec![]);
}

#[test]
fn codex_takes_mail_by_push_and_says_what_it_does_over_its_server() {
    let codex = harness();
    assert_eq!(
        codex.capabilities(),
        Capabilities {
            delivery: Delivery::Push,
            approvals: true,
            activity: ActivitySource::Channel,
        }
    );
    assert_eq!(codex.themes(), &[TuiTheme::Light, TuiTheme::Dark]);
    let hook = Report::Hook {
        event: "Stop",
        payload: b"{}",
    };
    assert_eq!(
        codex.ingest(hook, &IngestContext::default()),
        Ingested::nothing()
    );
}

/// Every recorded message, as its method and its params' text.
fn recorded() -> Vec<(String, String)> {
    let cases = fixture("messages.json");
    let cases = cases.as_array().unwrap();
    cases
        .iter()
        .map(|case| {
            let params = case.get("params").unwrap_or(&Value::Null);
            (
                case["method"].as_str().unwrap().to_owned(),
                params.to_string(),
            )
        })
        .collect()
}

proptest! {
    /// A TUI titles its terminal with its thread's id, whole or cut short, and the prefix that
    /// gives is read back as itself, so the daemon can follow by it.
    #[test]
    fn a_title_naming_a_thread_reads_as_a_prefix_of_its_id_and_reads_back_as_itself(
        id in "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        shown in 20_usize..=27,
        cut in prop::sample::select(vec!["", "...", "…"]),
        pad in prop::sample::select(vec!["", " ", "\t", "\u{feff}"]),
    ) {
        let prefix = id.get(..9 + shown).unwrap();
        let title = format!("{pad}{prefix}{cut}{pad}");
        prop_assert_eq!(threads::title_prefix(&title), Some(prefix));
        prop_assert_eq!(threads::title_prefix(prefix), Some(prefix));
    }

    /// Whatever a title is, a prefix read from it begins it and reads back as itself.
    #[test]
    fn any_prefix_a_title_gives_begins_it_and_reads_back_as_itself(
        title in "[ \t]?[0-9a-f]{8}-?[0-9a-f-]{0,30}(\\.\\.\\.|…|\\.)?[ a]?",
    ) {
        if let Some(prefix) = threads::title_prefix(&title) {
            prop_assert!(title.trim_matches(threads::js_space).starts_with(prefix));
            prop_assert_eq!(threads::title_prefix(prefix), Some(prefix));
        }
    }

    /// A message cut short isn't JSON, and says nothing.
    #[test]
    fn a_recorded_message_cut_short_says_nothing(
        case in prop::sample::select(recorded()),
        cut in any::<prop::sample::Index>(),
    ) {
        let (method, params) = case;
        let a = agent();
        let report = Report::Notification {
            method: &method,
            params: &params.as_bytes()[..cut.index(params.len())],
        };
        let context = IngestContext {
            agent: Some(&a),
            ..IngestContext::default()
        };
        prop_assert_eq!(harness().ingest(report, &context), Ingested::nothing());
    }

    /// Over any run of the recorded messages, each fact names the thread its message came from,
    /// or, from one that names none, the account, and is ungated; and once no agent is on those
    /// threads, nothing of them is held.
    #[test]
    fn every_fact_names_its_thread_and_nothing_is_held_of_threads_no_agent_is_on(
        picks in prop::collection::vec(any::<prop::sample::Index>(), 1..40),
    ) {
        let cases = recorded();
        let codex = harness();
        let a = agent();
        let mut seen = BTreeSet::new();
        for pick in picks {
            let (method, params) = &cases[pick.index(cases.len())];
            let params: Value = serde_json::from_str(params).unwrap();
            let thread = params["threadId"].as_str().map(str::to_owned);
            for keyed in notify(&codex, Some(&a), method, &params) {
                prop_assert_eq!(keyed.gate, Gate::None);
                match keyed.key {
                    Key::Session(SessionKey(session)) => {
                        prop_assert_eq!(Some(&session), thread.as_ref());
                    }
                    Key::Account => prop_assert_eq!(thread.as_ref(), None),
                    Key::Agent(agent) => prop_assert!(false, "keyed to {}", agent),
                }
            }
            seen.extend(thread);
        }
        for thread in &seen {
            let status = json!({ "threadId": thread, "status": { "type": "idle" } });
            notify(&codex, None, "thread/status/changed", &status);
        }
        let t = codex.threads();
        let held = t.activity.len() + t.failed.len() + t.first_item.len() + t.labels.len();
        prop_assert_eq!(held, 0);
    }
}
