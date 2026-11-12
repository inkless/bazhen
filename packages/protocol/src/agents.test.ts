import { describe, expect, it } from "vitest";
import { LaunchAgentRequest } from "./agents.ts";

const launch = { idempotencyKey: "k-1", harness: "claude-code", cwd: "/work" };

describe("LaunchAgentRequest", () => {
  it("accepts a launch with a key, a known harness and an absolute directory", () => {
    expect(LaunchAgentRequest.safeParse(launch).success).toBe(true);
  });

  it("refuses a relative directory, which would depend on where the daemon was started", () => {
    expect(LaunchAgentRequest.safeParse({ ...launch, cwd: "work" }).success).toBe(false);
  });

  it("refuses a launch without an idempotency key", () => {
    expect(LaunchAgentRequest.safeParse({ ...launch, idempotencyKey: "" }).success).toBe(false);
  });

  it("refuses a harness Bazhen has no adapter for", () => {
    expect(LaunchAgentRequest.safeParse({ ...launch, harness: "pi" }).success).toBe(false);
  });
});
