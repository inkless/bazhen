// Written by `cargo xtask schema` from the Rust protocol crates. Don't edit it: change the Rust types.

import { z } from "zod";
import * as checks from "../checks.ts";

export const ActivitySource = z.enum(["native", "heuristic"]);
export type ActivitySource = z.infer<typeof ActivitySource>;

export const ActivityValue = z.enum(["working", "waiting_input", "needs_approval", "idle", "done", "failed", "limited", "unknown"]);
export type ActivityValue = z.infer<typeof ActivityValue>;

export const AgentCli = z.object({ expected: z.string().nullable(), onPath: z.string().nullable() });
export type AgentCli = z.infer<typeof AgentCli>;

export const AgentCommand = z.enum(["close", "respawn", "signal", "relaunch"]);
export type AgentCommand = z.infer<typeof AgentCommand>;

export const AgentCondition = z.enum(["starting", "running", "exited", "unknown", "lost", "closing", "closed", "failed", "ended", "ready", "idle"]);
export type AgentCondition = z.infer<typeof AgentCondition>;

export const AgentFailedReason = z.enum(["launch_rejected", "daemon_restart"]);
export type AgentFailedReason = z.infer<typeof AgentFailedReason>;

export const AgentName = z.string().regex(new RegExp("^(?!(?:host|env|agent|task|asgn|attn|ntc|msg|term|dev|att|lease|obs)_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$)[A-Za-z0-9][A-Za-z0-9_-]{0,39}$"), { message: "a name is 1 to 40 letters, digits, - or _, starts with a letter or digit, and isn't an id" });
export type AgentName = z.infer<typeof AgentName>;

export const AgentShell = z.enum(["direct", "login"]);
export type AgentShell = z.infer<typeof AgentShell>;

export const AgentState = z.enum(["starting", "running", "exited", "unknown", "lost", "closing", "closed", "failed"]);
export type AgentState = z.infer<typeof AgentState>;

export const ApprovalDecision = z.enum(["allow", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const AssignmentEndReason = z.enum(["unassigned", "completed", "task_finished", "agent_closed", "parent_ended"]);
export type AssignmentEndReason = z.infer<typeof AssignmentEndReason>;

export const AssignmentEndedReason = z.enum(["unassigned", "completed"]);
export type AssignmentEndedReason = z.infer<typeof AssignmentEndedReason>;

export const AssignmentState = z.enum(["active", "ended"]);
export type AssignmentState = z.infer<typeof AssignmentState>;

export const AttachmentEndReason = z.enum(["client_closed", "terminal_closed", "attach_failed", "daemon_restart", "disconnected", "evicted_slow", "timed_out", "replaced"]);
export type AttachmentEndReason = z.infer<typeof AttachmentEndReason>;

export const AttachmentMode = z.enum(["observe", "interactive"]);
export type AttachmentMode = z.infer<typeof AttachmentMode>;

export const AttentionAction = z.enum(["allow", "deny", "reply", "resend", "dismiss"]);
export type AttentionAction = z.infer<typeof AttentionAction>;

export const AttentionCloseReason = z.enum(["answered", "answered_in_tui", "timed_out", "superseded", "agent_closed", "stale", "replied", "dismissed", "resent"]);
export type AttentionCloseReason = z.infer<typeof AttentionCloseReason>;

export const AttentionClosedReason = z.enum(["answered_in_tui", "timed_out", "superseded", "agent_closed", "stale", "replied", "dismissed", "resent"]);
export type AttentionClosedReason = z.infer<typeof AttentionClosedReason>;

export const AttentionKind = z.enum(["approval", "question", "failed", "undeliverable", "escalation", "task_done", "stuck_starting"]);
export type AttentionKind = z.infer<typeof AttentionKind>;

export const AttentionState = z.enum(["open", "closed"]);
export type AttentionState = z.infer<typeof AttentionState>;

export const BusyShell = z.object({ program: z.string().max(200), terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) });
export type BusyShell = z.infer<typeof BusyShell>;

export const CallerResponse = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable() });
export type CallerResponse = z.infer<typeof CallerResponse>;

export const ClientEventFrame = z.object({ type: z.literal("visibility"), visible: z.boolean() });
export type ClientEventFrame = z.infer<typeof ClientEventFrame>;

export const ClosedFrom = z.object({ id: z.string().regex(new RegExp("^dev_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), name: z.string() });
export type ClosedFrom = z.infer<typeof ClosedFrom>;

export const CompactWindowTokens = z.number().int().min(100000).max(10000000);
export type CompactWindowTokens = z.infer<typeof CompactWindowTokens>;

export const CompactedHook = z.object({ pid: z.number().int().min(-9007199254740991).max(9007199254740991), sessionId: z.string().nullable() });
export type CompactedHook = z.infer<typeof CompactedHook>;

export const CompactedSign = z.enum(["claude_hook", "codex_item"]);
export type CompactedSign = z.infer<typeof CompactedSign>;

export const ConfigFile = z.object({ found: z.boolean(), path: z.string() });
export type ConfigFile = z.infer<typeof ConfigFile>;

export const DaemonHolderStats = z.object({ engineBytes: z.number().int().min(0).max(9007199254740991), engineResets: z.number().int().min(0).max(9007199254740991).optional(), historyLines: z.number().int().min(0).max(9007199254740991), ringBytes: z.number().int().min(0).max(9007199254740991), rss: z.number().int().min(0).max(9007199254740991).nullable() });
export type DaemonHolderStats = z.infer<typeof DaemonHolderStats>;

export const EndedReason = z.enum(["evicted_slow", "disconnected"]);
export type EndedReason = z.infer<typeof EndedReason>;

export const EnvRefreshRequest = z.object({ env: z.record(z.string(), z.string()) });
export type EnvRefreshRequest = z.infer<typeof EnvRefreshRequest>;

export const EnvRefreshResponse = z.object({ capturedAt: z.string(), kept: z.number().int().min(0).max(9007199254740991), refused: z.array(z.string()), removed: z.record(z.string(), z.number().int().min(0).max(9007199254740991)), unchanged: z.array(z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$"))) });
export type EnvRefreshResponse = z.infer<typeof EnvRefreshResponse>;

export const EnvSource = z.enum(["start", "refresh"]);
export type EnvSource = z.infer<typeof EnvSource>;

export const EnvironmentKind = z.enum(["local", "opencode-server"]);
export type EnvironmentKind = z.infer<typeof EnvironmentKind>;

export const ErrorCode = z.enum(["invalid_request", "unsupported", "launch_failed", "conflict", "stale_generation", "not_resumable", "unavailable", "server_unconfirmed", "needs_restart", "busy", "not_found", "origin_not_allowed", "host_not_allowed", "forbidden", "unpaired", "pairing_failed", "rate_limited", "terminal_limit"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const EscalateResponse = z.object({ attentionId: z.string().regex(new RegExp("^attn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) });
export type EscalateResponse = z.infer<typeof EscalateResponse>;

export const EventId = z.number().int().min(1).max(9007199254740991);
export type EventId = z.infer<typeof EventId>;

export const EventStreamQuery = z.object({ after: z.string().regex(new RegExp("^\\d+$")), epoch: z.string().min(1) });
export type EventStreamQuery = z.infer<typeof EventStreamQuery>;

export const ExitStatus = z.discriminatedUnion("type", [z.object({ code: z.number().int().min(-9007199254740991).max(9007199254740991), type: z.literal("exited") }), z.object({ signal: z.string(), type: z.literal("signalled") }), z.object({ type: z.literal("unknown") })]);
export type ExitStatus = z.infer<typeof ExitStatus>;

export const ExternalRefKind = z.enum(["claude-session", "codex-thread"]);
export type ExternalRefKind = z.infer<typeof ExternalRefKind>;

export const FinishNoteText = z.string().max(20000).refine(checks.noteText, checks.noteText.message);
export type FinishNoteText = z.infer<typeof FinishNoteText>;

export const FleetHeadline = z.object({ ageSeconds: z.number().int().min(0).max(9007199254740991), taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), text: z.string() });
export type FleetHeadline = z.infer<typeof FleetHeadline>;

export const HarnessId = z.enum(["claude-code", "codex"]);
export type HarnessId = z.infer<typeof HarnessId>;

export const HealthStatus = z.enum(["ok"]);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const HolderAlternate = z.object({ offset: z.number().int().min(0).max(9007199254740991), on: z.boolean() });
export type HolderAlternate = z.infer<typeof HolderAlternate>;

export const HolderArgv = z.array(z.string().refine(checks.wellFormed, checks.wellFormed.message)).min(1);
export type HolderArgv = z.infer<typeof HolderArgv>;

export const HolderEnv = z.preprocess(checks.refusingOwnProto, z.record(z.string().regex(new RegExp("^(?!(?:__proto__)$)")).refine(checks.wellFormed, checks.wellFormed.message), z.string().refine(checks.wellFormed, checks.wellFormed.message)));
export type HolderEnv = z.infer<typeof HolderEnv>;

export const HolderExitCode = z.number().int().min(-9007199254740991).max(9007199254740991);
export type HolderExitCode = z.infer<typeof HolderExitCode>;

export const HolderForeground = z.object({ childPid: z.number().int().min(1).max(9007199254740991), childStart: z.number().int().min(0).max(9007199254740991), pgid: z.number().int().min(1).max(9007199254740991), pgidStart: z.number().int().min(0).max(9007199254740991) });
export type HolderForeground = z.infer<typeof HolderForeground>;

export const HolderGap = z.object({ from: z.number().int().min(0).max(9007199254740991), to: z.number().int().min(0).max(9007199254740991) });
export type HolderGap = z.infer<typeof HolderGap>;

export const HolderOk = z.object({ request: z.string().refine(checks.wellFormed, checks.wellFormed.message) });
export type HolderOk = z.infer<typeof HolderOk>;

export const HolderPasteRequest = z.object({ brackets: z.boolean(), generation: z.number().int().min(0).max(9007199254740991), text: z.string().refine(checks.wellFormed, checks.wellFormed.message).refine(checks.noControl, checks.noControl.message) }).refine(checks.unmarkedPasteIsAscii, checks.unmarkedPasteIsAscii.message);
export type HolderPasteRequest = z.infer<typeof HolderPasteRequest>;

export const HolderProtocolVersion = z.string().regex(new RegExp("^[0-9]+\\.[0-9]+$"));
export type HolderProtocolVersion = z.infer<typeof HolderProtocolVersion>;

export const HolderRequestName = z.enum(["hello", "snapshot", "subscribe", "input", "resize", "stats", "close", "signal", "foreground", "respawn", "set-tags", "set-theme", "paste", "screen"]);
export type HolderRequestName = z.infer<typeof HolderRequestName>;

export const HolderResized = z.object({ cols: z.number().int().min(0).max(1000), offset: z.number().int().min(0).max(9007199254740991), rows: z.number().int().min(0).max(1000) });
export type HolderResized = z.infer<typeof HolderResized>;

export const HolderRespawned = z.object({ childPid: z.number().int().min(1).max(9007199254740991), childStart: z.number().int().min(0).max(9007199254740991), generation: z.number().int().min(0).max(9007199254740991) });
export type HolderRespawned = z.infer<typeof HolderRespawned>;

export const HolderScreen = z.object({ history: z.number().int().min(0).max(9007199254740991), text: z.string().refine(checks.wellFormed, checks.wellFormed.message).refine(checks.screenText, checks.screenText.message) });
export type HolderScreen = z.infer<typeof HolderScreen>;

export const HolderScreenRequest = z.object({ history: z.number().int().min(0).max(9007199254740991) });
export type HolderScreenRequest = z.infer<typeof HolderScreenRequest>;

export const HolderSignal = z.enum(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]);
export type HolderSignal = z.infer<typeof HolderSignal>;

export const HolderSize = z.object({ cols: z.number().int().min(0).max(1000), rows: z.number().int().min(0).max(1000) });
export type HolderSize = z.infer<typeof HolderSize>;

export const HolderStats = z.object({ engineBytes: z.number().int().min(0).max(9007199254740991), engineResets: z.number().int().min(0).max(9007199254740991).optional(), historyLines: z.number().int().min(0).max(9007199254740991), ringBytes: z.number().int().min(0).max(9007199254740991), rss: z.number().int().min(0).max(9007199254740991).nullable() });
export type HolderStats = z.infer<typeof HolderStats>;

export const HolderSubscribeFrom = z.object({ generation: z.number().int().min(0).max(9007199254740991), offset: z.number().int().min(0).max(9007199254740991) });
export type HolderSubscribeFrom = z.infer<typeof HolderSubscribeFrom>;

export const HolderTags = z.preprocess(checks.refusingOwnProto, z.record(z.string().min(1).regex(new RegExp("^(?!(?:__proto__|constructor|prototype)$)")).refine(checks.wellFormed, checks.wellFormed.message).refine(checks.utf8AtMost64Bytes, checks.utf8AtMost64Bytes.message), z.string().refine(checks.wellFormed, checks.wellFormed.message).refine(checks.utf8AtMost1024Bytes, checks.utf8AtMost1024Bytes.message)));
export type HolderTags = z.infer<typeof HolderTags>;

export const HolderTerminalId = z.string().regex(new RegExp("^[A-Za-z0-9_-]{1,64}$"));
export type HolderTerminalId = z.infer<typeof HolderTerminalId>;

export const HolderTheme = z.enum(["light", "dark"]);
export type HolderTheme = z.infer<typeof HolderTheme>;

export const HolderTitle = z.object({ offset: z.number().int().min(0).max(9007199254740991), text: z.string().refine(checks.wellFormed, checks.wellFormed.message) });
export type HolderTitle = z.infer<typeof HolderTitle>;

export const HolderVersions = z.array(z.string().refine(checks.wellFormed, checks.wellFormed.message).refine(checks.utf8AtMost32Bytes, checks.utf8AtMost32Bytes.message)).min(1).max(16);
export type HolderVersions = z.infer<typeof HolderVersions>;

export const HookClient = z.object({ fallback: z.boolean(), path: z.string() });
export type HookClient = z.infer<typeof HookClient>;

export const HookEvent = z.string().min(1);
export type HookEvent = z.infer<typeof HookEvent>;

export const HostPtys = z.object({ exact: z.boolean(), max: z.number().int().min(1).max(9007199254740991), used: z.number().int().min(0).max(9007199254740991) });
export type HostPtys = z.infer<typeof HostPtys>;

export const IdempotencyKey = z.string().min(1).max(200);
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

export const MailboxState = z.enum(["queued", "offered", "emitted", "seen", "queued_in_codex", "delivered", "undeliverable"]);
export type MailboxState = z.infer<typeof MailboxState>;

export const MemoryCap = z.object({ asked: z.string(), bytes: z.number().int().min(0).max(9007199254740991).nullable() });
export type MemoryCap = z.infer<typeof MemoryCap>;

export const NeedsRestart = z.object({ holderPid: z.number().int().min(1).max(9007199254740991).nullable(), served: z.boolean().default(false) });
export type NeedsRestart = z.infer<typeof NeedsRestart>;

export const NewTaskTitle = z.string().trim().min(1).max(200).refine(checks.newTaskTitle, checks.newTaskTitle.message);
export type NewTaskTitle = z.infer<typeof NewTaskTitle>;

export const NoticeAction = z.enum(["dismiss"]);
export type NoticeAction = z.infer<typeof NoticeAction>;

export const NoticeCloseReason = z.enum(["dismissed", "revoked"]);
export type NoticeCloseReason = z.infer<typeof NoticeCloseReason>;

export const NoticeCloser = z.enum(["owner-socket", "owner-loopback", "revoke"]);
export type NoticeCloser = z.infer<typeof NoticeCloser>;

export const NoticeDevice = z.object({ address: z.string().nullable(), id: z.string().regex(new RegExp("^dev_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), name: z.string(), origin: z.string() });
export type NoticeDevice = z.infer<typeof NoticeDevice>;

export const NoticeState = z.enum(["open", "closed"]);
export type NoticeState = z.infer<typeof NoticeState>;

export const Notifications = z.object({ desktop: z.boolean(), notifier: z.string().nullable() });
export type Notifications = z.infer<typeof Notifications>;

export const OfferToken = z.string().regex(new RegExp("^msg_[0-9a-f]{32}-[0-9a-z]{1,32}$"));
export type OfferToken = z.infer<typeof OfferToken>;

export const OriginsFrom = z.enum(["BAZHEN_EXTERNAL_ORIGINS", "config"]);
export type OriginsFrom = z.infer<typeof OriginsFrom>;

export const PairRequest = z.object({ code: z.string().max(32), name: z.string().max(64).optional() });
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({ deviceId: z.string().regex(new RegExp("^dev_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), name: z.string() });
export type PairResponse = z.infer<typeof PairResponse>;

export const PairingMode = z.enum(["auto", "always"]);
export type PairingMode = z.infer<typeof PairingMode>;

export const PeerReader = z.object({ path: z.string() });
export type PeerReader = z.infer<typeof PeerReader>;

export const ProtocolVersion = z.string().regex(new RegExp("^[0-9]+\\.[0-9]+$"));
export type ProtocolVersion = z.infer<typeof ProtocolVersion>;

export const ReadySign = z.enum(["claude_hook", "codex_title"]);
export type ReadySign = z.infer<typeof ReadySign>;

export const Refusing = z.enum(["budget", "host"]);
export type Refusing = z.infer<typeof Refusing>;

export const RelaunchRejectedReason = z.enum(["not_resumable", "terminal_exists", "harness_refused", "unavailable", "daemon_restart"]);
export type RelaunchRejectedReason = z.infer<typeof RelaunchRejectedReason>;

export const RequeueReason = z.enum(["not_written", "daemon_restart", "session_started", "stop_failed", "interrupted", "not_seen"]);
export type RequeueReason = z.infer<typeof RequeueReason>;

export const ResetReason = z.enum(["stale", "foreign"]);
export type ResetReason = z.infer<typeof ResetReason>;

export const RespawnRejectedReason = z.enum(["not_resumable", "no_terminal", "terminal_changed", "harness_refused", "unavailable", "daemon_restart"]);
export type RespawnRejectedReason = z.infer<typeof RespawnRejectedReason>;

export const Resumes = z.object({ attachmentId: z.string().regex(new RegExp("^att_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), token: z.string().max(64) });
export type Resumes = z.infer<typeof Resumes>;

export const RevokeDeviceResponse = z.object({});
export type RevokeDeviceResponse = z.infer<typeof RevokeDeviceResponse>;

export const Role = z.string().regex(new RegExp("^[a-z][a-z0-9-]{0,31}$"));
export type Role = z.infer<typeof Role>;

export const RoleProblem = z.object({ file: z.string(), problem: z.string() });
export type RoleProblem = z.infer<typeof RoleProblem>;

export const RoleSource = z.enum(["builtin", "user"]);
export type RoleSource = z.infer<typeof RoleSource>;

export const RuntimeHealthState = z.enum(["healthy", "unreachable", "not-running"]);
export type RuntimeHealthState = z.infer<typeof RuntimeHealthState>;

export const RuntimeRefPayload = z.object({ locator: z.record(z.string(), z.string()), runtime: z.string() });
export type RuntimeRefPayload = z.infer<typeof RuntimeRefPayload>;

export const RuntimeReportState = z.enum(["healthy", "unreachable", "not-running", "unused"]);
export type RuntimeReportState = z.infer<typeof RuntimeReportState>;

export const SentTo = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), messageId: z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) });
export type SentTo = z.infer<typeof SentTo>;

export const ShellCommand = z.enum(["close", "restart", "rename", "unlink"]);
export type ShellCommand = z.infer<typeof ShellCommand>;

export const ShellCommandLine = z.string().min(1).refine(checks.commandLineInHistory, checks.commandLineInHistory.message).refine(checks.commandLineShowable, checks.commandLineShowable.message).refine(checks.commandLineVisible, checks.commandLineVisible.message).refine(checks.commandLineBytes, checks.commandLineBytes.message);
export type ShellCommandLine = z.infer<typeof ShellCommandLine>;

export const ShellCondition = z.enum(["creating", "running", "exited", "unknown", "lost", "closing", "closed", "failed", "ended"]);
export type ShellCondition = z.infer<typeof ShellCondition>;

export const ShellDecline = z.object({ token: z.string().min(1).max(128) });
export type ShellDecline = z.infer<typeof ShellDecline>;

export const ShellName = z.string().trim().min(1).max(80).refine(checks.shellName, checks.shellName.message);
export type ShellName = z.infer<typeof ShellName>;

export const ShellPrompt = z.object({ brackets: z.boolean().optional(), token: z.string().min(1).max(128) });
export type ShellPrompt = z.infer<typeof ShellPrompt>;

export const ShellReport = z.object({ at: z.number().int().min(0).max(9007199254740991), command: z.string().max(2048).nullable(), token: z.string().min(1).max(128) });
export type ShellReport = z.infer<typeof ShellReport>;

export const Signal = z.enum(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]);
export type Signal = z.infer<typeof Signal>;

export const Skipped = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), reason: z.string() });
export type Skipped = z.infer<typeof Skipped>;

export const StopResponse = z.object({});
export type StopResponse = z.infer<typeof StopResponse>;

export const Subnet = z.object({ cidr: z.string(), interface: z.string() });
export type Subnet = z.infer<typeof Subnet>;

export const TaskBrief = z.string().min(1).max(20000);
export type TaskBrief = z.infer<typeof TaskBrief>;

export const TaskCondition = z.enum(["done"]);
export type TaskCondition = z.infer<typeof TaskCondition>;

export const TaskNoteText = z.string().trim().min(1).refine(checks.taskNoteBytes, checks.taskNoteBytes.message).refine(checks.noteText, checks.noteText.message);
export type TaskNoteText = z.infer<typeof TaskNoteText>;

export const TaskOutcome = z.enum(["done", "cancelled"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

export const TaskState = z.enum(["open", "done", "cancelled"]);
export type TaskState = z.infer<typeof TaskState>;

export const TaskTitle = z.string().trim().min(1).max(200);
export type TaskTitle = z.infer<typeof TaskTitle>;

export const TerminalClosedReason = z.enum(["user", "exited", "agent_closed", "restarted"]);
export type TerminalClosedReason = z.infer<typeof TerminalClosedReason>;

export const TerminalFailedReason = z.enum(["open_rejected", "daemon_restart"]);
export type TerminalFailedReason = z.infer<typeof TerminalFailedReason>;

export const TerminalScreen = z.object({ history: z.number().int().min(0).max(9007199254740991), text: z.string().refine(checks.wellFormed, checks.wellFormed.message).refine(checks.screenText, checks.screenText.message) });
export type TerminalScreen = z.infer<typeof TerminalScreen>;

export const TerminalState = z.enum(["creating", "running", "exited", "unknown", "lost", "closing", "closed", "failed"]);
export type TerminalState = z.infer<typeof TerminalState>;

export const Timestamp = z.string().regex(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"));
export type Timestamp = z.infer<typeof Timestamp>;

export const ToolCalls = z.enum(["marked", "unmarked", "unread"]);
export type ToolCalls = z.infer<typeof ToolCalls>;

export const TuiTheme = z.enum(["light", "dark"]);
export type TuiTheme = z.infer<typeof TuiTheme>;

export const UndeliverableReason = z.enum(["agent_closed", "gave_up"]);
export type UndeliverableReason = z.infer<typeof UndeliverableReason>;

export const WaitMessagesRequest = z.object({ messageIds: z.array(z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$"))).min(1).max(100), timeoutMs: z.number().int().min(0).max(600000) });
export type WaitMessagesRequest = z.infer<typeof WaitMessagesRequest>;

export const WaitVerdict = z.enum(["met", "never", "bounced", "pending"]);
export type WaitVerdict = z.infer<typeof WaitVerdict>;

export const Activity = z.object({ confidence: z.number().min(0).max(1), detail: z.string().max(200).optional(), observedAt: Timestamp, resetsAt: Timestamp.optional(), source: ActivitySource, value: ActivityValue });
export type Activity = z.infer<typeof Activity>;

export const AddTaskNoteRequest = z.object({ handoff: z.boolean().optional(), idempotencyKey: IdempotencyKey, text: TaskNoteText });
export type AddTaskNoteRequest = z.infer<typeof AddTaskNoteRequest>;

export const AgentCommandResponse = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), eventIds: z.array(EventId) });
export type AgentCommandResponse = z.infer<typeof AgentCommandResponse>;

export const AgentRef = z.union([z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), AgentName]);
export type AgentRef = z.infer<typeof AgentRef>;

export const AgentsSettings = z.object({ loginShell: z.string().nullable(), shell: AgentShell });
export type AgentsSettings = z.infer<typeof AgentsSettings>;

export const AssignTaskResponse = z.object({ assignmentId: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), eventIds: z.array(EventId) });
export type AssignTaskResponse = z.infer<typeof AssignTaskResponse>;

export const Assignment = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), endReason: AssignmentEndReason.nullable(), id: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), parentAssignmentId: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), role: Role, state: AssignmentState, taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) });
export type Assignment = z.infer<typeof Assignment>;

export const Attention = z.object({ actions: z.array(AttentionAction), agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), closeReason: AttentionCloseReason.nullable(), id: z.string().regex(new RegExp("^attn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), kind: AttentionKind, messageId: z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), openedAt: Timestamp, state: AttentionState, summary: z.string(), taskId: z.string().nullable() });
export type Attention = z.infer<typeof Attention>;

export const BroadcastMessageResponse = z.object({ eventIds: z.array(EventId), sent: z.array(SentTo), skipped: z.array(Skipped) });
export type BroadcastMessageResponse = z.infer<typeof BroadcastMessageResponse>;

export const CapturedEnv = z.object({ capturedAt: z.string(), kept: z.number().int().min(0).max(9007199254740991), removed: z.record(z.string(), z.number().int().min(0).max(9007199254740991)), source: EnvSource });
export type CapturedEnv = z.infer<typeof CapturedEnv>;

export const Certificate = z.object({ expiresAt: Timestamp, fingerprint: z.string(), path: z.string() });
export type Certificate = z.infer<typeof Certificate>;

export const CloseAgentRequest = z.object({ confirmBusy: z.boolean().optional(), confirmedBusy: z.array(BusyShell).optional(), force: z.boolean().optional(), generation: z.number().int().min(0).max(9007199254740991), idempotencyKey: IdempotencyKey, keepShells: z.array(z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$"))).optional() });
export type CloseAgentRequest = z.infer<typeof CloseAgentRequest>;

export const CloseShellRequest = z.object({ confirmBusy: z.boolean().optional(), confirmedProgram: z.string().max(200).optional(), force: z.boolean().optional(), generation: z.number().int().min(0).max(9007199254740991), idempotencyKey: IdempotencyKey });
export type CloseShellRequest = z.infer<typeof CloseShellRequest>;

export const Codex = z.object({ cli: z.string().nullable(), daemon: z.string().nullable(), toolCalls: ToolCalls.nullable().optional() });
export type Codex = z.infer<typeof Codex>;

export const Containment = z.discriminatedUnion("state", [z.object({ oomPolicy: z.boolean(), state: z.literal("scoped"), swap: MemoryCap, systemd: z.number().int().min(1).max(9007199254740991), terminal: MemoryCap, total: MemoryCap }), z.object({ state: z.literal("uncontained"), why: z.string() }), z.object({ state: z.literal("unchecked") })]);
export type Containment = z.infer<typeof Containment>;

export const CreateTaskResponse = z.object({ assignmentId: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), eventIds: z.array(EventId), taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) });
export type CreateTaskResponse = z.infer<typeof CreateTaskResponse>;

export const Device = z.object({ expiresAt: Timestamp, id: z.string().regex(new RegExp("^dev_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), lastSeenAt: Timestamp, name: z.string(), pairedAt: Timestamp });
export type Device = z.infer<typeof Device>;

export const DismissNoticeRequest = z.object({ idempotencyKey: IdempotencyKey });
export type DismissNoticeRequest = z.infer<typeof DismissNoticeRequest>;

export const DismissNoticeResponse = z.object({ eventIds: z.array(EventId) });
export type DismissNoticeResponse = z.infer<typeof DismissNoticeResponse>;

export const Environment = z.object({ host: z.string().default(""), id: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), kind: EnvironmentKind });
export type Environment = z.infer<typeof Environment>;

export const ErrorResponse = z.object({ busy: z.array(BusyShell).optional(), error: ErrorCode, message: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const EscalateRequest = z.object({ idempotencyKey: IdempotencyKey, summary: z.string().trim().min(1).max(2000), taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional() });
export type EscalateRequest = z.infer<typeof EscalateRequest>;

export const EventEnvelope = z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.string(), id: EventId, payload: z.unknown(), ts: z.string(), type: z.string() });
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const ExternalRef = z.object({ environmentId: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), id: z.string().min(1), kind: ExternalRefKind });
export type ExternalRef = z.infer<typeof ExternalRef>;

export const FinishTaskRequest = z.object({ cascade: z.boolean().optional(), idempotencyKey: IdempotencyKey, note: FinishNoteText.optional(), outcome: TaskOutcome });
export type FinishTaskRequest = z.infer<typeof FinishTaskRequest>;

export const FleetAttention = z.object({ id: z.string().regex(new RegExp("^attn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), kind: AttentionKind });
export type FleetAttention = z.infer<typeof FleetAttention>;

export const FleetSignal = z.object({ ageSeconds: z.number().int().min(0).max(9007199254740991), resetsAt: Timestamp.optional(), source: ActivitySource, value: ActivityValue });
export type FleetSignal = z.infer<typeof FleetSignal>;

export const FleetTask = z.object({ assignmentId: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), role: Role, taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) });
export type FleetTask = z.infer<typeof FleetTask>;

export const Foreground = z.object({ command: z.string(), since: Timestamp });
export type Foreground = z.infer<typeof Foreground>;

export const Headline = z.object({ at: Timestamp, taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), text: z.string() });
export type Headline = z.infer<typeof Headline>;

export const HolderError = z.object({ code: z.string().refine(checks.wellFormed, checks.wellFormed.message), message: z.string().refine(checks.wellFormed, checks.wellFormed.message), protocol: HolderVersions.optional(), request: z.string().refine(checks.wellFormed, checks.wellFormed.message) });
export type HolderError = z.infer<typeof HolderError>;

export const HolderExitStatus = z.discriminatedUnion("type", [z.object({ code: HolderExitCode, type: z.literal("exited") }), z.object({ signal: z.string().refine(checks.wellFormed, checks.wellFormed.message), type: z.literal("signalled") }), z.object({ type: z.literal("unknown") })]);
export type HolderExitStatus = z.infer<typeof HolderExitStatus>;

export const HolderHelloFrozen = z.object({ protocol: HolderVersions });
export type HolderHelloFrozen = z.infer<typeof HolderHelloFrozen>;

export const HolderHelloReplyFrozen = z.object({ protocol: HolderVersions, version: HolderProtocolVersion });
export type HolderHelloReplyFrozen = z.infer<typeof HolderHelloReplyFrozen>;

export const HolderHelloRequest = z.object({ protocol: HolderVersions, writer: z.boolean().optional() });
export type HolderHelloRequest = z.infer<typeof HolderHelloRequest>;

export const HolderProcessSpec = z.object({ argv: HolderArgv, cwd: z.string().min(1).refine(checks.wellFormed, checks.wellFormed.message), env: HolderEnv, generation: z.number().int().min(0).max(9007199254740991), theme: HolderTheme.optional() });
export type HolderProcessSpec = z.infer<typeof HolderProcessSpec>;

export const HolderSetTagsRequest = z.object({ tags: HolderTags });
export type HolderSetTagsRequest = z.infer<typeof HolderSetTagsRequest>;

export const HolderSetThemeRequest = z.object({ theme: HolderTheme.nullable() });
export type HolderSetThemeRequest = z.infer<typeof HolderSetThemeRequest>;

export const HolderSignalRequest = z.object({ signal: HolderSignal });
export type HolderSignalRequest = z.infer<typeof HolderSignalRequest>;

export const HolderSpawnSpec = z.object({ argv: HolderArgv, cwd: z.string().min(1).refine(checks.wellFormed, checks.wellFormed.message), env: HolderEnv, generation: z.number().int().min(0).max(9007199254740991), historyLines: z.number().int().min(0).max(100000).default(10000), protocol: HolderVersions, size: HolderSize, socket: z.string().min(1).refine(checks.wellFormed, checks.wellFormed.message), tags: HolderTags, terminalId: HolderTerminalId, theme: HolderTheme.optional() });
export type HolderSpawnSpec = z.infer<typeof HolderSpawnSpec>;

export const HolderSubscribeRequest = z.object({ from: HolderSubscribeFrom.optional() });
export type HolderSubscribeRequest = z.infer<typeof HolderSubscribeRequest>;

export const HookAck = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), offered: z.array(OfferToken) });
export type HookAck = z.infer<typeof HookAck>;

export const HookReply = z.object({ exitCode: z.number().int().min(0).max(255), offered: z.array(OfferToken), stderr: z.string(), stdout: z.string() });
export type HookReply = z.infer<typeof HookReply>;

export const HookRequest = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), event: HookEvent, payload: z.unknown(), pid: z.number().int().min(-9007199254740991).max(9007199254740991), ppid: z.number().int().min(-9007199254740991).max(9007199254740991), protocolVersion: ProtocolVersion });
export type HookRequest = z.infer<typeof HookRequest>;

export const Launch = z.object({ cwd: z.string().min(1).optional(), harness: HarnessId, name: AgentName.optional() });
export type Launch = z.infer<typeof Launch>;

export const LaunchAgentRequest = z.object({ compactWindowTokens: CompactWindowTokens.optional(), cwd: z.string().min(1), harness: HarnessId, idempotencyKey: IdempotencyKey, name: AgentName.optional(), project: z.string().min(1).optional(), role: Role.optional(), theme: TuiTheme.optional() });
export type LaunchAgentRequest = z.infer<typeof LaunchAgentRequest>;

export const LaunchAgentResponse = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), eventIds: z.array(EventId), terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable() });
export type LaunchAgentResponse = z.infer<typeof LaunchAgentResponse>;

export const Message = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), id: z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), state: MailboxState });
export type Message = z.infer<typeof Message>;

export const Notice = z.object({ actions: z.array(z.string()), closeReason: z.string().nullable(), closedBy: z.string().nullable(), closedFrom: ClosedFrom.nullable(), device: NoticeDevice.nullable(), id: z.string().regex(new RegExp("^ntc_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), kind: z.string(), openedAt: Timestamp, state: NoticeState, summary: z.string() });
export type Notice = z.infer<typeof Notice>;

export const ObservedMessage = z.object({ accepted: z.boolean(), at: Timestamp, from: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), id: z.string().regex(new RegExp("^obs_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), summary: z.string(), to: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) });
export type ObservedMessage = z.infer<typeof ObservedMessage>;

export const OpenShellRequest = z.object({ cwd: z.string().min(1).optional(), idempotencyKey: IdempotencyKey, linkedAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), theme: TuiTheme.optional() }).refine(checks.linkedShellTakesNoCwd, checks.linkedShellTakesNoCwd.message);
export type OpenShellRequest = z.infer<typeof OpenShellRequest>;

export const Pairing = z.object({ mode: PairingMode, required: z.boolean() });
export type Pairing = z.infer<typeof Pairing>;

export const PairingLan = z.object({ expiresAt: Timestamp, fingerprint: z.string(), url: z.string() });
export type PairingLan = z.infer<typeof PairingLan>;

export const RelaunchAgentRequest = z.object({ fresh: z.boolean().optional(), generation: z.number().int().min(0).max(9007199254740991), idempotencyKey: IdempotencyKey, theme: TuiTheme.optional() });
export type RelaunchAgentRequest = z.infer<typeof RelaunchAgentRequest>;

export const RenameAgentRequest = z.object({ idempotencyKey: IdempotencyKey, name: AgentName });
export type RenameAgentRequest = z.infer<typeof RenameAgentRequest>;

export const RenameShellRequest = z.object({ idempotencyKey: IdempotencyKey, name: ShellName.nullable() });
export type RenameShellRequest = z.infer<typeof RenameShellRequest>;

export const RespawnAgentRequest = z.object({ generation: z.number().int().min(0).max(9007199254740991), idempotencyKey: IdempotencyKey, theme: TuiTheme.optional() });
export type RespawnAgentRequest = z.infer<typeof RespawnAgentRequest>;

export const RestartShellRequest = z.object({ generation: z.number().int().min(0).max(9007199254740991), idempotencyKey: IdempotencyKey, retype: z.literal(true).optional(), theme: TuiTheme.optional() });
export type RestartShellRequest = z.infer<typeof RestartShellRequest>;

export const RoleDefinition = z.object({ description: z.string(), grants: z.array(Role), key: Role, maxActiveTasks: z.number().int().min(1).max(9007199254740991).nullable(), prompt: z.string(), singlePerTask: z.boolean(), source: RoleSource, title: z.string() });
export type RoleDefinition = z.infer<typeof RoleDefinition>;

export const RunningHolder = z.object({ build: z.string().nullable(), contained: z.boolean().nullable().optional(), holderPid: z.number().int().min(1).max(9007199254740991).nullable().optional(), protocol: z.array(z.string()), socket: z.string().optional(), stats: DaemonHolderStats.nullable().optional(), terminalId: z.string() });
export type RunningHolder = z.infer<typeof RunningHolder>;

export const RuntimeHealthReport = z.object({ kind: z.string(), state: RuntimeReportState, version: z.string().nullable(), workarounds: z.array(z.string()).optional() });
export type RuntimeHealthReport = z.infer<typeof RuntimeHealthReport>;

export const SendMessageRequest = z.object({ body: z.string().min(1).max(20000), idempotencyKey: IdempotencyKey });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({ eventIds: z.array(EventId), messageId: z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) });
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const ShellCommandResponse = z.object({ eventIds: z.array(EventId), terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) });
export type ShellCommandResponse = z.infer<typeof ShellCommandResponse>;

export const SignalAgentRequest = z.object({ generation: z.number().int().min(0).max(9007199254740991), idempotencyKey: IdempotencyKey, signal: Signal });
export type SignalAgentRequest = z.infer<typeof SignalAgentRequest>;

export const StreamClientFrame = z.discriminatedUnion("type", [z.object({ cols: z.number().int().min(2).max(1000), mode: AttachmentMode, protocolId: z.string().optional(), resumes: Resumes.optional(), rows: z.number().int().min(2).max(1000), type: z.literal("hello") }), z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000), type: z.literal("resize") }), z.object({ type: z.literal("engage") }), z.object({ epoch: z.number().int().min(0).max(9007199254740991), type: z.literal("epoch") }), z.object({ type: z.literal("ping") })]);
export type StreamClientFrame = z.infer<typeof StreamClientFrame>;

export const StreamServerFrame = z.discriminatedUnion("type", [z.object({ attachmentId: z.string().regex(new RegExp("^att_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), resumeToken: z.string().optional(), type: z.literal("attached") }), z.object({ driven: z.boolean().optional(), driver: z.boolean(), driverDevice: z.string().optional(), epoch: z.number().int().min(0).max(9007199254740991), type: z.literal("lease") }), z.object({ type: z.literal("pong") }), z.object({ historyLines: z.number().int().min(0).max(9007199254740991).optional(), type: z.literal("snapshot_start") }), z.object({ type: z.literal("snapshot_end") }), z.object({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000), type: z.literal("geometry") }), z.object({ type: z.literal("input_dropped") }), z.object({ alternate: z.boolean(), type: z.literal("screen") }), z.object({ exit: ExitStatus, generation: z.number().int().min(0).max(9007199254740991), type: z.literal("exited") }), z.object({ type: z.literal("closed") }), z.object({ reason: EndedReason, type: z.literal("ended") }), z.object({ message: z.string(), type: z.literal("error") }), z.object({ message: z.string(), type: z.literal("notice") })]);
export type StreamServerFrame = z.infer<typeof StreamServerFrame>;

export const Task = z.object({ id: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), ownerAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), parentTaskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), state: TaskState, title: z.string() });
export type Task = z.infer<typeof Task>;

export const TaskCommandResponse = z.object({ eventIds: z.array(EventId) });
export type TaskCommandResponse = z.infer<typeof TaskCommandResponse>;

export const TaskNote = z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), at: Timestamp, eventId: EventId, handoff: z.boolean(), role: Role.nullable(), taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), text: z.string() });
export type TaskNote = z.infer<typeof TaskNote>;

export const Terminals = z.object({ host: HostPtys.nullable(), max: z.number().int().min(1).max(9007199254740991), open: z.number().int().min(0).max(9007199254740991), refusing: Refusing.nullable() });
export type Terminals = z.infer<typeof Terminals>;

export const UnassignTaskRequest = z.object({ assignmentId: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), idempotencyKey: IdempotencyKey });
export type UnassignTaskRequest = z.infer<typeof UnassignTaskRequest>;

export const UnlinkShellRequest = z.object({ generation: z.number().int().min(0).max(9007199254740991), idempotencyKey: IdempotencyKey });
export type UnlinkShellRequest = z.infer<typeof UnlinkShellRequest>;

export const UsageLimit = z.object({ resetsAt: Timestamp.optional(), usedPercent: z.number().min(0), window: z.string().min(1).max(60) });
export type UsageLimit = z.infer<typeof UsageLimit>;

export const WaitCondition = z.discriminatedUnion("on", [z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), on: z.literal("agent"), until: AgentCondition }), z.object({ on: z.literal("shell"), shellId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), until: ShellCondition }), z.object({ on: z.literal("task"), taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), until: TaskCondition }), z.object({ messageId: z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), on: z.literal("reply") })]);
export type WaitCondition = z.infer<typeof WaitCondition>;

export const AssignTaskRequest = z.object({ agentId: AgentRef, idempotencyKey: IdempotencyKey, role: Role });
export type AssignTaskRequest = z.infer<typeof AssignTaskRequest>;

export const DelegateTaskRequest = z.object({ agentId: AgentRef.optional(), brief: TaskBrief, fromTaskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), idempotencyKey: IdempotencyKey, launch: Launch.optional(), role: Role.default("worker"), title: NewTaskTitle }).refine(checks.agentOrLaunch, checks.agentOrLaunch.message);
export type DelegateTaskRequest = z.infer<typeof DelegateTaskRequest>;

export const DevicesResponse = z.object({ devices: z.array(Device) });
export type DevicesResponse = z.infer<typeof DevicesResponse>;

export const EventEnvelopeFrame = z.discriminatedUnion("type", [z.object({ event: EventEnvelope, type: z.literal("event") }), z.object({ reason: ResetReason, type: z.literal("reset") })]);
export type EventEnvelopeFrame = z.infer<typeof EventEnvelopeFrame>;

export const FleetAgent = z.object({ attention: z.array(FleetAttention), cwd: z.string(), harness: HarnessId, headline: FleetHeadline.nullable(), id: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), launchedBy: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), listening: z.boolean(), name: z.string(), project: z.string(), signal: FleetSignal.nullable(), state: AgentState, tasks: z.array(FleetTask) });
export type FleetAgent = z.infer<typeof FleetAgent>;

export const Grant = z.object({ agentId: AgentRef, role: Role });
export type Grant = z.infer<typeof Grant>;

export const HealthResponse = z.object({ appVersion: z.string(), protocolId: z.string(), runtimes: z.array(RuntimeHealthReport), status: HealthStatus });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const Holder = z.object({ binary: z.string().nullable(), build: z.string().nullable(), holders: z.array(RunningHolder), reason: z.string().nullable() });
export type Holder = z.infer<typeof Holder>;

export const HolderExited = z.object({ generation: z.number().int().min(0).max(9007199254740991), status: HolderExitStatus });
export type HolderExited = z.infer<typeof HolderExited>;

export const HolderHelloReply = z.object({ alternate: z.boolean(), childPid: z.number().int().min(1).max(9007199254740991), childStart: z.number().int().min(0).max(9007199254740991), engine: z.boolean().optional(), exit: HolderExitStatus.nullable(), generation: z.number().int().min(0).max(9007199254740991), historyLines: z.number().int().min(0).max(9007199254740991), holderPid: z.number().int().min(1).max(9007199254740991), holderStart: z.number().int().min(0).max(9007199254740991), offset: z.number().int().min(0).max(9007199254740991), protocol: HolderVersions, size: HolderSize, tags: HolderTags, terminalId: HolderTerminalId, title: z.string().refine(checks.wellFormed, checks.wellFormed.message), version: HolderProtocolVersion, writer: z.boolean() });
export type HolderHelloReply = z.infer<typeof HolderHelloReply>;

export const Lan = z.object({ allow: z.array(z.string()), certificate: Certificate.nullable(), error: z.string().nullable(), subnets: z.array(Subnet), url: z.string() });
export type Lan = z.infer<typeof Lan>;

export const PairingCodeResponse = z.object({ code: z.string().min(8).max(8), expiresAt: Timestamp, lan: PairingLan.optional(), origins: z.array(z.string()) });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

export const RolesResponse = z.object({ problems: z.array(RoleProblem), roles: z.array(RoleDefinition) });
export type RolesResponse = z.infer<typeof RolesResponse>;

export const Shell = z.object({ attachCommand: z.string().nullable(), commands: z.array(ShellCommand), cwd: z.string(), environmentId: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), foreground: Foreground.nullable().default(null), generation: z.number().int().min(0).max(9007199254740991), id: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), linkedAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), name: z.string().nullable().default(null), needsRestart: NeedsRestart.nullable().default(null), retypeable: z.boolean().default(false), state: TerminalState, theme: TuiTheme });
export type Shell = z.infer<typeof Shell>;

export const TaskDetail = z.object({ assignments: z.array(Assignment), brief: z.string(), id: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), note: z.string().nullable(), notes: z.array(TaskNote).default([]), ownerAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), parentTaskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), state: TaskState, subtasks: z.array(Task), title: z.string() });
export type TaskDetail = z.infer<typeof TaskDetail>;

export const Usage = z.object({ contextUsedPercent: z.number().min(0).max(100).optional(), contextWindowTokens: z.number().int().min(1).max(9007199254740991).optional(), limits: z.array(UsageLimit).max(20).optional(), model: z.string().max(200).optional() });
export type Usage = z.infer<typeof Usage>;

export const WaitMessagesResponse = z.object({ messages: z.array(Message) });
export type WaitMessagesResponse = z.infer<typeof WaitMessagesResponse>;

export const WaitRequest = z.object({ condition: WaitCondition, resumed: z.boolean().optional(), timeoutMs: z.number().int().min(0).max(600000) });
export type WaitRequest = z.infer<typeof WaitRequest>;

export const Agent = z.object({ activity: Activity.optional(), attachCommand: z.string().nullable().default(null), canOpenShell: z.boolean().default(false), commands: z.array(AgentCommand).default([]), cwd: z.string(), environmentId: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), exit: ExitStatus.nullable(), externalRef: ExternalRef.nullable(), generation: z.number().int().min(0).max(9007199254740991).nullable(), harness: HarnessId, headline: Headline.nullable().default(null), id: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), launchedBy: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable().default(null), listening: z.boolean().default(false), name: z.string().default(""), needsRestart: NeedsRestart.nullable().default(null), project: z.string(), promptChanged: z.boolean().default(false), resumable: z.boolean().default(false), role: Role.nullable().default(null), state: AgentState, terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), theme: TuiTheme.default("dark"), themes: z.array(TuiTheme).default(["dark"]), usage: Usage.optional() });
export type Agent = z.infer<typeof Agent>;

export const CreateTaskRequest = z.object({ assign: Grant.optional(), brief: TaskBrief, idempotencyKey: IdempotencyKey, parentTaskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), title: NewTaskTitle });
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const Event = z.discriminatedUnion("type", [z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("environment"), id: EventId, payload: z.object({ kind: EnvironmentKind }), ts: z.string(), type: z.literal("environment.registered") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("environment"), id: EventId, payload: z.object({ harness: HarnessId, previous: z.string().nullable(), version: z.string().min(1) }), ts: z.string(), type: z.literal("environment.harness_version") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ compactWindowTokens: z.number().int().min(100000).max(10000000).optional(), cwd: z.string(), environmentId: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), harness: HarnessId, launchedBy: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), name: z.string().optional(), nameOrdinal: z.number().int().min(1).max(9007199254740991).optional(), project: z.string(), promptHash: z.string().optional(), role: Role.optional(), runtime: z.string().min(1).optional(), terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable() }), ts: z.string(), type: z.literal("agent.launched") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ name: z.string(), previous: z.string() }), ts: z.string(), type: z.literal("agent.renamed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ externalRef: ExternalRef.nullable(), harnessName: z.string().optional(), runtimeRef: RuntimeRefPayload.nullable(), theme: TuiTheme.optional() }), ts: z.string(), type: z.literal("agent.running") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ sign: ReadySign }), ts: z.string(), type: z.literal("agent.ready") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ detail: z.string().optional(), reason: AgentFailedReason }), ts: z.string(), type: z.literal("agent.failed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("agent.lost") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ runtimeRef: RuntimeRefPayload }), ts: z.string(), type: z.literal("agent.process_adopted") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("agent.respawn_requested") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ externalRef: ExternalRef.nullable(), harnessName: z.string().optional(), promptHash: z.string().optional(), runtimeRef: RuntimeRefPayload, theme: TuiTheme.optional() }), ts: z.string(), type: z.literal("agent.respawned") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ detail: z.string().optional(), reason: RespawnRejectedReason }), ts: z.string(), type: z.literal("agent.respawn_rejected") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ fresh: z.boolean(), generation: z.number().int().min(1).max(9007199254740991), runtime: z.string().min(1).optional(), terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) }), ts: z.string(), type: z.literal("agent.relaunch_requested") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ externalRef: ExternalRef.nullable(), harnessName: z.string().optional(), promptHash: z.string().optional(), runtimeRef: RuntimeRefPayload, theme: TuiTheme.optional() }), ts: z.string(), type: z.literal("agent.relaunched") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ detail: z.string().optional(), reason: RelaunchRejectedReason }), ts: z.string(), type: z.literal("agent.relaunch_rejected") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ externalRef: ExternalRef }), ts: z.string(), type: z.literal("agent.external_ref_updated") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ sessionId: z.string().min(1) }), ts: z.string(), type: z.literal("agent.transcript_recorded") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ signal: Signal }), ts: z.string(), type: z.literal("agent.signalled") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ confidence: z.number().min(0).max(1), detail: z.string().max(200).optional(), observedAt: Timestamp, resetsAt: Timestamp.optional(), source: ActivitySource, value: ActivityValue }), ts: z.string(), type: z.literal("agent.activity") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ contextUsedPercent: z.number().min(0).max(100).optional(), contextWindowTokens: z.number().int().min(1).max(9007199254740991).optional(), limits: z.array(UsageLimit).max(20).optional(), model: z.string().max(200).optional() }), ts: z.string(), type: z.literal("agent.usage") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ before: Usage.optional(), hook: CompactedHook.optional(), sign: CompactedSign }), ts: z.string(), type: z.literal("agent.compacted") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({ exit: ExitStatus }), ts: z.string(), type: z.literal("agent.exited") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("agent.closing") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("agent"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("agent.closed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({ cwd: z.string(), environmentId: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), linkedAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), restartOf: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), runtime: z.string().min(1).optional(), theme: TuiTheme.optional() }), ts: z.string(), type: z.literal("terminal.opened") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({ runtimeRef: RuntimeRefPayload }), ts: z.string(), type: z.literal("terminal.running") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({ reason: TerminalFailedReason }), ts: z.string(), type: z.literal("terminal.failed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({ runtimeRef: RuntimeRefPayload }), ts: z.string(), type: z.literal("terminal.process_adopted") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("terminal.lost") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("terminal.closing") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({ reason: TerminalClosedReason }), ts: z.string(), type: z.literal("terminal.closed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({ command: z.string().max(200).nullable() }), ts: z.string(), type: z.literal("terminal.foreground_changed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({ protocol: z.array(z.string().refine(checks.wellFormed, checks.wellFormed.message).refine(checks.utf8AtMost32Bytes, checks.utf8AtMost32Bytes.message)).min(1).max(16) }), ts: z.string(), type: z.literal("terminal.needs_restart") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("terminal.restart_cleared") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("terminal.unlinked") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({ name: z.string().nullable() }), ts: z.string(), type: z.literal("terminal.renamed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("attachment"), id: EventId, payload: z.object({ mode: AttachmentMode, terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) }), ts: z.string(), type: z.literal("attachment.started") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("attachment"), id: EventId, payload: z.object({ reason: AttachmentEndReason }), ts: z.string(), type: z.literal("attachment.ended") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("message"), id: EventId, payload: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), from: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional() }), ts: z.string(), type: z.literal("mailbox.queued") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("message"), id: EventId, payload: z.object({ promptId: z.string().optional() }), ts: z.string(), type: z.literal("mailbox.offered") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("message"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("mailbox.emitted") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("message"), id: EventId, payload: z.object({ promptId: z.string() }), ts: z.string(), type: z.literal("mailbox.seen") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("message"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("mailbox.delivered") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("message"), id: EventId, payload: z.object({ offline: z.boolean() }), ts: z.string(), type: z.literal("mailbox.accepted") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("message"), id: EventId, payload: z.object({ reason: UndeliverableReason }), ts: z.string(), type: z.literal("mailbox.undeliverable") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("observed_message"), id: EventId, payload: z.object({ accepted: z.boolean(), from: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), summary: z.string(), to: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), toolUseId: z.string() }), ts: z.string(), type: z.literal("message.observed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("message"), id: EventId, payload: z.object({ reason: RequeueReason }), ts: z.string(), type: z.literal("mailbox.requeued") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("attention"), id: EventId, payload: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), kind: AttentionKind.optional(), mainAgent: z.boolean(), messageId: z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), summary: z.string(), taskId: z.string().optional(), toolUseId: z.string().nullable() }), ts: z.string(), type: z.literal("attention.opened") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("attention"), id: EventId, payload: z.object({ decision: ApprovalDecision }), ts: z.string(), type: z.literal("attention.answered") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("attention"), id: EventId, payload: z.object({ reason: AttentionClosedReason }), ts: z.string(), type: z.literal("attention.closed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("device"), id: EventId, payload: z.object({ name: z.string() }), ts: z.string(), type: z.literal("device.paired") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("device"), id: EventId, payload: z.object({}), ts: z.string(), type: z.literal("device.revoked") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("notice"), id: EventId, payload: z.object({ device: NoticeDevice.nullable(), kind: z.string(), summary: z.string() }), ts: z.string(), type: z.literal("notice.opened") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("notice"), id: EventId, payload: z.object({ by: NoticeCloser, fromDevice: z.string().regex(new RegExp("^dev_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), reason: NoticeCloseReason }), ts: z.string(), type: z.literal("notice.closed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("terminal"), id: EventId, payload: z.object({ attachmentId: z.string().regex(new RegExp("^att_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), epoch: z.number().int().min(1).max(9007199254740991) }), ts: z.string(), type: z.literal("lease.granted") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("task"), id: EventId, payload: z.object({ delegatedFrom: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable().optional(), ownerAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), parentTaskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), title: TaskTitle }), ts: z.string(), type: z.literal("task.created") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("task"), id: EventId, payload: z.object({ outcome: TaskOutcome }), ts: z.string(), type: z.literal("task.finished") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("task"), id: EventId, payload: z.object({ delegatedFrom: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), ownerAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable() }), ts: z.string(), type: z.literal("task.owner_changed") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("task"), id: EventId, payload: z.object({ handoff: z.boolean(), role: Role.nullable() }), ts: z.string(), type: z.literal("task.noted") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("assignment"), id: EventId, payload: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), parentAssignmentId: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), role: Role, taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) }), ts: z.string(), type: z.literal("assignment.granted") }), z.object({ actor: z.string(), causationId: EventId.nullable(), correlationId: z.string().nullable(), entityId: z.string(), entityType: z.literal("assignment"), id: EventId, payload: z.object({ reason: AssignmentEndedReason }), ts: z.string(), type: z.literal("assignment.ended") })]);
export type Event = z.infer<typeof Event>;

export const FleetAgents = z.array(FleetAgent);
export type FleetAgents = z.infer<typeof FleetAgents>;

export const RecordedEvent = z.discriminatedUnion("type", [z.object({ payload: z.object({ kind: EnvironmentKind }), type: z.literal("environment.registered") }), z.object({ payload: z.object({ harness: HarnessId, previous: z.string().nullable(), version: z.string().min(1) }), type: z.literal("environment.harness_version") }), z.object({ payload: z.object({ compactWindowTokens: z.number().int().min(100000).max(10000000).optional(), cwd: z.string(), environmentId: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), harness: HarnessId, launchedBy: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), name: z.string().optional(), nameOrdinal: z.number().int().min(1).max(9007199254740991).optional(), project: z.string(), promptHash: z.string().optional(), role: Role.optional(), runtime: z.string().min(1).optional(), terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable() }), type: z.literal("agent.launched") }), z.object({ payload: z.object({ name: z.string(), previous: z.string() }), type: z.literal("agent.renamed") }), z.object({ payload: z.object({ externalRef: ExternalRef.nullable(), harnessName: z.string().optional(), runtimeRef: RuntimeRefPayload.nullable(), theme: TuiTheme.optional() }), type: z.literal("agent.running") }), z.object({ payload: z.object({ sign: ReadySign }), type: z.literal("agent.ready") }), z.object({ payload: z.object({ detail: z.string().optional(), reason: AgentFailedReason }), type: z.literal("agent.failed") }), z.object({ payload: z.object({}), type: z.literal("agent.lost") }), z.object({ payload: z.object({ runtimeRef: RuntimeRefPayload }), type: z.literal("agent.process_adopted") }), z.object({ payload: z.object({}), type: z.literal("agent.respawn_requested") }), z.object({ payload: z.object({ externalRef: ExternalRef.nullable(), harnessName: z.string().optional(), promptHash: z.string().optional(), runtimeRef: RuntimeRefPayload, theme: TuiTheme.optional() }), type: z.literal("agent.respawned") }), z.object({ payload: z.object({ detail: z.string().optional(), reason: RespawnRejectedReason }), type: z.literal("agent.respawn_rejected") }), z.object({ payload: z.object({ fresh: z.boolean(), generation: z.number().int().min(1).max(9007199254740991), runtime: z.string().min(1).optional(), terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) }), type: z.literal("agent.relaunch_requested") }), z.object({ payload: z.object({ externalRef: ExternalRef.nullable(), harnessName: z.string().optional(), promptHash: z.string().optional(), runtimeRef: RuntimeRefPayload, theme: TuiTheme.optional() }), type: z.literal("agent.relaunched") }), z.object({ payload: z.object({ detail: z.string().optional(), reason: RelaunchRejectedReason }), type: z.literal("agent.relaunch_rejected") }), z.object({ payload: z.object({ externalRef: ExternalRef }), type: z.literal("agent.external_ref_updated") }), z.object({ payload: z.object({ path: z.string().max(4096).regex(new RegExp("^\\/.*")), sessionId: z.string().min(1) }), type: z.literal("agent.transcript_recorded") }), z.object({ payload: z.object({ signal: Signal }), type: z.literal("agent.signalled") }), z.object({ payload: z.object({ confidence: z.number().min(0).max(1), detail: z.string().max(200).optional(), observedAt: Timestamp, resetsAt: Timestamp.optional(), source: ActivitySource, value: ActivityValue }), type: z.literal("agent.activity") }), z.object({ payload: z.object({ contextUsedPercent: z.number().min(0).max(100).optional(), contextWindowTokens: z.number().int().min(1).max(9007199254740991).optional(), limits: z.array(UsageLimit).max(20).optional(), model: z.string().max(200).optional() }), type: z.literal("agent.usage") }), z.object({ payload: z.object({ before: Usage.optional(), hook: CompactedHook.optional(), sign: CompactedSign }), type: z.literal("agent.compacted") }), z.object({ payload: z.object({ exit: ExitStatus }), type: z.literal("agent.exited") }), z.object({ payload: z.object({}), type: z.literal("agent.closing") }), z.object({ payload: z.object({}), type: z.literal("agent.closed") }), z.object({ payload: z.object({ cwd: z.string(), environmentId: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), linkedAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), restartOf: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), runtime: z.string().min(1).optional(), theme: TuiTheme.optional() }), type: z.literal("terminal.opened") }), z.object({ payload: z.object({ runtimeRef: RuntimeRefPayload }), type: z.literal("terminal.running") }), z.object({ payload: z.object({ reason: TerminalFailedReason }), type: z.literal("terminal.failed") }), z.object({ payload: z.object({ runtimeRef: RuntimeRefPayload }), type: z.literal("terminal.process_adopted") }), z.object({ payload: z.object({}), type: z.literal("terminal.lost") }), z.object({ payload: z.object({}), type: z.literal("terminal.closing") }), z.object({ payload: z.object({ reason: TerminalClosedReason }), type: z.literal("terminal.closed") }), z.object({ payload: z.object({ command: z.string().max(200).nullable() }), type: z.literal("terminal.foreground_changed") }), z.object({ payload: z.object({ protocol: z.array(z.string().refine(checks.wellFormed, checks.wellFormed.message).refine(checks.utf8AtMost32Bytes, checks.utf8AtMost32Bytes.message)).min(1).max(16) }), type: z.literal("terminal.needs_restart") }), z.object({ payload: z.object({}), type: z.literal("terminal.restart_cleared") }), z.object({ payload: z.object({}), type: z.literal("terminal.unlinked") }), z.object({ payload: z.object({ name: z.string().nullable() }), type: z.literal("terminal.renamed") }), z.object({ payload: z.object({ mode: AttachmentMode, terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) }), type: z.literal("attachment.started") }), z.object({ payload: z.object({ reason: AttachmentEndReason }), type: z.literal("attachment.ended") }), z.object({ payload: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), body: z.string(), from: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional() }), type: z.literal("mailbox.queued") }), z.object({ payload: z.object({ promptId: z.string().optional() }), type: z.literal("mailbox.offered") }), z.object({ payload: z.object({}), type: z.literal("mailbox.emitted") }), z.object({ payload: z.object({ promptId: z.string() }), type: z.literal("mailbox.seen") }), z.object({ payload: z.object({}), type: z.literal("mailbox.delivered") }), z.object({ payload: z.object({ offline: z.boolean() }), type: z.literal("mailbox.accepted") }), z.object({ payload: z.object({ reason: UndeliverableReason }), type: z.literal("mailbox.undeliverable") }), z.object({ payload: z.object({ accepted: z.boolean(), from: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), summary: z.string(), text: z.string(), to: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), toolUseId: z.string() }), type: z.literal("message.observed") }), z.object({ payload: z.object({ reason: RequeueReason }), type: z.literal("mailbox.requeued") }), z.object({ payload: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), kind: AttentionKind.optional(), mainAgent: z.boolean(), messageId: z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), summary: z.string(), taskId: z.string().optional(), toolUseId: z.string().nullable() }), type: z.literal("attention.opened") }), z.object({ payload: z.object({ decision: ApprovalDecision }), type: z.literal("attention.answered") }), z.object({ payload: z.object({ reason: AttentionClosedReason }), type: z.literal("attention.closed") }), z.object({ payload: z.object({ name: z.string() }), type: z.literal("device.paired") }), z.object({ payload: z.object({}), type: z.literal("device.revoked") }), z.object({ payload: z.object({ device: NoticeDevice.nullable(), kind: z.string(), summary: z.string() }), type: z.literal("notice.opened") }), z.object({ payload: z.object({ by: NoticeCloser, fromDevice: z.string().regex(new RegExp("^dev_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), reason: NoticeCloseReason }), type: z.literal("notice.closed") }), z.object({ payload: z.object({ attachmentId: z.string().regex(new RegExp("^att_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), epoch: z.number().int().min(1).max(9007199254740991) }), type: z.literal("lease.granted") }), z.object({ payload: z.object({ brief: TaskBrief, delegatedFrom: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable().optional(), ownerAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), parentTaskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), title: TaskTitle }), type: z.literal("task.created") }), z.object({ payload: z.object({ note: z.string().nullable(), outcome: TaskOutcome }), type: z.literal("task.finished") }), z.object({ payload: z.object({ delegatedFrom: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), ownerAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable() }), type: z.literal("task.owner_changed") }), z.object({ payload: z.object({ handoff: z.boolean(), role: Role.nullable(), text: z.string() }), type: z.literal("task.noted") }), z.object({ payload: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), parentAssignmentId: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), role: Role, taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) }), type: z.literal("assignment.granted") }), z.object({ payload: z.object({ reason: AssignmentEndedReason }), type: z.literal("assignment.ended") })]);
export type RecordedEvent = z.infer<typeof RecordedEvent>;

export const Web = z.object({ allowInsecureOrigins: z.boolean(), app: z.string().nullable().optional(), appRefused: z.string().optional(), externalOrigins: z.array(z.string()), from: OriginsFrom.nullable(), lan: Lan.nullable().optional(), pairing: Pairing.optional() });
export type Web = z.infer<typeof Web>;

export const DoctorResponse = z.object({ agentCli: AgentCli.optional(), agents: AgentsSettings, appVersion: z.string(), codex: Codex.optional(), config: ConfigFile, containment: Containment.optional(), env: CapturedEnv, holder: Holder.optional(), hookClient: HookClient, notifications: Notifications.optional(), peerReader: PeerReader.nullable().optional(), protocolId: z.string(), runtimes: z.array(RuntimeHealthReport), terminals: Terminals.optional(), web: Web.optional() });
export type DoctorResponse = z.infer<typeof DoctorResponse>;

export const EventFrame = z.discriminatedUnion("type", [z.object({ event: Event, type: z.literal("event") }), z.object({ reason: ResetReason, type: z.literal("reset") })]);
export type EventFrame = z.infer<typeof EventFrame>;

export const StateSnapshot = z.object({ agents: z.array(Agent), assignments: z.array(Assignment).default([]), attention: z.array(Attention), environments: z.array(Environment), epoch: z.string(), eventId: z.number().int().min(0).max(9007199254740991), messages: z.array(Message), notices: z.array(Notice).default([]), observed: z.array(ObservedMessage).default([]), shells: z.array(Shell).default([]), tasks: z.array(Task).default([]) });
export type StateSnapshot = z.infer<typeof StateSnapshot>;

export const WaitResponse = z.object({ agent: Agent.optional(), replyId: z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), said: z.string(), shell: Shell.optional(), task: Task.optional(), verdict: WaitVerdict });
export type WaitResponse = z.infer<typeof WaitResponse>;

export const EVENTS = {
  "agent.activity": { entity: "agent", payload: z.object({ confidence: z.number().min(0).max(1), detail: z.string().max(200).optional(), observedAt: Timestamp, resetsAt: Timestamp.optional(), source: ActivitySource, value: ActivityValue }) },
  "agent.closed": { entity: "agent", payload: z.object({}) },
  "agent.closing": { entity: "agent", payload: z.object({}) },
  "agent.compacted": { entity: "agent", payload: z.object({ before: Usage.optional(), hook: CompactedHook.optional(), sign: CompactedSign }) },
  "agent.exited": { entity: "agent", payload: z.object({ exit: ExitStatus }) },
  "agent.external_ref_updated": { entity: "agent", payload: z.object({ externalRef: ExternalRef }) },
  "agent.failed": { entity: "agent", payload: z.object({ detail: z.string().optional(), reason: AgentFailedReason }) },
  "agent.launched": { entity: "agent", payload: z.object({ compactWindowTokens: z.number().int().min(100000).max(10000000).optional(), cwd: z.string(), environmentId: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), harness: HarnessId, launchedBy: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), name: z.string().optional(), nameOrdinal: z.number().int().min(1).max(9007199254740991).optional(), project: z.string(), promptHash: z.string().optional(), role: Role.optional(), runtime: z.string().min(1).optional(), terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable() }) },
  "agent.lost": { entity: "agent", payload: z.object({}) },
  "agent.process_adopted": { entity: "agent", payload: z.object({ runtimeRef: RuntimeRefPayload }) },
  "agent.ready": { entity: "agent", payload: z.object({ sign: ReadySign }) },
  "agent.relaunch_rejected": { entity: "agent", payload: z.object({ detail: z.string().optional(), reason: RelaunchRejectedReason }) },
  "agent.relaunch_requested": { entity: "agent", payload: z.object({ fresh: z.boolean(), generation: z.number().int().min(1).max(9007199254740991), runtime: z.string().min(1).optional(), terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) }) },
  "agent.relaunched": { entity: "agent", payload: z.object({ externalRef: ExternalRef.nullable(), harnessName: z.string().optional(), promptHash: z.string().optional(), runtimeRef: RuntimeRefPayload, theme: TuiTheme.optional() }) },
  "agent.renamed": { entity: "agent", payload: z.object({ name: z.string(), previous: z.string() }) },
  "agent.respawn_rejected": { entity: "agent", payload: z.object({ detail: z.string().optional(), reason: RespawnRejectedReason }) },
  "agent.respawn_requested": { entity: "agent", payload: z.object({}) },
  "agent.respawned": { entity: "agent", payload: z.object({ externalRef: ExternalRef.nullable(), harnessName: z.string().optional(), promptHash: z.string().optional(), runtimeRef: RuntimeRefPayload, theme: TuiTheme.optional() }) },
  "agent.running": { entity: "agent", payload: z.object({ externalRef: ExternalRef.nullable(), harnessName: z.string().optional(), runtimeRef: RuntimeRefPayload.nullable(), theme: TuiTheme.optional() }) },
  "agent.signalled": { entity: "agent", payload: z.object({ signal: Signal }) },
  "agent.transcript_recorded": { entity: "agent", payload: z.object({ path: z.string().max(4096).regex(new RegExp("^\\/.*")), sessionId: z.string().min(1) }), streamed: z.object({ sessionId: z.string().min(1) }) },
  "agent.usage": { entity: "agent", payload: z.object({ contextUsedPercent: z.number().min(0).max(100).optional(), contextWindowTokens: z.number().int().min(1).max(9007199254740991).optional(), limits: z.array(UsageLimit).max(20).optional(), model: z.string().max(200).optional() }) },
  "assignment.ended": { entity: "assignment", payload: z.object({ reason: AssignmentEndedReason }) },
  "assignment.granted": { entity: "assignment", payload: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), parentAssignmentId: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), role: Role, taskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) }) },
  "attachment.ended": { entity: "attachment", payload: z.object({ reason: AttachmentEndReason }) },
  "attachment.started": { entity: "attachment", payload: z.object({ mode: AttachmentMode, terminalId: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")) }) },
  "attention.answered": { entity: "attention", payload: z.object({ decision: ApprovalDecision }) },
  "attention.closed": { entity: "attention", payload: z.object({ reason: AttentionClosedReason }) },
  "attention.opened": { entity: "attention", payload: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), kind: AttentionKind.optional(), mainAgent: z.boolean(), messageId: z.string().regex(new RegExp("^msg_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), summary: z.string(), taskId: z.string().optional(), toolUseId: z.string().nullable() }) },
  "device.paired": { entity: "device", payload: z.object({ name: z.string() }) },
  "device.revoked": { entity: "device", payload: z.object({}) },
  "environment.harness_version": { entity: "environment", payload: z.object({ harness: HarnessId, previous: z.string().nullable(), version: z.string().min(1) }) },
  "environment.registered": { entity: "environment", payload: z.object({ kind: EnvironmentKind }) },
  "lease.granted": { entity: "terminal", payload: z.object({ attachmentId: z.string().regex(new RegExp("^att_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), epoch: z.number().int().min(1).max(9007199254740991) }) },
  "mailbox.accepted": { entity: "message", payload: z.object({ offline: z.boolean() }) },
  "mailbox.delivered": { entity: "message", payload: z.object({}) },
  "mailbox.emitted": { entity: "message", payload: z.object({}) },
  "mailbox.offered": { entity: "message", payload: z.object({ promptId: z.string().optional() }) },
  "mailbox.queued": { entity: "message", payload: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), body: z.string(), from: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional() }), streamed: z.object({ agentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), from: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional() }) },
  "mailbox.requeued": { entity: "message", payload: z.object({ reason: RequeueReason }) },
  "mailbox.seen": { entity: "message", payload: z.object({ promptId: z.string() }) },
  "mailbox.undeliverable": { entity: "message", payload: z.object({ reason: UndeliverableReason }) },
  "message.observed": { entity: "observed_message", payload: z.object({ accepted: z.boolean(), from: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), summary: z.string(), text: z.string(), to: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), toolUseId: z.string() }), streamed: z.object({ accepted: z.boolean(), from: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), summary: z.string(), to: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), toolUseId: z.string() }) },
  "notice.closed": { entity: "notice", payload: z.object({ by: NoticeCloser, fromDevice: z.string().regex(new RegExp("^dev_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), reason: NoticeCloseReason }) },
  "notice.opened": { entity: "notice", payload: z.object({ device: NoticeDevice.nullable(), kind: z.string(), summary: z.string() }) },
  "task.created": { entity: "task", payload: z.object({ brief: TaskBrief, delegatedFrom: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable().optional(), ownerAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), parentTaskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), title: TaskTitle }), streamed: z.object({ delegatedFrom: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable().optional(), ownerAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), parentTaskId: z.string().regex(new RegExp("^task_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), title: TaskTitle }) },
  "task.finished": { entity: "task", payload: z.object({ note: z.string().nullable(), outcome: TaskOutcome }), streamed: z.object({ outcome: TaskOutcome }) },
  "task.noted": { entity: "task", payload: z.object({ handoff: z.boolean(), role: Role.nullable(), text: z.string() }), streamed: z.object({ handoff: z.boolean(), role: Role.nullable() }) },
  "task.owner_changed": { entity: "task", payload: z.object({ delegatedFrom: z.string().regex(new RegExp("^asgn_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), ownerAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable() }) },
  "terminal.closed": { entity: "terminal", payload: z.object({ reason: TerminalClosedReason }) },
  "terminal.closing": { entity: "terminal", payload: z.object({}) },
  "terminal.failed": { entity: "terminal", payload: z.object({ reason: TerminalFailedReason }) },
  "terminal.foreground_changed": { entity: "terminal", payload: z.object({ command: z.string().max(200).nullable() }) },
  "terminal.lost": { entity: "terminal", payload: z.object({}) },
  "terminal.needs_restart": { entity: "terminal", payload: z.object({ protocol: z.array(z.string().refine(checks.wellFormed, checks.wellFormed.message).refine(checks.utf8AtMost32Bytes, checks.utf8AtMost32Bytes.message)).min(1).max(16) }) },
  "terminal.opened": { entity: "terminal", payload: z.object({ cwd: z.string(), environmentId: z.string().regex(new RegExp("^env_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")), linkedAgentId: z.string().regex(new RegExp("^agent_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).nullable(), restartOf: z.string().regex(new RegExp("^term_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$")).optional(), runtime: z.string().min(1).optional(), theme: TuiTheme.optional() }) },
  "terminal.process_adopted": { entity: "terminal", payload: z.object({ runtimeRef: RuntimeRefPayload }) },
  "terminal.renamed": { entity: "terminal", payload: z.object({ name: z.string().nullable() }) },
  "terminal.restart_cleared": { entity: "terminal", payload: z.object({}) },
  "terminal.running": { entity: "terminal", payload: z.object({ runtimeRef: RuntimeRefPayload }) },
  "terminal.unlinked": { entity: "terminal", payload: z.object({}) },
} as const;
