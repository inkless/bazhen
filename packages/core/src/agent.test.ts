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

  it("returns to lost, still closable and relaunchable, when a relaunch is rejected", () => {
    const rejected = agent.next(agent.next("lost", "relaunch.requested"), "relaunch.rejected");
    expect([rejected, agentCommands(rejected)]).toEqual(["lost", ["close", "relaunch"]]);
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
      lost: ["close", "relaunch"],
      closing: ["close"],
      closed: [],
      failed: [],
    };
    const isState = (s: string): s is AgentState => Object.hasOwn(expected, s);
    const states = Object.keys(expected).filter(isState);
    expect(Object.fromEntries(states.map((s) => [s, agentCommands(s)]))).toEqual(expected);
  });
});

const yes = () => true;
const no = () => false;

describe("offeredCommands", () => {
  const exited = {
    state: "exited" as const,
    generation: 1,
    harness: "codex" as const,
    externalRef: { environmentId: "env_1", kind: "codex-thread" as const, id: "thr" },
    transcript: null,
  };

  it("offers respawn only when the environment says the session resumes", () => {
    expect([offeredCommands(exited, yes), offeredCommands(exited, no)]).toEqual([
      ["close", "respawn"],
      ["close"],
    ]);
  });

  it("offers relaunch to a lost agent whether or not it can resume, since fresh is asked for", () => {
    const lost = { ...exited, state: "lost" as const };
    expect([
      offeredCommands(lost, yes),
      offeredCommands({ ...lost, externalRef: null }, no),
    ]).toEqual([
      ["close", "relaunch"],
      ["close", "relaunch"],
    ]);
  });

  it("offers nothing without a generation for a command to name", () => {
    expect(offeredCommands({ ...exited, generation: null }, yes)).toEqual([]);
  });
});
