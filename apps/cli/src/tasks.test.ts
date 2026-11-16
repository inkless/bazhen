import { describe, expect, it } from "vitest";
import type { StateSnapshot } from "@bazhen/protocol";
import {
  listAgents,
  listTasks,
  showTask,
  taskVerb,
  Usage,
  whoami,
  type Context,
  type Verb,
} from "./tasks.ts";

const AGENT = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const OTHER = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";
const TASK = "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const TASK2 = "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";

const ctx = (agentId?: string): Context => ({
  agentId,
  readFile: (path) => `brief from ${path}`,
  key: () => "key",
});

const task = (id: string, title: string) => ({
  id,
  title,
  state: "open" as const,
  ownerAgentId: null,
  parentTaskId: null,
});
const assigned = (taskId: string, agentId: string) => ({
  id: `asgn_${taskId.slice(5)}`,
  taskId,
  agentId,
  role: "worker" as const,
  parentAssignmentId: null,
  state: "active" as const,
  endReason: null,
});
const ENV = "env_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const agent = (id: string, name: string, over: Partial<StateSnapshot["agents"][number]> = {}) => ({
  id,
  name,
  environmentId: ENV,
  harness: "codex" as const,
  project: "bazhen",
  cwd: "/work",
  state: "running" as const,
  terminalId: null,
  generation: null,
  externalRef: null,
  exit: null,
  theme: "dark" as const,
  themes: ["dark" as const],
  attachCommand: null,
  commands: [],
  resumable: false,
  canOpenShell: false,
  launchedBy: null,
  ...over,
});
const snapshot = (
  tasks: StateSnapshot["tasks"],
  assignments: StateSnapshot["assignments"],
  agents: StateSnapshot["agents"] = [],
) =>
  ({
    epoch: "e",
    eventId: 1,
    environments: [],
    agents,
    attention: [],
    messages: [],
    shells: [],
    tasks,
    assignments,
    notices: [],
  }) satisfies StateSnapshot;

/** The call the verb's answer to `reply` leads to, as path and body; what it prints, if it prints. */
const after = (verb: Verb, reply: unknown) => {
  const next = verb.answer(reply);
  return typeof next === "string" ? next : [next.call.path, next.call.body];
};
const usage = (argv: string[], context = ctx()) => {
  try {
    taskVerb(argv, context);
  } catch (err) {
    if (err instanceof Usage) return err.message;
    throw err;
  }
  return "accepted";
};

const delegate = (role: string) =>
  usage(["delegate", OTHER, "--title", "t", "--brief", "b", "--role", role], ctx(AGENT));

describe("bazhen task verbs", () => {
  it("delegates as a worker unless told otherwise, from the task named", () => {
    const verb = taskVerb(
      ["delegate", OTHER, "--title", "t", "--brief", "b", "--task", TASK],
      ctx(AGENT),
    );
    expect([verb.call.path, verb.call.body]).toEqual([
      "/v1/tasks/delegate",
      {
        idempotencyKey: "key",
        agentId: OTHER,
        role: "worker",
        title: "t",
        brief: "b",
        fromTaskId: TASK,
      },
    ]);
  });

  it("delegates in any role the daemon may define, and refuses only one no role could be named", () => {
    expect([delegate("reviewer"), delegate("Lead")]).toEqual([
      "accepted",
      "--role is a role bazhen roles lists, not Lead",
    ]);
  });

  it("lists each role with what it grants and limits, then each role file skipped", () => {
    const role = {
      key: "worker",
      title: "Worker",
      description: "",
      grants: [],
      singlePerTask: false,
      maxActiveTasks: 1,
      prompt: "p",
      source: "builtin" as const,
    };
    const verb = taskVerb(["roles"], ctx());
    const reply = { roles: [role], problems: [{ file: "/r/lead.md", problem: "no prompt" }] };
    expect([verb.call.path, after(verb, reply)]).toEqual([
      "/v1/roles",
      "worker  Worker  grants nothing  at most 1 task(s) at once\nskipped /r/lead.md: no prompt",
    ]);
  });

  it("escalates the words given as one question, about the task named", () => {
    const verb = taskVerb(["escalate", "Pin", "24", "or", "26?", "--task", TASK], ctx(AGENT));
    expect([verb.call.path, verb.call.body]).toEqual([
      "/v1/escalations",
      { idempotencyKey: "key", summary: "Pin 24 or 26?", taskId: TASK },
    ]);
  });

  it("sends the words after the agent as one message, or a file's text, and says what it sent", () => {
    const words = taskVerb(["send", OTHER, "Is", "the", "build", "green?"], ctx(AGENT));
    expect([words.call.path, words.call.body]).toEqual([
      `/v1/agents/${OTHER}/messages`,
      { idempotencyKey: "key", body: "Is the build green?" },
    ]);
    const file = taskVerb(["send", OTHER, "--file", "notes.md"], ctx(AGENT));
    expect(file.call.body).toMatchObject({ body: "brief from notes.md" });
    const messageId = "msg_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
    expect(after(words, { messageId, eventIds: [1] })).toBe(`sent ${messageId} to ${OTHER}`);
  });

  it("wants an agent and one text to send, from the words or a file", () => {
    expect([
      usage(["send"]),
      usage(["send", OTHER]),
      usage(["send", OTHER, "hi", "--file", "f"]),
    ]).toEqual([
      expect.stringContaining("the agent"),
      expect.stringContaining("the text"),
      expect.stringContaining("not both"),
    ]);
  });

  it("refuses text that holds another verb's option, rather than send it with the option taken out", () => {
    expect([
      usage(["send", OTHER, "run", "it", "with", "--all"]),
      usage(["send", OTHER, "use", "--task", TASK]),
    ]).toEqual([
      expect.stringContaining("quotes: it holds --all"),
      expect.stringContaining("quotes: it holds --task"),
    ]);
  });

  it("refuses a send to something that is no agent's name or id, and --file on any other verb", () => {
    expect([
      usage(["send", "../tasks", "hi"]),
      usage(["escalate", "Pin", "it?", "--file", "q.md"]),
    ]).toEqual([
      expect.stringContaining("not an agent's name or id"),
      expect.stringContaining("--file is for send"),
    ]);
  });

  it("sends to an agent by its name", () => {
    const verb = taskVerb(["send", "BZ-127", "hi"], ctx(AGENT));
    expect(verb.call.path).toBe("/v1/agents/BZ-127/messages");
  });

  it("renames an agent, and refuses a new name that isn't one before asking the daemon", () => {
    const verb = taskVerb(["rename", "BZ-127", "reviewer"], ctx());
    expect([verb.call.path, verb.call.body]).toEqual([
      "/v1/agents/BZ-127/rename",
      { idempotencyKey: "key", name: "reviewer" },
    ]);
    expect([
      after(verb, { agentId: AGENT, eventIds: [3] }),
      usage(["rename", "BZ-127", OTHER]),
    ]).toEqual(["renamed BZ-127 to reviewer", expect.stringContaining("isn't an id")]);
  });

  it("names a launched agent, and wants --launch for --name", () => {
    const argv = [
      "delegate",
      "--launch",
      "codex",
      "--name",
      "notes",
      "--title",
      "t",
      "--brief",
      "b",
    ];
    expect(taskVerb(argv, ctx(AGENT)).call.body).toMatchObject({
      launch: { harness: "codex", name: "notes" },
    });
    expect([
      usage(["delegate", OTHER, "--name", "x", "--title", "t", "--brief", "b"]),
      usage(["delegate", "--launch", "codex", "--name=-x", "--title", "t", "--brief", "b"]),
    ]).toEqual([expect.stringContaining("give --launch"), expect.stringContaining("a name is")]);
  });

  it("delegates to a new agent it launches, in the directory named, rather than to one named", () => {
    const verb = taskVerb(
      ["delegate", "--launch", "codex", "--dir", "/work", "--title", "t", "--brief", "b"],
      ctx(AGENT),
    );
    expect(verb.call.body).toMatchObject({ launch: { harness: "codex", cwd: "/work" } });
    expect(verb.call.body).not.toHaveProperty("agentId");
    expect(
      usage(["delegate", OTHER, "--launch", "codex", "--title", "t", "--brief", "b"]),
    ).toContain("not both");
  });

  it("starts a launched agent in the directory named from where the command runs, and wants --launch for --dir", () => {
    const verb = taskVerb(
      ["delegate", "--launch", "codex", "--dir", "work", "--title", "t", "--brief", "b"],
      ctx(AGENT),
    );
    expect(verb.call.body).toMatchObject({ launch: { cwd: `${process.cwd()}/work` } });
    const home = taskVerb(
      ["delegate", "--launch", "codex", "--dir", "~/proj", "--title", "t", "--brief", "b"],
      ctx(AGENT),
    );
    expect(home.call.body).toMatchObject({ launch: { cwd: "~/proj" } });
    expect(usage(["delegate", OTHER, "--dir", "work", "--title", "t", "--brief", "b"])).toContain(
      "give --launch too",
    );
  });

  it("reads a brief from a file", () => {
    const verb = taskVerb(["task", "create", "--title", "t", "--brief-file", "plan.md"], ctx());
    expect(verb.call.body).toMatchObject({ brief: "brief from plan.md" });
  });

  it("refuses a brief given both ways, and an option it doesn't know, as usage", () => {
    expect([
      usage(["task", "create", "--title", "t", "--brief", "b", "--brief-file", "f"]),
      usage(["task", "list", "--everything"]),
    ]).toEqual([expect.stringContaining("not both"), expect.stringContaining("--everything")]);
  });

  it("finishes an agent's only task when none is named", () => {
    const verb = taskVerb(["task", "done", "--note", "n"], ctx(AGENT));
    const next = after(
      verb,
      snapshot([task(TASK, "a")], [assigned(TASK, AGENT), assigned(TASK2, OTHER)]),
    );
    expect(next).toEqual([
      `/v1/tasks/${TASK}/finish`,
      { idempotencyKey: "key", outcome: "done", note: "n" },
    ]);
  });

  it("asks which task to finish when the agent has several", () => {
    const verb = taskVerb(["task", "done"], ctx(AGENT));
    const state = snapshot([], [assigned(TASK, AGENT), assigned(TASK2, AGENT)]);
    expect(() => after(verb, state)).toThrow(`name one of ${TASK}, ${TASK2}`);
  });

  it("lists only the asking agent's own tasks", () => {
    const state = snapshot(
      [task(TASK, "mine"), task(TASK2, "theirs")],
      [assigned(TASK, AGENT), assigned(TASK2, OTHER)],
    );
    expect(listTasks(state, AGENT)).toBe(`${TASK}  mine  [worker ${AGENT}]`);
  });

  it("shows a finished task's note after its brief", () => {
    const detail = {
      ...task(TASK, "t"),
      state: "done" as const,
      brief: "b",
      note: "shipped",
      assignments: [],
      subtasks: [],
    };
    expect(showTask(detail, snapshot([], [])).split("\n").slice(-3)).toEqual([
      "b",
      "",
      "note: shipped",
    ]);
  });

  it("names a live assignee by its name, and an ended one by its id, as its name may be another's", () => {
    const state = snapshot(
      [task(TASK, "mine"), task(TASK2, "old")],
      [assigned(TASK, AGENT), assigned(TASK2, OTHER)],
      [agent(OTHER, "repo-1", { state: "closed" }), agent(AGENT, "repo-1")],
    );
    expect(listTasks(state, undefined).split("\n")).toEqual([
      `${TASK}  mine  [worker repo-1]`,
      `${TASK2}  old  [worker ${OTHER}]`,
    ]);
  });
});

describe("bazhen agents and whoami", () => {
  it("lists the agents not ended, each led by its name, and one with none by its id", () => {
    const THIRD = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c9d";
    const state = snapshot(
      [],
      [],
      [agent(AGENT, "BZ-127"), agent(OTHER, "old", { state: "closed" }), agent(THIRD, "")],
    );
    expect(listAgents(state).split("\n")).toEqual([
      `BZ-127  ${AGENT}  codex  running  bazhen  /work`,
      `${THIRD}  codex  running  bazhen  /work`,
    ]);
  });

  it("says who the agent is, who launched it, and whom it reports to on each task", () => {
    const parent = { ...assigned(TASK2, OTHER), role: "coordinator" as const };
    const mine = { ...assigned(TASK, AGENT), parentAssignmentId: parent.id };
    const state = snapshot(
      [task(TASK, "Write the notes")],
      [parent, mine],
      [agent(AGENT, "BZ-127", { launchedBy: OTHER }), agent(OTHER, "coordinator-1")],
    );
    expect(whoami(state, AGENT).split("\n")).toEqual([
      `BZ-127  ${AGENT}`,
      "codex  running  bazhen  /work",
      "launched by coordinator-1",
      "tasks:",
      `  ${TASK}  Write the notes  as worker, reporting to coordinator-1`,
    ]);
  });

  it("says a task an agent owns, given with no assignment above, reports to its owner", () => {
    const owned = { ...task(TASK, "t"), ownerAgentId: OTHER };
    const state = snapshot(
      [owned],
      [assigned(TASK, AGENT)],
      [agent(AGENT, "BZ-127"), agent(OTHER, "coordinator-1")],
    );
    expect(whoami(state, AGENT)).toContain("as worker, reporting to coordinator-1");
  });

  it("says a task the human gave reports to the human", () => {
    const state = snapshot([task(TASK, "t")], [assigned(TASK, AGENT)], [agent(AGENT, "BZ-127")]);
    expect(whoami(state, AGENT)).toContain("as worker, reporting to the human");
  });

  it("wants to run inside an agent", () => {
    expect(usage(["whoami"])).toContain("inside an agent");
  });
});
