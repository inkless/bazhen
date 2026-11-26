//! `POST /v1/agents/:id/messages` (`Tasks.send` and `Mailbox.send`): mail for an agent, by how
//! its harness takes it. Mail a harness takes from its hooks is queued for them. Mail a harness
//! takes by push is handed to it (`codex/mail.ts`'s `deliver`). A harness that takes none refuses
//! the send, as does one that takes none for the agent now.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
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

/// Where a writer job hands what it queued, once it commits.
/// Unbounded, so a write at start, before anything drains it, neither waits nor loses mail.
pub(crate) type Handing = mpsc::UnboundedSender<Queued>;

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
        shared
            .store
            .run(move |store| {
                let agent = store
                    .reads()
                    .resolve_agent(&reference)?
                    .and_then(|agent| AgentId::parse(&agent))
                    .ok_or_else(|| Sending::Unnamed(reference.clone()))?;
                sent(store, &agents, caller.as_ref(), &agent, &req)
            })
            .await
            .map_err(|err| Sending::Internal(err.to_string()))?
    };
    match sent.await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => refusal(&err),
    }
}

/// Hands a message just queued over as `queued` says: pushed, with the agent's mail queued before
/// it, or offered to the agent's waiter.
pub(crate) async fn deliver(shared: &Shared, queued: Queued) {
    let Queued {
        agent, delivery, ..
    } = queued;
    match delivery {
        Delivery::Push => push_queued(shared, &agent),
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
        deliver(&shared, queued).await;
    }
    while let Ok(queued) = handed.try_recv() {
        deliver(&shared, queued).await;
    }
}

/// The send, as the human's or as the agent `caller`'s to another.
fn sent(
    store: &mut Store,
    agents: &Agents,
    caller: Option<&AgentId>,
    agent: &AgentId,
    req: &SendMessageRequest,
) -> Result<SendMessageResponse, Sending> {
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
    // Committed: handed over here, so a caller gone before the answer leaves none of its mail
    // behind.
    agents.hand(fresh);
    Ok(response)
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

/// The agents whose queued mail a pusher pushes, each marked once its queue is to be read again.
/// One pusher at a time pushes an agent's mail, oldest first, so none is pushed twice, nor ahead
/// of mail queued before it.
#[derive(Debug, Default)]
pub(crate) struct Pushers(StdMutex<HashMap<AgentId, bool>>);

impl Pushers {
    fn pushing(&self) -> MutexGuard<'_, HashMap<AgentId, bool>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether a pusher is to start for `agent`, as none runs; one that runs is marked to read
    /// its queue again.
    fn wake(&self, agent: &AgentId) -> bool {
        match self.pushing().entry(agent.clone()) {
            Entry::Occupied(mut running) => {
                *running.get_mut() = true;
                false
            }
            Entry::Vacant(none) => {
                none.insert(false);
                true
            }
        }
    }

    /// The pusher reads `agent`'s queue: a wake from here on reads it again.
    fn reading(&self, agent: &AgentId) {
        if let Some(marked) = self.pushing().get_mut(agent) {
            *marked = false;
        }
    }

    /// Whether `agent`'s pusher ends, as no wake came since it read the queue; under the lock a
    /// wake takes, so a wake after this starts a pusher of its own.
    fn done(&self, agent: &AgentId) -> bool {
        let mut pushing = self.pushing();
        if pushing.get(agent).copied() == Some(true) {
            return false;
        }
        pushing.remove(agent);
        true
    }
}

/// An agent's pusher, which ends its run however its task ends: one cut short by a failed read,
/// or a panic, leaves none marked running with nothing running.
struct Pusher {
    pushers: Arc<Pushers>,
    agent: AgentId,
    done: bool,
}

impl Drop for Pusher {
    fn drop(&mut self) {
        if !self.done {
            self.pushers.pushing().remove(&self.agent);
        }
    }
}

impl Pusher {
    /// Pushes the agent's queued mail, oldest first, until none is left that a wake since the
    /// last read asks for. A harness that can't take it now holds what is left for the next wake.
    async fn run(
        &mut self,
        store: &crate::writer::Writer,
        agents: &Agents,
        port: &dyn PushPort,
    ) -> Result<(), String> {
        loop {
            self.pushers.reading(&self.agent);
            for message in queued(store, agents, &self.agent).await? {
                if push(store, agents, port, &message, &self.agent).await? == Push::NotNow {
                    break;
                }
            }
            if self.pushers.done(&self.agent) {
                self.done = true;
                return Ok(());
            }
        }
    }
}

/// Resumes pushing the queued mail the last daemon left behind, to each agent whose harness takes
/// mail by push; other mail stays queued for its harness to pull.
pub(crate) async fn resume_queued(shared: &Shared) {
    if shared.push.is_none() {
        return;
    }
    let store = shared.store.clone();
    let agents =
        tokio::task::spawn_blocking(move || store.reader()?.reads().agents_with_queued_mail())
            .await;
    match agents {
        Ok(Ok(agents)) => {
            for agent in agents {
                push_queued(shared, &agent);
            }
        }
        Ok(Err(err)) => tracing::warn!("bazhen: couldn't read queued mail at start: {err}"),
        Err(err) => tracing::warn!("bazhen: couldn't read queued mail at start: {err}"),
    }
}

/// Pushes `agent`'s queued mail, on the agents' tracker, through the daemon's push port, where
/// its harness takes mail by push; with no port, it stays queued. A pusher already running for
/// the agent reads its queue again instead.
pub(crate) fn push_queued(shared: &Shared, agent: &AgentId) {
    let (Some(PushTo(port)), Some(agents)) = (shared.push.clone(), shared.agents.clone()) else {
        return;
    };
    let pushers = Arc::clone(&shared.hooks.pushers);
    if !pushers.wake(agent) {
        return;
    }
    let store = shared.store.clone();
    let mut pusher = Pusher {
        pushers,
        agent: agent.clone(),
        done: false,
    };
    let run = Arc::clone(&agents);
    agents.spawn(async move {
        if let Err(err) = pusher.run(&store, &run, port.as_ref()).await {
            tracing::warn!("bazhen: couldn't push mail to {}: {err}", pusher.agent);
        }
    });
}

/// `agent`'s queued messages, oldest first, where its harness takes mail by push.
async fn queued(
    store: &crate::writer::Writer,
    agents: &Agents,
    agent: &AgentId,
) -> Result<Vec<MessageId>, String> {
    let id = agent.clone();
    let (binding, mail) = store
        .run(move |store| {
            let reads = store.reads();
            Ok::<_, rusqlite::Error>((
                reads.agent_binding(id.as_str())?,
                reads.mail(id.as_str(), &[MailboxState::Queued])?,
            ))
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    let pushes = binding
        .and_then(|b| harness_of(agents.harnesses(), &b.harness))
        .is_some_and(|h| h.capabilities().delivery == Delivery::Push);
    if !pushes {
        return Ok(Vec::new());
    }
    Ok(mail
        .into_iter()
        .filter_map(|m| MessageId::parse(&m.id))
        .collect())
}

/// What came of a push.
#[derive(Debug, PartialEq, Eq)]
enum Push {
    /// It was handed over, given up, or isn't the agent's to push any more.
    Went,
    /// The harness can't take mail for the agent now.
    NotNow,
}

/// What a push reads before each attempt: the message's body while it is still queued for
/// `agent`, and the agent's harness and session, unless it is still starting, as its TUI may be
/// held at a dialog and the harness's server would start a turn anyway.
struct Pushable {
    body: String,
    harness: String,
    session: Option<SessionRef>,
}

/// Where a queued message stands now.
enum Standing {
    /// It is no longer queued for its agent: taken, or settled.
    Gone,
    /// Its agent is starting, so its harness can't take it now.
    Starting,
    Pushable(Pushable),
}

/// Hands a queued message to its agent's harness, trying again with backoff, and gives it up as
/// undeliverable after the last attempt. One no longer queued is left alone, as is one for an
/// agent still starting, which the harness can't take now.
async fn push(
    store: &crate::writer::Writer,
    agents: &Agents,
    port: &dyn PushPort,
    message: &MessageId,
    agent: &AgentId,
) -> Result<Push, String> {
    let mut wait = PUSH_RETRY;
    for attempt in 1..=PUSH_ATTEMPTS {
        let now = match pushable(store, message, agent).await? {
            Standing::Gone => return Ok(Push::Went),
            Standing::Starting => return Ok(Push::NotNow),
            Standing::Pushable(now) => now,
        };
        let Some(harness) = harness_of(agents.harnesses(), &now.harness) else {
            return Ok(Push::Went);
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
            Pushed::NotNow => return Ok(Push::NotNow),
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
        return store
            .run(move |store| {
                store.write(|w| {
                    // A turn carrying it may have taken it before the push returned, or the agent
                    // started again, its TUI maybe held at a dialog: read in the transaction that
                    // records it, neither can come between the reading and the record.
                    match pushable_in(w.reads(), &message, &agent)? {
                        Standing::Gone => Ok(Push::Went),
                        Standing::Starting => Ok(Push::NotNow),
                        Standing::Pushable(_) => {
                            w.mail_step(&message, change)?;
                            Ok::<_, AppendError>(Push::Went)
                        }
                    }
                })
            })
            .await
            .map_err(|err| err.to_string())?
            .map_err(|err| err.to_string());
    }
    Ok(Push::Went)
}

/// Where the message stands for `agent`: what it is pushed as while it is still queued for an
/// agent that isn't starting.
async fn pushable(
    store: &crate::writer::Writer,
    message: &MessageId,
    agent: &AgentId,
) -> Result<Standing, String> {
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
) -> rusqlite::Result<Standing> {
    let queued = reads
        .message(message.as_str())?
        .filter(|m| m.agent == agent.as_str() && m.state == MailboxState::Queued);
    let Some(queued) = queued else {
        return Ok(Standing::Gone);
    };
    let Some(binding) = reads.agent_binding(agent.as_str())? else {
        return Ok(Standing::Gone);
    };
    if binding.state == "starting" {
        return Ok(Standing::Starting);
    }
    Ok(Standing::Pushable(Pushable {
        body: queued.body,
        harness: binding.harness,
        session: binding.session.map(|s| SessionRef {
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
