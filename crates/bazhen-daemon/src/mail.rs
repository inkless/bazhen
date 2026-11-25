//! `POST /v1/agents/:id/messages` (`Tasks.send` and `Mailbox.send`): mail for an agent, by how
//! its harness takes it. Mail a harness takes from its hooks is queued for them. Mail a harness
//! takes by push is handed to it (`codex/mail.ts`'s `deliver`). A harness that takes none refuses
//! the send, as does one that takes none for the agent now.

use std::cell::Cell;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_harness::{AgentRef, Delivery, Harness, Outgoing, PushPort, Pushed, SessionRef};
use bazhen_protocol::agents::HarnessId;
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::edge;
use bazhen_protocol::ids::{AgentId, MessageId};
use bazhen_protocol::mail::{MailboxState, SendMessageRequest, SendMessageResponse};
use bazhen_protocol::mail_events::{MailAccepted, MailUndeliverable, UndeliverableReason};
use bazhen_store::{AppendError, MailChange, OnceError, Store, Writer as StoreWriter};
use serde::Serialize;

use crate::agents::Agents;
use crate::callers::{Caller, caller_of};
use crate::routes::{Shared, fail, internal};

/// A message's limit in the mailbox, once composed, in UTF-16 code units as `body.length` counts
/// them (`MAIL_LIMIT`).
pub(crate) const MAIL_LIMIT: usize = 20_000;

/// The agent states that take no more mail: one closing or closed gives its mail up, and one that
/// failed never started, with nothing to give it up (`GONE`).
const GONE: [&str; 3] = ["closing", "closed", "failed"];

/// The caller states from which an agent may no longer send (`CLOSED_CALLER`).
const CLOSED_CALLER: [&str; 4] = ["closing", "closed", "failed", "lost"];

/// How many times a message is pushed before it is given up as undeliverable.
const PUSH_ATTEMPTS: u32 = 3;

/// The wait after a push's first failure, doubled after each one after it.
const PUSH_RETRY: Duration = Duration::from_secs(1);

/// The port a harness that takes mail by push is handed it through.
#[derive(Clone)]
pub(crate) struct PushTo(pub(crate) Arc<dyn PushPort>);

impl std::fmt::Debug for PushTo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PushTo")
    }
}

/// Why a send queued nothing.
#[derive(Debug)]
pub(crate) enum Sending {
    Invalid(String),
    /// The path names no agent: by its id, none the store knows; by its name, none live.
    Unnamed(String),
    /// No agent of that description, as `UnknownAgent` words it.
    NoAgent(String),
    Gone {
        agent: String,
        state: String,
    },
    ToSelf,
    /// The composed message, at this many UTF-16 code units, is past `MAIL_LIMIT`.
    TooLong(usize),
    Once(OnceError),
    Unavailable,
    Internal(String),
}

impl From<OnceError> for Sending {
    fn from(err: OnceError) -> Self {
        Self::Once(err)
    }
}

impl From<rusqlite::Error> for Sending {
    fn from(err: rusqlite::Error) -> Self {
        Self::Internal(err.to_string())
    }
}

impl From<AppendError> for Sending {
    fn from(err: AppendError) -> Self {
        Self::Internal(err.to_string())
    }
}

/// The request a send's key is kept for, as `Mailbox.send` keeps it: `from` only for an agent's
/// own words.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeptSend<'a> {
    agent_id: &'a str,
    body: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<&'a str>,
}

/// The request an agent's send is kept for, as `Tasks.send` keeps it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeptPeerSend<'a> {
    caller: &'a str,
    agent_id: &'a str,
    body: &'a str,
}

/// A send's answer, and how the message it queued is to be delivered: none for a repeat of a
/// send, which gets its first answer and hands nothing over again.
struct Sent {
    response: SendMessageResponse,
    queued: Option<Delivery>,
}

/// `POST /v1/agents/:id/messages`: the human sends as Bazhen, an agent as itself to another. The
/// path names the agent by its id or its live name, resolved before the key is replayed.
pub(crate) async fn send(
    State(shared): State<Shared>,
    Path(reference): Path<String>,
    caller: Option<axum::Extension<Caller>>,
    body: Bytes,
) -> Response {
    let sent = async {
        let req =
            edge::<SendMessageRequest>(&body).map_err(|refused| Sending::Invalid(refused.0))?;
        let agents = shared.agents.clone().ok_or(Sending::Unavailable)?;
        let caller = caller_of(caller);
        let run = Arc::clone(&agents);
        let (agent, sent) = shared
            .store
            .run(move |store| {
                let agent = store
                    .reads()
                    .resolve_agent(&reference)?
                    .and_then(|agent| AgentId::parse(&agent))
                    .ok_or_else(|| Sending::Unnamed(reference.clone()))?;
                let sent = sent(store, &run, caller.as_ref(), &agent, &req)?;
                Ok::<_, Sending>((agent, sent))
            })
            .await
            .map_err(|err| Sending::Internal(err.to_string()))??;
        let message = sent.response.message_id.clone();
        deliver(&shared, &agents, sent.queued, message, agent).await;
        Ok(sent.response)
    };
    match sent.await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => refusal(err),
    }
}

/// Hands a message just queued over as `queued` says: pushed, or offered to the agent's waiter.
/// None, for a repeat of a request, hands nothing over again.
pub(crate) async fn deliver(
    shared: &Shared,
    agents: &Arc<Agents>,
    queued: Option<Delivery>,
    message: MessageId,
    agent: AgentId,
) {
    match queued {
        Some(Delivery::Push) => pushing(shared, agents, message, agent),
        Some(Delivery::Pull) => {
            // Queued, the message waits for the next waiter or tool call when this fails.
            if let Err(err) = shared.hooks.mailbox.offer(shared, &agent).await {
                tracing::warn!("bazhen: couldn't offer mail to {agent}: {err}");
            }
        }
        Some(Delivery::None) | None => {}
    }
}

/// The send, as the human's or as the agent `caller`'s to another.
fn sent(
    store: &mut Store,
    agents: &Agents,
    caller: Option<&AgentId>,
    agent: &AgentId,
    req: &SendMessageRequest,
) -> Result<Sent, Sending> {
    let fresh = Cell::new(None);
    let response = match caller {
        None => {
            let kept = kept(agent, &req.body, None)?;
            store.once(&req.idempotency_key, &kept, |w| {
                queue(w, agents, agent, &req.body, None, &fresh)
            })?
        }
        Some(caller) => {
            let peer_kept = serde_json::to_string(&KeptPeerSend {
                caller: caller.as_str(),
                agent_id: agent.as_str(),
                body: &req.body,
            })
            .map_err(OnceError::from)?;
            store.once(&req.idempotency_key, &peer_kept, |w| {
                let reads = w.reads();
                let open = reads
                    .agent_state(caller.as_str())?
                    .is_some_and(|state| !CLOSED_CALLER.contains(&state.as_str()));
                if !open {
                    return Err(Sending::NoAgent(format!("no agent {caller} that is open")));
                }
                if caller == agent {
                    return Err(Sending::ToSelf);
                }
                let sender = reads
                    .sender(caller.as_str())?
                    .ok_or_else(|| Sending::NoAgent(format!("no agent {caller}")))?;
                let text = peer_mail(caller, &sender, &req.body);
                let length = text.encode_utf16().count();
                if length > MAIL_LIMIT {
                    return Err(Sending::TooLong(length));
                }
                let key = format!("{}:sent", req.idempotency_key);
                let kept = kept(agent, &text, Some(caller))?;
                if let Some(prior) = w.replay(&key, &kept)? {
                    return Ok(prior);
                }
                let response = queue(w, agents, agent, &text, Some(caller), &fresh)?;
                w.answered(&key, &kept, &response)?;
                Ok(response)
            })?
        }
    };
    Ok(Sent {
        response,
        queued: fresh.get(),
    })
}

fn kept(agent: &AgentId, body: &str, from: Option<&AgentId>) -> Result<String, OnceError> {
    Ok(serde_json::to_string(&KeptSend {
        agent_id: agent.as_str(),
        body,
        from: from.map(AgentId::as_str),
    })?)
}

/// Queues `body` for `agent`, if its harness takes mail for it now, noting in `fresh` how it is
/// to be delivered.
pub(crate) fn queue(
    w: &StoreWriter<'_>,
    agents: &Agents,
    agent: &AgentId,
    body: &str,
    from: Option<&AgentId>,
    fresh: &Cell<Option<Delivery>>,
) -> Result<SendMessageResponse, Sending> {
    let takes_none = || Sending::NoAgent(format!("no agent {agent} that takes mail"));
    let binding = w
        .reads()
        .agent_binding(agent.as_str())?
        .ok_or_else(takes_none)?;
    let harness = harness_of(agents, &binding.harness).ok_or_else(takes_none)?;
    let delivery = harness.capabilities().delivery;
    if delivery == Delivery::None {
        return Err(takes_none());
    }
    if GONE.contains(&binding.state.as_str()) {
        return Err(Sending::Gone {
            agent: agent.as_str().to_owned(),
            state: binding.state,
        });
    }
    let session = binding.session.as_ref().map(|s| SessionRef {
        kind: s.kind,
        id: s.id.clone(),
    });
    harness
        .accepts_mail(&AgentRef {
            session: session.as_ref(),
        })
        .map_err(|refusal| Sending::NoAgent(format!("no agent {agent} {}", refusal.reason)))?;
    let (message_id, event) = w.queue_mail(agent, body, from)?;
    fresh.set(Some(delivery));
    Ok(SendMessageResponse {
        message_id,
        event_ids: vec![event],
    })
}

pub(crate) fn harness_of<'a>(agents: &'a Agents, harness: &str) -> Option<&'a dyn Harness> {
    agents.harnesses().get(HarnessId::parse(harness)?)
}

/// An agent's own message to another, after a line naming the sender, so the reader knows which
/// peer wrote it, and saying how to reply without asking for a reply (`peerMail`).
fn peer_mail(from: &AgentId, sender: &bazhen_store::Sender, text: &str) -> String {
    let named = if sender.name.is_empty() {
        format!("agent {from} (")
    } else {
        format!("{} ({from}, ", sender.name)
    };
    format!(
        "From {named}{}, {}). If it needs an answer: bazhen agents send {from} \"<answer>\"\n\n{text}",
        sender.harness, sender.cwd
    )
}

/// Pushes the message, on the agents' tracker, through the daemon's push port; with none, it
/// stays queued.
fn pushing(shared: &Shared, agents: &Arc<Agents>, message: MessageId, agent: AgentId) {
    let Some(PushTo(port)) = shared.push.clone() else {
        return;
    };
    let (store, run) = (shared.store.clone(), Arc::clone(agents));
    agents.spawn(async move {
        if let Err(err) = push(&store, &run, port.as_ref(), &message, &agent).await {
            tracing::warn!("bazhen: couldn't push {message} to {agent}: {err}");
        }
    });
}

/// What a push reads before each attempt: the message's body while it is still queued for
/// `agent`, and the agent's harness and session, unless it is still starting, as its TUI may be
/// held at a dialog and the harness's server would start a turn anyway.
struct Pushable {
    body: String,
    harness: String,
    session: Option<SessionRef>,
}

/// Hands a queued message to its agent's harness, trying again with backoff, and gives it up as
/// undeliverable after the last attempt. One no longer queued is left alone, as is one for an
/// agent still starting.
async fn push(
    store: &crate::writer::Writer,
    agents: &Agents,
    port: &dyn PushPort,
    message: &MessageId,
    agent: &AgentId,
) -> Result<(), String> {
    let mut wait = PUSH_RETRY;
    for attempt in 1..=PUSH_ATTEMPTS {
        let Some(now) = pushable(store, message, agent).await? else {
            return Ok(());
        };
        let Some(harness) = harness_of(agents, &now.harness) else {
            return Ok(());
        };
        let pushed = harness
            .push(
                &Outgoing {
                    message_id: message.as_str(),
                    body: &now.body,
                    session: now.session.as_ref(),
                },
                port,
            )
            .await;
        // A turn carrying it may have taken it before the push returned.
        if pushable(store, message, agent).await?.is_none() {
            return Ok(());
        }
        let change = match pushed {
            Pushed::Accepted { offline } => MailChange::Accepted(MailAccepted { offline }),
            Pushed::NotNow => return Ok(()),
            Pushed::Failed { detail } if attempt < PUSH_ATTEMPTS => {
                tracing::warn!("bazhen: pushing {message} to {agent} failed: {detail}");
                tokio::time::sleep(wait).await;
                wait *= 2;
                continue;
            }
            Pushed::Failed { detail } => {
                tracing::warn!("bazhen: pushing {message} to {agent} failed: {detail}");
                MailChange::Undeliverable(MailUndeliverable {
                    reason: UndeliverableReason::GaveUp,
                })
            }
        };
        let message = message.clone();
        store
            .run(move |store| store.write(|w| w.mail_step(&message, change)))
            .await
            .map_err(|err| err.to_string())?
            .map_err(|err| err.to_string())?;
        return Ok(());
    }
    Ok(())
}

async fn pushable(
    store: &crate::writer::Writer,
    message: &MessageId,
    agent: &AgentId,
) -> Result<Option<Pushable>, String> {
    let (message, agent) = (message.clone(), agent.clone());
    store
        .run(move |store| {
            let reads = store.reads();
            let queued = reads
                .message(message.as_str())?
                .filter(|m| m.agent == agent.as_str() && m.state == MailboxState::Queued);
            let Some(queued) = queued else {
                return Ok(None);
            };
            let binding = reads.agent_binding(agent.as_str())?;
            Ok(binding.filter(|b| b.state != "starting").map(|b| Pushable {
                body: queued.body,
                harness: b.harness,
                session: b.session.map(|s| SessionRef {
                    kind: s.kind,
                    id: s.id,
                }),
            }))
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err: rusqlite::Error| err.to_string())
}

/// The protocol's error for a send that queued nothing, with `Tasks.send`'s and
/// `Mailbox.send`'s words.
pub(crate) fn refusal(err: Sending) -> Response {
    match err {
        Sending::Invalid(message) => {
            fail(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest, &message)
        }
        Sending::Unnamed(reference) => {
            let message = if AgentId::parse(&reference).is_some() {
                format!("no agent {reference}")
            } else {
                format!("no agent {reference} by that name")
            };
            fail(StatusCode::NOT_FOUND, ErrorCode::NotFound, &message)
        }
        Sending::NoAgent(message) => fail(StatusCode::NOT_FOUND, ErrorCode::NotFound, &message),
        Sending::Gone { agent, state } => fail(
            StatusCode::CONFLICT,
            ErrorCode::Conflict,
            &format!("agent {agent} is {state} and takes no mail"),
        ),
        Sending::ToSelf => fail(
            StatusCode::FORBIDDEN,
            ErrorCode::Forbidden,
            "you can't send to yourself",
        ),
        Sending::TooLong(length) => fail(
            StatusCode::BAD_REQUEST,
            ErrorCode::InvalidRequest,
            &format!(
                "the message to the agent would be {length} characters, over the {MAIL_LIMIT} a \
                 message may be: shorten what you wrote"
            ),
        ),
        Sending::Once(OnceError::Conflict(key)) => fail(
            StatusCode::CONFLICT,
            ErrorCode::Conflict,
            &format!("idempotency key {key} was first used for a different request"),
        ),
        Sending::Once(err) => internal(&err),
        Sending::Unavailable => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            "this daemon runs no terminals",
        ),
        Sending::Internal(err) => internal(&err),
    }
}

#[cfg(test)]
pub(crate) mod tests;
