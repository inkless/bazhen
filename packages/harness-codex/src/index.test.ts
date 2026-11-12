import { describe, expect, it } from "vitest";
import type { HarnessChannelPort } from "@bazhen/core";
import { ZodError } from "zod";
import { CodexHarness, ThreadMismatch } from "./index.ts";

const REMOTE = "unix:///codex/app-server-control.sock";

/**
 * A channel that answers `thread/start` with a thread and `thread/resume` with `resumes` (by
 * default the thread asked for), and records every request.
 */
function channel(result: unknown = { thread: { id: "thr-1" } }, resumes?: string) {
  const requests: [string, unknown][] = [];
  const port: HarnessChannelPort = {
    request: async (method, params) => {
      requests.push([method, params]);
      if (method === "thread/start") return result;
      if (method === "thread/resume") {
        return { thread: { id: resumes ?? String(Reflect.get(Object(params), "threadId")) } };
      }
      return {};
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

  it("reloads the agent's thread before the TUI resumes it, and starts no new one", async () => {
    const { port, requests } = channel();
    const harness = new CodexHarness(port, REMOTE);
    const resumed = await harness.resumeSpec(
      { harness: "codex", project: "p", cwd: "/work" },
      { kind: "codex-thread", id: "thr-7" },
    );
    expect(requests).toEqual([["thread/resume", { threadId: "thr-7", excludeTurns: true }]]);
    expect([resumed.argv.slice(0, 5), resumed.externalRef]).toEqual([
      ["codex", "resume", "thr-7", "--remote", REMOTE],
      { kind: "codex-thread", id: "thr-7" },
    ]);
  });

  it("refuses a resume that the server answered with another thread, rather than rebind", async () => {
    const harness = new CodexHarness(channel(undefined, "thr-other").port, REMOTE);
    await expect(
      harness.resumeSpec(
        { harness: "codex", project: "p", cwd: "/work" },
        { kind: "codex-thread", id: "thr-7" },
      ),
    ).rejects.toThrow(ThreadMismatch);
  });
});
