import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isId } from "@bazhen/core";
import type { SentMessage } from "@bazhen/harness-claude-code";
import { launchAgent } from "../agents/launch.ts";
import { renameAgent } from "../agents/names.ts";
import { AgentQueue } from "../agents/queue.ts";
import type { Store } from "../store/store.ts";
import { fakeEnvironment, testView, unlimited, withAgent } from "../testing/fixtures.ts";
import { observeSend } from "./observed.ts";

let launches = 0;

/** Another running Claude Code agent, started under `name`. */
async function peer(store: Store, name: string) {
  const deps = {
    store,
    environment: fakeEnvironment(store),
    size: { cols: 80, rows: 24 },
    home: tmpdir(),
    queue: new AgentQueue(),
    budget: unlimited,
  };
  const { agentId } = await launchAgent(deps, {
    idempotencyKey: `launch-${++launches}`,
    harness: "claude-code",
    cwd: "~",
    name,
  });
  if (!isId("agent", agentId)) throw new Error("launched no agent");
  return agentId;
}

const sent = (to: string, more: Partial<SentMessage> = {}): SentMessage => ({
  to,
  text: "Rebased; tests pass.",
  summary: null,
  accepted: true,
  ...more,
});

const observed = (store: Store) =>
  store.snapshot(testView).observed.map(({ from, to, summary, accepted }) => ({
    from,
    to,
    summary,
    accepted,
  }));

describe("messages agents send each other outside Bazhen's mail", () => {
  it("records a send to the agent whose session the name reaches, ignoring case", async () => {
    const { store, agentId } = await withAgent();
    const to = await peer(store, "BZ-127");
    observeSend(store, agentId, "t-1", sent("bz-127", { summary: "Status" }));
    observeSend(
      store,
      agentId,
      "t-2",
      sent("BZ-127", { text: "first line\nsecond", accepted: false }),
    );
    expect(observed(store)).toEqual([
      { from: agentId, to, summary: "Status", accepted: true },
      { from: agentId, to, summary: "first line", accepted: false },
    ]);
  });

  it("keeps the text in the log and gives clients only a summary of at most 120 characters", async () => {
    const { store, agentId } = await withAgent();
    await peer(store, "BZ-127");
    observeSend(store, agentId, "t-1", sent("BZ-127", { text: "x".repeat(500) }));
    const [shown] = store.snapshot(testView).observed;
    const [logged] = store.events(0).filter((e) => e.type === "message.observed");
    expect([shown?.summary.length, Reflect.get(Object(logged?.payload), "text")]).toEqual([
      120,
      "x".repeat(500),
    ]);
  });

  it("matches the name a session was started with, which a rename doesn't change", async () => {
    const { store, agentId } = await withAgent();
    const to = await peer(store, "BZ-127");
    renameAgent(store, null, to, { idempotencyKey: "n", name: "reviewer" });
    observeSend(store, agentId, "t-1", sent("reviewer", { summary: "by its new name" }));
    observeSend(store, agentId, "t-2", sent("BZ-127", { summary: "by its started name" }));
    expect(observed(store).map((m) => [m.to, m.summary])).toEqual([[to, "by its started name"]]);
  });

  it("records nothing when two sessions answer to the name, or none does", async () => {
    const { store, agentId } = await withAgent();
    const first = await peer(store, "BZ-127");
    renameAgent(store, null, first, { idempotencyKey: "n", name: "reviewer" });
    await peer(store, "BZ-127");
    observeSend(store, agentId, "t-1", sent("BZ-127"));
    observeSend(store, agentId, "t-2", sent("someone-else"));
    expect(observed(store)).toEqual([]);
  });

  it("records a send to the sender's own name as nothing, and one tool call once", async () => {
    const { store, agentId } = await withAgent();
    await peer(store, "BZ-127");
    const own = store.snapshot(testView).agents.find((a) => a.id === agentId)?.name;
    observeSend(store, agentId, "t-1", sent(String(own)));
    observeSend(store, agentId, "t-2", sent("BZ-127"));
    observeSend(store, agentId, "t-2", sent("BZ-127"));
    expect(observed(store)).toHaveLength(1);
  });
});
