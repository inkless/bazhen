//! The agents and the items for the human of `/v1/state`, as the TypeScript store reads them:
//! each agent with what its terminal, harness and latest note say of it, and each item with what
//! the human can do about it now.

use std::collections::HashMap;

use bazhen_core::agent::offered_commands;
use bazhen_protocol::agents::{
    Activity, ActivityValue, Agent, AgentState, ExitStatus, ExternalRef, HarnessId, Headline, Usage,
};
use bazhen_protocol::ids::{AgentId, AttentionId};
use bazhen_protocol::mail::{Attention, AttentionAction, AttentionKind, AttentionState};
use bazhen_protocol::names::Role;
use bazhen_protocol::shells::{TerminalState, TuiTheme};
use serde::de::DeserializeOwned;
use unicode_segmentation::UnicodeSegmentation as _;

use crate::SnapshotView;
use crate::agents::word;
use crate::snapshot::SnapshotError;
use crate::terminals::{attach_command, attachable, needs_restart};

/// How many graphemes of a note's first line a headline keeps: one line of a list.
const HEADLINE_MAX: usize = 200;

/// What the snapshot of agents needs of the daemon, which the database doesn't hold: what each
/// harness can do, whether mail reaches an agent now, and the prompt it would start with.
pub trait AgentView {
    /// Whether starting the agent again resumes its harness session.
    fn resumes(&self, evidence: &Evidence<'_>) -> bool;
    /// The themes `harness` can start its TUI in.
    fn themes(&self, harness: HarnessId) -> Vec<TuiTheme>;
    /// Whether mail sent to a running agent reaches it now with nothing else happening.
    fn listening(&self, agent: &Listener<'_>) -> bool;
    /// The hash of the prompt an agent launched in `role` would start with now.
    fn prompt_hash(&self, role: Option<&Role>) -> String;
}

/// What the snapshot of the items for the human needs of the daemon: what the human can do about
/// each open one now, which rests on what the daemon holds of it, such as a harness waiting on an
/// approval.
pub trait AttentionView {
    /// What the human can do about an open item now.
    fn attention_actions(&self, item: &OpenAttention<'_>) -> Vec<AttentionAction>;
}

/// What says whether an agent's harness session can be resumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Evidence<'a> {
    pub harness: HarnessId,
    pub external_ref: Option<&'a ExternalRef>,
    pub transcript: Option<&'a str>,
}

/// A running agent, as whether it is listening is judged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Listener<'a> {
    pub id: &'a AgentId,
    pub harness: HarnessId,
    pub activity: Option<ActivityValue>,
}

/// An open item for the human, as what they can do about it is judged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenAttention<'a> {
    pub id: &'a AttentionId,
    pub agent_id: &'a AgentId,
    pub kind: &'a AttentionKind,
    pub tool_use_id: Option<&'a str>,
    /// Asked by the agent itself rather than by a subagent.
    pub main_agent: bool,
    /// The message it is about, for mail that could not be delivered.
    pub message_id: Option<&'a str>,
    /// The task it is about, for an escalation or a task done.
    pub task_id: Option<&'a str>,
}

/// An agent's row and its terminal's, as one query reads them.
struct AgentRow {
    id: String,
    name: String,
    environment: String,
    harness: String,
    project: String,
    cwd: String,
    state: String,
    launched_by: Option<String>,
    role: Option<String>,
    prompt_hash: Option<String>,
    terminal_id: Option<String>,
    generation: Option<u64>,
    external_ref: Option<String>,
    exit: Option<String>,
    theme: String,
    activity: Option<String>,
    usage: Option<String>,
    terminal_state: Option<String>,
    runtime: Option<String>,
    transcript: Option<String>,
    restart_protocol: Option<String>,
    note: Option<(String, String, String)>,
    start_requested_at: Option<String>,
}

/// Every agent, oldest first.
pub(crate) fn agents(
    db: &rusqlite::Connection,
    view: &SnapshotView,
    agents: &dyn AgentView,
) -> Result<Vec<Agent>, SnapshotError> {
    let mut statement = db.prepare(
        "SELECT a.id, coalesce(a.name, ''), a.environment_id, a.harness, a.project, a.cwd, a.state,
           a.launched_by, a.role, a.prompt_hash, a.terminal_id, t.generation, a.external_ref,
           t.exit, coalesce(t.theme, 'dark'), s.activity, a.usage, t.state, t.runtime,
           a.transcript, t.restart_protocol, n.text, n.task_id, ne.ts,
           (SELECT ts FROM events WHERE id = (
              SELECT max(id) FROM events WHERE entity_type = 'agent' AND entity_id = a.id
                AND type IN ('agent.launched', 'agent.respawn_requested',
                             'agent.relaunch_requested')))
         FROM agent_sessions a LEFT JOIN terminals t ON t.id = a.terminal_id
         LEFT JOIN activity_latest s ON s.agent_session_id = a.id
         LEFT JOIN task_notes n ON n.event_id = (
           SELECT max(event_id) FROM task_notes WHERE agent_session_id = a.id)
         LEFT JOIN events ne ON ne.id = n.event_id
         ORDER BY a.created_event_id",
    )?;
    let rows = statement
        .query_map((), |row| {
            let note = match row.get::<_, Option<String>>(21)? {
                Some(text) => Some((text, row.get(22)?, row.get(23)?)),
                None => None,
            };
            Ok(AgentRow {
                id: row.get(0)?,
                name: row.get(1)?,
                environment: row.get(2)?,
                harness: row.get(3)?,
                project: row.get(4)?,
                cwd: row.get(5)?,
                state: row.get(6)?,
                launched_by: row.get(7)?,
                role: row.get(8)?,
                prompt_hash: row.get(9)?,
                terminal_id: row.get(10)?,
                generation: row
                    .get::<_, Option<i64>>(11)?
                    .map(|n| {
                        u64::try_from(n).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                11,
                                rusqlite::types::Type::Integer,
                                Box::new(e),
                            )
                        })
                    })
                    .transpose()?,
                external_ref: row.get(12)?,
                exit: row.get(13)?,
                theme: row.get(14)?,
                activity: row.get(15)?,
                usage: row.get(16)?,
                terminal_state: row.get(17)?,
                runtime: row.get(18)?,
                transcript: row.get(19)?,
                restart_protocol: row.get(20)?,
                note,
                start_requested_at: row.get(24)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Composed once a snapshot for each role, however many agents were launched in it.
    let mut hashes: HashMap<Option<Role>, String> = HashMap::new();
    rows.into_iter()
        .map(|row| agent(row, view, agents, &mut hashes))
        .collect()
}

fn agent(
    row: AgentRow,
    view: &SnapshotView,
    agents: &dyn AgentView,
    hashes: &mut HashMap<Option<Role>, String>,
) -> Result<Agent, SnapshotError> {
    let state: AgentState = word(row.state)?;
    let harness: HarnessId = word(row.harness)?;
    let role: Option<Role> = row.role.map(word).transpose()?;
    let terminal_state: Option<TerminalState> = row.terminal_state.map(word).transpose()?;
    let generation = row.generation;
    let external_ref: Option<ExternalRef> = json(row.external_ref.as_deref())?;
    let activity: Option<Activity> = json(row.activity.as_deref())?;
    let usage: Option<Usage> = json(row.usage.as_deref())?;
    let exit: Option<ExitStatus> = json(row.exit.as_deref())?;
    let evidence = Evidence {
        harness,
        external_ref: external_ref.as_ref(),
        transcript: row.transcript.as_deref(),
    };
    let restart = match (terminal_state, row.terminal_id.as_deref()) {
        (Some(terminal), Some(terminal_id)) => needs_restart(
            row.restart_protocol.as_deref(),
            terminal,
            view.restart_holders.get(terminal_id).copied(),
        ),
        _ => None,
    };
    let attach =
        terminal_state.is_some_and(attachable) && restart.as_ref().is_none_or(|r| r.served);
    let attach_command = match row.terminal_id.as_deref() {
        Some(terminal_id) if attach => attach_command(row.runtime.as_deref(), terminal_id),
        _ => None,
    };
    let id: AgentId = word(row.id)?;
    let listening = state == AgentState::Running
        && agents.listening(&Listener {
            id: &id,
            harness,
            activity: activity.as_ref().map(|a| a.value),
        });
    // An ended agent starts no more, and one from before hashes has none to differ.
    let prompt_changed = !matches!(state, AgentState::Closed | AgentState::Failed)
        && row.prompt_hash.is_some_and(|stored| {
            let now = hashes
                .entry(role.clone())
                .or_insert_with(|| agents.prompt_hash(role.as_ref()));
            *now != stored
        });
    let headline = row
        .note
        .map(|(text, task, at)| {
            Ok::<_, SnapshotError>(Headline {
                text: headline(&text),
                task_id: word(task)?,
                at,
            })
        })
        .transpose()?;
    // A start not yet answered: the request is the last thing its terminal saw.
    let start_requested_at = row.start_requested_at.filter(|_| {
        state == AgentState::Starting
            && matches!(
                terminal_state,
                Some(TerminalState::Creating | TerminalState::Exited)
            )
    });
    Ok(Agent {
        name: row.name,
        environment_id: word(row.environment)?,
        harness,
        project: row.project,
        cwd: row.cwd,
        state,
        terminal_id: row.terminal_id.map(word).transpose()?,
        generation,
        exit,
        theme: word(row.theme)?,
        themes: agents.themes(harness),
        activity,
        usage,
        attach_command,
        commands: offered_commands(state, terminal_state, generation, || {
            agents.resumes(&evidence)
        }),
        resumable: agents.resumes(&evidence),
        can_open_shell: matches!(
            state,
            AgentState::Starting | AgentState::Running | AgentState::Exited
        ),
        launched_by: row.launched_by.map(word).transpose()?,
        listening,
        headline,
        needs_restart: restart,
        role,
        prompt_changed,
        start_requested_at,
        external_ref,
        id,
    })
}

/// A note as a headline: its first line, cut to one line of a list between two graphemes.
fn headline(text: &str) -> String {
    text.split('\n')
        .next()
        .unwrap_or_default()
        .graphemes(true)
        .take(HEADLINE_MAX)
        .collect()
}

/// An item's row, as one query reads it.
struct AttentionRow {
    id: String,
    agent_id: String,
    state: String,
    close_reason: Option<String>,
    summary: String,
    kind: String,
    task_id: Option<String>,
    message_id: Option<String>,
    tool_use_id: Option<String>,
    main_agent: bool,
    opened_at: String,
}

/// Every item for the human, oldest first, each open one with what the human can do about it.
pub(crate) fn attention(
    db: &rusqlite::Connection,
    view: &dyn AttentionView,
) -> Result<Vec<Attention>, SnapshotError> {
    let mut statement = db.prepare(
        "SELECT i.id, i.agent_session_id, i.state, i.close_reason, i.summary, i.kind, i.task_id,
           i.message_id, i.tool_use_id, i.main_agent = 1, e.ts
         FROM attention_items i JOIN events e ON e.id = i.created_event_id
         ORDER BY i.created_event_id",
    )?;
    let rows = statement
        .query_map((), |row| {
            Ok(AttentionRow {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                state: row.get(2)?,
                close_reason: row.get(3)?,
                summary: row.get(4)?,
                kind: row.get(5)?,
                task_id: row.get(6)?,
                message_id: row.get(7)?,
                tool_use_id: row.get(8)?,
                main_agent: row.get(9)?,
                opened_at: row.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|row| item(row, view)).collect()
}

fn item(row: AttentionRow, view: &dyn AttentionView) -> Result<Attention, SnapshotError> {
    let id: AttentionId = word(row.id)?;
    let agent_id: AgentId = word(row.agent_id)?;
    let state: AttentionState = word(row.state)?;
    let kind: AttentionKind = word(row.kind)?;
    let actions = if state == AttentionState::Open {
        view.attention_actions(&OpenAttention {
            id: &id,
            agent_id: &agent_id,
            kind: &kind,
            tool_use_id: row.tool_use_id.as_deref(),
            main_agent: row.main_agent,
            message_id: row.message_id.as_deref(),
            task_id: row.task_id.as_deref(),
        })
    } else {
        Vec::new()
    };
    Ok(Attention {
        close_reason: row.close_reason.map(word).transpose()?,
        message_id: row.message_id.map(word).transpose()?,
        id,
        agent_id,
        state,
        summary: row.summary,
        kind,
        task_id: row.task_id,
        opened_at: row.opened_at,
        actions,
    })
}

/// A stored JSON column, or none where it is null.
fn json<T: DeserializeOwned>(text: Option<&str>) -> Result<Option<T>, SnapshotError> {
    Ok(text.map(serde_json::from_str).transpose()?)
}

#[cfg(test)]
mod tests {
    use super::headline;

    #[test]
    fn makes_a_note_a_headline_of_its_first_line_cut_at_200_graphemes() {
        let accented = "e\u{301}".repeat(205);
        assert_eq!(
            headline(&format!("{accented}\nmore")),
            "e\u{301}".repeat(200)
        );
        assert_eq!(headline("one\r\ntwo"), "one\r");
        assert_eq!(headline(""), "");
        assert_eq!(headline("\nsecond"), "");
    }
}
