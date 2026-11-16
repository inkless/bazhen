import { describe, expect, it } from "vitest";
import { listeningOf, type ListeningDeps } from "./listening.ts";

const deps = (how: "waiter" | "turn" | null, bound = true, held = false): ListeningDeps => ({
  mailbox: { listening: () => how },
  codexBound: () => bound,
  codexHeld: () => held,
});

const claude = (activity: "working" | "needs_approval" | "waiting_input" | "idle" | null) => ({
  id: "agent",
  harness: "claude-code" as const,
  activity,
});
const codex = { id: "agent", harness: "codex" as const, activity: null };
const blocked = ["needs_approval", "waiting_input"] as const;

describe("listeningOf", () => {
  it("hears a Claude Code agent whose waiter is held while it waits on nothing", () => {
    const hears = listeningOf(deps("waiter"));
    expect([hears(claude("idle")), hears(claude(null))]).toEqual([true, true]);
  });

  it("hears no agent that waits on the human, waiter, turn or bound thread notwithstanding", () => {
    const heard = blocked.flatMap((activity) => [
      listeningOf(deps("waiter"))(claude(activity)),
      listeningOf(deps("turn"))(claude(activity)),
      listeningOf(deps(null))({ ...codex, activity }),
    ]);
    expect(heard).toEqual([false, false, false, false, false, false]);
  });

  it("hears a Claude Code turn only while the agent works, not one waiting on an approval", () => {
    const hears = listeningOf(deps("turn"));
    expect([
      hears(claude("working")),
      hears(claude("needs_approval")),
      hears(claude(null)),
    ]).toEqual([true, false, false]);
  });

  it("hears no Claude Code agent with neither a waiter nor a turn", () => {
    expect(listeningOf(deps(null))(claude("working"))).toBe(false);
  });

  it("hears a Codex agent bound to a thread whose mail isn't held, and no other", () => {
    expect([
      listeningOf(deps(null))(codex),
      listeningOf(deps(null, false))(codex),
      listeningOf(deps(null, true, true))(codex),
    ]).toEqual([true, false, false]);
  });
});
