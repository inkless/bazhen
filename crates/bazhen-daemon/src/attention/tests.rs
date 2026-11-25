use std::future::Future;

use bazhen_harness::Pushed;
use bazhen_protocol::ids::{AgentId, AttentionId};
use serde_json::{Value, json};

use super::*;
use crate::mail::tests::{Fixture, fixture, pull, push};

/// Calls `route` on the item `id` with `body`, and waits for any push it starts.
fn call<F: Future<Output = Response>>(
    f: &Fixture,
    route: impl FnOnce(State<Shared>, Path<String>, Bytes) -> F,
    id: &str,
    body: &Value,
) -> (u16, Value) {
    let response = f.runtime.block_on(route(
        State(f.shared.clone()),
        Path(id.to_owned()),
        Bytes::from(body.to_string()),
    ));
    let status = response.status().as_u16();
    let bytes = f
        .runtime
        .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
        .unwrap();
    f.settle();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The human's answer, which no guard read a caller of.
async fn by_human(state: State<Shared>, id: Path<String>, body: Bytes) -> Response {
    answer(state, id, None, body).await
}

/// The status and refusal of a call, its item named `A`.
fn refused(answer: &(u16, Value), id: &str) -> (u16, String) {
    let message = answer.1["message"].as_str().unwrap_or_default();
    (answer.0, message.replace(id, "A"))
}

/// Opens an item for `agent`'s failed turn, answering its id.
fn failed(f: &Fixture, agent: &AgentId) -> String {
    let agent = agent.clone();
    f.runtime
        .block_on(f.shared.store.run(move |store| {
            store.write(|w| {
                w.turn_failed(&agent, Some("overloaded"))?;
                let open = w.reads().open_attention(agent.as_str())?;
                Ok::<_, AppendError>(open.last().map(|item| item.id.to_string()))
            })
        }))
        .unwrap()
        .unwrap()
        .unwrap()
}

/// `agent`'s open items' ids and kinds.
fn open(f: &Fixture, agent: &AgentId) -> Vec<(String, AttentionKind)> {
    let reader = f.shared.store.reader().unwrap();
    let open = reader.reads().open_attention(agent.as_str()).unwrap();
    open.into_iter()
        .map(|item| (item.id.to_string(), item.kind))
        .collect()
}

/// Each item closed, in order, and the payload it was closed with.
fn closes(f: &Fixture) -> Vec<(String, Value)> {
    let reader = f.shared.store.reader().unwrap();
    reader
        .reads()
        .events(0, 1000)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "attention.closed")
        .map(|e| (e.entity_id, serde_json::from_str(&e.payload).unwrap()))
        .collect()
}

/// What `/v1/state` says the human can do about each item.
fn offered(f: &Fixture) -> (u16, Vec<Value>) {
    let response = f
        .runtime
        .block_on(crate::routes::state(State(f.shared.clone()), None));
    let status = response.status().as_u16();
    let bytes = f
        .runtime
        .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
        .unwrap();
    let state: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let actions = state["attention"]
        .as_array()
        .map_or_else(Vec::new, |items| {
            items.iter().map(|item| item["actions"].clone()).collect()
        });
    (status, actions)
}

#[test]
fn replies_to_an_item_with_mail_to_its_agent_that_closes_it_once_per_key() {
    let f = fixture(pull());
    let id = failed(&f, &f.to);
    let reply = |key: &str, body: &str| {
        call(
            &f,
            reply,
            &id,
            &json!({ "idempotencyKey": key, "body": body }),
        )
    };
    let (first, again) = (reply("k", "go on"), reply("k", "go on"));
    let other = reply("k", "stop").0;
    assert_eq!(
        (
            first.0,
            first.1 == again.1,
            other,
            f.mail(),
            closes(&f),
            first.1["eventIds"].as_array().map(Vec::len)
        ),
        (
            200,
            true,
            409,
            vec![f.queued("go on")],
            vec![(id.clone(), json!({ "reason": "replied" }))],
            Some(2)
        )
    );
    assert!(first.1["messageId"].as_str().unwrap().starts_with("msg_"));
}

#[test]
fn resends_mail_given_up_on_as_a_new_message_and_closes_its_item() {
    let failure = || Pushed::Failed {
        detail: "the server is gone".to_owned(),
    };
    let f = fixture(push([
        failure(),
        failure(),
        failure(),
        Pushed::Accepted { offline: false },
    ]));
    f.send(None, &f.to, "k", "hello");
    let given_up = open(&f, &f.to);
    let id = given_up
        .first()
        .map_or_else(String::new, |(id, _)| id.clone());
    let before = offered(&f);
    let resent = call(&f, resend, &id, &json!({ "idempotencyKey": "r" }));
    let pushes: Vec<(String, String)> = f
        .stub
        .pushes
        .lock()
        .unwrap()
        .iter()
        .map(|p| (p.message_id.clone(), p.body.clone()))
        .collect();
    let resent_id = resent.1["messageId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert_eq!(
        (
            given_up
                .into_iter()
                .map(|(_, kind)| kind)
                .collect::<Vec<_>>(),
            before,
            resent.0,
            pushes.last().cloned(),
            pushes.len(),
            closes(&f),
            offered(&f),
        ),
        (
            vec![AttentionKind::Undeliverable],
            (200, vec![json!(["reply", "resend", "dismiss"])]),
            200,
            Some((resent_id, "hello".to_owned())),
            4,
            vec![(id, json!({ "reason": "resent" }))],
            (200, vec![json!([])]),
        )
    );
}

#[test]
fn refuses_a_verb_its_item_doesnt_offer_now_and_any_on_an_item_not_open() {
    let f = fixture(pull());
    let id = failed(&f, &f.to);
    let key = |key: &str| json!({ "idempotencyKey": key });
    let resend_failed = call(&f, resend, &id, &key("r"));
    let allow = call(
        &f,
        by_human,
        &id,
        &json!({ "idempotencyKey": "a", "decision": "allow" }),
    );
    f.set_state(&f.to.clone(), "closed");
    let reply_closed = call(
        &f,
        reply,
        &id,
        &json!({ "idempotencyKey": "p", "body": "hi" }),
    );
    let first = call(&f, dismiss, &id, &key("d"));
    let second = call(&f, dismiss, &id, &key("e"));
    let nothing = call(&f, dismiss, "attn_none", &key("f"));
    assert_eq!(
        (
            [resend_failed, allow, reply_closed, second, nothing].map(|a| refused(&a, &id)),
            first.0,
            f.mail(),
            closes(&f),
        ),
        (
            [
                (
                    409,
                    "attention item A can't be answered with resend".to_owned()
                ),
                (
                    409,
                    "attention item A can't be answered with allow".to_owned()
                ),
                (
                    409,
                    "attention item A can't be answered with reply".to_owned()
                ),
                (409, "attention item A is not open".to_owned()),
                (409, "attention item attn_none is not open".to_owned()),
            ],
            200,
            vec![],
            vec![(id.clone(), json!({ "reason": "dismissed" }))],
        )
    );
}

#[test]
fn offers_a_dismissal_of_all_but_a_harness_request_and_a_reply_while_its_agent_takes_mail() {
    use AttentionAction::{Dismiss, Reply, Resend};
    let (id, agent) = (
        AttentionId::parse("attn_01900000000070008000000000000001").unwrap(),
        AgentId::parse("agent_01900000000070008000000000000001").unwrap(),
    );
    let offered = |kind: AttentionKind, state: Option<&str>| {
        Inbox(Arc::default()).attention_actions(&OpenAttention {
            id: &id,
            agent_id: &agent,
            kind: &kind,
            tool_use_id: None,
            main_agent: true,
            message_id: None,
            task_id: None,
            agent_state: state,
        })
    };
    assert_eq!(
        [
            offered(AttentionKind::Approval, Some("running")),
            offered(AttentionKind::Question, Some("running")),
            offered(AttentionKind::StuckStarting, Some("starting")),
            offered(AttentionKind::Unknown("later".to_owned()), Some("running")),
            offered(AttentionKind::Failed, Some("running")),
            offered(AttentionKind::Failed, Some("lost")),
            offered(AttentionKind::Undeliverable, Some("exited")),
            offered(AttentionKind::Undeliverable, Some("closing")),
            offered(AttentionKind::Escalation, None),
            offered(AttentionKind::TaskDone, Some("failed")),
        ],
        [
            vec![],
            vec![],
            vec![Dismiss],
            vec![Dismiss],
            vec![Reply, Dismiss],
            vec![Reply, Dismiss],
            vec![Reply, Resend, Dismiss],
            vec![Dismiss],
            vec![Dismiss],
            vec![Dismiss],
        ]
    );
}
