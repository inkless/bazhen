// The task verbs agents and humans run: each is one daemon call, built here from the command
// line, and its answer printed as plain lines that a model reads as easily as a person.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AgentCommandResponse,
  AgentName,
  AgentRef,
  AssignTaskResponse,
  BroadcastMessageResponse,
  CreateTaskResponse,
  HarnessId,
  EscalateResponse,
  Id,
  MESSAGE_WAIT_MAX_MS,
  Role,
  RolesResponse,
  SendMessageResponse,
  SETTLED,
  StateSnapshot,
  TaskCommandResponse,
  TaskDetail,
  TaskNoteText,
  quoteNote,
  type FleetAgent,
  WaitMessagesResponse,
  type Agent,
  type Assignment,
  type MailboxState,
  type Task,
  type TaskNote,
} from "@bazhen/protocol";
import type { Call } from "@bazhen/daemon/client";

export const TASK_USAGE = `usage:
  bazhen agents [--json]
  bazhen whoami
  bazhen roles
  bazhen rename <agent> <name>
  bazhen task list [--all]
  bazhen task show <task>
  bazhen task create --title <title> (--brief <text> | --brief-file <path>) [--parent <task>] [--assign <agent> [--role <role>]]
  bazhen task assign <task> <agent> [--role <role>]
  bazhen task unassign <task> <assignment>
  bazhen task done [<task>] [--note <text>] [--cascade]
  bazhen task cancel <task> [--note <text>] [--cascade]
  bazhen task note [<task>] <text> [--handoff]
  bazhen escalate <question> [--task <task>]
  bazhen send (<agent> | --task <task>) (<text> | --file <path>) [--wait [--timeout <seconds>]]
  bazhen delegate (<agent> | --launch claude-code|codex [--dir <dir>] [--name <name>]) --title <title> (--brief <text> | --brief-file <path>) [--task <task>] [--role <role>]
<agent> is an agent's name or id, and <role> one of the roles bazhen roles lists. send --wait
exits 0 once the agent has the message in a prompt (a turn cut short may still get it again), 4
if it bounced, and 5 if it is still on its way when the timeout (60 s unless given) runs out.`;

/** A command line that doesn't say what to do; the message says why. */
export class Usage extends Error {}

/**
 * The daemon a task verb talks to: the one that started this process, by the socket it handed
 * every agent and shell, else the one this user's paths name. An agent's id means something only
 * to the daemon that started it, and an agent's environment has no `BAZHEN_HOME` to find a
 * relocated one by (foundation-design §9.5).
 */
export const taskSocket = (env: { readonly BAZHEN_SOCKET?: string }, resolved: string) =>
  env.BAZHEN_SOCKET === undefined || env.BAZHEN_SOCKET === "" ? resolved : env.BAZHEN_SOCKET;

/** What a verb needs from where it runs: who is asking, and the files a brief may come from. */
export interface Context {
  /** `BAZHEN_AGENT_ID`, set inside every agent Bazhen launches. */
  readonly agentId: string | undefined;
  readonly readFile: (path: string) => string;
  readonly key: () => string;
  /** The time now, in milliseconds since the epoch, that ages are counted to. */
  readonly now: () => number;
}

/**
 * One verb: the daemon call, and what its answer prints, or the call to make next when the answer
 * only says which one (as `task done` with no task, which first reads the agent's tasks).
 */
export interface Verb {
  readonly call: Call<unknown>;
  readonly answer: (reply: unknown) => Answer;
  /** What has happened already, said before the call, which may fail or take long. */
  readonly progress?: string;
}

/** What a verb prints when the exit status says more than that it ran. */
export interface Exit {
  readonly text: string;
  readonly code: number;
}

/** What a verb's answer leads to: lines to print, lines with an exit status, or the next call. */
export type Answer = string | Exit | Verb;

export const isVerb = (answer: Answer): answer is Verb =>
  typeof answer !== "string" && "call" in answer;

/** `send --wait`'s exit status, as `triage send --wait` gives it. */
export const LANDED = 0;
export const BOUNCED = 4;
export const QUEUED = 5;

const DEFAULT_WAIT_S = 60;
/** How much longer than the daemon may hold a wait the CLI gives the call to come back. */
const WAIT_MARGIN_MS = 5000;

/** A verb whose answer is checked against the call's reply schema before `then` reads it. */
function verb<T>(call: Call<T>, then: (reply: T) => Answer): Verb {
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
  json: { type: "boolean" },
  wait: { type: "boolean" },
  timeout: { type: "string" },
  handoff: { type: "boolean" },
} as const;

/** The command line's words and options; a malformed one is a Usage, not a crash. */
function parse(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, tokens: true });
  } catch (err) {
    if (err instanceof TypeError) throw new Usage(err.message, { cause: err });
    throw err;
  }
}

/** The options `send` and `task note` take, beside their text; `--home` and `--port` are every verb's. */
const SEND_OPTIONS: ReadonlySet<string> = new Set([
  "file",
  "task",
  "wait",
  "timeout",
  "home",
  "port",
]);
const NOTE_OPTIONS: ReadonlySet<string> = new Set(["handoff", "home", "port"]);
const SEND_TO_AGENT_OPTIONS: ReadonlySet<string> = new Set(
  [...SEND_OPTIONS].filter((o) => o !== "task"),
);

const state: Call<StateSnapshot> = { method: "GET", path: "/v1/state", reply: StateSnapshot };
const rolesCall: Call<RolesResponse> = { method: "GET", path: "/v1/roles", reply: RolesResponse };

/** Builds the verb `argv` names (the words after `bazhen`), or throws Usage. */
export function taskVerb(argv: readonly string[], ctx: Context): Verb {
  const { positionals, values, tokens } = parse(argv);
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
    if (!parsed.success) throw new Usage(`--role is a role bazhen roles lists, not ${values.role}`);
    return parsed.data;
  };
  const post = <T>(path: string, reply: Call<T>["reply"], body: object, print: (r: T) => Answer) =>
    verb({ method: "POST", path, reply, body: { idempotencyKey: ctx.key(), ...body } }, print);

  if (name !== "send" && values.file !== undefined) {
    throw new Usage("--file is for send; a brief takes --brief-file");
  }
  for (const [option, owner] of [
    ["wait", "send"],
    ["timeout", "send"],
    ["json", "agents"],
  ] as const) {
    if (values[option] !== undefined && name !== owner)
      throw new Usage(`--${option} is for ${owner}`);
  }
  if (values.handoff !== undefined && (name !== "task" || sub !== "note")) {
    throw new Usage("--handoff is for task note");
  }
  /** Text given as words, refused when an option took some of it out unseen. */
  const words = (given: readonly (string | undefined)[], allowed: ReadonlySet<string>) => {
    const taken = Object.keys(values).filter((o) => !allowed.has(o));
    if (taken.length > 0) {
      throw new Usage(`put the text in quotes: it holds --${taken.join(", --")}`);
    }
    return given.filter((w) => w !== undefined).join(" ");
  };
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
  if (name === "agents") {
    const now = ctx.now();
    return verb(state, (s) => (values.json === true ? agentsJson(s, now) : listAgents(s, now)));
  }
  if (name === "roles") return verb(rolesCall, listRoles);
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
    // Only before any word of the text, so a --task in unquoted text is refused rather than read
    // as a broadcast of the words before it.
    const firstWord = tokens.findIndex((t) => t.kind === "positional" && t.index > 0);
    const taskAt = tokens.findIndex((t) => t.kind === "option" && t.name === "task");
    const broadcasts = taskAt !== -1 && (firstWord === -1 || taskAt < firstWord);
    const toTask = broadcasts ? values.task : undefined;
    if (!broadcasts && values.task !== undefined) {
      throw new Usage(
        "put the text in quotes: it holds --task; to send to a task's agents, put --task <task> before the text",
      );
    }
    const agentId = toTask === undefined ? agentRef(sub, "the agent to send to") : undefined;
    const text = words(
      toTask === undefined ? rest : [sub, ...rest],
      broadcasts ? SEND_OPTIONS : SEND_TO_AGENT_OPTIONS,
    );
    if (text !== "" && values.file !== undefined) {
      throw new Usage("give the text or --file, not both");
    }
    const body =
      values.file === undefined ? need(text, "the text to send") : ctx.readFile(values.file);
    const wait = waitMs(values.wait === true, values.timeout);
    if (agentId === undefined) {
      return post(
        `/v1/tasks/${encodeURIComponent(need(toTask, "--task"))}/messages`,
        BroadcastMessageResponse,
        { body },
        (r) => broadcast(r, wait),
      );
    }
    return post(
      `/v1/agents/${encodeURIComponent(agentId)}/messages`,
      SendMessageResponse,
      { body },
      (r) =>
        wait === undefined
          ? `sent ${r.messageId} to ${agentId}`
          : waitFor([{ messageId: r.messageId, agentId }], wait, [], () => agentId),
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
    case "note": {
      const [first, ...more] = rest;
      const named = first !== undefined && Id("task").safeParse(first).success;
      const text = need(words(named ? more : rest, NOTE_OPTIONS), "the note's text");
      const parsed = TaskNoteText.safeParse(text);
      if (!parsed.success) {
        throw new Usage(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const handoff = values.handoff === true;
      const noteOn = (id: string): Verb =>
        post(
          `/v1/tasks/${id}/notes`,
          TaskCommandResponse,
          { text: parsed.data, ...(handoff ? { handoff } : {}) },
          () => `noted on ${id}${handoff ? ", as a handoff for whoever is assigned it next" : ""}`,
        );
      return named ? noteOn(first) : ownTask(ctx, noteOn);
    }
    case undefined:
    default:
      throw new Usage(`unknown task verb ${sub ?? ""}`);
  }
}

/**
 * `task done` or `task note` with no task, inside an agent: the one task it is assigned, read from
 * the state.
 */
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

/** The milliseconds to wait for, from `--wait` and `--timeout`; undefined without `--wait`. */
function waitMs(wait: boolean, timeout: string | undefined): number | undefined {
  if (!wait) {
    if (timeout !== undefined)
      throw new Usage("--timeout is how long --wait waits; give --wait too");
    return undefined;
  }
  if (timeout === undefined) return DEFAULT_WAIT_S * 1000;
  const seconds = /^[0-9]+$/.test(timeout) ? Number(timeout) : Number.NaN;
  if (!(seconds * 1000 <= MESSAGE_WAIT_MAX_MS)) {
    throw new Usage(
      `--timeout is whole seconds, at most ${MESSAGE_WAIT_MAX_MS / 1000}, not ${timeout}`,
    );
  }
  return seconds * 1000;
}

/** Where a message stands for a sender waiting on it: landed, bounced, or still on its way. */
const exitFor = (mail: MailboxState) => {
  if (mail === "undeliverable") return BOUNCED;
  return SETTLED.has(mail) ? LANDED : QUEUED;
};

/** The exit status of several sends: any bounced, else any still on its way, else landed. */
const worst = (codes: readonly number[]) => {
  if (codes.includes(BOUNCED)) return BOUNCED;
  return codes.includes(QUEUED) ? QUEUED : LANDED;
};

/** Waits on the messages, then prints each one's state after `before`, and exits as they stand. */
function waitFor(
  sent: readonly { readonly messageId: string; readonly agentId: string }[],
  timeoutMs: number,
  skipped: readonly string[],
  to: (agentId: string) => string,
): Verb {
  const wait = verb(
    {
      method: "POST",
      path: "/v1/messages/wait",
      reply: WaitMessagesResponse,
      body: { messageIds: sent.map((m) => m.messageId), timeoutMs },
      timeoutMs: timeoutMs + WAIT_MARGIN_MS,
    },
    (r) => ({
      text: [...skipped, ...r.messages.map((m) => `${m.id} to ${to(m.agentId)}: ${m.state}`)].join(
        "\n",
      ),
      code: worst([...skipped.map(() => BOUNCED), ...r.messages.map((m) => exitFor(m.state))]),
    }),
  );
  // Said before the wait, so a sender whose wait fails still knows what went, and resends nothing.
  const said = sent.map((m) => `sent ${m.messageId} to ${to(m.agentId)}`);
  return { ...wait, progress: `${said.join("\n")}\nwaiting up to ${timeoutMs / 1000} s` };
}

/**
 * A task's broadcast: each message sent and each assignee skipped, waited on when asked. One that
 * skipped anyone exits as bounced, as a send to an agent that takes no mail fails, so a script
 * never takes it for having reached the whole task.
 */
function broadcast(r: BroadcastMessageResponse, wait: number | undefined): Answer {
  const skipped = r.skipped.map((s) => `skipped ${s.agentId}: ${s.reason}`);
  if (wait === undefined) {
    const text = [...r.sent.map((m) => `sent ${m.messageId} to ${m.agentId}`), ...skipped];
    return skipped.length === 0 ? text.join("\n") : { text: text.join("\n"), code: BOUNCED };
  }
  if (r.sent.length === 0) return { text: skipped.join("\n"), code: BOUNCED };
  return waitFor(r.sent, wait, skipped, (agentId) => agentId);
}

/** Whole seconds from an ISO time to `now`, never negative, so a reader does no date arithmetic. */
const ageSeconds = (at: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(at)) / 1000));

/** An age as a person reads it at a glance: its largest whole unit. */
function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function listAgents(s: StateSnapshot, now: number): string {
  const live = s.agents.filter((a) => !ended(a));
  if (live.length === 0) return "no agents";
  return live
    .flatMap((a: Agent) => {
      const signal =
        a.activity === undefined
          ? ""
          : `${a.activity.value} ${ago(ageSeconds(a.activity.observedAt, now))}`;
      const line = [a.name, a.id, a.harness, a.state, signal, a.project, a.cwd]
        .filter((f) => f !== "")
        .join("  ");
      return a.headline === null ? [line] : [line, `  > ${a.headline.text}`];
    })
    .join("\n");
}

/** Each role with what it hands on and limits, then each role file that was skipped and why. */
export function listRoles({ roles, problems }: RolesResponse): string {
  const lines = roles.map((r) =>
    [
      `${r.key}  ${r.title}`,
      r.grants.length === 0 ? "grants nothing" : `grants ${r.grants.join(", ")}`,
      ...(r.singlePerTask ? ["one per task"] : []),
      ...(r.maxActiveTasks === null ? [] : [`at most ${r.maxActiveTasks} task(s) at once`]),
      ...(r.description === "" ? [] : [r.description]),
    ].join("  "),
  );
  const skipped = problems.map((p) => `skipped ${p.file}: ${p.problem}`);
  return [...lines, ...skipped].join("\n");
}

/**
 * The fleet for a program to read: each agent not ended, with its latest signal and its age,
 * whether mail reaches it now, its headline, its tasks, and the items it has open for the human.
 */
export function agentsJson(s: StateSnapshot, now: number): string {
  const agents: FleetAgent[] = s.agents
    .filter((a) => !ended(a))
    .map((a) => ({
      id: a.id,
      name: a.name,
      harness: a.harness,
      state: a.state,
      project: a.project,
      cwd: a.cwd,
      launchedBy: a.launchedBy,
      signal:
        a.activity === undefined
          ? null
          : {
              value: a.activity.value,
              source: a.activity.source,
              ageSeconds: ageSeconds(a.activity.observedAt, now),
            },
      listening: a.listening,
      headline:
        a.headline === null
          ? null
          : {
              text: a.headline.text,
              taskId: a.headline.taskId,
              ageSeconds: ageSeconds(a.headline.at, now),
            },
      tasks: activeFor(s, a.id).map((t) => ({
        taskId: t.taskId,
        assignmentId: t.id,
        role: t.role,
      })),
      attention: s.attention
        .filter((i) => i.agentId === a.id && i.state === "open")
        .map((i) => ({ id: i.id, kind: i.kind })),
    }));
  return JSON.stringify(agents, null, 2);
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
    `launched by ${launcher}${self.role === null ? "" : `, as a ${self.role}`}`,
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

const noteWriter = (s: StateSnapshot, n: TaskNote) =>
  n.agentId === null ? "the human" : `${shown(s, n.agentId)}, its ${n.role ?? "owner"}`;

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
    ...d.notes.flatMap((n) => [
      "",
      `${n.handoff ? "handoff" : "note"} from ${noteWriter(s, n)}, ${n.at}:`,
      quoteNote(n.text),
    ]),
  ];
  return d.note === null ? lines.join("\n") : [...lines, "", "note:", quoteNote(d.note)].join("\n");
}
