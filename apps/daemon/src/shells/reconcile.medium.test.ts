import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import { localEnvironmentId } from "../agents/launch.ts";
import { AgentQueue } from "../agents/queue.ts";
import { Store } from "../store/store.ts";
import { tempDb } from "../testing/fixtures.ts";
import { ShellLifecycle } from "./lifecycle.ts";
import { reconcileShells } from "./reconcile.ts";

/** A daemon's shells on a fake runtime, and what a restarted daemon's reconcile makes of them. */
function setup() {
  const store = Store.open(tempDb());
  const runtime = new FakeRuntime();
  const environment = new LocalEnvironment({
    id: localEnvironmentId(store),
    runtime,
    harnesses: [],
    socket: "/run/b.sock",
  });
  const home = mkdtempSync(join(tmpdir(), "bz-home-"));
  const shells = new ShellLifecycle({
    store,
    environment,
    queue: new AgentQueue(),
    size: { cols: 80, rows: 24 },
    home,
  });
  const logged: string[] = [];
  const restart = () => reconcileShells(store, environment, shells, (m) => logged.push(m));
  const open = async () => (await shells.open({ idempotencyKey: newId("att") })).terminalId;
  const stateOf = (terminalId: string) => store.shell(terminalId)?.state;
  const refOf = (terminalId: string) => {
    const ref = store.shell(terminalId)?.runtime;
    if (ref == null) throw new Error("no terminal");
    return ref;
  };
  return { store, runtime, environment, shells, restart, open, stateOf, refOf, logged };
}

describe("reconciling shells after a restart", () => {
  it("marks a shell lost once its server is gone, and lets it be dismissed with nothing to end", async () => {
    const { runtime, shells, restart, open, stateOf } = setup();
    const terminalId = await open();
    runtime.reboot();
    await restart();
    expect(stateOf(terminalId)).toBe("lost");
    await shells.close(terminalId, { idempotencyKey: "dismiss", generation: 0 });
    expect(stateOf(terminalId)).toBe("closed");
  });

  it("closes a shell whose shell exited while the daemon was down, rather than calling it lost", async () => {
    const { runtime, restart, open, stateOf, refOf } = setup();
    const terminalId = await open();
    runtime.exitProcess(refOf(terminalId));
    await restart();
    expect(stateOf(terminalId)).toBe("closed");
    expect((await runtime.inventory()).map((e) => e.ref.terminalId)).not.toContain(terminalId);
  });

  it("leaves a running shell running", async () => {
    const { restart, open, stateOf } = setup();
    const terminalId = await open();
    await restart();
    expect(stateOf(terminalId)).toBe("running");
  });

  it("settles a shell the daemon died opening by whether its session appeared", async () => {
    const { store, runtime, environment, restart, stateOf } = setup();
    const opened = (terminalId: string) =>
      store.append({
        type: "terminal.opened",
        entityId: terminalId,
        actor: "user",
        payload: { environmentId: environment.id, cwd: "/", linkedAgentId: null },
      });
    const appeared = newId("term");
    const never = newId("term");
    opened(appeared);
    opened(never);
    await environment.openShell({ terminalId: appeared, cwd: "/", size: { cols: 80, rows: 24 } });
    await restart();
    expect([stateOf(appeared), stateOf(never)]).toEqual(["running", "failed"]);
    expect(store.shell(appeared)?.runtime?.terminalId).toBe(appeared);
    expect(await runtime.inventory()).toHaveLength(1);
  });

  it("finishes the close of a shell left closing once its server is gone", async () => {
    const { store, runtime, restart, open, stateOf } = setup();
    const terminalId = await open();
    store.append({ type: "terminal.closing", entityId: terminalId, actor: "user", payload: {} });
    runtime.reboot();
    await restart();
    expect(stateOf(terminalId)).toBe("closed");
  });

  it("closes a shell the daemon died opening whose shell then exited", async () => {
    const { store, runtime, environment, restart, stateOf } = setup();
    const terminalId = newId("term");
    store.append({
      type: "terminal.opened",
      entityId: terminalId,
      actor: "user",
      payload: { environmentId: environment.id, cwd: "/", linkedAgentId: null },
    });
    const ref = await environment.openShell({ terminalId, cwd: "/", size: { cols: 80, rows: 24 } });
    runtime.exitProcess(ref);
    await restart();
    expect(stateOf(terminalId)).toBe("closed");
    expect(await runtime.inventory()).toEqual([]);
  });

  it("drops the agent tag from a kept shell's session that still carries it", async () => {
    const { store, runtime, environment, restart, stateOf } = setup();
    const terminalId = newId("term");
    const linkedAgentId = newId("agent");
    store.append({
      type: "terminal.opened",
      entityId: terminalId,
      actor: "user",
      payload: { environmentId: environment.id, cwd: "/", linkedAgentId: null },
    });
    const size = { cols: 80, rows: 24 };
    const ref = await environment.openShell({ terminalId, cwd: "/", size, linkedAgentId });
    store.append({
      type: "terminal.running",
      entityId: terminalId,
      actor: "system",
      payload: { runtimeRef: { runtime: ref.runtime, locator: ref.locator } },
    });
    await restart();
    const tags = (await runtime.inventory()).find((e) => e.ref.terminalId === terminalId)?.tags;
    expect([stateOf(terminalId), tags]).toEqual(["running", { kind: "shell" }]);
  });

  it("concludes nothing while the runtime can't be read", async () => {
    const { runtime, restart, open, stateOf } = setup();
    const terminalId = await open();
    runtime.disconnect();
    await restart();
    expect(stateOf(terminalId)).toBe("running");
  });
});
