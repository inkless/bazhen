import type { DatabaseSync } from "node:sqlite";
import hostEventsTerminals from "./migrations/2026-11-01-host-events-terminals.ts";
import agentSessions from "./migrations/2026-11-11-agent-sessions.ts";
import attachmentsAndLeases from "./migrations/2026-11-11-attachments-and-leases.ts";
import mailboxAndAttention from "./migrations/2026-11-12-mailbox-and-attention.ts";
import mailboxFirstOffered from "./migrations/2026-11-12-mailbox-first-offered.ts";
import eventLogEpoch from "./migrations/2026-11-12-event-log-epoch.ts";
import terminalExit from "./migrations/2026-11-12-terminal-exit.ts";
import harnessVersions from "./migrations/2026-11-12-harness-versions.ts";
import activityLatest from "./migrations/2026-11-12-activity-latest.ts";
import mailboxFailures from "./migrations/2026-11-12-mailbox-failures.ts";
import terminalTheme from "./migrations/2026-11-12-terminal-theme.ts";
import agentUsage from "./migrations/2026-11-12-agent-usage.ts";
import shellTerminals from "./migrations/2026-11-12-shell-terminals.ts";
import attentionKinds from "./migrations/2026-11-12-attention-kinds.ts";
import shellNames from "./migrations/2026-11-13-shell-names.ts";
import tasksAndAssignments from "./migrations/2026-11-13-tasks-and-assignments.ts";
import devices from "./migrations/2026-11-13-devices.ts";
import shellForeground from "./migrations/2026-11-13-shell-foreground.ts";
import taskDelegatedFrom from "./migrations/2026-11-13-task-delegated-from.ts";
import agentTranscript from "./migrations/2026-11-13-agent-transcript.ts";
import agentLaunchedBy from "./migrations/2026-11-13-agent-launched-by.ts";
import notices from "./migrations/2026-11-15-notices.ts";
import shellLastCommand from "./migrations/2026-11-15-shell-last-command.ts";
import agentNames from "./migrations/2026-11-15-agent-names.ts";
import observedMessages from "./migrations/2026-11-15-observed-messages.ts";
import taskNotes from "./migrations/2026-11-15-task-notes.ts";
import terminalRuntimeKind from "./migrations/2026-11-15-terminal-runtime-kind.ts";
import terminalRestartProtocol from "./migrations/2026-11-15-terminal-restart-protocol.ts";
import agentTokens from "./migrations/2026-11-16-agent-tokens.ts";
import agentRoles from "./migrations/2026-11-16-agent-roles.ts";
import agentCompactWindow from "./migrations/2026-11-18-agent-compact-window.ts";

export interface Migration {
  /** `YYYY-MM-DD-slug`, the day it was written, and its file's name in `migrations/`. */
  readonly name: string;
  readonly sql: string;
  /** What SQL can't say, run after `sql` in the same transaction. */
  readonly run?: (db: DatabaseSync) => void;
}

/**
 * A database runs each migration it hasn't recorded, in this order. So a migration may build only
 * on those already here when it was written, and two written in parallel must not depend on each
 * other: either may run first. When two appended at once conflict, keep both.
 *
 * A migration here is never edited, renamed or removed (`pnpm check` holds it): it has run on
 * users' databases, and changing it forks their schema from new installs. Add one instead, with a
 * medium test that upgrades a database from the one before.
 */
export const MIGRATIONS: readonly Migration[] = [
  hostEventsTerminals,
  agentSessions,
  attachmentsAndLeases,
  mailboxAndAttention,
  mailboxFirstOffered,
  eventLogEpoch,
  terminalExit,
  harnessVersions,
  activityLatest,
  mailboxFailures,
  terminalTheme,
  agentUsage,
  shellTerminals,
  attentionKinds,
  shellNames,
  tasksAndAssignments,
  devices,
  shellForeground,
  taskDelegatedFrom,
  agentTranscript,
  agentLaunchedBy,
  notices,
  shellLastCommand,
  agentNames,
  observedMessages,
  taskNotes,
  terminalRuntimeKind,
  terminalRestartProtocol,
  agentTokens,
  agentRoles,
  agentCompactWindow,
];

/**
 * The migrations the runner that numbered them knew, in its order: a database it left at version n
 * has run the first n. `MIGRATIONS` starts with these, in this order (`pnpm check` holds it).
 */
export const NUMBERED_MIGRATIONS: readonly string[] = [
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
