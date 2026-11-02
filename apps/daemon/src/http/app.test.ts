import { describe, expect, it } from "vitest";
import type { RuntimeAdapter } from "@bazhen/core";
import { createApp } from "./app.ts";

const unused = () => Promise.reject(new Error("not used by these tests"));
const runtime: RuntimeAdapter = {
  kind: "tmux",
  health: async () => ({ state: "not-running", version: "tmux 3.6b" }),
  inventory: unused,
  create: unused,
  attach: unused,
  close: unused,
};
const app = createApp({
  appVersion: "0.1.0",
  schemaVersion: () => 1,
  runtime,
  allowedHosts: ["127.0.0.1:7900"],
});

describe("HTTP app", () => {
  it("reports runtime health and versions", async () => {
    const res = await app.request("/v1/health", { headers: { host: "127.0.0.1:7900" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      protocolVersion: "1.0",
      schemaVersion: 1,
      runtime: { state: "not-running", version: "tmux 3.6b" },
    });
  });

  it("refuses a request whose Host header is not on the allowlist", async () => {
    const res = await app.request("/v1/health", { headers: { host: "evil.example:7900" } });
    expect(res.status).toBe(421);
  });
});
