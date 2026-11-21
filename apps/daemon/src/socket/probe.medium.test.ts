import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
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

// Listens with a backlog of one, as `backlog: 0` is taken for Node's default, then blocks its
// thread so it never accepts, until the test lets it go.
const NEVER_ACCEPTS = `
const { parentPort, workerData } = require("node:worker_threads");
const server = require("node:net").createServer();
server.listen({ path: workerData.socket, backlog: 1 }, () => {
  parentPort.postMessage("listening");
  Atomics.wait(workerData.gate, 0, 0, 30_000);
  server.close();
});
`;

/** A socket whose listener never accepts, its backlog taken by connections of the test's own. */
async function stuck(): Promise<string> {
  const socket = socketPath();
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(NEVER_ACCEPTS, { eval: true, workerData: { socket, gate } });
  const queued: ReturnType<typeof connect>[] = [];
  cleanups.push(async () => {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    for (const conn of queued) conn.destroy();
    await worker.terminate();
  });
  await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  for (let i = 0; i < 2; i++) {
    const conn = connect(socket);
    queued.push(conn);
    await new Promise((resolve, reject) => {
      conn.once("connect", resolve);
      conn.once("error", reject);
    });
  }
  return socket;
}

describe("probe", () => {
  it("finds nothing where no socket is", async () => {
    expect(await probe(socketPath())).toEqual({ kind: "nothing" });
  });

  it("finds a daemon that takes the connection but never answers silent", async () => {
    expect(await probe(await daemon("never"), 200)).toEqual({ kind: "silent" });
  });

  it.runIf(process.platform === "linux")(
    "finds a daemon whose backlog is full silent",
    async () => {
      expect(await probe(await stuck(), 200)).toEqual({ kind: "silent" });
    },
  );

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
