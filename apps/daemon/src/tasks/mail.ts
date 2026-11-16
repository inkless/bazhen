import type { Role, TaskOutcome } from "@bazhen/protocol";

/** The task as a message about it names it. */
export interface Named {
  readonly id: string;
  readonly title: string;
}

/** Who a message says acted: an agent, by its name and its id, or the human as null. */
export type Who = { readonly id: string; readonly name: string } | null;

/** An agent as mail names it: its name, which a reader knows it by, and its id, which lasts. */
const agentNamed = ({ id, name }: { readonly id: string; readonly name: string }) =>
  name === "" ? `agent ${id}` : `${name} (${id})`;

const by = (who: Who) => (who === null ? "the human" : agentNamed(who));

/**
 * What an agent is told when it is given a task: the brief, and the commands to answer with. The
 * agent may know nothing of Bazhen, so the message carries everything it needs to reply.
 */
export function assignedMail(
  task: Named & { readonly brief: string; readonly parentTaskId: string | null },
  role: Role,
  from: Who,
) {
  const part = task.parentTaskId === null ? "" : ` It is part of task ${task.parentTaskId}.`;
  return [
    `You are assigned to task ${task.id} as its ${role}, by ${by(from)}.${part}`,
    `Title: ${task.title}`,
    task.brief,
    "When it is finished, run:",
    `  bazhen task done ${task.id} --note "<what you did, in a sentence or two>"`,
    ...(role === "worker" ? [] : [DELEGATE(task.id, role)]),
    `If you are stuck, or need the human to decide: bazhen escalate "<question>" --task ${task.id}`,
    `To read the task again: bazhen task show ${task.id}`,
  ].join("\n\n");
}

/** How a coordinator or lead hands part of its task to another agent. */
const DELEGATE = (taskId: string, role: Role) =>
  [
    `To hand part of it to another agent (${role === "coordinator" ? "as a lead or a worker" : "as a worker"}), run:`,
    `  bazhen delegate <agent> --task ${taskId} --title "<title>" --brief "<instructions>"`,
    "  <agent> is a name or id; `bazhen agents` lists them, and whoever you delegate to tells you when they finish.",
    "  To start a new agent for it instead, put --launch claude-code or --launch codex in place of the agent, and --name <name> to name it.",
  ].join("\n");

export function unassignedMail(task: Named, from: Who) {
  return `You are no longer assigned to task ${task.id} (${task.title}); ${by(from)} took it away. Stop working on it.`;
}

/** To an agent that gave the task out, when it finishes. */
export function finishedMail(task: Named, outcome: TaskOutcome, from: Who, note: string | null) {
  const head = `Task ${task.id} (${task.title}) was marked ${outcome} by ${by(from)}.`;
  return note === null ? head : `${head}\n\nNote: ${note}`;
}

/**
 * An agent's own message to another, after a line naming the sender, so the reader knows which
 * peer wrote it, and saying how to reply without asking for a reply. The reply names the
 * sender's id, which a rename doesn't change.
 */
export function peerMail(
  from: {
    readonly id: string;
    readonly name: string;
    readonly harness: string;
    readonly cwd: string;
  },
  text: string,
) {
  const sender = from.name === "" ? `agent ${from.id} (` : `${from.name} (${from.id}, `;
  return `From ${sender}${from.harness}, ${from.cwd}). If it needs an answer: bazhen send ${from.id} "<answer>"\n\n${text}`;
}

/** A message's limit in the mailbox, which every composed one is held to. */
export const MAIL_LIMIT = 20_000;

/** The note on a subtask cancelled because its parent finished. */
export const CANCELLED_WITH_PARENT = "Cancelled with its parent task.";

/** To whoever gave a worker its part, when the worker reports it done. */
export function completedMail(
  task: Named,
  worker: { readonly id: string; readonly name: string },
  note: string | null,
) {
  const head = `${agentNamed(worker)} finished its part of task ${task.id} (${task.title}).`;
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
export function cancelledMail(task: Named, from: Who) {
  return `Task ${task.id} (${task.title}) was cancelled by ${by(from)}. Stop working on it.`;
}

/**
 * What every agent Bazhen launches is told about the fleet it runs in, beside its harness's own
 * instructions, so it knows the task verbs before any task arrives.
 */
export const FLEET_INSTRUCTIONS = `You are an agent in a Bazhen fleet, launched and managed by Bazhen. Your agent id is in $BAZHEN_AGENT_ID; bazhen whoami says your name, your tasks and whom you report to.
Tasks reach you as messages from Bazhen, and you answer them with the bazhen command:
- bazhen task list: the tasks you are assigned; bazhen task show <task>: one in full.
- bazhen task done <task> --note "<what you did>": report a task finished, to whoever gave it to you.
- bazhen escalate "<question>" [--task <task>]: put a question or problem in the human's inbox.
- bazhen agents lists the other agents, and bazhen send <agent> "<text>" (or --file <path>, for text with quotes or several lines) sends one a message: a question it can answer, or something it needs to act on. An agent is named by its name or its id. A message from another agent names its sender. Answer it only when there is something to answer or act on, never just to acknowledge or thank.
- As a task's coordinator or lead, bazhen delegate <agent> --task <task> --title "<title>" --brief "<instructions>" hands part of it to another agent; with --launch claude-code or --launch codex in place of the agent, to a new agent started for it.`;
