import { z } from "zod";
import { EnvironmentKind, Id, IdempotencyKey } from "./ids.ts";
import { Attention, Message } from "./mail.ts";
import { Shell } from "./shells.ts";
import { TuiTheme } from "./theme.ts";
import { Assignment, Task } from "./tasks.ts";

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

/** A command on an agent: each is a `POST /v1/agents/:id/<command>`. */
export const AgentCommand = z.enum(["close", "respawn", "signal"]);
export type AgentCommand = z.infer<typeof AgentCommand>;

/** A harness- or server-side object, such as a Claude Code session or a Codex thread. */
export const ExternalRef = z.object({
  environmentId: Id("env"),
  kind: z.enum(["claude-session", "codex-thread"]),
  id: z.string().min(1),
});
export type ExternalRef = z.infer<typeof ExternalRef>;

/**
 * What a harness last reported an agent doing (foundation-design §4.6). A signal never moves the
 * lifecycle; a missing one leaves the last standing, shown with its age.
 */
export const Activity = z.object({
  value: z.enum([
    "working",
    "waiting_input",
    "needs_approval",
    "idle",
    "done",
    "failed",
    "unknown",
  ]),
  /** Native when the harness said so itself; heuristic when Bazhen inferred it. */
  source: z.enum(["native", "heuristic"]),
  confidence: z.number().min(0).max(1),
  /** When the harness observed it, as an ISO timestamp. */
  observedAt: z.iso.datetime(),
  /**
   * A short reason a human can read, such as the error a turn failed with. Part of what the
   * signal says, so it names a reason, never per-call data such as a tool's name.
   */
  detail: z.string().max(200).optional(),
});
export type Activity = z.infer<typeof Activity>;

/**
 * What an agent's harness says of the model it runs and how full that model's context is, as a
 * Claude Code status line reports them (foundation-design §11.2). Each part is absent until the
 * harness says it.
 */
export const Usage = z.object({
  model: z.string().max(200).optional(),
  /** The share of the context window in use, 0 to 100. */
  contextUsedPercent: z.number().min(0).max(100).optional(),
  /** The context window's size, in tokens. */
  contextWindowTokens: z.number().int().positive().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const Environment = z.object({
  id: Id("env"),
  kind: EnvironmentKind,
  /** The machine it runs on, as a human names it: the local hostname for the local environment. */
  host: z.string().default(""),
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
  /**
   * The theme its TUI was started for, which its terminal is drawn in; dark when none was named,
   * as the terminal has always told programs that ask (protocol 1.15).
   */
  theme: TuiTheme.default("dark"),
  /** The themes its harness can start its TUI in, so a respawn in another is offered only here. */
  themes: z.array(TuiTheme).default(["dark"]),
  /**
   * What its harness last reported it doing, in this process; absent until the harness reports
   * anything (protocol 1.7).
   */
  activity: Activity.optional(),
  /** The model it runs and its context use, once its harness says (protocol 1.16). */
  usage: Usage.optional(),
  /**
   * A shell command that attaches a terminal emulator to its terminal, for a human to copy when the
   * web view is unusable (foundation-design §4.5). Null while the runtime holds no terminal for
   * it, so there is none to view either.
   */
  attachCommand: z.string().nullable().default(null),
  /** The commands the daemon would take on it now, so a client never restates its lifecycle. */
  commands: z.array(AgentCommand).default([]),
});
export type Agent = z.infer<typeof Agent>;

export const LaunchAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  harness: HarnessId,
  /** An absolute path, or `~` or `~/…` for the daemon user's home. */
  cwd: z.string().min(1),
  project: z.string().min(1).optional(),
  /** Protocol 1.13. */
  theme: TuiTheme.optional(),
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
  /**
   * For an agent left closing because its terminal's old server can't be shown gone
   * (`server_unconfirmed`): records it closed without ending anything. That server may still run.
   */
  force: z.boolean().optional(),
  /**
   * Its linked shells to keep running, made standalone; every other one closes with it, whatever
   * runs in it (protocol 1.19).
   */
  keepShells: z.array(Id("term")).optional(),
  /**
   * Close the shells it takes even though a program other than the shell runs in them. Without
   * it such a close is refused as `busy`, naming those programs (protocol 1.19).
   */
  confirmBusy: z.boolean().optional(),
});
export type CloseAgentRequest = z.infer<typeof CloseAgentRequest>;

/** Starts an exited agent again on its harness session, at the next generation (§4.5). */
export const RespawnAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
  /** Protocol 1.13. */
  theme: TuiTheme.optional(),
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
  /** Protocol 1.17. */
  shells: z.array(Shell).default([]),
  /** Protocol 1.20. */
  tasks: z.array(Task).default([]),
  /** Protocol 1.20. */
  assignments: z.array(Assignment).default([]),
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
    /** A close found no terminal, but the server it ran on may still run it; `force` closes it. */
    "server_unconfirmed",
    /** A shell close found a program other than the shell running; `confirmBusy` closes it. */
    "busy",
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
