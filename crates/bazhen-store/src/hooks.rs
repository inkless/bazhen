//! What a hook of an agent's is read against, and what it records of the session it came from:
//! the session the agent is bound to, which a new one its TUI started moves, and where that
//! session keeps its conversation (`store.ts` `claudeBinding`, `recordTranscript`, binding.ts's
//! `rebind`).

use bazhen_protocol::agent_events::{AgentExternalRefUpdated, AgentTranscriptRecorded};
use bazhen_protocol::agents::{ExternalRef, ExternalRefKind};
use bazhen_protocol::ids::{AgentId, EnvironmentId};

use crate::agent_events::AgentChange;
use crate::events::{AppendError, NewEvent, Reads, Writer};

/// The longest transcript path the protocol holds, in code points, as zod counts them.
pub const MAX_TRANSCRIPT_PATH: usize = 4096;

/// What a hook of an agent's is read against, as its rows record it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentBinding {
    /// The agent's state.
    pub state: String,
    /// The harness it runs, by its id.
    pub harness: String,
    pub environment: Option<String>,
    /// The session the agent is bound to, as its stored external ref names it.
    pub session: Option<ExternalRef>,
    pub transcript: Option<String>,
    /// The agent's terminal's state, when it has one.
    pub terminal_state: Option<String>,
    /// Where the terminal's runtime keeps it, as the JSON text the runtime recorded.
    pub locator: Option<String>,
}

impl Reads<'_> {
    /// What a hook of `agent_id`'s is read against; `None` for an agent the store doesn't know.
    /// A stored external ref that isn't one binds no session, as `ExternalRef.parse` would
    /// refuse it.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn agent_binding(self, agent_id: &str) -> rusqlite::Result<Option<AgentBinding>> {
        let mut rows = self.0.prepare(
            "SELECT a.state, a.harness, a.environment_id, a.external_ref, a.transcript, t.state, t.locator
             FROM agent_sessions a LEFT JOIN terminals t ON t.id = a.terminal_id
             WHERE a.id = ?",
        )?;
        let mut found = rows.query([agent_id])?;
        let Some(row) = found.next()? else {
            return Ok(None);
        };
        let external_ref: Option<String> = row.get(3)?;
        Ok(Some(AgentBinding {
            state: row.get(0)?,
            harness: row.get(1)?,
            environment: row.get(2)?,
            session: external_ref.and_then(|text| serde_json::from_str(&text).ok()),
            transcript: row.get(4)?,
            terminal_state: row.get(5)?,
            locator: row.get(6)?,
        }))
    }
}

impl Writer<'_> {
    /// Binds the agent to its harness's session `id`, of `kind`, as its TUI started it. One it is
    /// bound to already records nothing, so a repeat of the same start gives one event, not two,
    /// as does an agent in no environment, which can't name a ref.
    ///
    /// # Errors
    ///
    /// The append's.
    pub fn bind_session(
        &self,
        agent: &AgentId,
        kind: ExternalRefKind,
        id: &str,
    ) -> Result<Option<u64>, AppendError> {
        let Some(binding) = self.reads().agent_binding(agent.as_str())? else {
            return Ok(None);
        };
        if binding
            .session
            .as_ref()
            .is_some_and(|bound| bound.kind == kind && bound.id == id)
        {
            return Ok(None);
        }
        let environment = binding.environment.as_deref();
        let Some(environment_id) = environment.and_then(EnvironmentId::parse) else {
            return Ok(None);
        };
        let change = AgentChange::ExternalRefUpdated(AgentExternalRefUpdated {
            external_ref: ExternalRef {
                environment_id,
                kind,
                id: id.to_owned(),
            },
        });
        self.append(&system(agent, change)).map(Some)
    }

    /// Records where the agent's bound session `session_id` keeps its conversation. A session it
    /// isn't bound to, or a path already recorded, records nothing; nor does a path the protocol
    /// can't hold, longer than [`MAX_TRANSCRIPT_PATH`] or not absolute, which the TypeScript
    /// daemon's append refuses.
    ///
    /// # Errors
    ///
    /// The append's.
    pub fn record_transcript(
        &self,
        agent: &AgentId,
        session_id: &str,
        path: &str,
    ) -> Result<Option<u64>, AppendError> {
        if session_id.is_empty()
            || !path.starts_with('/')
            || path.chars().count() > MAX_TRANSCRIPT_PATH
        {
            return Ok(None);
        }
        let Some(binding) = self.reads().agent_binding(agent.as_str())? else {
            return Ok(None);
        };
        let bound = binding
            .session
            .as_ref()
            .is_some_and(|bound| bound.id == session_id);
        if !bound || binding.transcript.as_deref() == Some(path) {
            return Ok(None);
        }
        let change = AgentChange::TranscriptRecorded(AgentTranscriptRecorded {
            session_id: session_id.to_owned(),
            path: path.to_owned(),
        });
        self.append(&system(agent, change)).map(Some)
    }
}

fn system(agent: &AgentId, change: AgentChange) -> NewEvent {
    NewEvent::Agent {
        agent: agent.clone(),
        actor: "system".to_owned(),
        change,
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::agents::{ExternalRef, ExternalRefKind};
    use bazhen_protocol::ids::{AgentId, EnvironmentId};

    use super::{AgentBinding, MAX_TRANSCRIPT_PATH};
    use crate::Store;
    use crate::testing::TempDir;

    const ENV: &str = "env_01900000000070008000000000000009";
    const AGENT: &str = "agent_01900000000070008000000000000001";
    const CLAUDE: ExternalRefKind = ExternalRefKind::ClaudeSession;

    fn agent() -> AgentId {
        AgentId::parse(AGENT).unwrap()
    }

    /// A store with a running agent in `env_01900000000070008000000000000009`, bound to `external_ref`, on a terminal.
    fn store(dir: &TempDir, external_ref: Option<&str>) -> Store {
        let store = Store::open(&dir.db("hooks.db")).unwrap();
        store
            .db
            .execute_batch(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{}' FROM host;
                 INSERT INTO environments (id, kind, created_event_id) VALUES ('env_01900000000070008000000000000009', 'local', 1);
                 INSERT INTO terminals (id, host_id, state, generation, locator, kind,
                   agent_session_id, created_event_id, updated_event_id)
                   SELECT 'term_1', id, 'running', 0, '{\"childPid\":40}', 'agent', NULL, 1, 1 FROM host;",
            )
            .unwrap();
        store
            .db
            .execute(
                "INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   external_ref, terminal_id, created_event_id, updated_event_id)
                 VALUES (?, 'env_01900000000070008000000000000009', 'claude-code', 'p', '/', 'running', ?, 'term_1', 1, 1)",
                (AGENT, external_ref),
            )
            .unwrap();
        store
    }

    const BOUND: &str = r#"{"environmentId":"env_01900000000070008000000000000009","kind":"claude-session","id":"s-1"}"#;

    fn session(id: &str) -> ExternalRef {
        ExternalRef {
            environment_id: EnvironmentId::parse(ENV).unwrap(),
            kind: CLAUDE,
            id: id.to_owned(),
        }
    }

    fn binding(store: &Store) -> Option<AgentBinding> {
        store.reads().agent_binding(AGENT).unwrap()
    }

    fn events(store: &Store) -> Vec<(String, String)> {
        let mut rows = store
            .db
            .prepare("SELECT type, payload FROM events WHERE id > 1 ORDER BY id")
            .unwrap();
        rows.query_map((), |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn reads_an_agents_session_transcript_and_terminal_and_nothing_for_an_unknown_agent() {
        let (dir, unbound_dir) = (TempDir::new("binding"), TempDir::new("unbound"));
        let unbound = store(&unbound_dir, Some("not json"));
        let store = store(&dir, Some(BOUND));
        assert_eq!(
            [
                binding(&store),
                binding(&unbound),
                store.reads().agent_binding("agent_02").unwrap(),
            ],
            [
                Some(AgentBinding {
                    state: "running".to_owned(),
                    harness: "claude-code".to_owned(),
                    environment: Some(ENV.to_owned()),
                    session: Some(session("s-1")),
                    transcript: None,
                    terminal_state: Some("running".to_owned()),
                    locator: Some(r#"{"childPid":40}"#.to_owned()),
                }),
                Some(AgentBinding {
                    state: "running".to_owned(),
                    harness: "claude-code".to_owned(),
                    environment: Some(ENV.to_owned()),
                    session: None,
                    transcript: None,
                    terminal_state: Some("running".to_owned()),
                    locator: Some(r#"{"childPid":40}"#.to_owned()),
                }),
                None,
            ]
        );
    }

    #[test]
    fn binds_an_agent_to_a_new_session_once_however_often_its_start_is_reported() {
        let dir = TempDir::new("bind");
        let mut store = store(&dir, Some(BOUND));
        let bound = |store: &mut Store, id: &str| {
            store
                .write(|w| w.bind_session(&agent(), CLAUDE, id))
                .unwrap()
                .is_some()
        };
        assert_eq!(
            [
                bound(&mut store, "s-1"),
                bound(&mut store, "s-2"),
                bound(&mut store, "s-2"),
            ],
            [false, true, false]
        );
        assert_eq!(
            (binding(&store).unwrap().session, events(&store)),
            (
                Some(session("s-2")),
                vec![(
                    "agent.external_ref_updated".to_owned(),
                    r#"{"externalRef":{"environmentId":"env_01900000000070008000000000000009","kind":"claude-session","id":"s-2"}}"#
                        .to_owned()
                )]
            )
        );
    }

    #[test]
    fn binds_no_session_for_an_agent_in_no_environment_it_can_name() {
        let dir = TempDir::new("no-env");
        let mut store = store(&dir, None);
        store
            .db
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 UPDATE agent_sessions SET environment_id = 'nowhere';
                 PRAGMA foreign_keys = ON;",
            )
            .unwrap();
        let bound = store.write(|w| w.bind_session(&agent(), CLAUDE, "s-1"));
        assert_eq!((bound.unwrap(), events(&store)), (None, vec![]));
    }

    #[test]
    fn records_where_only_the_bound_session_keeps_its_conversation_once() {
        let dir = TempDir::new("transcript");
        let mut store = store(&dir, Some(BOUND));
        let mut record = |session: &str, path: &str| {
            store
                .write(|w| w.record_transcript(&agent(), session, path))
                .unwrap()
                .is_some()
        };
        assert_eq!(
            [
                record("s-2", "/t/s-2.jsonl"),
                record("s-1", "/t/s-1.jsonl"),
                record("s-1", "/t/s-1.jsonl"),
                record("s-1", "/t/moved.jsonl"),
            ],
            [false, true, false, true]
        );
        assert_eq!(
            binding(&store).unwrap().transcript.as_deref(),
            Some("/t/moved.jsonl")
        );
    }

    #[test]
    fn records_no_path_the_protocol_cant_hold_by_its_length_in_code_points_or_its_start() {
        let dir = TempDir::new("bounds");
        let mut store = store(&dir, Some(BOUND));
        let longest = format!("/{}", "é".repeat(MAX_TRANSCRIPT_PATH - 1));
        let over = format!("/{}", "a".repeat(MAX_TRANSCRIPT_PATH));
        let mut record = |session: &str, path: &str| {
            store
                .write(|w| w.record_transcript(&agent(), session, path))
                .unwrap()
                .is_some()
        };
        assert_eq!(
            [
                record("s-1", &over),
                record("s-1", "t/relative.jsonl"),
                record("", "/t/none.jsonl"),
                record("s-1", &longest),
            ],
            [false, false, false, true]
        );
    }
}
