import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon } from "./daemon.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  await daemon.stop();
});

const launch = (key: string, origin?: string) =>
  daemon.request("/v1/agents", {
    method: "POST",
    body: { idempotencyKey: key, harness: "claude-code", cwd: daemon.work },
    ...(origin === undefined ? {} : { origin }),
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

  it("shows a launched agent as running in the state snapshot", async () => {
    const { agentId } = LaunchAgentResponse.parse((await launch("second")).body);
    const state = StateSnapshot.parse((await daemon.request("/v1/state")).body);
    expect(state.agents.find((a) => a.id === agentId)).toMatchObject({
      harness: "claude-code",
      state: "running",
      cwd: daemon.work,
      externalRef: { kind: "claude-session" },
    });
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
