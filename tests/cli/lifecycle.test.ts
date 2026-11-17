import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentCommandResponse,
  LaunchAgentResponse,
  SignalAgentRequest,
  StateSnapshot,
} from "@bazhen/protocol";
import { type Scene, scene } from "./cli.ts";
import { AGENT, OTHER, UUID, agent, snapshot } from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const TERM = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const NOT_RUNNING = "bazhen is not running; start it with `bazhen start`\n";

/** The daemon holding `agents`, and answering each command on one with `eventIds`. */
const holding = (agents: StateSnapshot["agents"], eventIds: number[] = [7]) => {
  s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents }));
  for (const a of agents) {
    for (const action of ["close", "respawn", "relaunch", "signal"]) {
      s.daemon.answer(`POST /v1/agents/${a.id}/${action}`, AgentCommandResponse, {
        agentId: a.id,
        eventIds,
      });
    }
  }
};

const running = agent(AGENT, "reviewer", { generation: 3, terminalId: TERM });

const launched = () =>
  s.daemon.answer("POST /v1/agents", LaunchAgentResponse, {
    agentId: AGENT,
    terminalId: TERM,
    eventIds: [1, 2],
  });

describe("bazhen launch", () => {
  it("launches the harness where it runs, named and with the role given", async () => {
    launched();
    const ran = await s.bazhen(["launch", "claude-code", "--name", "reviewer", "--role", "worker"]);
    expect([ran, s.daemon.calls("POST /v1/agents").map((r) => r.body)]).toEqual([
      { code: 0, stdout: `launched reviewer (${AGENT})\n`, stderr: "" },
      [
        {
          idempotencyKey: expect.stringMatching(UUID),
          harness: "claude-code",
          cwd: s.dir,
          name: "reviewer",
          role: "worker",
        },
      ],
    ]);
  });

  it("starts in --dir, made absolute from where it runs, or left for the daemon under ~", async () => {
    launched();
    await s.bazhen(["launch", "codex", "--dir", "sub/../app"]);
    await s.bazhen(["launch", "codex", "--dir", "~/app"]);
    expect(s.daemon.calls("POST /v1/agents").map((r) => r.body)).toEqual([
      { idempotencyKey: expect.stringMatching(UUID), harness: "codex", cwd: join(s.dir, "app") },
      { idempotencyKey: expect.stringMatching(UUID), harness: "codex", cwd: "~/app" },
    ]);
  });

  it("prints the daemon's answer with --json, and an unnamed agent by its id", async () => {
    launched();
    const json = await s.bazhen(["launch", "codex", "--json"]);
    const plain = await s.bazhen(["launch", "codex"]);
    expect([JSON.parse(json.stdout), plain.stdout]).toEqual([
      { agentId: AGENT, terminalId: TERM, eventIds: [1, 2] },
      `launched ${AGENT}\n`,
    ]);
  });

  it("refuses, sending nothing, a harness it doesn't know, a bad name or role, and a word too many", async () => {
    const runs = await Promise.all([
      s.bazhen(["launch"]),
      s.bazhen(["launch", "vim"]),
      s.bazhen(["launch", "codex", "--name", "two words"]),
      s.bazhen(["launch", "codex", "--role", "Lead"]),
      s.bazhen(["launch", "codex", "now"]),
    ]);
    expect(runs.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [2, "missing the harness"],
      [2, "the harness is claude-code or codex, not vim"],
      [2, expect.stringMatching(/^a name is 1 to 40 letters/)],
      [2, "--role is a role bazhen roles lists, not Lead"],
      [2, "launch takes no now"],
    ]);
    expect(s.daemon.received).toEqual([]);
  });

  it("exits 3 when no daemon answers", async () => {
    await s.daemon.close();
    expect(await s.bazhen(["launch", "codex"])).toEqual({
      code: 3,
      stdout: "",
      stderr: NOT_RUNNING,
    });
  });
});

describe("bazhen close, respawn, relaunch and signal", () => {
  it("sends each command for the agent the name names, at its generation", async () => {
    holding([running]);
    const runs = [
      await s.bazhen(["close", "reviewer"]),
      await s.bazhen(["respawn", "reviewer"]),
      await s.bazhen(["relaunch", "reviewer"]),
      await s.bazhen(["signal", "reviewer", "TERM"]),
    ];
    expect(runs).toEqual([
      { code: 0, stdout: `closed reviewer (${AGENT})\n`, stderr: "" },
      { code: 0, stdout: `respawned reviewer (${AGENT})\n`, stderr: "" },
      { code: 0, stdout: `relaunched reviewer (${AGENT})\n`, stderr: "" },
      { code: 0, stdout: `sent SIGTERM to reviewer (${AGENT})\n`, stderr: "" },
    ]);
    const key = { idempotencyKey: expect.stringMatching(UUID), generation: 3 };
    expect(s.daemon.received.filter((r) => r.method === "POST")).toEqual([
      expect.objectContaining({ path: `/v1/agents/${AGENT}/close`, body: key }),
      expect.objectContaining({ path: `/v1/agents/${AGENT}/respawn`, body: key }),
      expect.objectContaining({ path: `/v1/agents/${AGENT}/relaunch`, body: key }),
      expect.objectContaining({
        path: `/v1/agents/${AGENT}/signal`,
        body: { ...key, signal: "SIGTERM" },
      }),
    ]);
  });

  it("asks for what the switches say: a busy close, a forced one, a fresh relaunch", async () => {
    holding([running]);
    await s.bazhen(["close", AGENT, "--confirm-busy"]);
    await s.bazhen(["close", AGENT, "--force"]);
    await s.bazhen(["relaunch", AGENT, "--fresh"]);
    const bodies = s.daemon.received.filter((r) => r.method === "POST").map((r) => r.body);
    expect(bodies).toEqual([
      expect.objectContaining({ confirmBusy: true }),
      expect.objectContaining({ force: true }),
      expect.objectContaining({ fresh: true }),
    ]);
    expect(bodies[0]).not.toHaveProperty("force");
    expect(bodies[1]).not.toHaveProperty("confirmBusy");
  });

  it("takes a name as the agent not ended that holds it, and an id as that agent whatever its state", async () => {
    const ended = agent(OTHER, "reviewer", { state: "closed", generation: 1 });
    holding([ended, running]);
    await s.bazhen(["close", "reviewer"]);
    await s.bazhen(["close", OTHER]);
    expect(s.daemon.received.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
      `/v1/agents/${AGENT}/close`,
      `/v1/agents/${OTHER}/close`,
    ]);
  });

  it("takes a name in any case, as the daemon does", async () => {
    holding([running]);
    const ran = await s.bazhen(["respawn", "REVIEWER"]);
    expect([ran, s.daemon.calls(`POST /v1/agents/${AGENT}/respawn`).length]).toEqual([
      { code: 0, stdout: `respawned reviewer (${AGENT})\n`, stderr: "" },
      1,
    ]);
  });

  it("reads a signal as kill does, with or without SIG, in either case, and refuses any other", async () => {
    holding([running]);
    for (const given of ["int", "SIGHUP", "Kill", "sigterm"])
      await s.bazhen(["signal", AGENT, given]);
    const usr1 = await s.bazhen(["signal", AGENT, "USR1"]);
    const none = await s.bazhen(["signal", AGENT]);
    expect(
      s.daemon
        .calls(`POST /v1/agents/${AGENT}/signal`)
        .map((r) => SignalAgentRequest.parse(r.body).signal),
    ).toEqual(["SIGINT", "SIGHUP", "SIGKILL", "SIGTERM"]);
    expect([usr1, none].map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [2, "the signal is INT, TERM, HUP or KILL, not USR1"],
      [2, "missing the signal"],
    ]);
  });

  it("refuses, sending no command, an agent the daemon doesn't have or one with no terminal yet", async () => {
    holding([agent(OTHER, "starting", { state: "starting" })]);
    const missing = await s.bazhen(["respawn", "nobody"]);
    const early = await s.bazhen(["close", "starting"]);
    expect([missing, early]).toEqual([
      { code: 1, stdout: "", stderr: "the daemon has no agent nobody\n" },
      { code: 1, stdout: "", stderr: `starting (${OTHER}) has no terminal yet\n` },
    ]);
    expect(s.daemon.routes()).toEqual(["GET /v1/state", "GET /v1/state"]);
  });

  it("prints a stale generation's refusal and exits 1, never trying again at the new one", async () => {
    holding([running]);
    const stale = { error: "stale_generation" as const, message: "agent is at generation 4" };
    s.daemon.fail(`POST /v1/agents/${AGENT}/close`, 409, stale);
    const ran = await s.bazhen(["close", "reviewer"]);
    expect([ran, s.daemon.calls(`POST /v1/agents/${AGENT}/close`)]).toEqual([
      {
        code: 1,
        stdout: "",
        stderr: `/v1/agents/${AGENT}/close: HTTP 409: ${JSON.stringify(stale)}\n`,
      },
      [expect.anything()],
    ]);
  });

  it("prints a busy close's refusal and exits 1, saying how to close anyway", async () => {
    holding([running]);
    const busy = {
      error: "busy" as const,
      message: "vim is running in reviewer; close anyway to end it",
      busy: [{ terminalId: TERM, program: "vim" }],
    };
    s.daemon.fail(`POST /v1/agents/${AGENT}/close`, 409, busy);
    const ran = await s.bazhen(["close", "reviewer"]);
    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr:
        `/v1/agents/${AGENT}/close: HTTP 409: ${JSON.stringify(busy)}\n` +
        "close again with --confirm-busy to end what runs\n",
    });
  });

  it("adds nothing to a close refused but not as busy, nor to one that confirmed", async () => {
    holding([running]);
    const path = `/v1/agents/${AGENT}/close`;
    const busy = { error: "busy" as const, message: "less is running in reviewer" };
    const conflict = { error: "conflict" as const, message: "reviewer is closing" };
    s.daemon.fail(`POST ${path}`, 409, busy);
    const confirmed = await s.bazhen(["close", "reviewer", "--confirm-busy"]);
    s.daemon.fail(`POST ${path}`, 409, conflict);
    const other = await s.bazhen(["close", "reviewer"]);
    expect([confirmed, other]).toEqual([
      { code: 1, stdout: "", stderr: `${path}: HTTP 409: ${JSON.stringify(busy)}\n` },
      { code: 1, stdout: "", stderr: `${path}: HTTP 409: ${JSON.stringify(conflict)}\n` },
    ]);
  });

  it("asks as the agent it runs in, and prints the daemon's refusal of an agent as the daemon said it", async () => {
    holding([running]);
    const forbidden = { error: "forbidden" as const, message: "an agent can't signal an agent" };
    s.daemon.fail(`POST /v1/agents/${AGENT}/signal`, 403, forbidden);
    const ran = await s.bazhen(["signal", "reviewer", "INT"], { BAZHEN_AGENT_ID: OTHER });
    const sent = s.daemon.calls(`POST /v1/agents/${AGENT}/signal`);
    expect([ran, sent.map((r) => r.headers["bazhen-agent-id"])]).toEqual([
      {
        code: 1,
        stdout: "",
        stderr: `/v1/agents/${AGENT}/signal: HTTP 403: ${JSON.stringify(forbidden)}\n`,
      },
      [OTHER],
    ]);
  });

  it("prints the daemon's answer with --json, and says so when there was nothing to do", async () => {
    holding([running], []);
    const json = await s.bazhen(["respawn", "reviewer", "--json"]);
    const plain = await s.bazhen(["respawn", "reviewer"]);
    expect([JSON.parse(json.stdout), plain.stdout]).toEqual([
      { agentId: AGENT, eventIds: [] },
      `reviewer (${AGENT}): nothing to do\n`,
    ]);
  });

  it("refuses another verb's option, here and on a task verb, and a word too many, sending nothing", async () => {
    const runs = await Promise.all([
      s.bazhen(["respawn", AGENT, "--fresh"]),
      s.bazhen(["signal", AGENT, "INT", "--force"]),
      s.bazhen(["close", AGENT, "--wait"]),
      s.bazhen(["task", "list", "--confirm-busy"]),
      s.bazhen(["close", AGENT, "now"]),
      s.bazhen(["close"]),
    ]);
    expect(runs.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [2, "respawn takes no --fresh"],
      [2, "signal takes no --force"],
      [2, "close takes no --wait"],
      [2, "--confirm-busy is for close"],
      [2, "close takes no now"],
      [2, "missing the agent"],
    ]);
    expect(s.daemon.received).toEqual([]);
  });
});
