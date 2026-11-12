import { describe, expect, it } from "vitest";
import type { EventFrame } from "@bazhen/protocol";
import { age, register as registered, settled, tempDb } from "../testing/fixtures.ts";
import { Store } from "../store/store.ts";
import { follow } from "./feed.ts";

const register = (store: Store) => registered(store).eventId;

/** A client that records what it is sent, and acknowledges writes only when told to. */
function client(acknowledge: "at once" | "by hand" = "at once") {
  const frames: EventFrame[] = [];
  const pending: (() => void)[] = [];
  let closed = false;
  const sink = {
    send: (frame: EventFrame, written?: () => void) => {
      frames.push(frame);
      if (written === undefined) return;
      if (acknowledge === "at once") written();
      else pending.push(written);
    },
    close: () => (closed = true),
  };
  return {
    sink,
    ids: () => frames.flatMap((f) => (f.type === "event" ? [f.event.id] : [])),
    frames,
    closed: () => closed,
    /** Writes the feed is waiting to hear have finished. */
    awaited: () => pending.length,
    /** The client finishes receiving the page in flight. */
    drain: () => pending.shift()?.(),
  };
}

describe("event feed", () => {
  it("sends the backlog after the cursor, then each new event, every one once", async () => {
    const store = Store.open(tempDb());
    const first = register(store);
    const second = register(store);
    const c = client();
    follow(store, { epoch: store.epoch(), after: first }, c.sink);
    const third = register(store);
    const fourth = register(store);
    await settled();
    expect(c.ids()).toEqual([second, third, fourth]);
    store.close();
  });

  it("keeps one page in flight, and reads what arrived meanwhile once it is written", async () => {
    const store = Store.open(tempDb());
    const ids = [register(store), register(store), register(store)];
    const c = client("by hand");
    follow(store, { epoch: store.epoch(), after: 0 }, c.sink, 2);
    ids.push(register(store));
    await settled();
    expect([c.ids(), c.awaited()]).toEqual([ids.slice(0, 2), 1]);
    c.drain();
    expect([c.ids(), c.awaited()]).toEqual([ids, 1]);
    store.close();
  });

  it("resets a client that retention overtakes while it reads an old backlog", () => {
    const path = tempDb();
    const store = Store.open(path);
    const ids = [register(store), register(store), register(store), register(store)];
    age(path);
    const c = client("by hand");
    follow(store, { epoch: store.epoch(), after: 0 }, c.sink, 2);
    while (store.pruneBatch(new Date("2026-02-01T00:00:00.000Z")));
    c.drain();
    expect(c.ids()).toEqual(ids.slice(0, 2));
    expect([c.frames.at(-1), c.closed()]).toEqual([{ type: "reset", reason: "stale" }, true]);
    store.close();
  });

  it("resets a cursor from another store at once, sending it no events", () => {
    const store = Store.open(tempDb());
    register(store);
    const c = client();
    follow(store, { epoch: "0".repeat(32), after: 0 }, c.sink);
    expect([c.frames, c.closed()]).toEqual([[{ type: "reset", reason: "foreign" }], true]);
    store.close();
  });

  it("sends nothing more once stopped", async () => {
    const store = Store.open(tempDb());
    const c = client();
    const stop = follow(store, { epoch: store.epoch(), after: 0 }, c.sink);
    const seen = register(store);
    await settled();
    stop();
    register(store);
    await settled();
    expect(c.ids()).toEqual([seen]);
    store.close();
  });
});
