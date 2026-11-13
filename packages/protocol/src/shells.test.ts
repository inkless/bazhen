import { describe, expect, it } from "vitest";
import { StateSnapshot } from "./agents.ts";
import { OpenShellRequest, RenameShellRequest } from "./shells.ts";

const named = (name: string) => RenameShellRequest.safeParse({ idempotencyKey: "k", name });
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

  it("takes a shell's name trimmed, and refuses one that is blank or too long to show", () => {
    expect(named("  dev server ").data?.name).toBe("dev server");
    expect([named("   ").success, named("x".repeat(81)).success]).toEqual([false, false]);
  });

  it("refuses a name holding an escape, a newline or a bidirectional override", () => {
    const refused = ["a\x1b[31mb", "dev\nserver", "a\u009bb", "abc\u202edef", "x\u2066y"];
    expect(refused.map((name) => named(name).success)).toEqual([false, false, false, false, false]);
    expect(named("café ☕ 服务").success).toBe(true);
  });
});
