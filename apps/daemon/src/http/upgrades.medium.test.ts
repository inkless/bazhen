import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { serveUpgrades, upgradeOutcome } from "../testing/fixtures.ts";

let server: Server | undefined;
afterEach(() => {
  server?.close();
});

/** A server whose one route accepts `/echo/:word` and sends the word back. */
async function serving() {
  const wss = new WebSocketServer({ noServer: true });
  const served = await serveUpgrades([
    {
      path: /^\/echo\/(\w+)$/,
      upgrade: (req, socket, head, _url, [, word]) =>
        wss.handleUpgrade(req, socket, head, (ws) => ws.send(String(word))),
    },
  ]);
  server = served.server;
  return `ws://${served.host}`;
}

describe("WebSocket upgrades", () => {
  it("hands a matching path to its route, with what the path captured", async () => {
    const ws = new WebSocket(`${await serving()}/echo/hello`);
    const received = await new Promise((resolve) =>
      ws.once("message", (d: Buffer) => resolve(d.toString("utf8"))),
    );
    expect(received).toBe("hello");
    ws.close();
  });

  it("answers a stream from another host as HTTP does, 421", async () => {
    const ws = new WebSocket(`${await serving()}/echo/hi`, { headers: { host: "evil.example" } });
    expect(await upgradeOutcome(ws)).toBe(421);
  });

  it("refuses an upgrade from a page on another origin, 403", async () => {
    const ws = new WebSocket(`${await serving()}/echo/hi`, { origin: "http://evil.example" });
    expect(await upgradeOutcome(ws)).toBe(403);
  });

  it("answers a path no route serves with 404", async () => {
    const ws = new WebSocket(`${await serving()}/nowhere`);
    expect(await upgradeOutcome(ws)).toBe(404);
  });
});
