import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { ErrorResponse, LaunchAgentResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon } from "./daemon.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  // A daemon that never started has already cleaned up after itself.
  await daemon?.stop();
});

const launch = (key: string, origin?: string, cwd = daemon.work) =>
  daemon.request("/v1/agents", {
    method: "POST",
    body: { idempotencyKey: key, harness: "claude-code", cwd },
    ...(origin === undefined ? {} : { origin }),
  });

describe("the directory an agent is launched in", () => {
  it("reads a leading ~ as the daemon user's home", async () => {
    const missing = `bazhen-api-no-such-dir-${process.pid}`;
    const { status, body } = await launch("home", undefined, `~/${missing}`);
    expect([status, ErrorResponse.parse(body).message]).toEqual([
      400,
      `${join(String(process.env["HOME"]), missing)} does not exist`,
    ]);
  });

  it.each([
    ["a relative path", () => "work", "is not a full path"],
    // A file the daemon is sure to have made.
    ["a file", () => join(daemon.home, "data", "bazhen.db"), "is not a directory"],
  ])("refuses %s in words, not a parser's issue list", async (what, path, why) => {
    const { status, body } = await launch(`refused ${what}`, undefined, path());
    expect([status, ErrorResponse.parse(body)]).toEqual([
      400,
      { error: "invalid_request", message: expect.stringContaining(why) },
    ]);
  });
});

describe("launching an agent", () => {
  it("runs the real Claude Code TUI in Bazhen's tmux, tagged with the agent", async () => {
    const { status, body } = await launch("first");
    expect(status).toBe(200);
    const { agentId } = LaunchAgentResponse.parse(body);
    const panes = daemon.tmux("list-panes", "-a", "-F", "#{@bazhen_agent_id} #{pane_dead}");
    expect(panes).toContain(`${agentId} 0`);
    await expect.poll(() => daemon.screen(agentId), { timeout: 20_000 }).toMatch(/Claude Code/);
  });

  it("gives Claude Code and the tmux server the hook link a restart re-points, not the client", async () => {
    const { agentId } = LaunchAgentResponse.parse((await launch("hook link")).body);
    await expect.poll(() => daemon.screen(agentId), { timeout: 20_000 }).toMatch(/Claude Code/);
    const link = join(daemon.home, "state", "hook", "bazhen-hook");
    expect([daemon.agentCommand(agentId).join(" "), daemon.tmux("show-hooks", "-gw")]).toEqual([
      expect.stringContaining(`'${link}'`),
      expect.stringContaining(`'${link}' 'pane-title'`),
    ]);
  });

  it("shows a launched agent as running in the state snapshot", async () => {
    const { agentId } = LaunchAgentResponse.parse((await launch("second")).body);
    const state = StateSnapshot.parse((await daemon.request("/v1/state")).body);
    expect(state.agents.find((a) => a.id === agentId)).toMatchObject({
      harness: "claude-code",
      state: "running",
      cwd: daemon.work,
      externalRef: { kind: "claude-session" },
      commands: ["close", "signal"],
    });
  });

  it("names the host and a pasteable command that attaches to the agent's own session", async () => {
    const { agentId } = LaunchAgentResponse.parse((await launch("attach")).body);
    const state = StateSnapshot.parse((await daemon.request("/v1/state")).body);
    const [command = ""] = state.agents
      .filter((a) => a.id === agentId)
      .map((a) => String(a.attachCommand));
    const socket = daemon.tmux("display-message", "-p", "#{socket_path}").trim();
    const target = String(command.split(" attach-session -t ").at(-1)).replaceAll("'", "");
    expect([
      state.environments.map((e) => e.host),
      command.startsWith("env -u TMUX tmux "),
      command.includes(` -S ${socket} `),
      daemon.tmux("display-message", "-p", "-t", target, "#{@bazhen_agent_id}").trim(),
    ]).toEqual([[daemon.tmux("display-message", "-p", "#{host}").trim()], true, true, agentId]);
  });

  it("launches once for a repeated key", async () => {
    const first = LaunchAgentResponse.parse((await launch("repeat")).body);
    const again = LaunchAgentResponse.parse((await launch("repeat")).body);
    const tagged = daemon.tmux("list-panes", "-a", "-F", "#{@bazhen_agent_id}");
    expect([again, tagged.split("\n").filter((l) => l === first.agentId).length]).toEqual([
      first,
      1,
    ]);
  });

  it("refuses a launch from a page on another origin, and launches nothing", async () => {
    const before = StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.length;
    const { status } = await launch("cross-site", "https://evil.example");
    const after = StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.length;
    expect([status, after]).toEqual([403, before]);
  });
});
