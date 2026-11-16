import { describe, expect, it } from "vitest";
import { newId, resolveRoles, TaskRefused } from "@bazhen/core";
import { recordClosed } from "../agents/lifecycle.ts";
import { UnknownAgent, type Store } from "../store/store.ts";
import { inbox, settled, taskFleet, testView } from "../testing/fixtures.ts";
import { builtinRoles, UnknownRole } from "../roles/roles.ts";
import { MailTooLong, Tasks } from "./tasks.ts";

const brief = { title: "Fix the build", brief: "It fails on Node 26." };

/** What refusing the command threw: TaskRefused's code, or the error's class name. */
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof TaskRefused) return err.code;
    if (err instanceof Error) return err.constructor.name;
    throw err;
  }
  return "allowed";
};

const close = (store: Store, agentId: string) => {
  store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
  recordClosed(store, agentId, "user");
};

/** A task the human gave `coordinator`, with `lead` as its lead and `worker` under the lead. */
async function staffed() {
  const f = await taskFleet();
  const { tasks, coordinator, lead, worker } = f;
  const assign = { agentId: coordinator, role: "coordinator" as const };
  const { taskId } = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
  tasks.assign(coordinator, taskId, { idempotencyKey: "l", agentId: lead, role: "lead" });
  tasks.assign(lead, taskId, { idempotencyKey: "w", agentId: worker, role: "worker" });
  return { ...f, taskId };
}

/** The id of the agent's one active assignment. */
const assignmentOf = (store: Store, agentId: string) =>
  String(store.assignments({ agentId }, "active")[0]?.id);

const activeOn = (store: Store, taskId: string) =>
  store.taskView(taskId)?.active.map((a) => a.role) ?? [];

describe("Tasks", () => {
  it("mails an assignee the brief and the command that reports it done", async () => {
    const { store, tasks, worker } = await taskFleet();
    const { taskId } = tasks.create(null, {
      idempotencyKey: "c",
      ...brief,
      assign: { agentId: worker, role: "worker" },
    });
    // Its first, the worker's prompt, comes because it wasn't launched as a worker.
    const mail = inbox(store, worker).at(-1);
    expect(mail).toContain("It fails on Node 26.");
    expect(mail).toContain(`bazhen task done ${taskId}`);
  });

  it("records nothing when the assignee takes no mail", async () => {
    const { store, tasks } = await taskFleet();
    const codex = newId("agent");
    const environmentId = String(store.snapshot(testView).environments[0]?.id);
    store.append({
      type: "agent.launched",
      entityId: codex,
      actor: "human",
      payload: { environmentId, harness: "codex", project: "p", cwd: "/w", terminalId: null },
    });
    const assign = { agentId: codex, role: "worker" as const };
    expect(() => tasks.create(null, { idempotencyKey: "c", ...brief, assign })).toThrow(
      UnknownAgent,
    );
    expect(store.snapshot(testView).tasks).toEqual([]);
  });

  it("hands an assignment's mail to the agent only once the command commits", async () => {
    const { store, mailbox, tasks, worker } = await taskFleet();
    let handed = false;
    void mailbox.wait(worker, new AbortController().signal).then(() => (handed = true));
    const assign = { agentId: worker, role: "worker" as const };
    expect(() =>
      store.transaction(() => {
        tasks.create(null, { idempotencyKey: "c", ...brief, assign });
        throw new Error("a later step fails");
      }),
    ).toThrow("a later step fails");
    await settled();
    expect([handed, inbox(store, worker)]).toEqual([false, []]);
  });

  it("neither assigns nor mails twice for a repeated request", async () => {
    const { store, tasks, worker } = await taskFleet();
    const req = {
      idempotencyKey: "c",
      ...brief,
      assign: { agentId: worker, role: "worker" as const },
    };
    const first = tasks.create(null, req);
    expect(tasks.create(null, req)).toEqual(first);
    // The worker's prompt and the brief, each once.
    expect([store.snapshot(testView).assignments.length, inbox(store, worker).length]).toEqual([
      1, 2,
    ]);
  });

  it("refuses a brief whose message would be longer than the mailbox takes, recording nothing", async () => {
    const { store, tasks, worker } = await taskFleet();
    const assign = { agentId: worker, role: "worker" as const };
    const long = { ...brief, brief: "x".repeat(19_950) };
    expect(refusal(() => tasks.create(null, { idempotencyKey: "c", ...long, assign }))).toBe(
      MailTooLong.name,
    );
    expect(store.snapshot(testView).tasks).toEqual([]);
  });

  it("refuses to give a task to a closed agent, and a closed agent's own commands", async () => {
    const { store, tasks, coordinator, worker } = await taskFleet();
    close(store, worker);
    const assign = { agentId: worker, role: "worker" as const };
    expect([
      refusal(() => tasks.create(null, { idempotencyKey: "c", ...brief, assign })),
      refusal(() => tasks.create(worker, { idempotencyKey: "w", ...brief })),
      refusal(() => tasks.create(coordinator, { idempotencyKey: "k", ...brief })),
    ]).toEqual([UnknownAgent.name, UnknownAgent.name, "allowed"]);
  });

  it("refuses a worker that tries to give its task to another agent", async () => {
    const { tasks, coordinator, worker } = await taskFleet();
    const { taskId } = tasks.create(null, {
      idempotencyKey: "c",
      ...brief,
      assign: { agentId: worker, role: "worker" },
    });
    const req = { idempotencyKey: "a", agentId: coordinator, role: "worker" as const };
    expect(refusal(() => tasks.assign(worker, taskId, req))).toBe("forbidden");
  });
});

describe("Tasks unassign", () => {
  it("ends everything granted under an unassigned lead, and tells each agent", async () => {
    const { store, tasks, coordinator, lead, worker, taskId } = await staffed();
    const leadAssignment = assignmentOf(store, lead);
    tasks.unassign(coordinator, taskId, { idempotencyKey: "u", assignmentId: leadAssignment });
    expect(activeOn(store, taskId)).toEqual(["coordinator"]);
    expect([inbox(store, lead).at(-1), inbox(store, worker).at(-1)]).toEqual([
      expect.stringContaining("no longer assigned"),
      expect.stringContaining("has ended"),
    ]);
  });

  it("lets a coordinator take back a worker its lead granted", async () => {
    const { store, tasks, coordinator, worker, taskId } = await staffed();
    const workerAssignment = assignmentOf(store, worker);
    tasks.unassign(coordinator, taskId, { idempotencyKey: "u", assignmentId: workerAssignment });
    expect(activeOn(store, taskId)).toEqual(["coordinator", "lead"]);
  });

  it("tells the agents a closing lead had granted work to that their work has ended", async () => {
    const { store, tasks, lead, worker, taskId } = await staffed();
    const stop = tasks.watch();
    close(store, lead);
    await settled();
    stop();
    expect(activeOn(store, taskId)).toEqual(["coordinator"]);
    expect(inbox(store, worker).at(-1)).toContain("has ended");
  });
});

describe("Tasks finish", () => {
  it("tells whoever gave a worker its part when the worker is done, and leaves the task open", async () => {
    const { store, tasks, lead, worker, taskId } = await staffed();
    tasks.finish(worker, taskId, { idempotencyKey: "f", outcome: "done", note: "Pinned Node." });
    expect(store.taskView(taskId)?.state).toBe("open");
    expect(inbox(store, lead).at(-1)).toContain(
      `${store.agent(worker)?.name} (${worker}) finished its part`,
    );
    expect(inbox(store, lead).at(-1)).toContain("Pinned Node.");
  });

  it("tells everyone still on a task its lead marked done, but not the lead", async () => {
    const { store, tasks, coordinator, lead, worker, taskId } = await staffed();
    const before = inbox(store, lead).length;
    tasks.finish(lead, taskId, { idempotencyKey: "f", outcome: "done" });
    expect([
      inbox(store, coordinator).at(-1),
      inbox(store, worker).at(-1),
      inbox(store, lead).length,
    ]).toEqual([
      expect.stringContaining(`marked done by ${store.agent(lead)?.name} (${lead})`),
      expect.stringContaining("marked done"),
      before,
    ]);
  });

  it("tells everyone still working on a cancelled task to stop", async () => {
    const { store, tasks, coordinator, worker } = await taskFleet();
    const { taskId } = tasks.create(coordinator, { idempotencyKey: "c", ...brief });
    tasks.assign(coordinator, taskId, { idempotencyKey: "a", agentId: worker, role: "worker" });
    tasks.finish(coordinator, taskId, { idempotencyKey: "f", outcome: "cancelled" });
    expect([inbox(store, worker).at(-1), inbox(store, coordinator)]).toEqual([
      expect.stringContaining("was cancelled"),
      [],
    ]);
  });

  it("finishes over open subtasks only when cancelling them with it, and tells their workers", async () => {
    const { store, tasks, coordinator, lead, taskId } = await staffed();
    const sub = tasks.create(coordinator, { idempotencyKey: "s", ...brief, parentTaskId: taskId });
    // The lead, since the worker already holds the one task a worker may.
    tasks.assign(coordinator, sub.taskId, {
      idempotencyKey: "sa",
      agentId: lead,
      role: "worker",
    });
    const finish = { idempotencyKey: "f", outcome: "done" as const };
    expect(refusal(() => tasks.finish(null, taskId, finish))).toBe("conflict");
    tasks.finish(null, taskId, { ...finish, idempotencyKey: "f2", cascade: true });
    expect([store.taskView(sub.taskId)?.state, store.taskView(taskId)?.state]).toEqual([
      "cancelled",
      "done",
    ]);
    expect(inbox(store, lead)).toContainEqual(expect.stringContaining(`Task ${sub.taskId}`));
  });

  it("refuses an agent's cascade that would cancel a subtask the human owns, naming it", async () => {
    const { store, tasks, coordinator, taskId } = await staffed();
    const sub = tasks.create(null, { idempotencyKey: "s", ...brief, parentTaskId: taskId });
    const cascade = { idempotencyKey: "f", outcome: "done" as const, cascade: true };
    expect(() => tasks.finish(coordinator, taskId, cascade)).toThrow(sub.taskId);
    expect([store.taskView(sub.taskId)?.state, store.taskView(taskId)?.state]).toEqual([
      "open",
      "open",
    ]);
  });

  it("refuses a subtask under a finished task", async () => {
    const { tasks, taskId } = await staffed();
    tasks.finish(null, taskId, { idempotencyKey: "f", outcome: "cancelled" });
    const req = { idempotencyKey: "s", ...brief, parentTaskId: taskId };
    expect(refusal(() => tasks.create(null, req))).toBe("conflict");
  });
});

describe("roles, as their definitions say", () => {
  it("refuses a worker a second task while it holds one, and takes it once the first is done", async () => {
    const { tasks, worker } = await taskFleet();
    const assign = { agentId: worker, role: "worker" as const };
    const first = tasks.create(null, { idempotencyKey: "c1", ...brief, assign });
    const second = () => tasks.create(null, { idempotencyKey: "c2", ...brief, assign });
    expect(refusal(second)).toBe("conflict");
    tasks.finish(worker, first.taskId, { idempotencyKey: "d", outcome: "done" });
    expect(refusal(second)).toBe("allowed");
  });

  it("frees a worker's one task when it is unassigned, so it can take another", async () => {
    const { store, tasks, worker } = await taskFleet();
    const assign = { agentId: worker, role: "worker" as const };
    const first = tasks.create(null, { idempotencyKey: "c1", ...brief, assign });
    const second = () => tasks.create(null, { idempotencyKey: "c2", ...brief, assign });
    expect(refusal(second)).toBe("conflict");
    const assignmentId = assignmentOf(store, worker);
    tasks.unassign(null, first.taskId, { idempotencyKey: "u", assignmentId });
    expect(refusal(second)).toBe("allowed");
  });

  it("counts only an agent's tasks in the same role toward that role's limit", async () => {
    const { tasks, lead } = await taskFleet();
    const as = (role: string, key: string) => () =>
      tasks.create(null, { idempotencyKey: key, ...brief, assign: { agentId: lead, role } });
    as("lead", "c1")();
    expect(refusal(as("worker", "c2"))).toBe("allowed");
  });

  it("refuses a role no definition has, naming where the roles are listed", async () => {
    const { tasks, worker } = await taskFleet();
    const assign = { agentId: worker, role: "auditor" };
    expect(() => tasks.create(null, { idempotencyKey: "c", ...brief, assign })).toThrow(
      new UnknownRole("auditor"),
    );
  });

  it("hands on what the user's definition grants, and says so in the brief", async () => {
    const f = await taskFleet();
    const lead = {
      key: "lead",
      title: "Lead",
      description: "",
      grants: ["reviewer"],
      singlePerTask: true,
      maxActiveTasks: null,
      prompt: "Lead.",
      source: "user" as const,
    };
    const custom = resolveRoles(builtinRoles(), [{ file: "lead.md", role: lead }]).book;
    const tasks = new Tasks(
      f.store,
      f.mailbox,
      () => newId("attn"),
      f.launcher,
      () => custom,
    );
    const assign = { agentId: f.lead, role: "lead" };
    const { taskId } = tasks.create(null, { idempotencyKey: "c", ...brief, assign });
    const give = (role: string) => () =>
      tasks.assign(f.lead, taskId, { idempotencyKey: role, agentId: f.worker, role });
    expect([refusal(give("worker")), refusal(give("reviewer"))]).toEqual(["forbidden", "allowed"]);
    expect(inbox(f.store, f.lead).at(-1)).toContain("as a reviewer");
  });
});
