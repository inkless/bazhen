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
  /** The human replied, as mail to the agent or as the answer to its question. */
  "replied",
  /** The human saw it and put it away. */
  "dismissed",
  /** The human sent the undelivered message again, as a new one. */
  "resent",
]);
export type AttentionCloseReason = z.infer<typeof AttentionCloseReason>;

export const ApprovalDecision = z.enum(["allow", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const Message = z.object({ id: Id("msg"), agentId: Id("agent"), state: MailboxState });
export type Message = z.infer<typeof Message>;

/**
 * What an item is about (foundation-design §4.6): a harness asking to run a tool, a question
 * the agent asked, a turn that failed, mail that could not be delivered, or something the agent
 * or a task raised for the human.
 */
export const AttentionKind = z.enum([
  "approval",
  "question",
  "failed",
  "undeliverable",
  "escalation",
  "task_done",
]);
export type AttentionKind = z.infer<typeof AttentionKind>;

/** What the human can do about an open item now; the daemon decides, the client never guesses. */
export const AttentionAction = z.enum(["allow", "deny", "reply", "resend", "dismiss"]);
export type AttentionAction = z.infer<typeof AttentionAction>;

/** Something that needs the human. */
export const Attention = z.object({
  id: Id("attn"),
  agentId: Id("agent"),
  state: AttentionState,
  closeReason: AttentionCloseReason.nullable(),
  summary: z.string(),
  kind: AttentionKind,
  /** The task it is about, for an item a task raised. */
  taskId: z.string().nullable(),
  /** The message it is about, for mail that could not be delivered. */
  messageId: Id("msg").nullable(),
  /** When it opened, as an ISO timestamp. */
  openedAt: z.iso.datetime(),
  /** Empty once it is closed, and for a question only its terminal can answer. */
  actions: z.array(AttentionAction),
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

/** A reply to an item that offers `reply`; it reaches the agent as mail. */
export const ReplyAttentionRequest = SendMessageRequest;
export type ReplyAttentionRequest = z.infer<typeof ReplyAttentionRequest>;

export const ReplyAttentionResponse = z.object({
  /** The message carrying the reply, whose delivery the mailbox reports. */
  messageId: Id("msg"),
  eventIds: z.array(z.number().int().positive()),
});
export type ReplyAttentionResponse = z.infer<typeof ReplyAttentionResponse>;

export const DismissAttentionRequest = z.object({ idempotencyKey: IdempotencyKey });
export type DismissAttentionRequest = z.infer<typeof DismissAttentionRequest>;

export const DismissAttentionResponse = AnswerAttentionResponse;
export type DismissAttentionResponse = z.infer<typeof DismissAttentionResponse>;

/**
 * Sends an undelivered message's text again, as a new message with attempts of its own: the
 * one given up on stays undeliverable, as every final state does (foundation-design §4.7).
 */
export const ResendAttentionRequest = DismissAttentionRequest;
export type ResendAttentionRequest = z.infer<typeof ResendAttentionRequest>;

export const ResendAttentionResponse = ReplyAttentionResponse;
export type ResendAttentionResponse = z.infer<typeof ResendAttentionResponse>;

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

/** `<message id>-<offer id>`; plain token characters, so every client echoes it verbatim. */
export const OfferToken = z.string().regex(/^msg_[0-9a-f]{32}-[0-9a-z]{1,32}$/);
export type OfferToken = z.infer<typeof OfferToken>;

/** The token for one offer of a message. */
export const offerToken = (messageId: string, offer: string): OfferToken => `${messageId}-${offer}`;

/** The message an offer token is for. */
export const offeredMessage = (token: OfferToken): string => token.slice(0, token.indexOf("-"));

/**
 * What the hook client prints and exits with, verbatim; it knows no harness format.
 *
 * On the wire it is framed rather than JSON, so a client with no JSON parser (a std-only binary,
 * a `sh` + `curl` script) can read it byte for byte: `Content-Type` is `HOOK_REPLY_TYPE`,
 * `Content-Length` is set, `Bazhen-Exit-Code` carries `exitCode`, `Bazhen-Offered` the
 * comma-separated `offered` tokens, `Bazhen-Stdout-Bytes` the UTF-8 length of `stdout`, and the body
 * is `stdout` then `stderr`. A client fails open on anything else, or on a body over
 * `HOOK_REPLY_MAX_BYTES`.
 */
export const HookReply = z.object({
  exitCode: z.number().int().min(0).max(255),
  stdout: z.string(),
  stderr: z.string(),
  /**
   * One token per message this reply hands to the harness, which the client acks once it has
   * written: the message's id and this offer's own, so an ack names the offer it confirms and a
   * late one for an earlier offer of the same message confirms nothing (protocol 1.9).
   */
  offered: z.array(OfferToken),
});
export type HookReply = z.infer<typeof HookReply>;

export const HOOK_REPLY_TYPE = "application/vnd.bazhen.hook-reply";

/** Clients refuse a larger body, so the daemon never offers more mail than one reply holds. */
export const HOOK_REPLY_MAX_BYTES = 1 << 20;

/** A reply as `HookReply` documents its framing: the headers, and stdout then stderr. */
export function frameHookReply(reply: HookReply): {
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
} {
  const encoder = new TextEncoder();
  const stdout = encoder.encode(reply.stdout);
  const stderr = encoder.encode(reply.stderr);
  const body = new Uint8Array(stdout.length + stderr.length);
  body.set(stdout);
  body.set(stderr, stdout.length);
  return {
    headers: {
      "content-type": HOOK_REPLY_TYPE,
      "content-length": String(body.length),
      "bazhen-exit-code": String(reply.exitCode),
      "bazhen-offered": reply.offered.join(","),
      "bazhen-stdout-bytes": String(stdout.length),
    },
    body,
  };
}

export const HookAck = z.object({ agentId: Id("agent"), offered: z.array(OfferToken) });
export type HookAck = z.infer<typeof HookAck>;
