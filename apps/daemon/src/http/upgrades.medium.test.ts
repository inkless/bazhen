import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { upgrades } from "./upgrades.ts";

let server: Server | undefined;
afterEach(() => {
  server?.close();
});

/** A server whose one route accepts `/echo/:word` and sends the word back. */
async function serving() {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer();
  const allow = { hosts: [] as string[], origins: [] as string[] };
  server.on(
    "upgrade",
    upgrades(allow, [
      {
        path: /^\/echo\/(\w+)$/,
        upgrade: (req, socket, head, [, word]) =>
          wss.handleUpgrade(req, socket, head, (ws) => ws.send(String(word))),
      },
    ]),
  );
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const host = `127.0.0.1:${address.port}`;
  allow.hosts.push(host);
  allow.origins.push(`http://${host}`);
  return `ws://${host}`;
}

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
    expect(await refusedWith(ws)).toBe(421);
  });

  it("refuses an upgrade from a page on another origin, 403", async () => {
    const ws = new WebSocket(`${await serving()}/echo/hi`, { origin: "http://evil.example" });
    expect(await refusedWith(ws)).toBe(403);
  });

  it("answers a path no route serves with 404", async () => {
    const ws = new WebSocket(`${await serving()}/nowhere`);
    expect(await refusedWith(ws)).toBe(404);
  });
});
