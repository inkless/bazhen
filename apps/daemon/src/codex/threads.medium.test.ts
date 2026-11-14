import { describe, expect, it } from "vitest";
import type { RuntimeRef } from "@bazhen/core";
import { FIXTURE_TMUX_SOCKET, withCodexAgents } from "../testing/fixtures.ts";
import { CodexThreads, UNTRACKED } from "./threads.ts";

const A = "01a1ce15-39c0-7183-b5b6-f6f2f0000001";
const B = "01a1ce15-6f85-7482-9722-6f4f70000002";
const C = "01a1ce15-9d28-7111-8222-933330000003";
/** A title read that fails, as for a pane tmux no longer has. */
const GONE = "<gone>";
/** Shares its first 29 characters with B. */
const B2 = "01a1ce15-6f85-7482-9722-6f4f79999999";
/** As the TUI titles its pane: the first 29 characters and `...`. */
const shown = (id: string) => `${id.slice(0, 29)}...`;

const started = (id: string, extra: object = {}) => ({ thread: { id, ...extra } });

/**
 * Agent on thread A in pane %0, whose title reads as `titles`, one per read and then the last,
 * and a server whose `thread/list` answers `listed`.
 */
async function setup(opts: {
  titles: string[];
  listed?: unknown[];
  unsaved?: number;
  /** Threads other agents are bound to, in panes %1 on. */
  others?: string[];
  giveUpMs?: number;
}) {
  let unsaved = opts.unsaved ?? 0;
  const { store, agentOn } = await withCodexAgents(A, ...(opts.others ?? []));
  const released: string[] = [];
  const agentId = agentOn(A);
  const resumed: string[] = [];
  const lists: unknown[] = [];
  const titles = [...opts.titles];
  const titled: RuntimeRef[] = [];
  const logged: string[] = [];
  const threads = new CodexThreads({
    store,
    runtime: {
      socket: FIXTURE_TMUX_SOCKET,
      paneTitle: async (ref) => {
        titled.push(ref);
        const title = (titles.length > 1 ? titles.shift() : titles[0]) ?? "";
        if (title === GONE) throw new Error("can't find pane: %0");
        return title;
      },
    },
    channel: {
      request: async (method, params) => {
        lists.push([method, params]);
        return { data: opts.listed ?? [] };
      },
      resume: async (threadId) => {
        resumed.push(threadId);
        if (unsaved-- > 0) throw new Error(`no rollout found for thread id ${threadId}`);
      },
    },
    log: (message) => logged.push(message),
    retryMs: 5,
    released: (id) => released.push(id),
    ...(opts.giveUpMs === undefined ? {} : { giveUpMs: opts.giveUpMs }),
  });
  const announce = (id: string, extra: object = {}) =>
    threads.listener.notification?.("thread/started", started(id, extra));
  const boundTo = () => store.codexThread(agentId);
  const untracked = () => store.latestActivity(agentId)?.detail === UNTRACKED;
  const held = () => threads.held(agentId);
  return {
    store,
    agentId,
    threads,
    announce,
    boundTo,
    untracked,
    resumed,
    lists,
    titled,
    logged,
    released,
    held,
    agentOn,
  };
}

describe("Codex thread switches", () => {
  it("moves the agent to the one thread its title names, subscribing to it first", async () => {
    const s = await setup({ titles: [shown(B)] });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.resumed, s.lists, s.untracked()]).toEqual([B, [B], [], false]);
    expect(s.titled[0]?.locator).toMatchObject({ paneId: "%0", socket: FIXTURE_TMUX_SOCKET });
  });

  it("finds a thread from before Bazhen connected in the server's thread list", async () => {
    const s = await setup({ titles: [shown(B)], listed: [{ id: A }, { id: B }] });
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.resumed]).toEqual([B, [B]]);
  });

  it("leaves the agent on its thread when no thread matches", async () => {
    const s = await setup({ titles: [shown(B)], listed: [{ id: A }] });
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.resumed, s.untracked()]).toEqual([A, [], true]);
  });

  it("moves the agent once the thread its title named first is announced", async () => {
    const s = await setup({ titles: [shown(B)] });
    await s.threads.paneTitleChanged("%0");
    expect(s.boundTo()).toBe(A);
    s.announce(B);
    await expect.poll(s.boundTo).toBe(B);
    expect(s.resumed).toEqual([B]);
  });

  it("moves the agent once a thread /new started can be resumed, after its first prompt", async () => {
    const s = await setup({ titles: [shown(B)], unsaved: 2 });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    expect(s.boundTo()).toBe(A);
    await expect.poll(s.boundTo).toBe(B);
    expect(s.resumed).toEqual([B, B, B]);
  });

  it("stops resuming a thread the title no longer names, and reads the title no more", async () => {
    const s = await setup({ titles: [shown(B), shown(A)], unsaved: 1 });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    await s.threads.paneTitleChanged("%0");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([s.boundTo(), s.resumed, s.titled.length]).toEqual([A, [B], 2]);
  });

  it("holds the agent's mail while it waits to move, and lets it go once it has", async () => {
    const s = await setup({ titles: [shown(B)], unsaved: 1 });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    expect([s.held(), s.released]).toEqual([true, []]);
    await expect.poll(s.boundTo).toBe(B);
    expect([s.held(), s.released]).toEqual([false, [s.agentId]]);
  });

  it("lets held mail go when the title goes back to the agent's thread", async () => {
    const s = await setup({ titles: [shown(B), shown(A)], unsaved: 9 });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, false, [s.agentId]]);
  });

  it("tries a waiting move again when reading the title fails", async () => {
    const s = await setup({ titles: [shown(B), GONE, shown(B)], unsaved: 1 });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    await expect.poll(s.boundTo).toBe(B);
    expect([s.held(), s.released]).toEqual([false, [s.agentId]]);
  });

  it("lets held mail go when reading the title keeps failing past the give-up time", async () => {
    const s = await setup({ titles: [shown(B), GONE], unsaved: 1, giveUpMs: 20 });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    await expect.poll(s.held).toBe(false);
    expect([s.boundTo(), s.released, s.untracked()]).toEqual([A, [s.agentId], true]);
  });

  it("holds every agent's mail at start until its title has been read", async () => {
    const s = await setup({ titles: [shown(A)] });
    s.threads.followAll();
    expect(s.held()).toBe(true);
    await expect.poll(s.held).toBe(false);
    expect([s.boundTo(), s.released]).toEqual([A, [s.agentId]]);
  });

  it("gives up on a thread that can't be resumed in time, and says so", async () => {
    const s = await setup({ titles: [shown(B)], unsaved: 99, giveUpMs: 20 });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    await expect.poll(s.untracked).toBe(true);
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, false, [s.agentId]]);
  });

  it("never moves an agent onto a thread another running agent is bound to", async () => {
    const s = await setup({ titles: [shown(B)], others: [B] });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.resumed, s.untracked()]).toEqual([A, [], true]);
    expect(s.store.codexAgent(B)).toBe(s.agentOn(B));
  });

  it("says switches are followed again once a move takes", async () => {
    const s = await setup({ titles: ["not a thread", shown(B)] });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    expect(s.untracked()).toBe(true);
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.untracked()]).toEqual([B, false]);
  });

  it("reads every running Codex agent's title, as after a daemon restart", async () => {
    const s = await setup({ titles: [shown(B)], others: [C] });
    s.announce(B);
    s.threads.followAll();
    await expect.poll(s.boundTo).toBe(B);
    expect(new Set(s.titled.map((ref) => ref.locator["paneId"]))).toEqual(new Set(["%0", "%1"]));
  });

  it("leaves the agent on its thread when several threads match", async () => {
    const s = await setup({ titles: [shown(B)] });
    s.announce(B);
    s.announce(B2);
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.resumed, s.untracked()]).toEqual([A, [], true]);
  });

  it("never matches a title thread, which Codex makes to write a thread's name", async () => {
    const s = await setup({ titles: [shown(B)] });
    s.announce(B, { ephemeral: true, threadSource: "thread_title" });
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.untracked()]).toEqual([A, true]);
  });

  it("leaves the agent on its thread when its title is no thread id, and names the title", async () => {
    const s = await setup({ titles: ["my project · codex"] });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.lists, s.untracked()]).toEqual([A, [], true]);
    expect(s.logged.join("\n")).toContain('"my project · codex"');
  });

  it("ignores the empty title the TUI leaves as it exits, blank or not", async () => {
    const s = await setup({ titles: ["", " "] });
    await s.threads.paneTitleChanged("%0");
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.lists, s.untracked(), s.logged]).toEqual([A, [], false, []]);
  });

  it("lets held mail go when the TUI exits while the agent waits to move", async () => {
    const s = await setup({ titles: [shown(B), ""], unsaved: 9 });
    s.announce(B);
    await s.threads.paneTitleChanged("%0");
    expect(s.held()).toBe(true);
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.held(), s.released, s.untracked()]).toEqual([
      A,
      false,
      [s.agentId],
      false,
    ]);
  });

  it("says switches are followed again once the title is back on the agent's thread", async () => {
    const s = await setup({ titles: [shown(B), shown(A)], listed: [{ id: A }] });
    await s.threads.paneTitleChanged("%0");
    expect(s.untracked()).toBe(true);
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.untracked()]).toEqual([A, false]);
  });

  it("does nothing for a title still naming its thread, as after /compact", async () => {
    const s = await setup({ titles: [shown(A)] });
    await s.threads.paneTitleChanged("%0");
    expect([s.boundTo(), s.resumed, s.lists, s.untracked()]).toEqual([A, [], [], false]);
  });

  it("ignores a pane no running Codex agent is in", async () => {
    const s = await setup({ titles: [shown(B)] });
    s.announce(B);
    await s.threads.paneTitleChanged("%7");
    expect([s.boundTo(), s.titled]).toEqual([A, []]);
  });

  it("follows titles in the order they changed", async () => {
    const s = await setup({ titles: [shown(B), shown(A)] });
    s.announce(A);
    s.announce(B);
    await Promise.all([s.threads.paneTitleChanged("%0"), s.threads.paneTitleChanged("%0")]);
    expect([s.boundTo(), s.resumed]).toEqual([A, [B, A]]);
  });
});

describe("the agent on a Codex thread", () => {
  it("is no agent when two are on it, so nothing meant for one reaches the other", async () => {
    const { store, agentOn } = await withCodexAgents(A, B);
    const [one, two] = [agentOn(A), agentOn(B)];
    const environmentId = String(store.agentEnvironment(two));
    store.append({
      type: "agent.external_ref_updated",
      entityId: two,
      actor: "system",
      payload: { externalRef: { environmentId, kind: "codex-thread", id: A } },
    });
    expect([
      store.codexAgent(A),
      store.codexAgentsOn(A).toSorted((x, y) => x.localeCompare(y)),
    ]).toEqual([undefined, [one, two].toSorted((x, y) => x.localeCompare(y))]);
  });
});
