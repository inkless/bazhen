import { z } from "zod";
import { ExternalRef, HarnessId } from "./agents.ts";
import { AttachmentMode, EnvironmentKind, Id } from "./ids.ts";

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
  /** An engaged view became the terminal's driver; the epoch rises on every grant (§4.3). */
  "lease.granted": {
    entity: "terminal",
    payload: z.object({ attachmentId: Id("att"), epoch: z.number().int().positive() }),
  },
} as const;

export type EventType = keyof typeof EVENTS;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENTS)[T]["payload"]>;
