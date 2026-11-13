import type { SQLInputValue, StatementSync } from "node:sqlite";
import {
  advanceTerminal,
  agent,
  assignment,
  attention,
  mailbox,
  task,
  type AgentEvent,
  type MailboxEvent,
  type TerminalEvent,
} from "@bazhen/core";
import {
  AgentState,
  AssignmentState,
  AttentionCloseReason,
  AttentionState,
  EVENTS,
  MailboxState,
  TaskState,
  TerminalState,
  type AssignmentEndReason,
  type EventType,
} from "@bazhen/protocol";

/** Prepares a statement once and reuses it: the store runs on the loop every hook waits on. */
export type Statements = { prepare(sql: string): StatementSync };

/** An event about an entity the read models don't hold. */
export class UnknownEntity extends Error {
  readonly id: string;

  constructor(kind: string, id: string) {
    super(`no ${kind} ${id}`);
    this.id = id;
  }
}

/** An event as written, with its id and the installation that wrote it. */
export interface Recorded {
  readonly id: number;
  readonly hostId: string;
  readonly type: EventType;
  readonly entityId: string;
  readonly payload: unknown;
}

/**
 * Applies one event to the read models, inside the transaction that records it. Lifecycle
 * changes go through core's state tables, so an event the current state can't take is refused
 * and nothing is written.
 */
export function project(db: Statements, e: Recorded): void {
  switch (e.type) {
    case "environment.registered": {
      const { kind } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare("INSERT INTO environments (id, kind, created_event_id) VALUES (?, ?, ?)").run(
        e.entityId,
        kind,
        e.id,
      );
      return;
    }
    case "environment.harness_version": {
      const { harness, version } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO harness_versions (environment_id, harness, version, updated_event_id)
           VALUES (?, ?, ?, ?)
         ON CONFLICT (environment_id, harness)
           DO UPDATE SET version = excluded.version, updated_event_id = excluded.updated_event_id`,
      ).run(e.entityId, harness, version, e.id);
      return;
    }
    case "agent.launched": {
      const {
        environmentId,
        harness,
        project: name,
        cwd,
        terminalId,
      } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO agent_sessions
           (id, environment_id, harness, project, cwd, state, terminal_id, created_event_id, updated_event_id)
         VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
      ).run(e.entityId, environmentId, harness, name, cwd, terminalId, e.id, e.id);
      if (terminalId === null) return;
      db.prepare(
        `INSERT INTO terminals
           (id, host_id, state, generation, runtime, locator, environment_id, kind, agent_session_id,
            created_event_id, updated_event_id)
         VALUES (?, ?, 'creating', 0, NULL, NULL, ?, 'agent', ?, ?, ?)`,
      ).run(terminalId, e.hostId, environmentId, e.entityId, e.id, e.id);
      return;
    }
    case "agent.running": {
      const { externalRef, runtimeRef, theme } = EVENTS[e.type].payload.parse(e.payload);
      advance(db, e.id, e.entityId, ["launch.confirmed", "runtime.confirmed"], {
        agent: { external_ref: externalRef && JSON.stringify(externalRef) },
        ...(runtimeRef && { terminal: { ...incarnation(runtimeRef), theme: theme ?? null } }),
      });
      return;
    }
    case "agent.failed":
      advance(db, e.id, e.entityId, ["launch.rejected", "runtime.rejected"]);
      return;
    case "agent.lost":
      advance(db, e.id, e.entityId, ["target.absent", "target.absent"]);
      return;
    case "agent.exited": {
      const { exit } = EVENTS[e.type].payload.parse(e.payload);
      advance(db, e.id, e.entityId, ["process.exited", "process.exited"], {
        terminal: { exit: JSON.stringify(exit) },
      });
      return;
    }
    case "agent.respawn_requested":
      advance(db, e.id, e.entityId, ["respawn.requested", null]);
      return;
    case "agent.respawned": {
      const { externalRef, runtimeRef, theme } = EVENTS[e.type].payload.parse(e.payload);
      advance(db, e.id, e.entityId, ["launch.confirmed", "respawned"], {
        // A new process reports its own usage, as it does its own activity.
        agent: { external_ref: externalRef && JSON.stringify(externalRef), usage: null },
        terminal: { ...incarnation(runtimeRef), exit: null, theme: theme ?? null },
      });
      forgetActivity(db, e.entityId);
      return;
    }
    case "agent.respawn_rejected":
      EVENTS[e.type].payload.parse(e.payload);
      advance(db, e.id, e.entityId, ["respawn.rejected", null]);
      return;
    case "agent.external_ref_updated": {
      const { externalRef } = EVENTS[e.type].payload.parse(e.payload);
      const row = db
        .prepare("SELECT 1 AS present FROM agent_sessions WHERE id = ?")
        .get(e.entityId);
      if (row === undefined) throw new UnknownEntity("agent session", e.entityId);
      update(db, "agent_sessions", "id", e.entityId, e.id, {
        external_ref: JSON.stringify(externalRef),
      });
      return;
    }
    case "agent.signalled":
      EVENTS[e.type].payload.parse(e.payload);
      return;
    case "agent.closing":
      advance(db, e.id, e.entityId, ["close.requested", "close.requested"]);
      return;
    case "agent.closed":
      advance(db, e.id, e.entityId, ["close.completed", "close.completed"], {
        agent: { usage: null },
      });
      forgetActivity(db, e.entityId);
      endAssignments(db, e.id, "agent_session_id", e.entityId, "agent_closed");
      endDescendants(db, e.id);
      return;
    case "terminal.opened": {
      const { environmentId, cwd, linkedAgentId, theme } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO terminals
           (id, host_id, state, generation, runtime, locator, environment_id, kind, cwd,
            linked_agent_id, theme, created_event_id, updated_event_id)
         VALUES (?, ?, 'creating', 0, NULL, NULL, ?, 'shell', ?, ?, ?, ?, ?)`,
      ).run(e.entityId, e.hostId, environmentId, cwd, linkedAgentId, theme ?? null, e.id, e.id);
      return;
    }
    case "terminal.running": {
      const { runtimeRef } = EVENTS[e.type].payload.parse(e.payload);
      return moveShell(db, e, "runtime.confirmed", incarnation(runtimeRef));
    }
    case "terminal.failed":
      EVENTS[e.type].payload.parse(e.payload);
      return moveShell(db, e, "runtime.rejected");
    case "terminal.lost":
      return moveShell(db, e, "target.absent");
    case "terminal.closing":
      return moveShell(db, e, "close.requested");
    case "terminal.closed":
      EVENTS[e.type].payload.parse(e.payload);
      return moveShell(db, e, "close.completed");
    case "terminal.unlinked":
      return setShell(db, e, { linked_agent_id: null });
    case "terminal.renamed":
      return setShell(db, e, { name: EVENTS[e.type].payload.parse(e.payload).name });
    case "attachment.started": {
      const { terminalId, mode } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        "INSERT INTO attachments_open (id, terminal_id, mode, started_event_id) VALUES (?, ?, ?, ?)",
      ).run(e.entityId, terminalId, mode, e.id);
      return;
    }
    case "attachment.ended": {
      EVENTS[e.type].payload.parse(e.payload);
      const open = db
        .prepare("SELECT terminal_id FROM attachments_open WHERE id = ?")
        .get(e.entityId);
      if (open === undefined) return;
      db.prepare("DELETE FROM attachments_open WHERE id = ?").run(e.entityId);
      // The lease ends with its attachment (§4.3); the epoch stays, so the next grant is higher.
      db.prepare(
        "UPDATE leases SET holder = NULL, updated_event_id = ? WHERE terminal_id = ? AND holder = ?",
      ).run(e.id, String(open.terminal_id), e.entityId);
      return;
    }
    case "mailbox.queued": {
      const { agentId, body } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO mailbox (id, agent_session_id, body, state, created_event_id, updated_event_id)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      ).run(e.entityId, agentId, body, e.id, e.id);
      return;
    }
    case "mailbox.offered": {
      const { promptId } = EVENTS[e.type].payload.parse(e.payload);
      moveMessage(db, e, "offer", { prompt_id: promptId ?? null });
      db.prepare(
        `UPDATE mailbox SET first_offered_event_id = coalesce(first_offered_event_id, ?)
         WHERE id = ?`,
      ).run(e.id, e.entityId);
      return;
    }
    case "mailbox.emitted":
      return moveMessage(db, e, "ack");
    case "mailbox.seen": {
      const { promptId } = EVENTS[e.type].payload.parse(e.payload);
      return moveMessage(db, e, "seen", { prompt_id: promptId });
    }
    case "mailbox.delivered":
      return moveMessage(db, e, "confirm");
    case "mailbox.accepted":
      EVENTS[e.type].payload.parse(e.payload);
      return moveMessage(db, e, "accept");
    case "mailbox.undeliverable": {
      const { reason } = EVENTS[e.type].payload.parse(e.payload);
      return moveMessage(db, e, reason === "agent_closed" ? "agent_closed" : "give_up");
    }
    case "mailbox.requeued": {
      const { reason } = EVENTS[e.type].payload.parse(e.payload);
      moveMessage(db, e, "requeue", { prompt_id: null });
      if (AGENT_FAILURES.has(reason)) {
        db.prepare("UPDATE mailbox SET failures = failures + 1 WHERE id = ?").run(e.entityId);
      }
      return;
    }
    case "attention.opened": {
      const p = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO attention_items (id, agent_session_id, state, summary, tool_use_id,
           main_agent, kind, task_id, message_id, created_event_id, updated_event_id)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        e.entityId,
        p.agentId,
        p.summary,
        p.toolUseId,
        p.mainAgent ? 1 : 0,
        p.kind ?? "approval",
        p.taskId ?? null,
        p.messageId ?? null,
        e.id,
        e.id,
      );
      return;
    }
    case "attention.answered":
      EVENTS[e.type].payload.parse(e.payload);
      return closeAttention(db, e, "answered");
    case "attention.closed":
      return closeAttention(db, e, EVENTS[e.type].payload.parse(e.payload).reason);
    case "agent.usage": {
      const usage = EVENTS[e.type].payload.parse(e.payload);
      const row = db
        .prepare("SELECT 1 AS present FROM agent_sessions WHERE id = ?")
        .get(e.entityId);
      if (row === undefined) throw new UnknownEntity("agent session", e.entityId);
      update(db, "agent_sessions", "id", e.entityId, e.id, { usage: JSON.stringify(usage) });
      return;
    }
    case "agent.activity": {
      const activity = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO activity_latest (agent_session_id, activity, updated_event_id) VALUES (?, ?, ?)
         ON CONFLICT (agent_session_id) DO UPDATE SET activity = excluded.activity,
           updated_event_id = excluded.updated_event_id`,
      ).run(e.entityId, JSON.stringify(activity), e.id);
      return;
    }
    case "task.created": {
      const { title, brief, ownerAgentId, parentTaskId } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO tasks (id, title, brief, state, owner_agent_id, parent_task_id,
           created_event_id, updated_event_id)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
      ).run(e.entityId, title, brief, ownerAgentId, parentTaskId, e.id, e.id);
      return;
    }
    case "task.finished": {
      const { outcome, note } = EVENTS[e.type].payload.parse(e.payload);
      const row = db.prepare("SELECT state FROM tasks WHERE id = ?").get(e.entityId);
      if (row === undefined) throw new UnknownEntity("task", e.entityId);
      const state = task.next(TaskState.parse(row.state), outcome);
      update(db, "tasks", "id", e.entityId, e.id, { state, note });
      endAssignments(db, e.id, "task_id", e.entityId, "task_finished");
      endDescendants(db, e.id);
      return;
    }
    case "assignment.granted": {
      const { taskId, agentId, role, parentAssignmentId } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO assignments (id, task_id, agent_session_id, role, parent_assignment_id, state,
           created_event_id, updated_event_id)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(e.entityId, taskId, agentId, role, parentAssignmentId, e.id, e.id);
      return;
    }
    case "assignment.ended": {
      const { reason } = EVENTS[e.type].payload.parse(e.payload);
      const row = db.prepare("SELECT state FROM assignments WHERE id = ?").get(e.entityId);
      if (row === undefined) throw new UnknownEntity("assignment", e.entityId);
      const state = assignment.next(AssignmentState.parse(row.state), reason);
      update(db, "assignments", "id", e.entityId, e.id, { state, end_reason: reason });
      endDescendants(db, e.id);
      return;
    }
    case "lease.granted": {
      const { attachmentId, epoch } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO leases (terminal_id, holder, epoch, updated_event_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (terminal_id) DO UPDATE SET holder = excluded.holder, epoch = excluded.epoch,
           updated_event_id = excluded.updated_event_id`,
      ).run(e.entityId, attachmentId, epoch, e.id);
      return;
    }
  }
}

/** Ends every active assignment of a task or an agent, as the event that ends them all is applied. */
function endAssignments(
  db: Statements,
  eventId: number,
  by: "task_id" | "agent_session_id",
  id: string,
  reason: AssignmentEndReason,
): void {
  db.prepare(
    `UPDATE assignments SET state = 'ended', end_reason = ?, updated_event_id = ?
     WHERE ${by} = ? AND state = 'active'`,
  ).run(reason, eventId, id);
}

/**
 * Ends every active assignment granted under one this event ended, however deep, as
 * `parent_ended`: no agent keeps authority it was given by one that has lost it.
 */
function endDescendants(db: Statements, eventId: number): void {
  db.prepare(
    `WITH RECURSIVE under (id) AS (
       SELECT a.id FROM assignments a JOIN assignments p ON a.parent_assignment_id = p.id
         WHERE p.updated_event_id = ? AND p.state = 'ended'
       UNION
       SELECT a.id FROM assignments a JOIN under ON a.parent_assignment_id = under.id
     )
     UPDATE assignments SET state = 'ended', end_reason = 'parent_ended', updated_event_id = ?
     WHERE state = 'active' AND id IN (SELECT id FROM under)`,
  ).run(eventId, eventId);
}

type Columns = Readonly<Record<string, SQLInputValue>>;

/** The columns that record which runtime incarnation a terminal is in. */
const incarnation = (ref: { runtime: string; locator: Record<string, string> }): Columns => ({
  runtime: ref.runtime,
  locator: JSON.stringify(ref.locator),
});

function moveMessage(db: Statements, e: Recorded, event: MailboxEvent, columns: Columns = {}) {
  const row = db.prepare("SELECT state FROM mailbox WHERE id = ?").get(e.entityId);
  if (row === undefined) throw new UnknownEntity("message", e.entityId);
  const state = mailbox.next(MailboxState.parse(row.state), event);
  update(db, "mailbox", "id", e.entityId, e.id, { state, ...columns });
}

/** A shell's own events move only its terminal: no agent session sits above it (§4.8). */
function moveShell(db: Statements, e: Recorded, event: TerminalEvent, columns: Columns = {}) {
  const row = db
    .prepare("SELECT state, generation FROM terminals WHERE id = ? AND kind = 'shell'")
    .get(e.entityId);
  if (row === undefined) throw new UnknownEntity("shell", e.entityId);
  const at = advanceTerminal(
    { state: TerminalState.parse(row.state), generation: Number(row.generation) },
    event,
  );
  update(db, "terminals", "id", e.entityId, e.id, { ...at, ...columns });
}

/** Changes what a shell is, never where it is in its lifecycle. */
function setShell(db: Statements, e: Recorded, columns: Columns) {
  const row = db
    .prepare("SELECT 1 AS present FROM terminals WHERE id = ? AND kind = 'shell'")
    .get(e.entityId);
  if (row === undefined) throw new UnknownEntity("shell", e.entityId);
  update(db, "terminals", "id", e.entityId, e.id, columns);
}

function closeAttention(db: Statements, e: Recorded, reason: AttentionCloseReason) {
  const row = db.prepare("SELECT state FROM attention_items WHERE id = ?").get(e.entityId);
  if (row === undefined) throw new UnknownEntity("attention item", e.entityId);
  const state = attention.next(AttentionState.parse(row.state), reason);
  update(db, "attention_items", "id", e.entityId, e.id, { state, close_reason: reason });
}

/** A new or closed process says nothing yet: the last one's signal goes with it. */
function forgetActivity(db: Statements, agentId: string): void {
  db.prepare("DELETE FROM activity_latest WHERE agent_session_id = ?").run(agentId);
}

/** Requeue reasons the agent's side caused, which count toward the re-offer cap (§5.6). */
const AGENT_FAILURES: ReadonlySet<string> = new Set(["stop_failed", "interrupted", "not_seen"]);

/** Moves an agent and its terminal together: a local agent's terminal is its process (§4.5). */
function advance(
  db: Statements,
  eventId: number,
  agentId: string,
  [agentEvent, terminalEvent]: [AgentEvent, TerminalEvent | null],
  columns: { agent?: Columns; terminal?: Columns } = {},
): void {
  const row = db.prepare("SELECT state FROM agent_sessions WHERE id = ?").get(agentId);
  if (row === undefined) throw new UnknownEntity("agent session", agentId);
  update(db, "agent_sessions", "id", agentId, eventId, {
    state: agent.next(AgentState.parse(row.state), agentEvent),
    ...columns.agent,
  });
  if (terminalEvent === null) return;
  const term = db
    .prepare("SELECT state, generation FROM terminals WHERE agent_session_id = ?")
    .get(agentId);
  if (term === undefined) return;
  const at = advanceTerminal(
    { state: TerminalState.parse(term.state), generation: Number(term.generation) },
    terminalEvent,
  );
  update(db, "terminals", "agent_session_id", agentId, eventId, { ...at, ...columns.terminal });
}

function update(
  db: Statements,
  table: string,
  key: string,
  id: string,
  eventId: number,
  columns: Columns,
): void {
  const names = Object.keys(columns);
  db.prepare(
    `UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(", ")}, updated_event_id = ? WHERE ${key} = ?`,
  ).run(...names.map((n) => columns[n] ?? null), eventId, id);
}
