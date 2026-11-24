// What the Rust store's agent events are held to: a run of `agent.*` events the TypeScript store
// appended, each with the payload it wrote or the refusal it gave, and the rows they left.
// `moon run :schema` writes it to packages/protocol/fixtures/agents/, where crates/bazhen-store's
// tests replay the same events and compare.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Activity, EventPayload, EventType, ExternalRef } from "@bazhen/protocol";
import { type NewEvent, Store } from "../apps/daemon/src/store/store.ts";

const id = (prefix: string, n: number) =>
  `${prefix}_0190000000007000800000000000${n.toString(16).padStart(4, "0")}`;

const ENV = id("env", 1);
const A = id("agent", 1);
const B = id("agent", 2);
const C = id("agent", 3);
const D = id("agent", 4);
const E = id("agent", 5);
const F = id("agent", 6);
const G = id("agent", 7);
const H = id("agent", 8);
const J = id("agent", 9);
const K = id("agent", 10);
const T1 = id("term", 1);
const T2 = id("term", 2);
const T3 = id("term", 3);
const T4 = id("term", 4);
const T5 = id("term", 5);
const T6 = id("term", 6);
const T7 = id("term", 7);
const T8 = id("term", 8);
const T9 = id("term", 9);
const T10 = id("term", 10);
const T11 = id("term", 11);
const HOST = id("host", 1);

const ref = (generation: number) => ({
  runtime: "holder",
  locator: { socket: "/run/bazhen/holder.sock", generation: String(generation) },
});
const session = (sessionId: string): ExternalRef => ({
  environmentId: ENV,
  kind: "claude-session",
  id: sessionId,
});
const thread = (threadId: string): ExternalRef => ({
  environmentId: ENV,
  kind: "codex-thread",
  id: threadId,
});
const activity: Activity = {
  value: "working",
  source: "native",
  confidence: 1,
  observedAt: "2026-11-01T00:00:00.000Z",
};
const usage = { model: "opus", contextUsedPercent: 12.5, contextWindowTokens: 200_000 };

const step = <T extends EventType>(
  type: T,
  entityId: string,
  actor: string,
  payload: EventPayload<T>,
): NewEvent<T> => ({ type, entityId, actor, payload });

/** Each event appended, in order: its type, its agent, who it came from, and its payload. */
const STEPS: readonly NewEvent<EventType>[] = [
  step("environment.registered", ENV, "system", { kind: "local" }),
  step("agent.launched", A, "user", {
    environmentId: ENV,
    harness: "claude-code",
    project: "my project!",
    cwd: "/work/a",
    terminalId: T1,
    name: "my-project-3",
    nameOrdinal: 3,
    runtime: "holder",
    role: "worker",
    promptHash: "hash-1",
    compactWindowTokens: 200_000,
  }),
  step("agent.running", A, "system", {
    externalRef: session("s1"),
    runtimeRef: ref(0),
    theme: "light",
    harnessName: "my-project-3",
  }),
  step("agent.running", A, "system", { externalRef: null, runtimeRef: null }),
  step("agent.ready", A, "system", { sign: "claude_hook" }),
  step("agent.activity", A, A, activity),
  step("agent.usage", A, A, usage),
  step("agent.transcript_recorded", A, A, { sessionId: "s1", path: "/home/u/.claude/s1.jsonl" }),
  step("agent.transcript_recorded", A, A, { sessionId: "s9", path: "/home/u/.claude/s9.jsonl" }),
  step("agent.external_ref_updated", A, A, { externalRef: session("s2") }),
  step("agent.transcript_recorded", A, A, { sessionId: "s2", path: "/home/u/.claude/s2.jsonl" }),
  step("agent.external_ref_updated", A, A, { externalRef: session("s2") }),
  step("agent.signalled", A, "user", { signal: "SIGINT" }),
  step("agent.compacted", A, A, {
    sign: "claude_hook",
    before: usage,
    hook: { sessionId: "s2", pid: 4242 },
  }),
  step("agent.exited", A, "system", { exit: { type: "exited", code: 1 } }),
  step("agent.ready", A, "system", { sign: "claude_hook" }),
  step("agent.respawn_requested", A, "user", {}),
  step("agent.respawned", A, "system", {
    externalRef: session("s2"),
    runtimeRef: ref(1),
    promptHash: "hash-2",
  }),
  step("agent.activity", A, A, activity),
  step("agent.exited", A, "system", { exit: { type: "signalled", signal: "SIGTERM" } }),
  step("agent.process_adopted", A, "system", { runtimeRef: ref(1) }),
  step("agent.process_adopted", A, "system", { runtimeRef: ref(5) }),
  step("agent.renamed", A, "user", { name: "renamed", previous: "my-project-3" }),
  step("agent.lost", A, "system", {}),
  step("agent.relaunch_rejected", B, "system", { reason: "unavailable" }),
  step("agent.relaunch_requested", A, "user", {
    terminalId: T2,
    generation: 6,
    fresh: false,
    runtime: "holder",
  }),
  step("agent.relaunch_rejected", A, "system", { reason: "harness_refused", detail: "no" }),
  step("agent.relaunch_requested", A, "user", { terminalId: T3, generation: 6, fresh: true }),
  step("agent.relaunched", A, "system", {
    externalRef: session("s3"),
    runtimeRef: ref(6),
    theme: "dark",
    promptHash: "hash-3",
  }),
  step("agent.closing", A, "user", {}),
  step("agent.closed", A, "system", {}),
  step("agent.closed", A, "system", {}),
  step("agent.launched", B, A, {
    environmentId: ENV,
    harness: "claude-code",
    project: "",
    cwd: "/work/b",
    terminalId: null,
    launchedBy: A,
    nameOrdinal: 1,
  }),
  step("agent.failed", B, "system", { reason: "daemon_restart" }),
  step("agent.launched", C, "user", {
    environmentId: ENV,
    harness: "claude-code",
    project: "x",
    cwd: "/c",
    terminalId: T4,
  }),
  step("agent.failed", C, "system", { reason: "launch_rejected", detail: "it broke" }),
  step("agent.launched", D, "user", {
    environmentId: ENV,
    harness: "codex",
    project: "x",
    cwd: "/d",
    terminalId: T5,
  }),
  step("agent.running", D, "system", { externalRef: thread("t1"), runtimeRef: ref(0) }),
  step("agent.exited", D, "system", { exit: { type: "unknown" } }),
  step("agent.respawn_requested", D, "user", {}),
  step("agent.respawn_rejected", D, "system", { reason: "not_resumable" }),
  step("agent.launched", E, "user", {
    environmentId: ENV,
    harness: "codex",
    project: "x",
    cwd: "/e",
    terminalId: null,
  }),
  step("agent.running", E, "system", { externalRef: thread("t1"), runtimeRef: null }),
  step("agent.activity", E, E, activity),
  step("agent.activity", E, E, { ...activity, value: "idle", confidence: 0.5 }),
  step("agent.usage", F, F, usage),
  step("agent.renamed", F, "user", { name: "f", previous: "" }),
  step("agent.relaunch_requested", F, "user", { terminalId: T11, generation: 1, fresh: true }),
  // A base differing only in case is the same counter, which keeps the highest ordinal: 7, not 2.
  step("agent.launched", K, "user", {
    environmentId: ENV,
    harness: "claude-code",
    project: "My Project",
    cwd: "/k",
    terminalId: null,
    nameOrdinal: 7,
  }),
  step("agent.launched", G, "user", {
    environmentId: ENV,
    harness: "claude-code",
    project: "MY PROJECT!",
    cwd: "/g",
    terminalId: null,
    nameOrdinal: 2,
  }),
  // Lost twice: a rejected relaunch goes back to the terminal it was last lost on.
  step("agent.launched", H, "user", {
    environmentId: ENV,
    harness: "claude-code",
    project: "h",
    cwd: "/h",
    terminalId: T6,
  }),
  step("agent.running", H, "system", { externalRef: session("s7"), runtimeRef: ref(0) }),
  step("agent.lost", H, "system", {}),
  step("agent.relaunch_requested", H, "user", { terminalId: T7, generation: 1, fresh: false }),
  step("agent.relaunched", H, "system", { externalRef: session("s7"), runtimeRef: ref(1) }),
  step("agent.lost", H, "system", {}),
  step("agent.relaunch_requested", H, "user", { terminalId: T8, generation: 2, fresh: false }),
  step("agent.relaunch_rejected", H, "system", { reason: "unavailable" }),
  // A thread held only by a closed agent is free to take.
  step("agent.closing", D, "user", {}),
  step("agent.closed", D, "system", {}),
  step("agent.running", E, "system", { externalRef: thread("t1"), runtimeRef: null }),
  // Each way of binding to a thread another live agent holds is refused.
  step("agent.launched", J, "user", {
    environmentId: ENV,
    harness: "codex",
    project: "j",
    cwd: "/j",
    terminalId: T9,
  }),
  step("agent.running", J, "system", { externalRef: thread("t5"), runtimeRef: ref(0) }),
  step("agent.external_ref_updated", J, J, { externalRef: thread("t1") }),
  step("agent.exited", J, "system", { exit: { type: "exited", code: 0 } }),
  step("agent.respawn_requested", J, "user", {}),
  step("agent.respawned", J, "system", { externalRef: thread("t1"), runtimeRef: ref(1) }),
  step("agent.respawned", J, "system", { externalRef: thread("t5"), runtimeRef: ref(1) }),
  step("agent.lost", J, "system", {}),
  step("agent.relaunch_requested", J, "user", { terminalId: T10, generation: 2, fresh: false }),
  step("agent.relaunched", J, "system", { externalRef: thread("t1"), runtimeRef: ref(2) }),
  step("agent.relaunched", J, "system", { externalRef: thread("t5"), runtimeRef: ref(2) }),
];

/**
 * Each table the agent events write, as rows in the order they were inserted. An event's `ts` is
 * the clock's at the append, so it is left out, as is every other column that would differ from
 * one run to the next.
 */
const TABLES = ["agent_sessions", "terminals", "activity_latest", "agent_name_counters", "events"];

export function agentEventFixture(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "bazhen-agent-events-"));
  try {
    const path = join(dir, "agents.db");
    const store = Store.open(path);
    const steps = STEPS.map((event) => {
      try {
        store.append(event);
        return event;
      } catch (err) {
        return { ...event, refused: String(err) };
      }
    });
    store.close();
    const db = new DatabaseSync(path);
    try {
      const host = String(db.prepare("SELECT id FROM host").get()?.id);
      const rows = (table: string) =>
        db
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all()
          .map(({ ts: _ts, ...row }) => row);
      const tables = Object.fromEntries(TABLES.map((t) => [t, rows(t)]));
      const text = `${JSON.stringify({ host: HOST, steps, tables }, null, 2)}\n`;
      return { "events.json": text.replaceAll(host, HOST) };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
