import { describe, expect, it } from "vitest";
import type { Assignment, Role, StateSnapshot, Task } from "@bazhen/protocol";
import {
  agentTasks,
  holdersOf,
  launcherOf,
  openSubtasksUnder,
  taskTree,
  type TaskNode,
} from "./model.ts";

const AGENT = "agent_0190000000007000800000000000a001";
const OTHER = "agent_0190000000007000800000000000a002";
const id = (n: number) => `task_0190000000007000800000000000${String(n).padStart(4, "0")}`;

const task = (n: number, parent: number | null = null, state: Task["state"] = "open"): Task => ({
  id: id(n),
  title: `task ${n}`,
  state,
  ownerAgentId: null,
  parentTaskId: parent === null ? null : id(parent),
});
const on = (n: number, agentId: string, role: Role, state: Assignment["state"] = "active") => ({
  id: `asgn_0190000000007000800000000000${String(n).padStart(2, "0")}${role.length}${agentId.slice(-1)}`,
  taskId: id(n),
  agentId,
  role,
  parentAssignmentId: null,
  state,
  endReason: state === "active" ? null : ("unassigned" as const),
});
/** The tree as each task's id with its subtasks', for comparing shapes. */
const shape = (nodes: readonly TaskNode[]): unknown[] =>
  nodes.map((n) => (n.children.length === 0 ? n.task.id : [n.task.id, shape(n.children)]));

const snapshot = (tasks: Task[], assignments: Assignment[]): StateSnapshot => ({
  epoch: "e",
  eventId: 1,
  environments: [],
  agents: [],
  attention: [],
  messages: [],
  shells: [],
  tasks,
  assignments,
});

describe("the task list", () => {
  it("puts each subtask under its parent, and leaves finished ones out", () => {
    const state = snapshot([task(1), task(2), task(3, 1), task(4, 1, "done"), task(5, 3)], []);
    expect(shape(taskTree(state))).toEqual([[id(1), [[id(3), [id(5)]]]], id(2)]);
  });

  it("shows a subtask whose parent is finished at the top, rather than not at all", () => {
    const state = snapshot([task(1, null, "done"), task(2, 1)], []);
    expect(shape(taskTree(state))).toEqual([id(2)]);
  });

  it("names who is on a task now, coordinator first, and not who was", () => {
    const state = snapshot(
      [task(1)],
      [on(1, OTHER, "worker"), on(1, AGENT, "coordinator"), on(1, OTHER, "lead", "ended")],
    );
    expect(holdersOf(state, id(1)).map((h) => [h.agentId, h.role])).toEqual([
      [AGENT, "coordinator"],
      [OTHER, "worker"],
    ]);
  });
});

describe("cancelling with subtasks", () => {
  it("counts every open task below, however deep and under a finished one, as the daemon does", () => {
    const state = snapshot(
      [task(1), task(2, 1), task(3, 2, "done"), task(4, 3), task(5, 1, "cancelled"), task(6)],
      [],
    );
    expect(openSubtasksUnder(state, id(1)).map((t) => t.id)).toEqual([id(2), id(4)]);
  });
});

describe("an agent's tasks", () => {
  it("lists the open tasks it is on, with its role, and not finished ones", () => {
    const state = snapshot(
      [task(1), task(2, null, "done"), task(3)],
      [on(1, AGENT, "lead"), on(2, AGENT, "worker"), on(3, OTHER, "worker")],
    );
    expect(agentTasks(state, AGENT).map((t) => [t.task.id, t.role])).toEqual([[id(1), "lead"]]);
  });
});

/** An agent with only what `launcherOf` reads. */
const launchedAgent = (agentId: string, project: string, launchedBy: string | null) => ({
  id: agentId,
  project,
  launchedBy,
});

describe("who launched an agent", () => {
  it("names the agent that launched it, and no one for an agent the human launched", () => {
    const state = {
      agents: [launchedAgent(AGENT, "web", null), launchedAgent(OTHER, "api", AGENT)],
    };
    expect([launcherOf(state, OTHER), launcherOf(state, AGENT)]).toEqual([
      { id: AGENT, project: "web" },
      null,
    ]);
  });
});
