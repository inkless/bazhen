//! Terminals and the environments they run in: the projections of `environment.registered` and
//! each `terminal.*` event, moved through packages/core's terminal machine, and what the daemon
//! reads back of a shell, as `store.ts` keeps them.

use bazhen_holder_proto::{PROTOCOL_VERSION, negotiate};
use bazhen_protocol::agents::{AgentState, Environment, EnvironmentKind};
use bazhen_protocol::events::{EnvironmentRegistered, RuntimeRefPayload};
use bazhen_protocol::ids::{AgentId, EnvironmentId, Id, TerminalId};
use bazhen_protocol::shells::{
    Foreground, NeedsRestart, Shell, TerminalState, TuiTheme, shell_command_line, shell_commands,
};
use rusqlite::types::ToSql;
use rusqlite::{OptionalExtension, Transaction};

use crate::events::{AppendError, NewEvent, Reads, TerminalChange, Writer, int, unsigned};
use crate::projections::At;
use crate::snapshot::{SnapshotError, SnapshotView};

/// A step of a terminal's lifecycle, as packages/core's `TerminalEvent` names it; only the steps
/// a shell's or an agent's events take are here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    RuntimeConfirmed,
    RuntimeRejected,
    ProcessExited,
    Respawned,
    Adopted,
    TargetAbsent,
    CloseRequested,
    CloseCompleted,
}

impl Step {
    fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeConfirmed => "runtime.confirmed",
            Self::RuntimeRejected => "runtime.rejected",
            Self::ProcessExited => "process.exited",
            Self::Respawned => "respawned",
            Self::Adopted => "adopted",
            Self::TargetAbsent => "target.absent",
            Self::CloseRequested => "close.requested",
            Self::CloseCompleted => "close.completed",
        }
    }
}

/// Whether a terminal in `from` may record its process exited (`accepts(from,
/// "process.exited")`): one running, or one whose process wasn't known.
#[must_use]
pub fn takes_exit(from: TerminalState) -> bool {
    advance(from, Step::ProcessExited).is_ok()
}

/// Whether an agent in `state` with its terminal in `terminal` waits on its start's answer: one
/// requested, whose terminal is still being created or still holds the process it replaces.
#[must_use]
pub fn start_unsettled(state: AgentState, terminal: Option<TerminalState>) -> bool {
    state == AgentState::Starting
        && matches!(
            terminal,
            Some(TerminalState::Creating | TerminalState::Exited)
        )
}

/// Where `step` takes a terminal in `from`, as packages/core's table has it, or why it can't.
pub(crate) fn advance(from: TerminalState, step: Step) -> Result<TerminalState, String> {
    use Step::{
        Adopted, CloseCompleted, CloseRequested, ProcessExited, Respawned, RuntimeConfirmed,
        RuntimeRejected,
    };
    use TerminalState::{Closed, Closing, Creating, Exited, Failed, Lost, Running, Unknown};
    match (from, step) {
        (Creating, RuntimeConfirmed) | (Running | Exited, Adopted) | (Exited, Respawned) => {
            Ok(Running)
        }
        (Running | Unknown, ProcessExited) => Ok(Exited),
        (Creating, RuntimeRejected) => Ok(Failed),
        (Running | Unknown | Exited, Step::TargetAbsent) => Ok(Lost),
        (Running | Unknown | Exited | Lost, CloseRequested) => Ok(Closing),
        (Closing, CloseCompleted) => Ok(Closed),
        _ => Err(format!(
            "terminal cannot handle {} while {}",
            step.as_str(),
            from.as_str()
        )),
    }
}

/// A column a projection sets, with its value.
type Column<'a> = (&'static str, &'a dyn ToSql);

/// A shell that has ended has no command left to type back, and keeps none it held.
const FORGET_COMMAND: [Column<'static>; 3] = [
    ("last_command", &rusqlite::types::Null),
    ("last_command_seq", &rusqlite::types::Null),
    ("report_token_hash", &rusqlite::types::Null),
];

pub(crate) fn project(
    tx: &Transaction<'_>,
    at: &At<'_>,
    terminal: &TerminalId,
    change: &TerminalChange,
) -> Result<(), AppendError> {
    let refuse = |reason: String| AppendError::Refused {
        event: change.name(),
        reason,
    };
    let id = terminal.as_str();
    match change {
        TerminalChange::Opened(payload) => {
            tx.execute(
                "INSERT INTO terminals
                   (id, host_id, state, generation, runtime, locator, environment_id, kind, cwd,
                    linked_agent_id, theme, created_event_id, updated_event_id)
                 VALUES (?, ?, 'creating', 0, NULL, NULL, ?, 'shell', ?, ?, ?, ?, ?)",
                (
                    id,
                    at.host,
                    payload.environment_id.as_str(),
                    &payload.cwd,
                    payload.linked_agent_id.as_ref().map(Id::as_str),
                    payload.theme.map(TuiTheme::as_str),
                    int(at.id)?,
                    int(at.id)?,
                ),
            )?;
            if let Some(runtime) = &payload.runtime {
                tx.execute(
                    "UPDATE terminals SET runtime_kind = ? WHERE id = ?",
                    (runtime, id),
                )?;
            }
        }
        TerminalChange::Running(payload) => {
            let locator = serde_json::to_string(&payload.runtime_ref.locator)?;
            move_shell(
                tx,
                at,
                change,
                id,
                Step::RuntimeConfirmed,
                &[
                    ("runtime", &payload.runtime_ref.runtime),
                    ("locator", &locator),
                ],
            )?;
        }
        TerminalChange::Failed(_) => {
            move_shell(tx, at, change, id, Step::RuntimeRejected, &FORGET_COMMAND)?;
        }
        TerminalChange::ProcessAdopted(payload) => {
            let generation = adopted_generation(tx, id, &payload.runtime_ref).map_err(refuse)?;
            let locator = serde_json::to_string(&payload.runtime_ref.locator)?;
            let generation = int(generation)?;
            move_shell(
                tx,
                at,
                change,
                id,
                Step::Adopted,
                &[
                    ("runtime", &payload.runtime_ref.runtime),
                    ("locator", &locator),
                    ("generation", &generation),
                ],
            )?;
        }
        // Nothing runs in a shell that is gone.
        TerminalChange::Lost => move_shell(
            tx,
            at,
            change,
            id,
            Step::TargetAbsent,
            &[
                ("foreground", &rusqlite::types::Null),
                ("report_token_hash", &rusqlite::types::Null),
            ],
        )?,
        TerminalChange::Closing => move_shell(tx, at, change, id, Step::CloseRequested, &[])?,
        TerminalChange::Closed(_) => {
            move_shell(tx, at, change, id, Step::CloseCompleted, &FORGET_COMMAND)?;
        }
        TerminalChange::ForegroundChanged(_)
        | TerminalChange::Renamed(_)
        | TerminalChange::NeedsRestart(_)
        | TerminalChange::RestartCleared
        | TerminalChange::Unlinked => describe(tx, at, id, change)?,
    }
    Ok(())
}

/// The changes to what a terminal is, never where it is in its lifecycle.
fn describe(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    change: &TerminalChange,
) -> Result<(), AppendError> {
    match change {
        TerminalChange::ForegroundChanged(payload) => {
            let foreground = payload
                .command
                .as_ref()
                .map(|command| {
                    serde_json::to_string(&Foreground {
                        command: command.clone(),
                        since: at.ts.to_owned(),
                    })
                })
                .transpose()?;
            set_shell(tx, at, change, id, &[("foreground", &foreground)])?;
        }
        TerminalChange::Renamed(payload) => {
            set_shell(tx, at, change, id, &[("name", &payload.name)])?;
        }
        TerminalChange::NeedsRestart(payload) => {
            let protocol = serde_json::to_string(&payload.protocol)?;
            set_terminal(tx, at, change, id, &[("restart_protocol", &protocol)])?;
        }
        TerminalChange::Unlinked => set_shell(
            tx,
            at,
            change,
            id,
            &[("linked_agent_id", &rusqlite::types::Null)],
        )?,
        TerminalChange::RestartCleared => set_terminal(
            tx,
            at,
            change,
            id,
            &[("restart_protocol", &rusqlite::types::Null)],
        )?,
        _ => {}
    }
    Ok(())
}

/// The generation an adopted process's ref names, which must be later than the terminal's:
/// generations only rise, and commands aimed at an older one must stay stale.
pub(crate) fn adopted_generation(
    tx: &Transaction<'_>,
    id: &str,
    runtime_ref: &RuntimeRefPayload,
) -> Result<u64, String> {
    let current: Option<i64> = tx
        .query_row(
            "SELECT generation FROM terminals WHERE id = ?",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(current) = current else {
        return Err(format!("no terminal {id}"));
    };
    let named = runtime_ref
        .locator
        .entries()
        .iter()
        .find(|(key, _)| key == "generation")
        .and_then(|(_, value)| value.parse::<u64>().ok());
    match named {
        Some(generation) if i64::try_from(generation).is_ok_and(|g| g > current) => Ok(generation),
        _ => Err(format!(
            "terminal {id}: an adopted process's generation must be above {current}"
        )),
    }
}

/// Moves a shell a step through its lifecycle, setting `columns` with it.
fn move_shell(
    tx: &Transaction<'_>,
    at: &At<'_>,
    change: &TerminalChange,
    id: &str,
    step: Step,
    columns: &[Column<'_>],
) -> Result<(), AppendError> {
    let refuse = |reason: String| AppendError::Refused {
        event: change.name(),
        reason,
    };
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM terminals WHERE id = ? AND kind = 'shell'",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(state) = state else {
        return Err(refuse(format!("no shell {id}")));
    };
    let from = TerminalState::parse(&state)
        .ok_or_else(|| refuse(format!("shell {id} is in no state a shell has: {state}")))?;
    let to = advance(from, step).map_err(refuse)?.as_str();
    let mut all: Vec<Column<'_>> = vec![("state", &to)];
    all.extend_from_slice(columns);
    update(tx, at, id, &all)
}

/// Changes what a shell is, never where it is in its lifecycle.
fn set_shell(
    tx: &Transaction<'_>,
    at: &At<'_>,
    change: &TerminalChange,
    id: &str,
    columns: &[Column<'_>],
) -> Result<(), AppendError> {
    let present = tx
        .prepare("SELECT 1 FROM terminals WHERE id = ? AND kind = 'shell'")?
        .exists([id])?;
    if !present {
        return Err(AppendError::Refused {
            event: change.name(),
            reason: format!("no shell {id}"),
        });
    }
    update(tx, at, id, columns)
}

/// Changes what any terminal, an agent's or a shell, records.
fn set_terminal(
    tx: &Transaction<'_>,
    at: &At<'_>,
    change: &TerminalChange,
    id: &str,
    columns: &[Column<'_>],
) -> Result<(), AppendError> {
    let present = tx
        .prepare("SELECT 1 FROM terminals WHERE id = ?")?
        .exists([id])?;
    if !present {
        return Err(AppendError::Refused {
            event: change.name(),
            reason: format!("no terminal {id}"),
        });
    }
    update(tx, at, id, columns)
}

fn update(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    columns: &[Column<'_>],
) -> Result<(), AppendError> {
    let event = int(at.id)?;
    let mut set: Vec<String> = columns
        .iter()
        .map(|(column, _)| format!("{column} = ?"))
        .collect();
    set.push("updated_event_id = ?".to_owned());
    let mut values: Vec<&dyn ToSql> = columns.iter().map(|(_, value)| *value).collect();
    values.push(&event);
    values.push(&id);
    tx.execute(
        &format!("UPDATE terminals SET {} WHERE id = ?", set.join(", ")),
        rusqlite::params_from_iter(values),
    )?;
    Ok(())
}

/// A shell as the daemon reads it to act on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellRow {
    pub id: TerminalId,
    pub state: TerminalState,
    pub generation: u64,
    /// The runtime its incarnation is on, once one confirmed it.
    pub runtime: Option<String>,
    /// Where that runtime keeps it, as the JSON text the runtime recorded.
    pub locator: Option<String>,
    /// The runtime it was created on.
    pub runtime_kind: String,
    /// The directory it opened in.
    pub cwd: String,
    /// The directory it was last seen in, else the one it opened in.
    pub current_cwd: String,
    pub linked_agent_id: Option<String>,
    pub theme: Option<TuiTheme>,
    /// The program its foreground was last seen running, `None` at its prompt.
    pub foreground: Option<String>,
}

/// A terminal's incarnation as a runtime confirmed it, whatever kind of terminal it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRow {
    /// The runtime it is on.
    pub runtime: String,
    /// Where that runtime keeps it, as the JSON text the runtime recorded.
    pub locator: Option<String>,
}

/// The states of a terminal that holds, or may yet hold, a PTY.
const OPEN_STATES: &str = "('creating', 'running', 'unknown', 'exited', 'closing')";

/// What a `ShellRow` is read from, for a `WHERE` to follow.
const SHELL_ROW: &str = "SELECT id, state, generation, runtime, locator, runtime_kind, cwd,
       coalesce(current_cwd, cwd), linked_agent_id, theme, json_extract(foreground, '$.command')
     FROM terminals WHERE kind = 'shell'";

/// The shells of this machine's environment not yet lost, closed or failed, oldest first.
fn recoverable_shells() -> String {
    format!(
        "{SHELL_ROW} AND environment_id = (
           SELECT id FROM environments WHERE kind = 'local'
           ORDER BY created_event_id LIMIT 1)
         AND state NOT IN ('lost', 'closed', 'failed') ORDER BY created_event_id"
    )
}

fn shell_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ShellRow> {
    let unreadable = |i: usize, what: &str| {
        rusqlite::Error::FromSqlConversionFailure(
            i,
            rusqlite::types::Type::Text,
            format!("{what} isn't one a shell has").into(),
        )
    };
    let id: String = row.get(0)?;
    let state: String = row.get(1)?;
    let theme: Option<String> = row.get(9)?;
    Ok(ShellRow {
        id: TerminalId::parse(&id).ok_or_else(|| unreadable(0, "its id"))?,
        state: TerminalState::parse(&state).ok_or_else(|| unreadable(1, "its state"))?,
        generation: unsigned(row, 2)?,
        runtime: row.get(3)?,
        locator: row.get(4)?,
        runtime_kind: row.get(5)?,
        cwd: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        current_cwd: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        linked_agent_id: row.get(8)?,
        theme: theme.as_deref().and_then(TuiTheme::parse),
        foreground: row.get(10)?,
    })
}

/// An agent with its current terminal, as each command on it reads them (`agentTerminal`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTerminal {
    pub agent_id: AgentId,
    pub state: AgentState,
    /// Its current terminal, once it has one.
    pub terminal_id: Option<TerminalId>,
    pub terminal_state: Option<TerminalState>,
    pub generation: Option<u64>,
    /// The runtime its incarnation is on, once one confirmed it.
    pub runtime: Option<String>,
    /// Where that runtime keeps it, as the JSON text the runtime recorded.
    pub locator: Option<String>,
    /// The runtime its terminal was created on, whether or not it runs there yet.
    pub runtime_kind: Option<String>,
}

const AGENT_TERMINAL: &str = "SELECT a.id, a.state, t.id, t.state, t.generation, t.runtime,
       t.locator, t.runtime_kind
     FROM agent_sessions a LEFT JOIN terminals t ON t.id = a.terminal_id WHERE a.id = ?";

/// The agents of this machine's environment not yet lost, closed or failed, oldest first.
const RECOVERABLE_AGENTS: &str = "SELECT a.id, a.state, t.id, t.state, t.generation, t.runtime,
       t.locator, t.runtime_kind
     FROM agent_sessions a LEFT JOIN terminals t ON t.id = a.terminal_id
     WHERE a.environment_id = (
       SELECT id FROM environments WHERE kind = 'local' ORDER BY created_event_id LIMIT 1)
     AND a.state NOT IN ('lost', 'closed', 'failed') ORDER BY a.created_event_id";

/// Each terminal made for an agent, with the agent, current or not.
const AGENT_ROWS: &str = "SELECT a.id, a.state, t.id, t.state, t.generation, t.runtime,
       t.locator, t.runtime_kind
     FROM terminals t JOIN agent_sessions a ON a.id = t.agent_session_id";

/// The agent a terminal is the current terminal of, through the terminal's own agent column:
/// one its agent has left behind, as a relaunch leaves one, finds none (`AGENT_BY_TERMINAL`).
const AGENT_BY_TERMINAL: &str = "SELECT a.id, a.state, t.id, t.state, t.generation, t.runtime,
       t.locator, t.runtime_kind
     FROM terminals t JOIN agent_sessions a ON a.id = t.agent_session_id AND a.terminal_id = t.id
     WHERE t.id = ?";

fn agent_terminal_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentTerminal> {
    let unreadable = |i: usize, what: &str| {
        rusqlite::Error::FromSqlConversionFailure(
            i,
            rusqlite::types::Type::Text,
            format!("{what} isn't one an agent has").into(),
        )
    };
    let id: String = row.get(0)?;
    let state: String = row.get(1)?;
    let terminal: Option<String> = row.get(2)?;
    let terminal_state: Option<String> = row.get(3)?;
    let generation: Option<i64> = row.get(4)?;
    Ok(AgentTerminal {
        agent_id: AgentId::parse(&id).ok_or_else(|| unreadable(0, "its id"))?,
        state: serde_json::from_value(serde_json::Value::String(state))
            .map_err(|_| unreadable(1, "its state"))?,
        terminal_id: terminal
            .map(|t| TerminalId::parse(&t).ok_or_else(|| unreadable(2, "its terminal's id")))
            .transpose()?,
        terminal_state: terminal_state
            .map(|t| TerminalState::parse(&t).ok_or_else(|| unreadable(3, "its terminal's state")))
            .transpose()?,
        generation: generation
            .map(|g| u64::try_from(g).map_err(|_| unreadable(4, "its generation")))
            .transpose()?,
        runtime: row.get(5)?,
        locator: row.get(6)?,
        runtime_kind: row.get(7)?,
    })
}

impl Reads<'_> {
    /// The agent `id` names, with its current terminal, or `None` for one the store doesn't know.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a row no agent could have written.
    pub fn agent_terminal(self, id: &str) -> rusqlite::Result<Option<AgentTerminal>> {
        self.0
            .query_row(AGENT_TERMINAL, [id], agent_terminal_row)
            .optional()
    }

    /// The agents of this machine's environment a restarted daemon may still find running, as
    /// any not yet lost, closed or failed may be, each with its current terminal, oldest first
    /// (`recoverable`).
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a row no agent could have written.
    pub fn recoverable_agents(self) -> rusqlite::Result<Vec<AgentTerminal>> {
        self.0
            .prepare(RECOVERABLE_AGENTS)?
            .query_map((), agent_terminal_row)?
            .collect()
    }

    /// The agent whose current terminal `terminal` is, with it, or `None` for a terminal no
    /// agent runs in now.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a row no agent could have written.
    pub fn agent_of_terminal(self, terminal: &str) -> rusqlite::Result<Option<AgentTerminal>> {
        self.0
            .query_row(AGENT_BY_TERMINAL, [terminal], agent_terminal_row)
            .optional()
    }

    /// The agent terminal `terminal` was made for, with that terminal, whether or not it is the
    /// agent's current one, or `None` for a terminal no agent was made.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a row no agent could have written.
    pub fn agent_with_terminal(self, terminal: &str) -> rusqlite::Result<Option<AgentTerminal>> {
        self.0
            .query_row(
                &format!("{AGENT_ROWS} WHERE t.id = ?"),
                [terminal],
                agent_terminal_row,
            )
            .optional()
    }

    /// Each terminal made for agent `agent` that isn't closed, with the agent, oldest first: what
    /// any of them ran may run still.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a row no agent could have written.
    pub fn agent_terminals(self, agent: &str) -> rusqlite::Result<Vec<AgentTerminal>> {
        self.0
            .prepare(&format!(
                "{AGENT_ROWS} WHERE a.id = ? AND t.state != 'closed' ORDER BY t.created_event_id"
            ))?
            .query_map([agent], agent_terminal_row)?
            .collect()
    }
}

impl Reads<'_> {
    /// The incarnation terminal `id` runs in, an agent's or a shell's, or `None` for no terminal,
    /// or one no runtime has confirmed (`runtimeRef`).
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn runtime_row(self, id: &str) -> rusqlite::Result<Option<RuntimeRow>> {
        self.0
            .query_row(
                "SELECT runtime, locator FROM terminals WHERE id = ? AND runtime IS NOT NULL",
                [id],
                |row| {
                    Ok(RuntimeRow {
                        runtime: row.get(0)?,
                        locator: row.get(1)?,
                    })
                },
            )
            .optional()
    }

    /// The state of the terminal `id` names, an agent's or a shell's, or `None` for none
    /// (`terminalState`).
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a state no terminal could have recorded.
    pub fn terminal_state(self, id: &str) -> rusqlite::Result<Option<TerminalState>> {
        let state: Option<String> = self
            .0
            .query_row("SELECT state FROM terminals WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .optional()?;
        state
            .map(|state| {
                TerminalState::parse(&state).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        format!("{state} isn't a terminal's state").into(),
                    )
                })
            })
            .transpose()
    }

    /// The shell `id` names, or `None` for none, or a terminal that isn't a shell.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn shell(self, id: &str) -> rusqlite::Result<Option<ShellRow>> {
        self.0
            .query_row(&format!("{SHELL_ROW} AND id = ?"), [id], shell_row)
            .optional()
    }

    /// The shells linked to `agent` not yet closed or failed, oldest first (`linkedShells`):
    /// those that close with it.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn linked_shells(self, agent: &str) -> rusqlite::Result<Vec<ShellRow>> {
        self.0
            .prepare(&format!(
                "{SHELL_ROW} AND linked_agent_id = ? AND state NOT IN ('closed', 'failed')
                 ORDER BY created_event_id"
            ))?
            .query_map([agent], shell_row)?
            .collect()
    }

    /// The shells of this machine's environment a restarted daemon may still find running, as
    /// any but lost, closed or failed ones may be, oldest first.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn recoverable_shells(self) -> rusqlite::Result<Vec<ShellRow>> {
        self.0
            .prepare(&recoverable_shells())?
            .query_map((), shell_row)?
            .collect()
    }

    /// The id, as stored, of the first shell `recoverable_shells` can't read, or `None` when it
    /// reads them all.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn unreadable_shell(self) -> rusqlite::Result<Option<String>> {
        let mut statement = self.0.prepare(&recoverable_shells())?;
        let mut rows = statement.query(())?;
        while let Some(row) = rows.next()? {
            if shell_row(row).is_err() {
                return row.get(0).map(Some);
            }
        }
        Ok(None)
    }

    /// Whether the terminal `id` names hasn't ended and isn't yet recorded as needing a restart.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn restart_unrecorded(self, id: &str) -> rusqlite::Result<bool> {
        self.0
            .prepare(
                "SELECT 1 FROM terminals WHERE id = ? AND restart_protocol IS NULL
                 AND state NOT IN ('closed', 'failed', 'lost')",
            )?
            .exists([id])
    }

    /// The terminals not yet ended that are recorded as needing a restart.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn restarts_recorded(self) -> rusqlite::Result<Vec<String>> {
        self.0
            .prepare(
                "SELECT id FROM terminals WHERE restart_protocol IS NOT NULL
                 AND state NOT IN ('closed', 'failed', 'lost') ORDER BY created_event_id",
            )?
            .query_map((), |row| row.get(0))?
            .collect()
    }

    /// How many terminals, agents' and shells', hold or may yet hold a PTY.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn open_terminals(self) -> rusqlite::Result<u64> {
        self.0.query_row(
            &format!("SELECT count(*) FROM terminals WHERE state IN {OPEN_STATES}"),
            (),
            |row| unsigned(row, 0),
        )
    }

    /// How many terminals are being opened, whose PTY the machine may not count yet.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn starting_terminals(self) -> rusqlite::Result<u64> {
        self.0.query_row(
            "SELECT count(*) FROM terminals WHERE state = 'creating'",
            (),
            |row| unsigned(row, 0),
        )
    }

    /// Whether the shell `id` names keeps a last command line to type back, as only a shell that
    /// reported its lines does.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn keeps_last_command(self, id: &str) -> rusqlite::Result<bool> {
        self.0
            .query_row(
                "SELECT last_command IS NOT NULL FROM terminals WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(|kept| kept.unwrap_or(false))
    }

    /// The hash of the token the shell `id` names reports with, or `None` for one that can't
    /// report.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn shell_token_hash(self, id: &str) -> rusqlite::Result<Option<String>> {
        self.0
            .query_row(
                "SELECT report_token_hash FROM terminals WHERE id = ? AND kind = 'shell'",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
    }

    /// The line kept to type back into the replacement of the shell `id` names, or `None` when
    /// none is.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn last_shell_command(self, id: &str) -> rusqlite::Result<Option<String>> {
        self.0
            .query_row(
                "SELECT last_command FROM terminals WHERE id = ? AND kind = 'shell'",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
    }

    /// The environment this machine's terminals run in, once one is registered.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn local_environment(self) -> rusqlite::Result<Option<String>> {
        self.0
            .query_row(
                "SELECT id FROM environments WHERE kind = 'local' ORDER BY created_event_id LIMIT 1",
                (),
                |row| row.get(0),
            )
            .optional()
    }
}

impl Writer<'_> {
    /// A new terminal's id, minted now.
    ///
    /// # Errors
    ///
    /// When the kernel gives no random bytes.
    pub fn mint_terminal(&self) -> Result<TerminalId, AppendError> {
        let urandom = crate::urandom().map_err(|e| AppendError::Refused {
            event: "terminal.opened",
            reason: format!("no id can be made: {e}"),
        })?;
        Ok(TerminalId::mint(crate::now_ms(), urandom))
    }

    /// Notes the directory the shell `id` names was last seen in, as its foreground read shows.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn note_shell_cwd(&self, id: &str, cwd: &str) -> rusqlite::Result<()> {
        self.connection().execute(
            "UPDATE terminals SET current_cwd = ?
             WHERE id = ? AND kind = 'shell' AND current_cwd IS NOT ?",
            (cwd, id, cwd),
        )?;
        Ok(())
    }

    /// Keeps the line a live shell reported running, under the report's number `seq`. Only a
    /// report newer than the kept one counts, so one arriving late leaves the newer line. A line
    /// that can't be typed back safely clears the kept one: typing an older command instead would
    /// mislead. Answers whether the report counted.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or one for a number beyond what it stores.
    pub fn note_shell_command(
        &self,
        id: &str,
        seq: u64,
        line: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let kept = line.filter(|line| shell_command_line(line));
        let seq =
            i64::try_from(seq).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let changed = self.connection().execute(
            "UPDATE terminals SET last_command = ?, last_command_seq = ?
             WHERE id = ? AND kind = 'shell' AND state IN ('creating', 'running')
             AND (last_command_seq IS NULL OR last_command_seq < ?)",
            (kept, seq, id, seq),
        )?;
        Ok(changed > 0)
    }

    /// Records the hash of the token a new shell's integration will report with.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn note_shell_token(&self, id: &str, hash: &str) -> rusqlite::Result<()> {
        self.connection().execute(
            "UPDATE terminals SET report_token_hash = ? WHERE id = ? AND kind = 'shell'",
            (hash, id),
        )?;
        Ok(())
    }

    /// Forgets every shell's kept line and token, for a daemon started with the integration off:
    /// what it was given while on is no longer wanted, and no shell may report. The journal is
    /// scrubbed once this commits, should it have forgotten any.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn forget_shell_commands(&self) -> rusqlite::Result<()> {
        let changed = self.connection().execute(
            "UPDATE terminals SET last_command = NULL, last_command_seq = NULL, report_token_hash = NULL
             WHERE kind = 'shell' AND (last_command IS NOT NULL OR report_token_hash IS NOT NULL)",
            (),
        )?;
        if changed > 0 {
            self.scrub.set(true);
        }
        Ok(())
    }

    /// The environment this machine's terminals run in: the first registered, or one registered
    /// now.
    ///
    /// # Errors
    ///
    /// [`AppendError`], or one when a stored id isn't an environment's.
    pub fn local_environment(&self) -> Result<EnvironmentId, AppendError> {
        if let Some(id) = Reads(self.connection()).local_environment()? {
            return EnvironmentId::parse(&id).ok_or_else(|| AppendError::Refused {
                event: "environment.registered",
                reason: format!("the local environment's id {id} isn't one"),
            });
        }
        let urandom = crate::urandom().map_err(|e| AppendError::Refused {
            event: "environment.registered",
            reason: format!("no id can be made: {e}"),
        })?;
        let environment = EnvironmentId::mint(crate::now_ms(), urandom);
        self.append(&NewEvent::EnvironmentRegistered {
            environment: environment.clone(),
            payload: EnvironmentRegistered {
                kind: EnvironmentKind::Local,
            },
        })?;
        Ok(environment)
    }
}

/// The terminal states whose holder may still run, so a restart prompt still means something.
fn restartable(state: TerminalState) -> bool {
    matches!(
        state,
        TerminalState::Creating | TerminalState::Running | TerminalState::Exited
    )
}

/// The terminal states a view can attach to.
pub(crate) fn attachable(state: TerminalState) -> bool {
    matches!(
        state,
        TerminalState::Running | TerminalState::Unknown | TerminalState::Exited
    )
}

/// A terminal's restart prompt, or `None` when it needs none or has ended, naming the holder to end
/// where `holder_pid` proved it still runs.
pub(crate) fn needs_restart(
    protocol: Option<&str>,
    state: TerminalState,
    holder_pid: Option<u64>,
) -> Option<NeedsRestart> {
    let protocol = protocol.filter(|_| restartable(state))?;
    let served = serde_json::from_str::<Vec<String>>(protocol).is_ok_and(|versions| {
        (1..=16).contains(&versions.len()) && negotiate(&[PROTOCOL_VERSION], &versions).is_some()
    });
    Some(NeedsRestart { holder_pid, served })
}

/// The command that attaches to a terminal on `runtime`: the holder's, the only runtime this
/// daemon runs. A terminal id is letters, digits and `_`, so it needs no quoting.
pub(crate) fn attach_command(runtime: Option<&str>, id: &str) -> Option<String> {
    (runtime == Some("holder")).then(|| format!("bazhen terminals attach {id}"))
}

/// Every environment, oldest first, each local one on the machine `host` names.
pub(crate) fn environments(
    db: &rusqlite::Connection,
    host: &str,
) -> Result<Vec<Environment>, SnapshotError> {
    let mut statement =
        db.prepare("SELECT id, kind FROM environments ORDER BY created_event_id")?;
    let rows = statement
        .query_map((), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, kind)| {
            let host = if kind == EnvironmentKind::Local.as_str() {
                host
            } else {
                ""
            };
            Ok(serde_json::from_value(serde_json::json!({
                "id": id, "kind": kind, "host": host,
            }))?)
        })
        .collect()
}

/// Every shell not yet ended, oldest first, with what can be done about it now.
pub(crate) fn shells(
    db: &rusqlite::Connection,
    view: &SnapshotView,
) -> Result<Vec<Shell>, SnapshotError> {
    let mut statement = db.prepare(
        "SELECT id, environment_id, state, generation, cwd, linked_agent_id, name,
           coalesce(theme, 'dark'), foreground, runtime, restart_protocol,
           last_command IS NOT NULL
         FROM terminals WHERE kind = 'shell' AND state NOT IN ('closed', 'failed')
         ORDER BY created_event_id",
    )?;
    let rows = statement
        .query_map((), |row| {
            Ok((
                (
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    unsigned(row, 3)?,
                    row.get::<_, Option<String>>(4)?,
                ),
                (
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, bool>(11)?,
                ),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(
                (id, environment, state, generation, cwd),
                (linked, name, theme, foreground, runtime, protocol, kept),
            )| {
                let state: TerminalState =
                    serde_json::from_value(serde_json::Value::String(state))?;
                let holder = view.restart_holders.get(&id).copied();
                let restart = needs_restart(protocol.as_deref(), state, holder);
                let attach = attachable(state) && restart.as_ref().is_none_or(|r| r.served);
                let foreground: Option<Foreground> = foreground
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?;
                Ok(serde_json::from_value(serde_json::json!({
                    "id": id,
                    "environmentId": environment,
                    "state": state,
                    "generation": generation,
                    "cwd": cwd,
                    "linkedAgentId": linked,
                    "name": name,
                    "theme": theme,
                    "foreground": foreground,
                    "attachCommand": if attach { attach_command(runtime.as_deref(), &id) } else { None },
                    "commands": shell_commands(state, linked.is_some()),
                    // A lost shell's last line is offered back only while shells report what
                    // they run, as only then can its replacement say when it is at its prompt.
                    "retypeable": view.shells_report && state == TerminalState::Lost && kept,
                    "needsRestart": restart,
                }))?)
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::events::{
        TerminalClosed, TerminalClosedReason, TerminalFailed, TerminalFailedReason,
        TerminalForegroundChanged, TerminalIncarnation, TerminalNeedsRestart, TerminalOpened,
        TerminalRenamed,
    };
    use bazhen_protocol::record::Record;
    use bazhen_protocol::shells::ShellCommand;

    use super::*;
    use crate::events::Actor;
    use crate::testing::TempDir;
    use crate::{AppendError, Store};

    fn locator(generation: &str) -> Record<String> {
        Record::new(
            [
                ("socket", "/run/h.sock"),
                ("holderPid", "10"),
                ("holderStart", "11"),
                ("childPid", "12"),
                ("childStart", "13"),
                ("generation", generation),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect(),
        )
    }

    fn incarnation(generation: &str) -> TerminalIncarnation {
        TerminalIncarnation {
            runtime_ref: RuntimeRefPayload {
                runtime: "holder".to_owned(),
                locator: locator(generation),
            },
        }
    }

    fn change(
        store: &mut Store,
        terminal: &TerminalId,
        change: TerminalChange,
    ) -> Result<u64, AppendError> {
        store.write(|w| {
            w.append(&NewEvent::Terminal {
                terminal: terminal.clone(),
                actor: Actor::User,
                change,
            })
        })
    }

    fn environment(store: &mut Store) -> EnvironmentId {
        store
            .write(|w| -> Result<_, AppendError> { w.local_environment() })
            .unwrap()
    }

    /// A store with one shell opened in the local environment, not yet running.
    fn opened(dir: &TempDir) -> (Store, TerminalId) {
        let mut store = Store::open(&dir.db("terminals.db")).unwrap();
        let terminal = TerminalId::mint(1, [3; 16]);
        let environment = environment(&mut store);
        change(
            &mut store,
            &terminal,
            TerminalChange::Opened(TerminalOpened {
                environment_id: environment,
                cwd: "/home/me".to_owned(),
                linked_agent_id: None,
                theme: None,
                restart_of: None,
                runtime: Some("holder".to_owned()),
            }),
        )
        .unwrap();
        (store, terminal)
    }

    fn payload(store: &Store, id: u64) -> (String, String, String) {
        store
            .db
            .query_row(
                "SELECT type, actor, payload FROM events WHERE id = ?",
                [int(id).unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    #[test]
    fn gives_an_agents_linked_shells_oldest_first_until_each_closes_or_is_unlinked() {
        let dir = TempDir::new("linked");
        let mut store = Store::open(&dir.db("linked.db")).unwrap();
        let environment = environment(&mut store);
        let [agent, other] = [
            "agent_0190a1b2c3d47abc8def0123456789a1",
            "agent_0190a1b2c3d47abc8def0123456789a2",
        ];
        let sessions = [agent, other].map(|id| {
            format!(
                "INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   created_event_id, updated_event_id)
                 VALUES ('{id}', '{}', 'claude-code', 'p', '/repo/{id}', 'running', 1, 1);",
                environment.as_str()
            )
        });
        store.db.execute_batch(&sessions.concat()).unwrap();
        let shells: Vec<TerminalId> = [Some(agent), Some(other), None, Some(agent), Some(agent)]
            .into_iter()
            .enumerate()
            .map(|(n, linked)| {
                let terminal = TerminalId::mint(1, [u8::try_from(n).unwrap() + 10; 16]);
                change(
                    &mut store,
                    &terminal,
                    TerminalChange::Opened(TerminalOpened {
                        environment_id: environment.clone(),
                        cwd: "/w".to_owned(),
                        linked_agent_id: linked.map(|id| AgentId::parse(id).unwrap()),
                        theme: None,
                        restart_of: None,
                        runtime: Some("holder".to_owned()),
                    }),
                )
                .unwrap();
                terminal
            })
            .collect();
        change(&mut store, &shells[3], TerminalChange::Unlinked).unwrap();
        change(
            &mut store,
            &shells[4],
            TerminalChange::Running(incarnation("1")),
        )
        .unwrap();
        change(&mut store, &shells[4], TerminalChange::Closing).unwrap();
        let linked = |store: &Store| -> Vec<TerminalId> {
            store
                .reads()
                .linked_shells(agent)
                .unwrap()
                .into_iter()
                .map(|shell| shell.id)
                .collect()
        };
        let closing = linked(&store);
        change(
            &mut store,
            &shells[4],
            TerminalChange::Closed(TerminalClosed {
                reason: TerminalClosedReason::AgentClosed,
            }),
        )
        .unwrap();
        assert_eq!(
            (
                closing,
                linked(&store),
                store
                    .reads()
                    .shell(shells[3].as_str())
                    .unwrap()
                    .unwrap()
                    .linked_agent_id,
                store.reads().agent_cwd(agent).unwrap(),
                store
                    .reads()
                    .agent_cwd("agent_0190a1b2c3d47abc8def0123456789a3")
                    .unwrap(),
            ),
            (
                vec![shells[0].clone(), shells[4].clone()],
                vec![shells[0].clone()],
                None,
                Some(format!("/repo/{agent}")),
                None,
            )
        );
    }

    #[test]
    fn moves_a_terminal_only_as_the_core_machine_allows_and_names_what_it_refused() {
        use TerminalState::{Closed, Closing, Creating, Exited, Failed, Lost, Running, Unknown};
        assert_eq!(advance(Creating, Step::RuntimeConfirmed), Ok(Running));
        assert_eq!(advance(Creating, Step::RuntimeRejected), Ok(Failed));
        assert_eq!(advance(Exited, Step::Adopted), Ok(Running));
        assert_eq!(advance(Unknown, Step::TargetAbsent), Ok(Lost));
        assert_eq!(advance(Lost, Step::CloseRequested), Ok(Closing));
        assert_eq!(advance(Closing, Step::CloseCompleted), Ok(Closed));
        assert_eq!(
            advance(Running, Step::CloseCompleted),
            Err("terminal cannot handle close.completed while running".to_owned())
        );
        assert!(advance(Closed, Step::CloseRequested).is_err());
        assert!(advance(Lost, Step::Adopted).is_err());
    }

    #[test]
    fn records_a_shell_s_events_as_the_typescript_daemon_writes_them() {
        let dir = TempDir::new("terminal-payloads");
        let (mut store, terminal) = opened(&dir);
        let running = change(
            &mut store,
            &terminal,
            TerminalChange::Running(incarnation("0")),
        )
        .unwrap();
        let renamed = change(
            &mut store,
            &terminal,
            TerminalChange::Renamed(TerminalRenamed {
                name: Some("build".to_owned()),
            }),
        )
        .unwrap();
        let closing = change(&mut store, &terminal, TerminalChange::Closing).unwrap();
        let closed = change(
            &mut store,
            &terminal,
            TerminalChange::Closed(TerminalClosed {
                reason: TerminalClosedReason::User,
            }),
        )
        .unwrap();
        let (kind, actor, opened) = payload(&store, running - 1);
        assert_eq!((kind.as_str(), actor.as_str()), ("terminal.opened", "user"));
        assert!(
            opened.ends_with(r#""cwd":"/home/me","linkedAgentId":null,"runtime":"holder"}"#),
            "{opened}"
        );
        assert_eq!(
            payload(&store, running).2,
            r#"{"runtimeRef":{"runtime":"holder","locator":{"socket":"/run/h.sock","holderPid":"10","holderStart":"11","childPid":"12","childStart":"13","generation":"0"}}}"#
        );
        assert_eq!(payload(&store, renamed).2, r#"{"name":"build"}"#);
        assert_eq!(payload(&store, closing).2, "{}");
        assert_eq!(payload(&store, closed).2, r#"{"reason":"user"}"#);
        let (state, name, updated): (String, String, i64) = store
            .db
            .query_row(
                "SELECT state, name, updated_event_id FROM terminals WHERE id = ?",
                [terminal.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((state.as_str(), name.as_str()), ("closed", "build"));
        assert_eq!(updated, int(closed).unwrap());
    }

    #[test]
    fn reads_a_terminal_s_runtime_once_one_confirmed_it_and_none_for_one_unknown() {
        let dir = TempDir::new("terminal-runtime");
        let (mut store, terminal) = opened(&dir);
        let before = store.reads().runtime_row(terminal.as_str()).unwrap();
        change(
            &mut store,
            &terminal,
            TerminalChange::Running(incarnation("0")),
        )
        .unwrap();
        let after = store.reads().runtime_row(terminal.as_str()).unwrap();
        let unknown = store
            .reads()
            .runtime_row(TerminalId::mint(1, [9; 16]).as_str())
            .unwrap();
        assert_eq!(
            (before, after, unknown),
            (
                None,
                Some(RuntimeRow {
                    runtime: "holder".to_owned(),
                    locator: Some(serde_json::to_string(&locator("0")).unwrap()),
                }),
                None
            )
        );
    }

    #[test]
    fn reads_the_state_of_an_agent_s_terminal_as_of_a_shell_s_and_none_for_one_unknown() {
        let dir = TempDir::new("terminal-state");
        let (mut store, terminal) = opened(&dir);
        let shell = store.reads().terminal_state(terminal.as_str()).unwrap();
        change(
            &mut store,
            &terminal,
            TerminalChange::Running(incarnation("0")),
        )
        .unwrap();
        store
            .db
            .execute("UPDATE terminals SET kind = 'agent'", ())
            .unwrap();
        let agent = store.reads().terminal_state(terminal.as_str()).unwrap();
        let unknown = store
            .reads()
            .terminal_state(TerminalId::mint(1, [9; 16]).as_str())
            .unwrap();
        assert_eq!(
            (shell, agent, unknown),
            (
                Some(TerminalState::Creating),
                Some(TerminalState::Running),
                None
            )
        );
    }

    #[test]
    fn refuses_a_step_the_shell_s_state_cant_take_and_records_nothing_of_it() {
        let dir = TempDir::new("terminal-refused");
        let (mut store, terminal) = opened(&dir);
        let refused = change(
            &mut store,
            &terminal,
            TerminalChange::Closed(TerminalClosed {
                reason: TerminalClosedReason::User,
            }),
        );
        assert!(
            matches!(&refused, Err(AppendError::Refused { reason, .. })
                if reason == "terminal cannot handle close.completed while creating"),
            "{refused:?}"
        );
        let missing = change(
            &mut store,
            &TerminalId::mint(1, [9; 16]),
            TerminalChange::Closing,
        );
        assert!(
            matches!(&missing, Err(AppendError::Refused { reason, .. }) if reason.starts_with("no shell term_")),
            "{missing:?}"
        );
        let events: i64 = store
            .db
            .query_row(
                "SELECT count(*) FROM events WHERE type = 'terminal.closed'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 0);
    }

    #[test]
    fn adopts_a_process_only_at_a_later_generation_than_the_shell_s() {
        let dir = TempDir::new("terminal-adopted");
        let (mut store, terminal) = opened(&dir);
        change(
            &mut store,
            &terminal,
            TerminalChange::Running(incarnation("0")),
        )
        .unwrap();
        let same = change(
            &mut store,
            &terminal,
            TerminalChange::ProcessAdopted(incarnation("0")),
        );
        assert!(matches!(same, Err(AppendError::Refused { .. })), "{same:?}");
        change(
            &mut store,
            &terminal,
            TerminalChange::ProcessAdopted(incarnation("2")),
        )
        .unwrap();
        let shell = store.reads().shell(terminal.as_str()).unwrap().unwrap();
        assert_eq!((shell.state, shell.generation), (TerminalState::Running, 2));
    }

    #[test]
    fn forgets_a_failed_shell_s_command_and_a_lost_one_s_foreground() {
        let dir = TempDir::new("terminal-forgets");
        let (mut store, terminal) = opened(&dir);
        change(
            &mut store,
            &terminal,
            TerminalChange::Running(incarnation("0")),
        )
        .unwrap();
        store
            .db
            .execute(
                "UPDATE terminals SET last_command = 'ls', report_token_hash = 'h'",
                (),
            )
            .unwrap();
        change(
            &mut store,
            &terminal,
            TerminalChange::ForegroundChanged(TerminalForegroundChanged {
                command: Some("vim".to_owned()),
            }),
        )
        .unwrap();
        change(&mut store, &terminal, TerminalChange::Lost).unwrap();
        let (foreground, token, command): (Option<String>, Option<String>, Option<String>) = store
            .db
            .query_row(
                "SELECT foreground, report_token_hash, last_command FROM terminals",
                (),
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (foreground, token, command.as_deref()),
            (None, None, Some("ls"))
        );

        let other = TerminalId::mint(2, [4; 16]);
        let environment = environment(&mut store);
        change(
            &mut store,
            &other,
            TerminalChange::Opened(TerminalOpened {
                environment_id: environment,
                cwd: "/".to_owned(),
                linked_agent_id: None,
                theme: None,
                restart_of: None,
                runtime: None,
            }),
        )
        .unwrap();
        store
            .db
            .execute(
                "UPDATE terminals SET last_command = 'ls' WHERE id = ?",
                [other.as_str()],
            )
            .unwrap();
        change(
            &mut store,
            &other,
            TerminalChange::Failed(TerminalFailed {
                reason: TerminalFailedReason::OpenRejected,
            }),
        )
        .unwrap();
        let (command, kind): (Option<String>, String) = store
            .db
            .query_row(
                "SELECT last_command, runtime_kind FROM terminals WHERE id = ?",
                [other.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((command, kind.as_str()), (None, "tmux"));
    }

    #[test]
    fn registers_the_local_environment_once() {
        let dir = TempDir::new("environment-once");
        let mut store = Store::open(&dir.db("env.db")).unwrap();
        let first = environment(&mut store);
        let second = environment(&mut store);
        assert_eq!(first, second);
        let (count, payload): (i64, String) = store
            .db
            .query_row(
                "SELECT count(*), max(payload) FROM events WHERE type = 'environment.registered'",
                (),
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((count, payload.as_str()), (1, r#"{"kind":"local"}"#));
    }

    #[test]
    fn counts_the_terminals_that_hold_a_pty_and_those_still_opening() {
        let dir = TempDir::new("terminal-counts");
        let (mut store, terminal) = opened(&dir);
        assert_eq!(store.reads().open_terminals().unwrap(), 1);
        assert_eq!(store.reads().starting_terminals().unwrap(), 1);
        change(
            &mut store,
            &terminal,
            TerminalChange::Running(incarnation("0")),
        )
        .unwrap();
        change(&mut store, &terminal, TerminalChange::Lost).unwrap();
        assert_eq!(store.reads().open_terminals().unwrap(), 0);
        assert_eq!(store.reads().starting_terminals().unwrap(), 0);
    }

    #[test]
    fn offers_a_shell_the_commands_its_state_takes_and_attaches_only_on_a_holder_it_serves() {
        let dir = TempDir::new("terminal-snapshot");
        let (mut store, terminal) = opened(&dir);
        let creating = shells(&store.db, &crate::testing::view()).unwrap();
        assert_eq!(creating[0].commands, [ShellCommand::Rename]);
        assert_eq!(creating[0].attach_command, None);
        change(
            &mut store,
            &terminal,
            TerminalChange::Running(incarnation("0")),
        )
        .unwrap();
        change(
            &mut store,
            &terminal,
            TerminalChange::ForegroundChanged(TerminalForegroundChanged {
                command: Some("vim".to_owned()),
            }),
        )
        .unwrap();
        let running = &shells(&store.db, &crate::testing::view()).unwrap()[0];
        assert_eq!(
            running.commands,
            [ShellCommand::Close, ShellCommand::Rename]
        );
        assert_eq!(
            running.attach_command.as_deref(),
            Some(format!("bazhen terminals attach {}", terminal.as_str()).as_str())
        );
        assert_eq!(
            running.foreground.as_ref().map(|f| f.command.as_str()),
            Some("vim")
        );
        assert_eq!(running.theme, TuiTheme::Dark);
        change(
            &mut store,
            &terminal,
            TerminalChange::NeedsRestart(TerminalNeedsRestart {
                protocol: vec!["0.9".to_owned()],
            }),
        )
        .unwrap();
        let unserved = &shells(&store.db, &crate::testing::view()).unwrap()[0];
        assert_eq!(
            unserved.needs_restart,
            Some(NeedsRestart {
                holder_pid: None,
                served: false
            })
        );
        assert_eq!(unserved.attach_command, None);
        change(&mut store, &terminal, TerminalChange::RestartCleared).unwrap();
        change(&mut store, &terminal, TerminalChange::Lost).unwrap();
        let lost = &shells(&store.db, &crate::testing::view()).unwrap()[0];
        assert_eq!(
            lost.commands,
            [
                ShellCommand::Close,
                ShellCommand::Restart,
                ShellCommand::Rename
            ]
        );
        assert_eq!(
            (lost.needs_restart.clone(), lost.attach_command.clone()),
            (None, None)
        );
    }

    /// A store with `count` shells running in the local environment.
    fn running(dir: &TempDir, count: u8) -> (Store, Vec<TerminalId>) {
        let mut store = Store::open(&dir.db("terminals.db")).unwrap();
        let environment = environment(&mut store);
        let terminals: Vec<TerminalId> = (0..count)
            .map(|n| TerminalId::mint(u64::from(n) + 1, [n + 3; 16]))
            .collect();
        for terminal in &terminals {
            change(
                &mut store,
                terminal,
                TerminalChange::Opened(TerminalOpened {
                    environment_id: environment.clone(),
                    cwd: "/home/me".to_owned(),
                    linked_agent_id: None,
                    theme: None,
                    restart_of: None,
                    runtime: Some("holder".to_owned()),
                }),
            )
            .unwrap();
            change(
                &mut store,
                terminal,
                TerminalChange::Running(incarnation("0")),
            )
            .unwrap();
        }
        (store, terminals)
    }

    fn note(store: &mut Store, terminal: &TerminalId, seq: u64, line: Option<&str>) -> bool {
        store
            .write(|w| w.note_shell_command(terminal.as_str(), seq, line))
            .unwrap()
    }

    fn kept(store: &Store, terminal: &TerminalId) -> Option<String> {
        store.reads().last_shell_command(terminal.as_str()).unwrap()
    }

    fn closed(store: &mut Store, terminal: &TerminalId) {
        change(store, terminal, TerminalChange::Closing).unwrap();
        change(
            store,
            terminal,
            TerminalChange::Closed(TerminalClosed {
                reason: TerminalClosedReason::User,
            }),
        )
        .unwrap();
    }

    #[test]
    fn keeps_the_newest_line_a_live_shell_reported_so_a_late_older_report_changes_nothing() {
        let dir = TempDir::new("shell-line-newest");
        let (mut store, terminals) = running(&dir, 1);
        let shell = &terminals[0];
        let counted = [
            note(&mut store, shell, 2, Some("moon run :dev")),
            note(&mut store, shell, 1, Some("ls")),
            note(&mut store, shell, 2, Some("ls")),
        ];
        assert_eq!(
            (counted, kept(&store, shell).as_deref()),
            ([true, false, false], Some("moon run :dev"))
        );
    }

    #[test]
    fn clears_the_kept_line_when_a_newer_one_cant_be_typed_back_rather_than_keep_the_older() {
        let dir = TempDir::new("shell-line-clears");
        let (mut store, terminals) = running(&dir, 1);
        let shell = &terminals[0];
        note(&mut store, shell, 1, Some("moon run :dev"));
        note(&mut store, shell, 2, Some("make\nrm -rf ~"));
        let after_newline = kept(&store, shell);
        note(&mut store, shell, 3, Some("moon run :dev"));
        note(&mut store, shell, 4, None);
        assert_eq!((after_newline, kept(&store, shell)), (None, None));
    }

    #[test]
    fn keeps_a_lost_shell_s_line_for_its_restart_and_takes_no_report_for_it() {
        let dir = TempDir::new("shell-line-lost");
        let (mut store, terminals) = running(&dir, 1);
        let shell = &terminals[0];
        note(&mut store, shell, 1, Some("cargo watch"));
        change(&mut store, shell, TerminalChange::Lost).unwrap();
        let counted = note(&mut store, shell, 2, Some("ls"));
        assert_eq!(
            (counted, kept(&store, shell).as_deref()),
            (false, Some("cargo watch"))
        );
    }

    #[test]
    fn keeps_a_shell_s_token_hash_and_answers_none_for_another_kind_or_no_terminal() {
        let dir = TempDir::new("shell-token");
        let (mut store, terminals) = running(&dir, 1);
        let shell = &terminals[0];
        let before = store.reads().shell_token_hash(shell.as_str()).unwrap();
        store
            .write(|w| w.note_shell_token(shell.as_str(), "hash"))
            .unwrap();
        store
            .write(|w| w.note_shell_token("term_none", "hash"))
            .unwrap();
        assert_eq!(
            (
                before,
                store.reads().shell_token_hash(shell.as_str()).unwrap(),
                store.reads().shell_token_hash("term_none").unwrap()
            ),
            (None, Some("hash".to_owned()), None)
        );
    }

    #[test]
    fn forgets_the_line_once_the_shell_closes_or_fails_and_never_writes_it_into_an_event() {
        let dir = TempDir::new("shell-line-forgets");
        let (mut store, terminals) = running(&dir, 2);
        let (closing, failing) = (&terminals[0], &terminals[1]);
        note(&mut store, closing, 1, Some("export TOKEN=s3cret-closed"));
        note(&mut store, failing, 1, Some("export TOKEN=s3cret-failed"));
        closed(&mut store, closing);
        store
            .db
            .execute(
                "UPDATE terminals SET state = 'creating' WHERE id = ?",
                [failing.as_str()],
            )
            .unwrap();
        change(
            &mut store,
            failing,
            TerminalChange::Failed(TerminalFailed {
                reason: TerminalFailedReason::OpenRejected,
            }),
        )
        .unwrap();
        let in_events: i64 = store
            .db
            .query_row(
                "SELECT count(*) FROM events WHERE payload LIKE '%s3cret%'",
                (),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            (kept(&store, closing), kept(&store, failing), in_events),
            (None, None, 0)
        );
    }

    /// Whether `needle` is anywhere in the database's file or its journal.
    fn on_disk(dir: &TempDir, needle: &[u8]) -> [bool; 2] {
        ["terminals.db", "terminals.db-wal"].map(|name| {
            std::fs::read(dir.db(name))
                .unwrap_or_default()
                .windows(needle.len())
                .any(|w| w == needle)
        })
    }

    #[test]
    fn leaves_no_trace_of_a_closed_shell_s_line_in_the_database_or_its_journal() {
        let dir = TempDir::new("shell-line-disk");
        // Rows after it on the same page keep a cleared row's old bytes where they stood, unzeroed.
        let (mut store, terminals) = running(&dir, 3);
        note(
            &mut store,
            &terminals[0],
            1,
            Some("export TOKEN=s3cret-on-disk"),
        );
        let before = on_disk(&dir, b"s3cret");
        closed(&mut store, &terminals[0]);
        assert_eq!(
            (before.contains(&true), on_disk(&dir, b"s3cret")),
            (true, [false, false])
        );
    }

    #[test]
    fn forgets_every_shell_s_line_and_token_and_scrubs_them_from_the_journal() {
        let dir = TempDir::new("shell-line-off");
        let (mut store, terminals) = running(&dir, 3);
        note(
            &mut store,
            &terminals[0],
            1,
            Some("export TOKEN=s3cret-off"),
        );
        store
            .write(|w| w.note_shell_token(terminals[1].as_str(), "hash"))
            .unwrap();
        store
            .write(|w: &Writer<'_>| w.forget_shell_commands())
            .unwrap();
        let reported = note(&mut store, &terminals[0], 2, Some("ls"));
        let reads = store.reads();
        assert_eq!(
            (
                reads.shell_token_hash(terminals[1].as_str()).unwrap(),
                on_disk(&dir, b"s3cret"),
                reported,
            ),
            (None, [false, false], true)
        );
    }

    #[test]
    fn offers_a_lost_shell_s_line_back_only_while_shells_report() {
        let dir = TempDir::new("shell-retypeable");
        let (mut store, terminals) = running(&dir, 2);
        note(&mut store, &terminals[0], 1, Some("make"));
        let reporting = SnapshotView {
            shells_report: true,
            ..crate::testing::view()
        };
        let live = shells(&store.db, &reporting).unwrap();
        for terminal in &terminals {
            change(&mut store, terminal, TerminalChange::Lost).unwrap();
        }
        let retypeable = |view: &SnapshotView| -> Vec<bool> {
            shells(&store.db, view)
                .unwrap()
                .iter()
                .map(|s| s.retypeable)
                .collect()
        };
        assert_eq!(
            (
                live[0].retypeable,
                retypeable(&reporting),
                retypeable(&crate::testing::view())
            ),
            (false, vec![true, false], vec![false, false])
        );
    }
}
