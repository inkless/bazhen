import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { InvalidTransition, newId } from "@bazhen/core";
import { MIGRATIONS } from "./migrations.ts";
import { UnknownEntity } from "./projections.ts";
import { LATEST_SCHEMA_VERSION, SchemaTooNew, Store } from "./store.ts";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "bz-store-")), "bazhen.db");

function withEnvironment(store: Store) {
  const environmentId = newId("env");
  store.append({
    type: "environment.registered",
    entityId: environmentId,
    actor: "system",
    payload: { kind: "local" },
  });
  return environmentId;
}

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
    expect(store.eventsAfter(a).map((e) => e.type)).toEqual(["agent.launched"]);
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
