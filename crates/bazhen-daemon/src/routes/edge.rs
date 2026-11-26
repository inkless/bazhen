//! The router against the edge: each planted case of a request the Rust daemon serves, sent to
//! its route, is refused as invalid exactly where `EdgeCheck` refuses it, but for the cases
//! `UNSHARED_CHECKS` lists. The cases are the corpus `cargo xtask schema` writes, each with the
//! edge's verdict. No route here runs a terminal or writes a store: the shells are absent and the
//! store closed, so a case the edge takes is answered past its validation without doing anything.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use axum::body::Body;
use axum::extract::Request;
use axum::{Router, http::Method};
use serde_json::Value;
use tower::ServiceExt;

use super::{Gate, Shared, Stop, guard, http_router, socket_router};
use crate::writer::Writer;

/// The corpus, under the repository's root.
const CORPUS: &str = "target/protocol-shadow/corpus.json";

/// The host and origin the HTTP router admits.
const HOST: &str = "127.0.0.1:7900";
const ORIGIN: &str = "http://127.0.0.1:7900";

/// A planted case the route judges otherwise than the edge: the route's own check, written before
/// the edge's, still decides it.
struct Unshared {
    message: &'static str,
    path: &'static str,
    kind: &'static str,
    /// Which of the two refuses the case; the other takes it.
    refused_by: Side,
    owner: &'static str,
    why: &'static str,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Side {
    Edge,
    Route,
}

/// Every case of each entry is judged otherwise, the same way round.
const UNSHARED_CHECKS: &[Unshared] = &[];

/// Each message a route reads, the route, and whether it is the HTTP listener's alone.
const ROUTES: &[(&str, &str, bool)] = &[
    ("CreateTaskRequest", "/v1/tasks", false),
    (
        "DismissNoticeRequest",
        "/v1/notices/notice_1/dismiss",
        false,
    ),
    ("OpenShellRequest", "/v1/shells", false),
    ("CloseShellRequest", "/v1/shells/term_1/close", false),
    ("RestartShellRequest", "/v1/shells/term_1/restart", false),
    ("RenameShellRequest", "/v1/shells/term_1/rename", false),
    ("UnlinkShellRequest", "/v1/shells/term_1/unlink", false),
    ("CloseAgentRequest", "/v1/agents/agent_1/close", false),
    ("SignalAgentRequest", "/v1/agents/agent_1/signal", false),
    ("RespawnAgentRequest", "/v1/agents/agent_1/respawn", false),
    ("ShellReport", "/v1/shells/term_1/report", false),
    ("ShellPrompt", "/v1/shells/term_1/prompt", false),
    ("ShellDecline", "/v1/shells/term_1/decline", false),
    (
        "SendMessageRequest",
        "/v1/agents/agent_01900000000070008000000000000001/messages",
        false,
    ),
    (
        "AnswerAttentionRequest",
        "/v1/attention/attn_1/answer",
        false,
    ),
    ("ReplyAttentionRequest", "/v1/attention/attn_1/reply", false),
    (
        "DismissAttentionRequest",
        "/v1/attention/attn_1/dismiss",
        false,
    ),
    (
        "ResendAttentionRequest",
        "/v1/attention/attn_1/resend",
        false,
    ),
    ("PairRequest", "/v1/pairing", true),
];

fn route(message: &str) -> Option<(&'static str, bool)> {
    ROUTES
        .iter()
        .find(|(m, _, _)| *m == message)
        .map(|(_, path, http)| (*path, *http))
}

fn router(http: bool) -> Router {
    let shared = |writer| Shared::new("f".repeat(64).as_str(), Stop::default(), writer);
    if http {
        let gate = Gate {
            allow: guard::allowlists(7900, None, &[]),
            pairing_required: true,
        };
        crate::testing::on_an_empty_store(|writer| {
            crate::testing::connected(http_router(shared(writer), gate))
        })
    } else {
        socket_router(shared(Writer::closed()))
    }
}

/// Whether the route refuses `body` as invalid, with the status and error it answers.
async fn refused(path: &str, http: bool, body: &str) -> (bool, u16, Value) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header("content-type", "application/json");
    if http {
        request = request.header("host", HOST).header("origin", ORIGIN);
    }
    let request = request.body(Body::from(body.to_owned())).unwrap();
    let response = router(http).oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let invalid = matches!(status, 400 | 413) && answer["error"] == "invalid_request";
    (invalid, status, answer)
}

/// The corpus's cases, or why there are none.
fn corpus() -> Vec<Value> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let text = std::fs::read_to_string(root.join(CORPUS)).unwrap_or_else(|err| {
        panic!("{CORPUS}: {err}; run `scripts/xtask.sh schema`, which writes it")
    });
    serde_json::from_str(&text).unwrap()
}

#[test]
fn each_route_refuses_as_invalid_what_the_edge_refuses_and_nothing_it_takes() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut found = Vec::new();
    let mut listed = BTreeSet::new();
    // For each message, how many cases the edge took and refused.
    let mut judged: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let cases = corpus();
    for case in &cases {
        let message = case["schema"].as_str().unwrap_or_default();
        let Some((path, http)) = route(message) else {
            continue;
        };
        let edge_refuses = match (&case["edge"]["taken"], &case["edge"]["refused"]) {
            (Value::Null, Value::Null) => continue,
            (_, Value::Null) => false,
            _ => true,
        };
        let counts = judged.entry(message).or_default();
        if edge_refuses {
            counts.1 += 1;
        } else {
            counts.0 += 1;
        }
        let body = case["body"].as_str().unwrap_or_default();
        let (route_refuses, status, answer) = runtime.block_on(refused(path, http, body));
        let key = (
            message,
            case["path"].as_str().unwrap_or_default(),
            case["kind"].as_str().unwrap_or_default(),
        );
        let entry = UNSHARED_CHECKS
            .iter()
            .find(|e| (e.message, e.path, e.kind) == key);
        let side = (route_refuses != edge_refuses).then_some(if edge_refuses {
            Side::Edge
        } else {
            Side::Route
        });
        if let Some(entry) = entry {
            listed.insert(key);
            if side == Some(entry.refused_by) {
                continue;
            }
        } else if side.is_none() {
            continue;
        }
        let edge = if edge_refuses { "refuses" } else { "takes" };
        let listing = entry.map_or(String::new(), |e| {
            format!(
                " (UNSHARED_CHECKS says {:?} alone refuses it: {})",
                e.refused_by, e.why
            )
        });
        found.push(format!(
            "{}{} ({}): the edge {edge} {body}, and {path} answers {status} {answer}{listing}",
            key.0, key.1, key.2
        ));
    }
    for entry in UNSHARED_CHECKS {
        let key = (entry.message, entry.path, entry.kind);
        if !listed.contains(&key) {
            found.push(format!(
                "UNSHARED_CHECKS lists {}{} ({}), owned by {}, which the corpus holds no case of",
                key.0, key.1, key.2, entry.owner
            ));
        }
    }
    for (message, _, _) in ROUTES {
        let (taken, refused) = judged.get(message).copied().unwrap_or_default();
        if taken == 0 || refused == 0 {
            found.push(format!(
                "{CORPUS} holds {taken} cases of {message} the edge takes and {refused} it \
                 refuses; each route needs both"
            ));
        }
    }
    assert!(found.is_empty(), "{}", found.join("\n"));
}
