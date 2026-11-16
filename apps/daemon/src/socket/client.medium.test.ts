import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HealthResponse } from "@bazhen/protocol";
import {
  ANOTHER_BUILD,
  DaemonError,
  DaemonUnreachable,
  answers,
  call,
  spokenProtocol,
} from "./client.ts";

let server: Server | undefined;
let dir = "";
afterEach(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env["BAZHEN_AGENT_ID"];
  delete process.env["BAZHEN_AGENT_AUTH_FILE"];
});

const health = {
  status: "ok",
  appVersion: "0.1.0",
  protocolId: "protocol-of-this-build",
  runtime: { kind: "tmux", state: "healthy", version: "3.5a" },
};

/** A socket answering every request with `body`; records the headers it was sent. */
async function daemon(body: string, status = 200) {
  dir = mkdtempSync("/tmp/bz-cli-");
  const socket = join(dir, "bazhen.sock");
  const seen: IncomingHttpHeaders[] = [];
  server = createServer((req, res) => {
    seen.push(req.headers);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(body);
  });
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  return { socket, seen };
}

const getHealth = { method: "GET", path: "/v1/health", reply: HealthResponse } as const;

describe("call", () => {
  it("returns the daemon's reply, checked against the protocol", async () => {
    const { socket } = await daemon(JSON.stringify(health));
    expect(await call(socket, getHealth)).toEqual(health);
  });

  it("says the daemon isn't running when nothing listens", async () => {
    dir = mkdtempSync("/tmp/bz-cli-");
    await expect(call(join(dir, "bazhen.sock"), getHealth)).rejects.toThrow(DaemonUnreachable);
    expect(await answers(join(dir, "bazhen.sock"))).toBe(false);
  });

  it("refuses a reply that isn't what the command expects", async () => {
    const { socket } = await daemon(JSON.stringify({ status: "ok" }));
    await expect(call(socket, getHealth)).rejects.toThrow(DaemonError);
  });

  it("says a success it can't read is from another build, and a refusal is not", async () => {
    const ok = await daemon(JSON.stringify({ status: "ok" }));
    const succeeded = await call(ok.socket, getHealth).catch((err: unknown) => String(err));
    server?.close();
    rmSync(dir, { recursive: true, force: true });
    const refused = await daemon(JSON.stringify({ error: "not_found" }), 404);
    const failed = await call(refused.socket, getHealth).catch((err: unknown) => String(err));
    expect([succeeded, failed]).toEqual([
      expect.stringContaining(ANOTHER_BUILD),
      expect.not.stringContaining(ANOTHER_BUILD),
    ]);
  });

  it("finds a daemon of another build answering, so stop can stop it", async () => {
    const { socket } = await daemon(JSON.stringify({ status: "ok", protocolVersion: "1.53" }));
    expect(await answers(socket)).toBe(true);
  });

  it("reads the protocol a daemon speaks, and none from one before protocol ids", async () => {
    const current = await daemon(JSON.stringify(health));
    const spoken = await spokenProtocol(current.socket);
    server?.close();
    rmSync(dir, { recursive: true, force: true });
    const older = await daemon(JSON.stringify({ status: "ok", protocolVersion: "1.53" }));
    expect([spoken, await spokenProtocol(older.socket)]).toEqual([health.protocolId, null]);
  });

  it("says when its caller is an agent", async () => {
    const { socket, seen } = await daemon(JSON.stringify(health));
    await call(socket, getHealth);
    process.env["BAZHEN_AGENT_ID"] = "agent_x";
    await call(socket, getHealth);
    expect(seen.map((h) => h["bazhen-agent-id"])).toEqual([undefined, "agent_x"]);
  });

  it("sends the agent token its file holds, and none for a file that holds no token", async () => {
    const { socket, seen } = await daemon(JSON.stringify(health));
    const token = "t".repeat(43);
    const file = join(dir, "agent.token");
    process.env["BAZHEN_AGENT_AUTH_FILE"] = file;
    writeFileSync(file, token);
    await call(socket, getHealth);
    writeFileSync(file, "not a token\r\nx-forged: 1");
    await call(socket, getHealth);
    rmSync(file);
    await call(socket, getHealth);
    expect(seen.map((h) => h["bazhen-agent-token"])).toEqual([token, undefined, undefined]);
  });
});
