import { describe, expect, it } from "vitest";
import { Event, EventFrame, EVENTS } from "./events.ts";

const recorded = {
  id: 7,
  ts: "2026-11-12T10:00:00.000Z",
  entityId: "msg_x",
  actor: "system",
  causationId: null,
  correlationId: null,
};

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

describe("streamed events", () => {
  it("carries a registered type with the payload that type declares", () => {
    const event = {
      ...recorded,
      type: "mailbox.requeued",
      entityType: "message",
      payload: { reason: "daemon_restart" },
    };
    expect(Event.parse(event)).toEqual(event);
  });

  it("refuses a payload that belongs to another type", () => {
    const event = { ...recorded, type: "mailbox.requeued", entityType: "message", payload: {} };
    expect(Event.safeParse(event).success).toBe(false);
  });

  it("leaves a queued message's body out of what it sends", () => {
    const agentId = "agent_019a7b2c3d4e7f00a1b2c3d4e5f60718";
    const event = Event.parse({
      ...recorded,
      type: "mailbox.queued",
      entityType: "message",
      payload: { agentId, body: "the secret plan" },
    });
    expect(event.payload).toEqual({ agentId });
  });

  it("tells a client its cursor can't be resumed, and why", () => {
    expect(EventFrame.parse({ type: "reset", reason: "stale" })).toEqual({
      type: "reset",
      reason: "stale",
    });
    expect(EventFrame.safeParse({ type: "reset", reason: "tired" }).success).toBe(false);
  });
});
