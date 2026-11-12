import { describe, expect, it } from "vitest";
import type { Store } from "../store/store.ts";
import { IdempotencyConflict } from "../store/store.ts";
import { withAgent } from "../testing/fixtures.ts";
import { AttentionClosed, Approvals } from "./approvals.ts";

const summary = 'Bash: {"command":"touch x"}';
const touch = JSON.stringify(["main", "Bash", { command: "touch x" }]);
const other = JSON.stringify(["main", "Bash", { command: "touch y" }]);
const subagents = JSON.stringify(["sub-1", "Bash", { command: "touch x" }]);
const live = () => new AbortController().signal;
const items = (store: Store) => store.snapshot().attention;

describe("approvals", () => {
  it("opens an item for a tool request and answers the waiting hook with the inbox's decision", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    const waiting = approvals.request(agentId, summary, touch, live());
    expect(items(store)[0]).toMatchObject({ state: "open", summary });
    approvals.answer(String(items(store)[0]?.id), { idempotencyKey: "a", decision: "allow" });
    expect(JSON.parse((await waiting).stdout)).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "allow" } },
    });
    expect(items(store)[0]).toMatchObject({ state: "closed", closeReason: "answered" });
  });

  it("gives up before the harness does, leaving the decision to its own prompt", async () => {
    const { store, agentId } = await withAgent();
    const reply = await new Approvals(store, 10).request(agentId, summary, touch, live());
    expect([reply.stdout, items(store)[0]?.closeReason]).toEqual(["", "timed_out"]);
  });

  it("closes only the request whose tool call finished, not a parallel one", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    void approvals.request(agentId, summary, touch, live());
    void approvals.request(agentId, summary, other, live());
    approvals.toolSettled(agentId, touch);
    expect(items(store).map((a) => a.state)).toEqual(["closed", "open"]);
  });

  it("closes the agent's own requests when its turn ends, but not a subagent's", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    void approvals.request(agentId, summary, touch, live());
    void approvals.request(agentId, summary, subagents, live());
    approvals.turnEnded(agentId);
    expect(items(store).map((a) => a.state)).toEqual(["closed", "open"]);
  });

  it("closes a request whose hook was killed, and refuses an answer after it", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    const esc = new AbortController();
    const waiting = approvals.request(agentId, summary, touch, esc.signal);
    esc.abort();
    await waiting;
    expect(items(store)[0]?.closeReason).toBe("answered_in_tui");
    expect(() =>
      approvals.answer(String(items(store)[0]?.id), { idempotencyKey: "late", decision: "allow" }),
    ).toThrow(AttentionClosed);
  });

  it("refuses a key reused to answer a different item", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    void approvals.request(agentId, summary, touch, live());
    void approvals.request(agentId, summary, other, live());
    const [first, second] = items(store);
    approvals.answer(String(first?.id), { idempotencyKey: "k", decision: "allow" });
    expect(() =>
      approvals.answer(String(second?.id), { idempotencyKey: "k", decision: "allow" }),
    ).toThrow(IdempotencyConflict);
  });
});
