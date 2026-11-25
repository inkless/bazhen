//! Approvals and questions: an item opened by the call it is about, the hook held for the human's
//! answer, and each path that ends it ending it once.

use std::task::{Context, Waker};
use std::time::Instant;

use axum::extract::Path;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::*;
use crate::callers::Caller;
use crate::routes::Reason;
use crate::testing::paused;

impl Fixture {
    /// Sets the agent's state as its row records it, as a close would, from a test's runtime.
    async fn set_state_now(&self, state: &'static str) {
        let agent = self.agent.clone();
        write(&self.shared.store, move |w| {
            w.connection().execute(
                "UPDATE agent_sessions SET state = ? WHERE id = ?",
                (state, agent.as_str()),
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }
}

/// Yields until `done`, or for as long as the deadline on the wall clock allows: a paused clock
/// would run a timer's deadline out while the writer's thread works. Whether it was done.
async fn until(mut done: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while !done() {
        if start.elapsed() > DEADLINE {
            return false;
        }
        tokio::task::yield_now().await;
    }
    true
}

/// A call to run `command`, by the agent itself or the subagent `by`.
fn call(command: &str, by: Option<&str>) -> Value {
    let mut call = json!({
        "session_id": "session-1", "tool_name": "Bash", "tool_input": { "command": command },
    });
    if let Some(by) = by {
        call["agent_id"] = json!(by);
    }
    call
}

fn event(mut payload: Value, name: &str, use_id: Option<&str>) -> Value {
    payload["hook_event_name"] = json!(name);
    if let Some(use_id) = use_id {
        payload["tool_use_id"] = json!(use_id);
    }
    payload
}

/// A question the TUI asks, about the call `AskUserQuestion` with `asked`.
fn question(asked: &str) -> Value {
    json!({
        "session_id": "session-1", "tool_name": "AskUserQuestion",
        "tool_input": { "questions": [{ "question": asked }] },
    })
}

/// The hook `event` with `payload`, from the agent's TUI.
async fn posted(f: &Fixture, name: &str, payload: &Value) -> Response {
    let hook = f.request(HOOK_PROTOCOL_VERSION, name, payload);
    taken(&f.shared, &hook, None, Some(its_tui()), None).await
}

/// Each open item of the agent, oldest first.
fn open_items(f: &Fixture) -> Vec<AttentionId> {
    let reader = f.shared.store.reader().unwrap();
    let open = reader.reads().open_attention(f.agent.as_str()).unwrap();
    open.into_iter().map(|item| item.id).collect()
}

/// Asks the permission request `payload` on a task of its own, answering its hook once the item it
/// opened is held; a request neither held nor answered by the deadline fails the test.
async fn asked(f: &Fixture, payload: Value) -> (JoinHandle<Response>, AttentionId) {
    let before = open_items(f);
    let (shared, hook) = (
        f.shared.clone(),
        f.request(HOOK_PROTOCOL_VERSION, "PermissionRequest", &payload),
    );
    let held = TaskTracker::new()
        .spawn(async move { taken(&shared, &hook, None, Some(its_tui()), None).await });
    let approvals = Arc::clone(&f.shared.hooks.approvals);
    let mut id = None;
    let found = until(|| {
        let new = open_items(f).into_iter().find(|id| !before.contains(id));
        id = new.filter(|id| approvals.held(id));
        id.is_some()
    })
    .await;
    assert!(
        found,
        "the request was neither held nor answered by the deadline"
    );
    (held, id.unwrap())
}

/// The exit code and stdout a hook's reply gives, or none by the deadline.
async fn reply(held: JoinHandle<Response>) -> Option<(String, String)> {
    if !until(|| held.is_finished()).await {
        held.abort();
        return None;
    }
    let response = held.await.ok()?;
    let exit = response.headers().get("bazhen-exit-code")?.to_str().ok()?;
    let exit = exit.to_owned();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .ok()?;
    Some((exit, String::from_utf8_lossy(&body).into_owned()))
}

/// The behavior a hook's stdout gives the permission request, or none for a quiet one.
fn behavior(reply: Option<(String, String)>) -> Option<String> {
    let (_, stdout) = reply?;
    let said: Value = serde_json::from_str(&stdout).ok()?;
    said["hookSpecificOutput"]["decision"]["behavior"]
        .as_str()
        .map(str::to_owned)
}

/// The human's answer to `id` over HTTP: its status and body.
async fn answered(f: &Fixture, id: &str, key: &str, decision: &str) -> (u16, Value) {
    answered_by(f, id, key, decision, None).await
}

async fn answered_by(
    f: &Fixture,
    id: &str,
    key: &str,
    decision: &str,
    caller: Option<Caller>,
) -> (u16, Value) {
    let body = json!({ "idempotencyKey": key, "decision": decision }).to_string();
    let response = crate::attention::answer(
        State(f.shared.clone()),
        Path(id.to_owned()),
        caller.map(Extension),
        Bytes::from(body),
    )
    .await;
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Runs nothing on the writer, which comes after all queued before it.
async fn flushed(f: &Fixture) {
    f.shared.store.run(|_| ()).await.unwrap();
}

/// A job queued on the writer now, after all queued before it, that holds the writer until it is
/// let go: what says the writer has reached it, and what lets it go, sent to or dropped.
fn writer_held(
    f: &Fixture,
) -> (
    tokio::sync::oneshot::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    let (reached, at) = tokio::sync::oneshot::channel();
    let (go, waits) = std::sync::mpsc::channel::<()>();
    f.shared
        .store
        .queue(move |_| {
            let _ = reached.send(());
            let _ = waits.recv();
        })
        .unwrap();
    (at, go)
}

#[test]
fn answers_a_held_approval_with_the_humans_decision_once_per_key() {
    let f = fixture();
    let (first, second, replay, other, allowed, denied) = runtime().block_on(async {
        posted(
            &f,
            "PreToolUse",
            &event(call("ls", None), "PreToolUse", Some("toolu_1")),
        )
        .await;
        let (held, id) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        let first = answered(&f, id.as_str(), "k", "allow").await;
        let allowed = behavior(reply(held).await);
        let replay = answered(&f, id.as_str(), "k", "allow").await;
        let other = answered(&f, id.as_str(), "k", "deny").await.0;
        let (held, next) = asked(&f, event(call("rm", None), "PermissionRequest", None)).await;
        let second = answered(&f, next.as_str(), "k2", "deny").await.0;
        let denied = behavior(reply(held).await);
        (first, second, replay, other, allowed, denied)
    });
    let answers: Vec<(String, Value)> = f
        .since_launch()
        .into_iter()
        .filter(|(kind, _)| kind == "attention.answered" || kind == "attention.opened")
        .map(|(kind, payload)| {
            let said = if kind == "attention.opened" {
                payload["toolUseId"].clone()
            } else {
                payload["decision"].clone()
            };
            (kind, said)
        })
        .collect();
    let actor: Vec<String> = {
        let reader = f.shared.store.reader().unwrap();
        let events = reader.reads().events(0, 1000).unwrap();
        events
            .into_iter()
            .filter(|e| e.kind == "attention.answered")
            .map(|e| e.actor)
            .collect()
    };
    assert_eq!(
        (
            first.0,
            replay == first,
            other,
            second,
            allowed,
            denied,
            answers,
            actor,
            open_items(&f)
        ),
        (
            200,
            true,
            409,
            200,
            Some("allow".to_owned()),
            Some("deny".to_owned()),
            vec![
                ("attention.opened".to_owned(), json!("toolu_1")),
                ("attention.answered".to_owned(), json!("allow")),
                ("attention.opened".to_owned(), Value::Null),
                ("attention.answered".to_owned(), json!("deny")),
            ],
            vec!["user".to_owned(), "user".to_owned()],
            vec![]
        )
    );
}

#[test]
fn closes_an_approval_whose_wait_ran_out_and_answers_its_hook_quiet() {
    let f = fixture();
    let (reply_of_hook, late) = paused().block_on(async {
        let (held, id) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        tokio::time::sleep(Duration::from_secs(51)).await;
        let reply_of_hook = reply(held).await;
        let late = answered(&f, id.as_str(), "k", "allow").await.0;
        (reply_of_hook, late)
    });
    assert_eq!(
        (reply_of_hook, late, reasons(&f)),
        (
            Some(("0".to_owned(), String::new())),
            409,
            vec!["timed_out".to_owned()]
        )
    );
}

#[test]
fn hands_the_hook_an_answer_that_claimed_its_item_as_its_wait_ran_out() {
    let f = fixture();
    let replied = paused().block_on(async {
        let (held, id) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        // An answer has claimed it, and sends in the job that claimed it.
        let claimed = f.shared.hooks.approvals.claim(&id);
        tokio::time::sleep(Duration::from_secs(51)).await;
        flushed(&f).await;
        if let Some(Entry {
            responder: Some(crate::hooks::approvals::Responder::Hook(hook)),
            ..
        }) = claimed
        {
            let _ = hook.send(HookReply {
                exit_code: 0,
                stdout: "answered".to_owned(),
                stderr: String::new(),
                offered: Vec::new(),
            });
        }
        reply(held).await
    });
    assert_eq!(
        (replied, reasons(&f)),
        (Some(("0".to_owned(), "answered".to_owned())), vec![])
    );
}

/// Each close's reason, and `answered` for an answer, in order.
fn reasons(f: &Fixture) -> Vec<String> {
    f.since_launch()
        .into_iter()
        .filter_map(|(kind, payload)| match kind.as_str() {
            "attention.closed" => payload["reason"].as_str().map(str::to_owned),
            "attention.answered" => Some("answered".to_owned()),
            _ => None,
        })
        .collect()
}

/// What closing a held approval's hook, as its client going does, records: `before` runs with the
/// approval held, ahead of the hook's going.
fn dropped(f: &Fixture, before: impl AsyncFnOnce(&Fixture, &AttentionId)) -> Vec<String> {
    runtime().block_on(async {
        let (held, id) = asked(f, event(call("ls", None), "PermissionRequest", None)).await;
        before(f, &id).await;
        held.abort();
        let _ = held.await;
        flushed(f).await;
    });
    reasons(f)
}

#[test]
fn closes_an_approval_whose_hook_went_as_answered_in_the_tui_or_by_its_agent_closing() {
    let in_tui = dropped(&fixture(), async |_, _| {});
    let after_answer = dropped(&fixture(), async |f, id| {
        answered(f, id.as_str(), "k", "allow").await;
    });
    let closing = dropped(&fixture(), async |f, _| f.set_state_now("closing").await);
    let stopping = dropped(&fixture(), async |f, _| {
        f.shared.stop.now(Reason::Requested);
    });
    assert_eq!(
        [in_tui, after_answer, closing, stopping],
        [
            vec!["answered_in_tui".to_owned()],
            vec!["answered".to_owned()],
            vec!["agent_closed".to_owned()],
            vec![],
        ]
    );
}

#[test]
fn closes_a_held_approval_once_as_its_agent_closes_whether_its_hook_goes_first_or_after() {
    let closed_first = dropped(&fixture(), async |f, _| {
        f.set_state_now("closed").await;
        f.shared.hooks.closed(&f.shared.store, &f.agent).await;
    });
    let f = fixture();
    let went_first = runtime().block_on(async {
        let (held, _) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        f.set_state_now("closed").await;
        held.abort();
        let _ = held.await;
        f.shared.hooks.closed(&f.shared.store, &f.agent).await;
        flushed(&f).await;
        reasons(&f)
    });
    assert_eq!(
        [closed_first, went_first],
        [
            vec!["agent_closed".to_owned()],
            vec!["agent_closed".to_owned()]
        ]
    );
}

#[test]
fn hands_over_an_answer_committed_after_the_route_that_made_it_went() {
    let f = fixture();
    let (early, allowed) = runtime().block_on(async {
        let (held, id) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        let mut route = Box::pin(answered(&f, id.as_str(), "k", "allow"));
        let mut poll = || {
            route
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_ready()
        };
        // The writer is held at each step, so neither of the route's jobs can be done by the
        // time it is polled for it: the writer runs on a thread of its own.
        let (_, first) = writer_held(&f);
        // The route queues its read of the agent's harness behind the first hold.
        let mut early = poll();
        let (read, second) = writer_held(&f);
        drop(first);
        read.await.unwrap();
        // The read done, the route queues its claim behind the second hold; then its caller goes.
        early |= poll();
        drop(route);
        drop(second);
        flushed(&f).await;
        (early, behavior(reply(held).await))
    });
    assert_eq!(
        (early, allowed, reasons(&f)),
        (false, Some("allow".to_owned()), vec!["answered".to_owned()])
    );
}

#[test]
fn settles_a_request_by_its_call_ending_and_not_by_anothers() {
    let f = fixture();
    let (other, own, late) = runtime().block_on(async {
        posted(
            &f,
            "PreToolUse",
            &event(call("ls", None), "PreToolUse", Some("toolu_1")),
        )
        .await;
        let (held, id) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        let settle = |use_id| event(call("ls", None), "PostToolUseFailure", Some(use_id));
        posted(&f, "PostToolUseFailure", &settle("toolu_2")).await;
        let other = f.shared.hooks.approvals.held(&id);
        posted(&f, "PostToolUseFailure", &settle("toolu_1")).await;
        let own = reply(held).await;
        let late = answered(&f, id.as_str(), "k", "allow").await.0;
        (other, own, late)
    });
    assert_eq!(
        (other, own, late, reasons(&f)),
        (
            true,
            Some(("0".to_owned(), String::new())),
            409,
            vec!["answered_in_tui".to_owned()]
        )
    );
}

#[test]
fn settles_the_requests_a_turn_a_subagent_or_a_session_ends_and_no_others() {
    let f = fixture();
    let settled = runtime().block_on(async {
        let ask = |command: &str, by: Option<&str>, session: &str| {
            let mut payload = event(call(command, by), "PermissionRequest", None);
            payload["session_id"] = json!(session);
            payload
        };
        let (main, _) = asked(&f, ask("a", None, "session-1")).await;
        let (sub, _) = asked(&f, ask("b", Some("sub-1"), "session-1")).await;
        let (other_sub, other_sub_id) = asked(&f, ask("c", Some("sub-2"), "session-1")).await;
        let (elsewhere, elsewhere_id) = asked(&f, ask("d", None, "session-0")).await;
        let mut settled = Vec::new();
        // Another session's turn ends: nothing of this one's.
        posted(&f, "Stop", &stop_in("session-9")).await;
        settled.push(open_items(&f).len());
        posted(&f, "Stop", &stop_in("session-1")).await;
        settled.push(usize::from(reply(main).await.is_some()));
        let over = json!({ "hook_event_name": "SubagentStop", "session_id": "session-1",
            "agent_id": "sub-1" });
        posted(&f, "SubagentStop", &over).await;
        settled.push(usize::from(reply(sub).await.is_some()));
        let held = [&other_sub_id, &elsewhere_id]
            .iter()
            .filter(|id| f.shared.hooks.approvals.held(id))
            .count();
        settled.push(held);
        // A new prompt in session-1 ends sub-2's; session-0's goes as the agent starts again.
        posted(&f, "UserPromptSubmit", &prompt("session-1")).await;
        settled.push(usize::from(reply(other_sub).await.is_some()));
        settled.push(usize::from(f.shared.hooks.approvals.held(&elsewhere_id)));
        let started = TaskTracker::new().spawn({
            let (shared, hook) = (
                f.shared.clone(),
                f.request(
                    HOOK_PROTOCOL_VERSION,
                    "wait",
                    &session_start("session-1", "clear"),
                ),
            );
            async move { taken(&shared, &hook, None, Some(its_tui()), None).await }
        });
        settled.push(usize::from(reply(elsewhere).await.is_some()));
        started.abort();
        settled
    });
    assert_eq!(
        (settled, reasons(&f)),
        (
            vec![4, 1, 1, 2, 1, 1, 1],
            vec![
                "answered_in_tui".to_owned(),
                "answered_in_tui".to_owned(),
                "answered_in_tui".to_owned(),
                "superseded".to_owned()
            ]
        )
    );
}

#[test]
fn matches_requests_to_calls_in_order_and_never_to_one_that_settled_unasked() {
    let f = fixture();
    runtime().block_on(async {
        let ask = question("Which?");
        for use_id in ["toolu_1", "toolu_2", "toolu_3"] {
            posted(
                &f,
                "PreToolUse",
                &event(ask.clone(), "PreToolUse", Some(use_id)),
            )
            .await;
        }
        posted(
            &f,
            "PostToolUse",
            &event(ask.clone(), "PostToolUse", Some("toolu_1")),
        )
        .await;
        for _ in 0..3 {
            posted(
                &f,
                "PermissionRequest",
                &event(ask.clone(), "PermissionRequest", None),
            )
            .await;
        }
    });
    let opened: Vec<Value> = f
        .of("attention.opened")
        .into_iter()
        .map(|opened| opened["toolUseId"].clone())
        .collect();
    assert_eq!(
        opened,
        vec![json!("toolu_2"), json!("toolu_3"), Value::Null]
    );
}

#[test]
fn answers_the_agents_other_hooks_while_an_approval_is_held() {
    let f = fixture();
    let (answered_meanwhile, held_still) = runtime().block_on(async {
        let (held, id) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        let other = event(call("pwd", None), "PostToolUse", Some("toolu_9"));
        let meanwhile =
            tokio::time::timeout(Duration::from_secs(2), posted(&f, "PostToolUse", &other))
                .await
                .is_ok();
        let held_still = f.shared.hooks.approvals.held(&id);
        held.abort();
        (meanwhile, held_still)
    });
    assert_eq!((answered_meanwhile, held_still), (true, true));
}

#[test]
fn offers_allow_and_deny_only_while_a_hook_holds_the_approval_and_never_for_a_question() {
    let f = fixture();
    let (held, unheld) = runtime().block_on(async {
        posted(
            &f,
            "PermissionRequest",
            &event(question("Which?"), "PermissionRequest", None),
        )
        .await;
        let (hook, _) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        let held = actions(&f).await;
        hook.abort();
        let _ = hook.await;
        flushed(&f).await;
        // One opened before a restart, which no hook of this daemon holds.
        let agent = f.agent.clone();
        write(&f.shared.store, move |w| {
            w.ask_attention(&agent, AttentionKind::Approval, "x", None, true)
        })
        .await
        .unwrap();
        (held, actions(&f).await)
    });
    assert_eq!(
        (held, unheld),
        (
            vec![json!([]), json!(["allow", "deny"])],
            vec![json!([]), json!([])]
        )
    );
}

/// What `/v1/state` offers for each open item, oldest first; it lists the closed ones too.
async fn actions(f: &Fixture) -> Vec<Value> {
    let response = crate::routes::state(State(f.shared.clone()), None).await;
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    let state: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    state["attention"]
        .as_array()
        .map_or_else(Vec::new, |items| {
            items
                .iter()
                .filter(|item| item["state"] == "open")
                .map(|item| item["actions"].clone())
                .collect()
        })
}

#[test]
fn refuses_an_answer_from_an_agent_and_to_an_id_that_names_no_item() {
    let f = fixture();
    let (by_agent, malformed, held) = runtime().block_on(async {
        let (hook, id) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        let agent = Some(Caller(Some(f.agent.clone())));
        let by_agent = answered_by(&f, id.as_str(), "k", "allow", agent).await.0;
        let malformed = answered(&f, "attn_none", "k2", "allow").await.0;
        let held = f.shared.hooks.approvals.held(&id);
        hook.abort();
        (by_agent, malformed, held)
    });
    assert_eq!((by_agent, malformed, held), (403, 404, true));
}

#[test]
fn keeps_the_hook_held_and_the_item_open_when_its_answer_cant_be_recorded() {
    let f = fixture();
    let (refused, held, allowed) = runtime().block_on(async {
        let (hook, id) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        let refuse = |sql: &'static str| {
            write(&f.shared.store, move |w| {
                w.connection().execute_batch(sql)?;
                Ok(())
            })
        };
        refuse(
            "CREATE TEMP TRIGGER refuse BEFORE INSERT ON events
             WHEN NEW.type = 'attention.answered' BEGIN SELECT RAISE(ABORT, 'refused'); END;",
        )
        .await
        .unwrap();
        let refused = answered(&f, id.as_str(), "k", "allow").await.0;
        let held = (
            f.shared.hooks.approvals.held(&id),
            open_items(&f) == [id.clone()],
        );
        refuse("DROP TRIGGER refuse;").await.unwrap();
        answered(&f, id.as_str(), "k2", "allow").await;
        (refused, held, behavior(reply(hook).await))
    });
    assert_eq!(
        (refused, held, allowed),
        (500, (true, true), Some("allow".to_owned()))
    );
}

#[test]
fn refuses_an_agents_answer_over_http_and_keeps_its_hook_held_for_the_humans() {
    use tower::ServiceExt;
    let mut f = fixture();
    // The loopback listener's caller reads as the agent's own TUI.
    f.shared.peers = crate::peer::Peers::with(DEADLINE, |_, _| Ok(peer_on(&[(ROOT, "claude")])));
    let (by_agent, held, allowed) = runtime().block_on(async {
        let (hook, id) = asked(&f, event(call("ls", None), "PermissionRequest", None)).await;
        let gate = crate::routes::Gate {
            allow: crate::guard::allowlists(7900, None, &[]),
            pairing_required: false,
        };
        let http = crate::testing::connected(crate::routes::http_router(f.shared.clone(), gate));
        let body = json!({ "idempotencyKey": "k", "decision": "allow" }).to_string();
        let request = axum::http::Request::post(format!("/v1/attention/{id}/answer"))
            .header("host", "127.0.0.1:7900")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body))
            .unwrap();
        let by_agent = http.oneshot(request).await.unwrap().status().as_u16();
        let held = (
            f.shared.hooks.approvals.held(&id),
            open_items(&f) == [id.clone()],
        );
        answered(&f, id.as_str(), "k2", "allow").await;
        (by_agent, held, behavior(reply(hook).await))
    });
    assert_eq!(
        (by_agent, held, allowed),
        (403, (true, true), Some("allow".to_owned()))
    );
}
