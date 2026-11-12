import { z } from "zod";
import { ExternalRef, HarnessId } from "./agents.ts";
import { AttachmentMode, EnvironmentKind, Id } from "./ids.ts";
import { ApprovalDecision, AttentionCloseReason } from "./mail.ts";

/**
 * Every event type the store accepts, with the entity it is about and its payload. A row adds
 * the types it emits here; payloads never carry message bodies, terminal bytes or secrets
 * (foundation-design §5.2).
 */
export const EVENTS = {
  "environment.registered": {
    entity: "environment",
    payload: z.object({ kind: EnvironmentKind }),
  },
  "agent.launched": {
    entity: "agent",
    payload: z.object({
      environmentId: Id("env"),
      harness: HarnessId,
      project: z.string(),
      cwd: z.string(),
      terminalId: Id("term").nullable(),
    }),
  },
  "agent.running": {
    entity: "agent",
    payload: z.object({
      externalRef: ExternalRef.nullable(),
      /** The terminal's runtime incarnation, as RuntimeRef names it; null with no local terminal. */
      runtimeRef: z
        .object({ runtime: z.string(), locator: z.record(z.string(), z.string()) })
        .nullable(),
    }),
  },
  "agent.failed": {
    entity: "agent",
    payload: z.object({ reason: z.enum(["launch_rejected"]) }),
  },
  /** A reachable environment no longer has the agent's terminal (§4.5, §7.1). */
  "agent.lost": { entity: "agent", payload: z.object({}) },
  /** A view opened a terminal's stream (foundation-design §4.2). */
  "attachment.started": {
    entity: "attachment",
    payload: z.object({ terminalId: Id("term"), mode: AttachmentMode }),
  },
  /** Ending an attachment releases its lease, and never touches the terminal's process. */
  "attachment.ended": {
    entity: "attachment",
    payload: z.object({
      reason: z.enum(["client_closed", "terminal_closed", "attach_failed", "daemon_restart"]),
    }),
  },
  /** A message for an agent, delivered at least once through its harness (§4.7, §5.6). */
  "mailbox.queued": {
    entity: "message",
    payload: z.object({ agentId: Id("agent"), body: z.string() }),
  },
  /** A hook took the message to hand to the harness. */
  "mailbox.offered": { entity: "message", payload: z.object({}) },
  /** The hook client wrote it where the harness reads it. */
  "mailbox.emitted": { entity: "message", payload: z.object({}) },
  /** A prompt carrying its id started; that prompt's end delivers it. */
  "mailbox.seen": { entity: "message", payload: z.object({ promptId: z.string() }) },
  "mailbox.delivered": { entity: "message", payload: z.object({}) },
  "mailbox.requeued": {
    entity: "message",
    payload: z.object({ reason: z.enum(["not_written", "daemon_restart"]) }),
  },
  /** A harness asks the human, here to run a tool (§4.6, §5.6). */
  "attention.opened": {
    entity: "attention",
    payload: z.object({
      agentId: Id("agent"),
      summary: z.string(),
      /** The tool call it is for, whose result closes it; null if no call was seen to start. */
      toolUseId: z.string().nullable(),
      /** Asked by the agent itself, whose turn ending closes it, rather than by a subagent. */
      mainAgent: z.boolean(),
    }),
  },
  "attention.answered": { entity: "attention", payload: z.object({ decision: ApprovalDecision }) },
  "attention.closed": {
    entity: "attention",
    payload: z.object({ reason: AttentionCloseReason.exclude(["answered"]) }),
  },
  /** An engaged view became the terminal's driver; the epoch rises on every grant (§4.3). */
  "lease.granted": {
    entity: "terminal",
    payload: z.object({ attachmentId: Id("att"), epoch: z.number().int().positive() }),
  },
} as const;

export type EventType = keyof typeof EVENTS;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENTS)[T]["payload"]>;
