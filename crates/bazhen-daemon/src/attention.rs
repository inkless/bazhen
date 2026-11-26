//! The items for the human (`attention/inbox.ts`): what the human can do about each open one, and
//! the routes that do it. A reply reaches the agent as mail; a resend sends an undelivered message
//! again; a dismissal closes the item. Each closes its item in the transaction that queues the mail,
//! so no crash leaves a reply sent and its item open, or the item closed with nothing sent.
//!
//! An answer to an approval goes to the hook its harness holds, once the item is claimed and the
//! answer committed, in the one job on the store's writer that claims it: that job runs to its end
//! whether or not the route's caller stays, so an answer recorded is an answer sent.

use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_harness::{Answer, HarnessId, Harnesses, Pending, Resolution};
use bazhen_protocol::agents::AgentState;
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::edge;
use bazhen_protocol::ids::{AgentId, AttentionId};
use bazhen_protocol::mail::{
    AnswerAttentionRequest, AnswerAttentionResponse, AttentionAction, AttentionKind,
    DismissAttentionRequest, DismissAttentionResponse, MailboxState, ReplyAttentionRequest,
    ReplyAttentionResponse, ResendAttentionRequest, ResendAttentionResponse,
};
use bazhen_protocol::mail_events::{ApprovalDecision, AttentionClosedReason};
use bazhen_store::{
    AppendError, AttentionItem, AttentionView, OnceError, OpenAttention, Writer as StoreWriter,
};

use crate::callers::{Caller, caller_of};
use crate::hooks::approvals::{Approvals, Responder};
use crate::mail::{Queued, Sending, deliver, queue, refusal};
use crate::routes::{Shared, fail, internal};

/// Agents gone for good: mail can't reach them, so a reply can't either.
const GONE: [&str; 3] = ["closing", "closed", "failed"];

/// What `/v1/state` asks of the daemon about each open item, from the requests the hooks hold.
/// An approval read as held may be claimed by the time an answer comes, which is then refused.
pub(crate) struct Inbox(pub(crate) Arc<Approvals>);

impl AttentionView for Inbox {
    fn attention_actions(&self, item: &OpenAttention<'_>) -> Vec<AttentionAction> {
        actions(item.kind, item.agent_state, self.0.held(item.id))
    }
}

/// What the human can do about an open item of `kind`, whose agent is in `state` (`Inbox.actions`).
/// An approval or a question is settled only through the harness request it stands behind, or in
/// the agent's terminal: an approval whose request is `held` takes allow or deny, and a question
/// only the TUI.
fn actions(kind: &AttentionKind, state: Option<&str>, held: bool) -> Vec<AttentionAction> {
    use AttentionAction::{Allow, Deny, Dismiss, Reply, Resend};
    match kind {
        AttentionKind::Approval if held => vec![Allow, Deny],
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
    /// No item could be by that id.
    NotFound(String),
    /// The caller may not answer.
    Forbidden(String),
    /// The harness can't take the answer now: the request's server has gone.
    Gone,
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

/// The open item `id`, if it offers `action` now, with what the hooks hold in `approvals`.
fn offering(
    w: &StoreWriter<'_>,
    approvals: &Approvals,
    id: &str,
    action: AttentionAction,
) -> Result<AttentionItem, Refusal> {
    let item = w
        .reads()
        .attention_item(id)?
        .filter(|item| item.open)
        .ok_or_else(|| Refusal::Closed(id.to_owned()))?;
    let state = item.agent_state.map(AgentState::as_str);
    if !actions(&item.kind, state, approvals.held(&item.id)).contains(&action) {
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

/// The actor the answer of `caller`, as the guard read it on the socket or over HTTP, is recorded
/// by, where it may answer at all: the human may; an agent may not answer what it asks.
fn may_answer(caller: Option<&AgentId>) -> Result<&'static str, Refusal> {
    match caller {
        None => Ok("user"),
        Some(agent) => Err(Refusal::Forbidden(format!(
            "agent {agent} can't answer an approval"
        ))),
    }
}

/// `POST /v1/attention/:id/answer`: the human's decision on an approval its harness waits on.
/// The reply is built before the item is claimed, from the agent's harness, and sent once the
/// answer commits; a repeat of the request answers what the first did and sends nothing.
pub(crate) async fn answer(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    caller: Option<Extension<Caller>>,
    body: Bytes,
) -> Response {
    let caller = caller_of(caller);
    let answer = match edge::<AnswerAttentionRequest>(&body) {
        Ok(req) => answered(&shared, id, caller.as_ref(), req).await,
        Err(refused) => Err(Refusal::Invalid(refused.0)),
    };
    respond(answer)
}

async fn answered(
    shared: &Shared,
    id: String,
    caller: Option<&AgentId>,
    req: AnswerAttentionRequest,
) -> Result<AnswerAttentionResponse, Refusal> {
    let attention = AttentionId::parse(&id).ok_or_else(|| Refusal::NotFound(id.clone()))?;
    let actor = may_answer(caller)?;
    let action = match req.decision {
        ApprovalDecision::Allow => AttentionAction::Allow,
        ApprovalDecision::Deny => AttentionAction::Deny,
    };
    let approvals = Arc::clone(&shared.hooks.approvals);
    let reply = built(shared, &approvals, &attention, req.decision).await?;
    let kept = kept(
        &id,
        "decision",
        &serde_json::to_value(req.decision).unwrap_or_default(),
    );
    let decision = req.decision;
    shared
        .store
        .run(move |store| {
            let mut claimed = None;
            let outcome = store.once(&req.idempotency_key, &kept, |w| {
                offering(w, &approvals, &id, action)?;
                let refused = || Refusal::Refused {
                    id: id.clone(),
                    action,
                };
                // Only a request whose reply was built before the claim is answered.
                reply.as_ref().ok_or_else(refused)?;
                let entry = approvals.claim(&attention).ok_or_else(refused)?;
                let entry = claimed.insert(entry);
                if entry.responder.is_none() {
                    return Err(refused());
                }
                let event = w.answer_attention(&attention, decision, actor)?;
                Ok::<_, Refusal>(AnswerAttentionResponse {
                    event_ids: vec![event],
                })
            });
            match (claimed, &outcome) {
                (Some(entry), Ok(_)) => {
                    if let (Some(Responder::Hook(hook)), Some(reply)) = (entry.responder, reply) {
                        // Its client may have gone already, as the human answered in the TUI.
                        let _ = hook.send(reply);
                    }
                }
                (Some(entry), Err(_)) => approvals.put_back(attention, entry),
                (None, _) => {}
            }
            outcome
        })
        .await
        .map_err(|err| Refusal::Internal(err.to_string()))?
}

/// The reply the hook held for the item `id` gives for `decision`, from its agent's harness; none
/// when no hook holds it, as for an item answered, settled, or never held.
async fn built(
    shared: &Shared,
    approvals: &Approvals,
    id: &AttentionId,
    decision: ApprovalDecision,
) -> Result<Option<bazhen_protocol::mail::HookReply>, Refusal> {
    let Some(agent) = approvals.agent_of(id).filter(|_| approvals.held(id)) else {
        return Ok(None);
    };
    let agents = shared.agents.clone().ok_or(Refusal::Unavailable)?;
    let binding = shared
        .store
        .run(move |store| store.reads().agent_binding(agent.as_str()))
        .await
        .map_err(|err| Refusal::Internal(err.to_string()))??;
    let harness = binding
        .and_then(|binding| HarnessId::parse(&binding.harness))
        .and_then(|harness| agents.harnesses().get(harness));
    let Some(harness) = harness else {
        return Ok(None);
    };
    match harness.answer(&Pending::Approval, Resolution::Decision(decision)) {
        Answer::Hook(output) => Ok(Some(bazhen_protocol::mail::HookReply {
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            offered: Vec::new(),
        })),
        Answer::Unavailable => Err(Refusal::Gone),
        Answer::Rpc(_) => Err(Refusal::Internal(
            "the harness answered a held hook with a server's result".to_owned(),
        )),
    }
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
        let approvals = Arc::clone(&shared.hooks.approvals);
        let (response, queued) = shared
            .store
            .run(move |store| {
                let mut queued = Vec::new();
                let kept = kept(&id, "reply", &req.body.clone().into());
                let response = store.once(&req.idempotency_key, &kept, |w| {
                    let item = offering(w, &approvals, &id, AttentionAction::Reply)?;
                    let (message_id, event_ids) = mail(
                        w,
                        run.harnesses(),
                        &item,
                        &req.body,
                        AttentionClosedReason::Replied,
                        &mut queued,
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
        for queued in queued {
            deliver(&shared, queued).await;
        }
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
        let approvals = Arc::clone(&shared.hooks.approvals);
        let (response, queued) = shared
            .store
            .run(move |store| {
                let mut queued = Vec::new();
                let kept = kept(&id, "resend", &true.into());
                let response = store.once(&req.idempotency_key, &kept, |w| {
                    let item = offering(w, &approvals, &id, AttentionAction::Resend)?;
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
                        run.harnesses(),
                        &item,
                        &text,
                        AttentionClosedReason::Resent,
                        &mut queued,
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
        for queued in queued {
            deliver(&shared, queued).await;
        }
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
        let approvals = Arc::clone(&shared.hooks.approvals);
        shared
            .store
            .run(move |store| {
                let kept = kept(&id, "dismiss", &true.into());
                store.once(&req.idempotency_key, &kept, |w| {
                    let item = offering(w, &approvals, &id, AttentionAction::Dismiss)?;
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

/// Queues `body` for the item's agent as the human's mail and closes the item for `reason`,
/// answering the message's id and the events'.
fn mail(
    w: &StoreWriter<'_>,
    harnesses: &Harnesses,
    item: &AttentionItem,
    body: &str,
    reason: AttentionClosedReason,
    queued: &mut Vec<Queued>,
) -> Result<(bazhen_protocol::ids::MessageId, Vec<u64>), Refusal> {
    let sent = queue(w, harnesses, &item.agent, body, None, queued)?;
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
        Err(Refusal::NotFound(id)) => fail(
            StatusCode::NOT_FOUND,
            ErrorCode::NotFound,
            &format!("no attention item can be {id}"),
        ),
        Err(Refusal::Forbidden(message)) => {
            fail(StatusCode::FORBIDDEN, ErrorCode::Forbidden, &message)
        }
        Err(Refusal::Gone) => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            "the request's server has gone",
        ),
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
        Err(Refusal::Mail(err)) => refusal(&err),
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
