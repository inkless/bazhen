import type {
  AssignmentEndReason,
  AssignmentState,
  Role,
  TaskOutcome,
  TaskState,
} from "@bazhen/protocol";
import type { AgentSessionId, AssignmentId } from "./ids.ts";
import { machine } from "./machine.ts";

export const task = machine<TaskState, TaskOutcome>("task", {
  open: { done: "done", cancelled: "cancelled" },
  done: {},
  cancelled: {},
});

export const assignment = machine<AssignmentState, AssignmentEndReason>("assignment", {
  active: {
    unassigned: "ended",
    completed: "ended",
    task_finished: "ended",
    agent_closed: "ended",
    parent_ended: "ended",
  },
  ended: {},
});

/** Who a command comes from: an agent, by its id, or the human, as `null`. */
export type Caller = AgentSessionId | null;

export interface ActiveAssignment {
  readonly id: AssignmentId;
  readonly agentId: AgentSessionId;
  readonly role: Role;
  readonly parentAssignmentId: AssignmentId | null;
}

/** An open or finished task, with the assignments still active on it. */
export interface TaskView {
  readonly state: TaskState;
  readonly ownerAgentId: AgentSessionId | null;
  readonly active: readonly ActiveAssignment[];
  /** Its subtasks still open, which keep it from finishing unless they are cancelled with it. */
  readonly openSubtasks: readonly string[];
}

/** `forbidden`: the caller may not do this. `conflict`: nobody may, while the task is as it is. */
export class TaskRefused extends Error {
  readonly code: "forbidden" | "conflict";

  constructor(code: "forbidden" | "conflict", message: string) {
    super(message);
    this.code = code;
  }
}

/** Only one agent at a time coordinates a task, and only one leads it. */
const SINGLE: ReadonlySet<Role> = new Set<Role>(["coordinator", "lead"]);

/**
 * The roles each holder may hand on. A worker hands on nothing: it escalates instead. Only the
 * human makes a coordinator, so an agent never promotes another to its own standing.
 */
const GRANTS: Readonly<Record<Role, readonly Role[]>> = {
  coordinator: ["lead", "worker"],
  lead: ["worker"],
  worker: [],
};

/**
 * The assignment a caller grants from on a task, or null for the human. The agent that created
 * the task grants as its coordinator would, without holding the role.
 */
export function grantingAssignment(view: TaskView, caller: Caller): ActiveAssignment | null {
  if (caller === null) return null;
  const held = view.active.filter((a) => a.agentId === caller && GRANTS[a.role].length > 0);
  const strongest = held.find((a) => a.role === "coordinator") ?? held[0];
  if (strongest !== undefined) return strongest;
  if (view.ownerAgentId === caller) return null;
  throw new TaskRefused("forbidden", "only the task's coordinator, lead or owner can assign it");
}

const ALL_ROLES: readonly Role[] = ["coordinator", "lead", "worker"];

/** Checks that `caller` may hand the role on from the open task, and returns what it grants from. */
function checkHandOn(view: TaskView, caller: Caller, role: Role): ActiveAssignment | null {
  if (view.state !== "open") throw new TaskRefused("conflict", `the task is ${view.state}`);
  const from = grantingAssignment(view, caller);
  const grantable =
    caller === null ? ALL_ROLES : from === null ? GRANTS.coordinator : GRANTS[from.role];
  if (!grantable.includes(role)) {
    throw new TaskRefused("forbidden", `${callerName(caller)} can't make an agent ${role}`);
  }
  return from;
}

/**
 * Checks that the agent may delegate part of `parent` as a subtask, with the role, and returns
 * the assignment the subtask's assignee is delegated from. Its authority comes from the parent:
 * the subtask is new and the delegating agent owns it, which would otherwise let a worker hand
 * on what it was given.
 */
export function checkDelegate(
  parent: TaskView,
  caller: AgentSessionId,
  role: Role,
): AssignmentId | null {
  return checkHandOn(parent, caller, role)?.id ?? null;
}

/**
 * Checks that `caller` may give `agentId` the role on the task, and returns the assignment the
 * new one is delegated from: null when the human or the task's owner grants it.
 */
export function checkGrant(
  view: TaskView,
  caller: Caller,
  grant: { readonly agentId: AgentSessionId; readonly role: Role },
): AssignmentId | null {
  const from = checkHandOn(view, caller, grant.role);
  if (view.active.some((a) => a.agentId === grant.agentId)) {
    throw new TaskRefused("conflict", `${grant.agentId} is already assigned to the task`);
  }
  const holder = view.active.find((a) => SINGLE.has(grant.role) && a.role === grant.role);
  if (holder !== undefined) {
    throw new TaskRefused("conflict", `${holder.agentId} is already the task's ${grant.role}`);
  }
  return from?.id ?? null;
}

/**
 * Checks that `caller` may take the assignment away: the human, the task's owner, or an agent the
 * assignment was granted under, however far up: a coordinator reaches the workers its leads
 * granted. `granters` are the agents of the assignment's ancestors, nearest first.
 */
export function checkUnassign(
  view: TaskView,
  caller: Caller,
  assignmentId: string,
  granters: readonly AgentSessionId[],
): void {
  if (!view.active.some((a) => a.id === assignmentId)) {
    throw new TaskRefused("conflict", `${assignmentId} is not active`);
  }
  if (caller === null || view.ownerAgentId === caller || granters.includes(caller)) return;
  throw new TaskRefused(
    "forbidden",
    "only an agent it was granted under, the owner or the human can unassign it",
  );
}

/** Finishing ends the task, or, for a worker, only the worker's own part in it. */
export type Finish =
  | { readonly kind: "task" }
  | { readonly kind: "assignment"; readonly assignment: ActiveAssignment };

/**
 * What `caller` finishing the task does. The human, its owner, its coordinator or its lead
 * finishes the task, except that only the human cancels a task the human owns; a worker's `done` completes only its own assignment, since others may still
 * be working on the task. A task with open subtasks finishes only when told to cancel them with
 * it (`cascade`), so no subtask outlives the work it was part of.
 */
export function checkFinish(
  view: TaskView,
  caller: Caller,
  outcome: TaskOutcome,
  cascade: boolean,
): Finish {
  if (view.state !== "open") throw new TaskRefused("conflict", `the task is already ${view.state}`);
  if (outcome === "cancelled" && view.ownerAgentId === null && caller !== null) {
    throw new TaskRefused("forbidden", "the human's task: only the human cancels it");
  }
  const mine = view.active.filter((a) => a.agentId === caller);
  const runsIt =
    caller === null || view.ownerAgentId === caller || mine.some((a) => a.role !== "worker");
  if (!runsIt) {
    const own = mine[0];
    if (own !== undefined && outcome === "done") return { kind: "assignment", assignment: own };
    const who = "its owner, coordinator, lead or the human";
    throw new TaskRefused("forbidden", `only ${who} can mark the task ${outcome}`);
  }
  if (view.openSubtasks.length > 0 && !cascade) {
    throw new TaskRefused(
      "conflict",
      `the task has open subtasks (${view.openSubtasks.join(", ")}): finish them first, or cancel them with it`,
    );
  }
  return { kind: "task" };
}

const callerName = (caller: Caller) => (caller === null ? "the human" : `agent ${caller}`);
