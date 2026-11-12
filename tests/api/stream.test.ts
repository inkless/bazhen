import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";

let daemon: Daemon;
let agentId = "";
let terminalId = "";
beforeAll(async () => {
  daemon = await Daemon.start();
  const launched = LaunchAgentResponse.parse(
    (
      await daemon.request("/v1/agents", {
        method: "POST",
        body: { idempotencyKey: "stream", harness: "claude-code", cwd: daemon.work },
      })
    ).body,
  );
  agentId = launched.agentId;
  terminalId = String(launched.terminalId);
  await waitUntil(() => daemon.screen(agentId).includes("Claude Code"), "Claude Code's TUI");
});
afterAll(async () => {
  await daemon?.stop();
});

describe("the terminal stream", () => {
  it("shows the agent's real TUI to a view, and types what the driver types into it", async () => {
    const view = await daemon.view(terminalId, "interactive");
    await expect.poll(() => view.output(), { timeout: 10_000 }).toMatch(/Claude Code/);
    view.frame({ type: "engage" });
    await expect
      .poll(() => view.frames)
      .toContainEqual(expect.objectContaining({ type: "lease", driver: true }));
    view.type("hello from the browser");
    await expect
      .poll(() => daemon.screen(agentId), { timeout: 10_000 })
      .toContain("hello from the browser");
    view.close();
  });

  it("drops keystrokes from a view that isn't driving, and says so", async () => {
    const driver = await daemon.view(terminalId, "interactive");
    driver.frame({ type: "engage" });
    const watcher = await daemon.view(terminalId, "observe");
    await expect
      .poll(() => watcher.frames)
      .toContainEqual(expect.objectContaining({ type: "attached" }));
    watcher.type("observer-typed-this");
    await expect.poll(() => watcher.frames).toContainEqual({ type: "input_dropped" });
    expect(daemon.screen(agentId)).not.toContain("observer-typed-this");
    driver.close();
    watcher.close();
  });

  it("shows a view that joins later the screen as it already is", async () => {
    const first = await daemon.view(terminalId, "interactive");
    await expect.poll(() => first.output(), { timeout: 10_000 }).toMatch(/Claude Code/);
    const late = await daemon.view(terminalId, "observe");
    await expect.poll(() => late.output(), { timeout: 10_000 }).toMatch(/Claude Code/);
    // Seeded from a snapshot, which starts by clearing the screen, through the one client.
    expect(late.output().startsWith("\u001b[H\u001b[2J")).toBe(true);
    expect(daemon.tmux("list-clients").trim().split("\n")).toHaveLength(1);
    first.close();
    late.close();
  });

  it("refuses a stream opened from a page on another origin", async () => {
    await expect(daemon.view(terminalId, "interactive", "https://evil.example")).rejects.toThrow(
      /refused: 403/,
    );
  });
});
