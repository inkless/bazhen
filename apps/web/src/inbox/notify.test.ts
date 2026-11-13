import { describe, expect, it } from "vitest";
import type { Attention, StateSnapshot } from "@bazhen/protocol";
import {
  freshItems,
  notificationsOn,
  notifyAccess,
  pageNotifier,
  type NotifyDeps,
} from "./notify.ts";

const open = (n: number): Attention => ({
  id: `attn_0190000000007000800000000000${String(n).padStart(4, "0")}`,
  agentId: "agent_01900000000070008000000000000000",
  state: "open",
  closeReason: null,
  summary: "Bash: curl -H 'token: s3cret'",
  kind: "approval",
  taskId: null,
  messageId: null,
  openedAt: "2026-11-12T00:00:00.000Z",
  actions: [],
});

const snapshot = (attention: Attention[]): StateSnapshot => ({
  epoch: "e",
  eventId: 1,
  environments: [],
  agents: [],
  attention,
  messages: [],
  shells: [],
  tasks: [],
  assignments: [],
});

const boom = () => {
  throw new Error("blocked");
};

/** A browser that allows notifications, with the page hidden, and what it was asked to show. */
function browser(over: Partial<NotifyDeps> = {}) {
  const shown: string[][] = [];
  const deps: NotifyDeps = {
    access: () => "granted",
    request: async () => "granted",
    stored: () => "on",
    store: () => undefined,
    hidden: () => true,
    show: (title, body) => shown.push([title, body]),
    ...over,
  };
  return { deps, shown };
}

/** Feeds a notifier the page's first snapshot, then one with a new item. */
function newItem(deps: NotifyDeps) {
  const notify = pageNotifier(deps);
  notify(snapshot([open(1)]));
  notify(snapshot([open(1), open(2)]));
}

describe("page notifications", () => {
  it("treats what was open when the page loaded as known, and only later items as news", () => {
    const first = freshItems(null, snapshot([open(1)]));
    const second = freshItems(first.open, snapshot([open(1), open(2)]));
    expect([first.fresh, second.fresh.map((i) => i.id)]).toEqual([[], [open(2).id]]);
  });

  it("names the kind and the project, never the summary, which a lock screen would show", () => {
    const { deps, shown } = browser();
    newItem(deps);
    expect(shown).toEqual([["An agent", "Approval: needs you"]]);
  });

  it("shows nothing while the page is in sight", () => {
    const { deps, shown } = browser({ hidden: () => false });
    newItem(deps);
    expect(shown).toEqual([]);
  });

  it("never throws into the page when storage or the Notification API does", () => {
    const blocked = browser({ stored: boom, access: boom }).deps;
    const noConstructor = browser({ show: boom }).deps;
    expect(() => newItem(blocked)).not.toThrow();
    expect(() => newItem(noConstructor)).not.toThrow();
    expect([notificationsOn(blocked), notifyAccess(blocked)]).toEqual([false, "unsupported"]);
  });
});
