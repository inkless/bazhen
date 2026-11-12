import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, bazhen, cliHome, overSocket } from "./daemon.ts";

describe("the daemon's Unix socket", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("serves the same commands as HTTP", async () => {
    const http = await daemon.request("/v1/state");
    expect(await overSocket(daemon.socket, "GET", "/v1/state")).toEqual(http);
  });

  it("serves stop on the socket only, never over HTTP", async () => {
    expect((await daemon.request("/v1/daemon/stop", { method: "POST" })).status).toBe(404);
  });

  it("refuses an approval answer from a caller that says it is an agent", async () => {
    const path = "/v1/attention/attn_0190a0b0c0d07e0f8a9b0c1d2e3f4a5b/answer";
    const body = { idempotencyKey: "k", decision: "allow" };
    const asAgent = await overSocket(daemon.socket, "POST", path, {
      headers: { "bazhen-agent-id": "agent_x" },
      body,
    });
    expect([asAgent.status, asAgent.body]).toMatchObject([403, { error: "forbidden" }]);
    expect((await overSocket(daemon.socket, "POST", path, { body })).status).not.toBe(403);
  });
});

describe("bazhen start, status and stop", () => {
  let home: Awaited<ReturnType<typeof cliHome>>;
  beforeAll(async () => {
    home = await cliHome();
  });
  afterAll(async () => {
    await home?.cleanup();
  });

  it("starts the daemon detached, reports it running, and stops it", async () => {
    expect(await bazhen(["start"], home.env)).toMatchObject({
      code: 0,
      out: expect.stringContaining("is running at http://"),
    });
    expect(await bazhen(["start"], home.env)).toMatchObject({
      code: 0,
      out: expect.stringContaining("already running"),
    });
    expect(await bazhen(["status"], home.env)).toMatchObject({
      code: 0,
      out: expect.stringContaining("agents: none"),
    });
    expect((await bazhen(["stop"], home.env)).code).toBe(0);
    expect(await bazhen(["status"], home.env)).toMatchObject({
      code: 3,
      out: expect.stringContaining("not running"),
    });
  });
});

describe("bazhen stop", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("stops the daemon and leaves its agents running in tmux", async () => {
    const { agentId } = await daemon.launch("kept");
    expect((await bazhen(["stop"], daemon.env)).code).toBe(0);
    expect(daemon.hasTerminal(agentId)).toBe(true);
  });
});

describe("bazhen start's environment", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    // From inside a parent Claude Code session, with a name the denylist drops unless passed
    // (not TERM_PROGRAM, which tmux sets in every pane itself).
    daemon = await Daemon.startWithCli('[agents.env]\npassthrough = ["ITERM_PROFILE"]\n', {
      CLAUDECODE: "1",
      ITERM_PROFILE: "kept-by-config",
    });
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("keeps a parent session's variables from agents, and passes what the config re-allows", async () => {
    const { agentId } = await daemon.launch("env");
    await expect.poll(() => daemon.hasTerminal(agentId)).toBe(true);
    const env = daemon.agentEnv(agentId);
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["ITERM_PROFILE"]).toBe("kept-by-config");
  });
});
