import { describe, expect, it } from "vitest";
import { LaunchAgentRequest } from "./agents.ts";

const launch = { idempotencyKey: "k-1", harness: "claude-code", cwd: "/work" };

describe("LaunchAgentRequest", () => {
  it("accepts a launch with a key, a known harness and an absolute directory", () => {
    expect(LaunchAgentRequest.safeParse(launch).success).toBe(true);
  });

  it("refuses an empty directory, and leaves what a path means to the daemon", () => {
    expect([
      LaunchAgentRequest.safeParse({ ...launch, cwd: "" }).success,
      LaunchAgentRequest.safeParse({ ...launch, cwd: "~/work" }).success,
    ]).toEqual([false, true]);
  });

  it("refuses a launch without an idempotency key", () => {
    expect(LaunchAgentRequest.safeParse({ ...launch, idempotencyKey: "" }).success).toBe(false);
  });

  it("refuses a harness Bazhen has no adapter for", () => {
    expect(LaunchAgentRequest.safeParse({ ...launch, harness: "pi" }).success).toBe(false);
  });
});
