import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EventFrame, PROTOCOL_VERSION } from "@bazhen/protocol";
import { Store } from "../store/store.ts";
import { register, serveUpgrades, tempDb, upgradeOutcome } from "../testing/fixtures.ts";
import { eventRoute } from "./server.ts";

let server: Server | undefined;
let opened: Store | undefined;
afterEach(() => {
  server?.close();
  opened?.close();
});

async function serving() {
  const store = Store.open(tempDb());
  opened = store;
  const served = await serveUpgrades([eventRoute(store)]);
  server = served.server;
  return { store, url: (query: string) => `ws://${served.host}/v1/events?${query}` };
}

describe("event stream endpoint", () => {
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
