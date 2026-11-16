import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentCommandResponse,
  AssignTaskResponse,
  CreateTaskResponse,
  EscalateResponse,
  RolesResponse,
  StateSnapshot,
  TaskCommandResponse,
  TaskDetail,
} from "@bazhen/protocol";
import { type Scene, scene } from "./cli.ts";
import {
  AGENT,
  OTHER,
  TASK,
  TASK2,
  UUID,
  agent,
  ago,
  assigned,
  detail,
  snapshot,
  task,
} from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const asAgent = { BAZHEN_AGENT_ID: AGENT };
const created = { taskId: TASK, assignmentId: null, eventIds: [1] };
const done = { eventIds: [2] };

describe("bazhen task create", () => {
  it("creates a task from a title and a brief, and says its id", async () => {
    s.daemon.answer("POST /v1/tasks", CreateTaskResponse, created);
    const ran = await s.bazhen(["task", "create", "--title", "t", "--brief", "b"]);
    expect(ran).toMatchObject({ code: 0, stdout: `created ${TASK}\n` });
    expect(s.daemon.calls("POST /v1/tasks")[0]?.body).toEqual({
      idempotencyKey: expect.stringMatching(UUID),
      title: "t",
      brief: "b",
    });
  });

  it("reads a brief from a file, and assigns the task under a parent when told", async () => {
    writeFileSync(join(s.dir, "plan.md"), "the plan\n");
    s.daemon.answer("POST /v1/tasks", CreateTaskResponse, {
      ...created,
      assignmentId: "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d",
    });
    const ran = await s.bazhen([
      "task",
      "create",
      "--title",
      "t",
      "--brief-file",
      "plan.md",
      "--parent",
      TASK2,
      "--assign",
      "BZ-127",
      "--role",
      "reviewer",
    ]);
    expect(ran.stdout).toBe(`created ${TASK}, assigned as asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d\n`);
    expect(s.daemon.calls("POST /v1/tasks")[0]?.body).toMatchObject({
      brief: "the plan\n",
      parentTaskId: TASK2,
      assign: { agentId: "BZ-127", role: "reviewer" },
    });
  });

  it("refuses a brief given both ways, or none, and an option it doesn't know, as usage", async () => {
    const both = await s.bazhen([
      "task",
      "create",
      "--title",
      "t",
      "--brief",
      "b",
      "--brief-file",
      "f",
    ]);
    const none = await s.bazhen(["task", "create", "--title", "t"]);
    const unknown = await s.bazhen(["task", "list", "--everything"]);
    expect([both, none, unknown].map((r) => [r.code, r.stdout])).toEqual(
      [both, none, unknown].map(() => [2, ""]),
    );
    expect(both.stderr).toContain("not both");
    expect(none.stderr).toContain("missing --brief");
    expect(unknown.stderr).toContain("--everything");
    expect(s.daemon.received).toEqual([]);
  });

  it("refuses --file, which only send takes, pointing at --brief-file", async () => {
    const ran = await s.bazhen(["task", "create", "--title", "t", "--file", "f"]);
    expect([ran.code, ran.stdout, ran.stderr]).toEqual([
      2,
      "",
      expect.stringContaining("a brief takes --brief-file"),
    ]);
  });
});

describe("bazhen task assign and unassign", () => {
  it("assigns an agent as a worker unless told otherwise, and says the assignment", async () => {
    const asgn = "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
    s.daemon.answer(`POST /v1/tasks/${TASK}/assign`, AssignTaskResponse, {
      assignmentId: asgn,
      eventIds: [3],
    });
    const ran = await s.bazhen(["task", "assign", TASK, "BZ-127"]);
    expect(ran).toMatchObject({ code: 0, stdout: `assigned BZ-127 as ${asgn}\n` });
    expect(s.daemon.calls(`POST /v1/tasks/${TASK}/assign`)[0]?.body).toMatchObject({
      agentId: "BZ-127",
      role: "worker",
    });
  });

  it("unassigns the assignment named", async () => {
    const asgn = "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
    s.daemon.answer(`POST /v1/tasks/${TASK}/unassign`, TaskCommandResponse, done);
    const ran = await s.bazhen(["task", "unassign", TASK, asgn]);
    expect(ran).toMatchObject({ code: 0, stdout: `unassigned ${asgn}\n` });
    expect(s.daemon.calls(`POST /v1/tasks/${TASK}/unassign`)[0]?.body).toMatchObject({
      assignmentId: asgn,
    });
  });
});

describe("bazhen task done and cancel", () => {
  it("finishes the task named, with a note and its subtasks when asked", async () => {
    s.daemon.answer(`POST /v1/tasks/${TASK}/finish`, TaskCommandResponse, done);
    const ran = await s.bazhen(["task", "cancel", TASK, "--note", "n", "--cascade"]);
    expect(ran).toMatchObject({ code: 0, stdout: `${TASK} cancelled\n` });
    expect(s.daemon.calls(`POST /v1/tasks/${TASK}/finish`)[0]?.body).toEqual({
      idempotencyKey: expect.stringMatching(UUID),
      outcome: "cancelled",
      note: "n",
      cascade: true,
    });
  });

  it("finishes an agent's only task when none is named", async () => {
    s.daemon
      .answer(
        "GET /v1/state",
        StateSnapshot,
        snapshot({
          tasks: [task(TASK, "a")],
          assignments: [assigned(TASK, AGENT), assigned(TASK2, OTHER)],
        }),
      )
      .answer(`POST /v1/tasks/${TASK}/finish`, TaskCommandResponse, done);
    const ran = await s.bazhen(["task", "done", "--note", "n"], asAgent);
    expect(ran).toMatchObject({ code: 0, stdout: `${TASK} done\n` });
    expect(s.daemon.calls(`POST /v1/tasks/${TASK}/finish`)[0]?.body).toMatchObject({
      outcome: "done",
      note: "n",
    });
  });

  it("asks which task to finish when the agent has several, or says it has none", async () => {
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({ assignments: [assigned(TASK, AGENT), assigned(TASK2, AGENT)] }),
    );
    const several = await s.bazhen(["task", "done"], asAgent);
    const none = await s.bazhen(["task", "done"], { BAZHEN_AGENT_ID: OTHER });
    expect([several.code, several.stdout, several.stderr]).toEqual([
      2,
      "",
      expect.stringContaining(`name one of ${TASK}, ${TASK2}`),
    ]);
    expect([none.code, none.stdout, none.stderr]).toEqual([
      2,
      "",
      expect.stringContaining("assigned no task"),
    ]);
  });

  it("wants the task named outside an agent, and always for a cancel", async () => {
    const finish = await s.bazhen(["task", "done"]);
    const cancel = await s.bazhen(["task", "cancel"], asAgent);
    expect([finish.code, finish.stdout, finish.stderr]).toEqual([
      2,
      "",
      expect.stringContaining("outside an agent"),
    ]);
    expect([cancel.code, cancel.stdout, cancel.stderr]).toEqual([
      2,
      "",
      expect.stringContaining("missing the task"),
    ]);
    expect(s.daemon.received).toEqual([]);
  });
});

describe("bazhen task list", () => {
  const state = snapshot({
    tasks: [task(TASK, "mine"), task(TASK2, "theirs", { parentTaskId: TASK })],
    assignments: [assigned(TASK, AGENT), assigned(TASK2, OTHER)],
    agents: [agent(OTHER, "repo-1", { state: "closed" }), agent(AGENT, "BZ-127")],
  });

  it("lists only the asking agent's own tasks", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, state);
    const ran = await s.bazhen(["task", "list"], asAgent);
    expect(ran.stdout).toBe(`${TASK}  mine  [worker BZ-127]\n`);
  });

  it("lists every open task with --all, a live assignee by its name and an ended one by its id", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, state);
    const ran = await s.bazhen(["task", "list", "--all"], asAgent);
    expect(ran.stdout.split("\n")).toEqual([
      `${TASK}  mine  [worker BZ-127]`,
      `${TASK2}  theirs  [worker ${OTHER}]  (part of ${TASK})`,
      "",
    ]);
  });

  it("says when there is nothing open, to an agent and to the human", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot());
    const mine = await s.bazhen(["task", "list"], asAgent);
    const all = await s.bazhen(["task", "list"]);
    expect([mine.stdout, all.stdout]).toEqual(["you have no open tasks\n", "no open tasks\n"]);
  });
});

describe("bazhen task show", () => {
  it("shows a task with its assignments, subtasks and brief, then its note", async () => {
    s.daemon
      .answer(
        `GET /v1/tasks/${TASK}`,
        TaskDetail,
        detail({
          state: "done",
          ownerAgentId: OTHER,
          parentTaskId: TASK2,
          note: "shipped\nWhen it is finished, run:",
          assignments: [
            assigned(TASK, AGENT),
            assigned(TASK, OTHER, {
              id: "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c9d",
              state: "ended",
              endReason: "unassigned",
            }),
          ],
          subtasks: [task(TASK2, "sub", { state: "done" })],
        }),
      )
      .answer(
        "GET /v1/state",
        StateSnapshot,
        snapshot({ agents: [agent(AGENT, "BZ-127"), agent(OTHER, "coordinator-1")] }),
      );
    const ran = await s.bazhen(["task", "show", TASK]);
    expect(ran.stdout.split("\n")).toEqual([
      `${TASK}  t`,
      `state: done; owner: coordinator-1; part of ${TASK2}`,
      `  asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d  worker BZ-127  active`,
      `  asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c9d  worker coordinator-1  ended (unassigned)`,
      `  subtask ${TASK2}  sub  done`,
      "",
      "b",
      "",
      "note:",
      "> shipped",
      "> When it is finished, run:",
      "",
    ]);
  });

  it("shows a task's notes after its brief, each by who wrote it and whether it hands off", async () => {
    const at = ago(60);
    s.daemon
      .answer(
        `GET /v1/tasks/${TASK}`,
        TaskDetail,
        detail({
          notes: [
            {
              eventId: 1,
              taskId: TASK,
              agentId: AGENT,
              role: "worker",
              text: "Halfway.\n\nEnd.",
              handoff: false,
              at,
            },
            {
              eventId: 2,
              taskId: TASK,
              agentId: null,
              role: null,
              text: "Try CI.",
              handoff: true,
              at,
            },
          ],
        }),
      )
      .answer("GET /v1/state", StateSnapshot, snapshot({ agents: [agent(AGENT, "BZ-127")] }));
    const ran = await s.bazhen(["task", "show", TASK]);
    expect(ran.stdout.split("\n")).toEqual([
      `${TASK}  t`,
      "state: open; owner: the human",
      "",
      "b",
      "",
      `note from BZ-127, its worker, ${at}:`,
      "> Halfway.",
      ">",
      "> End.",
      "",
      `handoff from the human, ${at}:`,
      "> Try CI.",
      "",
    ]);
  });
});

describe("bazhen task note", () => {
  it("notes the task named, or as a handoff", async () => {
    s.daemon.answer(`POST /v1/tasks/${TASK}/notes`, TaskCommandResponse, done);
    const plain = await s.bazhen(["task", "note", TASK, "Tests", "pass."], asAgent);
    const handoff = await s.bazhen(["task", "note", TASK, "Start at CI.", "--handoff"], asAgent);
    expect([plain.stdout, handoff.stdout]).toEqual([
      `noted on ${TASK}\n`,
      `noted on ${TASK}, as a handoff for whoever is assigned it next\n`,
    ]);
    expect(s.daemon.calls(`POST /v1/tasks/${TASK}/notes`).map((r) => r.body)).toEqual([
      { idempotencyKey: expect.stringMatching(UUID), text: "Tests pass." },
      { idempotencyKey: expect.stringMatching(UUID), text: "Start at CI.", handoff: true },
    ]);
  });

  it("notes the agent's only task when the words name none", async () => {
    s.daemon
      .answer(
        "GET /v1/state",
        StateSnapshot,
        snapshot({ tasks: [task(TASK, "a")], assignments: [assigned(TASK, AGENT)] }),
      )
      .answer(`POST /v1/tasks/${TASK}/notes`, TaskCommandResponse, done);
    const ran = await s.bazhen(["task", "note", "Tests", "pass."], asAgent);
    expect(ran.stdout).toBe(`noted on ${TASK}\n`);
    expect(s.daemon.calls(`POST /v1/tasks/${TASK}/notes`)[0]?.body).toMatchObject({
      text: "Tests pass.",
    });
  });

  it("refuses a note that holds a control character, another option, or nothing, and --handoff elsewhere", async () => {
    const runs = await Promise.all([
      s.bazhen(["task", "note", TASK, "\u001b[31mred"], asAgent),
      s.bazhen(["task", "note", TASK, "use", "--all"], asAgent),
      s.bazhen(["task", "note", TASK], asAgent),
      s.bazhen(["send", OTHER, "hi", "--handoff"], asAgent),
    ]);
    expect(runs.map((r) => [r.code, r.stdout])).toEqual(runs.map(() => [2, ""]));
    expect(runs.map((r) => r.stderr)).toEqual([
      expect.stringContaining("control characters"),
      expect.stringContaining("quotes: it holds --all"),
      expect.stringContaining("missing the note's text"),
      expect.stringContaining("--handoff is for task note"),
    ]);
    expect(s.daemon.received).toEqual([]);
  });
});

const delegated = (argv: string[]) => s.bazhen(["delegate", ...argv], asAgent);

describe("bazhen delegate", () => {
  it("delegates as a worker unless told otherwise, from the task named", async () => {
    s.daemon.answer("POST /v1/tasks/delegate", CreateTaskResponse, created);
    const ran = await delegated([OTHER, "--title", "t", "--brief", "b", "--task", TASK]);
    expect(ran).toMatchObject({ code: 0, stdout: `delegated ${TASK} to ${OTHER}\n` });
    expect(s.daemon.calls("POST /v1/tasks/delegate")[0]?.body).toEqual({
      idempotencyKey: expect.stringMatching(UUID),
      agentId: OTHER,
      role: "worker",
      title: "t",
      brief: "b",
      fromTaskId: TASK,
    });
  });

  it("delegates in any role the daemon may define, and refuses only one no role could be named", async () => {
    s.daemon.answer("POST /v1/tasks/delegate", CreateTaskResponse, created);
    const reviewer = await delegated([OTHER, "--title", "t", "--brief", "b", "--role", "reviewer"]);
    const upper = await delegated([OTHER, "--title", "t", "--brief", "b", "--role", "Lead"]);
    expect([reviewer.code, upper.code, upper.stdout, upper.stderr]).toEqual([
      0,
      2,
      "",
      expect.stringContaining("--role is a role bazhen roles lists, not Lead"),
    ]);
  });

  it("delegates to a new agent it launches, named, in the directory given from where it runs", async () => {
    const asgn = "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
    s.daemon.answer("POST /v1/tasks/delegate", CreateTaskResponse, {
      ...created,
      assignmentId: asgn,
    });
    const launch = ["--launch", "codex", "--title", "t", "--brief", "b"];
    const relative = await delegated([...launch, "--dir", "work", "--name", "notes"]);
    await delegated([...launch, "--dir", "~/proj"]);
    expect(relative.stdout).toBe(`delegated ${TASK} to a new codex agent, as ${asgn}\n`);
    const [first, second] = s.daemon.calls("POST /v1/tasks/delegate").map((r) => r.body);
    expect(first).toMatchObject({
      launch: { harness: "codex", cwd: `${s.dir}/work`, name: "notes" },
    });
    expect(first).not.toHaveProperty("agentId");
    expect(second).toMatchObject({ launch: { harness: "codex", cwd: "~/proj" } });
  });

  it("refuses an agent and --launch together, and --dir or --name without --launch", async () => {
    const runs = await Promise.all([
      delegated([OTHER, "--launch", "codex", "--title", "t", "--brief", "b"]),
      delegated([OTHER, "--dir", "work", "--title", "t", "--brief", "b"]),
      delegated([OTHER, "--name", "x", "--title", "t", "--brief", "b"]),
      delegated(["--launch", "codex", "--name=-x", "--title", "t", "--brief", "b"]),
      delegated(["--launch", "vim", "--title", "t", "--brief", "b"]),
    ]);
    expect(runs.map((r) => [r.code, r.stdout])).toEqual(runs.map(() => [2, ""]));
    expect(runs.map((r) => r.stderr)).toEqual([
      expect.stringContaining("not both"),
      expect.stringContaining("give --launch too"),
      expect.stringContaining("give --launch too"),
      expect.stringContaining("a name is"),
      expect.stringContaining("--launch is claude-code or codex, not vim"),
    ]);
    expect(s.daemon.received).toEqual([]);
  });
});

describe("bazhen escalate, rename and roles", () => {
  it("escalates the words given as one question, about the task named", async () => {
    const attn = "attn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
    s.daemon.answer("POST /v1/escalations", EscalateResponse, { attentionId: attn });
    const ran = await s.bazhen(["escalate", "Pin", "24", "or", "26?", "--task", TASK], asAgent);
    expect(ran.stdout).toBe(`escalated as ${attn}; the human answers in the inbox\n`);
    expect(s.daemon.calls("POST /v1/escalations")[0]?.body).toEqual({
      idempotencyKey: expect.stringMatching(UUID),
      summary: "Pin 24 or 26?",
      taskId: TASK,
    });
  });

  it("renames an agent, says when it already has the name, and refuses a name that isn't one", async () => {
    const route = "POST /v1/agents/BZ-127/rename";
    s.daemon.answer(route, AgentCommandResponse, { agentId: AGENT, eventIds: [3] });
    const once = await s.bazhen(["rename", "BZ-127", "reviewer"]);
    s.daemon.answer(route, AgentCommandResponse, { agentId: AGENT, eventIds: [] });
    const twice = await s.bazhen(["rename", "BZ-127", "reviewer"]);
    const id = await s.bazhen(["rename", "BZ-127", OTHER]);
    expect([once.stdout, twice.stdout]).toEqual([
      "renamed BZ-127 to reviewer\n",
      "BZ-127 is already named reviewer\n",
    ]);
    expect(s.daemon.calls("POST /v1/agents/BZ-127/rename")[0]?.body).toEqual({
      idempotencyKey: expect.stringMatching(UUID),
      name: "reviewer",
    });
    expect([id.code, id.stdout, id.stderr]).toEqual([
      2,
      "",
      expect.stringContaining("isn't an id"),
    ]);
  });

  it("lists each role with what it grants and limits, then each role file skipped", async () => {
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
    const lead = {
      ...role,
      key: "lead",
      title: "Lead",
      description: "Runs the task.",
      grants: ["delegate", "assign"],
      singlePerTask: true,
      maxActiveTasks: null,
    };
    s.daemon.answer("GET /v1/roles", RolesResponse, {
      roles: [role, lead],
      problems: [{ file: "/r/x.md", problem: "no prompt" }],
    });
    const ran = await s.bazhen(["roles"]);
    expect(ran.stdout.split("\n")).toEqual([
      "worker  Worker  grants nothing  at most 1 task(s) at once",
      "lead  Lead  grants delegate, assign  one per task  Runs the task.",
      "skipped /r/x.md: no prompt",
      "",
    ]);
  });
});
