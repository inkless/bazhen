//! `POST /v1/tasks`'s body held to `CreateTaskRequest`'s rules (`http/app.ts`), so the store makes
//! only a task the TypeScript daemon would.

use bazhen_protocol::ids::TaskId;
use bazhen_protocol::tasks::Grant;
use bazhen_protocol::text::{TASK_BRIEF_MAX_UNITS, new_task_title};
use bazhen_store::NewTask;
use serde_json::Value;

/// The most UTF-16 units an idempotency key has.
const KEY_MAX_UNITS: usize = 200;

/// Why a body makes no task.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// It breaks the schema's rules, which the message names.
    Invalid(String),
    /// It is valid, but assigns the task, which needs agents this daemon doesn't run.
    Assigns,
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The task `body` asks for. Every rule is checked, and each one broken named, before an
/// assignment is refused, as the schema parses the whole body before the route sees it. Keys the
/// schema doesn't know are dropped, as it drops them.
///
/// # Errors
///
/// [`Refused`], saying why.
pub fn asked(body: &[u8]) -> Result<NewTask, Refused> {
    let Ok(Value::Object(body)) = serde_json::from_slice::<Value>(body) else {
        return Err(Refused::Invalid("the body is not a JSON object".to_owned()));
    };
    let text = |key: &str| match body.get(key) {
        Some(Value::String(text)) => Some(text.as_str()),
        _ => None,
    };
    let key = text("idempotencyKey").filter(|key| (1..=KEY_MAX_UNITS).contains(&units(key)));
    let title = text("title").and_then(new_task_title);
    let brief = text("brief").filter(|brief| (1..=TASK_BRIEF_MAX_UNITS).contains(&units(brief)));
    let parent = match body.get("parentTaskId") {
        None => Some(None),
        Some(Value::String(id)) => TaskId::parse(id).map(Some),
        Some(_) => None,
    };
    let assigns = match body.get("assign") {
        None => Some(false),
        Some(grant) => serde_json::from_value::<Grant>(grant.clone())
            .ok()
            .map(|_| true),
    };
    let broken: Vec<&str> = [
        (key.is_none(), "idempotencyKey is 1 to 200 characters"),
        (
            title.is_none(),
            "title is 1 to 200 characters once trimmed, with no control characters, bidirectional \
             overrides or invisible ones",
        ),
        (brief.is_none(), "brief is 1 to 20000 characters"),
        (parent.is_none(), "parentTaskId is a task id"),
        (assigns.is_none(), "assign is an agent and a role"),
    ]
    .into_iter()
    .filter_map(|(broken, rule)| broken.then_some(rule))
    .collect();
    match (key, title, brief, parent, assigns) {
        (Some(key), Some(title), Some(brief), Some(parent), Some(false)) => Ok(NewTask {
            caller: None,
            key: key.to_owned(),
            title: title.to_owned(),
            brief: brief.to_owned(),
            parent,
        }),
        (_, _, _, _, Some(true)) if broken.is_empty() => Err(Refused::Assigns),
        _ => Err(Refused::Invalid(broken.join("; "))),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fixture() -> Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/protocol/fixtures/store/events.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn body(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }

    fn valid() -> Value {
        json!({ "idempotencyKey": "k", "title": "T", "brief": "b" })
    }

    fn with(key: &str, value: Value) -> Vec<u8> {
        let mut request = valid();
        request[key] = value;
        body(&request)
    }

    #[test]
    fn keeps_each_request_the_typescript_daemon_recorded_as_it_recorded_it() {
        let log = &fixture()["log"];
        for (request, row) in log["requests"]
            .as_array()
            .unwrap()
            .iter()
            .zip(log["tables"]["idempotency_keys"].as_array().unwrap())
        {
            let task = asked(&body(request)).unwrap();
            assert_eq!(task.key, row["key"].as_str().unwrap());
            let kept: Value = serde_json::from_str(row["response"].as_str().unwrap()).unwrap();
            assert_eq!(
                task.request_text().unwrap(),
                kept["request"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn takes_a_title_trimmed_a_parent_by_id_and_drops_keys_it_doesnt_know() {
        let parent = "task_01900000000070008000000000000002";
        let mut request = valid();
        request["title"] = json!("\u{feff} Ship\u{a0}it \n");
        request["parentTaskId"] = json!(parent);
        request["extra"] = json!(1);
        let task = asked(&body(&request)).unwrap();
        assert_eq!(task.title, "Ship\u{a0}it");
        assert_eq!(task.parent.unwrap().as_str(), parent);
    }

    #[test]
    fn refuses_a_body_that_breaks_a_rule_naming_each_one_broken() {
        let long = |n: usize| json!("x".repeat(n));
        let refused = [
            (b"not json".to_vec(), "the body is not a JSON object"),
            (body(&json!(["k"])), "the body is not a JSON object"),
            (body(&json!({})), "idempotencyKey"),
            (with("idempotencyKey", json!("")), "idempotencyKey"),
            (with("idempotencyKey", long(201)), "idempotencyKey"),
            (with("title", json!("  ")), "title"),
            (with("title", long(201)), "title"),
            (with("title", json!("a\u{1b}[2J")), "title"),
            (with("title", json!("a\u{202e}b")), "title"),
            (with("title", json!("a\u{200b}b")), "title"),
            (with("title", json!("a\u{e0041}b")), "title"),
            (with("title", json!(7)), "title"),
            (with("brief", json!("")), "brief"),
            (with("brief", long(20_001)), "brief"),
            (with("parentTaskId", json!(null)), "parentTaskId"),
            (with("parentTaskId", json!("task_1")), "parentTaskId"),
            (
                with("assign", json!({ "agentId": "agent_x", "role": "Worker!" })),
                "assign",
            ),
        ];
        for (request, rule) in refused {
            let answer = asked(&request);
            assert!(
                matches!(&answer, Err(Refused::Invalid(message)) if message.contains(rule)),
                "{}: {answer:?}",
                String::from_utf8_lossy(&request)
            );
        }
        assert!(asked(&with("title", long(200))).is_ok());
        assert!(asked(&with("brief", long(20_000))).is_ok());
        let both = body(&json!({ "idempotencyKey": "", "title": "", "brief": "b" }));
        assert!(
            matches!(asked(&both), Err(Refused::Invalid(m)) if m.contains("idempotencyKey") && m.contains("title"))
        );
    }

    #[test]
    fn refuses_a_valid_assignment_as_unsupported_but_only_in_a_valid_body() {
        let grant = json!({ "agentId": "reviewer-1", "role": "worker" });
        assert_eq!(asked(&with("assign", grant.clone())), Err(Refused::Assigns));
        let mut request = valid();
        request["assign"] = grant;
        request["brief"] = json!("");
        assert!(matches!(asked(&body(&request)), Err(Refused::Invalid(_))));
    }
}
