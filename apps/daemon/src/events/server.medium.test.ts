import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EventFrame, PROTOCOL_VERSION } from "@bazhen/protocol";
import { Store } from "../store/store.ts";
import { register, serveUpgrades, tempDb, upgradeOutcome } from "../testing/fixtures.ts";
import { eventRoute } from "./server.ts";
import { Presence } from "../notify/presence.ts";

let server: Server | undefined;
let opened: Store | undefined;
afterEach(() => {
  server?.close();
  opened?.close();
});

async function serving(presence?: Presence) {
  const store = Store.open(tempDb());
  opened = store;
  const served = await serveUpgrades([eventRoute(store, presence)]);
  server = served.server;
  return { store, url: (query: string) => `ws://${served.host}/v1/events?${query}` };
}

describe("event stream endpoint", () => {
  it("hears whether the client's page is in sight, until its stream closes", async () => {
    const presence = new Presence();
    const { store, url } = await serving(presence);
    const ws = new WebSocket(url(`v=${PROTOCOL_VERSION}&epoch=${store.epoch()}&after=0`));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send("not json");
    ws.send(JSON.stringify({ type: "visibility", visible: true }));
    await expect.poll(() => presence.seen(Date.now())).toBe(true);
    ws.close();
    await expect.poll(() => presence.seen(Date.now())).toBe(false);
  });

  it("streams the events after the cursor it was opened with", async () => {
    const { store, url } = await serving();
    const skipped = register(store).eventId;
    const ws = new WebSocket(url(`v=${PROTOCOL_VERSION}&epoch=${store.epoch()}&after=${skipped}`));
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

  it("refuses an upgrade with no cursor, or from a client of another major version, with 400", async () => {
    const { store, url } = await serving();
    const epoch = store.epoch();
    const statuses = await Promise.all(
      [`v=${PROTOCOL_VERSION}&epoch=${epoch}`, `v=2.0&epoch=${epoch}&after=0`].map((q) =>
        upgradeOutcome(new WebSocket(url(q))),
      ),
    );
    expect(statuses).toEqual([400, 400]);
  });
});
