import type { AgentState } from "@bazhen/protocol";
import { machine } from "./machine.ts";

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
