//! The router against the edge: each planted case of a request the Rust daemon serves, sent to
//! its route, is refused as invalid exactly where `EdgeCheck` refuses it, but for the cases
//! `UNSHARED_CHECKS` lists. The cases are the corpus `cargo xtask schema` writes, each with the
//! edge's verdict. No route here runs a terminal or writes a store: the shells are absent and the
//! store closed, so a case the edge takes is answered past its validation without doing anything.

use std::collections::BTreeSet;
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

/// Where a case the route refuses differs from the edge, as (message, path, kind, owner, why): the
/// route's own check, written before the edge's, still decides it.
const UNSHARED_CHECKS: &[(&str, &str, &str, &str, &str)] = &[
    (
        "CloseShellRequest",
        "/generation",
        "pastMaximum",
        SHELLS,
        GENERATION,
    ),
    (
        "CloseShellRequest",
        "/generation",
        "pastSafe",
        SHELLS,
        GENERATION,
    ),
    (
        "RestartShellRequest",
        "/generation",
        "pastMaximum",
        SHELLS,
        GENERATION,
    ),
    (
        "RestartShellRequest",
        "/generation",
        "pastSafe",
        SHELLS,
        GENERATION,
    ),
    (
        "DismissNoticeRequest",
        "/idempotencyKey",
        "underMinLength",
        NOTICES,
        KEY,
    ),
    (
        "DismissNoticeRequest",
        "/idempotencyKey",
        "pastMaxLength",
        NOTICES,
        KEY,
    ),
    (
        "DismissNoticeRequest",
        "/idempotencyKey",
        "astralPastMaxLength",
        NOTICES,
        KEY,
    ),
];

const SHELLS: &str = "the shells routes' port";
const NOTICES: &str = "the notices routes' port";

const GENERATION: &str = "close_request and restart_request read the generation as serde's u64 \
                          and hold it to no bound, so one past 2^53 - 1 goes on to the shells";
const KEY: &str = "dismiss reads the idempotency key with serde alone and holds it to no \
                   length, so an empty or overlong key goes on to the store";

/// The route that reads each message, and whether it is the HTTP listener's alone.
fn route(message: &str) -> Option<(&'static str, bool)> {
    Some(match message {
        "CreateTaskRequest" => ("/v1/tasks", false),
        "DismissNoticeRequest" => ("/v1/notices/notice_1/dismiss", false),
        "OpenShellRequest" => ("/v1/shells", false),
        "CloseShellRequest" => ("/v1/shells/term_1/close", false),
        "RestartShellRequest" => ("/v1/shells/term_1/restart", false),
        "RenameShellRequest" => ("/v1/shells/term_1/rename", false),
        "ShellReport" => ("/v1/shells/term_1/report", false),
        "ShellPrompt" => ("/v1/shells/term_1/prompt", false),
        "ShellDecline" => ("/v1/shells/term_1/decline", false),
        "PairRequest" => ("/v1/pairing", true),
        _ => return None,
    })
}

fn router(http: bool) -> Router {
    let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), Writer::closed());
    if http {
        let gate = Gate {
            allow: guard::allowlists(7900, None, &[]),
            pairing_required: true,
        };
        http_router(shared, gate)
    } else {
        socket_router(shared)
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
        .build()
        .unwrap();
    let mut found = Vec::new();
    let mut listed = BTreeSet::new();
    let mut sent = 0;
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
        let body = case["body"].as_str().unwrap_or_default();
        let (route_refuses, status, answer) = runtime.block_on(refused(path, http, body));
        sent += 1;
        if route_refuses == edge_refuses {
            continue;
        }
        let key = (
            message,
            case["path"].as_str().unwrap_or_default(),
            case["kind"].as_str().unwrap_or_default(),
        );
        if UNSHARED_CHECKS
            .iter()
            .any(|(m, p, k, _, _)| (*m, *p, *k) == key)
        {
            listed.insert(key);
            continue;
        }
        let edge = if edge_refuses { "refuses" } else { "takes" };
        found.push(format!(
            "{}{} ({}): the edge {edge} {body}, and {path} answers {status} {answer}",
            key.0, key.1, key.2
        ));
    }
    for (message, path, kind, _, _) in UNSHARED_CHECKS {
        if !listed.contains(&(*message, *path, *kind)) {
            found.push(format!(
                "UNSHARED_CHECKS lists {message}{path} ({kind}), which its route now agrees with"
            ));
        }
    }
    assert!(
        sent > 0,
        "{CORPUS} holds no case of a route this daemon serves"
    );
    assert!(found.is_empty(), "{}", found.join("\n"));
}
