import { z } from "zod";
import { AgentName, AgentRef, AGENT_NAME_MAX } from "./agent-name.ts";
import {
  AgentCommandResponse,
  CallerResponse,
  CloseAgentRequest,
  ErrorResponse,
  FleetAgent,
  LaunchAgentRequest,
  LaunchAgentResponse,
  RelaunchAgentRequest,
  RenameAgentRequest,
  RespawnAgentRequest,
  SignalAgentRequest,
  StateSnapshot,
  StopResponse,
} from "./agents.ts";
import { readDetachKeys } from "./detach-keys.ts";
import {
  DEVICE_NAME_MAX,
  DevicesResponse,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PairRequest,
  PairResponse,
  PairingCodeResponse,
  RevokeDeviceResponse,
} from "./devices.ts";
import { HarnessId, Id } from "./ids.ts";
import {
  ClientEventFrame,
  EVENTS,
  Event,
  RecordedEvent,
  EventEnvelopeFrame,
  EventStreamQuery,
  type EventType,
} from "./events.ts";
import { DoctorResponse, EnvRefreshRequest, EnvRefreshResponse, HealthResponse } from "./index.ts";
import { AgentCondition, ShellCondition, WaitRequest, WaitResponse } from "./waits.ts";
import {
  AnswerAttentionRequest,
  AnswerAttentionResponse,
  DismissAttentionRequest,
  DismissAttentionResponse,
  HOOK_PROTOCOL_VERSION,
  HOOK_REPLY_MAX_BYTES,
  HOOK_REPLY_TYPE,
  HookAck,
  HookReply,
  HookRequest,
  MESSAGE_WAIT_MAX_MS,
  OfferToken,
  ReplyAttentionRequest,
  ReplyAttentionResponse,
  ResendAttentionRequest,
  ResendAttentionResponse,
  SETTLED,
  SendMessageRequest,
  SendMessageResponse,
  WaitMessagesRequest,
  WaitMessagesResponse,
} from "./mail.ts";
import { DEVICE_PAIRED, DismissNoticeRequest, DismissNoticeResponse } from "./notices.ts";
import { hasKeystrokes, withoutReplies } from "./input.ts";
import { isOrigin, isPlainRemote } from "./origins.ts";
import { Role, RolesResponse } from "./roles.ts";
import { ProtocolVersion } from "./version.ts";
import { TerminalScreen } from "./terminals.ts";
import {
  CloseShellRequest,
  OpenShellRequest,
  RenameShellRequest,
  RestartShellRequest,
  ShellCommandResponse,
  ShellDecline,
  ShellPrompt,
  ShellReport,
  UnlinkShellRequest,
} from "./shells.ts";
import { STREAM_FRAME_MAX_BYTES, StreamClientFrame, StreamServerFrame } from "./stream.ts";
import {
  AddTaskNoteRequest,
  AssignTaskRequest,
  AssignTaskResponse,
  BroadcastMessageResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  DelegateTaskRequest,
  EscalateRequest,
  EscalateResponse,
  FinishTaskRequest,
  TASK_NOTE_MAX_BYTES,
  TaskCommandResponse,
  TaskDetail,
  TaskNoteText,
  UnassignTaskRequest,
  quoteNote,
} from "./tasks.ts";
import {
  enumPaths,
  type JsonSchema,
  replaceAt,
  uncovered,
  wellFormed,
  withField,
} from "./fixture-coverage.ts";

/*
 * The API messages another language's client speaks, as fixtures `make schema` writes to
 * `fixtures/api/`: for each, examples as they arrive on the wire, each with what the protocol
 * makes of it (defaults filled in, unknown fields dropped). A client's types decode the wire form
 * and encode back the parsed one. Between them the examples exercise every property, optional,
 * nullable, union branch and enum value of the message, which `apiFixtures` checks, so a field
 * the other side lacks or names wrongly fails there.
 */

const AGENT = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const AGENT2 = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";
const ENV = "env_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const TERM = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const TASK = "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const TASK2 = "task_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";
const ASGN = "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const ATTN = "attn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const MSG = "msg_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const NTC = "ntc_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const DEV = "dev_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const OBS = "obs_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const ATT = "att_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const AT = "2026-11-16T12:00:00.000Z";
const OFFER = `${MSG}-k3x9`;
const KEY = "0b8f8a52-58a3-4c49-9e2f-5d0f8c1c2a10";

const HOLDER_REF = { runtime: "holder", locator: { pid: "4242" } };
const SESSION = "5f0c2a8e-7b1d-4c3e-9f2a-1d0e8c7b6a59";
const USAGE = {
  model: "claude-opus",
  contextUsedPercent: 42.5,
  contextWindowTokens: 200_000,
  limits: [
    { window: "5h", usedPercent: 12, resetsAt: AT },
    { window: "weekly", usedPercent: 3 },
  ],
};
const restarted = (theme: string, harnessName: string) => [
  {
    externalRef: { environmentId: ENV, kind: "codex-thread", id: "t-1" },
    runtimeRef: HOLDER_REF,
    theme,
    harnessName,
    promptHash: "9f86d081",
  },
  { externalRef: null, runtimeRef: HOLDER_REF },
];

/** Each event type's payloads as the stream sends them. */
const EVENT_PAYLOADS: { readonly [T in EventType]: readonly unknown[] } = {
  "environment.registered": [{ kind: "local" }],
  "environment.harness_version": [
    { harness: "codex", version: "0.80.0", previous: "0.79.0" },
    { harness: "codex", version: "0.79.0", previous: null },
  ],
  "agent.launched": [
    {
      environmentId: ENV,
      harness: "claude-code",
      project: "bazhen",
      cwd: "/work",
      terminalId: TERM,
      launchedBy: AGENT2,
      name: "BZ-127",
      nameOrdinal: 3,
      runtime: "holder",
      role: "worker",
      promptHash: "9f86d081",
      compactWindowTokens: 200_000,
    },
    { environmentId: ENV, harness: "codex", project: "bazhen", cwd: "/work", terminalId: null },
  ],
  "agent.renamed": [{ name: "reviewer", previous: "bazhen-3" }],
  "agent.running": [
    {
      externalRef: { environmentId: ENV, kind: "claude-session", id: SESSION },
      runtimeRef: HOLDER_REF,
      theme: "dark",
      harnessName: "Claude Code",
    },
    { externalRef: null, runtimeRef: null },
  ],
  "agent.ready": [{ sign: "claude_hook" }],
  "agent.failed": [
    { reason: "launch_rejected", detail: "no such cwd" },
    { reason: "daemon_restart" },
  ],
  "agent.lost": [{}],
  "agent.process_adopted": [{ runtimeRef: HOLDER_REF }],
  "agent.respawn_requested": [{}],
  "agent.respawned": restarted("light", "Codex"),
  "agent.respawn_rejected": [
    { reason: "not_resumable", detail: "no session" },
    { reason: "unavailable" },
  ],
  "agent.relaunch_requested": [
    { terminalId: TERM, generation: 2, fresh: true, runtime: "holder" },
    { terminalId: TERM, generation: 3, fresh: false },
  ],
  "agent.relaunched": restarted("dark", "Claude Code"),
  "agent.relaunch_rejected": [
    { reason: "terminal_exists", detail: "still open" },
    { reason: "daemon_restart" },
  ],
  "agent.external_ref_updated": [
    { externalRef: { environmentId: ENV, kind: "codex-thread", id: "t-2" } },
  ],
  "agent.transcript_recorded": [{ sessionId: SESSION }],
  "agent.signalled": [{ signal: "SIGINT" }],
  "agent.activity": [
    {
      value: "working",
      source: "native",
      confidence: 1,
      observedAt: AT,
      detail: "Editing",
      resetsAt: AT,
    },
    { value: "idle", source: "heuristic", confidence: 0.5, observedAt: AT },
  ],
  "agent.usage": [USAGE, {}],
  "agent.compacted": [
    { sign: "claude_hook", before: USAGE, hook: { sessionId: SESSION, pid: 4242 } },
    { sign: "codex_item", before: {}, hook: { sessionId: null, pid: 4242 } },
    { sign: "codex_item" },
  ],
  "agent.exited": [
    { exit: { type: "exited", code: 0 } },
    { exit: { type: "signalled", signal: "SIGTERM" } },
    { exit: { type: "unknown" } },
  ],
  "agent.closing": [{}],
  "agent.closed": [{}],
  "terminal.opened": [
    {
      environmentId: ENV,
      cwd: "/work",
      linkedAgentId: AGENT,
      theme: "dark",
      restartOf: TERM,
      runtime: "holder",
    },
    { environmentId: ENV, cwd: "/work", linkedAgentId: null },
  ],
  "terminal.running": [{ runtimeRef: HOLDER_REF }],
  "terminal.failed": [{ reason: "open_rejected" }],
  "terminal.process_adopted": [{ runtimeRef: HOLDER_REF }],
  "terminal.lost": [{}],
  "terminal.closing": [{}],
  "terminal.closed": [{ reason: "user" }],
  "terminal.foreground_changed": [{ command: "vim" }, { command: null }],
  "terminal.needs_restart": [{ protocol: ["2"] }],
  "terminal.restart_cleared": [{}],
  "terminal.unlinked": [{}],
  "terminal.renamed": [{ name: "build" }, { name: null }],
  "attachment.started": [{ terminalId: TERM, mode: "interactive" }],
  "attachment.ended": [{ reason: "client_closed" }],
  "mailbox.queued": [{ agentId: AGENT, from: AGENT2 }, { agentId: AGENT }],
  "mailbox.offered": [{ promptId: "p-1" }, {}],
  "mailbox.emitted": [{}],
  "mailbox.seen": [{ promptId: "p-1" }],
  "mailbox.delivered": [{}],
  "mailbox.accepted": [{ offline: false }],
  "mailbox.undeliverable": [{ reason: "gave_up" }],
  "message.observed": [
    { from: AGENT, to: AGENT2, summary: "Review it?", accepted: true, toolUseId: "toolu_01" },
  ],
  "mailbox.requeued": [{ reason: "not_seen" }],
  "attention.opened": [
    {
      agentId: AGENT,
      summary: "Run the migration?",
      kind: "approval",
      taskId: TASK,
      messageId: MSG,
      toolUseId: "toolu_01",
      mainAgent: true,
    },
    { agentId: AGENT, summary: "Stuck?", toolUseId: null, mainAgent: false },
  ],
  "attention.answered": [{ decision: "allow" }],
  "attention.closed": [{ reason: "replied" }],
  "device.paired": [{ name: "iPad" }],
  "device.revoked": [{}],
  "notice.opened": [
    {
      kind: DEVICE_PAIRED,
      summary: "iPad paired",
      device: {
        id: DEV,
        name: "iPad",
        origin: "https://192.168.1.20:7777",
        address: "192.168.1.20",
      },
    },
    {
      kind: DEVICE_PAIRED,
      summary: "iPad paired",
      device: { id: DEV, name: "iPad", origin: "https://ipad.local:7777", address: null },
    },
    { kind: "daemon_restarted", summary: "Restarted", device: null },
  ],
  "notice.closed": [
    { reason: "revoked", by: "revoke", fromDevice: DEV },
    { reason: "dismissed", by: "owner-socket" },
  ],
  "lease.granted": [{ attachmentId: ATT, epoch: 1 }],
  "task.created": [
    { title: "Port events", ownerAgentId: AGENT, parentTaskId: TASK2, delegatedFrom: ASGN },
    { title: "Port events", ownerAgentId: null, parentTaskId: null, delegatedFrom: null },
    { title: "Port events", ownerAgentId: null, parentTaskId: null },
  ],
  "task.finished": [{ outcome: "done" }],
  "task.owner_changed": [
    { ownerAgentId: AGENT, delegatedFrom: ASGN },
    { ownerAgentId: null, delegatedFrom: null },
  ],
  "task.noted": [
    { handoff: true, role: "reviewer" },
    { handoff: false, role: null },
  ],
  "assignment.granted": [
    { taskId: TASK, agentId: AGENT, role: "worker", parentAssignmentId: ASGN },
    { taskId: TASK, agentId: AGENT, role: "worker", parentAssignmentId: null },
  ],
  "assignment.ended": [{ reason: "completed" }],
};

const ENTITY_IDS: Readonly<Record<string, string>> = {
  environment: ENV,
  agent: AGENT,
  terminal: TERM,
  attachment: ATT,
  message: MSG,
  observed_message: OBS,
  attention: ATTN,
  device: DEV,
  notice: NTC,
  task: TASK,
  assignment: ASGN,
};

const EVENT_ENTITIES: Readonly<Record<string, { readonly entity: string }>> = EVENTS;

/** `items`, as the list of at least one item it must be. */
function atLeastOne<T>(items: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error("expected at least one item");
  return [first, ...rest];
}

/** Each type's payloads as the store records them, where that is more than the stream sends. */
const RECORDED: Readonly<Record<string, readonly unknown[]>> = {
  "agent.transcript_recorded": [{ sessionId: SESSION, path: "/home/u/.claude/projects/p/s.jsonl" }],
  "mailbox.queued": [
    { agentId: AGENT, from: AGENT2, body: "Review the port." },
    { agentId: AGENT, body: "Ship it." },
  ],
  "message.observed": [
    {
      from: AGENT,
      to: AGENT2,
      summary: "Review it?",
      accepted: true,
      toolUseId: "toolu_01",
      text: "Review the port, please.",
    },
  ],
  "task.created": [
    {
      title: "Port events",
      brief: "Port the event stream.",
      ownerAgentId: AGENT,
      parentTaskId: TASK2,
      delegatedFrom: ASGN,
    },
    {
      title: "Port events",
      brief: "Port the event stream.",
      ownerAgentId: null,
      parentTaskId: null,
      delegatedFrom: null,
    },
    {
      title: "Port events",
      brief: "Port the event stream.",
      ownerAgentId: null,
      parentTaskId: null,
    },
  ],
  "task.finished": [
    { outcome: "done", note: "Shipped." },
    { outcome: "done", note: null },
  ],
  "task.noted": [
    { text: "Over to you.", handoff: true, role: "reviewer" },
    { text: "Noted.", handoff: false, role: null },
  ],
};

/** Every type's payloads as the store records them, each with its type. */
const PAYLOAD_WIRE = Object.entries(EVENT_PAYLOADS).flatMap(([type, payloads]) =>
  (RECORDED[type] ?? payloads).map((payload) => ({ type, payload })),
);

/** Every example of `EVENT_PAYLOADS` as an event, the first of each type caused by none. */
const EVENT_WIRE = Object.entries(EVENT_PAYLOADS).flatMap(([type, payloads], t) => {
  const entity = EVENT_ENTITIES[type]?.entity ?? "";
  return payloads.map((payload, i) => ({
    id: 100 * (t + 1) + i,
    ts: AT,
    type,
    entityType: entity,
    entityId: ENTITY_IDS[entity],
    actor: i === 0 ? "user" : AGENT,
    causationId: i === 0 ? null : 100 * (t + 1),
    correlationId: i === 0 ? null : KEY,
    payload,
  }));
});

const fullAgent = {
  id: AGENT,
  name: "BZ-127",
  environmentId: ENV,
  harness: "claude-code",
  project: "bazhen",
  cwd: "/work",
  state: "running",
  terminalId: TERM,
  generation: 3,
  externalRef: { environmentId: ENV, kind: "claude-session", id: "s-1" },
  exit: { type: "exited", code: 1 },
  theme: "light",
  themes: ["light", "dark"],
  activity: {
    value: "limited",
    source: "native",
    confidence: 0.75,
    observedAt: AT,
    detail: "rate_limit",
    resetsAt: AT,
  },
  usage: {
    model: "claude-opus-5-5",
    contextUsedPercent: 41.5,
    contextWindowTokens: 200_000,
    limits: [
      { window: "five_hour", usedPercent: 100, resetsAt: AT },
      { window: "spend_limit", usedPercent: 104.5 },
    ],
  },
  attachCommand: "tmux -S /run/tmux.sock attach -t %1",
  commands: ["close", "respawn", "signal", "relaunch"],
  resumable: true,
  canOpenShell: true,
  launchedBy: AGENT2,
  listening: true,
  headline: { text: "Halfway.", taskId: TASK, at: AT },
  needsRestart: { holderPid: 4242, served: true },
  role: "reviewer",
  promptChanged: true,
  startRequestedAt: AT,
};

/** An agent from an older daemon: every defaulted field missing, every nullable null. */
const bareAgent = {
  id: AGENT2,
  environmentId: ENV,
  harness: "codex",
  project: "p",
  cwd: "/w",
  state: "exited",
  terminalId: null,
  generation: null,
  externalRef: null,
  exit: { type: "signalled", signal: "SIGTERM" },
};

const nullAgent = {
  ...bareAgent,
  exit: null,
  activity: { value: "idle", source: "heuristic", confidence: 1, observedAt: AT },
  usage: {},
  attachCommand: null,
  launchedBy: null,
  headline: null,
  needsRestart: { holderPid: null },
  role: null,
  promptChanged: false,
  startRequestedAt: null,
};

const fullShell = {
  id: TERM,
  environmentId: ENV,
  state: "running",
  generation: 1,
  cwd: "/w",
  linkedAgentId: AGENT,
  name: "build",
  foreground: { command: "make", since: AT },
  theme: "dark",
  attachCommand: "tmux attach",
  commands: ["close", "restart", "rename", "unlink"],
  retypeable: true,
  needsRestart: { holderPid: 7, served: false },
};

const bareShell = {
  id: TERM,
  environmentId: ENV,
  state: "closed",
  generation: 0,
  cwd: "/w",
  linkedAgentId: null,
  theme: "light",
  attachCommand: null,
  commands: [],
};

const nullShell = {
  ...bareShell,
  name: null,
  foreground: null,
  needsRestart: null,
};
const unservedShell = { ...bareShell, needsRestart: { holderPid: null } };

const task = { id: TASK, title: "t", state: "open", ownerAgentId: AGENT, parentTaskId: TASK2 };
const orphanTask = { ...task, id: TASK2, state: "done", ownerAgentId: null, parentTaskId: null };

const assignment = {
  id: ASGN,
  taskId: TASK,
  agentId: AGENT,
  role: "worker",
  parentAssignmentId: ASGN,
  state: "ended",
  endReason: "unassigned",
};
const activeAssignment = {
  ...assignment,
  parentAssignmentId: null,
  state: "active",
  endReason: null,
};

const attention = {
  id: ATTN,
  agentId: AGENT,
  state: "closed",
  closeReason: "answered",
  summary: "Run it?",
  kind: "approval",
  taskId: TASK,
  messageId: MSG,
  openedAt: AT,
  actions: ["allow", "deny", "reply", "resend", "dismiss"],
};
const openAttention = {
  ...attention,
  state: "open",
  closeReason: null,
  taskId: null,
  messageId: null,
  actions: [],
};

const notice = {
  id: NTC,
  kind: "device_paired",
  state: "closed",
  closeReason: "dismissed",
  summary: "A device paired",
  openedAt: AT,
  device: { id: DEV, name: "phone", origin: "https://box.ts.net", address: "192.168.1.5" },
  actions: ["dismiss"],
  closedBy: "owner-socket",
  closedFrom: { id: DEV, name: "phone" },
};
const openNotice = {
  ...notice,
  state: "open",
  closeReason: null,
  device: null,
  closedBy: null,
  closedFrom: null,
};
const addresslessNotice = { ...openNotice, device: { ...notice.device, address: null } };

const fullState = {
  epoch: "e1",
  eventId: 42,
  environments: [{ id: ENV, kind: "local", host: "my-mac" }],
  agents: [fullAgent, bareAgent, nullAgent],
  attention: [attention, openAttention],
  messages: [{ id: MSG, agentId: AGENT, state: "queued" }],
  shells: [fullShell, bareShell, nullShell, unservedShell],
  tasks: [task, orphanTask],
  assignments: [assignment, activeAssignment],
  notices: [notice, openNotice, addresslessNotice],
  observed: [{ id: OBS, from: AGENT, to: AGENT2, summary: "ping", accepted: true, at: AT }],
};

/** A snapshot from a daemon before shells, tasks and notices: each defaulted list missing. */
const oldState = {
  epoch: "e0",
  eventId: 0,
  environments: [{ id: ENV, kind: "opencode-server" }],
  agents: [{ ...bareAgent, exit: { type: "unknown" }, needsRestart: null }],
  attention: [],
  messages: [],
};

/** A snapshot holding one of something, for an enum's values to be tried on without the rest. */
const lone = (over: Record<string, unknown>) => ({
  epoch: "e",
  eventId: 1,
  environments: [],
  agents: [],
  attention: [],
  messages: [],
  ...over,
});

const loneStates = [
  lone({ environments: [{ id: ENV, kind: "local" }] }),
  lone({ agents: [fullAgent] }),
  lone({ attention: [attention] }),
  lone({ messages: [{ id: MSG, agentId: AGENT, state: "queued" }] }),
  lone({ shells: [fullShell] }),
  lone({ tasks: [task] }),
  lone({ assignments: [assignment] }),
  lone({ notices: [notice] }),
  lone({ attention: [{ ...openAttention, summary: "Run it?\ud83d\ud83d👍" }] }),
];

const fullDoctor = {
  appVersion: "0.1.0",
  protocolId: "a".repeat(64),
  runtimes: [
    { kind: "tmux", state: "unused", version: null },
    { kind: "holder", state: "unreachable", version: null, workarounds: ["w"] },
  ],
  hookClient: { path: "/r/target/release/bazhen-hook", fallback: false },
  peerReader: { path: "/r/target/release/bazhen-peer" },
  agentCli: { expected: "/r/target/release/bazhen", onPath: "/h/bin/bazhen" },
  config: { path: "/c.toml", found: true },
  agents: { shell: "login", loginShell: "/bin/zsh" },
  codex: { daemon: "0.160.0", cli: "0.166.0", toolCalls: "unmarked" },
  web: {
    externalOrigins: ["https://box.ts.net"],
    from: "config",
    allowInsecureOrigins: true,
    pairing: { mode: "always", required: true },
    app: "/r/apps/web/dist",
    lan: {
      url: "https://my-mac.local:7942",
      allow: ["192.168.1.0/24"],
      certificate: { fingerprint: "AB:CD", path: "/s/lan.crt", expiresAt: AT },
      error: "stopped",
      subnets: [{ interface: "eno1", cidr: "192.168.1.0/24" }],
    },
  },
  notifications: { desktop: true, notifier: "notify-send" },
  terminals: { open: 3, max: 100, host: { used: 37, max: 4096, exact: true }, refusing: "budget" },
  holder: {
    binary: "/s/holder/3f9a/bazhen-holder",
    build: "3f9a",
    reason: "x",
    holders: [
      {
        terminalId: TERM,
        build: "3f9a",
        protocol: ["1.2"],
        contained: true,
        socket: "/run/bazhen/holders/term.sock",
        holderPid: 4242,
        stats: {
          engineBytes: 2_097_152,
          rss: 9_437_184,
          ringBytes: 1_048_576,
          historyLines: 812,
          engineResets: 0,
        },
      },
      { terminalId: TERM, build: "3f9a", protocol: ["1.2"] },
    ],
  },
  containment: {
    state: "scoped",
    systemd: 255,
    oomPolicy: true,
    terminal: { asked: "50%", bytes: 33_285_996_544 },
    total: { asked: "infinity", bytes: null },
    swap: { asked: "0", bytes: 0 },
  },
  httpCallers: { state: "identified" },
  env: { capturedAt: AT, source: "refresh", kept: 40, removed: { secrets: 2, session: 1 } },
};

const bareDoctor = {
  appVersion: "0.1.0",
  protocolId: "b".repeat(64),
  runtimes: [{ kind: "holder", state: "not-running", version: null }],
  hookClient: { path: "/r/hook.sh", fallback: true },
  config: { path: "/c.toml", found: false },
  agents: { shell: "direct", loginShell: null },
  env: { capturedAt: AT, source: "start", kept: 3, removed: {} },
};

const nullDoctor = {
  ...bareDoctor,
  peerReader: null,
  agentCli: { expected: null, onPath: null },
  codex: { daemon: null, cli: null, toolCalls: null },
  web: {
    externalOrigins: [],
    from: null,
    allowInsecureOrigins: false,
    pairing: { mode: "auto", required: false },
    app: null,
    appRefused: "/tmp: other users may write it",
    lan: null,
  },
  notifications: { desktop: false, notifier: null },
  terminals: { open: 0, max: 4, host: null, refusing: null },
  holder: {
    binary: null,
    build: null,
    reason: null,
    holders: [
      {
        terminalId: TERM,
        build: null,
        protocol: ["0.9"],
        contained: null,
        socket: "/run/bazhen/holders/term.sock",
        holderPid: null,
        stats: null,
      },
      {
        terminalId: TERM,
        build: "3f9a",
        protocol: ["1.2"],
        contained: false,
        socket: "/run/bazhen/holders/term.sock",
        holderPid: 4242,
        stats: { engineBytes: 1, rss: null, ringBytes: 0, historyLines: 0 },
      },
    ],
  },
  containment: { state: "uncontained", why: "no systemd user manager" },
  httpCallers: { state: "unidentified", why: "/proc/net/tcp can't be read" },
};

const certless = {
  ...bareDoctor,
  web: {
    externalOrigins: [],
    from: "BAZHEN_EXTERNAL_ORIGINS",
    allowInsecureOrigins: false,
    lan: { ...fullDoctor.web.lan, certificate: null, error: null, subnets: [] },
  },
  terminals: { open: 1, max: 4, host: { used: 1, max: 9, exact: false }, refusing: "host" },
  containment: {
    state: "scoped",
    systemd: 249,
    oomPolicy: false,
    terminal: { asked: "1G", bytes: null },
    total: { asked: "2G", bytes: null },
    swap: { asked: "1G", bytes: null },
  },
};

/** A web with no LAN listener, containment not checked yet, and Codex from before toolCalls. */
const lanless = {
  ...bareDoctor,
  web: { externalOrigins: [], from: null, allowInsecureOrigins: false },
  containment: { state: "unchecked" },
  codex: { daemon: "0.166.0", cli: "0.166.0" },
};

const role = {
  key: "lead",
  title: "Lead",
  description: "Runs the task.",
  grants: ["worker", "reviewer"],
  singlePerTask: true,
  maxActiveTasks: 2,
  prompt: "You lead.",
  source: "user",
};

const taskNote = {
  eventId: 7,
  taskId: TASK,
  agentId: AGENT,
  role: "worker",
  text: "Halfway.",
  handoff: true,
  at: AT,
};

/** A message, its schema, and examples of it on the wire. */
interface Example {
  readonly schema: z.ZodType;
  readonly wire: readonly unknown[];
  /** Printed by a client for a program to read, so its keys' order is part of it too. */
  readonly printed?: boolean;
}

const MESSAGES: Readonly<Record<string, Example>> = {
  AddTaskNoteRequest: {
    schema: AddTaskNoteRequest,
    wire: [
      { idempotencyKey: KEY, text: "Tests pass." },
      { idempotencyKey: KEY, text: "x", handoff: true },
    ],
  },
  AgentCommandResponse: {
    schema: AgentCommandResponse,
    wire: [{ agentId: AGENT, eventIds: [1, 2] }],
  },
  AnswerAttentionRequest: {
    schema: AnswerAttentionRequest,
    wire: [
      { idempotencyKey: KEY, decision: "allow" },
      { idempotencyKey: KEY, decision: "deny" },
    ],
  },
  AnswerAttentionResponse: { schema: AnswerAttentionResponse, wire: [{ eventIds: [4] }] },
  AssignTaskRequest: {
    schema: AssignTaskRequest,
    wire: [{ idempotencyKey: KEY, agentId: "BZ-127", role: "reviewer" }],
  },
  AssignTaskResponse: { schema: AssignTaskResponse, wire: [{ assignmentId: ASGN, eventIds: [3] }] },
  CallerResponse: { schema: CallerResponse, wire: [{ agentId: AGENT }, { agentId: null }] },
  ClientEventFrame: { schema: ClientEventFrame, wire: [{ type: "visibility", visible: true }] },
  CloseAgentRequest: {
    schema: CloseAgentRequest,
    wire: [
      { idempotencyKey: KEY, generation: 0 },
      {
        idempotencyKey: KEY,
        generation: 3,
        force: true,
        keepShells: [TERM],
        confirmBusy: true,
        confirmedBusy: [{ terminalId: TERM, program: "vim" }],
      },
    ],
  },
  BroadcastMessageResponse: {
    schema: BroadcastMessageResponse,
    wire: [
      {
        sent: [{ agentId: AGENT, messageId: MSG }],
        skipped: [{ agentId: AGENT2, reason: "it is closing" }],
        eventIds: [],
      },
    ],
  },
  CloseShellRequest: {
    schema: CloseShellRequest,
    wire: [
      { idempotencyKey: KEY, generation: 0 },
      {
        idempotencyKey: KEY,
        generation: 2,
        confirmBusy: true,
        confirmedProgram: "vim",
        force: true,
      },
    ],
  },
  CreateTaskRequest: {
    schema: CreateTaskRequest,
    wire: [
      { idempotencyKey: KEY, title: "t", brief: "b" },
      {
        idempotencyKey: KEY,
        title: "t",
        brief: "b",
        parentTaskId: TASK,
        assign: { agentId: AGENT, role: "worker" },
      },
    ],
  },
  CreateTaskResponse: {
    schema: CreateTaskResponse,
    wire: [
      { taskId: TASK, assignmentId: ASGN, eventIds: [1] },
      { taskId: TASK, assignmentId: null, eventIds: [1] },
    ],
  },
  DelegateTaskRequest: {
    schema: DelegateTaskRequest,
    wire: [
      { idempotencyKey: KEY, agentId: "BZ-127", title: "t", brief: "b" },
      {
        idempotencyKey: KEY,
        fromTaskId: TASK,
        launch: { harness: "codex", cwd: "/w", name: "notes" },
        role: "reviewer",
        title: "t",
        brief: "b",
      },
      {
        idempotencyKey: KEY,
        launch: { harness: "claude-code" },
        role: "worker",
        title: "t",
        brief: "b",
      },
    ],
  },
  DevicesResponse: {
    schema: DevicesResponse,
    wire: [
      {
        devices: [{ id: DEV, name: "phone", pairedAt: AT, lastSeenAt: AT, expiresAt: AT }],
      },
      {
        devices: [
          { id: DEV, name: `${"x".repeat(63)}\ud83d`, pairedAt: AT, lastSeenAt: AT, expiresAt: AT },
          { id: DEV, name: "\udc4d first", pairedAt: AT, lastSeenAt: AT, expiresAt: AT },
        ],
      },
    ],
  },
  DismissAttentionRequest: { schema: DismissAttentionRequest, wire: [{ idempotencyKey: KEY }] },
  DismissAttentionResponse: { schema: DismissAttentionResponse, wire: [{ eventIds: [4] }] },
  DismissNoticeRequest: { schema: DismissNoticeRequest, wire: [{ idempotencyKey: KEY }] },
  DismissNoticeResponse: { schema: DismissNoticeResponse, wire: [{ eventIds: [4] }] },
  DoctorResponse: {
    schema: DoctorResponse,
    wire: [fullDoctor, bareDoctor, nullDoctor, certless, lanless],
  },
  EnvRefreshRequest: { schema: EnvRefreshRequest, wire: [{ env: { PATH: "/bin", HOME: "/h" } }] },
  EnvRefreshResponse: {
    schema: EnvRefreshResponse,
    wire: [
      { capturedAt: AT, kept: 12, removed: { secrets: 2 }, refused: ["BAD"], unchanged: [AGENT] },
    ],
  },
  ErrorResponse: {
    schema: ErrorResponse,
    wire: [
      { error: "unpaired", message: "pair this browser: run `bazhen devices pair`" },
      { error: "host_not_allowed", message: "evil.example" },
      { error: "origin_not_allowed", message: "" },
      {
        error: "busy",
        message: "a program runs in it",
        busy: [{ terminalId: TERM, program: "vim" }],
      },
    ],
  },
  EscalateRequest: {
    schema: EscalateRequest,
    wire: [
      { idempotencyKey: KEY, summary: "Pin it?" },
      { idempotencyKey: KEY, summary: "?", taskId: TASK },
    ],
  },
  EscalateResponse: { schema: EscalateResponse, wire: [{ attentionId: ATTN }] },
  EventEnvelopeFrame: {
    schema: EventEnvelopeFrame,
    wire: [
      {
        type: "event",
        event: {
          id: 41,
          ts: AT,
          type: "terminal.renamed",
          entityType: "terminal",
          entityId: TERM,
          actor: "user",
          causationId: null,
          correlationId: null,
          payload: { name: "build" },
        },
      },
      {
        type: "event",
        event: {
          id: 42,
          ts: AT,
          type: "agent.renamed",
          entityType: "agent",
          entityId: AGENT,
          actor: AGENT,
          causationId: 41,
          correlationId: KEY,
          payload: { name: "reviewer", previous: "bazhen-3" },
        },
      },
      { type: "reset", reason: "stale" },
      { type: "reset", reason: "foreign" },
    ],
  },
  /**
   * zod writes `Event` as an `anyOf` whose branches share their payloads' paths, so one type's
   * enum would be planted in another's payload. Its own branches, discriminated by type, keep
   * each type's apart, and parse every event alike.
   */
  Event: { schema: z.discriminatedUnion("type", atLeastOne(Event.options)), wire: EVENT_WIRE },
  RecordedEvent: {
    schema: z.discriminatedUnion("type", atLeastOne(RecordedEvent.options)),
    wire: PAYLOAD_WIRE,
  },
  EventStreamQuery: {
    schema: EventStreamQuery,
    wire: [{ epoch: "0190c3b2a1d47a3b8c1d2e3f4a5b6c7d", after: "41" }],
  },
  FinishTaskRequest: {
    schema: FinishTaskRequest,
    wire: [
      { idempotencyKey: KEY, outcome: "done" },
      { idempotencyKey: KEY, outcome: "cancelled", note: "n", cascade: true },
    ],
  },
  FleetAgent: {
    schema: FleetAgent,
    printed: true,
    wire: [
      {
        id: AGENT,
        name: "BZ-127",
        harness: "codex",
        state: "running",
        project: "bazhen",
        cwd: "/work",
        launchedBy: AGENT2,
        signal: { value: "limited", source: "native", ageSeconds: 125, resetsAt: AT },
        listening: true,
        headline: { text: "Halfway.", taskId: TASK, ageSeconds: 30 },
        tasks: [{ taskId: TASK, assignmentId: ASGN, role: "worker" }],
        attention: [{ id: ATTN, kind: "approval" }],
      },
      {
        id: AGENT,
        name: "",
        harness: "claude-code",
        state: "starting",
        project: "p",
        cwd: "/w",
        launchedBy: null,
        signal: null,
        listening: false,
        headline: null,
        tasks: [],
        attention: [],
      },
      {
        id: AGENT2,
        name: "",
        harness: "claude-code",
        state: "running",
        project: "p",
        cwd: "/w",
        launchedBy: null,
        signal: { value: "working", source: "native", ageSeconds: 4 },
        listening: false,
        headline: null,
        tasks: [],
        attention: [],
      },
    ],
  },
  HealthResponse: {
    schema: HealthResponse,
    wire: [
      {
        status: "ok",
        appVersion: "0.1.0",
        protocolId: "a".repeat(64),
        runtimes: [
          { kind: "holder", state: "not-running", version: "holder/1.2" },
          { kind: "tmux", state: "healthy", version: "3.4", workarounds: ["w"] },
          { kind: "other", state: "unreachable", version: null },
        ],
      },
      {
        status: "ok",
        appVersion: "0.1.0",
        protocolId: "b".repeat(64),
        runtimes: [
          { kind: "holder", state: "healthy", version: "holder/1.2" },
          { kind: "tmux", state: "unused", version: null },
        ],
      },
    ],
  },
  HookAck: { schema: HookAck, wire: [{ agentId: AGENT, offered: [OFFER] }] },
  HookReply: {
    schema: HookReply,
    wire: [
      { exitCode: 2, stdout: "", stderr: "Message for you", offered: [OFFER, `${MSG}-1`] },
      { exitCode: 0, stdout: "{}", stderr: "", offered: [] },
    ],
  },
  HookRequest: {
    schema: HookRequest,
    wire: [
      {
        protocolVersion: "1.0",
        agentId: AGENT,
        event: "Stop",
        pid: 42,
        ppid: 41,
        payload: { session_id: "s", prompt_id: "p", nested: [1, null, "\ud83d"] },
      },
      { protocolVersion: "1.12", agentId: AGENT, event: "wait", pid: -1, ppid: 0, payload: null },
      { protocolVersion: "1.0", agentId: AGENT, event: "statusline", pid: 1, ppid: 1, payload: 7 },
    ],
  },
  LaunchAgentRequest: {
    schema: LaunchAgentRequest,
    wire: [
      { idempotencyKey: KEY, harness: "claude-code", cwd: "/work" },
      {
        idempotencyKey: KEY,
        harness: "codex",
        cwd: "~/w",
        project: "bazhen",
        theme: "light",
        name: "reviewer",
        role: "worker",
        compactWindowTokens: 300_000,
      },
    ],
  },
  LaunchAgentResponse: {
    schema: LaunchAgentResponse,
    wire: [
      { agentId: AGENT, terminalId: TERM, eventIds: [1, 2] },
      { agentId: AGENT, terminalId: null, eventIds: [] },
    ],
  },
  OpenShellRequest: {
    schema: OpenShellRequest,
    wire: [
      { idempotencyKey: KEY },
      { idempotencyKey: KEY, linkedAgentId: AGENT, theme: "dark" },
      { idempotencyKey: KEY, cwd: "~/work", theme: "light" },
    ],
  },
  PairRequest: {
    schema: PairRequest,
    wire: [{ code: "abcd-2345" }, { code: "ABCD 2345", name: "Phone" }],
  },
  PairResponse: { schema: PairResponse, wire: [{ deviceId: DEV, name: "Phone" }] },
  PairingCodeResponse: {
    schema: PairingCodeResponse,
    wire: [
      { code: "ABCD2345", expiresAt: AT, origins: [] },
      {
        code: "ABCD2345",
        expiresAt: AT,
        origins: ["https://box.ts.net"],
        lan: { url: "https://m.local:7942", fingerprint: "AB:CD", expiresAt: AT },
      },
    ],
  },
  RelaunchAgentRequest: {
    schema: RelaunchAgentRequest,
    wire: [
      { idempotencyKey: KEY, generation: 2 },
      { idempotencyKey: KEY, generation: 2, theme: "dark", fresh: true },
    ],
  },
  RenameAgentRequest: {
    schema: RenameAgentRequest,
    wire: [{ idempotencyKey: KEY, name: "reviewer" }],
  },
  RenameShellRequest: {
    schema: RenameShellRequest,
    wire: [
      { idempotencyKey: KEY, name: " build " },
      { idempotencyKey: KEY, name: null },
    ],
  },
  RestartShellRequest: {
    schema: RestartShellRequest,
    wire: [
      { idempotencyKey: KEY, generation: 0 },
      { idempotencyKey: KEY, generation: 3, theme: "dark", retype: true },
    ],
  },
  RespawnAgentRequest: {
    schema: RespawnAgentRequest,
    wire: [
      { idempotencyKey: KEY, generation: 1 },
      { idempotencyKey: KEY, generation: 1, theme: "light" },
    ],
  },
  RevokeDeviceResponse: { schema: RevokeDeviceResponse, wire: [{}] },
  RolesResponse: {
    schema: RolesResponse,
    wire: [
      {
        roles: [role, { ...role, maxActiveTasks: null, source: "builtin" }],
        problems: [{ file: "/r/x.md", problem: "no prompt" }],
      },
    ],
  },
  ReplyAttentionRequest: {
    schema: ReplyAttentionRequest,
    wire: [{ idempotencyKey: KEY, body: "yes, go on" }],
  },
  ReplyAttentionResponse: {
    schema: ReplyAttentionResponse,
    wire: [
      { messageId: MSG, eventIds: [5, 6] },
      { messageId: null, eventIds: [5] },
    ],
  },
  ResendAttentionRequest: { schema: ResendAttentionRequest, wire: [{ idempotencyKey: KEY }] },
  ResendAttentionResponse: {
    schema: ResendAttentionResponse,
    wire: [{ messageId: MSG, eventIds: [7, 8] }],
  },
  SendMessageRequest: { schema: SendMessageRequest, wire: [{ idempotencyKey: KEY, body: "hi" }] },
  SendMessageResponse: { schema: SendMessageResponse, wire: [{ messageId: MSG, eventIds: [1] }] },
  ShellCommandResponse: {
    schema: ShellCommandResponse,
    wire: [
      { terminalId: TERM, eventIds: [4] },
      { terminalId: TERM, eventIds: [] },
    ],
  },
  ShellDecline: { schema: ShellDecline, wire: [{ token: "shell-token" }] },
  ShellPrompt: {
    schema: ShellPrompt,
    wire: [{ token: "shell-token" }, { token: "shell-token", brackets: true }],
  },
  ShellReport: {
    schema: ShellReport,
    wire: [
      { token: "shell-token", at: 1_700_000_000_000_000, command: "make test" },
      { token: "shell-token", at: 0, command: null },
    ],
  },
  TerminalScreen: {
    schema: TerminalScreen,
    wire: [
      { text: "$ ls\nREADME.md\n", history: 1 },
      { text: "", history: 0 },
    ],
  },
  SignalAgentRequest: {
    schema: SignalAgentRequest,
    wire: [{ idempotencyKey: KEY, generation: 4, signal: "SIGTERM" }],
  },
  StateSnapshot: { schema: StateSnapshot, wire: [fullState, oldState, ...loneStates] },
  StopResponse: { schema: StopResponse, wire: [{}] },
  StreamClientFrame: {
    schema: StreamClientFrame,
    wire: [
      { type: "hello", protocolId: "f".repeat(64), mode: "interactive", cols: 120, rows: 40 },
      {
        type: "hello",
        mode: "observe",
        cols: 2,
        rows: 1000,
        resumes: { attachmentId: ATT, token: "r".repeat(43) },
      },
      { type: "resize", cols: 1000, rows: 2 },
      { type: "engage" },
      { type: "epoch", epoch: 0 },
      { type: "epoch", epoch: 7 },
      { type: "ping" },
    ],
  },
  StreamServerFrame: {
    schema: StreamServerFrame,
    wire: [
      { type: "attached", attachmentId: ATT, resumeToken: "r".repeat(43) },
      { type: "attached", attachmentId: ATT },
      { type: "lease", driver: true, epoch: 3 },
      { type: "lease", driver: false, epoch: 4, driven: true, driverDevice: "Phone" },
      { type: "pong" },
      { type: "snapshot_start", historyLines: 10_000 },
      { type: "snapshot_start" },
      { type: "snapshot_end" },
      { type: "geometry", cols: 1, rows: 1 },
      { type: "input_dropped" },
      { type: "screen", alternate: true },
      { type: "exited", generation: 2, exit: { type: "exited", code: 0 } },
      { type: "exited", generation: 0, exit: { type: "signalled", signal: "SIGHUP" } },
      { type: "exited", generation: 1, exit: { type: "unknown" } },
      { type: "closed" },
      { type: "ended", reason: "evicted_slow" },
      { type: "error", message: "no such terminal" },
      { type: "notice", message: "the runtime refused the resize" },
    ],
  },
  TaskCommandResponse: { schema: TaskCommandResponse, wire: [{ eventIds: [2] }] },
  TaskDetail: {
    schema: TaskDetail,
    wire: [
      {
        ...task,
        brief: "b",
        note: "shipped",
        assignments: [assignment, activeAssignment],
        subtasks: [orphanTask],
        notes: [taskNote, { ...taskNote, agentId: null, role: null, handoff: false }],
      },
      { ...orphanTask, brief: "b", note: null, assignments: [], subtasks: [] },
    ],
  },
  UnassignTaskRequest: {
    schema: UnassignTaskRequest,
    wire: [{ idempotencyKey: KEY, assignmentId: ASGN }],
  },
  UnlinkShellRequest: {
    schema: UnlinkShellRequest,
    wire: [{ idempotencyKey: KEY, generation: 2 }],
  },
  WaitRequest: {
    schema: WaitRequest,
    wire: [
      { condition: { on: "agent", agentId: AGENT, until: "idle" }, timeoutMs: 60_000 },
      { condition: { on: "agent", agentId: AGENT, until: "running" }, timeoutMs: 0 },
      { condition: { on: "shell", shellId: TERM, until: "ended" }, timeoutMs: 600_000 },
      { condition: { on: "shell", shellId: TERM, until: "running" }, timeoutMs: 1 },
      { condition: { on: "task", taskId: TASK, until: "done" }, timeoutMs: 60_000 },
      { condition: { on: "reply", messageId: MSG }, timeoutMs: 60_000 },
      {
        condition: { on: "shell", shellId: TERM, until: "ended" },
        timeoutMs: 60_000,
        resumed: true,
      },
    ],
  },
  WaitResponse: {
    schema: WaitResponse,
    wire: [
      ...[
        fullAgent,
        bareAgent,
        nullAgent,
        { ...bareAgent, exit: { type: "unknown" }, needsRestart: null },
      ].map((agent) => ({ verdict: "met", said: "worker-1 is idle", agent })),
      ...[fullShell, bareShell, nullShell, unservedShell].map((shell) => ({
        verdict: "never",
        said: "logs is closed, and can't be running now",
        shell,
      })),
      ...[task, orphanTask].map((t) => ({ verdict: "pending", said: "t is open", task: t })),
      { verdict: "met", said: "worker-1 replied", agent: bareAgent, replyId: MSG },
      { verdict: "bounced", said: "the message to worker-1 bounced" },
    ],
  },
  WaitMessagesRequest: {
    schema: WaitMessagesRequest,
    wire: [{ messageIds: [MSG], timeoutMs: 60_000 }],
  },
  WaitMessagesResponse: {
    schema: WaitMessagesResponse,
    wire: [{ messages: [{ id: MSG, agentId: AGENT, state: "seen" }] }],
  },
};

/** A field no version of the protocol has, which a reader of an open object must pass over. */
const UNKNOWN_FIELD = "fieldFromANewerDaemon";

/**
 * One fixture: the value on the wire, and what the protocol's schema makes of it, each lone
 * surrogate in its text made U+FFFD, as a reader holding text as UTF-8 must and as Node prints
 * one. A printed message carries its parsed value's JSON too, so the order of its keys is held.
 */
export interface Fixture {
  readonly name: string;
  readonly wire: unknown;
  readonly parsed: unknown;
  readonly text?: string;
}

const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function schemaOf(schema: z.ZodType): JsonSchema {
  const json: unknown = z.toJSONSchema(schema, { io: "input" });
  if (!isSchema(json)) throw new Error("zod wrote a JSON Schema that isn't an object");
  return json;
}

/**
 * The examples of one message, and from the first holding each enum's place, one more for every
 * value of that enum, and one carrying a field the message doesn't define. Throws when they leave
 * any of the message unexercised.
 */
export function messageFixtures(name: string, example: Example): Fixture[] {
  const schema = schemaOf(example.schema);
  const wire: { name: string; value: unknown }[] = example.wire.map((value, i) => ({
    name: `example ${i + 1}`,
    value,
  }));
  for (const [path, values] of enumPaths(schema)) {
    for (const value of values) {
      const base = example.wire
        .map((w) => replaceAt(w, path, value))
        .filter((w) => w !== undefined)
        .toSorted((a, b) => JSON.stringify(a).length - JSON.stringify(b).length)[0];
      if (base !== undefined)
        wire.push({ name: `${path} = ${JSON.stringify(value)}`, value: base });
    }
  }
  example.wire.forEach((value, i) => {
    wire.push({
      name: `example ${i + 1}, with a field no version defines in each of its objects`,
      value: withField(schema, value, UNKNOWN_FIELD),
    });
  });
  const gaps = uncovered(
    schema,
    wire.map((w) => w.value),
  );
  if (gaps.length > 0)
    throw new Error(`fixtures for ${name} leave unexercised: ${gaps.join(", ")}`);
  return wire.map((w) => {
    const parsed = wellFormed(example.schema.parse(w.value));
    return {
      name: w.name,
      wire: w.value,
      parsed,
      ...(example.printed === true ? { text: JSON.stringify(parsed) } : {}),
    };
  });
}

/** A check another language makes the same way: an input, and the protocol's verdict on it. */
const verdicts = (schema: z.ZodType, inputs: readonly string[]) =>
  inputs.map((input) => {
    const r = schema.safeParse(input);
    return r.success
      ? { input, ok: true, value: r.data }
      : { input, ok: false, message: r.error.issues.map((i) => i.message).join("; ") };
  });

const ID_BODY = "0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const NAME_INPUTS = [
  "BZ-127",
  "a",
  "9lives",
  "agent_tools",
  "x".repeat(AGENT_NAME_MAX),
  "x".repeat(AGENT_NAME_MAX + 1),
  "",
  "-x",
  "_x",
  "a b",
  "a.b",
  "é",
  `agent_${ID_BODY}`,
  `task_${ID_BODY}`,
  `term_${ID_BODY}`,
  `agent_${ID_BODY}x`,
  `agent_${ID_BODY.toUpperCase()}`,
  "../tasks",
];
const ID_INPUTS = [
  `task_${ID_BODY}`,
  `task_${ID_BODY.slice(0, 12)}6${ID_BODY.slice(13)}`,
  `task_${ID_BODY.slice(0, 16)}7${ID_BODY.slice(17)}`,
  `task_${ID_BODY.slice(1)}`,
  `agent_${ID_BODY}`,
  "task_x",
  "",
];
const OFFER_INPUTS = [
  `msg_${ID_BODY}-k3x9`,
  `msg_${ID_BODY}-${"z".repeat(32)}`,
  `msg_${ID_BODY}-${"z".repeat(33)}`,
  `msg_${ID_BODY}-`,
  `msg_${ID_BODY}-K`,
  `msg_${ID_BODY}-a-b`,
  `msg_${ID_BODY}`,
  `msg_${ID_BODY.toUpperCase()}-1`,
  `msg_${ID_BODY.slice(1)}-1`,
  `msg_${ID_BODY}0-1`,
  `msg_${"g".repeat(32)}-1`,
  `agent_${ID_BODY}-1`,
  "",
];
const VERSION_INPUTS = ["1.0", "10.12", "1", "1.", ".1", "1.0.0", "v1.0", "1.x", "١.٠", ""];
const ROLE_INPUTS = ["worker", "a", "a-1", "x".repeat(32), "x".repeat(33), "Lead", "1x", "-x", ""];
const BIG = "é".repeat(TASK_NOTE_MAX_BYTES / 2);
const NOTE_INPUTS = [
  "Tests pass.",
  "  padded\n",
  "\t\n\u000b\f\r       　x　",
  "﻿bom",
  "x﻿",
  "\u0085x",
  "line\nnext\ttab",
  "",
  "   ",
  "\u001b[31mred",
  "x\u007f",
  "x\u009f",
  "x y",
  "x‪",
  "x‮",
  "x⁦",
  "x⁩",
  "x؜",
  "x​",
  "x‌",
  "x‏",
  "x y",
  "x⁠",
  "x⁤",
  "x\u{e0000}",
  "x\u{e007f}",
  "x\u{e0080}",
  "👍",
  BIG,
  `${BIG}x`,
  `${BIG.slice(1)}xy`,
  `\u001b${BIG}`,
];
const ORIGIN_INPUTS = [
  "http://192.168.1.5:7900",
  "http://box.ts.net",
  "https://box.ts.net",
  "http://localhost:7901",
  "http://127.0.0.1:7900",
  "http://[::1]:7900",
  "http://LOCALHOST:7901",
  "http://127.0.0.2",
];
/**
 * Origins as a user might write one: canonical, and each way a URL parser would read it as
 * another, which a browser never sends.
 */
const ORIGIN_FORMS = [
  ...ORIGIN_INPUTS,
  "https://bazhen.example.com",
  "https://bazhen.example.com/",
  "https://bazhen.example.com/app",
  "https://bazhen.example.com?a=1",
  "https://bazhen.example.com?",
  "https://bazhen.example.com#top",
  "https://bazhen.example.com#",
  "https://user@bazhen.example.com",
  "https://user:pass@bazhen.example.com",
  "https://@bazhen.example.com",
  "https://Bazhen.example.com",
  "HTTPS://bazhen.example.com",
  "Https://bazhen.example.com",
  "https:bazhen.example.com",
  "https:/bazhen.example.com",
  "https:///bazhen.example.com",
  "https:\\\\bazhen.example.com",
  "https://bazhen.example.com\\",
  " https://bazhen.example.com",
  "https://bazhen.example.com ",
  "https://bazhen.example.com\n",
  "https://baz\then.example.com",
  "https://baz hen.example.com",
  "ftp://bazhen.example.com",
  "ws://bazhen.example.com",
  "file:///tmp",
  "bazhen.example.com",
  "//bazhen.example.com",
  "",
  "https://",
  "http://",
  "https://:443",
  "https://bazhen.example.com:443",
  "http://bazhen.example.com:443",
  "https://bazhen.example.com:80",
  "http://bazhen.example.com:80",
  "http://bazhen.example.com:080",
  "https://bazhen.example.com:0443",
  "https://bazhen.example.com:8443",
  "https://bazhen.example.com:08443",
  "https://bazhen.example.com:0",
  "https://bazhen.example.com:00",
  "https://bazhen.example.com:65535",
  "https://bazhen.example.com:65536",
  "https://bazhen.example.com:99999999999999999999",
  "https://bazhen.example.com:",
  "https://bazhen.example.com:+80",
  "https://bazhen.example.com:8a",
  "https://bazhen.example.com:８０",
  "https://bazhen.example.com.",
  "https://bazhen.example.com..",
  "https://.bazhen.example.com",
  "https://bazhen..example.com",
  "https://.",
  "https://..",
  "https://a",
  "https://-a-.example",
  "https://a_b.example",
  "https://_",
  "https://a~b!$&'()*+,;=`{}\".example",
  "https://a*b.example",
  "https://a%41.example",
  "https://a%2541.example",
  "https://a%zz.example",
  "https://a#b.example",
  "https://a<b.example",
  "https://a>b.example",
  "https://a^b.example",
  "https://a|b.example",
  "https://a[b.example",
  "https://a]b.example",
  "https://a\u007fb.example",
  "https://a\u0000b.example",
  "https://bücher.example",
  "https://xn--bcher-kva.example",
  "https://xn--bcher-KVA.example",
  "https://xn--.example",
  "https://xn--zz.example",
  "https://ＢＡＺＨＥＮ.example",
  "https://ß.example",
  "https://a\u00adb.example",
  "https://a\u200bb.example",
  "https://ａ.example",
  "https://例え.テスト",
  "https://bazhen.example.com/ü",
  "https://1.2.3.4",
  "https://0.0.0.0",
  "https://255.255.255.255",
  "https://256.0.0.1",
  "https://1.2.3.256",
  "https://01.2.3.4",
  "https://1.2.3.04",
  "https://0x7f.0.0.1",
  "https://0x7f000001",
  "https://2130706433",
  "https://127.1",
  "https://1.2.3",
  "https://1.2.3.4.",
  "https://1.2.3.4..",
  "https://1.2.3.4.5",
  "https://.1.2.3.4",
  "https://1..2.3",
  "https://a.1",
  "https://a.1.",
  "https://a.0x",
  "https://a.0x1f",
  "https://a.0X1F",
  "https://a.0xg",
  "https://a.09",
  "https://a.1a",
  "https://1a",
  "https://1e3",
  "https://0x",
  "https://0X",
  "https://99999999999",
  "https://4294967295",
  "https://4294967296",
  "https://１.２.３.４",
  "https://[::1]",
  "https://[::1]:443",
  "https://[::1]:8443",
  "https://[::1]:",
  "https://[::1]:08443",
  "https://[::]",
  "https://[::0]",
  "https://[0::]",
  "https://[0:0:0:0:0:0:0:0]",
  "https://[0:0:0:0:0:0:0:1]",
  "https://[1::]",
  "https://[1::1]",
  "https://[1:0::1]",
  "https://[1:2:3:4:5:6:7:8]",
  "https://[1:2:3:4:5:6:7::]",
  "https://[1:2:3:4:5:6::8]",
  "https://[::2:3:4:5:6:7:8]",
  "https://[1:0:0:4:0:0:7:8]",
  "https://[1::4:0:0:7:8]",
  "https://[1:0:0:4::7:8]",
  "https://[0:0:1:0:0:0:1:0]",
  "https://[0:0:1::1:0]",
  "https://[1:0:1:0:1:0:1:0]",
  "https://[fd00::1]",
  "https://[FD00::1]",
  "https://[fd00::0001]",
  "https://[fd00:0::1]",
  "https://[::ffff:1.2.3.4]",
  "https://[::ffff:102:304]",
  "https://[::1.2.3.4]",
  "https://[::102:304]",
  "https://[::1%25eth0]",
  "https://[fe80::1%eth0]",
  "https://[::1",
  "https://::1]",
  "https://::1",
  "https://[]",
  "https://[:]",
  "https://[:::]",
  "https://[1:2:3:4:5:6:7:8:9]",
  "https://[12345::]",
  "https://[g::]",
  "https://[::1].example",
  "https://[::1]x",
];

const QUOTE_INPUTS = ["one", "a\n\nb", "", "\n", "end\n", "  indented"];
const DATETIME_INPUTS = [
  "2026-11-16T12:00:00.000Z",
  "2026-11-16T12:00:00Z",
  "2026-11-16T12:00Z",
  "2026-11-16T12:00:00.5Z",
  "2026-11-16T12:00:00.123456Z",
  "1969-12-31T23:59:59.999Z",
  "0000-01-01T00:00:00Z",
  "2024-02-29T00:00:00Z",
  "2026-02-29T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-11-31T00:00:00Z",
  "2026-11-16T24:00:00Z",
  "2026-11-16T12:60:00Z",
  "2026-11-16T12:00:60Z",
  "2026-11-16T12:00:00+01:00",
  "2026-11-16T12:00:00",
  "2026-11-16 12:00:00Z",
  "2026-11-16t12:00:00z",
  "+2026-11-16T12:00:00Z",
  "",
];

const E = "\x1b";
/** A view's input as one byte per character: keys, replies, reports and pastes, alone and mixed. */
const KEY_INPUTS = [
  "a",
  "",
  "\r",
  "\xe9",
  E,
  `${E}[`,
  `${E}[A`,
  `${E}[1;2R`,
  `${E}[I`,
  `${E}[O`,
  `${E}[I${E}[O`,
  `${E}[Ix`,
  `${E}[<65;10;5M`,
  `${E}[<0;10;5m`,
  `${E}[96;10;5M`,
  `${E}[Ma*%`,
  `${E}[?62;22c`,
  `${E}[>0;276;0c`,
  `${E}[c`,
  `${E}[0n`,
  `${E}[?1;2R`,
  `${E}[?2004;1$y`,
  `${E}[2004;2$y`,
  `${E}[8;24;80t`,
  `${E}P1$r0m${E}\\`,
  `${E}P>|xterm(388)${E}\\`,
  `${E}P1$r0m`,
  `${E}Pabc${E}\\`,
  `${E}P1+r544e=787465726d${E}\\`,
  "5M",
  `${E}]10;rgb:ffff/ffff/ffff${E}\\`,
  `${E}]4;1;rgb:cd/00/00\x07`,
  `${E}]11;rgb:00/00/00`,
  `${E}[?62;22c${E}[<0;1;1M${E}[O`,
  `${E}[?62;22cq`,
  `${E}[200~${E}[I${E}[201~`,
  `${E}[200~unended`,
  `${E}[200~${E}[0n${E}[201~`,
  `${E}[200~x${E}[201~${E}[0n`,
  `${E}[0n${E}[200~${E}[0n`,
];

/** Detach sequences: each kind of key, each refusal, and what only ASCII's case folding refuses. */
const DETACH_INPUTS = [
  "ctrl-],ctrl-]",
  "ctrl-p,ctrl-q",
  "CTRL-A,Ctrl-z",
  "ctrl-@,ctrl-\\,ctrl-^,ctrl-_",
  "x,ctrl-[",
  "~,.",
  "q",
  "a,b,c,d,e,f,g,h",
  "a,b,c,d,e,f,g,h,i",
  "ctrl-[,x",
  "",
  ",",
  "ctrl-],",
  "ctrl-",
  "ctrl-1",
  "ctrl-ab",
  "ctrl-]x",
  "ctrl-] ",
  " ",
  "ctrl-\u00e9",
  "\u00e9",
  "ctrl-\u212a",
  "\x7f",
  "\x1d",
  "\x1b[2J",
  "\t",
  'a"b\\',
  "\u{1f600}",
  "ctrl-p, ctrl-q",
];

/** The checks a client makes before it asks the daemon, with the protocol's verdicts. */
export function checkFixtures() {
  return {
    constants: {
      messageWaitMaxMs: MESSAGE_WAIT_MAX_MS,
      taskNoteMaxBytes: TASK_NOTE_MAX_BYTES,
      agentNameMax: AGENT_NAME_MAX,
      streamFrameMaxBytes: STREAM_FRAME_MAX_BYTES,
      pairingAlphabet: PAIRING_ALPHABET,
      pairingCodeLength: PAIRING_CODE_LENGTH,
      deviceNameMax: DEVICE_NAME_MAX,
      devicePaired: DEVICE_PAIRED,
      hookProtocolVersion: HOOK_PROTOCOL_VERSION,
      hookReplyType: HOOK_REPLY_TYPE,
      hookReplyMaxBytes: HOOK_REPLY_MAX_BYTES,
      settled: [...SETTLED].toSorted(),
      harnesses: HarnessId.options,
      agentConditions: AgentCondition.options.flatMap((o) => o.options),
      shellConditions: ShellCondition.options.flatMap((o) => o.options),
    },
    agentName: verdicts(AgentName, NAME_INPUTS),
    agentRef: verdicts(AgentRef, NAME_INPUTS),
    taskId: verdicts(Id("task"), ID_INPUTS),
    role: verdicts(Role, ROLE_INPUTS),
    offerToken: verdicts(OfferToken, OFFER_INPUTS),
    protocolVersion: verdicts(ProtocolVersion, VERSION_INPUTS),
    taskNoteText: verdicts(TaskNoteText, NOTE_INPUTS),
    plainRemote: ORIGIN_INPUTS.map((input) => ({ input, plain: isPlainRemote(input) })),
    origin: ORIGIN_FORMS.map((input) => ({ input, origin: isOrigin(input) })),
    datetime: DATETIME_INPUTS.map((input) =>
      z.iso.datetime().safeParse(input).success
        ? { input, ok: true, ms: Date.parse(input) }
        : { input, ok: false },
    ),
    quoteNote: QUOTE_INPUTS.map((input) => ({ input, quoted: quoteNote(input) })),
    keystrokes: KEY_INPUTS.map((input) => ({
      input,
      keystrokes: hasKeystrokes(input),
      withoutReplies: withoutReplies(input),
    })),
    detachKeys: DETACH_INPUTS.map((input) => {
      const read = readDetachKeys(input);
      return "problem" in read
        ? { input, ok: false, message: read.problem }
        : { input, ok: true, value: read.shown };
    }),
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The files of `fixtures/api/`, by name: one per message, and the checks. */
export function apiFixtures(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(MESSAGES).map(([name, example]) => [
        `${name}.json`,
        json(messageFixtures(name, example)),
      ]),
    ),
    "checks.json": json(checkFixtures()),
  };
}
