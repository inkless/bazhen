import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { InvalidTransition, newId } from "@bazhen/core";
import { age, register, settled, visit, withAgent, testView } from "../testing/fixtures.ts";
import { MIGRATIONS } from "./migrations.ts";
import { UnknownEntity } from "./projections.ts";
import { LATEST_SCHEMA_VERSION, SchemaTooNew, Store, UnknownAgent } from "./store.ts";

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

const shellOpened = (terminalId: string, environmentId: string, linkedAgentId: string | null) =>
  ({
    type: "terminal.opened",
    entityId: terminalId,
    actor: "user",
    payload: { environmentId, cwd: "/work", linkedAgentId },
  }) as const;

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
      { version: LATEST_SCHEMA_VERSION + 1, sql: "SELECT 1" },
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

  it("upgrades a schema-12 database to hold shells beside the agents it had", () => {
    const path = dbPath();
    const v13 = Store.open(path, MIGRATIONS.slice(0, 13));
    const { agentId } = launch(v13, withEnvironment(v13));
    v13.close();
    const upgraded = Store.open(path);
    const [environmentId] = upgraded.environments("local");
    const terminalId = newId("term");
    upgraded.append(shellOpened(terminalId, String(environmentId), agentId));
    expect(upgraded.snapshot(testView)).toMatchObject({
      agents: [{ id: agentId, state: "starting" }],
      shells: [{ id: terminalId, state: "creating", cwd: "/work", linkedAgentId: agentId }],
    });
    upgraded.close();
  });

  it("upgrades a schema-14 database, its shells unnamed until they are named", () => {
    const path = dbPath();
    const v14 = Store.open(path, MIGRATIONS.slice(0, 14));
    const environmentId = withEnvironment(v14);
    const terminalId = newId("term");
    v14.append(shellOpened(terminalId, environmentId, null));
    v14.close();
    const upgraded = Store.open(path);
    const before = upgraded.snapshot(testView).shells[0]?.name;
    upgraded.append({
      type: "terminal.renamed",
      entityId: terminalId,
      actor: "user",
      payload: { name: "logs" },
    });
    expect([before, upgraded.snapshot(testView).shells[0]?.name]).toEqual([null, "logs"]);
    upgraded.close();
  });

  it("upgrades a schema-17 database, its shells running nothing until one is seen to", () => {
    const path = dbPath();
    const v17 = Store.open(path, MIGRATIONS.slice(0, 17));
    const environmentId = withEnvironment(v17);
    const terminalId = newId("term");
    v17.append(shellOpened(terminalId, environmentId, null));
    v17.close();
    const upgraded = Store.open(path);
    const before = upgraded.snapshot(testView).shells[0]?.foreground;
    upgraded.append({
      type: "terminal.foreground_changed",
      entityId: terminalId,
      actor: "system",
      payload: { command: "make" },
    });
    upgraded.noteShellCwd(terminalId, "/work/sub");
    expect([before, upgraded.snapshot(testView).shells[0]?.foreground?.command]).toEqual([
      null,
      "make",
    ]);
    expect(upgraded.shell(terminalId)?.currentCwd).toBe("/work/sub");
    upgraded.close();
  });

  it("moves a shell through its own events, and never an agent's terminal by them", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    const { terminalId: agentTerminal } = launch(store, environmentId);
    const terminalId = newId("term");
    store.append(shellOpened(terminalId, environmentId, null));
    const event = (type: "terminal.closing" | "terminal.lost", id = terminalId) =>
      ({ type, entityId: id, actor: "system", payload: {} }) as const;
    store.append({
      type: "terminal.running",
      entityId: terminalId,
      actor: "system",
      payload: { runtimeRef: { runtime: "tmux", locator: { generation: "0" } } },
    });
    store.append(event("terminal.lost"));
    expect(store.shell(terminalId)).toMatchObject({ state: "lost", generation: 0 });
    expect(() => store.append(event("terminal.closing", agentTerminal))).toThrow(UnknownEntity);
    expect(store.terminalState(agentTerminal)).toBe("creating");
    store.close();
  });

  it("records no event when its projection refuses it", () => {
    const store = Store.open(dbPath());
    launch(store, withEnvironment(store));
    const before = store.snapshot(testView).eventId;
    expect(() => store.append(running(newId("agent")))).toThrow(UnknownEntity);
    expect(store.snapshot(testView).eventId).toBe(before);
    store.close();
  });

  it("moves a launched agent and its terminal to running together, once", () => {
    const path = dbPath();
    const store = Store.open(path);
    const { agentId, terminalId } = launch(store, withEnvironment(store));
    expect(store.snapshot(testView).agents).toMatchObject([
      { id: agentId, state: "starting", terminalId },
    ]);
    store.append(running(agentId));
    expect(store.snapshot(testView).agents).toMatchObject([{ id: agentId, state: "running" }]);
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
    const a = store.snapshot(testView).eventId;
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
    const before = store.snapshot(testView).eventId;
    expect(() =>
      store.transaction(() => {
        withEnvironment(store);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    expect(store.snapshot(testView)).toMatchObject({ eventId: before, environments: [] });
    store.close();
  });
});

const CUTOFF = new Date("2026-02-01T00:00:00.000Z");

const exited = (agentId: string) => ({
  type: "agent.exited" as const,
  entityId: agentId,
  actor: "system",
  payload: { exit: { type: "exited" as const, code: 0 } },
});

describe("Store snapshot view", () => {
  const view = {
    host: (kind: string) => `${kind}-host`,
    attachCommand: (ref: { locator: Record<string, string> }) => `attach ${ref.locator.session}`,
    resumable: ["claude-code" as const],
    themes: () => ["light", "dark"] as const,
    attentionActions: () => [],
  };

  it("names each environment's host as the view says", () => {
    const store = Store.open(dbPath());
    withEnvironment(store);
    expect(store.snapshot(view).environments).toMatchObject([
      { kind: "local", host: "local-host" },
    ]);
    store.close();
  });

  it("offers an attach command only while the agent's terminal exists in the runtime", () => {
    const store = Store.open(dbPath());
    const { agentId } = launch(store, withEnvironment(store));
    const attach = () => store.snapshot(view).agents[0]?.attachCommand;
    const seen = [attach()];
    store.append(running(agentId));
    seen.push(attach());
    store.append(exited(agentId));
    seen.push(attach());
    store.append({ type: "agent.lost", entityId: agentId, actor: "system", payload: {} });
    seen.push(attach());
    expect(seen).toEqual([null, "attach bz-1", "attach bz-1", null]);
    store.close();
  });

  it("offers respawn only to an exited agent with a session, on a harness that resumes", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    const bare = launch(store, environmentId).agentId;
    const resumable = launch(store, environmentId).agentId;
    store.append(running(bare));
    const ref = { environmentId, kind: "claude-session" as const, id: "s-1" };
    store.append({
      ...running(resumable),
      payload: { ...running(resumable).payload, externalRef: ref },
    });
    store.append(exited(bare));
    store.append(exited(resumable));
    const commands = (resumes: readonly "claude-code"[]) =>
      store.snapshot({ ...view, resumable: resumes }).agents.map((a) => a.commands);
    expect([commands(["claude-code"]), commands([])]).toEqual([
      [["close"], ["close", "respawn"]],
      [["close"], ["close"]],
    ]);
    store.close();
  });
});

describe("Store event log", () => {
  it("gives each database its own epoch, kept across reopen and carried by the snapshot", () => {
    const path = dbPath();
    const first = Store.open(path);
    const epoch = first.epoch();
    first.close();
    const again = Store.open(path);
    const other = Store.open(dbPath());
    expect(epoch).toMatch(/^[0-9a-f]{32}$/);
    expect([again.epoch(), again.snapshot(testView).epoch]).toEqual([epoch, epoch]);
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
    const { epoch, eventId } = upgraded.snapshot(testView);
    expect([epoch, upgraded.cursorFault(epoch, eventId)]).toEqual([
      expect.stringMatching(/^[0-9a-f]{32}$/),
      null,
    ]);
    upgraded.close();
  });

  it("reads every attention item of a schema-13 database as an approval once upgraded", () => {
    const path = dbPath();
    const v13 = Store.open(path, MIGRATIONS.slice(0, 13));
    const { agentId } = launch(v13, withEnvironment(v13));
    v13.close();
    const id = newId("attn");
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO attention_items VALUES ('${id}', '${agentId}', 'open', NULL, 'Bash',
              NULL, 1, 1, 1)`);
    raw.close();
    const upgraded = Store.open(path);
    expect(upgraded.openAttention()).toMatchObject([{ id, kind: "approval" }]);
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
    expect([told, store.snapshot(testView).environments.length]).toEqual([true, 1]);
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
    const { epoch, eventId } = store.snapshot(testView);
    expect([
      store.cursorFault("0".repeat(32), eventId),
      store.cursorFault(epoch, eventId + 1),
      store.cursorFault(epoch, eventId),
      store.cursorFault(epoch, 0),
    ]).toEqual(["foreign", "foreign", null, null]);
    store.close();
  });

  it("retires an old event once the projection that kept it no longer points at it", async () => {
    const { path, store, terminalId } = await withAgent();
    const attachmentId = newId("att");
    const started = store.append({
      type: "attachment.started",
      entityId: attachmentId,
      actor: "system",
      payload: { terminalId, mode: "observe" },
    });
    age(path);
    store.pruneBatch(CUTOFF);
    const keptWhileOpen = store.events(started - 1, 1).map((e) => e.id);
    store.append({
      type: "attachment.ended",
      entityId: attachmentId,
      actor: "system",
      payload: { reason: "client_closed" },
    });
    store.pruneBatch(CUTOFF);
    const keptAfterEnd = store.events(0).some((e) => e.id === started);
    expect([keptWhileOpen, keptAfterEnd]).toEqual([[started], false]);
    store.close();
  });
});

const activity = (
  value: "working" | "idle",
  observedAt: string,
  more: { detail?: string; confidence?: number } = {},
) => ({ value, source: "native" as const, confidence: more.confidence ?? 1, observedAt, ...more });

const activityEvents = (store: Store) => store.events(0).filter((e) => e.type === "agent.activity");

describe("Store activity signals", () => {
  it("keeps the latest signal per agent, and shows it with the agent in the snapshot", async () => {
    const { store, agentId } = await withAgent();
    expect(store.snapshot(testView).agents[0]).not.toHaveProperty("activity");
    store.recordActivity(agentId, activity("working", "2026-11-12T10:00:00.000Z"));
    store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:05.000Z"));
    expect(store.latestActivity(agentId)?.value).toBe("idle");
    expect(store.snapshot(testView).agents[0]?.activity).toEqual(
      activity("idle", "2026-11-12T10:00:05.000Z"),
    );
  });

  it("appends nothing for a repeat, whenever it was seen and however sure", async () => {
    const { store, agentId } = await withAgent();
    const first = store.recordActivity(agentId, activity("working", "2026-11-12T10:00:00.000Z"));
    const again = store.recordActivity(
      agentId,
      activity("working", "2026-11-12T10:00:09.000Z", { confidence: 0.5 }),
    );
    // The first of the repeats stands, so its age shows how long the agent has been working.
    expect(store.latestActivity(agentId)?.observedAt).toBe("2026-11-12T10:00:00.000Z");
    const changed = store.recordActivity(
      agentId,
      activity("working", "2026-11-12T10:00:10.000Z", { detail: "auto-continued" }),
    );
    expect(first).toBeTypeOf("number");
    expect(again).toBeNull();
    expect(changed).toBeTypeOf("number");
    expect(activityEvents(store)).toHaveLength(2);
  });

  it("drops a signal observed before the latest, which arrived late", async () => {
    const { store, agentId } = await withAgent();
    store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:05.000Z"));
    expect(
      store.recordActivity(agentId, activity("working", "2026-11-12T10:00:00.000Z")),
    ).toBeNull();
    expect(store.latestActivity(agentId)?.value).toBe("idle");
    expect(activityEvents(store)).toHaveLength(1);
  });

  it("refuses a signal for an agent it doesn't run, recording nothing", async () => {
    const { store } = await withAgent();
    expect(() =>
      store.recordActivity(newId("agent"), activity("idle", "2026-11-12T10:00:00.000Z")),
    ).toThrow(UnknownAgent);
    expect(activityEvents(store)).toHaveLength(0);
  });

  it("records nothing for an agent whose process has exited", async () => {
    const { store, agentId } = await withAgent();
    store.append({
      type: "agent.exited",
      entityId: agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    expect(store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:00.000Z"))).toBeNull();
    expect(activityEvents(store)).toHaveLength(0);
  });

  it("forgets the old process's signal when the agent is respawned", async () => {
    const { store, agentId } = await withAgent();
    store.recordActivity(agentId, activity("working", "2026-11-12T10:00:00.000Z"));
    store.append({
      type: "agent.exited",
      entityId: agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    store.append({
      type: "agent.respawn_requested",
      entityId: agentId,
      actor: "system",
      payload: {},
    });
    store.append({
      type: "agent.respawned",
      entityId: agentId,
      actor: "system",
      payload: { externalRef: null, runtimeRef: { runtime: "tmux", locator: { generation: "1" } } },
    });
    expect(store.latestActivity(agentId)).toBeUndefined();
    // The new process's first signal is news, not a repeat of the old process's.
    expect(
      store.recordActivity(agentId, activity("working", "2026-11-12T10:01:00.000Z")),
    ).toBeTypeOf("number");
  });

  it("forgets an agent's signal once it is closed", async () => {
    const { store, agentId } = await withAgent();
    store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:00.000Z"));
    store.append({ type: "agent.closing", entityId: agentId, actor: "system", payload: {} });
    store.append({ type: "agent.closed", entityId: agentId, actor: "system", payload: {} });
    expect(store.latestActivity(agentId)).toBeUndefined();
    expect(store.snapshot(testView).agents[0]).not.toHaveProperty("activity");
  });

  it("keeps the latest signal across reopen", async () => {
    const { path, store, agentId } = await withAgent();
    store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:00.000Z"));
    store.close();
    expect(Store.open(path).latestActivity(agentId)?.value).toBe("idle");
  });

  it("never retires the event behind an agent's latest signal", async () => {
    const { path, store, agentId, terminalId } = await withAgent();
    const kept = store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:00.000Z"));
    // Retention always keeps the newest event, so a later one makes the signal's prunable.
    visit(store, terminalId);
    store.close();
    age(path);
    const reopened = Store.open(path);
    reopened.pruneBatch(new Date());
    expect(reopened.events(0).map((e) => e.id)).toContain(kept);
    expect(reopened.latestActivity(agentId)?.value).toBe("idle");
  });
});

describe("Store usage", () => {
  it("keeps the model and context use its harness last reported, recording only a change", async () => {
    const { store, agentId } = await withAgent();
    const usage = { model: "Opus 5.5", contextUsedPercent: 3, contextWindowTokens: 1_000_000 };
    expect(store.snapshot(testView).agents[0]).not.toHaveProperty("usage");
    const first = store.recordUsage(agentId, usage);
    const again = store.recordUsage(agentId, { ...usage });
    const grown = store.recordUsage(agentId, { ...usage, contextUsedPercent: 4 });
    expect([first, again, grown].map((id) => id === null)).toEqual([false, true, false]);
    expect(store.snapshot(testView).agents[0]?.usage).toEqual({ ...usage, contextUsedPercent: 4 });
  });

  it("records no usage for an agent whose process has exited, and refuses one it never ran", async () => {
    const { store, agentId } = await withAgent();
    store.append({
      type: "agent.exited",
      entityId: agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    expect(store.recordUsage(agentId, { model: "Opus" })).toBeNull();
    expect(() => store.recordUsage(newId("agent"), { model: "Opus" })).toThrow(UnknownAgent);
  });

  it("forgets an agent's usage when its process is replaced or it is closed", async () => {
    const respawned = await withAgent();
    respawned.store.recordUsage(respawned.agentId, { model: "Opus" });
    respawned.store.append({
      type: "agent.exited",
      entityId: respawned.agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    respawned.store.append({
      type: "agent.respawn_requested",
      entityId: respawned.agentId,
      actor: "system",
      payload: {},
    });
    respawned.store.append({
      type: "agent.respawned",
      entityId: respawned.agentId,
      actor: "system",
      payload: { externalRef: null, runtimeRef: { runtime: "tmux", locator: { generation: "1" } } },
    });
    const closed = await withAgent();
    closed.store.recordUsage(closed.agentId, { model: "Opus" });
    closed.store.append({
      type: "agent.closing",
      entityId: closed.agentId,
      actor: "system",
      payload: {},
    });
    closed.store.append({
      type: "agent.closed",
      entityId: closed.agentId,
      actor: "system",
      payload: {},
    });
    expect([
      respawned.store.snapshot(testView).agents[0],
      closed.store.snapshot(testView).agents[0],
    ]).toEqual([
      expect.not.objectContaining({ usage: expect.anything() }),
      expect.not.objectContaining({ usage: expect.anything() }),
    ]);
  });
});
