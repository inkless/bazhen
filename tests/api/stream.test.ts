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
    await expect.poll(() => view.text(), { timeout: 10_000 }).toContain("Claude Code");
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
    await expect.poll(() => first.text(), { timeout: 10_000 }).toContain("Claude Code");
    const late = await daemon.view(terminalId, "observe");
    await expect.poll(() => late.text(), { timeout: 10_000 }).toContain("Claude Code");
    // Seeded from the daemon's snapshot, through the one client.
    expect(late.frames.map((f) => f.type)).toEqual(
      expect.arrayContaining(["snapshot_start", "snapshot_end"]),
    );
    // An earlier view's client may still be on its way out.
    await expect
      .poll(
        () =>
          daemon
            .tmux("list-clients")
            .split("\n")
            .filter((line) => line.trim() !== ""),
        {
          timeout: 10_000,
        },
      )
      .toHaveLength(1);
    first.close();
    late.close();
  });

  it("keeps its client a moment after the last view closes on an Enter, then lets it go", async () => {
    const program = await daemon.program([
      "sh",
      "-c",
      'echo ready; read line; echo "got $line"; exec sleep 600',
    ]);
    await waitUntil(() => daemon.screen(program.agentId).includes("ready"), "the program");
    const session = String(daemon.paneFact(program.agentId, "session_name"));
    const clients = () => daemon.tmux("list-clients", "-t", session).trim();
    const view = await daemon.view(program.terminalId, "interactive");
    await view.drive();
    view.type("last words\r");
    view.close();
    await view.closed();
    // Long enough for a client killed at the close to be gone, well inside the hub's grace.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lingering = clients();
    await expect.poll(() => daemon.screen(program.agentId)).toContain("got last words");
    await expect.poll(clients, { timeout: 10_000 }).toBe("");
    expect(lingering).not.toBe("");
  });

  it("refuses a stream opened from a page on another origin", async () => {
    await expect(daemon.view(terminalId, "interactive", "https://evil.example")).rejects.toThrow(
      /refused: 403/,
    );
  });
});
