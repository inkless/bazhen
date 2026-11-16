import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FleetAgents, StateSnapshot } from "@bazhen/protocol";
import { type Scene, scene } from "./cli.ts";
import {
  AGENT,
  OTHER,
  TASK,
  TASK2,
  THIRD,
  agent,
  ago,
  assigned,
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

const working = (signalAge: number, headlineAge: number) => ({
  activity: {
    value: "working" as const,
    source: "native" as const,
    confidence: 1,
    observedAt: ago(signalAge),
  },
  listening: true,
  headline: { text: "Halfway through the tests.", taskId: TASK, at: ago(headlineAge) },
});

const item = (id: string, state: "open" | "closed") => ({
  id,
  agentId: AGENT,
  state,
  closeReason: null,
  summary: "Run it?",
  kind: "approval" as const,
  taskId: null,
  messageId: null,
  openedAt: ago(5),
  actions: [],
});

describe("bazhen agents", () => {
  it("lists the agents not ended, each led by its name, and one with none by its id", async () => {
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({
        agents: [
          agent(AGENT, "BZ-127"),
          agent(OTHER, "old", { state: "closed" }),
          agent(THIRD, "", { state: "failed" }),
          agent("agent_0190c3b2a1d47a3b8c1d2e3f4a5b6cad", ""),
        ],
      }),
    );
    const ran = await s.bazhen(["agents"]);
    expect(ran.stdout.split("\n")).toEqual([
      `BZ-127  ${AGENT}  codex  running  bazhen  /work`,
      "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6cad  codex  running  bazhen  /work",
      "",
    ]);
  });

  it("shows each agent's latest signal with its age at a glance, and its headline under it", async () => {
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({
        agents: [
          agent(AGENT, "seconds", working(5, 30)),
          agent(OTHER, "minutes", { ...working(125, 30), headline: null }),
          agent(THIRD, "hours", { ...working(7300, 30), headline: null }),
          agent("agent_0190c3b2a1d47a3b8c1d2e3f4a5b6cad", "days", {
            ...working(200_000, 30),
            headline: null,
          }),
          agent("agent_0190c3b2a1d47a3b8c1d2e3f4a5b6cbd", "quiet"),
        ],
      }),
    );
    const [first, ...rest] = (await s.bazhen(["agents"])).stdout.split("\n");
    expect(first).toMatch(
      new RegExp(`^seconds  ${AGENT}  codex  running  working [5-9]s  bazhen  /work$`),
    );
    expect(rest).toEqual([
      "  > Halfway through the tests.",
      `minutes  ${OTHER}  codex  running  working 2m  bazhen  /work`,
      `hours  ${THIRD}  codex  running  working 2h  bazhen  /work`,
      "days  agent_0190c3b2a1d47a3b8c1d2e3f4a5b6cad  codex  running  working 2d  bazhen  /work",
      "quiet  agent_0190c3b2a1d47a3b8c1d2e3f4a5b6cbd  codex  running  bazhen  /work",
      "",
    ]);
  });

  it("says when no agent runs", async () => {
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({ agents: [agent(AGENT, "x", { state: "closed" })] }),
    );
    expect((await s.bazhen(["agents"])).stdout).toBe("no agents\n");
  });

  it("gives a program each live agent's signal, listening, headline, tasks and open items", async () => {
    const open = item("attn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d", "open");
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({
        agents: [
          agent(AGENT, "BZ-127", { ...working(125, 30), launchedBy: OTHER }),
          agent(OTHER, "gone", { state: "closed" }),
        ],
        tasks: [task(TASK, "t")],
        assignments: [assigned(TASK, AGENT), assigned(TASK2, AGENT, { state: "ended" })],
        attention: [open, item("attn_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d", "closed")],
      }),
    );
    const ran = await s.bazhen(["agents", "--json"]);
    const printed: unknown = JSON.parse(ran.stdout);
    expect(FleetAgents.safeParse(printed).success).toBe(true);
    expect(printed).toEqual([
      {
        id: AGENT,
        name: "BZ-127",
        harness: "codex",
        state: "running",
        project: "bazhen",
        cwd: "/work",
        launchedBy: OTHER,
        signal: { value: "working", source: "native", ageSeconds: expect.any(Number) },
        listening: true,
        headline: {
          text: "Halfway through the tests.",
          taskId: TASK,
          ageSeconds: expect.any(Number),
        },
        tasks: [{ taskId: TASK, assignmentId: assigned(TASK, AGENT).id, role: "worker" }],
        attention: [{ id: open.id, kind: "approval" }],
      },
    ]);
    const [fleet] = FleetAgents.parse(printed);
    expect(fleet?.signal?.ageSeconds).toBeGreaterThanOrEqual(125);
    expect(fleet?.signal?.ageSeconds).toBeLessThan(135);
    expect(fleet?.headline?.ageSeconds).toBeGreaterThanOrEqual(30);
    expect(fleet?.headline?.ageSeconds).toBeLessThan(40);
  });

  it("prints the fleet as JSON indented by two spaces, one agent with no signal or headline as null", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [agent(AGENT, "quiet")] }));
    const ran = await s.bazhen(["agents", "--json"]);
    expect(ran.stdout).toBe(
      `${JSON.stringify(
        [
          {
            id: AGENT,
            name: "quiet",
            harness: "codex",
            state: "running",
            project: "bazhen",
            cwd: "/work",
            launchedBy: null,
            signal: null,
            listening: false,
            headline: null,
            tasks: [],
            attention: [],
          },
        ],
        null,
        2,
      )}\n`,
    );
  });

  it("prints an attention kind newer than it knows as the daemon named it", async () => {
    const open = { ...item("attn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d", "open"), kind: "a_later_kind" };
    const state = { ...snapshot({ agents: [agent(AGENT, "quiet")] }), attention: [open] };
    s.daemon.raw("GET /v1/state", 200, JSON.stringify(state));
    const ran = await s.bazhen(["agents", "--json"]);
    expect([ran.code, JSON.parse(ran.stdout)]).toEqual([
      0,
      [expect.objectContaining({ attention: [{ id: open.id, kind: "a_later_kind" }] })],
    ]);
  });

  it("prints an empty fleet as an empty JSON list, and takes --json on agents only", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot());
    const empty = await s.bazhen(["agents", "--json"]);
    const elsewhere = await s.bazhen(["task", "list", "--json"]);
    expect([empty.stdout, elsewhere.code, elsewhere.stdout, elsewhere.stderr]).toEqual([
      "[]\n",
      2,
      "",
      expect.stringContaining("--json is for agents"),
    ]);
  });
});

describe("bazhen whoami", () => {
  const asAgent = { BAZHEN_AGENT_ID: AGENT };

  it("says who the agent is, who launched it, and whom it reports to on each task", async () => {
    const parent = assigned(TASK2, OTHER, { role: "coordinator" });
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({
        tasks: [task(TASK, "Write the notes")],
        assignments: [parent, assigned(TASK, AGENT, { parentAssignmentId: parent.id })],
        agents: [agent(AGENT, "BZ-127", { launchedBy: OTHER }), agent(OTHER, "coordinator-1")],
      }),
    );
    const ran = await s.bazhen(["whoami"], asAgent);
    expect(ran.stdout.split("\n")).toEqual([
      `BZ-127  ${AGENT}`,
      "codex  running  bazhen  /work",
      "launched by coordinator-1",
      "tasks:",
      `  ${TASK}  Write the notes  as worker, reporting to coordinator-1`,
      "",
    ]);
  });

  it("says a task an agent owns, given with no assignment above, reports to its owner", async () => {
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({
        tasks: [task(TASK, "t", { ownerAgentId: OTHER })],
        assignments: [assigned(TASK, AGENT)],
        agents: [agent(AGENT, "BZ-127"), agent(OTHER, "coordinator-1")],
      }),
    );
    expect((await s.bazhen(["whoami"], asAgent)).stdout).toContain(
      "as worker, reporting to coordinator-1",
    );
  });

  it("says a task the human gave reports to the human, and an agent the human launched so", async () => {
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({
        tasks: [task(TASK, "t")],
        assignments: [assigned(TASK, AGENT)],
        agents: [agent(AGENT, "BZ-127")],
      }),
    );
    const ran = await s.bazhen(["whoami"], asAgent);
    expect(ran.stdout).toContain("launched by the human\n");
    expect(ran.stdout).toContain("as worker, reporting to the human");
  });

  it("says the role an agent was launched in, beside who launched it", async () => {
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({ agents: [agent(AGENT, "BZ-127", { role: "reviewer" })] }),
    );
    const ran = await s.bazhen(["whoami"], asAgent);
    expect(ran.stdout.split("\n")[2]).toBe("launched by the human, as a reviewer");
  });

  it("says when the agent has no tasks", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [agent(AGENT, "BZ-127")] }));
    expect((await s.bazhen(["whoami"], asAgent)).stdout).toMatch(/\nno tasks\n$/);
  });

  it("names the Codex agent whose thread the command runs in, as Codex runs it outside the agent", async () => {
    const thread = "01a1e0f0-593e-7ae1-9d31-769db26227fc";
    const codexAgent = (id: string, name: string, over = {}) => {
      const a = agent(id, name, over);
      return {
        ...a,
        externalRef: { environmentId: a.environmentId, kind: "codex-thread" as const, id: thread },
      };
    };
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({
        agents: [codexAgent(OTHER, "before", { state: "closed" }), codexAgent(AGENT, "BZ-127")],
      }),
    );
    const ran = await s.bazhen(["whoami"], { CODEX_THREAD_ID: thread });
    expect(ran.stdout.split("\n")[0]).toBe(`BZ-127  ${AGENT}`);
  });

  it("names no agent for a Codex thread no live agent is bound to", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [agent(AGENT, "BZ-127")] }));
    const ran = await s.bazhen(["whoami"], {
      CODEX_THREAD_ID: "01a1e0f0-0000-7000-8000-000000000000",
    });
    expect([ran.code, ran.stdout, ran.stderr]).toEqual([
      2,
      "",
      expect.stringContaining("inside an agent"),
    ]);
  });

  it("says only why it can't answer outside an agent, not every verb's usage", async () => {
    const outside = await s.bazhen(["whoami"]);
    expect(outside.stderr).not.toContain("bazhen agents");
  });

  it("wants to run inside an agent the daemon knows", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot());
    const outside = await s.bazhen(["whoami"]);
    const unknown = await s.bazhen(["whoami"], asAgent);
    expect([outside.code, outside.stdout, outside.stderr]).toEqual([
      2,
      "",
      expect.stringContaining("inside an agent"),
    ]);
    expect([unknown.code, unknown.stdout, unknown.stderr]).toEqual([
      2,
      "",
      expect.stringContaining(`the daemon has no agent ${AGENT}`),
    ]);
  });
});
