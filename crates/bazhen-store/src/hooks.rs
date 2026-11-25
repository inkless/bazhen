//! What a hook of an agent's is read against, and what it records of the session it came from:
//! the session the agent is bound to, which a new one its TUI started moves, and where that
//! session keeps its conversation (`store.ts` `claudeBinding`, `recordTranscript`, binding.ts's
//! `rebind`).

use bazhen_protocol::agent_events::{
    AgentCompacted, AgentExternalRefUpdated, AgentReady, AgentTranscriptRecorded, CompactedHook,
    CompactedSign, ReadySign,
};
use bazhen_protocol::agents::{Activity, ExternalRef, ExternalRefKind, Usage};
use bazhen_protocol::ids::{AgentId, EnvironmentId};

use crate::agent_events::AgentChange;
use crate::events::{AppendError, NewEvent, Reads, Writer};

/// The states in which an agent's harness reports what it is doing (`store.ts` `REPORTING`).
const REPORTING: [&str; 3] = ["starting", "running", "unknown"];

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

impl Writer<'_> {
    /// Records what the agent's harness says it is doing (`store.ts` `recordActivity`), unless the
    /// agent isn't in a state that reports, the last recorded was observed later, or it says the
    /// same as the last: the same value, source, detail and reset, however sure and whenever seen.
    ///
    /// # Errors
    ///
    /// The append's.
    pub fn record_activity(
        &self,
        agent: &AgentId,
        activity: &Activity,
    ) -> Result<Option<u64>, AppendError> {
        if !self.reporting(agent)? {
            return Ok(None);
        }
        let latest: Option<String> = self.reads().first_text(
            "SELECT activity FROM activity_latest WHERE agent_session_id = ?",
            agent.as_str(),
        )?;
        if let Some(latest) = latest.and_then(|text| serde_json::from_str::<Activity>(&text).ok()) {
            // Every stored time is written as `toISOString` writes it, so two compare as text as
            // they do as times.
            let same = latest.value == activity.value
                && latest.source == activity.source
                && latest.detail == activity.detail
                && latest.resets_at == activity.resets_at;
            if activity.observed_at < latest.observed_at || same {
                return Ok(None);
            }
        }
        let change = AgentChange::Activity(activity.clone());
        self.append(&system(agent, change)).map(Some)
    }

    /// Records that the agent's session compacted its context (`store.ts` `recordCompaction`),
    /// with the usage recorded last as what it held before, unless the agent isn't in a state that
    /// reports, or the same hook, by its session and process, reported it already.
    ///
    /// # Errors
    ///
    /// The append's.
    pub fn record_compaction(
        &self,
        agent: &AgentId,
        sign: CompactedSign,
        hook: Option<CompactedHook>,
    ) -> Result<Option<u64>, AppendError> {
        if !self.reporting(agent)? {
            return Ok(None);
        }
        if let Some(hook) = &hook {
            let reported: Option<i64> = self
                .connection()
                .query_row(
                    "SELECT 1 FROM events WHERE entity_type = 'agent' AND entity_id = ?
                       AND type = 'agent.compacted' AND json_extract(payload, '$.hook.pid') = ?
                       AND json_extract(payload, '$.hook.sessionId') IS ? LIMIT 1",
                    (agent.as_str(), hook.pid, hook.session_id.as_deref()),
                    |row| row.get(0),
                )
                .map(Some)
                .or_else(|err| match err {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    err => Err(err),
                })?;
            if reported.is_some() {
                return Ok(None);
            }
        }
        // The status line reports apart from the hook, so a reading taken just after the
        // compaction may land first, and `before` then holds the use after it.
        let before: Option<String> = self.reads().first_text(
            "SELECT usage FROM agent_sessions WHERE id = ?",
            agent.as_str(),
        )?;
        let change = AgentChange::Compacted(AgentCompacted {
            sign,
            before: before.and_then(|text| serde_json::from_str::<Usage>(&text).ok()),
            hook,
        });
        self.append(&system(agent, change)).map(Some)
    }

    /// Records the harness's first sign of life since the agent's terminal came up
    /// (`Readiness.ready`): only while the agent is starting and its terminal runs, so a sign
    /// before the terminal is up, or once the agent runs, records nothing.
    ///
    /// # Errors
    ///
    /// The read's, or the append's.
    pub fn record_ready(
        &self,
        agent: &AgentId,
        sign: ReadySign,
    ) -> Result<Option<u64>, AppendError> {
        let waiting = self
            .reads()
            .agent_binding(agent.as_str())?
            .is_some_and(|b| {
                b.state == "starting" && b.terminal_state.as_deref() == Some("running")
            });
        if !waiting {
            return Ok(None);
        }
        self.append(&system(agent, AgentChange::Ready(AgentReady { sign })))
            .map(Some)
    }

    /// Whether the agent is in a state its harness reports in.
    fn reporting(&self, agent: &AgentId) -> rusqlite::Result<bool> {
        let state = self.reads().agent_state(agent.as_str())?;
        Ok(state.is_some_and(|state| REPORTING.contains(&state.as_str())))
    }
}

impl Reads<'_> {
    /// The first row's text column, or none: no row, or a null.
    fn first_text(self, sql: &str, key: &str) -> rusqlite::Result<Option<String>> {
        let mut rows = self.0.prepare(sql)?;
        let mut found = rows.query([key])?;
        let text: Option<Option<String>> = found.next()?.map(|row| row.get(0)).transpose()?;
        Ok(text.flatten())
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
    use bazhen_protocol::agent_events::{CompactedHook, CompactedSign, ReadySign};
    use bazhen_protocol::agents::{
        Activity, ActivitySource, ActivityValue, ExternalRef, ExternalRefKind,
    };
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

    fn activity(value: ActivityValue, at: &str, confidence: f64) -> Activity {
        Activity {
            value,
            source: ActivitySource::Native,
            confidence,
            observed_at: format!("2026-11-24T00:00:{at}.000Z"),
            detail: None,
            resets_at: None,
        }
    }

    #[test]
    fn records_a_change_of_activity_and_not_an_older_or_the_same_one_however_sure() {
        let dir = TempDir::new("activity");
        let mut store = store(&dir, Some(BOUND));
        let mut record = |activity: Activity| {
            store
                .write(|w| w.record_activity(&agent(), &activity))
                .unwrap()
                .is_some()
        };
        assert_eq!(
            [
                record(activity(ActivityValue::Working, "10", 1.0)),
                record(activity(ActivityValue::Working, "20", 0.5)),
                record(activity(ActivityValue::Idle, "05", 1.0)),
                record(activity(ActivityValue::Idle, "30", 1.0)),
                record(activity(ActivityValue::Working, "30", 1.0)),
            ],
            [true, false, false, true, true]
        );
    }

    #[test]
    fn records_no_activity_or_compaction_for_an_agent_in_a_state_that_doesnt_report() {
        let dir = TempDir::new("exited");
        let mut store = store(&dir, Some(BOUND));
        store
            .db
            .execute("UPDATE agent_sessions SET state = 'exited'", ())
            .unwrap();
        let recorded = store.write(|w| {
            Ok::<_, crate::AppendError>([
                w.record_activity(&agent(), &activity(ActivityValue::Working, "10", 1.0))?,
                w.record_compaction(&agent(), CompactedSign::ClaudeHook, None)?,
            ])
        });
        assert_eq!((recorded.unwrap(), events(&store)), ([None, None], vec![]));
    }

    #[test]
    fn records_a_compaction_with_nothing_before_it_for_an_agent_that_reported_no_usage() {
        let dir = TempDir::new("no-usage");
        let mut store = store(&dir, Some(BOUND));
        let compacted =
            store.write(|w| w.record_compaction(&agent(), CompactedSign::ClaudeHook, None));
        assert_eq!(
            (compacted.unwrap().is_some(), events(&store)),
            (
                true,
                vec![(
                    "agent.compacted".to_owned(),
                    r#"{"sign":"claude_hook"}"#.to_owned()
                )]
            )
        );
    }

    #[test]
    fn records_a_compaction_once_per_hook_with_the_usage_held_before_it() {
        let dir = TempDir::new("compacted");
        let mut store = store(&dir, Some(BOUND));
        store
            .db
            .execute(
                r#"UPDATE agent_sessions SET usage = '{"model":"opus","contextUsedPercent":80}'"#,
                (),
            )
            .unwrap();
        let hook = |session: Option<&str>, pid| CompactedHook {
            session_id: session.map(str::to_owned),
            pid,
        };
        let mut compacted = |hook: Option<CompactedHook>| {
            store
                .write(|w| w.record_compaction(&agent(), CompactedSign::ClaudeHook, hook))
                .unwrap()
                .is_some()
        };
        assert_eq!(
            [
                compacted(Some(hook(Some("s-1"), 7))),
                compacted(Some(hook(Some("s-1"), 7))),
                compacted(Some(hook(None, 7))),
                compacted(Some(hook(None, 7))),
                compacted(Some(hook(Some("s-1"), 8))),
                compacted(None),
                compacted(None),
            ],
            [true, false, true, false, true, true, true]
        );
        assert_eq!(
            events(&store).first().map(|(_, payload)| payload.as_str()),
            Some(
                r#"{"sign":"claude_hook","before":{"model":"opus","contextUsedPercent":80},"hook":{"sessionId":"s-1","pid":7}}"#
            )
        );
    }

    #[test]
    fn records_a_sign_of_life_only_while_the_agent_starts_on_a_running_terminal() {
        let dir = TempDir::new("ready");
        let mut store = store(&dir, Some(BOUND));
        let set = |store: &Store, agent: &str, terminal: &str| {
            store
                .db
                .execute_batch(&format!(
                    "UPDATE agent_sessions SET state = '{agent}'; UPDATE terminals SET state = '{terminal}';"
                ))
                .unwrap();
        };
        let ready = |store: &mut Store| {
            store
                .write(|w| w.record_ready(&agent(), ReadySign::ClaudeHook))
                .unwrap()
                .is_some()
        };
        set(&store, "starting", "starting");
        let before_terminal = ready(&mut store);
        set(&store, "starting", "running");
        let (first, again) = (ready(&mut store), ready(&mut store));
        assert_eq!(
            (
                before_terminal,
                first,
                again,
                binding(&store).map(|b| b.state)
            ),
            (false, true, false, Some("running".to_owned()))
        );
        assert_eq!(
            events(&store),
            [(
                "agent.ready".to_owned(),
                r#"{"sign":"claude_hook"}"#.to_owned()
            )]
        );
    }
}
