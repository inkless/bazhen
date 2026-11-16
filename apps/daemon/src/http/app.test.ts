import { describe, expect, it } from "vitest";
import {
  AgentTerminalExists,
  HarnessRefused,
  newId,
  NotResumable,
  TaskRefused,
  UnsupportedHarness,
  type Caller,
} from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { PROTOCOL_VERSION, RolesResponse, type LaunchAgentRequest } from "@bazhen/protocol";
import { EnvironmentUnavailable, ServerUnconfirmed, StaleGeneration } from "../agents/lifecycle.ts";
import { AttentionClosed } from "../mailbox/approvals.ts";
import { AgentGone } from "../mailbox/mailbox.ts";
import { ShellBusy, UnknownShell } from "../shells/lifecycle.ts";
import { AttentionRefused } from "../attention/inbox.ts";
import { NoticeClosed, NoticeRefused, type Viewer } from "../attention/notices.ts";
import { TerminalLimit } from "../terminals/budget.ts";
import { NameTaken } from "../agents/names.ts";
import { UnknownAgent } from "../store/store.ts";
import { createApp, type AppDeps, type TaskCommands } from "./app.ts";

const runtime = new FakeRuntime();

const launched = { agentId: newId("agent"), terminalId: newId("term"), eventIds: [2, 3] };
const callers: Caller[] = [];
const target = newId("agent");
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
};
/** The viewer and advisory device each notice dismissal reached the handler with. */
const seenDismissals: [Viewer, string | undefined][] = [];

const deps: AppDeps = {
  appVersion: "0.1.0",
  schemaVersion: () => 1,
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
};
const restarts: unknown[] = [];
const app = createApp(deps);
const socket = createApp({ ...deps, allow: null });

const host = "127.0.0.1:7900";

const act = (action: string, body: object) =>
  app.request(`/v1/attention/attn_x/${action}`, {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "a", ...body }),
  });
const dismissNotice = (body: unknown, on = app) =>
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

  it("sends a socket caller's message as that agent's, and a browser's as the human's", async () => {
    const send = (on: typeof app) =>
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

  it("refuses a socket caller that gives its name in place of its id", async () => {
    const res = await createTask(socket, "named", { "bazhen-agent-id": "BZ-127" });
    expect(res.status).toBe(400);
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

  it("answers a read of a task it doesn't have with not found", async () => {
    const res = await app.request(`/v1/tasks/${newId("task")}`, { headers: { host } });
    expect([res.status, await res.json()]).toEqual([
      404,
      expect.objectContaining({ error: "not_found" }),
    ]);
  });
});

const postTo = (on: typeof app, path: string, body: object, headers: Record<string, string> = {}) =>
  on.request(path, {
    method: "POST",
    headers: { host, "content-type": "application/json", ...headers },
    body: JSON.stringify({ idempotencyKey: "n", ...body }),
  });

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
