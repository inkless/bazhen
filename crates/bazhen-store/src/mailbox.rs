//! An agent's mail as the mailbox reads and writes it (`mailbox.ts`): a message queued for it, a
//! step it takes towards delivery, and who sent it.

use bazhen_protocol::ids::{AgentId, MessageId, ObservedId};
use bazhen_protocol::mail::MailboxState;
use bazhen_protocol::mail_events::{MailQueued, MailRequeued, MessageObserved, RequeueReason};
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

/// What an observed send records, as shown: its summary and text already cut and cleaned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedSend<'a> {
    pub summary: &'a str,
    pub text: &'a str,
    /// Whether the harness said it was sent.
    pub accepted: bool,
    /// The tool call that sent it.
    pub tool_use_id: &'a str,
}

/// One of an agent's messages as the mailbox hands it over and settles it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mail {
    pub id: String,
    pub body: String,
    /// The turn it was seen in, or folded into.
    pub prompt_id: Option<String>,
    /// When it was first offered, for one offered before.
    pub first_offered: Option<String>,
    /// How often the agent's side has failed it.
    pub failures: u32,
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

    /// `agent_id`'s messages in any of `states`, oldest first.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn mail(self, agent_id: &str, states: &[MailboxState]) -> rusqlite::Result<Vec<Mail>> {
        let marks = vec!["?"; states.len()].join(", ");
        let mut rows = self.0.prepare(&format!(
            "SELECT m.id, m.body, m.prompt_id, e.ts, m.failures FROM mailbox m
               LEFT JOIN events e ON e.id = m.first_offered_event_id
             WHERE m.agent_session_id = ? AND m.state IN ({marks})
             ORDER BY m.created_event_id"
        ))?;
        let params = std::iter::once(agent_id).chain(states.iter().map(|s| s.as_str()));
        rows.query_map(rusqlite::params_from_iter(params), |row| {
            Ok(Mail {
                id: row.get(0)?,
                body: row.get(1)?,
                prompt_id: row.get(2)?,
                first_offered: row.get(3)?,
                failures: row.get(4)?,
            })
        })?
        .collect()
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

    /// Records the message `from` sent through its harness's own channel by the tool call
    /// `tool_use_id`, to the session named `to`: a session answers to the name it was last started
    /// with, whatever its agent is called since. Recorded only when exactly one other live agent of
    /// `from`'s harness answers to `to`, ignoring case, for the channel reaches no other, and only
    /// once per tool call. Answers the event's id; `None` when it isn't recorded.
    ///
    /// # Errors
    ///
    /// The reads' and the append's, or no random bytes for the id.
    pub fn observe_send(
        &self,
        from: &AgentId,
        to: &str,
        sent: ObservedSend<'_>,
    ) -> Result<Option<u64>, AppendError> {
        let reads = self.reads();
        let Some(sender) = reads.sender(from.as_str())? else {
            return Ok(None);
        };
        let answering: Vec<String> = self
            .connection()
            .prepare(
                "SELECT id FROM agent_sessions
                 WHERE harness_name = ? COLLATE NOCASE AND harness = ? AND id != ?
                   AND state NOT IN ('closed', 'failed')
                 ORDER BY created_event_id LIMIT 2",
            )?
            .query_map((to, &sender.harness, from.as_str()), |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let [recipient] = answering.as_slice() else {
            return Ok(None);
        };
        let Some(recipient) = AgentId::parse(recipient) else {
            return Ok(None);
        };
        let recorded = self
            .connection()
            .query_row(
                "SELECT 1 FROM observed_messages WHERE from_agent_id = ? AND tool_use_id = ?",
                (from.as_str(), sent.tool_use_id),
                |_| Ok(()),
            )
            .optional()?;
        if recorded.is_some() {
            return Ok(None);
        }
        let observed = ObservedId::mint(
            crate::now_ms(),
            crate::urandom().map_err(AppendError::NoId)?,
        );
        let id = self.append(&NewEvent::MessageObserved {
            observed,
            actor: from.as_str().to_owned(),
            payload: MessageObserved {
                from: from.clone(),
                to: recipient,
                summary: sent.summary.to_owned(),
                text: sent.text.to_owned(),
                accepted: sent.accepted,
                tool_use_id: sent.tool_use_id.to_owned(),
            },
        })?;
        Ok(Some(id))
    }

    /// Requeues every message a hook held, as a daemon that stopped leaves them: the hooks went
    /// with its socket. Answers how many.
    ///
    /// # Errors
    ///
    /// The appends'.
    pub fn requeue_in_flight(&self) -> Result<usize, AppendError> {
        let held: Vec<String> = self
            .connection()
            .prepare(
                "SELECT id FROM mailbox WHERE state IN ('offered', 'emitted', 'seen')
                 ORDER BY created_event_id",
            )?
            .query_map((), |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let held: Vec<MessageId> = held.iter().filter_map(|id| MessageId::parse(id)).collect();
        for message in &held {
            self.mail_step(
                message,
                MailChange::Requeued(MailRequeued {
                    reason: RequeueReason::DaemonRestart,
                }),
            )?;
        }
        Ok(held.len())
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
    use bazhen_protocol::mail_events::{
        MailAccepted, MailOffered, MailRequeued, MailSeen, MailUndeliverable, RequeueReason,
        UndeliverableReason,
    };
    use rusqlite::OptionalExtension as _;
    use rusqlite::types::Type;

    use super::{Mail, Message, ObservedSend, Sender};
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

    fn step(store: &mut Store, message: &MessageId, change: MailChange) {
        store.write(|w| w.mail_step(message, change)).unwrap();
    }

    fn offered(prompt: Option<&str>) -> MailChange {
        MailChange::Offered(MailOffered {
            prompt_id: prompt.map(str::to_owned),
        })
    }

    #[test]
    fn reads_an_agents_mail_in_the_states_asked_oldest_first_with_its_first_offer() {
        let dir = TempDir::new("mail");
        let mut store = store(&dir);
        let (first, second) = (queued(&mut store, None), queued(&mut store, None));
        step(&mut store, &first, offered(Some("p-1")));
        step(&mut store, &first, MailChange::Emitted);
        step(&mut store, &second, offered(None));
        step(
            &mut store,
            &second,
            MailChange::Requeued(MailRequeued {
                reason: RequeueReason::NotSeen,
            }),
        );
        let offered_at: String = store
            .db
            .query_row(
                "SELECT ts FROM events WHERE type = 'mailbox.offered' AND entity_id = ?",
                [second.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let reads = store.reads();
        let ids = |states: &[MailboxState]| {
            let mail = reads.mail(AGENT, states).unwrap();
            mail.into_iter().map(|m| m.id).collect::<Vec<_>>()
        };
        assert_eq!(
            (
                ids(&[MailboxState::Queued, MailboxState::Emitted]),
                ids(&[MailboxState::Queued]),
                reads.mail(PEER, &[MailboxState::Queued]).unwrap(),
                reads.mail(AGENT, &[MailboxState::Queued]).unwrap(),
            ),
            (
                vec![first.as_str().to_owned(), second.as_str().to_owned()],
                vec![second.as_str().to_owned()],
                vec![],
                vec![Mail {
                    id: second.as_str().to_owned(),
                    body: "hi".to_owned(),
                    prompt_id: None,
                    first_offered: Some(offered_at),
                    failures: 1,
                }],
            )
        );
    }

    #[test]
    fn requeues_what_a_hook_held_when_the_daemon_stopped_and_nothing_else() {
        let dir = TempDir::new("restart");
        let mut store = store(&dir);
        let [waiting, handed, written, seen, done] =
            std::array::from_fn(|_| queued(&mut store, None));
        for message in [&handed, &written, &seen, &done] {
            step(&mut store, message, offered(None));
        }
        step(&mut store, &written, MailChange::Emitted);
        let seen_in = || {
            MailChange::Seen(MailSeen {
                prompt_id: "p-1".to_owned(),
            })
        };
        step(&mut store, &seen, seen_in());
        step(&mut store, &done, seen_in());
        step(&mut store, &done, MailChange::Delivered);
        let requeued = store
            .write(|w| {
                let requeued = w.requeue_in_flight()?;
                Ok::<_, crate::AppendError>(requeued)
            })
            .unwrap();
        let reads = store.reads();
        let state = |m: &MessageId| reads.message(m.as_str()).unwrap().unwrap().state;
        let failures = reads.mail(AGENT, &[MailboxState::Queued]).unwrap();
        assert_eq!(
            (
                requeued,
                [&waiting, &handed, &written, &seen, &done].map(state),
                failures.iter().map(|m| m.failures).sum::<u32>(),
            ),
            (
                3,
                [
                    MailboxState::Queued,
                    MailboxState::Queued,
                    MailboxState::Queued,
                    MailboxState::Queued,
                    MailboxState::Delivered,
                ],
                0,
            )
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

    /// Adds an agent of `harness`, last started as `started_as`, in `state`.
    fn agent(store: &Store, agent: &str, harness: &str, started_as: &str, state: &str) {
        store
            .db
            .execute(
                "INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   harness_name, created_event_id, updated_event_id)
                   VALUES (?, ?, ?, 'p', '/w', ?, ?, 1, 1)",
                (agent, ENV, harness, state, started_as),
            )
            .unwrap();
    }

    /// Whether `from`'s send to `to` by the tool call `use_id` was recorded; `None` on an error.
    fn observed(store: &mut Store, from: &str, to: &str, use_id: &str) -> Option<bool> {
        let sent = ObservedSend {
            summary: "lunch?",
            text: "lunch?\nat noon",
            accepted: true,
            tool_use_id: use_id,
        };
        let from = id(from);
        store
            .write(|w| w.observe_send(&from, to, sent))
            .ok()
            .map(|id| id.is_some())
    }

    /// Each observed message, by who sent it to whom with what, and the tool call.
    fn observations(store: &Store) -> Vec<(String, String, String, String)> {
        let mut rows = store
            .db
            .prepare(
                "SELECT from_agent_id, to_agent_id, summary, tool_use_id FROM observed_messages
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

    const BOB: &str = "agent_01900000000070008000000000000003";
    const BOB_CLOSED: &str = "agent_01900000000070008000000000000004";
    const BOB_TWO: &str = "agent_01900000000070008000000000000005";

    #[test]
    fn records_a_send_once_to_the_one_other_live_agent_of_the_senders_harness_started_as_its_name()
    {
        let dir = TempDir::new("observe");
        let mut store = store(&dir);
        store
            .db
            .execute(
                "UPDATE agent_sessions SET harness_name = 'bob' WHERE id = ?",
                [AGENT],
            )
            .unwrap();
        agent(&store, BOB, "claude-code", "Bob", "running");
        agent(&store, BOB_CLOSED, "claude-code", "bob", "closed");
        store
            .db
            .execute(
                "UPDATE agent_sessions SET harness_name = 'bob' WHERE id = ?",
                [PEER],
            )
            .unwrap();
        let first = observed(&mut store, AGENT, "BOB", "toolu_1");
        let again = observed(&mut store, AGENT, "BOB", "toolu_1");
        let payload: Option<String> = store
            .db
            .query_row(
                "SELECT payload FROM events WHERE type = 'message.observed'",
                (),
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(
            (first, again, observations(&store), payload),
            (
                Some(true),
                Some(false),
                vec![(
                    AGENT.to_owned(),
                    BOB.to_owned(),
                    "lunch?".to_owned(),
                    "toolu_1".to_owned()
                )],
                Some(format!(
                    r#"{{"from":"{AGENT}","to":"{BOB}","summary":"lunch?","text":"lunch?\nat noon","accepted":true,"toolUseId":"toolu_1"}}"#
                )),
            )
        );
    }

    #[test]
    fn records_no_send_to_a_name_no_other_agent_or_two_answer_to_nor_from_an_agent_unknown() {
        let dir = TempDir::new("observe-none");
        let mut store = store(&dir);
        let nobody = observed(&mut store, AGENT, "bob", "toolu_1");
        agent(&store, BOB, "claude-code", "bob", "running");
        agent(&store, BOB_TWO, "claude-code", "bob", "starting");
        let two = observed(&mut store, AGENT, "bob", "toolu_2");
        let unknown = observed(
            &mut store,
            "agent_01900000000070008000000000000099",
            "bob",
            "toolu_3",
        );
        assert_eq!(
            (nobody, two, unknown, observations(&store)),
            (Some(false), Some(false), Some(false), vec![])
        );
    }
}
