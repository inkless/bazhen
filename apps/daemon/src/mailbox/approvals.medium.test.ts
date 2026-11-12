import { describe, expect, it } from "vitest";
import { readHook } from "@bazhen/harness-claude-code";
import type { Store } from "../store/store.ts";
import { IdempotencyConflict } from "../store/store.ts";
import { withAgent } from "../testing/fixtures.ts";
import { AttentionClosed, Approvals } from "./approvals.ts";

const summary = 'Bash: {"command":"touch x"}';
const live = () => new AbortController().signal;
const items = (store: Store) => store.snapshot().attention;
const call = (command: string, caller?: string) => ({
  prompt_id: "p-1",
  tool_name: "Bash",
  tool_input: { command },
  ...(caller === undefined ? {} : { agent_id: caller }),
});

const keyOf = (payload: ReturnType<typeof call>) => {
  const asked = readHook("PermissionRequest", payload);
  return asked.kind === "permission" ? asked.tool : "";
};

/** A tool call starting and asking permission, as Claude Code's hooks report it. */
function ask(approvals: Approvals, agentId: string, useId: string, payload = call("touch x")) {
  const started = readHook("PreToolUse", { ...payload, tool_use_id: useId });
  const asked = readHook("PermissionRequest", payload);
  if (started.kind !== "toolStarted" || asked.kind !== "permission") throw new Error("not a tool");
  approvals.toolStarted(agentId, started.tool, started.useId);
  return approvals.request(agentId, asked.summary, asked.tool, live());
}

describe("approvals", () => {
  it("opens an item for a tool request and answers the waiting hook with the inbox's decision", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    const waiting = ask(approvals, agentId, "t-1");
    expect(items(store)[0]).toMatchObject({ state: "open", summary });
    approvals.answer(String(items(store)[0]?.id), { idempotencyKey: "a", decision: "allow" });
    expect(JSON.parse((await waiting).stdout)).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "allow" } },
    });
    expect(items(store)[0]).toMatchObject({ state: "closed", closeReason: "answered" });
  });

  it("gives up before the harness does, leaving the decision to its own prompt", async () => {
    const { store, agentId } = await withAgent();
    const reply = await ask(new Approvals(store, 10), agentId, "t-1");
    expect([reply.stdout, items(store)[0]?.closeReason]).toEqual(["", "timed_out"]);
  });

  it("closes only the request whose tool call finished, not an identical parallel one", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    void ask(approvals, agentId, "t-1");
    void ask(approvals, agentId, "t-2");
    approvals.toolSettled(agentId, "t-2");
    expect(items(store).map((a) => a.state)).toEqual(["open", "closed"]);
  });

  it("matches identical calls started together to their requests in the order they started", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    for (const useId of ["t-1", "t-2"])
      approvals.toolStarted(agentId, keyOf(call("touch x")), useId);
    for (let i = 0; i < 2; i++)
      void approvals.request(agentId, summary, keyOf(call("touch x")), live());
    approvals.toolSettled(agentId, "t-1");
    expect(items(store).map((a) => a.state)).toEqual(["closed", "open"]);
  });

  it("leaves a request open when a different call finishes", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    void ask(approvals, agentId, "t-1");
    approvals.toolStarted(agentId, keyOf(call("touch y")), "t-2");
    approvals.toolSettled(agentId, "t-2");
    expect(items(store).map((a) => a.state)).toEqual(["open"]);
  });

  it("closes the agent's own requests when its turn ends, but not a subagent's", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    void ask(approvals, agentId, "t-1");
    void ask(approvals, agentId, "t-2", call("touch x", "sub-1"));
    approvals.turnEnded(agentId);
    expect(items(store).map((a) => a.state)).toEqual(["closed", "open"]);
  });

  it("closes a request whose hook was killed, and refuses an answer after it", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    const esc = new AbortController();
    const waiting = approvals.request(agentId, summary, keyOf(call("touch x")), esc.signal);
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
    void ask(approvals, agentId, "t-1");
    void ask(approvals, agentId, "t-2", call("touch y"));
    const [first, second] = items(store);
    approvals.answer(String(first?.id), { idempotencyKey: "k", decision: "allow" });
    expect(() =>
      approvals.answer(String(second?.id), { idempotencyKey: "k", decision: "allow" }),
    ).toThrow(IdempotencyConflict);
  });

  it("closes items left open by a daemon that stopped as stale", async () => {
    const { store, agentId } = await withAgent();
    void ask(new Approvals(store), agentId, "t-1");
    new Approvals(store).closeAbandoned();
    expect(items(store)[0]?.closeReason).toBe("stale");
  });
});
