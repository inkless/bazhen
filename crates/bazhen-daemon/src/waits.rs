//! Requests held open until what they wait on stands: how many each listener and each caller
//! may hold at once, and the loop each runs, judged now and again after each commit until the
//! answer can't change or its time is up.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::edge;
use bazhen_protocol::ids::{AgentId, DeviceId, MessageId};
use bazhen_protocol::mail::{Message, WaitMessagesRequest, WaitMessagesResponse};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::accept::Holdable;
use crate::callers::Caller;
use crate::paired::Viewer;
use crate::routes::{Shared, fail, internal};
use crate::writer::Writer;

/// The most waits one caller holds at once, as the TypeScript daemon's `WAITS_PER_CALLER`.
const PER_CALLER: usize = 64;

/// The listener a request came in on, which each router marks its requests with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum On {
    Socket,
    Http,
}

/// Who holds a wait, as the caps count it: an agent by its id, a paired device by its id, and the
/// owner otherwise, on either listener.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Waiter {
    Owner,
    Agent(AgentId),
    Device(DeviceId),
}

impl Waiter {
    /// Who holds a request's wait, from what its listener read of its caller.
    pub(crate) fn of(caller: Option<&Caller>, viewer: Option<&Viewer>) -> Self {
        match (caller, viewer) {
            (Some(Caller(Some(agent))), _) => Self::Agent(agent.clone()),
            (_, Some(Viewer::Device { id, .. })) => Self::Device(id.clone()),
            _ => Self::Owner,
        }
    }
}

/// The waits held open, counted against each listener's cap and each caller's, with the messages
/// they wait on.
#[derive(Debug, Clone)]
pub(crate) struct Waits(Arc<Registry>);

#[derive(Debug)]
struct Registry {
    socket: usize,
    http: usize,
    caller: usize,
    held: Mutex<Tally>,
    /// Each message an open wait is on, with how many are on it.
    watched: Mutex<HashMap<MessageId, usize>>,
    latest: tokio::sync::Mutex<Latest>,
}

/// The watched messages' states as last read, on a read-only connection: never on the writer,
/// whose queue every hook, send and launch waits in.
#[derive(Debug, Default)]
struct Latest {
    /// The commit they were read at, or after.
    at: Option<u64>,
    states: HashMap<MessageId, Message>,
}

#[derive(Debug, Default)]
struct Tally {
    socket: usize,
    http: usize,
    callers: HashMap<Waiter, usize>,
}

/// Why a wait was refused a place.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum Crowded {
    #[error("the daemon holds as many waits on this listener as it may; let one end first")]
    Listener,
    #[error("{} already {} {held} waits, as many as one caller may; let one end first",
        waiter_named(.holder), if matches!(.holder, Waiter::Agent(_)) { "holds" } else { "hold" })]
    Caller { holder: Waiter, held: usize },
}

fn waiter_named(holder: &Waiter) -> &str {
    match holder {
        Waiter::Agent(agent) => agent.as_str(),
        Waiter::Owner | Waiter::Device(_) => "you",
    }
}

impl Waits {
    /// Waits for listeners serving `socket` and `http` connections at once. Each listener holds
    /// waits on at most half its connections, so the rest still answer whatever else is asked; a
    /// caller holds at most 64, and at most a quarter of the socket's.
    pub(crate) fn new(socket: usize, http: usize) -> Self {
        let socket = socket / 2;
        Self(Arc::new(Registry {
            socket,
            http: http / 2,
            caller: PER_CALLER.min(socket / 4),
            held: Mutex::default(),
            watched: Mutex::default(),
            latest: tokio::sync::Mutex::default(),
        }))
    }

    /// Marks `ids` as waited on until the guard is dropped, so each commit's read takes them in.
    fn watch(&self, ids: &Arc<[MessageId]>) -> Watched {
        let mut watched = self
            .0
            .watched
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for id in ids.iter() {
            *watched.entry(id.clone()).or_insert(0) += 1;
        }
        Watched {
            waits: Arc::clone(&self.0),
            ids: Arc::clone(ids),
        }
    }

    /// Where each of `ids` stands, as of `store`'s latest commit or later, in the order asked.
    /// One read of a commit serves every wait on it: the first wait judged after a commit reads
    /// every watched message's state with its own, and the others answer from that. Bodies are
    /// never read.
    async fn states(&self, store: &Writer, ids: &[MessageId]) -> Result<Vec<Message>, Unread> {
        let mut latest = self.0.latest.lock().await;
        let at = *store.committed().borrow();
        if latest.at != Some(at) {
            latest.at = Some(at);
            latest.states.clear();
        }
        let mut asked: HashSet<MessageId> = ids
            .iter()
            .filter(|id| !latest.states.contains_key(*id))
            .cloned()
            .collect();
        let mut fresh = HashMap::new();
        if !asked.is_empty() {
            let watched: HashSet<MessageId> = self
                .0
                .watched
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .keys()
                .cloned()
                .collect();
            if latest.states.is_empty() {
                asked.extend(watched.iter().cloned());
            }
            let store = store.clone();
            let found = tokio::task::spawn_blocking(move || {
                let asked: Vec<&str> = asked.iter().map(MessageId::as_str).collect();
                store.reader()?.reads().message_states(&asked)
            })
            .await
            .map_err(|err| Unread::Store(err.to_string()))?
            .map_err(|err| Unread::Store(err.to_string()))?;
            for found in found {
                let (Some(id), Some(agent_id)) =
                    (MessageId::parse(&found.id), AgentId::parse(&found.agent))
                else {
                    return Err(Unread::Store(format!(
                        "message {} names no agent id",
                        found.id
                    )));
                };
                let message = Message {
                    id: id.clone(),
                    agent_id,
                    state: found.state,
                };
                // Only what a wait is on is kept: the rest is answered once and read again
                // when asked again.
                if watched.contains(&id) {
                    latest.states.insert(id.clone(), message.clone());
                }
                fresh.insert(id, message);
            }
        }
        ids.iter()
            .map(|id| {
                fresh
                    .get(id)
                    .or_else(|| latest.states.get(id))
                    .cloned()
                    .ok_or_else(|| Unread::Unknown(id.clone()))
            })
            .collect()
    }

    /// A place for one more of `holder`'s waits on the listener `on`, held until the slot is
    /// dropped; refused, taking nothing, when either cap is reached.
    pub(crate) fn enter(&self, on: On, holder: Waiter) -> Result<Slot, Crowded> {
        let mut count = self.0.held.lock().unwrap_or_else(PoisonError::into_inner);
        let Tally {
            socket,
            http,
            callers,
        } = &mut *count;
        let (listener, most) = match on {
            On::Socket => (socket, self.0.socket),
            On::Http => (http, self.0.http),
        };
        if *listener >= most {
            return Err(Crowded::Listener);
        }
        let held = callers.get(&holder).copied().unwrap_or(0);
        if held >= self.0.caller {
            return Err(Crowded::Caller { holder, held });
        }
        *listener += 1;
        callers.insert(holder.clone(), held + 1);
        Ok(Slot {
            waits: Arc::clone(&self.0),
            on,
            holder,
        })
    }
}

/// One wait's place, given back when it is dropped.
#[derive(Debug)]
pub(crate) struct Slot {
    waits: Arc<Registry>,
    on: On,
    holder: Waiter,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut count = self
            .waits
            .held
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let listener = match self.on {
            On::Socket => &mut count.socket,
            On::Http => &mut count.http,
        };
        *listener = listener.saturating_sub(1);
        if let Some(held) = count.callers.get_mut(&self.holder) {
            *held = held.saturating_sub(1);
            if *held == 0 {
                count.callers.remove(&self.holder);
            }
        }
    }
}

/// The messages one wait is on, given back when it ends.
#[derive(Debug)]
struct Watched {
    waits: Arc<Registry>,
    ids: Arc<[MessageId]>,
}

impl Drop for Watched {
    fn drop(&mut self) {
        let mut watched = self
            .waits
            .watched
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for id in self.ids.iter() {
            if let Some(on) = watched.get_mut(id) {
                *on = on.saturating_sub(1);
                if *on == 0 {
                    watched.remove(id);
                }
            }
        }
    }
}

/// Where a wait stands: `done` once no later commit can change the answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Judged<T> {
    pub(crate) done: bool,
    pub(crate) value: T,
}

/// A wait's watch on the store's commits, and when its time is up: every commit after it starts
/// calls for another judgement, however soon after the first it comes.
#[derive(Debug)]
pub(crate) struct Watching {
    committed: watch::Receiver<u64>,
    deadline: Instant,
}

impl Watching {
    /// A wait of `timeout` from now judged for the first time, with the commits `committed` says
    /// of watched from before the judgement, so one that lands while it is made isn't missed.
    pub(crate) async fn first<T, E, F, Judging>(
        mut committed: watch::Receiver<u64>,
        timeout: Duration,
        mut judge: F,
    ) -> Result<(Judged<T>, Self), E>
    where
        F: FnMut() -> Judging,
        Judging: Future<Output = Result<Judged<T>, E>>,
    {
        let deadline = Instant::now() + timeout;
        committed.mark_unchanged();
        let first = judge().await?;
        Ok((
            first,
            Self {
                committed,
                deadline,
            },
        ))
    }

    /// Answers with the first judgement that is done: `first`, else one `judge` makes after a
    /// commit. At the deadline, which no commit moves, it answers with one made then; once the
    /// store's writer is gone, with the last made.
    pub(crate) async fn until<T, E, F, Judging>(
        mut self,
        first: Judged<T>,
        mut judge: F,
    ) -> Result<T, E>
    where
        F: FnMut() -> Judging,
        Judging: Future<Output = Result<Judged<T>, E>>,
    {
        let mut timer = std::pin::pin!(tokio::time::sleep_until(self.deadline));
        let mut last = first;
        while !last.done {
            tokio::select! {
                biased;
                () = &mut timer => return judge().await.map(|judged| judged.value),
                changed = self.committed.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    last = judge().await?;
                }
            }
        }
        Ok(last.value)
    }
}

/// Why a wait for mail can't be judged.
#[derive(Debug)]
enum Unread {
    Unknown(MessageId),
    Store(String),
}

impl Unread {
    fn response(&self) -> Response {
        match self {
            Self::Unknown(id) => fail(
                StatusCode::NOT_FOUND,
                ErrorCode::NotFound,
                &format!("no message {}", id.as_str()),
            ),
            Self::Store(err) => internal(err),
        }
    }
}

/// Where the messages `ids` stand, in the order asked: done once each is settled.
async fn mail(
    waits: Waits,
    store: Writer,
    ids: Arc<[MessageId]>,
) -> Result<Judged<WaitMessagesResponse>, Unread> {
    let read = waits.states(&store, &ids).await?;
    Ok(Judged {
        done: read.iter().all(|message| message.state.settled()),
        value: WaitMessagesResponse { messages: read },
    })
}

/// `POST /v1/messages/wait`: answered once every message is settled, or at `timeoutMs`, with the
/// states then. A message this daemon never queued is refused at once.
pub(crate) async fn messages(
    State(shared): State<Shared>,
    Extension(on): Extension<On>,
    caller: Option<Extension<Caller>>,
    viewer: Option<Extension<Viewer>>,
    holdable: Option<Extension<Holdable>>,
    body: Bytes,
) -> Response {
    let req = match edge::<WaitMessagesRequest>(&body) {
        Ok(req) => req,
        Err(refused) => {
            return fail(
                StatusCode::BAD_REQUEST,
                ErrorCode::InvalidRequest,
                &refused.0,
            );
        }
    };
    let ids: Arc<[MessageId]> = req.message_ids.into();
    let judge = || mail(shared.waits.clone(), shared.store.clone(), Arc::clone(&ids));
    let timeout = Duration::from_millis(req.timeout_ms);
    let (first, watching) = match Watching::first(shared.store.committed(), timeout, judge).await {
        Ok(first) => first,
        Err(unread) => return unread.response(),
    };
    if first.done || req.timeout_ms == 0 {
        return Json(first.value).into_response();
    }
    let holder = Waiter::of(
        caller.as_ref().map(|Extension(caller)| caller),
        viewer.as_ref().map(|Extension(viewer)| viewer),
    );
    let _slot = match shared.waits.enter(on, holder) {
        Ok(slot) => slot,
        Err(crowded) => {
            return fail(
                StatusCode::TOO_MANY_REQUESTS,
                ErrorCode::RateLimited,
                &crowded.to_string(),
            );
        }
    };
    let _watched = shared.waits.watch(&ids);
    // A stop drops the wait unanswered, so its client asks the next daemon.
    let _holding = holdable.as_ref().map(|Extension(holdable)| holdable.hold());
    match watching.until(first, judge).await {
        Ok(answer) => Json(answer).into_response(),
        Err(unread) => unread.response(),
    }
}

#[cfg(test)]
mod tests;
