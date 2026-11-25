//! The items for the human (`attention/inbox.ts`): what the human can do about each open one, and
//! the routes that do it. A reply reaches the agent as mail; a resend sends an undelivered message
//! again; a dismissal closes the item. Each closes its item in the transaction that queues the mail,
//! so no crash leaves a reply sent and its item open, or the item closed with nothing sent.

use std::cell::Cell;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_protocol::agents::AgentState;
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::edge;
use bazhen_protocol::ids::AgentId;
use bazhen_protocol::mail::{
    AnswerAttentionRequest, AnswerAttentionResponse, AttentionAction, AttentionKind,
    DismissAttentionRequest, DismissAttentionResponse, MailboxState, ReplyAttentionRequest,
    ReplyAttentionResponse, ResendAttentionRequest, ResendAttentionResponse,
};
use bazhen_protocol::mail_events::{ApprovalDecision, AttentionClosedReason};
use bazhen_store::{
    AppendError, AttentionItem, AttentionView, OnceError, OpenAttention, Writer as StoreWriter,
};

use crate::agents::Agents;
use crate::mail::{Sending, deliver, queue, refusal};
use crate::routes::{Shared, fail, internal};

/// Agents gone for good: mail can't reach them, so a reply can't either.
const GONE: [&str; 3] = ["closing", "closed", "failed"];

/// What `/v1/state` asks of the daemon about each open item.
pub(crate) struct Inbox;

impl AttentionView for Inbox {
    fn attention_actions(&self, item: &OpenAttention<'_>) -> Vec<AttentionAction> {
        actions(item.kind, item.agent_state)
    }
}

/// What the human can do about an open item of `kind`, whose agent is in `state` (`Inbox.actions`).
/// An approval or a question is settled only through the harness request it stands behind, which
/// no route here answers yet, or in the agent's terminal.
fn actions(kind: &AttentionKind, state: Option<&str>) -> Vec<AttentionAction> {
    use AttentionAction::{Dismiss, Reply, Resend};
    match kind {
        AttentionKind::Approval | AttentionKind::Question => Vec::new(),
        // Only its terminal answers it; mail would wait behind the very dialog it is about.
        AttentionKind::StuckStarting | AttentionKind::Unknown(_) => vec![Dismiss],
        _ if state.is_none_or(|state| GONE.contains(&state)) => vec![Dismiss],
        AttentionKind::Undeliverable => vec![Reply, Resend, Dismiss],
        _ => vec![Reply, Dismiss],
    }
}

/// Why a verb did nothing.
#[derive(Debug)]
enum Refusal {
    Invalid(String),
    /// No item by that id is open.
    Closed(String),
    /// The item doesn't offer the action now.
    Refused {
        id: String,
        action: AttentionAction,
    },
    Mail(Sending),
    Unavailable,
    Internal(String),
}

impl From<Sending> for Refusal {
    fn from(err: Sending) -> Self {
        Self::Mail(err)
    }
}

impl From<OnceError> for Refusal {
    fn from(err: OnceError) -> Self {
        Self::Mail(Sending::from(err))
    }
}

impl From<rusqlite::Error> for Refusal {
    fn from(err: rusqlite::Error) -> Self {
        Self::Internal(err.to_string())
    }
}

impl From<AppendError> for Refusal {
    fn from(err: AppendError) -> Self {
        Self::Internal(err.to_string())
    }
}

/// The open item `id`, if it offers `action` now.
fn offering(
    w: &StoreWriter<'_>,
    id: &str,
    action: AttentionAction,
) -> Result<AttentionItem, Refusal> {
    let item = w
        .reads()
        .attention_item(id)?
        .filter(|item| item.open)
        .ok_or_else(|| Refusal::Closed(id.to_owned()))?;
    let state = item.agent_state.map(AgentState::as_str);
    if !actions(&item.kind, state).contains(&action) {
        return Err(Refusal::Refused {
            id: id.to_owned(),
            action,
        });
    }
    Ok(item)
}

/// The request a verb's key is kept for, as the inbox keeps it.
fn kept(id: &str, verb: &str, value: &serde_json::Value) -> String {
    serde_json::json!({ "attention": id, verb: value }).to_string()
}

/// `POST /v1/attention/:id/answer`: the human's decision on an approval its harness waits on.
pub(crate) async fn answer(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let answered = async {
        let req =
            edge::<AnswerAttentionRequest>(&body).map_err(|refused| Refusal::Invalid(refused.0))?;
        let action = match req.decision {
            ApprovalDecision::Allow => AttentionAction::Allow,
            ApprovalDecision::Deny => AttentionAction::Deny,
        };
        let kept = kept(
            &id,
            "decision",
            &serde_json::to_value(req.decision).unwrap_or_default(),
        );
        shared
            .store
            .run(move |store| {
                store.once(&req.idempotency_key, &kept, |w| {
                    offering(w, &id, action)?;
                    // Only an approval offers a decision, once a harness request stands behind it.
                    Err::<AnswerAttentionResponse, _>(Refusal::Refused {
                        id: id.clone(),
                        action,
                    })
                })
            })
            .await
            .map_err(|err| Refusal::Internal(err.to_string()))?
    };
    respond(answered.await)
}

/// `POST /v1/attention/:id/reply`: mail to the item's agent, which closes it.
pub(crate) async fn reply(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let replied = async {
        let req =
            edge::<ReplyAttentionRequest>(&body).map_err(|refused| Refusal::Invalid(refused.0))?;
        let agents = shared.agents.clone().ok_or(Refusal::Unavailable)?;
        let run = Arc::clone(&agents);
        let (response, queued) = shared
            .store
            .run(move |store| {
                let queued = Queued::default();
                let kept = kept(&id, "reply", &req.body.clone().into());
                let response = store.once(&req.idempotency_key, &kept, |w| {
                    let item = offering(w, &id, AttentionAction::Reply)?;
                    let (message_id, event_ids) = mail(
                        w,
                        &run,
                        &item,
                        &req.body,
                        AttentionClosedReason::Replied,
                        &queued,
                    )?;
                    Ok::<_, Refusal>(ReplyAttentionResponse {
                        message_id: Some(message_id),
                        event_ids,
                    })
                })?;
                Ok::<_, Refusal>((response, queued))
            })
            .await
            .map_err(|err| Refusal::Internal(err.to_string()))??;
        queued
            .deliver(&shared, &agents, response.message_id.clone())
            .await;
        Ok(response)
    };
    respond(replied.await)
}

/// `POST /v1/attention/:id/resend`: the undelivered message's text again, as a new message to the
/// same agent, which closes the item.
pub(crate) async fn resend(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let resent = async {
        let req =
            edge::<ResendAttentionRequest>(&body).map_err(|refused| Refusal::Invalid(refused.0))?;
        let agents = shared.agents.clone().ok_or(Refusal::Unavailable)?;
        let run = Arc::clone(&agents);
        let (response, queued) = shared
            .store
            .run(move |store| {
                let queued = Queued::default();
                let kept = kept(&id, "resend", &true.into());
                let response = store.once(&req.idempotency_key, &kept, |w| {
                    let item = offering(w, &id, AttentionAction::Resend)?;
                    let refused = || Refusal::Refused {
                        id: id.clone(),
                        action: AttentionAction::Resend,
                    };
                    let message = item.message_id.as_ref().ok_or_else(refused)?;
                    let text = w
                        .reads()
                        .message(message.as_str())?
                        .filter(|m| m.state == MailboxState::Undeliverable)
                        .ok_or_else(refused)?
                        .body;
                    let (message_id, event_ids) = mail(
                        w,
                        &run,
                        &item,
                        &text,
                        AttentionClosedReason::Resent,
                        &queued,
                    )?;
                    Ok::<_, Refusal>(ResendAttentionResponse {
                        message_id,
                        event_ids,
                    })
                })?;
                Ok::<_, Refusal>((response, queued))
            })
            .await
            .map_err(|err| Refusal::Internal(err.to_string()))??;
        queued
            .deliver(&shared, &agents, Some(response.message_id.clone()))
            .await;
        Ok(response)
    };
    respond(resent.await)
}

/// `POST /v1/attention/:id/dismiss`: closes the item, with nothing sent.
pub(crate) async fn dismiss(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let dismissed = async {
        let req = edge::<DismissAttentionRequest>(&body)
            .map_err(|refused| Refusal::Invalid(refused.0))?;
        shared
            .store
            .run(move |store| {
                let kept = kept(&id, "dismiss", &true.into());
                store.once(&req.idempotency_key, &kept, |w| {
                    let item = offering(w, &id, AttentionAction::Dismiss)?;
                    let closed =
                        w.close_attention(&item.id, AttentionClosedReason::Dismissed, "user")?;
                    Ok::<_, Refusal>(DismissAttentionResponse {
                        event_ids: vec![closed],
                    })
                })
            })
            .await
            .map_err(|err| Refusal::Internal(err.to_string()))?
    };
    respond(dismissed.await)
}

/// How a message a verb queued is to be delivered once its transaction commits; nothing for a
/// repeat of a request, which queued nothing.
#[derive(Default)]
struct Queued {
    delivery: Cell<Option<bazhen_harness::Delivery>>,
    agent: Cell<Option<AgentId>>,
}

impl Queued {
    async fn deliver(
        self,
        shared: &Shared,
        agents: &Arc<Agents>,
        message: Option<bazhen_protocol::ids::MessageId>,
    ) {
        if let (Some(agent), Some(message)) = (self.agent.into_inner(), message) {
            deliver(shared, agents, self.delivery.get(), message, agent).await;
        }
    }
}

/// Queues `body` for the item's agent as the human's mail and closes the item for `reason`,
/// answering the message's id and the events'.
fn mail(
    w: &StoreWriter<'_>,
    agents: &Agents,
    item: &AttentionItem,
    body: &str,
    reason: AttentionClosedReason,
    queued: &Queued,
) -> Result<(bazhen_protocol::ids::MessageId, Vec<u64>), Refusal> {
    let sent = queue(w, agents, &item.agent, body, None, &queued.delivery)?;
    queued.agent.set(Some(item.agent.clone()));
    let closed = w.close_attention(&item.id, reason, "user")?;
    let mut events = sent.event_ids;
    events.push(closed);
    Ok((sent.message_id, events))
}

/// Closes as stale the approvals and questions the daemon before this one left open: the harness
/// requests they stood behind went with its sockets.
pub(crate) async fn close_abandoned(store: &crate::writer::Writer) {
    let closed = store
        .run(|store| {
            store.write(|w| {
                let closed = w.close_abandoned()?;
                Ok::<_, AppendError>(closed)
            })
        })
        .await
        .map_err(|err| err.to_string())
        .and_then(|closed| closed.map_err(|err| err.to_string()));
    match closed {
        Ok(0) => {}
        Ok(closed) => tracing::info!("bazhen: closed {closed} items the last daemon left open"),
        Err(err) => tracing::warn!("bazhen: couldn't close the items the last daemon left: {err}"),
    }
}

fn respond<T: serde::Serialize>(answer: Result<T, Refusal>) -> Response {
    match answer {
        Ok(response) => axum::Json(response).into_response(),
        Err(Refusal::Invalid(message)) => {
            fail(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest, &message)
        }
        Err(Refusal::Closed(id)) => fail(
            StatusCode::CONFLICT,
            ErrorCode::Conflict,
            &format!("attention item {id} is not open"),
        ),
        Err(Refusal::Refused { id, action }) => {
            let action = serde_json::to_value(action).unwrap_or_default();
            let action = action.as_str().unwrap_or_default();
            fail(
                StatusCode::CONFLICT,
                ErrorCode::Conflict,
                &format!("attention item {id} can't be answered with {action}"),
            )
        }
        Err(Refusal::Mail(err)) => refusal(err),
        Err(Refusal::Unavailable) => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            "this daemon runs no terminals",
        ),
        Err(Refusal::Internal(err)) => internal(&err),
    }
}

#[cfg(test)]
mod tests;
