import { describe, expect, it } from "vitest";
import { HOOK_REPLY_MAX_BYTES, offeredMessage, type HookReply } from "@bazhen/protocol";
import { Store } from "../store/store.ts";
import { withAgent, testView } from "../testing/fixtures.ts";
import { UnknownAgent } from "../store/store.ts";
import { MAX_FAILURES, Mailbox } from "./mailbox.ts";

const stateOf = (store: Store, id: string) =>
  store.snapshot(testView).messages.find((m) => m.id === id)?.state;
const live = () => new AbortController().signal;
/** The messages a hook reply hands over. */
const idsIn = (reply: HookReply) => reply.offered.map(offeredMessage);

/** A store with one agent, its mailbox, and a message woken into prompt `p-1` and seen there. */
async function seenInP1() {
  const { store, agentId } = await withAgent();
  const mailbox = new Mailbox(store);
  const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
  mailbox.ack((await mailbox.wait(agentId, live())).offered);
  mailbox.promptStarted(agentId, `woken by ${messageId}`, "p-1");
  const requeues = () =>
    store
      .events(0)
      .filter((e) => e.type === "mailbox.requeued" && e.entityId === messageId)
      .map((e) => Reflect.get(Object(e.payload), "reason"));
  return { store, agentId, mailbox, messageId, state: () => stateOf(store, messageId), requeues };
}

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
    expect([stateOf(store, first), stateOf(store, other)]).toEqual(["seen", "emitted"]);
    mailbox.turnEnded(agentId, "p-1");
    expect([stateOf(store, first), stateOf(store, other)]).toEqual(["delivered", "emitted"]);
    mailbox.turnEnded(agentId, "p-2");
    // `other` was handed over, then two turns ended without it in a prompt: it never arrived.
    expect(stateOf(store, other)).toBe("queued");
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

  it("waits for the turn after a mid-turn wake before calling it unseen", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const woken = mailbox.send(agentId, { idempotencyKey: "m1", body: "hello" }).messageId;
    const lost = mailbox.send(agentId, { idempotencyKey: "m2", body: "lost" }).messageId;
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    // The turn under way when the wake landed ends first; the wake starts the next one.
    mailbox.turnEnded(agentId, "p-running");
    expect([stateOf(store, woken), stateOf(store, lost)]).toEqual(["emitted", "emitted"]);
    mailbox.promptStarted(agentId, `woken by ${woken}`, "p-wake");
    mailbox.turnEnded(agentId, "p-wake");
    // A second turn has ended without `lost` in a prompt: it never reached the agent.
    expect([stateOf(store, woken), stateOf(store, lost)]).toEqual(["delivered", "queued"]);
  });

  it("leaves a seen message alone when the session only compacts, and requeues it otherwise", async () => {
    const compacted = await seenInP1();
    compacted.mailbox.sessionStarted(compacted.agentId, true);
    expect(compacted.state()).toBe("seen");
    // A resume after the TUI died, or a /clear: the turn that saw it is over.
    const restarted = await seenInP1();
    restarted.mailbox.sessionStarted(restarted.agentId);
    expect([restarted.state(), restarted.requeues()]).toEqual(["queued", ["session_started"]]);
  });

  it("requeues what a turn saw when the next turn starts with no Stop for it, as after Esc", async () => {
    const { mailbox, agentId, state, requeues } = await seenInP1();
    mailbox.promptStarted(agentId, "never mind, do this instead", "p-2");
    expect([state(), requeues()]).toEqual(["queued", ["interrupted"]]);
  });

  it("takes a prompt typed during the turn for part of it, and only a new turn for an interrupt", async () => {
    const { mailbox, agentId, state, requeues } = await seenInP1();
    // Claude Code gives a prompt typed mid-turn the running turn's own prompt id.
    mailbox.promptStarted(agentId, "also say hi", "p-1");
    expect([state(), requeues()]).toEqual(["seen", []]);
    mailbox.promptStarted(agentId, "something else", "p-2");
    expect([state(), requeues()]).toEqual(["queued", ["interrupted"]]);
  });

  it("never lets a later turn's Stop deliver what an interrupted turn saw", async () => {
    const { mailbox, agentId, state, requeues } = await seenInP1();
    // Esc ends p-1 silently; a background subagent's report starts p-2, which stops.
    mailbox.promptStarted(agentId, "<task-notification>done</task-notification>", "p-2");
    mailbox.turnEnded(agentId, "p-2");
    expect([state(), requeues()]).toEqual(["queued", ["interrupted"]]);
  });

  it("requeues what a turn saw when it ends in an API error", async () => {
    const { mailbox, agentId, state, requeues } = await seenInP1();
    mailbox.turnFailed(agentId, "p-1");
    expect([state(), requeues()]).toEqual(["queued", ["stop_failed"]]);
  });

  it("starts a requeued message's turn count over, so a new session can't call it unseen early", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    mailbox.turnEnded(agentId, "p-1");
    mailbox.sessionStarted(agentId);
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    // One turn end since it was written again: not yet the second.
    mailbox.turnEnded(agentId, "p-2");
    expect(stateOf(store, messageId)).toBe("emitted");
    mailbox.turnEnded(agentId, "p-3");
    expect(stateOf(store, messageId)).toBe("queued");
  });

  it("gives a message up once the agent's side has failed it four times", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const failTurn = async (promptId: string) => {
      expect(stateOf(store, messageId)).toBe("queued");
      mailbox.ack((await mailbox.wait(agentId, live())).offered);
      mailbox.promptStarted(agentId, `woken by ${messageId}`, promptId);
      mailbox.turnFailed(agentId, promptId);
    };
    for (let attempt = 1; attempt < MAX_FAILURES; attempt++) await failTurn(`p-${attempt}`);
    // A requeue the daemon causes, here a session starting over, never uses up an attempt.
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    mailbox.sessionStarted(agentId);
    await failTurn("p-last");
    expect(stateOf(store, messageId)).toBe("undeliverable");
    const reasons = store
      .events(0)
      .filter((e) => e.type === "mailbox.requeued")
      .map((e) => Reflect.get(Object(e.payload), "reason"));
    expect(reasons).toEqual([
      "stop_failed",
      "stop_failed",
      "stop_failed",
      "session_started",
      "stop_failed",
    ]);
  });

  it("offers a written wake again when it stays unseen while the agent is idle", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store, { unseenDeadlineMs: 20 });
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    await expect.poll(() => stateOf(store, messageId)).toBe("queued");
  });

  it("leaves an unseen wake to the turn boundaries while a turn is under way", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store, { unseenDeadlineMs: 20 });
    mailbox.promptStarted(agentId, "a long task", "p-1");
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stateOf(store, messageId)).toBe("emitted");
    mailbox.turnEnded(agentId, "p-1");
    // Idle now: the deadline runs again, and the wake goes back to the queue.
    await expect.poll(() => stateOf(store, messageId)).toBe("queued");
  });

  it("takes a wake held back past its deadline as seen when its prompt lands, calling off the re-offer", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store, { unseenDeadlineMs: 20 });
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    // A dialog held the wake back; it went back to the queue with no waiter to take it.
    await expect.poll(() => stateOf(store, messageId)).toBe("queued");
    mailbox.promptStarted(agentId, `woken by ${messageId}`, "p-1");
    expect(stateOf(store, messageId)).toBe("seen");
    mailbox.turnEnded(agentId, "p-1");
    expect(stateOf(store, messageId)).toBe("delivered");
  });

  it("takes a late wake as seen though its message is out again, which then can't requeue it", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store, { ackDeadlineMs: 20, unseenDeadlineMs: 20 });
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    const waiting = mailbox.wait(agentId, live());
    await waiting;
    expect(stateOf(store, messageId)).toBe("offered");
    mailbox.promptStarted(agentId, `woken by ${messageId}`, "p-1");
    // The second offer's ack deadline went with it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stateOf(store, messageId)).toBe("seen");
  });

  it("ends a turn on whichever of its two end reports arrives, and counts it once", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store);
    const seen = mailbox.send(agentId, { idempotencyKey: "m1", body: "hello" }).messageId;
    const later = mailbox.send(agentId, { idempotencyKey: "m2", body: "later" }).messageId;
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    mailbox.promptStarted(agentId, `woken by ${seen}`, "p-1");
    // The Stop report and the waiter beside it both say p-1 ended.
    mailbox.turnEnded(agentId, "p-1");
    mailbox.turnEnded(agentId, "p-1");
    // One turn end, not two: `later` is not yet called unseen.
    expect([stateOf(store, seen), stateOf(store, later)]).toEqual(["delivered", "emitted"]);
    mailbox.turnEnded(agentId, "p-2");
    expect(stateOf(store, later)).toBe("queued");
  });

  it("stops waiting on a turn whose end was never heard, after a few deadlines", async () => {
    const { store, agentId } = await withAgent();
    const mailbox = new Mailbox(store, { unseenDeadlineMs: 20 });
    mailbox.promptStarted(agentId, "a task", "p-1");
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    mailbox.ack((await mailbox.wait(agentId, live())).offered);
    await expect.poll(() => stateOf(store, messageId)).toBe("queued");
  });
});
