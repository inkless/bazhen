import { describe, expect, it } from "vitest";
import {
  AttentionCloseReason,
  HOOK_REPLY_TYPE,
  HookAck,
  HookReply,
  SendMessageRequest,
  frameHookReply,
  offerToken,
  offeredMessage,
} from "./mail.ts";
import { EVENTS } from "./events.ts";

const MSG = "msg_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";

describe("mail and attention schemas", () => {
  it("names an offer by its message and its own id, and reads the message back", () => {
    const token = offerToken(MSG, "ab12x");
    expect([token, offeredMessage(token)]).toEqual([`${MSG}-ab12x`, MSG]);
    expect(
      HookAck.safeParse({ agentId: "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d", offered: [token] })
        .success,
    ).toBe(true);
  });

  it("refuses an ack that names a message but not which offer of it", () => {
    expect(
      HookAck.safeParse({ agentId: "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d", offered: [MSG] })
        .success,
    ).toBe(false);
  });

  it("refuses an empty message", () => {
    expect(SendMessageRequest.safeParse({ idempotencyKey: "k", body: "" }).success).toBe(false);
  });

  it("refuses an exit code a process can't have", () => {
    expect(
      HookReply.safeParse({ exitCode: 256, stdout: "", stderr: "", offered: [] }).success,
    ).toBe(false);
  });

  it("still reads an item opened before kinds, and refuses a kind it doesn't know", () => {
    const opened = EVENTS["attention.opened"].payload;
    const before = {
      agentId: "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d",
      summary: "Bash",
      toolUseId: null,
      mainAgent: true,
    };
    expect([
      opened.safeParse(before).success,
      opened.safeParse({ ...before, kind: "nudge" }).success,
    ]).toEqual([true, false]);
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
