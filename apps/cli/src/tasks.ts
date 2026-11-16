// The task verbs agents and humans run: each is one daemon call, built here from the command
// line, and its answer printed as plain lines that a model reads as easily as a person.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AgentCommandResponse,
  AgentName,
  AgentRef,
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
  bazhen whoami
  bazhen rename <agent> <name>
  bazhen task list [--all]
  bazhen task show <task>
  bazhen task create --title <title> (--brief <text> | --brief-file <path>) [--parent <task>] [--assign <agent> [--role <role>]]
  bazhen task assign <task> <agent> [--role coordinator|lead|worker]
  bazhen task unassign <task> <assignment>
  bazhen task done [<task>] [--note <text>] [--cascade]
  bazhen task cancel <task> [--note <text>] [--cascade]
  bazhen escalate <question> [--task <task>]
  bazhen send <agent> (<text> | --file <path>)
  bazhen delegate (<agent> | --launch claude-code|codex [--dir <dir>] [--name <name>]) --title <title> (--brief <text> | --brief-file <path>) [--task <task>] [--role lead|worker]
<agent> is an agent's name or id.`;

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
  name: { type: "string" },
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

/** The options `send` takes; `--home` and `--port` are every verb's. */
const SEND_OPTIONS: ReadonlySet<string> = new Set(["file", "home", "port"]);

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

  if (name !== "send" && values.file !== undefined) {
    throw new Usage("--file is for send; a brief takes --brief-file");
  }
  /** A name the command line gives an agent, checked before the daemon is asked. */
  const newName = (value: string) => {
    const parsed = AgentName.safeParse(value);
    if (!parsed.success) throw new Usage(parsed.error.issues.map((i) => i.message).join("; "));
    return parsed.data;
  };
  /** An agent the command line names, by name or id, as a path segment. */
  const agentRef = (value: string | undefined, what: string) => {
    const ref = need(value, what);
    if (!AgentRef.safeParse(ref).success) throw new Usage(`not an agent's name or id: ${ref}`);
    return ref;
  };
  if (name === "agents") return verb(state, listAgents);
  if (name === "whoami") {
    const self = ctx.agentId;
    if (self === undefined) throw new Usage("whoami runs inside an agent Bazhen launched");
    return verb(state, (s) => whoami(s, self));
  }
  if (name === "rename") {
    const agent = agentRef(sub, "the agent to rename");
    const to = newName(need(rest[0], "the new name"));
    return post(
      `/v1/agents/${encodeURIComponent(agent)}/rename`,
      AgentCommandResponse,
      { name: to },
      (r) =>
        r.eventIds.length === 0 ? `${agent} is already named ${to}` : `renamed ${agent} to ${to}`,
    );
  }
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
    const agentId = agentRef(sub, "the agent to send to");
    // An unquoted word that is another verb's option would be taken out of the text silently.
    const taken = Object.keys(values).filter((o) => !SEND_OPTIONS.has(o));
    if (taken.length > 0) {
      throw new Usage(`put the text in quotes: it holds --${taken.join(", --")}`);
    }
    const words = rest.join(" ");
    if (words !== "" && values.file !== undefined) {
      throw new Usage("give the text or --file, not both");
    }
    const body =
      values.file === undefined ? need(words, "the text to send") : ctx.readFile(values.file);
    return post(
      `/v1/agents/${encodeURIComponent(agentId)}/messages`,
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
    if (harness === undefined && values.name !== undefined) {
      throw new Usage(
        "--name names a --launch agent; give --launch too, or bazhen rename one that runs",
      );
    }
    if (harness !== undefined && !HarnessId.safeParse(harness).success) {
      throw new Usage(`--launch is ${HarnessId.options.join(" or ")}, not ${harness}`);
    }
    const to =
      harness === undefined
        ? { agentId: agentRef(sub, "the agent to delegate to, or --launch <harness>") }
        : {
            launch: {
              harness,
              ...(values.dir === undefined
                ? {}
                : { cwd: values.dir.startsWith("~") ? values.dir : resolve(values.dir) }),
              ...(values.name === undefined ? {} : { name: newName(values.name) }),
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
      return verb({ method: "GET", path: `/v1/tasks/${taskId}`, reply: TaskDetail }, (d) =>
        verb(state, (s) => showTask(d, s)),
      );
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
            : { assign: { agentId: agentRef(values.assign, "--assign"), role: role("worker") } }),
        },
        (r) =>
          r.assignmentId === null
            ? `created ${r.taskId}`
            : `created ${r.taskId}, assigned as ${r.assignmentId}`,
      );
    case "assign": {
      const [taskId, agentId] = [need(rest[0], "the task"), agentRef(rest[1], "the agent")];
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

const ended = (a: Agent) => a.state === "closed" || a.state === "failed";

export function listAgents(s: StateSnapshot): string {
  const live = s.agents.filter((a) => !ended(a));
  if (live.length === 0) return "no agents";
  return live
    .map((a: Agent) =>
      [a.name, a.id, a.harness, a.state, a.project, a.cwd].filter((f) => f !== "").join("  "),
    )
    .join("\n");
}

/**
 * An agent as the CLI prints it: by its name while it is not ended, as the name then names it
 * alone; by its id once it has, since another agent may hold its name now, and from a daemon
 * that names none.
 */
function shown(s: StateSnapshot, agentId: string): string {
  const agent = s.agents.find((a) => a.id === agentId);
  return agent === undefined || agent.name === "" || ended(agent) ? agentId : agent.name;
}

/**
 * The asking agent: its name and where it runs, each task it is on with its role, and whom it
 * reports to there: as the daemon tells of its work, the agent holding the assignment it was
 * given under, else the task's owner, else the human.
 */
export function whoami(s: StateSnapshot, agentId: string): string {
  const self = s.agents.find((a) => a.id === agentId);
  if (self === undefined) throw new Usage(`the daemon has no agent ${agentId}`);
  const launcher = self.launchedBy === null ? "the human" : shown(s, self.launchedBy);
  const tasks = activeFor(s, agentId).map((a) => {
    const task = s.tasks.find((t) => t.id === a.taskId);
    const giver =
      s.assignments.find((p) => p.id === a.parentAssignmentId)?.agentId ?? task?.ownerAgentId;
    const to = giver === undefined || giver === null ? "the human" : shown(s, giver);
    const title = task?.title ?? "";
    return `  ${a.taskId}  ${title}  as ${a.role}, reporting to ${to}`;
  });
  return [
    `${self.name}  ${self.id}`,
    `${self.harness}  ${self.state}  ${self.project}  ${self.cwd}`,
    `launched by ${launcher}`,
    ...(tasks.length === 0 ? ["no tasks"] : ["tasks:", ...tasks]),
  ].join("\n");
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
        s,
        t,
        active.filter((a) => a.taskId === t.id),
      ),
    )
    .join("\n");
}

const taskLine = (s: StateSnapshot, t: Task, assignees: readonly Assignment[]) => {
  const who = assignees.map((a) => `${a.role} ${shown(s, a.agentId)}`).join(", ") || "unassigned";
  const parent = t.parentTaskId === null ? "" : `  (part of ${t.parentTaskId})`;
  return `${t.id}  ${t.title}  [${who}]${parent}`;
};

export function showTask(d: TaskDetail, s: StateSnapshot): string {
  const owner = d.ownerAgentId === null ? "the human" : shown(s, d.ownerAgentId);
  const lines = [
    `${d.id}  ${d.title}`,
    `state: ${d.state}; owner: ${owner}${d.parentTaskId === null ? "" : `; part of ${d.parentTaskId}`}`,
    ...d.assignments.map(
      (a) =>
        `  ${a.id}  ${a.role} ${shown(s, a.agentId)}  ${a.state === "active" ? "active" : `ended (${a.endReason ?? "?"})`}`,
    ),
    ...d.subtasks.map((t) => `  subtask ${t.id}  ${t.title}  ${t.state}`),
    "",
    d.brief,
  ];
  return d.note === null ? lines.join("\n") : [...lines, "", `note: ${d.note}`].join("\n");
}
