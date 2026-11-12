import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HealthResponse } from "@bazhen/protocol";
import { DaemonError, DaemonUnreachable, answers, call } from "./client.ts";

let server: Server | undefined;
let dir = "";
afterEach(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env["BAZHEN_AGENT_ID"];
});

const health = {
  status: "ok",
  appVersion: "0.1.0",
  protocolVersion: "1.2",
  schemaVersion: 1,
  runtime: { kind: "tmux", state: "healthy", version: "3.5a" },
};

/** A socket answering every request with `body`; records the headers it was sent. */
async function daemon(body: string) {
  dir = mkdtempSync("/tmp/bz-cli-");
  const socket = join(dir, "bazhen.sock");
  const seen: IncomingHttpHeaders[] = [];
  server = createServer((req, res) => {
    seen.push(req.headers);
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

  it("says when its caller is an agent", async () => {
    const { socket, seen } = await daemon(JSON.stringify(health));
    await call(socket, getHealth);
    process.env["BAZHEN_AGENT_ID"] = "agent_x";
    await call(socket, getHealth);
    expect(seen.map((h) => h["bazhen-agent-id"])).toEqual([undefined, "agent_x"]);
  });
});
