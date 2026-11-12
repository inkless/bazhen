// What every RuntimeAdapter promises the daemon, as one suite. It runs against FakeRuntime in
// `pnpm check` and against TmuxRuntime in the test container, so the fake can't drift from tmux.

import { describe, expect, it, onTestFinished } from "vitest";
import { newId } from "../ids.ts";
import { decode, delay, encode } from "./platform.ts";
import {
  StaleIncarnation,
  type RuntimeAdapter,
  type RuntimeRef,
  type TerminalSpec,
  type TerminalTags,
} from "../runtime.ts";

export interface ContractHarness {
  /** A runtime on a server of its own, which the suite ends after each test. */
  make(): { readonly runtime: RuntimeAdapter; dispose(): void };
  /** Leaves `runtime`'s server running, but where it can no longer be read. */
  unreadable(runtime: RuntimeAdapter): void;
  /** Replaces the terminal's pane inside it, as a split and a kill by hand would. */
  replacePane(runtime: RuntimeAdapter, ref: RuntimeRef): void;
  /** Ends the terminal outside Bazhen, as a killed session would. */
  vanish(runtime: RuntimeAdapter, ref: RuntimeRef): void;
  /** Where the terminals' programs run. */
  readonly cwd: string;
  /** How long to wait for a process to exit; a loaded runner can take a second or more. */
  readonly waitMs: number;
}

/** tmux 3.4 sometimes never learns how a pane's process ended, so a cause may be unknown. */
const UNKNOWN = { type: "unknown" } as const;
const sleeping = ["sleep", "300"] as const;
const exiting = (code: number) => ["sh", "-c", `exit ${code}`] as const;

const entryOf = async (runtime: RuntimeAdapter, ref: RuntimeRef) =>
  (await runtime.inventory()).find(
    (e) => e.ref.terminalId === ref.terminalId && e.ref.locator.paneId === ref.locator.paneId,
  );
const exitOf = async (runtime: RuntimeAdapter, ref: RuntimeRef) =>
  (await entryOf(runtime, ref))?.exit ?? null;
const running = async (runtime: RuntimeAdapter, ref: RuntimeRef) => {
  const entry = await entryOf(runtime, ref);
  return { pid: entry?.ref.locator.panePid, dead: entry === undefined || entry.exit !== null };
};

/** Exits reported for `terminalId`, collected until the test ends. */
function exitsOf(runtime: RuntimeAdapter, terminalId: string) {
  const seen: { generation: string | undefined; status: unknown }[] = [];
  onTestFinished(
    runtime.onExit((ref, status) => {
      if (ref.terminalId === terminalId) seen.push({ generation: ref.locator.generation, status });
    }),
  );
  return seen;
}

export function runtimeContract(name: string, harness: ContractHarness): void {
  const spec = (
    argv: readonly [string, ...string[]],
    tags: TerminalTags = { kind: "agent", agentId: newId("agent") },
  ): TerminalSpec => ({
    terminalId: newId("term"),
    tags,
    argv,
    cwd: harness.cwd,
    env: {},
    size: { cols: 80, rows: 24 },
    generation: 0,
  });

  const deadOf = async (runtime: RuntimeAdapter, ref: RuntimeRef) => {
    await expect.poll(() => exitOf(runtime, ref), { timeout: harness.waitMs }).not.toBeNull();
  };

  const fresh = () => {
    const made = harness.make();
    onTestFinished(() => made.dispose());
    return made.runtime;
  };

  describe(`${name}: the runtime contract`, () => {
    it("has no server to read before its first terminal, and a healthy one after", async () => {
      const runtime = fresh();
      expect((await runtime.health()).state).toBe("not-running");
      await expect(runtime.inventory()).rejects.not.toBeInstanceOf(StaleIncarnation);
      await runtime.create(spec(["cat"]));
      expect((await runtime.health()).state).toBe("healthy");
    });

    it("finds a created terminal again by its Bazhen id, with its tags", async () => {
      const runtime = fresh();
      const agentId = newId("agent");
      const agent = spec(["cat"], { kind: "agent", agentId });
      const shell = spec(["cat"], { kind: "shell", linkedAgentId: agentId });
      await runtime.create(agent);
      await runtime.create(shell);
      const all = await runtime.inventory();
      const of = (id: string) => all.find((e) => e.ref.terminalId === id);
      expect([of(agent.terminalId)?.tags, of(shell.terminalId)?.tags]).toEqual([
        { kind: "agent", agentId },
        { kind: "shell", linkedAgentId: agentId },
      ]);
      expect(of(agent.terminalId)?.exit).toBeNull();
    });

    it("keeps an exited terminal with its exit status", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(exiting(3)));
      await expect
        .poll(() => exitOf(runtime, ref), { timeout: harness.waitMs })
        .toBeOneOf([{ type: "exited", code: 3 }, UNKNOWN]);
    });

    it("round-trips input through an attached terminal", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(["cat"]));
      const { stream } = await runtime.attach(ref, { cols: 100, rows: 30 }, 0);
      onTestFinished(() => stream.close());
      let seen = "";
      stream.onData((bytes) => (seen += decode(bytes)));
      stream.write(encode("ping-你好\r"));
      await expect.poll(() => seen, { timeout: harness.waitMs }).toContain("ping-你好");
    });

    it("reports how the pane's own process ended, or that it could not tell", async () => {
      const runtime = fresh();
      const coded = await runtime.create(spec(exiting(3)));
      const killed = await runtime.create(spec(sleeping));
      const codes = exitsOf(runtime, coded.terminalId);
      const signals = exitsOf(runtime, killed.terminalId);
      // Exits are found by looking, never inside the subscription itself.
      expect(codes).toEqual([]);
      await runtime.signal(killed, "SIGTERM");
      await expect
        .poll(() => codes.at(-1)?.status, { timeout: harness.waitMs })
        .toBeOneOf([{ type: "exited", code: 3 }, UNKNOWN]);
      await expect
        .poll(() => signals.at(-1)?.status, { timeout: harness.waitMs })
        .toBeOneOf([{ type: "signalled", signal: "SIGTERM" }, UNKNOWN]);
    });

    it("respawns a dead pane in place, with a new process and the same pane", async () => {
      const runtime = fresh();
      const s = spec(exiting(0));
      const ref = await runtime.create(s);
      await deadOf(runtime, ref);
      const next = await runtime.respawn(ref, { ...s, generation: 1, argv: sleeping });
      expect(next.locator.paneId).toBe(ref.locator.paneId);
      expect(next.locator.panePid).not.toBe(ref.locator.panePid);
      expect(await running(runtime, next)).toEqual({ pid: next.locator.panePid, dead: false });
    });

    it("reports a respawned pane's next exit under its new generation", async () => {
      const runtime = fresh();
      const s = spec(exiting(1));
      const ref = await runtime.create(s);
      await deadOf(runtime, ref);
      const next = await runtime.respawn(ref, {
        ...s,
        generation: 1,
        argv: ["sh", "-c", "sleep 0.5; exit 2"],
      });
      const exits = exitsOf(runtime, ref.terminalId);
      expect([ref.locator.generation, next.locator.generation]).toEqual(["0", "1"]);
      await expect
        .poll(() => exits.at(-1), { timeout: harness.waitMs })
        .toMatchObject({ generation: "1" });
      expect(exits.at(-1)?.status).toBeOneOf([{ type: "exited", code: 2 }, UNKNOWN]);
    });

    it("refuses to respawn a pane whose process is still running, and leaves it running", async () => {
      const runtime = fresh();
      const s = spec(sleeping);
      const ref = await runtime.create(s);
      await expect(runtime.respawn(ref, s)).rejects.toMatchObject({ expected: "exited" });
      expect(await running(runtime, ref)).toEqual({ pid: ref.locator.panePid, dead: false });
    });

    it("refuses to signal a process that has already exited", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(exiting(0)));
      await deadOf(runtime, ref);
      await expect(runtime.signal(ref, "SIGTERM")).rejects.toMatchObject({ expected: "running" });
    });

    it("touches nothing when the server is not the one the terminal was created on", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      const forged = { ...ref, locator: { ...ref.locator, serverStart: "1" } };
      await expect(runtime.close(forged)).rejects.toThrow(StaleIncarnation);
      await expect(runtime.signal(forged, "SIGKILL")).rejects.toThrow(StaleIncarnation);
      expect((await running(runtime, ref)).dead).toBe(false);
    });

    it("refuses to respawn from a ref whose server is not the one the terminal was created on", async () => {
      const runtime = fresh();
      const s = spec(exiting(0));
      const ref = await runtime.create(s);
      await deadOf(runtime, ref);
      const forged = { ...ref, locator: { ...ref.locator, serverPid: "0" } };
      await expect(runtime.respawn(forged, s)).rejects.toMatchObject({ reason: "server-replaced" });
      expect(await exitOf(runtime, ref)).toBeOneOf([{ type: "exited", code: 0 }, UNKNOWN]);
    });

    it("refuses to act on a pane that has been replaced inside the terminal", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      harness.replacePane(runtime, ref);
      await expect(runtime.signal(ref, "SIGKILL")).rejects.toMatchObject({
        reason: "pane-replaced",
      });
    });

    it("refuses to respawn from a ref to an earlier generation", async () => {
      const runtime = fresh();
      const s = spec(exiting(0));
      const ref = await runtime.create(s);
      await deadOf(runtime, ref);
      const next = await runtime.respawn(ref, { ...s, generation: 1, argv: exiting(0) });
      await deadOf(runtime, next);
      await expect(runtime.respawn(ref, { ...s, generation: 2 })).rejects.toMatchObject({
        reason: "process-replaced",
      });
    });

    it("refuses a ref that carries no generation rather than acting on it unchecked", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      const { generation: _, ...unnumbered } = ref.locator;
      await expect(
        runtime.signal({ ...ref, locator: unnumbered }, "SIGKILL"),
      ).rejects.toMatchObject({
        reason: "unnumbered",
      });
      expect((await running(runtime, ref)).dead).toBe(false);
    });

    it("refuses to signal a process that has been replaced by a respawn", async () => {
      const runtime = fresh();
      const s = spec(exiting(0));
      const ref = await runtime.create(s);
      await deadOf(runtime, ref);
      const next = await runtime.respawn(ref, { ...s, generation: 1, argv: sleeping });
      await expect(runtime.signal(ref, "SIGKILL")).rejects.toMatchObject({
        reason: "process-replaced",
      });
      expect((await running(runtime, next)).dead).toBe(false);
    });

    it("closes a terminal, and counts one the server no longer has as closed", async () => {
      const runtime = fresh();
      await runtime.create(spec(sleeping)); // keeps the server up once the others are gone
      const ref = await runtime.create(spec(sleeping));
      const gone = await runtime.create(spec(sleeping));
      harness.vanish(runtime, gone);
      await runtime.close(ref);
      await runtime.close(gone);
      const left = (await runtime.inventory()).map((e) => e.ref.terminalId);
      expect([left.includes(ref.terminalId), left.includes(gone.terminalId)]).toEqual([
        false,
        false,
      ]);
    });

    it("refuses to close a terminal on a server it can't read, without calling it stale", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      harness.unreadable(runtime);
      await expect(runtime.close(ref)).rejects.not.toBeInstanceOf(StaleIncarnation);
      expect((await runtime.health()).state).toBe("unreachable");
    });

    it("reports no exit, even of a terminal already dead, while the server cannot be read", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(exiting(0)));
      await deadOf(runtime, ref);
      harness.unreadable(runtime);
      const seen: string[] = [];
      onTestFinished(runtime.onExit((dead) => seen.push(dead.terminalId)));
      await delay(300);
      expect(seen).toEqual([]);
    });
  });
}
