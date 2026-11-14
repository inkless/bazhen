import { z } from "zod";
import { Activity, Usage, ExitStatus, ExternalRef, HarnessId, Signal } from "./agents.ts";
import { TuiTheme } from "./theme.ts";
import { AttachmentMode, EnvironmentKind, Id } from "./ids.ts";
import { ApprovalDecision, AttentionCloseReason, AttentionKind } from "./mail.ts";
import { Role, TaskBrief, TaskOutcome, TaskTitle } from "./tasks.ts";
import { ProtocolVersion } from "./version.ts";

const queued = z.object({
  agentId: Id("agent"),
  body: z.string(),
  /**
   * The agent whose own words the body is, after a line naming it that the body starts with;
   * absent for the human's mail and for mail Bazhen composes, as a task's. Absent before protocol
   * 1.35.
   */
  from: Id("agent").optional(),
});
const taskCreated = z.object({
  title: TaskTitle,
  brief: TaskBrief,
  ownerAgentId: Id("agent").nullable(),
  parentTaskId: Id("task").nullable(),
  /**
   * The assignment an agent delegated it under, whose ending moves the task up to the parent's
   * owner; null when delegated as the parent's owner. Absent before protocol 1.25.
   */
  delegatedFrom: Id("asgn").nullable().optional(),
});
const taskFinished = z.object({ outcome: TaskOutcome, note: z.string().nullable() });
const transcript = z.object({
  sessionId: z.string().min(1),
  path: z.string().startsWith("/").max(4096),
});

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
      /** The agent that launched it to delegate to it; absent when the human did (1.31). */
      launchedBy: Id("agent").optional(),
    }),
  },
  "agent.running": {
    entity: "agent",
    payload: z.object({
      externalRef: ExternalRef.nullable(),
      /** Null with no local terminal. */
      runtimeRef: RuntimeRefPayload.nullable(),
      /** The theme the TUI was started for, when one was named. */
      theme: TuiTheme.optional(),
    }),
  },
  "agent.failed": {
    entity: "agent",
    payload: z.object({
      /** `daemon_restart`: the daemon died mid-launch, and its terminal never appeared (§7.1). */
      reason: z.enum(["launch_rejected", "daemon_restart"]),
      /**
       * Protocol 1.34. What went wrong, in the failure's own words with secrets taken out, at most
       * 500 characters counted as a person sees them (grapheme clusters, not UTF-16 units).
       */
      detail: z.string().optional(),
    }),
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
      /** The theme the TUI was started for, when one was named. */
      theme: TuiTheme.optional(),
    }),
  },
  /** The respawn failed; the agent is exited again, with its terminal, and still closable. */
  "agent.respawn_rejected": {
    entity: "agent",
    payload: z.object({
      /**
       * `harness_refused`: the harness's server answered that it won't resume the session (protocol
       * 1.34). `daemon_restart`: the daemon died mid-respawn, before the new process started (§7.1).
       */
      reason: z.enum([
        "not_resumable",
        "no_terminal",
        "terminal_changed",
        "harness_refused",
        "unavailable",
        "daemon_restart",
      ]),
      /**
       * Protocol 1.34. What went wrong, in the failure's own words with secrets taken out, at most
       * 500 characters counted as a person sees them (grapheme clusters, not UTF-16 units).
       */
      detail: z.string().optional(),
    }),
  },
  /**
   * A lost agent is starting again, on a new terminal at `generation`; the lost one stays lost
   * (foundation-design §4.1).
   */
  "agent.relaunch_requested": {
    entity: "agent",
    payload: z.object({
      terminalId: Id("term"),
      generation: z.number().int().positive(),
      /** On a new harness session, which the old one's conversation doesn't carry into. */
      fresh: z.boolean(),
    }),
  },
  /** The relaunched agent's new terminal runs, on the harness session it started with. */
  "agent.relaunched": {
    entity: "agent",
    payload: z.object({
      externalRef: ExternalRef.nullable(),
      runtimeRef: RuntimeRefPayload,
      /** The theme the TUI was started for, when one was named. */
      theme: TuiTheme.optional(),
    }),
  },
  /** The relaunch failed: its new terminal failed, and the agent is lost on its old one again. */
  "agent.relaunch_rejected": {
    entity: "agent",
    payload: z.object({
      /**
       * `harness_refused`: the harness's server answered that it won't start the session (protocol
       * 1.34). `daemon_restart`: the daemon died mid-relaunch, and the new terminal never appeared.
       */
      reason: z.enum([
        "not_resumable",
        "terminal_exists",
        "harness_refused",
        "unavailable",
        "daemon_restart",
      ]),
      /**
       * Protocol 1.34. What went wrong, in the failure's own words with secrets taken out, at most
       * 500 characters counted as a person sees them (grapheme clusters, not UTF-16 units).
       */
      detail: z.string().optional(),
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
  /**
   * Where the harness keeps the bound session's conversation, as its own hooks report it: a
   * Claude Code session can be resumed only once that file exists. The stream leaves the path out.
   */
  "agent.transcript_recorded": {
    entity: "agent",
    payload: transcript,
    streamed: transcript.omit({ path: true }),
  },
  /** The agent's process was sent a signal; any exit it causes is recorded on its own. */
  "agent.signalled": { entity: "agent", payload: z.object({ signal: Signal }) },
  /** The agent's harness reported what it is doing; the latest per process is kept (§4.6). */
  "agent.activity": { entity: "agent", payload: Activity },
  /** The model the agent runs, or its context use, changed (§11.2). */
  "agent.usage": { entity: "agent", payload: Usage },
  /** The agent's process ended; its terminal stays, with its last screen (§4.1, §4.5). */
  "agent.exited": { entity: "agent", payload: z.object({ exit: ExitStatus }) },
  /** A close was asked for. Recorded before the terminal is touched, so a view that loses its
   * terminal next can tell a close from a disconnect. */
  "agent.closing": { entity: "agent", payload: z.object({}) },
  /** The agent's terminal is gone, and the agent with it. */
  "agent.closed": { entity: "agent", payload: z.object({}) },
  /** A shell was asked for; its terminal is recorded before the runtime starts it (§4.8). */
  "terminal.opened": {
    entity: "terminal",
    payload: z.object({
      environmentId: Id("env"),
      cwd: z.string(),
      linkedAgentId: Id("agent").nullable(),
      /** The theme it is opened for, when one was named. */
      theme: TuiTheme.optional(),
      /** The lost shell it was opened to restart. */
      restartOf: Id("term").optional(),
    }),
  },
  "terminal.running": { entity: "terminal", payload: z.object({ runtimeRef: RuntimeRefPayload }) },
  "terminal.failed": {
    entity: "terminal",
    /** `daemon_restart`: the daemon died while opening it, and its session never appeared. */
    payload: z.object({ reason: z.enum(["open_rejected", "daemon_restart"]) }),
  },
  /** A reachable runtime no longer has the shell, as after a reboot; it can be restarted. */
  "terminal.lost": { entity: "terminal", payload: z.object({}) },
  /** A close was asked for, recorded before the terminal is touched. */
  "terminal.closing": { entity: "terminal", payload: z.object({}) },
  "terminal.closed": {
    entity: "terminal",
    /**
     * `exited`: its shell ended, by `exit` or Ctrl+D, which closes it at once. `agent_closed`: the
     * agent it was linked to closed. `restarted`: a lost shell a new one replaced.
     */
    payload: z.object({ reason: z.enum(["user", "exited", "agent_closed", "restarted"]) }),
  },
  /**
   * What runs in a shell's foreground changed: a program's name, or null back at the prompt. Its
   * command line is never carried: it can hold a secret the user typed (§4.8).
   */
  "terminal.foreground_changed": {
    entity: "terminal",
    payload: z.object({ command: z.string().max(200).nullable() }),
  },
  /** A linked shell became standalone; its agent's close no longer takes it. */
  "terminal.unlinked": { entity: "terminal", payload: z.object({}) },
  /** A shell's name, as the user gave it, or null when taken away. */
  "terminal.renamed": { entity: "terminal", payload: z.object({ name: z.string().nullable() }) },
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
        "timed_out",
        "replaced",
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
  "mailbox.offered": {
    entity: "message",
    /** A fold's offer names the prompt of the turn it is folded into, whose Stop delivers it. */
    payload: z.object({ promptId: z.string().optional() }),
  },
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
        /** The turn carrying it ended in an API error (StopFailure). */
        "stop_failed",
        /** The turn that saw it ended with no Stop, as Esc ends one: another turn began. */
        "interrupted",
        /** Written, but in no prompt by the second turn end, or a deadline while idle. */
        "not_seen",
      ]),
    }),
  },
  /** Something needs the human: a harness asking to run a tool, a failure, a question (§4.6). */
  "attention.opened": {
    entity: "attention",
    payload: z.object({
      agentId: Id("agent"),
      summary: z.string(),
      /** Absent on items recorded before kinds, which were all approvals. */
      kind: AttentionKind.optional(),
      taskId: z.string().optional(),
      messageId: Id("msg").optional(),
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
  /** Never the token, its hash or the code it was paired with. */
  "device.paired": { entity: "device", payload: z.object({ name: z.string() }) },
  "device.revoked": { entity: "device", payload: z.object({}) },
  "lease.granted": {
    entity: "terminal",
    payload: z.object({ attachmentId: Id("att"), epoch: z.number().int().positive() }),
  },
  /** The stream leaves the brief out, as it does a message's body. */
  "task.created": {
    entity: "task",
    payload: taskCreated,
    streamed: taskCreated.omit({ brief: true }),
  },
  /** Ends every active assignment on the task, as `task_finished`. */
  "task.finished": {
    entity: "task",
    payload: taskFinished,
    streamed: taskFinished.omit({ note: true }),
  },
  /**
   * The task moved up to its parent's owner: what made its owner the owner ended, as the
   * assignment it was delegated under (protocol 1.25).
   */
  "task.owner_changed": {
    entity: "task",
    payload: z.object({
      ownerAgentId: Id("agent").nullable(),
      delegatedFrom: Id("asgn").nullable(),
    }),
  },
  "assignment.granted": {
    entity: "assignment",
    payload: z.object({
      taskId: Id("task"),
      agentId: Id("agent"),
      role: Role,
      parentAssignmentId: Id("asgn").nullable(),
    }),
  },
  /**
   * Taken away, or its worker's part done. A task finishing or an agent closing ends assignments
   * through its own event. Every assignment granted under an ended one ends with it, as
   * `parent_ended`.
   */
  "assignment.ended": {
    entity: "assignment",
    payload: z.object({ reason: z.enum(["unassigned", "completed"]) }),
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

/**
 * What a client sends on `/v1/events`: whether its page is in sight, when it opens, whenever that
 * changes, and every `VISIBILITY_HEARTBEAT_MS` while it is. The host's desktop notifications wait
 * while some page is, since that page already shows what opened.
 */
export const ClientEventFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("visibility"), visible: z.boolean() }),
]);
export type ClientEventFrame = z.infer<typeof ClientEventFrame>;

/** A page in sight says so this often; one silent for twice as long counts as out of sight. */
export const VISIBILITY_HEARTBEAT_MS = 30_000;

/** Text frames the daemon sends on `/v1/events`. */
export const EventFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: Event }),
  /**
   * The cursor can't be resumed: older than retention (`stale`), or not from this store
   * (`foreign`). Re-read `/v1/state` and resume from its cursor.
   */
  z.object({ type: z.literal("reset"), reason: ResetReason }),
]);
export type EventFrame = z.infer<typeof EventFrame>;
