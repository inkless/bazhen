//! What the daemon reads of agents to tell who called it: an agent by its token's hash, one known
//! by its id alone, a Codex agent by its thread, and the terminals whose processes a caller may
//! run under. And what a launch reads and writes beside its events: the names agents hold, and
//! each start's token. And a rename, once per key.

use bazhen_protocol::agent_events::AgentRenamed;
use bazhen_protocol::agents::{AgentCommandResponse, ExternalRef, HarnessId};
use bazhen_protocol::ids::AgentId;
use bazhen_protocol::names::{Role, name_base};
use bazhen_protocol::shells::TuiTheme;
use rusqlite::OptionalExtension as _;
use serde::Serialize;

use crate::Store;
use crate::agent_events::AgentChange;
use crate::events::{AppendError, NewEvent, OnceError, Reads, Writer};

/// The states an agent has ended in, which no rename changes.
const ENDED: [&str; 2] = ["closed", "failed"];

/// What an agent was launched with, and the harness session it is on: what starting it again
/// starts it with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLaunch {
    pub harness: HarnessId,
    pub project: String,
    /// The directory it was launched in, as resolved.
    pub cwd: String,
    /// Its name now, which a start gives its harness; none for an agent from before names.
    pub name: Option<String>,
    /// The role whose prompt it was launched with.
    pub role: Option<Role>,
    /// The hash of the prompt its last start gave it, when a start recorded one.
    pub prompt_hash: Option<String>,
    /// The compaction window every start gives it; none for the harness's own.
    pub compact_window_tokens: Option<u32>,
    /// The harness session it is bound to, once one is.
    pub external_ref: Option<ExternalRef>,
    /// Where that session keeps its conversation, as one of its hooks reported it.
    pub transcript: Option<String>,
    /// The theme its terminal was last drawn for, once it has a terminal that was.
    pub theme: Option<TuiTheme>,
}

/// A stored word, such as a state or an id, read as the protocol's type for it.
pub(crate) fn word<T: serde::de::DeserializeOwned>(text: String) -> Result<T, serde_json::Error> {
    serde_json::from_value(serde_json::Value::String(text))
}

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

    /// The agents that hold the harness session `session` names, by id: each bound to it that
    /// isn't closed or failed, since an exited or lost agent is started again on the session it
    /// is bound to.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn session_holders(self, session: &ExternalRef) -> rusqlite::Result<Vec<String>> {
        let kind = serde_json::to_value(session.kind)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
        let mut rows = self.0.prepare(
            "SELECT id FROM agent_sessions WHERE state NOT IN ('closed', 'failed')
               AND json_extract(external_ref, '$.kind') = ?
               AND json_extract(external_ref, '$.id') = ? ORDER BY id",
        )?;
        rows.query_map((kind.as_str(), session.id.as_str()), |row| row.get(0))?
            .collect()
    }

    /// The agent's state, or `None` for an agent the store doesn't know.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn agent_state(self, agent_id: &str) -> rusqlite::Result<Option<String>> {
        self.first("SELECT state FROM agent_sessions WHERE id = ?", agent_id)
    }

    /// What the agent was launched with and the session it is on, or `None` for an agent the
    /// store doesn't know.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a row no launch could have written.
    pub fn agent_launch(self, agent_id: &str) -> rusqlite::Result<Option<AgentLaunch>> {
        self.0
            .query_row(
                "SELECT a.harness, a.project, a.cwd, a.name, a.role, a.prompt_hash,
                   a.compact_window, a.external_ref, a.transcript, t.theme
                 FROM agent_sessions a LEFT JOIN terminals t ON t.id = a.terminal_id
                 WHERE a.id = ?",
                [agent_id],
                |row| {
                    use rusqlite::types::Type;
                    let unreadable = |i: usize, kind: Type, what: &str| {
                        rusqlite::Error::FromSqlConversionFailure(
                            i,
                            kind,
                            format!("{what} isn't one a launch records").into(),
                        )
                    };
                    let compact: Option<i64> = row.get(6)?;
                    let external_ref: Option<String> = row.get(7)?;
                    Ok(AgentLaunch {
                        harness: word(row.get(0)?)
                            .map_err(|_| unreadable(0, Type::Text, "its harness"))?,
                        project: row.get(1)?,
                        cwd: row.get(2)?,
                        name: row.get(3)?,
                        role: row
                            .get::<_, Option<String>>(4)?
                            .map(word)
                            .transpose()
                            .map_err(|_| unreadable(4, Type::Text, "its role"))?,
                        prompt_hash: row.get(5)?,
                        compact_window_tokens: compact
                            .map(|n| {
                                u32::try_from(n).map_err(|_| {
                                    unreadable(6, Type::Integer, "its compaction window")
                                })
                            })
                            .transpose()?,
                        external_ref: external_ref
                            .map(|text| {
                                serde_json::from_str(&text)
                                    .map_err(|_| unreadable(7, Type::Text, "its harness session"))
                            })
                            .transpose()?,
                        transcript: row.get(8)?,
                        theme: row
                            .get::<_, Option<String>>(9)?
                            .map(|text| {
                                TuiTheme::parse(&text).ok_or_else(|| {
                                    unreadable(9, Type::Text, "its terminal's theme")
                                })
                            })
                            .transpose()?,
                    })
                },
            )
            .optional()
    }

    /// The directory the agent was launched in, as resolved: where a shell linked to it opens.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn agent_cwd(self, agent_id: &str) -> rusqlite::Result<Option<String>> {
        self.first("SELECT cwd FROM agent_sessions WHERE id = ?", agent_id)
    }

    /// The agent `reference` names: by its id, any agent the store knows; by its name, the one
    /// not ended that holds it. `None` for one it names no agent by.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn resolve_agent(self, reference: &str) -> rusqlite::Result<Option<String>> {
        if AgentId::parse(reference).is_some() {
            return Ok(self.agent_state(reference)?.map(|_| reference.to_owned()));
        }
        self.live_agent_named(reference)
    }

    /// The agent's name, if it has one, and its state; `None` for an agent the store doesn't know.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn agent_name_and_state(
        self,
        agent_id: &str,
    ) -> rusqlite::Result<Option<(Option<String>, String)>> {
        let mut rows = self
            .0
            .prepare("SELECT name, state FROM agent_sessions WHERE id = ?")?;
        let mut found = rows.query([agent_id])?;
        found
            .next()?
            .map(|row| Ok((row.get(0)?, row.get(1)?)))
            .transpose()
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

/// A rename of an agent, as `POST /v1/agents/:id/rename` asks for it, its agent already resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rename {
    pub key: String,
    /// The agent asking, or `None` for the human.
    pub caller: Option<String>,
    pub agent: AgentId,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeptRename<'a> {
    caller: Option<&'a str>,
    agent_id: &'a str,
    name: &'a str,
}

impl Rename {
    /// The text a repeat of this request must match, as the TypeScript daemon writes it.
    ///
    /// # Errors
    ///
    /// `serde_json`'s, which a struct of strings never meets.
    pub fn request_text(&self) -> serde_json::Result<String> {
        serde_json::to_string(&KeptRename {
            caller: self.caller.as_deref(),
            agent_id: self.agent.as_str(),
            name: &self.name,
        })
    }
}

/// Why an agent wasn't renamed.
#[derive(Debug, thiserror::Error)]
pub enum RenameError {
    /// Another agent asked: an agent renames only itself.
    #[error("an agent can rename only itself")]
    Forbidden,
    #[error("no agent {0}")]
    Unknown(String),
    #[error("agent {agent} is {state}; only an agent not ended can be renamed")]
    Ended { agent: String, state: String },
    #[error("another agent is named {0}; close it or pick another name")]
    NameTaken(String),
    #[error(transparent)]
    Once(#[from] OnceError),
    #[error(transparent)]
    Append(#[from] AppendError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl Store {
    /// Renames an agent, or answers what its key was first answered (`names.ts` `renameAgent`).
    /// The human renames any agent, an agent only itself; a name another agent not ended holds,
    /// in any case, is refused, and the name it already has is no change.
    ///
    /// # Errors
    ///
    /// [`RenameError`]; nothing is recorded then.
    pub fn rename_agent(&mut self, rename: &Rename) -> Result<AgentCommandResponse, RenameError> {
        self.once(&rename.key, &rename.request_text()?, |w| {
            let agent = rename.agent.as_str();
            if rename
                .caller
                .as_deref()
                .is_some_and(|caller| caller != agent)
            {
                return Err(RenameError::Forbidden);
            }
            let reads = w.reads();
            let Some((previous, state)) = reads.agent_name_and_state(agent)? else {
                return Err(RenameError::Unknown(agent.to_owned()));
            };
            if ENDED.contains(&state.as_str()) {
                return Err(RenameError::Ended {
                    agent: agent.to_owned(),
                    state,
                });
            }
            let answer = |event_ids| AgentCommandResponse {
                agent_id: rename.agent.clone(),
                event_ids,
            };
            if previous.as_deref() == Some(rename.name.as_str()) {
                return Ok(answer(Vec::new()));
            }
            if reads
                .live_agent_named(&rename.name)?
                .is_some_and(|holder| holder != agent)
            {
                return Err(RenameError::NameTaken(rename.name.clone()));
            }
            let id = w.append(&NewEvent::Agent {
                agent: rename.agent.clone(),
                actor: rename.caller.clone().unwrap_or_else(|| "user".to_owned()),
                change: AgentChange::Renamed(AgentRenamed {
                    name: rename.name.clone(),
                    // An agent from before agents had names has none, which store.ts reads
                    // with String(), as "null".
                    previous: previous.unwrap_or_else(|| "null".to_owned()),
                }),
            })?;
            Ok(answer(vec![id]))
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::testing::TempDir;
    use bazhen_protocol::agents::AgentState;
    use bazhen_protocol::ids::{AgentId, TerminalId};
    use bazhen_protocol::shells::TerminalState;

    use crate::{AgentTerminal, LiveTerminal, Store};

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
    fn reads_what_an_agent_was_launched_with_and_the_session_its_on_and_none_for_an_unknown_one() {
        use bazhen_protocol::agents::{ExternalRef, HarnessId};
        use bazhen_protocol::names::Role;
        use bazhen_protocol::shells::TuiTheme;
        let dir = TempDir::new("agents");
        let store = store(&dir);
        let session = r#"{"environmentId":"env_01900000000070008000000000000001","kind":"claude-session","id":"s-1"}"#;
        seed(
            &store,
            &Agent {
                external_ref: Some(session),
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
                id: "agent_04",
                ..AGENT
            },
        );
        store
            .db
            .execute_batch(
                "UPDATE agent_sessions SET name = 'lead', role = 'reviewer', prompt_hash = 'h1',
                   compact_window = 120000, transcript = '/c/s-1.jsonl' WHERE id = 'agent_01';
                 UPDATE agent_sessions SET harness = 'emacs' WHERE id = 'agent_02';",
            )
            .unwrap();
        terminal(&store, "term_1", "agent", "exited", Some("agent_01"), None);
        store
            .db
            .execute_batch(
                "UPDATE terminals SET theme = 'light' WHERE id = 'term_1';
                 UPDATE agent_sessions SET terminal_id = 'term_1' WHERE id = 'agent_01';",
            )
            .unwrap();
        let reads = store.reads();
        assert_eq!(
            (
                reads.agent_launch("agent_01").ok(),
                reads.agent_launch("agent_02").is_err(),
                reads.agent_launch("agent_03").ok(),
                reads.agent_launch("agent_04").ok(),
            ),
            (
                Some(Some(crate::AgentLaunch {
                    harness: HarnessId::ClaudeCode,
                    project: "p".to_owned(),
                    cwd: "/".to_owned(),
                    name: Some("lead".to_owned()),
                    role: Some(Role::parse("reviewer").unwrap()),
                    prompt_hash: Some("h1".to_owned()),
                    compact_window_tokens: Some(120_000),
                    external_ref: Some(serde_json::from_str::<ExternalRef>(session).unwrap()),
                    transcript: Some("/c/s-1.jsonl".to_owned()),
                    theme: Some(TuiTheme::Light),
                })),
                true,
                Some(None),
                Some(Some(crate::AgentLaunch {
                    harness: HarnessId::ClaudeCode,
                    project: "p".to_owned(),
                    cwd: "/".to_owned(),
                    name: None,
                    role: None,
                    prompt_hash: None,
                    compact_window_tokens: None,
                    external_ref: None,
                    transcript: None,
                    theme: None,
                })),
            )
        );
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
    fn names_every_agent_holding_a_session_but_those_closed_or_failed() {
        let dir = TempDir::new("holders");
        let store = store(&dir);
        let on = |id, state, kind: &str| {
            let external_ref = format!(r#"{{"kind":"{kind}","id":"t-1"}}"#);
            store
                .db
                .execute(
                    "INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                       external_ref, untokened, created_event_id, updated_event_id)
                     VALUES (?, 'env_local', 'codex', 'p', '/', ?, ?, 0, 1, 1)",
                    (id, state, external_ref),
                )
                .unwrap();
        };
        on("agent_01", "exited", "codex-thread");
        on("agent_02", "lost", "codex-thread");
        on("agent_03", "closed", "codex-thread");
        on("agent_04", "failed", "codex-thread");
        on("agent_05", "running", "claude-session");
        on("agent_06", "running", "codex-thread");
        let reads = store.reads();
        let session = |id: &str| {
            serde_json::from_value::<bazhen_protocol::agents::ExternalRef>(serde_json::json!({
                "environmentId": "env_01900000000070008000000000000001",
                "kind": "codex-thread",
                "id": id,
            }))
            .unwrap()
        };
        assert_eq!(
            (
                reads.session_holders(&session("t-1")).unwrap(),
                reads.session_holders(&session("t-2")).unwrap(),
            ),
            (
                vec![
                    "agent_01".to_owned(),
                    "agent_02".to_owned(),
                    "agent_06".to_owned()
                ],
                Vec::<String>::new(),
            )
        );
    }

    #[test]
    fn reads_an_agent_with_its_current_terminal_and_none_for_one_it_doesnt_know() {
        let dir = TempDir::new("agent-terminal");
        let store = store(&dir);
        let [with, without] = [
            "agent_0190a1b2c3d47abc8def0123456789a1",
            "agent_0190a1b2c3d47abc8def0123456789a2",
        ];
        let [current, left] = [
            "term_0190a1b2c3d47abc8def0123456789a1",
            "term_0190a1b2c3d47abc8def0123456789a2",
        ];
        for id in [with, without] {
            seed(&store, &Agent { id, ..AGENT });
        }
        terminal(&store, left, "agent", "closed", Some(with), Some("{}"));
        terminal(
            &store,
            current,
            "agent",
            "running",
            Some(with),
            Some(r#"{"childPid":"7"}"#),
        );
        store
            .db
            .execute_batch(&format!(
                "UPDATE terminals SET runtime = 'holder', runtime_kind = 'holder', generation = 3
                   WHERE id = '{current}';
                 UPDATE agent_sessions SET terminal_id = '{current}' WHERE id = '{with}';"
            ))
            .unwrap();
        let reads = store.reads();
        let found = |id: &str| reads.agent_terminal(id).unwrap();
        assert_eq!(
            [
                found(with),
                found(without),
                found("agent_0190a1b2c3d47abc8def0123456789a3")
            ],
            [
                Some(AgentTerminal {
                    agent_id: AgentId::parse(with).unwrap(),
                    state: AgentState::Running,
                    terminal_id: TerminalId::parse(current),
                    terminal_state: Some(TerminalState::Running),
                    generation: Some(3),
                    runtime: Some("holder".to_owned()),
                    locator: Some(r#"{"childPid":"7"}"#.to_owned()),
                    runtime_kind: Some("holder".to_owned()),
                }),
                Some(AgentTerminal {
                    agent_id: AgentId::parse(without).unwrap(),
                    state: AgentState::Running,
                    terminal_id: None,
                    terminal_state: None,
                    generation: None,
                    runtime: None,
                    locator: None,
                    runtime_kind: None,
                }),
                None
            ]
        );
    }

    #[test]
    fn finds_the_agent_a_terminal_is_current_for_and_none_for_one_left_behind() {
        let dir = TempDir::new("agent-of-terminal");
        let store = store(&dir);
        let agent = "agent_0190a1b2c3d47abc8def0123456789a1";
        let [current, left] = [
            "term_0190a1b2c3d47abc8def0123456789a1",
            "term_0190a1b2c3d47abc8def0123456789a2",
        ];
        seed(&store, &Agent { id: agent, ..AGENT });
        terminal(&store, left, "agent", "exited", Some(agent), None);
        terminal(&store, current, "agent", "running", Some(agent), None);
        store
            .db
            .execute(
                "UPDATE agent_sessions SET terminal_id = ? WHERE id = ?",
                (current, agent),
            )
            .unwrap();
        let reads = store.reads();
        let found = |id: &str| {
            reads.agent_of_terminal(id).unwrap().map(|t| {
                (
                    t.agent_id.as_str().to_owned(),
                    t.terminal_id,
                    t.terminal_state,
                )
            })
        };
        assert_eq!(
            [
                found(current),
                found(left),
                found("term_0190a1b2c3d47abc8def0123456789a3")
            ],
            [
                Some((
                    agent.to_owned(),
                    TerminalId::parse(current),
                    Some(TerminalState::Running)
                )),
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

    /// Two agents, `lead` and `peer`, named as such, with ids a rename can name.
    struct Named {
        _dir: TempDir,
        store: Store,
        lead: bazhen_protocol::ids::AgentId,
        peer: bazhen_protocol::ids::AgentId,
    }

    fn two_named() -> Named {
        let dir = TempDir::new("rename");
        let store = store(&dir);
        let [lead, peer] =
            [1_u8, 2].map(|n| bazhen_protocol::ids::AgentId::mint(u64::from(n), [n; 16]));
        for (agent, name) in [(&lead, "lead"), (&peer, "peer")] {
            seed(
                &store,
                &Agent {
                    id: agent.as_str(),
                    ..AGENT
                },
            );
            store
                .db
                .execute(
                    "UPDATE agent_sessions SET name = ? WHERE id = ?",
                    (name, agent.as_str()),
                )
                .unwrap();
        }
        Named {
            _dir: dir,
            store,
            lead,
            peer,
        }
    }

    impl Named {
        fn rename(
            &mut self,
            key: &str,
            caller: Option<&bazhen_protocol::ids::AgentId>,
            name: &str,
        ) -> Result<bazhen_protocol::agents::AgentCommandResponse, crate::RenameError> {
            self.store.rename_agent(&crate::Rename {
                key: key.to_owned(),
                caller: caller.map(|c| c.as_str().to_owned()),
                agent: self.lead.clone(),
                name: name.to_owned(),
            })
        }

        fn name(&self) -> Option<String> {
            self.store
                .reads()
                .agent_name_and_state(self.lead.as_str())
                .unwrap()
                .and_then(|(name, _)| name)
        }

        fn renamed(&self) -> Vec<(String, serde_json::Value)> {
            self.store
                .reads()
                .events(0, 100)
                .unwrap()
                .into_iter()
                .filter(|e| e.kind == "agent.renamed")
                .map(|e| (e.actor, serde_json::from_str(&e.payload).unwrap()))
                .collect()
        }
    }

    #[test]
    fn renames_an_agent_for_the_human_recording_the_name_it_had() {
        let mut n = two_named();
        let answer = n.rename("r", None, "reviewer").unwrap();
        assert_eq!(
            (n.name(), n.renamed(), answer.event_ids.len()),
            (
                Some("reviewer".to_owned()),
                vec![(
                    "user".to_owned(),
                    serde_json::json!({"name": "reviewer", "previous": "lead"})
                )],
                1
            )
        );
    }

    #[test]
    fn lets_an_agent_rename_itself_and_no_other_agent() {
        let mut n = two_named();
        let (lead, peer) = (n.lead.clone(), n.peer.clone());
        n.rename("self", Some(&lead), "me").unwrap();
        let other = n.rename("o", Some(&peer), "you");
        assert!(
            matches!(other, Err(crate::RenameError::Forbidden)),
            "{other:?}"
        );
        assert_eq!(n.name(), Some("me".to_owned()));
        assert_eq!(n.renamed()[0].0, lead.as_str());
    }

    #[test]
    fn refuses_a_name_another_live_agent_holds_in_any_case() {
        let mut n = two_named();
        let taken = n.rename("r", None, "PEER");
        assert!(
            matches!(&taken, Err(crate::RenameError::NameTaken(name)) if name == "PEER"),
            "{taken:?}"
        );
        assert_eq!(n.renamed(), Vec::new());
    }

    #[test]
    fn takes_a_name_only_an_ended_agent_held() {
        let mut n = two_named();
        n.store
            .db
            .execute(
                "UPDATE agent_sessions SET state = 'closed' WHERE id = ?",
                [n.peer.as_str()],
            )
            .unwrap();
        n.rename("r", None, "peer").unwrap();
        assert_eq!(n.name(), Some("peer".to_owned()));
    }

    #[test]
    fn changes_only_the_case_of_its_own_name() {
        let mut n = two_named();
        n.rename("b", None, "Lead").unwrap();
        assert_eq!(n.name(), Some("Lead".to_owned()));
    }

    #[test]
    fn records_nothing_for_the_name_it_already_has() {
        let mut n = two_named();
        let again = n.rename("b", None, "lead").unwrap();
        assert_eq!((again.event_ids, n.renamed()), (Vec::new(), Vec::new()));
    }

    #[test]
    fn answers_a_repeat_with_the_first_answer_and_the_key_reused_for_another_name_as_a_conflict() {
        let mut n = two_named();
        let first = n.rename("r", None, "reviewer").unwrap();
        // The repeat would be no change now, but answers what the first did.
        let repeat = n.rename("r", None, "reviewer").unwrap();
        let other = n.rename("r", None, "x");
        assert_eq!(repeat, first);
        assert!(
            matches!(
                other,
                Err(crate::RenameError::Once(crate::OnceError::Conflict(_)))
            ),
            "{other:?}"
        );
    }

    #[test]
    fn refuses_to_rename_an_agent_that_has_ended_or_whose_launch_failed() {
        let refused = |state: &str| {
            let mut n = two_named();
            n.store
                .db
                .execute(
                    "UPDATE agent_sessions SET state = ? WHERE id = ?",
                    (state, n.lead.as_str()),
                )
                .unwrap();
            n.rename("r", None, "x").map_err(|e| e.to_string())
        };
        let lead = bazhen_protocol::ids::AgentId::mint(1, [1; 16]);
        assert_eq!(
            [refused("closed"), refused("failed")],
            ["closed", "failed"].map(|state| Err(format!(
                "agent {} is {state}; only an agent not ended can be renamed",
                lead.as_str()
            )))
        );
    }

    #[test]
    fn keeps_each_rename_as_the_typescript_daemon_does_for_its_key() {
        let lead = bazhen_protocol::ids::AgentId::mint(1, [1; 16]);
        let rename = |caller: Option<&str>| crate::Rename {
            key: "r".to_owned(),
            caller: caller.map(str::to_owned),
            agent: lead.clone(),
            name: "x".to_owned(),
        };
        assert_eq!(
            [rename(None), rename(Some("agent_y"))].map(|r| r.request_text().unwrap()),
            [
                format!(
                    r#"{{"caller":null,"agentId":"{}","name":"x"}}"#,
                    lead.as_str()
                ),
                format!(
                    r#"{{"caller":"agent_y","agentId":"{}","name":"x"}}"#,
                    lead.as_str()
                ),
            ]
        );
    }

    #[test]
    fn resolves_an_agent_by_its_id_whatever_its_state_and_by_its_name_only_while_it_is_live() {
        let n = two_named();
        n.store
            .db
            .execute(
                "UPDATE agent_sessions SET state = 'closed' WHERE id = ?",
                [n.peer.as_str()],
            )
            .unwrap();
        let unknown = bazhen_protocol::ids::AgentId::mint(9, [9; 16]);
        let reads = n.store.reads();
        assert_eq!(
            ["LEAD", "peer", n.peer.as_str(), unknown.as_str(), "nobody"]
                .map(|r| reads.resolve_agent(r).unwrap()),
            [
                Some(n.lead.as_str().to_owned()),
                None,
                Some(n.peer.as_str().to_owned()),
                None,
                None
            ]
        );
    }
}
