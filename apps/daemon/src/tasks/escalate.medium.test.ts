import { describe, expect, it } from "vitest";
import { TaskRefused } from "@bazhen/core";
import { recordClosed } from "../agents/lifecycle.ts";
import { Inbox } from "../attention/inbox.ts";
import { Approvals } from "../mailbox/approvals.ts";
import type { Store } from "../store/store.ts";
import { taskFleet, testView } from "../testing/fixtures.ts";
import { Tasks } from "./tasks.ts";

const brief = { title: "Fix the build", brief: "It fails on Node 26." };

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

describe("Tasks escalate", () => {
  it("puts an agent's question about its own task in the human's inbox", async () => {
    const { tasks, raised, worker } = await taskFleet();
    const assign = { agentId: worker, role: "worker" as const };
    const { taskId } = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    tasks.escalate(worker, { idempotencyKey: "e", summary: "Pin 24 or 26?", taskId });
    expect(raised).toEqual([
      { agentId: worker, kind: "escalation", summary: "Pin 24 or 26?", taskId },
    ]);
  });

  it("refuses the human, and an agent asking about a task that isn't its own", async () => {
    const { tasks, raised, coordinator, worker } = await taskFleet();
    const assign = { agentId: worker, role: "worker" as const };
    const { taskId } = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    const req = { idempotencyKey: "e", summary: "Why?", taskId };
    expect([
      refusal(() => tasks.escalate(null, req)),
      refusal(() => tasks.escalate(coordinator, { ...req, idempotencyKey: "e2" })),
    ]).toEqual(["forbidden", "forbidden"]);
    expect(raised).toEqual([]);
  });
});

describe("the human's tasks, done", () => {
  it("tells the human through the inbox when an agent marks the human's task done, and only then", async () => {
    const { tasks, raised, coordinator, worker } = await taskFleet();
    const assign = { agentId: coordinator, role: "coordinator" as const };
    const human = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    const own = tasks.create(coordinator, { idempotencyKey: "o", ...brief });
    tasks.assign(coordinator, own.taskId, { idempotencyKey: "a", agentId: worker, role: "lead" });
    tasks.finish(worker, own.taskId, { idempotencyKey: "f1", outcome: "done" });
    tasks.finish(coordinator, human.taskId, {
      idempotencyKey: "f2",
      outcome: "done",
      note: "Pinned.",
    });
    expect(raised).toEqual([
      expect.objectContaining({ agentId: coordinator, kind: "task_done", taskId: human.taskId }),
    ]);
    expect(raised[0]?.summary).toContain("Pinned.");
  });

  it("tells the human when a worker it gave a part to reports that part done", async () => {
    const { tasks, raised, worker } = await taskFleet();
    const assign = { agentId: worker, role: "worker" as const };
    const { taskId } = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    tasks.finish(worker, taskId, { idempotencyKey: "f", outcome: "done" });
    expect(raised).toEqual([
      expect.objectContaining({ agentId: worker, kind: "task_done", taskId }),
    ]);
  });
});

/** The fleet with the daemon's own inbox behind the task service, rather than a recorder. */
async function withInbox() {
  const f = await taskFleet();
  const box = new Inbox(f.store, new Approvals(f.store), (to, req) => f.mailbox.send(to, req));
  box.follow();
  const tasks = new Tasks(f.store, f.mailbox, (r) => box.raise(r));
  const open = () =>
    f.store
      .snapshot(testView)
      .attention.filter((a) => a.state === "open")
      .map((a) => ({ kind: a.kind, taskId: a.taskId, summary: a.summary }));
  return { ...f, tasks, open };
}

const close = (store: Store, agentId: string) => {
  store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
  recordClosed(store, agentId, "user");
};

describe("escalations in the daemon's inbox", () => {
  it("opens one with its task, and none for a command that rolls back", async () => {
    const { store, tasks, open, worker } = await withInbox();
    const assign = { agentId: worker, role: "worker" as const };
    const { taskId } = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    expect(() =>
      store.transaction(() => {
        tasks.escalate(worker, { idempotencyKey: "e1", summary: "Lost?", taskId });
        throw new Error("a later step fails");
      }),
    ).toThrow("a later step fails");
    expect(open()).toEqual([]);
    tasks.escalate(worker, { idempotencyKey: "e2", summary: "Pin 24 or 26?", taskId });
    expect(open()).toEqual([{ kind: "escalation", taskId, summary: "Pin 24 or 26?" }]);
  });

  it("keeps a task done open after the agent that finished it closes", async () => {
    const { store, tasks, open, coordinator } = await withInbox();
    const assign = { agentId: coordinator, role: "coordinator" as const };
    const { taskId } = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    tasks.finish(coordinator, taskId, { idempotencyKey: "f", outcome: "done" });
    close(store, coordinator);
    expect(open()).toEqual([expect.objectContaining({ kind: "task_done", taskId })]);
  });

  it("refuses a second open escalation about the same task, but takes one about another", async () => {
    const { tasks, worker } = await withInbox();
    const assign = { agentId: worker, role: "worker" as const };
    const first = tasks.create(null, { idempotencyKey: "c1", ...brief, assign });
    const second = tasks.create(null, { idempotencyKey: "c2", ...brief, assign });
    tasks.escalate(worker, { idempotencyKey: "e1", summary: "A?", taskId: first.taskId });
    expect([
      refusal(() =>
        tasks.escalate(worker, { idempotencyKey: "e2", summary: "B?", taskId: first.taskId }),
      ),
      refusal(() =>
        tasks.escalate(worker, { idempotencyKey: "e3", summary: "C?", taskId: second.taskId }),
      ),
    ]).toEqual(["conflict", "allowed"]);
  });

  it("refuses an escalation about a finished task", async () => {
    const { tasks, coordinator } = await withInbox();
    const assign = { agentId: coordinator, role: "coordinator" as const };
    const { taskId } = tasks.create(coordinator, { idempotencyKey: "c", ...brief });
    tasks.assign(null, taskId, { idempotencyKey: "a", ...assign });
    tasks.finish(coordinator, taskId, { idempotencyKey: "f", outcome: "cancelled" });
    const req = { idempotencyKey: "e", summary: "Why?", taskId };
    expect(refusal(() => tasks.escalate(coordinator, req))).toBe("conflict");
  });

  it("shows the human an escalation without the agent's control or escape characters", async () => {
    const { tasks, open, worker } = await withInbox();
    tasks.escalate(worker, { idempotencyKey: "e", summary: "red\u001b[31m alert\u0007" });
    expect(open()).toEqual([expect.objectContaining({ summary: "red [31m alert" })]);
  });

  it("refuses an owner that no longer holds its subtask, before the subtask moves up", async () => {
    const { store, tasks, lead, worker } = await withInbox();
    const assign = { agentId: lead, role: "lead" as const };
    tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    const delegate = { idempotencyKey: "d", agentId: worker, role: "worker" as const, ...brief };
    const subtask = tasks.delegate(lead, delegate);
    const leadAssignment = String(store.assignments({ agentId: lead }, "active")[0]?.id);
    store.append({
      type: "assignment.ended",
      entityId: leadAssignment,
      actor: "human",
      payload: { reason: "unassigned" },
    });
    const req = { idempotencyKey: "e", summary: "Mine?", taskId: subtask.taskId };
    expect([
      store.taskView(subtask.taskId)?.ownerAgentId,
      refusal(() => tasks.escalate(lead, req)),
    ]).toEqual([lead, "forbidden"]);
  });
});
