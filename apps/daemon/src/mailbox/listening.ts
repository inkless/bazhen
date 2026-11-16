import type { Activity, HarnessId } from "@bazhen/protocol";
import type { Mailbox } from "./mailbox.ts";

/** A running agent, as far as whether mail reaches it depends on. */
export interface Listener {
  readonly id: string;
  readonly harness: HarnessId;
  readonly activity: Activity["value"] | null;
}

export interface ListeningDeps {
  readonly mailbox: Pick<Mailbox, "listening">;
  /** Whether a Codex agent is bound to a thread its mail can go to. */
  readonly codexBound: (agentId: string) => boolean;
  /** Whether a Codex agent's mail waits for now, as while its TUI shows another thread. */
  readonly codexHeld: (agentId: string) => boolean;
}

/** What an agent waits on the human for, while mail it is sent waits on that too. */
const BLOCKED: ReadonlySet<Activity["value"]> = new Set(["needs_approval", "waiting_input"]);

/**
 * Whether mail sent to a running agent now reaches it with nothing else happening. An agent
 * waiting on an approval or an answer takes no mail until the human gives it, whatever else
 * holds: Claude Code's waiter stays held through a turn the human started. A Claude Code turn
 * counts only while the agent is said to be working, since one ended by Esc reports no end, so
 * its turn would otherwise stand.
 */
export const listeningOf =
  (deps: ListeningDeps) =>
  ({ id, harness, activity }: Listener): boolean => {
    if (activity !== null && BLOCKED.has(activity)) return false;
    if (harness === "codex") return deps.codexBound(id) && !deps.codexHeld(id);
    const how = deps.mailbox.listening(id);
    return how === "waiter" || (how === "turn" && activity === "working");
  };
