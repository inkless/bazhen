import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, LOGIN_SHELL, bazhen, cliHome, overSocket } from "./daemon.ts";

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

describe("a second daemon on the same home", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("exits already running and leaves the first daemon's socket answering", async () => {
    const second = await daemon.startAnother();
    expect(second).toMatchObject({ code: 1, out: expect.stringContaining("already running") });
    expect((await overSocket(daemon.socket, "GET", "/v1/health")).status).toBe(200);
  });
});

describe("bazhen stop with no daemon", () => {
  let home: Awaited<ReturnType<typeof cliHome>>;
  beforeAll(async () => {
    home = await cliHome();
  });
  afterAll(async () => {
    await home?.cleanup();
  });

  it("fails bazhen doctor, saying the daemon isn't running", async () => {
    expect(await bazhen(["doctor"], home.env)).toMatchObject({
      code: 1,
      out: expect.stringContaining("daemon: not running"),
    });
  });

  it("says it isn't running, and succeeds: stopping is idempotent", async () => {
    expect(await bazhen(["stop"], home.env)).toEqual({ code: 0, out: "bazhen is not running\n" });
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

  it("runs the daemon in /, not the directory it was started from", () => {
    expect(daemon.daemonCwd()).toBe("/");
  });

  it("keeps a parent session's variables from agents, and passes what the config re-allows", async () => {
    const { agentId } = await daemon.launch("env");
    await expect.poll(() => daemon.hasTerminal(agentId)).toBe(true);
    const env = daemon.agentEnv(agentId);
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["ITERM_PROFILE"]).toBe("kept-by-config");
  });
});

describe("bazhen doctor", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.startWithCli("", { CLAUDECODE: "sentinel-value-never-shown" });
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("shows what the daemon runs with: counts per rule, never a variable's value", async () => {
    const { code, out } = await bazhen(["doctor"], daemon.env);
    expect(code).toBe(0);
    expect(out).toContain("CLAUDECODE 1");
    expect(out).toContain(`config: ${daemon.home}/config/config.toml\n`);
    expect(out).not.toContain("sentinel-value-never-shown");
  });
});

describe('agents.shell = "login"', () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.startWithCli('[agents]\nshell = "login"\n', { SHELL: LOGIN_SHELL });
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("starts each agent through the user's login shell, which hands over to the TUI", async () => {
    const { agentId } = await daemon.launch("login");
    await expect.poll(() => daemon.hasTerminal(agentId)).toBe(true);
    const env = daemon.agentEnv(agentId);
    expect([env["BZ_LOGIN_SHELL_ARGS"], env["FROM_RC"]]).toEqual(["-l -i -c", "1"]);
    // The pane's process is the TUI itself, with its own arguments, not a shell left waiting on it.
    const [program, ...args] = daemon.agentCommand(agentId);
    expect(program).not.toMatch(/(^|\/)(sh|bash|zsh|fish|login-shell\.sh)$/);
    expect(args).toContain("--settings");
  });
});
