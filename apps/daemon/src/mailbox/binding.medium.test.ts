import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "@bazhen/core";
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
    more: { subagent?: boolean; started?: boolean; ppid?: number; transcript?: string } = {},
  ) =>
    binding.owns(
      agentId,
      {
        sessionId,
        transcriptPath: more.transcript ?? null,
        subagent: more.subagent ?? false,
        subagentId: more.subagent === true ? "sub-1" : null,
      },
      { sessionStarted: more.started ?? false, ppid: more.ppid ?? 900 },
    );
  const session = () => store.snapshot(testView).agents[0]?.externalRef?.id;
  const rebinds = () => store.events(0).filter((e) => e.type === "agent.external_ref_updated");
  const transcript = () => store.agentLaunch(agentId)?.transcript;
  return { own, session, rebinds, transcript, store };
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

  it("records where the bound session keeps its conversation, from its own hooks only", async () => {
    const { own, transcript } = await bound();
    await own(CLAUDE_SESSION, { subagent: true, transcript: "/c/sub.jsonl" });
    await own("someone-else", { transcript: "/c/other.jsonl" });
    const fromOthers = transcript();
    await own(CLAUDE_SESSION, { transcript: "/c/own.jsonl" });
    expect([fromOthers, transcript()]).toEqual([null, "/c/own.jsonl"]);
  });

  it("forgets the last session's transcript on a rebind, until the new one's hooks name theirs", async () => {
    const { own, transcript } = await bound();
    await own(CLAUDE_SESSION, { transcript: "/c/own.jsonl" });
    await own(NEW_SESSION, { started: true });
    const rebound = transcript();
    await own(NEW_SESSION, { transcript: "/c/cleared.jsonl" });
    expect([rebound, transcript()]).toEqual([null, "/c/cleared.jsonl"]);
  });

  it("records a transcript once, though every hook names it", async () => {
    const { own, store } = await bound();
    await own(CLAUDE_SESSION, { transcript: "/c/own.jsonl" });
    await own(CLAUDE_SESSION, { transcript: "/c/own.jsonl" });
    expect(store.events(0).filter((e) => e.type === "agent.transcript_recorded")).toHaveLength(1);
  });

  it("judges a new session's SessionStart that comes before its relaunch is recorded, once it is", async () => {
    const { store, agentId } = await claudeAgent();
    const binding = new SessionBinding(store, table);
    const system = { entityId: agentId, actor: "system" } as const;
    store.append({ ...system, type: "agent.lost", payload: {} });
    store.append({
      ...system,
      type: "agent.relaunch_requested",
      payload: { terminalId: newId("term"), generation: 1, fresh: true },
    });
    const owned = binding.owns(
      agentId,
      { sessionId: NEW_SESSION, transcriptPath: null, subagent: false, subagentId: null },
      { sessionStarted: true, ppid: 900 },
    );
    // Recorded only once the SessionStart is being judged, as a slow start's is.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const environmentId = String(store.agentEnvironment(agentId));
    store.append({
      ...system,
      type: "agent.relaunched",
      payload: {
        externalRef: { environmentId, kind: "claude-session", id: NEW_SESSION },
        runtimeRef: { runtime: "tmux", locator: { panePid: String(PANE_PID) } },
      },
    });
    expect(await owned).toBe(true);
  });

  it("refuses a SessionStart whose agent stays starting past the wait, with no pane to check", async () => {
    const { store, agentId } = await claudeAgent();
    const binding = new SessionBinding(store, table, 10);
    const system = { entityId: agentId, actor: "system" } as const;
    store.append({ ...system, type: "agent.lost", payload: {} });
    store.append({
      ...system,
      type: "agent.relaunch_requested",
      payload: { terminalId: newId("term"), generation: 1, fresh: true },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const owned = await binding.owns(
      agentId,
      { sessionId: NEW_SESSION, transcriptPath: null, subagent: false, subagentId: null },
      { sessionStarted: true, ppid: 900 },
    );
    expect(owned).toBe(false);
  });
});
