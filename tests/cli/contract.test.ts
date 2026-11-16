import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HealthResponse, StateSnapshot } from "@bazhen/protocol";
import { FakeDaemon, type Scene, scene } from "./cli.ts";
import { AGENT, health, snapshot } from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

describe("the command line", () => {
  it("prints the usage of every verb and exits 2 with no verb, or one it doesn't know", async () => {
    const runs = await Promise.all([s.bazhen([]), s.bazhen(["frobnicate"])]);
    expect(runs.map((r) => r.code)).toEqual([2, 2]);
    expect(runs[0]?.stderr.split("\n")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^usage: bazhen <start\|stop\|status\|doctor\|env refresh\|pair\|/),
        "  bazhen agents [--json]",
        "  bazhen task create --title <title> (--brief <text> | --brief-file <path>) [--parent <task>] [--assign <agent> [--role <role>]]",
        "  bazhen send (<agent> | --task <task>) (<text> | --file <path>) [--wait [--timeout <seconds>]]",
      ]),
    );
    expect(runs[1]?.stderr).toBe(runs[0]?.stderr);
    expect(s.daemon.received).toEqual([]);
  });

  it("refuses a task verb it doesn't know", async () => {
    const ran = await s.bazhen(["task", "frobnicate"]);
    expect([ran.code, ran.stderr]).toEqual([
      2,
      expect.stringContaining("unknown task verb frobnicate"),
    ]);
  });
});

describe("a daemon that isn't running", () => {
  it("exits 3, saying how to start it, for a read and for a command", async () => {
    await s.daemon.close();
    const runs = await Promise.all([
      s.bazhen(["status"]),
      s.bazhen(["task", "list"]),
      s.bazhen(["pair"]),
    ]);
    expect(runs.map((r) => [r.code, r.stderr])).toEqual(
      Array.from({ length: 3 }, () => [3, "bazhen is not running; start it with `bazhen start`\n"]),
    );
  });
});

describe("a daemon that refuses", () => {
  it("exits 1, saying the path, the status and what the daemon said", async () => {
    const body = { error: "not_found", message: "no task task_x" };
    s.daemon.fail("GET /v1/tasks/task_x", 404, body);
    const ran = await s.bazhen(["task", "show", "task_x"]);
    expect([ran.code, ran.stderr]).toEqual([
      1,
      `/v1/tasks/task_x: HTTP 404: ${JSON.stringify(body)}\n`,
    ]);
  });

  it("exits 1 on an answer this CLI can't read", async () => {
    s.daemon.fail("GET /v1/state", 200, { agents: "not a list" });
    const ran = await s.bazhen(["agents"]);
    expect([ran.code, ran.stderr]).toEqual([1, expect.stringContaining("/v1/state")]);
  });
});

describe("the daemon a verb reaches", () => {
  it("is the one whose socket started a task verb's caller, though BAZHEN_HOME names another", async () => {
    const elsewhere = join(s.dir, "agent-run");
    mkdirSync(elsewhere);
    const theirs = await FakeDaemon.listen(join(elsewhere, "bazhen.sock"));
    try {
      theirs.answer("GET /v1/state", StateSnapshot, snapshot());
      s.daemon.answer("GET /v1/state", StateSnapshot, snapshot());
      const ran = await s.bazhen(["task", "list", "--all"], {
        BAZHEN_SOCKET: join(elsewhere, "bazhen.sock"),
      });
      expect([ran.code, theirs.routes(), s.daemon.routes()]).toEqual([0, ["GET /v1/state"], []]);
    } finally {
      await theirs.close();
    }
  });

  it("is the one the home names when BAZHEN_SOCKET is empty, and always for a daemon verb", async () => {
    s.daemon
      .answer("GET /v1/state", StateSnapshot, snapshot())
      .answer("GET /v1/health", HealthResponse, health());
    const empty = await s.bazhen(["task", "list"], { BAZHEN_SOCKET: "" });
    const status = await s.bazhen(["status"], { BAZHEN_SOCKET: join(s.dir, "nothing.sock") });
    expect([empty.code, status.code]).toEqual([0, 0]);
    expect(s.daemon.routes().toSorted()).toEqual([
      "GET /v1/health",
      "GET /v1/state",
      "GET /v1/state",
    ]);
  });

  it("is the one under --home, over BAZHEN_HOME", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot());
    const ran = await s.bazhen(["task", "list", "--home", s.home], {
      BAZHEN_HOME: join(s.dir, "other-home"),
    });
    expect([ran.code, s.daemon.routes()]).toEqual([0, ["GET /v1/state"]]);
  });
});

describe("who is asking", () => {
  it("names the agent and the paired device it runs under, when it runs under one", async () => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot());
    const dev = "dev_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
    await s.bazhen(["task", "list"], { BAZHEN_AGENT_ID: AGENT, BAZHEN_DEVICE_ID: dev });
    await s.bazhen(["task", "list", "--all"]);
    const [inside, outside] = s.daemon.received.map((r) => r.headers);
    expect([inside?.["bazhen-agent-id"], inside?.["bazhen-device-id"]]).toEqual([AGENT, dev]);
    expect([outside?.["bazhen-agent-id"], outside?.["bazhen-device-id"]]).toEqual([
      undefined,
      undefined,
    ]);
  });
});
