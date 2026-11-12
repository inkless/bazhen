import { describe, expect, it } from "vitest";
import type { HarnessChannelPort } from "@bazhen/core";
import { ZodError } from "zod";
import { CodexHarness } from "./index.ts";

const REMOTE = "unix:///codex/app-server-control.sock";

/** A channel that answers `thread/start` with a thread, and records every request. */
function channel(result: unknown = { thread: { id: "thr-1" } }) {
  const requests: [string, unknown][] = [];
  const port: HarnessChannelPort = {
    request: async (method, params) => {
      requests.push([method, params]);
      return method === "thread/start" ? result : {};
    },
  };
  return { port, requests };
}

describe("Codex harness", () => {
  it("starts the agent's thread and gives it a first item, so the TUI can resume it", async () => {
    const { port, requests } = channel();
    await new CodexHarness(port, REMOTE).launchSpec({ cwd: "/work" });
    expect(requests).toEqual([
      ["thread/start", { cwd: "/work" }],
      [
        "thread/inject_items",
        { threadId: "thr-1", items: [expect.objectContaining({ role: "developer" })] },
      ],
    ]);
  });

  it("launches the TUI on that thread, on the same server, and binds the agent to it", async () => {
    const launch = await new CodexHarness(channel().port, REMOTE).launchSpec({ cwd: "/work" });
    expect(launch).toMatchObject({
      argv: [
        "codex",
        "resume",
        "thr-1",
        "--remote",
        REMOTE,
        "--no-alt-screen",
        "-c",
        'tui.terminal_title=["thread-id"]',
      ],
      externalRef: { kind: "codex-thread", id: "thr-1" },
    });
  });

  it("refuses to launch when the server returns no thread", async () => {
    await expect(
      new CodexHarness(channel({}).port, REMOTE).launchSpec({ cwd: "/work" }),
    ).rejects.toThrow(ZodError);
  });
});
