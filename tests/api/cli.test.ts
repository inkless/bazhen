import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signalOwnChild } from "@bazhen/host-guard";
import { StateSnapshot } from "@bazhen/protocol";
import {
  Daemon,
  LOGIN_SHELL,
  bazhen,
  cliHome,
  followEvents,
  overSocket,
  waitUntil,
} from "./daemon.ts";

/** What each notice offers its viewer. */
const offered = (state: StateSnapshot) => state.notices.map((n) => n.actions);
/** The state as every viewer sees it: all of it but what a notice offers. */
const shared = (state: StateSnapshot) => ({
  ...state,
  notices: state.notices.map(({ actions: _actions, ...n }) => n),
});

describe("the daemon's Unix socket", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("serves the same commands as HTTP, but for what each caller may do about a notice", async () => {
    const http = await daemon.request("/v1/state");
    const socket = await overSocket(daemon.socket, "GET", "/v1/state");
    const overHttp = StateSnapshot.parse(http.body);
    const asOwner = StateSnapshot.parse(socket.body);
    // The socket's caller is the owner, who alone dismisses a notice; these HTTP requests come
    // from the harness's paired browser, which never may, its own pairing's included.
    expect(shared(asOwner)).toEqual(shared(overHttp));
    expect([offered(asOwner), offered(overHttp)]).toEqual([[["dismiss"]], [[]]]);
  });

  it("follows its events with bazhen events follow until Ctrl-C, which ends it with 0", async () => {
    const follow = followEvents(daemon);
    let opened = 0;
    try {
      // The stream carries only what happens once it is open: open shells until one shows.
      await waitUntil(async () => {
        await daemon.request("/v1/shells", {
          method: "POST",
          body: { idempotencyKey: `follow-${opened++}`, cwd: daemon.work },
        });
        return follow.printed().includes(" terminal ");
      }, "an event printed by bazhen events follow");
      signalOwnChild(follow.child, "SIGINT");
      expect(await follow.exited).toEqual({ code: 0, signal: null });
    } finally {
      signalOwnChild(follow.child, "SIGTERM");
    }
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

  it("stops the daemon and leaves its agents running", async () => {
    const { agentId } = await daemon.launch("kept");
    expect((await bazhen(["stop"], daemon.env)).code).toBe(0);
    expect(await daemon.hasTerminal(agentId)).toBe(true);
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
    const env = await daemon.agentEnv(agentId);
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
    expect(out).toContain("external origins: none (loopback only)\n");
    expect(out).toContain("web app: not built;");
    expect(out).not.toContain("sentinel-value-never-shown");
  });

  it("says tmux is unused while no terminal is on it, and nothing of its dead-pane crash", async () => {
    const { code, out } = await bazhen(["doctor"], daemon.env);
    expect([
      code,
      out.split("\n").filter((l) => l.startsWith("tmux")),
      out.includes("  warning: tmux before 3.5 crashes"),
    ]).toEqual([0, ["tmux: unused"], false]);
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
    // The terminal's process is the TUI itself, with its own arguments, not a shell left waiting on it.
    // It is the fixture's `/bin/sh -c` for a moment before then, so wait out the handover, for
    // longer than the default 1 s: a loaded runner can be slow to get from the exec to the TUI.
    await expect
      .poll(async () => (await daemon.agentCommand(agentId))[0], { timeout: 10_000 })
      .not.toMatch(/(^|\/)(sh|bash|zsh|fish|login-shell\.sh)$/);
    const env = await daemon.agentEnv(agentId);
    expect([env["BZ_LOGIN_SHELL_ARGS"], env["FROM_RC"]]).toEqual(["-l -i -c", "1"]);
    expect(await daemon.agentCommand(agentId)).toContain("--settings");
  });
});

describe("bazhen env refresh", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.startWithCli("", { BZ_STALE: "from-start" });
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  // A value that would end the command, or run another, if a runtime ever read it as code.
  const fresh = `it's "x" $HOME; run-shell 'id' #{pane_id} a\\b`;

  it("gives agents started afterwards the refreshing shell's environment, and no other", async () => {
    const first = await daemon.launch("before");
    await expect.poll(() => daemon.hasTerminal(first.agentId)).toBe(true);

    const refreshed = await bazhen(["env", "refresh"], {
      ...daemon.env,
      BZ_FRESH: fresh,
      BZ_MULTI: "one\ntwo",
      CLAUDECODE: "1",
    });
    expect(refreshed.code).toBe(0);
    expect(refreshed.out).not.toContain("left as they were");
    expect(refreshed.out).toContain(first.agentId);

    const second = await daemon.launch("after");
    await expect.poll(() => daemon.hasTerminal(second.agentId)).toBe(true);
    const env = await daemon.agentEnv(second.agentId);
    expect([env["BZ_FRESH"], env["BZ_STALE"], env["BZ_MULTI"], env["CLAUDECODE"]]).toEqual([
      fresh,
      undefined,
      "one\ntwo",
      undefined,
    ]);
    // The agent already running keeps what it started with.
    expect((await daemon.agentEnv(first.agentId))["BZ_STALE"]).toBe("from-start");
  });

  it("says in doctor that the capture came from a refresh", async () => {
    expect((await bazhen(["doctor"], daemon.env)).out).toContain("by bazhen env refresh");
  });
});
