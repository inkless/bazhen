import type { AgentLaunchRequest, HarnessAdapter, HarnessLaunch } from "@bazhen/core";
import type { ApprovalDecision, ExternalRef } from "@bazhen/protocol";

export interface ClaudeCodeOptions {
  readonly newSessionId: () => string;
  /** The hook client as a shell command; Bazhen appends the event. */
  readonly hookCommand: string;
  /** A permission mode every agent starts in; unset, each starts in the user's own. */
  readonly permissionMode?: string;
}

/**
 * Claude Code, reached through its hooks (foundation-design §5.6). Bazhen picks the session id
 * itself, so the agent's first binding is known before any hook fires (§3.1), and passes its
 * hooks with the launch, beside the user's own, so nothing is written to the user's settings.
 */
export class ClaudeCodeHarness implements HarnessAdapter {
  readonly id = "claude-code";
  private readonly opts: ClaudeCodeOptions;

  constructor(opts: ClaudeCodeOptions) {
    this.opts = opts;
  }

  async launchSpec(): Promise<HarnessLaunch> {
    const id = this.opts.newSessionId();
    return this.spec(["--session-id", id], id);
  }

  /** The same TUI, with its hooks, on the session the agent already had. */
  async resumeSpec(
    _request: AgentLaunchRequest,
    session: Omit<ExternalRef, "environmentId">,
  ): Promise<HarnessLaunch> {
    return this.spec(["--resume", session.id], session.id);
  }

  private spec(session: string[], id: string): HarnessLaunch {
    return {
      argv: [
        "claude",
        ...session,
        "--settings",
        JSON.stringify(hooks(this.opts.hookCommand)),
        ...(this.opts.permissionMode === undefined
          ? []
          : ["--permission-mode", this.opts.permissionMode]),
      ],
      env: {},
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
      PostToolUse: [{ matcher: "*", hooks: [report("PostToolUse")] }],
      PostToolUseFailure: [{ matcher: "*", hooks: [report("PostToolUseFailure")] }],
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
      readonly turnEnd: { readonly promptId: string | null; readonly failed: boolean } | null;
    }
  | { readonly kind: "toolStarted"; readonly tool: string; readonly useId: string }
  | { readonly kind: "permission"; readonly summary: string; readonly tool: string }
  | { readonly kind: "promptStarted"; readonly prompt: string; readonly promptId: string | null }
  | { readonly kind: "turnEnded"; readonly promptId: string | null }
  | { readonly kind: "turnFailed"; readonly promptId: string | null }
  | { readonly kind: "toolSettled"; readonly useId: string }
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
    case "PermissionRequest":
      // A question wants the human's choice, which allow or deny can't give: the TUI asks it.
      if (field(payload, "tool_name") === "AskUserQuestion") return IGNORED;
      return { kind: "permission", summary: approvalSummary(payload), tool: toolKey(payload) };
    case "UserPromptSubmit":
      return { kind: "promptStarted", prompt: promptOf(payload), promptId: promptIdOf(payload) };
    case "Stop":
      return { kind: "turnEnded", promptId: promptIdOf(payload) };
    case "StopFailure":
      return { kind: "turnFailed", promptId: promptIdOf(payload) };
    case "PostToolUse":
    case "PostToolUseFailure": {
      const useId = toolUseIdOf(payload);
      return useId === null ? IGNORED : { kind: "toolSettled", useId };
    }
    default:
      return IGNORED;
  }
}

const IGNORED: Hook = { kind: "ignored" };

/** The turn a Stop or StopFailure payload ends, for a hook that runs beside those reports. */
function turnEndOf(payload: unknown): { promptId: string | null; failed: boolean } | null {
  const event = field(payload, "hook_event_name");
  if (event !== "Stop" && event !== "StopFailure") return null;
  return { promptId: promptIdOf(payload), failed: event === "StopFailure" };
}

/** Which Claude Code session ran a hook, and whether one of its subagents did. */
export interface HookOrigin {
  readonly sessionId: string | null;
  /** A subagent's hook, which carries `agent_id`; compaction runs as one (§3.1). */
  readonly subagent: boolean;
}

export function hookOrigin(payload: unknown): HookOrigin {
  const session = field(payload, "session_id");
  return {
    sessionId: typeof session === "string" && session !== "" ? session : null,
    subagent: typeof field(payload, "agent_id") === "string",
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
      return `Message for you from Bazhen (${m.id}):\n${again}${m.body}`;
    })
    .join("\n\n");
}
