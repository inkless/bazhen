import { z } from "zod";
import { Id, IdempotencyKey } from "./ids.ts";
import { ProtocolVersion } from "./version.ts";

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

export const AttentionState = z.enum(["open", "closed"]);
export type AttentionState = z.infer<typeof AttentionState>;

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

export const ApprovalDecision = z.enum(["allow", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const Message = z.object({ id: Id("msg"), agentId: Id("agent"), state: MailboxState });
export type Message = z.infer<typeof Message>;

/** Something that needs the human: in M1, a harness asking to run a tool. */
export const Attention = z.object({
  id: Id("attn"),
  agentId: Id("agent"),
  state: AttentionState,
  closeReason: AttentionCloseReason.nullable(),
  summary: z.string(),
});
export type Attention = z.infer<typeof Attention>;

export const SendMessageRequest = z.object({
  idempotencyKey: IdempotencyKey,
  body: z.string().min(1).max(20_000),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({
  messageId: Id("msg"),
  eventIds: z.array(z.number().int().positive()),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const AnswerAttentionRequest = z.object({
  idempotencyKey: IdempotencyKey,
  decision: ApprovalDecision,
});
export type AnswerAttentionRequest = z.infer<typeof AnswerAttentionRequest>;

export const AnswerAttentionResponse = z.object({
  eventIds: z.array(z.number().int().positive()),
});
export type AnswerAttentionResponse = z.infer<typeof AnswerAttentionResponse>;

/**
 * What the hook client sends for every hook a harness runs, over the daemon's Unix socket
 * (foundation-design §5.6). `payload` is the harness's own hook input, passed through.
 */
export const HookRequest = z.object({
  protocolVersion: ProtocolVersion,
  agentId: Id("agent"),
  event: z.string().min(1),
  pid: z.number().int(),
  ppid: z.number().int(),
  payload: z.unknown(),
});
export type HookRequest = z.infer<typeof HookRequest>;

/** What the hook client prints and exits with, verbatim; it knows no harness format. */
export const HookReply = z.object({
  exitCode: z.number().int().min(0).max(255),
  stdout: z.string(),
  stderr: z.string(),
  /** Messages this reply hands to the harness; the client acks them once it has written. */
  offered: z.array(Id("msg")),
});
export type HookReply = z.infer<typeof HookReply>;

export const HookAck = z.object({ agentId: Id("agent"), offered: z.array(Id("msg")) });
export type HookAck = z.infer<typeof HookAck>;
