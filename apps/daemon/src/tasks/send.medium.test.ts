import { describe, expect, it } from "vitest";
import { newId, TaskRefused } from "@bazhen/core";
import { recordClosed } from "../agents/lifecycle.ts";
import { AgentGone } from "../mailbox/mailbox.ts";
import { UnknownAgent, type Store } from "../store/store.ts";
import { inbox, taskFleet } from "../testing/fixtures.ts";
import { MAIL_LIMIT, peerMail } from "./mail.ts";
import { MailTooLong } from "./tasks.ts";

const close = (store: Store, agentId: string) => {
  store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
  recordClosed(store, agentId, "user");
};

/** Who each queued message is from, oldest first; undefined for one no agent wrote. */
const senders = (store: Store) =>
  store
    .events(0)
    .filter((e) => e.type === "mailbox.queued")
    .map((e) => Reflect.get(Object(e.payload), "from"));

describe("Tasks send", () => {
  it("hands a peer an agent's words after a line naming the sender and how to answer it", async () => {
    const { store, tasks, lead, worker } = await taskFleet();
    tasks.send(lead, worker, { idempotencyKey: "k", body: "Is the build green?" });
    const cwd = store.agentLaunch(lead)?.launch.cwd;
    expect(inbox(store, worker)).toEqual([
      `From agent ${lead} (claude-code, ${cwd}). If it needs an answer: bazhen send ${lead} "<answer>"\n\nIs the build green?`,
    ]);
    expect(senders(store)).toEqual([lead]);
  });

  it("hands on the human's words as written, from no agent", async () => {
    const { store, tasks, worker } = await taskFleet();
    tasks.send(null, worker, { idempotencyKey: "k", body: "Is the build green?" });
    expect([inbox(store, worker), senders(store)]).toEqual([["Is the build green?"], [undefined]]);
  });

  it("refuses an agent mailing itself, a closed sender, a closed or unknown peer and an over-long text", async () => {
    const { store, tasks, coordinator, lead, worker } = await taskFleet();
    close(store, worker);
    const send =
      (from: typeof lead, to: string, body = "hi") =>
      () =>
        tasks.send(from, to, { idempotencyKey: `${from}-${to}-${body.length}`, body });
    expect(send(lead, lead)).toThrow(TaskRefused);
    expect(send(worker, lead)).toThrow(UnknownAgent);
    expect(send(lead, worker)).toThrow(AgentGone);
    expect(send(lead, newId("agent"))).toThrow(UnknownAgent);
    expect(send(lead, coordinator, "x".repeat(MAIL_LIMIT))).toThrow(MailTooLong);
    expect(senders(store)).toEqual([]);
  });

  it("takes a text that just fits the limit with its sender line", async () => {
    const { store, tasks, coordinator, lead } = await taskFleet();
    const sender = {
      id: lead,
      harness: "claude-code",
      cwd: String(store.agentLaunch(lead)?.launch.cwd),
    };
    const body = "x".repeat(MAIL_LIMIT - peerMail(sender, "").length);
    tasks.send(lead, coordinator, { idempotencyKey: "k", body });
    expect(senders(store)).toEqual([lead]);
  });

  it("answers a repeat with the first answer, even once the peer has closed", async () => {
    const { store, tasks, lead, worker } = await taskFleet();
    const req = { idempotencyKey: "k", body: "hi" };
    const first = tasks.send(lead, worker, req);
    close(store, worker);
    expect([tasks.send(lead, worker, req), senders(store)]).toEqual([first, [lead]]);
  });
});
