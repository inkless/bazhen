import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import type { MailboxState } from "@bazhen/protocol";
import { handTimer } from "../testing/fixtures.ts";
import type { After } from "../waits/until.ts";
import { UnknownMessage, waitForMail } from "./wait.ts";

const AGENT = newId("agent");
const MSG = newId("msg");

/** A store of one message whose state a test sets, and whose commits it makes by hand. */
function fakeStore(state: MailboxState) {
  const states = new Map<string, MailboxState>([[MSG, state]]);
  const listeners = new Set<() => void>();
  const store = {
    messages: (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const at = states.get(id);
        return at === undefined ? [] : [{ id, agentId: AGENT, state: at }];
      }),
    onCommit: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const commit = (next: MailboxState) => {
    states.set(MSG, next);
    for (const listener of listeners) listener();
  };
  return { store, commit, listeners };
}

const wait = (store: ReturnType<typeof fakeStore>["store"], after: After, signal?: AbortSignal) =>
  waitForMail(
    store,
    { messageIds: [MSG], timeoutMs: 60_000 },
    signal ?? new AbortController().signal,
    after,
  );

const states = async (waited: ReturnType<typeof waitForMail>) =>
  (await waited).messages.map((m) => m.state);

describe("waitForMail", () => {
  it("answers on the commit that settles the message, and leaves no listener or timer set", async () => {
    const { store, commit, listeners } = fakeStore("queued");
    const timer = handTimer();
    const waited = wait(store, timer.after);
    commit("offered");
    commit("seen");
    expect([await states(waited), listeners.size, timer.pending.size]).toEqual([["seen"], 0, 0]);
  });

  it("answers at the timeout with the state then, and leaves no listener or timer set", async () => {
    const { store, listeners } = fakeStore("queued");
    const timer = handTimer();
    const waited = wait(store, timer.after);
    timer.fire();
    expect([await states(waited), listeners.size, timer.pending.size]).toEqual([["queued"], 0, 0]);
  });

  it("answers when the asker goes away, and leaves no listener or timer set", async () => {
    const { store, listeners } = fakeStore("queued");
    const timer = handTimer();
    const abort = new AbortController();
    const waited = wait(store, timer.after, abort.signal);
    abort.abort();
    expect([await states(waited), listeners.size, timer.pending.size]).toEqual([["queued"], 0, 0]);
  });

  it("answers mail settled before it began at once, setting nothing", async () => {
    const { store, listeners } = fakeStore("delivered");
    const timer = handTimer();
    const waited = wait(store, timer.after);
    const held = [listeners.size, timer.pending.size];
    expect([await states(waited), held]).toEqual([["delivered"], [0, 0]]);
  });

  it("refuses a message it was never sent", () => {
    const { store } = fakeStore("queued");
    const unknown = { messageIds: [newId("msg")], timeoutMs: 10 };
    expect(() => waitForMail(store, unknown, new AbortController().signal)).toThrow(UnknownMessage);
  });
});
