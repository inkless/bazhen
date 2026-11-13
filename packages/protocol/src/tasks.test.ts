import { describe, expect, it } from "vitest";
import { Event } from "./events.ts";
import { CreateTaskRequest, FinishTaskRequest } from "./tasks.ts";

const created = {
  id: 1,
  ts: "2026-11-12T00:00:00.000Z",
  type: "task.created",
  entityType: "task",
  entityId: "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d",
  actor: "human",
  causationId: null,
  correlationId: null,
  payload: { title: "t", brief: "secret plan", ownerAgentId: null, parentTaskId: null },
};

describe("task schemas", () => {
  it("refuses a brief longer than a message to the assignee may be", () => {
    const request = { idempotencyKey: "k", title: "t", brief: "x".repeat(20_001) };
    expect(CreateTaskRequest.safeParse(request).success).toBe(false);
  });

  it("refuses a blank title", () => {
    const request = { idempotencyKey: "k", title: "  ", brief: "b" };
    expect(CreateTaskRequest.safeParse(request).success).toBe(false);
  });

  it("can't finish a task as open", () => {
    expect(FinishTaskRequest.safeParse({ idempotencyKey: "k", outcome: "open" }).success).toBe(
      false,
    );
  });

  it("streams a created task without its brief", () => {
    const streamed = Event.parse(created);
    expect(streamed.payload).not.toHaveProperty("brief");
  });
});
