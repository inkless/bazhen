import { describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { withAgent } from "../testing/fixtures.ts";
import { Mailbox, UnknownAgent } from "./mailbox.ts";

const stateOf = (store: Store, id: string) =>
  store.snapshot().messages.find((m) => m.id === id)?.state;
const live = () => new AbortController().signal;

describe("mailbox", () => {
  it("wakes the agent's waiter with the message and its id, and holds it as offered", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const waiting = mailbox.wait(agentId, live());
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const reply = await waiting;
    expect([reply.exitCode, reply.offered, stateOf(store, messageId)]).toEqual([
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
    await mailbox.wait(agentId, live());
    mailbox.ack([first, other]);
    mailbox.promptStarted(agentId, `woken by ${first}`, "p-1");
    mailbox.turnEnded(agentId, "p-other");
    expect([stateOf(store, first), stateOf(store, other)]).toEqual(["seen", "emitted"]);
    mailbox.turnEnded(agentId, "p-1");
    expect([stateOf(store, first), stateOf(store, other)]).toEqual(["delivered", "emitted"]);
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
    const mailbox = new Mailbox(store, 10);
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    await mailbox.wait(agentId, live());
    const again = await mailbox.wait(agentId, live());
    expect([again.offered, stateOf(store, messageId)]).toEqual([[messageId], "offered"]);
  });

  it("offers every message a hook held again after a restart, as a possible re-delivery", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const seen = mailbox.send(agentId, { idempotencyKey: "m1", body: "first" }).messageId;
    await mailbox.wait(agentId, live());
    mailbox.ack([seen]);
    mailbox.promptStarted(agentId, `woken by ${seen}`, "p-1");
    const offered = mailbox.send(agentId, { idempotencyKey: "m2", body: "second" }).messageId;
    await mailbox.wait(agentId, live());
    const restarted = new Mailbox(store);
    restarted.requeueInFlight();
    expect([stateOf(store, seen), stateOf(store, offered)]).toEqual(["queued", "queued"]);
    const again = await restarted.wait(agentId, live());
    expect([again.offered, again.stderr]).toEqual([
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
      store.snapshot().messages.length,
    ]).toEqual([first, 1]);
  });
});
