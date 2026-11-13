import type {
  AgentLaunchRequest,
  HarnessAdapter,
  HarnessLaunch,
  LaunchOptions,
} from "@bazhen/core";
import type { Activity, ApprovalDecision, ExternalRef, Usage } from "@bazhen/protocol";

export interface ClaudeCodeOptions {
  readonly newSessionId: () => string;
  /** The hook client as a shell command; Bazhen appends the event. */
  readonly hookCommand: string;
  /** A permission mode every agent starts in; unset, each starts in the user's own. */
  readonly permissionMode?: string;
  /**
   * Which status line Bazhen's runs inside it for a session started in `cwd`, or "leave" to set
   * none, leaving Claude Code's own (foundation-design §11.2).
   */
  readonly statusLine?: (cwd: string) => StatusLineChoice;
}

/** The user's status line to wrap (none: Bazhen's draws nothing), or "leave" Claude's alone. */
export type StatusLineChoice = { readonly wrap: UserStatusLine | null } | "leave";

/** A Claude Code `statusLine` setting of the command kind. */
export interface UserStatusLine {
  readonly command: string;
  readonly padding?: number;
}

/**
 * Claude Code, reached through its hooks (foundation-design §5.6). Bazhen picks the session id
 * itself, so the agent's first binding is known before any hook fires (§3.1), and passes its
 * hooks with the launch, beside the user's own, so nothing is written to the user's settings.
 */
export class ClaudeCodeHarness implements HarnessAdapter {
  readonly id = "claude-code";
  readonly themes = ["light", "dark"] as const;
  private readonly opts: ClaudeCodeOptions;

  constructor(opts: ClaudeCodeOptions) {
    this.opts = opts;
  }

  async launchSpec(request: AgentLaunchRequest, options: LaunchOptions): Promise<HarnessLaunch> {
    const id = this.opts.newSessionId();
    return this.spec(["--session-id", id], id, request, options);
  }

  /** The same TUI, with its hooks, on the session the agent already had. */
  async resumeSpec(
    request: AgentLaunchRequest,
    session: Omit<ExternalRef, "environmentId">,
    options: LaunchOptions,
  ): Promise<HarnessLaunch> {
    return this.spec(["--resume", session.id], session.id, request, options);
  }

  /** Claude Code reads a theme in its settings ahead of the user's own, for this launch only. */
  private spec(
    session: string[],
    id: string,
    request: AgentLaunchRequest,
    { theme }: LaunchOptions,
  ): HarnessLaunch {
    const choice = this.opts.statusLine?.(request.cwd) ?? { wrap: null };
    const statusLine =
      choice === "leave"
        ? {}
        : { statusLine: wrappedStatusLine(this.opts.hookCommand, choice.wrap) };
    return {
      argv: [
        "claude",
        ...session,
        "--settings",
        JSON.stringify({ ...hooks(this.opts.hookCommand), ...statusLine, ...(theme && { theme }) }),
        ...(this.opts.permissionMode === undefined
          ? []
          : ["--permission-mode", this.opts.permissionMode]),
      ],
      env: {},
      ...(theme && { theme }),
      externalRef: { kind: "claude-session", id },
    };
  }
}

/**
 * The waiter runs asynchronously after every turn and at start, and wakes an idle session when
 * mail arrives (`asyncRewake`); Claude Code kills it at its timeout, so that is a day and the
 * waiter gives up first. A permission request waits for an inbox answer, bounded below
 * Claude Code's own wait.
 */
/** One shell word, whatever the string holds. */
const shellWord = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * Bazhen's status line: the hook client's wrapper, which runs the user's own command inside it,
 * its output passed through unchanged, and reports the line's input to the daemon.
 */
function wrappedStatusLine(hook: string, user: UserStatusLine | null) {
  const inner = user === null ? "" : ` sh -c ${shellWord(user.command)}`;
  return {
    type: "command",
    command: `${hook} statusline-wrap${inner}`,
    ...(user?.padding === undefined ? {} : { padding: user.padding }),
  };
}

function hooks(hook: string) {
  const run = (event: string, timeout: number) => ({
    type: "command",
    command: `${hook} ${event}`,
    timeout,
  });
  const waiter = { ...run("wait", 86_400), asyncRewake: true };
  // Reports that change nothing in the session run beside it, so no tool call waits on them.
  const report = (event: string) => ({ ...run(event, 10), async: true });
  return {
    hooks: {
      SessionStart: [{ hooks: [waiter] }],
      // Not async: a turn's end must reach the daemon before the next turn's prompt does.
      Stop: [{ hooks: [waiter, run("Stop", 10)] }],
      // An API error ends the turn with StopFailure instead of Stop, idle all the same.
      StopFailure: [{ hooks: [waiter, run("StopFailure", 10)] }],
      UserPromptSubmit: [{ hooks: [run("UserPromptSubmit", 10)] }],
      // Not async: a permission request that follows must find the call it is about.
      PreToolUse: [{ matcher: "*", hooks: [run("PreToolUse", 10)] }],
      PermissionRequest: [
        { matcher: "*", hooks: [run("PermissionRequest", APPROVAL_WAIT_MS / 1000 + 10)] },
      ],
      // Not async: its reply can fold mail into the running turn, so each tool call waits on it.
      PostToolUse: [{ matcher: "*", hooks: [run("PostToolUse", FOLD_TIMEOUT_S)] }],
      PostToolUseFailure: [{ matcher: "*", hooks: [report("PostToolUseFailure")] }],
      // A background subagent outlives the turn that started it: these say it is still at work.
      // Not async, so its start arrives before its first tool call.
      SubagentStart: [{ hooks: [run("SubagentStart", 10)] }],
      SubagentStop: [{ hooks: [run("SubagentStop", 10)] }],
    },
  };
}

/**
 * How long a permission request waits for the inbox; its hook's own timeout is set past it, so
 * the hook gives up first and Claude Code's prompt decides, never an automatic allow.
 */
export const APPROVAL_WAIT_MS = 50_000;

/** A Claude Code hook as the daemon acts on it, whatever Claude Code calls it. */
export type Hook =
  /**
   * The waiter; `sessionStarted` when it runs for a SessionStart, which may move the binding,
   * and `compacted` when that SessionStart only compacted the session the agent is in.
   */
  | {
      readonly kind: "wait";
      readonly sessionStarted: boolean;
      readonly compacted: boolean;
      /** The turn whose end this waiter runs for, as the Stop or StopFailure report says too. */
      readonly turnEnd: {
        readonly promptId: string | null;
        readonly failed: boolean;
        readonly error: string | null;
      } | null;
    }
  | { readonly kind: "toolStarted"; readonly tool: string; readonly useId: string }
  | { readonly kind: "permission"; readonly summary: string; readonly tool: string }
  | { readonly kind: "promptStarted"; readonly prompt: string; readonly promptId: string | null }
  | { readonly kind: "turnEnded"; readonly promptId: string | null }
  | {
      readonly kind: "turnFailed";
      readonly promptId: string | null;
      /** Claude Code's name for the API error, such as `server_error`. */
      readonly error: string | null;
    }
  | {
      readonly kind: "toolSettled";
      readonly useId: string;
      /** A PostToolUse, whose reply can fold mail into the turn; a failed call's can't. */
      readonly fold: { readonly promptId: string | null } | null;
    }
  /** The status line redrew, saying which model runs and how full its context is. */
  | { readonly kind: "statusline"; readonly usage: Usage }
  /** One of the agent's subagents started or ended, by its `agent_id`. */
  | { readonly kind: "subagentStarted" | "subagentStopped"; readonly subagentId: string }
  | { readonly kind: "ignored" };

/** Reads one of the hooks `launchSpec` installed; the daemon never sees Claude Code's formats. */
export function readHook(event: string, payload: unknown): Hook {
  switch (event) {
    case "wait":
      return {
        kind: "wait",
        sessionStarted: field(payload, "hook_event_name") === "SessionStart",
        compacted: field(payload, "source") === "compact",
        turnEnd: turnEndOf(payload),
      };
    case "PreToolUse": {
      const useId = toolUseIdOf(payload);
      return useId === null ? IGNORED : { kind: "toolStarted", tool: toolKey(payload), useId };
    }
    case "statusline":
      return { kind: "statusline", usage: usageOf(payload) };
    case "SubagentStart":
    case "SubagentStop": {
      const id = field(payload, "agent_id");
      if (typeof id !== "string" || id === "") return IGNORED;
      return {
        kind: event === "SubagentStart" ? "subagentStarted" : "subagentStopped",
        subagentId: id,
      };
    }
    case "PermissionRequest":
      // A question wants the human's choice, which allow or deny can't give: the TUI asks it.
      if (field(payload, "tool_name") === "AskUserQuestion") return IGNORED;
      return { kind: "permission", summary: approvalSummary(payload), tool: toolKey(payload) };
    case "UserPromptSubmit":
      return { kind: "promptStarted", prompt: promptOf(payload), promptId: promptIdOf(payload) };
    case "Stop":
      return { kind: "turnEnded", promptId: promptIdOf(payload) };
    case "StopFailure":
      return { kind: "turnFailed", promptId: promptIdOf(payload), error: errorOf(payload) };
    case "PostToolUse":
    case "PostToolUseFailure": {
      const useId = toolUseIdOf(payload);
      const fold = event === "PostToolUse" ? { promptId: promptIdOf(payload) } : null;
      return useId === null ? IGNORED : { kind: "toolSettled", useId, fold };
    }
    default:
      return IGNORED;
  }
}

const IGNORED: Hook = { kind: "ignored" };

/** The model and context use a status line's input gives, as far as it gives them. */
function usageOf(payload: unknown): Usage {
  const name = field(field(payload, "model"), "display_name");
  const window = field(payload, "context_window");
  const used = field(window, "used_percentage");
  const size = field(window, "context_window_size");
  return {
    ...(typeof name === "string" && name !== "" ? { model: name.slice(0, 200) } : {}),
    // Whole percent: a finer change isn't worth an event.
    ...(typeof used === "number" && used >= 0 && used <= 100
      ? { contextUsedPercent: Math.round(used) }
      : {}),
    ...(typeof size === "number" && Number.isInteger(size) && size > 0
      ? { contextWindowTokens: size }
      : {}),
  };
}

const failure = (error: string | null): Pick<Activity, "value" | "detail"> =>
  error === null ? { value: "failed" } : { value: "failed", detail: error };

/**
 * What a hook says the agent is doing (foundation-design §4.6), or null for one that says
 * nothing: a prompt or a tool call means working, a permission request needs the human, a turn's
 * end leaves it idle, and an API error that ends the turn is a failure.
 */
export function activityOf(hook: Hook): Pick<Activity, "value" | "detail"> | null {
  switch (hook.kind) {
    case "promptStarted":
    case "toolStarted":
    case "toolSettled":
      return { value: "working" };
    case "permission":
      return { value: "needs_approval" };
    case "turnEnded":
      return { value: "idle" };
    case "turnFailed":
      return failure(hook.error);
    case "wait":
      // A session that starts or starts over waits for its first prompt; a compaction is mid-turn.
      if (hook.sessionStarted) return hook.compacted ? null : { value: "idle" };
      if (hook.turnEnd === null) return null;
      return hook.turnEnd.failed ? failure(hook.turnEnd.error) : { value: "idle" };
    case "subagentStarted":
    case "subagentStopped":
    case "statusline":
    case "ignored":
      break;
  }
  return null;
}

/** The turn a Stop or StopFailure payload ends, for a hook that runs beside those reports. */
function turnEndOf(
  payload: unknown,
): { promptId: string | null; failed: boolean; error: string | null } | null {
  const event = field(payload, "hook_event_name");
  if (event !== "Stop" && event !== "StopFailure") return null;
  return {
    promptId: promptIdOf(payload),
    failed: event === "StopFailure",
    error: errorOf(payload),
  };
}

/** Claude Code's name for the API error a StopFailure reports, such as `server_error`. */
function errorOf(payload: unknown): string | null {
  const error = field(payload, "error");
  return typeof error === "string" ? error.slice(0, 200) : null;
}

/** Which Claude Code session ran a hook, and whether one of its subagents did. */
export interface HookOrigin {
  readonly sessionId: string | null;
  /** A subagent's hook, which carries `agent_id`; compaction runs as one (§3.1). */
  readonly subagent: boolean;
  /** That subagent's `agent_id`, unique among the agent's subagents. */
  readonly subagentId: string | null;
}

export function hookOrigin(payload: unknown): HookOrigin {
  const session = field(payload, "session_id");
  const subagent = field(payload, "agent_id");
  return {
    sessionId: typeof session === "string" && session !== "" ? session : null,
    subagent: typeof subagent === "string",
    subagentId: typeof subagent === "string" ? subagent : null,
  };
}

const field = (payload: unknown, name: string): unknown =>
  typeof payload === "object" && payload !== null ? Reflect.get(payload, name) : undefined;

/** The prompt a UserPromptSubmit carries; a wake's prompt contains the waiter's text verbatim. */
function promptOf(payload: unknown): string {
  const prompt = field(payload, "prompt");
  return typeof prompt === "string" ? prompt : "";
}

/** The prompt id on every hook but SessionStart, which ties a Stop to the prompt it ends. */
function promptIdOf(payload: unknown): string | null {
  const id = field(payload, "prompt_id");
  return typeof id === "string" ? id : null;
}

function toolUseIdOf(payload: unknown): string | null {
  const id = field(payload, "tool_use_id");
  return typeof id === "string" ? id : null;
}

/**
 * Which tool call a PermissionRequest is about, as far as its payload says. It carries no
 * tool_use_id, so it is matched to a PreToolUse with the same caller (the agent or one of its
 * subagents), prompt, tool and exact input, whose tool_use_id the call's result then carries
 * (foundation-design §5.6).
 */
function toolKey(payload: unknown): string {
  const caller = field(payload, "agent_id");
  return JSON.stringify([
    typeof caller === "string" ? caller : "main",
    promptIdOf(payload),
    field(payload, "tool_name") ?? null,
    field(payload, "tool_input") ?? null,
  ]);
}

/** The key of a tool call the agent itself made, as opposed to one of its subagents. */
export const isMainAgentTool = (tool: string) => tool.startsWith('["main",');

/** What a permission request is for, as the inbox shows it. */
function approvalSummary(payload: unknown): string {
  const tool = field(payload, "tool_name");
  const input = JSON.stringify(field(payload, "tool_input") ?? {});
  return `${typeof tool === "string" ? tool : "A tool"}: ${input.slice(0, 300)}`;
}

/** The hook output that answers a PermissionRequest, dismissing the TUI's own prompt. */
export function approvalReply(decision: ApprovalDecision): string {
  const answer =
    decision === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", message: "Denied from the Bazhen inbox." };
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: answer },
  });
}

/**
 * How long a tool call may wait on the PostToolUse hook. The client gives up on the daemon after
 * 2 s and acks within 5 s more, so it is done well before Claude Code would kill it and drop
 * what it wrote.
 */
const FOLD_TIMEOUT_S = 10;

/**
 * The most text a fold hands over: Claude Code 2.1.322 cuts a PostToolUse's
 * `additionalContext` at about 10,000 characters, where a wake's stderr arrives whole. Mail that
 * doesn't fit waits for a wake.
 */
export const FOLD_MAX_CHARS = 9_000;

/**
 * The PostToolUse output that folds mail into the running turn: the model reads it beside the
 * tool's result (foundation-design §5.6), in the same words a wake uses.
 */
export function foldReply(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
  });
}

/** How a woken message is introduced to the model; only a prompt carrying it saw the message. */
const wakeLabel = (id: string) => `Message for you from Bazhen (${id}):`;

/**
 * Whether a prompt carries this message as a wake handed it over, rather than naming its id in
 * passing, as a human or a background subagent quoting it might.
 */
export const carriesWake = (prompt: string, id: string) => prompt.includes(wakeLabel(id));

/**
 * What a wake hands the model: Claude Code shows it as a system notification, not user input,
 * and its UserPromptSubmit carries it verbatim, so each message's id confirms it was seen. A
 * message offered before may already have reached the agent, and says so (foundation-design §5.6).
 */
export function wakeText(
  messages: readonly { id: string; body: string; firstOffered: string | null }[],
): string {
  return messages
    .map((m) => {
      const again =
        m.firstOffered === null
          ? ""
          : `(possible re-delivery of ${m.id}, first offered ${m.firstOffered})\n`;
      return `${wakeLabel(m.id)}\n${again}${m.body}`;
    })
    .join("\n\n");
}
