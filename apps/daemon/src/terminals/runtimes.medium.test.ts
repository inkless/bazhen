import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, RoutedRuntime, UnsupportedOnRuntime, type HarnessAdapter } from "@bazhen/core";
import type { HarnessId } from "@bazhen/protocol";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import { launchAgent, localEnvironmentId } from "../agents/launch.ts";
import { Lifecycle } from "../agents/lifecycle.ts";
import { AgentQueue } from "../agents/queue.ts";
import { reconcile } from "../agents/reconcile.ts";
import { ServerWatch } from "../agents/server-watch.ts";
import { ShellLifecycle } from "../shells/lifecycle.ts";
import { reconcileShells } from "../shells/reconcile.ts";
import { Store } from "../store/store.ts";
import { quietStartAgain, tempDb, testView, unlimited } from "../testing/fixtures.ts";

const claude: HarnessAdapter = {
  id: "claude-code",
  themes: ["light", "dark"],
  launchSpec: async () => ({ argv: ["claude"], env: {}, externalRef: null }),
};
const codex: HarnessAdapter = { ...claude, id: "codex" };

/**
 * One daemon's store over a tmux and a holder runtime, and its environment as configured for
 * each default, so terminals can be put on either.
 */
function twoRuntimes() {
  const store = Store.open(tempDb());
  const tmux = new FakeRuntime({ kind: "tmux" });
  const holder = new FakeRuntime({ kind: "holder", attach: "snapshot" });
  const on = (defaultKind: "tmux" | "holder") =>
    new LocalEnvironment({
      id: localEnvironmentId(store),
      runtime: new RoutedRuntime({ runtimes: [tmux, holder], defaultKind, onError: () => {} }),
      harnesses: [claude, codex],
      socket: "/run/b.sock",
    });
  const queue = new AgentQueue();
  const size = { cols: 80, rows: 24 };
  const home = mkdtempSync(join(tmpdir(), "bz-home-"));
  const launch = async (kind: "tmux" | "holder", harness: HarnessId = "claude-code") =>
    (
      await launchAgent(
        { store, environment: on(kind), size, home, queue, budget: unlimited },
        { idempotencyKey: newId("att"), harness, cwd: "~" },
      )
    ).agentId;
  const shellsOn = (kind: "tmux" | "holder") =>
    new ShellLifecycle({ store, environment: on(kind), queue, budget: unlimited, size, home });
  const openShell = async (kind: "tmux" | "holder") =>
    (await shellsOn(kind).open({ idempotencyKey: newId("att") })).terminalId;
  const agentState = (agentId: string) =>
    store.snapshot(testView).agents.find((a) => a.id === agentId)?.state;
  const shellState = (terminalId: string) => store.shell(terminalId)?.state;
  const logged: string[] = [];
  const log = (m: string) => logged.push(m);
  return {
    store,
    tmux,
    holder,
    on,
    queue,
    launch,
    shellsOn,
    openShell,
    agentState,
    shellState,
    log,
    logged,
  };
}

/** A launch on `runtime` the last daemon died in the middle of, its terminal never made. */
function cutLaunch(store: Store, runtime: string) {
  const agentId = newId("agent");
  store.append({
    type: "agent.launched",
    entityId: agentId,
    actor: "user",
    payload: {
      environmentId: localEnvironmentId(store),
      harness: "claude-code",
      project: "p",
      cwd: "/w",
      terminalId: newId("term"),
      runtime,
    },
  });
  return agentId;
}

describe("reconciling each runtime by itself", () => {
  it("leaves every holder agent as it was while the holders can't be read, and concludes tmux's", async () => {
    const { store, tmux, holder, on, launch, agentState, log } = twoRuntimes();
    const onTmux = await launch("tmux");
    const onHolder = await launch("holder");
    const cut = cutLaunch(store, "holder");
    tmux.reboot();
    holder.disconnect();
    await reconcile(store, on("tmux"), log);
    expect([agentState(onTmux), agentState(onHolder), agentState(cut)]).toEqual([
      "lost",
      "running",
      "starting",
    ]);
  });

  it("concludes the holder agents while tmux can't be read, a launch cut short there included", async () => {
    const { store, tmux, holder, on, launch, agentState, log, logged } = twoRuntimes();
    const onTmux = await launch("tmux");
    const onHolder = await launch("holder");
    const cut = cutLaunch(store, "holder");
    holder.reboot();
    tmux.disconnect();
    await reconcile(store, on("tmux"), log);
    expect([agentState(onTmux), agentState(onHolder), agentState(cut)]).toEqual([
      "running",
      "lost",
      "failed",
    ]);
    expect(logged).toEqual([]);
  });

  it("leaves every holder shell as it was while the holders can't be read, and concludes tmux's", async () => {
    const { store, tmux, holder, on, shellsOn, openShell, shellState, log } = twoRuntimes();
    const onTmux = await openShell("tmux");
    const onHolder = await openShell("holder");
    tmux.reboot();
    holder.disconnect();
    await reconcileShells(store, on("tmux"), shellsOn("tmux"), log);
    expect([shellState(onTmux), shellState(onHolder)]).toEqual(["lost", "running"]);
  });

  it("concludes the holder shells while tmux can't be read", async () => {
    const { store, tmux, holder, on, shellsOn, openShell, shellState, log } = twoRuntimes();
    const onTmux = await openShell("tmux");
    const onHolder = await openShell("holder");
    holder.reboot();
    tmux.disconnect();
    await reconcileShells(store, on("tmux"), shellsOn("tmux"), log);
    expect([shellState(onTmux), shellState(onHolder)]).toEqual(["running", "lost"]);
  });

  it("goes on reading the holders while tmux, unreachable, waits out its own backoff", async () => {
    const { store, tmux, holder, on, queue, launch, agentState, log, logged } = twoRuntimes();
    const onTmux = await launch("tmux");
    const onHolder = await launch("holder");
    const watch = new ServerWatch({ store, environment: on("tmux"), queue, now: () => 0, log });
    tmux.disconnect();
    await watch.tick();
    holder.reboot();
    await watch.tick();
    expect([agentState(onTmux), agentState(onHolder)]).toEqual(["running", "lost"]);
    expect(logged.filter((m) => m.includes("tmux is unreachable"))).toHaveLength(1);
  });
});

describe("reconciling what can't be read whole", () => {
  it("concludes nothing on a runtime that reads healthy and then can't be listed", async () => {
    const { store, tmux, holder, on, launch, agentState, log } = twoRuntimes();
    const onTmux = await launch("tmux");
    const onHolder = await launch("holder");
    const cut = cutLaunch(store, "holder");
    Object.assign(holder, {
      inventory: async () => {
        throw new Error("the holders at /run/h.sock can't be read");
      },
    });
    tmux.reboot();
    await reconcile(store, on("tmux"), log);
    expect([agentState(onTmux), agentState(onHolder), agentState(cut)]).toEqual([
      "lost",
      "running",
      "starting",
    ]);
  });

  it("says once at boot which terminals are on a runtime it doesn't run, and leaves them", async () => {
    const { store, on, log, logged, agentState } = twoRuntimes();
    const elsewhere = cutLaunch(store, "screen");
    await reconcile(store, on("tmux"), log);
    expect([agentState(elsewhere), logged]).toEqual([
      "starting",
      [`reconcile: agent ${elsewhere}'s terminal is on screen, which this daemon doesn't run`],
    ]);
  });
});

describe("making a new terminal for an old one", () => {
  it("relaunches a lost tmux agent onto the holders once they are the default", async () => {
    const { store, tmux, holder, on, queue, launch, log } = twoRuntimes();
    const agentId = await launch("tmux");
    tmux.reboot();
    await reconcile(store, on("tmux"), log);
    await new Lifecycle(store, on("holder"), queue, quietStartAgain).relaunch(agentId, {
      idempotencyKey: newId("att"),
      generation: 0,
      fresh: true,
    });
    const now = store.agentTerminal({ agentId });
    expect([
      now?.state,
      now?.runtimeKind,
      now?.runtime?.runtime,
      (await holder.inventory()).length,
    ]).toEqual(["running", "holder", "holder", 1]);
  });

  it("restarts a lost tmux shell onto the holders once they are the default", async () => {
    const { store, tmux, on, shellsOn, openShell, log } = twoRuntimes();
    const lost = await openShell("tmux");
    tmux.reboot();
    await reconcileShells(store, on("tmux"), shellsOn("tmux"), log);
    const { terminalId } = await shellsOn("holder").restart(lost, {
      idempotencyKey: newId("att"),
      generation: 0,
    });
    const restarted = store.shell(terminalId);
    expect([restarted?.state, restarted?.runtimeKind, restarted?.runtime?.runtime]).toEqual([
      "running",
      "holder",
      "holder",
    ]);
  });

  it("refuses a Codex agent the holders would run, recording nothing, and starts one on tmux", async () => {
    const { store, launch, agentState } = twoRuntimes();
    await expect(launch("holder", "codex")).rejects.toBeInstanceOf(UnsupportedOnRuntime);
    const onTmux = await launch("tmux", "codex");
    expect([store.snapshot(testView).agents.length, agentState(onTmux)]).toEqual([1, "running"]);
  });

  it("refuses to relaunch a lost Codex agent onto the holders", async () => {
    const { store, tmux, on, queue, launch, log } = twoRuntimes();
    const agentId = await launch("tmux", "codex");
    tmux.reboot();
    await reconcile(store, on("tmux"), log);
    const relaunched = new Lifecycle(store, on("holder"), queue, quietStartAgain).relaunch(
      agentId,
      {
        idempotencyKey: newId("att"),
        generation: 0,
        fresh: true,
      },
    );
    await expect(relaunched).rejects.toBeInstanceOf(UnsupportedOnRuntime);
    expect(store.agentTerminal({ agentId })?.state).toBe("lost");
  });
});
