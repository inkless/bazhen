//! The hooks' routes, `POST /v1/hooks` and `POST /v1/hooks/ack` (`mailbox/ingress.ts`): each
//! identifies its agent itself, hands the hook to the agent's harness, and applies the facts it
//! reads, each under its gate, one hook of an agent at a time.
//!
//! A hook fails open: whatever goes wrong, its harness goes on as it would, so every hook is
//! answered quiet but one whose caller wasn't read in time, which is told to try again, and the
//! agent's waiter, which is held until a newer one replaces it.

mod activity;
mod binding;
mod waiters;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bazhen_harness::{
    Gate, HarnessId, Held, IngestContext, Key, Observed, Origin, Reply, Report, SessionRef,
};
use bazhen_peer::Peer;
use bazhen_protocol::agent_events::CompactedHook;
use bazhen_protocol::agents::{Activity, ActivitySource};
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::edge;
use bazhen_protocol::ids::AgentId;
use bazhen_protocol::mail::{
    HOOK_PROTOCOL_VERSION, HOOK_REPLY_TYPE, HookAck, HookReply, HookRequest, OfferToken,
};
use bazhen_store::{AgentBinding, Store};

use self::activity::{Change, Tracker};
use self::waiters::{Waiters, Waiting};
use crate::accept::Holdable;
use crate::callers::{Identity, Presented, identified, presented_by};
use crate::peer::{PeerRead, PeerSocket, root_of};
use crate::routes::{Shared, fail};
use crate::writer::Writer;

/// How long a hook that may move its agent to a new session waits for the agent's start to be
/// recorded: the TUI can start its session before its terminal says it runs.
const START_WAIT: Duration = Duration::from_secs(30);

/// The longest text from a hook a log line quotes, in characters.
const CLIP_CHARS: usize = 80;

const NO_SUCH_AGENT: &str = "the daemon runs no such agent";

/// What the hooks keep between requests: what each agent is doing, its waiter, and its turn.
#[derive(Debug)]
pub(crate) struct Hooks {
    activity: StdMutex<Tracker>,
    waiters: Arc<Waiters>,
    /// One hook of an agent at a time, from its binding's read to its last fact.
    order: StdMutex<HashMap<AgentId, Arc<tokio::sync::Mutex<()>>>>,
    start_wait: Duration,
}

impl Default for Hooks {
    fn default() -> Self {
        Self::waiting(START_WAIT)
    }
}

/// The reply that leaves the harness to go on as it would.
fn quiet() -> HookReply {
    HookReply {
        exit_code: 0,
        stdout: String::new(),
        stderr: String::new(),
        offered: Vec::new(),
    }
}

/// `reply` as the hook client reads it (`frameHookReply`): stdout then stderr as the body, with
/// where one ends, the exit code and the offers in headers.
fn framed(reply: &HookReply) -> Response {
    let mut body = Vec::with_capacity(reply.stdout.len() + reply.stderr.len());
    body.extend_from_slice(reply.stdout.as_bytes());
    body.extend_from_slice(reply.stderr.as_bytes());
    let offered: Vec<&str> = reply.offered.iter().map(OfferToken::as_str).collect();
    (
        [
            (header::CONTENT_TYPE.as_str(), HOOK_REPLY_TYPE.to_owned()),
            ("bazhen-exit-code", reply.exit_code.to_string()),
            ("bazhen-offered", offered.join(",")),
            ("bazhen-stdout-bytes", reply.stdout.len().to_string()),
        ],
        body,
    )
        .into_response()
}

/// Whether a hook client of `version` speaks this daemon's hook protocol: the same major, as
/// text, as `isCompatible` compares them, so `01.0` is another major than `1.0`. The edge has
/// already held `version` to the protocol's shape.
fn compatible(version: &str) -> bool {
    let major = |version: &str| version.split('.').next().map(str::to_owned);
    major(version) == major(HOOK_PROTOCOL_VERSION)
}

/// `text`, cut to `CLIP_CHARS` characters.
fn clip(text: &str) -> String {
    match text.char_indices().nth(CLIP_CHARS) {
        Some((at, _)) => format!("{}…", text.get(..at).unwrap_or(text)),
        None => text.to_owned(),
    }
}

/// `text`, clipped, as a JSON string.
fn quoted(text: &str) -> String {
    serde_json::to_string(&clip(text)).unwrap_or_default()
}

/// Logs a hook dropped, but for the status line, which redraws too often to log.
fn dropped(event: &str, said: &str, why: &str) {
    if event != "statusline" {
        tracing::warn!("dropped the {} hook for agent {said}: {why}", quoted(event));
    }
}

/// The socket's peer, read, where the request came over the socket.
async fn peer_of(shared: &Shared, socket: Option<Extension<PeerSocket>>) -> Option<PeerRead> {
    match socket {
        Some(Extension(socket)) => Some(shared.peers.read(&socket).await),
        None => None,
    }
}

fn late(reason: &str) -> Response {
    fail(
        StatusCode::SERVICE_UNAVAILABLE,
        ErrorCode::Unavailable,
        reason,
    )
}

/// `POST /v1/hooks`: a hook a harness ran, from the hook client.
pub(crate) async fn hook(
    State(shared): State<Shared>,
    socket: Option<Extension<PeerSocket>>,
    holdable: Option<Extension<Holdable>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = peer_of(&shared, socket).await;
    match edge::<HookRequest>(&body) {
        Ok(hook) => {
            let token = presented_by(&headers).token;
            let holdable = holdable.map(|Extension(holdable)| holdable);
            taken(&shared, &hook, token, read, holdable.as_ref()).await
        }
        Err(refused) => {
            tracing::warn!("dropped a hook request it can't read: {}", clip(&refused.0));
            framed(&quiet())
        }
    }
}

async fn taken(
    shared: &Shared,
    hook: &HookRequest,
    token: Option<String>,
    read: Option<PeerRead>,
    holdable: Option<&Holdable>,
) -> Response {
    let (event, said) = (hook.event.as_str(), hook.agent_id.as_str());
    let version = hook.protocol_version.as_str();
    if !compatible(version) {
        let why = format!(
            "its protocol {} isn't {HOOK_PROTOCOL_VERSION}'s",
            clip(version)
        );
        dropped(event, said, &why);
        return framed(&quiet());
    }
    let peer = match &read {
        Some(PeerRead::Read(peer)) => Some(peer.clone()),
        _ => None,
    };
    let presented = Presented {
        token,
        said: Some(said.to_owned()),
        thread: None,
    };
    let agent = match identified(shared, read, presented).await {
        Ok(Identity::Agent(agent)) => agent,
        Ok(Identity::Refused {
            reason,
            retry: true,
        }) => {
            if event == "wait" {
                tracing::warn!("late, the waiter retries: agent {said}");
            } else {
                dropped(event, said, &reason);
            }
            return late(&reason);
        }
        Ok(Identity::Refused { reason, .. }) => {
            dropped(event, said, &format!("refused, {reason}"));
            return framed(&quiet());
        }
        Ok(Identity::Human) => {
            dropped(event, said, NO_SUCH_AGENT);
            return framed(&quiet());
        }
        Err(err) => {
            dropped(event, said, &format!("its caller can't be read: {err}"));
            return framed(&quiet());
        }
    };
    match shared
        .hooks
        .ingest(shared, &agent, hook, peer.as_ref())
        .await
    {
        Ok(Some(mut waiting)) => {
            let _holding = holdable.map(Holdable::hold);
            framed(&waiting.answered().await)
        }
        Ok(None) => framed(&quiet()),
        Err(why) => {
            dropped(event, said, &why);
            framed(&quiet())
        }
    }
}

/// `POST /v1/hooks/ack`: the hook client wrote a reply's offered messages. An ack that can't be
/// read, or names no agent, is answered all the same: the client has nothing to do with the
/// answer but wait for it.
pub(crate) async fn ack(
    State(shared): State<Shared>,
    socket: Option<Extension<PeerSocket>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let answered = || axum::Json(serde_json::json!({})).into_response();
    let Ok(ack) = edge::<HookAck>(&body) else {
        return answered();
    };
    let read = peer_of(&shared, socket).await;
    let presented = Presented {
        token: presented_by(&headers).token,
        said: Some(ack.agent_id.as_str().to_owned()),
        thread: None,
    };
    match identified(&shared, read, presented).await {
        Ok(Identity::Refused {
            reason,
            retry: true,
        }) => late(&reason),
        _ => answered(),
    }
}

/// What the store says of `agent`, as its hooks are checked against it.
async fn binding_of(store: &Writer, agent: &AgentId) -> Result<Option<AgentBinding>, String> {
    let id = agent.as_str().to_owned();
    store
        .run(move |store| store.reads().agent_binding(&id))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

/// Runs `write` in one transaction on the store's writer.
async fn write<T: Send + 'static>(
    store: &Writer,
    write: impl FnOnce(&bazhen_store::Writer<'_>) -> Result<T, bazhen_store::AppendError>
    + Send
    + 'static,
) -> Result<T, String> {
    store
        .run(move |store: &mut Store| store.write(write))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

/// What a hook's report passes, as the daemon finds the session it came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Passes {
    in_session: bool,
    owner: bool,
    /// That the agent is starting, and the hook ran from the TUI its terminal started, so a sign
    /// of life in it is the agent's harness up (`startedHere`).
    started_here: bool,
}

impl Passes {
    fn passes(self, gate: Gate) -> bool {
        match gate {
            Gate::None => true,
            Gate::InSession => self.in_session,
            Gate::Owner => self.owner,
        }
    }
}

impl Hooks {
    /// Hooks whose start wait is `start_wait`.
    pub(crate) fn waiting(start_wait: Duration) -> Self {
        Self {
            activity: StdMutex::new(Tracker::default()),
            waiters: Arc::default(),
            order: StdMutex::new(HashMap::new()),
            start_wait,
        }
    }

    /// Reads `hook` for `agent` through its harness, and applies what it says. A waiter its gate
    /// passes is registered, and comes back to be held.
    async fn ingest(
        &self,
        shared: &Shared,
        agent: &AgentId,
        hook: &HookRequest,
        peer: Option<&Peer>,
    ) -> Result<Option<Waiting>, String> {
        let binding = binding_of(&shared.store, agent)
            .await?
            .ok_or(NO_SUCH_AGENT)?;
        let harnesses = shared
            .agents
            .as_ref()
            .map(|agents| agents.harnesses())
            .ok_or("this daemon runs no agents")?;
        let harness = HarnessId::parse(&binding.harness)
            .and_then(|id| harnesses.get(id))
            .ok_or_else(|| format!("its harness {} isn't served", quoted(&binding.harness)))?;
        let session = binding.session.as_ref().map(|session| SessionRef {
            kind: session.kind,
            id: session.id.clone(),
        });
        let report = Report::Hook {
            event: hook.event.as_str(),
            payload: hook.payload.get().as_bytes(),
        };
        let context = IngestContext {
            agent: Some(agent),
            offered: &[],
            session: session.as_ref(),
        };
        let ingested = harness.ingest(report, &context);
        let origin = ingested.origin.clone().unwrap_or(Origin {
            session: None,
            transcript: None,
            subagent: None,
        });
        let owned = |gate| gate == Gate::Owner;
        let asks_owner =
            owned(ingested.reply_gate) || ingested.observed.iter().any(|keyed| owned(keyed.gate));
        let starts = ingested.observed.iter().any(|keyed| {
            owned(keyed.gate) && matches!(keyed.fact, Observed::SessionStarted { .. })
        });
        // Only the agent's own session, and no subagent of it, can own the agent.
        let may_own = asks_owner && origin.subagent.is_none() && origin.session.is_some();
        let rebinds = may_own && starts && !binding::in_session(&binding, &origin);
        let readies = may_own
            && binding.state == "starting"
            && ingested
                .observed
                .iter()
                .any(|keyed| owned(keyed.gate) && matches!(keyed.fact, Observed::Ready { .. }));
        if rebinds || readies {
            self.started(&shared.store, agent).await?;
        }
        let turn = self.turn_of(agent);
        let applied = {
            let _held = turn.lock().await;
            let passes = self
                .passes(shared, agent, &origin, peer, may_own, rebinds)
                .await?;
            if owned(ingested.reply_gate) && !passes.owner {
                let why = match &origin.session {
                    _ if origin.subagent.is_some() => "it ran in a subagent".to_owned(),
                    Some(session) => format!("session {} isn't the agent's", quoted(&session.id)),
                    None => "session none isn't the agent's".to_owned(),
                };
                Err(why)
            } else {
                let waits = ingested.reply == Reply::Hold(Held::Waiter);
                match self
                    .apply(shared, agent, hook, &origin, passes, &ingested.observed)
                    .await
                {
                    Ok(()) => self.waits(shared, agent, waits).await,
                    Err(why) => Err(why),
                }
            }
        };
        self.release(agent, turn);
        applied
    }

    /// What the report passes, once a report that started a session the agent's terminal runs
    /// has moved the agent to it, and the session's transcript is recorded where it owns it.
    async fn passes(
        &self,
        shared: &Shared,
        agent: &AgentId,
        origin: &Origin,
        peer: Option<&Peer>,
        may_own: bool,
        rebinds: bool,
    ) -> Result<Passes, String> {
        let binding = binding_of(&shared.store, agent)
            .await?
            .ok_or(NO_SUCH_AGENT)?;
        let in_session = binding::in_session(&binding, origin);
        let owner = may_own
            && (in_session
                || (rebinds && rebind(&shared.store, agent, &binding, origin, peer).await?));
        let started_here = owner && binding.state == "starting" && ran_from_pane(&binding, peer);
        if owner && let (Some(session), Some(path)) = (&origin.session, &origin.transcript) {
            let (agent, session, path) = (agent.clone(), session.id.clone(), path.clone());
            write(&shared.store, move |w| {
                w.record_transcript(&agent, &session, &path)
            })
            .await?;
        }
        Ok(Passes {
            in_session: in_session || owner,
            owner,
            started_here,
        })
    }

    /// Applies each fact for `agent` that its gate passes, in order. The facts not applied here
    /// land with the mailbox, readiness, approvals and turns.
    async fn apply(
        &self,
        shared: &Shared,
        agent: &AgentId,
        hook: &HookRequest,
        origin: &Origin,
        passes: Passes,
        observed: &[bazhen_harness::Keyed],
    ) -> Result<(), String> {
        let subagent = origin.subagent.as_deref();
        for keyed in observed {
            let ours = matches!(&keyed.key, Key::Agent(id) if id == agent);
            if !ours || !passes.passes(keyed.gate) {
                continue;
            }
            let change = match &keyed.fact {
                Observed::Ready { sign } => {
                    if passes.started_here {
                        let (agent, sign) = (agent.clone(), *sign);
                        write(&shared.store, move |w| w.record_ready(&agent, sign)).await?;
                    }
                    continue;
                }
                Observed::Activity(doing) => Change::Doing(doing.clone()),
                Observed::SubagentStarted { id } => Change::SubagentStarted(id.clone()),
                Observed::SubagentStopped { id } => Change::SubagentStopped(id.clone()),
                Observed::SessionStarted { compacted: false } => {
                    self.tracker().session_started(agent);
                    continue;
                }
                Observed::Compacted { sign } => {
                    let compacted = CompactedHook {
                        session_id: origin.session.as_ref().map(|s| s.id.clone()),
                        pid: hook.pid,
                    };
                    let (agent, sign) = (agent.clone(), *sign);
                    write(&shared.store, move |w| {
                        w.record_compaction(&agent, sign, Some(compacted))
                    })
                    .await?;
                    continue;
                }
                _ => continue,
            };
            let Some(doing) = self.tracker().observe(agent, subagent, change) else {
                continue;
            };
            let activity = Activity {
                value: doing.value,
                source: ActivitySource::Native,
                confidence: 1.0,
                observed_at: format!("{:.3}", jiff::Timestamp::now()),
                detail: doing.detail,
                resets_at: None,
            };
            let agent = agent.clone();
            write(&shared.store, move |w| w.record_activity(&agent, &activity)).await?;
        }
        Ok(())
    }

    /// Registers `agent`'s waiter, where the report holds one, but for an agent that has closed,
    /// whose waiter is answered at once. A newer waiter answers the one it replaces, as does a
    /// session that started over, whose start only a waiter reports.
    async fn waits(
        &self,
        shared: &Shared,
        agent: &AgentId,
        waits: bool,
    ) -> Result<Option<Waiting>, String> {
        if !waits {
            return Ok(None);
        }
        let closed = binding_of(&shared.store, agent)
            .await?
            .is_none_or(|binding| binding.state == "closed");
        Ok((!closed).then(|| self.waiters.wait(agent)))
    }

    fn tracker(&self) -> std::sync::MutexGuard<'_, Tracker> {
        self.activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Answers the waiter `agent` holds quiet, where its close is recorded, as a close answered
    /// with its shells unsettled has. Taken in its turn, so a hook that read the agent as open
    /// before the close registers its waiter first, to be answered here, and one after reads it
    /// closed and holds none.
    pub(crate) async fn closed(&self, store: &Writer, agent: &AgentId) {
        let turn = self.turn_of(agent);
        {
            let _held = turn.lock().await;
            match binding_of(store, agent).await {
                Ok(binding)
                    if binding
                        .as_ref()
                        .is_none_or(|binding| binding.state == "closed") =>
                {
                    self.waiters.release(agent);
                }
                Ok(_) => {}
                Err(why) => tracing::warn!(
                    "bazhen: agent {agent}'s waiter is kept: whether it closed can't be read: {why}"
                ),
            }
        }
        self.release(agent, turn);
    }

    /// A waiter for `agent`, as a hook that holds one registers it.
    #[cfg(test)]
    pub(crate) fn waiter(&self, agent: &AgentId) -> Waiting {
        self.waiters.wait(agent)
    }

    /// Whether `agent` holds a waiter.
    #[cfg(test)]
    pub(crate) fn holds_waiter(&self, agent: &AgentId) -> bool {
        self.waiters.holds(agent)
    }

    /// `agent`'s turn, which a hook holds from its binding's read to its last fact.
    fn turn_of(&self, agent: &AgentId) -> Arc<tokio::sync::Mutex<()>> {
        let mut order = self
            .order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        order.entry(agent.clone()).or_default().clone()
    }

    /// Forgets `agent`'s turn once no hook holds or waits on it.
    fn release(&self, agent: &AgentId, turn: Arc<tokio::sync::Mutex<()>>) {
        let mut order = self
            .order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        drop(turn);
        if order
            .get(agent)
            .is_some_and(|turn| Arc::strong_count(turn) == 1)
        {
            order.remove(agent);
        }
    }

    /// Waits, at most the start wait, while `agent`'s start is still being recorded.
    async fn started(&self, store: &Writer, agent: &AgentId) -> Result<(), String> {
        let mut committed = store.committed();
        let recorded = async {
            loop {
                committed.borrow_and_update();
                match binding_of(store, agent).await? {
                    Some(binding) if binding::starting(&binding) => {}
                    _ => return Ok(()),
                }
                if committed.changed().await.is_err() {
                    return Ok(());
                }
            }
        };
        tokio::time::timeout(self.start_wait, recorded)
            .await
            .unwrap_or(Ok(()))
    }
}

/// Whether the hook's caller ran from the TUI `binding`'s terminal started, on the line the
/// kernel vouched for.
fn ran_from_pane(binding: &AgentBinding, peer: Option<&Peer>) -> bool {
    let root = binding.locator.as_deref().and_then(root_of);
    peer.zip(root)
        .is_some_and(|(peer, root)| binding::ran_by_pane(peer, root))
}

/// Moves `agent` to the session `origin` started, when its caller ran from the agent's terminal
/// itself: a nested session's start never moves it.
async fn rebind(
    store: &Writer,
    agent: &AgentId,
    binding: &AgentBinding,
    origin: &Origin,
    peer: Option<&Peer>,
) -> Result<bool, String> {
    let Some(session) = &origin.session else {
        return Ok(false);
    };
    if !ran_from_pane(binding, peer) {
        tracing::warn!(
            "agent {} stays on its session: SessionStart of {} wasn't its pane's",
            agent.as_str(),
            quoted(&session.id)
        );
        return Ok(false);
    }
    let (agent, kind, id) = (agent.clone(), session.kind, session.id.clone());
    write(store, move |w| w.bind_session(&agent, kind, &id)).await?;
    Ok(true)
}

/// `agent`'s last process is gone for good, as a respawn or relaunch replaces it.
pub(crate) fn replaced(
    _shared: &Shared,
    _agent: &AgentId,
) -> impl std::future::Future<Output = ()> + Send + 'static {
    std::future::ready(())
}

#[cfg(test)]
mod tests;
