import { afterEach, describe, expect, it } from "vitest";
import type { TerminalId } from "@bazhen/core";
import { Approvals } from "../mailbox/approvals.ts";
import { Inbox } from "../attention/inbox.ts";
import type { Store } from "../store/store.ts";
import { testView, withAgent, withStartingCodexAgentsOn } from "../testing/fixtures.ts";
import { localEnvironmentId } from "./launch.ts";
import { Readiness } from "./readiness.ts";

const DEADLINE_MS = 30;

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

/**
 * An agent still waiting on its harness, followed by the daemon's inbox and readiness, whose
 * clock reads `now` and whose deadline is `DEADLINE_MS`.
 */
async function starting(
  now: () => number = Date.now,
  notStarted?: (box: Inbox) => (id: string, summary: string) => void,
) {
  const { store, agentId, terminalId } = await withAgent(undefined, { starting: true });
  const box = new Inbox(store, new Approvals(store), () => ({ messageId: "msg_x", eventIds: [] }));
  stops.push(box.follow());
  const up: TerminalId[] = [];
  const reused: TerminalId[] = [];
  const left: TerminalId[] = [];
  const released: string[] = [];
  const logged: string[] = [];
  const readiness = new Readiness({
    store,
    environmentId: localEnvironmentId(store),
    deadlineMs: DEADLINE_MS,
    notStarted: notStarted?.(box) ?? ((id, summary) => box.notStarted(id, summary)),
    terminalUp: (terminal) => up.push(terminal),
    terminalReused: (terminal) => reused.push(terminal),
    terminalLeft: (terminal) => left.push(terminal),
    released: (id) => released.push(id),
    now,
    log: (message) => logged.push(message),
  });
  const follow = () => stops.push(readiness.follow());
  return { store, agentId, terminalId, box, readiness, follow, up, reused, left, released, logged };
}

/** The agent's not-started items, as `state:closeReason`. */
const stuck = (store: Store) =>
  store
    .snapshot(testView)
    .attention.filter((a) => a.kind === "stuck_starting")
    .map((a) => `${a.state}:${a.closeReason ?? ""}`);
const lifecycle = (store: Store) => store.snapshot(testView).agents[0]?.state;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens the item through the inbox, failing the first `failures` times as a busy store would. */
const failingFirst = (failures: number) => (box: Inbox) => {
  let left = failures;
  return (agentId: string, summary: string) => {
    if (left-- > 0) throw new Error("the store is busy");
    box.notStarted(agentId, summary);
  };
};

function respawn(store: Store, agentId: string) {
  const system = { entityId: agentId, actor: "system" } as const;
  store.append({ ...system, type: "agent.exited", payload: { exit: { type: "exited", code: 0 } } });
  store.append({ ...system, type: "agent.respawn_requested", payload: {} });
  store.append({
    ...system,
    type: "agent.respawned",
    payload: { externalRef: null, runtimeRef: { runtime: "tmux", locator: { generation: "1" } } },
  });
}

describe("launch readiness", () => {
  it("runs a starting agent on its harness's sign, and releases what waited for it", async () => {
    const s = await starting();
    s.follow();
    s.readiness.ready(s.agentId, "claude_hook");
    s.readiness.ready(s.agentId, "claude_hook");
    const readies = s.store.events(0).filter((e) => e.type === "agent.ready");
    expect([lifecycle(s.store), readies.length, s.released]).toEqual(["running", 1, [s.agentId]]);
  });

  it("tells the human once, past the deadline, to look at the terminal of an agent still starting", async () => {
    const s = await starting();
    s.follow();
    await expect.poll(() => stuck(s.store)).toEqual(["open:"]);
    await pause(DEADLINE_MS * 3);
    const actions = s.store.openAttention(s.agentId).map((item) => s.box.actions(item));
    const summary = s.store.snapshot(testView).attention[0]?.summary;
    expect([stuck(s.store), actions, summary]).toEqual([
      ["open:"],
      [["dismiss"]],
      expect.stringContaining("Look in its terminal for a dialog"),
    ]);
  });

  it("tells the human nothing of an agent whose harness came up in time", async () => {
    const s = await starting();
    s.follow();
    s.readiness.ready(s.agentId, "codex_title");
    await pause(DEADLINE_MS * 3);
    expect(stuck(s.store)).toEqual([]);
  });

  it("closes the item as answered in the terminal once the harness comes up", async () => {
    const s = await starting();
    s.follow();
    await expect.poll(() => stuck(s.store)).toEqual(["open:"]);
    s.readiness.ready(s.agentId, "claude_hook");
    expect([stuck(s.store), lifecycle(s.store)]).toEqual([["closed:answered_in_tui"], "running"]);
  });

  it("closes the item as stale when the agent ends before its harness comes up", async () => {
    const s = await starting();
    s.follow();
    await expect.poll(() => stuck(s.store)).toEqual(["open:"]);
    s.store.append({
      type: "agent.exited",
      entityId: s.agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 1 } },
    });
    expect([stuck(s.store), lifecycle(s.store)]).toEqual([["closed:stale"], "exited"]);
  });

  it("times a start from when its terminal came up, across a restart", async () => {
    const later = Date.now() + 10 * DEADLINE_MS;
    const s = await starting(() => later);
    s.follow();
    // Long past its deadline by the clock, so it fires on the first turn of the loop.
    await pause(1);
    expect(stuck(s.store)).toEqual(["open:"]);
  });

  it("doesn't tell again of a start it told of and the human dismissed, after a restart", async () => {
    const s = await starting();
    s.follow();
    await expect.poll(() => stuck(s.store)).toEqual(["open:"]);
    for (const item of s.store.openAttention(s.agentId))
      s.box.dismiss(item.id, { idempotencyKey: "d" });
    s.follow();
    await pause(DEADLINE_MS * 3);
    expect(stuck(s.store)).toEqual(["closed:dismissed"]);
  });

  it("times a respawn as a new start, says its terminal is reused, and says when it is up", async () => {
    const s = await starting();
    s.follow();
    await expect.poll(() => stuck(s.store)).toEqual(["open:"]);
    respawn(s.store, s.agentId);
    await expect.poll(() => stuck(s.store)).toEqual(["closed:stale", "open:"]);
    expect([lifecycle(s.store), s.reused, s.up]).toEqual([
      "starting",
      [s.terminalId],
      [s.terminalId],
    ]);
  });

  it("says when no start will come in a reused terminal: a refused respawn, or a close", async () => {
    const s = await starting();
    s.follow();
    const system = { entityId: s.agentId, actor: "system" } as const;
    s.store.append({ ...system, type: "agent.exited", payload: { exit: { type: "unknown" } } });
    s.store.append({ ...system, type: "agent.respawn_requested", payload: {} });
    s.store.append({
      ...system,
      type: "agent.respawn_rejected",
      payload: { reason: "daemon_restart" },
    });
    s.store.append({ ...system, type: "agent.closing", payload: {} });
    expect([s.reused, s.left]).toEqual([[s.terminalId], [s.terminalId, s.terminalId]]);
  });

  it("tries again, and says so, when telling the human fails", async () => {
    const s = await starting(Date.now, failingFirst(1));
    s.follow();
    await expect.poll(() => stuck(s.store)).toEqual(["open:"]);
    expect(s.logged).toEqual([expect.stringContaining("trying again")]);
  });

  it("tells the human what to check of a Codex whose TUI may be up unseen", async () => {
    const { store, agentOn } = await withStartingCodexAgentsOn("tmux", "thr-1");
    const box = new Inbox(store, new Approvals(store), () => ({
      messageId: "msg_x",
      eventIds: [],
    }));
    stops.push(box.follow());
    const readiness = new Readiness({
      store,
      environmentId: localEnvironmentId(store),
      deadlineMs: DEADLINE_MS,
      notStarted: (id, summary) => box.notStarted(id, summary),
    });
    stops.push(readiness.follow());
    const summary = async () =>
      store.snapshot(testView).attention.find((a) => a.agentId === agentOn("thr-1"))?.summary;
    await expect.poll(summary).toContain("tui.terminal_title");
  });

  // The hook binding holds a sign that comes early until the start's terminal runs.
  it("records no sign itself before the start's terminal runs", async () => {
    const s = await starting();
    s.follow();
    const system = { entityId: s.agentId, actor: "system" } as const;
    s.store.append({ ...system, type: "agent.exited", payload: { exit: { type: "unknown" } } });
    s.store.append({ ...system, type: "agent.respawn_requested", payload: {} });
    s.readiness.ready(s.agentId, "claude_hook");
    expect(lifecycle(s.store)).toBe("starting");
  });
});
