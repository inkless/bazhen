import { describe, expect, it } from "vitest";
import { TaskRefused } from "@bazhen/core";
import { recordClosed } from "../agents/lifecycle.ts";
import type { Store } from "../store/store.ts";
import { inbox, settled, taskFleet } from "../testing/fixtures.ts";

const brief = { title: "Fix the build", brief: "It fails on Node 26." };
const sub = { title: "Pin Node", brief: "Pin Node 24 in CI." };

/** The code a refused command threw, or "allowed". */
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof TaskRefused) return err.code;
    throw err;
  }
  return "allowed";
};

/**
 * A task `coordinator` created and coordinates, with `lead` as its lead, who delegated a subtask
 * to `worker`.
 */
async function delegatedByLead() {
  const f = await taskFleet();
  const { tasks, coordinator, lead, worker } = f;
  const { taskId } = tasks.create(coordinator, { idempotencyKey: "c", ...brief });
  tasks.assign(coordinator, taskId, { idempotencyKey: "l", agentId: lead, role: "lead" });
  const req = { idempotencyKey: "d", agentId: worker, role: "worker" as const, ...sub };
  const subtask = tasks.delegate(lead, req);
  return { ...f, taskId, subtaskId: subtask.taskId };
}

const close = (store: Store, agentId: string) => {
  store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
  recordClosed(store, agentId, "user");
};

/** A task the human gave `coordinator` to coordinate. */
async function coordinated() {
  const f = await taskFleet();
  const { taskId } = f.tasks.create(null, {
    idempotencyKey: "c",
    ...brief,
    assign: { agentId: f.coordinator, role: "coordinator" },
  });
  return { ...f, parentId: taskId };
}

describe("Tasks delegate", () => {
  it("makes a subtask the coordinator owns, and mails its worker what it is part of", async () => {
    const { store, tasks, coordinator, worker, parentId } = await coordinated();
    const { taskId } = tasks.delegate(coordinator, {
      idempotencyKey: "d",
      agentId: worker,
      role: "worker",
      ...sub,
    });
    const detail = store.taskDetail(taskId);
    const [own] = store.assignments({ agentId: coordinator }, "active");
    expect([
      detail?.ownerAgentId,
      detail?.parentTaskId,
      detail?.assignments[0]?.parentAssignmentId,
    ]).toEqual([coordinator, parentId, own?.id]);
    expect(inbox(store, worker).at(-1)).toContain(`part of task ${parentId}`);
  });

  it("tells the coordinator when the worker finishes the subtask", async () => {
    const { store, tasks, coordinator, worker } = await coordinated();
    const req = { idempotencyKey: "d", agentId: worker, role: "worker" as const, ...sub };
    const { taskId } = tasks.delegate(coordinator, req);
    tasks.finish(worker, taskId, { idempotencyKey: "f", outcome: "done" });
    expect(inbox(store, coordinator).at(-1)).toContain(
      `finished its part of task ${taskId} (Pin Node)`,
    );
  });

  it("refuses a worker, and the human, though either would own the subtask", async () => {
    const { tasks, coordinator, worker, parentId } = await coordinated();
    const done = tasks.delegate(coordinator, {
      idempotencyKey: "d",
      agentId: worker,
      role: "worker",
      ...sub,
    });
    const req = {
      idempotencyKey: "w",
      fromTaskId: done.taskId,
      agentId: coordinator,
      role: "worker" as const,
      ...sub,
    };
    expect([
      refusal(() => tasks.delegate(worker, req)),
      refusal(() => tasks.delegate(null, { ...req, idempotencyKey: "h", fromTaskId: parentId })),
    ]).toEqual(["forbidden", "forbidden"]);
  });

  it("asks which task to delegate from when the agent coordinates more than one", async () => {
    const { tasks, coordinator, worker, parentId } = await coordinated();
    const second = tasks.create(null, {
      idempotencyKey: "c2",
      ...brief,
      assign: { agentId: coordinator, role: "coordinator" },
    });
    const req = { idempotencyKey: "d", agentId: worker, role: "worker" as const, ...sub };
    expect(() => tasks.delegate(coordinator, req)).toThrow(
      `name one of ${parentId}, ${second.taskId}`,
    );
  });

  it("gives an agent's new subtask only under a task it coordinates, leads or owns", async () => {
    const { tasks, lead, worker, taskId } = await delegatedByLead();
    const req = (key: string) => ({ idempotencyKey: key, ...sub, parentTaskId: taskId });
    expect([
      refusal(() => tasks.create(worker, req("sub-w"))),
      refusal(() => tasks.create(lead, req("sub-l"))),
    ]).toEqual(["forbidden", "allowed"]);
  });

  it("refuses delegating to itself, or up to whoever gave it the work", async () => {
    const { tasks, coordinator, lead, worker, taskId } = await delegatedByLead();
    const req = (agentId: string, key: string) => ({
      idempotencyKey: key,
      fromTaskId: taskId,
      agentId,
      role: "worker" as const,
      ...sub,
    });
    expect([
      refusal(() => tasks.delegate(lead, req(lead, "self"))),
      refusal(() => tasks.delegate(lead, req(coordinator, "up"))),
      refusal(() => tasks.delegate(lead, req(worker, "down"))),
    ]).toEqual(["forbidden", "forbidden", "allowed"]);
  });
});

describe("delegating up", () => {
  it("refuses a lead the human assigned delegating to its task's coordinator", async () => {
    const { tasks, coordinator, lead } = await taskFleet();
    const assign = { agentId: coordinator, role: "coordinator" as const };
    const { taskId } = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    tasks.assign(null, taskId, { idempotencyKey: "l", agentId: lead, role: "lead" });
    const req = { idempotencyKey: "d", agentId: coordinator, role: "worker" as const, ...sub };
    expect(refusal(() => tasks.delegate(lead, req))).toBe("forbidden");
  });
});

describe("a delegated subtask whose delegator loses the work", () => {
  it("moves up to the parent's owner when the lead is unassigned, and the lead loses its say", async () => {
    const { store, tasks, coordinator, lead, worker, taskId, subtaskId } = await delegatedByLead();
    const leadAssignment = String(store.assignments({ agentId: lead }, "active")[0]?.id);
    tasks.unassign(coordinator, taskId, { idempotencyKey: "u", assignmentId: leadAssignment });
    expect([store.taskView(subtaskId)?.ownerAgentId, store.taskView(subtaskId)?.active]).toEqual([
      coordinator,
      [],
    ]);
    expect(inbox(store, coordinator).at(-1)).toContain(`Task ${subtaskId} (Pin Node) is now yours`);
    const regrant = { idempotencyKey: "r", agentId: worker, role: "worker" as const };
    expect(refusal(() => tasks.assign(lead, subtaskId, regrant))).toBe("forbidden");
  });

  it("moves up to the parent's owner when the lead closes", async () => {
    const { store, tasks, coordinator, lead, subtaskId } = await delegatedByLead();
    const stop = tasks.watch();
    close(store, lead);
    await settled();
    stop();
    expect(store.taskView(subtaskId)?.ownerAgentId).toBe(coordinator);
    expect(inbox(store, coordinator).at(-1)).toContain(`Task ${subtaskId} (Pin Node) is now yours`);
  });

  it("moves up to the human when the parent is the human's", async () => {
    const f = await taskFleet();
    const { store, tasks, coordinator, lead, worker } = f;
    const assign = { agentId: coordinator, role: "coordinator" as const };
    const { taskId } = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    tasks.assign(coordinator, taskId, { idempotencyKey: "l", agentId: lead, role: "lead" });
    const req = { idempotencyKey: "d", agentId: worker, role: "worker" as const, ...sub };
    const { taskId: subtaskId } = tasks.delegate(lead, req);
    const leadAssignment = String(store.assignments({ agentId: lead }, "active")[0]?.id);
    tasks.unassign(null, taskId, { idempotencyKey: "u", assignmentId: leadAssignment });
    expect(store.taskView(subtaskId)?.ownerAgentId).toBeNull();
  });

  it("falls to the human, with an inbox item, when the owner it would move up to is gone", async () => {
    const { store, tasks, raised, lead, coordinator, taskId, subtaskId } = await delegatedByLead();
    close(store, coordinator);
    const leadAssignment = String(store.assignments({ agentId: lead }, "active")[0]?.id);
    tasks.unassign(null, taskId, { idempotencyKey: "u", assignmentId: leadAssignment });
    expect(store.taskView(subtaskId)?.ownerAgentId).toBeNull();
    expect(raised).toEqual([
      expect.objectContaining({ agentId: lead, kind: "escalation", taskId: subtaskId }),
    ]);
  });
});
