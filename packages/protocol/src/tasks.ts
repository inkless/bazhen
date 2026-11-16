import { z } from "zod";
import { AgentName, AgentRef } from "./agent-name.ts";
import { hasLoneSurrogate } from "./holder.ts";
import { HarnessId, Id, IdempotencyKey } from "./ids.ts";
import { Role } from "./roles.ts";
import { INVISIBLE, showable, TAG_CHARACTERS } from "./text.ts";

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

export const TASK_NOTE_MAX_BYTES = 4000;

const encoder = new TextEncoder();

/** Newline and tab, the only controls a note may hold. */
const NOTE_CONTROLS: ReadonlySet<number> = new Set([0x0a, 0x09]);

/** Whether text is fit for a note: only newline and tab of the controls, and nothing invisible. */
const noteSafe = (text: string) =>
  showable(text, NOTE_CONTROLS) &&
  !hasLoneSurrogate(text) &&
  !INVISIBLE.test(text) &&
  !TAG_CHARACTERS.test(text);

/**
 * What a note says. It is drawn as an agent's headline in a terminal, the web and mail, and read
 * by the next assignee's model, so it holds no control character but newline and tab, no
 * bidirectional override, and nothing that draws as nothing.
 */
export const TaskNoteText = z
  .string()
  .trim()
  .min(1)
  .refine((text) => encoder.encode(text).length <= TASK_NOTE_MAX_BYTES, {
    message: `a note is at most ${TASK_NOTE_MAX_BYTES} UTF-8 bytes`,
  })
  .refine(noteSafe, {
    message: "a note can't hold control characters but newline and tab, or invisible characters",
  })
  .describe(`At most ${TASK_NOTE_MAX_BYTES} UTF-8 bytes.`);

/**
 * What the agent or human who finishes a task says of it (protocol 1.44). It is mailed to whoever
 * gave the task out, so it holds what a task note may, at a message's length. Only requests are
 * held to it: a note stored before keeps loading.
 */
export const FinishNoteText = z.string().max(20_000).refine(noteSafe, {
  message: "a note can't hold control characters but newline and tab, or invisible characters",
});

/**
 * Every line of a note marked as quoted, as a brief and `task show` print it, so no line of it
 * can pass for Bazhen's own text around it: not a header, not the line that ends the note, not a
 * command to run.
 */
export const quoteNote = (text: string) =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/** A note on a task, from the agent working it or the human: progress, or a handoff (1.44). */
export const TaskNote = z.object({
  /** The event that recorded it, which orders notes. */
  eventId: z.number().int().positive(),
  taskId: Id("task"),
  /** Null when the human wrote it. */
  agentId: Id("agent").nullable(),
  /**
   * The role its agent held on the task when it wrote it; null for the human, and for an agent
   * that held none there, which writes as the task's owner.
   */
  role: Role.nullable(),
  text: z.string(),
  /**
   * For whoever is assigned the task next: the brief of the next grant carries the latest one
   * written since the grant before it.
   */
  handoff: z.boolean(),
  at: z.iso.datetime(),
});
export type TaskNote = z.infer<typeof TaskNote>;

/** `POST /v1/tasks/:id/notes` (protocol 1.44). */
export const AddTaskNoteRequest = z.object({
  idempotencyKey: IdempotencyKey,
  text: TaskNoteText,
  handoff: z.boolean().optional(),
});
export type AddTaskNoteRequest = z.infer<typeof AddTaskNoteRequest>;

/** `GET /v1/tasks/:id`: the task in full, with its assignments and subtasks. */
export const TaskDetail = Task.extend({
  brief: z.string(),
  /** What the agent or human who finished it said; null while it is open or when none was given. */
  note: z.string().nullable(),
  assignments: z.array(Assignment),
  subtasks: z.array(Task),
  /** Oldest first (protocol 1.44). */
  notes: z.array(TaskNote).default([]),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/** The agent by id or, from protocol 1.40, by name. */
const Grant = z.object({ agentId: AgentRef, role: Role });

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
  note: FinishNoteText.optional(),
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
export const DelegateTaskRequest = z
  .object({
    idempotencyKey: IdempotencyKey,
    fromTaskId: Id("task").optional(),
    /** The agent to give the subtask to, by id or name; or, with `launch`, none yet. */
    agentId: AgentRef.optional(),
    /**
     * Launches a new agent for the subtask instead (protocol 1.31), in `cwd`, or the delegating
     * agent's own directory.
     */
    launch: z
      .object({
        harness: HarnessId,
        cwd: z.string().min(1).optional(),
        /** Protocol 1.40. */
        name: AgentName.optional(),
      })
      .optional(),
    role: Role.default("worker"),
    title: TaskTitle,
    brief: TaskBrief,
  })
  .refine((r) => (r.agentId === undefined) !== (r.launch === undefined), {
    message: "name the agent to delegate to, or one to launch, not both",
  });
export type DelegateTaskRequest = z.infer<typeof DelegateTaskRequest>;

/**
 * `POST /v1/escalations`, an agent's verb: a question or problem for the human's inbox, about
 * one of its tasks when it names one (protocol 1.26).
 */
export const EscalateRequest = z.object({
  idempotencyKey: IdempotencyKey,
  summary: z.string().trim().min(1).max(2000),
  taskId: Id("task").optional(),
});
export type EscalateRequest = z.infer<typeof EscalateRequest>;

export const EscalateResponse = z.object({ attentionId: Id("attn") });
export type EscalateResponse = z.infer<typeof EscalateResponse>;
