//! Items for the human (`inbox.ts`): opened, answered and closed, and the items another event opens
//! or closes in the transaction that records it, so no crash can leave one without the other.

use bazhen_protocol::agents::AgentState;
use bazhen_protocol::ids::{AgentId, AttentionId, MessageId};
use bazhen_protocol::mail::AttentionKind;
use bazhen_protocol::mail_events::{
    AttentionClosed, AttentionClosedReason, AttentionOpened, MailUndeliverable, UndeliverableReason,
};
use rusqlite::OptionalExtension as _;

use crate::agent_events::AgentChange;
use crate::events::{AppendError, NewEvent};
use crate::mail_events::{AttentionChange, MailChange};
use crate::{Reads, Writer};

/// Kinds a harness request stands behind: only that request, or the TUI, settles them.
const HARNESS_HELD: [AttentionKind; 2] = [AttentionKind::Approval, AttentionKind::Question];

/// Kinds that tell the human something whether or not the agent that raised them is still there.
/// They stay open until the human dismisses them.
const HUMAN_HELD: [AttentionKind; 2] = [AttentionKind::Escalation, AttentionKind::TaskDone];

/// What a mail given up on opens, for the human to reply, send it again or dismiss.
const UNDELIVERABLE: &str = "A message could not be delivered";

/// What a failed turn opens when its harness gives no error.
const TURN_FAILED: &str = "A turn failed";

/// One item for the human, as the store records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionItem {
    pub id: AttentionId,
    pub agent: AgentId,
    pub kind: AttentionKind,
    pub open: bool,
    /// The message it is about, for mail that could not be delivered.
    pub message_id: Option<MessageId>,
    /// Its agent's state; none for an agent the store no longer has.
    pub agent_state: Option<AgentState>,
}

impl Reads<'_> {
    /// The item `id`, if the store has it.
    ///
    /// # Errors
    ///
    /// The query's, or a column it can't read.
    pub fn attention_item(self, id: &str) -> rusqlite::Result<Option<AttentionItem>> {
        self.0
            .query_row(
                "SELECT i.id, i.agent_session_id, i.kind, i.state = 'open', i.message_id, a.state
                 FROM attention_items i LEFT JOIN agent_sessions a ON a.id = i.agent_session_id
                 WHERE i.id = ?",
                [id],
                item,
            )
            .optional()
    }

    /// `agent`'s open items, oldest first.
    ///
    /// # Errors
    ///
    /// The query's, or a column it can't read.
    pub fn open_attention(self, agent: &str) -> rusqlite::Result<Vec<AttentionItem>> {
        self.0
            .prepare(
                "SELECT i.id, i.agent_session_id, i.kind, 1, i.message_id, a.state
                 FROM attention_items i LEFT JOIN agent_sessions a ON a.id = i.agent_session_id
                 WHERE i.agent_session_id = ? AND i.state = 'open' ORDER BY i.created_event_id",
            )?
            .query_map([agent], item)?
            .collect()
    }
}

fn item(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttentionItem> {
    let id: String = row.get(0)?;
    let agent: String = row.get(1)?;
    let kind: String = row.get(2)?;
    Ok(AttentionItem {
        id: AttentionId::parse(&id).ok_or_else(|| unreadable(0, "not an attention id"))?,
        agent: AgentId::parse(&agent).ok_or_else(|| unreadable(1, "not an agent id"))?,
        kind: word(2, kind)?,
        open: row.get(3)?,
        message_id: row
            .get::<_, Option<String>>(4)?
            .map(|id| MessageId::parse(&id).ok_or_else(|| unreadable(4, "not a message id")))
            .transpose()?,
        agent_state: row
            .get::<_, Option<String>>(5)?
            .map(|state| word(5, state))
            .transpose()?,
    })
}

/// The column's text as the protocol's word for it.
fn word<T: serde::de::DeserializeOwned>(at: usize, text: String) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(text)).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(at, rusqlite::types::Type::Text, Box::new(err))
    })
}

fn unreadable(at: usize, why: &'static str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(at, rusqlite::types::Type::Text, why.into())
}

impl Writer<'_> {
    /// Opens an item for the human; answers its id and its event's.
    ///
    /// # Errors
    ///
    /// The append's, or no random bytes for the id.
    pub fn open_attention(
        &self,
        opened: AttentionOpened,
    ) -> Result<(AttentionId, u64), AppendError> {
        let attention = AttentionId::mint(
            crate::now_ms(),
            crate::urandom().map_err(AppendError::NoId)?,
        );
        let id = self.append(&NewEvent::Attention {
            attention: attention.clone(),
            actor: "system".to_owned(),
            change: AttentionChange::Opened(opened),
        })?;
        Ok((attention, id))
    }

    /// Closes the item `id` for `reason`, by `actor`: `user` for the human, else `system`.
    ///
    /// # Errors
    ///
    /// The append's: an item not open is refused.
    pub fn close_attention(
        &self,
        id: &AttentionId,
        reason: AttentionClosedReason,
        actor: &str,
    ) -> Result<u64, AppendError> {
        self.append(&NewEvent::Attention {
            attention: id.clone(),
            actor: actor.to_owned(),
            change: AttentionChange::Closed(AttentionClosed { reason }),
        })
    }

    /// The agent's own turn failed, as its harness reports it: one item while its turns keep
    /// failing, saying `error`. Answers its event's id, none when one is open already or the
    /// agent is closed or unknown, since a hook can come after the close and no turn would ever
    /// close the item.
    ///
    /// # Errors
    ///
    /// The read's and the append's.
    pub fn turn_failed(
        &self,
        agent: &AgentId,
        error: Option<&str>,
    ) -> Result<Option<u64>, AppendError> {
        let state: Option<String> = self
            .connection()
            .query_row(
                "SELECT state FROM agent_sessions WHERE id = ?",
                [agent.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        if state.is_none_or(|state| state == "closed") {
            return Ok(None);
        }
        if self
            .open_of(agent, &AttentionKind::Failed)?
            .next()
            .is_some()
        {
            return Ok(None);
        }
        let summary = error
            .filter(|error| !error.is_empty())
            .unwrap_or(TURN_FAILED);
        let opened = self.open_attention(raised(agent, AttentionKind::Failed, summary, None))?;
        Ok(Some(opened.1))
    }

    /// The agent started a turn of its own, so the failure before it no longer holds it up.
    ///
    /// # Errors
    ///
    /// The read's and the appends'.
    pub fn turn_started(&self, agent: &AgentId) -> Result<(), AppendError> {
        let failed: Vec<AttentionId> = self.open_of(agent, &AttentionKind::Failed)?.collect();
        for id in failed {
            self.close_attention(&id, AttentionClosedReason::Superseded, "system")?;
        }
        Ok(())
    }

    /// Closes as stale every approval and question left open by a daemon that stopped: the
    /// harness request each stood behind went with it. Answers how many.
    ///
    /// # Errors
    ///
    /// The read's and the appends'.
    pub fn close_abandoned(&self) -> Result<usize, AppendError> {
        let abandoned: Vec<String> = self
            .connection()
            .prepare(
                "SELECT id FROM attention_items WHERE state = 'open' AND kind IN (?, ?)
                 ORDER BY created_event_id",
            )?
            .query_map(
                (
                    AttentionKind::Approval.as_str(),
                    AttentionKind::Question.as_str(),
                ),
                |row| row.get(0),
            )?
            .collect::<rusqlite::Result<_>>()?;
        let mut closed = 0;
        for id in abandoned.iter().filter_map(|id| AttentionId::parse(id)) {
            self.close_attention(&id, AttentionClosedReason::Stale, "system")?;
            closed += 1;
        }
        Ok(closed)
    }

    /// The ids of `agent`'s open items of `kind`.
    fn open_of(
        &self,
        agent: &AgentId,
        kind: &AttentionKind,
    ) -> Result<impl Iterator<Item = AttentionId>, AppendError> {
        let open = self.reads().open_attention(agent.as_str())?;
        let kind = kind.clone();
        Ok(open
            .into_iter()
            .filter(move |item| item.kind == kind)
            .map(|item| item.id))
    }
}

/// An item Bazhen opens for `agent` itself, about no tool call.
fn raised(
    agent: &AgentId,
    kind: AttentionKind,
    summary: &str,
    message: Option<MessageId>,
) -> AttentionOpened {
    AttentionOpened {
        agent_id: agent.clone(),
        summary: summary.to_owned(),
        kind: Some(kind),
        task_id: None,
        message_id: message,
        tool_use_id: None,
        main_agent: true,
    }
}

/// Opens or closes the items `event`, just recorded, causes (`Inbox.react`): mail given up on opens
/// one, and an agent closing closes those only it could have answered.
pub(crate) fn react(w: &Writer<'_>, event: &NewEvent) -> Result<(), AppendError> {
    match event {
        NewEvent::Mail {
            message,
            change:
                MailChange::Undeliverable(MailUndeliverable {
                    reason: UndeliverableReason::GaveUp,
                }),
            ..
        } => {
            // A message the store doesn't hold, or whose agent's id it can't read, opens nothing.
            let Some(agent) = w.reads().message(message.as_str())?.map(|m| m.agent) else {
                return Ok(());
            };
            let Some(agent) = AgentId::parse(&agent) else {
                return Ok(());
            };
            let opened = raised(
                &agent,
                AttentionKind::Undeliverable,
                UNDELIVERABLE,
                Some(message.clone()),
            );
            w.open_attention(opened)?;
        }
        NewEvent::Agent {
            agent,
            change: AgentChange::Closed,
            ..
        } => {
            let open = w.reads().open_attention(agent.as_str())?;
            for item in open {
                if !HARNESS_HELD.contains(&item.kind) && !HUMAN_HELD.contains(&item.kind) {
                    w.close_attention(&item.id, AttentionClosedReason::AgentClosed, "system")?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::agents::AgentState;
    use bazhen_protocol::ids::{AgentId, AttentionId};
    use bazhen_protocol::mail::AttentionKind;
    use bazhen_protocol::mail_events::{MailUndeliverable, UndeliverableReason};

    use super::{AttentionItem, raised};
    use crate::events::NewEvent;
    use crate::testing::TempDir;
    use crate::{AgentChange, MailChange, Store};

    const AGENT: &str = "agent_01900000000070008000000000000001";
    const ENV: &str = "env_01900000000070008000000000000009";

    fn agent() -> AgentId {
        AgentId::parse(AGENT).unwrap()
    }

    /// A store with one agent, in `state`.
    fn store(dir: &TempDir, state: &str) -> Store {
        let store = Store::open(&dir.db("attention.db")).unwrap();
        store
            .db
            .execute_batch(&format!(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{{}}' FROM host;
                 INSERT INTO environments (id, kind, created_event_id) VALUES ('{ENV}', 'local', 1);
                 INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   created_event_id, updated_event_id)
                   VALUES ('{AGENT}', '{ENV}', 'claude-code', 'p', '/w', '{state}', 1, 1);"
            ))
            .unwrap();
        store
    }

    fn open(store: &mut Store, kind: AttentionKind) -> AttentionId {
        store
            .write(|w| w.open_attention(raised(&agent(), kind, "s", None)))
            .unwrap()
            .0
    }

    /// Every item, oldest first: its kind, state and close reason, and the message it is about.
    fn items(store: &Store) -> Vec<(String, String, Option<String>, Option<String>)> {
        let mut rows = store
            .db
            .prepare(
                "SELECT kind, state, close_reason, message_id FROM attention_items
                 ORDER BY created_event_id",
            )
            .unwrap();
        rows.query_map((), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    fn row(
        kind: &str,
        state: &str,
        reason: Option<&str>,
    ) -> (String, String, Option<String>, Option<String>) {
        (
            kind.to_owned(),
            state.to_owned(),
            reason.map(str::to_owned),
            None,
        )
    }

    #[test]
    fn mail_given_up_on_opens_an_item_about_it_and_mail_gone_with_its_agent_none() {
        let dir = TempDir::new("undeliverable");
        let mut store = store(&dir, "running");
        let give_up = |store: &mut Store, reason: UndeliverableReason| {
            let message = store
                .write(|w| w.queue_mail(&agent(), "hi", None))
                .unwrap()
                .0;
            store
                .write(|w| {
                    w.mail_step(
                        &message,
                        MailChange::Undeliverable(MailUndeliverable { reason }),
                    )
                })
                .unwrap();
            message
        };
        let abandoned = give_up(&mut store, UndeliverableReason::GaveUp);
        give_up(&mut store, UndeliverableReason::AgentClosed);
        let open = store.reads().open_attention(AGENT).unwrap();
        assert_eq!(
            (
                items(&store),
                open.iter().map(|i| i.open).collect::<Vec<_>>()
            ),
            (
                vec![(
                    "undeliverable".to_owned(),
                    "open".to_owned(),
                    None,
                    Some(abandoned.as_str().to_owned())
                )],
                vec![true]
            )
        );
    }

    #[test]
    fn a_failed_turn_opens_one_item_while_turns_keep_failing_and_a_turn_of_its_own_closes_it() {
        let dir = TempDir::new("failed");
        let mut store = store(&dir, "running");
        let fail = |store: &mut Store, error: Option<&str>| {
            store
                .write(|w| w.turn_failed(&agent(), error))
                .unwrap()
                .is_some()
        };
        let first = fail(&mut store, Some("overloaded"));
        let again = fail(&mut store, None);
        store.write(|w| w.turn_started(&agent())).unwrap();
        let after = fail(&mut store, Some(""));
        let summaries: Vec<String> = store
            .db
            .prepare("SELECT summary FROM attention_items ORDER BY created_event_id")
            .unwrap()
            .query_map((), |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            ((first, again, after), items(&store), summaries),
            (
                (true, false, true),
                vec![
                    row("failed", "closed", Some("superseded")),
                    row("failed", "open", None)
                ],
                vec!["overloaded".to_owned(), "A turn failed".to_owned()]
            )
        );
    }

    #[test]
    fn a_failed_turn_opens_nothing_for_an_agent_closed_or_unknown() {
        let dir = TempDir::new("failed-closed");
        let mut store = store(&dir, "closed");
        let unknown = AgentId::parse("agent_01900000000070008000000000000002").unwrap();
        let opened = (
            store.write(|w| w.turn_failed(&agent(), Some("late"))),
            store.write(|w| w.turn_failed(&unknown, Some("late"))),
        );
        assert_eq!(
            (opened.0.ok(), opened.1.ok(), items(&store)),
            (Some(None), Some(None), vec![])
        );
    }

    #[test]
    fn an_agent_closing_closes_what_only_it_could_answer_and_leaves_the_rest() {
        let dir = TempDir::new("closed");
        let mut store = store(&dir, "closing");
        for kind in [
            AttentionKind::Failed,
            AttentionKind::Approval,
            AttentionKind::StuckStarting,
            AttentionKind::Escalation,
            AttentionKind::Question,
            AttentionKind::TaskDone,
        ] {
            open(&mut store, kind);
        }
        store
            .write(|w| {
                w.append(&NewEvent::Agent {
                    agent: agent(),
                    actor: "system".to_owned(),
                    change: AgentChange::Closed,
                })
            })
            .unwrap();
        assert_eq!(
            items(&store),
            vec![
                row("failed", "closed", Some("agent_closed")),
                row("approval", "open", None),
                row("stuck_starting", "closed", Some("agent_closed")),
                row("escalation", "open", None),
                row("question", "open", None),
                row("task_done", "open", None),
            ]
        );
    }

    #[test]
    fn closes_as_stale_the_approvals_and_questions_a_stopped_daemon_left_open() {
        let dir = TempDir::new("abandoned");
        let mut store = store(&dir, "running");
        let approval = open(&mut store, AttentionKind::Approval);
        open(&mut store, AttentionKind::Question);
        open(&mut store, AttentionKind::Failed);
        let closed = store
            .write(|w| {
                let closed = w.close_abandoned()?;
                Ok::<_, crate::AppendError>(closed)
            })
            .unwrap();
        let read = store.reads().attention_item(approval.as_str()).unwrap();
        assert_eq!(
            (closed, items(&store), read),
            (
                2,
                vec![
                    row("approval", "closed", Some("stale")),
                    row("question", "closed", Some("stale")),
                    row("failed", "open", None),
                ],
                Some(AttentionItem {
                    id: approval.clone(),
                    agent: agent(),
                    kind: AttentionKind::Approval,
                    open: false,
                    message_id: None,
                    agent_state: Some(AgentState::Running),
                })
            )
        );
    }
    #[test]
    fn counts_only_the_abandoned_items_it_closed() {
        let dir = TempDir::new("abandoned-unreadable");
        let mut store = store(&dir, "running");
        open(&mut store, AttentionKind::Approval);
        store
            .db
            .execute(
                "INSERT INTO attention_items (id, agent_session_id, state, summary, main_agent,
                   created_event_id, updated_event_id, kind)
                   VALUES ('not-an-id', ?, 'open', 's', 1, 1, 1, 'question')",
                [AGENT],
            )
            .unwrap();
        let closed = store
            .write(|w| {
                let closed = w.close_abandoned()?;
                Ok::<_, crate::AppendError>(closed)
            })
            .unwrap();
        assert_eq!(closed, 1);
    }
}
