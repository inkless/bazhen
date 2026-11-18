import { z } from "zod";
import { AgentName } from "./agent-name.ts";
import { EnvironmentKind, HarnessId, Id, IdempotencyKey } from "./ids.ts";

export { HarnessId };
import { Attention, AttentionKind, Message, ObservedMessage } from "./mail.ts";
import { Notice } from "./notices.ts";
import { Role } from "./roles.ts";
import { BusyShell, NeedsRestart, Shell } from "./shells.ts";
import { TuiTheme } from "./theme.ts";
import { Assignment, Task } from "./tasks.ts";

/**
 * foundation-design §4.5. An agent is `starting` until its harness shows a sign of life (the
 * `agent.ready` event), even once its terminal runs: a TUI held at a trust or login dialog isn't
 * up. `running` means its harness has shown it is up since it last started, so it is the state to
 * wait on for an agent that is ready. A respawn or relaunch makes it `starting` again.
 */
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
export const AgentCommand = z.enum(["close", "respawn", "signal", "relaunch"]);
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
    /**
     * Stopped by the account's limit, which resets on its schedule; failed when that can't be
     * shown, as it can't be for a rate limit whose used-up window gives no reset. It holds until
     * the agent's next activity, not until `resetsAt`: a reader compares that with now to say
     * whether the reset has passed.
     */
    "limited",
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
  /** When a `limited` agent's limit resets, as an ISO timestamp, if its harness says. */
  resetsAt: z.iso.datetime().optional(),
});
export type Activity = z.infer<typeof Activity>;

/** One of an account's usage limits, as the agent's harness last reported it. */
export const UsageLimit = z.object({
  /** The harness's name for it, such as `five_hour`. */
  window: z.string().min(1).max(60),
  /** The share of it in use: 100 is the limit, and a spend limit can go past it. */
  usedPercent: z.number().min(0),
  /** When it resets, as an ISO timestamp. */
  resetsAt: z.iso.datetime().optional(),
});
export type UsageLimit = z.infer<typeof UsageLimit>;

/** The most usage limits an agent's usage holds. */
export const USAGE_LIMITS_MAX = 20;

/**
 * What an agent's harness says of the model it runs, how full that model's context is, and how
 * near its account is to each usage limit (foundation-design §11.2). Each part is absent until
 * the harness says it.
 */
export const Usage = z.object({
  model: z.string().max(200).optional(),
  /** The share of the context window in use, 0 to 100. */
  contextUsedPercent: z.number().min(0).max(100).optional(),
  /** The context window's size, in tokens. */
  contextWindowTokens: z.number().int().positive().optional(),
  limits: z.array(UsageLimit).max(USAGE_LIMITS_MAX).optional(),
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
  /**
   * Unique, ignoring case, among agents not closed or failed; empty only from an older daemon.
   */
  name: z.string().default(""),
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
   * as the terminal has always told programs that ask.
   */
  theme: TuiTheme.default("dark"),
  /** The themes its harness can start its TUI in, so a respawn in another is offered only here. */
  themes: z.array(TuiTheme).default(["dark"]),
  /**
   * What its harness last reported it doing, in this process; absent until the harness reports
   * anything.
   */
  activity: Activity.optional(),
  /** The model it runs and its context use, once its harness says. */
  usage: Usage.optional(),
  /**
   * A shell command that attaches a terminal emulator to its terminal, for a human to copy when the
   * web view is unusable (foundation-design §4.5). Null while the runtime holds no terminal for
   * it, so there is none to view either.
   */
  attachCommand: z.string().nullable().default(null),
  /** The commands the daemon would take on it now, so a client never restates its lifecycle. */
  commands: z.array(AgentCommand).default([]),
  /**
   * Whether starting it again resumes its harness session; a relaunch of one that can't starts a
   * fresh session only when asked to.
   */
  resumable: z.boolean().default(false),
  /** Whether a shell can be opened beside it now: its directory still holds its work. */
  canOpenShell: z.boolean().default(false),
  /** The agent that launched it to delegate to it, or null when the human did. */
  launchedBy: Id("agent").nullable().default(null),
  /**
   * Whether mail sent now reaches it with nothing else happening: a Claude Code agent idle with
   * its wake hook held, or in a turn the mail folds into; a Codex agent bound to a thread that
   * takes it.
   */
  listening: z.boolean().default(false),
  /**
   * Its latest note on any task, open or not, the first line of it, as its line in the fleet.
   */
  headline: z
    .object({ text: z.string(), taskId: Id("task"), at: z.iso.datetime() })
    .nullable()
    .default(null),
  /** Set while its terminal runs on a holder this build can't fully serve; null otherwise. */
  needsRestart: NeedsRestart.nullable().default(null),
  /** The role whose prompt it was launched with, which changes only by launching another. */
  role: Role.nullable().default(null),
  /**
   * Whether the prompt it would start with now differs from the one its last start gave it, as
   * after an edit to its role's file. It takes the new one at its next start.
   */
  promptChanged: z.boolean().default(false),
});
export type Agent = z.infer<typeof Agent>;

const ageSeconds = z.number().int().nonnegative();

/**
 * One agent as `bazhen agents --json` prints it for a program: what it is doing and since when,
 * whether mail reaches it now, its headline, its tasks, and the items it has open for the human.
 * Ages are whole seconds, by the clock of the CLI that printed it.
 */
export const FleetAgent = z.object({
  id: Id("agent"),
  name: z.string(),
  harness: HarnessId,
  state: AgentState,
  project: z.string(),
  cwd: z.string(),
  launchedBy: Id("agent").nullable(),
  signal: z
    .object({
      value: Activity.shape.value,
      source: Activity.shape.source,
      ageSeconds,
      resetsAt: Activity.shape.resetsAt,
    })
    .nullable(),
  listening: z.boolean(),
  headline: z.object({ text: z.string(), taskId: Id("task"), ageSeconds }).nullable(),
  tasks: z.array(z.object({ taskId: Id("task"), assignmentId: Id("asgn"), role: Role })),
  attention: z.array(z.object({ id: Id("attn"), kind: AttentionKind })),
});
export type FleetAgent = z.infer<typeof FleetAgent>;

/** What `bazhen agents --json` prints: each agent not ended. */
export const FleetAgents = z.array(FleetAgent);

/** A compaction window, in tokens. */
export const CompactWindowTokens = z.number().int().min(100_000).max(10_000_000);

export const LaunchAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  harness: HarnessId,
  /** An absolute path, or `~` or `~/…` for the daemon user's home. */
  cwd: z.string().min(1),
  project: z.string().min(1).optional(),
  theme: TuiTheme.optional(),
  /** Absent, the daemon names it `<project>-<n>`. */
  name: AgentName.optional(),
  /** The role whose prompt it starts with; absent for none. */
  role: Role.optional(),
  /**
   * How many tokens its context may reach before the harness compacts it, on every start of the
   * agent; absent, the harness's own setting stands. Claude Code takes no fewer than 100 000.
   */
  compactWindowTokens: CompactWindowTokens.optional(),
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
   * runs in it.
   */
  keepShells: z.array(Id("term")).optional(),
  /**
   * Close the shells it takes even though a program other than the shell runs in them. Without
   * it such a close is refused as `busy`, naming those programs.
   */
  confirmBusy: z.boolean().optional(),
  /**
   * The programs the user was shown running in the shells it takes, and confirmed: any of those
   * shells running something else by then is refused as `busy`.
   */
  confirmedBusy: z.array(BusyShell).optional(),
});
export type CloseAgentRequest = z.infer<typeof CloseAgentRequest>;

/** Starts an exited agent again on its harness session, at the next generation (§4.5). */
export const RespawnAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
  theme: TuiTheme.optional(),
});
export type RespawnAgentRequest = z.infer<typeof RespawnAgentRequest>;

/**
 * Starts a lost agent again on a new terminal, at the next generation (foundation-design §4.1,
 * §4.5). It resumes the agent's harness session; one that can't be resumed is refused unless
 * `fresh` asks for a new session, which the old one's conversation doesn't carry into.
 */
export const RelaunchAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
  theme: TuiTheme.optional(),
  fresh: z.boolean().optional(),
});
export type RelaunchAgentRequest = z.infer<typeof RelaunchAgentRequest>;

/**
 * `POST /v1/agents/:id/rename`: the human renames any agent, an agent only itself. A retry
 * names the agent by its id: the path is resolved before the key is replayed, and a rename that
 * landed has freed the old name, so a retry by that name finds no agent.
 */
export const RenameAgentRequest = z.object({
  idempotencyKey: IdempotencyKey,
  name: AgentName,
});
export type RenameAgentRequest = z.infer<typeof RenameAgentRequest>;

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

/**
 * Who the daemon takes the request that asks to be: an agent, or the human as null. A command's
 * environment can't tell, since who a Codex command is depends on which process the daemon
 * finds calling, so a command defaulting to its own agent asks.
 */
export const CallerResponse = z.object({ agentId: Id("agent").nullable() });
export type CallerResponse = z.infer<typeof CallerResponse>;

/** Projections, consistent as of `eventId` in store `epoch`: resume the event stream there. */
export const StateSnapshot = z.object({
  epoch: z.string(),
  eventId: z.number().int().nonnegative(),
  environments: z.array(Environment),
  agents: z.array(Agent),
  attention: z.array(Attention),
  messages: z.array(Message),
  shells: z.array(Shell).default([]),
  tasks: z.array(Task).default([]),
  assignments: z.array(Assignment).default([]),
  /** Every open notice, and the latest closed ones. */
  notices: z.array(Notice).default([]),
  /** The latest messages agents sent each other outside Bazhen's mail, oldest first. */
  observed: z.array(ObservedMessage).default([]),
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

export const ErrorResponse = z.object({
  error: z.enum([
    "invalid_request",
    "unsupported",
    /**
     * The agent's process could not be started: by a launch, or by a respawn or relaunch the
     * harness refused. The message says why; repeating won't help until that changes.
     */
    "launch_failed",
    "conflict",
    "stale_generation",
    "not_resumable",
    "unavailable",
    /** A close found no terminal, but the server it ran on may still run it; `force` closes it. */
    "server_unconfirmed",
    /**
     * A close reached a holder this build can't speak to, which can't be closed from here, with or
     * without `force`: it runs until its process is ended, as the message says.
     */
    "needs_restart",
    /** A shell close found a program other than the shell running; `confirmBusy` closes it. */
    "busy",
    "not_found",
    "origin_not_allowed",
    "host_not_allowed",
    "forbidden",
    /** No device cookie, or one revoked or expired: the browser must pair. */
    "unpaired",
    /** The code was wrong, expired, used or burned; which one is not said. */
    "pairing_failed",
    "rate_limited",
    /**
     * A new agent or shell refused: as many terminals are open as the daemon allows, or the
     * machine is short of PTYs. The message says which; closing a terminal makes room.
     */
    "terminal_limit",
  ]),
  message: z.string(),
  /** With `busy`: each shell, and what runs in it, that the close would end. */
  busy: z.array(BusyShell).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** `POST /v1/daemon/stop`, on the Unix socket only: the daemon stops once it has sent this. */
export const StopResponse = z.object({});
export type StopResponse = z.infer<typeof StopResponse>;
