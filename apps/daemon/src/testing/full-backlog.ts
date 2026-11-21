import { connect, type Socket } from "node:net";
import { Worker } from "node:worker_threads";

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

function connected(socket: string): Promise<Socket> {
  const conn = connect(socket);
  return new Promise((resolve, reject) => {
    conn.once("connect", () => resolve(conn));
    conn.once("error", reject);
  });
}

/**
 * A listener at `socket` that never accepts, its backlog taken by connections of its own, so a
 * connect there fails with EAGAIN, as it does on a daemon stuck with a full backlog. Linux only:
 * macOS refuses such a connect, as it does one to a socket nothing listens on. `close` lets the
 * listener go and ends its thread; call it whether or not the test passed.
 */
export async function fullBacklog(socket: string): Promise<{ close(): Promise<void> }> {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(NEVER_ACCEPTS, { eval: true, workerData: { socket, gate } });
  const queued: Socket[] = [];
  const close = async () => {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    for (const conn of queued) conn.destroy();
    await worker.terminate();
  };
  try {
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    for (let i = 0; i < 2; i++) queued.push(await connected(socket));
    const third = await connected(socket).then(
      (conn) => (queued.push(conn), "connected"),
      (err: unknown) => (err instanceof Error && "code" in err ? err.code : String(err)),
    );
    if (third !== "EAGAIN")
      throw new Error(`the backlog isn't full: a third connect got ${String(third)}`);
  } catch (err) {
    await close();
    throw err;
  }
  return { close };
}
