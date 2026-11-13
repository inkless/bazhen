import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isId, type AgentRefs, type EnvironmentAdapter, type HarnessAdapter } from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import type { Store } from "../store/store.ts";
import { claudeAgent, fakeEnvironment, testView, withAgent } from "../testing/fixtures.ts";
import { launchAgent, localEnvironmentId } from "./launch.ts";
import { Lifecycle } from "./lifecycle.ts";
import { AgentQueue } from "./queue.ts";
import { ServerWatch } from "./server-watch.ts";

const claude: HarnessAdapter = {
  id: "claude-code",
  themes: ["light", "dark"],
  launchSpec: async () => ({ argv: ["claude"], env: {}, externalRef: null }),
  resumeSpec: async () => ({ argv: ["claude", "--resume"], env: {}, externalRef: null }),
};

const local = (store: Store, runtime: FakeRuntime) =>
  new LocalEnvironment({
    id: localEnvironmentId(store),
    runtime,
    harnesses: [claude],
    socket: "/s",
  });

const append = (store: Store, agentId: string, type: "agent.closing" | "agent.exited") =>
  store.append({
    entityId: agentId,
    actor: "system",
    ...(type === "agent.exited"
      ? { type, payload: { exit: { type: "exited", code: 0 } } }
      : { type, payload: {} }),
  });

const stateOf = (store: Store, agentId: string) =>
  store.snapshot(testView).agents.find((a) => a.id === agentId)?.state;

const launch = (store: Store, environment: EnvironmentAdapter, queue: AgentQueue, key: string) =>
  launchAgent(
    { store, environment, size: { cols: 80, rows: 24 }, home: tmpdir(), queue },
    { idempotencyKey: key, harness: "claude-code", cwd: "~" },
  );

/** The agent a launch has recorded and not yet settled. */
const startingAgent = (store: Store) =>
  store.snapshot(testView).agents.find((a) => a.state === "starting")?.id ?? "";

/** A launch the last daemon died in the middle of: recorded, in a queue this daemon doesn't hold. */
async function leftLaunch(store: Store) {
  const hung = { ...fakeEnvironment(store), launch: () => new Promise<never>(() => {}) };
  void launch(store, hung, new AgentQueue(), "k-left");
  await expect.poll(() => startingAgent(store)).not.toBe("");
  const agent = store.snapshot(testView).agents.find((a) => a.state === "starting");
  if (agent?.terminalId == null || !isId("agent", agent.id) || !isId("term", agent.terminalId))
    throw new Error("no launch");
  return { agentId: agent.id, terminalId: agent.terminalId };
}

/** `store`, whose first `times` reads of the agents to recover fail as a locked database does. */
function lockedFor(store: Store, times: number): Store {
  let failures = 0;
  return new Proxy(store, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key !== "recoverable" || failures >= times) return value;
      return () => {
        failures += 1;
        throw new Error("database is locked");
      };
    },
  });
}

/** A probe that fails the first time it is asked, and finds the terminal gone after. */
function failingOnce() {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) throw new Error("ps failed");
    return true;
  };
}

describe("ServerWatch", () => {
  it("marks running and exited agents lost, and finishes a closing one, once the tmux server dies under the daemon", async () => {
    const runtime = new FakeRuntime();
    const queue = new AgentQueue();
    const { store, agentId, environment } = await withAgent((s) => local(s, runtime));
    const exited = (await launch(store, environment, queue, "k-2")).agentId;
    const closing = (await launch(store, environment, queue, "k-3")).agentId;
    append(store, exited, "agent.exited");
    append(store, closing, "agent.closing");
    const watch = new ServerWatch({ store, environment, queue, log: () => {} });
    await watch.tick();
    const before = [agentId, exited, closing].map((id) => stateOf(store, id));
    runtime.killServer();
    await watch.tick();
    expect([before, [agentId, exited, closing].map((id) => stateOf(store, id))]).toEqual([
      ["running", "exited", "closing"],
      ["lost", "lost", "closed"],
    ]);
  });

  it("concludes nothing of an agent whose old server may still run it, and says so once", async () => {
    const { store, agentId } = await withAgent();
    const environment = { ...fakeEnvironment(store), gone: async () => false };
    const logged: string[] = [];
    const watch = new ServerWatch({
      store,
      environment,
      queue: new AgentQueue(),
      log: (m) => logged.push(m),
    });
    await watch.tick();
    await watch.tick();
    expect([stateOf(store, agentId), logged]).toEqual([
      "running",
      [expect.stringContaining(agentId)],
    ]);
  });

  it("leaves a launch in flight alone, though its terminal isn't there yet", async () => {
    const { store } = await withAgent();
    const queue = new AgentQueue();
    const creating = Promise.withResolvers<AgentRefs>();
    const hung = { ...fakeEnvironment(store), launch: () => creating.promise };
    const launching = launch(store, hung, queue, "k-2");
    const watch = new ServerWatch({
      store,
      environment: fakeEnvironment(store),
      queue,
      log: () => {},
    });
    await expect.poll(() => store.snapshot(testView).agents.length).toBe(2);
    const agentId = startingAgent(store);
    await watch.tick();
    const during = stateOf(store, agentId);
    creating.resolve({ runtime: null, externalRef: null });
    await launching;
    expect([during, stateOf(store, agentId)]).toEqual(["starting", "running"]);
  });

  it("settles a launch the last daemon left starting, which no command here holds", async () => {
    const { store } = await withAgent();
    const { agentId } = await leftLaunch(store);
    const watch = new ServerWatch({
      store,
      environment: fakeEnvironment(store),
      queue: new AgentQueue(),
      log: () => {},
    });
    await watch.tick();
    expect(stateOf(store, agentId)).toBe("failed");
  });

  it("settles a launch the last daemon left starting as running, once its terminal is there", async () => {
    const { store } = await withAgent();
    const { agentId, terminalId } = await leftLaunch(store);
    const ref = { terminalId, runtime: "tmux", locator: { generation: "0" } };
    const environment = fakeEnvironment(store, undefined, () => [{ agentId, ref, dead: false }]);
    await new ServerWatch({ store, environment, queue: new AgentQueue(), log: () => {} }).tick();
    expect(stateOf(store, agentId)).toBe("running");
  });

  it("leaves a respawn in flight alone, and its agent runs at the next generation", async () => {
    const { store, agentId, environment } = await claudeAgent();
    append(store, agentId, "agent.exited");
    const queue = new AgentQueue();
    const starting = Promise.withResolvers<void>();
    const slow: EnvironmentAdapter = {
      ...environment,
      respawn: async (r) => {
        await starting.promise;
        return environment.respawn(r);
      },
    };
    const respawning = new Lifecycle(store, slow, queue).respawn(agentId, {
      idempotencyKey: "r-1",
      generation: 0,
    });
    await expect.poll(() => stateOf(store, agentId)).toBe("starting");
    await new ServerWatch({ store, environment, queue, log: () => {} }).tick();
    starting.resolve();
    await respawning;
    const agent = store.snapshot(testView).agents.find((a) => a.id === agentId);
    expect([agent?.state, agent?.generation]).toEqual(["running", 1]);
  });

  it("leaves alone an agent a command settled while the check was reading the environment", async () => {
    const { store, agentId, environment } = await withAgent();
    const queue = new AgentQueue();
    const lifecycle = new Lifecycle(store, environment, queue);
    const closingMeanwhile: EnvironmentAdapter = {
      ...environment,
      inventory: async () => {
        await lifecycle.close(agentId, { idempotencyKey: "c-1", generation: 0 });
        return [];
      },
    };
    const logged: string[] = [];
    const watch = new ServerWatch({
      store,
      environment: closingMeanwhile,
      queue,
      log: (m) => logged.push(m),
    });
    await watch.tick();
    expect([stateOf(store, agentId), logged]).toEqual(["closed", []]);
  });

  it("asks an environment that isn't reachable less and less often, and says so once", async () => {
    const { store } = await withAgent();
    const asked: number[] = [];
    let now = 0;
    const environment: EnvironmentAdapter = {
      ...fakeEnvironment(store),
      health: async () => {
        asked.push(now);
        return { state: "unreachable", version: null };
      },
    };
    const logged: string[] = [];
    const watch = new ServerWatch({
      store,
      environment,
      queue: new AgentQueue(),
      intervalMs: 5_000,
      now: () => now,
      log: (m) => logged.push(m),
    });
    for (; now <= 60_000; now += 5_000) await watch.tick();
    expect([asked, logged.length]).toEqual([[0, 5_000, 15_000, 35_000], 1]);
  });

  it("concludes nothing when it can't tell whether a terminal is gone, and settles it on a later check", async () => {
    const { store, agentId } = await withAgent();
    const environment: EnvironmentAdapter = { ...fakeEnvironment(store), gone: failingOnce() };
    const logged: string[] = [];
    const watch = new ServerWatch({
      store,
      environment,
      queue: new AgentQueue(),
      log: (m) => logged.push(m),
    });
    await watch.tick();
    const first = stateOf(store, agentId);
    await watch.tick();
    expect([first, stateOf(store, agentId), logged.join()]).toEqual([
      "running",
      "lost",
      expect.stringContaining("ps failed"),
    ]);
  });

  it("keeps checking after a check the store failed, and says so once", async () => {
    const { store, agentId } = await withAgent();
    const logged: string[] = [];
    const watch = new ServerWatch({
      store: lockedFor(store, 2),
      environment: fakeEnvironment(store),
      queue: new AgentQueue(),
      log: (m) => logged.push(m),
    });
    await watch.tick();
    await watch.tick();
    await watch.tick();
    expect([stateOf(store, agentId), logged]).toEqual([
      "lost",
      [expect.stringContaining("database is locked")],
    ]);
  });

  it("reads nothing from the environment while no agent there can change", async () => {
    const { store, agentId } = await withAgent();
    append(store, agentId, "agent.closing");
    store.append({ type: "agent.closed", entityId: agentId, actor: "system", payload: {} });
    let asked = 0;
    const environment: EnvironmentAdapter = {
      ...fakeEnvironment(store),
      health: async () => {
        asked += 1;
        return { state: "reachable", version: null };
      },
    };
    await new ServerWatch({ store, environment, queue: new AgentQueue(), log: () => {} }).tick();
    expect(asked).toBe(0);
  });
});
