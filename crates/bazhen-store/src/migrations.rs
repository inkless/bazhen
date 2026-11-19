//! Every migration, in the order a database runs them: each name and SQL copied byte for byte from
//! `apps/daemon/src/store/migrations/`, and its code ported, so both daemons give one database one
//! schema. `tests/fixture.rs` holds them to what the TypeScript daemon runs.

use std::collections::BTreeMap;

use rusqlite::Connection;

/// One step of the schema.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// `YYYY-MM-DD-slug`, the day it was written.
    pub name: &'static str,
    pub sql: &'static str,
    /// What SQL can't say, run after `sql` in the same transaction.
    pub run: Option<fn(&Connection) -> rusqlite::Result<()>>,
}

/// A migration that is SQL only.
const fn sql(name: &'static str, sql: &'static str) -> Migration {
    Migration {
        name,
        sql,
        run: None,
    }
}

/// A database runs each migration it hasn't recorded, in this order. One is never edited,
/// renamed or removed: it has run on users' databases.
pub const MIGRATIONS: &[Migration] = &[
    sql(
        "2026-11-01-host-events-terminals",
        include_str!("migrations/2026-11-01-host-events-terminals.sql"),
    ),
    sql(
        "2026-11-11-agent-sessions",
        include_str!("migrations/2026-11-11-agent-sessions.sql"),
    ),
    sql(
        "2026-11-11-attachments-and-leases",
        include_str!("migrations/2026-11-11-attachments-and-leases.sql"),
    ),
    sql(
        "2026-11-12-mailbox-and-attention",
        include_str!("migrations/2026-11-12-mailbox-and-attention.sql"),
    ),
    sql(
        "2026-11-12-mailbox-first-offered",
        include_str!("migrations/2026-11-12-mailbox-first-offered.sql"),
    ),
    sql(
        "2026-11-12-event-log-epoch",
        include_str!("migrations/2026-11-12-event-log-epoch.sql"),
    ),
    sql(
        "2026-11-12-terminal-exit",
        include_str!("migrations/2026-11-12-terminal-exit.sql"),
    ),
    sql(
        "2026-11-12-harness-versions",
        include_str!("migrations/2026-11-12-harness-versions.sql"),
    ),
    sql(
        "2026-11-12-activity-latest",
        include_str!("migrations/2026-11-12-activity-latest.sql"),
    ),
    sql(
        "2026-11-12-mailbox-failures",
        include_str!("migrations/2026-11-12-mailbox-failures.sql"),
    ),
    sql(
        "2026-11-12-terminal-theme",
        include_str!("migrations/2026-11-12-terminal-theme.sql"),
    ),
    sql(
        "2026-11-12-agent-usage",
        include_str!("migrations/2026-11-12-agent-usage.sql"),
    ),
    sql(
        "2026-11-12-shell-terminals",
        include_str!("migrations/2026-11-12-shell-terminals.sql"),
    ),
    sql(
        "2026-11-12-attention-kinds",
        include_str!("migrations/2026-11-12-attention-kinds.sql"),
    ),
    sql(
        "2026-11-13-shell-names",
        include_str!("migrations/2026-11-13-shell-names.sql"),
    ),
    sql(
        "2026-11-13-tasks-and-assignments",
        include_str!("migrations/2026-11-13-tasks-and-assignments.sql"),
    ),
    sql(
        "2026-11-13-devices",
        include_str!("migrations/2026-11-13-devices.sql"),
    ),
    sql(
        "2026-11-13-shell-foreground",
        include_str!("migrations/2026-11-13-shell-foreground.sql"),
    ),
    sql(
        "2026-11-13-task-delegated-from",
        include_str!("migrations/2026-11-13-task-delegated-from.sql"),
    ),
    sql(
        "2026-11-13-agent-transcript",
        include_str!("migrations/2026-11-13-agent-transcript.sql"),
    ),
    sql(
        "2026-11-13-agent-launched-by",
        include_str!("migrations/2026-11-13-agent-launched-by.sql"),
    ),
    sql(
        "2026-11-15-notices",
        include_str!("migrations/2026-11-15-notices.sql"),
    ),
    sql(
        "2026-11-15-shell-last-command",
        include_str!("migrations/2026-11-15-shell-last-command.sql"),
    ),
    Migration {
        run: Some(name_every_agent),
        ..sql(
            "2026-11-15-agent-names",
            include_str!("migrations/2026-11-15-agent-names.sql"),
        )
    },
    sql(
        "2026-11-15-observed-messages",
        include_str!("migrations/2026-11-15-observed-messages.sql"),
    ),
    sql(
        "2026-11-15-task-notes",
        include_str!("migrations/2026-11-15-task-notes.sql"),
    ),
    sql(
        "2026-11-15-terminal-runtime-kind",
        include_str!("migrations/2026-11-15-terminal-runtime-kind.sql"),
    ),
    sql(
        "2026-11-15-terminal-restart-protocol",
        include_str!("migrations/2026-11-15-terminal-restart-protocol.sql"),
    ),
    sql(
        "2026-11-16-agent-tokens",
        include_str!("migrations/2026-11-16-agent-tokens.sql"),
    ),
    sql(
        "2026-11-16-agent-roles",
        include_str!("migrations/2026-11-16-agent-roles.sql"),
    ),
    sql(
        "2026-11-18-agent-compact-window",
        include_str!("migrations/2026-11-18-agent-compact-window.sql"),
    ),
    sql(
        "2026-11-18-mailbox-sender-and-settled",
        include_str!("migrations/2026-11-18-mailbox-sender-and-settled.sql"),
    ),
];

/// The migrations the runner that numbered them knew, in its order: a database it left at version
/// n has run the first n.
pub const NUMBERED_MIGRATIONS: &[&str] = &[
    "2026-11-01-host-events-terminals",
    "2026-11-11-agent-sessions",
    "2026-11-11-attachments-and-leases",
    "2026-11-12-mailbox-and-attention",
    "2026-11-12-mailbox-first-offered",
    "2026-11-12-event-log-epoch",
    "2026-11-12-terminal-exit",
    "2026-11-12-harness-versions",
    "2026-11-12-activity-latest",
    "2026-11-12-mailbox-failures",
    "2026-11-12-terminal-theme",
    "2026-11-12-agent-usage",
    "2026-11-12-shell-terminals",
    "2026-11-12-attention-kinds",
    "2026-11-13-shell-names",
    "2026-11-13-tasks-and-assignments",
    "2026-11-13-devices",
    "2026-11-13-shell-foreground",
    "2026-11-13-task-delegated-from",
    "2026-11-13-agent-transcript",
    "2026-11-13-agent-launched-by",
    "2026-11-15-notices",
    "2026-11-15-shell-last-command",
    "2026-11-15-agent-names",
    "2026-11-15-observed-messages",
    "2026-11-15-task-notes",
    "2026-11-15-terminal-runtime-kind",
    "2026-11-15-terminal-restart-protocol",
    "2026-11-16-agent-tokens",
    "2026-11-16-agent-roles",
];

/// `nameBase` as `2026-11-15-agent-names` ran it, frozen so a later change to the live one can't
/// name a database upgraded after it differently from one upgraded before: each run of anything
/// but `[A-Za-z0-9_-]` becomes `-`, then `-` and `_` are trimmed from the ends, before and after
/// cutting it to 32.
fn base_at_24(project: &str) -> String {
    let mut cleaned = String::with_capacity(project.len());
    let mut in_run = false;
    for c in project.chars() {
        let kept = c.is_ascii_alphanumeric() || c == '_' || c == '-';
        if kept {
            cleaned.push(c);
        } else if !in_run {
            cleaned.push('-');
        }
        in_run = !kept;
    }
    let trim = |s: &str| s.trim_matches(['-', '_']).to_owned();
    let trimmed = trim(&cleaned);
    // Only ASCII is left, so 32 bytes are the 32 UTF-16 units JavaScript's slice takes.
    let base = trim(trimmed.get(..32).unwrap_or(&trimmed));
    if base.is_empty() {
        "agent".to_owned()
    } else {
        base
    }
}

/// Gives each agent, ended ones too, its project's default name, numbered in launch order, and
/// records the last number each base took.
fn name_every_agent(db: &Connection) -> rusqlite::Result<()> {
    let agents: Vec<(String, String)> = db
        .prepare("SELECT id, project FROM agent_sessions ORDER BY created_event_id")?
        .query_map((), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    // By the base's lower case, as the counters' NOCASE key folds it: the first spelling, which the
    // counter keeps, and the last number taken. Each agent is named by its own spelling.
    let mut last: BTreeMap<String, (String, i64)> = BTreeMap::new();
    let mut rename = db.prepare("UPDATE agent_sessions SET name = ? WHERE id = ?")?;
    for (id, project) in agents {
        let base = base_at_24(&project);
        let (_, n) = last
            .entry(base.to_ascii_lowercase())
            .or_insert_with(|| (base.clone(), 0));
        *n += 1;
        rename.execute((format!("{base}-{n}"), id))?;
    }
    let mut count = db.prepare("INSERT INTO agent_name_counters (base, last) VALUES (?, ?)")?;
    for (base, n) in last.values() {
        count.execute((base, n))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_is_the_project_cleaned_trimmed_and_cut_to_32_or_agent() {
        let cases = [
            ("my project!", "my-project"),
            ("--__--", "agent"),
            ("", "agent"),
            ("ünïcödé", "n-c-d"),
            ("a\u{1f600}\u{1f600}b", "a-b"),
            ("_x_", "x"),
            (
                "abcdefghijklmnopqrstuvwxyz01234-_x",
                "abcdefghijklmnopqrstuvwxyz01234",
            ),
            (&"q".repeat(40), &"q".repeat(32)),
        ];
        for (project, base) in cases {
            assert_eq!(base_at_24(project), base, "{project:?}");
        }
    }
}
