//! The agents' routes (`POST /v1/agents`, and `POST /v1/agents/:id/` each command, in
//! `http/app.ts`), and the agents' failures as the protocol's errors.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_protocol::agents::{
    AgentCommandResponse, CloseAgentRequest, RespawnAgentRequest, SignalAgentRequest,
};
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::{EdgeCheck, Refused, edge};
use bazhen_protocol::ids::AgentId;
use bazhen_store::{OnceError, Rename, RenameError};
use serde::de::DeserializeOwned;

use crate::agent_requests::{launch_request, rename_request};
use crate::agents::{AgentError, Agents};
use crate::callers::{Caller, caller_of};
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
        AgentError::Unknown(_) => (StatusCode::NOT_FOUND, ErrorCode::NotFound),
        AgentError::Conflict(_) => (StatusCode::CONFLICT, ErrorCode::Conflict),
        AgentError::Stale { .. } => (StatusCode::CONFLICT, ErrorCode::StaleGeneration),
        AgentError::NotResumable(_) | AgentError::SessionTaken(_) => {
            (StatusCode::CONFLICT, ErrorCode::NotResumable)
        }
        AgentError::ServerUnconfirmed(_) => (StatusCode::CONFLICT, ErrorCode::ServerUnconfirmed),
        AgentError::NeedsRestart(_) => (StatusCode::CONFLICT, ErrorCode::NeedsRestart),
        AgentError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable),
        AgentError::Internal(_) => return internal(err),
        AgentError::Shells(err) => return crate::shell_routes::refusal(err),
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

/// Why an agent wasn't renamed, or that the path named no agent.
#[derive(Debug)]
enum Renaming {
    Invalid(String),
    /// The path names no agent: by its id, none the store knows; by its name, none live.
    Unnamed(String),
    Refused(RenameError),
    /// The store's writer has stopped.
    Closed(String),
}

/// The agent a path names by its id, in any state, or by its live name (`resolveAgent`).
async fn resolved(shared: &Shared, reference: String) -> Result<String, AgentError> {
    shared
        .store
        .run(move |store| {
            store.reads().resolve_agent(&reference)?.ok_or_else(|| {
                AgentError::Unknown(if AgentId::parse(&reference).is_some() {
                    reference
                } else {
                    format!("{reference} by that name")
                })
            })
        })
        .await?
}

/// A command on the agent the path names: its body held to its schema, then the agent resolved,
/// then the command, run to its end whether or not the caller waits for the answer.
async fn command<R, F>(
    shared: &Shared,
    reference: String,
    body: &[u8],
    run: impl FnOnce(Arc<Agents>, String, R) -> F,
) -> Response
where
    R: DeserializeOwned + EdgeCheck,
    F: Future<Output = Result<AgentCommandResponse, AgentError>> + Send + 'static,
{
    let answered = async {
        let req = edge::<R>(body).map_err(|Refused(why)| AgentError::Invalid(why))?;
        let id = resolved(shared, reference).await?;
        agents_of(shared)?
            .completing(move |agents| run(agents, id, req))
            .await
    };
    match answered.await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => refusal(&err),
    }
}

/// `POST /v1/agents/:id/close`, over either listener: the agent with its linked shells.
pub(crate) async fn close(
    State(shared): State<Shared>,
    Path(reference): Path<String>,
    body: Bytes,
) -> Response {
    let shells = shared.shells.clone();
    command(
        &shared,
        reference,
        &body,
        move |agents, id, req: CloseAgentRequest| async move {
            match shells {
                Some(shells) => shells.close_agent(&id, &req, agents.close(&id, &req)).await,
                None => agents.close(&id, &req).await,
            }
        },
    )
    .await
}

/// `POST /v1/agents/:id/respawn`, over either listener: the exited agent started again on its
/// session, once its hooks have let go of the process it replaces.
pub(crate) async fn respawn(
    State(shared): State<Shared>,
    Path(reference): Path<String>,
    body: Bytes,
) -> Response {
    command(
        &shared,
        reference,
        &body,
        |agents, id, req: RespawnAgentRequest| async move {
            agents.respawn(&id, &req, |_agent| Box::pin(async {})).await
        },
    )
    .await
}

/// `POST /v1/agents/:id/signal`, over either listener.
pub(crate) async fn signal(
    State(shared): State<Shared>,
    Path(reference): Path<String>,
    body: Bytes,
) -> Response {
    command(
        &shared,
        reference,
        &body,
        |agents, id, req: SignalAgentRequest| async move { agents.signal(&id, &req).await },
    )
    .await
}

/// `POST /v1/agents/:id/rename`: the human renames any agent over either listener, an agent only
/// itself over the socket. The path names the agent by its id or its live name, resolved before
/// the key is replayed.
pub(crate) async fn rename(
    State(shared): State<Shared>,
    Path(reference): Path<String>,
    caller: Option<axum::Extension<Caller>>,
    body: Bytes,
) -> Response {
    let renamed = async {
        let req = rename_request(&body).map_err(Renaming::Invalid)?;
        let caller = caller_of(caller).map(|agent| agent.as_str().to_owned());
        shared
            .store
            .run(move |store| {
                let agent = store
                    .reads()
                    .resolve_agent(&reference)
                    .map_err(|err| Renaming::Refused(err.into()))?
                    .and_then(|agent| AgentId::parse(&agent))
                    .ok_or_else(|| Renaming::Unnamed(reference.clone()))?;
                store
                    .rename_agent(&Rename {
                        key: req.idempotency_key,
                        caller,
                        agent,
                        name: req.name.as_str().to_owned(),
                    })
                    .map_err(Renaming::Refused)
            })
            .await
            .map_err(|err| Renaming::Closed(err.to_string()))?
    };
    renaming(renamed.await)
}

/// The answer to a rename, or its failure as the protocol's error.
fn renaming(renamed: Result<AgentCommandResponse, Renaming>) -> Response {
    match renamed {
        Ok(answer) => axum::Json(answer).into_response(),
        Err(Renaming::Invalid(message)) => {
            fail(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest, &message)
        }
        Err(Renaming::Unnamed(reference)) => {
            let message = if AgentId::parse(&reference).is_some() {
                format!("no agent {reference}")
            } else {
                format!("no agent {reference} by that name")
            };
            fail(StatusCode::NOT_FOUND, ErrorCode::NotFound, &message)
        }
        Err(Renaming::Refused(err @ RenameError::Forbidden)) => fail(
            StatusCode::FORBIDDEN,
            ErrorCode::Forbidden,
            &err.to_string(),
        ),
        Err(Renaming::Refused(err @ RenameError::Unknown(_))) => {
            fail(StatusCode::NOT_FOUND, ErrorCode::NotFound, &err.to_string())
        }
        Err(Renaming::Refused(err @ (RenameError::Ended { .. } | RenameError::NameTaken(_)))) => {
            fail(StatusCode::CONFLICT, ErrorCode::Conflict, &err.to_string())
        }
        Err(Renaming::Refused(RenameError::Once(OnceError::Conflict(key)))) => fail(
            StatusCode::CONFLICT,
            ErrorCode::Conflict,
            &format!("idempotency key {key} was first used for a different request"),
        ),
        Err(Renaming::Refused(err)) => internal(&err),
        Err(Renaming::Closed(err)) => internal(&err),
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
            AgentError::Unknown("x".to_owned()),
            AgentError::Conflict("x".to_owned()),
            AgentError::Stale {
                id: "x".to_owned(),
                generation: None,
            },
            AgentError::ServerUnconfirmed("x".to_owned()),
            AgentError::NotResumable("x".to_owned()),
            AgentError::SessionTaken("x".to_owned()),
            AgentError::NeedsRestart("x".to_owned()),
            AgentError::Shells(crate::shells::ShellError::Busy {
                message: "vim is running in agent x's shells".to_owned(),
                busy: Vec::new(),
            }),
            AgentError::Shells(crate::shells::ShellError::Unavailable("x".to_owned())),
            AgentError::Shells(crate::shells::ShellError::Conflict("x".to_owned())),
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
                (404, code("not_found")),
                (409, code("conflict")),
                (409, code("stale_generation")),
                (409, code("server_unconfirmed")),
                (409, code("not_resumable")),
                (409, code("not_resumable")),
                (409, code("needs_restart")),
                (409, code("busy")),
                (503, code("unavailable")),
                (409, code("conflict")),
            ]
        );
    }
}
