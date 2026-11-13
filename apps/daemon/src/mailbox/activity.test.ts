import { describe, expect, it } from "vitest";
import { readHook, type HookOrigin } from "@bazhen/harness-claude-code";
import type { Activity } from "@bazhen/protocol";
import { ActivityTracker } from "./activity.ts";

const MAIN: HookOrigin = {
  sessionId: "s",
  transcriptPath: null,
  subagent: false,
  subagentId: null,
};
const sub = (id: string): HookOrigin => ({
  sessionId: "s",
  transcriptPath: null,
  subagent: true,
  subagentId: id,
});

/** A tracker for agent `a`, and what it has recorded so far, as value and detail. */
function tracked() {
  const recorded: Activity[] = [];
  const tracker = new ActivityTracker((_agent, activity) => recorded.push(activity));
  const hook = (event: string, origin = MAIN, payload: Record<string, unknown> = {}) =>
    tracker.observe("a", origin, readHook(event, { prompt_id: "p", tool_use_id: "t", ...payload }));
  const now = () => {
    const last = recorded.at(-1);
    return last === undefined ? undefined : [last.value, last.detail];
  };
  return { tracker, hook, now };
}

describe("ActivityTracker", () => {
  it("keeps the agent working while a background subagent outlives the turn that started it", () => {
    const { hook, now } = tracked();
    hook("UserPromptSubmit", MAIN, { prompt: "go" });
    hook("SubagentStart", sub("x"), { agent_id: "x" });
    hook("Stop");
    expect(now()).toEqual(["working", "subagent running"]);
    hook("PreToolUse", sub("x"), { agent_id: "x" });
    hook("PostToolUse", sub("x"), { agent_id: "x" });
    expect(now()).toEqual(["working", "subagent running"]);
    hook("SubagentStop", sub("x"), { agent_id: "x" });
    expect(now()).toEqual(["idle", undefined]);
  });

  it("forgets what a replaced process was doing, so a new one's subagent isn't read through it", () => {
    const { tracker, hook, now } = tracked();
    hook("PermissionRequest", MAIN, { tool_name: "Bash" });
    const before = now();
    tracker.replaced("a");
    hook("PreToolUse", sub("x"), { agent_id: "x" });
    expect([before, now()]).toEqual([
      ["needs_approval", undefined],
      ["working", "subagent running"],
    ]);
  });

  it("needs approval while a subagent waits on one, and works on after it", () => {
    const { hook, now } = tracked();
    hook("SubagentStart", sub("x"), { agent_id: "x" });
    hook("Stop");
    hook("PermissionRequest", sub("x"), { agent_id: "x", tool_name: "Bash" });
    expect(now()).toEqual(["needs_approval", undefined]);
    hook("PostToolUse", sub("x"), { agent_id: "x" });
    expect(now()).toEqual(["working", "subagent running"]);
  });

  it("counts a subagent whose start went unheard as open from its first hook", () => {
    const { hook, now } = tracked();
    hook("Stop");
    hook("PreToolUse", sub("y"), { agent_id: "y" });
    hook("Stop");
    expect(now()).toEqual(["working", "subagent running"]);
  });

  it("forgets the subagents of a session that started over", () => {
    const { tracker, hook, now } = tracked();
    hook("SubagentStart", sub("x"), { agent_id: "x" });
    tracker.sessionStarted("a");
    hook("Stop");
    expect(now()).toEqual(["idle", undefined]);
  });

  it("reads an agent the daemon restarted under as unknown, never idle, until its main turn speaks", () => {
    const { tracker, hook, now } = tracked();
    tracker.restarted("a");
    expect(now()).toEqual(["unknown", "daemon restarted"]);
    // A subagent the last daemon heard start, still running, then done: still no word from the main.
    hook("PostToolUse", sub("z"), { agent_id: "z" });
    expect(now()).toEqual(["working", "subagent running"]);
    hook("SubagentStop", sub("z"), { agent_id: "z" });
    expect(now()).toEqual(["unknown", "daemon restarted"]);
    hook("Stop");
    expect(now()).toEqual(["idle", undefined]);
  });

  it("takes no word from a waiter that outlived the restart, only from the main agent's next hook", () => {
    const { tracker, hook, now } = tracked();
    tracker.restarted("a");
    // A waiter reconnects by posting its SessionStart or Stop from before the restart again.
    hook("wait", MAIN, { hook_event_name: "SessionStart", source: "startup" });
    hook("wait", MAIN, { hook_event_name: "Stop" });
    expect(now()).toEqual(["unknown", "daemon restarted"]);
    hook("Stop");
    expect(now()).toEqual(["idle", undefined]);
    // Vouched for again, a later waiter's turn end counts as before.
    hook("UserPromptSubmit", MAIN, { prompt: "go" });
    hook("wait", MAIN, { hook_event_name: "Stop" });
    expect(now()).toEqual(["idle", undefined]);
  });
});
