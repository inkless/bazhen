//! What the daemon reads of agents to tell who called it: an agent by its token's hash, one known
//! by its id alone, a Codex agent by its thread, and the terminals whose processes a caller may
//! run under.

use crate::events::Reads;

/// A terminal not yet ended that a runtime holds, as its row records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveTerminal {
    /// `agent` or `shell`.
    pub kind: String,
    pub agent_id: Option<String>,
    /// Where its runtime keeps it, as the JSON text the runtime recorded.
    pub locator: String,
}

impl Reads<'_> {
    /// The agent whose current token hashes to `hash`, unless it has ended.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn agent_by_token_hash(self, hash: &str) -> rusqlite::Result<Option<String>> {
        self.first(
            "SELECT id FROM agent_sessions WHERE token_hash = ? AND state NOT IN ('closed', 'failed')",
            hash,
        )
    }

    /// Whether the agent ran from before agents had tokens, no start has given it one since, and
    /// it hasn't ended.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn agent_untokened(self, agent_id: &str) -> rusqlite::Result<bool> {
        let untokened: Option<i64> = self.first(
            "SELECT untokened FROM agent_sessions WHERE id = ? AND state NOT IN ('closed', 'failed')",
            agent_id,
        )?;
        Ok(untokened == Some(1))
    }

    /// The live Codex agent bound to a thread, if exactly one is: of two, neither is guessed at,
    /// so nothing meant for one reaches the other.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn codex_agent(self, thread: &str) -> rusqlite::Result<Option<String>> {
        let mut rows = self.0.prepare(
            "SELECT id FROM agent_sessions WHERE harness = 'codex' AND state IN ('starting', 'running')
               AND json_extract(external_ref, '$.kind') = 'codex-thread'
               AND json_extract(external_ref, '$.id') = ? LIMIT 2",
        )?;
        let ids = rows
            .query_map([thread], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(match <[String; 1]>::try_from(ids) {
            Ok([id]) => Some(id),
            Err(_) => None,
        })
    }

    /// The agent's state, or `None` for an agent the store doesn't know.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn agent_state(self, agent_id: &str) -> rusqlite::Result<Option<String>> {
        self.first("SELECT state FROM agent_sessions WHERE id = ?", agent_id)
    }

    /// Every terminal not yet ended that a runtime holds.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn live_terminals(self) -> rusqlite::Result<Vec<LiveTerminal>> {
        let mut rows = self.0.prepare(
            "SELECT kind, agent_session_id, locator FROM terminals
             WHERE state NOT IN ('closed', 'failed') AND locator IS NOT NULL",
        )?;
        rows.query_map((), |row| {
            Ok(LiveTerminal {
                kind: row.get(0)?,
                agent_id: row.get(1)?,
                locator: row.get(2)?,
            })
        })?
        .collect()
    }

    fn first<T: rusqlite::types::FromSql>(
        self,
        sql: &str,
        key: &str,
    ) -> rusqlite::Result<Option<T>> {
        let mut rows = self.0.prepare(sql)?;
        let mut found = rows.query([key])?;
        found.next()?.map(|row| row.get(0)).transpose()
    }
}

#[cfg(test)]
mod tests {
    use crate::testing::TempDir;
    use crate::{LiveTerminal, Store};

    /// A store with one environment and one event every row below can point at.
    fn store(dir: &TempDir) -> Store {
        let store = Store::open(&dir.db("agents.db")).unwrap();
        store
            .db
            .execute_batch(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{}' FROM host;
                 INSERT INTO environments (id, kind, created_event_id) VALUES ('env_local', 'local', 1);",
            )
            .unwrap();
        store
    }

    struct Agent<'a> {
        id: &'a str,
        harness: &'a str,
        state: &'a str,
        token_hash: Option<&'a str>,
        untokened: bool,
        external_ref: Option<&'a str>,
    }

    const AGENT: Agent<'static> = Agent {
        id: "agent_01",
        harness: "claude-code",
        state: "running",
        token_hash: None,
        untokened: false,
        external_ref: None,
    };

    fn seed(store: &Store, agent: &Agent<'_>) {
        store
            .db
            .execute(
                "INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   external_ref, token_hash, untokened, created_event_id, updated_event_id)
                 VALUES (?, 'env_local', ?, 'p', '/', ?, ?, ?, ?, 1, 1)",
                (
                    agent.id,
                    agent.harness,
                    agent.state,
                    agent.external_ref,
                    agent.token_hash,
                    i64::from(agent.untokened),
                ),
            )
            .unwrap();
    }

    fn terminal(
        store: &Store,
        id: &str,
        kind: &str,
        state: &str,
        agent: Option<&str>,
        locator: Option<&str>,
    ) {
        store
            .db
            .execute(
                "INSERT INTO terminals (id, host_id, state, generation, locator, kind,
                   agent_session_id, created_event_id, updated_event_id)
                 SELECT ?, id, ?, 0, ?, ?, ?, 1, 1 FROM host",
                (id, state, locator, kind, agent),
            )
            .unwrap();
    }

    #[test]
    fn knows_a_live_agent_by_its_tokens_hash_and_an_ended_one_by_none() {
        let dir = TempDir::new("by-hash");
        let store = store(&dir);
        seed(
            &store,
            &Agent {
                token_hash: Some("aa"),
                ..AGENT
            },
        );
        for (id, state, hash) in [("agent_02", "closed", "bb"), ("agent_03", "failed", "cc")] {
            seed(
                &store,
                &Agent {
                    id,
                    state,
                    token_hash: Some(hash),
                    ..AGENT
                },
            );
        }
        let reads = store.reads();
        assert_eq!(
            ["aa", "bb", "cc", "dd"].map(|hash| reads.agent_by_token_hash(hash).unwrap()),
            [Some("agent_01".to_owned()), None, None, None]
        );
    }

    #[test]
    fn knows_an_agent_by_its_id_alone_only_while_it_is_untokened_and_live() {
        let dir = TempDir::new("untokened");
        let store = store(&dir);
        seed(
            &store,
            &Agent {
                untokened: true,
                ..AGENT
            },
        );
        seed(
            &store,
            &Agent {
                id: "agent_02",
                ..AGENT
            },
        );
        seed(
            &store,
            &Agent {
                id: "agent_03",
                state: "closed",
                untokened: true,
                ..AGENT
            },
        );
        seed(
            &store,
            &Agent {
                id: "agent_04",
                state: "failed",
                untokened: true,
                ..AGENT
            },
        );
        let reads = store.reads();
        assert_eq!(
            ["agent_01", "agent_02", "agent_03", "agent_04", "agent_05"]
                .map(|id| reads.agent_untokened(id).unwrap()),
            [true, false, false, false, false]
        );
    }

    #[test]
    fn knows_the_one_live_codex_agent_bound_to_a_thread_and_none_where_two_are() {
        let dir = TempDir::new("codex");
        let store = store(&dir);
        let bound = |id, state, thread: &'static str| Agent {
            id,
            harness: "codex",
            state,
            external_ref: Some(thread),
            ..AGENT
        };
        seed(
            &store,
            &bound(
                "agent_01",
                "running",
                r#"{"kind":"codex-thread","id":"t-1"}"#,
            ),
        );
        seed(
            &store,
            &bound(
                "agent_02",
                "starting",
                r#"{"kind":"codex-thread","id":"t-2"}"#,
            ),
        );
        seed(
            &store,
            &bound(
                "agent_03",
                "running",
                r#"{"kind":"codex-thread","id":"t-3"}"#,
            ),
        );
        seed(
            &store,
            &bound(
                "agent_04",
                "starting",
                r#"{"kind":"codex-thread","id":"t-3"}"#,
            ),
        );
        seed(
            &store,
            &bound(
                "agent_05",
                "closed",
                r#"{"kind":"codex-thread","id":"t-5"}"#,
            ),
        );
        seed(
            &store,
            &bound(
                "agent_06",
                "running",
                r#"{"kind":"claude-session","id":"t-6"}"#,
            ),
        );
        seed(
            &store,
            &Agent {
                id: "agent_07",
                external_ref: Some(r#"{"kind":"codex-thread","id":"t-7"}"#),
                ..AGENT
            },
        );
        let reads = store.reads();
        assert_eq!(
            ["t-1", "t-2", "t-3", "t-5", "t-6", "t-7", "t-8"]
                .map(|t| reads.codex_agent(t).unwrap()),
            [
                Some("agent_01".to_owned()),
                Some("agent_02".to_owned()),
                None,
                None,
                None,
                None,
                None
            ]
        );
    }

    #[test]
    fn reads_an_agents_state_and_none_for_one_it_doesnt_know() {
        let dir = TempDir::new("state");
        let store = store(&dir);
        seed(
            &store,
            &Agent {
                state: "closed",
                ..AGENT
            },
        );
        let reads = store.reads();
        assert_eq!(
            [
                reads.agent_state("agent_01").unwrap(),
                reads.agent_state("agent_02").unwrap()
            ],
            [Some("closed".to_owned()), None]
        );
    }

    #[test]
    fn lists_the_terminals_not_yet_ended_that_a_runtime_holds() {
        let dir = TempDir::new("terminals");
        let store = store(&dir);
        seed(&store, &AGENT);
        terminal(
            &store,
            "term_1",
            "agent",
            "running",
            Some("agent_01"),
            Some(r#"{"panePid":10}"#),
        );
        terminal(
            &store,
            "term_2",
            "shell",
            "starting",
            None,
            Some(r#"{"childPid":11}"#),
        );
        terminal(
            &store,
            "term_3",
            "agent",
            "closed",
            Some("agent_01"),
            Some(r#"{"panePid":12}"#),
        );
        terminal(
            &store,
            "term_4",
            "shell",
            "failed",
            None,
            Some(r#"{"childPid":13}"#),
        );
        terminal(&store, "term_5", "shell", "creating", None, None);
        assert_eq!(
            store.reads().live_terminals().unwrap(),
            [
                LiveTerminal {
                    kind: "agent".into(),
                    agent_id: Some("agent_01".into()),
                    locator: r#"{"panePid":10}"#.into()
                },
                LiveTerminal {
                    kind: "shell".into(),
                    agent_id: None,
                    locator: r#"{"childPid":11}"#.into()
                }
            ]
        );
    }
}
