import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  HealthResponse,
  LaunchAgentRequest,
  PROTOCOL_VERSION,
  type ErrorResponse,
  type LaunchAgentResponse,
  type StateSnapshot,
} from "@bazhen/protocol";
import { LaunchFailed, UnsupportedHarness, type RuntimeAdapter } from "@bazhen/core";
import { IdempotencyConflict } from "../agents/launch.ts";

export interface AppDeps {
  readonly appVersion: string;
  readonly schemaVersion: () => number;
  readonly runtime: RuntimeAdapter;
  /** Host header values accepted; anything else is refused as a DNS-rebinding defence. */
  readonly allowedHosts: readonly string[];
  /** Origins a browser may act from: state-changing requests and socket upgrades from any other are refused. */
  readonly allowedOrigins: readonly string[];
  readonly state: () => StateSnapshot;
  readonly launch: (req: LaunchAgentRequest) => Promise<LaunchAgentResponse>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function fail(
  c: Context,
  status: ContentfulStatusCode,
  error: ErrorResponse["error"],
  message: string,
) {
  const body: ErrorResponse = { error, message };
  return c.json(body, status);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!deps.allowedHosts.includes(host)) return fail(c, 421, "host_not_allowed", host);
    return next();
  });

  // A browser always sends Origin on these, so a page elsewhere can't act through a user's
  // browser (foundation-design §9.1). A request without one comes from a local process, which
  // the Host check and, later, pairing govern.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const acts = !SAFE_METHODS.has(c.req.method) || c.req.header("upgrade") !== undefined;
    if (acts && origin !== undefined && !deps.allowedOrigins.includes(origin)) {
      return fail(c, 403, "origin_not_allowed", origin);
    }
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

  app.get("/v1/state", (c) => c.json(deps.state()));

  app.post("/v1/agents", async (c) => {
    const body = LaunchAgentRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return fail(c, 400, "invalid_request", body.error.message);
    return c.json(await deps.launch(body.data));
  });

  // Typed failures from the domain become protocol errors in one place; anything else is a bug.
  app.onError((err, c) => {
    if (err instanceof UnsupportedHarness) return fail(c, 422, "unsupported", err.message);
    if (err instanceof LaunchFailed) return fail(c, 502, "launch_failed", err.message);
    if (err instanceof IdempotencyConflict) return fail(c, 409, "conflict", err.message);
    throw err;
  });

  return app;
}
