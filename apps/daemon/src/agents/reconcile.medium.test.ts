import { describe, expect, it } from "vitest";
import { fakeEnvironment, withAgent } from "../testing/fixtures.ts";
import { reconcile } from "./reconcile.ts";

const stateOf = (store: Awaited<ReturnType<typeof withAgent>>["store"]) =>
  store.snapshot().agents[0]?.state;

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

  it("concludes nothing from an environment it can't read", async () => {
    const { store } = await withAgent();
    const unreadable = {
      ...fakeEnvironment(store),
      health: async () => ({ state: "unreachable" as const, version: null }),
    };
    await reconcile(store, unreadable);
    expect(stateOf(store)).toBe("running");
  });
});
