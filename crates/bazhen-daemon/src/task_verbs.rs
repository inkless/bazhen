//! The task verbs' routes (`http/app.ts`'s `taskRoute`s): each body held to the protocol at the
//! edge, then the verb run once per key in the store, which checks the caller may.

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_core::task::Refusal;
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::edge;
use bazhen_protocol::ids::TaskId;
use bazhen_protocol::tasks::AddTaskNoteRequest;
use bazhen_store::{NewNote, OnceError, TaskVerbError};

use crate::callers::{Caller, caller_of};
use crate::routes::{Shared, fail, internal};

/// What a verb answers when the store did nothing: the status the TypeScript daemon gives each.
fn refused(err: &TaskVerbError) -> Response {
    let (status, code) = match err {
        TaskVerbError::NoTask(_) | TaskVerbError::NoCaller(_) => {
            (StatusCode::NOT_FOUND, ErrorCode::NotFound)
        }
        TaskVerbError::Refused(refused) => match refused.refusal {
            Refusal::Forbidden => (StatusCode::FORBIDDEN, ErrorCode::Forbidden),
            Refusal::Conflict => (StatusCode::CONFLICT, ErrorCode::Conflict),
        },
        TaskVerbError::Once(OnceError::Conflict(key)) => {
            return fail(
                StatusCode::CONFLICT,
                ErrorCode::Conflict,
                &format!("idempotency key {key} was first used for a different request"),
            );
        }
        TaskVerbError::Once(_)
        | TaskVerbError::Append(_)
        | TaskVerbError::Read(_)
        | TaskVerbError::Json(_)
        | TaskVerbError::Sqlite(_) => return internal(err),
    };
    fail(status, code, &err.to_string())
}

fn no_task(id: &str) -> Response {
    fail(
        StatusCode::NOT_FOUND,
        ErrorCode::NotFound,
        &format!("no task {id}"),
    )
}

/// `POST /v1/tasks/:id/notes`: a note on the task from the human, its owner or an agent on it.
pub(crate) async fn note(
    State(shared): State<Shared>,
    caller: Option<Extension<Caller>>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let req = match edge::<AddTaskNoteRequest>(&body) {
        Ok(req) => req,
        Err(refused) => {
            return fail(
                StatusCode::BAD_REQUEST,
                ErrorCode::InvalidRequest,
                &refused.0,
            );
        }
    };
    let Some(task) = TaskId::parse(&id) else {
        return no_task(&id);
    };
    let note = NewNote {
        caller: caller_of(caller),
        task,
        key: req.idempotency_key,
        text: req.text,
        handoff: req.handoff == Some(true),
    };
    match shared.store.run(move |store| store.note_task(&note)).await {
        Ok(Ok(noted)) => axum::Json(noted).into_response(),
        Ok(Err(err)) => refused(&err),
        Err(err) => internal(&err),
    }
}
