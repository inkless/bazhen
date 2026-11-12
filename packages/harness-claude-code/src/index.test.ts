import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@bazhen/core";
import { ClaudeCodeHarness } from "./index.ts";

const request = { harness: "claude-code" as const, project: "p", cwd: "/work" };
const claude = (newSessionId: () => string): HarnessAdapter => new ClaudeCodeHarness(newSessionId);

describe("Claude Code harness", () => {
  it("launches with a session id it chose, and reports that session as the agent's", () => {
    const launch = claude(() => "6f1c0b2e-0000-4000-8000-000000000001").launchSpec(request);
    expect(launch.argv).toEqual(["claude", "--session-id", "6f1c0b2e-0000-4000-8000-000000000001"]);
    expect(launch.externalRef).toEqual({
      kind: "claude-session",
      id: "6f1c0b2e-0000-4000-8000-000000000001",
    });
  });

  it("gives every launch its own session", () => {
    let n = 0;
    const harness = claude(() => `session-${++n}`);
    expect([
      harness.launchSpec(request).externalRef?.id,
      harness.launchSpec(request).externalRef?.id,
    ]).toEqual(["session-1", "session-2"]);
  });
});
