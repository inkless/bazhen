import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { newId } from "@bazhen/core";
import type { AgentCredentials } from "../auth/callers.ts";
import type { PeerReading } from "../auth/peer.ts";
import { serveUpgrades, upgradeOutcome } from "../testing/fixtures.ts";
import { socketUpgrades, type UpgradeRoute } from "./upgrades.ts";

let server: Server | undefined;
let dir: string | undefined;
const lingerers: Socket[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const conn of lingerers.splice(0)) conn.destroy();
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

/** A route whose upgrade throws, as a broken route would. */
const throwing: UpgradeRoute = {
  path: /^\/throws$/,
  upgrade: () => {
    throw new Error("the route broke");
  },
};

/** A server whose routes are the echo route and `more`. */
async function serving(...more: UpgradeRoute[]) {
  const served = await serveUpgrades([echo(), ...more]);
  server = served.server;
  return `ws://${served.host}`;
}

/** A WebSocket upgrade request for `target`, as raw bytes, since ws sends only targets it can read. */
const upgradeRequest = (target: string, host = "x") =>
  `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";

/**
 * Sends an upgrade for `target` on `conn`; what came back once the connection closed: the
 * response's status line, or "closed" if nothing did. Undefined while it is open.
 */
function rawUpgrade(conn: Socket, target: string, host?: string) {
  let received = "";
  let answer: string | undefined;
  conn.on("data", (d: Buffer) => (received += d.toString("latin1")));
  conn.on("error", () => {});
  conn.on("close", () => (answer = received === "" ? "closed" : received.split("\r\n")[0]));
  conn.write(upgradeRequest(target, host));
  return () => answer;
}

/** Whether the server's side of the next connection the server accepts has closed. */
function serverSide() {
  if (server === undefined) throw new Error("nothing is serving");
  let closed = false;
  server.once("connection", (socket: Socket) => socket.once("close", () => (closed = true)));
  return () => closed;
}

/**
 * Sends an upgrade for `target` on a connection that never closes its side, and never reads from
 * it unless `reading`; the status line read back, empty if none was.
 */
function lingering(to: { path: string } | { port: number; host: string }, reading: boolean) {
  const conn = connect({ ...to, allowHalfOpen: true });
  lingerers.push(conn);
  conn.on("error", () => {});
  let received = "";
  if (reading) conn.on("data", (d: Buffer) => (received += d.toString("latin1")));
  else conn.pause();
  return (target: string, host?: string) => {
    conn.write(upgradeRequest(target, host));
    return () => received.split("\r\n")[0];
  };
}

/** A raw connection to the server at `base`, a URL `serving` gave, and the Host it is known by. */
function dial(base: string) {
  const { hostname, port, host } = new URL(base);
  return { conn: connect(Number(port), hostname), host };
}

/** The echo route's first message on `ws`. */
const echoed = (ws: WebSocket) =>
  new Promise((resolve) => ws.once("message", (d: Buffer) => resolve(d.toString("utf8"))));

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

  it("answers a request target URL can't read with 400, and serves the next caller", async () => {
    const base = await serving();
    const { conn, host } = dial(base);
    const answer = rawUpgrade(conn, "//[", host);
    await expect.poll(answer).toBe("HTTP/1.1 400 Bad Request");
    const next = new WebSocket(`${base}/echo/again`);
    expect(await echoed(next)).toBe("again");
    next.close();
  });

  it("closes an upgrade whose route throws, logs why, and serves the next caller", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = await serving(throwing);
    const { conn, host } = dial(base);
    const answer = rawUpgrade(conn, "/throws", host);
    await expect.poll(answer).toBe("closed");
    expect(logged).toHaveBeenCalledWith("an upgrade failed", new Error("the route broke"));
    const next = new WebSocket(`${base}/echo/again`);
    expect(await echoed(next)).toBe("again");
    next.close();
  });

  it("lets no error escape from a caller that resets before its refusal is written", async () => {
    const escaped: unknown[] = [];
    const escape = (err: unknown) => escaped.push(err);
    process.on("uncaughtException", escape);
    try {
      const base = await serving();
      const closed = new Promise((resolve) =>
        server?.once("connection", (s: Socket) => s.once("close", resolve)),
      );
      const { conn } = dial(base);
      conn.on("error", () => {});
      conn.write(upgradeRequest("/echo/hi", "evil.example"), () => conn.resetAndDestroy());
      await closed;
      const next = new WebSocket(`${base}/echo/again`);
      expect(await echoed(next)).toBe("again");
      next.close();
    } finally {
      process.off("uncaughtException", escape);
    }
    expect(escaped).toEqual([]);
  });

  it("answers a target URL can't read from another host with the guard's 421, and closes its side though the caller never hangs up", async () => {
    const { hostname, port } = new URL(await serving());
    const closed = serverSide();
    const status = lingering({ port: Number(port), host: hostname }, true)("//[", "evil.example");
    await expect.poll(status).toBe("HTTP/1.1 421 Misdirected Request");
    await expect.poll(closed).toBe(true);
  });

  it("closes its side of a refusal whose caller neither reads it nor hangs up", async () => {
    const { hostname, port } = new URL(await serving());
    const closed = serverSide();
    lingering({ port: Number(port), host: hostname }, false)("/echo/hi", "evil.example");
    await expect.poll(closed).toBe(true);
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
async function servingOnSocket(peer?: () => Promise<PeerReading>, ...more: UpgradeRoute[]) {
  dir = mkdtempSync(join(tmpdir(), "bz-upgrade-"));
  const path = join(dir, "bazhen.sock");
  server = createServer();
  server.on("upgrade", socketUpgrades(credentials, [echo(), ...more], peer));
  await new Promise<void>((resolve) => server?.listen(path, resolve));
  return (route: string) => `ws+unix://${path}:${route}`;
}

/** The socket's path, from the URL maker `servingOnSocket` gave. */
const socketPath = (url: (route: string) => string) => url("").slice("ws+unix://".length, -1);

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

  it("refuses a caller whose read fails outright, and logs why", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const url = await servingOnSocket(() => Promise.reject(new Error("ps failed")));
    expect(await refusalOf(new WebSocket(url("/echo/hi")))).toEqual([
      403,
      "the caller's process can't be read for sure",
    ]);
    expect(logged).toHaveBeenCalledWith("a peer reading failed", new Error("ps failed"));
  });

  it("closes its side of a refusal on the socket whose caller never hangs up", async () => {
    const url = await servingOnSocket(async () => ({ kind: "agent", agentId: agent }));
    const closed = serverSide();
    const status = lingering({ path: socketPath(url) }, true)("/echo/hi");
    await expect.poll(status).toBe("HTTP/1.1 403 Forbidden");
    await expect.poll(closed).toBe(true);
  });

  it("answers a path no route serves with 404", async () => {
    const url = await servingOnSocket();
    expect(await upgradeOutcome(new WebSocket(url("/nowhere")))).toBe(404);
  });

  it("answers a request target URL can't read with 400 on the socket, and serves the next caller", async () => {
    const url = await servingOnSocket();
    const answer = rawUpgrade(connect(socketPath(url)), "//[");
    await expect.poll(answer).toBe("HTTP/1.1 400 Bad Request");
    const next = new WebSocket(url("/echo/again"));
    expect(await echoed(next)).toBe("again");
    next.close();
  });

  it("closes an upgrade on the socket whose route throws, logs why, and serves the next caller", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const url = await servingOnSocket(undefined, throwing);
    const answer = rawUpgrade(connect(socketPath(url)), "/throws");
    await expect.poll(answer).toBe("closed");
    expect(logged).toHaveBeenCalledWith("an upgrade failed", new Error("the route broke"));
    const next = new WebSocket(url("/echo/again"));
    expect(await echoed(next)).toBe("again");
    next.close();
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
      const gone = connect(socketPath(url));
      gone.write(upgradeRequest(at));
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
