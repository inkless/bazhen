import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@bazhen/core";
import {
  approvalReply,
  ClaudeCodeHarness,
  hookOrigin,
  isMainAgentTool,
  readHook,
  wakeText,
  type Hook,
} from "./index.ts";

const toolOf = (h: Hook) => ("tool" in h ? h.tool : "");
/** The waiter, run for a hook event of that name. */
const waiterAt = (hook_event_name: string, source?: string) =>
  readHook("wait", { hook_event_name, session_id: "s", source });
const request = { harness: "claude-code" as const, project: "p", cwd: "/work" };
const claude = (newSessionId: () => string): HarnessAdapter =>
  new ClaudeCodeHarness({ newSessionId, hookCommand: "bazhen-hook" });

describe("Claude Code harness", () => {
  it("launches with a session id it chose, and reports that session as the agent's", async () => {
    const launch = await claude(() => "6f1c0b2e-0000-4000-8000-000000000001").launchSpec(request);
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
    const resumed = await harness.resumeSpec(request, { kind: "claude-session", id: "s-7" });
    const launched = await harness.launchSpec();
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
      (await harness.launchSpec(request)).externalRef?.id,
      (await harness.launchSpec(request)).externalRef?.id,
    ]).toEqual(["session-1", "session-2"]);
  });

  it("installs its hooks with the launch, waking an idle session for mail", async () => {
    const { argv } = await claude(() => "s").launchSpec(request);
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
      },
    });
  });

  it("starts in a configured permission mode, and in the user's own otherwise", async () => {
    const harness: HarnessAdapter = new ClaudeCodeHarness({
      newSessionId: () => "s",
      hookCommand: "h",
      permissionMode: "default",
    });
    const configured = (await harness.launchSpec(request)).argv;
    expect([configured.slice(-2), (await claude(() => "s").launchSpec(request)).argv]).toEqual([
      ["--permission-mode", "default"],
      expect.not.arrayContaining(["--permission-mode"]),
    ]);
  });
});

describe("Claude Code hooks", () => {
  it("tells the waiter which turn's end it runs beside, so either report ends the turn", () => {
    const at = { session_id: "s", prompt_id: "p-1" };
    expect([
      Reflect.get(Object(readHook("wait", { ...at, hook_event_name: "Stop" })), "turnEnd"),
      Reflect.get(Object(readHook("wait", { ...at, hook_event_name: "StopFailure" })), "turnEnd"),
    ]).toEqual([
      { promptId: "p-1", failed: false },
      { promptId: "p-1", failed: true },
    ]);
  });

  it("reads an API error's end of turn, with the prompt it ends", () => {
    expect(readHook("StopFailure", { prompt_id: "p-1", error: "rate_limit" })).toEqual({
      kind: "turnFailed",
      promptId: "p-1",
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
      { kind: "toolSettled", useId: "t-1" },
    ]);
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
        turnEnd: { promptId: null, failed: false },
      },
    ]);
  });

  it("reads which session ran a hook, and whether a subagent did", () => {
    expect(hookOrigin({ session_id: "s-1" })).toEqual({ sessionId: "s-1", subagent: false });
    expect(hookOrigin({ session_id: "s-1", agent_id: "a-1" })).toEqual({
      sessionId: "s-1",
      subagent: true,
    });
    expect(hookOrigin({ session_id: "" })).toEqual({ sessionId: null, subagent: false });
    expect(hookOrigin(null)).toEqual({ sessionId: null, subagent: false });
  });

  it("ignores a hook it did not install", () => {
    expect(readHook("Notification", {})).toEqual({ kind: "ignored" });
  });

  it("answers a permission request in the shape Claude Code reads", () => {
    expect(JSON.parse(approvalReply("allow"))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });

  it("labels each woken message with its id, so its prompt confirms it was seen", () => {
    expect(wakeText([{ id: "msg_1", body: "hi", firstOffered: null }])).toContain("(msg_1):\nhi");
  });

  it("labels a message offered before as a possible re-delivery", () => {
    const again = wakeText([{ id: "msg_1", body: "hi", firstOffered: "2026-11-12T08:00:00Z" }]);
    expect(again).toContain("possible re-delivery of msg_1, first offered 2026-11-12T08:00:00Z");
  });
});
