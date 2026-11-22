import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { type Socket, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fullBacklog } from "../testing/full-backlog.ts";
import { probe } from "./probe.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function socketPath(): string {
  const dir = mkdtempSync("/tmp/bz-probe-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "bazhen.sock");
}

/** A socket answering every request with `body`, or never answering one. */
async function daemon(reply: { body: string; status?: number } | "never"): Promise<string> {
  const socket = socketPath();
  const server = createServer((_req, res) => {
    if (reply === "never") return;
    res.statusCode = reply.status ?? 200;
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return socket;
}

async function stuck(): Promise<string> {
  const socket = socketPath();
  const backlog = await fullBacklog(socket);
  cleanups.push(() => backlog.close());
  return socket;
}

/** A socket whose peer starts a reply and adds a byte to its head every 50 ms, never ending it. */
async function trickling(): Promise<string> {
  const socket = socketPath();
  const conns = new Set<Socket>();
  const server = createNetServer((conn) => {
    conns.add(conn);
    conn.on("error", () => {});
    conn.write("HTTP/1.1 200 OK\r\nx-slow: ");
    const drip = setInterval(() => conn.write("a"), 50);
    conn.on("close", () => clearInterval(drip));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const conn of conns) conn.destroy();
        server.close(() => resolve());
      }),
  );
  return socket;
}

const STILL_WAITING = "still waiting";
const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<string>((r) => setTimeout(() => r(STILL_WAITING), ms))]);

describe("probe", () => {
  it("finds nothing where no socket is", async () => {
    expect(await probe(socketPath())).toEqual({ kind: "nothing" });
  });

  it("finds a daemon that takes the connection but never answers silent", async () => {
    expect(await probe(await daemon("never"), 200)).toEqual({
      kind: "silent",
      seen: "no answer within 200 ms",
    });
  });

  it.runIf(process.platform === "linux")(
    "finds a daemon whose backlog is full silent",
    async () => {
      expect((await probe(await stuck(), 200)).kind).toBe("silent");
    },
  );

  it("gives up on a peer that trickles its reply, in its time as a whole", async () => {
    expect(await within(2000, probe(await trickling(), 300))).toEqual({
      kind: "silent",
      seen: "no answer within 300 ms",
    });
  });

  it("reads the protocol a daemon speaks, and none from one before ids or from a refusal", async () => {
    const answers = [
      await probe(await daemon({ body: JSON.stringify({ status: "ok", protocolId: "abc" }) })),
      await probe(
        await daemon({ body: JSON.stringify({ status: "ok", protocolVersion: "1.53" }) }),
      ),
      await probe(await daemon({ body: JSON.stringify({ protocolId: "abc" }), status: 401 })),
      await probe(await daemon({ body: "not json" })),
    ];
    expect(answers).toEqual([
      { kind: "daemon", protocolId: "abc" },
      { kind: "daemon", protocolId: null },
      { kind: "daemon", protocolId: null },
      { kind: "daemon", protocolId: null },
    ]);
  });
});
