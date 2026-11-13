import type { Caller } from "@bazhen/core";
import type { Role, TaskOutcome } from "@bazhen/protocol";

/** The task as a message about it names it. */
export interface Named {
  readonly id: string;
  readonly title: string;
}

const by = (caller: Caller) => (caller === null ? "the human" : `agent ${caller}`);

/**
 * What an agent is told when it is given a task: the brief, and the commands to answer with. The
 * agent may know nothing of Bazhen, so the message carries everything it needs to reply.
 */
export function assignedMail(
  task: Named & { readonly brief: string; readonly parentTaskId: string | null },
  role: Role,
  from: Caller,
) {
  const part = task.parentTaskId === null ? "" : ` It is part of task ${task.parentTaskId}.`;
  return [
    `You are assigned to task ${task.id} as its ${role}, by ${by(from)}.${part}`,
    `Title: ${task.title}`,
    task.brief,
    "When it is finished, run:",
    `  bazhen task done ${task.id} --note "<what you did, in a sentence or two>"`,
    ...(role === "worker" ? [] : [DELEGATE(task.id, role)]),
    `To read the task again: bazhen task show ${task.id}`,
  ].join("\n\n");
}

/** How a coordinator or lead hands part of its task to another agent. */
const DELEGATE = (taskId: string, role: Role) =>
  [
    `To hand part of it to another agent (${role === "coordinator" ? "as a lead or a worker" : "as a worker"}), run:`,
    `  bazhen delegate <agent-id> --task ${taskId} --title "<title>" --brief "<instructions>"`,
    "  `bazhen agents` lists the agents; whoever you delegate to tells you when they finish.",
  ].join("\n");

export function unassignedMail(task: Named, from: Caller) {
  return `You are no longer assigned to task ${task.id} (${task.title}); ${by(from)} took it away. Stop working on it.`;
}

/** To an agent that gave the task out, when it finishes. */
export function finishedMail(task: Named, outcome: TaskOutcome, from: Caller, note: string | null) {
  const head = `Task ${task.id} (${task.title}) was marked ${outcome} by ${by(from)}.`;
  return note === null ? head : `${head}\n\nNote: ${note}`;
}

/** A message's limit in the mailbox, which every composed one is held to. */
export const MAIL_LIMIT = 20_000;

/** The note on a subtask cancelled because its parent finished. */
export const CANCELLED_WITH_PARENT = "Cancelled with its parent task.";

/** To whoever gave a worker its part, when the worker reports it done. */
export function completedMail(task: Named, worker: string, note: string | null) {
  const head = `Agent ${worker} finished its part of task ${task.id} (${task.title}).`;
  return note === null ? head : `${head}\n\nNote: ${note}`;
}

/** To an agent whose assignment ended because the one it was granted under did. */
export function lineEndedMail(task: Named) {
  return `Your assignment on task ${task.id} (${task.title}) has ended: whoever gave it to you no longer holds the work. Stop working on it.`;
}

/** To the agent a subtask moved up to, when the one it was delegated by lost the work. */
export function ownedMail(task: Named) {
  return `Task ${task.id} (${task.title}) is now yours: whoever it was delegated by no longer holds the work it is part of. Assign it, finish it or cancel it.`;
}

/** To an agent still working on a task someone else cancelled. */
export function cancelledMail(task: Named, from: Caller) {
  return `Task ${task.id} (${task.title}) was cancelled by ${by(from)}. Stop working on it.`;
}

/**
 * What every agent Bazhen launches is told about the fleet it runs in, beside its harness's own
 * instructions, so it knows the task verbs before any task arrives.
 */
export const FLEET_INSTRUCTIONS = `You are an agent in a Bazhen fleet, launched and managed by Bazhen. Your agent id is in $BAZHEN_AGENT_ID.
Tasks reach you as messages from Bazhen, and you answer them with the bazhen command:
- bazhen task list: the tasks you are assigned; bazhen task show <task>: one in full.
- bazhen task done <task> --note "<what you did>": report a task finished, to whoever gave it to you.
- As a task's coordinator or lead, bazhen agents lists the other agents, and bazhen delegate <agent-id> --task <task> --title "<title>" --brief "<instructions>" hands part of it to one of them.`;
