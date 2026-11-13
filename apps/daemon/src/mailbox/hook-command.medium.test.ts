import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { signalGroup, spawnGroup } from "@bazhen/host-guard";
import { HOOK_REPLY_TYPE, HookRequest, frameHookReply, isCompatible } from "@bazhen/protocol";
import { HOOK_SCRIPT, hookClient, hookCommand } from "./hook-command.ts";

const clients = [
  ["binary", hookClient()],
  ["script", HOOK_SCRIPT],
] as const;

let server: Server | undefined;
let dir = "";
/** Clients still running when a case ends, which only a case that timed out leaves. */
const running = new Set<ChildProcess>();
afterEach(() => {
  for (const child of running) signalGroup(child, "SIGKILL");
  running.clear();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Under /tmp: a socket path must fit in about 104 bytes. */
function socketPath() {
  dir = mkdtempSync("/tmp/bz-hook-");
  return join(dir, "bazhen.sock");
}

interface Exchange {
  readonly path: string;
  readonly body: string;
}

/** Reads one HTTP request off the connection. */
function readRequest(conn: Socket): Promise<Exchange> {
  return new Promise((resolve) => {
    let data = Buffer.alloc(0);
    conn.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = data.subarray(0, end).toString();
      const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0);
      if (data.length < end + 4 + length) return;
      resolve({
        path: head.split(" ")[1] ?? "",
        body: data.subarray(end + 4, end + 4 + length).toString(),
      });
    });
  });
}

const bodyOf = (seen: readonly Exchange[], i: number) => seen[i]?.body ?? "";

const raw = (headers: Record<string, string>, body: Buffer | string, status = "200 OK") =>
  Buffer.concat([
    Buffer.from(
      `HTTP/1.1 ${status}\r\n${Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("")}\r\n`,
    ),
    Buffer.from(body),
  ]);

/** The daemon's reply, framed exactly as the daemon frames it. */
function framed(reply: Parameters<typeof frameHookReply>[0]) {
  const { headers, body } = frameHookReply(reply);
  return raw(headers, Buffer.from(body));
}

/**
 * A socket answering each request with the next of `answers`: bytes to write, or null to drop
 * the connection after reading the request. Records every request it reads.
 */
function listen(socket: string, answers: (Buffer | null)[]) {
  const seen: Exchange[] = [];
  server = createServer((conn) => {
    void readRequest(conn).then((request) => {
      seen.push(request);
      const answer =
        request.path === "/v1/hooks/ack" ? raw({ "content-length": "2" }, "{}") : answers.shift();
      if (answer === null || answer === undefined) conn.destroy();
      else conn.end(answer);
    });
  });
  server.listen(socket);
  return { seen, ready: new Promise((r) => server?.once("listening", r)) };
}

/**
 * Runs the hook client for `event` as a harness would, and resolves with how it exited. No test
 * here waits on a clock: a client that wrongly retries is caught by what the stub hands it next.
 */
function run(client: string, event: string, env: Record<string, string>, stdin = "{}") {
  const child = spawnGroup(client, [event], { env: { PATH: process.env["PATH"] ?? "", ...env } });
  running.add(child);
  const { stdin: input, stdout: out, stderr: err } = child;
  if (input === null || out === null || err === null) throw new Error("spawned without pipes");
  let stdout = "";
  let stderr = "";
  out.on("data", (d: Buffer) => (stdout += d.toString()));
  err.on("data", (d: Buffer) => (stderr += d.toString()));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // A client that exits without reading its input, as outside an agent, closes the pipe first.
    input.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") reject(e);
    });
    input.end(stdin);
    child.on("exit", (code) => {
      running.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

const QUIET = { code: 0, stdout: "", stderr: "" };
const MAIL = { exitCode: 2, stdout: "", stderr: "mail", offered: [] };

describe("hook command", () => {
  it("runs the client through a shell even when its path has spaces, quotes and $", () => {
    dir = mkdtempSync("/tmp/bz-hook-");
    const odd = join(dir, `it's a "dir" $HOME`);
    mkdirSync(odd);
    const client = join(odd, "client");
    writeFileSync(client, '#!/bin/sh\nprintf %s "$1"\n', { mode: 0o755 });
    const out = execFileSync("/bin/sh", ["-c", `${hookCommand(client)} wait`]);
    expect(out.toString()).toBe("wait");
  });

  it("runs the built binary, so the binary's cases below aren't the script's again", () => {
    expect(hookClient()).not.toBe(HOOK_SCRIPT);
  });
});

describe.each(clients)("hook client (%s)", { timeout: 30_000 }, (_kind, client) => {
  // The first run of a freshly built binary pays the OS's one-time check of it (on macOS, seconds
  // under load); paying it here keeps it out of every case below.
  beforeAll(async () => {
    await run(client, "Stop", {});
  }, 30_000);

  it("does nothing outside a Bazhen agent", async () => {
    const socket = socketPath();
    const { seen, ready } = listen(socket, [framed(MAIL)]);
    await ready;
    expect(await run(client, "Stop", { BAZHEN_SOCKET: socket })).toEqual(QUIET);
    expect(seen).toEqual([]);
  });

  it("forwards the hook with the payload first, so the fixed keys win", async () => {
    const socket = socketPath();
    const agentId = newId("agent");
    const { seen, ready } = listen(socket, [framed({ ...MAIL, exitCode: 0, stderr: "" })]);
    await ready;
    await run(
      client,
      "PreToolUse",
      { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket },
      `1,"agentId":"agent_other"`,
    );
    const body = bodyOf(seen, 0);
    expect(body.startsWith(`{"payload":1,"agentId":"agent_other",`)).toBe(true);
    const request = HookRequest.parse(JSON.parse(body));
    expect(request).toMatchObject({ agentId, event: "PreToolUse" });
    // The daemon takes any version with its own major, as `/v1/hooks` checks.
    expect(isCompatible(request.protocolVersion)).toBe(true);
  });

  it("sends a null payload for stdin that is only whitespace", async () => {
    const socket = socketPath();
    const { seen, ready } = listen(socket, [framed({ ...MAIL, exitCode: 0, stderr: "" })]);
    await ready;
    await run(client, "Stop", { BAZHEN_AGENT_ID: newId("agent"), BAZHEN_SOCKET: socket }, " \n");
    expect(JSON.parse(bodyOf(seen, 0))).toMatchObject({ payload: null });
  });

  it("prints the reply verbatim, then acks what it was offered", async () => {
    const socket = socketPath();
    const agentId = newId("agent");
    const offered = [newId("msg"), newId("msg")];
    const reply = { exitCode: 2, stdout: '{"ü":"日本"}\n', stderr: "wake\n", offered };
    const { seen, ready } = listen(socket, [framed(reply)]);
    await ready;
    const result = await run(client, "PostToolUse", {
      BAZHEN_AGENT_ID: agentId,
      BAZHEN_SOCKET: socket,
    });
    expect(result).toEqual({ code: 2, stdout: reply.stdout, stderr: reply.stderr });
    expect(seen.map((s) => s.path)).toEqual(["/v1/hooks", "/v1/hooks/ack"]);
    expect(JSON.parse(bodyOf(seen, 1))).toEqual({ agentId, offered });
  });

  it("keeps the waiter trying until the daemon's socket answers, then wakes the session", async () => {
    const socket = socketPath();
    const waiting = run(client, "wait", { BAZHEN_AGENT_ID: newId("agent"), BAZHEN_SOCKET: socket });
    // Nothing listens yet, as while the daemon restarts; the waiter must not give up.
    const reply = framed(MAIL);
    setTimeout(() => listen(socket, [reply]), 1500);
    expect(await waiting).toEqual({ code: 2, stdout: "", stderr: "mail" });
  });

  it("retries the waiter when the daemon drops it mid-request", async () => {
    const socket = socketPath();
    const { seen, ready } = listen(socket, [null, framed(MAIL)]);
    await ready;
    const result = await run(client, "wait", {
      BAZHEN_AGENT_ID: newId("agent"),
      BAZHEN_SOCKET: socket,
    });
    expect(result).toEqual({ code: 2, stdout: "", stderr: "mail" });
    expect(seen).toHaveLength(2);
  });

  it("gives up on any other hook when nothing listens", async () => {
    // A client that looked again forever would hit the describe's timeout instead.
    const result = await run(client, "PermissionRequest", {
      BAZHEN_AGENT_ID: newId("agent"),
      BAZHEN_SOCKET: socketPath(),
    });
    expect(result).toEqual(QUIET);
  });

  it("gives up at once on any other hook when the daemon drops it", async () => {
    // Mail waits on a second try, which only a client that wrongly retries would make.
    const socket = socketPath();
    const { seen, ready } = listen(socket, [null, framed(MAIL)]);
    await ready;
    const result = await run(client, "PermissionRequest", {
      BAZHEN_AGENT_ID: newId("agent"),
      BAZHEN_SOCKET: socket,
    });
    expect(result).toEqual(QUIET);
    expect(seen).toHaveLength(1);
  });

  const good = {
    "content-type": HOOK_REPLY_TYPE,
    "content-length": "4",
    "bazhen-exit-code": "2",
    "bazhen-offered": "",
    "bazhen-stdout-bytes": "2",
  };
  const malformed: [string, Buffer][] = [
    ["a server error", raw({ ...good }, "oops", "500 Internal Server Error")],
    ["JSON instead of the frame", raw({ ...good, "content-type": "application/json" }, "oops")],
    [
      "no Content-Length",
      raw(
        {
          "content-type": HOOK_REPLY_TYPE,
          "bazhen-exit-code": "2",
          "bazhen-offered": "",
          "bazhen-stdout-bytes": "0",
          connection: "close",
        },
        "",
      ),
    ],
    ["a chunked body", raw({ ...good, "transfer-encoding": "chunked" }, "4\r\noops\r\n0\r\n\r\n")],
    ["a stdout count past the body", raw({ ...good, "bazhen-stdout-bytes": "5" }, "oops")],
    ["an exit code that isn't one", raw({ ...good, "bazhen-exit-code": "two" }, "oops")],
    ["an offered ID that isn't one", raw({ ...good, "bazhen-offered": "msg_a,msg b" }, "oops")],
    ["a repeated header", raw({ ...good, "Bazhen-Exit-Code": "0" }, "oops")],
    [
      "a body over 1 MiB",
      raw({ ...good, "content-length": String(2 ** 20 + 1) }, Buffer.alloc(2 ** 20 + 1)),
    ],
  ];
  it("gives the waiter up on a whole reply without Content-Length, rather than retrying it", async () => {
    const socket = socketPath();
    const noLength = raw(
      Object.fromEntries(Object.entries(good).filter(([name]) => name !== "content-length")),
      "oops",
    );
    const { seen, ready } = listen(socket, [noLength, framed(MAIL)]);
    await ready;
    const result = await run(client, "wait", {
      BAZHEN_AGENT_ID: newId("agent"),
      BAZHEN_SOCKET: socket,
    });
    expect(result).toEqual(QUIET);
    expect(seen).toHaveLength(1);
  });

  it.each(malformed)("fails open on %s", async (_what, answer) => {
    const socket = socketPath();
    const { ready } = listen(socket, [answer]);
    await ready;
    expect(
      await run(client, "PermissionRequest", {
        BAZHEN_AGENT_ID: newId("agent"),
        BAZHEN_SOCKET: socket,
      }),
    ).toEqual(QUIET);
  });
});
