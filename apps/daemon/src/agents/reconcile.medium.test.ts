import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import {
  isId,
  LaunchFailed,
  type EnvironmentAdapter,
  type HarnessAdapter,
  type RuntimeRef,
} from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import { Mailbox } from "../mailbox/mailbox.ts";
import type { Store } from "../store/store.ts";
import { fakeEnvironment, testView, withAgent } from "../testing/fixtures.ts";
import { launchAgent, localEnvironmentId } from "./launch.ts";
import { AgentQueue } from "./queue.ts";
import { reconcile } from "./reconcile.ts";

const stateOf = (store: Awaited<ReturnType<typeof withAgent>>["store"]) =>
  store.snapshot(testView).agents[0]?.state;

const claude: HarnessAdapter = {
  id: "claude-code",
  themes: ["light", "dark"],
  launchSpec: async () => ({ argv: ["claude"], env: {}, externalRef: null }),
};

/** The daemon's local environment, on `runtime`. */
const local = (store: Store, runtime: FakeRuntime) =>
  new LocalEnvironment({
    id: localEnvironmentId(store),
    runtime,
    harnesses: [claude],
    socket: "/run/b.sock",
  });

const closing = (store: Store, agentId: string) =>
  store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
const exited = (store: Store, agentId: string) =>
  store.append({
    type: "agent.exited",
    entityId: agentId,
    actor: "system",
    payload: { exit: { type: "exited", code: 0 } },
  });

/**
 * A launch the daemon died in the middle of: recorded and keyed as `launch-cut`, with the
 * environment never answering. Retrying the key replays it.
 */
async function launchCut(store: Store) {
  const deps = (environment: EnvironmentAdapter) => ({
    store,
    environment,
    size: { cols: 80, rows: 24 },
    home: tmpdir(),
    queue: new AgentQueue(),
  });
  const req = { idempotencyKey: "launch-cut", harness: "claude-code", cwd: "~" } as const;
  const hung = { ...fakeEnvironment(store), launch: () => new Promise<never>(() => {}) };
  void launchAgent(deps(hung), req);
  // The launch is recorded once it holds its agent's slot, a moment after it is asked for.
  await expect
    .poll(() => store.snapshot(testView).agents.some((a) => a.state === "starting"))
    .toBe(true);
  const agent = store.snapshot(testView).agents.find((a) => a.state === "starting");
  if (agent?.terminalId == null || !isId("term", agent.terminalId) || !isId("agent", agent.id))
    throw new Error("no launch");
  const retry = () => launchAgent(deps(fakeEnvironment(store)), req);
  return { agentId: agent.id, terminalId: agent.terminalId, retry };
}

/** An agent the daemon died respawning: exited at generation 0, then a respawn asked for. */
async function midRespawn() {
  const fixture = await withAgent();
  exited(fixture.store, fixture.agentId);
  fixture.store.append({
    type: "agent.respawn_requested",
    entityId: fixture.agentId,
    actor: "user",
    payload: {},
  });
  return fixture;
}

const atGeneration = (terminalId: RuntimeRef["terminalId"], generation: string): RuntimeRef => ({
  terminalId,
  runtime: "tmux",
  locator: { generation },
});

const agentOf = (store: Store) => store.snapshot(testView).agents[0];
const lastReason = (
  store: Store,
  agentId: string,
  type: "agent.failed" | "agent.respawn_rejected",
) =>
  store
    .events(0)
    .filter((e) => e.entityId === agentId && e.type === type)
    .map((e) => e.payload);

/** An environment that can't show any terminal it lacks is gone, as with an old server unsure. */
const unproven = (s: Store) => ({ ...fakeEnvironment(s), gone: async () => false });

describe("reconcile", () => {
  it("leaves an agent the environment still runs as it was", async () => {
    const { store, agentId, terminalId } = await withAgent();
    const ref = { terminalId, runtime: "tmux", locator: {} };
    await reconcile(
      store,
      fakeEnvironment(store, undefined, () => [{ agentId, ref, dead: false }]),
    );
    expect(stateOf(store)).toBe("running");
  });

  it("marks an agent lost when a reachable environment no longer has it", async () => {
    const { store } = await withAgent();
    await reconcile(store, fakeEnvironment(store));
    expect(stateOf(store)).toBe("lost");
  });

  // The daemon restarted after its tmux server died: the new runtime finds no server at all.
  it("marks a running agent lost once its environment's tmux server is gone", async () => {
    const { store } = await withAgent((s) => local(s, new FakeRuntime()));
    await reconcile(store, local(store, new FakeRuntime()));
    expect(stateOf(store)).toBe("lost");
  });

  it("asks the environment's health about the refs its agents recorded", async () => {
    const { store, terminalId } = await withAgent();
    const asked: (readonly RuntimeRef[] | undefined)[] = [];
    const env = fakeEnvironment(store);
    await reconcile(store, {
      ...env,
      health: async (known) => {
        asked.push(known);
        return { state: "unreachable", version: null };
      },
    });
    expect(asked).toEqual([[{ terminalId, runtime: "tmux", locator: {} }]]);
  });

  it("marks an exited agent lost when a reachable environment no longer has it", async () => {
    const { store, agentId } = await withAgent();
    exited(store, agentId);
    await reconcile(store, fakeEnvironment(store));
    expect(stateOf(store)).toBe("lost");
  });

  it("closes an agent left closing once the environment no longer has it, giving up its mail", async () => {
    const { store, agentId, terminalId } = await withAgent();
    const { messageId } = new Mailbox(store).send(agentId, { idempotencyKey: "m", body: "hi" });
    closing(store, agentId);
    const ref = { terminalId, runtime: "tmux", locator: {} };
    await reconcile(
      store,
      fakeEnvironment(store, undefined, () => [{ agentId, ref, dead: false }]),
    );
    const kept = stateOf(store);
    await reconcile(store, fakeEnvironment(store));
    const mail = store.snapshot(testView).messages.find((m) => m.id === messageId)?.state;
    expect([kept, stateOf(store), mail]).toEqual(["closing", "closed", "undeliverable"]);
  });

  it("settles an agent the daemon died launching as running, on the harness session its terminal carries", async () => {
    const { store } = await withAgent();
    const { agentId, terminalId, retry } = await launchCut(store);
    const externalRef = {
      environmentId: localEnvironmentId(store),
      kind: "claude-session",
      id: "s-9",
    } as const;
    const ref = atGeneration(terminalId, "0");
    const entry = { agentId, ref, dead: false, externalRef };
    await reconcile(
      store,
      fakeEnvironment(store, undefined, () => [entry]),
    );
    const settled = store.snapshot(testView).agents.find((a) => a.id === agentId);
    const again = await retry();
    expect([settled?.state, settled?.externalRef, again.agentId]).toEqual([
      "running",
      externalRef,
      agentId,
    ]);
  });

  it("settles an agent the daemon died launching as failed when no session carries it, and its key says so", async () => {
    const { store } = await withAgent();
    const { agentId, retry } = await launchCut(store);
    await reconcile(store, fakeEnvironment(store));
    const state = store.snapshot(testView).agents.find((a) => a.id === agentId)?.state;
    const replayed = await retry().catch((e: unknown) => e);
    expect([
      state,
      lastReason(store, agentId, "agent.failed"),
      replayed instanceof LaunchFailed,
    ]).toEqual(["failed", [{ reason: "daemon_restart" }], true]);
  });

  it("settles an agent the daemon died respawning as respawned, once its pane runs the next generation", async () => {
    const { store, agentId, terminalId } = await midRespawn();
    const ref = atGeneration(terminalId, "1");
    await reconcile(
      store,
      fakeEnvironment(store, undefined, () => [{ agentId, ref, dead: false }]),
    );
    expect([agentOf(store)?.state, agentOf(store)?.generation]).toEqual(["running", 1]);
  });

  it("settles an agent the daemon died respawning as exited, when its pane is still the old one", async () => {
    const { store, agentId, terminalId } = await midRespawn();
    const ref = atGeneration(terminalId, "0");
    await reconcile(
      store,
      fakeEnvironment(store, undefined, () => [{ agentId, ref, dead: true }]),
    );
    expect([
      agentOf(store)?.state,
      agentOf(store)?.generation,
      lastReason(store, agentId, "agent.respawn_rejected"),
    ]).toEqual(["exited", 0, [{ reason: "daemon_restart" }]]);
  });

  it("settles an agent the daemon died respawning as lost, when its terminal is gone", async () => {
    const { store } = await midRespawn();
    await reconcile(store, fakeEnvironment(store));
    expect(agentOf(store)?.state).toBe("lost");
  });

  it("concludes nothing of an agent whose old server may still run its terminal", async () => {
    const { store, agentId } = await withAgent();
    const second = await withAgent();
    closing(second.store, second.agentId);
    const logged: string[] = [];
    await reconcile(store, unproven(store), (m) => logged.push(m));
    await reconcile(second.store, unproven(second.store), () => {});
    expect([stateOf(store), stateOf(second.store), logged.join()]).toEqual([
      "running",
      "closing",
      expect.stringContaining(agentId),
    ]);
  });

  it.each(["unknown", "unreachable"] as const)(
    "concludes nothing from an environment whose health is %s",
    async (state) => {
      const { store } = await withAgent();
      const unread = { ...fakeEnvironment(store), health: async () => ({ state, version: null }) };
      await reconcile(store, unread);
      expect(stateOf(store)).toBe("running");
    },
  );

  it("concludes nothing, and says so, when reading the environment fails", async () => {
    const { store } = await withAgent();
    const failing = fakeEnvironment(store, undefined, () => {
      throw new Error("tmux went away");
    });
    const logged: string[] = [];
    await reconcile(store, failing, (m) => logged.push(m));
    expect([stateOf(store), logged.join()]).toEqual([
      "running",
      expect.stringContaining("tmux went away"),
    ]);
  });
});
