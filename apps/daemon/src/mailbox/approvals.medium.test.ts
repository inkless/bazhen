import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { readHook } from "@bazhen/harness-claude-code";
import { localEnvironmentId } from "../agents/launch.ts";
import type { Store } from "../store/store.ts";
import { IdempotencyConflict } from "../store/store.ts";
import { withAgent, testView } from "../testing/fixtures.ts";
import { AttentionClosed, Approvals } from "./approvals.ts";

const summary = 'Bash: {"command":"touch x"}';
const live = () => new AbortController().signal;
const items = (store: Store) => store.snapshot(testView).attention;
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

/** A question starting and asking, as Claude Code's hooks report an AskUserQuestion. */
function askQuestion(approvals: Approvals, agentId: string, useId: string, caller?: string) {
  const question = {
    prompt_id: "p-1",
    tool_name: "AskUserQuestion",
    tool_input: {},
    ...(caller === undefined ? {} : { agent_id: caller }),
  };
  const started = readHook("PreToolUse", { ...question, tool_use_id: useId });
  const asked = readHook("PermissionRequest", question);
  if (started.kind !== "toolStarted" || asked.kind !== "question") throw new Error("no question");
  approvals.toolStarted(agentId, started.tool, started.useId);
  approvals.question(agentId, asked.summary, asked.tool);
}

describe("approvals", () => {
  it("closes the agent's question when a prompt with a new id ends its turn, not one that joins it", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    askQuestion(approvals, agentId, "q-1");
    approvals.promptStarted(agentId, "p-1");
    const joined = items(store)[0]?.state;
    approvals.promptStarted(agentId, "p-2");
    expect([joined, items(store)[0]?.closeReason]).toEqual(["open", "answered_in_tui"]);
  });

  it("closes a subagent's question when that subagent stops, and no other's", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    askQuestion(approvals, agentId, "q-1", "sub-1");
    askQuestion(approvals, agentId, "q-2", "sub-2");
    approvals.subagentStopped(agentId, "sub-1");
    expect(items(store).map((i) => i.state)).toEqual(["closed", "open"]);
  });

  it("shows a question the TUI takes, with nothing to answer it, until its tool call ends", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    askQuestion(approvals, agentId, "q-1");
    const open = items(store)[0];
    approvals.toolSettled(agentId, "q-1");
    expect([open?.kind, open?.actions, items(store)[0]?.closeReason]).toEqual([
      "question",
      [],
      "answered_in_tui",
    ]);
  });

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

  it("supersedes an agent's open requests when its process is replaced, not its other items or another agent's", async () => {
    const { store, agentId } = await withAgent();
    const other = newId("agent");
    store.append({
      type: "agent.launched",
      entityId: other,
      actor: "system",
      payload: {
        environmentId: localEnvironmentId(store),
        harness: "claude-code",
        project: "q",
        cwd: "/q",
        terminalId: null,
      },
    });
    const approvals = new Approvals(store);
    const waiting = ask(approvals, agentId, "t-1");
    void ask(approvals, other, "t-2");
    // A failed turn is the agent's to look at, not a request the dead process held.
    store.append({
      type: "attention.opened",
      entityId: newId("attn"),
      actor: "system",
      payload: {
        agentId,
        summary: "turn failed",
        kind: "failed",
        toolUseId: null,
        mainAgent: true,
      },
    });
    approvals.supersede(agentId);
    const [replaced, kept, failure] = items(store);
    expect([(await waiting).stdout, replaced?.closeReason, kept?.state, failure?.state]).toEqual([
      "",
      "superseded",
      "open",
      "open",
    ]);
    expect(() =>
      approvals.answer(String(replaced?.id), { idempotencyKey: "late", decision: "allow" }),
    ).toThrow(AttentionClosed);
  });
});
