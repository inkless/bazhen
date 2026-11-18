import { describe, expect, it } from "vitest";
import { threadConfig } from "@bazhen/harness-codex";
import { withCodexAgent } from "../testing/fixtures.ts";
import { resumeConfig } from "./threads.ts";

const SOCKET = "/run/bazhen/bazhen.sock";

describe("what the daemon resumes a Codex thread with", () => {
  it("gives the thread the compaction window of the agent bound to it", async () => {
    const { store } = await withCodexAgent("thr-1", { compactWindowTokens: 300_000 });
    expect(resumeConfig(store, SOCKET)("thr-1")).toEqual({
      ...threadConfig(SOCKET),
      model_auto_compact_token_limit: 300_000,
    });
  });

  it("leaves Codex's own window to an agent launched without one, and to a thread none is on", async () => {
    const { store } = await withCodexAgent("thr-1");
    const config = resumeConfig(store, SOCKET);
    expect([config("thr-1"), config("thr-other")]).toEqual([
      threadConfig(SOCKET),
      threadConfig(SOCKET),
    ]);
  });
});
