// The task verbs agents and humans run: each is one daemon call, built here from the command
// line, and its answer printed as plain lines that a model reads as easily as a person.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AssignTaskResponse,
  CreateTaskResponse,
  HarnessId,
  EscalateResponse,
  Role,
  SendMessageResponse,
  StateSnapshot,
  TaskCommandResponse,
  TaskDetail,
  type Agent,
  type Assignment,
  type Task,
} from "@bazhen/protocol";
import type { Call } from "@bazhen/daemon/client";

export const TASK_USAGE = `usage:
  bazhen agents
  bazhen task list [--all]
  bazhen task show <task>
  bazhen task create --title <title> (--brief <text> | --brief-file <path>) [--parent <task>] [--assign <agent> [--role <role>]]
  bazhen task assign <task> <agent> [--role coordinator|lead|worker]
  bazhen task unassign <task> <assignment>
  bazhen task done [<task>] [--note <text>] [--cascade]
  bazhen task cancel <task> [--note <text>] [--cascade]
  bazhen escalate <question> [--task <task>]
  bazhen send <agent> (<text> | --file <path>)
  bazhen delegate (<agent> | --launch claude-code|codex [--dir <dir>]) --title <title> (--brief <text> | --brief-file <path>) [--task <task>] [--role lead|worker]`;

/** A command line that doesn't say what to do; the message says why. */
export class Usage extends Error {}

/** What a verb needs from where it runs: who is asking, and the files a brief may come from. */
export interface Context {
  /** `BAZHEN_AGENT_ID`, set inside every agent Bazhen launches. */
  readonly agentId: string | undefined;
  readonly readFile: (path: string) => string;
  readonly key: () => string;
}

/**
 * One verb: the daemon call, and what its answer prints, or the call to make next when the answer
 * only says which one (as `task done` with no task, which first reads the agent's tasks).
 */
export interface Verb {
  readonly call: Call<unknown>;
  readonly answer: (reply: unknown) => string | Verb;
}

/** A verb whose answer is checked against the call's reply schema before `then` reads it. */
function verb<T>(call: Call<T>, then: (reply: T) => string | Verb): Verb {
  return {
    call,
    answer: (reply) => {
      const parsed = call.reply.safeParse(reply);
      if (!parsed.success) throw new Usage(`${call.path}: an answer this CLI can't read`);
      return then(parsed.data);
    },
  };
}

const OPTIONS = {
  title: { type: "string" },
  brief: { type: "string" },
  "brief-file": { type: "string" },
  file: { type: "string" },
  parent: { type: "string" },
  assign: { type: "string" },
  role: { type: "string" },
  note: { type: "string" },
  task: { type: "string" },
  all: { type: "boolean" },
  cascade: { type: "boolean" },
  launch: { type: "string" },
  dir: { type: "string" },
  home: { type: "string" },
  port: { type: "string" },
} as const;

/** The command line's words and options; a malformed one is a Usage, not a crash. */
function parse(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (err) {
    if (err instanceof TypeError) throw new Usage(err.message, { cause: err });
    throw err;
  }
}

const state: Call<StateSnapshot> = { method: "GET", path: "/v1/state", reply: StateSnapshot };

/** Builds the verb `argv` names (the words after `bazhen`), or throws Usage. */
export function taskVerb(argv: readonly string[], ctx: Context): Verb {
  const { positionals, values } = parse(argv);
  const [name, sub, ...rest] = positionals;
  const need = (value: string | undefined, what: string) => {
    if (value === undefined || value === "") throw new Usage(`missing ${what}`);
    return value;
  };
  const brief = () => {
    if (values.brief !== undefined && values["brief-file"] !== undefined) {
      throw new Usage("give --brief or --brief-file, not both");
    }
    const file = values["brief-file"];
    return file === undefined ? need(values.brief, "--brief") : ctx.readFile(file);
  };
  const role = (fallback: Role) => {
    const parsed = Role.safeParse(values.role ?? fallback);
    if (!parsed.success)
      throw new Usage(`--role is coordinator, lead or worker, not ${values.role}`);
    return parsed.data;
  };
  const post = <T>(path: string, reply: Call<T>["reply"], body: object, print: (r: T) => string) =>
    verb({ method: "POST", path, reply, body: { idempotencyKey: ctx.key(), ...body } }, print);

  if (name === "agents") return verb(state, listAgents);
  if (name === "escalate") {
    const summary = [sub, ...rest].filter((w) => w !== undefined).join(" ");
    return post(
      "/v1/escalations",
      EscalateResponse,
      {
        summary: need(summary, "what to ask the human"),
        ...(values.task === undefined ? {} : { taskId: values.task }),
      },
      (r) => `escalated as ${r.attentionId}; the human answers in the inbox`,
    );
  }
  if (name === "send") {
    const agentId = need(sub, "the agent to send to");
    const words = rest.join(" ");
    if (words !== "" && values.file !== undefined) {
      throw new Usage("give the text or --file, not both");
    }
    const body =
      values.file === undefined ? need(words, "the text to send") : ctx.readFile(values.file);
    return post(
      `/v1/agents/${agentId}/messages`,
      SendMessageResponse,
      { body },
      (r) => `sent ${r.messageId} to ${agentId}`,
    );
  }
  if (name === "delegate") {
    const harness = values.launch;
    if (harness !== undefined && sub !== undefined) {
      throw new Usage("name the agent to delegate to, or --launch one, not both");
    }
    if (harness === undefined && values.dir !== undefined) {
      throw new Usage("--dir is where a --launch agent starts; give --launch too");
    }
    if (harness !== undefined && !HarnessId.safeParse(harness).success) {
      throw new Usage(`--launch is ${HarnessId.options.join(" or ")}, not ${harness}`);
    }
    const to =
      harness === undefined
        ? { agentId: need(sub, "the agent to delegate to, or --launch <harness>") }
        : {
            launch: {
              harness,
              ...(values.dir === undefined
                ? {}
                : { cwd: values.dir.startsWith("~") ? values.dir : resolve(values.dir) }),
            },
          };
    return post(
      "/v1/tasks/delegate",
      CreateTaskResponse,
      {
        ...to,
        role: role("worker"),
        title: need(values.title, "--title"),
        brief: brief(),
        ...(values.task === undefined ? {} : { fromTaskId: values.task }),
      },
      (r) =>
        harness === undefined
          ? `delegated ${r.taskId} to ${sub}`
          : `delegated ${r.taskId} to a new ${harness} agent, as ${r.assignmentId ?? "?"}`,
    );
  }
  if (name !== "task") throw new Usage(`unknown verb ${name ?? ""}`);
  switch (sub) {
    case "list":
      return verb(state, (s) => listTasks(s, values.all === true ? undefined : ctx.agentId));
    case "show": {
      const taskId = need(rest[0], "the task");
      return verb({ method: "GET", path: `/v1/tasks/${taskId}`, reply: TaskDetail }, showTask);
    }
    case "create":
      return post(
        "/v1/tasks",
        CreateTaskResponse,
        {
          title: need(values.title, "--title"),
          brief: brief(),
          ...(values.parent === undefined ? {} : { parentTaskId: values.parent }),
          ...(values.assign === undefined
            ? {}
            : { assign: { agentId: values.assign, role: role("worker") } }),
        },
        (r) =>
          r.assignmentId === null
            ? `created ${r.taskId}`
            : `created ${r.taskId}, assigned as ${r.assignmentId}`,
      );
    case "assign": {
      const [taskId, agentId] = [need(rest[0], "the task"), need(rest[1], "the agent")];
      return post(
        `/v1/tasks/${taskId}/assign`,
        AssignTaskResponse,
        { agentId, role: role("worker") },
        (r) => `assigned ${agentId} as ${r.assignmentId}`,
      );
    }
    case "unassign": {
      const [taskId, assignmentId] = [need(rest[0], "the task"), need(rest[1], "the assignment")];
      return post(
        `/v1/tasks/${taskId}/unassign`,
        TaskCommandResponse,
        { assignmentId },
        () => `unassigned ${assignmentId}`,
      );
    }
    case "done":
    case "cancel": {
      const outcome = sub === "done" ? "done" : "cancelled";
      const taskId = rest[0] ?? (sub === "done" ? undefined : need(undefined, "the task"));
      const finish = (id: string): Verb =>
        post(
          `/v1/tasks/${id}/finish`,
          TaskCommandResponse,
          {
            outcome,
            ...(values.note === undefined ? {} : { note: values.note }),
            ...(values.cascade === true ? { cascade: true } : {}),
          },
          () => `${id} ${outcome}`,
        );
      if (taskId !== undefined) return finish(taskId);
      return ownTask(ctx, finish);
    }
    case undefined:
    default:
      throw new Usage(`unknown task verb ${sub ?? ""}`);
  }
}

/** `task done` with no task, inside an agent: the one task it is assigned, read from the state. */
function ownTask(ctx: Context, finish: (id: string) => Verb): Verb {
  const agentId = ctx.agentId;
  if (agentId === undefined) throw new Usage("missing the task (outside an agent, name it)");
  return verb(state, (s) => {
    const [only, ...more] = activeFor(s, agentId);
    if (only !== undefined && more.length === 0) return finish(only.taskId);
    if (only === undefined) throw new Usage("you are assigned no task");
    throw new Usage(`name one of ${[only, ...more].map((a) => a.taskId).join(", ")}`);
  });
}

const activeFor = (s: StateSnapshot, agentId: string) =>
  s.assignments.filter((a) => a.agentId === agentId && a.state === "active");

export function listAgents(s: StateSnapshot): string {
  const live = s.agents.filter((a) => a.state !== "closed" && a.state !== "failed");
  if (live.length === 0) return "no agents";
  return live
    .map((a: Agent) => `${a.id}  ${a.harness}  ${a.state}  ${a.project}  ${a.cwd}`)
    .join("\n");
}

/**
 * Open tasks, each with its assignees. Given an agent, only the tasks it is assigned or owns, and
 * its own role on each.
 */
export function listTasks(s: StateSnapshot, agentId: string | undefined): string {
  const active = s.assignments.filter((a) => a.state === "active");
  const tasks = s.tasks.filter(
    (t) =>
      t.state === "open" &&
      (agentId === undefined ||
        t.ownerAgentId === agentId ||
        active.some((a) => a.taskId === t.id && a.agentId === agentId)),
  );
  if (tasks.length === 0) return agentId === undefined ? "no open tasks" : "you have no open tasks";
  return tasks
    .map((t) =>
      taskLine(
        t,
        active.filter((a) => a.taskId === t.id),
      ),
    )
    .join("\n");
}

const taskLine = (t: Task, assignees: readonly Assignment[]) => {
  const who = assignees.map((a) => `${a.role} ${a.agentId}`).join(", ") || "unassigned";
  const parent = t.parentTaskId === null ? "" : `  (part of ${t.parentTaskId})`;
  return `${t.id}  ${t.title}  [${who}]${parent}`;
};

export function showTask(d: TaskDetail): string {
  const owner = d.ownerAgentId === null ? "the human" : d.ownerAgentId;
  const lines = [
    `${d.id}  ${d.title}`,
    `state: ${d.state}; owner: ${owner}${d.parentTaskId === null ? "" : `; part of ${d.parentTaskId}`}`,
    ...d.assignments.map(
      (a) =>
        `  ${a.id}  ${a.role} ${a.agentId}  ${a.state === "active" ? "active" : `ended (${a.endReason ?? "?"})`}`,
    ),
    ...d.subtasks.map((t) => `  subtask ${t.id}  ${t.title}  ${t.state}`),
    "",
    d.brief,
  ];
  return d.note === null ? lines.join("\n") : [...lines, "", `note: ${d.note}`].join("\n");
}
