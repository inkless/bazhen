import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EnvironmentAdapter, HarnessAdapter, RuntimeRef } from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import { localEnvironmentId } from "../agents/launch.ts";
import { Lifecycle } from "../agents/lifecycle.ts";
import { AgentQueue } from "../agents/queue.ts";
import { StaleGeneration, StateConflict } from "../commands.ts";
import { IdempotencyConflict, type Store } from "../store/store.ts";
import { testView, withAgent } from "../testing/fixtures.ts";
import {
  ShellBusy,
  ShellLifecycle,
  ShellOpenFailed,
  ShellsUnsettled,
  UnknownShell,
} from "./lifecycle.ts";

const claude: HarnessAdapter = {
  id: "claude-code",
  themes: ["light", "dark"],
  launchSpec: async () => ({ argv: ["claude"], env: {}, externalRef: null }),
};

/** A store with one running agent, and shells on a fake runtime whose user's shell is zsh. */
async function setup() {
  const runtime = new FakeRuntime();
  const home = mkdtempSync(join(tmpdir(), "bz-home-"));
  const { store, agentId, environment } = await withAgent(
    (s) =>
      new LocalEnvironment({
        id: localEnvironmentId(s),
        runtime,
        harnesses: [claude],
        socket: "/run/b.sock",
        shell: "/bin/zsh",
      }),
  );
  const atClose: (string | undefined)[] = [];
  // The environment as it is, noting each shell's state as its close reaches the environment.
  const watched: EnvironmentAdapter = Object.create(environment);
  // Closes wait while a test holds the gate, as an environment slow to answer would.
  let gate: Promise<void> = Promise.resolve();
  let shellsFail = false;
  watched.close = async (refs) => {
    atClose.push(refs.runtime === null ? undefined : store.shell(refs.runtime.terminalId)?.state);
    await gate;
    if (shellsFail && refs.runtime !== null && store.shell(refs.runtime.terminalId))
      throw new Error("tmux unreachable");
    return environment.close(refs);
  };
  let opensFail = false;
  let opensGate: Promise<void> = Promise.resolve();
  watched.openShell = async (open) => {
    await opensGate;
    if (opensFail) throw new Error("tmux refused");
    return environment.openShell(open);
  };
  const holdOpens = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    opensGate = promise;
    return () => resolve();
  };
  const hold = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    gate = promise;
    return () => resolve();
  };
  const queue = new AgentQueue();
  const shells = new ShellLifecycle({
    store,
    environment: watched,
    queue,
    size: { cols: 80, rows: 24 },
    home,
  });
  const refOf = (terminalId: string): RuntimeRef => {
    const ref = store.shell(terminalId)?.runtime;
    if (ref == null) throw new Error(`shell ${terminalId} has no terminal`);
    return ref;
  };
  const stateOf = (terminalId: string) => store.shell(terminalId)?.state;
  const open = async (key = "open") => (await shells.open({ idempotencyKey: key })).terminalId;
  const lifecycle = new Lifecycle(store, watched, queue);
  let keys = 0;
  const linked = async () =>
    (await shells.open({ idempotencyKey: `linked-${++keys}`, linkedAgentId: agentId })).terminalId;
  const closeAgent = (
    asked: { keepShells?: string[]; confirmBusy?: boolean; idempotencyKey?: string } = {},
  ) =>
    shells.closeAgent(
      agentId,
      { idempotencyKey: `close-agent-${++keys}`, generation: 0, ...asked },
      (r) => lifecycle.close(agentId, r),
    );
  const tagsOf = async (terminalId: string) =>
    (await runtime.inventory()).find((e) => e.ref.terminalId === terminalId)?.tags;
  const shellOf = (terminalId: string) =>
    store.snapshot(testView).shells.find((s) => s.id === terminalId);
  return {
    store,
    runtime,
    home,
    agentId,
    shells,
    refOf,
    stateOf,
    open,
    atClose,
    hold,
    failShells: (fail: boolean) => (shellsFail = fail),
    failOpens: (fail: boolean) => (opensFail = fail),
    holdOpens,
    linked,
    closeAgent,
    tagsOf,
    shellOf,
  };
}

const carried = async (runtime: FakeRuntime, terminalId: string) =>
  (await runtime.inventory()).some((e) => e.ref.terminalId === terminalId);

const agentClosed = (store: Store, agentId: string) => {
  store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
  store.append({ type: "agent.closed", entityId: agentId, actor: "user", payload: {} });
};

describe("opening a shell", () => {
  it("runs the user's shell as a login shell in their home, told its terminal but no agent", async () => {
    const { shells, runtime, refOf, home } = await setup();
    const { terminalId } = await shells.open({ idempotencyKey: "o", theme: "light" });
    const spec = runtime.specOf(refOf(terminalId));
    expect([spec.argv, spec.cwd, spec.tags, spec.theme]).toEqual([
      ["/bin/zsh", "-l", "-i"],
      home,
      { kind: "shell" },
      "light",
    ]);
    expect(spec.env).toEqual({ BAZHEN_TERMINAL_ID: terminalId, BAZHEN_SOCKET: "/run/b.sock" });
  });

  it("opens a linked shell in its agent's directory, tagged with the agent", async () => {
    const { shells, runtime, refOf, agentId, store } = await setup();
    const { terminalId } = await shells.open({ idempotencyKey: "o", linkedAgentId: agentId });
    const spec = runtime.specOf(refOf(terminalId));
    expect([spec.cwd, spec.tags]).toEqual([tmpdir(), { kind: "shell", linkedAgentId: agentId }]);
    expect(store.snapshot(testView).shells).toMatchObject([
      { id: terminalId, state: "running", cwd: tmpdir(), linkedAgentId: agentId },
    ]);
  });

  it("refuses to link a shell to an agent that has closed", async () => {
    const { shells, agentId, store } = await setup();
    agentClosed(store, agentId);
    await expect(shells.open({ idempotencyKey: "o", linkedAgentId: agentId })).rejects.toThrow(
      StateConflict,
    );
  });

  it("answers a repeated key with the first shell, opening no second one", async () => {
    const { shells, runtime, open } = await setup();
    const first = await open("same");
    expect(await open("same")).toBe(first);
    expect((await runtime.inventory()).filter((e) => e.tags.kind === "shell")).toHaveLength(1);
    await expect(shells.open({ idempotencyKey: "same", cwd: "/" })).rejects.toThrow(
      IdempotencyConflict,
    );
  });
});

describe("closing a shell", () => {
  it("refuses while a program runs in it, naming it, and closes once that is confirmed", async () => {
    const { shells, runtime, refOf, stateOf, open } = await setup();
    const terminalId = await open();
    runtime.runInForeground(refOf(terminalId), "nvim");
    const refused = shells.close(terminalId, { idempotencyKey: "c1", generation: 0 });
    await expect(refused).rejects.toThrow(ShellBusy);
    await expect(refused).rejects.toThrow(/nvim/);
    expect([stateOf(terminalId), await carried(runtime, terminalId)]).toEqual(["running", true]);
    await shells.close(terminalId, { idempotencyKey: "c2", generation: 0, confirmBusy: true });
    expect([stateOf(terminalId), await carried(runtime, terminalId)]).toEqual(["closed", false]);
  });

  it("closes without asking a shell whose process died before its exit was seen", async () => {
    const { shells, runtime, refOf, stateOf, open } = await setup();
    const terminalId = await open();
    runtime.exitProcess(refOf(terminalId));
    await shells.close(terminalId, { idempotencyKey: "c", generation: 0 });
    expect([stateOf(terminalId), await carried(runtime, terminalId)]).toEqual(["closed", false]);
  });

  it("closes a shell at its prompt without asking, and lists it no more", async () => {
    const { shells, runtime, stateOf, open, store } = await setup();
    const terminalId = await open();
    await shells.close(terminalId, { idempotencyKey: "c", generation: 0 });
    expect([stateOf(terminalId), await carried(runtime, terminalId)]).toEqual(["closed", false]);
    expect(store.snapshot(testView).shells).toEqual([]);
  });

  it("refuses a close naming an earlier generation, and a shell it doesn't know", async () => {
    const { shells, open } = await setup();
    const terminalId = await open();
    await expect(shells.close(terminalId, { idempotencyKey: "c", generation: 1 })).rejects.toThrow(
      StaleGeneration,
    );
    await expect(shells.close("term_nope", { idempotencyKey: "d", generation: 0 })).rejects.toThrow(
      UnknownShell,
    );
  });

  it("closes a shell at once when its shell exits, recorded closing before its session ends", async () => {
    const { shells, runtime, refOf, stateOf, open, atClose } = await setup();
    const terminalId = await open();
    const stop = shells.watch();
    runtime.exitProcess(refOf(terminalId));
    await expect.poll(() => stateOf(terminalId)).toBe("closed");
    expect([await carried(runtime, terminalId), atClose]).toEqual([false, ["closing"]]);
    stop();
  });
});

describe("a shell beside an agent", () => {
  it("closes with its agent, busy or not, unless kept, which runs on standalone", async () => {
    const { runtime, refOf, stateOf, linked, open, closeAgent, tagsOf, shellOf } = await setup();
    const [busy, kept, standalone] = [await linked(), await linked(), await open("s")];
    runtime.runInForeground(refOf(busy), "nvim");
    await closeAgent({ keepShells: [kept], confirmBusy: true });
    expect([stateOf(busy), stateOf(kept), stateOf(standalone)]).toEqual([
      "closed",
      "running",
      "running",
    ]);
    expect([await tagsOf(busy), await tagsOf(kept)]).toEqual([undefined, { kind: "shell" }]);
    expect(shellOf(kept)?.linkedAgentId).toBeNull();
  });

  it("refuses a shell asked for beside an agent whose close is already under way", async () => {
    const { shells, agentId, closeAgent, hold, store } = await setup();
    const release = hold();
    const closing = closeAgent();
    await expect.poll(() => store.agentTerminal({ agentId })?.state).toBe("closing");
    const opening = shells.open({ idempotencyKey: "late", linkedAgentId: agentId });
    release();
    await expect(opening).rejects.toThrow(StateConflict);
    await closing;
  });

  it("lets an agent's close wait for a restart beside it, then takes the new shell too", async () => {
    const { shells, agentId, closeAgent, store, runtime, holdOpens } = await setup();
    const { terminalId } = await shells.open({ idempotencyKey: "o", linkedAgentId: agentId });
    runtime.killServer();
    store.append({ type: "terminal.lost", entityId: terminalId, actor: "system", payload: {} });
    const release = holdOpens();
    const restarting = shells.restart(terminalId, { idempotencyKey: "r", generation: 0 });
    await expect.poll(() => store.snapshot(testView).shells.length).toBe(2);
    const closing = closeAgent();
    release();
    const restarted = await restarting;
    await closing;
    const running = Number(store.lastEventId(restarted.terminalId, "terminal.running"));
    const agentClosing = Number(store.lastEventId(agentId, "agent.closing"));
    expect([running < agentClosing, store.shell(restarted.terminalId)?.state]).toEqual([
      true,
      "closed",
    ]);
  });

  it("refuses to close an agent while a shell it takes runs a program, naming it", async () => {
    const { runtime, refOf, store, agentId, stateOf, linked, closeAgent } = await setup();
    const [busy, kept] = [await linked(), await linked()];
    runtime.runInForeground(refOf(busy), "nvim");
    runtime.runInForeground(refOf(kept), "npm");
    const refused = closeAgent({ keepShells: [kept] });
    await expect(refused).rejects.toThrow(ShellBusy);
    await expect(refused).rejects.toThrow(/nvim/);
    expect([store.agentTerminal({ agentId })?.state, stateOf(busy)]).toEqual([
      "running",
      "running",
    ]);
  });

  it("answers a repeated close the same, the kept shell standalone by then", async () => {
    const { linked, closeAgent, stateOf } = await setup();
    const kept = await linked();
    const asked = { keepShells: [kept], idempotencyKey: "close-once" };
    const first = await closeAgent(asked);
    expect(await closeAgent(asked)).toEqual(first);
    expect(stateOf(kept)).toBe("running");
  });

  it("reports the shells it could not close, and a repeat finishes them", async () => {
    const { linked, closeAgent, stateOf, store, agentId, failShells } = await setup();
    const shell = await linked();
    const asked = { idempotencyKey: "close-twice" };
    failShells(true);
    await expect(closeAgent(asked)).rejects.toThrow(ShellsUnsettled);
    const left = [store.agentTerminal({ agentId })?.state, stateOf(shell)];
    failShells(false);
    await closeAgent(asked);
    expect([left, stateOf(shell)]).toEqual([["closed", "closing"], "closed"]);
  });

  it("closes a shell left beside an agent that closed without it, as the server watch does", async () => {
    const { linked, closeAgent, stateOf, failShells, shells } = await setup();
    const shell = await linked();
    failShells(true);
    await closeAgent().catch(() => {});
    failShells(false);
    await shells.settleOrphans();
    expect(stateOf(shell)).toBe("closed");
  });

  it("refuses to keep a shell that isn't beside the agent, and closes nothing", async () => {
    const { store, agentId, stateOf, linked, open, closeAgent } = await setup();
    const [mine, other] = [await linked(), await open("s")];
    await expect(closeAgent({ keepShells: [other] })).rejects.toThrow(StateConflict);
    expect([store.agentTerminal({ agentId })?.state, stateOf(mine)]).toEqual([
      "running",
      "running",
    ]);
  });

  it("makes a linked shell standalone where it runs, and refuses a standalone one", async () => {
    const { shells, linked, open, tagsOf, shellOf } = await setup();
    const [terminalId, standalone] = [await linked(), await open("s")];
    await shells.unlink(terminalId, { idempotencyKey: "u", generation: 0 });
    expect([await tagsOf(terminalId), shellOf(terminalId)?.linkedAgentId]).toEqual([
      { kind: "shell" },
      null,
    ]);
    await expect(
      shells.unlink(standalone, { idempotencyKey: "u2", generation: 0 }),
    ).rejects.toThrow(StateConflict);
  });
});

/** A linked shell whose server died, as reconciliation records it. */
async function lost(theme: "light" | "dark" = "light") {
  const ctx = await setup();
  const { terminalId } = await ctx.shells.open({
    idempotencyKey: "lost",
    linkedAgentId: ctx.agentId,
    theme,
  });
  ctx.runtime.killServer();
  ctx.store.append({ type: "terminal.lost", entityId: terminalId, actor: "system", payload: {} });
  return { ...ctx, terminalId };
}

describe("a lost shell", () => {
  it("restarts as a new shell in its directory, beside its agent and in its theme", async () => {
    const { shells, terminalId, runtime, refOf, stateOf, agentId } = await lost();
    const restarted = await shells.restart(terminalId, { idempotencyKey: "r", generation: 0 });
    const spec = runtime.specOf(refOf(restarted.terminalId));
    expect([stateOf(terminalId), stateOf(restarted.terminalId)]).toEqual(["closed", "running"]);
    expect([spec.cwd, spec.tags, spec.theme]).toEqual([
      tmpdir(),
      { kind: "shell", linkedAgentId: agentId },
      "light",
    ]);
  });

  it("stays lost when its restart fails, and a repeat says so, so it can be restarted again", async () => {
    const { shells, terminalId, stateOf, failOpens } = await lost();
    failOpens(true);
    const asked = { idempotencyKey: "r", generation: 0 };
    await expect(shells.restart(terminalId, asked)).rejects.toThrow(ShellOpenFailed);
    await expect(shells.restart(terminalId, asked)).rejects.toThrow(ShellOpenFailed);
    failOpens(false);
    const again = await shells.restart(terminalId, { idempotencyKey: "r2", generation: 0 });
    expect([stateOf(terminalId), stateOf(again.terminalId)]).toEqual(["closed", "running"]);
  });

  it("restarts standalone once its agent has closed", async () => {
    const { shells, terminalId, runtime, refOf, store, agentId } = await lost();
    store.append({ type: "agent.closing", entityId: agentId, actor: "user", payload: {} });
    store.append({ type: "agent.closed", entityId: agentId, actor: "user", payload: {} });
    const restarted = await shells.restart(terminalId, { idempotencyKey: "r", generation: 0 });
    expect(runtime.specOf(refOf(restarted.terminalId)).tags).toEqual({ kind: "shell" });
  });

  it("is dismissed with its agent when the lost agent is removed", async () => {
    const { store, agentId, terminalId, stateOf, closeAgent } = await lost();
    store.append({ type: "agent.lost", entityId: agentId, actor: "system", payload: {} });
    await closeAgent();
    expect(stateOf(terminalId)).toBe("closed");
  });
});

describe("naming a shell", () => {
  it("shows the name given, and none once it is taken away", async () => {
    const { shells, open, shellOf } = await setup();
    const terminalId = await open();
    await shells.rename(terminalId, { idempotencyKey: "n1", name: "dev server" });
    const named = shellOf(terminalId)?.name;
    await shells.rename(terminalId, { idempotencyKey: "n2", name: null });
    expect([named, shellOf(terminalId)?.name]).toEqual(["dev server", null]);
  });
});
