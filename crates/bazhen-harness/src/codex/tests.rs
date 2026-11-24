//! The Codex adapter, read against what the TypeScript daemon makes of the same messages.

use super::*;
use crate::{Reply, SessionRef};
use bazhen_protocol::agents::{ExternalRefKind, UsageLimit};
use bazhen_protocol::ids::AgentId;
use serde_json::{Value, json};

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
    vec![
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
    assert_eq!(checked, cases.len() * 7);
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
fn a_title_naming_the_agents_thread_says_its_tui_is_up_and_another_names_where_it_moved() {
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
    assert_eq!(titled("my project", Some(&a), Some(&session)), vec![]);
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
