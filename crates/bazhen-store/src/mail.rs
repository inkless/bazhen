//! What the daemon reads of the mail on its way to an agent: what a close makes undeliverable.

use bazhen_protocol::ids::MessageId;
use bazhen_protocol::mail::MailboxState;

use crate::events::Reads;

/// The states of mail still on its way to its agent (`IN_FLIGHT` in `agents/lifecycle.ts`), in
/// its order.
pub const IN_FLIGHT: [MailboxState; 5] = [
    MailboxState::Queued,
    MailboxState::Offered,
    MailboxState::Emitted,
    MailboxState::Seen,
    MailboxState::QueuedInCodex,
];

impl Reads<'_> {
    /// The mail still on its way to `agent`, oldest first, as a close makes it undeliverable.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or an id no message could have.
    pub fn in_flight_mail(self, agent: &str) -> rusqlite::Result<Vec<MessageId>> {
        let mut rows = self.0.prepare(
            "SELECT id FROM mailbox WHERE agent_session_id = ?1 AND state IN (?2, ?3, ?4, ?5, ?6)
             ORDER BY created_event_id",
        )?;
        let params = std::iter::once(agent).chain(IN_FLIGHT.map(MailboxState::as_str));
        rows.query_map(rusqlite::params_from_iter(params), |row| {
            let id: String = row.get(0)?;
            MessageId::parse(&id).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    format!("{id} isn't a message's id").into(),
                )
            })
        })?
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;
    use crate::testing::TempDir;

    const AGENT: &str = "agent_0190a1b2c3d47abc8def0123456789a1";
    const OTHER: &str = "agent_0190a1b2c3d47abc8def0123456789a2";

    fn message(n: u8) -> String {
        format!("msg_0190a1b2c3d47abc8def0123456789{n:02x}")
    }

    #[test]
    fn gives_the_mail_still_on_its_way_to_an_agent_oldest_first_and_none_of_anothers() {
        let dir = TempDir::new("mail");
        let store = Store::open(&dir.db("mail.db")).unwrap();
        let event = "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
               SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{}' FROM host;";
        let agents = [AGENT, OTHER].map(|agent| {
            format!(
                "INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   created_event_id, updated_event_id)
                 VALUES ('{agent}', 'env_local', 'claude-code', 'p', '/', 'running', 1, 1);"
            )
        });
        // Created in this order, each at the event its number names.
        let mail = [
            (8, AGENT, "seen"),
            (2, AGENT, "delivered"),
            (5, AGENT, "queued"),
            (3, OTHER, "queued"),
            (7, AGENT, "undeliverable"),
            (4, AGENT, "queued_in_codex"),
            (6, AGENT, "offered"),
            (9, AGENT, "emitted"),
        ]
        .map(|(n, agent, state)| {
            format!(
                "INSERT INTO mailbox (id, agent_session_id, body, state, created_event_id,
                   updated_event_id)
                 VALUES ('{}', '{agent}', 'b', '{state}', {n}, {n});",
                message(n)
            )
        });
        let sql: Vec<String> = std::iter::repeat_n(event.to_owned(), 9)
            .chain(std::iter::once(
                "INSERT INTO environments (id, kind, created_event_id) VALUES ('env_local', 'local', 1);"
                    .to_owned(),
            ))
            .chain(agents)
            .chain(mail)
            .collect();
        store.db.execute_batch(&sql.concat()).unwrap();
        assert_eq!(
            store.reads().in_flight_mail(AGENT).unwrap(),
            [4, 5, 6, 8, 9].map(|n| MessageId::parse(&message(n)).unwrap())
        );
    }
}
