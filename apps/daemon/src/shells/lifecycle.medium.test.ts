import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EnvironmentAdapter, HarnessAdapter, RuntimeRef } from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import { localEnvironmentId } from "../agents/launch.ts";
import { AgentQueue } from "../agents/queue.ts";
import { IdempotencyConflict, type Store } from "../store/store.ts";
import { testView, withAgent } from "../testing/fixtures.ts";
import {
  ShellBusy,
  ShellLifecycle,
  ShellStateConflict,
  StaleShellGeneration,
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
  watched.close = (refs) => {
    atClose.push(refs.runtime === null ? undefined : store.shell(refs.runtime.terminalId)?.state);
    return environment.close(refs);
  };
  const shells = new ShellLifecycle({
    store,
    environment: watched,
    queue: new AgentQueue(),
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
  return { store, runtime, home, agentId, shells, refOf, stateOf, open, atClose };
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
      ShellStateConflict,
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
      StaleShellGeneration,
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
