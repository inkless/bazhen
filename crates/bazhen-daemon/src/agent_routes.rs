//! The agents' routes (`POST /v1/agents` in `http/app.ts`), and the agents' failures as the
//! protocol's errors.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_protocol::daemon::ErrorCode;

use crate::agent_launch::launch_request;
use crate::agents::{AgentError, Agents};
use crate::routes::{Shared, fail, internal};

/// The protocol's error for an agent's failure.
pub(crate) fn refusal(err: &AgentError) -> Response {
    let (status, code) = match err {
        AgentError::Invalid(_) => (StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest),
        AgentError::Unsupported(_) => (StatusCode::UNPROCESSABLE_ENTITY, ErrorCode::Unsupported),
        AgentError::Limit(_) => (StatusCode::CONFLICT, ErrorCode::TerminalLimit),
        AgentError::Idempotency(_) | AgentError::NameTaken(_) => {
            (StatusCode::CONFLICT, ErrorCode::Conflict)
        }
        AgentError::LaunchFailed { .. } => (StatusCode::BAD_GATEWAY, ErrorCode::LaunchFailed),
        AgentError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable),
        AgentError::Internal(_) => return internal(err),
    };
    fail(status, code, &err.to_string())
}

/// The agents, where this daemon runs any.
fn agents_of(shared: &Shared) -> Result<&Arc<Agents>, AgentError> {
    shared
        .agents
        .as_ref()
        .ok_or_else(|| AgentError::Unavailable("this daemon runs no terminals".to_owned()))
}

pub(crate) async fn launch(State(shared): State<Shared>, body: Bytes) -> Response {
    let launched = async {
        let req = launch_request(&body).map_err(AgentError::Invalid)?;
        agents_of(&shared)?
            .completing(move |agents| async move { agents.launch(&req).await })
            .await
    };
    match launched.await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => refusal(&err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_each_failure_with_its_status_and_code() {
        let limit = crate::budget::TerminalLimit {
            message: "4 terminals are open".to_owned(),
            open: 4,
            host: false,
        };
        let answered = [
            AgentError::Invalid("x".to_owned()),
            AgentError::Unsupported("x".to_owned()),
            AgentError::Limit(limit),
            AgentError::Idempotency("k".to_owned()),
            AgentError::NameTaken("lead".to_owned()),
            AgentError::LaunchFailed {
                agent: "agent_1".to_owned(),
                why: "x".to_owned(),
            },
            AgentError::Unavailable("x".to_owned()),
            AgentError::Internal("x".to_owned()),
        ]
        .map(|err| {
            let response = refusal(&err);
            let status = response.status().as_u16();
            let body = crate::testing::runtime()
                .block_on(axum::body::to_bytes(response.into_body(), 4096))
                .unwrap();
            let code = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|json| json["error"].as_str().map(str::to_owned));
            (status, code)
        });
        let code = |c: &str| Some(c.to_owned());
        assert_eq!(
            answered,
            [
                (400, code("invalid_request")),
                (422, code("unsupported")),
                (409, code("terminal_limit")),
                (409, code("conflict")),
                (409, code("conflict")),
                (502, code("launch_failed")),
                (503, code("unavailable")),
                (500, None),
            ]
        );
    }
}
