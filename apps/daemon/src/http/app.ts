import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  AnswerAttentionRequest,
  CloseAgentRequest,
  RespawnAgentRequest,
  SignalAgentRequest,
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
import {
  LaunchFailed,
  NoTerminal,
  NotResumable,
  ProcessState,
  UnsupportedHarness,
  type RuntimeAdapter,
} from "@bazhen/core";
import { z } from "zod";
import { InvalidDirectory } from "../agents/cwd.ts";
import { IdempotencyConflict, UnknownAgent } from "../store/store.ts";
import {
  AgentStateConflict,
  TerminalReplaced,
  EnvironmentUnavailable,
  ServerUnconfirmed,
  StaleGeneration,
} from "../agents/lifecycle.ts";
import { AttentionClosed, AttentionUnavailable } from "../mailbox/approvals.ts";
import { refusal, type Allowlists } from "./guard.ts";

export interface AppDeps {
  readonly appVersion: string;
  readonly schemaVersion: () => number;
  readonly runtime: RuntimeAdapter;
  /** Null on the Unix socket, whose 0600 permission is the authentication (§9.1). */
  readonly allow: Allowlists | null;
  readonly state: () => StateSnapshot;
  readonly launch: (req: LaunchAgentRequest) => Promise<LaunchAgentResponse>;
  readonly send: (agentId: string, req: SendMessageRequest) => SendMessageResponse;
  readonly answer: (attentionId: string, req: AnswerAttentionRequest) => AnswerAttentionResponse;
  readonly close: (agentId: string, req: CloseAgentRequest) => Promise<AgentCommandResponse>;
  readonly respawn: (agentId: string, req: RespawnAgentRequest) => Promise<AgentCommandResponse>;
  readonly signal: (agentId: string, req: SignalAgentRequest) => Promise<AgentCommandResponse>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A request that doesn't parse, described in words rather than as the parser's issue list. */
const invalid = (c: Context, error: z.ZodError) =>
  fail(c, 400, "invalid_request", z.prettifyError(error));

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

  const { allow } = deps;
  if (allow !== null) {
    app.use("*", async (c, next) => {
      const host = c.req.header("host");
      const origin = c.req.header("origin");
      const acting = !SAFE_METHODS.has(c.req.method) || c.req.header("upgrade") !== undefined;
      const refused = refusal(allow, { host, origin, acting });
      if (refused === "host_not_allowed") return fail(c, 421, refused, host ?? "");
      if (refused !== null) return fail(c, 403, refused, origin ?? "");
      return next();
    });
  }

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
    if (!body.success) return invalid(c, body.error);
    return c.json(await deps.launch(body.data));
  });

  /** A request about one entity: the body is checked against its schema, then handed to `run`. */
  const route = <T, R>(
    path: `/v1/${string}/:id/${string}`,
    schema: z.ZodType<T>,
    run: (id: string, req: T) => R | Promise<R>,
  ) =>
    app.post(path, async (c) => {
      const body = schema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return invalid(c, body.error);
      return c.json(await run(c.req.param("id"), body.data));
    });
  route("/v1/agents/:id/messages", SendMessageRequest, deps.send);
  route("/v1/agents/:id/close", CloseAgentRequest, deps.close);
  route("/v1/agents/:id/respawn", RespawnAgentRequest, deps.respawn);
  route("/v1/agents/:id/signal", SignalAgentRequest, deps.signal);
  route("/v1/attention/:id/answer", AnswerAttentionRequest, deps.answer);

  // Typed failures from the domain become protocol errors in one place; anything else is a bug.
  app.onError((err, c) => {
    if (err instanceof UnsupportedHarness) return fail(c, 422, "unsupported", err.message);
    if (err instanceof InvalidDirectory) return fail(c, 400, "invalid_request", err.message);
    if (err instanceof LaunchFailed) return fail(c, 502, "launch_failed", err.message);
    if (err instanceof IdempotencyConflict) return fail(c, 409, "conflict", err.message);
    if (err instanceof AttentionClosed) return fail(c, 409, "conflict", err.message);
    if (err instanceof AttentionUnavailable) return fail(c, 503, "unavailable", err.message);
    if (err instanceof UnknownAgent) return fail(c, 404, "not_found", err.message);
    if (err instanceof StaleGeneration) return fail(c, 409, "stale_generation", err.message);
    if (err instanceof NotResumable) return fail(c, 409, "not_resumable", err.message);
    if (err instanceof ServerUnconfirmed) return fail(c, 409, "server_unconfirmed", err.message);
    const conflict = [AgentStateConflict, TerminalReplaced, NoTerminal, ProcessState].some(
      (e) => err instanceof e,
    );
    if (conflict) return fail(c, 409, "conflict", err.message);
    if (err instanceof EnvironmentUnavailable) return fail(c, 503, "unavailable", err.message);
    throw err;
  });

  return app;
}
