import type { AgentCommand, AgentState, ExternalRef, HarnessId } from "@bazhen/protocol";
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
  | "launch.rejected"
  | "process.exited"
  | "environment.unreachable"
  | "environment.reconfirmed"
  | "target.absent"
  | "respawn.requested"
  | "respawn.rejected"
  | "relaunch.requested"
  | "close.requested"
  | "close.completed";

// While its environment is unreachable an agent is unknown, never lost: only a reachable
// environment that positively lacks the target makes it lost (foundation-design §4.4, §4.5).
export const agent = machine<AgentState, AgentEvent>("agent session", {
  // A rejected respawn returns to exited, where the terminal still is: it stays closable, and
  // failed would leave its tmux session with nothing to close it.
  starting: {
    "launch.confirmed": "running",
    "launch.rejected": "failed",
    "respawn.rejected": "exited",
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
 * The commands an agent in `state` takes, by its lifecycle alone. A closing agent takes close
 * again, which finishes what an unreachable environment stopped; a closed one answers it with
 * nothing to do, so it isn't offered.
 */
export function agentCommands(state: AgentState): AgentCommand[] {
  return [
    ...(agent.accepts(state, "close.requested") || state === "closing" ? ["close" as const] : []),
    ...(agent.accepts(state, "respawn.requested") ? ["respawn" as const] : []),
    ...(state === "running" ? ["signal" as const] : []),
  ];
}

/** Whether a respawn can resume the agent: it has a harness session, on a harness that resumes. */
export const canResume = (
  a: { readonly harness: HarnessId; readonly externalRef: ExternalRef | null },
  resumable: readonly HarnessId[],
) => a.externalRef !== null && resumable.includes(a.harness);

/**
 * The commands the daemon would take on an agent now, as a client is offered them. Every command
 * names a generation, so an agent without one is offered none.
 */
export function offeredCommands(
  a: {
    readonly state: AgentState;
    readonly generation: number | null;
    readonly harness: HarnessId;
    readonly externalRef: ExternalRef | null;
  },
  resumable: readonly HarnessId[],
): AgentCommand[] {
  if (a.generation === null) return [];
  return agentCommands(a.state).filter((c) => c !== "respawn" || canResume(a, resumable));
}
