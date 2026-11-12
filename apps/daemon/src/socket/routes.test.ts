import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { socketApp } from "./routes.ts";

function app() {
  const commands = new Hono();
  commands.post("/v1/attention/:id/answer", (c) => c.json({ answered: c.req.param("id") }));
  commands.get("/v1/state", (c) => c.json({ state: true }));
  const hooks = new Hono();
  hooks.post("/v1/hooks", (c) => c.text("hook"));
  return socketApp({ commands, hooks, stop: () => undefined });
}

const answer = (headers: Record<string, string> = {}) =>
  app().request("/v1/attention/attn_x/answer", { method: "POST", headers });

describe("socketApp", () => {
  it("serves the command routes and the hook ingress", async () => {
    expect(await (await app().request("/v1/state")).json()).toEqual({ state: true });
    expect(await (await app().request("/v1/hooks", { method: "POST" })).text()).toBe("hook");
  });

  it("lets a caller that presents no agent answer an approval", async () => {
    expect(await (await answer()).json()).toEqual({ answered: "attn_x" });
  });

  it("refuses an approval answer from a caller that says it is an agent", async () => {
    const res = await answer({ "bazhen-agent-id": "agent_x" });
    expect([res.status, (await res.json()).error]).toEqual([403, "forbidden"]);
  });
});
