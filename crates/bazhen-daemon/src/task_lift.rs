//! Moves each subtask whose owner no longer holds it up to its parent's owner (`liftStranded`),
//! in the write that stranded it: an unassign's, a finish's, a close's, and once at start for
//! what a store was left holding.

use std::sync::Arc;

use bazhen_harness::Harnesses;
use bazhen_protocol::mail::AttentionKind;
use bazhen_protocol::mail_events::AttentionOpened;
use bazhen_store::{Stranded, Writer as StoreWriter};

use crate::agents::Agents;
use crate::mail::{Queued, Sending};
use crate::task_mail::{fell_to_the_human, owned_mail};
use crate::task_verbs::{Tell, reachable, tell};

/// What a lift did.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Lifted {
    /// The owner changes, and the mail that told the new owners.
    pub(crate) event_ids: Vec<u64>,
    /// It stopped at its bound with subtasks still stranded, which no tree of tasks can leave.
    pub(crate) outran: bool,
}

/// Moves every stranded subtask up a level, and again, until none is left, mailing each new
/// owner. A move can strand the level below, but each pass lifts one
/// level, so it ends within as many passes as there are open tasks, and one more finds none left.
///
/// # Errors
///
/// A read or an append that failed, or mail refused other than for an agent that takes none now;
/// the write is rolled back then.
pub(crate) fn lift_stranded(
    w: &StoreWriter<'_>,
    harnesses: &Harnesses,
    fresh: &mut Vec<Queued>,
) -> Result<Lifted, Sending> {
    let bound = w.reads().open_task_count()?.saturating_add(1);
    let mut event_ids = Vec::new();
    let ended = passes(bound, || {
        let stranded = w.reads().stranded()?;
        for lifted in &stranded {
            event_ids.extend(lift(w, harnesses, lifted, fresh)?);
        }
        Ok::<_, Sending>(!stranded.is_empty())
    })?;
    Ok(Lifted {
        event_ids,
        outran: !ended,
    })
}

/// Runs `pass` until a pass does nothing, at most `bound` times; answers whether one did nothing.
fn passes<E>(bound: u64, mut pass: impl FnMut() -> Result<bool, E>) -> Result<bool, E> {
    for _ in 0..bound {
        if !pass()? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Moves one subtask up. An owner that is gone can't take it, so it falls to the human rather
/// than up a tree whose other owners' standing nothing has checked, and the agent that delegated
/// it is escalated to the human.
fn lift(
    w: &StoreWriter<'_>,
    harnesses: &Harnesses,
    lifted: &Stranded,
    fresh: &mut Vec<Queued>,
) -> Result<Vec<u64>, Sending> {
    let reads = w.reads();
    let task = reads
        .task(&lifted.task_id)?
        .ok_or_else(|| Sending::Internal(format!("no task {}", lifted.task_id)))?;
    let owner = match &lifted.owner_agent_id {
        Some(owner) if reachable(reads, owner)? => Some(owner.clone()),
        _ => None,
    };
    let delegated_from = owner.as_ref().and(lifted.delegated_from.clone());
    let moved = w.change_owner(&lifted.task_id, owner.clone(), delegated_from)?;
    let mut event_ids = vec![moved];
    match owner {
        Some(owner) => {
            let to = vec![Tell {
                body: owned_mail(&task),
                agent: owner,
            }];
            event_ids.extend(tell(w, harnesses, to, None, fresh)?);
        }
        None => {
            if let Some(previous) = &task.owner_agent_id {
                w.open_attention(AttentionOpened {
                    agent_id: previous.clone(),
                    summary: fell_to_the_human(&task, previous),
                    kind: Some(AttentionKind::Escalation),
                    task_id: Some(task.id.as_str().to_owned()),
                    message_id: None,
                    tool_use_id: None,
                    main_agent: true,
                })?;
            }
        }
    }
    Ok(event_ids)
}

/// Lifts what the store was left holding stranded, before the daemon takes any command: by a
/// daemon that stopped between writes of its own, or one that didn't lift in each. Its mail waits
/// on the channel until the drain starts. A lift that fails, or outruns its bound, is logged, and
/// the daemon starts all the same: what it lifted is kept.
pub(crate) async fn at_start(store: &crate::writer::Writer, agents: &Arc<Agents>) {
    let run = Arc::clone(agents);
    let lifted = store
        .run(move |store| {
            let mut queued = Vec::new();
            let lifted = store.write(|w| lift_stranded(w, run.harnesses(), &mut queued))?;
            Ok::<_, Sending>((lifted, queued))
        })
        .await;
    match lifted {
        Ok(Ok((lifted, queued))) => {
            agents.hand(queued);
            if lifted.outran {
                tracing::warn!("bazhen: subtasks are still stranded after lifting every level");
            }
        }
        Ok(Err(err)) => tracing::warn!("bazhen: stranded subtasks weren't lifted at start: {err}"),
        Err(err) => tracing::warn!("bazhen: stranded subtasks weren't lifted at start: {err}"),
    }
}

#[cfg(test)]
mod tests;
