import { describe, expect, it } from "vitest";
import { newId, NotResumable, UnsupportedHarness } from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { PROTOCOL_VERSION, type LaunchAgentRequest } from "@bazhen/protocol";
import { EnvironmentUnavailable, StaleGeneration } from "../agents/lifecycle.ts";
import { AttentionClosed } from "../mailbox/approvals.ts";
import { createApp } from "./app.ts";

const runtime = new FakeRuntime();
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
  close: async (agentId, req) => {
    if (req.generation !== 2) throw new StaleGeneration(agentId, 2);
    throw new EnvironmentUnavailable(agentId, new Error("tmux unreachable"));
  },
  respawn: async () => {
    throw new NotResumable(newId("agent"));
  },
  signal: () => Promise.reject(new Error("not used by these tests")),
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
const close = (generation: number) =>
  app.request("/v1/agents/agent_x/close", {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "c", generation }),
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

  it("tells a stale generation from an environment that can't be reached, on close", async () => {
    const [stale, unavailable] = await Promise.all([close(1), close(2)]);
    expect([stale.status, (await stale.json()).error]).toEqual([409, "stale_generation"]);
    expect([unavailable.status, (await unavailable.json()).error]).toEqual([503, "unavailable"]);
  });

  it("answers a respawn of an agent with no session to resume as not resumable", async () => {
    const res = await app.request("/v1/agents/agent_x/respawn", {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "r", generation: 0 }),
    });
    expect([res.status, (await res.json()).error]).toEqual([409, "not_resumable"]);
  });
});
