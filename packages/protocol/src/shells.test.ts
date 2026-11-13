import { describe, expect, it } from "vitest";
import { StateSnapshot } from "./agents.ts";
import { OpenShellRequest } from "./shells.ts";

const agentId = "agent_0190000000007000800000000000aaaa";

describe("shell requests", () => {
  it("opens a linked shell in its agent's directory, so refuses one that names its own", () => {
    const linked = { idempotencyKey: "k", linkedAgentId: agentId };
    expect(OpenShellRequest.safeParse(linked).success).toBe(true);
    expect(OpenShellRequest.safeParse({ ...linked, cwd: "/work" }).success).toBe(false);
  });

  it("reads a snapshot from a daemon older than shells as having none", () => {
    const older = {
      epoch: "e",
      eventId: 0,
      environments: [],
      agents: [],
      attention: [],
      messages: [],
    };
    expect(StateSnapshot.parse(older).shells).toEqual([]);
  });
});
