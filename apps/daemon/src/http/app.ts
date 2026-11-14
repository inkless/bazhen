import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  AnswerAttentionRequest,
  DismissAttentionRequest,
  ReplyAttentionRequest,
  ResendAttentionRequest,
  AssignTaskRequest,
  CreateTaskRequest,
  DelegateTaskRequest,
  EscalateRequest,
  type EscalateResponse,
  FinishTaskRequest,
  UnassignTaskRequest,
  type AssignTaskResponse,
  type CreateTaskResponse,
  type TaskCommandResponse,
  type TaskDetail,
  CloseAgentRequest,
  CloseShellRequest,
  OpenShellRequest,
  RenameShellRequest,
  RestartShellRequest,
  UnlinkShellRequest,
  RelaunchAgentRequest,
  RespawnAgentRequest,
  SignalAgentRequest,
  HealthResponse,
  LaunchAgentRequest,
  PROTOCOL_VERSION,
  PairRequest,
  SendMessageRequest,
  type AnswerAttentionResponse,
  type DismissAttentionResponse,
  type ReplyAttentionResponse,
  type ResendAttentionResponse,
  type PairResponse,
  type AgentCommandResponse,
  type SendMessageResponse,
  type ErrorResponse,
  type LaunchAgentResponse,
  type ShellCommandResponse,
  type StateSnapshot,
} from "@bazhen/protocol";
import {
  AgentTerminalExists,
  HarnessRefused,
  isId,
  LaunchFailed,
  TaskRefused,
  type Caller,
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
  EnvironmentUnavailable,
  failureDetail,
  ServerUnconfirmed,
  StaleGeneration,
  StateConflict,
  TerminalReplaced,
} from "../commands.ts";
import { AttentionClosed, AttentionUnavailable } from "../mailbox/approvals.ts";
import { AgentGone } from "../mailbox/mailbox.ts";
import { ShellBusy, ShellOpenFailed, ShellsUnsettled, UnknownShell } from "../shells/lifecycle.ts";
import { AttentionRefused } from "../attention/inbox.ts";
import { MailTooLong, UnknownTask } from "../tasks/tasks.ts";
import { refusal, type Allowlists } from "./guard.ts";
import { webPage } from "./web.ts";
import {
  arrivedRemotely,
  deviceCookie,
  mustPair,
  tokenFrom,
  type DeviceAuth,
  type DeviceGate,
} from "../auth/devices.ts";
import type { PairingCodes } from "../auth/pairing.ts";

export interface AppDeps {
  readonly appVersion: string;
  readonly schemaVersion: () => number;
  readonly runtime: RuntimeAdapter;
  /** Null on the Unix socket, whose 0600 permission is the authentication (§9.1). */
  readonly allow: Allowlists | null;
  /** Where a browser trades a pairing code for a device; absent on the Unix socket. */
  readonly pairing?: { readonly codes: PairingCodes; readonly devices: DeviceAuth };
  /** When a request other than the pairing exchange must come from a paired device (§9.2). */
  readonly gate?: DeviceGate;
  /** The built web client's directory, served on every path outside `/v1`; absent on the socket. */
  readonly web?: { readonly root: string };
  readonly state: () => StateSnapshot;
  readonly launch: (req: LaunchAgentRequest) => Promise<LaunchAgentResponse>;
  readonly answer: (attentionId: string, req: AnswerAttentionRequest) => AnswerAttentionResponse;
  readonly reply: (attentionId: string, req: ReplyAttentionRequest) => ReplyAttentionResponse;
  readonly dismiss: (attentionId: string, req: DismissAttentionRequest) => DismissAttentionResponse;
  readonly resend: (attentionId: string, req: ResendAttentionRequest) => ResendAttentionResponse;
  readonly close: (agentId: string, req: CloseAgentRequest) => Promise<AgentCommandResponse>;
  readonly respawn: (agentId: string, req: RespawnAgentRequest) => Promise<AgentCommandResponse>;
  readonly relaunch: (agentId: string, req: RelaunchAgentRequest) => Promise<AgentCommandResponse>;
  readonly signal: (agentId: string, req: SignalAgentRequest) => Promise<AgentCommandResponse>;
  readonly openShell: (req: OpenShellRequest) => Promise<ShellCommandResponse>;
  readonly closeShell: (
    terminalId: string,
    req: CloseShellRequest,
  ) => Promise<ShellCommandResponse>;
  readonly restartShell: (
    terminalId: string,
    req: RestartShellRequest,
  ) => Promise<ShellCommandResponse>;
  readonly renameShell: (
    terminalId: string,
    req: RenameShellRequest,
  ) => Promise<ShellCommandResponse>;
  readonly unlinkShell: (
    terminalId: string,
    req: UnlinkShellRequest,
  ) => Promise<ShellCommandResponse>;
  readonly tasks: TaskCommands;
}

/** Task commands, each told who asks: an agent by its id, or the human as null. */
export interface TaskCommands {
  create(caller: Caller, req: CreateTaskRequest): CreateTaskResponse;
  show(taskId: string): TaskDetail | undefined;
  assign(caller: Caller, taskId: string, req: AssignTaskRequest): AssignTaskResponse;
  unassign(caller: Caller, taskId: string, req: UnassignTaskRequest): TaskCommandResponse;
  finish(caller: Caller, taskId: string, req: FinishTaskRequest): TaskCommandResponse;
  /** Launching the agent to delegate to, when the request asks, is the only async step. */
  delegate(caller: Caller, req: DelegateTaskRequest): Promise<CreateTaskResponse>;
  escalate(caller: Caller, req: EscalateRequest): EscalateResponse;
  /** A message to the agent: the human's, or another agent's own words. */
  send(caller: Caller, agentId: string, req: SendMessageRequest): SendMessageResponse;
}

/** Thrown for a caller that says it is an agent with something that is no agent's id. */
class NotAnAgent extends Error {}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PAIRING_PATH = "/v1/pairing";

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

  const { gate } = deps;
  if (gate !== undefined) {
    // The API only: the page holds no secret, and must load unpaired to show the pairing form.
    app.use("/v1/*", async (c, next) => {
      if (c.req.method === "POST" && c.req.path === PAIRING_PATH) return next();
      const header = (name: string) => c.req.header(name);
      const required = mustPair(gate, header);
      const origin = header("origin");
      // A page elsewhere can't even read; a paired browser acts only from an allowed origin,
      // which it always sends then. SameSite is the second layer.
      if (origin !== undefined && !allow?.origins.includes(origin)) {
        return required ? fail(c, 403, "origin_not_allowed", origin) : next();
      }
      // SameSite ignores ports, so a page on another local port also sends the cookie, without
      // Origin on a plain GET such as an image's. Only the daemon's own page, or a client that
      // isn't a browser and so sends no Sec-Fetch-Site, keeps the device alive.
      const fetchSite = header("sec-fetch-site");
      const presented = tokenFrom(header("cookie"));
      const verified = gate.devices.verify(presented, {
        remote: arrivedRemotely(header),
        touch: fetchSite === undefined || fetchSite === "same-origin",
      });
      if (required) {
        if (verified === null)
          return fail(c, 401, "unpaired", "pair this browser: run `bazhen pair`");
        if (!SAFE_METHODS.has(c.req.method) && origin === undefined) {
          return fail(c, 403, "origin_not_allowed", "");
        }
      }
      await next();
      if (verified?.refresh === true && presented !== undefined)
        c.header("set-cookie", deviceCookie(presented.token, verified.device.secure), {
          append: true,
        });
    });
  }

  const { pairing } = deps;
  if (pairing !== undefined) {
    app.post(PAIRING_PATH, async (c) => {
      const origin = c.req.header("origin");
      if (origin === undefined) return fail(c, 403, "origin_not_allowed", "");
      const body = PairRequest.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return invalid(c, body.error);
      const attempt = pairing.codes.attempt(body.data.code, origin);
      if (attempt.kind === "rate_limited") {
        c.header("retry-after", String(attempt.retryAfterSeconds));
        return fail(c, 429, "rate_limited", "too many attempts; wait a minute");
      }
      if (attempt.kind === "failed") {
        return fail(c, 401, "pairing_failed", "that code is wrong or has expired");
      }
      // HTTPS gets the cookie only HTTPS can carry; plain HTTP is loopback (§9.2).
      const secure = origin.startsWith("https:");
      const { deviceId, name, token } = pairing.devices.pair(body.data.name, secure);
      c.header("set-cookie", deviceCookie(token, secure));
      const res: PairResponse = { deviceId, name };
      return c.json(res);
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

  app.post("/v1/shells", async (c) => {
    const body = OpenShellRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return invalid(c, body.error);
    return c.json(await deps.openShell(body.data));
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
  route("/v1/agents/:id/close", CloseAgentRequest, deps.close);
  route("/v1/agents/:id/respawn", RespawnAgentRequest, deps.respawn);
  route("/v1/agents/:id/relaunch", RelaunchAgentRequest, deps.relaunch);
  route("/v1/agents/:id/signal", SignalAgentRequest, deps.signal);
  route("/v1/attention/:id/answer", AnswerAttentionRequest, deps.answer);
  route("/v1/shells/:id/close", CloseShellRequest, deps.closeShell);
  route("/v1/attention/:id/reply", ReplyAttentionRequest, deps.reply);
  route("/v1/attention/:id/dismiss", DismissAttentionRequest, deps.dismiss);
  route("/v1/attention/:id/resend", ResendAttentionRequest, deps.resend);
  route("/v1/shells/:id/restart", RestartShellRequest, deps.restartShell);
  route("/v1/shells/:id/rename", RenameShellRequest, deps.renameShell);
  route("/v1/shells/:id/unlink", UnlinkShellRequest, deps.unlinkShell);

  // Only the Unix socket's callers can be agents: a browser over TCP is always the human, so no
  // page can act as an agent, whatever header it sends (§9.1, §9.4).
  const callerOf = (c: Context): Caller => {
    const said = allow === null ? c.req.header("bazhen-agent-id") : undefined;
    if (said === undefined) return null;
    if (!isId("agent", said)) throw new NotAnAgent(`not an agent id: ${said}`);
    return said;
  };
  const taskRoute = <T, R>(
    path: string,
    schema: z.ZodType<T>,
    run: (caller: Caller, id: string, req: T) => R,
  ) =>
    app.post(path, async (c) => {
      const body = schema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return invalid(c, body.error);
      return c.json(await run(callerOf(c), c.req.param("id") ?? "", body.data));
    });
  const { tasks } = deps;
  taskRoute("/v1/tasks", CreateTaskRequest, (caller, _id, req) => tasks.create(caller, req));
  taskRoute("/v1/tasks/delegate", DelegateTaskRequest, (caller, _id, req) =>
    tasks.delegate(caller, req),
  );
  taskRoute("/v1/escalations", EscalateRequest, (caller, _id, req) => tasks.escalate(caller, req));
  taskRoute("/v1/agents/:id/messages", SendMessageRequest, (...a) => tasks.send(...a));
  taskRoute("/v1/tasks/:id/assign", AssignTaskRequest, (...a) => tasks.assign(...a));
  taskRoute("/v1/tasks/:id/unassign", UnassignTaskRequest, (...a) => tasks.unassign(...a));
  taskRoute("/v1/tasks/:id/finish", FinishTaskRequest, (...a) => tasks.finish(...a));
  app.get("/v1/tasks/:id", (c) => {
    const detail = tasks.show(c.req.param("id"));
    if (detail === undefined) throw new UnknownTask(c.req.param("id"));
    return c.json(detail);
  });

  // Last, so it answers only a path no API route did.
  if (deps.web !== undefined) app.get("*", webPage(deps.web.root));

  // Typed failures from the domain become protocol errors in one place; anything else is a bug.
  app.onError((err, c) => {
    if (err instanceof UnsupportedHarness) return fail(c, 422, "unsupported", err.message);
    if (err instanceof InvalidDirectory) return fail(c, 400, "invalid_request", err.message);
    if (err instanceof LaunchFailed) return fail(c, 502, "launch_failed", err.message);
    if (err instanceof HarnessRefused) return fail(c, 502, "launch_failed", failureDetail(err));
    if (err instanceof IdempotencyConflict) return fail(c, 409, "conflict", err.message);
    if (err instanceof AttentionClosed) return fail(c, 409, "conflict", err.message);
    if (err instanceof AttentionRefused) return fail(c, 409, "conflict", err.message);
    if (err instanceof AttentionUnavailable) return fail(c, 503, "unavailable", err.message);
    if (err instanceof UnknownAgent || err instanceof UnknownShell)
      return fail(c, 404, "not_found", err.message);
    if (err instanceof ShellBusy) {
      const body: ErrorResponse = { error: "busy", message: err.message, busy: [...err.busy] };
      return c.json(body, 409);
    }
    if (err instanceof ShellOpenFailed) return fail(c, 502, "launch_failed", err.message);
    if (err instanceof ShellsUnsettled) return fail(c, 503, "unavailable", err.message);
    if (err instanceof UnknownTask) return fail(c, 404, "not_found", err.message);
    if (err instanceof MailTooLong) return fail(c, 400, "invalid_request", err.message);
    if (err instanceof NotAnAgent) return fail(c, 400, "invalid_request", err.message);
    if (err instanceof TaskRefused) {
      return err.code === "forbidden"
        ? fail(c, 403, "forbidden", err.message)
        : fail(c, 409, "conflict", err.message);
    }
    if (err instanceof StaleGeneration) return fail(c, 409, "stale_generation", err.message);
    if (err instanceof NotResumable) return fail(c, 409, "not_resumable", err.message);
    if (err instanceof ServerUnconfirmed) return fail(c, 409, "server_unconfirmed", err.message);
    const conflict = [
      AgentGone,
      StateConflict,
      TerminalReplaced,
      NoTerminal,
      ProcessState,
      AgentTerminalExists,
    ].some((e) => err instanceof e);
    if (conflict) return fail(c, 409, "conflict", err.message);
    if (err instanceof EnvironmentUnavailable) return fail(c, 503, "unavailable", err.message);
    throw err;
  });

  return app;
}
