import { describe, expect, it } from "vitest";
import { LaunchAgentRequest, StateSnapshot } from "./agents.ts";

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

describe("StateSnapshot", () => {
  it("still reads a snapshot from a daemon older than its host, attach and command fields", () => {
    const environmentId = "env_01900000000070008000000000000001";
    const older = {
      epoch: "e",
      eventId: 1,
      environments: [{ id: environmentId, kind: "local" }],
      agents: [
        {
          id: "agent_01900000000070008000000000000002",
          environmentId,
          harness: "codex",
          project: "p",
          cwd: "/p",
          state: "running",
          terminalId: null,
          generation: null,
          externalRef: null,
          exit: null,
        },
      ],
      attention: [],
      messages: [],
    };
    const read = StateSnapshot.parse(older);
    expect([
      read.environments[0]?.host,
      read.agents[0]?.attachCommand,
      read.agents[0]?.commands,
    ]).toEqual(["", null, []]);
  });
});
