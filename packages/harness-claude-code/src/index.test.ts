import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@bazhen/core";
import {
  activityOf,
  approvalReply,
  ClaudeCodeHarness,
  carriesWake,
  foldReply,
  hookOrigin,
  isMainAgentTool,
  readHook,
  wakeText,
  type Hook,
  type StatusLineChoice,
} from "./index.ts";

const toolOf = (h: Hook) => ("tool" in h ? h.tool : "");
/** What a hook of this name, with this payload, says the agent is doing. */
const activityAt = (event: string, payload: Record<string, unknown> = {}) =>
  activityOf(readHook(event, { prompt_id: "p", tool_use_id: "t", ...payload }));
/** The waiter, run for a hook event of that name. */
const waiterAt = (hook_event_name: string, source?: string) =>
  readHook("wait", { hook_event_name, session_id: "s", source });
const request = { harness: "claude-code" as const, project: "p", cwd: "/work" };
const claude = (newSessionId: () => string): HarnessAdapter =>
  new ClaudeCodeHarness({ newSessionId, hookCommand: "bazhen-hook" });

/** The status line a launch sets, given which status line to wrap; absent when it sets none. */
const statusLineOf = async (choice: StatusLineChoice) => {
  const harness = new ClaudeCodeHarness({
    newSessionId: () => "s",
    hookCommand: "bazhen-hook",
    statusLine: () => choice,
  });
  const { argv } = await harness.launchSpec(request, {});
  const settings: unknown = JSON.parse(String(argv[argv.indexOf("--settings") + 1]));
  return Reflect.get(Object(settings), "statusLine");
};

describe("Claude Code harness", () => {
  it("launches with a session id it chose, and reports that session as the agent's", async () => {
    const launch = await claude(() => "6f1c0b2e-0000-4000-8000-000000000001").launchSpec(
      request,
      {},
    );
    expect(launch.argv.slice(0, 3)).toEqual([
      "claude",
      "--session-id",
      "6f1c0b2e-0000-4000-8000-000000000001",
    ]);
    expect(launch.externalRef).toEqual({
      kind: "claude-session",
      id: "6f1c0b2e-0000-4000-8000-000000000001",
    });
  });

  it("resumes the agent's own session, with the same hooks, minting no new one", async () => {
    const harness = new ClaudeCodeHarness({
      newSessionId: () => "fresh",
      hookCommand: "bazhen-hook",
    });
    const resumed = await harness.resumeSpec(request, { kind: "claude-session", id: "s-7" }, {});
    const launched = await harness.launchSpec(request, {});
    expect([resumed.argv.slice(0, 3), resumed.externalRef]).toEqual([
      ["claude", "--resume", "s-7"],
      { kind: "claude-session", id: "s-7" },
    ]);
    expect(resumed.argv.slice(3)).toEqual(launched.argv.slice(3));
  });

  it("gives every launch its own session", async () => {
    let n = 0;
    const harness = claude(() => `session-${++n}`);
    expect([
      (await harness.launchSpec(request, {})).externalRef?.id,
      (await harness.launchSpec(request, {})).externalRef?.id,
    ]).toEqual(["session-1", "session-2"]);
  });

  it("installs its hooks with the launch, waking an idle session for mail", async () => {
    const { argv } = await claude(() => "s").launchSpec(request, {});
    const settings: unknown = JSON.parse(String(argv[argv.indexOf("--settings") + 1]));
    expect(settings).toMatchObject({
      hooks: {
        Stop: [
          {
            hooks: expect.arrayContaining([
              expect.objectContaining({ command: "bazhen-hook wait", asyncRewake: true }),
              // Not async, so a turn's end reaches the daemon before the next turn's prompt.
              { type: "command", command: "bazhen-hook Stop", timeout: 10 },
            ]),
          },
        ],
        StopFailure: [
          {
            hooks: expect.arrayContaining([
              expect.objectContaining({ command: "bazhen-hook wait", asyncRewake: true }),
              { type: "command", command: "bazhen-hook StopFailure", timeout: 10 },
            ]),
          },
        ],
        PermissionRequest: [
          {
            matcher: "*",
            hooks: [expect.objectContaining({ command: "bazhen-hook PermissionRequest" })],
          },
        ],
        // Synchronous, so its reply can fold mail into the turn.
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "bazhen-hook PostToolUse", timeout: 10 }],
          },
        ],
      },
    });
  });

  it("runs its status line around the user's own, quoted whole, alone, or sets none to leave Claude's", async () => {
    expect([
      await statusLineOf({ wrap: { command: "echo 'hi' $X", padding: 1 } }),
      await statusLineOf({ wrap: null }),
      await statusLineOf("leave"),
    ]).toEqual([
      {
        type: "command",
        command: "bazhen-hook statusline-wrap sh -c 'echo '\\''hi'\\'' $X'",
        padding: 1,
      },
      { type: "command", command: "bazhen-hook statusline-wrap" },
      undefined,
    ]);
  });

  it("starts in a configured permission mode, and in the user's own otherwise", async () => {
    const harness: HarnessAdapter = new ClaudeCodeHarness({
      newSessionId: () => "s",
      hookCommand: "h",
      permissionMode: "default",
    });
    const configured = (await harness.launchSpec(request, {})).argv;
    expect([configured.slice(-2), (await claude(() => "s").launchSpec(request, {})).argv]).toEqual([
      ["--permission-mode", "default"],
      expect.not.arrayContaining(["--permission-mode"]),
    ]);
  });
});

const settingsOf = (argv: readonly string[]): unknown =>
  JSON.parse(String(argv[argv.indexOf("--settings") + 1]));

describe("Claude Code's theme", () => {
  it("goes with its settings on a launch and a resume, and only when the request names one", async () => {
    const harness = new ClaudeCodeHarness({ newSessionId: () => "s", hookCommand: "h" });
    const launched = await harness.launchSpec(request, { theme: "light" });
    const resumed = await harness.resumeSpec(
      request,
      { kind: "claude-session", id: "s-7" },
      { theme: "dark" },
    );
    const unthemed = await harness.launchSpec(request, {});
    expect([
      settingsOf(launched.argv),
      settingsOf(resumed.argv),
      settingsOf(unthemed.argv),
    ]).toEqual([
      expect.objectContaining({ theme: "light", hooks: expect.any(Object) }),
      expect.objectContaining({ theme: "dark", hooks: expect.any(Object) }),
      expect.not.objectContaining({ theme: expect.anything() }),
    ]);
    expect([launched.theme, resumed.theme, unthemed.theme]).toEqual(["light", "dark", undefined]);
  });
});

describe("Claude Code hooks", () => {
  it("tells the waiter which turn's end it runs beside, so either report ends the turn", () => {
    const at = { session_id: "s", prompt_id: "p-1" };
    expect([
      Reflect.get(Object(readHook("wait", { ...at, hook_event_name: "Stop" })), "turnEnd"),
      Reflect.get(Object(readHook("wait", { ...at, hook_event_name: "StopFailure" })), "turnEnd"),
    ]).toEqual([
      { promptId: "p-1", failed: false, error: null },
      { promptId: "p-1", failed: true, error: null },
    ]);
  });

  it("reads the model and context use, in whole percent, from a status line's input, as far as it gives them", () => {
    const window = { context_window_size: 1_000_000, used_percentage: 12.5 };
    expect([
      readHook("statusline", { model: { display_name: "Opus 5.5" }, context_window: window }),
      readHook("statusline", { context_window: { context_window_size: 0, used_percentage: null } }),
    ]).toEqual([
      {
        kind: "statusline",
        usage: { model: "Opus 5.5", contextUsedPercent: 13, contextWindowTokens: 1_000_000 },
      },
      { kind: "statusline", usage: {} },
    ]);
  });

  it("reads a subagent's start and stop, by its id", () => {
    expect([
      readHook("SubagentStart", { agent_id: "x" }),
      readHook("SubagentStop", { agent_id: "x" }),
      readHook("SubagentStop", {}),
    ]).toEqual([
      { kind: "subagentStarted", subagentId: "x" },
      { kind: "subagentStopped", subagentId: "x" },
      { kind: "ignored" },
    ]);
  });

  it("says what each hook means the agent is doing, and nothing for the rest", () => {
    expect([
      activityAt("UserPromptSubmit", { prompt: "hi" }),
      activityAt("PreToolUse"),
      activityAt("PostToolUse"),
      activityAt("PermissionRequest", { tool_name: "Bash" }),
      activityAt("Stop"),
      activityAt("StopFailure", { error: "server_error" }),
      activityAt("wait", { hook_event_name: "StopFailure", error: "unknown" }),
      activityAt("wait", { hook_event_name: "SessionStart", source: "startup" }),
      activityAt("wait", { hook_event_name: "SessionStart", source: "compact" }),
      activityAt("Notification"),
    ]).toEqual([
      { value: "working" },
      { value: "working" },
      { value: "working" },
      { value: "needs_approval" },
      { value: "idle" },
      { value: "failed", detail: "server_error" },
      { value: "failed", detail: "unknown" },
      { value: "idle" },
      null,
      null,
    ]);
  });

  it("reads an API error's end of turn, with the prompt it ends", () => {
    expect(readHook("StopFailure", { prompt_id: "p-1", error: "rate_limit" })).toEqual({
      kind: "turnFailed",
      promptId: "p-1",
      error: "rate_limit",
    });
  });

  it("reads a prompt and the prompt id that ties the turn's end to it", () => {
    const payload = { prompt: "hello", prompt_id: "p-1", session_id: "s" };
    expect([readHook("UserPromptSubmit", payload), readHook("Stop", { prompt_id: "p-1" })]).toEqual(
      [
        { kind: "promptStarted", prompt: "hello", promptId: "p-1" },
        { kind: "turnEnded", promptId: "p-1" },
      ],
    );
  });

  it("ties a permission request to the call that started it, and that call's result to both", () => {
    const call = { prompt_id: "p-1", tool_name: "Bash", tool_input: { command: "touch x" } };
    const started = readHook("PreToolUse", { ...call, tool_use_id: "t-1" });
    const asked = readHook("PermissionRequest", call);
    expect([
      started,
      asked,
      readHook("PostToolUseFailure", { ...call, tool_use_id: "t-1" }),
    ]).toEqual([
      { kind: "toolStarted", tool: toolOf(asked), useId: "t-1" },
      { kind: "permission", summary: 'Bash: {"command":"touch x"}', tool: toolOf(asked) },
      { kind: "toolSettled", useId: "t-1", fold: null },
    ]);
  });

  it("lets a finished tool call's PostToolUse fold mail into its turn", () => {
    expect(readHook("PostToolUse", { prompt_id: "p-1", tool_use_id: "t-1" })).toEqual({
      kind: "toolSettled",
      useId: "t-1",
      fold: { promptId: "p-1" },
    });
  });

  it("folds mail in the shape Claude Code adds beside a tool's result", () => {
    expect(JSON.parse(foldReply("hello"))).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "hello" },
    });
  });

  it("tells a subagent's tool call apart from the same call by the agent itself", () => {
    const call = { tool_name: "Bash", tool_input: { command: "touch x" } };
    const own = readHook("PermissionRequest", call);
    const subagent = readHook("PermissionRequest", { ...call, agent_id: "sub-1" });
    expect([own, subagent].map((h) => isMainAgentTool(toolOf(h)))).toEqual([true, false]);
  });

  // Allowing a question runs it without answering it, so the agent waits on, or asks again.
  it("leaves a question for the human to the TUI, which an inbox allow or deny can't answer", () => {
    const question = { tool_name: "AskUserQuestion", tool_input: { questions: [] } };
    expect(readHook("PermissionRequest", question)).toEqual({ kind: "ignored" });
  });

  it("tells the waiter a SessionStart ran it, which may move the binding", () => {
    expect([
      waiterAt("SessionStart", "clear"),
      waiterAt("SessionStart", "compact"),
      waiterAt("Stop"),
    ]).toEqual([
      { kind: "wait", sessionStarted: true, compacted: false, turnEnd: null },
      { kind: "wait", sessionStarted: true, compacted: true, turnEnd: null },
      {
        kind: "wait",
        sessionStarted: false,
        compacted: false,
        turnEnd: { promptId: null, failed: false, error: null },
      },
    ]);
  });

  it("reads which session ran a hook, and whether a subagent did", () => {
    const main = { subagent: false, subagentId: null };
    expect(hookOrigin({ session_id: "s-1" })).toEqual({ sessionId: "s-1", ...main });
    expect(hookOrigin({ session_id: "s-1", agent_id: "a-1" })).toEqual({
      sessionId: "s-1",
      subagent: true,
      subagentId: "a-1",
    });
    expect(hookOrigin({ session_id: "" })).toEqual({ sessionId: null, ...main });
    expect(hookOrigin(null)).toEqual({ sessionId: null, ...main });
  });

  it("ignores a hook it did not install", () => {
    expect(readHook("Notification", {})).toEqual({ kind: "ignored" });
  });

  it("answers a permission request in the shape Claude Code reads", () => {
    expect(JSON.parse(approvalReply("allow"))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });

  it("knows a prompt that carries a wake from one that only names the message", () => {
    const wake = wakeText([{ id: "msg_1", body: "hi", firstOffered: "2026-11-12T08:00:00Z" }]);
    expect([carriesWake(wake, "msg_1"), carriesWake("what is msg_1?", "msg_1")]).toEqual([
      true,
      false,
    ]);
  });

  it("labels each woken message with its id, so its prompt confirms it was seen", () => {
    expect(wakeText([{ id: "msg_1", body: "hi", firstOffered: null }])).toContain("(msg_1):\nhi");
  });

  it("labels a message offered before as a possible re-delivery", () => {
    const again = wakeText([{ id: "msg_1", body: "hi", firstOffered: "2026-11-12T08:00:00Z" }]);
    expect(again).toContain("possible re-delivery of msg_1, first offered 2026-11-12T08:00:00Z");
  });
});
