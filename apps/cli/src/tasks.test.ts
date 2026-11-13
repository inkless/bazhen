import { describe, expect, it } from "vitest";
import type { StateSnapshot } from "@bazhen/protocol";
import { listTasks, showTask, taskVerb, Usage, type Context, type Verb } from "./tasks.ts";

const AGENT = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const OTHER = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";
const TASK = "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const TASK2 = "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";

const ctx = (agentId?: string): Context => ({
  agentId,
  readFile: (path) => `brief from ${path}`,
  key: () => "key",
});

const task = (id: string, title: string) => ({
  id,
  title,
  state: "open" as const,
  ownerAgentId: null,
  parentTaskId: null,
});
const assigned = (taskId: string, agentId: string) => ({
  id: `asgn_${taskId.slice(5)}`,
  taskId,
  agentId,
  role: "worker" as const,
  parentAssignmentId: null,
  state: "active" as const,
  endReason: null,
});
const snapshot = (tasks: StateSnapshot["tasks"], assignments: StateSnapshot["assignments"]) =>
  ({
    epoch: "e",
    eventId: 1,
    environments: [],
    agents: [],
    attention: [],
    messages: [],
    shells: [],
    tasks,
    assignments,
  }) satisfies StateSnapshot;

/** The call the verb's answer to `reply` leads to, as path and body; what it prints, if it prints. */
const after = (verb: Verb, reply: unknown) => {
  const next = verb.answer(reply);
  return typeof next === "string" ? next : [next.call.path, next.call.body];
};
const usage = (argv: string[], context = ctx()) => {
  try {
    taskVerb(argv, context);
  } catch (err) {
    if (err instanceof Usage) return err.message;
    throw err;
  }
  return "accepted";
};

describe("bazhen task verbs", () => {
  it("delegates as a worker unless told otherwise, from the task named", () => {
    const verb = taskVerb(
      ["delegate", OTHER, "--title", "t", "--brief", "b", "--task", TASK],
      ctx(AGENT),
    );
    expect([verb.call.path, verb.call.body]).toEqual([
      "/v1/tasks/delegate",
      {
        idempotencyKey: "key",
        agentId: OTHER,
        role: "worker",
        title: "t",
        brief: "b",
        fromTaskId: TASK,
      },
    ]);
  });

  it("escalates the words given as one question, about the task named", () => {
    const verb = taskVerb(["escalate", "Pin", "24", "or", "26?", "--task", TASK], ctx(AGENT));
    expect([verb.call.path, verb.call.body]).toEqual([
      "/v1/escalations",
      { idempotencyKey: "key", summary: "Pin 24 or 26?", taskId: TASK },
    ]);
  });

  it("reads a brief from a file", () => {
    const verb = taskVerb(["task", "create", "--title", "t", "--brief-file", "plan.md"], ctx());
    expect(verb.call.body).toMatchObject({ brief: "brief from plan.md" });
  });

  it("refuses a brief given both ways, and an option it doesn't know, as usage", () => {
    expect([
      usage(["task", "create", "--title", "t", "--brief", "b", "--brief-file", "f"]),
      usage(["task", "list", "--everything"]),
    ]).toEqual([expect.stringContaining("not both"), expect.stringContaining("--everything")]);
  });

  it("finishes an agent's only task when none is named", () => {
    const verb = taskVerb(["task", "done", "--note", "n"], ctx(AGENT));
    const next = after(
      verb,
      snapshot([task(TASK, "a")], [assigned(TASK, AGENT), assigned(TASK2, OTHER)]),
    );
    expect(next).toEqual([
      `/v1/tasks/${TASK}/finish`,
      { idempotencyKey: "key", outcome: "done", note: "n" },
    ]);
  });

  it("asks which task to finish when the agent has several", () => {
    const verb = taskVerb(["task", "done"], ctx(AGENT));
    const state = snapshot([], [assigned(TASK, AGENT), assigned(TASK2, AGENT)]);
    expect(() => after(verb, state)).toThrow(`name one of ${TASK}, ${TASK2}`);
  });

  it("lists only the asking agent's own tasks", () => {
    const state = snapshot(
      [task(TASK, "mine"), task(TASK2, "theirs")],
      [assigned(TASK, AGENT), assigned(TASK2, OTHER)],
    );
    expect(listTasks(state, AGENT)).toBe(`${TASK}  mine  [worker ${AGENT}]`);
  });

  it("shows a finished task's note after its brief", () => {
    const detail = {
      ...task(TASK, "t"),
      state: "done" as const,
      brief: "b",
      note: "shipped",
      assignments: [],
      subtasks: [],
    };
    expect(showTask(detail).split("\n").slice(-3)).toEqual(["b", "", "note: shipped"]);
  });
});
