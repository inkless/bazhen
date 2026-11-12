import { describe, expect, it } from "vitest";
import { messageText } from "@bazhen/harness-codex";
import { Mailbox } from "../mailbox/mailbox.ts";
import { withCodexAgent } from "../testing/fixtures.ts";
import { CodexMail } from "./mail.ts";

/**
 * A Codex agent's mail on thread `thr-1`, through a `codex queue` that takes a message unless
 * `refuses` says no. `startsTurn` makes the queue start the turn that carries the message
 * before the command returns, as Codex may.
 */
async function mailFor(
  refuses: (args: readonly string[]) => boolean = () => false,
  startsTurn = false,
) {
  const { store, agentId } = await withCodexAgent();
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
  const stateOf = (id: string) => store.snapshot().messages.find((m) => m.id === id)?.state;
  return { ran, send, stateOf, turn };
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
    turn("thr-other", messageText(id, "hello"));
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
});
