import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import type { Activity, SendMessageRequest } from "@bazhen/protocol";
import { AttentionClosed, Approvals } from "../mailbox/approvals.ts";
import type { Store } from "../store/store.ts";
import { withAgent, testView } from "../testing/fixtures.ts";
import { recordClosed } from "../agents/lifecycle.ts";
import { MAX_FAILURES, Mailbox } from "../mailbox/mailbox.ts";
import { AttentionRefused, Inbox } from "./inbox.ts";

const items = (store: Store) => store.snapshot(testView).attention;

const signal = (value: Activity["value"], detail?: string): Activity => ({
  value,
  source: "native",
  confidence: 1,
  observedAt: new Date().toISOString(),
  ...(detail === undefined ? {} : { detail }),
});

/** An inbox following a store with one running agent, and the mail its replies sent. */
async function inbox() {
  const { store, agentId } = await withAgent();
  const sent: { agentId: string; req: SendMessageRequest }[] = [];
  const messageId = newId("msg");
  const approvals = new Approvals(store);
  const box = new Inbox(store, approvals, (to, req) => {
    sent.push({ agentId: to, req });
    return { messageId, eventIds: [1] };
  });
  box.follow();
  return { store, agentId, box, sent, messageId, approvals };
}

function giveUp(store: Store, agentId: string, reason: "gave_up" | "agent_closed") {
  const id = newId("msg");
  store.append({
    type: "mailbox.queued",
    entityId: id,
    actor: "system",
    payload: { agentId, body: "hi" },
  });
  store.append({
    type: "mailbox.undeliverable",
    entityId: id,
    actor: "system",
    payload: { reason },
  });
  return id;
}

describe("inbox", () => {
  it("opens one item for a failed turn, carrying the failure, and closes it when a turn starts", async () => {
    const { store, agentId, box } = await inbox();
    box.turnFailed(agentId, "overloaded");
    box.turnFailed(agentId, "rate limited");
    const open = items(store).map((a) => [a.kind, a.state, a.summary]);
    box.turnStarted(agentId);
    expect([open, items(store).map((a) => a.closeReason)]).toEqual([
      [["failed", "open", "overloaded"]],
      ["superseded"],
    ]);
  });

  it("keeps a failed turn's item across a daemon restart and the unknown it records", async () => {
    const { store, agentId, box, approvals } = await inbox();
    box.turnFailed(agentId, null);
    approvals.closeAbandoned();
    store.recordActivity(agentId, signal("unknown"));
    expect(items(store)).toMatchObject([
      { kind: "failed", state: "open", summary: "A turn failed" },
    ]);
  });

  it("opens an item for mail it gave up on, naming the message, but none for mail of a closed agent", async () => {
    const { store, agentId } = await inbox();
    const messageId = giveUp(store, agentId, "gave_up");
    giveUp(store, agentId, "agent_closed");
    expect(items(store)).toMatchObject([{ kind: "undeliverable", messageId, state: "open" }]);
  });

  it("opens an item when the mailbox gives a message up after the agent's side fails it", async () => {
    const { store, agentId } = await inbox();
    const mailbox = new Mailbox(store);
    const { messageId } = mailbox.send(agentId, { idempotencyKey: "m", body: "hello" });
    for (let attempt = 1; attempt <= MAX_FAILURES; attempt++) {
      mailbox.ack((await mailbox.wait(agentId, new AbortController().signal)).offered);
      mailbox.promptStarted(agentId, `Message for you from Bazhen (${messageId}):`, `p-${attempt}`);
      mailbox.turnFailed(agentId, `p-${attempt}`);
    }
    expect(items(store)).toMatchObject([{ kind: "undeliverable", messageId, state: "open" }]);
  });

  it("sends an undelivered message's text again as a new message, closing the item as resent", async () => {
    const { store, agentId, box, sent } = await inbox();
    giveUp(store, agentId, "gave_up");
    const item = items(store)[0];
    const offered = store.openAttention().map((i) => box.actions(i))[0];
    box.resend(String(item?.id), { idempotencyKey: "again" });
    expect([offered, sent.map((s) => s.req.body), items(store)[0]?.closeReason]).toEqual([
      ["reply", "resend", "dismiss"],
      ["hi"],
      "resent",
    ]);
  });

  it("sends a reply to the agent as mail and closes the item as replied, once per key", async () => {
    const { store, agentId, box, sent, messageId } = await inbox();
    const id = box.raise({ agentId, kind: "escalation", summary: "Which branch?", taskId: "t1" });
    const req = { idempotencyKey: "k", body: "main" };
    const first = box.reply(id, req);
    const again = box.reply(id, req);
    expect([first.messageId, again, sent.map((s) => [s.agentId, s.req.body])]).toEqual([
      messageId,
      first,
      [[agentId, "main"]],
    ]);
    expect(items(store)).toMatchObject([
      { kind: "escalation", taskId: "t1", state: "closed", closeReason: "replied" },
    ]);
  });

  it("refuses a reply to an item that already closed", async () => {
    const { agentId, box } = await inbox();
    const id = box.raise({ agentId, kind: "task_done", summary: "Done" });
    box.dismiss(id, { idempotencyKey: "d" });
    expect(() => box.reply(id, { idempotencyKey: "r", body: "x" })).toThrow(AttentionClosed);
  });

  it("refuses to dismiss an approval its harness is waiting on", async () => {
    const { store, agentId, box, approvals } = await inbox();
    void approvals.request(agentId, "Bash", "Bash", new AbortController().signal);
    const id = String(items(store)[0]?.id);
    expect(() => box.dismiss(id, { idempotencyKey: "d" })).toThrow(AttentionRefused);
  });

  it("offers allow and deny only while the hook waits, and keeps raised items across a restart", async () => {
    const { store, agentId, box, approvals } = await inbox();
    void approvals.request(agentId, "Bash", "Bash", new AbortController().signal);
    box.raise({ agentId, kind: "escalation", summary: "Help" });
    const offered = () => store.openAttention().map((i) => box.actions(i));
    const before = offered();
    approvals.closeAbandoned();
    expect([before, offered()]).toEqual([
      [
        ["allow", "deny"],
        ["reply", "dismiss"],
      ],
      [["reply", "dismiss"]],
    ]);
  });

  it("keeps what an agent raised open across its turns, which settle only its requests", async () => {
    const { store, agentId, box, approvals } = await inbox();
    box.raise({ agentId, kind: "escalation", summary: "Help" });
    approvals.turnEnded(agentId);
    approvals.toolSettled(agentId, "t-1");
    expect(items(store).map((a) => a.state)).toEqual(["open"]);
  });

  it("keeps what an agent raised for the human open after the agent closes", async () => {
    const { store, agentId, box } = await inbox();
    box.raise({ agentId, kind: "escalation", summary: "Help" });
    box.raise({ agentId, kind: "task_done", summary: "Done" });
    store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
    recordClosed(store, agentId, "user");
    expect(items(store)).toMatchObject([{ state: "open" }, { state: "open" }]);
  });
});
