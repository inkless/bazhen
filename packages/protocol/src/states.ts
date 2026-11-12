import { z } from "zod";

/** foundation-design §4.1. */
export const TerminalState = z.enum([
  "creating",
  "running",
  "exited",
  "unknown",
  "lost",
  "closing",
  "closed",
  "failed",
]);
export type TerminalState = z.infer<typeof TerminalState>;

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

/** foundation-design §4.4. */
export const EnvironmentHealthState = z.enum([
  "unknown",
  "reachable",
  "unreachable",
  "auth_failed",
  "version_unsupported",
]);
export type EnvironmentHealthState = z.infer<typeof EnvironmentHealthState>;

/** foundation-design §4.6. */
export const AttentionState = z.enum(["open", "closed"]);
export type AttentionState = z.infer<typeof AttentionState>;

/** foundation-design §4.7. */
export const MailboxState = z.enum([
  "queued",
  "offered",
  "emitted",
  "seen",
  "queued_in_codex",
  "delivered",
  "undeliverable",
]);
export type MailboxState = z.infer<typeof MailboxState>;

/** Why an attention item closed (foundation-design §4.6, §5.6, §5.8). */
export const AttentionCloseReason = z.enum([
  "answered",
  "answered_in_tui",
  "timed_out",
  "superseded",
  "agent_closed",
  "stale",
]);
export type AttentionCloseReason = z.infer<typeof AttentionCloseReason>;
