import type {
  AgentCommand,
  AgentState,
  ExternalRef,
  HarnessId,
  TerminalState,
} from "@bazhen/protocol";
import type { AgentSessionId, EnvironmentId, TerminalId } from "./ids.ts";
import { machine } from "./machine.ts";

/** What was asked for at launch, kept so the agent can be respawned the same way. */
export interface AgentLaunchRequest {
  readonly harness: HarnessId;
  readonly project: string;
  readonly cwd: string;
}

/**
 * The join key: tasks, attention and mail all reference an agent session, which references what
 * runs it (foundation-design §3.1). A local agent's terminal is its process.
 */
export interface AgentSession {
  readonly id: AgentSessionId;
  readonly environmentId: EnvironmentId;
  readonly launch: AgentLaunchRequest;
  readonly state: AgentState;
  readonly terminalId: TerminalId | null;
  readonly externalRef: ExternalRef | null;
}

export type AgentEvent =
  | "launch.confirmed"
  | "harness.ready"
  | "launch.rejected"
  | "process.exited"
  | "environment.unreachable"
  | "environment.reconfirmed"
  | "target.absent"
  | "respawn.requested"
  | "respawn.rejected"
  | "relaunch.requested"
  | "relaunch.rejected"
  | "close.requested"
  | "close.completed";

// While its environment is unreachable an agent is unknown, never lost: only a reachable
// environment that positively lacks the target makes it lost (foundation-design §4.4, §4.5).
export const agent = machine<AgentState, AgentEvent>("agent session", {
  // An agent is starting until its harness shows a sign of life, not merely until its terminal
  // runs: a TUI stopped at a trust or login dialog is not running. Its terminal tells the two
  // phases apart. Unreachable is left out: unknown returns to running on reconfirm, which would
  // skip the harness's sign.
  // A rejected respawn returns to exited, where the terminal still is: it stays closable, and
  // failed would leave its tmux session with nothing to close it. A rejected relaunch returns to
  // lost the same way, so it can be relaunched again or removed.
  starting: {
    "launch.confirmed": "starting",
    "harness.ready": "running",
    "launch.rejected": "failed",
    "respawn.rejected": "exited",
    "relaunch.rejected": "lost",
    "process.exited": "exited",
    "target.absent": "lost",
    "close.requested": "closing",
  },
  running: {
    "process.exited": "exited",
    "environment.unreachable": "unknown",
    "target.absent": "lost",
    "close.requested": "closing",
  },
  unknown: {
    "environment.reconfirmed": "running",
    "process.exited": "exited",
    "target.absent": "lost",
    "close.requested": "closing",
  },
  exited: {
    "respawn.requested": "starting",
    "target.absent": "lost",
    "close.requested": "closing",
  },
  lost: { "relaunch.requested": "starting", "close.requested": "closing" },
  closing: { "close.completed": "closed" },
  closed: {},
  failed: {},
});

/**
 * The commands an agent takes, by its lifecycle and its terminal's. A closing agent takes close
 * again, which finishes what an unreachable environment stopped; a closed one answers it with
 * nothing to do, so it isn't offered. A starting agent takes close and signal only once its
 * terminal runs: before then its start holds it, and there is no process to end.
 */
export function agentCommands({
  state,
  terminalState,
}: {
  readonly state: AgentState;
  readonly terminalState: TerminalState | null;
}): AgentCommand[] {
  if (state === "starting") return terminalState === "running" ? ["close", "signal"] : [];
  return [
    ...(agent.accepts(state, "close.requested") || state === "closing" ? ["close" as const] : []),
    ...(agent.accepts(state, "respawn.requested") ? ["respawn" as const] : []),
    ...(state === "running" ? ["signal" as const] : []),
    ...(agent.accepts(state, "relaunch.requested") ? ["relaunch" as const] : []),
  ];
}

/**
 * What says whether an agent's harness session can be resumed: the session, and where its
 * harness keeps the conversation, as the harness's hooks last reported it.
 */
export interface ResumeEvidence {
  readonly harness: HarnessId;
  readonly externalRef: ExternalRef | null;
  readonly transcript: string | null;
}

/** Whether starting the agent again resumes its harness session, as its environment judges. */
export type Resumes = (a: ResumeEvidence) => boolean;

/**
 * The commands the daemon would take on an agent now, as a client is offered them. Every command
 * names a generation, so an agent without one is offered none.
 */
export function offeredCommands(
  a: {
    readonly state: AgentState;
    readonly terminalState: TerminalState | null;
    readonly generation: number | null;
  } & ResumeEvidence,
  resumes: Resumes,
): AgentCommand[] {
  if (a.generation === null) return [];
  return agentCommands(a).filter((c) => c !== "respawn" || resumes(a));
}
