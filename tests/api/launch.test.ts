import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join, relative } from "node:path";
import {
  DoctorResponse,
  ErrorResponse,
  LaunchAgentResponse,
  StateSnapshot,
} from "@bazhen/protocol";
import { Daemon, HOST, overSocket } from "./daemon.ts";
import { holderSockets } from "../support/holder-close.ts";

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
  it("runs the real Claude Code TUI on a holder of its own, tagged with the agent", async () => {
    const { status, body } = await launch("first");
    expect(status).toBe(200);
    const { agentId, terminalId } = LaunchAgentResponse.parse(body);
    expect([
      daemon.holderOf(agentId),
      (await daemon.holderTags(String(terminalId)))["agentId"],
    ]).toEqual([expect.stringMatching(/\.sock$/), agentId]);
    await expect.poll(() => daemon.screen(agentId), { timeout: 20_000 }).toMatch(/Claude Code/);
  });

  it("gives Claude Code the hook link a restart re-points, not the client", async () => {
    const { agentId } = LaunchAgentResponse.parse((await launch("hook link")).body);
    await expect.poll(() => daemon.screen(agentId), { timeout: 20_000 }).toMatch(/Claude Code/);
    const link = join(daemon.home, "state", "hook", "bazhen-hook");
    expect((await daemon.agentCommand(agentId)).join(" ")).toContain(`'${link}'`);
  });

  it("points the hook link at a copy installed under its build, which doctor names", async () => {
    const client = daemon.hookClient();
    const asked = await overSocket(daemon.socket, "GET", "/v1/daemon/doctor");
    const doctor = DoctorResponse.parse(asked.body);
    expect([relative(join(daemon.home, "state", "hook"), client), doctor.hookClient.path]).toEqual([
      expect.stringMatching(/^[0-9a-f]{16}\/bazhen-hook$/),
      client,
    ]);
  });

  it("shows a launched agent as running in the state snapshot", async () => {
    const { agentId } = LaunchAgentResponse.parse((await launch("second")).body);
    const shown = async () =>
      StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.find(
        (a) => a.id === agentId,
      );
    await expect.poll(shown, { timeout: 30_000 }).toMatchObject({
      harness: "claude-code",
      state: "running",
      cwd: daemon.work,
      externalRef: { kind: "claude-session" },
      commands: ["close", "signal"],
    });
  });

  it("names the host and a pasteable command that attaches to the agent's own terminal", async () => {
    const { agentId, terminalId } = LaunchAgentResponse.parse((await launch("attach")).body);
    const state = StateSnapshot.parse((await daemon.request("/v1/state")).body);
    expect([
      state.environments.map((e) => e.host),
      state.agents.find((a) => a.id === agentId)?.attachCommand,
    ]).toEqual([[HOST], `bazhen terminals attach ${terminalId}`]);
  });

  it("launches once for a repeated key", async () => {
    const before = holderSockets(daemon.home).length;
    const first = LaunchAgentResponse.parse((await launch("repeat")).body);
    const again = LaunchAgentResponse.parse((await launch("repeat")).body);
    expect([again, holderSockets(daemon.home).length - before]).toEqual([first, 1]);
  });

  it("refuses a launch from a page on another origin, and launches nothing", async () => {
    const before = StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.length;
    const { status } = await launch("cross-site", "https://evil.example");
    const after = StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.length;
    expect([status, after]).toEqual([403, before]);
  });
});
