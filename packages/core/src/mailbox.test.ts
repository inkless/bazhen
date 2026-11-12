import { describe, expect, it } from "vitest";
import { InvalidTransition } from "./machine.ts";
import { mailbox } from "./mailbox.ts";

describe("mailbox message", () => {
  it("goes back to the queue from every in-flight state, as after a daemon restart", () => {
    expect(
      (["offered", "emitted", "seen"] as const).map((s) => mailbox.next(s, "requeue")),
    ).toEqual(["queued", "queued", "queued"]);
  });

  it("waits in Codex's own queue until the turn carrying it starts", () => {
    const parked = mailbox.next("queued", "accept_offline");
    expect(parked).toBe("queued_in_codex");
    expect(() => mailbox.next(parked, "requeue")).toThrow(InvalidTransition);
    expect(mailbox.next(parked, "confirm")).toBe("delivered");
  });

  it("becomes undeliverable from any in-flight state when the agent closes", () => {
    expect(mailbox.next("queued_in_codex", "agent_closed")).toBe("undeliverable");
  });
});
