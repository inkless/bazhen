import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import {
  EnvRefreshRequest,
  type DoctorResponse,
  type EnvRefreshResponse,
  type ErrorResponse,
  type StopResponse,
} from "@bazhen/protocol";

export interface SocketParts {
  /** The `/v1` command routes, unguarded: the socket's permission is the authentication. */
  readonly commands: Hono;
  readonly hooks: Hono;
  /** Stops the daemon; called once the reply to `stop` has been written. */
  readonly stop: () => void;
  readonly doctor: () => Promise<DoctorResponse>;
  /** Agents started from now on get `env`, filtered as at start-up (foundation-design §9.5). */
  readonly refreshEnv: (env: Readonly<Record<string, string>>) => Promise<EnvRefreshResponse>;
}

/**
 * What the daemon's 0600 Unix socket serves: the hook ingress, the full command set, and routes a
 * browser must never reach (foundation-design §5.1, §9.1).
 */
export function socketApp(parts: SocketParts): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  // Only a human answers an approval: a caller that says it is an agent is refused (§9.1).
  // Advisory against a hostile process of the same user, which could just not say (§9.4).
  app.use("/v1/attention/:id/answer", async (c, next) => {
    if (c.req.header("bazhen-agent-id") === undefined) return next();
    const body: ErrorResponse = {
      error: "forbidden",
      message: "an agent can't answer an approval",
    };
    return c.json(body, 403);
  });

  app.post("/v1/daemon/stop", (c) => {
    c.env.outgoing.once("finish", parts.stop);
    const body: StopResponse = {};
    return c.json(body);
  });

  app.get("/v1/daemon/doctor", async (c) => c.json(await parts.doctor()));

  // The body is the user's whole environment: it is used and dropped, never logged or stored.
  app.post("/v1/daemon/env", async (c) => {
    const req = EnvRefreshRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!req.success) {
      const body: ErrorResponse = { error: "invalid_request", message: "expected { env }" };
      return c.json(body, 400);
    }
    return c.json(await parts.refreshEnv(req.data.env));
  });

  app.route("/", parts.hooks);
  app.route("/", parts.commands);
  return app;
}
