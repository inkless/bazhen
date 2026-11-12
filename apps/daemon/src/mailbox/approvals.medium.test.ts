import { describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { withAgent } from "../testing/fixtures.ts";
import { AttentionClosed, Approvals } from "./approvals.ts";

const bash = 'Bash: {"command":"touch x"}';
const item = (store: Store) => store.snapshot().attention[0];

describe("approvals", () => {
  it("opens an item for a tool request and answers the waiting hook with the inbox's decision", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    const waiting = approvals.request(agentId, bash);
    expect(item(store)).toMatchObject({ state: "open", summary: 'Bash: {"command":"touch x"}' });
    approvals.answer(String(item(store)?.id), { idempotencyKey: "a", decision: "allow" });
    expect(JSON.parse((await waiting).stdout)).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "allow" } },
    });
    expect(item(store)).toMatchObject({ state: "closed", closeReason: "answered" });
  });

  it("gives up before the harness does, leaving the decision to its own prompt", async () => {
    const { store, agentId } = await withAgent();
    const reply = await new Approvals(store, 10).request(agentId, bash);
    expect([reply.stdout, item(store)?.closeReason]).toEqual(["", "timed_out"]);
  });

  it("refuses an answer once the request was answered in the TUI", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    const waiting = approvals.request(agentId, bash);
    approvals.settled(agentId);
    await waiting;
    expect(item(store)?.closeReason).toBe("answered_in_tui");
    expect(() =>
      approvals.answer(String(item(store)?.id), { idempotencyKey: "late", decision: "allow" }),
    ).toThrow(AttentionClosed);
  });

  it("closes items left open by a daemon that stopped as stale", async () => {
    const { store, agentId } = await withAgent();
    void new Approvals(store).request(agentId, bash);
    new Approvals(store).closeAbandoned();
    expect(item(store)?.closeReason).toBe("stale");
  });
});
