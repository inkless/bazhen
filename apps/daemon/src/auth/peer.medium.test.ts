import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, createServer, request, type Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { guardCallers, type SocketEnv } from "./callers.ts";
import {
  noteAccepted,
  PEER_SOURCE,
  peerReading,
  readPeer,
  type PeerChain,
  type PeerReading,
  type TerminalPids,
} from "./peer.ts";

let server: Server | undefined;
let dir = "";
afterEach(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
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

/** A script at a path of its own, as a binary `readPeer` runs. */
function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

describe("bazhen-peer, on the socket", () => {
  it("names the process that connected, its session and its parent first among its ancestors", async () => {
    const seen: (PeerChain | undefined)[] = [];
    const socket = await guarded(async (connection) => {
      seen.push(await readPeer(PEER_SOURCE, connection));
      return { kind: "outside" };
    });
    await post(socket);
    expect([seen[0]?.pid, seen[0]?.ancestors[0]]).toEqual([process.pid, process.ppid]);
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
    expect(out).toMatch(/^403 .*a Codex tool call names no agent/);
  });

  it("refuses the human's route to a Codex command left running when its shell and server exit", async () => {
    const socket = await guarded(peerReading(PEER_SOURCE, () => none));
    // As `bash -c 'bazhen devices &'` leaves one: by the time it calls, its parent has gone, so
    // no app-server is above it; the environment Codex gave it is all that is left.
    const call = `
      import { request } from "node:http";
      const server = Number(process.argv[1]);
      const late = setTimeout(() => { process.stdout.write("its parent never exited"); process.exit(1); }, 10000);
      const wait = () => (process.ppid === server ? setTimeout(wait, 20) : post());
      const post = () => request({ socketPath: ${JSON.stringify(socket)}, method: "POST", path: "/v1/daemon/stop" }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => { clearTimeout(late); process.stdout.write(res.statusCode + " " + text); });
      }).end();
      wait();
    `;
    const appServer = `
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(call)}, String(process.pid)], {
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
        env: { ...process.env, CODEX_THREAD_ID: "01a1e0f0-593e-7ae1-9d31-769db26227fc" },
      }).unref();
    `;
    const codex = spawn(process.execPath, ["--input-type=module", "-e", appServer, "app-server"], {
      argv0: join(dir, "codex"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    codex.stdout.setEncoding("utf8");
    codex.stdout.on("data", (chunk: string) => (out += chunk));
    await new Promise((resolve) => codex.stdout.on("end", resolve));
    expect(out).toMatch(/^403 .*a Codex tool call names no agent/);
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

/** The daemon's end of a connection this process makes to a socket of its own. */
const connection = () =>
  new Promise<Socket>((resolve) => {
    dir = mkdtempSync("/tmp/bz-peer-");
    const socket = join(dir, "s.sock");
    server = createServer();
    server.on("connection", resolve);
    server.listen(socket, () =>
      request({ socketPath: socket })
        .on("error", () => {})
        .end(),
    );
  });

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

describe("readPeer", () => {
  it("names nobody when the reader exits otherwise than cleanly, can't start, or takes too long", async () => {
    const conn = await connection();
    const slow = script("slow", "sleep 1");
    const readings = [
      await readPeer("/bin/false", conn),
      await readPeer(join(dir, "absent"), conn),
      await readPeer(slow, conn, 100),
    ];
    conn.destroy();
    expect(readings).toEqual([undefined, undefined, undefined]);
  });
});
