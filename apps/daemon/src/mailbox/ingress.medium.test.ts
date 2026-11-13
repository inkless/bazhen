import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SESSION, PANE_PID, claudeAgent, testView } from "../testing/fixtures.ts";
import { Approvals } from "./approvals.ts";
import { SessionBinding } from "./binding.ts";
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
  const { store, agentId } = await claudeAgent();
  const mailbox = new Mailbox(store);
  // Every hook here runs through a shell of the pane's process.
  const binding = new SessionBinding(store, {
    parent: async () => ({ ppid: PANE_PID, command: "sh" }),
  });
  const app = hookApp({
    mailbox,
    approvals: new Approvals(store),
    knows: (id) => id === agentId,
    binding,
  });
  const listener = getRequestListener(app.fetch);
  dir = mkdtempSync("/tmp/bz-ingress-");
  const socket = join(dir, "bazhen.sock");
  server = createServer((req, res) => void listener(req, res));
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  const state = (id: string) => store.snapshot(testView).messages.find((m) => m.id === id)?.state;
  return { socket, agentId, mailbox, state };
}

/** A Stop's payload, from the agent's own session unless another is named. */
const stop = (session = CLAUDE_SESSION, promptId = "p-1") =>
  JSON.stringify({ hook_event_name: "Stop", session_id: session, prompt_id: promptId });
/** A finished tool call's PostToolUse, from the agent itself or one of its subagents. */
const postToolUse = (more: Record<string, string> = {}) =>
  JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: CLAUDE_SESSION,
    prompt_id: "p-1",
    tool_use_id: "t-1",
    ...more,
  });
/** A SessionStart's payload, as /clear starts a new session. */
const sessionStart = (session: string) =>
  JSON.stringify({ hook_event_name: "SessionStart", session_id: session, source: "clear" });

function run(client: string, event: string, env: Record<string, string>, payload = stop()) {
  const child = spawn(client, [event], { env: { PATH: process.env["PATH"] ?? "", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdin.end(payload);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("exit", (code) => resolve({ code, stdout, stderr })),
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

  it("answers another session's waiter at once, and keeps the mail for the agent's own", async () => {
    const { socket, agentId, mailbox, state } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const stale = await run(client, "wait", env, stop("33333333-3333-4333-8333-333333333333"));
    expect(stale.code).toBe(0);
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    expect(state(messageId)).toBe("queued");
    const own = await run(client, "wait", env);
    expect(own.code).toBe(2);
    await expect.poll(() => state(messageId)).toBe("emitted");
  });

  it("hands mail the old session's waiter held to the new session's, once it rebinds", async () => {
    const { socket, agentId, mailbox, state } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const old = run(client, "wait", env);
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    expect((await old).code).toBe(2);
    await expect.poll(() => state(messageId)).toBe("emitted");
    // The old session never shows it to the agent; the new one gets it again, labelled so.
    const fresh = await run(
      client,
      "wait",
      env,
      sessionStart("44444444-4444-4444-8444-444444444444"),
    );
    expect([fresh.code, fresh.stderr]).toEqual([
      2,
      expect.stringContaining(`possible re-delivery of ${messageId}`),
    ]);
  });

  it("ends a turn from the waiter beside its Stop, when the Stop report itself is lost", async () => {
    const { socket, agentId, mailbox, state } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    // The waiter that wakes the agent ran beside an earlier turn's Stop.
    const wake = run(client, "wait", env, stop(CLAUDE_SESSION, "p-0"));
    expect((await wake).code).toBe(2);
    await expect.poll(() => state(messageId)).toBe("emitted");
    mailbox.promptStarted(agentId, `Message for you from Bazhen (${messageId}):`, "p-1");
    // Only the waiter that runs beside p-1's Stop reaches the daemon.
    const beside = run(client, "wait", env, stop());
    await expect.poll(() => state(messageId)).toBe("delivered");
    mailbox.send(agentId, { idempotencyKey: "m2", body: "release the waiter" });
    await beside;
  });

  it("folds mail into the agent's running turn through PostToolUse, and the ack marks it", async () => {
    const { socket, agentId, mailbox, state } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const folded = await run(client, "PostToolUse", env, postToolUse());
    expect([folded.code, JSON.parse(folded.stdout)]).toEqual([
      0,
      {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: expect.stringContaining(`(${messageId}):\nhello`),
        },
      },
    ]);
    await expect.poll(() => state(messageId)).toBe("emitted");
  });

  it("never folds mail into a subagent's tool call", async () => {
    const { socket, agentId, mailbox, state } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const sub = await run(client, "PostToolUse", env, postToolUse({ agent_id: "sub-1" }));
    expect([sub.code, sub.stdout, state(messageId)]).toEqual([0, "", "queued"]);
  });
});
