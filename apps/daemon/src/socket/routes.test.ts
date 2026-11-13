import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DoctorResponse } from "@bazhen/protocol";
import { socketApp } from "./routes.ts";

const report: DoctorResponse = {
  appVersion: "0.1.0",
  protocolVersion: "1.4",
  runtime: { state: "healthy", version: "3.5a" },
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

function app(
  refreshEnv = async (_env: Env) => refreshed,
  paneTitleChanged = (_pane: string) => {},
) {
  const commands = new Hono();
  commands.post("/v1/attention/:id/answer", (c) => c.json({ answered: c.req.param("id") }));
  commands.get("/v1/state", (c) => c.json({ state: true }));
  const hooks = new Hono();
  hooks.post("/v1/hooks", (c) => c.text("hook"));
  return socketApp({
    commands,
    hooks,
    stop: () => undefined,
    doctor,
    refreshEnv,
    paneTitleChanged,
  });
}

const answer = (headers: Record<string, string> = {}) =>
  app().request("/v1/attention/attn_x/answer", { method: "POST", headers });

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

  it("lets a caller that presents no agent answer an approval", async () => {
    expect(await (await answer()).json()).toEqual({ answered: "attn_x" });
  });

  it("refuses an approval answer from a caller that says it is an agent", async () => {
    const res = await answer({ "bazhen-agent-id": "agent_x" });
    expect([res.status, (await res.json()).error]).toEqual([403, "forbidden"]);
  });
});
