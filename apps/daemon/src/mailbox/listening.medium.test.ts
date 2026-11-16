import { describe, expect, it } from "vitest";
import { recordClosed } from "../agents/lifecycle.ts";
import type { Store } from "../store/store.ts";
import { taskFleet, testView } from "../testing/fixtures.ts";

const close = (store: Store, agentId: string) => {
  store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
  recordClosed(store, agentId, "user");
};

describe("Mailbox listening", () => {
  it("says which of its waiter or a turn would take mail now, and neither between", async () => {
    const { mailbox, worker } = await taskFleet();
    const heard = [mailbox.listening(worker)];
    const abort = new AbortController();
    const waiting = mailbox.wait(worker, abort.signal);
    heard.push(mailbox.listening(worker));
    abort.abort();
    await waiting;
    heard.push(mailbox.listening(worker));
    mailbox.promptStarted(worker, "go on", "p1");
    heard.push(mailbox.listening(worker));
    mailbox.turnEnded(worker, "p1");
    heard.push(mailbox.listening(worker));
    expect(heard).toEqual([null, "waiter", null, "turn", null]);
  });

  it("never shows an agent that isn't running as listening, whatever its mailbox says", async () => {
    const { store, worker, lead } = await taskFleet();
    close(store, worker);
    const view = { ...testView, listening: () => true };
    const listening = new Map(store.snapshot(view).agents.map((a) => [a.id, a.listening]));
    expect([listening.get(worker), listening.get(lead)]).toEqual([false, true]);
  });

  it("asks whether an agent listens with what it was last said to be doing", async () => {
    const { store, worker, lead } = await taskFleet();
    store.append({
      type: "agent.activity",
      entityId: worker,
      actor: "system",
      payload: {
        value: "needs_approval",
        source: "native",
        confidence: 1,
        observedAt: new Date().toISOString(),
      },
    });
    const asked = new Map<string, string | null>();
    store.snapshot({
      ...testView,
      listening: ({ id, activity }) => {
        asked.set(id, activity);
        return false;
      },
    });
    expect([asked.get(worker), asked.get(lead)]).toEqual(["needs_approval", null]);
  });
});
