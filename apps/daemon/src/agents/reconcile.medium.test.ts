import { describe, expect, it } from "vitest";
import { fakeEnvironment, withAgent, testView } from "../testing/fixtures.ts";
import { reconcile } from "./reconcile.ts";

const stateOf = (store: Awaited<ReturnType<typeof withAgent>>["store"]) =>
  store.snapshot(testView).agents[0]?.state;

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
