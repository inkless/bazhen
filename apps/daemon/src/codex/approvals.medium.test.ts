import { describe, expect, it } from "vitest";
import { isId } from "@bazhen/core";
import type { Store } from "../store/store.ts";
import { withAgent, testView } from "../testing/fixtures.ts";
import { AttentionClosed, AttentionUnavailable, Approvals } from "../mailbox/approvals.ts";
import { codexApprovals } from "./approvals.ts";
import { Inbox } from "../attention/inbox.ts";

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
  const alive = { now: true };
  const codex = codexApprovals(
    approvals,
    (threadId) => (running.has(threadId) ? agentId : undefined),
    () => alive.now,
  );
  /** A request arriving on a connection, whose answers that connection collects in `on`. */
  const ask = (
    id: number,
    params: object = command,
    method = "item/commandExecution/requestApproval",
    on: unknown[] = answered,
  ) => codex.request(method, params, id, (result) => on.push(result));
  return { store, approvals, codex, ask, answered, running, alive };
}

const userInput = (questions: object[]) => ({
  threadId: "thr-1",
  turnId: "t-1",
  itemId: "call_2",
  questions,
});
const canReply = (approvals: Approvals, id: string) =>
  isId("attn", id) && approvals.canReplyText(id);
const freeText = userInput([{ id: "q1", header: "Branch", question: "Which branch?" }]);

describe("Codex questions", () => {
  it("answers a free-text question with the human's reply, closing it as replied", async () => {
    const { store, approvals, ask, answered } = await codexFor();
    ask(3, freeText, "item/tool/requestUserInput");
    const item = items(store)[0];
    approvals.replyText(String(item?.id), { idempotencyKey: "r", body: "main" });
    expect([item?.kind, item?.summary, answered, items(store)[0]?.closeReason]).toEqual([
      "question",
      "Which branch?",
      [{ answers: { q1: { answers: ["main"] } } }],
      "replied",
    ]);
  });

  it("leaves a choice or an elicitation to the TUI, and closes it when the TUI answers", async () => {
    const { store, approvals, codex, ask } = await codexFor();
    const choice = {
      id: "q1",
      header: "H",
      question: "Pick",
      options: [{ label: "a", description: "" }],
    };
    ask(4, userInput([choice]), "item/tool/requestUserInput");
    ask(
      5,
      { threadId: "thr-1", turnId: null, serverName: "gh", mode: "url", message: "Log in" },
      "mcpServer/elicitation/request",
    );
    const ids = items(store).map((i) => i.id);
    const replyable = ids.map((id) => canReply(approvals, id));
    codex.notification("serverRequest/resolved", { threadId: "thr-1", requestId: 5 });
    expect([replyable, items(store).map((i) => i.closeReason)]).toEqual([
      [false, false],
      [null, "answered_in_tui"],
    ]);
  });

  it("takes an inbox reply to a question as its answer, sending no mail", async () => {
    const { store, approvals, ask, answered } = await codexFor();
    const mail: string[] = [];
    const inbox = new Inbox(store, approvals, (_agent, req) => {
      mail.push(req.body);
      throw new Error("no mail for a question");
    });
    ask(3, freeText, "item/tool/requestUserInput");
    const item = store.openAttention()[0];
    const offered = store.openAttention().map((i) => inbox.actions(i))[0];
    const replied = inbox.reply(String(item?.id), { idempotencyKey: "r", body: "main" });
    expect([offered, replied.messageId, answered, mail]).toEqual([
      ["reply"],
      null,
      [{ answers: { q1: { answers: ["main"] } } }],
      [],
    ]);
  });

  it("finds an elicitation a resumed thread sends again under a new request id, opening no second item", async () => {
    const { store, codex, ask } = await codexFor();
    const login = {
      threadId: "thr-1",
      turnId: null,
      serverName: "gh",
      mode: "url",
      message: "Log in",
    };
    ask(5, login, "mcpServer/elicitation/request");
    codex.disconnected();
    ask(12, login, "mcpServer/elicitation/request");
    codex.resumed?.(["thr-1"]);
    expect(items(store).map((i) => i.state)).toEqual(["open"]);
  });

  it("refuses a text reply while the connection that asked is down", async () => {
    const { store, approvals, codex, ask } = await codexFor();
    ask(3, freeText, "item/tool/requestUserInput");
    codex.disconnected();
    expect(() =>
      approvals.replyText(String(items(store)[0]?.id), { idempotencyKey: "r", body: "main" }),
    ).toThrow(AttentionUnavailable);
  });
});

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
    const { store, codex, ask, running, alive } = await codexFor();
    ask(0);
    running.delete("thr-1");
    alive.now = false;
    codex.disconnected();
    expect(items(store)[0]?.closeReason).toBe("agent_closed");
  });

  it("supersedes an item whose agent has moved to another thread when the connection ends", async () => {
    const { store, codex, ask, running } = await codexFor();
    ask(0);
    running.delete("thr-1");
    codex.disconnected();
    expect(items(store)[0]?.closeReason).toBe("superseded");
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
