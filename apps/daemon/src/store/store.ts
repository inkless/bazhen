import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isId, newId, type AttachmentId, type EnvironmentId, type RuntimeRef } from "@bazhen/core";
import { z } from "zod";
import {
  EVENTS,
  StateSnapshot,
  type EnvironmentKind,
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
    return this.prepare("SELECT id FROM environments WHERE kind = ? ORDER BY created_event_id")
      .all(kind)
      .flatMap((r) => (typeof r.id === "string" && isId("env", r.id) ? [r.id] : []));
  }

  /** A terminal's current runtime incarnation, if it is running in one. */
  runtimeRef(terminalId: string): RuntimeRef | undefined {
    const row = this.prepare("SELECT runtime, locator FROM terminals WHERE id = ?").get(terminalId);
    if (!isId("term", terminalId) || typeof row?.runtime !== "string") return undefined;
    const locator: Record<string, string> = JSON.parse(String(row.locator));
    return { terminalId, runtime: row.runtime, locator };
  }

  /** The epoch of a terminal's last lease grant, or 0 if it has had none. */
  leaseEpoch(terminalId: string): number {
    const row = this.prepare("SELECT epoch FROM leases WHERE terminal_id = ?").get(terminalId);
    return typeof row?.epoch === "number" ? row.epoch : 0;
  }

  /** Attachments recorded as open; after a restart, none of them has a client any more. */
  openAttachments(): AttachmentId[] {
    return this.prepare("SELECT id FROM attachments_open ORDER BY started_event_id")
      .all()
      .flatMap((r) => (typeof r.id === "string" && isId("att", r.id) ? [r.id] : []));
  }

  /** Every projection the state snapshot shows, with the last event it reflects. */
  snapshot(): StateSnapshot {
    return this.transaction("read", () =>
      StateSnapshot.parse({
        eventId: Number(this.prepare("SELECT coalesce(max(id), 0) AS id FROM events").get()?.id),
        environments: this.prepare(
          "SELECT id, kind FROM environments ORDER BY created_event_id",
        ).all(),
        agents: this.prepare(
          `SELECT id, environment_id AS environmentId, harness, project, cwd, state,
                  terminal_id AS terminalId, external_ref AS externalRef
           FROM agent_sessions ORDER BY created_event_id`,
        )
          .all()
          .map((r) => ({
            ...r,
            externalRef: typeof r.externalRef === "string" ? JSON.parse(r.externalRef) : null,
          })),
      }),
    );
  }

  eventsAfter(afterId: number, limit = 500): Array<{ id: number; type: string; entityId: string }> {
    return this.prepare(
      "SELECT id, type, entity_id AS entityId FROM events WHERE id > ? ORDER BY id LIMIT ?",
    )
      .all(afterId, limit)
      .map((r) => ({ id: Number(r.id), type: String(r.type), entityId: String(r.entityId) }));
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
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }
}

export { LATEST_SCHEMA_VERSION };
