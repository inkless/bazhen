//! The titles of starting agents' terminals, for a harness whose TUI says in its title what it
//! shows ([`ReadySource::Title`]). While such a start waits on its harness its terminal is
//! watched: its title is read as the start is timed, and again each time the runtime tells it
//! may have changed, or that events were missed. Each read goes to the agent's harness, and a
//! sign of life records the agent up, only while the process that set the title is still the
//! agent's. Nothing is kept of a title: one set before its start, or by another process, records
//! nothing.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use bazhen_harness::{IngestContext, Observed, ReadySource, Report, SessionRef};
use bazhen_protocol::agent_events::ReadySign;
use bazhen_protocol::agents::HarnessId;
use bazhen_protocol::ids::{AgentId, TerminalId};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::agents::Agents;
use crate::routes::Shared;
use crate::terminals::{Recorded, TerminalError};

/// How many times a title that couldn't be read, though its terminal still runs, is read again.
const RETRIES: u32 = 3;

/// The wait before a title is read again, doubled each time after.
const RETRY_AFTER: Duration = Duration::from_millis(250);

/// The start a watched terminal's title is read for: its agent's process at `generation`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Watch {
    pub(crate) agent: AgentId,
    pub(crate) generation: u64,
}

#[derive(Debug, Default)]
struct State {
    watched: HashMap<TerminalId, Watch>,
    /// The watched terminals whose title is to be read.
    due: HashSet<TerminalId>,
    /// Events were missed: every watched terminal's title is to be read. It stays set until the
    /// reader takes it.
    missed: bool,
}

/// The terminals watched, and those due a read.
#[derive(Debug, Default)]
pub(crate) struct Titles {
    state: StdMutex<State>,
    due: Notify,
}

impl Titles {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Watches `terminal` for `watch`'s start, in place of any the agent had, and reads its
    /// title. It is watched before it is read, so a title set while it is read is read again.
    pub(crate) fn watch(&self, terminal: TerminalId, watch: Watch) {
        let mut state = self.state();
        state.watched.retain(|_, w| w.agent != watch.agent);
        state.watched.insert(terminal.clone(), watch);
        state.due.insert(terminal);
        drop(state);
        self.due.notify_one();
    }

    /// The agent's start no longer waits on its harness: its terminal isn't watched.
    pub(crate) fn unwatch(&self, agent: &AgentId) {
        self.state().watched.retain(|_, w| &w.agent != agent);
    }

    /// The runtime told `terminal`'s title may have changed: read it, if it is watched.
    pub(crate) fn told(&self, terminal: &TerminalId) {
        let mut state = self.state();
        if !state.watched.contains_key(terminal) {
            return;
        }
        state.due.insert(terminal.clone());
        drop(state);
        self.due.notify_one();
    }

    /// Whether `terminal` is still watched for `watch`'s start.
    fn watches(&self, terminal: &TerminalId, watch: &Watch) -> bool {
        self.state().watched.get(terminal) == Some(watch)
    }

    /// The runtime missed events: read every watched terminal's title.
    pub(crate) fn missed(&self) {
        self.state().missed = true;
        self.due.notify_one();
    }

    /// The watched terminals due a read, each with the start it is read for, once there are any.
    async fn next(&self) -> Vec<(TerminalId, Watch)> {
        loop {
            // A notify given while no one waits is kept for the next wait.
            let notified = self.due.notified();
            {
                let mut state = self.state();
                let due: Vec<TerminalId> = if std::mem::take(&mut state.missed) {
                    state.due.clear();
                    state.watched.keys().cloned().collect()
                } else {
                    state.due.drain().collect()
                };
                let due: Vec<(TerminalId, Watch)> = due
                    .into_iter()
                    .filter_map(|t| state.watched.get(&t).cloned().map(|w| (t, w)))
                    .collect();
                if !due.is_empty() {
                    return due;
                }
            }
            notified.await;
        }
    }
}

/// Whether `harness`'s TUI says in its terminal's title what it shows.
pub(crate) fn reads_titles(agents: &Agents, harness: &str) -> bool {
    HarnessId::parse(harness)
        .and_then(|id| agents.harnesses().get(id))
        .is_some_and(|h| h.capabilities().ready == ReadySource::Title)
}

/// Reads each watched terminal's title as it comes due, until `stop`: each read on the agents'
/// tracker, so a slow holder holds up no other. A title that can't be read while its terminal
/// still runs is read again, after a wait that doubles, while its terminal is watched.
pub(crate) async fn follow(shared: Shared, stop: CancellationToken) {
    let Some(agents) = shared.agents.clone() else {
        return;
    };
    let titles = Arc::clone(&shared.hooks.titles);
    while let Some(due) = stop.run_until_cancelled(titles.next()).await {
        for (terminal, watch) in due {
            let shared = shared.clone();
            let run = Arc::clone(&agents);
            let stop = stop.clone();
            agents.spawn(async move {
                let (mut wait, mut tries) = (RETRY_AFTER, 0);
                loop {
                    let Err(err) = read_one(&shared, &run, &terminal, &watch).await else {
                        return;
                    };
                    let titles = &shared.hooks.titles;
                    if !err.again || tries == RETRIES || !titles.watches(&terminal, &watch) {
                        tracing::warn!(
                            "bazhen: agent {}'s terminal title can't be read: {}",
                            watch.agent.as_str(),
                            err.message
                        );
                        return;
                    }
                    if stop
                        .run_until_cancelled(tokio::time::sleep(wait))
                        .await
                        .is_none()
                    {
                        return;
                    }
                    (wait, tries) = (wait * 2, tries + 1);
                }
            });
        }
    }
}

/// Why a title wasn't read: `again` when reading it again may work, as its terminal still runs.
#[derive(Debug)]
struct Unread {
    message: String,
    again: bool,
}

impl Unread {
    fn again(err: &impl ToString) -> Self {
        Self {
            message: err.to_string(),
            again: true,
        }
    }
}

impl From<TerminalError> for Unread {
    fn from(err: TerminalError) -> Self {
        let again = !matches!(err, TerminalError::Gone(_) | TerminalError::Stale(_));
        Self {
            message: err.to_string(),
            again,
        }
    }
}

/// Reads `terminal`'s title for `watch`'s start, and hands it to the agent's harness: a sign of
/// life records the agent up, in the write that finds the process that set the title still the
/// agent's, then its queued mail is pushed.
async fn read_one(
    shared: &Shared,
    agents: &Agents,
    terminal: &TerminalId,
    watch: &Watch,
) -> Result<(), Unread> {
    let id = watch.agent.clone();
    let (found, binding) = shared
        .store
        .run(move |store| {
            let reads = store.reads();
            Ok::<_, rusqlite::Error>((
                reads.agent_terminal(id.as_str())?,
                reads.agent_binding(id.as_str())?,
            ))
        })
        .await
        .map_err(|err| Unread::again(&err))?
        .map_err(|err| Unread::again(&err))?;
    let (Some(found), Some(binding)) = (found, binding) else {
        return Ok(());
    };
    let Some(locator) = found
        .locator
        .filter(|_| found.terminal_id.as_ref() == Some(terminal))
    else {
        return Ok(());
    };
    let recorded = Recorded {
        terminal_id: terminal.clone(),
        locator,
    };
    let (generation, title) = agents.terminals().title(&recorded).await?;
    let Some(harness) = crate::mail::harness_of(agents.harnesses(), &binding.harness) else {
        return Ok(());
    };
    let session = binding.session.map(|s| SessionRef {
        kind: s.kind,
        id: s.id,
    });
    let ingested = harness.ingest(
        Report::TerminalTitle { title: &title },
        &IngestContext {
            agent: Some(&watch.agent),
            offered: &[],
            session: session.as_ref(),
        },
    );
    let Some(sign) = ingested.observed.iter().find_map(|keyed| match keyed.fact {
        Observed::Ready { sign } => Some(sign),
        _ => None,
    }) else {
        return Ok(());
    };
    if ready_at(shared, &watch.agent, terminal, generation, sign)
        .await
        .map_err(|err| Unread::again(&err))?
    {
        shared.hooks.titles.unwatch(&watch.agent);
        crate::mail::push_queued(shared, &watch.agent);
    }
    Ok(())
}

/// Records `agent` up on `sign`, if it still starts in `terminal` at `generation`; whether it did.
async fn ready_at(
    shared: &Shared,
    agent: &AgentId,
    terminal: &TerminalId,
    generation: u64,
    sign: ReadySign,
) -> Result<bool, String> {
    let (agent, terminal) = (agent.clone(), terminal.clone());
    let recorded = shared
        .store
        .run(move |store| {
            store.write(|w| {
                let now = w.reads().agent_terminal(agent.as_str())?;
                let its = now.is_some_and(|now| {
                    now.terminal_id.as_ref() == Some(&terminal)
                        && now.generation == Some(generation)
                });
                if !its {
                    return Ok(None);
                }
                w.record_ready(&agent, sign)
            })
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    Ok(recorded.is_some())
}

#[cfg(test)]
mod tests;
