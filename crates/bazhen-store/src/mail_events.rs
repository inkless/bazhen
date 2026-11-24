//! The mail and attention events as the TypeScript store projects them: a message's queue and
//! delivery, a message one agent sent another through its harness, and an item for the human.
//! Each move goes through bazhen-core's machine, and one it doesn't take is refused.

use bazhen_core::attention;
use bazhen_core::mail::{self, MailboxEvent};
use bazhen_protocol::ids::Id;
use bazhen_protocol::mail::{AttentionCloseReason, AttentionKind, AttentionState, MailboxState};
use bazhen_protocol::mail_events::{
    AttentionAnswered, AttentionClosed, AttentionOpened, MailAccepted, MailOffered, MailQueued,
    MailRequeued, MailSeen, MailUndeliverable, MessageObserved, UndeliverableReason,
};
use rusqlite::types::Value;
use rusqlite::{OptionalExtension, Transaction};

use crate::agent_events::update;
use crate::events::{AppendError, int};
use crate::projections::At;

/// A change to a message in an agent's mailbox.
#[derive(Debug, Clone, PartialEq)]
pub enum MailChange {
    Queued(MailQueued),
    Offered(MailOffered),
    Emitted,
    Seen(MailSeen),
    Delivered,
    Accepted(MailAccepted),
    Undeliverable(MailUndeliverable),
    Requeued(MailRequeued),
}

/// A change to an item for the human.
#[derive(Debug, Clone, PartialEq)]
pub enum AttentionChange {
    Opened(AttentionOpened),
    Answered(AttentionAnswered),
    Closed(AttentionClosed),
}

/// The payload of an event that carries none.
#[derive(serde::Serialize)]
struct Empty {}

impl MailChange {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Queued(_) => "mailbox.queued",
            Self::Offered(_) => "mailbox.offered",
            Self::Emitted => "mailbox.emitted",
            Self::Seen(_) => "mailbox.seen",
            Self::Delivered => "mailbox.delivered",
            Self::Accepted(_) => "mailbox.accepted",
            Self::Undeliverable(_) => "mailbox.undeliverable",
            Self::Requeued(_) => "mailbox.requeued",
        }
    }

    pub(crate) fn payload(&self) -> serde_json::Result<String> {
        match self {
            Self::Queued(p) => serde_json::to_string(p),
            Self::Offered(p) => serde_json::to_string(p),
            Self::Seen(p) => serde_json::to_string(p),
            Self::Accepted(p) => serde_json::to_string(p),
            Self::Undeliverable(p) => serde_json::to_string(p),
            Self::Requeued(p) => serde_json::to_string(p),
            Self::Emitted | Self::Delivered => serde_json::to_string(&Empty {}),
        }
    }
}

impl AttentionChange {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Opened(_) => "attention.opened",
            Self::Answered(_) => "attention.answered",
            Self::Closed(_) => "attention.closed",
        }
    }

    pub(crate) fn payload(&self) -> serde_json::Result<String> {
        match self {
            Self::Opened(p) => serde_json::to_string(p),
            Self::Answered(p) => serde_json::to_string(p),
            Self::Closed(p) => serde_json::to_string(p),
        }
    }
}

fn refused(event: &'static str) -> impl Fn(String) -> AppendError {
    move |reason| AppendError::Refused { event, reason }
}

pub(crate) fn project_mail(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    change: &MailChange,
) -> Result<(), AppendError> {
    let moving = |event, columns: &[(&'static str, Value)]| {
        move_message(tx, at, id, change.name(), event, columns)
    };
    match change {
        MailChange::Queued(payload) => {
            tx.execute(
                "INSERT INTO mailbox (id, agent_session_id, from_agent_id, body, state,
                   created_event_id, updated_event_id)
                 VALUES (?, ?, ?, ?, 'queued', ?, ?)",
                (
                    id,
                    payload.agent_id.as_str(),
                    payload.from.as_ref().map(Id::as_str),
                    &payload.body,
                    int(at.id)?,
                    int(at.id)?,
                ),
            )?;
            Ok(())
        }
        MailChange::Offered(payload) => {
            let prompt = payload.prompt_id.clone().map_or(Value::Null, Value::Text);
            moving(MailboxEvent::Offer, &[("prompt_id", prompt)])?;
            tx.execute(
                "UPDATE mailbox SET first_offered_event_id = coalesce(first_offered_event_id, ?)
                 WHERE id = ?",
                (int(at.id)?, id),
            )?;
            Ok(())
        }
        MailChange::Emitted => moving(MailboxEvent::Ack, &[]),
        MailChange::Seen(payload) => moving(
            MailboxEvent::Seen,
            &[("prompt_id", Value::Text(payload.prompt_id.clone()))],
        ),
        MailChange::Delivered => moving(MailboxEvent::Confirm, &[]),
        MailChange::Accepted(_) => moving(MailboxEvent::Accept, &[]),
        MailChange::Undeliverable(payload) => moving(
            match payload.reason {
                UndeliverableReason::AgentClosed => MailboxEvent::AgentClosed,
                UndeliverableReason::GaveUp => MailboxEvent::GiveUp,
            },
            &[],
        ),
        MailChange::Requeued(payload) => {
            moving(MailboxEvent::Requeue, &[("prompt_id", Value::Null)])?;
            if payload.reason.is_agent_failure() {
                tx.execute(
                    "UPDATE mailbox SET failures = failures + 1 WHERE id = ?",
                    [id],
                )?;
            }
            Ok(())
        }
    }
}

/// Moves a message by `event`, recording the event it first settled at.
fn move_message(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    name: &'static str,
    event: MailboxEvent,
    columns: &[(&'static str, Value)],
) -> Result<(), AppendError> {
    let refuse = refused(name);
    let state: Option<String> = tx
        .query_row("SELECT state FROM mailbox WHERE id = ?", [id], |row| {
            row.get(0)
        })
        .optional()?;
    let state = state.ok_or_else(|| refuse(format!("no message {id}")))?;
    let was: MailboxState = serde_json::from_value(serde_json::Value::String(state))?;
    let to = mail::next(was, event).map_err(|e| refuse(e.to_string()))?;
    let mut set = vec![("state", Value::Text(to.as_str().to_owned()))];
    if to.settled() && !was.settled() {
        set.push(("settled_event_id", Value::Integer(int(at.id)?)));
    }
    set.extend_from_slice(columns);
    update(tx, at, "mailbox", id, &set)
}

pub(crate) fn project_observed(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    payload: &MessageObserved,
) -> Result<(), AppendError> {
    tx.execute(
        "INSERT INTO observed_messages
           (id, from_agent_id, to_agent_id, summary, accepted, tool_use_id, created_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            id,
            payload.from.as_str(),
            payload.to.as_str(),
            &payload.summary,
            i64::from(payload.accepted),
            &payload.tool_use_id,
            int(at.id)?,
        ),
    )?;
    Ok(())
}

pub(crate) fn project_attention(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    change: &AttentionChange,
) -> Result<(), AppendError> {
    match change {
        AttentionChange::Opened(p) => {
            let kind = p.kind.clone().unwrap_or(AttentionKind::Approval);
            tx.execute(
                "INSERT INTO attention_items (id, agent_session_id, state, summary, tool_use_id,
                   main_agent, kind, task_id, message_id, created_event_id, updated_event_id)
                 VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    id,
                    p.agent_id.as_str(),
                    &p.summary,
                    &p.tool_use_id,
                    i64::from(p.main_agent),
                    serde_json::to_value(kind)?
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    &p.task_id,
                    p.message_id.as_ref().map(Id::as_str),
                    int(at.id)?,
                    int(at.id)?,
                ),
            )?;
            Ok(())
        }
        AttentionChange::Answered(_) => {
            close_attention(tx, at, id, change.name(), AttentionCloseReason::Answered)
        }
        AttentionChange::Closed(p) => close_attention(tx, at, id, change.name(), p.reason.reason()),
    }
}

fn close_attention(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    name: &'static str,
    reason: AttentionCloseReason,
) -> Result<(), AppendError> {
    let refuse = refused(name);
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM attention_items WHERE id = ?",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let state = state.ok_or_else(|| refuse(format!("no attention item {id}")))?;
    let was: AttentionState = serde_json::from_value(serde_json::Value::String(state))?;
    let to = attention::next(was, reason).map_err(|e| refuse(e.to_string()))?;
    update(
        tx,
        at,
        "attention_items",
        id,
        &[
            ("state", Value::Text(to.as_str().to_owned())),
            ("close_reason", Value::Text(reason.as_str().to_owned())),
        ],
    )
}
