import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import {
  isId,
  newId,
  type AttachmentId,
  type AttentionId,
  type EnvironmentId,
  type IdPrefix,
  type MessageId,
  type RuntimeRef,
} from "@bazhen/core";
import { z } from "zod";
import {
  AgentState,
  EVENTS,
  ExternalRef,
  StateSnapshot,
  TerminalState,
  type EnvironmentKind,
  type MailboxState,
  type ResetReason,
  type EventPayload,
  type EventType,
} from "@bazhen/protocol";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from "./migrations.ts";
import { project, type Statements } from "./projections.ts";

export interface NewEvent<T extends EventType> {
  readonly type: T;
  readonly entityId: string;
  readonly actor: string;
  readonly payload: EventPayload<T>;
  readonly causationId?: number;
  readonly correlationId?: string;
}

/** An event as the log holds it, payload parsed from its JSON. */
export interface LoggedEvent {
  readonly id: number;
  readonly ts: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actor: string;
  readonly causationId: number | null;
  readonly correlationId: string | null;
  readonly payload: unknown;
}

/** A row's id as a Bazhen id of the given kind, or nothing if it isn't one. */
function rowIds<P extends IdPrefix>(rows: readonly Record<string, SQLOutputValue>[], prefix: P) {
  return rows.flatMap((r) => (typeof r.id === "string" && isId(prefix, r.id) ? [r.id] : []));
}

/** A key reused for a different request: answering with the first one would be a lie. */
export interface OpenAttention {
  readonly id: AttentionId;
  readonly toolUseId: string | null;
  readonly mainAgent: boolean;
}

/** No agent the command can act on: none by that id, or, with `what`, none of that kind. */
export class UnknownAgent extends Error {
  readonly agentId: string;

  constructor(agentId: string, what = "") {
    super(`no agent ${agentId}${what}`);
    this.agentId = agentId;
  }
}

export interface AgentTerminal {
  readonly agentId: string;
  readonly state: AgentState;
  readonly terminalState: TerminalState | null;
  readonly generation: number | null;
  readonly runtime: RuntimeRef | null;
}

/** The runtime incarnation a terminal row records, or null while it has none. */
function refFrom(
  terminalId: unknown,
  row: Record<string, SQLOutputValue> | undefined,
): RuntimeRef | null {
  if (typeof terminalId !== "string" || !isId("term", terminalId)) return null;
  if (typeof row?.runtime !== "string") return null;
  const locator: Record<string, string> = JSON.parse(String(row.locator));
  return { terminalId, runtime: row.runtime, locator };
}

export class IdempotencyConflict extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`idempotency key ${key} was first used for a different request`);
    this.key = key;
  }
}

/** A payload its event type's schema refuses; nothing is recorded. */
export class InvalidEvent extends Error {
  readonly type: EventType;

  constructor(type: EventType, cause: unknown) {
    super(`invalid ${type} payload`, { cause });
    this.type = type;
  }
}

export class SchemaTooNew extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(`database schema ${found} is newer than this build supports (${supported})`);
    this.found = found;
    this.supported = supported;
  }
}

/** The SQLite seam. Nothing else in the daemon imports node:sqlite. */
export class Store {
  private readonly db: DatabaseSync;
  private host = "";
  private depth = 0;
  private appended = false;
  private readonly listeners = new Set<() => void>();
  /** Every event a projection still points at; retention keeps them, as it keeps projections. */
  private referenced = "";
  private readonly cache = new Map<string, StatementSync>();
  /** What the projections may do: run SQL, inside the transaction that records an event. */
  private readonly statements: Statements = { prepare: (sql) => this.prepare(sql) };

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** This installation's HostId: minted on first open, stamped on every event. */
  hostId(): string {
    return this.host;
  }

  private ensureHost(): void {
    const hasTable = this.db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'host'")
      .get();
    if (!hasTable) return;
    const existing = this.db.prepare("SELECT id FROM host LIMIT 1").get()?.id;
    if (typeof existing === "string") {
      this.host = existing;
      return;
    }
    const id = newId("host");
    this.db
      .prepare("INSERT INTO host (id, created_at) VALUES (?, ?)")
      .run(id, new Date().toISOString());
    this.host = id;
  }

  static open(path: string, migrations: readonly Migration[] = MIGRATIONS): Store {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL) STRICT");
    const store = new Store(db);
    store.migrate(migrations);
    store.ensureHost();
    store.referenced = referencedEvents(db);
    return store;
  }

  schemaVersion(): number {
    const v = this.db.prepare("SELECT max(version) AS v FROM schema_version").get()?.v;
    return typeof v === "number" ? v : 0;
  }

  private migrate(migrations: readonly Migration[]): void {
    const current = this.schemaVersion();
    const supported = migrations.at(-1)?.version ?? 0;
    if (current > supported) throw new SchemaTooNew(current, supported);
    for (const m of migrations) {
      if (m.version <= current) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
      });
    }
  }

  /**
   * Appends a registered event and applies it to the read models in one transaction: if either
   * fails, neither is recorded.
   */
  append<T extends EventType>(event: NewEvent<T>): number {
    return this.transaction(() => {
      const result = this.prepare(
        `INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, causation_id, correlation_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        this.host,
        new Date().toISOString(),
        event.type,
        EVENTS[event.type].entity,
        event.entityId,
        event.actor,
        event.causationId ?? null,
        event.correlationId ?? null,
        JSON.stringify(event.payload),
      );
      const id = Number(result.lastInsertRowid);
      this.appended = true;
      // The projection parses the payload with its type's schema, rolling the event back if
      // it doesn't match.
      try {
        project(this.statements, { id, hostId: this.host, ...event });
      } catch (err) {
        throw err instanceof z.ZodError ? new InvalidEvent(event.type, err) : err;
      }
      return id;
    });
  }

  private prepare(sql: string): StatementSync {
    let statement = this.cache.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }

  /** The answer first given to a mutation carrying `key`, if there was one. */
  recall(key: string): unknown {
    const row = this.prepare("SELECT response FROM idempotency_keys WHERE key = ?").get(key);
    return typeof row?.response === "string" ? JSON.parse(row.response) : undefined;
  }

  remember(key: string, response: unknown): void {
    this.prepare("INSERT OR REPLACE INTO idempotency_keys (key, response) VALUES (?, ?)").run(
      key,
      JSON.stringify(response),
    );
  }

  environments(kind: EnvironmentKind): EnvironmentId[] {
    const rows = this.prepare(
      "SELECT id FROM environments WHERE kind = ? ORDER BY created_event_id",
    );
    return rowIds(rows.all(kind), "env");
  }

  /** A terminal's current runtime incarnation, if it is running in one. */
  runtimeRef(terminalId: string): RuntimeRef | undefined {
    const row = this.prepare("SELECT runtime, locator FROM terminals WHERE id = ?").get(terminalId);
    return refFrom(terminalId, row) ?? undefined;
  }

  /** The epoch of a terminal's last lease grant, or 0 if it has had none. */
  leaseEpoch(terminalId: string): number {
    const row = this.prepare("SELECT epoch FROM leases WHERE terminal_id = ?").get(terminalId);
    return typeof row?.epoch === "number" ? row.epoch : 0;
  }

  /** Attachments recorded as open; after a restart, none of them has a client any more. */
  openAttachments(): AttachmentId[] {
    return rowIds(
      this.prepare("SELECT id FROM attachments_open ORDER BY started_event_id").all(),
      "att",
    );
  }

  /** An agent's messages in the given states, oldest first, with when each was first offered. */
  mail(agentId: string, states: readonly MailboxState[]) {
    const marks = states.map(() => "?").join(", ");
    const rows = this.prepare(
      `SELECT m.id, m.body, m.prompt_id, e.ts AS first_offered FROM mailbox m
       LEFT JOIN events e ON e.id = m.first_offered_event_id
       WHERE m.agent_session_id = ? AND m.state IN (${marks}) ORDER BY m.created_event_id`,
    ).all(agentId, ...states);
    return rows.flatMap((r) =>
      typeof r.id === "string" && isId("msg", r.id)
        ? [
            {
              id: r.id,
              body: String(r.body),
              promptId: typeof r.prompt_id === "string" ? r.prompt_id : null,
              firstOffered: typeof r.first_offered === "string" ? r.first_offered : null,
            },
          ]
        : [],
    );
  }

  /** Messages a hook held when the daemon stopped; their hooks are gone with its socket. */
  inFlight(): { id: MessageId; agentId: string }[] {
    const sql = `SELECT id, agent_session_id FROM mailbox
                 WHERE state IN ('offered', 'emitted', 'seen') ORDER BY created_event_id`;
    return this.prepare(sql)
      .all()
      .flatMap((r) =>
        typeof r.id === "string" && isId("msg", r.id)
          ? [{ id: r.id, agentId: String(r.agent_session_id) }]
          : [],
      );
  }

  /** Open attention items, for one agent or all, with the tool call each is about. */
  openAttention(agentId?: string): OpenAttention[] {
    const sql = `SELECT id, tool_use_id, main_agent FROM attention_items
                 WHERE state = 'open' AND (?1 IS NULL OR agent_session_id = ?1) ORDER BY created_event_id`;
    return this.prepare(sql)
      .all(agentId ?? null)
      .flatMap((r) =>
        typeof r.id === "string" && isId("attn", r.id)
          ? [
              {
                id: r.id,
                toolUseId: typeof r.tool_use_id === "string" ? r.tool_use_id : null,
                mainAgent: r.main_agent === 1,
              },
            ]
          : [],
      );
  }

  /** One agent's harness, if this daemon runs it. */
  agent(agentId: string): { harness: string } | undefined {
    const row = this.prepare("SELECT harness FROM agent_sessions WHERE id = ?").get(agentId);
    return row === undefined ? undefined : { harness: String(row.harness) };
  }

  /** The agents an environment should still be running. */
  runningAgents(environmentId: string): string[] {
    const sql = "SELECT id FROM agent_sessions WHERE environment_id = ? AND state = 'running'";
    return this.prepare(sql)
      .all(environmentId)
      .map((r) => String(r.id));
  }

  /** The Codex threads the running Codex agents are bound to. */
  codexThreads(): string[] {
    const sql = `SELECT external_ref FROM agent_sessions
                 WHERE harness = 'codex' AND state = 'running' AND external_ref IS NOT NULL`;
    return this.prepare(sql)
      .all()
      .flatMap((r) => {
        const ref = ExternalRef.safeParse(JSON.parse(String(r.external_ref)));
        return ref.success && ref.data.kind === "codex-thread" ? [ref.data.id] : [];
      });
  }

  /**
   * Runs a mutation once per idempotency key (§5.1): a repeat of the same request gets the first
   * answer, parsed as `parse` reads it; the same key for a different request is refused. The
   * answer is written in the transaction that records the mutation.
   */
  once<T>(key: string, request: unknown, parse: (stored: unknown) => T, mutate: () => T): T {
    const prior = this.replay(key, request, parse);
    if (prior !== undefined) return prior;
    return this.transaction(() => {
      const response = mutate();
      this.answered(key, request, response);
      return response;
    });
  }

  /** The first answer to `key`, parsed; undefined if none. The same key for another request is refused. */
  replay<T>(key: string, request: unknown, parse: (stored: unknown) => T): T | undefined {
    const prior = this.recall(key);
    if (prior === undefined) return undefined;
    const stored: unknown =
      typeof prior === "object" && prior !== null ? Reflect.get(prior, "request") : undefined;
    if (stored !== JSON.stringify(request)) throw new IdempotencyConflict(key);
    return parse(Reflect.get(Object(prior), "response"));
  }

  /** Records the answer to `key`, for `replay`. */
  answered(key: string, request: unknown, response: unknown): void {
    this.remember(key, { request: JSON.stringify(request), response });
  }

  /**
   * An agent and its terminal, found by either id, for a lifecycle change: the agent's state, the
   * terminal's state and generation, and the runtime incarnation it is in.
   */
  agentTerminal(by: { agentId: string } | { terminalId: string }): AgentTerminal | undefined {
    const [where, id] = "agentId" in by ? ["a.id", by.agentId] : ["t.id", by.terminalId];
    const row = this.prepare(
      `SELECT a.id, a.state AS agent_state, t.id AS terminal_id, t.state AS terminal_state,
              t.generation, t.runtime, t.locator
       FROM agent_sessions a LEFT JOIN terminals t ON t.id = a.terminal_id WHERE ${where} = ?`,
    ).get(id);
    if (row === undefined) return undefined;
    return {
      agentId: String(row.id),
      state: AgentState.parse(row.agent_state),
      terminalState: row.terminal_state === null ? null : TerminalState.parse(row.terminal_state),
      generation: typeof row.generation === "number" ? row.generation : null,
      runtime: refFrom(row.terminal_id, row),
    };
  }

  /** Every projection the state snapshot shows, with the last event it reflects. */
  snapshot(): StateSnapshot {
    return this.transaction("read", () =>
      StateSnapshot.parse({
        epoch: this.epoch(),
        eventId: Number(this.prepare("SELECT coalesce(max(id), 0) AS id FROM events").get()?.id),
        environments: this.prepare(
          "SELECT id, kind FROM environments ORDER BY created_event_id",
        ).all(),
        agents: this.prepare(
          `SELECT a.id, a.environment_id AS environmentId, a.harness, a.project, a.cwd, a.state,
                  a.terminal_id AS terminalId, t.generation, a.external_ref AS externalRef, t.exit
           FROM agent_sessions a LEFT JOIN terminals t ON t.id = a.terminal_id
           ORDER BY a.created_event_id`,
        )
          .all()
          .map((r) => ({
            ...r,
            externalRef: typeof r.externalRef === "string" ? JSON.parse(r.externalRef) : null,
            exit: typeof r.exit === "string" ? JSON.parse(r.exit) : null,
          })),
        attention: this.prepare(
          `SELECT id, agent_session_id AS agentId, state, close_reason AS closeReason, summary
           FROM attention_items ORDER BY created_event_id`,
        ).all(),
        messages: this.prepare(
          "SELECT id, agent_session_id AS agentId, state FROM mailbox ORDER BY created_event_id",
        ).all(),
      }),
    );
  }

  /** This database's epoch, which every cursor into its log carries. */
  epoch(): string {
    return String(this.prepare("SELECT epoch FROM event_log").get()?.epoch);
  }

  /** Events after `afterId`, oldest first. */
  events(afterId: number, limit = 500): LoggedEvent[] {
    const sql = `SELECT id, ts, type, entity_type, entity_id, actor, causation_id, correlation_id, payload
                 FROM events WHERE id > ? ORDER BY id LIMIT ?`;
    return this.prepare(sql)
      .all(afterId, limit)
      .map((r) => ({
        id: Number(r.id),
        ts: String(r.ts),
        type: String(r.type),
        entityType: String(r.entity_type),
        entityId: String(r.entity_id),
        actor: String(r.actor),
        causationId: typeof r.causation_id === "number" ? r.causation_id : null,
        correlationId: typeof r.correlation_id === "string" ? r.correlation_id : null,
        payload: JSON.parse(String(r.payload)),
      }));
  }

  /** Whether the log can no longer continue after `afterId` for a client of store `epoch`. */
  cursorFault(epoch: string, afterId: number): ResetReason | null {
    const row = this.prepare(
      "SELECT epoch, pruned_through, (SELECT coalesce(max(id), 0) FROM events) AS newest FROM event_log",
    ).get();
    if (epoch !== row?.epoch || afterId > Number(row.newest)) return "foreign";
    return afterId < Number(row.pruned_through) ? "stale" : null;
  }

  /**
   * Retires up to `limit` events older than `cutoff`, walking up from where retention last
   * stopped, and answers whether any remain. Events a projection points at stay, and so does the
   * newest event: ids are max(id) + 1, so deleting it would hand out ids retention has passed.
   * Events kept earlier are looked at again each time, and go once nothing points at them.
   */
  pruneBatch(cutoff: Date, limit = 1000): boolean {
    return this.transaction(() => {
      const from = Number(
        this.prepare("SELECT pruned_through FROM event_log").get()?.pruned_through,
      );
      const rows = this.prepare("SELECT id, ts FROM events WHERE id > ? ORDER BY id LIMIT ?").all(
        from,
        limit,
      );
      const young = rows.findIndex((r) => String(r.ts) >= cutoff.toISOString());
      const expired = young === -1 ? rows : rows.slice(0, young);
      const through = Number(expired.at(-1)?.id ?? from);
      this.prepare(
        `DELETE FROM events WHERE id <= ?
           AND id <> (SELECT max(id) FROM events) AND id NOT IN (${this.referenced})`,
      ).run(through);
      this.prepare("UPDATE event_log SET pruned_through = ?").run(through);
      return young === -1 && rows.length === limit;
    });
  }

  /**
   * Runs `fn` in one transaction; nested calls join the outer one. A read takes no write lock,
   * but still sees one consistent state.
   */
  transaction<T>(fn: () => T): T;
  transaction<T>(mode: "read", fn: () => T): T;
  transaction<T>(...args: [() => T] | ["read", () => T]): T {
    const fn = args.length === 1 ? args[0] : args[1];
    if (this.depth > 0) return fn();
    this.db.exec(args.length === 1 ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      if (this.appended) this.notify();
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.appended = false;
      this.depth--;
    }
  }

  /**
   * Calls `listener` after each commit that appended events, never for a rolled-back one. It runs
   * after the mutation has returned, so a failing listener can't fail what already committed.
   */
  onCommit(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        if (!this.listeners.has(listener)) return;
        try {
          listener();
        } catch (err) {
          console.error("an event listener failed", err);
        }
      });
    }
  }

  close(): void {
    this.db.close();
  }
}

const quote = (name: unknown) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * One query for every event id a projection column points at, read from the schema's foreign
 * keys, so a table added later is kept without retention having to know about it.
 */
function referencedEvents(db: DatabaseSync): string {
  const columns = db
    .prepare(
      `SELECT m.name AS tbl, f."from" AS col FROM sqlite_master m, pragma_foreign_key_list(m.name) f
       WHERE m.type = 'table' AND f."table" = 'events' ORDER BY m.name, f."from"`,
    )
    .all();
  // NOT IN over a NULL is never true, which would keep every event.
  const selects = columns.map(
    (c) => `SELECT ${quote(c.col)} FROM ${quote(c.tbl)} WHERE ${quote(c.col)} IS NOT NULL`,
  );
  return selects.length > 0 ? selects.join(" UNION ") : "SELECT NULL WHERE 0";
}

export { LATEST_SCHEMA_VERSION };
