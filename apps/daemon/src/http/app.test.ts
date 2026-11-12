import { describe, expect, it } from "vitest";
import { newId, UnsupportedHarness, type RuntimeAdapter } from "@bazhen/core";
import { PROTOCOL_VERSION, type LaunchAgentRequest } from "@bazhen/protocol";
import { AttentionClosed } from "../mailbox/approvals.ts";
import { createApp } from "./app.ts";

const unused = () => Promise.reject(new Error("not used by these tests"));
const runtime: RuntimeAdapter = {
  kind: "tmux",
  health: async () => ({ state: "not-running", version: "tmux 3.6b" }),
  inventory: unused,
  create: unused,
  attach: unused,
  close: unused,
  respawn: unused,
  signal: unused,
  onExit: () => () => {},
};
const launched = { agentId: newId("agent"), terminalId: newId("term"), eventIds: [2, 3] };
const app = createApp({
  appVersion: "0.1.0",
  schemaVersion: () => 1,
  runtime,
  allow: { hosts: ["127.0.0.1:7900"], origins: ["http://127.0.0.1:7900"] },
  state: () => ({
    epoch: "e1",
    eventId: 3,
    environments: [],
    agents: [],
    attention: [],
    messages: [],
  }),
  send: () => ({ messageId: newId("msg"), eventIds: [4] }),
  answer: () => {
    throw new AttentionClosed("attn_x");
  },
  launch: async (req: LaunchAgentRequest) => {
    if (req.harness === "codex") throw new UnsupportedHarness("codex");
    return launched;
  },
});

const host = "127.0.0.1:7900";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/v1/agents", {
    method: "POST",
    headers: { host, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const launch = { idempotencyKey: "k-1", harness: "claude-code", cwd: "/work" };

describe("HTTP app", () => {
  it("reports runtime health and versions", async () => {
    const res = await app.request("/v1/health", { headers: { host } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: 1,
      runtime: { state: "not-running", version: "tmux 3.6b" },
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
    const bad = await post({ ...launch, cwd: "relative" });
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
});
