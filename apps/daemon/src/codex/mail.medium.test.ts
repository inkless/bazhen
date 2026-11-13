import { describe, expect, it } from "vitest";
import { messageText } from "@bazhen/harness-codex";
import { newId } from "@bazhen/core";
import { Mailbox } from "../mailbox/mailbox.ts";
import { UnknownAgent } from "../store/store.ts";
import { withCodexAgents, testView } from "../testing/fixtures.ts";
import { CodexMail } from "./mail.ts";

/**
 * The mail of Codex agents on threads `thr-1` and `thr-2`, and of one bound to no thread,
 * through a `codex queue` that takes a message unless `refuses` says no. Mail is for the
 * agent on `thr-1`. `startsTurn` makes the queue start the turn that carries the message
 * before the command returns, as Codex may.
 */
async function mailFor(
  refuses: (args: readonly string[]) => boolean = () => false,
  startsTurn = false,
) {
  const { store, agentOn } = await withCodexAgents("thr-1", "thr-2", null);
  const agentId = agentOn("thr-1");
  const ran: (readonly string[])[] = [];
  const turn = (threadId: string, text: string) =>
    mail.listener.notification("item/started", {
      threadId,
      item: { type: "userMessage", content: [{ type: "text", text }] },
    });
  const mail = new CodexMail({
    store,
    remote: "unix:///s.sock",
    codex: async (args) => {
      ran.push(args);
      if (startsTurn) turn("thr-1", String(args.at(-1)));
      if (refuses(args)) throw new Error("codex queue failed");
    },
    log: () => {},
    retryMs: 1,
  });
  const handed: Promise<void>[] = [];
  const mailbox = new Mailbox(store, {
    codex: (id, agent) => void handed.push(mail.deliver(id, agent)),
  });
  const send = async (body: string, key = body) => {
    const { messageId } = mailbox.send(agentId, { idempotencyKey: key, body });
    await Promise.all(handed);
    return messageId;
  };
  const stateOf = (id: string) => store.snapshot(testView).messages.find((m) => m.id === id)?.state;
  return { ran, send, stateOf, turn, store, mail, mailbox, agentOn };
}

describe("Codex mail", () => {
  it("stores a message on the app-server for the agent's thread, labelled, as queued in Codex", async () => {
    const { ran, send, stateOf } = await mailFor();
    const id = await send("hello");
    expect([stateOf(id), ran]).toEqual([
      "queued_in_codex",
      [
        [
          "queue",
          "--thread",
          "thr-1",
          "--remote",
          "unix:///s.sock",
          "--message",
          messageText(id, "hello"),
        ],
      ],
    ]);
  });

  it("delivers a message once a turn on its thread takes it, and not on another's", async () => {
    const { send, stateOf, turn } = await mailFor();
    const id = await send("hello");
    turn("thr-1", messageText("msg_someoneelse", "hi"));
    // thr-2 is another agent's, so its turn may carry the same text and still confirm nothing.
    turn("thr-2", messageText(id, "hello"));
    expect(stateOf(id)).toBe("queued_in_codex");
    turn("thr-1", messageText(id, "hello"));
    expect(stateOf(id)).toBe("delivered");
  });

  it("stores it in the Codex home when no app-server takes it", async () => {
    const { ran, send, stateOf } = await mailFor((args) => args.includes("--remote"));
    const id = await send("hello");
    expect([stateOf(id), ran.map((args) => args.includes("--remote"))]).toEqual([
      "queued_in_codex",
      [true, false],
    ]);
  });

  it("hands a message over once, however often its send is repeated", async () => {
    const { ran, send } = await mailFor();
    // The repeat arrives while the first hand-over is still running.
    await Promise.all([send("hello", "k"), send("hello", "k")]);
    expect(ran.length).toBe(1);
  });

  it("delivers a message whose turn starts before the queue has returned", async () => {
    const { send, stateOf } = await mailFor(() => false, true);
    expect(stateOf(await send("hello"))).toBe("delivered");
  });

  it("tries again, and gives a message up as undeliverable after three attempts", async () => {
    const { ran, send, stateOf } = await mailFor(() => true);
    const id = await send("hello");
    expect([stateOf(id), ran.length]).toEqual(["undeliverable", 6]);
  });

  it("confirms nothing for a message whose body quotes another's label", async () => {
    const { send, stateOf, turn } = await mailFor();
    const quoted = await send("first");
    const quoting = await send(`about ${messageText(quoted, "first")}`, "second");
    turn("thr-1", messageText(quoting, `about ${messageText(quoted, "first")}`));
    expect([stateOf(quoted), stateOf(quoting)]).toEqual(["queued_in_codex", "delivered"]);
  });

  it("refuses mail for a Codex agent bound to no thread, rather than holding it", async () => {
    const { mailbox, agentOn } = await mailFor();
    expect(() => mailbox.send(agentOn(null), { idempotencyKey: "m", body: "hi" })).toThrow(
      UnknownAgent,
    );
  });

  it("hands over again, once its thread is resumed, a message left queued, but not one in Codex", async () => {
    const { store, mail, agentOn, stateOf, ran, send } = await mailFor();
    const stored = await send("already stored");
    const left = newId("msg");
    // Queued by a daemon that died before its hand-over.
    store.append({
      type: "mailbox.queued",
      entityId: left,
      actor: "system",
      payload: { agentId: agentOn("thr-1"), body: "hi" },
    });
    ran.length = 0;
    mail.listener.resumed(["thr-1"]);
    await expect.poll(() => stateOf(left)).toBe("queued_in_codex");
    expect([stateOf(stored), ran.length]).toEqual(["queued_in_codex", 1]);
  });
});
