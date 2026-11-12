import { describe, expect, it } from "vitest";
import { agent } from "./agent.ts";
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
