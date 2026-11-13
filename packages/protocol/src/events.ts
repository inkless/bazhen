import { z } from "zod";
import { Activity, ExitStatus, ExternalRef, HarnessId, Signal } from "./agents.ts";
import { AttachmentMode, EnvironmentKind, Id } from "./ids.ts";
import { ApprovalDecision, AttentionCloseReason } from "./mail.ts";
import { ProtocolVersion } from "./version.ts";

const queued = z.object({ agentId: Id("agent"), body: z.string() });

/** A terminal's runtime incarnation, as RuntimeRef names it, minus the terminal it is for. */
const RuntimeRefPayload = z.object({
  runtime: z.string(),
  locator: z.record(z.string(), z.string()),
});

/**
 * Every event type the store accepts, with the entity it is about and its payload. A row adds
 * the types it emits here. Payloads never carry terminal bytes or secrets; a type whose payload
 * holds more than a client may see names the narrower shape it is `streamed` in
 * (foundation-design §5.2).
 */
export const EVENTS = {
  "environment.registered": {
    entity: "environment",
    payload: z.object({ kind: EnvironmentKind }),
  },
  /**
   * A harness's own server answers on a version other than the last one recorded, as after a
   * Codex self-update, which nothing announces but the socket ending (foundation-design §5.8).
   */
  "environment.harness_version": {
    entity: "environment",
    payload: z.object({
      harness: HarnessId,
      version: z.string().min(1),
      /** Null for the first version recorded. */
      previous: z.string().nullable(),
    }),
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
      /** Null with no local terminal. */
      runtimeRef: RuntimeRefPayload.nullable(),
    }),
  },
  "agent.failed": {
    entity: "agent",
    /** `daemon_restart`: the daemon died mid-launch, and its terminal never appeared (§7.1). */
    payload: z.object({ reason: z.enum(["launch_rejected", "daemon_restart"]) }),
  },
  /** A reachable environment no longer has the agent's terminal (§4.5, §7.1). */
  "agent.lost": { entity: "agent", payload: z.object({}) },
  /** A respawn was asked for; the terminal is still the exited one until the next event. */
  "agent.respawn_requested": { entity: "agent", payload: z.object({}) },
  /** The terminal runs again, at the next generation, on the agent's harness session. */
  "agent.respawned": {
    entity: "agent",
    payload: z.object({
      externalRef: ExternalRef.nullable(),
      runtimeRef: RuntimeRefPayload,
    }),
  },
  /** The respawn failed; the agent is exited again, with its terminal, and still closable. */
  "agent.respawn_rejected": {
    entity: "agent",
    payload: z.object({
      /** `daemon_restart`: the daemon died mid-respawn, before the new process started (§7.1). */
      reason: z.enum([
        "not_resumable",
        "no_terminal",
        "terminal_changed",
        "unavailable",
        "daemon_restart",
      ]),
    }),
  },
  /**
   * The agent is bound to another harness session, which its own process moved to, such as a
   * Claude Code `/clear` or fork, or a Codex TUI's `/new`, `/fork` or `/resume` (foundation-design
   * §3.1, §5.8). Respawn resumes this one.
   */
  "agent.external_ref_updated": {
    entity: "agent",
    payload: z.object({ externalRef: ExternalRef }),
  },
  /** The agent's process was sent a signal; any exit it causes is recorded on its own. */
  "agent.signalled": { entity: "agent", payload: z.object({ signal: Signal }) },
  /** The agent's harness reported what it is doing; the latest per process is kept (§4.6). */
  "agent.activity": { entity: "agent", payload: Activity },
  /** The agent's process ended; its terminal stays, with its last screen (§4.1, §4.5). */
  "agent.exited": { entity: "agent", payload: z.object({ exit: ExitStatus }) },
  /** A close was asked for. Recorded before the terminal is touched, so a view that loses its
   * terminal next can tell a close from a disconnect. */
  "agent.closing": { entity: "agent", payload: z.object({}) },
  /** The agent's terminal is gone, and the agent with it. */
  "agent.closed": { entity: "agent", payload: z.object({}) },
  /** A view opened a terminal's stream (foundation-design §4.2). */
  "attachment.started": {
    entity: "attachment",
    payload: z.object({ terminalId: Id("term"), mode: AttachmentMode }),
  },
  /** Ending an attachment releases its lease, and never touches the terminal's process. */
  "attachment.ended": {
    entity: "attachment",
    payload: z.object({
      reason: z.enum([
        "client_closed",
        "terminal_closed",
        "attach_failed",
        "daemon_restart",
        "disconnected",
        "evicted_slow",
      ]),
    }),
  },
  /** A message for an agent, delivered at least once through its harness (§4.7, §5.6). */
  "mailbox.queued": {
    entity: "message",
    payload: queued,
    /** The mailbox needs the body; the stream leaves it out, as `/v1/state` does. */
    streamed: queued.omit({ body: true }),
  },
  /** A hook took the message to hand to the harness. */
  "mailbox.offered": { entity: "message", payload: z.object({}) },
  /** The hook client wrote it where the harness reads it. */
  "mailbox.emitted": { entity: "message", payload: z.object({}) },
  /** A prompt carrying its id started; that prompt's end delivers it. */
  "mailbox.seen": { entity: "message", payload: z.object({ promptId: z.string() }) },
  "mailbox.delivered": { entity: "message", payload: z.object({}) },
  /**
   * `codex queue` stored it in Codex, on a live app-server or, `offline`, in the Codex home. It is
   * delivered only once the turn carrying it is seen (§5.8).
   */
  "mailbox.accepted": { entity: "message", payload: z.object({ offline: z.boolean() }) },
  /** It will never reach its agent: the agent closed, or every attempt to hand it over failed. */
  "mailbox.undeliverable": {
    entity: "message",
    payload: z.object({ reason: z.enum(["agent_closed", "gave_up"]) }),
  },
  "mailbox.requeued": {
    entity: "message",
    payload: z.object({
      reason: z.enum([
        "not_written",
        "daemon_restart",
        /** The session started over, as /clear does, before the agent saw it. */
        "session_started",
      ]),
    }),
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

const isEventType = (type: string): type is EventType => Object.hasOwn(EVENTS, type);

const eventBranch = (type: EventType) => {
  const entry: { readonly payload: z.ZodType; readonly streamed?: z.ZodType } = EVENTS[type];
  return z.object({
    id: z.number().int().positive(),
    ts: z.string(),
    type: z.literal(type),
    entityType: z.literal(EVENTS[type].entity),
    entityId: z.string(),
    actor: z.string(),
    causationId: z.number().int().positive().nullable(),
    correlationId: z.string().nullable(),
    payload: entry.streamed ?? entry.payload,
  });
};

/**
 * One event as the stream sends it: a branch per registered type, each checking its own
 * payload. Clients skip types they don't know, so registering one breaks no older client.
 */
export const Event = z.union(Object.keys(EVENTS).filter(isEventType).map(eventBranch));
export type Event = z.infer<typeof Event>;

/**
 * The query that opens `/v1/events`: the client's protocol version, and the cursor `/v1/state`
 * or the last event it saw gave it. The stream resumes after `after`.
 */
export const EventStreamQuery = z.object({
  v: ProtocolVersion,
  epoch: z.string().min(1),
  after: z.string().regex(/^\d+$/),
});
export type EventStreamQuery = z.infer<typeof EventStreamQuery>;

/** Why a cursor can't be resumed: older than retention, or not from this store. */
export const ResetReason = z.enum(["stale", "foreign"]);
export type ResetReason = z.infer<typeof ResetReason>;

/** Text frames on `/v1/events`; the client sends none. */
export const EventFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: Event }),
  /**
   * The cursor can't be resumed: older than retention (`stale`), or not from this store
   * (`foreign`). Re-read `/v1/state` and resume from its cursor.
   */
  z.object({ type: z.literal("reset"), reason: ResetReason }),
]);
export type EventFrame = z.infer<typeof EventFrame>;
