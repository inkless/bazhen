import { describe, expect, it } from "vitest";
import {
  AttentionCloseReason,
  HOOK_REPLY_TYPE,
  HookReply,
  SendMessageRequest,
  frameHookReply,
} from "./mail.ts";
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

describe("frameHookReply", () => {
  it("counts stdout in UTF-8 bytes and puts it before stderr", () => {
    const { headers, body } = frameHookReply({
      exitCode: 2,
      stdout: "日本",
      stderr: "x",
      offered: ["msg_a", "msg_b"],
    });
    expect(headers).toEqual({
      "content-type": HOOK_REPLY_TYPE,
      "content-length": "7",
      "bazhen-exit-code": "2",
      "bazhen-offered": "msg_a,msg_b",
      "bazhen-stdout-bytes": "6",
    });
    expect(new TextDecoder().decode(body)).toBe("日本x");
  });
});
