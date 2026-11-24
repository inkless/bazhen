// What the Rust store's agent events are held to: a run of the events of agents, their mail, the
// items they raise for the human and their tasks, as the TypeScript store appended them, each with
// the payload it wrote or the refusal it gave, and the rows they left; and the `/v1/state`
// snapshot of what they left, under a view a test can answer the same.
// `moon run :schema` writes it to packages/protocol/fixtures/agents/, where crates/bazhen-store's
// tests replay the same events and compare.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Activity, EventPayload, EventType, ExternalRef } from "@bazhen/protocol";
import { type NewEvent, type SnapshotView, Store } from "../apps/daemon/src/store/store.ts";

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
const L = id("agent", 11);
const [M1, M2, M3, M9] = [id("msg", 1), id("msg", 2), id("msg", 3), id("msg", 9)];
const O1 = id("obs", 1);
const O2 = id("obs", 2);
const [N1, N2, N9] = [id("attn", 1), id("attn", 2), id("attn", 9)];
const N3 = id("attn", 3);
const N4 = id("attn", 4);
const [TK1, TK2, TK3, TK9] = [id("task", 1), id("task", 2), id("task", 3), id("task", 9)];
const AS1 = id("asgn", 1);
const AS2 = id("asgn", 2);
const AS3 = id("asgn", 3);
const AS4 = id("asgn", 4);
const AS5 = id("asgn", 5);
const AS6 = id("asgn", 6);
const AS7 = id("asgn", 7);
const AS8 = id("asgn", 8);
const AS9 = id("asgn", 9);
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
const T12 = id("term", 12);
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
    role: "reviewer",
    promptHash: "hash-reviewer",
  }),
  step("agent.launched", G, "user", {
    environmentId: ENV,
    harness: "claude-code",
    project: "MY PROJECT!",
    cwd: "/g",
    terminalId: null,
    nameOrdinal: 2,
    role: "worker",
    promptHash: "hash-from-before",
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
  // Mail: delivered once, then refused; requeued for the agent's failure and for the daemon's;
  // given up on; stored in Codex; and one that was never queued.
  step("agent.launched", L, "user", {
    environmentId: ENV,
    harness: "claude-code",
    project: "mail",
    cwd: "/g",
    terminalId: T12,
  }),
  step("agent.running", L, "system", { externalRef: session("s7"), runtimeRef: ref(0) }),
  step("mailbox.queued", M1, "user", { agentId: L, body: "hello", from: E }),
  step("mailbox.queued", M2, "user", { agentId: L, body: "again" }),
  step("mailbox.offered", M1, L, {}),
  step("mailbox.emitted", M1, L, {}),
  step("mailbox.seen", M1, L, { promptId: "p1" }),
  step("mailbox.delivered", M1, L, {}),
  step("mailbox.delivered", M1, L, {}),
  step("mailbox.offered", M2, L, { promptId: "p2" }),
  step("mailbox.requeued", M2, "system", { reason: "not_seen" }),
  step("mailbox.offered", M2, L, {}),
  step("mailbox.requeued", M2, "system", { reason: "daemon_restart" }),
  // Each reason the agent's side caused counts a failure; the rest count none.
  step("mailbox.offered", M2, L, {}),
  step("mailbox.requeued", M2, "system", { reason: "stop_failed" }),
  step("mailbox.offered", M2, L, {}),
  step("mailbox.requeued", M2, "system", { reason: "interrupted" }),
  step("mailbox.offered", M2, L, {}),
  step("mailbox.requeued", M2, "system", { reason: "not_written" }),
  step("mailbox.offered", M2, L, {}),
  step("mailbox.requeued", M2, "system", { reason: "session_started" }),
  step("mailbox.undeliverable", M2, "system", { reason: "gave_up" }),
  step("mailbox.queued", M3, "user", { agentId: E, body: "for codex" }),
  step("mailbox.accepted", M3, "system", { offline: true }),
  step("mailbox.seen", M3, E, { promptId: "p3" }),
  step("mailbox.undeliverable", M3, "system", { reason: "agent_closed" }),
  step("mailbox.offered", M9, L, {}),
  step("message.observed", O1, L, {
    from: L,
    to: E,
    summary: "a note",
    text: "a note, whole",
    accepted: true,
    toolUseId: "tu1",
  }),
  // The same tool call observed again, under the id the daemon mints for each observation.
  step("message.observed", O2, L, {
    from: L,
    to: E,
    summary: "again",
    text: "again",
    accepted: false,
    toolUseId: "tu1",
  }),
  // Items for the human: an approval from before kinds, answered once; a question, timed out.
  step("attention.opened", N1, L, {
    agentId: L,
    summary: "run ls?",
    toolUseId: "tu2",
    mainAgent: true,
  }),
  step("attention.opened", N2, L, {
    agentId: L,
    summary: "which?",
    kind: "question",
    taskId: TK1,
    messageId: M1,
    toolUseId: null,
    mainAgent: false,
  }),
  step("attention.answered", N1, "user", { decision: "allow" }),
  step("attention.answered", N1, "user", { decision: "deny" }),
  step("attention.closed", N2, "system", { reason: "timed_out" }),
  step("attention.closed", N9, "system", { reason: "stale" }),
  // Tasks: a subtask delegated under a lead's assignment, which ending takes the worker's with
  // it; a task finished, ending what is still active on it; an agent closing, ending its own.
  step("task.created", TK1, "user", {
    title: "Ship",
    brief: "the brief",
    ownerAgentId: null,
    parentTaskId: null,
    delegatedFrom: null,
  }),
  step("assignment.granted", AS1, "user", {
    taskId: TK1,
    agentId: L,
    role: "lead",
    parentAssignmentId: null,
  }),
  step("assignment.granted", AS2, L, {
    taskId: TK1,
    agentId: E,
    role: "worker",
    parentAssignmentId: AS1,
  }),
  step("task.created", TK2, L, {
    title: "Part",
    brief: "a part",
    ownerAgentId: L,
    parentTaskId: TK1,
    delegatedFrom: AS1,
  }),
  step("assignment.granted", AS3, L, {
    taskId: TK2,
    agentId: E,
    role: "worker",
    parentAssignmentId: AS2,
  }),
  step("task.noted", TK1, L, { text: "on it", handoff: true, role: "lead" }),
  step("task.noted", TK1, "user", { text: "thanks", handoff: false, role: null }),
  // A headline is a note's first line, cut at 200 graphemes however many code points each is.
  step("task.noted", TK1, L, {
    text: `${"e\u0301".repeat(205)}\nthe rest`,
    handoff: false,
    role: "lead",
  }),
  step("task.noted", TK1, E, { text: "fine\nmore", handoff: false, role: null }),
  step("task.noted", TK9, "user", { text: "nobody", handoff: false, role: null }),
  step("task.owner_changed", TK2, "system", { ownerAgentId: null, delegatedFrom: null }),
  step("assignment.ended", AS1, "user", { reason: "unassigned" }),
  step("assignment.ended", AS1, "user", { reason: "completed" }),
  step("assignment.granted", AS4, "user", {
    taskId: TK1,
    agentId: L,
    role: "worker",
    parentAssignmentId: null,
  }),
  // A child on another task, which the parent's ending ends; and one beside it, which stays.
  step("task.created", TK3, "user", {
    title: "Other",
    brief: "another",
    ownerAgentId: null,
    parentTaskId: null,
    delegatedFrom: null,
  }),
  step("assignment.granted", AS7, "user", {
    taskId: TK3,
    agentId: E,
    role: "worker",
    parentAssignmentId: AS4,
  }),
  step("assignment.granted", AS8, "user", {
    taskId: TK3,
    agentId: E,
    role: "worker",
    parentAssignmentId: null,
  }),
  step("assignment.ended", AS9, "user", { reason: "completed" }),
  step("task.finished", TK1, "user", { outcome: "done", note: "shipped" }),
  step("task.finished", TK1, "user", { outcome: "cancelled", note: null }),
  step("task.finished", TK2, "user", { outcome: "cancelled", note: null }),
  step("assignment.granted", AS5, "user", {
    taskId: TK2,
    agentId: L,
    role: "worker",
    parentAssignmentId: null,
  }),
  step("assignment.granted", AS6, "user", {
    taskId: TK2,
    agentId: E,
    role: "worker",
    parentAssignmentId: AS5,
  }),
  step("agent.closing", L, "user", {}),
  step("agent.closed", L, "system", {}),
  // A running agent, idle, with what it raised still open.
  step("agent.ready", J, "system", { sign: "claude_hook" }),
  step("agent.activity", J, J, { ...activity, value: "idle" }),
  step("agent.usage", J, J, usage),
  step("agent.transcript_recorded", J, J, { sessionId: "t5", path: "/home/u/.codex/t5.jsonl" }),
  step("attention.opened", N3, J, {
    agentId: J,
    summary: "edit it?",
    toolUseId: "tu3",
    mainAgent: true,
  }),
  step("attention.opened", N4, J, {
    agentId: J,
    summary: "not delivered",
    kind: "undeliverable",
    messageId: M2,
    toolUseId: null,
    mainAgent: false,
  }),
];

/** Every event's time, set before the snapshot so its times are the same on every run. */
const TS = "2026-11-01T00:00:00.000Z";
const EPOCH = "e".repeat(32);

/**
 * What a daemon would answer the snapshot, fixed so the Rust store's test can answer the same: a
 * holder's attach command, a session resumed once its transcript is known, Claude Code's two
 * themes, mail heard by an idle agent, and actions by the item's kind.
 */
const VIEW: SnapshotView = {
  host: (kind) => (kind === "local" ? "fixture-host" : ""),
  attachCommand: (terminal) =>
    terminal.runtime === "holder" ? `bazhen terminals attach ${terminal.terminalId}` : null,
  resumes: (evidence) => evidence.transcript !== null,
  themes: (harness) => (harness === "claude-code" ? ["dark", "light"] : ["dark"]),
  attentionActions: (item) => {
    if (item.kind === "approval")
      return item.mainAgent ? ["allow", "deny", "reply"] : ["allow", "deny"];
    return item.messageId === null ? ["dismiss"] : ["resend", "dismiss"];
  },
  noticeActions: () => ["dismiss"],
  shellsReport: true,
  listening: (agent) => agent.activity === "idle",
  promptHash: (role) => `hash-${role ?? "none"}`,
};

/**
 * Each table the agent events write, as rows in the order they were inserted. An event's `ts` is
 * the clock's at the append, so it is left out, as is every other column that would differ from
 * one run to the next.
 */
const TABLES = [
  "agent_sessions",
  "terminals",
  "activity_latest",
  "agent_name_counters",
  "mailbox",
  "observed_messages",
  "attention_items",
  "tasks",
  "task_notes",
  "assignments",
  "events",
];

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
      db.prepare("UPDATE events SET ts = ?").run(TS);
      db.close();
      const reopened = Store.open(path);
      const snapshot = { ...reopened.snapshot(VIEW), epoch: EPOCH };
      reopened.close();
      const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`.replaceAll(host, HOST);
      return {
        "events.json": json({ host: HOST, steps, tables }),
        "snapshot.json": json({ ts: TS, epoch: EPOCH, snapshot }),
      };
    } finally {
      if (db.isOpen) db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
