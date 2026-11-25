//! An agent's mail as the mailbox reads and writes it (`mailbox.ts`): a message queued for it, a
//! step it takes towards delivery, and who sent it.

use bazhen_protocol::ids::{AgentId, MessageId};
use bazhen_protocol::mail::MailboxState;
use bazhen_protocol::mail_events::MailQueued;
use rusqlite::OptionalExtension;
use rusqlite::types::Type;

use crate::events::{AppendError, NewEvent};
use crate::{MailChange, Reads, Writer};

/// One message in an agent's mailbox, as its row records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub agent: String,
    pub body: String,
    pub state: MailboxState,
}

/// What an agent's message to another names it by: the reader is told which peer wrote it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sender {
    /// Its name; empty for an agent from before agents had names.
    pub name: String,
    pub harness: String,
    pub cwd: String,
}

impl Reads<'_> {
    /// The message `id`; `None` for one the store doesn't know.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a stored state the protocol doesn't name, as a failure to read its column.
    pub fn message(self, id: &str) -> rusqlite::Result<Option<Message>> {
        let row: Option<(String, String, String)> = self
            .0
            .query_row(
                "SELECT agent_session_id, body, state FROM mailbox WHERE id = ?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        row.map(|(agent, body, state)| {
            let state =
                serde_json::from_value(serde_json::Value::String(state)).map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(2, Type::Text, Box::new(err))
                })?;
            Ok(Message { agent, body, state })
        })
        .transpose()
    }

    /// What `agent_id`'s message to another names it by; `None` for an agent the store doesn't
    /// know.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn sender(self, agent_id: &str) -> rusqlite::Result<Option<Sender>> {
        self.0
            .query_row(
                "SELECT coalesce(name, ''), harness, cwd FROM agent_sessions WHERE id = ?",
                [agent_id],
                |row| {
                    Ok(Sender {
                        name: row.get(0)?,
                        harness: row.get(1)?,
                        cwd: row.get(2)?,
                    })
                },
            )
            .optional()
    }
}

impl Writer<'_> {
    /// Queues `body` for `agent`, from the agent `from` whose own words it is, or from the human
    /// or Bazhen; answers the new message's id and its event's.
    ///
    /// # Errors
    ///
    /// The append's, or [`AppendError::NoId`] for no random bytes to mint the id with.
    pub fn queue_mail(
        &self,
        agent: &AgentId,
        body: &str,
        from: Option<&AgentId>,
    ) -> Result<(MessageId, u64), AppendError> {
        let urandom = crate::urandom().map_err(AppendError::NoId)?;
        let message = MessageId::mint(crate::now_ms(), urandom);
        let id = self.append(&NewEvent::Mail {
            message: message.clone(),
            actor: from.map_or_else(|| "system".to_owned(), |from| from.as_str().to_owned()),
            change: MailChange::Queued(MailQueued {
                agent_id: agent.clone(),
                body: body.to_owned(),
                from: from.cloned(),
            }),
        })?;
        Ok((message, id))
    }

    /// Records Bazhen's step of `message` towards delivery.
    ///
    /// # Errors
    ///
    /// The append's: a step the message's state doesn't take is refused.
    pub fn mail_step(&self, message: &MessageId, change: MailChange) -> Result<u64, AppendError> {
        self.append(&NewEvent::Mail {
            message: message.clone(),
            actor: "system".to_owned(),
            change,
        })
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::ids::{AgentId, MessageId};
    use bazhen_protocol::mail::MailboxState;
    use bazhen_protocol::mail_events::{MailAccepted, MailUndeliverable, UndeliverableReason};

    use rusqlite::types::Type;

    use super::{Message, Sender};
    use crate::testing::TempDir;
    use crate::{MailChange, Store};

    const AGENT: &str = "agent_01900000000070008000000000000001";
    const PEER: &str = "agent_01900000000070008000000000000002";
    const ENV: &str = "env_01900000000070008000000000000009";

    fn id(text: &str) -> AgentId {
        AgentId::parse(text).unwrap()
    }

    /// A store with two agents, the first unnamed and the second named `peer`.
    fn store(dir: &TempDir) -> Store {
        let store = Store::open(&dir.db("mail.db")).unwrap();
        store
            .db
            .execute_batch(&format!(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{{}}' FROM host;
                 INSERT INTO environments (id, kind, created_event_id) VALUES ('{ENV}', 'local', 1);
                 INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   created_event_id, updated_event_id)
                   VALUES ('{AGENT}', '{ENV}', 'claude-code', 'p', '/w', 'running', 1, 1);
                 INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state, name,
                   created_event_id, updated_event_id)
                   VALUES ('{PEER}', '{ENV}', 'codex', 'p', '/v', 'running', 'peer', 1, 1);"
            ))
            .unwrap();
        store
    }

    fn queued(store: &mut Store, from: Option<&AgentId>) -> MessageId {
        store
            .write(|w| w.queue_mail(&id(AGENT), "hi", from))
            .unwrap()
            .0
    }

    fn queued_events(store: &Store) -> Vec<(String, String)> {
        let mut rows = store
            .db
            .prepare("SELECT actor, payload FROM events WHERE type = 'mailbox.queued' ORDER BY id")
            .unwrap();
        rows.query_map((), |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn queues_a_message_from_bazhen_or_from_the_agent_whose_words_it_is() {
        let dir = TempDir::new("queue");
        let mut store = store(&dir);
        let human = queued(&mut store, None);
        queued(&mut store, Some(&id(PEER)));
        assert_eq!(
            (
                store.reads().message(human.as_str()).unwrap(),
                queued_events(&store)
            ),
            (
                Some(Message {
                    agent: AGENT.to_owned(),
                    body: "hi".to_owned(),
                    state: MailboxState::Queued,
                }),
                vec![
                    (
                        "system".to_owned(),
                        format!(r#"{{"agentId":"{AGENT}","body":"hi"}}"#)
                    ),
                    (
                        PEER.to_owned(),
                        format!(r#"{{"agentId":"{AGENT}","body":"hi","from":"{PEER}"}}"#)
                    ),
                ]
            )
        );
    }

    #[test]
    fn steps_a_message_only_as_its_state_takes_the_step() {
        let dir = TempDir::new("step");
        let mut store = store(&dir);
        let message = queued(&mut store, None);
        let step = |store: &mut Store, change: MailChange| {
            store.write(|w| w.mail_step(&message, change)).is_ok()
        };
        let accepted = step(
            &mut store,
            MailChange::Accepted(MailAccepted { offline: true }),
        );
        let given_up = step(
            &mut store,
            MailChange::Undeliverable(MailUndeliverable {
                reason: UndeliverableReason::GaveUp,
            }),
        );
        let state = store
            .reads()
            .message(message.as_str())
            .unwrap()
            .map(|m| m.state);
        assert_eq!(
            (accepted, given_up, state),
            (true, false, Some(MailboxState::QueuedInCodex))
        );
    }

    #[test]
    fn reads_a_stored_state_the_protocol_doesnt_name_as_a_column_it_cant_read() {
        let dir = TempDir::new("state");
        let mut store = store(&dir);
        let message = queued(&mut store, None);
        store
            .db
            .execute(
                "UPDATE mailbox SET state = 'lost' WHERE id = ?",
                [message.as_str()],
            )
            .unwrap();
        let read = store.reads().message(message.as_str());
        assert!(
            matches!(
                read,
                Err(rusqlite::Error::FromSqlConversionFailure(2, Type::Text, _))
            ),
            "{read:?}"
        );
    }

    #[test]
    fn names_a_sender_by_its_name_harness_and_directory_and_knows_no_other() {
        let dir = TempDir::new("sender");
        let store = store(&dir);
        let reads = store.reads();
        assert_eq!(
            (
                reads.sender(AGENT).unwrap(),
                reads.sender(PEER).unwrap(),
                reads
                    .sender("agent_01900000000070008000000000000003")
                    .unwrap(),
                reads
                    .message("msg_01900000000070008000000000000001")
                    .unwrap(),
            ),
            (
                Some(Sender {
                    name: String::new(),
                    harness: "claude-code".to_owned(),
                    cwd: "/w".to_owned(),
                }),
                Some(Sender {
                    name: "peer".to_owned(),
                    harness: "codex".to_owned(),
                    cwd: "/v".to_owned(),
                }),
                None,
                None,
            )
        );
    }
}
