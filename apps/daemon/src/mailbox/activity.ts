import { activityOf, type Hook, type HookOrigin } from "@bazhen/harness-claude-code";
import type { Activity } from "@bazhen/protocol";

type Doing = Pick<Activity, "value" | "detail">;

/** What a busy agent's idle main turn reads as while a subagent of its still works. */
const SUBAGENT_RUNNING: Doing = { value: "working", detail: "subagent running" };

/**
 * What a Claude Code agent is doing, from its hooks (foundation-design §4.6). The main agent's
 * hooks say what its turn is doing; a background subagent outlives that turn, so the agent reads
 * idle only once the main turn has ended and every subagent has stopped (SubagentStart and
 * SubagentStop bound each one). A subagent waiting on a permission makes the agent need approval.
 *
 * The safe way round is always `working`: after an Esc, a TUI answer the hooks don't see, or a
 * plain deny, the agent reads as it last did until its next hook, and a subagent whose stop was
 * never heard keeps it working until the session starts over.
 */
export class ActivityTracker {
  private readonly record: (agentId: string, activity: Activity) => void;
  private readonly main = new Map<string, Doing>();
  /** Per agent, each open subagent by its id, and whether it waits on a permission. */
  private readonly subagents = new Map<string, Map<string, Doing>>();
  /**
   * Agents the daemon restarted under, which a waiter can't vouch for: a waiter outlives the
   * restart by posting its first request again, a SessionStart or a Stop from before it, which
   * says nothing of now. Until another of the main agent's hooks arrives, waiters are ignored.
   */
  private readonly unvouched = new Set<string>();

  constructor(record: (agentId: string, activity: Activity) => void) {
    this.record = record;
  }

  /** A hook from the agent's own session, a subagent's included. */
  observe(agentId: string, origin: HookOrigin, hook: Hook): void {
    const open = this.subagents.get(agentId) ?? new Map<string, Doing>();
    this.subagents.set(agentId, open);
    const doing = activityOf(hook);
    if (this.unvouched.has(agentId) && origin.subagentId === null) {
      if (hook.kind === "wait") return;
      if (doing !== null) this.unvouched.delete(agentId);
    }
    if (hook.kind === "subagentStarted") open.set(hook.subagentId, { value: "working" });
    else if (hook.kind === "subagentStopped") open.delete(hook.subagentId);
    else if (origin.subagentId !== null) {
      // Any hook of a subagent's says it is open, though its start went unheard.
      if (doing !== null) open.set(origin.subagentId, doing);
    } else if (doing !== null) this.main.set(agentId, doing);
    else return;
    const now = this.effective(agentId);
    if (now === undefined) return;
    this.record(agentId, {
      ...now,
      source: "native",
      confidence: 1,
      observedAt: new Date().toISOString(),
    });
  }

  /**
   * The daemon started with this agent already running: what its subagents are doing went with
   * the last daemon's memory, so it reads unknown, never idle, until a main hook other than a
   * waiter (a prompt, a tool call, a turn's Stop report) says what it is doing.
   */
  restarted(agentId: string): void {
    this.unvouched.add(agentId);
    this.main.set(agentId, { value: "unknown", detail: "daemon restarted" });
    this.record(agentId, {
      value: "unknown",
      detail: "daemon restarted",
      source: "heuristic",
      confidence: 1,
      observedAt: new Date().toISOString(),
    });
  }

  /** The session started over: its subagents went with it. */
  sessionStarted(agentId: string): void {
    this.subagents.delete(agentId);
  }

  private effective(agentId: string): Doing | undefined {
    const main = this.main.get(agentId);
    const open = [...(this.subagents.get(agentId)?.values() ?? [])];
    if (main?.value === "needs_approval" || open.some((d) => d.value === "needs_approval")) {
      return { value: "needs_approval" };
    }
    if (main?.value === "working") return main;
    if (open.length > 0) return SUBAGENT_RUNNING;
    return main;
  }
}
