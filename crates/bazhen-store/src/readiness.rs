//! A start waiting on its harness's first sign of life (`readiness.ts`), and the item that tells
//! the human once it has waited too long: an agent whose terminal runs is still starting until
//! its harness shows it is up, since a TUI held at a trust, login or update dialog isn't running.

use bazhen_protocol::ids::{AgentId, AttentionId};
use bazhen_protocol::mail::AttentionKind;
use rusqlite::OptionalExtension as _;

use crate::attention::raised;
use crate::events::{AppendError, Reads, Writer, int, unsigned};

/// The events that confirm a start's terminal, after which the agent waits on its harness.
pub const STARTS: [&str; 4] = [
    "agent.running",
    "agent.respawned",
    "agent.relaunched",
    "agent.process_adopted",
];

/// The events that ask for a start, before its terminal is up.
const REQUESTS: [&str; 3] = [
    "agent.launched",
    "agent.respawn_requested",
    "agent.relaunch_requested",
];

/// A start whose agent waits on its harness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    pub agent: AgentId,
    /// The start's event.
    pub start_id: u64,
    /// When the start was recorded, as the event's `ts`.
    pub at: String,
}

impl Reads<'_> {
    /// Whether `agent_id` is starting on a running terminal, so its harness's sign is awaited.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn waiting(self, agent_id: &str) -> rusqlite::Result<bool> {
        Ok(self.agent_binding(agent_id)?.is_some_and(|b| {
            b.state == "starting" && b.terminal_state.as_deref() == Some("running")
        }))
    }

    /// Every agent starting on a running terminal, with its latest start, oldest start first. An
    /// agent with no start recorded, or whose id isn't one, is left out.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn waiting_starts(self) -> rusqlite::Result<Vec<Waiting>> {
        let rows: Vec<(String, u64, String)> = self
            .0
            .prepare(
                "SELECT a.id, e.id, e.ts FROM agent_sessions a
                   JOIN terminals t ON t.id = a.terminal_id
                   JOIN events e ON e.id = (
                     SELECT max(id) FROM events WHERE entity_type = 'agent'
                       AND entity_id = a.id AND type IN (?, ?, ?, ?))
                 WHERE a.state = 'starting' AND t.state = 'running'
                 ORDER BY e.id",
            )?
            .query_map(STARTS, |row| {
                Ok((row.get(0)?, unsigned(row, 1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows
            .into_iter()
            .filter_map(|(agent, start_id, at)| {
                Some(Waiting {
                    agent: AgentId::parse(&agent)?,
                    start_id,
                    at,
                })
            })
            .collect())
    }

    /// The id of the request for `agent_id`'s start `start_id`: its latest start request before
    /// it, if one is still in the log.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn start_request(self, agent_id: &str, start_id: u64) -> rusqlite::Result<Option<u64>> {
        let [launched, respawn, relaunch] = REQUESTS;
        self.0
            .query_row(
                "SELECT max(id) FROM events WHERE entity_type = 'agent' AND entity_id = ?
                   AND type IN (?, ?, ?) AND id < ?",
                (agent_id, launched, respawn, relaunch, int(start_id)?),
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten()
            .map(|id| {
                u64::try_from(id).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, id))
            })
            .transpose()
    }
}

impl Writer<'_> {
    /// Tells the human that `agent`'s start `start_id` hasn't come up, saying `summary`: once per
    /// start, and only while the agent still waits on its harness. Answers the item opened; none
    /// when the agent no longer waits, or an item about this start, or one still open, says so
    /// already.
    ///
    /// # Errors
    ///
    /// The reads' and the append's.
    pub fn stuck_starting(
        &self,
        agent: &AgentId,
        start_id: u64,
        summary: &str,
    ) -> Result<Option<AttentionId>, AppendError> {
        if !self.reads().waiting(agent.as_str())? {
            return Ok(None);
        }
        let told: bool = self.connection().query_row(
            "SELECT EXISTS (SELECT 1 FROM attention_items WHERE agent_session_id = ? AND kind = ?
               AND (state = 'open' OR created_event_id > ?))",
            (
                agent.as_str(),
                AttentionKind::StuckStarting.as_str(),
                int(start_id)?,
            ),
            |row| row.get(0),
        )?;
        if told {
            return Ok(None);
        }
        let opened = raised(agent, AttentionKind::StuckStarting, summary, None);
        Ok(Some(self.open_attention(opened)?.0))
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::agent_events::{
        AgentExited, AgentFailed, AgentFailedReason, AgentReady, AgentRespawnRejected, ReadySign,
        RespawnRejectedReason,
    };
    use bazhen_protocol::agents::ExitStatus;
    use bazhen_protocol::ids::AgentId;
    use bazhen_protocol::mail::AttentionKind;

    use super::Waiting;
    use crate::testing::TempDir;
    use crate::{AgentChange, NewEvent, Store};

    const ENV: &str = "env_01900000000070008000000000000009";
    const AGENT: &str = "agent_01900000000070008000000000000001";
    const OTHER: &str = "agent_01900000000070008000000000000002";

    fn agent() -> AgentId {
        AgentId::parse(AGENT).unwrap()
    }

    /// A store with `AGENT` starting on a running terminal, and `OTHER` running on one.
    fn store(dir: &TempDir) -> Store {
        let store = Store::open(&dir.db("readiness.db")).unwrap();
        store
            .db
            .execute_batch(&format!(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{{}}' FROM host;
                 INSERT INTO environments (id, kind, created_event_id) VALUES ('{ENV}', 'local', 1);
                 INSERT INTO terminals (id, host_id, state, generation, locator, kind,
                   agent_session_id, created_event_id, updated_event_id)
                   SELECT 'term_1', id, 'running', 0, '{{}}', 'agent', NULL, 1, 1 FROM host;
                 INSERT INTO terminals (id, host_id, state, generation, locator, kind,
                   agent_session_id, created_event_id, updated_event_id)
                   SELECT 'term_2', id, 'running', 0, '{{}}', 'agent', NULL, 1, 1 FROM host;
                 INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   terminal_id, created_event_id, updated_event_id)
                   VALUES ('{AGENT}', '{ENV}', 'claude-code', 'p', '/w', 'starting', 'term_1', 1, 1);
                 INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   terminal_id, created_event_id, updated_event_id)
                   VALUES ('{OTHER}', '{ENV}', 'claude-code', 'p', '/w', 'running', 'term_2', 1, 1);"
            ))
            .unwrap();
        store
    }

    /// Writes an event of `kind` about `agent` as a raw row, as the log holds one: the projection
    /// isn't what these reads are about.
    fn raw(store: &Store, agent: &str, kind: &str, ts: &str) -> u64 {
        store
            .db
            .execute(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, ?, ?, 'agent', ?, 'system', '{}' FROM host",
                (ts, kind, agent),
            )
            .unwrap();
        u64::try_from(store.db.last_insert_rowid()).unwrap()
    }

    fn stuck(store: &mut Store, start_id: u64) -> bool {
        store
            .write(|w| w.stuck_starting(&agent(), start_id, "not up"))
            .unwrap()
            .is_some()
    }

    /// Each stuck-starting item, oldest first: its state and close reason.
    fn items(store: &Store) -> Vec<(String, Option<String>)> {
        store
            .db
            .prepare(
                "SELECT state, close_reason FROM attention_items WHERE kind = ?
                 ORDER BY created_event_id",
            )
            .unwrap()
            .query_map([AttentionKind::StuckStarting.as_str()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn open() -> (String, Option<String>) {
        ("open".to_owned(), None)
    }

    fn closed(reason: &str) -> (String, Option<String>) {
        ("closed".to_owned(), Some(reason.to_owned()))
    }

    fn set_state(store: &Store, state: &str) {
        store
            .db
            .execute(
                "UPDATE agent_sessions SET state = ? WHERE id = ?",
                (state, AGENT),
            )
            .unwrap();
    }

    fn set_terminal(store: &Store, state: &str) {
        store
            .db
            .execute(
                "UPDATE terminals SET state = ? WHERE id = 'term_1'",
                [state],
            )
            .unwrap();
    }

    fn append(store: &mut Store, change: AgentChange) {
        store
            .write(|w| {
                w.append(&NewEvent::Agent {
                    agent: agent(),
                    actor: "system".to_owned(),
                    change,
                })
            })
            .unwrap();
    }

    #[test]
    fn finds_each_agent_waiting_on_its_harness_by_its_latest_start_and_that_starts_request() {
        let dir = TempDir::new("waiting");
        let store = store(&dir);
        let launched = raw(&store, AGENT, "agent.launched", "2026-11-20T00:00:01.000Z");
        raw(&store, AGENT, "agent.running", "2026-11-20T00:00:02.000Z");
        let respawn = raw(
            &store,
            AGENT,
            "agent.respawn_requested",
            "2026-11-20T00:00:03.000Z",
        );
        raw(&store, AGENT, "agent.activity", "2026-11-20T00:00:04.000Z");
        let respawned = raw(&store, AGENT, "agent.respawned", "2026-11-20T00:00:05.000Z");
        raw(&store, OTHER, "agent.running", "2026-11-20T00:00:06.000Z");
        let reads = store.reads();
        assert_eq!(
            (
                reads.waiting_starts().unwrap(),
                reads.start_request(AGENT, respawned).unwrap(),
                reads.start_request(AGENT, respawn).unwrap(),
                reads.start_request(AGENT, launched).unwrap(),
                reads.waiting(AGENT).unwrap(),
                reads.waiting(OTHER).unwrap(),
            ),
            (
                vec![Waiting {
                    agent: agent(),
                    start_id: respawned,
                    at: "2026-11-20T00:00:05.000Z".to_owned(),
                }],
                Some(respawn),
                Some(launched),
                None,
                true,
                false,
            )
        );
    }

    #[test]
    fn tells_the_human_once_per_start_and_only_while_the_agent_waits_on_its_harness() {
        let dir = TempDir::new("stuck");
        let mut store = store(&dir);
        let first = raw(&store, AGENT, "agent.running", "2026-11-20T00:00:01.000Z");
        store
            .db
            .execute_batch("UPDATE terminals SET state = 'creating' WHERE id = 'term_1'")
            .unwrap();
        let terminal_not_up = stuck(&mut store, first);
        store
            .db
            .execute_batch("UPDATE terminals SET state = 'running' WHERE id = 'term_1'")
            .unwrap();
        let (told, again) = (stuck(&mut store, first), stuck(&mut store, first));
        // Still open, the first start's item says the agent hasn't come up for a later start too.
        let later = raw(&store, AGENT, "agent.running", "2026-11-20T00:00:02.000Z");
        let while_open = stuck(&mut store, later);
        store
            .db
            .execute_batch("UPDATE attention_items SET state = 'closed', close_reason = 'stale'")
            .unwrap();
        let same_start = stuck(&mut store, first);
        let next = raw(&store, AGENT, "agent.running", "2026-11-20T00:00:03.000Z");
        let next_start = stuck(&mut store, next);
        assert_eq!(
            (
                terminal_not_up,
                told,
                again,
                while_open,
                same_start,
                next_start
            ),
            (false, true, false, false, false, true)
        );
    }

    #[test]
    fn closes_a_stuck_start_as_answered_once_it_is_up_and_as_stale_once_it_is_over() {
        let exited = AgentChange::Exited(AgentExited {
            exit: ExitStatus::Unknown,
        });
        let overs = [
            ("starting", exited),
            ("starting", AgentChange::Lost),
            ("starting", AgentChange::Closing),
            (
                "starting",
                AgentChange::Failed(AgentFailed {
                    reason: AgentFailedReason::LaunchRejected,
                    detail: None,
                }),
            ),
            (
                "starting",
                AgentChange::RespawnRejected(AgentRespawnRejected {
                    reason: RespawnRejectedReason::NotResumable,
                    detail: None,
                }),
            ),
            ("exited", AgentChange::RespawnRequested),
        ];
        for (state, change) in overs {
            let dir = TempDir::new("over");
            let mut store = store(&dir);
            let start = raw(&store, AGENT, "agent.running", "2026-11-20T00:00:01.000Z");
            assert!(stuck(&mut store, start));
            set_state(&store, state);
            let name = change.name();
            if name == "agent.failed" {
                // A launch is refused before its terminal runs.
                set_terminal(&store, "creating");
            }
            append(&mut store, change);
            assert_eq!(items(&store), [closed("stale")], "{name}");
        }
        let dir = TempDir::new("up");
        let mut store = store(&dir);
        let start = raw(&store, AGENT, "agent.running", "2026-11-20T00:00:01.000Z");
        assert!(stuck(&mut store, start));
        append(
            &mut store,
            AgentChange::Ready(AgentReady {
                sign: ReadySign::ClaudeHook,
            }),
        );
        assert_eq!(items(&store), [closed("answered_in_tui")]);
    }

    #[test]
    fn leaves_one_open_item_after_a_stuck_agent_is_respawned_and_sticks_again() {
        let dir = TempDir::new("respawned");
        let mut store = store(&dir);
        let first = raw(&store, AGENT, "agent.running", "2026-11-20T00:00:01.000Z");
        assert!(stuck(&mut store, first));
        append(
            &mut store,
            AgentChange::Exited(AgentExited {
                exit: ExitStatus::Unknown,
            }),
        );
        append(&mut store, AgentChange::RespawnRequested);
        set_terminal(&store, "running");
        let second = raw(&store, AGENT, "agent.respawned", "2026-11-20T00:00:02.000Z");
        assert!(stuck(&mut store, second));
        assert_eq!(items(&store), [closed("stale"), open()]);
    }
}
