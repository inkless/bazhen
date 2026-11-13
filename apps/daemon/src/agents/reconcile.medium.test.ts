import { describe, expect, it } from "vitest";
import type { HarnessAdapter, RuntimeRef } from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import { Mailbox } from "../mailbox/mailbox.ts";
import type { Store } from "../store/store.ts";
import { fakeEnvironment, testView, withAgent } from "../testing/fixtures.ts";
import { localEnvironmentId } from "./launch.ts";
import { reconcile } from "./reconcile.ts";

const stateOf = (store: Awaited<ReturnType<typeof withAgent>>["store"]) =>
  store.snapshot(testView).agents[0]?.state;

const claude: HarnessAdapter = {
  id: "claude-code",
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
