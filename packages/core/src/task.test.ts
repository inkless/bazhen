import * as fc from "fast-check";
import type { Role } from "@bazhen/protocol";
import { describe, expect, it } from "vitest";
import { newId, type AgentSessionId, type AssignmentId } from "./ids.ts";
import { InvalidTransition } from "./machine.ts";
import {
  assignment,
  checkDelegate,
  checkFinish,
  checkGrant,
  checkUnassign,
  task,
  TaskRefused,
  type ActiveAssignment,
  type Caller,
  type TaskView,
} from "./task.ts";

const [A, B, C, D] = [newId("agent"), newId("agent"), newId("agent"), newId("agent")];
const AGENTS = [A, B, C, D];

const asgn = (
  agentId: AgentSessionId,
  role: Role,
  parent: AssignmentId | null = null,
): ActiveAssignment => ({ id: newId("asgn"), agentId, role, parentAssignmentId: parent });

const open = (
  active: ActiveAssignment[],
  ownerAgentId: AgentSessionId | null = null,
  openSubtasks: string[] = [],
) => ({ state: "open", ownerAgentId, active, openSubtasks }) satisfies TaskView;

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof TaskRefused) return error.code;
    throw error;
  }
  return "allowed";
};

describe("task and assignment states", () => {
  it("refuses to finish a task twice, whichever way it first ended", () => {
    expect(() => task.next(task.next("open", "cancelled"), "done")).toThrow(InvalidTransition);
  });

  it("ends an assignment once, so a task finishing after its agent closed changes nothing", () => {
    expect(() =>
      assignment.next(assignment.next("active", "agent_closed"), "task_finished"),
    ).toThrow(InvalidTransition);
  });
});

describe("who may assign", () => {
  it("lets a coordinator grant a lead and a worker, but never another coordinator", () => {
    const coord = asgn(A, "coordinator");
    const view = open([coord]);
    expect(checkGrant(view, A, { agentId: B, role: "lead" })).toBe(coord.id);
    expect(refusal(() => checkGrant(view, A, { agentId: B, role: "coordinator" }))).toBe(
      "forbidden",
    );
  });

  it("lets a lead grant only workers, and a worker nothing", () => {
    const view = open([asgn(A, "lead"), asgn(B, "worker")]);
    expect(refusal(() => checkGrant(view, A, { agentId: C, role: "worker" }))).toBe("allowed");
    expect(refusal(() => checkGrant(view, A, { agentId: C, role: "lead" }))).toBe("forbidden");
    expect(refusal(() => checkGrant(view, B, { agentId: C, role: "worker" }))).toBe("forbidden");
  });

  it("lets the agent that created a task grant as its coordinator would, from no assignment", () => {
    const view = open([], A);
    expect(checkGrant(view, A, { agentId: B, role: "lead" })).toBeNull();
    expect(refusal(() => checkGrant(view, A, { agentId: B, role: "coordinator" }))).toBe(
      "forbidden",
    );
  });

  it("refuses a second lead while one is active, but takes any number of workers", () => {
    const view = open([asgn(A, "lead"), asgn(B, "worker")]);
    expect(refusal(() => checkGrant(view, null, { agentId: C, role: "lead" }))).toBe("conflict");
    expect(refusal(() => checkGrant(view, null, { agentId: C, role: "worker" }))).toBe("allowed");
  });

  it("refuses to assign anyone to a finished task", () => {
    const view: TaskView = { state: "done", ownerAgentId: null, active: [], openSubtasks: [] };
    expect(refusal(() => checkGrant(view, null, { agentId: A, role: "worker" }))).toBe("conflict");
  });
});

describe("who may delegate", () => {
  it("refuses a worker that would own the subtask it hands on", () => {
    expect(refusal(() => checkDelegate(open([asgn(A, "worker")]), A, "worker"))).toBe("forbidden");
  });

  it("delegates from the lead's own assignment, so the subtask's worker answers to it", () => {
    const lead = asgn(A, "lead");
    expect(checkDelegate(open([lead]), A, "worker")).toBe(lead.id);
  });
});

describe("who may unassign", () => {
  it("lets a coordinator take back a worker its lead granted, and no agent outside that line", () => {
    const coord = asgn(A, "coordinator");
    const lead = asgn(B, "lead", coord.id);
    const worker = asgn(C, "worker", lead.id);
    const view = open([coord, lead, worker]);
    expect(refusal(() => checkUnassign(view, A, worker.id, [B, A]))).toBe("allowed");
    expect(refusal(() => checkUnassign(view, D, worker.id, [B, A]))).toBe("forbidden");
  });
});

describe("who may finish", () => {
  it("lets a lead finish the task, but makes a worker's done complete only its own part", () => {
    const worker = asgn(B, "worker");
    const view = open([asgn(A, "lead"), worker]);
    expect([checkFinish(view, A, "done", false), checkFinish(view, B, "done", false)]).toEqual([
      { kind: "task" },
      { kind: "assignment", assignment: worker },
    ]);
  });

  it("refuses a worker that cancels, and an agent with no part in the task", () => {
    const view = open([asgn(B, "worker")], A);
    expect([
      refusal(() => checkFinish(view, B, "cancelled", false)),
      refusal(() => checkFinish(view, C, "done", false)),
    ]).toEqual(["forbidden", "forbidden"]);
  });

  it("lets a coordinator mark the human's task done, but not cancel it", () => {
    const view = open([asgn(A, "coordinator")]);
    expect([
      refusal(() => checkFinish(view, A, "done", false)),
      refusal(() => checkFinish(view, A, "cancelled", false)),
      refusal(() => checkFinish(view, null, "cancelled", false)),
    ]).toEqual(["allowed", "forbidden", "allowed"]);
  });

  it("refuses to finish over open subtasks unless they are cancelled with it", () => {
    const view = open([], A, ["task_sub"]);
    expect(refusal(() => checkFinish(view, A, "done", false))).toBe("conflict");
    expect(checkFinish(view, A, "done", true)).toEqual({ kind: "task" });
  });
});

type Command =
  | { kind: "grant"; caller: Caller; agentId: AgentSessionId; role: Role }
  | { kind: "unassign"; caller: Caller; index: number };

const callers: fc.Arbitrary<Caller> = fc.constantFrom(null, ...AGENTS);
const commands = fc.array(
  fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("grant" as const),
        caller: callers,
        agentId: fc.constantFrom(...AGENTS),
        role: fc.constantFrom<Role>("coordinator", "lead", "worker"),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("unassign" as const),
        caller: callers,
        index: fc.nat(5),
      }),
    },
  ),
  { maxLength: 30 },
);

interface Granted extends ActiveAssignment {
  readonly by: Caller;
}

/** The assignment the rules let `c` grant from, or undefined when they refuse it. */
function tryGrant(view: TaskView, c: Extract<Command, { kind: "grant" }>) {
  try {
    return checkGrant(view, c.caller, c);
  } catch (error) {
    if (error instanceof TaskRefused) return undefined;
    throw error;
  }
}

/** The agents `a` was granted under, nearest first, as the store reads them. */
function grantersOf(active: readonly Granted[], a: Granted): AgentSessionId[] {
  const parent = active.find((p) => p.id === a.parentAssignmentId);
  return parent === undefined ? [] : [parent.agentId, ...grantersOf(active, parent)];
}

/** Removes `a` and everything granted under it, as ending an assignment does. */
function withoutLine(active: readonly Granted[], a: Granted): Granted[] {
  const under = active.filter((x) => x.parentAssignmentId === a.id);
  return under.reduce(
    (rest, x) => withoutLine(rest, x),
    active.filter((x) => x !== a),
  );
}

/** Applies each command the rules allow, as the daemon would, and returns every state seen. */
function run(owner: AgentSessionId | null, list: Command[]): Granted[][] {
  let active: Granted[] = [];
  const seen: Granted[][] = [];
  for (const c of list) {
    const view = open(active, owner);
    if (c.kind === "grant") {
      const parent = tryGrant(view, c);
      if (parent !== undefined)
        active = [...active, { ...asgn(c.agentId, c.role, parent), by: c.caller }];
    } else {
      const target = active[c.index % Math.max(active.length, 1)];
      if (
        target !== undefined &&
        refusal(() => checkUnassign(view, c.caller, target.id, grantersOf(active, target))) ===
          "allowed"
      ) {
        active = withoutLine(active, target);
      }
    }
    seen.push(active);
  }
  return seen;
}

const atMostOne = (active: readonly ActiveAssignment[], role: Role) =>
  active.filter((a) => a.role === role).length <= 1;
const eachAgentOnce = (active: readonly ActiveAssignment[]) =>
  new Set(active.map((a) => a.agentId)).size === active.length;

const singleHolders = (owner: AgentSessionId | null, list: Command[]) =>
  run(owner, list).every(
    (active) =>
      atMostOne(active, "coordinator") && atMostOne(active, "lead") && eachAgentOnce(active),
  );

const coordinatorsFromHuman = (list: Command[]) =>
  run(D, list).every((active) => active.every((a) => a.role !== "coordinator" || a.by === null));

describe("assignment invariants over any sequence of commands", () => {
  it("never holds two coordinators, two leads, or one agent twice", () => {
    expect(() =>
      fc.assert(fc.property(fc.constantFrom(null, A), commands, singleHolders)),
    ).not.toThrow();
  });

  it("makes coordinators only on the human's word", () => {
    expect(() => fc.assert(fc.property(commands, coordinatorsFromHuman))).not.toThrow();
  });
});
