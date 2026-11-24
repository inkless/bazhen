//! What the daemon reads of agents to tell who called it: an agent by its token's hash, one known
//! by its id alone, a Codex agent by its thread, and the terminals whose processes a caller may
//! run under. And what a launch reads and writes beside its events: the names agents hold, and
//! each start's token.

use bazhen_protocol::names::name_base;

use crate::events::{Reads, Writer};

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

    /// The agent not ended that holds `name`, ignoring case.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn live_agent_named(self, name: &str) -> rusqlite::Result<Option<String>> {
        self.first(
            "SELECT id FROM agent_sessions
             WHERE name = ? COLLATE NOCASE AND state NOT IN ('closed', 'failed')",
            name,
        )
    }

    /// The default name a new agent in `project` takes, and its number: the first after the last
    /// one given under its base that no agent not ended holds. Read and recorded in one
    /// transaction, by the launch that records it.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn next_default_name(self, project: &str) -> rusqlite::Result<(String, u64)> {
        let base = name_base(project);
        let last: Option<i64> =
            self.first("SELECT last FROM agent_name_counters WHERE base = ?", &base)?;
        let mut ordinal = last.map_or(0, |last| u64::try_from(last).unwrap_or(0));
        loop {
            ordinal = ordinal.saturating_add(1);
            let name = format!("{base}-{ordinal}");
            if self.live_agent_named(&name)?.is_none() {
                return Ok((name, ordinal));
            }
        }
    }

    /// The hash of the agent's current token, or `None` for one that has none.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn agent_token_hash(self, agent_id: &str) -> rusqlite::Result<Option<String>> {
        let hash: Option<Option<String>> = self.first(
            "SELECT token_hash FROM agent_sessions WHERE id = ?",
            agent_id,
        )?;
        Ok(hash.flatten())
    }

    /// Why the agent's last failure says it failed, when its event is kept and says why.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn agent_failure_detail(self, agent_id: &str) -> rusqlite::Result<Option<String>> {
        let payload: Option<String> = self.first(
            "SELECT payload FROM events WHERE entity_id = ? AND type = 'agent.failed'
             ORDER BY id DESC LIMIT 1",
            agent_id,
        )?;
        Ok(payload
            .and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
            .and_then(|payload| payload.get("detail")?.as_str().map(str::to_owned)))
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

impl Writer<'_> {
    /// Makes `hash` the agent's token's, which takes the place of the last at once: the start it
    /// was minted for may call before that start returns.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn note_agent_token(&self, agent_id: &str, hash: &str) -> rusqlite::Result<()> {
        self.connection().execute(
            "UPDATE agent_sessions SET token_hash = ? WHERE id = ?",
            (hash, agent_id),
        )?;
        Ok(())
    }

    /// A start of the agent's own went ahead on a token: its bare id no longer names it.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn kept_agent_token(&self, agent_id: &str) -> rusqlite::Result<()> {
        self.connection().execute(
            "UPDATE agent_sessions SET untokened = 0 WHERE id = ?",
            [agent_id],
        )?;
        Ok(())
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

    /// An agent `id` in `state` holding `name`.
    fn named(store: &Store, id: &str, name: &str, state: &str) {
        seed(store, &Agent { id, state, ..AGENT });
        store
            .db
            .execute(
                "UPDATE agent_sessions SET name = ? WHERE id = ?",
                (name, id),
            )
            .unwrap();
    }

    #[test]
    fn gives_a_default_name_no_live_agent_holds_and_never_a_number_given_before() {
        let dir = TempDir::new("default-name");
        let store = store(&dir);
        named(&store, "agent_01", "p-1", "failed");
        store
            .db
            .execute(
                "INSERT INTO agent_name_counters (base, last) VALUES ('p', 1)",
                (),
            )
            .unwrap();
        named(&store, "agent_02", "P-2", "running");
        assert_eq!(
            [
                store.reads().next_default_name("p").unwrap(),
                store.reads().next_default_name("other project").unwrap(),
            ],
            [("p-3".to_owned(), 3), ("other-project-1".to_owned(), 1)]
        );
    }

    #[test]
    fn finds_the_agent_not_ended_that_holds_a_name_in_any_case() {
        let dir = TempDir::new("live-name");
        let store = store(&dir);
        named(&store, "agent_01", "lead", "closed");
        named(&store, "agent_02", "Lead", "running");
        named(&store, "agent_03", "gone", "failed");
        let reads = store.reads();
        assert_eq!(
            [
                reads.live_agent_named("LEAD").unwrap(),
                reads.live_agent_named("gone").unwrap(),
                reads.live_agent_named("lea").unwrap(),
            ],
            [Some("agent_02".to_owned()), None, None]
        );
    }

    #[test]
    fn takes_a_new_tokens_hash_in_place_of_the_last_and_keeps_the_start_that_went_ahead_on_it() {
        let dir = TempDir::new("token-hash");
        let mut store = store(&dir);
        seed(
            &store,
            &Agent {
                token_hash: Some("old"),
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
        let before = store.reads().agent_untokened("agent_01").unwrap();
        store
            .write(|w| {
                w.note_agent_token("agent_01", "new")?;
                w.kept_agent_token("agent_01")
            })
            .unwrap();
        let reads = store.reads();
        assert_eq!(
            [
                reads.agent_token_hash("agent_01").unwrap(),
                reads.agent_token_hash("agent_02").unwrap(),
                reads.agent_token_hash("agent_09").unwrap(),
            ],
            [Some("new".to_owned()), None, None]
        );
        assert_eq!(
            (before, reads.agent_untokened("agent_01").unwrap()),
            (true, false)
        );
    }

    #[test]
    fn says_why_the_agents_last_failure_said_it_failed_when_it_said() {
        let dir = TempDir::new("failure-detail");
        let store = store(&dir);
        store
            .db
            .execute_batch(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'agent.failed', 'agent', 'agent_01',
                     'system', '{\"reason\":\"launch_rejected\",\"detail\":\"first\"}' FROM host;
                 INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'agent.failed', 'agent', 'agent_01',
                     'system', '{\"reason\":\"launch_rejected\",\"detail\":\"last\"}' FROM host;
                 INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'agent.failed', 'agent', 'agent_02',
                     'system', '{\"reason\":\"launch_rejected\"}' FROM host;
                 INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'agent.running', 'agent', 'agent_03',
                     'system', '{\"detail\":\"not a failure\"}' FROM host;",
            )
            .unwrap();
        let reads = store.reads();
        assert_eq!(
            ["agent_01", "agent_02", "agent_03"].map(|id| reads.agent_failure_detail(id).unwrap()),
            [Some("last".to_owned()), None, None]
        );
    }

    #[test]
    fn recalls_what_a_key_recorded_as_it_was_recorded_and_nothing_for_a_key_never_used() {
        let dir = TempDir::new("recall");
        let mut store = store(&dir);
        let record = serde_json::json!({"request": {"cwd": "/w"}, "response": {}, "failed": true});
        let recalled = store
            .write(|w| -> Result<_, crate::OnceError> {
                w.remember("launch", &serde_json::json!({"failed": false}))?;
                w.remember("launch", &record)?;
                Ok([w.recall("launch")?, w.recall("never")?])
            })
            .unwrap();
        assert_eq!(recalled, [Some(record), None]);
    }
}
