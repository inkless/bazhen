import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { newId } from "@bazhen/core";
import { PROTOCOL_VERSION } from "@bazhen/protocol";
import { upgrades } from "../http/upgrades.ts";
import { streamRoute } from "./server.ts";

let server: Server | undefined;
afterEach(() => {
  server?.close();
});

const terminalId = newId("term");

/** A stream endpoint over a hub that counts joins and never finishes one. */
async function endpoint() {
  let joins = 0;
  const hub = {
    join: () => {
      joins++;
      return new Promise<never>(() => {});
    },
  };
  server = createServer();
  const allow = { hosts: [] as string[], origins: [] as string[] };
  server.on(
    "upgrade",
    upgrades(allow, [
      streamRoute({
        hub,
        runtimeRef: (id) => ({ terminalId, runtime: "fake", locator: { id } }),
      }),
    ]),
  );
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const host = `127.0.0.1:${address.port}`;
  allow.hosts.push(host);
  allow.origins.push(`http://${host}`);
  return { url: `ws://${host}/v1/terminals/${terminalId}/stream`, joins: () => joins };
}

const hello = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  mode: "interactive",
  cols: 80,
  rows: 24,
};

describe("stream endpoint", () => {
  it("joins once, however many hellos arrive while the first join is pending", async () => {
    const { url, joins } = await endpoint();
    const ws = new WebSocket(url);
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify(hello));
    ws.send(JSON.stringify(hello));
    // Frames are handled in order: once this one is refused, both hellos have been seen.
    ws.send(JSON.stringify({ type: "unknown" }));
    await new Promise((resolve) => ws.once("close", resolve));
    expect(joins()).toBe(1);
  });
});
