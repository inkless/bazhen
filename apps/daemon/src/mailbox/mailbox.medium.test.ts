import { describe, expect, it } from "vitest";
import { HOOK_REPLY_MAX_BYTES, offeredMessage, type HookReply } from "@bazhen/protocol";
import { Store } from "../store/store.ts";
import { withAgent, testView } from "../testing/fixtures.ts";
import { UnknownAgent } from "../store/store.ts";
import { Mailbox } from "./mailbox.ts";

const stateOf = (store: Store, id: string) =>
  store.snapshot(testView).messages.find((m) => m.id === id)?.state;
const live = () => new AbortController().signal;
/** The messages a hook reply hands over. */
const idsIn = (reply: HookReply) => reply.offered.map(offeredMessage);

describe("mailbox", () => {
  it("wakes the agent's waiter with the message and its id, and holds it as offered", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const waiting = mailbox.wait(agentId, live());
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const reply = await waiting;
    expect([reply.exitCode, idsIn(reply), stateOf(store, messageId)]).toEqual([
      2,
      [messageId],
      "offered",
    ]);
    expect(reply.stderr).toContain(`(${messageId}):\nhello`);
  });

  it("confirms a message through its ack, the prompt that carries it, and that prompt's end", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const first = mailbox.send(agentId, { idempotencyKey: "m1", body: "hello" }).messageId;
    const other = mailbox.send(agentId, { idempotencyKey: "m2", body: "later" }).messageId;
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    mailbox.promptStarted(agentId, `woken by ${first}`, "p-1");
    mailbox.turnEnded(agentId, "p-other");
    expect([stateOf(store, first), stateOf(store, other)]).toEqual(["seen", "emitted"]);
    mailbox.turnEnded(agentId, "p-1");
    expect([stateOf(store, first), stateOf(store, other)]).toEqual(["delivered", "emitted"]);
  });

  it("offers no more mail than one hook reply holds, and the rest to the next waiter", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const ids = Array.from(
      { length: 60 },
      (_, i) =>
        mailbox.send(agentId, { idempotencyKey: `m${i}`, body: "x".repeat(20_000) }).messageId,
    );
    const first = await mailbox.wait(agentId, live());
    expect(Buffer.byteLength(first.stderr)).toBeLessThanOrEqual(HOOK_REPLY_MAX_BYTES);
    const second = await mailbox.wait(agentId, live());
    expect([...idsIn(first), ...idsIn(second)]).toEqual(ids);
  });

  it("offers at most 100 messages to one waiter, however small", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    for (let i = 0; i < 150; i++) mailbox.send(agentId, { idempotencyKey: `m${i}`, body: "hi" });
    expect((await mailbox.wait(agentId, live())).offered).toHaveLength(100);
    expect((await mailbox.wait(agentId, live())).offered).toHaveLength(50);
  });

  it("releases an older waiter when a newer one arrives, so only the newest hands out mail", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const older = mailbox.wait(agentId, live());
    const newer = mailbox.wait(agentId, live());
    mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    expect([(await older).exitCode, (await newer).exitCode]).toEqual([0, 2]);
  });

  it("offers a message again to the waiter when the hook client never says it wrote it", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store, { ackDeadlineMs: 10 });
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    await mailbox.wait(agentId, live());
    const again = await mailbox.wait(agentId, live());
    expect([idsIn(again), stateOf(store, messageId)]).toEqual([[messageId], "offered"]);
  });

  it("offers every message a hook held again after a restart, as a possible re-delivery", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const seen = mailbox.send(agentId, { idempotencyKey: "m1", body: "first" }).messageId;
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    mailbox.promptStarted(agentId, `woken by ${seen}`, "p-1");
    const offered = mailbox.send(agentId, { idempotencyKey: "m2", body: "second" }).messageId;
    await mailbox.wait(agentId, live());
    const restarted = new Mailbox(store);
    restarted.requeueInFlight();
    expect([stateOf(store, seen), stateOf(store, offered)]).toEqual(["queued", "queued"]);
    const again = await restarted.wait(agentId, live());
    expect([idsIn(again), again.stderr]).toEqual([
      [seen, offered],
      expect.stringMatching(
        new RegExp(`possible re-delivery of ${seen}.*possible re-delivery of ${offered}`, "s"),
      ),
    ]);
  });

  it("refuses mail for an agent it doesn't run, and queues a repeat only once", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    expect(() => mailbox.send("agent_unknown", { idempotencyKey: "x", body: "hi" })).toThrow(
      UnknownAgent,
    );
    const first = mailbox.send(agentId, { idempotencyKey: "same", body: "hi" });
    expect([
      mailbox.send(agentId, { idempotencyKey: "same", body: "hi" }),
      store.snapshot(testView).messages.length,
    ]).toEqual([first, 1]);
  });

  it("requeues what a new session can't have seen, for the new session's waiter", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store, { ackDeadlineMs: 20 });
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    await mailbox.wait(agentId, live());
    const old = mailbox.wait(agentId, live());
    mailbox.sessionStarted(agentId);
    // The old session's waiter is let go with nothing, never handed the requeued mail.
    expect((await old).exitCode).toBe(0);
    expect(stateOf(store, messageId)).toBe("queued");
    const fresh = await mailbox.wait(agentId, live());
    expect(idsIn(fresh)).toEqual([messageId]);
    mailbox.ack(fresh.offered);
    // The first offer's ack deadline went with it, so it can't requeue the second offer.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stateOf(store, messageId)).toBe("emitted");
  });

  it("leaves a seen message alone when the session starts over", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    mailbox.promptStarted(agentId, `woken by ${messageId}`, "p-1");
    mailbox.sessionStarted(agentId);
    expect(stateOf(store, messageId)).toBe("seen");
  });

  it("confirms only the offer an ack names, never a later offer of the same message", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store, { ackDeadlineMs: 20 });
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const old = await mailbox.wait(agentId, live());
    mailbox.sessionStarted(agentId);
    const fresh = await mailbox.wait(agentId, live());
    expect(idsIn(fresh)).toEqual([messageId]);
    // The old session's client acks late; the new offer is still unwritten.
    mailbox.ack(old.offered);
    expect(stateOf(store, messageId)).toBe("offered");
    // Its own deadline still stands: unwritten, it goes back to the queue.
    await expect.poll(() => stateOf(store, messageId)).toBe("queued");
  });
});
