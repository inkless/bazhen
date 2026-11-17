import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EventFrame } from "@bazhen/protocol";
import { Store } from "../store/store.ts";
import { register, serveUpgrades, tempDb, upgradeOutcome } from "../testing/fixtures.ts";
import { eventRoute, type EventDeps } from "./server.ts";
import { Presence } from "../notify/presence.ts";

const visible = JSON.stringify({ type: "visibility", visible: true });

let server: Server | undefined;
let opened: Store | undefined;
afterEach(() => {
  server?.close();
  opened?.close();
});

async function serving(more: Omit<EventDeps, "store"> = {}) {
  const store = Store.open(tempDb());
  opened = store;
  const served = await serveUpgrades([eventRoute({ store, ...more })]);
  server = served.server;
  return { store, url: (query: string) => `ws://${served.host}/v1/events?${query}` };
}

describe("event stream endpoint", () => {
  it("hears whether the client's page is in sight, until its stream closes", async () => {
    const presence = new Presence();
    const { store, url } = await serving({ presence });
    const ws = new WebSocket(url(`epoch=${store.epoch()}&after=0`));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send("not json");
    ws.send(visible);
    await expect.poll(() => presence.seen(Date.now())).toBe(true);
    ws.close();
    await expect.poll(() => presence.seen(Date.now())).toBe(false);
  });

  it("streams the events after the cursor it was opened with", async () => {
    const { store, url } = await serving();
    const skipped = register(store).eventId;
    const ws = new WebSocket(url(`epoch=${store.epoch()}&after=${skipped}`));
    const frames: EventFrame[] = [];
    ws.on("message", (data: Buffer) =>
      frames.push(EventFrame.parse(JSON.parse(data.toString("utf8")))),
    );
    await new Promise((resolve) => ws.once("open", resolve));
    const sent = register(store).eventId;
    await expect
      .poll(() => frames)
      .toEqual([{ type: "event", event: expect.objectContaining({ id: sent }) }]);
    ws.close();
  });

  it("takes an upgrade whose cursor is whole though it names no version, and refuses one that isn't with 400", async () => {
    const { store, url } = await serving();
    const epoch = store.epoch();
    const outcomes = await Promise.all(
      [`epoch=${epoch}&after=0`, `epoch=${epoch}`, "after=0"].map((q) =>
        upgradeOutcome(new WebSocket(url(q))),
      ),
    );
    expect(outcomes).toEqual(["open", 400, 400]);
  });

  it("ends a client that stops answering pings, and forgets that its page was in sight", async () => {
    const presence = new Presence();
    const { store, url } = await serving({ presence, heartbeatMs: 100 });
    const ws = new WebSocket(url(`epoch=${store.epoch()}&after=0`), { autoPong: false });
    let closed = false;
    ws.on("close", () => (closed = true));
    await new Promise((resolve) => ws.once("open", resolve));
    // Seen once, then silent, as a phone that sleeps with the page open.
    ws.send(visible);
    await expect.poll(() => presence.seen(Date.now())).toBe(true);
    await expect
      .poll(() => [closed, presence.seen(Date.now())], { timeout: 2_000 })
      .toEqual([true, false]);
  });

  it("keeps a client that answers pings", async () => {
    const { store, url } = await serving({ heartbeatMs: 100 });
    const ws = new WebSocket(url(`epoch=${store.epoch()}&after=0`));
    let pings = 0;
    ws.on("ping", () => pings++);
    await new Promise((resolve) => ws.once("open", resolve));
    // Each ping after the first would have ended a client that didn't answer the one before.
    await expect.poll(() => pings, { timeout: 2_000 }).toBeGreaterThanOrEqual(3);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("keeps a client that sends no pongs while its page keeps reporting", async () => {
    const { store, url } = await serving({ heartbeatMs: 100 });
    const ws = new WebSocket(url(`epoch=${store.epoch()}&after=0`), { autoPong: false });
    let pings = 0;
    ws.on("ping", () => pings++);
    await new Promise((resolve) => ws.once("open", resolve));
    const reporting = setInterval(() => ws.send(visible), 30);
    try {
      await expect.poll(() => pings, { timeout: 2_000 }).toBeGreaterThanOrEqual(3);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      clearInterval(reporting);
      ws.close();
    }
  });
});
