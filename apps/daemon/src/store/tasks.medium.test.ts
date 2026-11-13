import { describe, expect, it } from "vitest";
import { InvalidTransition, newId, type AgentSessionId } from "@bazhen/core";
import type { Role } from "@bazhen/protocol";
import { register, settled, tempDb, testView, withAgent } from "../testing/fixtures.ts";
import { MIGRATIONS } from "./migrations.ts";
import { LATEST_SCHEMA_VERSION, Store } from "./store.ts";

function create(store: Store, ownerAgentId: AgentSessionId | null = null) {
  const taskId = newId("task");
  store.append({
    type: "task.created",
    entityId: taskId,
    actor: ownerAgentId ?? "human",
    payload: {
      title: "Fix the build",
      brief: "It fails on Node 26.",
      ownerAgentId,
      parentTaskId: null,
    },
  });
  return taskId;
}

function grant(
  store: Store,
  taskId: string,
  agentId: string,
  role: Role = "worker",
  parentAssignmentId: string | null = null,
) {
  const assignmentId = newId("asgn");
  store.append({
    type: "assignment.granted",
    entityId: assignmentId,
    actor: "human",
    payload: { taskId, agentId, role, parentAssignmentId },
  });
  return assignmentId;
}

/** Another agent in the store's environment, to hold an assignment. */
function newAgent(store: Store) {
  const agentId = newId("agent");
  const environmentId = String(store.snapshot(testView).environments[0]?.id);
  store.append({
    type: "agent.launched",
    entityId: agentId,
    actor: "system",
    payload: { environmentId, harness: "codex", project: "p", cwd: "/w", terminalId: null },
  });
  return agentId;
}

const finish = (taskId: string, outcome: "done" | "cancelled") => ({
  type: "task.finished" as const,
  entityId: taskId,
  actor: "human",
  payload: { outcome, note: "Pinned the toolchain." },
});

describe("Store tasks", () => {
  it("upgrades a schema-15 database with agents to one that gives them tasks", async () => {
    const path = tempDb();
    const old = Store.open(
      path,
      MIGRATIONS.filter((m) => m.version <= 15),
    );
    const { environmentId } = register(old);
    const agentId = newId("agent");
    old.append({
      type: "agent.launched",
      entityId: agentId,
      actor: "system",
      payload: { environmentId, harness: "claude-code", project: "p", cwd: "/w", terminalId: null },
    });
    old.close();
    const store = Store.open(path);
    expect(store.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    const taskId = create(store);
    grant(store, taskId, agentId);
    expect(store.assignments({ agentId }).map((a) => a.taskId)).toEqual([taskId]);
    store.close();
  });

  it("ends every assignment granted under an ended one, however deep, and no other", async () => {
    const { store, agentId } = await withAgent();
    const taskId = create(store);
    const top = grant(store, taskId, agentId, "coordinator");
    const lead = grant(store, taskId, newAgent(store), "lead", top);
    const worker = grant(store, taskId, newAgent(store), "worker", lead);
    const apart = grant(store, taskId, newAgent(store), "worker");
    store.append({
      type: "assignment.ended",
      entityId: lead,
      actor: "human",
      payload: { reason: "unassigned" },
    });
    const ends = Object.fromEntries(store.assignments({ taskId }).map((a) => [a.id, a.endReason]));
    expect([ends[top], ends[lead], ends[worker], ends[apart]]).toEqual([
      null,
      "unassigned",
      "parent_ended",
      null,
    ]);
  });

  it("runs after-commit work only once its transaction commits, and never after a rollback", async () => {
    const { store } = await withAgent();
    const ran: string[] = [];
    store.transaction(() => {
      store.afterCommit(() => ran.push("kept"));
      expect(ran).toEqual([]);
    });
    expect(() =>
      store.transaction(() => {
        store.afterCommit(() => ran.push("rolled back"));
        throw new Error("fails");
      }),
    ).toThrow("fails");
    expect(ran).toEqual(["kept"]);
  });

  it("keeps a command committed when work after its commit fails, and still runs the rest", async () => {
    const { store } = await withAgent();
    const ran: string[] = [];
    let told = false;
    store.onCommit(() => (told = true));
    const taskId = store.transaction(() => {
      store.afterCommit(() => {
        throw new Error("hand-over failed");
      });
      store.afterCommit(() => ran.push("next"));
      return create(store);
    });
    await settled();
    expect([store.taskView(taskId)?.state, ran, told]).toEqual(["open", ["next"], true]);
  });

  it("runs each piece of after-commit work in its own transaction, recording none of one that fails", async () => {
    const { store } = await withAgent();
    store.transaction(() => {
      store.afterCommit(() => {
        create(store);
        throw new Error("fails after its first write");
      });
    });
    expect(store.snapshot(testView).tasks).toEqual([]);
  });

  it("shows a task and its assignment in the snapshot, with the brief only in its own read", async () => {
    const { store, agentId } = await withAgent();
    const taskId = create(store);
    const assignmentId = grant(store, taskId, agentId, "lead");
    const snapshot = store.snapshot(testView);
    expect(snapshot.tasks).toEqual([
      { id: taskId, title: "Fix the build", state: "open", ownerAgentId: null, parentTaskId: null },
    ]);
    expect(snapshot.assignments).toEqual([
      expect.objectContaining({ id: assignmentId, agentId, role: "lead", state: "active" }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("Node 26");
    expect(store.taskDetail(taskId)?.brief).toBe("It fails on Node 26.");
  });

  it("ends every active assignment as the task finishes, and keeps the note", async () => {
    const { store, agentId } = await withAgent();
    const taskId = create(store);
    grant(store, taskId, agentId);
    store.append(finish(taskId, "done"));
    const detail = store.taskDetail(taskId);
    expect([detail?.state, detail?.note]).toEqual(["done", "Pinned the toolchain."]);
    expect(detail?.assignments.map((a) => [a.state, a.endReason])).toEqual([
      ["ended", "task_finished"],
    ]);
  });

  it("refuses to finish a task a second time, recording nothing", async () => {
    const { store } = await withAgent();
    const taskId = create(store);
    store.append(finish(taskId, "cancelled"));
    const before = store.snapshot(testView).eventId;
    expect(() => store.append(finish(taskId, "done"))).toThrow(InvalidTransition);
    expect(store.snapshot(testView).eventId).toBe(before);
  });

  it("ends only the closing agent's assignments, as agent_closed", async () => {
    const { store, agentId } = await withAgent();
    const other = newId("agent");
    const [environment] = store.snapshot(testView).environments;
    store.append({
      type: "agent.launched",
      entityId: other,
      actor: "human",
      payload: {
        environmentId: String(environment?.id),
        harness: "codex",
        project: "p",
        cwd: "/work",
        terminalId: null,
      },
    });
    const taskId = create(store);
    const mine = grant(store, taskId, agentId);
    const theirs = grant(store, taskId, other);
    store.append({ type: "agent.closing", entityId: agentId, actor: "human", payload: {} });
    store.append({ type: "agent.closed", entityId: agentId, actor: "system", payload: {} });
    expect(store.taskView(taskId)?.active.map((a) => a.id)).toEqual([theirs]);
    expect(store.assignments({ agentId })).toEqual([
      expect.objectContaining({ id: mine, state: "ended", endReason: "agent_closed" }),
    ]);
  });
});
