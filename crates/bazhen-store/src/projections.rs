//! The read models each event changes, applied inside the transaction that records it. A type
//! gets its projection here in the change that first appends it.

use bazhen_protocol::ids::Id;
use rusqlite::Transaction;

use crate::events::{AppendError, NewEvent, int};

pub(crate) fn project(tx: &Transaction<'_>, id: u64, event: &NewEvent) -> Result<(), AppendError> {
    match event {
        NewEvent::TaskCreated { task, payload, .. } => {
            tx.execute(
                "INSERT INTO tasks (id, title, brief, state, owner_agent_id, parent_task_id,
                   delegated_from, created_event_id, updated_event_id)
                 VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)",
                (
                    task.as_str(),
                    &payload.title,
                    &payload.brief,
                    payload.owner_agent_id.as_ref().map(Id::as_str),
                    payload.parent_task_id.as_ref().map(Id::as_str),
                    payload.delegated_from.as_ref().map(Id::as_str),
                    int(id)?,
                    int(id)?,
                ),
            )?;
        }
    }
    Ok(())
}
