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
use bazhen_protocol::ids::DeviceId;
use bazhen_protocol::nullable::Nullable;
use bazhen_protocol::shells::{
    CloseShellRequest, OpenShellRequest, RenameShellRequest, RestartShellRequest,
    ShellCommandResponse, ShellDecline, ShellPrompt, ShellReport, shell_name,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::paired::Viewer;
use crate::routes::{Shared, fail, internal};
use crate::shells::reports::ReportOutcome;
use crate::shells::{ShellError, Shells};

/// The most UTF-16 units an idempotency key has, and a confirmed program's name.
const KEY_MAX_UNITS: usize = 200;
const PROGRAM_MAX_UNITS: usize = 200;

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The protocol's error for a shell's failure.
pub(crate) fn refusal(err: &ShellError) -> Response {
    let (status, code) = match err {
        ShellError::Invalid(_) => (StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest),
        ShellError::Unsupported(_) => (StatusCode::BAD_REQUEST, ErrorCode::Unsupported),
        ShellError::Limit(_) => (StatusCode::CONFLICT, ErrorCode::TerminalLimit),
        ShellError::Idempotency(_) | ShellError::Conflict(_) => {
            (StatusCode::CONFLICT, ErrorCode::Conflict)
        }
        ShellError::Unknown(_) => (StatusCode::NOT_FOUND, ErrorCode::NotFound),
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
    serde_json::from_slice(body)
        .map_err(|err| ShellError::Invalid(format!("the body is not a {what}: {err}")))
}

fn keyed(key: &str) -> Result<(), ShellError> {
    if (1..=KEY_MAX_UNITS).contains(&units(key)) {
        Ok(())
    } else {
        Err(ShellError::Invalid(
            "idempotencyKey is 1 to 200 characters".to_owned(),
        ))
    }
}

fn open_request(body: &[u8]) -> Result<OpenShellRequest, ShellError> {
    let req: OpenShellRequest = parsed(body, "shell to open")?;
    keyed(&req.idempotency_key)?;
    if req.cwd.as_deref() == Some("") {
        return Err(ShellError::Invalid("cwd is a path".to_owned()));
    }
    if req.linked_agent_id.is_some() && req.cwd.is_some() {
        return Err(ShellError::Invalid(
            "a linked shell opens in its agent's directory, so it takes no cwd".to_owned(),
        ));
    }
    Ok(req)
}

fn close_request(body: &[u8]) -> Result<CloseShellRequest, ShellError> {
    let req: CloseShellRequest = parsed(body, "shell's close")?;
    keyed(&req.idempotency_key)?;
    if req
        .confirmed_program
        .as_deref()
        .is_some_and(|p| units(p) > PROGRAM_MAX_UNITS)
    {
        return Err(ShellError::Invalid(
            "confirmedProgram is at most 200 characters".to_owned(),
        ));
    }
    Ok(req)
}

fn restart_request(body: &[u8]) -> Result<RestartShellRequest, ShellError> {
    let req: RestartShellRequest = parsed(body, "shell's restart")?;
    keyed(&req.idempotency_key)?;
    if req.retype == Some(false) {
        return Err(ShellError::Invalid("retype is only ever true".to_owned()));
    }
    Ok(req)
}

/// A rename as sent: its name may be null, but must be there.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rename {
    idempotency_key: String,
    #[serde(default, deserialize_with = "Nullable::present")]
    name: Nullable<String>,
}

/// The rename asked for, its name trimmed as the schema keeps it.
fn rename_request(body: &[u8]) -> Result<RenameShellRequest, ShellError> {
    let req: Rename = parsed(body, "shell's name")?;
    keyed(&req.idempotency_key)?;
    let name = match req.name {
        Nullable::Absent => {
            return Err(ShellError::Invalid(
                "name is a name, or null to take it away".to_owned(),
            ));
        }
        Nullable::Null => None,
        Nullable::Value(name) => Some(shell_name(&name).map(str::to_owned).ok_or_else(|| {
            ShellError::Invalid(
                "name is 1 to 80 characters once trimmed, with no control characters or bidirectional overrides".to_owned(),
            )
        })?),
    };
    Ok(RenameShellRequest {
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
    serde_json::from_slice(&body)
        .ok()
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

/// `POST /v1/shells/:id/report`, on the socket only: the line the shell starts running.
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
        Ok(shells) => shells.report(&id, req).await,
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
        Ok(shells) => shells.prompt(&id, &req).await,
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
        Ok(shells) => shells.decline(&id, &req).await,
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

    /// What a router answers a POST of `body` to `path` with, reaching it from this machine.
    fn posted(router: axum::Router, path: &str, body: Vec<u8>) -> (u16, serde_json::Value) {
        use tower::ServiceExt as _;
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(path)
            .header("host", "127.0.0.1:7900")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body))
            .unwrap();
        crate::testing::runtime().block_on(async {
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
        let id = crate::testing::runtime().block_on(h.open("o")).unwrap();
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
        ];
        let expected = "expected { token, at, command }";
        assert_eq!(
            [
                posted(socket(), &at("report"), report),
                posted(socket(), &at("report"), forged),
                posted(socket(), &at("report"), padded(16 * 1024)),
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
            malformed.map(|body| posted(socket(), &at("report"), body)),
            [(); 4].map(|()| said("invalid_request", expected))
        );
        assert_eq!(h.last_command(&id), Some("make".to_owned()));
        let marked_null = json(serde_json::json!({ "token": token, "brackets": null }));
        let forged = json(serde_json::json!({ "token": "forged" }));
        let long = json(serde_json::json!({ "token": "x".repeat(1024) }));
        let too_large = (
            413,
            serde_json::json!({ "error": "invalid_request", "message": "report too large" }),
        );
        assert_eq!(
            [
                posted(socket(), &at("prompt"), own.clone()),
                posted(socket(), &at("decline"), own.clone()),
                posted(socket(), &at("prompt"), forged.clone()),
                posted(socket(), &at("decline"), forged),
                posted(socket(), &at("prompt"), marked_null),
                posted(socket(), &at("decline"), b"{}".to_vec()),
                posted(socket(), &at("prompt"), long.clone()),
                posted(socket(), &at("decline"), long),
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
            ]
        );
        let gate = crate::routes::Gate {
            allow: crate::guard::allowlists(7900, None, &[]),
            pairing_required: false,
        };
        let http = crate::routes::http_router(shared.clone(), gate);
        let over_http = ["report", "prompt", "decline"]
            .map(|verb| posted(http.clone(), &at(verb), own.clone()).0);
        assert_eq!(over_http, [404; 3]);
    }
}
