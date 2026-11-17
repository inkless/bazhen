import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { type Scene, scene } from "./cli.ts";
import { AGENT, OTHER, UUID, agent, ago, shell, snapshot } from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const SH1 = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c71";
const SH2 = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c72";
const SH3 = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c73";
const SH4 = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c74";
const NOT_RUNNING = "bazhen is not running; start it with `bazhen start`\n";

const reviewer = agent(AGENT, "reviewer", { generation: 2 });

/** The daemon holding `shells` beside the reviewer, and answering a shell's close with `eventIds`. */
const holding = (shells: StateSnapshot["shells"], eventIds: number[] = [9]) => {
  s.daemon.answer("GET /v1/state", StateSnapshot, snapshot({ agents: [reviewer], shells }));
  for (const sh of shells) {
    s.daemon.answer(`POST /v1/shells/${sh.id}/close`, ShellCommandResponse, {
      terminalId: sh.id,
      eventIds,
    });
  }
};

const opened = () =>
  s.daemon.answer("POST /v1/shells", ShellCommandResponse, { terminalId: SH3, eventIds: [5] });

describe("bazhen shells list", () => {
  const build = shell(SH1, {
    name: "build",
    linkedAgentId: AGENT,
    foreground: { command: "vim", since: ago(30) },
  });
  const plain = shell(SH2, { cwd: "/tmp" });
  const gone = shell(SH3, { name: "old", state: "closed" });
  const failed = shell(SH4, { state: "failed" });

  it("lists the shells not closed, one a line, with the agent each is beside and what runs in it", async () => {
    holding([build, plain, gone, failed]);
    expect(await s.bazhen(["shells", "list"])).toEqual({
      code: 0,
      stdout: `build  ${SH1}  running  beside reviewer  vim  /work\n${SH2}  running  /tmp\n`,
      stderr: "",
    });
  });

  it("lists closed and failed shells too with --all, and says when there are none", async () => {
    holding([gone, failed]);
    const all = await s.bazhen(["shells", "list", "--all"]);
    const open = await s.bazhen(["shells", "list"]);
    expect([all.stdout, open.stdout]).toEqual([
      `old  ${SH3}  closed  /work\n${SH4}  failed  /work\n`,
      "no shells\n",
    ]);
  });

  it("prints the shells as the CLI reads them with --json", async () => {
    holding([build, gone]);
    const json = await s.bazhen(["shells", "list", "--json"]);
    const all = await s.bazhen(["shells", "list", "--all", "--json"]);
    expect([JSON.parse(json.stdout), JSON.parse(all.stdout)]).toEqual([[build], [build, gone]]);
  });
});

describe("bazhen shells open", () => {
  it("opens a shell of its own where it runs, in --dir made absolute, or under ~ for the daemon", async () => {
    opened();
    const here = await s.bazhen(["shells", "open"]);
    await s.bazhen(["shells", "open", "--dir", "sub/../app"]);
    await s.bazhen(["shells", "open", "--dir", "~/app"]);
    const key = expect.stringMatching(UUID);
    expect([here, s.daemon.calls("POST /v1/shells").map((r) => r.body)]).toEqual([
      { code: 0, stdout: `opened ${SH3}\n`, stderr: "" },
      [
        { idempotencyKey: key, cwd: s.dir },
        { idempotencyKey: key, cwd: join(s.dir, "app") },
        { idempotencyKey: key, cwd: "~/app" },
      ],
    ]);
  });

  it("opens a shell beside the agent named, in any case, in its directory", async () => {
    holding([]);
    opened();
    const ran = await s.bazhen(["shells", "open", "REVIEWER"]);
    expect([ran, s.daemon.calls("POST /v1/shells").map((r) => r.body)]).toEqual([
      { code: 0, stdout: `opened ${SH3} beside reviewer (${AGENT})\n`, stderr: "" },
      [{ idempotencyKey: expect.stringMatching(UUID), linkedAgentId: AGENT }],
    ]);
  });

  it("prints the daemon's answer as the CLI reads it with --json", async () => {
    opened();
    const ran = await s.bazhen(["shells", "open", "--json"]);
    expect(JSON.parse(ran.stdout)).toEqual({ terminalId: SH3, eventIds: [5] });
  });

  it("refuses an agent and a --dir together, sending nothing, and an agent the daemon doesn't have", async () => {
    holding([]);
    const both = await s.bazhen(["shells", "open", "reviewer", "--dir", "/tmp"]);
    const missing = await s.bazhen(["shells", "open", "nobody"]);
    expect([
      [both.code, both.stderr.split("\n")[0]],
      [missing.code, missing.stderr],
      s.daemon.routes(),
    ]).toEqual([
      [2, "a shell beside an agent opens in its directory, so takes no --dir"],
      [1, "the daemon has no agent nobody\n"],
      ["GET /v1/state"],
    ]);
  });
});

describe("bazhen shells close", () => {
  it("closes the shell its id or name names, at its generation", async () => {
    holding([shell(SH1, { name: "build", generation: 4 }), shell(SH2, { generation: 7 })]);
    const byName = await s.bazhen(["shells", "close", "build"]);
    const byId = await s.bazhen(["shells", "close", SH2]);
    expect([byName, byId]).toEqual([
      { code: 0, stdout: `closed build (${SH1})\n`, stderr: "" },
      { code: 0, stdout: `closed ${SH2}\n`, stderr: "" },
    ]);
    const key = expect.stringMatching(UUID);
    expect(s.daemon.received.filter((r) => r.method === "POST")).toEqual([
      expect.objectContaining({
        path: `/v1/shells/${SH1}/close`,
        body: { idempotencyKey: key, generation: 4 },
      }),
      expect.objectContaining({
        path: `/v1/shells/${SH2}/close`,
        body: { idempotencyKey: key, generation: 7 },
      }),
    ]);
  });

  it("asks for what the switches say: a busy close, and a forced one", async () => {
    holding([shell(SH1)]);
    await s.bazhen(["shells", "close", SH1, "--confirm-busy"]);
    await s.bazhen(["shells", "close", SH1, "--force"]);
    const bodies = s.daemon.calls(`POST /v1/shells/${SH1}/close`).map((r) => r.body);
    expect(bodies).toEqual([
      { idempotencyKey: expect.stringMatching(UUID), generation: 1, confirmBusy: true },
      { idempotencyKey: expect.stringMatching(UUID), generation: 1, force: true },
    ]);
  });

  it("takes a name only one open shell has, past a closed one of that name", async () => {
    holding([
      shell(SH1, { name: "build", state: "closed" }),
      shell(SH2, { name: "build" }),
      shell(SH3, { name: "logs" }),
    ]);
    await s.bazhen(["shells", "close", "build"]);
    expect(s.daemon.received.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
      `/v1/shells/${SH2}/close`,
    ]);
  });

  it("refuses, sending no close, a name two open shells have, or one none has", async () => {
    holding([shell(SH1, { name: "build" }), shell(SH2, { name: "build" })]);
    const two = await s.bazhen(["shells", "close", "build"]);
    const none = await s.bazhen(["shells", "close", "logs"]);
    expect([two, none]).toEqual([
      {
        code: 1,
        stdout: "",
        stderr: `2 open shells are named build: name one by its id, ${SH1} or ${SH2}\n`,
      },
      { code: 1, stdout: "", stderr: "the daemon has no open shell logs\n" },
    ]);
    expect(s.daemon.routes()).toEqual(["GET /v1/state", "GET /v1/state"]);
  });

  it("prints a busy close's refusal and exits 1, saying how to close anyway, but not once confirmed", async () => {
    holding([shell(SH1)]);
    const path = `/v1/shells/${SH1}/close`;
    const busy = {
      error: "busy" as const,
      message: "vim is running in the shell; close anyway to end it",
      busy: [{ terminalId: SH1, program: "vim" }],
    };
    s.daemon.fail(`POST ${path}`, 409, busy);
    const plain = await s.bazhen(["shells", "close", SH1]);
    const confirmed = await s.bazhen(["shells", "close", SH1, "--confirm-busy"]);
    const refusal = `${path}: HTTP 409: ${JSON.stringify(busy)}\n`;
    expect([plain, confirmed]).toEqual([
      {
        code: 1,
        stdout: "",
        stderr: `${refusal}close again with --confirm-busy to end what runs\n`,
      },
      { code: 1, stdout: "", stderr: refusal },
    ]);
  });

  it("prints the daemon's refusal of an agent as the daemon said it", async () => {
    holding([shell(SH1)]);
    const forbidden = { error: "forbidden" as const, message: "an agent can't close a shell" };
    s.daemon.fail(`POST /v1/shells/${SH1}/close`, 403, forbidden);
    const ran = await s.bazhen(["shells", "close", SH1], { BAZHEN_AGENT_ID: OTHER });
    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr: `/v1/shells/${SH1}/close: HTTP 403: ${JSON.stringify(forbidden)}\n`,
    });
  });

  it("prints the daemon's answer with --json, and says so when there was nothing to do", async () => {
    holding([shell(SH1, { name: "build" })], []);
    const json = await s.bazhen(["shells", "close", SH1, "--json"]);
    const plain = await s.bazhen(["shells", "close", SH1]);
    expect([JSON.parse(json.stdout), plain.stdout]).toEqual([
      { terminalId: SH1, eventIds: [] },
      `build (${SH1}): nothing to do\n`,
    ]);
  });
});

describe("bazhen shells", () => {
  it("refuses a missing or unknown action, another's option, and a word too many, sending nothing", async () => {
    const runs = await Promise.all([
      s.bazhen(["shells"]),
      s.bazhen(["shells", "restart", SH1]),
      s.bazhen(["shells", "list", "--force"]),
      s.bazhen(["shells", "open", "--confirm-busy"]),
      s.bazhen(["shells", "close", SH1, "--dir", "/tmp"]),
      s.bazhen(["shells", "list", "all"]),
      s.bazhen(["shells", "close", SH1, SH2]),
      s.bazhen(["shells", "close"]),
    ]);
    expect(runs.map((r) => [r.code, r.stderr.split("\n")[0]])).toEqual([
      [2, "missing list, open or close"],
      [2, "shells takes list, open or close, not restart"],
      [2, "shells list takes no --force"],
      [2, "shells open takes no --confirm-busy"],
      [2, "shells close takes no --dir"],
      [2, "shells list takes no all"],
      [2, `shells close takes no ${SH2}`],
      [2, "missing the shell"],
    ]);
    expect(runs[0]?.stderr).toContain("  bazhen shells close <shell> [--confirm-busy] [--force]");
    expect(s.daemon.received).toEqual([]);
  });

  it("exits 3 when no daemon answers", async () => {
    await s.daemon.close();
    expect(await s.bazhen(["shells", "list"])).toEqual({
      code: 3,
      stdout: "",
      stderr: NOT_RUNNING,
    });
  });
});
