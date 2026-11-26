//! Each served harness's own server, for a harness that runs one: a channel to it, connected
//! while the daemon serves an agent on one of its sessions, and one task that hands each event the
//! channel tells to the hooks before it reads the next, so a request the server asks again on a
//! new connection lands ahead of what the connection says of its sessions.

use std::sync::Arc;
use std::time::Duration;

use bazhen_harness::{Bound, IngestContext, LaunchRequest, Report, RunPort, SessionRef};
use bazhen_protocol::agents::HarnessId;
use bazhen_protocol::ids::AgentId;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::channel::reconnect::{Channel, Event, FIRST_RETRY, Options};
use crate::channel::rpc::Inbound;
use crate::commands::Commands;
use crate::hooks::channel::served_on;
use crate::routes::Shared;
use crate::writer::Writer;

/// How many events a channel tells ahead of the task that reads them before it waits for it.
const QUEUE: usize = 256;

/// The most of a version a server names that is recorded, in bytes.
const VERSION_CAP: usize = 128;

/// The channel to each served harness's server, for the harnesses that run one.
#[derive(Debug, Default)]
pub(crate) struct Channels(Vec<(HarnessId, Channel)>);

impl Channels {
    pub(crate) fn get(&self, harness: HarnessId) -> Option<&Channel> {
        self.0
            .iter()
            .find_map(|(id, channel)| (*id == harness).then_some(channel))
    }
}

/// Starts a channel to the server of each harness `shared`'s agents run that has one, and its
/// task, both on `tracker` until `stop`, and hands the agents the channels to start theirs over:
/// once the agents are reconciled, so a channel picks up only the sessions still served. It
/// connects at once if the daemon serves an agent on one of its sessions; `run` runs the
/// harness's command that starts its server where none listens.
pub(crate) fn start(
    shared: &Shared,
    run: &Arc<Commands>,
    tracker: &TaskTracker,
    stop: &CancellationToken,
) {
    start_retrying(shared, run, tracker, stop, FIRST_RETRY);
}

/// [`start`], each channel first waiting `first_retry` to connect again once a connection ends.
fn start_retrying(
    shared: &Shared,
    run: &Arc<Commands>,
    tracker: &TaskTracker,
    stop: &CancellationToken,
    first_retry: Duration,
) {
    let Some(agents) = shared.agents.as_ref() else {
        return;
    };
    let mut channels = Vec::new();
    for harness in HarnessId::ALL {
        let Some(session) = agents
            .harnesses()
            .get(harness)
            .and_then(bazhen_harness::Harness::session)
        else {
            continue;
        };
        let (events, told) = mpsc::channel(QUEUE);
        let store = shared.store.clone();
        let options = Options {
            session,
            bound: Box::new(move || bound(&store, harness)),
            run: Arc::clone(run) as Arc<dyn RunPort>,
            events,
            first_retry,
        };
        channels.push((harness, Channel::start(options, tracker, stop.clone())));
        tracker.spawn(hear(shared.clone(), harness, told));
    }
    agents.serve(Channels(channels));
}

/// The agents the daemon serves on `harness`'s sessions, as its server picks each up again: on
/// the session it is bound to, with what its launch set that a pickup gives again. None while the
/// store can't be read, which the next connection reads again.
fn bound(store: &Writer, harness: HarnessId) -> Vec<Bound> {
    read_bound(store, harness).unwrap_or_else(|err| {
        tracing::warn!(
            "bazhen: the agents on {}'s sessions can't be read: {err}",
            harness.as_str()
        );
        Vec::new()
    })
}

fn read_bound(store: &Writer, harness: HarnessId) -> rusqlite::Result<Vec<Bound>> {
    let reader = store.reader()?;
    let reads = reader.reads();
    let mut bound = Vec::new();
    for id in reads.served_agents(harness)? {
        let (Some(agent), Some(launch)) = (AgentId::parse(&id), reads.agent_launch(&id)?) else {
            continue;
        };
        let Some(session) = launch.external_ref else {
            continue;
        };
        bound.push(Bound {
            agent,
            session,
            launch: LaunchRequest {
                cwd: launch.cwd,
                theme: launch.theme,
                instructions: None,
                instructions_file: None,
                instructions_changed: false,
                name: launch.name.filter(|name| !name.is_empty()),
                compact_window_tokens: launch.compact_window_tokens.map(u64::from),
            },
        });
    }
    Ok(bound)
}

/// Hands each event `harness`'s channel tells to the hooks, one at a time, until the channel ends.
async fn hear(shared: Shared, harness: HarnessId, mut told: mpsc::Receiver<Event>) {
    while let Some(event) = told.recv().await {
        if let Err(why) = heard(&shared, harness, event).await {
            tracing::warn!(
                "bazhen: what {}'s server said wasn't all applied: {why}",
                harness.as_str()
            );
        }
    }
}

async fn heard(shared: &Shared, harness: HarnessId, event: Event) -> Result<(), String> {
    match event {
        Event::Inbound { message, .. } => inbound(shared, harness, message).await,
        Event::Version(Some(version)) => recorded(shared, harness, version).await,
        // A server that names none leaves the last one recorded.
        Event::Version(None) => Ok(()),
        Event::Connected(observed) | Event::Disconnected(observed) => {
            shared.hooks.channel(shared, harness, observed).await
        }
    }
}

/// Records the version `harness`'s server answered a handshake on, when it isn't the last one
/// recorded: no more than its first [`VERSION_CAP`] bytes, as the server names what it likes.
async fn recorded(shared: &Shared, harness: HarnessId, mut version: String) -> Result<(), String> {
    let mut cap = VERSION_CAP.min(version.len());
    while !version.is_char_boundary(cap) {
        cap -= 1;
    }
    version.truncate(cap);
    shared
        .store
        .run(move |store| store.write(|w| w.record_harness_version(harness, &version)))
        .await
        .map_err(|err| err.to_string())?
        .map(|_| ())
        .map_err(|err| err.to_string())
}

/// Reads what the server sent through its harness, for the agent served on the session the
/// harness routes it to, and applies what it says. A request is left to the harness's own TUI,
/// which the server asks it of too.
async fn inbound(shared: &Shared, id: HarnessId, message: Inbound) -> Result<(), String> {
    let Some(harness) = shared.agents.as_ref().and_then(|a| a.harnesses().get(id)) else {
        return Ok(());
    };
    let (method, params, asked) = match message {
        Inbound::Notification { method, params } => (method, params, None),
        Inbound::Request { id, method, params } => {
            (method, params, Some(Value::from(id).to_string()))
        }
    };
    let params = params.unwrap_or(Value::Null).to_string();
    let report = match &asked {
        None => Report::Notification {
            method: &method,
            params: params.as_bytes(),
        },
        Some(asked) => Report::ServerRequest {
            method: &method,
            params: params.as_bytes(),
            id: asked,
        },
    };
    let session = harness.route(&report);
    let agent = match &session {
        Some(session) => served_on(shared, id, session).await?,
        None => None,
    };
    let bound_to = match &agent {
        Some(agent) => session_of(shared, agent).await?,
        None => None,
    };
    let context = IngestContext {
        agent: agent.as_ref(),
        offered: &[],
        session: bound_to.as_ref(),
    };
    let ingested = harness.ingest(report, &context);
    shared.hooks.channel(shared, id, ingested.observed).await
}

/// The session `agent` is bound to, as its stored external ref names it.
async fn session_of(shared: &Shared, agent: &AgentId) -> Result<Option<SessionRef>, String> {
    let agent = agent.clone();
    let binding = shared
        .store
        .run(move |store| store.reads().agent_binding(agent.as_str()))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    Ok(binding.and_then(|b| b.session).map(|session| SessionRef {
        kind: session.kind,
        id: session.id,
    }))
}

#[cfg(test)]
mod tests;
