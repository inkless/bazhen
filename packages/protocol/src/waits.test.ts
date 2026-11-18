import { describe, expect, it } from "vitest";
import { WAIT_MAX_MS, WaitRequest } from "./waits.ts";

const AGENT = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const TERM = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const TASK = "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";

const parses = (condition: unknown, timeoutMs = 1000) =>
  WaitRequest.safeParse({ condition, timeoutMs }).success;

describe("WaitRequest", () => {
  it("takes each noun's own conditions, and none of another's", () => {
    expect([
      parses({ on: "agent", agentId: AGENT, until: "idle" }),
      parses({ on: "agent", agentId: AGENT, until: "creating" }),
      parses({ on: "shell", shellId: TERM, until: "creating" }),
      parses({ on: "shell", shellId: TERM, until: "idle" }),
      parses({ on: "task", taskId: TASK, until: "done" }),
      parses({ on: "task", taskId: TASK, until: "cancelled" }),
      parses({ on: "agent", agentId: TERM, until: "ready" }),
    ]).toEqual([true, false, true, false, true, false, false]);
  });

  it("holds a request no longer than a wait for mail", () => {
    const on = { on: "agent", agentId: AGENT, until: "ended" };
    expect([parses(on, WAIT_MAX_MS), parses(on, WAIT_MAX_MS + 1), parses(on, -1)]).toEqual([
      true,
      false,
      false,
    ]);
  });
});
