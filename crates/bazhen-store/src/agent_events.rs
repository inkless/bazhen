//! What each `agent.*` event writes, as projections.ts writes it: an agent and the terminal it is
//! on move through their lifecycles together, since a local agent's terminal is its process.

use bazhen_core::agent::{self, AgentEvent};
use bazhen_protocol::agent_events::{
    AgentCompacted, AgentExited, AgentExternalRefUpdated, AgentFailed, AgentLaunched,
    AgentProcessAdopted, AgentReady, AgentRelaunchRejected, AgentRelaunchRequested, AgentRenamed,
    AgentRespawnRejected, AgentRestarted, AgentRunning, AgentSignalled, AgentTranscriptRecorded,
};
use bazhen_protocol::agents::{Activity, AgentState, ExternalRef, ExternalRefKind, Usage};
use bazhen_protocol::events::RuntimeRefPayload;
use bazhen_protocol::ids::{AgentId, Id};
use bazhen_protocol::names::name_base;
use bazhen_protocol::shells::{TerminalState, TuiTheme};
use rusqlite::types::Value;
use rusqlite::{OptionalExtension, Transaction};

use crate::events::{AppendError, int};
use crate::projections::At;
use crate::terminals::{Step, adopted_generation};

/// What an `agent.*` event records, with its payload.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentChange {
    Launched(AgentLaunched),
    Renamed(AgentRenamed),
    Running(AgentRunning),
    Ready(AgentReady),
    Failed(AgentFailed),
    Lost,
    ProcessAdopted(AgentProcessAdopted),
    RespawnRequested,
    Respawned(AgentRestarted),
    RespawnRejected(AgentRespawnRejected),
    RelaunchRequested(AgentRelaunchRequested),
    Relaunched(AgentRestarted),
    RelaunchRejected(AgentRelaunchRejected),
    ExternalRefUpdated(AgentExternalRefUpdated),
    TranscriptRecorded(AgentTranscriptRecorded),
    Signalled(AgentSignalled),
    Activity(Activity),
    Usage(Usage),
    Compacted(AgentCompacted),
    Exited(AgentExited),
    Closing,
    Closed,
}

/// The payload of an event that carries none.
#[derive(serde::Serialize)]
struct Empty {}

impl AgentChange {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Launched(_) => "agent.launched",
            Self::Renamed(_) => "agent.renamed",
            Self::Running(_) => "agent.running",
            Self::Ready(_) => "agent.ready",
            Self::Failed(_) => "agent.failed",
            Self::Lost => "agent.lost",
            Self::ProcessAdopted(_) => "agent.process_adopted",
            Self::RespawnRequested => "agent.respawn_requested",
            Self::Respawned(_) => "agent.respawned",
            Self::RespawnRejected(_) => "agent.respawn_rejected",
            Self::RelaunchRequested(_) => "agent.relaunch_requested",
            Self::Relaunched(_) => "agent.relaunched",
            Self::RelaunchRejected(_) => "agent.relaunch_rejected",
            Self::ExternalRefUpdated(_) => "agent.external_ref_updated",
            Self::TranscriptRecorded(_) => "agent.transcript_recorded",
            Self::Signalled(_) => "agent.signalled",
            Self::Activity(_) => "agent.activity",
            Self::Usage(_) => "agent.usage",
            Self::Compacted(_) => "agent.compacted",
            Self::Exited(_) => "agent.exited",
            Self::Closing => "agent.closing",
            Self::Closed => "agent.closed",
        }
    }

    pub(crate) fn payload(&self) -> serde_json::Result<String> {
        match self {
            Self::Launched(p) => serde_json::to_string(p),
            Self::Renamed(p) => serde_json::to_string(p),
            Self::Running(p) => serde_json::to_string(p),
            Self::Ready(p) => serde_json::to_string(p),
            Self::Failed(p) => serde_json::to_string(p),
            Self::ProcessAdopted(p) => serde_json::to_string(p),
            Self::Respawned(p) | Self::Relaunched(p) => serde_json::to_string(p),
            Self::RespawnRejected(p) => serde_json::to_string(p),
            Self::RelaunchRequested(p) => serde_json::to_string(p),
            Self::RelaunchRejected(p) => serde_json::to_string(p),
            Self::ExternalRefUpdated(p) => serde_json::to_string(p),
            Self::TranscriptRecorded(p) => serde_json::to_string(p),
            Self::Signalled(p) => serde_json::to_string(p),
            Self::Activity(p) => serde_json::to_string(p),
            Self::Usage(p) => serde_json::to_string(p),
            Self::Compacted(p) => serde_json::to_string(p),
            Self::Exited(p) => serde_json::to_string(p),
            Self::Lost | Self::RespawnRequested | Self::Closing | Self::Closed => {
                serde_json::to_string(&Empty {})
            }
        }
    }
}

/// The columns a projection sets, with their values.
type Columns = Vec<(&'static str, Value)>;

fn text(value: impl Into<String>) -> Value {
    Value::Text(value.into())
}

pub(crate) fn project(
    tx: &Transaction<'_>,
    at: &At<'_>,
    agent: &AgentId,
    change: &AgentChange,
) -> Result<(), AppendError> {
    let id = agent.as_str();
    let moving = Moving { tx, at, change, id };
    match change {
        AgentChange::Launched(payload) => launched(tx, at, id, payload),
        AgentChange::Running(payload) => running(&moving, payload),
        AgentChange::Ready(_) => moving.advance(AgentEvent::HarnessReady, None, vec![], vec![]),
        AgentChange::Failed(_) => moving.advance(
            AgentEvent::LaunchRejected,
            Some(Step::RuntimeRejected),
            vec![],
            vec![],
        ),
        AgentChange::Lost => moving.advance(
            AgentEvent::TargetAbsent,
            Some(Step::TargetAbsent),
            vec![],
            vec![],
        ),
        AgentChange::Exited(payload) => moving.advance(
            AgentEvent::ProcessExited,
            Some(Step::ProcessExited),
            vec![],
            vec![("exit", text(serde_json::to_string(&payload.exit)?))],
        ),
        AgentChange::ProcessAdopted(payload) => adopted(&moving, payload),
        AgentChange::RespawnRequested => {
            moving.advance(AgentEvent::RespawnRequested, None, vec![], vec![])
        }
        AgentChange::Respawned(payload) => respawned(&moving, payload),
        AgentChange::RespawnRejected(_) => {
            moving.advance(AgentEvent::RespawnRejected, None, vec![], vec![])
        }
        AgentChange::RelaunchRequested(payload) => relaunch_requested(&moving, payload),
        AgentChange::Relaunched(payload) => relaunched(&moving, payload),
        AgentChange::RelaunchRejected(_) => relaunch_rejected(&moving),
        AgentChange::ExternalRefUpdated(payload) => {
            present(tx, id).map_err(|r| moving.refuse(r))?;
            let columns =
                bound_to(tx, id, Some(&payload.external_ref)).map_err(|r| moving.refuse(r))?;
            update(tx, at, "agent_sessions", id, &columns)
        }
        AgentChange::TranscriptRecorded(payload) => transcript_recorded(&moving, payload),
        AgentChange::Renamed(payload) => update(
            tx,
            at,
            "agent_sessions",
            id,
            &[("name", text(payload.name.clone()))],
        ),
        AgentChange::Signalled(_) | AgentChange::Compacted(_) => Ok(()),
        AgentChange::Activity(activity) => {
            tx.execute(
                "INSERT INTO activity_latest (agent_session_id, activity, updated_event_id)
                 VALUES (?, ?, ?)
                 ON CONFLICT (agent_session_id) DO UPDATE SET activity = excluded.activity,
                   updated_event_id = excluded.updated_event_id",
                (id, serde_json::to_string(activity)?, int(at.id)?),
            )?;
            Ok(())
        }
        AgentChange::Usage(usage) => {
            present(tx, id).map_err(|r| moving.refuse(r))?;
            update(
                tx,
                at,
                "agent_sessions",
                id,
                &[("usage", text(serde_json::to_string(usage)?))],
            )
        }
        AgentChange::Closing => moving.advance(
            AgentEvent::CloseRequested,
            Some(Step::CloseRequested),
            vec![],
            vec![],
        ),
        AgentChange::Closed => {
            moving.advance(
                AgentEvent::CloseCompleted,
                Some(Step::CloseCompleted),
                vec![("usage", Value::Null)],
                vec![],
            )?;
            forget_activity(tx, id)?;
            end_assignments(tx, at, "agent_session_id", id, "agent_closed")?;
            end_descendants(tx, at)
        }
    }
}

fn running(moving: &Moving<'_, '_>, payload: &AgentRunning) -> Result<(), AppendError> {
    let mut agent = bound_to(moving.tx, moving.id, payload.external_ref.as_ref())
        .map_err(|r| moving.refuse(r))?;
    agent.extend(started_as(payload.harness_name.as_deref()));
    let terminal = payload
        .runtime_ref
        .as_ref()
        .map(|r| incarnation(r, payload.theme))
        .transpose()?
        .unwrap_or_default();
    moving.advance(
        AgentEvent::LaunchConfirmed,
        Some(Step::RuntimeConfirmed),
        agent,
        terminal,
    )
}

fn adopted(moving: &Moving<'_, '_>, payload: &AgentProcessAdopted) -> Result<(), AppendError> {
    let (tx, id) = (moving.tx, moving.id);
    let terminal =
        terminal_of(tx, id)?.ok_or_else(|| moving.refuse(format!("no terminal of agent {id}")))?;
    let generation =
        adopted_generation(tx, &terminal, &payload.runtime_ref).map_err(|r| moving.refuse(r))?;
    let mut columns = incarnation(&payload.runtime_ref, None)?;
    columns.retain(|(c, _)| *c != "theme");
    columns.push(("generation", Value::Integer(int(generation)?)));
    columns.push(("exit", Value::Null));
    moving.advance(
        AgentEvent::ProcessAdopted,
        Some(Step::Adopted),
        vec![("usage", Value::Null)],
        columns,
    )?;
    forget_activity(tx, id)
}

fn respawned(moving: &Moving<'_, '_>, payload: &AgentRestarted) -> Result<(), AppendError> {
    let (tx, id) = (moving.tx, moving.id);
    delivered_prompt(tx, id, payload.prompt_hash.as_deref())?;
    // A new process reports its own usage, as it does its own activity.
    let mut agent =
        bound_to(tx, id, payload.external_ref.as_ref()).map_err(|r| moving.refuse(r))?;
    agent.push(("usage", Value::Null));
    agent.extend(started_as(payload.harness_name.as_deref()));
    let mut terminal = incarnation(&payload.runtime_ref, payload.theme)?;
    terminal.insert(2, ("exit", Value::Null));
    moving.advance(
        AgentEvent::LaunchConfirmed,
        Some(Step::Respawned),
        agent,
        terminal,
    )?;
    forget_activity(tx, id)
}

fn relaunched(moving: &Moving<'_, '_>, payload: &AgentRestarted) -> Result<(), AppendError> {
    let (tx, id) = (moving.tx, moving.id);
    delivered_prompt(tx, id, payload.prompt_hash.as_deref())?;
    let mut agent =
        bound_to(tx, id, payload.external_ref.as_ref()).map_err(|r| moving.refuse(r))?;
    agent.extend(started_as(payload.harness_name.as_deref()));
    moving.advance(
        AgentEvent::LaunchConfirmed,
        Some(Step::RuntimeConfirmed),
        agent,
        incarnation(&payload.runtime_ref, payload.theme)?,
    )
}

/// Back to the terminal the agent was lost on, which close still takes; the new one failed. An
/// agent with none was never lost, so this was no relaunch.
fn relaunch_rejected(moving: &Moving<'_, '_>) -> Result<(), AppendError> {
    let (tx, id) = (moving.tx, moving.id);
    let lost: Option<String> = tx
        .query_row(
            "SELECT id FROM terminals WHERE agent_session_id = ? AND state = 'lost'
             ORDER BY created_event_id DESC LIMIT 1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let lost = lost.ok_or_else(|| moving.refuse(format!("no lost terminal of agent {id}")))?;
    moving.advance(
        AgentEvent::RelaunchRejected,
        Some(Step::RuntimeRejected),
        vec![],
        vec![],
    )?;
    update(
        tx,
        moving.at,
        "agent_sessions",
        id,
        &[("terminal_id", text(lost))],
    )
}

/// Where the agent's session keeps its conversation. Only the bound session's: a report about
/// one the agent has left says nothing of this one.
fn transcript_recorded(
    moving: &Moving<'_, '_>,
    payload: &AgentTranscriptRecorded,
) -> Result<(), AppendError> {
    let (tx, id) = (moving.tx, moving.id);
    let stored = stored_ref(tx, id)?.ok_or_else(|| moving.refuse(no_agent(id)))?;
    let bound = session_id_of(stored.0.as_deref()).map_err(|r| moving.refuse(r))?;
    if bound != Some(serde_json::json!(payload.session_id)) {
        return Ok(());
    }
    update(
        tx,
        moving.at,
        "agent_sessions",
        id,
        &[("transcript", text(payload.path.clone()))],
    )
}

fn launched(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    payload: &AgentLaunched,
) -> Result<(), AppendError> {
    let event = int(at.id)?;
    let terminal = payload.terminal_id.as_ref().map(Id::as_str);
    tx.execute(
        "INSERT INTO agent_sessions
           (id, environment_id, harness, project, cwd, state, terminal_id, created_event_id,
            updated_event_id)
         VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?)",
        (
            id,
            payload.environment_id.as_str(),
            payload.harness.as_str(),
            &payload.project,
            &payload.cwd,
            terminal,
            event,
            event,
        ),
    )?;
    // Set apart from the insert, which older schemas, read back by upgrade, must still take.
    let set = |column: &str, value: Value| {
        tx.execute(
            &format!("UPDATE agent_sessions SET {column} = ? WHERE id = ?"),
            (value, id),
        )
    };
    if let Some(by) = &payload.launched_by {
        set("launched_by", text(by.as_str()))?;
    }
    if let Some(name) = &payload.name {
        set("name", text(name.clone()))?;
    }
    if let Some(role) = &payload.role {
        set("role", text(role.as_str()))?;
    }
    if let Some(tokens) = payload.compact_window_tokens {
        set("compact_window", Value::Integer(tokens.into()))?;
    }
    delivered_prompt(tx, id, payload.prompt_hash.as_deref())?;
    if let Some(ordinal) = payload.name_ordinal {
        tx.execute(
            "INSERT INTO agent_name_counters (base, last) VALUES (?, ?)
             ON CONFLICT (base) DO UPDATE SET last = max(last, excluded.last)",
            (name_base(&payload.project), int(ordinal)?),
        )?;
    }
    let Some(terminal) = terminal else {
        return Ok(());
    };
    tx.execute(
        "INSERT INTO terminals
           (id, host_id, state, generation, runtime, locator, environment_id, kind,
            agent_session_id, created_event_id, updated_event_id)
         VALUES (?, ?, 'creating', 0, NULL, NULL, ?, 'agent', ?, ?, ?)",
        (
            terminal,
            at.host,
            payload.environment_id.as_str(),
            id,
            event,
            event,
        ),
    )?;
    created_on(tx, terminal, payload.runtime.as_deref())
}

fn relaunch_requested(
    moving: &Moving<'_, '_>,
    payload: &AgentRelaunchRequested,
) -> Result<(), AppendError> {
    let Moving { tx, at, id, .. } = *moving;
    let environment: Option<Option<String>> = tx
        .query_row(
            "SELECT environment_id FROM agent_sessions WHERE id = ?",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let terminal = payload.terminal_id.as_str();
    // The lost terminal is final: the agent moves to a new one, and the lost one stays.
    moving.advance(
        AgentEvent::RelaunchRequested,
        None,
        vec![("terminal_id", text(terminal)), ("usage", Value::Null)],
        vec![],
    )?;
    let event = int(at.id)?;
    tx.execute(
        "INSERT INTO terminals
           (id, host_id, state, generation, runtime, locator, environment_id, kind,
            agent_session_id, created_event_id, updated_event_id)
         VALUES (?, ?, 'creating', ?, NULL, NULL, ?, 'agent', ?, ?, ?)",
        (
            terminal,
            at.host,
            int(payload.generation)?,
            environment.flatten(),
            id,
            event,
            event,
        ),
    )?;
    created_on(tx, terminal, payload.runtime.as_deref())?;
    forget_activity(tx, id)
}

/// An agent's event being applied, which moves it and the terminal it is on.
#[derive(Clone, Copy)]
struct Moving<'t, 'a> {
    tx: &'t Transaction<'a>,
    at: &'t At<'t>,
    change: &'t AgentChange,
    id: &'t str,
}

impl Moving<'_, '_> {
    /// The event refused, for `reason`, with nothing of it recorded.
    fn refuse(&self, reason: String) -> AppendError {
        AppendError::Refused {
            event: self.change.name(),
            reason,
        }
    }

    /// Moves the agent by `event`, and the terminal it is on by `step` when there is one, setting
    /// `agent` and `terminal` with them. An agent relaunched has had more than one terminal; only
    /// the one it is on moves.
    fn advance(
        &self,
        event: AgentEvent,
        step: Option<Step>,
        agent: Columns,
        terminal: Columns,
    ) -> Result<(), AppendError> {
        let Self { tx, at, change, id } = *self;
        let refuse = |reason: String| AppendError::Refused {
            event: change.name(),
            reason,
        };
        let state: Option<String> = tx
            .query_row(
                "SELECT state FROM agent_sessions WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let state = state.ok_or_else(|| refuse(no_agent(id)))?;
        let from: AgentState = serde_json::from_value(serde_json::Value::String(state))?;
        let to = agent::next(from, event).map_err(|e| refuse(e.to_string()))?;
        let agent = merged(vec![("state", text(to.as_str()))], agent);
        update(tx, at, "agent_sessions", id, &agent)?;
        let Some(step) = step else {
            return Ok(());
        };
        let on: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT t.id, t.state, t.generation FROM terminals t
                 JOIN agent_sessions a ON t.id = a.terminal_id WHERE a.id = ?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((terminal_id, state, generation)) = on else {
            return Ok(());
        };
        let from = TerminalState::parse(&state)
            .ok_or_else(|| refuse(format!("terminal {terminal_id} is in no state: {state}")))?;
        let to = crate::terminals::advance(from, step).map_err(refuse)?;
        // A respawn starts a new runtime incarnation, so it takes the next generation.
        let generation = if step == Step::Respawned {
            generation.saturating_add(1)
        } else {
            generation
        };
        let terminal = merged(
            vec![
                ("state", text(to.as_str())),
                ("generation", Value::Integer(generation)),
            ],
            terminal,
        );
        update(tx, at, "terminals", &terminal_id, &terminal)
    }
}

/// `base` with `over` set over it, as a later key of an object spread wins.
fn merged(mut base: Columns, over: Columns) -> Columns {
    for (column, value) in over {
        match base.iter_mut().find(|(c, _)| *c == column) {
            Some(slot) => slot.1 = value,
            None => base.push((column, value)),
        }
    }
    base
}

/// Sets `columns` of the row `id` names in `table`, with the event that set them.
pub(crate) fn update(
    tx: &Transaction<'_>,
    at: &At<'_>,
    table: &str,
    id: &str,
    columns: &[(&'static str, Value)],
) -> Result<(), AppendError> {
    let mut set: Vec<String> = columns.iter().map(|(c, _)| format!("{c} = ?")).collect();
    set.push("updated_event_id = ?".to_owned());
    let mut values: Vec<Value> = columns.iter().map(|(_, v)| v.clone()).collect();
    values.push(Value::Integer(int(at.id)?));
    values.push(text(id));
    tx.execute(
        &format!("UPDATE {table} SET {} WHERE id = ?", set.join(", ")),
        rusqlite::params_from_iter(values),
    )?;
    Ok(())
}

fn no_agent(id: &str) -> String {
    format!("no agent session {id}")
}

fn present(tx: &Transaction<'_>, id: &str) -> Result<(), String> {
    let found = tx
        .prepare("SELECT 1 FROM agent_sessions WHERE id = ?")
        .and_then(|mut s| s.exists([id]))
        .map_err(|e| e.to_string())?;
    if found { Ok(()) } else { Err(no_agent(id)) }
}

/// An agent's stored external ref, as JSON text, or none while it is bound to nothing.
struct StoredRef(Option<String>);

/// The agent's stored external ref, or `None` when there is no such agent.
fn stored_ref(tx: &Transaction<'_>, id: &str) -> rusqlite::Result<Option<StoredRef>> {
    tx.query_row(
        "SELECT external_ref FROM agent_sessions WHERE id = ?",
        [id],
        |row| row.get(0).map(StoredRef),
    )
    .optional()
}

/// The `id` of a stored external ref, null for none, or `None` where the stored JSON names no
/// id, which matches nothing, as TypeScript's `undefined` matches nothing. Stored JSON that doesn't
/// parse is refused, as `JSON.parse` throws on it.
fn session_id_of(stored: Option<&str>) -> Result<Option<serde_json::Value>, String> {
    match stored {
        None => Ok(Some(serde_json::Value::Null)),
        Some(json) => serde_json::from_str::<serde_json::Value>(json)
            .map(|value| value.get("id").cloned())
            .map_err(|e| format!("the stored external ref isn't JSON: {e}")),
    }
}

/// The columns that bind an agent to `external_ref`. Moving to another session forgets where the
/// last one kept its conversation, so it can't be resumed until the new one's hooks say. A Codex
/// thread another live agent holds is refused.
fn bound_to(
    tx: &Transaction<'_>,
    id: &str,
    external_ref: Option<&ExternalRef>,
) -> Result<Columns, String> {
    let stored = stored_ref(tx, id)
        .map_err(|e| e.to_string())?
        .and_then(|s| s.0);
    let wanted = external_ref.map_or(serde_json::Value::Null, |r| serde_json::json!(r.id));
    let moved = session_id_of(stored.as_deref())? != Some(wanted);
    if let Some(r) = external_ref.filter(|r| moved && r.kind == ExternalRefKind::CodexThread) {
        let holder: Option<String> = tx
            .query_row(
                "SELECT id FROM agent_sessions WHERE state NOT IN ('closed', 'failed')
                   AND json_extract(external_ref, '$.kind') = 'codex-thread'
                   AND json_extract(external_ref, '$.id') = ? AND id != ? LIMIT 1",
                (&r.id, id),
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(holder) = holder {
            return Err(format!(
                "agent {id} can't be bound to Codex thread {}: agent {holder} holds it",
                r.id
            ));
        }
    }
    let json = external_ref
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    let mut columns = vec![("external_ref", json.map_or(Value::Null, Value::Text))];
    if moved {
        columns.push(("transcript", Value::Null));
    }
    Ok(columns)
}

/// A start's harness name, set only by one that records it.
fn started_as(harness_name: Option<&str>) -> Columns {
    harness_name.map_or_else(Vec::new, |name| vec![("harness_name", text(name))])
}

/// The columns that record which runtime incarnation a terminal is in, and the theme it was
/// started for.
fn incarnation(
    runtime_ref: &RuntimeRefPayload,
    theme: Option<TuiTheme>,
) -> serde_json::Result<Columns> {
    Ok(vec![
        ("runtime", text(runtime_ref.runtime.clone())),
        (
            "locator",
            text(serde_json::to_string(&runtime_ref.locator)?),
        ),
        ("theme", theme.map_or(Value::Null, |t| text(t.as_str()))),
    ])
}

/// The terminal an agent is on now.
fn terminal_of(tx: &Transaction<'_>, id: &str) -> rusqlite::Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT terminal_id FROM agent_sessions WHERE id = ?",
            [id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// Records the runtime a new terminal is created on; an event without one was made on tmux, the
/// column's default.
fn created_on(
    tx: &Transaction<'_>,
    terminal: &str,
    runtime: Option<&str>,
) -> Result<(), AppendError> {
    if let Some(runtime) = runtime {
        tx.execute(
            "UPDATE terminals SET runtime_kind = ? WHERE id = ?",
            (runtime, terminal),
        )?;
    }
    Ok(())
}

/// The prompt a start gave the agent, which a start from before prompts were hashed doesn't say.
fn delivered_prompt(tx: &Transaction<'_>, id: &str, hash: Option<&str>) -> Result<(), AppendError> {
    if let Some(hash) = hash {
        tx.execute(
            "UPDATE agent_sessions SET prompt_hash = ? WHERE id = ?",
            (hash, id),
        )?;
    }
    Ok(())
}

/// A new or closed process says nothing yet: the last one's signal goes with it.
fn forget_activity(tx: &Transaction<'_>, id: &str) -> Result<(), AppendError> {
    tx.execute(
        "DELETE FROM activity_latest WHERE agent_session_id = ?",
        [id],
    )?;
    Ok(())
}

/// Ends every active assignment whose `column`, its task's or its agent's, is `id`, as the event
/// that ends them all applies.
pub(crate) fn end_assignments(
    tx: &Transaction<'_>,
    at: &At<'_>,
    column: &'static str,
    id: &str,
    reason: &str,
) -> Result<(), AppendError> {
    tx.execute(
        &format!(
            "UPDATE assignments SET state = 'ended', end_reason = ?, updated_event_id = ?
             WHERE {column} = ? AND state = 'active'"
        ),
        (reason, int(at.id)?, id),
    )?;
    Ok(())
}

/// Ends every active assignment granted under one this event ended, however deep, as
/// `parent_ended`: no agent keeps authority it was given by one that has lost it.
pub(crate) fn end_descendants(tx: &Transaction<'_>, at: &At<'_>) -> Result<(), AppendError> {
    let event = int(at.id)?;
    tx.execute(
        "WITH RECURSIVE under (id) AS (
           SELECT a.id FROM assignments a JOIN assignments p ON a.parent_assignment_id = p.id
             WHERE p.updated_event_id = ? AND p.state = 'ended'
           UNION
           SELECT a.id FROM assignments a JOIN under ON a.parent_assignment_id = under.id
         )
         UPDATE assignments SET state = 'ended', end_reason = 'parent_ended', updated_event_id = ?
         WHERE state = 'active' AND id IN (SELECT id FROM under)",
        (event, event),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::ids::{AgentId, EnvironmentId};

    use super::AgentChange;
    use crate::testing::TempDir;
    use crate::{AppendError, NewEvent, Store};

    const ENV: &str = "env_01900000000070008000000000000001";

    fn agent(n: u8) -> AgentId {
        AgentId::parse(&format!("agent_0190000000007000800000000000000{n}")).unwrap()
    }

    fn change(json: &str) -> AgentChange {
        let (kind, payload) = json.split_once(' ').unwrap();
        match kind {
            "launched" => AgentChange::Launched(serde_json::from_str(payload).unwrap()),
            "running" => AgentChange::Running(serde_json::from_str(payload).unwrap()),
            "transcript" => AgentChange::TranscriptRecorded(serde_json::from_str(payload).unwrap()),
            "closing" => AgentChange::Closing,
            "closed" => AgentChange::Closed,
            other => panic!("no change {other}"),
        }
    }

    fn append(store: &mut Store, agent: &AgentId, json: &str) -> Result<u64, AppendError> {
        let event = NewEvent::Agent {
            agent: agent.clone(),
            actor: "system".to_owned(),
            change: change(json),
        };
        store.write(|w| w.append(&event))
    }

    /// A store with an environment and agents 1 to `count` running, each on no terminal.
    fn running(dir: &TempDir, count: u8) -> Store {
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let env = NewEvent::EnvironmentRegistered {
            environment: EnvironmentId::parse(ENV).unwrap(),
            payload: serde_json::from_str(r#"{"kind":"local"}"#).unwrap(),
        };
        store.write(|w| w.append(&env)).unwrap();
        for n in 1..=count {
            let launched = format!(
                r#"launched {{"environmentId":"{ENV}","harness":"claude-code","project":"p","cwd":"/","terminalId":null}}"#
            );
            append(&mut store, &agent(n), &launched).unwrap();
            append(
                &mut store,
                &agent(n),
                r#"running {"externalRef":null,"runtimeRef":null}"#,
            )
            .unwrap();
        }
        store
    }

    fn assignments(store: &Store) -> Vec<(String, String, Option<String>)> {
        let mut statement = store
            .db
            .prepare("SELECT id, state, end_reason FROM assignments ORDER BY id")
            .unwrap();
        statement
            .query_map((), |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn closing_an_agent_ends_its_assignments_and_every_one_granted_under_them_however_deep() {
        let dir = TempDir::new("agent-close-assignments");
        let mut store = running(&dir, 4);
        let [a1, a2, a3, a4] = [1, 2, 3, 4].map(|n| agent(n).as_str().to_owned());
        // a1 leads; a2 works under it, and a3 under a2; a4 works on its own.
        store
            .db
            .execute_batch(&format!(
                "INSERT INTO tasks (id, title, brief, state, created_event_id, updated_event_id)
                   VALUES ('task_1', 'T', '', 'open', 1, 1);
                 INSERT INTO assignments (id, task_id, agent_session_id, role,
                   parent_assignment_id, state, created_event_id, updated_event_id) VALUES
                   ('asgn_1', 'task_1', '{a1}', 'lead', NULL, 'active', 1, 1),
                   ('asgn_2', 'task_1', '{a2}', 'worker', 'asgn_1', 'active', 1, 1),
                   ('asgn_3', 'task_1', '{a3}', 'worker', 'asgn_2', 'active', 1, 1),
                   ('asgn_4', 'task_1', '{a4}', 'worker', NULL, 'active', 1, 1);"
            ))
            .unwrap();
        append(&mut store, &agent(1), "closing {}").unwrap();
        let closed = append(&mut store, &agent(1), "closed {}").unwrap();
        let ended =
            |id: &str, reason: &str| (id.to_owned(), "ended".to_owned(), Some(reason.to_owned()));
        assert_eq!(
            assignments(&store),
            [
                ended("asgn_1", "agent_closed"),
                ended("asgn_2", "parent_ended"),
                ended("asgn_3", "parent_ended"),
                ("asgn_4".to_owned(), "active".to_owned(), None),
            ]
        );
        let updated: i64 = store
            .db
            .query_row(
                "SELECT updated_event_id FROM assignments WHERE id = 'asgn_3'",
                (),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(u64::try_from(updated).ok(), Some(closed));
    }

    #[test]
    fn refuses_a_transcript_or_a_bind_for_an_agent_whose_stored_external_ref_isn_t_json() {
        let dir = TempDir::new("agent-bad-ref");
        let mut store = running(&dir, 1);
        store
            .db
            .execute(
                "UPDATE agent_sessions SET external_ref = '{not json' WHERE id = ?",
                [agent(1).as_str()],
            )
            .unwrap();
        for json in [
            r#"transcript {"sessionId":"s1","path":"/t.jsonl"}"#,
            r#"running {"externalRef":null,"runtimeRef":null}"#,
        ] {
            let got = append(&mut store, &agent(1), json);
            assert!(
                matches!(&got, Err(AppendError::Refused { reason, .. }) if reason.starts_with("the stored external ref isn't JSON")),
                "{json}: {got:?}"
            );
        }
    }
}
