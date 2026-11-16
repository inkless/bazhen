import { describe, expect, it } from "vitest";
import { newId, type Compatibility, type EnvironmentAdapter, type TerminalId } from "@bazhen/core";
import type { HolderProcess } from "@bazhen/host-guard";
import type { Store } from "../store/store.ts";
import { fakeEnvironment, testView, withAgent } from "../testing/fixtures.ts";
import { RestartWatch } from "./needs-restart.ts";

const HOLDER = { pid: 4243, start: 1_700_000_000 };

/**
 * An agent on a holder, the environment's read of it, set by `serve`, and a watch whose `ps` finds
 * the holder only while `alive` says so.
 */
async function onHolder() {
  let read: Compatibility = { outdated: new Map(), served: new Set() };
  const fixture = await withAgent((store) => ({
    ...fakeEnvironment(store, async (l) => ({
      runtime: {
        terminalId: l.terminalId,
        runtime: "holder",
        locator: {
          holderPid: String(HOLDER.pid),
          holderStart: String(HOLDER.start),
          generation: "0",
        },
      },
      externalRef: null,
    })),
    compatibility: async () => read,
  }));
  const terminalId = fixture.terminalId;
  const serve = (how: "outdated" | "served") => {
    read =
      how === "outdated"
        ? {
            outdated: new Map<TerminalId, readonly string[]>([[terminalId, ["2.0"]]]),
            served: new Set(),
          }
        : { outdated: new Map(), served: new Set([terminalId]) };
  };
  let alive = true;
  const watch = new RestartWatch({
    store: fixture.store,
    environment: fixture.environment,
    vouch: async (holder: HolderProcess) => (alive ? holder : null),
  });
  const view = { ...testView, restartHolder: (id: string) => watch.holderPid(id) };
  const agentOf = () => fixture.store.snapshot(view).agents.find((a) => a.id === fixture.agentId);
  return { ...fixture, serve, watch, agentOf, end: () => (alive = false) };
}

const recorded = (store: Store, terminalId: string, type = "terminal.needs_restart") =>
  store.events(0).filter((e) => e.type === type && e.entityId === terminalId);
const append = (store: Store, agentId: string, type: "agent.lost" | "agent.closing") =>
  store.append({ type, entityId: agentId, actor: "system", payload: {} });

describe("recording the terminals that need a restart", () => {
  it("records one once, however often it is seen, naming the holder it proved still runs", async () => {
    const { store, terminalId, serve, watch, agentOf } = await onHolder();
    const before = agentOf()?.needsRestart;
    serve("outdated");
    await watch.sweep();
    await watch.sweep();
    expect([before, agentOf()?.needsRestart, recorded(store, terminalId).length]).toEqual([
      null,
      { holderPid: HOLDER.pid },
      1,
    ]);
  });

  it("names no pid once the holder isn't proved to run there, and offers no attach command", async () => {
    const { serve, watch, agentOf, end } = await onHolder();
    serve("outdated");
    end();
    await watch.sweep();
    expect([agentOf()?.needsRestart, agentOf()?.attachCommand]).toEqual([
      { holderPid: null },
      null,
    ]);
  });

  it("clears it once a build that serves the terminal in full reads it", async () => {
    const { store, terminalId, serve, watch, agentOf } = await onHolder();
    serve("outdated");
    await watch.sweep();
    serve("served");
    await watch.sweep();
    await watch.sweep();
    expect([
      agentOf()?.needsRestart,
      recorded(store, terminalId, "terminal.restart_cleared").length,
    ]).toEqual([null, 1]);
  });

  it("shows nothing for a terminal lost or closed since, whose pid may be anyone's by now", async () => {
    const lost = await onHolder();
    lost.serve("outdated");
    await lost.watch.sweep();
    append(lost.store, lost.agentId, "agent.lost");
    const closed = await onHolder();
    closed.serve("outdated");
    await closed.watch.sweep();
    append(closed.store, closed.agentId, "agent.closing");
    closed.store.append({
      type: "agent.closed",
      entityId: closed.agentId,
      actor: "user",
      payload: {},
    });
    expect([lost.agentOf()?.needsRestart, closed.agentOf()?.needsRestart]).toEqual([null, null]);
  });

  it("keeps it through a respawn in the same holder", async () => {
    const { store, agentId, serve, watch, agentOf } = await onHolder();
    serve("outdated");
    await watch.sweep();
    store.append({
      type: "agent.exited",
      entityId: agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    store.append({
      type: "agent.respawn_requested",
      entityId: agentId,
      actor: "user",
      payload: {},
    });
    store.append({
      type: "agent.respawned",
      entityId: agentId,
      actor: "system",
      payload: {
        externalRef: null,
        runtimeRef: {
          runtime: "holder",
          locator: { holderPid: String(HOLDER.pid), holderStart: String(HOLDER.start) },
        },
      },
    });
    expect(agentOf()?.needsRestart).toEqual({ holderPid: HOLDER.pid });
  });

  it("starts a relaunched agent's new terminal without it", async () => {
    const { store, agentId, serve, watch, agentOf } = await onHolder();
    serve("outdated");
    await watch.sweep();
    append(store, agentId, "agent.lost");
    store.append({
      type: "agent.relaunch_requested",
      entityId: agentId,
      actor: "user",
      payload: { terminalId: newId("term"), generation: 1, fresh: true, runtime: "holder" },
    });
    expect(agentOf()?.needsRestart).toBeNull();
  });

  it("records nothing for a terminal that has ended, or where the environment can't tell", async () => {
    const ended = await onHolder();
    ended.serve("outdated");
    append(ended.store, ended.agentId, "agent.lost");
    await ended.watch.sweep();
    const plain = await onHolder();
    const environment: EnvironmentAdapter = fakeEnvironment(plain.store);
    await new RestartWatch({ store: plain.store, environment }).sweep();
    expect([
      recorded(ended.store, ended.terminalId),
      recorded(plain.store, plain.terminalId),
    ]).toEqual([[], []]);
  });
});
