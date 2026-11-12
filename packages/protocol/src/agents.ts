import { z } from "zod";
import { EnvironmentKind, Id } from "./ids.ts";

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
  externalRef: ExternalRef.nullable(),
});
export type Agent = z.infer<typeof Agent>;

/**
 * Every mutation carries a key chosen by the client; repeating it returns the first answer
 * instead of acting twice (foundation-design §5.1).
 */
export const IdempotencyKey = z.string().min(1).max(200);

export const LaunchAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  harness: HarnessId,
  cwd: z.string().startsWith("/"),
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

/** Projections, consistent as of `eventId`: resume the event stream after it. */
export const StateSnapshot = z.object({
  eventId: z.number().int().nonnegative(),
  environments: z.array(Environment),
  agents: z.array(Agent),
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

export const ErrorResponse = z.object({
  error: z.enum([
    "invalid_request",
    "unsupported",
    "launch_failed",
    "origin_not_allowed",
    "host_not_allowed",
  ]),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
