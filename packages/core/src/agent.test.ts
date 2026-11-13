import { describe, expect, it } from "vitest";
import type { AgentCommand, AgentState } from "@bazhen/protocol";
import { agent, agentCommands, offeredCommands } from "./agent.ts";
import { InvalidTransition } from "./machine.ts";

describe("agent session lifecycle", () => {
  it("stays unknown while its environment is unreachable", () => {
    const unknown = agent.next("running", "environment.unreachable");
    expect(() => agent.next(unknown, "environment.unreachable")).toThrow(InvalidTransition);
  });

  it("starts again when a lost agent is relaunched", () => {
    expect(agent.next("lost", "relaunch.requested")).toBe("starting");
  });

  it("returns to exited, still closable, when a respawn is rejected", () => {
    const rejected = agent.next(agent.next("exited", "respawn.requested"), "respawn.rejected");
    expect([rejected, agent.accepts(rejected, "close.requested")]).toEqual(["exited", true]);
  });

  it("cannot be respawned while still running", () => {
    expect(() => agent.next("running", "respawn.requested")).toThrow(InvalidTransition);
  });
});

describe("agentCommands", () => {
  it("offers exactly the commands the lifecycle takes, in every state", () => {
    // A Record, so a state added to the protocol fails to compile here until it is listed.
    const expected: Record<AgentState, AgentCommand[]> = {
      starting: [],
      running: ["close", "signal"],
      unknown: ["close"],
      exited: ["close", "respawn"],
      lost: ["close"],
      closing: ["close"],
      closed: [],
      failed: [],
    };
    const isState = (s: string): s is AgentState => Object.hasOwn(expected, s);
    const states = Object.keys(expected).filter(isState);
    expect(Object.fromEntries(states.map((s) => [s, agentCommands(s)]))).toEqual(expected);
  });
});

describe("offeredCommands", () => {
  const exited = {
    state: "exited" as const,
    generation: 1,
    harness: "codex" as const,
    externalRef: { environmentId: "env_1", kind: "codex-thread" as const, id: "thr" },
  };

  it("offers respawn only with a session on a harness the environment resumes", () => {
    expect([
      offeredCommands(exited, ["codex"]),
      offeredCommands(exited, ["claude-code"]),
      offeredCommands({ ...exited, externalRef: null }, ["codex"]),
    ]).toEqual([["close", "respawn"], ["close"], ["close"]]);
  });

  it("offers nothing without a generation for a command to name", () => {
    expect(offeredCommands({ ...exited, generation: null }, ["codex"])).toEqual([]);
  });
});
