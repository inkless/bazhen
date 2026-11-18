import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import {
  CLAUDE_SESSION,
  claudeAgent,
  PANE_PID,
  testView,
  untokenedCredentials,
} from "../testing/fixtures.ts";
import { AgentTokens } from "../auth/callers.ts";
import type { PeerReading } from "../auth/peer.ts";
import { ActivityTracker } from "./activity.ts";
import { Approvals } from "./approvals.ts";
import { SessionBinding } from "./binding.ts";
import { HOOK_SCRIPT, hookClient } from "./hook-command.ts";
import type { SentMessage } from "@bazhen/harness-claude-code";
import { hookApp, type IngressDeps } from "./ingress.ts";
import { Mailbox } from "./mailbox.ts";
import { Inbox } from "../attention/inbox.ts";
import { localEnvironmentId } from "../agents/launch.ts";
import { Readiness } from "../agents/readiness.ts";

let server: Server | undefined;
let dir = "";
afterEach(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The daemon's real hook ingress, served on a Unix socket as main.ts serves it. A `tokened`
 * agent is given a token, in `tokenFile`; otherwise it is one started before agents had tokens.
 */
async function daemon(
  tokened = false,
  peer?: IngressDeps["peer"],
  starting = false,
  outsidePane = false,
) {
  const { store, agentId } = await claudeAgent({ starting });
  dir = mkdtempSync("/tmp/bz-ingress-");
  const tokens = new AgentTokens(store, join(dir, "agents"), process.getuid?.() ?? 0);
  const tokenFile = tokened ? tokens.mint(agentId).file : "";
  const observed: { id: string; toolUseId: string; sent: SentMessage }[] = [];
  const logged: string[] = [];
  const mailbox = new Mailbox(store);
  const approvals = new Approvals(store);
  const inbox = new Inbox(store, approvals, (id, req) => mailbox.send(id, req));
  const readiness = new Readiness({
    store,
    environmentId: localEnvironmentId(store),
    deadlineMs: 60_000,
    notStarted: (id, summary) => inbox.notStarted(id, summary),
  });
  // Every hook here runs through a shell of the pane's process, unless `outsidePane`, when the
  // hook client's parent, this test, is a TUI of its own outside the agent's terminal.
  const binding = new SessionBinding(store, {
    parent: async (pid) =>
      outsidePane && pid === process.pid
        ? { ppid: 1, command: "claude" }
        : { ppid: PANE_PID, command: "sh" },
  });
  const app = hookApp({
    mailbox,
    approvals,
    turns: {
      started: (id) => inbox.turnStarted(id),
      failed: (id, error) => inbox.turnFailed(id, error),
    },
    knows: (id) => id === agentId,
    ready: (id) => readiness.ready(id, "claude_hook"),
    credentials: tokened ? tokens : untokenedCredentials,
    ...(peer && { peer }),
    binding,
    activity: new ActivityTracker((id, activity) => store.recordActivity(id, activity)),
    recordUsage: (id, usage) => store.recordUsage(id, usage),
    compacted: (id, hook) => store.recordCompaction(id, "claude_hook", hook),
    observeSend: (id, toolUseId, sent) => observed.push({ id, toolUseId, sent }),
    log: (line) => logged.push(line),
    now: () => new Date("2026-11-17T00:00:00.000Z"),
  });
  const listener = getRequestListener(app.fetch);
  const socket = join(dir, "bazhen.sock");
  server = createServer((req, res) => void listener(req, res));
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  const state = (id: string) => store.snapshot(testView).messages.find((m) => m.id === id)?.state;
  const activity = () => store.latestActivity(agentId);
  /** Whether the agent's latest activity is a native idle recorded after its last mail settled. */
  const idleAfterMail = () => {
    const turn = store.turnAfterMail(agentId);
    return (
      turn.activity?.source === "native" &&
      turn.activity.value === "idle" &&
      turn.inFlight === 0 &&
      (turn.activityAt ?? 0) > (turn.lastSettled ?? 0)
    );
  };
  const usage = () => store.snapshot(testView).agents[0]?.usage;
  const lifecycle = () => store.snapshot(testView).agents[0]?.state;
  const compactions = () =>
    store
      .events(0)
      .filter((e) => e.type === "agent.compacted")
      .map((e) => e.payload);
  const failures = () =>
    store
      .snapshot(testView)
      .attention.filter((a) => a.kind === "failed")
      .map((a) => `${a.state}:${a.summary}`);
  return {
    socket,
    agentId,
    mailbox,
    state,
    activity,
    idleAfterMail,
    usage,
    failures,
    lifecycle,
    compactions,
    observed,
    logged,
    tokens,
    tokenFile,
  };
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
/** The agent's SendMessage to BZ-127, as a PostToolUse from `session` reports it. */
const sendMessage = (session: string) =>
  JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: session,
    prompt_id: "p-1",
    tool_use_id: "t-1",
    tool_name: "SendMessage",
    tool_input: { to: "BZ-127", message: "Rebased." },
    tool_response: { success: true },
  });
/** A SessionStart's payload for a compaction of the agent's session, or of a subagent's. */
const compact = (more: Record<string, string> = {}) =>
  JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: CLAUDE_SESSION,
    source: "compact",
    ...more,
  });
/** A SessionStart's payload, as /clear starts a new session. */
const sessionStart = (session: string) =>
  JSON.stringify({ hook_event_name: "SessionStart", session_id: session, source: "clear" });

const PATH = process.env["PATH"] ?? "";

/** A peer that reads each of `readings` in turn, taking it off, then every caller as outside. */
const inTurn =
  (readings: PeerReading[]): NonNullable<IngressDeps["peer"]> =>
  async () =>
    readings.shift() ?? { kind: "outside" };

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

  it("asks again when the daemon couldn't read the waiter in time, and takes its mail", async () => {
    const readings: PeerReading[] = [{ kind: "late" }];
    const { socket, agentId, mailbox, state } = await daemon(false, inTurn(readings));
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const result = await run(client, "wait", { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket });
    expect([result.code, readings]).toEqual([2, []]);
    await expect.poll(() => state(messageId)).toBe("emitted");
  });

  it("decides nothing on a permission request it couldn't read in time, as when no daemon answers", async () => {
    const { socket, agentId } = await daemon(false, async () => ({ kind: "late" }));
    const permission = JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: CLAUDE_SESSION,
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    const ask = (at: string) =>
      run(client, "PermissionRequest", { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: at }, permission);
    const [late, unanswered] = [await ask(socket), await ask(join(dir, "nobody.sock"))];
    expect([late, unanswered]).toEqual([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ]);
  });

  it("takes mail for an agent whose hook proves it with its token file", async () => {
    const { socket, agentId, mailbox, state, tokenFile } = await daemon(true);
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const own = await run(client, "wait", { ...env, BAZHEN_AGENT_AUTH_FILE: tokenFile });
    expect(own.code).toBe(2);
    await expect.poll(() => state(messageId)).toBe("emitted");
  });

  it("gives an agent's mail to no hook with its token from another agent's process", async () => {
    const elsewhere = newId("agent");
    const { socket, agentId, mailbox, state, tokenFile } = await daemon(true, async () => ({
      kind: "agent",
      agentId: elsewhere,
    }));
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const borrowed = await run(client, "wait", { ...env, BAZHEN_AGENT_AUTH_FILE: tokenFile });
    expect([borrowed.code, borrowed.stderr, state(messageId)]).toEqual([0, "", "queued"]);
  });

  it("gives an agent's mail to no hook that names it without its live token", async () => {
    const { socket, agentId, mailbox, state, tokens, tokenFile } = await daemon(true);
    const stale = join(dir, "stale.token");
    copyFileSync(tokenFile, stale);
    tokens.mint(agentId).kept();
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const untokened = await run(client, "wait", env);
    expect([untokened.code, untokened.stderr, state(messageId)]).toEqual([0, "", "queued"]);
    const revoked = await run(client, "wait", { ...env, BAZHEN_AGENT_AUTH_FILE: stale });
    expect([revoked.code, revoked.stderr, state(messageId)]).toEqual([0, "", "queued"]);
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

  it("settles mail folded into a turn before the idle the turn's Stop reports", async () => {
    const { socket, agentId, mailbox, state, idleAfterMail } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    await run(client, "PostToolUse", env, postToolUse());
    await expect.poll(() => state(messageId)).toBe("emitted");
    await run(client, "Stop", env, stop());
    expect([state(messageId), idleAfterMail()]).toEqual(["delivered", true]);
  });

  it("settles folded mail before the idle, when the waiter beside the Stop ends the turn", async () => {
    const { socket, agentId, mailbox, state, idleAfterMail } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    await run(client, "PostToolUse", env, postToolUse());
    await expect.poll(() => state(messageId)).toBe("emitted");
    const beside = run(client, "wait", env, stop());
    await expect.poll(() => state(messageId)).toBe("delivered");
    await expect.poll(idleAfterMail).toBe(true);
    mailbox.send(agentId, { idempotencyKey: "m2", body: "release the waiter" });
    await beside;
  });

  it("records the agent's own SendMessage while folding mail, and none another session sent", async () => {
    const { socket, agentId, mailbox, observed } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    await run(client, "PostToolUse", env, sendMessage("22222222-2222-4222-8222-222222222222"));
    const folded = await run(client, "PostToolUse", env, sendMessage(CLAUDE_SESSION));
    expect([folded.stdout.includes(messageId), observed]).toEqual([
      true,
      [
        {
          id: agentId,
          toolUseId: "t-1",
          sent: { to: "BZ-127", text: "Rebased.", summary: null, accepted: true },
        },
      ],
    ]);
  });

  it("never folds mail into a subagent's tool call", async () => {
    const { socket, agentId, mailbox, state } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const sub = await run(client, "PostToolUse", env, postToolUse({ agent_id: "sub-1" }));
    expect([sub.code, sub.stdout, state(messageId)]).toEqual([0, "", "queued"]);
  });

  it("runs a starting agent on a hook of its own session, and on none of another's", async () => {
    const { socket, agentId, lifecycle } = await daemon(false, undefined, true);
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    await run(client, "Stop", env, stop("66666666-6666-4666-8666-666666666666"));
    const another = lifecycle();
    await run(client, "Stop", env, stop());
    expect([another, lifecycle()]).toEqual(["starting", "running"]);
  });

  it("doesn't run a starting agent on a hook of its session from outside its terminal", async () => {
    const { socket, agentId, lifecycle } = await daemon(false, undefined, true, true);
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    await run(client, "Stop", env, stop());
    expect(lifecycle()).toBe("starting");
  });

  it("records what the agent's own session says it is doing, and nothing another says", async () => {
    const { socket, agentId, activity } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const at = (event: string, more: Record<string, string> = {}) =>
      run(
        client,
        event,
        env,
        JSON.stringify({
          hook_event_name: event,
          session_id: CLAUDE_SESSION,
          prompt_id: "p-1",
          tool_use_id: "t-1",
          ...more,
        }),
      );
    await at("PreToolUse", { agent_id: "sub-1" });
    expect(activity()).toMatchObject({ value: "working", source: "native" });
    await at("SubagentStop", { agent_id: "sub-1" });
    await at("Stop");
    expect(activity()?.value).toBe("idle");
    await at("PreToolUse", { session_id: "66666666-6666-4666-8666-666666666666" });
    expect(activity()?.value).toBe("idle");
    await at("StopFailure", { prompt_id: "p-2", error: "server_error" });
    expect(activity()).toMatchObject({ value: "failed", detail: "server_error" });
  });

  it("puts the agent's own failed turn in the inbox while a subagent works on, until its next turn", async () => {
    const { socket, agentId, failures } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const at = (event: string, more: Record<string, string> = {}) =>
      run(
        client,
        event,
        env,
        JSON.stringify({
          hook_event_name: event,
          session_id: CLAUDE_SESSION,
          prompt_id: "p-1",
          ...more,
        }),
      );
    await at("SubagentStart", { agent_id: "sub-1" });
    await at("StopFailure", { error: "server_error" });
    await at("PostToolUse", { agent_id: "sub-1", tool_use_id: "t-9" });
    await at("UserPromptSubmit", { agent_id: "sub-1", prompt: "sub work" });
    const during = failures();
    await at("UserPromptSubmit", { prompt_id: "p-2", prompt: "try again" });
    expect([during, failures()]).toEqual([["open:server_error"], ["closed:server_error"]]);
  });

  it("reads a session /clear starts as idle, once the binding has moved to it", async () => {
    const { socket, agentId, mailbox, activity } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    await run(client, "PreToolUse", env, postToolUse({ hook_event_name: "PreToolUse" }));
    expect(activity()?.value).toBe("working");
    const fresh = "77777777-7777-4777-8777-777777777777";
    const waiting = run(client, "wait", env, sessionStart(fresh));
    await expect.poll(() => activity()?.value).toBe("idle");
    mailbox.send(agentId, { idempotencyKey: "m", body: "release the waiter" });
    await waiting;
  });

  it("records a compaction of the agent's own session, with its use before, and none of a subagent's", async () => {
    const { socket, agentId, mailbox, compactions } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const window = { used_percentage: 91, context_window_size: 200_000 };
    await run(
      client,
      "statusline",
      env,
      JSON.stringify({ session_id: CLAUDE_SESSION, context_window: window }),
    );
    await run(client, "wait", env, compact({ agent_id: "subagent-1" }));
    const waiting = run(client, "wait", env, compact());
    await expect.poll(() => compactions().length).toBe(1);
    mailbox.send(agentId, { idempotencyKey: "m", body: "release the waiter" });
    await waiting;
    expect(compactions()).toEqual([
      {
        sign: "claude_hook",
        before: { contextUsedPercent: 91, contextWindowTokens: 200_000 },
        hook: { sessionId: CLAUDE_SESSION, pid: expect.any(Number) },
      },
    ]);
  });

  it("records a compaction once, however often its hook's client sends the report", async () => {
    const { socket, agentId, mailbox, compactions } = await daemon();
    const report = (pid: number) => ({
      protocolVersion: "1.0",
      agentId,
      event: "wait",
      pid,
      ppid: process.pid,
      payload: JSON.parse(compact()),
    });
    // The client sends the same report again once the daemon drops it, as across a restart.
    const dropped = new AbortController();
    const first = post(socket, "/v1/hooks", report(4242), {}, dropped.signal).catch(
      () => "dropped",
    );
    await expect.poll(() => compactions().length).toBe(1);
    dropped.abort();
    await expect(first).resolves.toBe("dropped");
    const again = post(socket, "/v1/hooks", report(4242));
    mailbox.send(agentId, { idempotencyKey: "m1", body: "release the waiter" });
    await again;
    // The next compaction runs a new hook process.
    const next = post(socket, "/v1/hooks", report(4243));
    mailbox.send(agentId, { idempotencyKey: "m2", body: "release the waiter" });
    await next;
    expect(compactions()).toEqual([
      { sign: "claude_hook", hook: { sessionId: CLAUDE_SESSION, pid: 4242 } },
      { sign: "claude_hook", hook: { sessionId: CLAUDE_SESSION, pid: 4243 } },
    ]);
  });

  it("records the model and context use the agent's own status line reports", async () => {
    const { socket, agentId, usage } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const line = (session: string, model: string) =>
      run(
        client,
        "statusline",
        env,
        JSON.stringify({ session_id: session, model: { display_name: model } }),
      );
    await line("88888888-8888-4888-8888-888888888888", "Not this one");
    expect(usage()).toBeUndefined();
    await line(CLAUDE_SESSION, "Opus 5.5");
    expect(usage()).toEqual({ model: "Opus 5.5" });
  });
});

/**
 * One POST to the ingress on `socket`, with `headers`; its status, once the reply has ended, or a
 * rejection if `signal` drops it first.
 */
function post(
  socket: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method: "POST",
        path,
        headers: { "content-type": "application/json", ...headers },
        ...(signal && { signal }),
      },
      (res) => res.resume().on("end", () => resolve(res.statusCode ?? 0)),
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("hook ingress, on an ack", () => {
  it("confirms an agent's mail only on an ack with its token", async () => {
    const { socket, agentId, mailbox, state, tokenFile } = await daemon(true);
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const { offered } = await mailbox.wait(agentId, new AbortController().signal);
    await post(socket, "/v1/hooks/ack", { agentId, offered });
    expect(state(messageId)).toBe("offered");
    const token = readFileSync(tokenFile, "utf8");
    await post(socket, "/v1/hooks/ack", { agentId, offered }, { "bazhen-agent-token": token });
    expect(state(messageId)).toBe("emitted");
  });
});

describe("hook ingress, on a caller it can't read in time", () => {
  it("tells an ack to try again, and leaves its mail offered", async () => {
    const { socket, agentId, mailbox, state, tokenFile } = await daemon(true, async () => ({
      kind: "late",
    }));
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    const { offered } = await mailbox.wait(agentId, new AbortController().signal);
    const token = readFileSync(tokenFile, "utf8");
    const status = await post(
      socket,
      "/v1/hooks/ack",
      { agentId, offered },
      { "bazhen-agent-token": token },
    );
    expect([status, state(messageId)]).toEqual([503, "offered"]);
  });

  it("tells a hook to try again, and says so", async () => {
    const { socket, agentId, logged } = await daemon(false, async () => ({ kind: "late" }));
    const status = await post(socket, "/v1/hooks", {
      payload: JSON.parse(stop()),
      protocolVersion: "1.0",
      agentId,
      event: "Stop",
      pid: process.pid,
      ppid: process.ppid,
    });
    expect([status, logged]).toEqual([
      503,
      [
        `bazhen: 2026-11-17T00:00:00.000Z dropped the "Stop" hook for agent ${agentId}: ` +
          "the caller's process wasn't read in time; try again",
      ],
    ]);
  });

  it("gives up, as the script waiter, after five readings in a row that come late, waiting longer before each", async () => {
    let readings = 0;
    const { socket, agentId } = await daemon(false, async () => {
      readings += 1;
      return { kind: "late" };
    });
    const stubs = join(dir, "bin");
    const slept = join(dir, "slept");
    mkdirSync(stubs);
    writeFileSync(
      join(stubs, "sleep"),
      `#!/bin/sh
printf '%s ' "$1" >>"${slept}"
`,
    );
    chmodSync(join(stubs, "sleep"), 0o700);
    const result = await run(HOOK_SCRIPT, "wait", {
      BAZHEN_AGENT_ID: agentId,
      BAZHEN_SOCKET: socket,
      PATH: `${stubs}:${PATH}`,
    });
    expect([result.code, readings, readFileSync(slept, "utf8")]).toEqual([0, 6, "1 2 4 8 16 "]);
  });
});

describe("hook ingress, on a hook it drops", () => {
  const client = hookClient();
  const at = "bazhen: 2026-11-17T00:00:00.000Z dropped";

  it("says why it refused a waiter that carries another agent's token", async () => {
    const elsewhere = newId("agent");
    const { socket, agentId, logged, tokenFile } = await daemon(true, async () => ({
      kind: "agent",
      agentId: elsewhere,
    }));
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    await run(client, "wait", { ...env, BAZHEN_AGENT_AUTH_FILE: tokenFile });
    expect(logged).toEqual([
      `${at} the "wait" hook for agent ${agentId}: refused, the agent token is not agent ` +
        `${elsewhere}'s, whose process calls`,
    ]);
  });

  it("says it runs no such agent for each of a stranger's hooks but its status line", async () => {
    const { socket, agentId, mailbox, logged } = await daemon();
    const stranger = newId("agent");
    const env = { BAZHEN_AGENT_ID: stranger, BAZHEN_SOCKET: socket };
    await run(client, "wait", env);
    await run(client, "PostToolUse", env, postToolUse());
    await run(client, "statusline", env);
    // The agent's own waiter, which takes its mail, is no drop.
    mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    expect((await run(client, "wait", { ...env, BAZHEN_AGENT_ID: agentId })).code).toBe(2);
    expect(logged).toEqual([
      `${at} the "wait" hook for agent ${stranger}: the daemon runs no such agent`,
      `${at} the "PostToolUse" hook for agent ${stranger}: the daemon runs no such agent`,
    ]);
  });

  it("names the session of a waiter that isn't the agent's own, or says it is a subagent's", async () => {
    const { socket, agentId, logged } = await daemon();
    const env = { BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: socket };
    const other = "33333333-3333-4333-8333-333333333333";
    await run(client, "wait", env, stop(other));
    const subagent = JSON.stringify({ ...JSON.parse(stop()), agent_id: "sub-1" });
    await run(client, "wait", env, subagent);
    expect(logged).toEqual([
      `${at} the "wait" hook for agent ${agentId}: session "${other}" isn't the agent's`,
      `${at} the "wait" hook for agent ${agentId}: it ran in a subagent`,
    ]);
  });

  it("says why it can't take a request, and keeps what the client sent short", async () => {
    const { socket, agentId, logged } = await daemon();
    const hook = { protocolVersion: "1.0", agentId, event: "wait", pid: 1, ppid: 1, payload: null };
    await post(socket, "/v1/hooks", { nonsense: true });
    await post(socket, "/v1/hooks", { ...hook, protocolVersion: "9.0" });
    await post(socket, "/v1/hooks", { ...hook, agentId: newId("agent"), event: "x".repeat(500) });
    expect(logged).toEqual([
      `${at} a hook request it can't read: protocolVersion, agentId, event, pid, ppid, payload`,
      `${at} the "wait" hook for agent ${agentId}: its protocol 9.0 isn't 1.0's`,
      expect.stringContaining(`the "${"x".repeat(80)}…" hook for agent`),
    ]);
    expect(logged[2]?.length).toBeLessThan(250);
  });
});
