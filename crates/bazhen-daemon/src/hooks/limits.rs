//! Whether a turn its harness says the account's limit may have stopped is `limited`
//! (`limits.ts`), against the usage limits the harness last reported. `limited` says the agent
//! waits for a window to reset, so it takes a window used up and not yet reset, as only the
//! harness's meter shows. A `rate` stop without one stays failed: a passing 429 looks the same,
//! and so does any 429 from a harness that reports no meter. A `quota` stop is the account's
//! usage limit by the harness's own word, so it is limited with or without a window, and resets
//! when that window does.
//!
//! A window counts as used up only with a reset still to come. One that gives no reset, or whose
//! reset has passed, may be stale: a merged window keeps its last reading until an update names
//! it again, and one the harness has renamed is never named again.
//!
//! The meter can be read after the stop it explains, so the agent's latest stop is weighed again
//! at each change of its usage, for [`LATE_READING`], while what is recorded is still that stop.
//! Weighed again, it records only a window used up: a later reading that shows none, as another
//! turn's on the same account may, says nothing of what stopped this one.
//!
//! Each call runs in the store writer's transaction, so the usage it reads, and the activity it
//! weighs again, are what that transaction sees.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex as StdMutex, MutexGuard, PoisonError};

use bazhen_harness::LimitStop;
use bazhen_protocol::agents::{Activity, ActivityValue, USAGE_LIMITS_MAX, Usage, UsageLimit};
use bazhen_protocol::ids::AgentId;
use bazhen_store::AppendError;
use jiff::{SignedDuration, Timestamp};

/// How long after a stop a reading of the meter is still about it. A harness reports its meter
/// within moments of the turn that read it; a reading later than this is about the account since,
/// and so, on an account another agent shares, about that agent's turns.
pub(crate) const LATE_READING: SignedDuration = SignedDuration::from_mins(5);

/// An agent's latest stop.
#[derive(Debug, Clone)]
struct Stop {
    /// What the harness reported.
    activity: Activity,
    /// What was recorded of it.
    recorded: Activity,
    at: Timestamp,
}

/// Each agent's latest stop, while it may still be weighed again.
#[derive(Debug, Default)]
pub(crate) struct Limits {
    stops: StdMutex<HashMap<AgentId, Stop>>,
}

impl Limits {
    fn stops(&self) -> MutexGuard<'_, HashMap<AgentId, Stop>> {
        self.stops.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records what the agent's harness reports it doing at `now`, `limited` when `limit` says
    /// the account's limit may have stopped it and its usage shows it. Answers the event's id,
    /// none when the store recorded nothing.
    ///
    /// # Errors
    ///
    /// The store's.
    pub(crate) fn record(
        &self,
        w: &bazhen_store::Writer<'_>,
        agent: &AgentId,
        activity: Activity,
        limit: Option<LimitStop>,
        now: Timestamp,
    ) -> Result<Option<u64>, AppendError> {
        let Some(limit) = limit else {
            self.stops().remove(agent);
            return w.record_activity(agent, &activity);
        };
        let usage = w.reads().agent_usage(agent.as_str())?;
        let resets = reset_of(usage.as_ref(), now);
        let recorded = if resets.is_none() && limit == LimitStop::Rate {
            activity.clone()
        } else {
            limited(&activity, resets)
        };
        let id = w.record_activity(agent, &recorded)?;
        // A stop the store refused, as for an agent whose process has gone, is not held.
        if id.is_some() {
            let stop = Stop {
                activity,
                recorded,
                at: now,
            };
            self.stops().insert(agent.clone(), stop);
        }
        Ok(id)
    }

    /// Records the usage the agent's harness reports at `now`, which may show why its latest
    /// turn stopped.
    ///
    /// # Errors
    ///
    /// The store's.
    pub(crate) fn usage(
        &self,
        w: &bazhen_store::Writer<'_>,
        agent: &AgentId,
        usage: &Usage,
        now: Timestamp,
    ) -> Result<(), AppendError> {
        if w.record_usage(agent, usage)?.is_some() {
            self.reweigh(w, agent, usage, now)?;
        }
        Ok(())
    }

    /// Records an update of an account's limits, at `now`, for each agent on it. The update is
    /// sparse: a window it leaves out keeps what was last said of it.
    ///
    /// # Errors
    ///
    /// The store's.
    pub(crate) fn account_limits(
        &self,
        w: &bazhen_store::Writer<'_>,
        agents: &[AgentId],
        update: &[UsageLimit],
        now: Timestamp,
    ) -> Result<(), AppendError> {
        for agent in agents {
            let held = w.reads().agent_usage(agent.as_str())?;
            let usage = match held {
                Some(held) => Usage {
                    limits: Some(merge_limits(held.limits.as_deref(), update)),
                    ..held
                },
                None => Usage {
                    model: None,
                    context_used_percent: None,
                    context_window_tokens: None,
                    limits: Some(merge_limits(None, update)),
                },
            };
            self.usage(w, agent, &usage, now)?;
        }
        Ok(())
    }

    /// Forgets the agent's stop, as its process has gone.
    pub(crate) fn forget(&self, agent: &AgentId) {
        self.stops().remove(agent);
    }

    fn reweigh(
        &self,
        w: &bazhen_store::Writer<'_>,
        agent: &AgentId,
        usage: &Usage,
        now: Timestamp,
    ) -> Result<(), AppendError> {
        let Some(stop) = self.stops().get(agent).cloned() else {
            return Ok(());
        };
        if stop.at.duration_until(now) > LATE_READING {
            self.stops().remove(agent);
            return Ok(());
        }
        let Some(resets) = reset_of(Some(usage), now) else {
            return Ok(());
        };
        // An activity recorded since says the agent went on: the stop no longer stands.
        let latest = w.reads().latest_activity(agent.as_str())?;
        let stands = latest.is_some_and(|latest| {
            latest.value == stop.recorded.value
                && latest.source == stop.recorded.source
                && latest.detail == stop.recorded.detail
        });
        if !stands {
            self.stops().remove(agent);
            return Ok(());
        }
        let observed = Activity {
            observed_at: format!("{now:.3}"),
            ..stop.activity.clone()
        };
        let again = limited(&observed, Some(resets));
        if w.record_activity(agent, &again)?.is_some()
            && let Some(held) = self.stops().get_mut(agent)
        {
            held.recorded = again;
        }
        Ok(())
    }
}

fn limited(activity: &Activity, resets_at: Option<String>) -> Activity {
    Activity {
        value: ActivityValue::Limited,
        resets_at,
        ..activity.clone()
    }
}

/// The latest reset of the usage's windows that are used up, as it was given, or none when none
/// is: compared as times, not as text, which orders two offsets or precisions wrongly.
pub(crate) fn reset_of(usage: Option<&Usage>, now: Timestamp) -> Option<String> {
    usage?
        .limits
        .iter()
        .flatten()
        .filter(|limit| limit.used_percent >= 100.0)
        .filter_map(|limit| {
            let resets = limit.resets_at.as_ref()?;
            let at = resets.parse::<Timestamp>().ok().filter(|at| *at > now)?;
            Some((at, resets))
        })
        .max_by_key(|(at, _)| *at)
        .map(|(_, resets)| resets.clone())
}

/// The usage limits held, with those an update names replaced and those it leaves out kept, in
/// the order held, then those it names first, in its order. A window it names twice is held as it
/// last names it. Past the most usage holds, those it leaves out go first, the one held first
/// first. An update that alone names as many keeps only the first it names, in its order.
pub(crate) fn merge_limits(held: Option<&[UsageLimit]>, update: &[UsageLimit]) -> Vec<UsageLimit> {
    let mut last: HashMap<&str, &UsageLimit> = HashMap::new();
    let mut first_named: Vec<&str> = Vec::new();
    for limit in update {
        if last.insert(&limit.window, limit).is_none() {
            first_named.push(&limit.window);
        }
    }
    let said = |window: &&str| last.get(window).map(|limit| (*limit).clone());
    if first_named.len() >= USAGE_LIMITS_MAX {
        return first_named
            .iter()
            .take(USAGE_LIMITS_MAX)
            .filter_map(said)
            .collect();
    }
    let held = held.unwrap_or_default();
    let known: HashSet<&str> = held.iter().map(|limit| limit.window.as_str()).collect();
    let merged: Vec<(bool, UsageLimit)> = held
        .iter()
        .map(|limit| match said(&limit.window.as_str()) {
            Some(named) => (true, named),
            None => (false, limit.clone()),
        })
        .chain(
            first_named
                .iter()
                .filter(|window| !known.contains(*window))
                .filter_map(said)
                .map(|named| (true, named)),
        )
        .collect();
    let mut over = merged.len().saturating_sub(USAGE_LIMITS_MAX);
    merged
        .into_iter()
        .filter(|(named, _)| {
            if *named || over == 0 {
                return true;
            }
            over -= 1;
            false
        })
        .map(|(_, limit)| limit)
        .collect()
}
