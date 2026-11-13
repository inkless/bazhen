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
    `To read the task again: bazhen task show ${task.id}`,
  ].join("\n\n");
}

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

/** To an agent still working on a task someone else cancelled. */
export function cancelledMail(task: Named, from: Caller) {
  return `Task ${task.id} (${task.title}) was cancelled by ${by(from)}. Stop working on it.`;
}
