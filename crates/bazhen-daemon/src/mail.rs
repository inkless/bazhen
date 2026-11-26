//! `POST /v1/agents/:id/messages` (`Tasks.send` and `Mailbox.send`): mail for an agent, by how
//! its harness takes it. Mail a harness takes from its hooks is queued for them. Mail a harness
//! takes by push is handed to it (`codex/mail.ts`'s `deliver`). A harness that takes none refuses
//! the send, as does one that takes none for the agent now.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_harness::{
    AgentRef, Delivery, Harness, Harnesses, Outgoing, PushPort, Pushed, SessionRef,
};
use bazhen_protocol::agents::HarnessId;
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::edge;
use bazhen_protocol::ids::{AgentId, MessageId};
use bazhen_protocol::mail::{MailboxState, SendMessageRequest, SendMessageResponse};
use bazhen_protocol::mail_events::{MailAccepted, MailUndeliverable, UndeliverableReason};
use bazhen_store::{AppendError, MailChange, OnceError, Store, Writer as StoreWriter};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agents::Agents;
use crate::callers::{Caller, caller_of};
use crate::routes::{Shared, fail, internal};

/// A message's limit in the mailbox, once composed, in UTF-16 code units as `body.length` counts
/// them (`MAIL_LIMIT`).
pub(crate) const MAIL_LIMIT: usize = 20_000;

/// The agent states that take no more mail: one closing or closed gives its mail up, and one that
/// failed never started, with nothing to give it up (`GONE`).
pub(crate) const GONE: [&str; 3] = ["closing", "closed", "failed"];

/// The caller states from which an agent may no longer send (`CLOSED_CALLER`).
pub(crate) const CLOSED_CALLER: [&str; 4] = ["closing", "closed", "failed", "lost"];

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

/// What a refusal says, as the answer words it.
impl std::fmt::Display for Sending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) | Self::NoAgent(message) | Self::Internal(message) => {
                f.write_str(message)
            }
            Self::Unnamed(reference) if AgentId::parse(reference).is_some() => {
                write!(f, "no agent {reference}")
            }
            Self::Unnamed(reference) => write!(f, "no agent {reference} by that name"),
            Self::Gone { agent, state } => write!(f, "agent {agent} is {state} and takes no mail"),
            Self::ToSelf => f.write_str("you can't send to yourself"),
            Self::TooLong(length) => write!(
                f,
                "the message to the agent would be {length} characters, over the {MAIL_LIMIT} a \
                 message may be: shorten what you wrote"
            ),
            Self::Once(OnceError::Conflict(key)) => {
                write!(
                    f,
                    "idempotency key {key} was first used for a different request"
                )
            }
            Self::Once(err) => write!(f, "{err}"),
            Self::Unavailable => f.write_str("this daemon runs no terminals"),
        }
    }
}

impl From<bazhen_store::TaskReadError> for Sending {
    fn from(err: bazhen_store::TaskReadError) -> Self {
        Self::Internal(err.to_string())
    }
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

/// A message a write queued, and how it is to be delivered once the write commits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Queued {
    pub(crate) agent: AgentId,
    pub(crate) message: MessageId,
    pub(crate) delivery: Delivery,
}

/// Where a write that can't reach the daemon's routes hands what it queued, once it commits.
/// Unbounded, so a write at start, before anything drains it, neither waits nor loses mail.
pub(crate) type Handing = mpsc::UnboundedSender<Queued>;

/// A send's answer, and the message it queued: none for a repeat of a send, which gets its first
/// answer and hands nothing over again.
struct Sent {
    response: SendMessageResponse,
    queued: Vec<Queued>,
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
        let sent = shared
            .store
            .run(move |store| {
                let agent = store
                    .reads()
                    .resolve_agent(&reference)?
                    .and_then(|agent| AgentId::parse(&agent))
                    .ok_or_else(|| Sending::Unnamed(reference.clone()))?;
                sent(store, &run, caller.as_ref(), &agent, &req)
            })
            .await
            .map_err(|err| Sending::Internal(err.to_string()))??;
        for queued in sent.queued {
            deliver(&shared, &agents, queued).await;
        }
        Ok(sent.response)
    };
    match sent.await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => refusal(&err),
    }
}

/// Hands a message just queued over as `queued` says: pushed, or offered to the agent's waiter.
pub(crate) async fn deliver(shared: &Shared, agents: &Arc<Agents>, queued: Queued) {
    let Queued {
        agent,
        message,
        delivery,
    } = queued;
    match delivery {
        Delivery::Push => pushing(shared, agents, message, agent),
        Delivery::Pull => {
            // Queued, the message waits for the next waiter or tool call when this fails.
            if let Err(err) = shared.hooks.mailbox.offer(shared, &agent).await {
                tracing::warn!("bazhen: couldn't offer mail to {agent}: {err}");
            }
        }
        Delivery::None => {}
    }
}

/// Delivers each message handed over on the channel, in the order handed, until the daemon stops
/// or nothing is left to hand any. A stop still delivers what was handed before it: each was
/// committed, and is owed its push or offer.
pub(crate) async fn hand_over(
    shared: Shared,
    agents: Arc<Agents>,
    mut handed: mpsc::UnboundedReceiver<Queued>,
    stop: CancellationToken,
) {
    loop {
        let queued = tokio::select! {
            biased;
            () = stop.cancelled() => break,
            queued = handed.recv() => queued,
        };
        let Some(queued) = queued else {
            return;
        };
        deliver(&shared, &agents, queued).await;
    }
    while let Ok(queued) = handed.try_recv() {
        deliver(&shared, &agents, queued).await;
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
    let harnesses = agents.harnesses();
    let mut fresh = Vec::new();
    let response = match caller {
        None => {
            let kept = kept(agent, &req.body, None)?;
            store.once(&req.idempotency_key, &kept, |w| {
                queue(w, harnesses, agent, &req.body, None, &mut fresh)
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
                let response = queue(w, harnesses, agent, &text, Some(caller), &mut fresh)?;
                w.answered(&key, &kept, &response)?;
                Ok(response)
            })?
        }
    };
    Ok(Sent {
        response,
        queued: fresh,
    })
}

/// Bazhen's own mail to `agent`, sent in a verb's write under `key`, a key derived from the
/// verb's, as `Mailbox.send` sends it: a retry of the verb sends it no second time.
pub(crate) fn send_under(
    w: &StoreWriter<'_>,
    harnesses: &Harnesses,
    agent: &AgentId,
    key: &str,
    body: &str,
    fresh: &mut Vec<Queued>,
) -> Result<SendMessageResponse, Sending> {
    let kept = kept(agent, body, None)?;
    if let Some(prior) = w.replay(key, &kept)? {
        return Ok(prior);
    }
    let response = queue(w, harnesses, agent, body, None, fresh)?;
    w.answered(key, &kept, &response)?;
    Ok(response)
}

fn kept(agent: &AgentId, body: &str, from: Option<&AgentId>) -> Result<String, OnceError> {
    Ok(serde_json::to_string(&KeptSend {
        agent_id: agent.as_str(),
        body,
        from: from.map(AgentId::as_str),
    })?)
}

/// Queues `body` for `agent`, if its harness takes mail for it now, adding to `fresh` how it is
/// to be delivered once the write commits.
pub(crate) fn queue(
    w: &StoreWriter<'_>,
    harnesses: &Harnesses,
    agent: &AgentId,
    body: &str,
    from: Option<&AgentId>,
    fresh: &mut Vec<Queued>,
) -> Result<SendMessageResponse, Sending> {
    let takes_none = || Sending::NoAgent(format!("no agent {agent} that takes mail"));
    let binding = w
        .reads()
        .agent_binding(agent.as_str())?
        .ok_or_else(takes_none)?;
    let harness = harness_of(harnesses, &binding.harness).ok_or_else(takes_none)?;
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
    fresh.push(Queued {
        agent: agent.clone(),
        message: message_id.clone(),
        delivery,
    });
    Ok(SendMessageResponse {
        message_id,
        event_ids: vec![event],
    })
}

pub(crate) fn harness_of<'a>(harnesses: &'a Harnesses, harness: &str) -> Option<&'a dyn Harness> {
    harnesses.get(HarnessId::parse(harness)?)
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
        let Some(harness) = harness_of(agents.harnesses(), &now.harness) else {
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
        let (message, agent) = (message.clone(), agent.clone());
        store
            .run(move |store| {
                store.write(|w| {
                    // A turn carrying it may have taken it before the push returned, or the agent
                    // started again: read in the transaction that records it, neither can come
                    // between the reading and the record.
                    if pushable_in(w.reads(), &message, &agent)?.is_some() {
                        w.mail_step(&message, change)?;
                    }
                    Ok::<_, AppendError>(())
                })
            })
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
        .run(move |store| pushable_in(store.reads(), &message, &agent))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err: rusqlite::Error| err.to_string())
}

/// The same, as `reads` sees it.
fn pushable_in(
    reads: bazhen_store::Reads<'_>,
    message: &MessageId,
    agent: &AgentId,
) -> rusqlite::Result<Option<Pushable>> {
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
}

/// The protocol's error for a send that queued nothing, with `Tasks.send`'s and
/// `Mailbox.send`'s words.
pub(crate) fn refusal(err: &Sending) -> Response {
    let (status, code) = match err {
        Sending::Invalid(_) | Sending::TooLong(_) => {
            (StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest)
        }
        Sending::Unnamed(_) | Sending::NoAgent(_) => (StatusCode::NOT_FOUND, ErrorCode::NotFound),
        Sending::Gone { .. } | Sending::Once(OnceError::Conflict(_)) => {
            (StatusCode::CONFLICT, ErrorCode::Conflict)
        }
        Sending::ToSelf => (StatusCode::FORBIDDEN, ErrorCode::Forbidden),
        Sending::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable),
        Sending::Once(_) | Sending::Internal(_) => return internal(err),
    };
    fail(status, code, &err.to_string())
}

#[cfg(test)]
pub(crate) mod tests;
