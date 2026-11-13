import { describe, expect, it } from "vitest";
import type { Store } from "../store/store.ts";
import { withAgent, testView } from "../testing/fixtures.ts";
import { AttentionClosed, AttentionUnavailable, Approvals } from "../mailbox/approvals.ts";
import { codexApprovals } from "./approvals.ts";

const items = (store: Store) => store.snapshot(testView).attention;
const command = {
  threadId: "thr-1",
  turnId: "t-1",
  itemId: "call_1",
  command: "touch x",
  reason: null,
};

/**
 * Codex's approvals for an agent on threads `thr-1` and `thr-2`, while each is in `running`, and
 * what each request was answered with.
 */
async function codexFor() {
  const { store, agentId } = await withAgent();
  const approvals = new Approvals(store);
  const answered: unknown[] = [];
  const running = new Set(["thr-1", "thr-2"]);
  const codex = codexApprovals(approvals, (threadId) =>
    running.has(threadId) ? agentId : undefined,
  );
  /** A request arriving on a connection, whose answers that connection collects in `on`. */
  const ask = (
    id: number,
    params: object = command,
    method = "item/commandExecution/requestApproval",
    on: unknown[] = answered,
  ) => codex.request(method, params, id, (result) => on.push(result));
  return { store, approvals, codex, ask, answered, running };
}

describe("Codex approvals", () => {
  it("opens an item for a request to run a command, and answers it with the inbox's decision", async () => {
    const { store, approvals, ask, answered } = await codexFor();
    ask(0);
    expect(items(store)).toEqual([
      expect.objectContaining({ state: "open", summary: "Run touch x" }),
    ]);
    approvals.answer(String(items(store)[0]?.id), { idempotencyKey: "a", decision: "allow" });
    expect([answered, items(store)[0]?.closeReason]).toEqual([
      [{ decision: "accept" }],
      "answered",
    ]);
  });

  it("closes an item answered in the TUI, and refuses the inbox's answer after it", async () => {
    const { store, approvals, codex, ask, answered } = await codexFor();
    ask(7);
    codex.notification("serverRequest/resolved", { threadId: "thr-1", requestId: 7 });
    const id = String(items(store)[0]?.id);
    expect(items(store)[0]?.closeReason).toBe("answered_in_tui");
    expect(() => approvals.answer(id, { idempotencyKey: "late", decision: "allow" })).toThrow(
      AttentionClosed,
    );
    expect(answered).toEqual([]);
  });

  it("closes as stale an item the next connection doesn't ask again, as after a restart", async () => {
    const { store, codex, ask } = await codexFor();
    ask(0);
    codex.disconnected();
    expect(items(store)[0]?.state).toBe("open");
    codex.resumed(["thr-1"]);
    expect(items(store)[0]?.closeReason).toBe("stale");
  });

  it("keeps an item whose thread couldn't be resumed: its request may still come again", async () => {
    const { store, codex, ask } = await codexFor();
    ask(0);
    codex.disconnected();
    codex.resumed([]);
    expect(items(store)[0]?.state).toBe("open");
  });

  it("closes as stale only the items not asked again, of two on the same thread", async () => {
    const { store, codex, ask } = await codexFor();
    ask(0);
    ask(1, { ...command, itemId: "call_2" });
    codex.disconnected();
    ask(5);
    codex.resumed(["thr-1"]);
    expect(items(store).map((a) => a.state)).toEqual(["open", "closed"]);
  });

  it("tells apart the same tool call id on two threads", async () => {
    const { store, codex, ask } = await codexFor();
    ask(0);
    ask(1, { ...command, threadId: "thr-2" });
    codex.disconnected();
    ask(5);
    codex.resumed(["thr-1", "thr-2"]);
    expect(items(store).map((a) => a.state)).toEqual(["open", "closed"]);
  });

  it("closes an item whose agent no longer runs when the connection ends", async () => {
    const { store, codex, ask, running } = await codexFor();
    ask(0);
    running.delete("thr-1");
    codex.disconnected();
    expect(items(store)[0]?.closeReason).toBe("agent_closed");
  });

  it("keeps the item a server still running asks again, and answers it on the new connection", async () => {
    const { store, approvals, codex, ask, answered } = await codexFor();
    ask(0);
    codex.disconnected();
    const again: unknown[] = [];
    ask(3, command, "item/commandExecution/requestApproval", again);
    codex.resumed(["thr-1"]);
    expect(items(store).map((a) => a.state)).toEqual(["open"]);
    approvals.answer(String(items(store)[0]?.id), { idempotencyKey: "a", decision: "deny" });
    expect([answered, again]).toEqual([[], [{ decision: "decline" }]]);
  });

  it("refuses an inbox answer while no connection holds the request, and records nothing", async () => {
    const { store, approvals, codex, ask, answered } = await codexFor();
    ask(0);
    codex.disconnected();
    const id = String(items(store)[0]?.id);
    expect(() => approvals.answer(id, { idempotencyKey: "a", decision: "allow" })).toThrow(
      AttentionUnavailable,
    );
    expect([items(store)[0]?.state, answered]).toEqual(["open", []]);
    const again: unknown[] = [];
    ask(3, command, "item/commandExecution/requestApproval", again);
    approvals.answer(id, { idempotencyKey: "a", decision: "allow" });
    expect(again).toEqual([{ decision: "accept" }]);
  });

  it("leaves to the TUI a request that isn't an approval, or is for a thread no agent has", async () => {
    const { store, ask, answered } = await codexFor();
    ask(0, command, "item/tool/requestUserInput");
    ask(1, { ...command, threadId: "someone-elses" });
    expect([items(store), answered]).toEqual([[], []]);
  });
});
