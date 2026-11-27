import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { newId, type RuntimeRef, type TerminalId } from "@bazhen/core";
import { holderSocket, holdersDir } from "@bazhen/host-guard";
import { HolderRuntime } from "@bazhen/runtime-holder";
import { listenFakeHolder } from "@bazhen/runtime-holder/testing";
import {
  bindLegacy,
  FIXTURE_TMUX_SOCKET,
  testView,
  withCodexAgents,
  withCodexAgentsOn,
  withStartingCodexAgentsOn,
} from "../testing/fixtures.ts";
import { localEnvironmentId } from "../agents/launch.ts";
import { Readiness } from "../agents/readiness.ts";
import { ThreadHeld } from "../store/store.ts";
import { CodexThreads, MAIL_HELD, UNTRACKED } from "./threads.ts";

const A = "01a1ce15-39c0-7183-b5b6-f6f2f0000001";
const B = "01a1ce15-6f85-7482-9722-6f4f70000002";
const C = "01a1ce15-9d28-7111-8222-933330000003";
const D = "01a1ce15-c3a4-7333-8444-944440000004";
const E = "01a1ce15-d5b6-7555-8666-955550000005";
const F = "01a1ce15-e7c8-7777-8888-966660000006";
/** A title read that fails, as for a pane tmux no longer has. */
const GONE = "<gone>";
/** Shares its first 29 characters with B. */
const B2 = "01a1ce15-6f85-7482-9722-6f4f79999999";
/** As the TUI titles its pane: the first 29 characters and `...`. */
const shown = (id: string) => `${id.slice(0, 29)}...`;

const started = (id: string, extra: object = {}) => ({ thread: { id, ...extra } });

/**
 * Agent on thread A in pane %0, whose title reads as `titles`, one per read and then the last,
 * and a server whose `thread/list` answers `listed`, as it is at each list, or `pages`, one per
 * cursor.
 */
async function setup(opts: {
  titles: string[];
  listed?: unknown[];
  pages?: unknown[][];
  retryMs?: number;
  unsaved?: number;
  /** Threads other agents are bound to, in panes %1 on. */
  others?: string[];
  giveUpMs?: number;
  /** Where the agents' terminals run: tmux's panes by default. */
  runtime?: "tmux" | "holder";
  /** What `thread/list` waits on before it answers, as a server slow to answer. */
  listing?: Promise<unknown>;
  /** Letting held mail go throws, as a mailbox failing would. */
  releaseFails?: boolean;
  /** Its agents still starting, their TUIs not yet up. */
  starting?: boolean;
  /** Runs while a title is first read, before the read answers. */
  reading?: () => void;
  /** Runs while a thread is first resumed, before the resume answers. */
  resuming?: () => void;
}) {
  let unsaved = opts.unsaved ?? 0;
  let { reading, resuming } = opts;
  const runtime = opts.runtime ?? "tmux";
  const agents = opts.starting === true ? withStartingCodexAgentsOn : withCodexAgentsOn;
  const { store, agentOn } = await agents(runtime, A, ...(opts.others ?? []));
  const readiness = new Readiness({
    store,
    environmentId: localEnvironmentId(store),
    deadlineMs: 60_000,
    notStarted: () => {},
  });
  const released: string[] = [];
  const agentId = agentOn(A);
  const resumed: string[] = [];
  const lists: [method: string, params: unknown][] = [];
  const titles = [...opts.titles];
  const titled: RuntimeRef[] = [];
  const logged: string[] = [];
  const threads = new CodexThreads({
    store,
    runtime: {
      title: async (ref) => {
        titled.push(ref);
        reading?.();
        reading = undefined;
        const title = (titles.length > 1 ? titles.shift() : titles[0]) ?? "";
        if (title === GONE) throw new Error("can't find pane: %0");
        return title;
      },
    },
    channel: {
      request: async (method, params) => {
        lists.push([method, params]);
        await opts.listing;
        if (opts.pages === undefined) return { data: opts.listed ?? [] };
        const at = Number(Object(params).cursor ?? 0);
        const more = at + 1 < opts.pages.length;
        return { data: opts.pages[at] ?? [], nextCursor: more ? String(at + 1) : null };
      },
      resume: async (threadId) => {
        resumed.push(threadId);
        resuming?.();
        resuming = undefined;
        if (unsaved-- > 0) throw new Error(`no rollout found for thread id ${threadId}`);
      },
    },
    log: (message) => logged.push(message),
    retryMs: opts.retryMs ?? 5,
    released: (id) => {
      released.push(id);
      if (opts.releaseFails === true) throw new Error("the mailbox is unavailable");
    },
    ready: (id) => readiness.ready(id, "codex_title"),
    ...(opts.giveUpMs === undefined ? {} : { giveUpMs: opts.giveUpMs }),
  });
  const terminal =
    runtime === "tmux"
      ? store.codexTerminalInPane(FIXTURE_TMUX_SOCKET, "%0")
      : store.codexTerminals().find((t) => store.codexAgentIn(t)?.agentId === agentId);
  if (terminal === undefined) throw new Error("no terminal for the agent on A");
  const announce = (id: string, extra: object = {}) =>
    threads.listener.notification?.("thread/started", started(id, extra));
  const boundTo = () => store.codexThread(agentId);
  const detail = () => store.latestActivity(agentId)?.detail;
  const untracked = () => detail() === UNTRACKED;
  const held = () => threads.held(agentId);
  const lifecycle = () => store.snapshot(testView).agents.find((a) => a.id === agentId)?.state;
  return {
    store,
    agentId,
    terminal,
    threads,
    announce,
    boundTo,
    untracked,
    detail,
    resumed,
    lists,
    titled,
    titles,
    logged,
    released,
    held,
    lifecycle,
    agentOn,
  };
}

/**
 * The agent's TUI killed and a respawn asked for in the same terminal, whose runtime drops the
 * last TUI's title; the returned function records the respawn.
 */
function respawn(s: Awaited<ReturnType<typeof setup>>) {
  const system = { entityId: s.agentId, actor: "system" } as const;
  s.store.append({ ...system, type: "agent.exited", payload: { exit: { type: "unknown" } } });
  s.store.append({ ...system, type: "agent.respawn_requested", payload: {} });
  const ref = s.store.agentTerminal({ agentId: s.agentId })?.runtime;
  const externalRef = s.store.agentLaunch(s.agentId)?.externalRef ?? null;
  return () =>
    s.store.append({
      ...system,
      type: "agent.respawned",
      payload: {
        externalRef,
        runtimeRef: { runtime: ref?.runtime ?? "tmux", locator: { ...ref?.locator } },
      },
    });
}

/** Above every system's pid limit, so nothing a holder runtime does can reach a process. */
const FAKE_PID = 2 ** 22 + 1;

/** The most a pid can be here: Linux says; macOS's is fixed, and it has no /proc. */
function pidLimit(): number {
  try {
    return Number(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());
  } catch {
    return 99_999;
  }
}

/**
 * A holder runtime over one fake holder of `terminal`, as `agentId`'s, whose `hello` carries
 * `title`: what its title watch reports goes to `report`.
 */
async function holderReporting(
  terminal: TerminalId,
  agentId: string,
  title: string,
  report: (...told: [TerminalId]) => void,
) {
  const limit = pidLimit();
  if (!(FAKE_PID > limit)) throw new Error(`the fake holder's pid isn't above the limit ${limit}`);
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    throw new Error(`a test reached process.kill(${pid})`);
  });
  const root = mkdtempSync("/tmp/bz-th-");
  chmodSync(root, 0o700);
  mkdirSync(holdersDir(root), { mode: 0o700 });
  const start = 1_700_000_000;
  const server = await listenFakeHolder(holderSocket(root, terminal), {
    hello: {
      terminalId: terminal,
      tags: { kind: "agent", agentId },
      holderPid: FAKE_PID,
      holderStart: start,
      childPid: FAKE_PID,
      childStart: start,
      title,
    },
  });
  const runtime = new HolderRuntime({
    root,
    binary: "/nonexistent/bazhen-holder",
    env: { PATH: "/bin" },
    titleSyncMs: 60_000,
    onError: () => {},
  });
  const stop = runtime.onTitle(report);
  onTestFinished(async () => {
    stop();
    await server.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
}

describe("a Codex agent's TUI coming up", () => {
  it("takes a change heard before a respawn is recorded as its TUI up, once it is", async () => {
    const s = await setup({ titles: [shown(A)] });
    const recorded = respawn(s);
    await s.threads.heard(s.terminal);
    const early = s.lifecycle();
    recorded();
    await s.threads.titleChanged(s.terminal);
    expect([early, s.lifecycle()]).toEqual(["starting", "running"]);
  });

  it("runs a starting agent once its title names its thread, and not on a title naming none", async () => {
    const s = await setup({ titles: ["codex", shown(A)], starting: true });
    await s.threads.titleChanged(s.terminal);
    const before = s.lifecycle();
    await s.threads.titleChanged(s.terminal);
    expect([before, s.lifecycle()]).toEqual(["starting", "running"]);
  });

  it("never takes the title the last TUI's holder reported before a respawn for the new TUI's", async () => {
    const { promise: listing, resolve: answer } = Promise.withResolvers<unknown>();
    const s = await setup({ titles: [shown(C)], runtime: "holder", listing });
    void s.threads.heard(s.terminal);
    await expect.poll(() => s.lists.length).toBe(1);
    s.titles.splice(0, 1, shown(A));
    const reported: TerminalId[] = [];
    // Everything the watch reports goes on, so a title it told would be acted on.
    await holderReporting(s.terminal, s.agentId, shown(A), (...told) => {
      reported.push(told[0]);
      void s.threads.heard(...told);
    });
    await expect.poll(() => reported).toEqual([s.terminal]);
    respawn(s)();
    s.titles.splice(0, 1, "");
    answer(undefined);
    await s.threads.titleChanged(s.terminal);
    expect(s.lifecycle()).toBe("starting");
  });

  it.each(["tmux", "holder"] as const)(
    "never takes a title read as a respawn commits for the new TUI's, but takes the new TUI's, on %s",
    async (runtime) => {
      const s: Awaited<ReturnType<typeof setup>> = await setup({
        titles: [shown(A)],
        runtime,
        reading: () => respawn(s)(),
      });
      await s.threads.heard(s.terminal);
      const dropped = s.lifecycle();
      await s.threads.titleChanged(s.terminal);
      expect([dropped, s.lifecycle()]).toEqual(["starting", "running"]);
    },
  );

  it.each([
    ["no thread", shown(C), []],
    ["several threads", shown(B), [{ id: B }, { id: B2 }]],
  ])(
    "neither holds the mail of, nor says it keeps its thread for, an agent respawned while the threads are listed for a title naming %s",
    async (_, title, listed) => {
      const { promise: listing, resolve: answer } = Promise.withResolvers<unknown>();
      const s = await setup({ titles: [title], runtime: "holder", listing, listed });
      const followed = s.threads.heard(s.terminal);
      await expect.poll(() => s.lists.length).toBe(1);
      respawn(s)();
      answer(undefined);
      await followed;
      expect([s.held(), s.untracked()]).toEqual([false, false]);
    },
  );

  it.each(["tmux", "holder"] as const)(
    "neither moves nor readies an agent respawned while its move's thread resumes, but readies it on the new TUI's title, on %s",
    async (runtime) => {
      const s: Awaited<ReturnType<typeof setup>> = await setup({
        titles: [shown(B)],
        runtime,
        resuming: () => respawn(s)(),
      });
      s.announce(B);
      await s.threads.heard(s.terminal);
      const dropped = [s.lifecycle(), s.boundTo()];
      s.titles.splice(0, 1, shown(A));
      await s.threads.titleChanged(s.terminal);
      expect([dropped, [s.lifecycle(), s.boundTo()]]).toEqual([
        ["starting", A],
        ["running", A],
      ]);
    },
  );
});

describe("Codex thread switches", () => {
  it("moves the agent to the one thread its title names, subscribing to it first", async () => {
    const s = await setup({ titles: [shown(B)] });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.resumed, s.lists, s.untracked()]).toEqual([B, [B], [], false]);
    expect(s.titled[0]?.locator).toMatchObject({ paneId: "%0", socket: FIXTURE_TMUX_SOCKET });
  });

  it("finds a thread from before Bazhen connected in the server's thread list", async () => {
    const s = await setup({ titles: [shown(B)], listed: [{ id: A }, { id: B }] });
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.resumed]).toEqual([B, [B]]);
  });

  it("holds the agent's mail while its title names a thread not yet listed, and moves once it is", async () => {
    const listed = [{ id: A }];
    const s = await setup({ titles: [shown(B)], listed });
    await s.threads.titleChanged(s.terminal);
    await expect.poll(() => s.lists.length).toBeGreaterThan(1);
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, true, []]);
    listed.push({ id: B });
    await expect.poll(s.boundTo).toBe(B);
    expect([s.resumed, s.held(), s.released, s.untracked()]).toEqual([
      [B],
      false,
      [s.agentId],
      false,
    ]);
  });

  it("finds a thread the TUI resumed from far back, past the thread list's first page", async () => {
    const s = await setup({ titles: [shown(B)], pages: [[{ id: A }], [{ id: C }], [{ id: B }]] });
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.resumed, s.lists.length]).toEqual([B, [B], 3]);
  });

  it("reads only the thread list's first page again while it waits", async () => {
    const s = await setup({ titles: [shown(B)], pages: [[{ id: A }], [{ id: C }]] });
    await s.threads.titleChanged(s.terminal);
    await expect.poll(() => s.lists.length).toBeGreaterThan(4);
    expect(s.lists.filter(([, params]) => Object(params).cursor !== undefined)).toHaveLength(1);
  });

  it("holds no mail again for a title it gave up on, told again, and moves once its thread is listed", async () => {
    const listed = [{ id: A }];
    const s = await setup({ titles: [shown(B)], listed, giveUpMs: 20 });
    await s.threads.titleChanged(s.terminal);
    await expect.poll(s.untracked).toBe(true);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, false, [s.agentId]]);
    listed.push({ id: B });
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.untracked()]).toEqual([B, false]);
  });

  it("holds no mail again for a title told again after a thread it found could not be resumed in time", async () => {
    const s = await setup({ titles: [shown(B)], unsaved: 99, giveUpMs: 20 });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    await expect.poll(s.untracked).toBe(true);
    const tries = s.resumed.length;
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.held(), s.released, s.resumed.length]).toEqual([
      A,
      false,
      [s.agentId],
      tries + 1,
    ]);
  });

  it("holds mail while a title it gave up on can't be read, and none once it reads it again", async () => {
    const s = await setup({ titles: [shown(B)], listed: [{ id: A }], giveUpMs: 20 });
    const waits = () => s.logged.filter((line) => line.includes("waits to move")).length;
    await s.threads.titleChanged(s.terminal);
    await expect.poll(s.untracked).toBe(true);
    s.titles.splice(0, s.titles.length, GONE, shown(B));
    await s.threads.titleChanged(s.terminal);
    expect(s.held()).toBe(true);
    await expect.poll(s.held).toBe(false);
    expect([s.boundTo(), s.released, waits(), s.untracked()]).toEqual([
      A,
      [s.agentId, s.agentId],
      1,
      true,
    ]);
  });

  it("lets mail go at give-up, and moves the agent once the thread its title names is announced", async () => {
    const s = await setup({ titles: [shown(B)], listed: [{ id: A }], giveUpMs: 20 });
    await s.threads.titleChanged(s.terminal);
    await expect.poll(s.untracked).toBe(true);
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, false, [s.agentId]]);
    s.announce(B);
    await expect.poll(s.boundTo).toBe(B);
  });

  it("drops a waiting move, and lets its mail go, once nothing will start in its terminal", async () => {
    const s = await setup({ titles: [shown(B)], listed: [{ id: A }] });
    await s.threads.titleChanged(s.terminal);
    expect(s.held()).toBe(true);
    s.threads.left(s.terminal);
    await expect.poll(s.held).toBe(false);
    const lists = s.lists.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([s.boundTo(), s.released, s.lists.length]).toEqual([A, [s.agentId], lists]);
  });

  it("follows the next title though letting a left terminal's mail go throws", async () => {
    const s = await setup({ titles: [shown(B)], listed: [{ id: A }], releaseFails: true });
    await s.threads.titleChanged(s.terminal);
    s.threads.left(s.terminal);
    const read = s.titled.length;
    await s.threads.titleChanged(s.terminal);
    expect([s.released, s.titled.length]).toEqual([[s.agentId], read + 1]);
  });

  it("leaves the agent on its thread when no thread is listed in time, and says so", async () => {
    const s = await setup({ titles: [shown(B)], listed: [{ id: A }], giveUpMs: 20 });
    await s.threads.titleChanged(s.terminal);
    expect(s.held()).toBe(true);
    await expect.poll(s.untracked).toBe(true);
    expect([s.boundTo(), s.resumed, s.held(), s.released]).toEqual([A, [], false, [s.agentId]]);
    expect(s.logged.at(-1)).toContain(`no thread matches ${shown(B).slice(0, 29)}`);
  });

  it("moves the agent once the thread its title named first is announced", async () => {
    const s = await setup({ titles: [shown(B)], retryMs: 60_000 });
    await s.threads.titleChanged(s.terminal);
    expect(s.boundTo()).toBe(A);
    s.announce(B);
    await expect.poll(s.boundTo).toBe(B);
    expect(s.resumed).toEqual([B]);
  });

  it("moves the agent once a thread /new started can be resumed, after its first prompt", async () => {
    const s = await setup({ titles: [shown(B)], unsaved: 2 });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect(s.boundTo()).toBe(A);
    await expect.poll(s.boundTo).toBe(B);
    expect(s.resumed).toEqual([B, B, B]);
  });

  it("stops resuming a thread the title no longer names, and reads the title no more", async () => {
    const s = await setup({ titles: [shown(B), shown(A)], unsaved: 1 });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    await s.threads.titleChanged(s.terminal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([s.boundTo(), s.resumed, s.titled.length]).toEqual([A, [B], 2]);
  });

  it("holds the agent's mail while it waits to move, and lets it go once it has", async () => {
    const s = await setup({ titles: [shown(B)], unsaved: 1 });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect([s.held(), s.released]).toEqual([true, []]);
    await expect.poll(s.boundTo).toBe(B);
    expect([s.held(), s.released]).toEqual([false, [s.agentId]]);
  });

  it("lets held mail go when the title goes back to the agent's thread", async () => {
    const s = await setup({ titles: [shown(B), shown(A)], unsaved: 9 });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, false, [s.agentId]]);
  });

  it("tries a waiting move again when reading the title fails", async () => {
    const s = await setup({ titles: [shown(B), GONE, shown(B)], unsaved: 1 });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    await expect.poll(s.boundTo).toBe(B);
    expect([s.held(), s.released]).toEqual([false, [s.agentId]]);
  });

  it("holds mail while reading the title keeps failing past the give-up time, says so once, and moves once it reads", async () => {
    const s = await setup({ titles: [shown(B), GONE], unsaved: 1, giveUpMs: 20 });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    await expect.poll(() => s.titled.length).toBeGreaterThan(5);
    const said = s.logged.filter((line) => line.includes("mail is held"));
    expect([s.boundTo(), s.held(), s.released, said.length, s.detail()]).toEqual([
      A,
      true,
      [],
      1,
      MAIL_HELD,
    ]);
    s.titles.splice(0, s.titles.length, shown(B));
    await expect.poll(s.boundTo).toBe(B);
    expect([s.held(), s.released, s.detail()]).toEqual([false, [s.agentId], undefined]);
  });

  it("says at the first title read that fails, not at the give-up time, that the agent's mail is held", async () => {
    const s = await setup({ titles: [GONE, shown(B)], retryMs: 60_000 });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    const said = s.logged.filter((line) => line.includes("mail is held"));
    expect([s.held(), said.length, s.detail()]).toEqual([true, 1, MAIL_HELD]);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.held(), s.detail()]).toEqual([B, false, undefined]);
  });

  it("holds an agent's mail at start while its title can't be read, and moves it once it reads", async () => {
    const s = await setup({ titles: [GONE, shown(B)], runtime: "holder" });
    s.announce(B);
    s.threads.followAll();
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, true, []]);
    await expect.poll(s.boundTo).toBe(B);
    expect([s.held(), s.released]).toEqual([false, [s.agentId]]);
  });

  it("holds an agent's mail when a title it is told of can't be read, and moves it once it reads", async () => {
    const s = await setup({ titles: [GONE, shown(B)] });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, true, []]);
    await expect.poll(s.boundTo).toBe(B);
    expect([s.held(), s.released]).toEqual([false, [s.agentId]]);
  });

  it("lets the mail held for a title that can't be read go once nothing will start in its terminal", async () => {
    const s = await setup({ titles: [GONE] });
    await s.threads.titleChanged(s.terminal);
    expect(s.held()).toBe(true);
    s.threads.left(s.terminal);
    await expect.poll(s.held).toBe(false);
    expect([s.boundTo(), s.released]).toEqual([A, [s.agentId]]);
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
    await s.threads.titleChanged(s.terminal);
    await expect.poll(s.untracked).toBe(true);
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, false, [s.agentId]]);
  });

  it("never moves an agent onto a thread another running agent is bound to", async () => {
    const s = await setup({ titles: [shown(B)], others: [B] });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.resumed, s.untracked()]).toEqual([A, [], true]);
    expect(s.store.codexAgent(B)).toBe(s.agentOn(B));
  });

  it("never moves an agent onto the thread of an agent that is lost, exited or closing", async () => {
    const s = await setup({ titles: [shown(B), shown(C), shown(D)], others: [B, C, D] });
    const system = { actor: "system", payload: {} } as const;
    s.store.append({ ...system, type: "agent.lost", entityId: s.agentOn(B) });
    s.store.append({
      type: "agent.exited",
      entityId: s.agentOn(C),
      actor: "system",
      payload: { exit: { type: "unknown" } },
    });
    s.store.append({ ...system, type: "agent.closing", entityId: s.agentOn(D) });
    s.announce(B);
    s.announce(C);
    s.announce(D);
    await s.threads.titleChanged(s.terminal);
    await s.threads.titleChanged(s.terminal);
    await s.threads.titleChanged(s.terminal);
    expect([s.titled.length, s.boundTo(), s.resumed, s.untracked()]).toEqual([3, A, [], true]);
  });

  it("leaves the agent on its thread when another agent is bound to the thread while it is resumed", async () => {
    const during: { resuming?: () => void } = {};
    const s = await setup({ titles: [shown(B)], others: [C], resuming: () => during.resuming?.() });
    const other = s.agentOn(C);
    const environmentId = String(s.store.agentEnvironment(other));
    during.resuming = () =>
      s.store.append({
        type: "agent.external_ref_updated",
        entityId: other,
        actor: "system",
        payload: { externalRef: { environmentId, kind: "codex-thread", id: B } },
      });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.store.codexAgentsOn(B), s.untracked()]).toEqual([A, [other], true]);
    expect([s.held(), s.released]).toEqual([false, [s.agentId]]);
  });

  it("says switches are followed again once a move takes", async () => {
    const s = await setup({ titles: ["not a thread", shown(B)] });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect(s.untracked()).toBe(true);
    await s.threads.titleChanged(s.terminal);
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
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.resumed, s.untracked()]).toEqual([A, [], true]);
  });

  it("never matches a title thread, which Codex makes to write a thread's name", async () => {
    const s = await setup({ titles: [shown(B)] });
    s.announce(B, { ephemeral: true, threadSource: "thread_title" });
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.resumed]).toEqual([A, []]);
  });

  it("leaves the agent on its thread when its title is no thread id, and names the title", async () => {
    const s = await setup({ titles: ["my project · codex"] });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.lists, s.untracked()]).toEqual([A, [], true]);
    expect(s.logged.join("\n")).toContain('"my project · codex"');
  });

  it("ignores the empty title the TUI leaves as it exits, blank or not", async () => {
    const s = await setup({ titles: ["", " "] });
    await s.threads.titleChanged(s.terminal);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.lists, s.untracked(), s.logged]).toEqual([A, [], false, []]);
  });

  it("lets held mail go when the TUI exits while the agent waits to move", async () => {
    const s = await setup({ titles: [shown(B), ""], unsaved: 9 });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect(s.held()).toBe(true);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.held(), s.released, s.untracked()]).toEqual([
      A,
      false,
      [s.agentId],
      false,
    ]);
  });

  it("says switches are followed again once the title is back on the agent's thread", async () => {
    const s = await setup({ titles: [shown(B), shown(A)], listed: [{ id: A }], giveUpMs: 0 });
    await s.threads.titleChanged(s.terminal);
    expect(s.untracked()).toBe(true);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.untracked()]).toEqual([A, false]);
  });

  it("does nothing for a title still naming its thread, as after /compact", async () => {
    const s = await setup({ titles: [shown(A)] });
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.resumed, s.lists, s.untracked()]).toEqual([A, [], [], false]);
  });

  it("follows an agent on a holder by its terminal, reading the title from its holder", async () => {
    const s = await setup({ titles: [shown(B)], runtime: "holder" });
    s.announce(B);
    await s.threads.titleChanged(s.terminal);
    expect([s.boundTo(), s.resumed, s.titled.map((ref) => ref.runtime)]).toEqual([
      B,
      [B],
      ["holder"],
    ]);
  });

  it("drops at once a title heard where no Codex agent runs, while a Codex agent's follow waits", async () => {
    const { promise: listing } = Promise.withResolvers<unknown>();
    const s = await setup({ titles: [shown(C)], runtime: "holder", listing });
    void s.threads.heard(s.terminal);
    await expect.poll(() => s.lists.length).toBe(1);
    const other = s.threads.heard(newId("term")).then(() => "dropped");
    const queued = new Promise((resolve) => setTimeout(() => resolve("queued"), 200));
    await expect(Promise.race([other, queued])).resolves.toBe("dropped");
  });

  it("moves an agent, after a restart, to a thread the server lists only later and never announces", async () => {
    const listed = [{ id: A }];
    const s = await setup({ titles: [shown(B)], runtime: "holder", listed });
    s.threads.followAll();
    await expect.poll(() => s.lists.length).toBeGreaterThan(1);
    expect([s.boundTo(), s.held(), s.released]).toEqual([A, true, []]);
    listed.push({ id: B });
    await expect.poll(s.boundTo).toBe(B);
    expect([s.held(), s.released]).toEqual([false, [s.agentId]]);
  });

  it("reads every Codex agent's title after a restart, whichever runtime it is on", async () => {
    const s = await setup({ titles: [shown(B)], runtime: "holder" });
    s.announce(B);
    s.threads.followAll();
    expect(s.held()).toBe(true);
    await expect.poll(() => s.boundTo()).toBe(B);
    expect(s.held()).toBe(false);
  });

  it("ignores a terminal no running Codex agent is in", async () => {
    const s = await setup({ titles: [shown(B)] });
    s.announce(B);
    await s.threads.titleChanged(newId("term"));
    expect([s.boundTo(), s.titled]).toEqual([A, []]);
  });

  it("follows every change told during a follow with one more, which reads the latest title", async () => {
    const { promise: listing, resolve: answer } = Promise.withResolvers<unknown>();
    const s = await setup({
      titles: [shown(B), shown(A)],
      runtime: "holder",
      listing,
      listed: [{ id: A }, { id: B }],
    });
    const first = s.threads.heard(s.terminal);
    await expect.poll(() => s.lists.length).toBe(1);
    const told = Array.from({ length: 20 }, () => s.threads.heard(s.terminal));
    answer(undefined);
    await Promise.all([first, ...told]);
    expect([s.boundTo(), s.resumed, s.titled.length]).toEqual([A, [B, A], 2]);
  });

  it("follows changes told after its terminal was left after the drop, not in a follow queued before it", async () => {
    const s = await setup({ titles: [shown(B)], listed: [{ id: A }], retryMs: 60_000 });
    const before = s.threads.titleChanged(s.terminal);
    s.threads.left(s.terminal);
    const after = Array.from({ length: 5 }, () => s.threads.titleChanged(s.terminal));
    await Promise.all([before, ...after]);
    expect([s.held(), s.titled.length]).toEqual([true, 2]);
  });

  it("keeps one follow queued for a left terminal while the follow queued before the drop runs", async () => {
    const { promise: listing, resolve: answer } = Promise.withResolvers<unknown>();
    const s = await setup({ titles: [shown(B)], listing, listed: [{ id: A }], retryMs: 60_000 });
    const before = s.threads.titleChanged(s.terminal);
    s.threads.left(s.terminal);
    const after = s.threads.titleChanged(s.terminal);
    await expect.poll(() => s.lists.length).toBe(1);
    const told = Array.from({ length: 5 }, () => s.threads.titleChanged(s.terminal));
    answer(undefined);
    await Promise.all([before, after, ...told]);
    expect([s.held(), s.titled.length]).toEqual([true, 2]);
  });
});

describe("the agent on a Codex thread", () => {
  it("is the live agent bound to it, and none for a thread nothing is bound to", async () => {
    const { store, agentOn } = await withCodexAgents(A);
    expect([store.codexAgent(A), store.codexAgent(C)]).toEqual([agentOn(A), undefined]);
  });

  it("is no agent once the agent bound to it has exited, is lost, closing or closed, beside one still live", async () => {
    const { store, agentOn } = await withCodexAgents(A, B, C, D, E);
    const user = { actor: "user", payload: {} } as const;
    store.append({ ...user, type: "agent.lost", entityId: agentOn(A) });
    store.append({ ...user, type: "agent.closing", entityId: agentOn(B) });
    store.append({ ...user, type: "agent.closing", entityId: agentOn(C) });
    store.append({ ...user, type: "agent.closed", entityId: agentOn(C) });
    store.append({
      type: "agent.exited",
      entityId: agentOn(D),
      actor: "system",
      payload: { exit: { type: "unknown" } },
    });
    expect([A, B, C, D, E].map((t) => store.codexAgent(t))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      agentOn(E),
    ]);
  });

  it("is the agent still starting on it, as a thread is bound before its TUI is up", async () => {
    const { store, agentOn } = await withStartingCodexAgentsOn("tmux", A);
    expect(store.codexAgent(A)).toBe(agentOn(A));
  });

  it("is no agent once the start of the agent bound to it has failed", async () => {
    const { store } = await withCodexAgents();
    const environmentId = localEnvironmentId(store);
    const agentId = newId("agent");
    const system = { entityId: agentId, actor: "system" } as const;
    store.append({
      ...system,
      type: "agent.launched",
      payload: {
        environmentId,
        harness: "codex",
        project: "p",
        cwd: "/w",
        terminalId: newId("term"),
      },
    });
    store.append({
      ...system,
      type: "agent.external_ref_updated",
      payload: { externalRef: { environmentId, kind: "codex-thread", id: A } },
    });
    const starting = store.codexAgent(A);
    store.append({ ...system, type: "agent.failed", payload: { reason: "launch_rejected" } });
    expect([starting, store.codexAgent(A)]).toEqual([agentId, undefined]);
  });

  it("is no agent whose reference names it as another kind than a Codex thread", async () => {
    const { store, agentOn } = await withCodexAgents(A, B);
    const other = agentOn(B);
    store.append({
      type: "agent.external_ref_updated",
      entityId: other,
      actor: "system",
      payload: {
        externalRef: {
          environmentId: String(store.agentEnvironment(other)),
          kind: "claude-session",
          id: C,
        },
      },
    });
    expect([store.codexAgent(A), store.codexAgent(C)]).toEqual([agentOn(A), undefined]);
  });

  it("is no agent when two are on it, as a store from before one agent held a thread may have", async () => {
    const { store, path, agentOn } = await withCodexAgents(A, B);
    const [one, two] = [agentOn(A), agentOn(B)];
    bindLegacy(path, two, A);
    expect([
      store.codexAgent(A),
      store.codexAgentsOn(A).toSorted((x, y) => x.localeCompare(y)),
    ]).toEqual([undefined, [one, two].toSorted((x, y) => x.localeCompare(y))]);
  });

  it("can't be bound to an agent while another agent holds it, live, lost, exited or closing, and can once it has closed", async () => {
    const { store, agentOn } = await withCodexAgents(A, B, C, D, E, F);
    const system = { actor: "system", payload: {} } as const;
    store.append({ ...system, type: "agent.lost", entityId: agentOn(B) });
    store.append({
      type: "agent.exited",
      entityId: agentOn(C),
      actor: "system",
      payload: { exit: { type: "unknown" } },
    });
    store.append({ ...system, type: "agent.closing", entityId: agentOn(D) });
    store.append({ ...system, type: "agent.closing", entityId: agentOn(F) });
    store.append({ ...system, type: "agent.closed", entityId: agentOn(F) });
    const mover = agentOn(E);
    const environmentId = String(store.agentEnvironment(mover));
    const bind = (id: string) => () =>
      store.append({
        type: "agent.external_ref_updated",
        entityId: mover,
        actor: "system",
        payload: { externalRef: { environmentId, kind: "codex-thread", id } },
      });
    const before = store.snapshot(testView).eventId;
    for (const held of [A, B, C, D]) expect(bind(held)).toThrow(ThreadHeld);
    const refused = [store.snapshot(testView).eventId, store.codexThread(mover)];
    bind(F)();
    expect([refused, store.codexAgent(F)]).toEqual([[before, E], mover]);
  });
});
