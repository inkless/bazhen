// What every RuntimeAdapter promises the daemon, as one suite. It runs against FakeRuntime in
// `pnpm check`, in both its attach modes, and against TmuxRuntime in the test container, so the
// fake can't drift from tmux. It reads a ref's locator only for the generation every runtime
// records.

import type { ExitStatus } from "@bazhen/protocol";
import { assert, describe, expect, it, onTestFinished } from "vitest";
import { newId } from "../ids.ts";
import { decode, delay, encode } from "./platform.ts";
import {
  ProcessState,
  StaleIncarnation,
  type RuntimeAdapter,
  type RuntimeRef,
  type Size,
  type TerminalSpec,
  type TerminalTags,
} from "../runtime.ts";

export interface ContractHarness {
  /** A runtime on a server of its own, which the suite ends after each test. */
  make(): { readonly runtime: RuntimeAdapter; dispose(): void };
  /** Leaves what holds `runtime`'s terminals running, but where it can no longer be read. */
  unreadable(runtime: RuntimeAdapter): void;
  /** Replaces the terminal's process outside Bazhen, under the generation it already has. */
  replaceProcess(runtime: RuntimeAdapter, ref: RuntimeRef): void;
  /** Ends the terminal outside Bazhen, as a killed session would. */
  vanish(runtime: RuntimeAdapter, ref: RuntimeRef): void;
  /** Ends every terminal and whatever holds them, as a reboot would. */
  reboot(runtime: RuntimeAdapter): void;
  /** The same terminal's ref, as if it had been made on a server other than the one running it. */
  forge(ref: RuntimeRef): RuntimeRef;
  /** Where the runtime runs a terminal's process, for one that reuses it across a respawn. */
  placeOf(ref: RuntimeRef): string | undefined;
  /** Whether it may never learn how a process ended, and call the cause unknown, as tmux 3.4 may. */
  readonly exitMayBeUnknown: boolean;
  /** Where the terminals' programs run. */
  readonly cwd: string;
  /** How long to wait for a process to exit; a loaded runner can take a second or more. */
  readonly waitMs: number;
}

const sleeping = ["sleep", "300"] as const;
const exiting = (code: number) => ["sh", "-c", `exit ${code}`] as const;

const entryOf = async (runtime: RuntimeAdapter, ref: RuntimeRef) =>
  (await runtime.inventory()).find(
    (e) =>
      e.ref.terminalId === ref.terminalId && e.ref.locator.generation === ref.locator.generation,
  );
const exitOf = async (runtime: RuntimeAdapter, ref: RuntimeRef) =>
  (await entryOf(runtime, ref))?.exit ?? null;
/** The terminal's current incarnation, which a ref equals only while its process is the same. */
const running = async (runtime: RuntimeAdapter, ref: RuntimeRef) => {
  const entry = (await runtime.inventory()).find((e) => e.ref.terminalId === ref.terminalId);
  return { ref: entry?.ref, dead: entry === undefined || entry.exit !== null };
};

/** A client attached on a snapshot, with the output its stream has carried since. */
async function snapshotClient(runtime: RuntimeAdapter, ref: RuntimeRef) {
  const attached = await runtime.attach(ref, null, 0);
  onTestFinished(() => attached.stream.close());
  assert(attached.kind === "snapshot", `attached with ${attached.kind}`);
  let live = "";
  let bytes = 0;
  const respawns: { generation: number; after: string }[] = [];
  attached.stream.onData((chunk) => {
    live += decode(chunk);
    bytes += chunk.length;
  });
  attached.stream.onRespawn((generation) => respawns.push({ generation, after: live }));
  return { ...attached, live: () => live, end: () => attached.offset + bytes, respawns };
}

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

  /** The cause the runtime gives, or, where it may not learn it, unknown. */
  const causes = (status: ExitStatus) =>
    harness.exitMayBeUnknown ? [status, { type: "unknown" }] : [status];

  const deadOf = async (runtime: RuntimeAdapter, ref: RuntimeRef) => {
    await expect.poll(() => exitOf(runtime, ref), { timeout: harness.waitMs }).not.toBeNull();
  };

  const fresh = () => {
    const made = harness.make();
    onTestFinished(() => made.dispose());
    return made.runtime;
  };

  describe(`${name}: the runtime contract`, () => {
    it("reports nothing running before its first terminal, and healthy after", async () => {
      const runtime = fresh();
      expect([(await runtime.health()).state, await runtime.inventory()]).toEqual([
        "not-running",
        [],
      ]);
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

    it("keeps an agent's harness session in its tags, as written", async () => {
      const runtime = fresh();
      const harnessSession = '{"kind":"claude-session","id":"s; 1"}';
      const s = spec(sleeping, { kind: "agent", agentId: newId("agent"), harnessSession });
      await runtime.create(s);
      const entry = (await runtime.inventory()).find((e) => e.ref.terminalId === s.terminalId);
      expect(entry?.tags).toEqual(s.tags);
    });

    it("keeps an exited terminal with its exit status", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(exiting(3)));
      await expect
        .poll(() => exitOf(runtime, ref), { timeout: harness.waitMs })
        .toBeOneOf(causes({ type: "exited", code: 3 }));
    });

    it("finds a terminal's own process in its foreground while it starts nothing", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      await expect
        .poll(() => runtime.foreground(ref), { timeout: harness.waitMs })
        .toEqual({ command: "sleep", own: true });
    });

    it("reads the live terminals' foregrounds it is asked for at once, with their directories", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      const dead = await runtime.create(spec(exiting(0)));
      await runtime.create(spec(sleeping));
      await deadOf(runtime, dead);
      const asked = new Set<string>([ref.terminalId, dead.terminalId]);
      const read = async () =>
        (await runtime.foregrounds(asked)).map((f) => ({ ...f, ref: f.ref.terminalId }));
      await expect
        .poll(read, { timeout: harness.waitMs })
        .toEqual([{ ref: ref.terminalId, command: "sleep", own: true, cwd: harness.cwd }]);
    });

    it("refuses to read the foreground of a terminal whose process has exited", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(exiting(0)));
      await deadOf(runtime, ref);
      await expect(runtime.foreground(ref)).rejects.toThrow(ProcessState);
    });

    it("drops a shell's agent link from its tags, and keeps the rest", async () => {
      const runtime = fresh();
      const s = spec(sleeping, { kind: "shell", linkedAgentId: newId("agent") });
      const ref = await runtime.create(s);
      await runtime.unlink(ref);
      const entry = (await runtime.inventory()).find((e) => e.ref.terminalId === s.terminalId);
      expect([entry?.tags, entry?.exit]).toEqual([{ kind: "shell" }, null]);
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

    it("pushes each switch to or from the alternate screen, once", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(["cat"]));
      const { stream, alternate } = await runtime.attach(ref, null, 0);
      onTestFinished(() => stream.close());
      const pushed: boolean[] = [];
      stream.onAlternate((on) => pushed.push(on));
      stream.write(encode("\x1b[?1049h\r"));
      await expect.poll(() => pushed, { timeout: harness.waitMs }).toEqual([true]);
      stream.write(encode("still there\r"));
      await delay(300);
      expect(pushed).toEqual([true]);
      stream.write(encode("\x1b[?1049l\r"));
      await expect.poll(() => pushed, { timeout: harness.waitMs }).toEqual([true, false]);
      expect(alternate).toBe(false);
    });

    it("refuses to attach to a terminal that is no longer there", async () => {
      const runtime = fresh();
      await runtime.create(spec(sleeping)); // keeps the server up once the other is gone
      const ref = await runtime.create(spec(sleeping));
      await runtime.close(ref);
      await expect(runtime.attach(ref, null, 0)).rejects.toMatchObject({ reason: "gone" });
    });

    it("reports how the terminal's own process ended, or, where it can't, that it could not tell", async () => {
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
        .toBeOneOf(causes({ type: "exited", code: 3 }));
      await expect
        .poll(() => signals.at(-1)?.status, { timeout: harness.waitMs })
        .toBeOneOf(causes({ type: "signalled", signal: "SIGTERM" }));
    });

    it("respawns a dead terminal in place, as its next generation", async () => {
      const runtime = fresh();
      const s = spec(exiting(0));
      const ref = await runtime.create(s);
      await deadOf(runtime, ref);
      const next = await runtime.respawn(ref, { ...s, generation: 1, argv: sleeping });
      const entries = (await runtime.inventory()).filter(
        (e) => e.ref.terminalId === ref.terminalId,
      );
      expect([next.locator.generation, entries.map((e) => [e.ref, e.exit])]).toEqual([
        "1",
        [[next, null]],
      ]);
      expect(harness.placeOf(next)).toBe(harness.placeOf(ref));
    });

    it("respawns a terminal left on its alternate screen onto its main screen", async () => {
      const runtime = fresh();
      const s = spec(["cat"]);
      const ref = await runtime.create(s);
      const { stream } = await runtime.attach(ref, null, 0);
      onTestFinished(() => stream.close());
      const pushed: boolean[] = [];
      stream.onAlternate((on) => pushed.push(on));
      stream.write(encode("\x1b[?1049h\r"));
      await expect.poll(() => pushed, { timeout: harness.waitMs }).toEqual([true]);
      await runtime.signal(ref, "SIGTERM");
      await deadOf(runtime, ref);
      const next = await runtime.respawn(ref, { ...s, generation: 1, argv: sleeping });
      const after = await runtime.attach(next, null, 0);
      onTestFinished(() => after.stream.close());
      expect(after.alternate).toBe(false);
    });

    it("reports a respawned terminal's next exit under its new generation", async () => {
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
      expect(exits.at(-1)?.status).toBeOneOf(causes({ type: "exited", code: 2 }));
    });

    it("refuses to respawn a terminal whose process is still running, and leaves it running", async () => {
      const runtime = fresh();
      const s = spec(sleeping);
      const ref = await runtime.create(s);
      await expect(runtime.respawn(ref, s)).rejects.toMatchObject({ expected: "exited" });
      expect(await running(runtime, ref)).toEqual({ ref, dead: false });
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
      const forged = harness.forge(ref);
      await expect(runtime.close(forged)).rejects.toThrow(StaleIncarnation);
      await expect(runtime.signal(forged, "SIGKILL")).rejects.toThrow(StaleIncarnation);
      expect((await running(runtime, ref)).dead).toBe(false);
    });

    it("refuses to attach from a ref whose server is not the one the terminal was created on", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      const forged = harness.forge(ref);
      await expect(runtime.attach(forged, null, 0)).rejects.toMatchObject({
        reason: "server-replaced",
      });
    });

    it("closes a terminal ended by a reboot, with nothing running", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      harness.reboot(runtime);
      await expect(runtime.close(ref)).resolves.toBeUndefined();
    });

    it("closes a terminal ended by a reboot, once another terminal runs", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      harness.reboot(runtime);
      const next = await runtime.create(spec(sleeping));
      await runtime.close(ref);
      expect((await runtime.inventory()).map((e) => e.ref.terminalId)).toEqual([next.terminalId]);
    });

    it("refuses to respawn from a ref whose server is not the one the terminal was created on", async () => {
      const runtime = fresh();
      const s = spec(exiting(0));
      const ref = await runtime.create(s);
      await deadOf(runtime, ref);
      const forged = harness.forge(ref);
      await expect(runtime.respawn(forged, s)).rejects.toMatchObject({ reason: "server-replaced" });
      expect(await exitOf(runtime, ref)).toBeOneOf(causes({ type: "exited", code: 0 }));
    });

    it("refuses to act on a process replaced outside Bazhen, on a server it was made on", async () => {
      const runtime = fresh();
      const ref = await runtime.create(spec(sleeping));
      harness.replaceProcess(runtime, ref);
      const refused = runtime.signal(ref, "SIGKILL");
      await expect(refused).rejects.toThrow(StaleIncarnation);
      await expect(refused).rejects.toMatchObject({
        reason: expect.stringMatching(/^(pane|process)-replaced$/),
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

/** What a runtime that attaches on a snapshot promises beyond the runtime contract. */
/** What a terminal that replays VT bytes, as a view does, ends up showing and answering. */
export interface Replayed {
  readonly buffer: "normal" | "alternate";
  /** Its modes, compared whole with a fresh terminal's. */
  readonly modes: unknown;
  /** Every row it holds, history first, trimmed. */
  readonly lines: readonly string[];
  /** What it sent back, as a terminal answers a query. */
  readonly replies: string;
}

export interface SnapshotHarness extends ContractHarness {
  /** Replays `vt` into a fresh terminal of `size`. */
  replay(vt: Uint8Array, size: Size): Promise<Replayed>;
}

export function snapshotContract(name: string, harness: SnapshotHarness): void {
  const fresh = () => {
    const made = harness.make();
    onTestFinished(() => made.dispose());
    return made.runtime;
  };

  const spec: TerminalSpec = {
    terminalId: newId("term"),
    tags: { kind: "shell" },
    argv: ["cat"],
    cwd: harness.cwd,
    env: {},
    size: { cols: 80, rows: 24 },
    generation: 0,
  };

  describe(`${name}: the snapshot attach contract`, () => {
    it("attaches on a snapshot that its stream carries on from, nothing missed or repeated", async () => {
      const runtime = fresh();
      const ref = await runtime.create({ ...spec, terminalId: newId("term") });
      const first = await snapshotClient(runtime, ref);
      first.stream.write(encode("before\r"));
      await expect.poll(() => first.live(), { timeout: harness.waitMs }).toContain("before");
      const late = await snapshotClient(runtime, ref);
      late.stream.write(encode("after\r"));
      await expect.poll(() => late.live(), { timeout: harness.waitMs }).toContain("after");
      await expect.poll(() => late.end() - first.end(), { timeout: harness.waitMs }).toBe(0);
      await delay(300);
      expect(late.offset).toSatisfy(Number.isSafeInteger);
      expect(late.offset).toBeGreaterThan(0);
      expect([late.end() - first.end(), decode(late.vt), late.live()]).toEqual([
        0,
        expect.stringContaining("before"),
        expect.not.stringContaining("before"),
      ]);
    });

    it("tells a stream of a respawn before the next process's output, which counts from 0", async () => {
      const runtime = fresh();
      const s = { ...spec, terminalId: newId("term") };
      const ref = await runtime.create(s);
      const first = await snapshotClient(runtime, ref);
      first.stream.write(encode("before\r"));
      await expect.poll(() => first.live(), { timeout: harness.waitMs }).toContain("before");
      await runtime.signal(ref, "SIGTERM");
      await expect.poll(() => exitOf(runtime, ref), { timeout: harness.waitMs }).not.toBeNull();
      const next = await runtime.respawn(ref, { ...s, generation: 1 });
      const late = await snapshotClient(runtime, next);
      first.stream.write(encode("after\r"));
      await expect.poll(() => first.live(), { timeout: harness.waitMs }).toContain("after");
      expect([late.offset, first.respawns]).toEqual([
        0,
        [{ generation: 1, after: expect.not.stringContaining("after") }],
      ]);
    });

    it("attaches a respawned terminal on its main screen, with a fresh terminal's modes", async () => {
      const runtime = fresh();
      const s = { ...spec, terminalId: newId("term") };
      const ref = await runtime.create(s);
      const first = await snapshotClient(runtime, ref);
      first.stream.write(encode("\x1b[?1049hALTDRAWN\x1b[?1000h\x1b[?2004h\r"));
      await expect.poll(() => first.live(), { timeout: harness.waitMs }).toContain("ALTDRAWN");
      await runtime.signal(ref, "SIGTERM");
      await expect.poll(() => exitOf(runtime, ref), { timeout: harness.waitMs }).not.toBeNull();
      const next = await runtime.respawn(ref, { ...s, generation: 1 });
      const late = await snapshotClient(runtime, next);
      const shown = await harness.replay(late.vt, s.size);
      const blank = await harness.replay(new Uint8Array(), s.size);
      expect([late.alternate, shown.buffer, shown.modes, shown.lines]).toEqual([
        false,
        "normal",
        blank.modes,
        expect.not.arrayContaining(["ALTDRAWN"]),
      ]);
    });

    it("attaches on a snapshot that asks the terminal nothing, whatever the program asked", async () => {
      const runtime = fresh();
      const ref = await runtime.create({ ...spec, terminalId: newId("term") });
      const first = await snapshotClient(runtime, ref);
      first.stream.write(encode("\x1b[6n\x1b[c\x1b]10;?\x07\x1b]11;?\x1b\\asked\r"));
      await expect.poll(() => first.live(), { timeout: harness.waitMs }).toContain("asked");
      const late = await snapshotClient(runtime, ref);
      const shown = await harness.replay(late.vt, spec.size);
      expect([shown.replies, shown.lines]).toEqual(["", expect.arrayContaining(["asked"])]);
    });
  });
}
