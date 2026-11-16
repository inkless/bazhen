import { describe, expect, it } from "vitest";
import { newId, type EnvironmentAdapter, type TerminalId } from "@bazhen/core";
import type { Store } from "../store/store.ts";
import { fakeEnvironment, testView, withAgent } from "../testing/fixtures.ts";
import { recordOutdated } from "./needs-restart.ts";

const HOLDER_PID = 4243;

/** An agent on a holder that answers only on `protocol`, and the environment that says so. */
async function onOldHolder(protocol: readonly string[] = ["2.0"]) {
  let outdated = new Map<TerminalId, readonly string[]>();
  const fixture = await withAgent((store) => ({
    ...fakeEnvironment(store, async (l) => ({
      runtime: {
        terminalId: l.terminalId,
        runtime: "holder",
        locator: { holderPid: String(HOLDER_PID), generation: "0" },
      },
      externalRef: null,
    })),
    outdated: async () => outdated,
  }));
  outdated = new Map([[fixture.terminalId, protocol]]);
  return fixture;
}

const needsRestart = (store: Store, agentId: string) =>
  store.snapshot(testView).agents.find((a) => a.id === agentId)?.needsRestart;
const recorded = (store: Store, terminalId: string) =>
  store.events(0).filter((e) => e.type === "terminal.needs_restart" && e.entityId === terminalId);
const append = (store: Store, agentId: string, type: "agent.lost" | "agent.closing") =>
  store.append({ type, entityId: agentId, actor: "system", payload: {} });

describe("recording the terminals that need a restart", () => {
  it("records one once, however often it is seen, with the holder to end", async () => {
    const { store, agentId, terminalId, environment } = await onOldHolder();
    const before = needsRestart(store, agentId);
    await recordOutdated(store, environment);
    await recordOutdated(store, environment);
    expect([before, needsRestart(store, agentId), recorded(store, terminalId).length]).toEqual([
      null,
      { holderPid: HOLDER_PID },
      1,
    ]);
  });

  it("keeps it through a respawn in the same holder", async () => {
    const { store, agentId, environment } = await onOldHolder();
    await recordOutdated(store, environment);
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
        runtimeRef: { runtime: "holder", locator: { holderPid: String(HOLDER_PID) } },
      },
    });
    expect(needsRestart(store, agentId)).toEqual({ holderPid: HOLDER_PID });
  });

  it("starts a relaunched agent's new terminal without it", async () => {
    const { store, agentId, environment } = await onOldHolder();
    await recordOutdated(store, environment);
    append(store, agentId, "agent.lost");
    store.append({
      type: "agent.relaunch_requested",
      entityId: agentId,
      actor: "user",
      payload: { terminalId: newId("term"), generation: 1, fresh: true, runtime: "holder" },
    });
    expect(needsRestart(store, agentId)).toBeNull();
  });

  it("records nothing for a terminal that has ended", async () => {
    const { store, agentId, terminalId, environment } = await onOldHolder();
    append(store, agentId, "agent.lost");
    await recordOutdated(store, environment);
    expect(recorded(store, terminalId)).toEqual([]);
  });

  it("records nothing where the environment can't tell", async () => {
    const { store, terminalId } = await onOldHolder();
    const plain: EnvironmentAdapter = fakeEnvironment(store);
    await recordOutdated(store, plain);
    expect(recorded(store, terminalId)).toEqual([]);
  });
});
