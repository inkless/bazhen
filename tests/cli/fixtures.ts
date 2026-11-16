// Protocol values for the fake daemon to answer with. Each is checked against its schema when a
// route answers it, so a fixture the protocol no longer accepts fails its test at once.

import type { DoctorResponse, HealthResponse, StateSnapshot, TaskDetail } from "@bazhen/protocol";
import { protocolId } from "@bazhen/protocol/id";

/** The protocol the CLI under test speaks, and as much of it as the CLI prints. */
export const PROTOCOL_ID = await protocolId();
export const SHORT_ID = PROTOCOL_ID.slice(0, 12);

/** What the CLI says of a daemon whose replies it can't read: another build, to restart. */
export const ANOTHER_BUILD =
  "the daemon runs another build of Bazhen: restart it with `bazhen stop`, then `bazhen start`";

export const AGENT = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
export const OTHER = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";
export const THIRD = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c9d";
export const TASK = "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
export const TASK2 = "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";
export const MSG = "msg_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
export const MSG2 = "msg_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";
const ENV = "env_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";

/** An idempotency key, as the CLI makes a fresh one for each command. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An ISO time `seconds` before now, for ages the CLI counts to its own clock. */
export const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

type Agent = StateSnapshot["agents"][number];
type Task = StateSnapshot["tasks"][number];
type Assignment = StateSnapshot["assignments"][number];

export const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  id,
  title,
  state: "open",
  ownerAgentId: null,
  parentTaskId: null,
  ...over,
});

export const assigned = (
  taskId: string,
  agentId: string,
  over: Partial<Assignment> = {},
): Assignment => ({
  id: `asgn_${taskId.slice(5)}`,
  taskId,
  agentId,
  role: "worker",
  parentAssignmentId: null,
  state: "active",
  endReason: null,
  ...over,
});

export const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  id,
  name,
  environmentId: ENV,
  harness: "codex",
  project: "bazhen",
  cwd: "/work",
  state: "running",
  terminalId: null,
  generation: null,
  externalRef: null,
  exit: null,
  theme: "dark",
  themes: ["dark"],
  attachCommand: null,
  commands: [],
  resumable: false,
  canOpenShell: false,
  launchedBy: null,
  listening: false,
  headline: null,
  needsRestart: null,
  role: null,
  promptChanged: false,
  ...over,
});

export const snapshot = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  epoch: "e",
  eventId: 1,
  environments: [],
  agents: [],
  attention: [],
  messages: [],
  shells: [],
  tasks: [],
  assignments: [],
  notices: [],
  observed: [],
  ...over,
});

export const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  ...task(TASK, "t"),
  brief: "b",
  note: null,
  assignments: [],
  subtasks: [],
  notes: [],
  ...over,
});

export const health = (over: Partial<HealthResponse> = {}): HealthResponse => ({
  status: "ok",
  appVersion: "0.1.0",
  protocolId: PROTOCOL_ID,
  runtime: { kind: "tmux", state: "healthy", version: "3.4" },
  ...over,
});

export const doctor = (over: Partial<DoctorResponse> = {}): DoctorResponse => ({
  appVersion: "0.1.0",
  protocolId: PROTOCOL_ID,
  runtime: { state: "healthy", version: "3.4" },
  hookClient: { path: "/repo/target/release/bazhen-hook", fallback: false },
  config: { path: "/home/u/.config/bazhen/config.toml", found: true },
  agents: { shell: "direct", loginShell: null },
  env: {
    capturedAt: "2026-11-16T12:00:00.000Z",
    source: "start",
    kept: 40,
    removed: { secrets: 2, session: 1 },
  },
  ...over,
});
