import { DatabaseSync } from "node:sqlite";
import { newId } from "@bazhen/core";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from "./migrations.ts";

export interface NewEvent {
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actor: string;
  readonly payload: unknown;
  readonly causationId?: number;
  readonly correlationId?: string;
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
   * Appends an event and applies its projection in one transaction: if the projection throws,
   * the event is not recorded either.
   */
  append(event: NewEvent, project?: (eventId: number, db: DatabaseSync) => void): number {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, causation_id, correlation_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.host,
          new Date().toISOString(),
          event.type,
          event.entityType,
          event.entityId,
          event.actor,
          event.causationId ?? null,
          event.correlationId ?? null,
          JSON.stringify(event.payload),
        );
      const id = Number(result.lastInsertRowid);
      project?.(id, this.db);
      return id;
    });
  }

  eventsAfter(afterId: number, limit = 500): Array<{ id: number; type: string; entityId: string }> {
    return this.db
      .prepare(
        "SELECT id, type, entity_id AS entityId FROM events WHERE id > ? ORDER BY id LIMIT ?",
      )
      .all(afterId, limit)
      .map((r) => ({ id: Number(r.id), type: String(r.type), entityId: String(r.entityId) }));
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

export { LATEST_SCHEMA_VERSION };
