import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SESSION, PANE_PID, claudeAgent, testView } from "../testing/fixtures.ts";
import { SessionBinding, type ProcessEntry } from "./binding.ts";

const NEW_SESSION = "22222222-2222-4222-8222-222222222222";
const LATER_SESSION = "33333333-3333-4333-8333-333333333333";

afterEach(() => vi.restoreAllMocks());

/** The pane's TUI runs hooks through `sh` 900; a nested claude 800 runs its own through 700. */
const procs: Record<number, ProcessEntry> = {
  900: { ppid: PANE_PID, command: "/bin/sh" },
  // A second shell of the pane's, which `ps` is slow to answer for.
  950: { ppid: PANE_PID, command: "/bin/sh" },
  800: { ppid: 600, command: "claude" },
  700: { ppid: 800, command: "sh" },
  600: { ppid: PANE_PID, command: "bash" },
};
const table = {
  parent: async (pid: number) => {
    if (pid === 950) await new Promise((resolve) => setTimeout(resolve, 30));
    if (pid === 990) throw new Error("the process table broke");
    return procs[pid];
  },
};

async function bound() {
  const { store, agentId } = await claudeAgent();
  const binding = new SessionBinding(store, table);
  const own = (
    sessionId: string | null,
    more: { subagent?: boolean; started?: boolean; ppid?: number } = {},
  ) =>
    binding.owns(
      agentId,
      { sessionId, subagent: more.subagent ?? false },
      { sessionStarted: more.started ?? false, ppid: more.ppid ?? 900 },
    );
  const session = () => store.snapshot(testView).agents[0]?.externalRef?.id;
  const rebinds = () => store.events(0).filter((e) => e.type === "agent.external_ref_updated");
  return { own, session, rebinds };
}

describe("SessionBinding", () => {
  it("owns the bound session's hooks, and no subagent's or other session's", async () => {
    const { own } = await bound();
    expect(await own(CLAUDE_SESSION)).toBe(true);
    expect(await own(CLAUDE_SESSION, { subagent: true })).toBe(false);
    expect(await own(NEW_SESSION)).toBe(false);
    expect(await own(null)).toBe(false);
  });

  it("rebinds on a SessionStart the pane's process ran on a new session, as /clear starts", async () => {
    const { own, session, rebinds } = await bound();
    expect(await own(NEW_SESSION, { started: true })).toBe(true);
    expect(session()).toBe(NEW_SESSION);
    expect(rebinds()).toHaveLength(1);
    // The old session's waiters, which Claude Code never reaps, no longer count.
    expect(await own(CLAUDE_SESSION)).toBe(false);
    expect(await own(NEW_SESSION)).toBe(true);
    expect(rebinds()).toHaveLength(1);
  });

  it("never rebinds on a nested claude's SessionStart, and says so", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { own, session, rebinds } = await bound();
    expect(await own(NEW_SESSION, { started: true, ppid: 700 })).toBe(false);
    expect(session()).toBe(CLAUDE_SESSION);
    expect(rebinds()).toHaveLength(0);
    expect(String(log.mock.calls[0])).toContain(`SessionStart of ${NEW_SESSION} wasn't its pane's`);
  });

  it("never rebinds on a hook that isn't a SessionStart, or a subagent's", async () => {
    const { own, rebinds } = await bound();
    expect(await own(NEW_SESSION, { started: false })).toBe(false);
    expect(await own(NEW_SESSION, { started: true, subagent: true })).toBe(false);
    expect(rebinds()).toHaveLength(0);
  });

  it("records one rebind for two SessionStarts of the same new session", async () => {
    const { own, rebinds } = await bound();
    const both = await Promise.all([
      own(NEW_SESSION, { started: true }),
      own(NEW_SESSION, { started: true }),
    ]);
    expect(both).toEqual([true, true]);
    expect(rebinds()).toHaveLength(1);
  });

  it("settles two quick rebinds in the order they arrived, though the first walk is slower", async () => {
    const { own, session, rebinds } = await bound();
    const first = own(NEW_SESSION, { started: true, ppid: 950 });
    const second = own(LATER_SESSION, { started: true, ppid: 900 });
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(session()).toBe(LATER_SESSION);
    expect(rebinds()).toHaveLength(2);
  });

  it("still checks the next rebind when the one before it threw", async () => {
    const { own, session } = await bound();
    const broken = own(NEW_SESSION, { started: true, ppid: 990 });
    const next = own(LATER_SESSION, { started: true, ppid: 900 });
    await expect(broken).rejects.toThrow("the process table broke");
    expect(await next).toBe(true);
    expect(session()).toBe(LATER_SESSION);
  });
});
