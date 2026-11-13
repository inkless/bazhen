import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { withAgent, testView } from "../testing/fixtures.ts";
import { Approvals } from "./approvals.ts";
import { HOOK_SCRIPT, hookClient } from "./hook-command.ts";
import { hookApp } from "./ingress.ts";
import { Mailbox } from "./mailbox.ts";

let server: Server | undefined;
let dir = "";
afterEach(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The daemon's real hook ingress, served on a Unix socket as main.ts serves it. */
async function daemon() {
  const { store, agentId } = await withAgent();
  const mailbox = new Mailbox(store);
  const app = hookApp({ mailbox, approvals: new Approvals(store), knows: (id) => id === agentId });
  const listener = getRequestListener(app.fetch);
  dir = mkdtempSync("/tmp/bz-ingress-");
  const socket = join(dir, "bazhen.sock");
  server = createServer((req, res) => void listener(req, res));
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  const state = (id: string) => store.snapshot(testView).messages.find((m) => m.id === id)?.state;
  return { socket, agentId, mailbox, state };
}

function run(client: string, event: string, env: Record<string, string>) {
  const child = spawn(client, [event], { env: { PATH: process.env["PATH"] ?? "", ...env } });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdin.end("{}");
  return new Promise<{ code: number | null; stderr: string }>((resolve) =>
    child.on("exit", (code) => resolve({ code, stderr })),
  );
}

describe.each([
  ["binary", hookClient()],
  ["script", HOOK_SCRIPT],
])("hook ingress with the real client (%s)", (_kind, client) => {
  it("wakes the waiter with mail, and the client's ack marks it emitted", async () => {
    const { socket, agentId, mailbox, state } = await daemon();
    const waiting = run(client, "wait", { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket });
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello ü" });
    const result = await waiting;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`(${messageId}):\nhello ü`);
    await expect.poll(() => state(messageId)).toBe("emitted");
  });
});
