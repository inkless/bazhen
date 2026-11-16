import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { newId } from "@bazhen/core";
import type { AgentCredentials } from "../auth/callers.ts";
import type { PeerReading } from "../auth/peer.ts";
import { serveUpgrades, upgradeOutcome } from "../testing/fixtures.ts";
import { socketUpgrades, type UpgradeRoute } from "./upgrades.ts";

let server: Server | undefined;
let dir: string | undefined;
afterEach(() => {
  server?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The route every server here serves: `/echo/:word`, which sends the word back. */
function echo(): UpgradeRoute {
  const wss = new WebSocketServer({ noServer: true });
  return {
    path: /^\/echo\/(\w+)$/,
    upgrade: (req, socket, head, _url, [, word]) =>
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(String(word))),
  };
}

/** A server whose one route accepts `/echo/:word` and sends the word back. */
async function serving() {
  const served = await serveUpgrades([echo()]);
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

const agent = newId("agent");
const TOKEN = "t".repeat(43);
const credentials: AgentCredentials = {
  agentOf: (token) => (token === TOKEN ? agent : undefined),
  untokened: () => false,
};

/**
 * The echo route on a Unix socket, as the daemon's socket serves streams, with `peer` as the read
 * of each caller's process; the URL a client connects to it with.
 */
async function servingOnSocket(peer?: () => Promise<PeerReading>) {
  dir = mkdtempSync(join(tmpdir(), "bz-upgrade-"));
  const path = join(dir, "bazhen.sock");
  server = createServer();
  server.on("upgrade", socketUpgrades(credentials, [echo()], peer));
  await new Promise<void>((resolve) => server?.listen(path, resolve));
  return (route: string) => `ws+unix://${path}:${route}`;
}

/**
 * A peer read that holds the first caller until `release`, then reads it as `first`; every later
 * caller is the human.
 */
function holdingFirst(first: PeerReading) {
  const released = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  let waiting = true;
  const peer = async (): Promise<PeerReading> => {
    const held = waiting;
    waiting = false;
    if (!held) return { kind: "outside" };
    read.resolve();
    await released.promise;
    return first;
  };
  return { peer, read: read.promise, release: () => released.resolve() };
}

/** The refusal an upgrade got: its status and the message its body gave. */
const refusalOf = (ws: WebSocket) =>
  new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_q, res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve([res.statusCode, JSON.parse(body).message]));
    });
    ws.once("open", () => reject(new Error("the upgrade was let through")));
  });

describe("WebSocket upgrades on the daemon's socket", () => {
  it("lets the human through whatever Host and Origin it sends, which only browsers send", async () => {
    const url = await servingOnSocket();
    const ws = new WebSocket(url("/echo/hello"), {
      headers: { host: "evil.example" },
      origin: "http://evil.example",
    });
    const received = await new Promise((resolve) =>
      ws.once("message", (d: Buffer) => resolve(d.toString("utf8"))),
    );
    expect(received).toBe("hello");
    ws.close();
  });

  it("refuses an agent that presents its token, 403, saying why", async () => {
    const url = await servingOnSocket();
    const ws = new WebSocket(url("/echo/hi"), { headers: { "bazhen-agent-token": TOKEN } });
    expect(await refusalOf(ws)).toEqual([403, "an agent can't attach to a terminal"]);
  });

  it("refuses a caller whose process is an agent's, though it presents nothing", async () => {
    const url = await servingOnSocket(async () => ({ kind: "agent", agentId: agent }));
    expect(await refusalOf(new WebSocket(url("/echo/hi")))).toEqual([
      403,
      "an agent can't attach to a terminal",
    ]);
  });

  it("refuses a caller whose process can't be read, whatever it presents", async () => {
    const unread = await servingOnSocket(async () => ({ kind: "refused", reason: "unreadable" }));
    const failed = await refusalOf(new WebSocket(unread("/echo/hi")));
    const tokened = await refusalOf(
      new WebSocket(unread("/echo/hi"), { headers: { "bazhen-agent-token": TOKEN } }),
    );
    expect([failed, tokened]).toEqual([
      [403, "unreadable"],
      [403, "unreadable"],
    ]);
  });

  it("refuses a caller outside every terminal whose token is no live agent's", async () => {
    const url = await servingOnSocket(async () => ({ kind: "outside" }));
    const ws = new WebSocket(url("/echo/hi"), {
      headers: { "bazhen-agent-token": "f".repeat(43) },
    });
    expect(await refusalOf(ws)).toEqual([403, "the agent token is no live agent's"]);
  });

  it("refuses a caller whose read fails outright", async () => {
    const url = await servingOnSocket(() => Promise.reject(new Error("ps failed")));
    expect(await refusalOf(new WebSocket(url("/echo/hi")))).toEqual([
      403,
      "the caller's process can't be read for sure",
    ]);
  });

  it("answers a path no route serves with 404", async () => {
    const url = await servingOnSocket();
    expect(await upgradeOutcome(new WebSocket(url("/nowhere")))).toBe(404);
  });

  it.each([
    { who: "refused", first: { kind: "refused", reason: "gone" }, at: "/echo/hi" },
    { who: "the human, at no route", first: { kind: "outside" }, at: "/nowhere" },
    { who: "the human, at a route", first: { kind: "outside" }, at: "/echo/hi" },
  ] satisfies { who: string; first: PeerReading; at: string }[])(
    "outlives a caller hanging up while it is identified, $who, and serves the next",
    async ({ first, at }) => {
      const { peer, read, release } = holdingFirst(first);
      const url = await servingOnSocket(peer);
      const path = url("").slice("ws+unix://".length, -1);
      const gone = connect(path);
      gone.write(
        `GET ${at} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
      await read;
      await new Promise((resolve) => gone.destroy().once("close", resolve));
      release();
      const next = new WebSocket(url("/echo/again"));
      const received = await new Promise((resolve) =>
        next.once("message", (d: Buffer) => resolve(d.toString("utf8"))),
      );
      next.close();
      expect(received).toBe("again");
    },
  );
});
