import type { AgentSessionId, EnvironmentId, TerminalId } from "./ids.ts";
import { machine } from "./machine.ts";

export type AgentState =
  | "starting"
  | "running"
  | "exited"
  | "unknown"
  | "lost"
  | "closing"
  | "closed"
  | "failed";

export type HarnessId = "claude-code" | "codex";

/** A harness- or server-side object, such as a Claude Code session or a Codex thread. */
export interface ExternalRef {
  readonly environmentId: EnvironmentId;
  readonly kind: "claude-session" | "codex-thread";
  readonly id: string;
}

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
  | "relaunch.requested"
  | "close.requested"
  | "close.completed";

// While its environment is unreachable an agent is unknown, never lost: only a reachable
// environment that positively lacks the target makes it lost (foundation-design §4.4, §4.5).
export const agent = machine<AgentState, AgentEvent>("agent session", {
  starting: { "launch.confirmed": "running", "launch.rejected": "failed" },
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
