import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { newId } from "@bazhen/core";
import { EventFrame, PROTOCOL_VERSION } from "@bazhen/protocol";
import { upgrades } from "../http/upgrades.ts";
import { Store } from "../store/store.ts";
import { tempDb } from "../testing/fixtures.ts";
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
  server = createServer();
  const allow = { hosts: [] as string[], origins: [] as string[] };
  server.on("upgrade", upgrades(allow, [eventRoute(store)]));
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const host = `127.0.0.1:${address.port}`;
  allow.hosts.push(host);
  return { store, url: (query: string) => `ws://${host}/v1/events?${query}` };
}

const register = (s: Store) =>
  s.append({
    type: "environment.registered",
    entityId: newId("env"),
    actor: "system",
    payload: { kind: "local" },
  });

/** The status an upgrade was refused with, or "open" if it was let through. */
const refusedWith = (ws: WebSocket) =>
  new Promise((resolve) => {
    ws.once("unexpected-response", (_q, res) => resolve(res.statusCode));
    ws.once("open", () => {
      resolve("open");
      ws.close();
    });
    ws.once("error", (err) => resolve(err.message));
  });

describe("event stream endpoint", () => {
  it("streams the events after the cursor it was opened with", async () => {
    const { store, url } = await serving();
    const skipped = register(store);
    const ws = new WebSocket(url(`v=${PROTOCOL_VERSION}&epoch=${store.epoch()}&after=${skipped}`));
    const frames: EventFrame[] = [];
    ws.on("message", (data: Buffer) =>
      frames.push(EventFrame.parse(JSON.parse(data.toString("utf8")))),
    );
    await new Promise((resolve) => ws.once("open", resolve));
    const sent = register(store);
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
        refusedWith(new WebSocket(url(q))),
      ),
    );
    expect(statuses).toEqual([400, 400]);
  });
});
