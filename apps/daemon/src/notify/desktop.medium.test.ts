import { describe, expect, it } from "vitest";
import { Inbox } from "../attention/inbox.ts";
import { Approvals } from "../mailbox/approvals.ts";
import { withAgent } from "../testing/fixtures.ts";
import { notifyOnAttention } from "./desktop.ts";
import { Presence } from "./presence.ts";

describe("notifying the host's desktop", () => {
  it("shows each item that opens while no dashboard is in sight, by kind, and none while one is", async () => {
    const { store, agentId } = await withAgent();
    const approvals = new Approvals(store);
    const inbox = new Inbox(store, approvals, () => {
      throw new Error("no mail here");
    });
    const presence = new Presence();
    const shown: string[][] = [];
    const now = { at: 1_000 };
    const before = inbox.raise({ agentId, kind: "escalation", summary: "Opened before" });
    notifyOnAttention(
      store,
      presence,
      (title, body) => shown.push([title, body]),
      () => now.at,
    );
    inbox.raise({ agentId, kind: "escalation", summary: "Which branch?" });
    await expect.poll(() => shown.length).toBe(1);
    const page = {};
    presence.report(page, true, now.at);
    inbox.raise({ agentId, kind: "task_done", summary: "Seen on the page" });
    // Commit listeners run once the mutation has returned, so the page is still in sight then.
    await new Promise((resolve) => setTimeout(resolve, 0));
    presence.gone(page);
    inbox.raise({ agentId, kind: "task_done", summary: "Done" });
    await expect.poll(() => shown.length).toBe(2);
    expect([before.startsWith("attn_"), shown.map(([, body]) => body)]).toEqual([
      true,
      ["The agent needs you", "A task is done"],
    ]);
  });
});
