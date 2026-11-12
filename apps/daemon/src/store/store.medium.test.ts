import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { InvalidTransition, newId } from "@bazhen/core";
import { age, register, settled, visit, withAgent } from "../testing/fixtures.ts";
import { MIGRATIONS } from "./migrations.ts";
import { UnknownEntity } from "./projections.ts";
import { LATEST_SCHEMA_VERSION, SchemaTooNew, Store } from "./store.ts";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "bz-store-")), "bazhen.db");

const withEnvironment = (store: Store) => register(store).environmentId;

function launch(store: Store, environmentId: string) {
  const agentId = newId("agent");
  const terminalId = newId("term");
  store.append({
    type: "agent.launched",
    entityId: agentId,
    actor: "system",
    payload: { environmentId, harness: "claude-code", project: "p", cwd: "/work", terminalId },
  });
  return { agentId, terminalId };
}

const running = (agentId: string) => ({
  type: "agent.running" as const,
  entityId: agentId,
  actor: "system",
  payload: { externalRef: null, runtimeRef: { runtime: "tmux", locator: { session: "bz-1" } } },
});

describe("Store", () => {
  it("migrates a fresh database to the latest schema, and reopening is a no-op", () => {
    const path = dbPath();
    Store.open(path).close();
    const again = Store.open(path);
    expect(again.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    again.close();
  });

  it("refuses a database written by a newer build", () => {
    const path = dbPath();
    Store.open(path, [
      { version: 1, sql: "SELECT 1" },
      { version: 9, sql: "SELECT 1" },
    ]).close();
    expect(() => Store.open(path)).toThrow(SchemaTooNew);
  });

  it("upgrades a schema-1 database through every migration, keeping its terminals", () => {
    const path = dbPath();
    const v1 = Store.open(path, MIGRATIONS.slice(0, 1));
    const host = v1.hostId();
    v1.close();
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
              VALUES ('${host}', '2026-01-01', 'old', 'terminal', 'term_1', 'system', '{}')`);
    raw.exec(
      `INSERT INTO terminals VALUES ('term_1', '${host}', 'running', 0, 'tmux', '{}', 1, 1)`,
    );
    raw.close();
    const upgraded = Store.open(path);
    expect(upgraded.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    upgraded.close();
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT kind FROM terminals").get()).toEqual({ kind: "agent" });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["agent_sessions", "leases"]));
    check.close();
  });

  it("records no event when its projection refuses it", () => {
    const store = Store.open(dbPath());
    launch(store, withEnvironment(store));
    const before = store.snapshot().eventId;
    expect(() => store.append(running(newId("agent")))).toThrow(UnknownEntity);
    expect(store.snapshot().eventId).toBe(before);
    store.close();
  });

  it("moves a launched agent and its terminal to running together, once", () => {
    const path = dbPath();
    const store = Store.open(path);
    const { agentId, terminalId } = launch(store, withEnvironment(store));
    expect(store.snapshot().agents).toMatchObject([{ id: agentId, state: "starting", terminalId }]);
    store.append(running(agentId));
    expect(store.snapshot().agents).toMatchObject([{ id: agentId, state: "running" }]);
    expect(() => store.append(running(agentId))).toThrow(InvalidTransition);
    store.close();
    const raw = new DatabaseSync(path);
    expect(
      raw.prepare("SELECT state, runtime FROM terminals WHERE id = ?").get(terminalId),
    ).toEqual({
      state: "running",
      runtime: "tmux",
    });
    raw.close();
  });

  it("keeps the same HostId across reopen", () => {
    const path = dbPath();
    const first = Store.open(path);
    const host = first.hostId();
    first.close();
    const again = Store.open(path);
    expect(host).toMatch(/^host_[0-9a-f]{32}$/);
    expect(again.hostId()).toBe(host);
    again.close();
  });

  it("orders events by id for resumable streams", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    const a = store.snapshot().eventId;
    launch(store, environmentId);
    expect(store.events(a).map((e) => e.type)).toEqual(["agent.launched"]);
    store.close();
  });

  it("returns the answer a key was first given, across a restart", () => {
    const path = dbPath();
    const store = Store.open(path);
    store.remember("k-1", { agentId: "agent_x", eventIds: [1] });
    store.close();
    const again = Store.open(path);
    expect([again.recall("k-1"), again.recall("k-2")]).toEqual([
      { agentId: "agent_x", eventIds: [1] },
      undefined,
    ]);
    again.close();
  });

  it("rolls a transaction back whole, nested appends included", () => {
    const store = Store.open(dbPath());
    const before = store.snapshot().eventId;
    expect(() =>
      store.transaction(() => {
        withEnvironment(store);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    expect(store.snapshot()).toMatchObject({ eventId: before, environments: [] });
    store.close();
  });
});

const CUTOFF = new Date("2026-02-01T00:00:00.000Z");

describe("Store event log", () => {
  it("gives each database its own epoch, kept across reopen and carried by the snapshot", () => {
    const path = dbPath();
    const first = Store.open(path);
    const epoch = first.epoch();
    first.close();
    const again = Store.open(path);
    const other = Store.open(dbPath());
    expect(epoch).toMatch(/^[0-9a-f]{32}$/);
    expect([again.epoch(), again.snapshot().epoch]).toEqual([epoch, epoch]);
    expect(other.epoch()).not.toBe(epoch);
    again.close();
    other.close();
  });

  it("mints an epoch for a database upgraded from schema 5, resumable from its newest event", () => {
    const path = dbPath();
    const v5 = Store.open(path, MIGRATIONS.slice(0, 5));
    withEnvironment(v5);
    v5.close();
    const upgraded = Store.open(path);
    const { epoch, eventId } = upgraded.snapshot();
    expect([epoch, upgraded.cursorFault(epoch, eventId)]).toEqual([
      expect.stringMatching(/^[0-9a-f]{32}$/),
      null,
    ]);
    upgraded.close();
  });

  it("reads back each event whole, payload included", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    expect(store.events(0)).toEqual([
      {
        id: 1,
        ts: expect.any(String),
        type: "environment.registered",
        entityType: "environment",
        entityId: environmentId,
        actor: "system",
        causationId: null,
        correlationId: null,
        payload: { kind: "local" },
      },
    ]);
    store.close();
  });

  it("tells listeners once per transaction that appended, never about a rolled-back one", async () => {
    const store = Store.open(dbPath());
    let calls = 0;
    store.onCommit(() => calls++);
    store.transaction(() => {
      launch(store, withEnvironment(store));
    });
    await settled();
    expect(calls).toBe(1);
    expect(() =>
      store.transaction(() => {
        withEnvironment(store);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    store.transaction(() => store.remember("k-1", {}));
    await settled();
    expect(calls).toBe(1);
    store.close();
  });

  it("keeps a committed append when a listener throws, and still tells the others", async () => {
    const store = Store.open(dbPath());
    let told = false;
    store.onCommit(() => {
      throw new Error("broken subscriber");
    });
    store.onCommit(() => (told = true));
    withEnvironment(store);
    await settled();
    expect([told, store.snapshot().environments.length]).toEqual([true, 1]);
    store.close();
  });

  it("retires old events no projection points at, and keeps those one does", async () => {
    const { path, store, agentId, terminalId } = await withAgent();
    // Never offered, so its first_offered_event_id is NULL: retention must still prune.
    store.append({
      type: "mailbox.queued",
      entityId: newId("msg"),
      actor: "system",
      payload: { agentId, body: "hi" },
    });
    const kept = store.events(0).map((e) => e.type);
    const [, ended] = visit(store, terminalId);
    age(path);
    const [young] = visit(store, terminalId);
    expect(store.pruneBatch(CUTOFF)).toBe(false);
    expect(store.events(0).map((e) => e.type)).toEqual([
      ...kept,
      "attachment.started",
      "attachment.ended",
    ]);
    expect(store.events(0).at(-2)?.id).toBe(young);
    const epoch = store.epoch();
    expect([store.cursorFault(epoch, ended - 1), store.cursorFault(epoch, ended)]).toEqual([
      "stale",
      null,
    ]);
    store.close();
  });

  it("never retires the newest event, so later ids stay above what retention has passed", async () => {
    const { path, store, terminalId } = await withAgent();
    const [, newest] = visit(store, terminalId);
    age(path);
    store.pruneBatch(new Date("2100-01-01T00:00:00.000Z"));
    expect(store.events(newest - 1).map((e) => e.id)).toEqual([newest]);
    const [next] = visit(store, terminalId);
    expect(next).toBe(newest + 1);
    expect(store.cursorFault(store.epoch(), newest)).toBeNull();
    store.close();
  });

  it("retires a long backlog in bounded batches, each moving the watermark up", async () => {
    const { path, store, terminalId } = await withAgent();
    const [, firstEnd] = visit(store, terminalId);
    visit(store, terminalId);
    const [, newest] = visit(store, terminalId);
    age(path);
    const epoch = store.epoch();
    // Nine events, two per batch: the first visit's end (id 5) falls behind in the third.
    const faults: (string | null)[] = [];
    while (store.pruneBatch(CUTOFF, 2)) faults.push(store.cursorFault(epoch, firstEnd));
    expect(faults).toEqual([null, null, "stale", "stale"]);
    expect(store.cursorFault(epoch, newest)).toBeNull();
    store.close();
  });

  it("calls a cursor foreign when it names another store or an event this one never had", () => {
    const store = Store.open(dbPath());
    withEnvironment(store);
    const { epoch, eventId } = store.snapshot();
    expect([
      store.cursorFault("0".repeat(32), eventId),
      store.cursorFault(epoch, eventId + 1),
      store.cursorFault(epoch, eventId),
      store.cursorFault(epoch, 0),
    ]).toEqual(["foreign", "foreign", null, null]);
    store.close();
  });
});
