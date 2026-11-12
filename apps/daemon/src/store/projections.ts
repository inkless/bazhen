import type { SQLInputValue, StatementSync } from "node:sqlite";
import { agent, terminal, type AgentEvent, type TerminalEvent } from "@bazhen/core";
import { AgentState, EVENTS, TerminalState, type EventType } from "@bazhen/protocol";

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
         VALUES (?, ?, 'creating', 0, '', '{}', ?, 'agent', ?, ?, ?)`,
      ).run(terminalId, e.hostId, environmentId, e.entityId, e.id, e.id);
      return;
    }
    case "agent.running": {
      const { externalRef, runtime } = EVENTS[e.type].payload.parse(e.payload);
      advance(db, e.id, e.entityId, ["launch.confirmed", "runtime.confirmed"], {
        agent: { external_ref: externalRef && JSON.stringify(externalRef) },
        ...(runtime && {
          terminal: { runtime: runtime.kind, locator: JSON.stringify(runtime.locator) },
        }),
      });
      return;
    }
    case "agent.failed":
      advance(db, e.id, e.entityId, ["launch.rejected", "runtime.rejected"]);
      return;
  }
}

type Columns = Readonly<Record<string, SQLInputValue>>;

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
