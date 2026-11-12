import { z } from "zod";
import { EnvironmentKind, Id, IdempotencyKey } from "./ids.ts";
import { Attention, Message } from "./mail.ts";

export const HarnessId = z.enum(["claude-code", "codex"]);
export type HarnessId = z.infer<typeof HarnessId>;

/** foundation-design §4.5. */
export const AgentState = z.enum([
  "starting",
  "running",
  "exited",
  "unknown",
  "lost",
  "closing",
  "closed",
  "failed",
]);
export type AgentState = z.infer<typeof AgentState>;

/** What an agent's process can be sent, in place of typing a key into it (foundation-design §8.2). */
export const Signal = z.enum(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]);
export type Signal = z.infer<typeof Signal>;

/**
 * How a process ended: with an exit code, or killed by a signal named as in `SIGTERM`. Unknown when
 * the runtime knows the process is gone but not how it ended.
 */
export const ExitStatus = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exited"), code: z.number().int() }),
  z.object({ type: z.literal("signalled"), signal: z.string() }),
  z.object({ type: z.literal("unknown") }),
]);
export type ExitStatus = z.infer<typeof ExitStatus>;

/** A harness- or server-side object, such as a Claude Code session or a Codex thread. */
export const ExternalRef = z.object({
  environmentId: Id("env"),
  kind: z.enum(["claude-session", "codex-thread"]),
  id: z.string().min(1),
});
export type ExternalRef = z.infer<typeof ExternalRef>;

export const Environment = z.object({
  id: Id("env"),
  kind: EnvironmentKind,
});
export type Environment = z.infer<typeof Environment>;

export const Agent = z.object({
  id: Id("agent"),
  environmentId: Id("env"),
  harness: HarnessId,
  project: z.string(),
  cwd: z.string(),
  state: AgentState,
  terminalId: Id("term").nullable(),
  /** Its terminal's incarnation; a command on the agent names the one it expects (§3). */
  generation: z.number().int().nonnegative().nullable(),
  externalRef: ExternalRef.nullable(),
  /** How its process ended, once it has. */
  exit: ExitStatus.nullable(),
});
export type Agent = z.infer<typeof Agent>;

export const LaunchAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  harness: HarnessId,
  /** An absolute path, or `~` or `~/…` for the daemon user's home. */
  cwd: z.string().min(1),
  project: z.string().min(1).optional(),
});
export type LaunchAgentRequest = z.infer<typeof LaunchAgentRequest>;

/** A mutation's result names the events it produced, so a client can wait for them. */
export const LaunchAgentResponse = z.object({
  agentId: Id("agent"),
  terminalId: Id("term").nullable(),
  eventIds: z.array(z.number().int().positive()),
});
export type LaunchAgentResponse = z.infer<typeof LaunchAgentResponse>;

/** Ends an agent and its terminal (§4.5). A stale generation is refused with the current one. */
export const CloseAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
});
export type CloseAgentRequest = z.infer<typeof CloseAgentRequest>;

/** Starts an exited agent again on its harness session, at the next generation (§4.5). */
export const RespawnAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
});
export type RespawnAgentRequest = z.infer<typeof RespawnAgentRequest>;

/** Signals a running agent's process, in place of typing a key into it. */
export const SignalAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
  signal: Signal,
});
export type SignalAgentRequest = z.infer<typeof SignalAgentRequest>;

/** What a command on an agent produced: the events it recorded, none if there was nothing to do. */
export const AgentCommandResponse = z.object({
  agentId: Id("agent"),
  eventIds: z.array(z.number().int().positive()),
});
export type AgentCommandResponse = z.infer<typeof AgentCommandResponse>;

/** Projections, consistent as of `eventId` in store `epoch`: resume the event stream there. */
export const StateSnapshot = z.object({
  epoch: z.string(),
  eventId: z.number().int().nonnegative(),
  environments: z.array(Environment),
  agents: z.array(Agent),
  attention: z.array(Attention),
  messages: z.array(Message),
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

export const ErrorResponse = z.object({
  error: z.enum([
    "invalid_request",
    "unsupported",
    "launch_failed",
    "conflict",
    "stale_generation",
    "not_resumable",
    "unavailable",
    "not_found",
    "origin_not_allowed",
    "host_not_allowed",
    "forbidden",
  ]),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** `POST /v1/daemon/stop`, on the Unix socket only: the daemon stops once it has sent this. */
export const StopResponse = z.object({});
export type StopResponse = z.infer<typeof StopResponse>;
