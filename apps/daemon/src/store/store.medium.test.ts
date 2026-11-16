import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidTransition, newId, type ResumeEvidence } from "@bazhen/core";
import { TerminalState, type ExternalRef } from "@bazhen/protocol";
import {
  age,
  loopbackPairing,
  register,
  resumesClaude,
  settled,
  visit,
  withAgent,
  testView,
} from "../testing/fixtures.ts";
import { MIGRATIONS } from "./migrations.ts";
import { UnknownEntity } from "./projections.ts";
import {
  LATEST_SCHEMA_VERSION,
  SchemaTooNew,
  Store,
  UnknownAgent,
  UnsafeDatabase,
} from "./store.ts";

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

/**
 * Leaves `path` as a daemon killed with a live WAL would, made before databases were private:
 * the database and both journals on disk, 0644.
 */
function leftByKilledDaemon(path: string): void {
  const killed = Store.open(path);
  withEnvironment(killed);
  const journals = [`${path}-wal`, `${path}-shm`].map((file) => ({
    file,
    bytes: readFileSync(file),
  }));
  killed.close();
  for (const { file, bytes } of journals) writeFileSync(file, bytes, { mode: 0o644 });
  for (const file of [path, ...journals.map((j) => j.file)]) chmodSync(file, 0o644);
}

function runningShell(store: Store) {
  const terminalId = newId("term");
  store.append(shellOpened(terminalId, withEnvironment(store), null));
  store.append({
    type: "terminal.running",
    entityId: terminalId,
    actor: "system",
    payload: { runtimeRef: { runtime: "tmux", locator: { generation: "0" } } },
  });
  return terminalId;
}

const shellEvent = (terminalId: string, type: "terminal.closing" | "terminal.lost") =>
  ({ type, entityId: terminalId, actor: "system", payload: {} }) as const;

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

  it("upgrades a schema-21 database, and a device paired after it opens a notice", () => {
    const path = dbPath();
    Store.open(path, MIGRATIONS.slice(0, 21)).close();
    const upgraded = Store.open(path);
    const device = upgraded.pairDevice("phone", "hash", true, new Date(), loopbackPairing);
    expect(upgraded.snapshot(testView).notices.map((n) => n.device?.id)).toEqual([device]);
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

  it("keeps its database and journals readable by this user only, tightening an older one", () => {
    const fresh = dbPath();
    const older = dbPath();
    leftByKilledDaemon(older);
    const store = Store.open(fresh);
    withEnvironment(store);
    const reopened = Store.open(older);
    const files = [fresh, `${fresh}-wal`, `${fresh}-shm`, older, `${older}-wal`, `${older}-shm`];
    expect(files.map((file) => statSync(file).mode & 0o777)).toEqual(files.map(() => 0o600));
    store.close();
    reopened.close();
  });

  it("refuses a database or journal that is a symlink, changing nothing it points at", () => {
    const path = dbPath();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "bz-elsewhere-")), "target");
    writeFileSync(elsewhere, "", { mode: 0o644 });
    symlinkSync(elsewhere, `${path}-wal`);
    expect(() => Store.open(path)).toThrow(UnsafeDatabase);
    symlinkSync(elsewhere, `${path}.db`);
    expect(() => Store.open(`${path}.db`)).toThrow("it is a symlink");
    expect(statSync(elsewhere).mode & 0o777).toBe(0o644);
  });

  it("refuses a FIFO or a directory in a journal's place at once, rather than wait on it", () => {
    const fifo = dbPath();
    execFileSync("mkfifo", [`${fifo}-wal`]);
    const dir = dbPath();
    mkdirSync(`${dir}-shm`);
    expect(() => Store.open(fifo)).toThrow("it is not a regular file");
    expect(() => Store.open(dir)).toThrow("it is not a regular file");
  });

  it("refuses a device as its database, which opens for writing like a file", () => {
    expect(() => Store.open("/dev/null")).toThrow("it is not a regular file");
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

  it("counts as open every terminal, agent's or shell's, but the lost, closed and failed, and as starting the creating", () => {
    const path = dbPath();
    const store = Store.open(path);
    const environmentId = withEnvironment(store);
    launch(store, environmentId);
    store.append(shellOpened(newId("term"), environmentId, null));
    store.close();
    const counted: Record<string, [number, number]> = {};
    for (const state of TerminalState.options) {
      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE terminals SET state = ?").run(state);
      raw.close();
      const reopened = Store.open(path);
      counted[state] = [reopened.openTerminals(), reopened.startingTerminals()];
      reopened.close();
    }
    expect(counted).toEqual({
      creating: [2, 2],
      running: [2, 0],
      unknown: [2, 0],
      exited: [2, 0],
      closing: [2, 0],
      lost: [0, 0],
      closed: [0, 0],
      failed: [0, 0],
    });
  });
});

/**
 * The `synchronous` level each commit on any connection ran at, in order. With `lockedOnce`, the
 * first write transaction can't begin, as when another writer holds the database past the timeout.
 */
function commitLevels({ lockedOnce = false } = {}): number[] {
  const levels: number[] = [];
  let locked = lockedOnce;
  const { value: exec } = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec") ?? {};
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (sql === "BEGIN IMMEDIATE" && locked) {
      locked = false;
      throw new Error("database is locked");
    }
    if (sql === "COMMIT")
      levels.push(Number(this.prepare("PRAGMA synchronous").get()?.synchronous));
    Reflect.apply(exec, this, [sql]);
  });
  return levels;
}

describe("Store durability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("commits at NORMAL, and a device's revocation, which must not come back after a crash, at FULL", () => {
    const store = Store.open(dbPath());
    const now = new Date("2026-02-01T00:00:00.000Z");
    const levels = commitLevels();
    const device = store.pairDevice("phone", "hash", true, now, loopbackPairing);
    store.revokeDevice(device, now);
    withEnvironment(store);
    expect(levels).toEqual([1, 2, 1]);
    store.close();
  });

  it("goes back to NORMAL when a durable transaction can't even begin", () => {
    const store = Store.open(dbPath());
    const device = store.pairDevice("phone", "hash", true, new Date(), loopbackPairing);
    const levels = commitLevels({ lockedOnce: true });
    expect(() => store.revokeDevice(device, new Date())).toThrow("database is locked");
    withEnvironment(store);
    expect(levels).toEqual([1]);
    store.close();
  });

  it("refuses a durable transaction inside another, whose commit would decide its durability", () => {
    const store = Store.open(dbPath());
    const device = store.pairDevice("phone", "hash", true, new Date(), loopbackPairing);
    expect(() => store.transaction(() => store.revokeDevice(device, new Date()))).toThrow(
      /durable/,
    );
    expect(store.devices().map((d) => d.id)).toEqual([device]);
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
    resumes: resumesClaude,
    themes: () => ["light", "dark"] as const,
    attentionActions: () => [],
    noticeActions: () => [],
    shellsReport: true,
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

  it("offers respawn only to an exited agent whose session resumes, by the transcript it recorded", () => {
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
    const onTranscript = { ...view, resumes: (a: ResumeEvidence) => a.transcript !== null };
    const commands = () => store.snapshot(onTranscript).agents.map((a) => a.commands);
    const before = commands();
    store.recordTranscript(resumable, "s-1", "/c/s-1.jsonl");
    expect([before, commands()]).toEqual([
      [["close"], ["close"]],
      [["close"], ["close", "respawn"]],
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

const event = (agentId: string) => ({ entityId: agentId, actor: "user" });

/** A launched agent whose terminal was lost, on a Claude Code session. */
function lostAgent(store: Store) {
  const environmentId = withEnvironment(store);
  const { agentId, terminalId } = launch(store, environmentId);
  const ref = { environmentId, kind: "claude-session" as const, id: "s-1" };
  store.append({
    ...running(agentId),
    payload: { ...running(agentId).payload, externalRef: ref },
  });
  store.recordUsage(agentId, { model: "Opus" });
  store.append({ ...event(agentId), type: "agent.lost", payload: {} });
  return { agentId, lostTerminal: terminalId, session: ref };
}

const requested = (agentId: string, terminalId: string) => ({
  ...event(agentId),
  type: "agent.relaunch_requested" as const,
  payload: { terminalId, generation: 1, fresh: false },
});

describe("Store relaunch", () => {
  it("moves a relaunched agent to a new terminal at the next generation, leaving the lost one lost", () => {
    const store = Store.open(dbPath());
    const { agentId, lostTerminal } = lostAgent(store);
    const terminalId = newId("term");
    store.append(requested(agentId, terminalId));
    store.append({
      ...event(agentId),
      type: "agent.relaunched",
      payload: { externalRef: null, runtimeRef: { runtime: "tmux", locator: { session: "bz-2" } } },
    });
    const agent = store.snapshot(testView).agents[0];
    expect([
      agent?.state,
      agent?.terminalId,
      agent?.generation,
      agent?.usage,
      store.terminalState(lostTerminal),
    ]).toEqual(["running", terminalId, 1, undefined, "lost"]);
    store.close();
  });

  it("returns a rejected relaunch to the terminal it was lost on, which close still ends", () => {
    const store = Store.open(dbPath());
    const { agentId, lostTerminal } = lostAgent(store);
    const terminalId = newId("term");
    store.append(requested(agentId, terminalId));
    store.append({
      ...event(agentId),
      type: "agent.relaunch_rejected",
      payload: { reason: "unavailable" },
    });
    const rejected = store.snapshot(testView).agents[0];
    store.append({ ...event(agentId), type: "agent.closing", payload: {} });
    store.append({ ...event(agentId), type: "agent.closed", payload: {} });
    expect([
      rejected?.state,
      rejected?.terminalId,
      store.terminalState(terminalId),
      store.terminalState(lostTerminal),
    ]).toEqual(["lost", lostTerminal, "failed", "closed"]);
    store.close();
  });

  it("keeps the transcript across a relaunch on the same session, and forgets it on a fresh one", () => {
    const store = Store.open(dbPath());
    const { agentId, session } = lostAgent(store);
    store.recordTranscript(agentId, "s-1", "/c/s-1.jsonl");
    const relaunch = (externalRef: ExternalRef | null) => {
      store.append(requested(agentId, newId("term")));
      store.append({
        ...event(agentId),
        type: "agent.relaunched",
        payload: { externalRef, runtimeRef: { runtime: "tmux", locator: { session: "bz-2" } } },
      });
      const kept = store.agentLaunch(agentId)?.transcript;
      store.append({ ...event(agentId), type: "agent.lost", payload: {} });
      return kept;
    };
    const resumed = relaunch(session);
    const fresh = relaunch({ ...session, id: "s-2" });
    expect([resumed, fresh]).toEqual(["/c/s-1.jsonl", null]);
    store.close();
  });

  it("takes a transcript only for the session the agent is bound to", () => {
    const store = Store.open(dbPath());
    const { agentId } = lostAgent(store);
    const record = (sessionId: string, path: string) =>
      store.append({
        ...event(agentId),
        type: "agent.transcript_recorded",
        payload: { sessionId, path },
      });
    record("s-1", "/c/s-1.jsonl");
    record("s-old", "/c/s-old.jsonl");
    expect(store.agentLaunch(agentId)?.transcript).toBe("/c/s-1.jsonl");
    store.close();
  });

  it("refuses a rejected relaunch for an agent never lost, which a launch's start can't take", () => {
    const store = Store.open(dbPath());
    const { agentId } = launch(store, withEnvironment(store));
    expect(() =>
      store.append({
        ...event(agentId),
        type: "agent.relaunch_rejected",
        payload: { reason: "unavailable" },
      }),
    ).toThrow(UnknownEntity);
    expect(store.agentTerminal({ agentId })?.state).toBe("starting");
    store.close();
  });

  it("offers relaunch to a lost agent, saying whether it would resume its session", () => {
    const store = Store.open(dbPath());
    lostAgent(store);
    const offered = (resumes: boolean) => {
      const a = store.snapshot({ ...testView, resumes: () => resumes }).agents[0];
      return [a?.commands, a?.resumable];
    };
    expect([offered(true), offered(false)]).toEqual([
      [["close", "relaunch"], true],
      [["close", "relaunch"], false],
    ]);
    store.close();
  });

  describe("a shell's last command", () => {
    it("upgrades a schema-22 database, its shells keeping no command until one is reported", () => {
      const path = dbPath();
      const v22 = Store.open(path, MIGRATIONS.slice(0, 22));
      const terminalId = runningShell(v22);
      v22.close();
      const upgraded = Store.open(path);
      const before = upgraded.lastShellCommand(terminalId);
      upgraded.noteShellCommand(terminalId, 1, "make");
      expect([before, upgraded.lastShellCommand(terminalId)]).toEqual([null, "make"]);
      upgraded.close();
    });

    it("keeps the newest line a live shell reported, so a late older report changes nothing", () => {
      const store = Store.open(dbPath());
      const terminalId = runningShell(store);
      const counted = [
        store.noteShellCommand(terminalId, 2, "pnpm dev"),
        store.noteShellCommand(terminalId, 1, "ls"),
        store.noteShellCommand(terminalId, 2, "ls"),
      ];
      expect([counted, store.lastShellCommand(terminalId)]).toEqual([
        [true, false, false],
        "pnpm dev",
      ]);
      store.close();
    });

    it("clears the kept line when a newer one can't be typed back, rather than keep the older", () => {
      const store = Store.open(dbPath());
      const terminalId = runningShell(store);
      store.noteShellCommand(terminalId, 1, "pnpm dev");
      store.noteShellCommand(terminalId, 2, "make\nrm -rf ~");
      const afterNewline = store.lastShellCommand(terminalId);
      store.noteShellCommand(terminalId, 3, "pnpm dev");
      store.noteShellCommand(terminalId, 4, null);
      expect([afterNewline, store.lastShellCommand(terminalId)]).toEqual([null, null]);
      store.close();
    });

    it("keeps a lost shell's line for its restart, and takes no report for it", () => {
      const store = Store.open(dbPath());
      const terminalId = runningShell(store);
      store.noteShellCommand(terminalId, 1, "cargo watch");
      store.append(shellEvent(terminalId, "terminal.lost"));
      const counted = store.noteShellCommand(terminalId, 2, "ls");
      expect([counted, store.lastShellCommand(terminalId)]).toEqual([false, "cargo watch"]);
      store.close();
    });

    it("forgets the line once the shell closes or fails, and never writes it into an event", () => {
      const path = dbPath();
      const store = Store.open(path);
      const closed = runningShell(store);
      const failed = newId("term");
      store.append(shellOpened(failed, withEnvironment(store), null));
      store.noteShellCommand(closed, 1, "export TOKEN=s3cret-closed");
      store.noteShellCommand(failed, 1, "export TOKEN=s3cret-failed");
      store.append(shellEvent(closed, "terminal.closing"));
      store.append({
        type: "terminal.closed",
        entityId: closed,
        actor: "user",
        payload: { reason: "user" },
      });
      store.append({
        type: "terminal.failed",
        entityId: failed,
        actor: "system",
        payload: { reason: "open_rejected" },
      });
      expect([store.lastShellCommand(closed), store.lastShellCommand(failed)]).toEqual([
        null,
        null,
      ]);
      store.close();
      const raw = new DatabaseSync(path);
      const events = raw.prepare("SELECT count(*) AS n FROM events WHERE payload LIKE '%s3cret%'");
      expect(events.get()?.n).toBe(0);
      raw.close();
    });

    it("leaves no trace of a closed shell's line in the database or its journal", () => {
      const path = dbPath();
      const store = Store.open(path);
      // Rows after it on the same page keep a cleared row's old bytes where they stood, unzeroed.
      const terminalId = runningShell(store);
      runningShell(store);
      runningShell(store);
      store.noteShellCommand(terminalId, 1, "export TOKEN=s3cret-on-disk");
      store.append(shellEvent(terminalId, "terminal.closing"));
      store.append({
        type: "terminal.closed",
        entityId: terminalId,
        actor: "user",
        payload: { reason: "user" },
      });
      const traces = [path, `${path}-wal`].map((file) => readFileSync(file).includes("s3cret"));
      store.close();
      expect(traces).toEqual([false, false]);
    });
  });
});

function named(store: Store, project: string, name?: string, nameOrdinal?: number) {
  const agentId = newId("agent");
  store.append({
    type: "agent.launched",
    entityId: agentId,
    actor: "system",
    payload: {
      environmentId: withEnvironment(store),
      harness: "claude-code",
      project,
      cwd: "/work",
      terminalId: null,
      ...(name === undefined ? {} : { name }),
      ...(nameOrdinal === undefined ? {} : { nameOrdinal }),
    },
  });
  return agentId;
}
const fail = (store: Store, agentId: string) =>
  store.append({
    type: "agent.failed",
    entityId: agentId,
    actor: "system",
    payload: { reason: "launch_rejected" },
  });
const names = (store: Store) => store.snapshot(testView).agents.map((a) => a.name);

describe("agent names", () => {
  it("upgrades a schema-23 database, naming every agent by its project in launch order", () => {
    const path = dbPath();
    const v23 = Store.open(path, MIGRATIONS.slice(0, 23));
    named(v23, "p");
    fail(v23, named(v23, "p"));
    named(v23, "my.app");
    v23.close();
    const upgraded = Store.open(path);
    expect([...names(upgraded), upgraded.nextDefaultName("p").name]).toEqual([
      "p-1",
      "p-2",
      "my-app-1",
      "p-3",
    ]);
    upgraded.close();
  });

  it("upgrades a schema-24 database, its running agents answering to no name until restarted", () => {
    const path = dbPath();
    const v24 = Store.open(path, MIGRATIONS.slice(0, 24));
    const from = named(v24, "p", "BZ-1");
    const to = named(v24, "p", "BZ-127");
    v24.append({
      type: "agent.running",
      entityId: to,
      actor: "system",
      payload: { externalRef: null, runtimeRef: null },
    });
    v24.close();
    const upgraded = Store.open(path);
    upgraded.append({
      type: "message.observed",
      entityId: newId("msg"),
      actor: from,
      payload: { from, to, summary: "hi", text: "hi", accepted: true, toolUseId: "t-1" },
    });
    expect([
      upgraded.agentsStartedAs("BZ-127"),
      upgraded.snapshot(testView).observed.map((m) => [m.from, m.to]),
    ]).toEqual([[], [[from, to]]]);
    upgraded.close();
  });

  it("upgrades projects that make one base onto one counter, each keeping its own spelling", () => {
    const path = dbPath();
    const v23 = Store.open(path, MIGRATIONS.slice(0, 23));
    for (const project of ["Bazhen", "bazhen", "my.app", "my app", ".agent_tools"])
      named(v23, project);
    v23.close();
    const upgraded = Store.open(path);
    expect([...names(upgraded), upgraded.nextDefaultName("BAZHEN").name]).toEqual([
      "Bazhen-1",
      "bazhen-2",
      "my-app-1",
      "my-app-2",
      "agent_tools-1",
      "BAZHEN-3",
    ]);
    upgraded.close();
  });

  it("resolves an exact id in any state, and a name only among agents not ended", () => {
    const store = Store.open(dbPath());
    const live = named(store, "p", "BZ-127");
    const ended = named(store, "p", "old");
    fail(store, ended);
    const resolved = [store.resolveAgent(ended), store.resolveAgent("bz-127")];
    expect(resolved).toEqual([ended, live]);
    expect(() => store.resolveAgent("old")).toThrow(UnknownAgent);
    store.close();
  });

  it("never resolves part of a name", () => {
    const store = Store.open(dbPath());
    named(store, "p", "coordinator-1");
    expect(() => store.resolveAgent("coordinator")).toThrow(UnknownAgent);
    store.close();
  });

  it("gives a default name no live agent holds, and never a number given before", () => {
    const store = Store.open(dbPath());
    fail(store, named(store, "p", "p-1", 1));
    named(store, "p", "P-2");
    expect(store.nextDefaultName("p")).toEqual({ name: "p-3", ordinal: 3 });
    store.close();
  });

  it("lets a freed name be taken again, and refuses a second live holder past every check", () => {
    const store = Store.open(dbPath());
    fail(store, named(store, "p", "lead"));
    named(store, "p", "lead");
    expect(() => named(store, "p", "LEAD")).toThrow(/UNIQUE/);
    store.close();
  });

  it("shows a rename in the snapshot", () => {
    const store = Store.open(dbPath());
    const agentId = named(store, "p", "p-1", 1);
    store.append({
      type: "agent.renamed",
      entityId: agentId,
      actor: "user",
      payload: { name: "reviewer", previous: "p-1" },
    });
    expect(names(store)).toEqual(["reviewer"]);
    store.close();
  });
});
