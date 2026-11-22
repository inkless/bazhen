//! The read models each event changes, applied inside the transaction that records it. A type
//! gets its projection here in the change that first appends it.

use bazhen_protocol::ids::Id;
use bazhen_protocol::tasks::{is_task_brief, is_task_title};
use rusqlite::{OptionalExtension, Transaction};

use crate::events::{AppendError, NewEvent, int};
use crate::terminals;

/// The event being applied: its id, when it was recorded, and the host that recorded it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct At<'a> {
    pub(crate) id: u64,
    pub(crate) ts: &'a str,
    pub(crate) host: &'a str,
}

pub(crate) fn project(
    tx: &Transaction<'_>,
    at: &At<'_>,
    event: &NewEvent,
) -> Result<(), AppendError> {
    let id = at.id;
    match event {
        NewEvent::TaskCreated { task, payload, .. } => {
            // As the TypeScript projection parses it: a title or brief it would refuse is a bug in
            // whatever appended it, and nothing of it is recorded.
            if !is_task_title(&payload.title) || !is_task_brief(&payload.brief) {
                return Err(AppendError::Refused {
                    event: event.name(),
                    reason: "its title or brief isn't one a task holds".to_owned(),
                });
            }
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
        // The devices table carries the token's hash, which no event may, so the store writes it
        // beside these events rather than from them.
        NewEvent::DevicePaired { .. } | NewEvent::DeviceRevoked { .. } => {}
        NewEvent::NoticeOpened { notice, payload } => {
            let device = payload.device.as_ref();
            tx.execute(
                "INSERT INTO notices (id, kind, state, summary, device_id, device_name,
                   device_origin, device_address, created_event_id, updated_event_id)
                 VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)",
                (
                    notice.as_str(),
                    &payload.kind,
                    &payload.summary,
                    device.map(|d| d.id.as_str()),
                    device.map(|d| d.name.as_str()),
                    device.map(|d| d.origin.as_str()),
                    device.and_then(|d| d.address.as_deref()),
                    int(id)?,
                    int(id)?,
                ),
            )?;
        }
        NewEvent::NoticeClosed { notice, payload } => {
            // A notice closes once, as packages/core's machine has it: a dismissal after a
            // revocation, or the reverse, is refused.
            let state: Option<String> = tx
                .query_row(
                    "SELECT state FROM notices WHERE id = ?",
                    [notice.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            match state.as_deref() {
                Some("open") => {}
                Some(state) => {
                    return Err(AppendError::Refused {
                        event: event.name(),
                        reason: format!("the notice is {state}"),
                    });
                }
                None => {
                    return Err(AppendError::Refused {
                        event: event.name(),
                        reason: format!("no notice {}", notice.as_str()),
                    });
                }
            }
            tx.execute(
                "UPDATE notices SET state = 'closed', close_reason = ?, closed_by = ?,
                   closed_from_device = ?, updated_event_id = ? WHERE id = ?",
                (
                    payload.reason.as_str(),
                    payload.by.as_str(),
                    payload.from_device.as_ref().map(Id::as_str),
                    int(id)?,
                    notice.as_str(),
                ),
            )?;
        }
        NewEvent::EnvironmentRegistered {
            environment,
            payload,
        } => {
            tx.execute(
                "INSERT INTO environments (id, kind, created_event_id) VALUES (?, ?, ?)",
                (environment.as_str(), payload.kind.as_str(), int(id)?),
            )?;
        }
        NewEvent::Terminal {
            terminal, change, ..
        } => terminals::project(tx, at, terminal, change)?,
    }
    Ok(())
}
