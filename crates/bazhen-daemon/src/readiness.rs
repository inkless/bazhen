//! Launch readiness (`readiness.ts`, foundation-design §4.5): an agent whose terminal runs is
//! still starting until its harness shows a sign of life, since a TUI held at a trust, login or
//! update dialog isn't running. Once a start has waited its deadline, the human is told, once per
//! start, to look at its terminal. Nothing here writes to a terminal: only the human answers
//! what a TUI asks.
//!
//! One task follows the committed events, so every start is timed however it was recorded, by
//! whichever lane: a start arms its deadline, and its end disarms it. It ends only at the daemon's
//! stop, or once the store has closed: a read that fails is tried again, and an event it can't
//! read is passed over.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use bazhen_peer::Peer;
use bazhen_protocol::agent_events::ReadySign;
use bazhen_protocol::ids::AgentId;
use bazhen_store::{STARTS, StoredEvent, Waiting};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::routes::Shared;

/// The most events one read takes.
const PAGE: u32 = 256;
/// How long the first retry of a failed read waits; each next one waits twice as long, up to
/// [`RETRY_MOST`].
const RETRY_FIRST: Duration = Duration::from_millis(100);
const RETRY_MOST: Duration = Duration::from_secs(5);

/// The events after which an agent no longer waits on its harness.
const SETTLES: [&str; 4] = ["agent.ready", "agent.exited", "agent.lost", "agent.closing"];
/// The events after which an agent's process has gone, or is going.
const GONE: [&str; 3] = ["agent.exited", "agent.lost", "agent.closing"];

/// A sign of life the agent's own TUI gave while no start of it waited, kept for the start that
/// comes: a hook can come before its start is recorded.
#[derive(Debug, Clone)]
struct Remembered {
    sign: ReadySign,
    /// The newest event committed when it was kept: a start requested after it isn't its.
    stamp: u64,
    /// Who sent it, which the start's root process must have run.
    peer: Peer,
}

/// The signs of life kept for starts not yet recorded, by agent.
#[derive(Debug, Default)]
pub(crate) struct Signs {
    kept: StdMutex<HashMap<AgentId, Remembered>>,
}

impl Signs {
    fn kept(&self) -> MutexGuard<'_, HashMap<AgentId, Remembered>> {
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Keeps `sign`, which `peer` gave once `stamp` was the newest event, for the agent's next
    /// start; it replaces any kept before it.
    pub(crate) fn remember(&self, agent: &AgentId, sign: ReadySign, stamp: u64, peer: Peer) {
        self.kept()
            .insert(agent.clone(), Remembered { sign, stamp, peer });
    }

    /// Forgets the agent's sign kept before the event `before`, as its process went: one kept
    /// since is a newer process's.
    fn forget_before(&self, agent: &AgentId, before: u64) {
        let mut kept = self.kept();
        if kept.get(agent).is_some_and(|sign| sign.stamp < before) {
            kept.remove(agent);
        }
    }

    fn forget(&self, agent: &AgentId) {
        self.kept().remove(agent);
    }

    /// The agent's sign kept once its start was requested by the event `request`, which goes.
    fn take_since(&self, agent: &AgentId, request: Option<u64>) -> Option<Remembered> {
        let mut kept = self.kept();
        let since = kept
            .get(agent)
            .is_some_and(|sign| request.is_none_or(|request| sign.stamp >= request));
        since.then(|| kept.remove(agent)).flatten()
    }
}

/// What the follower reads the log through.
pub(crate) trait Source: Send {
    /// The newest event's id, then every start waiting on its harness, read after it.
    ///
    /// # Errors
    ///
    /// The store's, said.
    fn boot(&mut self) -> Result<(u64, Vec<Waiting>), String>;
    /// Up to `limit` events after `after`, oldest first.
    ///
    /// # Errors
    ///
    /// The store's, said.
    fn events(&mut self, after: u64, limit: u32) -> Result<Vec<StoredEvent>, String>;
}

/// The store, through a read connection opened for each read, as a route opens one.
#[derive(Debug)]
pub(crate) struct StoreSource {
    store: crate::writer::Writer,
}

impl StoreSource {
    pub(crate) fn new(store: crate::writer::Writer) -> Self {
        Self { store }
    }

    fn read<T>(
        &self,
        read: impl FnOnce(bazhen_store::Reads<'_>) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let reader = self.store.reader().map_err(|err| err.to_string())?;
        read(reader.reads()).map_err(|err| err.to_string())
    }
}

impl Source for StoreSource {
    fn boot(&mut self) -> Result<(u64, Vec<Waiting>), String> {
        self.read(|reads| Ok((reads.latest_event_id()?, reads.waiting_starts()?)))
    }

    fn events(&mut self, after: u64, limit: u32) -> Result<Vec<StoredEvent>, String> {
        self.read(|reads| reads.events(after, limit))
    }
}

/// What arming a start found.
enum Arming {
    /// Its agent no longer waits on its harness.
    Settled,
    /// A sign its TUI gave once the start was requested recorded it up.
    Ready,
    /// It waits on its harness.
    Waits,
}

/// A start timed for its deadline.
#[derive(Debug, Clone, Copy)]
struct Armed {
    start_id: u64,
    due: Instant,
}

/// The follower's state: where it has read to, and the starts it times.
struct Follower<S> {
    shared: Shared,
    source: S,
    deadline: Duration,
    cursor: u64,
    armed: HashMap<AgentId, Armed>,
}

/// Follows the committed events until `stop`, or until the store closes, timing each start that
/// waits on its harness for `deadline`, from those waiting at boot on.
pub(crate) async fn follow(
    shared: Shared,
    source: impl Source,
    deadline: Duration,
    stop: CancellationToken,
) {
    let mut committed = shared.store.committed();
    let mut follower = Follower {
        shared,
        source,
        deadline,
        cursor: 0,
        armed: HashMap::new(),
    };
    let mut retry = RETRY_FIRST;
    loop {
        // Marked first, so a commit during the boot's read wakes the tail below.
        committed.borrow_and_update();
        match follower.boot().await {
            Ok(()) => break,
            Err(err) => {
                tracing::warn!("bazhen: readiness can't read the starts waiting: {err}");
                if !wait(&stop, retry).await {
                    return;
                }
                retry = (retry * 2).min(RETRY_MOST);
            }
        }
    }
    let mut retry_at: Option<Instant> = None;
    let mut retry = RETRY_FIRST;
    loop {
        let due = follower.armed.values().map(|armed| armed.due).min();
        tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = sleep_until(due) => follower.fire_due().await,
            () = sleep_until(retry_at) => {
                retry_at = None;
                if let Err(err) = follower.catch_up().await {
                    tracing::warn!("bazhen: readiness can't read the events: {err}");
                    retry = (retry * 2).min(RETRY_MOST);
                    retry_at = Some(Instant::now() + retry);
                } else {
                    retry = RETRY_FIRST;
                }
            }
            changed = committed.changed(), if retry_at.is_none() => {
                if changed.is_err() {
                    return;
                }
                committed.borrow_and_update();
                if let Err(err) = follower.catch_up().await {
                    tracing::warn!("bazhen: readiness can't read the events: {err}");
                    retry_at = Some(Instant::now() + retry);
                }
            }
        }
    }
}

/// Waits `delay` unless `stop` comes first; whether it waited.
async fn wait(stop: &CancellationToken, delay: Duration) -> bool {
    tokio::select! {
        () = stop.cancelled() => false,
        () = tokio::time::sleep(delay) => true,
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

impl<S: Source> Follower<S> {
    /// Reads where the log ends, then arms each start waiting.
    async fn boot(&mut self) -> Result<(), String> {
        let (cursor, waiting) = self.source.boot()?;
        self.cursor = cursor;
        for start in waiting {
            self.arm(start.agent, start.start_id, &start.at).await;
        }
        Ok(())
    }

    /// Reads every event committed past the cursor, and hands each on.
    async fn catch_up(&mut self) -> Result<(), String> {
        loop {
            let page = self.source.events(self.cursor, PAGE)?;
            let read = page.len();
            for event in page {
                self.cursor = event.id;
                self.take(&event).await;
            }
            if read < PAGE as usize {
                return Ok(());
            }
        }
    }

    async fn take(&mut self, event: &StoredEvent) {
        if event.entity_type != "agent" {
            return;
        }
        let Some(agent) = AgentId::parse(&event.entity_id) else {
            tracing::warn!(
                "bazhen: readiness passes over event {}: its agent's id isn't one",
                event.id
            );
            return;
        };
        let kind = event.kind.as_str();
        if STARTS.contains(&kind) {
            self.arm(agent, event.id, &event.ts).await;
            return;
        }
        if SETTLES.contains(&kind) {
            self.armed.remove(&agent);
            self.shared.hooks.titles.unwatch(&agent);
        }
        let hooks = &self.shared.hooks;
        if GONE.contains(&kind) {
            hooks.limits.forget(&agent);
            hooks.signs.forget_before(&agent, event.id);
        }
        if kind == "agent.closed" {
            hooks.signs.forget(&agent);
        }
    }

    /// Times the start `start_id`, recorded at `at`, unless its agent no longer waits on its
    /// harness, or a sign its TUI gave once the start was requested says it is up already, when
    /// its queued mail is pushed. A start whose harness's TUI says in its title what it shows has
    /// its terminal watched.
    async fn arm(&mut self, agent: AgentId, start_id: u64, at: &str) {
        let signs = Arc::clone(&self.shared.hooks.signs);
        let id = agent.clone();
        let armed = self
            .shared
            .store
            .run(move |store| -> Result<Arming, bazhen_store::AppendError> {
                if !store.reads().waiting(id.as_str())? {
                    return Ok(Arming::Settled);
                }
                let request = store.reads().start_request(id.as_str(), start_id)?;
                let Some(kept) = signs.take_since(&id, request) else {
                    return Ok(Arming::Waits);
                };
                let binding = store.reads().agent_binding(id.as_str())?;
                let its =
                    binding.is_some_and(|b| crate::hooks::ran_from_pane(&b, Some(&kept.peer)));
                if !its {
                    return Ok(Arming::Waits);
                }
                let ready = store.write(|w| w.record_ready(&id, kept.sign))?;
                Ok(if ready.is_some() {
                    Arming::Ready
                } else {
                    Arming::Waits
                })
            })
            .await;
        match armed {
            Ok(Ok(Arming::Settled)) => {
                self.armed.remove(&agent);
            }
            Ok(Ok(Arming::Ready)) => {
                self.armed.remove(&agent);
                crate::mail::push_queued(&self.shared, &agent);
            }
            Ok(Ok(Arming::Waits)) => {
                let due = Instant::now() + self.left(at);
                watch_title(&self.shared, &agent).await;
                self.armed.insert(agent, Armed { start_id, due });
            }
            Ok(Err(err)) => {
                // The deadline's own check says whether the agent still waits.
                tracing::warn!(
                    "bazhen: readiness times agent {} without its kept sign: {err}",
                    agent.as_str()
                );
                let due = Instant::now() + self.left(at);
                watch_title(&self.shared, &agent).await;
                self.armed.insert(agent, Armed { start_id, due });
            }
            Err(_) => {}
        }
    }

    /// What is left of the deadline of a start recorded at `at`: none once it has passed, as for
    /// a start from before a restart. A time that can't be read leaves the whole deadline.
    fn left(&self, at: &str) -> Duration {
        let Ok(at) = at.parse::<jiff::Timestamp>() else {
            return self.deadline;
        };
        let deadline =
            jiff::SignedDuration::try_from(self.deadline).unwrap_or(jiff::SignedDuration::MAX);
        let due = at.checked_add(deadline).unwrap_or(jiff::Timestamp::MAX);
        let left = jiff::Timestamp::now().duration_until(due);
        Duration::try_from(left).unwrap_or(Duration::ZERO)
    }

    /// Tells the human of each start whose deadline has come, unless it has settled or they were
    /// told of it already. One that can't be told is timed again.
    async fn fire_due(&mut self) {
        let now = Instant::now();
        let due: Vec<(AgentId, Armed)> = self
            .armed
            .iter()
            .filter(|(_, armed)| armed.due <= now)
            .map(|(agent, armed)| (agent.clone(), *armed))
            .collect();
        for (agent, armed) in due {
            self.armed.remove(&agent);
            let summary = summary(&self.shared, self.deadline, &agent).await;
            let id = agent.clone();
            let told = self
                .shared
                .store
                .run(move |store| store.write(|w| w.stuck_starting(&id, armed.start_id, &summary)))
                .await;
            match told {
                Ok(Ok(_)) | Err(_) => {}
                Ok(Err(err)) => {
                    tracing::warn!(
                        "bazhen: readiness can't tell the human agent {} hasn't started; trying \
                         again in {} ms: {err}",
                        agent.as_str(),
                        self.deadline.as_millis()
                    );
                    let due = Instant::now() + self.deadline;
                    let start_id = armed.start_id;
                    self.armed.insert(agent, Armed { start_id, due });
                }
            }
        }
    }
}

/// Watches the terminal `agent` starts in, if its harness's TUI says in its title what it
/// shows.
async fn watch_title(shared: &Shared, agent: &AgentId) {
    let Some(agents) = shared.agents.clone() else {
        return;
    };
    let id = agent.clone();
    let found = shared
        .store
        .run(move |store| {
            let reads = store.reads();
            Ok::<_, rusqlite::Error>((
                reads.agent_terminal(id.as_str())?,
                reads.agent_binding(id.as_str())?,
            ))
        })
        .await;
    let (found, binding) = match found {
        Ok(Ok((Some(found), Some(binding)))) => (found, binding),
        Ok(Ok(_)) | Err(_) => return,
        Ok(Err(err)) => {
            tracing::warn!(
                "bazhen: readiness can't watch agent {}'s title: {err}",
                agent.as_str()
            );
            return;
        }
    };
    if !crate::titles::reads_titles(&agents, &binding.harness) {
        return;
    }
    let (Some(terminal), Some(generation)) = (found.terminal_id, found.generation) else {
        return;
    };
    let watch = crate::titles::Watch {
        agent: agent.clone(),
        generation,
    };
    shared.hooks.titles.watch(terminal, watch);
}

/// What the item says: the deadline, and the harness's hint, where it has one.
async fn summary(shared: &Shared, deadline: Duration, agent: &AgentId) -> String {
    let seconds = deadline.as_secs_f64().round();
    let said = format!(
        "Its harness hasn't shown it is up after {seconds} s. Look in its terminal for a \
         dialog to answer."
    );
    let id = agent.as_str().to_owned();
    let harness = shared
        .store
        .run(move |store| store.reads().agent_binding(&id))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
        .and_then(|binding| bazhen_protocol::agents::HarnessId::parse(&binding.harness));
    let hint = shared
        .agents
        .as_ref()
        .zip(harness)
        .and_then(|(agents, harness)| agents.harnesses().get(harness))
        .and_then(bazhen_harness::Harness::not_ready_hint);
    match hint {
        Some(hint) => format!("{said} {hint}"),
        None => said,
    }
}
