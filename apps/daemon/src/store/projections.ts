import type { SQLInputValue, StatementSync } from "node:sqlite";
import {
  agent,
  attention,
  mailbox,
  terminal,
  type AgentEvent,
  type MailboxEvent,
  type TerminalEvent,
} from "@bazhen/core";
import {
  AgentState,
  AttentionCloseReason,
  AttentionState,
  EVENTS,
  MailboxState,
  TerminalState,
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
      const { externalRef, runtimeRef } = EVENTS[e.type].payload.parse(e.payload);
      advance(db, e.id, e.entityId, ["launch.confirmed", "runtime.confirmed"], {
        agent: { external_ref: externalRef && JSON.stringify(externalRef) },
        ...(runtimeRef && {
          terminal: { runtime: runtimeRef.runtime, locator: JSON.stringify(runtimeRef.locator) },
        }),
      });
      return;
    }
    case "agent.failed":
      advance(db, e.id, e.entityId, ["launch.rejected", "runtime.rejected"]);
      return;
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
    case "mailbox.offered":
      return moveMessage(db, e, "offer");
    case "mailbox.emitted":
      return moveMessage(db, e, "ack");
    case "mailbox.seen": {
      const { promptId } = EVENTS[e.type].payload.parse(e.payload);
      return moveMessage(db, e, "seen", { prompt_id: promptId });
    }
    case "mailbox.delivered":
      return moveMessage(db, e, "confirm");
    case "mailbox.requeued":
      EVENTS[e.type].payload.parse(e.payload);
      return moveMessage(db, e, "requeue", { prompt_id: null });
    case "attention.opened": {
      const { agentId, summary, toolUseId, mainAgent } = EVENTS[e.type].payload.parse(e.payload);
      db.prepare(
        `INSERT INTO attention_items (id, agent_session_id, state, summary, tool_use_id,
           main_agent, created_event_id, updated_event_id)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`,
      ).run(e.entityId, agentId, summary, toolUseId, mainAgent ? 1 : 0, e.id, e.id);
      return;
    }
    case "attention.answered":
      EVENTS[e.type].payload.parse(e.payload);
      return closeAttention(db, e, "answered");
    case "attention.closed":
      return closeAttention(db, e, EVENTS[e.type].payload.parse(e.payload).reason);
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

type Columns = Readonly<Record<string, SQLInputValue>>;

function moveMessage(db: Statements, e: Recorded, event: MailboxEvent, columns: Columns = {}) {
  const row = db.prepare("SELECT state FROM mailbox WHERE id = ?").get(e.entityId);
  if (row === undefined) throw new UnknownEntity("message", e.entityId);
  const state = mailbox.next(MailboxState.parse(row.state), event);
  update(db, "mailbox", "id", e.entityId, e.id, { state, ...columns });
}

function closeAttention(db: Statements, e: Recorded, reason: AttentionCloseReason) {
  const row = db.prepare("SELECT state FROM attention_items WHERE id = ?").get(e.entityId);
  if (row === undefined) throw new UnknownEntity("attention item", e.entityId);
  const state = attention.next(AttentionState.parse(row.state), reason);
  update(db, "attention_items", "id", e.entityId, e.id, { state, close_reason: reason });
}

/** Moves an agent and its terminal together: a local agent's terminal is its process (§4.5). */
function advance(
  db: Statements,
  eventId: number,
  agentId: string,
  [agentEvent, terminalEvent]: [AgentEvent, TerminalEvent],
  columns: { agent?: Columns; terminal?: Columns } = {},
): void {
  const row = db.prepare("SELECT state FROM agent_sessions WHERE id = ?").get(agentId);
  if (row === undefined) throw new UnknownEntity("agent session", agentId);
  update(db, "agent_sessions", "id", agentId, eventId, {
    state: agent.next(AgentState.parse(row.state), agentEvent),
    ...columns.agent,
  });
  const term = db.prepare("SELECT state FROM terminals WHERE agent_session_id = ?").get(agentId);
  if (term === undefined) return;
  update(db, "terminals", "agent_session_id", agentId, eventId, {
    state: terminal.next(TerminalState.parse(term.state), terminalEvent),
    ...columns.terminal,
  });
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
