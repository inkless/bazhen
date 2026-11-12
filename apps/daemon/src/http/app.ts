import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  AnswerAttentionRequest,
  CloseAgentRequest,
  HealthResponse,
  LaunchAgentRequest,
  PROTOCOL_VERSION,
  SendMessageRequest,
  type AnswerAttentionResponse,
  type AgentCommandResponse,
  type SendMessageResponse,
  type ErrorResponse,
  type LaunchAgentResponse,
  type StateSnapshot,
} from "@bazhen/protocol";
import { LaunchFailed, NoTerminal, UnsupportedHarness, type RuntimeAdapter } from "@bazhen/core";
import { IdempotencyConflict, UnknownAgent } from "../store/store.ts";
import {
  AgentStateConflict,
  TerminalReplaced,
  EnvironmentUnavailable,
  StaleGeneration,
} from "../agents/lifecycle.ts";
import { AttentionClosed } from "../mailbox/approvals.ts";
import { refusal, type Allowlists } from "./guard.ts";

export interface AppDeps {
  readonly appVersion: string;
  readonly schemaVersion: () => number;
  readonly runtime: RuntimeAdapter;
  readonly allow: Allowlists;
  readonly state: () => StateSnapshot;
  readonly launch: (req: LaunchAgentRequest) => Promise<LaunchAgentResponse>;
  readonly send: (agentId: string, req: SendMessageRequest) => SendMessageResponse;
  readonly answer: (attentionId: string, req: AnswerAttentionRequest) => AnswerAttentionResponse;
  readonly close: (agentId: string, req: CloseAgentRequest) => Promise<AgentCommandResponse>;
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
    const host = c.req.header("host");
    const origin = c.req.header("origin");
    const acting = !SAFE_METHODS.has(c.req.method) || c.req.header("upgrade") !== undefined;
    const refused = refusal(deps.allow, { host, origin, acting });
    if (refused === "host_not_allowed") return fail(c, 421, refused, host ?? "");
    if (refused !== null) return fail(c, 403, refused, origin ?? "");
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

  app.post("/v1/agents/:id/messages", async (c) => {
    const body = SendMessageRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return fail(c, 400, "invalid_request", body.error.message);
    return c.json(deps.send(c.req.param("id"), body.data));
  });

  app.post("/v1/agents/:id/close", async (c) => {
    const body = CloseAgentRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return fail(c, 400, "invalid_request", body.error.message);
    return c.json(await deps.close(c.req.param("id"), body.data));
  });

  app.post("/v1/attention/:id/answer", async (c) => {
    const body = AnswerAttentionRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return fail(c, 400, "invalid_request", body.error.message);
    return c.json(deps.answer(c.req.param("id"), body.data));
  });

  // Typed failures from the domain become protocol errors in one place; anything else is a bug.
  app.onError((err, c) => {
    if (err instanceof UnsupportedHarness) return fail(c, 422, "unsupported", err.message);
    if (err instanceof LaunchFailed) return fail(c, 502, "launch_failed", err.message);
    if (err instanceof IdempotencyConflict) return fail(c, 409, "conflict", err.message);
    if (err instanceof AttentionClosed) return fail(c, 409, "conflict", err.message);
    if (err instanceof UnknownAgent) return fail(c, 404, "not_found", err.message);
    if (err instanceof StaleGeneration) return fail(c, 409, "stale_generation", err.message);
    const conflict = [AgentStateConflict, TerminalReplaced, NoTerminal].some(
      (e) => err instanceof e,
    );
    if (conflict) return fail(c, 409, "conflict", err.message);
    if (err instanceof EnvironmentUnavailable) return fail(c, 503, "unavailable", err.message);
    throw err;
  });

  return app;
}
