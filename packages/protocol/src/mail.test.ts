import { describe, expect, it } from "vitest";
import { AttentionCloseReason, HookReply, SendMessageRequest } from "./mail.ts";
import { EVENTS } from "./events.ts";

describe("mail and attention schemas", () => {
  it("refuses an empty message", () => {
    expect(SendMessageRequest.safeParse({ idempotencyKey: "k", body: "" }).success).toBe(false);
  });

  it("refuses an exit code a process can't have", () => {
    expect(
      HookReply.safeParse({ exitCode: 256, stdout: "", stderr: "", offered: [] }).success,
    ).toBe(false);
  });

  it("records an answer as answered, never as a plain close", () => {
    const closed = EVENTS["attention.closed"].payload;
    expect([
      AttentionCloseReason.safeParse("answered").success,
      closed.safeParse({ reason: "answered" }).success,
    ]).toEqual([true, false]);
  });
});
