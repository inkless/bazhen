import { Hono } from "hono";
import { HealthResponse, PROTOCOL_VERSION } from "@bazhen/protocol";
import type { RuntimeAdapter } from "@bazhen/core";

export interface AppDeps {
  readonly appVersion: string;
  readonly schemaVersion: () => number;
  readonly runtime: RuntimeAdapter;
  /** Host header values accepted; anything else is refused as a DNS-rebinding defence. */
  readonly allowedHosts: readonly string[];
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!deps.allowedHosts.includes(host)) return c.json({ error: "host not allowed" }, 421);
    return next();
  });

  app.get("/v1/health", async (c) => {
    const runtime = await deps.runtime.health();
    const body = HealthResponse.parse({
      status: "ok",
      appVersion: deps.appVersion,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: deps.schemaVersion(),
      runtime: { kind: "tmux", state: runtime.state, version: runtime.version },
    });
    return c.json(body);
  });

  return app;
}
