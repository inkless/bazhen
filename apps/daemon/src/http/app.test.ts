import { describe, expect, it } from "vitest";
import {
  AgentTerminalExists,
  newId,
  NotResumable,
  TaskRefused,
  UnsupportedHarness,
  type Caller,
} from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { PROTOCOL_VERSION, type LaunchAgentRequest } from "@bazhen/protocol";
import { EnvironmentUnavailable, ServerUnconfirmed, StaleGeneration } from "../agents/lifecycle.ts";
import { AttentionClosed } from "../mailbox/approvals.ts";
import { ShellBusy, UnknownShell } from "../shells/lifecycle.ts";
import { AttentionRefused } from "../attention/inbox.ts";
import { createApp, type AppDeps, type TaskCommands } from "./app.ts";

const runtime = new FakeRuntime();

const launched = { agentId: newId("agent"), terminalId: newId("term"), eventIds: [2, 3] };
const callers: Caller[] = [];
const tasks: TaskCommands = {
  create: (caller, req) => {
    callers.push(caller);
    if (req.title === "forbidden") throw new TaskRefused("forbidden", "a worker can't");
    if (req.title === "conflict") throw new TaskRefused("conflict", "the task is done");
    return { taskId: newId("task"), assignmentId: null, eventIds: [5] };
  },
  show: () => undefined,
  assign: () => ({ assignmentId: newId("asgn"), eventIds: [6] }),
  unassign: () => ({ eventIds: [7] }),
  finish: () => ({ eventIds: [8] }),
  delegate: async () => ({ taskId: newId("task"), assignmentId: newId("asgn"), eventIds: [9] }),
  escalate: () => ({ attentionId: newId("attn") }),
};
const deps: AppDeps = {
  appVersion: "0.1.0",
  schemaVersion: () => 1,
  runtime,
  allow: { hosts: ["127.0.0.1:7900"], origins: ["http://127.0.0.1:7900"] },
  state: () => ({
    epoch: "e1",
    eventId: 3,
    environments: [],
    agents: [],
    tasks: [],
    assignments: [],
    attention: [],
    messages: [],
    shells: [],
  }),
  send: () => ({ messageId: newId("msg"), eventIds: [4] }),
  answer: () => {
    throw new AttentionClosed("attn_x");
  },
  reply: () => {
    throw new AttentionRefused("attn_x", "reply");
  },
  dismiss: () => {
    throw new AttentionClosed("attn_x");
  },
  resend: () => {
    throw new AttentionRefused("attn_x", "resend");
  },
  close: async (agentId, req) => {
    if (req.generation === 3) throw new ServerUnconfirmed(agentId, new Error("no server running"));
    if (req.generation !== 2) throw new StaleGeneration(agentId, 2);
    throw new EnvironmentUnavailable(agentId, new Error("tmux unreachable"));
  },
  respawn: async () => {
    throw new NotResumable(newId("agent"));
  },
  relaunch: async (agentId, req) => {
    if (req.fresh === true) return { agentId, eventIds: [9] };
    throw new AgentTerminalExists(newId("agent"));
  },
  signal: () => Promise.reject(new Error("not used by these tests")),
  openShell: async () => ({ terminalId: launched.terminalId, eventIds: [5, 6] }),
  restartShell: () => Promise.reject(new Error("not used by these tests")),
  renameShell: () => Promise.reject(new Error("not used by these tests")),
  unlinkShell: () => Promise.reject(new Error("not used by these tests")),
  closeShell: async (terminalId, req) => {
    if (req.confirmBusy === true) throw new UnknownShell(terminalId);
    throw new ShellBusy(`shell ${terminalId}`, [{ terminalId, program: "nvim" }]);
  },
  launch: async (req: LaunchAgentRequest) => {
    if (req.harness === "codex") throw new UnsupportedHarness("codex");
    return launched;
  },
  tasks,
};
const app = createApp(deps);
const socket = createApp({ ...deps, allow: null });

const host = "127.0.0.1:7900";

const act = (action: string, body: object) =>
  app.request(`/v1/attention/attn_x/${action}`, {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "a", ...body }),
  });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/v1/agents", {
    method: "POST",
    headers: { host, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const launch = { idempotencyKey: "k-1", harness: "claude-code", cwd: "/work" };
const relaunch = (body: unknown) =>
  app.request("/v1/agents/agent_x/relaunch", {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const close = (generation: number) =>
  app.request("/v1/agents/agent_x/close", {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "c", generation }),
  });

const closeShell = (confirmBusy: boolean) =>
  app.request(`/v1/shells/${launched.terminalId}/close`, {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "sc", generation: 0, confirmBusy }),
  });

describe("HTTP app", () => {
  it("reports runtime health and versions", async () => {
    const res = await app.request("/v1/health", { headers: { host } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: 1,
      runtime: { state: "not-running", version: "fake" },
    });
  });

  it("refuses a request whose Host header is not on the allowlist", async () => {
    const res = await app.request("/v1/health", { headers: { host: "evil.example:7900" } });
    expect(res.status).toBe(421);
  });

  it("serves the state snapshot with the event it is consistent with", async () => {
    const res = await app.request("/v1/state", { headers: { host } });
    expect(await res.json()).toEqual({
      epoch: "e1",
      eventId: 3,
      environments: [],
      agents: [],
      attention: [],
      messages: [],
      shells: [],
      tasks: [],
      assignments: [],
    });
  });

  it("launches an agent and answers with the events it produced", async () => {
    const res = await post(launch, { origin: "http://127.0.0.1:7900" });
    expect([res.status, await res.json()]).toEqual([200, launched]);
  });

  it("refuses a launch from a page on another origin", async () => {
    const res = await post(launch, { origin: "https://evil.example" });
    expect([res.status, await res.json()]).toEqual([
      403,
      { error: "origin_not_allowed", message: "https://evil.example" },
    ]);
  });

  it("refuses a socket upgrade from another origin, though it is a GET", async () => {
    const res = await app.request("/v1/state", {
      headers: { host, origin: "https://evil.example", upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  it("lets a local process without an Origin launch", async () => {
    expect((await post(launch)).status).toBe(200);
  });

  it("refuses a malformed launch and a harness the environment can't run", async () => {
    const bad = await post({ ...launch, cwd: "" });
    const unsupported = await post({ ...launch, harness: "codex" });
    expect([bad.status, unsupported.status]).toEqual([400, 422]);
  });

  it("answers a late answer to an attention item with a conflict, not a success", async () => {
    const res = await app.request("/v1/attention/attn_x/answer", {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "a", decision: "allow" }),
    });
    expect(res.status).toBe(409);
  });

  it("answers a reply or dismissal the item can't take with a conflict", async () => {
    const statuses = [
      (await act("reply", { body: "ok" })).status,
      (await act("resend", {})).status,
      (await act("dismiss", {})).status,
    ];
    expect(statuses).toEqual([409, 409, 409]);
  });

  it("tells a stale generation from an environment that can't be reached, on close", async () => {
    const [stale, unavailable] = await Promise.all([close(1), close(2)]);
    expect([stale.status, (await stale.json()).error]).toEqual([409, "stale_generation"]);
    expect([unavailable.status, (await unavailable.json()).error]).toEqual([503, "unavailable"]);
  });

  it("says a close found its terminal's old server may still run it, so a forced close can follow", async () => {
    const res = await close(3);
    expect([res.status, (await res.json()).error]).toEqual([409, "server_unconfirmed"]);
  });

  it("answers a respawn of an agent with no session to resume as not resumable", async () => {
    const res = await app.request("/v1/agents/agent_x/respawn", {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "r", generation: 0 }),
    });
    expect([res.status, (await res.json()).error]).toEqual([409, "not_resumable"]);
  });

  it("opens a shell and answers with the events it produced", async () => {
    const res = await app.request("/v1/shells", {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "s", cwd: "/work" }),
    });
    expect([res.status, await res.json()]).toEqual([
      200,
      { terminalId: launched.terminalId, eventIds: [5, 6] },
    ]);
  });

  it("answers a close of a shell running a program as busy, naming the shell and program", async () => {
    const res = await closeShell(false);
    const body = await res.json();
    expect([res.status, body.error, body.busy]).toEqual([
      409,
      "busy",
      [{ terminalId: launched.terminalId, program: "nvim" }],
    ]);
  });

  it("answers a command on a shell it doesn't know as not found", async () => {
    const res = await closeShell(true);
    expect([res.status, (await res.json()).error]).toEqual([404, "not_found"]);
  });

  it("relaunches as the body asks, and answers one the runtime still carries as a conflict", async () => {
    const fresh = await relaunch({ idempotencyKey: "f", generation: 0, fresh: true });
    const carried = await relaunch({ idempotencyKey: "c", generation: 0, theme: "light" });
    expect([
      [fresh.status, (await fresh.json()).eventIds],
      [carried.status, (await carried.json()).error],
    ]).toEqual([
      [200, [9]],
      [409, "conflict"],
    ]);
  });
});

const agentId = newId("agent");
const createTask = (on: typeof app, title: string, headers: Record<string, string> = {}) =>
  on.request("/v1/tasks", {
    method: "POST",
    headers: { host, "content-type": "application/json", ...headers },
    body: JSON.stringify({ idempotencyKey: `t-${title}`, title, brief: "b" }),
  });

describe("HTTP task routes", () => {
  it("takes a socket caller that names its agent as that agent", async () => {
    const res = await createTask(socket, "mine", { "bazhen-agent-id": agentId });
    expect([res.status, callers.at(-1)]).toEqual([200, agentId]);
  });

  it("treats a browser's request as the human's, whatever agent it names", async () => {
    const res = await createTask(app, "page", { "bazhen-agent-id": agentId });
    expect([res.status, callers.at(-1)]).toEqual([200, null]);
  });

  it("refuses a socket caller whose agent id is malformed", async () => {
    const res = await createTask(socket, "bad", { "bazhen-agent-id": "%3" });
    expect(res.status).toBe(400);
  });

  it("tells a command the caller may not give from one nobody may give now", async () => {
    const statuses = [
      (await createTask(app, "forbidden")).status,
      (await createTask(app, "conflict")).status,
    ];
    expect(statuses).toEqual([403, 409]);
  });

  it("answers a read of a task it doesn't have with not found", async () => {
    const res = await app.request(`/v1/tasks/${newId("task")}`, { headers: { host } });
    expect([res.status, await res.json()]).toEqual([
      404,
      expect.objectContaining({ error: "not_found" }),
    ]);
  });
});
