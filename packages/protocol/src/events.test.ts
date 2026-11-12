import { describe, expect, it } from "vitest";
import { EVENTS } from "./events.ts";

describe("event registry", () => {
  it("records why a launch failed as a code, never as free text that could carry output", () => {
    const failed = EVENTS["agent.failed"].payload;
    expect(failed.safeParse({ reason: "launch_rejected" }).success).toBe(true);
    expect(failed.safeParse({ reason: "tmux said: token=abc" }).success).toBe(false);
  });

  it("names the entity each event is about", () => {
    expect([EVENTS["agent.launched"].entity, EVENTS["environment.registered"].entity]).toEqual([
      "agent",
      "environment",
    ]);
  });
});
