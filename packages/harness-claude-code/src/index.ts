import type { HarnessAdapter, HarnessLaunch } from "@bazhen/core";
import type { ApprovalDecision } from "@bazhen/protocol";

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

  launchSpec(): HarnessLaunch {
    const id = this.opts.newSessionId();
    return {
      argv: [
        "claude",
        "--session-id",
        id,
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
      Stop: [{ hooks: [waiter, report("Stop")] }],
      UserPromptSubmit: [{ hooks: [run("UserPromptSubmit", 10)] }],
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
  | { readonly kind: "wait" }
  | { readonly kind: "permission"; readonly summary: string; readonly tool: string }
  | { readonly kind: "promptStarted"; readonly prompt: string; readonly promptId: string | null }
  | { readonly kind: "turnEnded"; readonly promptId: string | null }
  | { readonly kind: "toolSettled"; readonly tool: string }
  | { readonly kind: "ignored" };

/** Reads one of the hooks `launchSpec` installed; the daemon never sees Claude Code's formats. */
export function readHook(event: string, payload: unknown): Hook {
  switch (event) {
    case "wait":
      return { kind: "wait" };
    case "PermissionRequest":
      return { kind: "permission", summary: approvalSummary(payload), tool: toolKey(payload) };
    case "UserPromptSubmit":
      return { kind: "promptStarted", prompt: promptOf(payload), promptId: promptIdOf(payload) };
    case "Stop":
      return { kind: "turnEnded", promptId: promptIdOf(payload) };
    case "PostToolUse":
    case "PostToolUseFailure":
      return { kind: "toolSettled", tool: toolKey(payload) };
    default:
      return { kind: "ignored" };
  }
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

/**
 * Which tool call a hook is about. A PermissionRequest carries no tool_use_id, so a request and
 * the tool's result are matched by who called it (the agent or one of its subagents), the tool
 * and its exact input (foundation-design §5.6).
 */
function toolKey(payload: unknown): string {
  const caller = field(payload, "agent_id");
  return JSON.stringify([
    typeof caller === "string" ? caller : "main",
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
 * and its UserPromptSubmit carries it verbatim, so each message's id confirms it was seen.
 */
export function wakeText(messages: readonly { id: string; body: string }[]): string {
  return messages.map((m) => `Message for you from Bazhen (${m.id}):\n${m.body}`).join("\n\n");
}
