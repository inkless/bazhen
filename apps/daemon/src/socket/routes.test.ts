import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { PairingCodeResponse, type Device, type DoctorResponse } from "@bazhen/protocol";
import type { AppEnv } from "../http/app.ts";
import { UnknownDevice } from "../store/store.ts";
import { AGENT_OPEN, HUMANS_ONLY, SELF_IDENTIFIED } from "../auth/callers.ts";
import { socketApp, type SocketParts } from "./routes.ts";

const report: DoctorResponse = {
  appVersion: "0.1.0",
  protocolId: "protocol-of-this-build",
  runtimes: [{ kind: "holder", state: "healthy", version: "holder/1.2" }],
  hookClient: { path: "/bin/bazhen-hook", fallback: false },
  config: { path: "/c/config.toml", found: false },
  agents: { shell: "direct", loginShell: null },
  codex: { daemon: "0.167.2", cli: "0.166.0" },
  env: {
    capturedAt: "2026-11-12T00:00:00.000Z",
    source: "start",
    kept: 3,
    removed: { CLAUDECODE: 1 },
  },
};
const doctor = async () => report;
type Env = Readonly<Record<string, string>>;
const refreshed = { capturedAt: "t", kept: 1, removed: {}, refused: [], unchanged: [] };

const device: Device = {
  id: newId("dev"),
  name: "Phone",
  pairedAt: "2026-11-12T00:00:00.000Z",
  lastSeenAt: "2026-11-12T00:00:00.000Z",
  expiresAt: "2026-12-12T00:00:00.000Z",
};
const revoked: string[] = [];
const devices = {
  list: () => [device],
  revoke: (id: string) => {
    if (id !== device.id) throw new UnknownDevice(id);
    revoked.push(id);
  },
};
/** One agent with a token; any other agent was started before agents had them. */
const tokened = newId("agent");
const TOKEN = "t".repeat(43);
const credentials: SocketParts["credentials"] = {
  agentOf: (token) => (token === TOKEN ? tokened : undefined),
  untokened: (agentId) => agentId !== tokened,
};
const pairing = {
  issue: () => ({ code: "ABCD2345", expiresAt: new Date("2026-11-12T00:05:00.000Z") }),
};

function app(
  refreshEnv = async (_env: Env) => refreshed,
  paneTitleChanged = (_pane: string) => {},
  lan: () => PairingCodeResponse["lan"] = () => undefined,
  shellReport: SocketParts["shellReport"] = () => "kept",
  shellPrompt: SocketParts["shellPrompt"] = () => true,
  peer?: SocketParts["peer"],
  shellDecline: SocketParts["shellDecline"] = () => true,
) {
  const commands = new Hono<AppEnv>();
  commands.post("/v1/attention/:id/answer", (c) => c.json({ answered: c.req.param("id") }));
  commands.post("/v1/attention/:id/reply", (c) => c.json({ replied: c.req.param("id") }));
  commands.post("/v1/attention/:id/dismiss", (c) => c.json({ dismissed: c.req.param("id") }));
  commands.post("/v1/attention/:id/resend", (c) => c.json({ resent: c.req.param("id") }));
  commands.post("/v1/notices/:id/dismiss", (c) => c.json({ dismissed: c.req.param("id") }));
  commands.get("/v1/state", (c) => c.json({ state: true }));
  const hooks = new Hono<{ Bindings: HttpBindings }>();
  hooks.post("/v1/hooks", (c) => c.text("hook"));
  hooks.post("/v1/hooks/ack", (c) => c.json({}));
  return socketApp({
    commands,
    hooks,
    credentials,
    stop: () => undefined,
    doctor,
    refreshEnv,
    paneTitleChanged,
    pairing,
    devices,
    externalOrigins: ["https://laptop.example.ts.net"],
    lan,
    shellReport,
    shellPrompt,
    shellDecline,
    ...(peer && { peer }),
  });
}

const act = (action: string, headers: Record<string, string>) =>
  app().request(`/v1/attention/attn_x/${action}`, { method: "POST", headers });

/** Every route `on` serves, once each. */
function routesOf(on: ReturnType<typeof app>): { method: string; path: string }[] {
  const routes = new Map<string, { method: string; path: string }>();
  for (const { method, path } of on.routes)
    if (method !== "ALL") routes.set(`${method} ${path}`, { method, path });
  return [...routes.values()];
}

/** One call on a route of `on`, its `:id` filled in, with an empty environment unless a GET. */
const callOn = (
  on: ReturnType<typeof app>,
  route: { method: string; path: string },
  headers: Record<string, string>,
) =>
  on.request(route.path.replaceAll(":id", "x_1"), {
    method: route.method,
    headers,
    ...(route.method === "GET" ? {} : { body: JSON.stringify({ env: {} }) }),
  });

/** A route in neither the agents' list nor the hooks': the human's alone. */
const humansAlone = (route: { method: string; path: string }) =>
  !agentOpen(route) && !SELF_IDENTIFIED.includes(route.path);

/** Whether `AGENT_OPEN` lists the route, by its method and path. */
function agentOpen(route: { method: string; path: string }): boolean {
  return AGENT_OPEN.some(([method, path]) => method === route.method && path === route.path);
}

const answer = (headers: Record<string, string> = {}) =>
  app().request("/v1/attention/attn_x/answer", { method: "POST", headers });

const dismissNotice = (headers: Record<string, string>) =>
  app().request("/v1/notices/ntc_x/dismiss", { method: "POST", headers });

describe("socketApp", () => {
  it("serves the command routes and the hook ingress", async () => {
    expect(await (await app().request("/v1/state")).json()).toEqual({ state: true });
    expect(await (await app().request("/v1/hooks", { method: "POST" })).text()).toBe("hook");
  });

  it("reports the daemon's doctor", async () => {
    expect(await (await app().request("/v1/daemon/doctor")).json()).toEqual(report);
  });

  it("hands a refresh the caller's environment, and refuses a body that isn't one", async () => {
    const received: Env[] = [];
    const daemon = app(async (env) => {
      received.push(env);
      return refreshed;
    });
    const refresh = (body: unknown) =>
      daemon.request("/v1/daemon/env", { method: "POST", body: JSON.stringify(body) });
    expect((await refresh({ env: { A: "1" } })).status).toBe(200);
    expect((await refresh({ env: { A: 1 } })).status).toBe(400);
    expect(received).toEqual([{ A: "1" }]);
  });

  it("hands on the pane a title changed in, and refuses anything but a pane id", async () => {
    const panes: string[] = [];
    const daemon = app(undefined, (pane) => panes.push(pane));
    const notify = (body: unknown) =>
      daemon.request("/v1/codex/pane-title", { method: "POST", body: JSON.stringify(body) });
    expect((await notify({ pane: "%12" })).status).toBe(204);
    expect((await notify({ pane: "%12; rm" })).status).toBe(400);
    expect((await notify({ title: "x" })).status).toBe(400);
    expect(panes).toEqual(["%12"]);
  });

  it("hands on a shell's report as it came, and refuses a body that isn't one", async () => {
    const received: { terminalId: string; sent: unknown }[] = [];
    const daemon = app(undefined, undefined, undefined, (terminalId, sent) => {
      received.push({ terminalId, sent });
      return "kept";
    });
    const post = (body: unknown) =>
      daemon.request("/v1/shells/term_x/report", { method: "POST", body: JSON.stringify(body) });
    const statuses = [
      (await post({ token: "t", at: 1, command: "make" })).status,
      (await post({ token: "t", at: 2, command: 7 })).status,
      (await post({ token: "t", command: "make" })).status,
    ];
    expect([statuses, received]).toEqual([
      [204, 400, 400],
      [{ terminalId: "term_x", sent: { token: "t", at: 1, command: "make" } }],
    ]);
  });

  it("refuses a report body larger than any whole line needs, unread", async () => {
    const received: string[] = [];
    const daemon = app(undefined, undefined, undefined, (terminalId) => {
      received.push(terminalId);
      return "kept";
    });
    const res = await daemon.request("/v1/shells/term_x/report", {
      method: "POST",
      body: JSON.stringify({ token: "t", at: 1, command: "x", pad: "y".repeat(17 * 1024) }),
    });
    expect([res.status, received]).toEqual([413, []]);
  });

  it("refuses a report the shell's token doesn't vouch for, naming no part of its line", async () => {
    const daemon = app(undefined, undefined, undefined, () => "refused");
    const res = await daemon.request("/v1/shells/term_x/report", {
      method: "POST",
      body: JSON.stringify({ token: "t", at: 1, command: "export TOKEN=s3cret" }),
    });
    const text = await res.text();
    expect([res.status, text.includes("s3cret")]).toEqual([403, false]);
  });

  it("hands on a shell's prompt report, and refuses one its token doesn't vouch for", async () => {
    const received: { terminalId: string; sent: unknown }[] = [];
    const daemon = app(undefined, undefined, undefined, undefined, (terminalId, sent) => {
      received.push({ terminalId, sent });
      return sent.token === "mine";
    });
    const post = (body: unknown) =>
      daemon.request("/v1/shells/term_x/prompt", { method: "POST", body: JSON.stringify(body) });
    const statuses = [
      (await post({ token: "mine" })).status,
      (await post({ token: "theirs" })).status,
      (await post({ token: "" })).status,
    ];
    const large = await post({ token: "mine", pad: "y".repeat(2048) });
    expect([statuses, received.map((r) => r.sent)]).toEqual([
      [204, 403, 400],
      [{ token: "mine" }, { token: "theirs" }],
    ]);
    expect([large.status, await large.json()]).toEqual([
      413,
      { error: "invalid_request", message: "report too large" },
    ]);
  });

  it("hands on a shell's word that it won't take a line back, on a route of its own", async () => {
    const received: { terminalId: string; sent: unknown }[] = [];
    const prompts: unknown[] = [];
    const daemon = app(
      undefined,
      undefined,
      undefined,
      undefined,
      (_terminalId, sent) => prompts.push(sent) > 0,
      undefined,
      (terminalId, sent) => {
        received.push({ terminalId, sent });
        return sent.token === "mine";
      },
    );
    const post = (body: unknown) =>
      daemon.request("/v1/shells/term_x/decline", { method: "POST", body: JSON.stringify(body) });
    const statuses = [
      (await post({ token: "mine" })).status,
      (await post({ token: "theirs" })).status,
      (await post({ token: "" })).status,
    ];
    expect([statuses, received, prompts]).toEqual([
      [204, 403, 400],
      [
        { terminalId: "term_x", sent: { token: "mine" } },
        { terminalId: "term_x", sent: { token: "theirs" } },
      ],
      [],
    ]);
  });

  it("lets a caller that presents no agent answer an approval", async () => {
    expect(await (await answer()).json()).toEqual({ answered: "attn_x" });
  });

  it("refuses a reply, resend or dismissal from a caller that says it is an agent", async () => {
    const agent = { "bazhen-agent-id": "agent_x" };
    const refused = await Promise.all(
      ["reply", "resend", "dismiss"].map(async (a) => (await act(a, agent)).status),
    );
    const human = await (await act("reply", {})).json();
    expect([refused, human]).toEqual([[403, 403, 403], { replied: "attn_x" }]);
  });

  it("refuses a notice dismissal from a caller that says it is an agent, and takes a human's", async () => {
    const refused = await dismissNotice({ "bazhen-agent-id": "agent_x" });
    const human = await (await dismissNotice({})).json();
    expect([refused.status, human]).toEqual([403, { dismissed: "ntc_x" }]);
  });

  it("refuses an approval answer from a caller that says it is an agent", async () => {
    const res = await answer({ "bazhen-agent-id": "agent_x" });
    expect([res.status, (await res.json()).error]).toEqual([403, "forbidden"]);
  });

  it("refuses a token that is no live agent's on every route but those that identify their callers themselves", async () => {
    const daemon = app();
    const routes = routesOf(daemon);
    const bad = { "bazhen-agent-token": "u".repeat(43) };
    const refused = await Promise.all(
      routes.map(async (r) => [r.path, (await callOn(daemon, r, bad)).status === 403]),
    );
    expect(routes.length).toBeGreaterThan(10);
    const unidentified = ["/v1/hooks", "/v1/hooks/ack", "/v1/codex/pane-title"];
    expect(refused).toEqual(routes.map((r) => [r.path, !unidentified.includes(r.path)]));
  });

  it("puts every route it serves in exactly one of the agents', the human's and the hooks' lists", () => {
    const humans = HUMANS_ONLY.map(([path]) => path);
    const routes = routesOf(app());
    const lists = routes.map((r) => [
      r.path,
      [agentOpen(r), humans.includes(r.path), SELF_IDENTIFIED.includes(r.path)].filter(Boolean)
        .length,
    ]);
    expect(lists).toEqual(routes.map((r) => [r.path, 1]));
  });

  it("refuses an agent with its token every route outside the agents' and the hooks' lists", async () => {
    const daemon = app();
    const routes = routesOf(daemon).filter(humansAlone);
    const asAgent = { "bazhen-agent-token": TOKEN };
    const statuses = await Promise.all(
      routes.map(async (r) => [r.path, (await callOn(daemon, r, asAgent)).status]),
    );
    expect(routes.map((r) => r.path)).toEqual(
      expect.arrayContaining(["/v1/pairing/codes", "/v1/devices/:id/revoke", "/v1/daemon/env"]),
    );
    expect(statuses).toEqual(routes.map((r) => [r.path, 403]));
  });

  it("takes tmux's pane-title hook, which runs under its server in no terminal, and refuses that caller elsewhere", async () => {
    const titled: string[] = [];
    const daemon = app(
      undefined,
      (pane) => titled.push(pane),
      undefined,
      undefined,
      undefined,
      async () => ({ kind: "refused", reason: "the caller runs under Bazhen's runtime" }),
    );
    // The guard reads the connection's peer; these requests have none, so the reading is faked.
    const env = { incoming: { socket: {} } };
    const call = (path: string, body: unknown) =>
      daemon.request(path, { method: "POST", body: JSON.stringify(body) }, env);
    const statuses = [
      (await call("/v1/codex/pane-title", { pane: "%1" })).status,
      (await call("/v1/pairing/codes", {})).status,
    ];
    expect([statuses, titled]).toEqual([[204, 403], ["%1"]]);
  });

  it("refuses an approval answer from an agent that proves itself with its token", async () => {
    const res = await answer({ "bazhen-agent-token": TOKEN });
    expect([res.status, (await res.json()).message]).toEqual([
      403,
      "an agent can't answer an attention item",
    ]);
  });

  it("refuses an approval answer from a caller whose agent token is no live agent's", async () => {
    const res = await answer({ "bazhen-agent-token": "u".repeat(43) });
    expect([res.status, (await res.json()).message]).toEqual([
      403,
      "an agent can't answer an attention item: the agent token is no live agent's",
    ]);
  });

  it("issues a pairing code with the addresses to open, to a caller that isn't an agent", async () => {
    const res = await app().request("/v1/pairing/codes", { method: "POST" });
    expect(await res.json()).toEqual({
      code: "ABCD2345",
      expiresAt: "2026-11-12T00:05:00.000Z",
      origins: ["https://laptop.example.ts.net"],
    });
  });

  it("shows the LAN listener's address and fingerprint with the code while it serves", async () => {
    const lan = {
      url: "https://my-mac.local:7942",
      fingerprint: "ab cd",
      expiresAt: "2029-02-11T00:00:00.000Z",
    };
    const res = await app(undefined, undefined, () => lan).request("/v1/pairing/codes", {
      method: "POST",
    });
    expect(PairingCodeResponse.parse(await res.json()).lan).toEqual(lan);
  });

  it("refuses to pair or revoke for a caller that says it is an agent", async () => {
    const agent = { "bazhen-agent-id": "agent_x" };
    const paths = ["/v1/pairing/codes", `/v1/devices/${device.id}/revoke`];
    const statuses = await Promise.all(
      paths.map(async (p) => (await app().request(p, { method: "POST", headers: agent })).status),
    );
    expect([statuses, revoked]).toEqual([[403, 403], []]);
  });

  it("lists devices, revokes one by id, and answers 404 for an id it doesn't know", async () => {
    const daemon = app();
    expect(await (await daemon.request("/v1/devices")).json()).toEqual({ devices: [device] });
    const revoke = (id: string) => daemon.request(`/v1/devices/${id}/revoke`, { method: "POST" });
    expect((await revoke(device.id)).status).toBe(200);
    expect((await revoke(newId("dev"))).status).toBe(404);
    expect(revoked).toEqual([device.id]);
  });
});
