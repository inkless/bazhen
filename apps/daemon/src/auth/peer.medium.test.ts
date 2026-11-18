import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, createServer, request, type Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { newId } from "@bazhen/core";
import { guardCallers, type SocketEnv } from "./callers.ts";
import {
  codexServerMarked,
  MAX_READING,
  noteAccepted,
  PEER_SOURCE,
  peerReading,
  readPeer,
  type PeerChain,
  type PeerRead,
  type PeerReading,
  type TerminalPids,
} from "./peer.ts";

let server: Server | undefined;
/** Servers `connections` opened beside `server`. */
const listeners: Server[] = [];
let dir = "";
afterEach(() => {
  server?.close();
  for (const listener of listeners.splice(0)) listener.close();
  rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const agent = newId("agent");
const none: TerminalPids = { agents: new Map(), shells: new Set(), runtimes: new Set() };
/** This test's own process as an agent's pane process, which every call it makes runs under. */
const ours: TerminalPids = { ...none, agents: new Map([[process.pid, agent]]) };

/**
 * The socket's guard on a Unix socket served as main.ts serves it, its peer read by `peer`, with
 * two human routes that answer who called and how much they were sent; returns the socket path.
 */
async function guarded(peer: (connection: Socket) => Promise<PeerReading>) {
  if (!existsSync(PEER_SOURCE)) throw new Error("bazhen-peer isn't built; pnpm build:hook does");
  const app = new Hono<SocketEnv>();
  guardCallers(app, { agentOf: () => undefined, untokened: () => false }, peer);
  app.post("/v1/daemon/stop", (c) => c.json({ caller: c.get("caller") }));
  app.post("/v1/daemon/env", async (c) => c.json({ bytes: (await c.req.text()).length }));
  dir = mkdtempSync("/tmp/bz-peer-");
  const socket = join(dir, "bazhen.sock");
  const listener = getRequestListener(app.fetch);
  server = createServer((req, res) => void listener(req, res));
  server.on("connection", (connection) => noteAccepted(connection));
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  return socket;
}

/** One POST on the socket from this process, presenting nothing; its status and body. */
function post(socket: string, path = "/v1/daemon/stop", body = "", via?: Agent) {
  return new Promise<[number, string]>((resolve, reject) => {
    const req = request({ socketPath: socket, method: "POST", path, agent: via }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve([res.statusCode ?? 0, text]));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** The chain `read` names, if it read one. */
const chainOf = (read: PeerRead | undefined): PeerChain | undefined =>
  read?.kind === "read" ? read.chain : undefined;

/** A script at a path of its own, as a binary `readPeer` runs. */
function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

describe("bazhen-peer, on the socket", () => {
  it("names the process that connected, its session and its parent first among its ancestors", async () => {
    const seen: PeerRead[] = [];
    const socket = await guarded(async (connection) => {
      seen.push(await readPeer(PEER_SOURCE, connection));
      return { kind: "outside" };
    });
    await post(socket);
    const chain = chainOf(seen[0]);
    expect([chain?.pid, chain?.ancestors[0]]).toEqual([process.pid, process.ppid]);
  });

  it("takes a caller outside every agent's process, presenting nothing, as the human", async () => {
    const socket = await guarded(peerReading(PEER_SOURCE, () => none));
    expect(await post(socket)).toEqual([200, JSON.stringify({ caller: null })]);
  });

  it("refuses the human's route to a caller under an agent's process, though it presents nothing", async () => {
    const [status, body] = await post(await guarded(peerReading(PEER_SOURCE, () => ours)));
    expect([status, body]).toEqual([403, expect.stringContaining("an agent can't")]);
  });

  it("refuses the human's route to a Codex tool call that presents nothing", async () => {
    const socket = await guarded(peerReading(PEER_SOURCE, () => none));
    // A process whose arguments read as a Codex app-server's, and a command it runs that calls.
    const call = `
      import { request } from "node:http";
      request({ socketPath: ${JSON.stringify(socket)}, method: "POST", path: "/v1/daemon/stop" }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => process.stdout.write(res.statusCode + " " + text));
      }).end();
    `;
    const appServer = `
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(call)}], { stdio: "inherit" });
    `;
    const codex = spawn(process.execPath, ["--input-type=module", "-e", appServer, "app-server"], {
      argv0: join(dir, "codex"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    codex.stdout.setEncoding("utf8");
    codex.stdout.on("data", (chunk: string) => (out += chunk));
    await new Promise((resolve) => codex.stdout.on("end", resolve));
    expect(out).toMatch(/^403 .*a Codex tool call names no thread/);
  });

  it("refuses the human's route to a Codex command left running when its shell and server exit, by its thread alone", async () => {
    const socket = await guarded(peerReading(PEER_SOURCE, () => none));
    // As `bash -c 'bazhen devices &'` leaves one: by the time it calls, its parent has gone, so
    // no app-server is above it; the environment Codex gave it is all that is left. One left
    // without the thread reads as anyone's, so the thread is what decides.
    const call = `
      import { request } from "node:http";
      const server = Number(process.argv[1]);
      const late = setTimeout(() => { process.stdout.write("its parent never exited"); process.exit(1); }, 10000);
      const wait = () => (process.ppid === server ? setTimeout(wait, 20) : post());
      const post = () => request({ socketPath: ${JSON.stringify(socket)}, method: "POST", path: "/v1/daemon/stop" }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => { clearTimeout(late); process.stdout.write(process.argv[2] + " " + res.statusCode + " " + text + "\\n"); });
      }).end();
      wait();
    `;
    const appServer = `
      import { spawn } from "node:child_process";
      const { CODEX_THREAD_ID: _, ...unmarked } = process.env;
      const marked = { ...unmarked, CODEX_THREAD_ID: "01a1e0f0-593e-7ae1-9d31-769db26227fc" };
      for (const [tag, env] of [["marked", marked], ["unmarked", unmarked]]) {
        spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(call)}, String(process.pid), tag], {
          stdio: ["ignore", "inherit", "inherit"],
          detached: true,
          env,
        }).unref();
      }
    `;
    const codex = spawn(process.execPath, ["--input-type=module", "-e", appServer, "app-server"], {
      argv0: join(dir, "codex"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    codex.stdout.setEncoding("utf8");
    codex.stdout.on("data", (chunk: string) => (out += chunk));
    await new Promise((resolve) => codex.stdout.on("end", resolve));
    expect(out.trim().split("\n").toSorted()).toEqual([
      expect.stringMatching(/^marked 403 .*a Codex tool call names no thread/),
      `unmarked 200 ${JSON.stringify({ caller: null })}`,
    ]);
  });

  it("takes a caller inside an agent's terminal for that agent, though it names a Codex thread", async () => {
    const socket = await guarded(peerReading(PEER_SOURCE, () => ours));
    const call = `
      import { request } from "node:http";
      request({ socketPath: ${JSON.stringify(socket)}, method: "POST", path: "/v1/daemon/stop" }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => process.stdout.write(res.statusCode + " " + text));
      }).end();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", call], {
      env: { ...process.env, CODEX_THREAD_ID: "01a1e0f0-593e-7ae1-9d31-769db26227fc" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    await new Promise((resolve) => child.stdout.on("end", resolve));
    expect(out).toBe(
      `403 ${JSON.stringify({ error: "forbidden", message: "an agent can't stop the daemon" })}`,
    );
  });

  it("refuses a caller whose process the reader can't name, as when it fails", async () => {
    const socket = await guarded(peerReading("/bin/false", () => none));
    const [status, body] = await post(socket);
    expect([status, body]).toEqual([403, expect.stringContaining("can't be read for sure")]);
  });

  it("serves a large body and a second call on the same connection after reading its peer", async () => {
    const socket = await guarded(peerReading(PEER_SOURCE, () => none));
    const keepAlive = new Agent({ keepAlive: true, maxSockets: 1 });
    const body = "x".repeat(1 << 20);
    const first = await post(socket, "/v1/daemon/env", body, keepAlive);
    const second = await post(socket, "/v1/daemon/stop", "", keepAlive);
    keepAlive.destroy();
    expect([first, second]).toEqual([
      [200, JSON.stringify({ bytes: body.length })],
      [200, JSON.stringify({ caller: null })],
    ]);
  });

  it("refuses a call on a connection whose connector has gone, though the call before it was the human's", async () => {
    const socket = await guarded(peerReading(PEER_SOURCE, () => none));
    // The connector calls once, hands the connection to a child of its own, and exits; the child
    // calls again on it.
    const orphan = script(
      "orphan.mjs",
      `exec "${process.execPath}" --input-type=module -e '
        import { Socket } from "node:net";
        const conn = new Socket({ fd: 0 });
        conn.on("data", (d) => { process.stdout.write(String(d).split("\\r\\n")[0] + "\\n"); process.exit(0); });
        setTimeout(() => conn.write("POST /v1/daemon/stop HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 0\\r\\n\\r\\n"), 300);
      '`,
    );
    const connector = `
      import { connect } from "node:net";
      import { spawn } from "node:child_process";
      const conn = connect(${JSON.stringify(socket)}, () =>
        conn.write("POST /v1/daemon/stop HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 0\\r\\n\\r\\n"));
      conn.once("data", (d) => {
        process.stdout.write(String(d).split("\\r\\n")[0] + "\\n");
        conn.pause();
        spawn(${JSON.stringify(orphan)}, [], { stdio: [conn, "inherit", "inherit"], detached: true }).unref();
        process.exit(0);
      });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", connector], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    await new Promise((resolve) => child.stdout.on("end", resolve));
    expect(out.trim().split("\n")).toEqual(["HTTP/1.1 200 OK", "HTTP/1.1 403 Forbidden"]);
  });
});

/** The daemon's ends of `count` connections this process makes to a socket of its own. */
const connections = (count: number) =>
  new Promise<Socket[]>((resolve) => {
    dir ||= mkdtempSync("/tmp/bz-peer-");
    const socket = join(dir, `s${listeners.length}.sock`);
    const accepted: Socket[] = [];
    const held = createServer();
    listeners.push(held);
    held.on("connection", (conn) => {
      if (accepted.push(conn) === count) resolve(accepted);
    });
    held.listen(socket, () => {
      for (let i = 0; i < count; i += 1)
        request({ socketPath: socket, agent: false })
          .on("error", () => {})
          .end();
    });
  });

/** The daemon's end of a connection this process makes to a socket of its own. */
const connection = async () => {
  const [conn] = await connections(1);
  if (conn === undefined) throw new Error("no connection");
  return conn;
};

describe("readPeer, after the body is read", () => {
  it("leaves the connection serving a later call on it, as the hook routes read their body first", async () => {
    const app = new Hono<SocketEnv>();
    app.post("/v1/hooks", async (c) => {
      const bytes = (await c.req.text()).length;
      await readPeer(PEER_SOURCE, c.env.incoming.socket);
      return c.json({ bytes });
    });
    dir = mkdtempSync("/tmp/bz-peer-");
    const socket = join(dir, "bazhen.sock");
    const listener = getRequestListener(app.fetch);
    server = createServer((req, res) => void listener(req, res));
    await new Promise<void>((resolve) => server?.listen(socket, resolve));
    const keepAlive = new Agent({ keepAlive: true, maxSockets: 1 });
    const first = await post(socket, "/v1/hooks", "one", keepAlive);
    const stalled = new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 1000));
    const second = await Promise.race([post(socket, "/v1/hooks", "two!", keepAlive), stalled]);
    keepAlive.destroy();
    expect([first, second]).toEqual([
      [200, JSON.stringify({ bytes: 3 })],
      [200, JSON.stringify({ bytes: 4 })],
    ]);
  });
});

/** A reading's deadline, which every stall outlasts. */
const DEADLINE_MS = 100;
/** Longer than the deadline, and many times what a reader takes on a loaded runner. */
const STALL_MS = 300;
const WAVES = 3;
/**
 * The most loop turns a wave of readings takes: until each reader's exit is read, then until
 * the child's `close`, which frees its slot for the next wave.
 */
const TURNS_PER_WAVE = 4;
/** Opening the connections and spawning the readers, on a loaded runner. */
const STARTUP_MS = 2000;

describe("readPeer", () => {
  it("says why it read nobody when the reader refuses, exits otherwise than cleanly, or can't start", async () => {
    const conn = await connection();
    const nonsense = script("nonsense", "echo nonsense");
    const replaced = await connection();
    noteAccepted(replaced, 0);
    const readings = [
      await readPeer("/bin/false", conn),
      await readPeer(nonsense, conn),
      await readPeer(join(dir, "absent"), conn),
      await readPeer(PEER_SOURCE, replaced),
    ];
    conn.destroy();
    replaced.destroy();
    expect(readings).toEqual([
      { kind: "unread", why: "the reader exited 1" },
      { kind: "unread", why: "the reader printed no peer" },
      { kind: "unread", why: expect.stringMatching(/^the reader can't start: .*ENOENT/) },
      {
        kind: "unread",
        why: expect.stringMatching(/started at \d+, after the connection was accepted at 0$/),
      },
    ]);
  });

  it("keeps the first line of what the reader said, and at most 512 bytes of it", async () => {
    const conn = await connection();
    const panicked = script(
      "panicked",
      "printf 'thread main panicked at src/main.rs:9:5:\\nboom\\nnote: run with RUST_BACKTRACE=1\\n' >&2; exit 101",
    );
    const long = script(
      "long",
      "i=0; while [ $i -lt 400 ]; do printf '\\303\\251' >&2; i=$((i+1)); done; exit 1",
    );
    const readings = [await readPeer(panicked, conn), await readPeer(long, conn)];
    conn.destroy();
    expect(readings).toEqual([
      { kind: "unread", why: "thread main panicked at src/main.rs:9:5:" },
      { kind: "unread", why: "\u00e9".repeat(256) },
    ]);
  });

  it("reads a reader still running at its deadline as late, not as nobody", async () => {
    const conn = await connection();
    const reading = await readPeer(script("slow", "sleep 1"), conn, 100);
    conn.destroy();
    expect(reading).toEqual({ kind: "late" });
  });

  it("hears a reader that finished while the daemon's loop was stalled past the deadline", async () => {
    const conn = await connection();
    const reading = readPeer(PEER_SOURCE, conn, 100);
    stall(1000);
    const read = await reading;
    conn.destroy();
    expect(read).toEqual({ kind: "read", chain: expect.objectContaining({ pid: process.pid }) });
  });

  it(
    "reads every one of more callers than it reads at once, through repeated stalls",
    async () => {
      const conns = await connections(WAVES * MAX_READING);
      const readings = Promise.all(conns.map((conn) => readPeer(PEER_SOURCE, conn, DEADLINE_MS)));
      const stop = stallEveryTurn(STALL_MS);
      onTestFinished(stop);
      const read = await readings.finally(stop);
      for (const conn of conns) conn.destroy();
      expect(read).toEqual(
        conns.map(() => ({ kind: "read", chain: expect.objectContaining({ pid: process.pid }) })),
      );
    },
    (WAVES * TURNS_PER_WAVE + 1) * STALL_MS + STARTUP_MS,
  );
});

/** Blocks this process's loop for `ms`, as a busy daemon's is. */
function stall(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stalls the loop for `ms` now and on every turn after, until the returned stop: a reader's exit
 * is never read before a stall, however fast the host.
 */
function stallEveryTurn(ms: number): () => void {
  let stalling = true;
  const turn = () => {
    if (!stalling) return;
    stall(ms);
    setImmediate(turn);
  };
  turn();
  return () => {
    stalling = false;
  };
}

/** A process listening on a socket of its own, its argv as `argv0` and `args` give it. */
async function listening(argv0: string, ...args: string[]) {
  dir = mkdtempSync("/tmp/bz-peer-");
  const socket = join(dir, "s.sock");
  const listen = `
    import { createServer } from "node:net";
    createServer().listen(${JSON.stringify(socket)}, () => process.stdout.write("up\\n"));
    process.stdin.on("end", () => process.exit(0)).resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", listen, ...args], {
    argv0,
    stdio: ["pipe", "pipe", "inherit"],
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  return { socket, done: () => child.stdin.end() };
}

describe("codexServerMarked", () => {
  it("reads a Codex app-server's socket as one, and another listener's or none as not", async () => {
    const codex = await listening(join("/opt", "codex"), "app-server");
    const marked = await codexServerMarked(PEER_SOURCE, codex.socket);
    codex.done();
    const other = await listening("node", "server");
    const unmarked = await codexServerMarked(PEER_SOURCE, other.socket);
    other.done();
    const unread = await codexServerMarked(PEER_SOURCE, join(dir, "absent.sock"));
    expect([marked, unmarked, unread]).toEqual(["marked", "unmarked", "unread"]);
  });
});
