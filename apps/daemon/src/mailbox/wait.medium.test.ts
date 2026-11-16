import { describe, expect, it } from "vitest";
import { recordClosed } from "../agents/lifecycle.ts";
import type { Store } from "../store/store.ts";
import { handTimer, settled, taskFleet } from "../testing/fixtures.ts";
import { waitForMail } from "./wait.ts";

const close = (store: Store, agentId: string) => {
  store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
  recordClosed(store, agentId, "user");
};

/** A fleet with mail to each agent named, and a wait on it whose timeout the test fires. */
async function waiting(to: (fleet: Awaited<ReturnType<typeof taskFleet>>) => string[]) {
  const fleet = await taskFleet();
  const messageIds = to(fleet).map(
    (agentId) => fleet.tasks.send(null, agentId, { idempotencyKey: agentId, body: "hi" }).messageId,
  );
  const abort = new AbortController();
  const timer = handTimer();
  let answered = false;
  const waited = waitForMail(
    fleet.store,
    { messageIds, timeoutMs: 60_000 },
    abort.signal,
    timer.after,
  );
  void waited.then(() => (answered = true));
  const states = async () => (await waited).messages.map((m) => m.state);
  return { ...fleet, abort, timer, states, answered: () => answered };
}

const toWorker = (f: { worker: string }) => [f.worker];

describe("waitForMail", () => {
  it("answers once the agent's prompt carries the message", async () => {
    const { mailbox, worker, states } = await waiting(toWorker);
    const wake = await mailbox.wait(worker, new AbortController().signal);
    mailbox.promptStarted(worker, wake.stderr, "p1");
    expect(await states()).toEqual(["seen"]);
  });

  it("answers once the message bounces", async () => {
    const { store, worker, states } = await waiting(toWorker);
    close(store, worker);
    expect(await states()).toEqual(["undeliverable"]);
  });

  it("answers at the timeout with the state then, whatever else commits meanwhile", async () => {
    const { tasks, lead, timer, states, answered } = await waiting(toWorker);
    tasks.send(null, lead, { idempotencyKey: "other", body: "unrelated" });
    await settled();
    const early = answered();
    timer.fire();
    expect([early, await states()]).toEqual([false, ["queued"]]);
  });

  it("answers at once when the asker goes away", async () => {
    const { abort, states } = await waiting(toWorker);
    abort.abort();
    expect(await states()).toEqual(["queued"]);
  });

  it("waits for every message, answering at the timeout while one is still on its way", async () => {
    const { mailbox, worker, timer, states, answered } = await waiting((f) => [f.worker, f.lead]);
    const wake = await mailbox.wait(worker, new AbortController().signal);
    mailbox.promptStarted(worker, wake.stderr, "p1");
    await settled();
    const early = answered();
    timer.fire();
    expect([early, await states()]).toEqual([false, ["seen", "queued"]]);
  });
});
