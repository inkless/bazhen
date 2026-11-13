import { z } from "zod";
import { Id, IdempotencyKey } from "./ids.ts";

/** What an assignment lets its agent do on its task (foundation-design §3). */
export const Role = z.enum(["coordinator", "lead", "worker"]);
export type Role = z.infer<typeof Role>;

export const TaskState = z.enum(["open", "done", "cancelled"]);
export type TaskState = z.infer<typeof TaskState>;

/** How a task ended: the states it can finish in. */
export const TaskOutcome = TaskState.exclude(["open"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

export const AssignmentState = z.enum(["active", "ended"]);
export type AssignmentState = z.infer<typeof AssignmentState>;

/**
 * Why an assignment ended: taken away, its worker's part done, its task finished, its agent
 * closed (§4.5), or the assignment it was granted under ended.
 */
export const AssignmentEndReason = z.enum([
  "unassigned",
  "completed",
  "task_finished",
  "agent_closed",
  "parent_ended",
]);
export type AssignmentEndReason = z.infer<typeof AssignmentEndReason>;

/** The instructions an assignee is mailed, so no longer than a message may be. */
export const TaskBrief = z.string().min(1).max(20_000);
export const TaskTitle = z.string().trim().min(1).max(200);

/** A task as the state snapshot shows it: without its brief or note, which only its own read has. */
export const Task = z.object({
  id: Id("task"),
  title: z.string(),
  state: TaskState,
  /** The agent that created it, or null when the human did. */
  ownerAgentId: Id("agent").nullable(),
  parentTaskId: Id("task").nullable(),
});
export type Task = z.infer<typeof Task>;

export const Assignment = z.object({
  id: Id("asgn"),
  taskId: Id("task"),
  agentId: Id("agent"),
  role: Role,
  /** The assignment it was delegated from; null when the human assigned it. */
  parentAssignmentId: Id("asgn").nullable(),
  state: AssignmentState,
  endReason: AssignmentEndReason.nullable(),
});
export type Assignment = z.infer<typeof Assignment>;

/** `GET /v1/tasks/:id`: the task in full, with its assignments and subtasks. */
export const TaskDetail = Task.extend({
  brief: z.string(),
  /** What the agent or human who finished it said; null while it is open or when none was given. */
  note: z.string().nullable(),
  assignments: z.array(Assignment),
  subtasks: z.array(Task),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

const Grant = z.object({ agentId: Id("agent"), role: Role });

/** `POST /v1/tasks`. Assigning in the same request mails the brief, or refuses the whole create. */
export const CreateTaskRequest = z.object({
  idempotencyKey: IdempotencyKey,
  title: TaskTitle,
  brief: TaskBrief,
  parentTaskId: Id("task").optional(),
  assign: Grant.optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const CreateTaskResponse = z.object({
  taskId: Id("task"),
  /** Null when the request assigned no one. */
  assignmentId: Id("asgn").nullable(),
  eventIds: z.array(z.number().int().positive()),
});
export type CreateTaskResponse = z.infer<typeof CreateTaskResponse>;

/** `POST /v1/tasks/:id/assign`. */
export const AssignTaskRequest = Grant.extend({ idempotencyKey: IdempotencyKey });
export type AssignTaskRequest = z.infer<typeof AssignTaskRequest>;

export const AssignTaskResponse = z.object({
  assignmentId: Id("asgn"),
  eventIds: z.array(z.number().int().positive()),
});
export type AssignTaskResponse = z.infer<typeof AssignTaskResponse>;

/** `POST /v1/tasks/:id/unassign`. */
export const UnassignTaskRequest = z.object({
  idempotencyKey: IdempotencyKey,
  assignmentId: Id("asgn"),
});
export type UnassignTaskRequest = z.infer<typeof UnassignTaskRequest>;

/**
 * `POST /v1/tasks/:id/finish`: marks it done or cancelled, ending its assignments; from a worker,
 * `done` completes only its own assignment. `cascade` cancels its open subtasks with it, which it
 * otherwise refuses to finish over.
 */
export const FinishTaskRequest = z.object({
  idempotencyKey: IdempotencyKey,
  outcome: TaskOutcome,
  note: z.string().max(20_000).optional(),
  cascade: z.boolean().optional(),
});
export type FinishTaskRequest = z.infer<typeof FinishTaskRequest>;

export const TaskCommandResponse = z.object({
  eventIds: z.array(z.number().int().positive()),
});
export type TaskCommandResponse = z.infer<typeof TaskCommandResponse>;

/**
 * `POST /v1/tasks/delegate`, an agent's verb: a subtask of a task it coordinates or leads, given
 * to another agent. With no `fromTaskId`, the caller's only such task is the parent.
 */
export const DelegateTaskRequest = z.object({
  idempotencyKey: IdempotencyKey,
  fromTaskId: Id("task").optional(),
  agentId: Id("agent"),
  role: Role.exclude(["coordinator"]).default("worker"),
  title: TaskTitle,
  brief: TaskBrief,
});
export type DelegateTaskRequest = z.infer<typeof DelegateTaskRequest>;
