import { describe, expect, it } from "vitest";
import {
  AgentTerminalExists,
  HarnessRefused,
  newId,
  RoutedRuntime,
  TerminalUnservable,
  NotResumable,
  TaskRefused,
  UnsupportedHarness,
  type Caller,
} from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { ErrorResponse, RolesResponse, type LaunchAgentRequest } from "@bazhen/protocol";
import { EnvironmentUnavailable, ServerUnconfirmed, StaleGeneration } from "../agents/lifecycle.ts";
import { HolderUnservable } from "../commands.ts";
import { AttentionClosed } from "../mailbox/approvals.ts";
import { AgentGone } from "../mailbox/mailbox.ts";
import { UnknownMessage } from "../mailbox/wait.ts";
import { ShellBusy, UnknownShell } from "../shells/lifecycle.ts";
import { AttentionRefused } from "../attention/inbox.ts";
import { NoticeClosed, NoticeRefused, type Viewer } from "../attention/notices.ts";
import { TerminalLimit } from "../terminals/budget.ts";
import { NameTaken } from "../agents/names.ts";
import { UnknownAgent } from "../store/store.ts";
import { Hono } from "hono";
import {
  AGENT_OPEN,
  guardCallers,
  HUMANS_ONLY,
  type AgentCredentials,
  type SocketEnv,
} from "../auth/callers.ts";
import { createApp, type AppDeps, type TaskCommands } from "./app.ts";

const runtime = new FakeRuntime();

const launched = { agentId: newId("agent"), terminalId: newId("term"), eventIds: [2, 3] };
const callers: Caller[] = [];
const target = newId("agent");
const unknownMessage = newId("msg");
/** The signal each wait was handed, which the request's going away aborts. */
const waitSignals: AbortSignal[] = [];
/** The agent each task command was handed, as the body named it once resolved. */
const addressed: (string | undefined)[] = [];
/** Who each rename came from, and the agent it was of. */
const renames: [Caller, string][] = [];
const tasks: TaskCommands = {
  create: (caller, req) => {
    callers.push(caller);
    if (req.assign !== undefined) addressed.push(req.assign.agentId);
    if (req.title === "forbidden") throw new TaskRefused("forbidden", "a worker can't");
    if (req.title === "conflict") throw new TaskRefused("conflict", "the task is done");
    return { taskId: newId("task"), assignmentId: null, eventIds: [5] };
  },
  show: () => undefined,
  assign: (_caller, _taskId, req) => {
    addressed.push(req.agentId);
    return { assignmentId: newId("asgn"), eventIds: [6] };
  },
  unassign: () => ({ eventIds: [7] }),
  finish: () => ({ eventIds: [8] }),
  delegate: async (_caller, req) => {
    addressed.push(req.agentId);
    return { taskId: newId("task"), assignmentId: newId("asgn"), eventIds: [9] };
  },
  escalate: () => ({ attentionId: newId("attn") }),
  send: (caller, agentId) => {
    callers.push(caller);
    if (agentId === "agent_gone") throw new AgentGone(agentId, "closed");
    return { messageId: newId("msg"), eventIds: [agentId === target ? 4 : 0] };
  },
  broadcast: (caller) => {
    callers.push(caller);
    return { sent: [], skipped: [], eventIds: [11] };
  },
  note: (caller) => {
    callers.push(caller);
    return { eventIds: [12] };
  },
};
/** The viewer and advisory device each notice dismissal reached the handler with. */
const seenDismissals: [Viewer, string | undefined][] = [];

/** One agent with a token, by it; any other agent was started before agents had them. */
const tokenedAgent = newId("agent");
const AGENT_TOKEN = "t".repeat(43);
const credentials: AgentCredentials = {
  agentOf: (token) => (token === AGENT_TOKEN ? tokenedAgent : undefined),
  untokened: (id) => id !== tokenedAgent,
};

const deps: AppDeps = {
  appVersion: "0.1.0",
  protocolId: "protocol-of-this-build",
  runtime,
  allow: { hosts: ["127.0.0.1:7900"], origins: ["http://127.0.0.1:7900"] },
  roles: () => ({
    roles: [
      {
        key: "worker",
        title: "Worker",
        description: "",
        grants: [],
        singlePerTask: false,
        maxActiveTasks: 1,
        prompt: "Do the work.",
        source: "builtin",
      },
    ],
    problems: [{ file: "/home/u/.config/bazhen/roles/lead.md", problem: "no prompt" }],
  }),
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
    notices: [],
    observed: [],
  }),
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
  dismissNotice: (noticeId, req, viewer, fromDevice) => {
    if (req.idempotencyKey === "refused") throw new NoticeRefused(noticeId, "dismiss");
    if (req.idempotencyKey === "closed") throw new NoticeClosed(noticeId);
    seenDismissals.push([viewer, fromDevice]);
    return { eventIds: [1] };
  },
  close: async (agentId, req) => {
    if (req.generation === 3) throw new ServerUnconfirmed(agentId, new Error("no server running"));
    if (req.generation === 4)
      throw new HolderUnservable(agentId, new TerminalUnservable(newId("term"), ["2.0"], 4243));
    if (req.generation !== 2) throw new StaleGeneration(agentId, 2);
    throw new EnvironmentUnavailable(agentId, new Error("tmux unreachable"));
  },
  respawn: async (_agentId, req) => {
    if (req.generation === 1)
      throw new HarnessRefused('Codex refused thread/resume: api_key = "s3cret" is wrong (-32600)');
    throw new NotResumable(newId("agent"));
  },
  relaunch: async (agentId, req) => {
    if (req.fresh === true) return { agentId, eventIds: [9] };
    throw new AgentTerminalExists(newId("agent"));
  },
  signal: () => Promise.reject(new Error("not used by these tests")),
  rename: (caller, agentId, req) => {
    if (req.name === "taken") throw new NameTaken(req.name);
    renames.push([caller, agentId]);
    return { agentId, eventIds: [10] };
  },
  resolveAgent: (ref) => {
    if (ref === "BZ-127") return target;
    if (ref.startsWith("agent_")) return ref;
    throw new UnknownAgent(ref, "by that name");
  },
  openShell: async () => ({ terminalId: launched.terminalId, eventIds: [5, 6] }),
  restartShell: async (_terminalId, req) => {
    restarts.push(req);
    return { terminalId: launched.terminalId, eventIds: [7] };
  },
  renameShell: () => Promise.reject(new Error("not used by these tests")),
  unlinkShell: () => Promise.reject(new Error("not used by these tests")),
  closeShell: async (terminalId, req) => {
    if (req.confirmBusy === true) throw new UnknownShell(terminalId);
    throw new ShellBusy(`shell ${terminalId}`, [{ terminalId, program: "nvim" }]);
  },
  launch: async (req: LaunchAgentRequest) => {
    if (req.harness === "codex") throw new UnsupportedHarness("codex");
    if (req.cwd === "/full")
      throw new TerminalLimit("4 terminals are open, the most at once", {
        open: 4,
        max: 4,
        host: false,
      });
    return launched;
  },
  tasks,
  waitMessages: async (req, signal) => {
    const [id] = req.messageIds;
    if (id === unknownMessage) throw new UnknownMessage(id);
    waitSignals.push(signal);
    return { messages: [] };
  },
};
const restarts: unknown[] = [];
const app = createApp(deps);
/** The commands as the socket serves them: behind its guard, which says who called. */
const socket = new Hono<SocketEnv>();
guardCallers(socket, credentials);
socket.route("/", createApp({ ...deps, allow: null }));

const host = "127.0.0.1:7900";

const act = (action: string, body: object) =>
  app.request(`/v1/attention/attn_x/${action}`, {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "a", ...body }),
  });
/** What a test calls a route through: the TCP app, or the socket's. */
type Served = { request(path: string, init?: RequestInit): Response | Promise<Response> };

const dismissNotice = (body: unknown, on: Served = app) =>
  on.request("/v1/notices/ntc_x/dismiss", {
    method: "POST",
    headers: { host, "content-type": "application/json", "bazhen-device-id": "dev_x" },
    body: JSON.stringify(body),
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
  it("takes a retype from a client, but never whether to mark the paste, nor a shell's prompt", async () => {
    const asked = { idempotencyKey: "r", generation: 0, retype: true };
    const restarted = await app.request(`/v1/shells/${launched.terminalId}/restart`, {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ ...asked, brackets: true }),
    });
    const prompts = await Promise.all(
      [app, socket].map(async (on) => {
        const res = await on.request(`/v1/shells/${launched.terminalId}/prompt`, {
          method: "POST",
          headers: { host, "content-type": "application/json" },
          body: JSON.stringify({ token: "t", brackets: true }),
        });
        return res.status;
      }),
    );
    expect([restarted.status, restarts, prompts]).toEqual([200, [asked], [404, 404]]);
  });

  it("reports runtime health and versions", async () => {
    const res = await app.request("/v1/health", { headers: { host } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      protocolId: "protocol-of-this-build",
      runtime: { state: "not-running", version: "fake" },
    });
  });

  it("reports each runtime of a routed one by itself, and the worst of them as the runtime", async () => {
    const tmux = new FakeRuntime({ kind: "tmux" });
    const holder = new FakeRuntime({ kind: "holder" });
    const routed = new RoutedRuntime({
      runtimes: [tmux, holder],
      defaultKind: "tmux",
      log: () => {},
    });
    holder.disconnect();
    const res = await createApp({ ...deps, runtime: routed }).request("/v1/health", {
      headers: { host },
    });
    expect(await res.json()).toMatchObject({
      runtime: { kind: "tmux", state: "unreachable", version: "fake" },
      runtimes: [
        { kind: "tmux", state: "not-running", version: "fake" },
        { kind: "holder", state: "unreachable", version: null },
      ],
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
      notices: [],
      observed: [],
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

  it("answers a launch past the terminal budget as terminal_limit, with its reason, on either listener", async () => {
    const asked = {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ ...launch, cwd: "/full" }),
    };
    const answers = await Promise.all(
      [app, socket].map(async (on) => {
        const res = await on.request("/v1/agents", asked);
        return [res.status, await res.json()];
      }),
    );
    const refused = [
      409,
      { error: "terminal_limit", message: "4 terminals are open, the most at once" },
    ];
    expect(answers).toEqual([refused, refused]);
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

  it("takes an unpaired HTTP request for loopback's owner, and the socket's for the socket's, whose shell alone may name a device", async () => {
    seenDismissals.length = 0;
    await dismissNotice({ idempotencyKey: "k" });
    await dismissNotice({ idempotencyKey: "k" }, socket);
    expect(seenDismissals).toEqual([
      ["owner-loopback", undefined],
      ["owner-socket", "dev_x"],
    ]);
  });

  it("answers a notice dismissal that is closed or refused with a conflict, and a bad body with 400", async () => {
    const replies = [
      await dismissNotice({ idempotencyKey: "closed" }),
      await dismissNotice({ idempotencyKey: "refused" }),
      await dismissNotice({}),
    ];
    expect(replies.map((r) => r.status)).toEqual([409, 409, 400]);
  });

  it("tells a stale generation from an environment that can't be reached, on close", async () => {
    const [stale, unavailable] = await Promise.all([close(1), close(2)]);
    expect([stale.status, (await stale.json()).error]).toEqual([409, "stale_generation"]);
    expect([unavailable.status, (await unavailable.json()).error]).toEqual([503, "unavailable"]);
  });

  it("says a close reached a holder it can't speak to, which no forced close passes", async () => {
    const res = await close(4);
    expect([res.status, (await res.json()).error]).toEqual([409, "needs_restart"]);
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

  it("answers a respawn the harness refuses with the harness's own reason, its secrets left out", async () => {
    const res = await app.request("/v1/agents/agent_x/respawn", {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "r", generation: 1 }),
    });
    expect([res.status, await res.json()]).toEqual([
      502,
      {
        error: "launch_failed",
        message: "Codex refused thread/resume: api_key = [redacted] is wrong (-32600)",
      },
    ]);
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

  it("answers mail for an agent that is gone as a conflict", async () => {
    const res = await app.request("/v1/agents/agent_gone/messages", {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "m", body: "hi" }),
    });
    expect([res.status, (await res.json()).error]).toEqual([409, "conflict"]);
  });
});

const agentId = newId("agent");
const createTask = (on: Served, title: string, headers: Record<string, string> = {}) =>
  on.request("/v1/tasks", {
    method: "POST",
    headers: { host, "content-type": "application/json", ...headers },
    body: JSON.stringify({ idempotencyKey: `t-${title}`, title, brief: "b" }),
  });

/** Every command route the socket serves, once each. */
function socketRoutes(): { method: string; path: string }[] {
  const routes = new Map<string, { method: string; path: string }>();
  for (const { method, path } of socket.routes)
    if (method !== "ALL" && path.startsWith("/v1/"))
      routes.set(`${method} ${path}`, { method, path });
  return [...routes.values()];
}
/** Whether `AGENT_OPEN` lists the route, by its method and path. */
const agentOpen = (route: { method: string; path: string }) =>
  AGENT_OPEN.some(([method, path]) => method === route.method && path === route.path);
/** One call on a route, its `:id` filled in, with a body unless it is a GET. */
const call = (route: { method: string; path: string }, headers: Record<string, string>) =>
  socket.request(route.path.replaceAll(":id", "x_1"), {
    method: route.method,
    headers: { "content-type": "application/json", ...headers },
    ...(route.method === "GET" ? {} : { body: "{}" }),
  });

describe("socket callers", () => {
  it("refuses a caller with a token that is no live agent's on every command route", async () => {
    const routes = socketRoutes();
    const bad = { "bazhen-agent-token": "u".repeat(43) };
    const statuses = await Promise.all(routes.map(async (r) => (await call(r, bad)).status));
    expect(routes).toEqual(
      expect.arrayContaining([
        { method: "POST", path: "/v1/agents" },
        { method: "GET", path: "/v1/state" },
      ]),
    );
    expect(statuses).toEqual(routes.map(() => 403));
  });

  it("puts every command route in exactly one of the agents' list and the human's", () => {
    const humans = HUMANS_ONLY.map(([path]) => path);
    const lists = socketRoutes().map((r) => [
      r.path,
      Number(agentOpen(r)) + Number(humans.includes(r.path)),
    ]);
    expect(lists).toEqual(socketRoutes().map((r) => [r.path, 1]));
  });

  it("refuses an agent a route nobody classified, and takes the human's call", async () => {
    const guarded = new Hono<SocketEnv>();
    guardCallers(guarded, credentials);
    guarded.post("/v1/unclassified", (c) => c.json({}));
    const as = (headers: Record<string, string>) =>
      guarded.request("/v1/unclassified", { method: "POST", headers });
    const statuses = [
      (await as({ "bazhen-agent-token": AGENT_TOKEN })).status,
      (await as({})).status,
    ];
    expect(statuses).toEqual([403, 200]);
  });

  it("refuses an agent a method nobody opened on a path open to agents for another", async () => {
    const guarded = new Hono<SocketEnv>();
    guardCallers(guarded, credentials);
    guarded.on(["GET", "POST"], "/v1/tasks", (c) => c.json({}));
    const asAgent = { "bazhen-agent-token": AGENT_TOKEN };
    const statuses = [
      (await guarded.request("/v1/tasks", { method: "POST", headers: asAgent })).status,
      (await guarded.request("/v1/tasks", { method: "GET", headers: asAgent })).status,
    ];
    expect(statuses).toEqual([200, 403]);
  });

  it("refuses an agent with its token every command route outside the agents' list", async () => {
    const routes = socketRoutes().filter((r) => !agentOpen(r));
    const asAgent = { "bazhen-agent-token": AGENT_TOKEN };
    const replies = await Promise.all(
      routes.map(async (r) => {
        const res = await call(r, asAgent);
        const { message } = ErrorResponse.parse(await res.json());
        return [r.path, res.status, message.startsWith("an agent can't")];
      }),
    );
    expect(replies).toEqual(routes.map((r) => [r.path, 403, true]));
  });
});

/** Whom `on` names on `/v1/caller` to a request with `headers`, and the status it answers with. */
const callerOn = async (on: Served, headers: Record<string, string> = {}) => {
  const res = await on.request("/v1/caller", { headers: { host, ...headers } });
  return [res.status, await res.json()];
};

describe("the caller route", () => {
  it("names the agent the socket's guard took the caller for, and the human as null", async () => {
    expect([
      await callerOn(socket, { "bazhen-agent-token": AGENT_TOKEN }),
      await callerOn(socket, { "bazhen-agent-id": agentId }),
      await callerOn(socket),
    ]).toEqual([
      [200, { agentId: tokenedAgent }],
      [200, { agentId }],
      [200, { agentId: null }],
    ]);
  });

  it("names a Codex command's thread's agent, not the agent its server's environment names", async () => {
    const thread = "01a1e0f0-593e-7ae1-9d31-769db26227fc";
    const codexAgent = newId("agent");
    const underServer = new Hono<SocketEnv>();
    guardCallers(
      underServer,
      { ...credentials, codexAgent: (t) => new Map([[thread, codexAgent]]).get(t) },
      async () => ({ kind: "codex", via: "server" }),
    );
    underServer.route("/", createApp({ ...deps, allow: null }));
    const leaked = { "bazhen-agent-token": AGENT_TOKEN, "bazhen-agent-id": tokenedAgent };
    const res = await underServer.request(
      "/v1/caller",
      { headers: { ...leaked, "bazhen-codex-thread": thread } },
      { incoming: { socket: {} } },
    );
    expect([res.status, await res.json()]).toEqual([200, { agentId: codexAgent }]);
  });

  it("names nobody to a browser, whatever agent it names", async () => {
    expect(await callerOn(app, { "bazhen-agent-id": agentId })).toEqual([200, { agentId: null }]);
  });
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

  it("sends a socket caller's message as that agent's, and a browser's as the human's", async () => {
    const send = (on: Served) =>
      on.request(`/v1/agents/${target}/messages`, {
        method: "POST",
        headers: { host, "content-type": "application/json", "bazhen-agent-id": agentId },
        body: JSON.stringify({ idempotencyKey: "m", body: "hi" }),
      });
    const replies = [await send(socket), await send(app)];
    expect(await Promise.all(replies.map(async (r) => (await r.json()).eventIds))).toEqual([
      [4],
      [4],
    ]);
    expect(callers.slice(-2)).toEqual([agentId, null]);
  });

  it("refuses a task title holding a newline or a control character before any command sees it", async () => {
    const before = callers.length;
    const statuses = [
      (await createTask(app, "a\nb")).status,
      (await createTask(app, "a\u0007b")).status,
    ];
    expect([statuses, callers.length - before]).toEqual([[400, 400], 0]);
  });

  it("refuses a socket caller whose agent id is malformed", async () => {
    const res = await createTask(socket, "bad", { "bazhen-agent-id": "%3" });
    expect(res.status).toBe(403);
  });

  it("takes a socket caller with an agent's token as that agent, naming it or not", async () => {
    const token = { "bazhen-agent-token": AGENT_TOKEN };
    const named = { ...token, "bazhen-agent-id": tokenedAgent };
    const statuses = [
      (await createTask(socket, "token", token)).status,
      (await createTask(socket, "token-named", named)).status,
    ];
    expect([statuses, callers.slice(-2)]).toEqual([
      [200, 200],
      [tokenedAgent, tokenedAgent],
    ]);
  });

  it("refuses a socket caller that names an agent with a token and doesn't present it", async () => {
    const before = callers.length;
    const res = await createTask(socket, "untokened", { "bazhen-agent-id": tokenedAgent });
    expect([res.status, (await res.json()).error, callers.length]).toEqual([
      403,
      "forbidden",
      before,
    ]);
  });

  it("refuses a socket caller whose agent token is another agent's than the one it names", async () => {
    const res = await createTask(socket, "other", {
      "bazhen-agent-token": AGENT_TOKEN,
      "bazhen-agent-id": agentId,
    });
    expect(res.status).toBe(403);
  });

  it("refuses a socket caller whose agent token is no live agent's, naming no agent", async () => {
    const res = await createTask(socket, "stale", { "bazhen-agent-token": "u".repeat(43) });
    expect(res.status).toBe(403);
  });

  it("tells a command the caller may not give from one nobody may give now", async () => {
    const statuses = [
      (await createTask(app, "forbidden")).status,
      (await createTask(app, "conflict")).status,
    ];
    expect(statuses).toEqual([403, 409]);
  });

  it("refuses a socket caller that gives its name in place of its id", async () => {
    const res = await createTask(socket, "named", { "bazhen-agent-id": "BZ-127" });
    expect(res.status).toBe(403);
  });

  it("lists the roles in force and the role files skipped, to an agent on the socket too", async () => {
    const res = await socket.request("/v1/roles", {
      headers: { "bazhen-agent-id": newId("agent") },
    });
    const body = RolesResponse.parse(await res.json());
    expect([res.status, body.roles.map((r) => r.key), body.problems.length]).toEqual([
      200,
      ["worker"],
      1,
    ]);
  });

  it("refuses a note too long, or holding a control character, before any command sees it", async () => {
    const before = callers.length;
    const statuses = [
      (await postNote("x".repeat(4001))).status,
      (await postNote("a\u001bb")).status,
    ];
    expect([statuses, callers.length - before]).toEqual([[400, 400], 0]);
  });

  it("hands a task's note to its own command, as the socket caller's", async () => {
    const as = { "bazhen-agent-id": agentId };
    const noted = await postTo(socket, `/v1/tasks/${newId("task")}/notes`, { text: "halfway" }, as);
    expect([(await noted.json()).eventIds, callers.at(-1)]).toEqual([[12], agentId]);
  });

  it("hands a task's broadcast to its own command, as the socket caller's", async () => {
    const as = { "bazhen-agent-id": agentId };
    const sent = await postTo(socket, `/v1/tasks/${newId("task")}/messages`, { body: "all" }, as);
    expect([(await sent.json()).eventIds, callers.at(-1)]).toEqual([[11], agentId]);
  });

  it("hands a wait the signal its request aborts when the client goes away", async () => {
    const gone = new AbortController();
    await app.request("/v1/messages/wait", {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ messageIds: [newId("msg")], timeoutMs: 1000 }),
      signal: gone.signal,
    });
    const signal = waitSignals.at(-1);
    gone.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("answers a wait on mail it never queued as not found, and one held too long as invalid", async () => {
    expect([(await wait(0)).status, (await wait(600_001)).status]).toEqual([404, 400]);
  });

  it("answers a read of a task it doesn't have with not found", async () => {
    const res = await app.request(`/v1/tasks/${newId("task")}`, { headers: { host } });
    expect([res.status, await res.json()]).toEqual([
      404,
      expect.objectContaining({ error: "not_found" }),
    ]);
  });
});

const postTo = (on: Served, path: string, body: object, headers: Record<string, string> = {}) =>
  on.request(path, {
    method: "POST",
    headers: { host, "content-type": "application/json", ...headers },
    body: JSON.stringify({ idempotencyKey: "n", ...body }),
  });

const postNote = (text: string) => postTo(app, `/v1/tasks/${newId("task")}/notes`, { text });

const wait = (timeoutMs: number) =>
  postTo(app, "/v1/messages/wait", { messageIds: [unknownMessage], timeoutMs });

describe("agents addressed by name", () => {
  it("takes an agent's name in its path as its id", async () => {
    const res = await postTo(app, "/v1/agents/BZ-127/messages", { body: "hi" });
    expect((await res.json()).eventIds).toEqual([4]);
  });

  it("hands a command on an agent named in its path that agent's id", async () => {
    const res = await postTo(app, "/v1/agents/BZ-127/relaunch", { generation: 0, fresh: true });
    expect((await res.json()).agentId).toBe(target);
  });

  it("answers a name no agent holds with not found", async () => {
    const res = await postTo(app, "/v1/agents/nobody/respawn", { generation: 0 });
    expect([res.status, (await res.json()).error]).toEqual([404, "not_found"]);
  });

  it("hands assign, create and delegate the id of the agent their body names", async () => {
    addressed.length = 0;
    await postTo(app, `/v1/tasks/${newId("task")}/assign`, { agentId: "BZ-127", role: "worker" });
    await postTo(app, "/v1/tasks", {
      title: "t",
      brief: "b",
      assign: { agentId: "BZ-127", role: "lead" },
    });
    await postTo(
      socket,
      "/v1/tasks/delegate",
      { agentId: "BZ-127", title: "t", brief: "b" },
      {
        "bazhen-agent-id": agentId,
      },
    );
    expect(addressed).toEqual([target, target, target]);
  });

  it("renames as whoever asks: the agent over the socket, the human over HTTP", async () => {
    renames.length = 0;
    await postTo(
      socket,
      "/v1/agents/BZ-127/rename",
      { name: "lead" },
      { "bazhen-agent-id": agentId },
    );
    await postTo(app, "/v1/agents/BZ-127/rename", { name: "lead" }, { "bazhen-agent-id": agentId });
    expect(renames).toEqual([
      [agentId, target],
      [null, target],
    ]);
  });

  it("answers a rename to a name another agent holds as a conflict", async () => {
    const res = await postTo(app, `/v1/agents/${target}/rename`, { name: "taken" });
    expect([res.status, (await res.json()).error]).toEqual([409, "conflict"]);
  });

  it("refuses a rename to something that isn't a name", async () => {
    const res = await postTo(app, `/v1/agents/${target}/rename`, { name: "-x" });
    expect(res.status).toBe(400);
  });
});
