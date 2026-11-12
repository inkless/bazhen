import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@bazhen/core";
import {
  approvalReply,
  ClaudeCodeHarness,
  isMainAgentTool,
  readHook,
  wakeText,
  type Hook,
} from "./index.ts";

const toolOf = (h: Hook) => ("tool" in h ? h.tool : "");
const request = { harness: "claude-code" as const, project: "p", cwd: "/work" };
const claude = (newSessionId: () => string): HarnessAdapter =>
  new ClaudeCodeHarness({ newSessionId, hookCommand: "bazhen-hook" });

describe("Claude Code harness", () => {
  it("launches with a session id it chose, and reports that session as the agent's", () => {
    const launch = claude(() => "6f1c0b2e-0000-4000-8000-000000000001").launchSpec(request);
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

  it("gives every launch its own session", () => {
    let n = 0;
    const harness = claude(() => `session-${++n}`);
    expect([
      harness.launchSpec(request).externalRef?.id,
      harness.launchSpec(request).externalRef?.id,
    ]).toEqual(["session-1", "session-2"]);
  });

  it("installs its hooks with the launch, waking an idle session for mail", () => {
    const argv = claude(() => "s").launchSpec(request).argv;
    const settings: unknown = JSON.parse(String(argv[argv.indexOf("--settings") + 1]));
    expect(settings).toMatchObject({
      hooks: {
        Stop: [
          {
            hooks: expect.arrayContaining([
              expect.objectContaining({ command: "bazhen-hook wait", asyncRewake: true }),
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

  it("starts in a configured permission mode, and in the user's own otherwise", () => {
    const harness: HarnessAdapter = new ClaudeCodeHarness({
      newSessionId: () => "s",
      hookCommand: "h",
      permissionMode: "default",
    });
    const configured = harness.launchSpec(request).argv;
    expect([configured.slice(-2), claude(() => "s").launchSpec(request).argv]).toEqual([
      ["--permission-mode", "default"],
      expect.not.arrayContaining(["--permission-mode"]),
    ]);
  });
});

describe("Claude Code hooks", () => {
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

  it("ignores a hook it did not install", () => {
    expect(readHook("Notification", {})).toEqual({ kind: "ignored" });
  });

  it("answers a permission request in the shape Claude Code reads", () => {
    expect(JSON.parse(approvalReply("allow"))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });

  it("labels each woken message with its id, so its prompt confirms it was seen", () => {
    expect(wakeText([{ id: "msg_1", body: "hi" }])).toContain("(msg_1):\nhi");
  });
});
