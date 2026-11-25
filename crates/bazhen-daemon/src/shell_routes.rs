//! The shells' routes (`POST /v1/shells` and `/v1/shells/:id/*` in `http/app.ts`), each body held
//! to its schema's rules, and the shells' failures as the protocol's errors.

use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_protocol::daemon::{ErrorCode, ErrorResponse};
use bazhen_protocol::edge::{EdgeCheck, OBJECT_RULE, Refused, is_object};
use bazhen_protocol::ids::DeviceId;
use bazhen_protocol::nullable::Nullable;
use bazhen_protocol::shells::{
    CloseShellRequest, OpenShellRequest, RenameShellRequest, RestartShellRequest,
    ShellCommandResponse, ShellDecline, ShellPrompt, ShellReport, UnlinkShellRequest,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::paired::Viewer;
use crate::routes::{Shared, fail, internal};
use crate::shells::reports::{ReportKind, ReportOutcome};
use crate::shells::{ShellError, Shells};

/// The protocol's error for a shell's failure.
pub(crate) fn refusal(err: &ShellError) -> Response {
    let (status, code) = match err {
        ShellError::Invalid(_) => (StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest),
        ShellError::Limit(_) => (StatusCode::CONFLICT, ErrorCode::TerminalLimit),
        ShellError::Idempotency(_) | ShellError::Conflict(_) => {
            (StatusCode::CONFLICT, ErrorCode::Conflict)
        }
        ShellError::Unknown(_) | ShellError::UnknownAgent(_) => {
            (StatusCode::NOT_FOUND, ErrorCode::NotFound)
        }
        ShellError::Stale { .. } => (StatusCode::CONFLICT, ErrorCode::StaleGeneration),
        ShellError::Busy { message, busy } => {
            let body = ErrorResponse {
                error: ErrorCode::Busy,
                message: message.clone(),
                busy: Some(busy.clone()),
            };
            return (StatusCode::CONFLICT, axum::Json(body)).into_response();
        }
        ShellError::OpenFailed(_) => (StatusCode::BAD_GATEWAY, ErrorCode::LaunchFailed),
        ShellError::ServerUnconfirmed(_) => (StatusCode::CONFLICT, ErrorCode::ServerUnconfirmed),
        ShellError::NeedsRestart(_) => (StatusCode::CONFLICT, ErrorCode::NeedsRestart),
        ShellError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable),
        ShellError::Internal(_) => return internal(err),
    };
    fail(status, code, &err.to_string())
}

/// `body` as the request `what` names, or why it isn't one.
fn parsed<R: DeserializeOwned>(body: &[u8], what: &str) -> Result<R, ShellError> {
    if !is_object(body) {
        return Err(ShellError::Invalid(OBJECT_RULE.to_owned()));
    }
    serde_json::from_slice(body)
        .map_err(|err| ShellError::Invalid(format!("the body is not a {what}: {err}")))
}

/// `req` held to the edge's rules, or the first it breaks.
fn checked<R: EdgeCheck>(req: R) -> Result<R, ShellError> {
    req.checked()
        .map_err(|Refused(rule)| ShellError::Invalid(rule))
}

fn open_request(body: &[u8]) -> Result<OpenShellRequest, ShellError> {
    checked(parsed::<OpenShellRequest>(body, "shell to open")?)
}

fn close_request(body: &[u8]) -> Result<CloseShellRequest, ShellError> {
    checked(parsed::<CloseShellRequest>(body, "shell's close")?)
}

fn restart_request(body: &[u8]) -> Result<RestartShellRequest, ShellError> {
    checked(parsed::<RestartShellRequest>(body, "shell's restart")?)
}

fn unlink_request(body: &[u8]) -> Result<UnlinkShellRequest, ShellError> {
    checked(parsed::<UnlinkShellRequest>(body, "shell's unlink")?)
}

/// A rename as sent: its name may be null, but must be there.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rename {
    idempotency_key: String,
    #[serde(default, deserialize_with = "Nullable::present")]
    name: Nullable<String>,
}

/// The rename asked for, its name trimmed as the schema keeps it. An absent name is refused here,
/// before the edge, so the refusal says what a rename's name may be.
fn rename_request(body: &[u8]) -> Result<RenameShellRequest, ShellError> {
    let req: Rename = parsed(body, "shell's name")?;
    let name = match req.name {
        Nullable::Absent => {
            return Err(ShellError::Invalid(
                "name is a name, or null to take it away".to_owned(),
            ));
        }
        Nullable::Null => None,
        Nullable::Value(name) => Some(name),
    };
    checked(RenameShellRequest {
        idempotency_key: req.idempotency_key,
        name,
    })
}

/// The shells, where this daemon runs any.
fn shells_of(shared: &Shared) -> Result<&Arc<Shells>, ShellError> {
    shared
        .shells
        .as_ref()
        .ok_or_else(|| ShellError::Unavailable("this daemon runs no terminals".to_owned()))
}

/// The paired device a request came from: only a device's own request over HTTP names one.
fn device_of(viewer: Option<Extension<Viewer>>) -> Option<DeviceId> {
    match viewer {
        Some(Extension(Viewer::Device { id, .. })) => Some(id),
        _ => None,
    }
}

fn answer(done: Result<ShellCommandResponse, ShellError>) -> Response {
    match done {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => refusal(&err),
    }
}

pub(crate) async fn open(
    State(shared): State<Shared>,
    viewer: Option<Extension<Viewer>>,
    body: Bytes,
) -> Response {
    let opened = async {
        let req = open_request(&body)?;
        let by = device_of(viewer);
        shells_of(&shared)?
            .completing(move |shells| async move { shells.open(&req, by).await })
            .await
    };
    answer(opened.await)
}

pub(crate) async fn close(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let closed = async {
        let req = close_request(&body)?;
        shells_of(&shared)?
            .completing(move |shells| async move { shells.close(&id, &req).await })
            .await
    };
    answer(closed.await)
}

pub(crate) async fn restart(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    viewer: Option<Extension<Viewer>>,
    body: Bytes,
) -> Response {
    let restarted = async {
        let req = restart_request(&body)?;
        let by = device_of(viewer);
        shells_of(&shared)?
            .completing(move |shells| async move { shells.restart(&id, &req, by).await })
            .await
    };
    answer(restarted.await)
}

pub(crate) async fn unlink(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let unlinked = async {
        let req = unlink_request(&body)?;
        shells_of(&shared)?
            .completing(move |shells| async move { shells.unlink(&id, &req).await })
            .await
    };
    answer(unlinked.await)
}

pub(crate) async fn rename(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let renamed = async {
        let req = rename_request(&body)?;
        shells_of(&shared)?
            .completing(move |shells| async move { shells.rename(&id, &req).await })
            .await
    };
    answer(renamed.await)
}

/// The most bytes a line's report has, and a prompt's or a decline's, which is its token alone.
pub(crate) const REPORT_MAX_BYTES: usize = 16 * 1024;
pub(crate) const PROMPT_MAX_BYTES: usize = 1024;

/// Why a shell's report wasn't read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unread {
    /// Its body is past the route's limit.
    TooLarge,
    /// Its body isn't one, or breaks its bounds.
    Malformed,
}

impl Unread {
    /// The answer to it, which says what a report was `expected` to be.
    fn answer(self, expected: &str) -> Response {
        match self {
            Self::TooLarge => fail(
                StatusCode::PAYLOAD_TOO_LARGE,
                ErrorCode::InvalidRequest,
                "report too large",
            ),
            Self::Malformed => fail(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest, expected),
        }
    }
}

/// A shell's report as its integration sends it over the socket, held to its bounds.
fn reported<R: DeserializeOwned>(
    body: Result<Bytes, BytesRejection>,
    bounded: fn(&R) -> bool,
) -> Result<R, Unread> {
    let body = match body {
        Ok(body) => body,
        Err(err) if err.status() == StatusCode::PAYLOAD_TOO_LARGE => return Err(Unread::TooLarge),
        Err(_) => return Err(Unread::Malformed),
    };
    is_object(&body)
        .then(|| serde_json::from_slice(&body).ok())
        .flatten()
        .filter(bounded)
        .ok_or(Unread::Malformed)
}

fn not_its_token() -> Response {
    fail(
        StatusCode::FORBIDDEN,
        ErrorCode::Forbidden,
        "no such shell, or not its token",
    )
}

/// `POST /v1/shells/:id/report`, on the socket only: the line the shell starts running. Once its
/// body is whole, it is handled on the shells' keeper, to its end even if the hook hangs up first,
/// as a prompt and a decline are.
pub(crate) async fn report(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let req: ShellReport = match reported(body, ShellReport::bounded) {
        Ok(req) => req,
        Err(unread) => return unread.answer("expected { token, at, command }"),
    };
    let reported = match shells_of(&shared) {
        Ok(shells) => {
            let on = id.clone();
            shells
                .kept(ReportKind::Line, &on, move |shells| async move {
                    shells.report(&id, req).await
                })
                .await
        }
        Err(err) => Err(err),
    };
    match reported {
        Ok(ReportOutcome::Refused) => not_its_token(),
        Ok(ReportOutcome::Kept | ReportOutcome::Stale) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => refusal(&err),
    }
}

/// `POST /v1/shells/:id/prompt`, on the socket only: the shell's first prompt.
pub(crate) async fn prompt(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let req: ShellPrompt = match reported(body, ShellPrompt::bounded) {
        Ok(req) => req,
        Err(unread) => return unread.answer("expected { token }"),
    };
    let prompted = match shells_of(&shared) {
        Ok(shells) => {
            let on = id.clone();
            shells
                .kept(ReportKind::Prompt, &on, move |shells| async move {
                    shells.prompt(&id, &req).await
                })
                .await
        }
        Err(err) => Err(err),
    };
    owned(prompted)
}

/// `POST /v1/shells/:id/decline`, on the socket only: a shell that won't take a line typed back.
pub(crate) async fn decline(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let req: ShellDecline = match reported(body, ShellDecline::bounded) {
        Ok(req) => req,
        Err(unread) => return unread.answer("expected { token }"),
    };
    let declined = match shells_of(&shared) {
        Ok(shells) => {
            let on = id.clone();
            shells
                .kept(ReportKind::Decline, &on, move |shells| async move {
                    shells.decline(&id, &req).await
                })
                .await
        }
        Err(err) => Err(err),
    };
    owned(declined)
}

/// The answer to a report that was the shell's own, or not.
fn owned(done: Result<bool, ShellError>) -> Response {
    match done {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_its_token(),
        Err(err) => refusal(&err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_name_trimmed_and_refuses_one_a_client_couldnt_show() {
        let named = rename_request(br#"{"idempotencyKey":"n","name":"  dev server  "}"#).unwrap();
        let taken = rename_request(br#"{"idempotencyKey":"n","name":null}"#).unwrap();
        assert_eq!(
            (named.name.as_deref(), taken.name),
            (Some("dev server"), None)
        );
        for refused in [
            r#"{"idempotencyKey":"n","name":"   "}"#,
            r#"{"idempotencyKey":"n","name":"a\u202eb"}"#,
            r#"{"idempotencyKey":"n"}"#,
            r#"{"idempotencyKey":"","name":"x"}"#,
        ] {
            assert!(
                matches!(
                    rename_request(refused.as_bytes()),
                    Err(ShellError::Invalid(_))
                ),
                "{refused}"
            );
        }
    }

    #[test]
    fn refuses_an_open_that_names_both_an_agent_and_a_directory_or_an_empty_one() {
        for refused in [
            r#"{"idempotencyKey":"o","cwd":"/","linkedAgentId":"agent_01900000000070008000000000000001"}"#,
            r#"{"idempotencyKey":"o","cwd":""}"#,
            r#"{"idempotencyKey":"o","theme":"blue"}"#,
            "[]",
        ] {
            assert!(
                matches!(
                    open_request(refused.as_bytes()),
                    Err(ShellError::Invalid(_))
                ),
                "{refused}"
            );
        }
        assert!(open_request(br#"{"idempotencyKey":"o","cwd":"~/x","theme":"dark"}"#).is_ok());
    }

    #[test]
    fn refuses_a_close_with_no_generation_and_a_restart_asking_not_to_retype() {
        assert!(matches!(
            close_request(br#"{"idempotencyKey":"c"}"#),
            Err(ShellError::Invalid(_))
        ));
        assert!(matches!(
            restart_request(br#"{"idempotencyKey":"r","generation":0,"retype":false}"#),
            Err(ShellError::Invalid(_))
        ));
    }

    #[test]
    fn counts_each_bound_in_code_points_so_astral_text_at_it_is_taken_and_one_past_refused() {
        let emoji = |n: usize| "\u{1f600}".repeat(n);
        let body = |value: serde_json::Value| serde_json::to_vec(&value).unwrap();
        let named = |n: usize| {
            rename_request(&body(
                serde_json::json!({ "idempotencyKey": "n", "name": emoji(n) }),
            ))
            .map(|rename| rename.name)
            .map_err(|err| err.to_string())
        };
        for (n, taken) in [(200, true), (201, false)] {
            let key = emoji(n);
            let judged = [
                open_request(&body(serde_json::json!({ "idempotencyKey": key }))).is_ok(),
                close_request(&body(
                    serde_json::json!({ "idempotencyKey": key, "generation": 0 }),
                ))
                .is_ok(),
                close_request(&body(serde_json::json!({
                    "idempotencyKey": "c", "generation": 0, "confirmedProgram": key,
                })))
                .is_ok(),
                restart_request(&body(
                    serde_json::json!({ "idempotencyKey": key, "generation": 0 }),
                ))
                .is_ok(),
                rename_request(&body(
                    serde_json::json!({ "idempotencyKey": key, "name": null }),
                ))
                .is_ok(),
            ];
            assert_eq!(judged, [taken; 5], "{n} code points");
        }
        assert_eq!(named(80), Ok(Some(emoji(80))));
        assert!(named(81).is_err_and(|refused| refused.starts_with("name is 1 to 80")));
    }

    #[test]
    fn refuses_a_generation_past_the_largest_safe_integer() {
        let ask = |generation: u64| {
            let body = format!(r#"{{"idempotencyKey":"g","generation":{generation}}}"#);
            (
                close_request(body.as_bytes())
                    .map(drop)
                    .map_err(|e| e.to_string()),
                restart_request(body.as_bytes())
                    .map(drop)
                    .map_err(|e| e.to_string()),
            )
        };
        let past = Err("generation is a safe integer".to_owned());
        assert_eq!(ask((1 << 53) - 1), (Ok(()), Ok(())));
        assert_eq!(ask(1 << 53), (past.clone(), past));
    }

    #[test]
    fn refuses_null_for_a_field_a_request_may_only_leave_out() {
        let opens = ["linkedAgentId", "cwd", "theme"]
            .map(|field| format!(r#"{{"idempotencyKey":"o","{field}":null}}"#));
        let closes = ["confirmBusy", "confirmedProgram", "force"]
            .map(|field| format!(r#"{{"idempotencyKey":"c","generation":0,"{field}":null}}"#));
        let restarts = ["theme", "retype"]
            .map(|field| format!(r#"{{"idempotencyKey":"r","generation":0,"{field}":null}}"#));
        let refused = |r: &Result<_, ShellError>| matches!(r, Err(ShellError::Invalid(_)));
        for body in &opens {
            assert!(refused(&open_request(body.as_bytes()).map(drop)), "{body}");
        }
        for body in &closes {
            assert!(refused(&close_request(body.as_bytes()).map(drop)), "{body}");
        }
        for body in &restarts {
            assert!(
                refused(&restart_request(body.as_bytes()).map(drop)),
                "{body}"
            );
        }
    }

    /// The status and JSON body `err` is answered with.
    fn answered(err: &ShellError) -> (u16, serde_json::Value) {
        let response = refusal(err);
        let status = response.status().as_u16();
        let bytes = crate::testing::runtime()
            .block_on(axum::body::to_bytes(response.into_body(), 1 << 16))
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn answers_a_busy_shell_naming_its_program_and_each_refusal_with_its_status_and_code() {
        let busy = ShellError::Busy {
            message: "nvim is running in shell term_x; close anyway to end it".to_owned(),
            busy: vec![bazhen_protocol::shells::BusyShell {
                terminal_id: bazhen_protocol::ids::TerminalId::parse(
                    "term_0190a1b2c3d47abc8def0123456789ad",
                )
                .unwrap(),
                program: "nvim".to_owned(),
            }],
        };
        let limit = ShellError::Limit(crate::budget::TerminalLimit {
            message: "full".to_owned(),
            open: 3,
            host: false,
        });
        assert_eq!(
            answered(&busy),
            (
                409,
                serde_json::json!({
                    "error": "busy",
                    "message": "nvim is running in shell term_x; close anyway to end it",
                    "busy": [{"terminalId": "term_0190a1b2c3d47abc8def0123456789ad", "program": "nvim"}],
                })
            )
        );
        assert_eq!(
            [
                answered(&limit),
                answered(&ShellError::OpenFailed("term_x".to_owned())),
                answered(&ShellError::Stale {
                    id: "term_x".to_owned(),
                    generation: 2
                }),
            ],
            [
                (
                    409,
                    serde_json::json!({"error": "terminal_limit", "message": "full"})
                ),
                (
                    502,
                    serde_json::json!({"error": "launch_failed", "message": "shell term_x failed to open"})
                ),
                (
                    409,
                    serde_json::json!({"error": "stale_generation", "message": "shell term_x is at generation 2"})
                ),
            ]
        );
    }

    /// What a router answers a POST of `body` to `path` with, reaching it from this machine, on
    /// `runtime`: a test's requests share one, as the daemon's do, which runs the shells' keeper.
    fn posted(
        runtime: &tokio::runtime::Runtime,
        router: axum::Router,
        path: &str,
        body: Vec<u8>,
    ) -> (u16, serde_json::Value) {
        use tower::ServiceExt as _;
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(path)
            .header("host", "127.0.0.1:7900")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body))
            .unwrap();
        runtime.block_on(async {
            let response = router.oneshot(request).await.unwrap();
            let status = response.status().as_u16();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
                .await
                .unwrap();
            let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
            (status, body)
        })
    }

    fn said(error: &str, message: &str) -> (u16, serde_json::Value) {
        let status = match error {
            "forbidden" => 403,
            _ => 400,
        };
        (
            status,
            serde_json::json!({ "error": error, "message": message }),
        )
    }

    #[test]
    fn takes_a_shell_s_reports_over_the_socket_by_its_own_token_held_to_their_bounds() {
        use crate::shells::tests::{integration, setup_with};
        let h = setup_with(100, Some(integration()));
        let runtime = crate::testing::runtime();
        let id = runtime.block_on(h.open("o")).unwrap();
        let token = h.token_of(&id).unwrap();
        let shared = Shared {
            shells: Some(Arc::clone(&h.shells)),
            ..Shared::new(
                "f".repeat(64).as_str(),
                crate::routes::Stop::default(),
                h.store.clone(),
            )
        };
        let socket = || crate::routes::socket_router(shared.clone());
        let at = |verb: &str| format!("/v1/shells/{id}/{verb}");
        let json = |value: serde_json::Value| value.to_string().into_bytes();
        let report = json(serde_json::json!({ "token": token, "at": 1, "command": "make" }));
        let forged = json(serde_json::json!({ "token": "forged", "at": 2, "command": "rm -rf ~" }));
        let own = json(serde_json::json!({ "token": token }));
        let padded = |limit: usize| {
            json(serde_json::json!({ "token": token, "at": 3, "command": "x".repeat(limit) }))
        };
        let malformed = [
            b"{}".to_vec(),
            json(serde_json::json!({ "token": token, "at": 1 })),
            json(serde_json::json!({ "token": token, "at": -1, "command": null })),
            b"not json".to_vec(),
            json(serde_json::json!([token, 4, "rm -rf ~"])),
        ];
        let expected = "expected { token, at, command }";
        assert_eq!(
            [
                posted(&runtime, socket(), &at("report"), report),
                posted(&runtime, socket(), &at("report"), forged),
                posted(&runtime, socket(), &at("report"), padded(16 * 1024)),
            ],
            [
                (204, serde_json::Value::Null),
                said("forbidden", "no such shell, or not its token"),
                (
                    413,
                    serde_json::json!({ "error": "invalid_request", "message": "report too large" })
                ),
            ]
        );
        assert_eq!(
            malformed.map(|body| posted(&runtime, socket(), &at("report"), body)),
            [(); 5].map(|()| said("invalid_request", expected))
        );
        assert_eq!(h.last_command(&id), Some("make".to_owned()));
        let marked_null = json(serde_json::json!({ "token": token, "brackets": null }));
        let forged = json(serde_json::json!({ "token": "forged" }));
        let long = json(serde_json::json!({ "token": "x".repeat(1024) }));
        let listed = json(serde_json::json!([token]));
        let too_large = (
            413,
            serde_json::json!({ "error": "invalid_request", "message": "report too large" }),
        );
        assert_eq!(
            [
                posted(&runtime, socket(), &at("prompt"), own.clone()),
                posted(&runtime, socket(), &at("decline"), own.clone()),
                posted(&runtime, socket(), &at("prompt"), forged.clone()),
                posted(&runtime, socket(), &at("decline"), forged),
                posted(&runtime, socket(), &at("prompt"), marked_null),
                posted(&runtime, socket(), &at("decline"), b"{}".to_vec()),
                posted(&runtime, socket(), &at("prompt"), long.clone()),
                posted(&runtime, socket(), &at("decline"), long),
                posted(&runtime, socket(), &at("prompt"), listed.clone()),
                posted(&runtime, socket(), &at("decline"), listed),
            ],
            [
                (204, serde_json::Value::Null),
                (204, serde_json::Value::Null),
                said("forbidden", "no such shell, or not its token"),
                said("forbidden", "no such shell, or not its token"),
                said("invalid_request", "expected { token }"),
                said("invalid_request", "expected { token }"),
                too_large.clone(),
                too_large,
                said("invalid_request", "expected { token }"),
                said("invalid_request", "expected { token }"),
            ]
        );
        let gate = crate::routes::Gate {
            allow: crate::guard::allowlists(7900, None, &[]),
            pairing_required: false,
        };
        let http = crate::routes::http_router(shared.clone(), gate);
        let over_http = ["report", "prompt", "decline"]
            .map(|verb| posted(&runtime, http.clone(), &at(verb), own.clone()).0);
        assert_eq!(over_http, [404; 3]);
    }

    #[test]
    fn takes_a_report_at_its_bounds_with_every_character_escaped() {
        use std::fmt::Write as _;

        use crate::shells::tests::{integration, setup_with};
        let h = setup_with(100, Some(integration()));
        let runtime = crate::testing::runtime();
        let id = runtime.block_on(h.open("o")).unwrap();
        let token = h.token_of(&id).unwrap();
        let shared = Shared {
            shells: Some(Arc::clone(&h.shells)),
            ..Shared::new(
                "f".repeat(64).as_str(),
                crate::routes::Stop::default(),
                h.store.clone(),
            )
        };
        let escaped = |text: &str| {
            text.encode_utf16().fold(String::new(), |mut out, unit| {
                write!(out, "\\u{unit:04x}").unwrap();
                out
            })
        };
        let longest = format!(
            r#"{{"token":"{}","at":9007199254740991,"command":"{}"}}"#,
            escaped(&token),
            escaped(&"a".repeat(2048))
        );
        assert_eq!(
            posted(
                &runtime,
                crate::routes::socket_router(shared),
                &format!("/v1/shells/{id}/report"),
                longest.into_bytes()
            ),
            (204, serde_json::Value::Null),
            "about 12 KiB of JSON, under the 16 KiB limit"
        );
        assert_eq!(h.last_command(&id), Some("a".repeat(2048)));
    }

    /// Calls the handlers themselves, not the socket's router: the router's caller guard
    /// identifies the caller in `spawn_blocking`, so a single poll of the router can't be known to
    /// have reached the keeper. Dropping the handler's future is what hyper does when the hook's
    /// socket closes.
    #[test]
    fn keeps_a_line_whose_hook_hung_up_while_the_store_was_held_and_says_so_once() {
        use crate::shells::reports::tests::waits;
        use crate::shells::tests::{Said, integration, setup_with};
        let h = setup_with(100, Some(integration()));
        let said = Said::default();
        let _logging = said.logging();
        let line = "cargo build --release";
        let (id, token) = crate::testing::runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let token = h.token_of(&id).unwrap();
            let shared = Shared {
                shells: Some(Arc::clone(&h.shells)),
                ..Shared::new(
                    "f".repeat(64).as_str(),
                    crate::routes::Stop::default(),
                    h.store.clone(),
                )
            };
            let body = |value: serde_json::Value| Ok(Bytes::from(value.to_string()));
            let (release, gate) = std::sync::mpsc::channel::<()>();
            let mut held = Box::pin(h.store.run(move |_| gate.recv().is_ok()));
            assert!(waits(&mut held).await);
            let mut reporting = Box::pin(report(
                State(shared.clone()),
                Path(id.clone()),
                body(serde_json::json!({ "token": token, "at": 1, "command": line })),
            ));
            assert!(waits(&mut reporting).await, "answered past the held store");
            // The hook hangs up, and hyper drops the route's future.
            drop(reporting);
            // Whatever runs the report reaches the store, behind the hold, before it is let go.
            tokio::task::yield_now().await;
            release.send(()).unwrap();
            assert!(held.await.unwrap());
            // Reports are handled in turn, so once a later one is answered the line's has ended.
            let prompted = prompt(
                State(shared),
                Path(id.clone()),
                body(serde_json::json!({ "token": token })),
            )
            .await;
            assert_eq!(prompted.status(), StatusCode::NO_CONTENT);
            assert_eq!(h.last_command(&id), Some(line.to_owned()));
            (id, token)
        });
        let text = said.text();
        assert_eq!(
            (
                said.times(&format!(
                    "shell {id}: finished a report its hook stopped waiting for"
                )),
                said.times("stopped waiting"),
                text.contains(line) || text.contains(&token),
            ),
            (1, 1, false),
            "{text}"
        );
    }
}
