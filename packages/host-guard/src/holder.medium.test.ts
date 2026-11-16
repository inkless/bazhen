// startHolder with a fake child, a fake `ps` and a kill that is recorded, never sent: no process
// is started or signalled.

import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HolderChild,
  HolderStartFailed,
  holderSocket,
  holdersDir,
  rebindHolderWith,
  type StartHolderOptions,
  startHolderWith,
} from "./holder.ts";
import type { HolderProcess } from "./signal.ts";
import type { PsReading } from "./tmux.ts";

// Above every system's pid limit, so even a broken guard reaches no process.
const PID = 2 ** 22 + 1;
const START = 1_794_630_000;
const BINARY = "/opt/bazhen/bazhen-holder";

/** A child that does what each test says, and records what it was sent. */
class FakeChild extends EventEmitter implements HolderChild {
  pid: number | undefined = PID;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  unrefed = false;
  sent = "";
  stdinEnded = false;

  constructor() {
    super();
    this.stdin.setEncoding("utf8").on("data", (chunk: string) => (this.sent += chunk));
    this.stdin.once("finish", () => (this.stdinEnded = true));
  }

  unref(): void {
    this.unrefed = true;
  }

  exit(code: number | null, signal: string | null = null): void {
    this.stderr.end();
    this.emit("exit", code, signal);
  }
}

/** The most a pid can be here: Linux says; macOS's is fixed. */
function pidLimit(): number {
  try {
    return Number(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());
  } catch {
    return 99_999;
  }
}

beforeAll(() => {
  const limit = pidLimit();
  if (!(Number.isSafeInteger(limit) && PID > limit)) {
    throw new Error(`the fake holder's pid ${PID} isn't above this system's limit ${limit}`);
  }
});

// Nothing here may reach a real signal: the kill is a seam, and a call that got past it throws.
beforeEach(() => {
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    throw new Error(`a test reached process.kill(${pid})`);
  });
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bz-hg-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

const holderAt = (start: number): PsReading => ({ comm: BINARY, start, args: "bazhen-holder" });
const stranger: PsReading = { comm: "sleep", start: START, args: "sleep 300" };
const always = (reading: PsReading) => async () => reading;
/** `ps` read by each of `steps` in turn, the last of them again from then on. */
const inTurn = (...steps: [() => PsReading, ...(() => PsReading)[]]) => {
  let at = 0;
  return async () => steps[Math.min(at++, steps.length - 1)]!();
};
/** `ps` showing `first`, then `then` from the next read on, as a pid reused meanwhile would. */
const readsThen = (first: PsReading, then: PsReading) => {
  const readings = [first];
  return async () => readings.shift() ?? then;
};

interface Run {
  readonly child: FakeChild;
  readonly root: string;
  readonly spec: StartHolderOptions["spec"];
  readonly kills: HolderProcess[];
  readonly reads: () => number;
  readonly spawned: { file: string; args: readonly string[]; env: Record<string, string> }[];
  readonly start: Promise<unknown>;
}

function started(
  read: (pid: number) => Promise<PsReading>,
  options: Partial<StartHolderOptions> = {},
  child = new FakeChild(),
): Run {
  const root = privateRoot();
  const kills: HolderProcess[] = [];
  const spawned: Run["spawned"] = [];
  let reads = 0;
  const spec = { terminalId: "term_1", socket: holderSocket(root, "term_1"), argv: ["sh"] };
  const start = startHolderWith(
    { binary: BINARY, root, spec, env: {}, readyMs: 2_000, ...options },
    {
      spawn: (file, args, { env }) => {
        spawned.push({ file, args, env });
        return child;
      },
      read: (pid) => {
        reads += 1;
        return read(pid);
      },
      kill: (proof) => {
        kills.push(proof);
        return true;
      },
    },
  );
  // Each test awaits it; a rejection seen first is not unhandled.
  start.catch(() => {});
  return { child, root, spec, kills, reads: () => reads, spawned, start };
}

const failureOf = (run: Run) =>
  run.start.then(
    () => null,
    (error: unknown) => error,
  );

const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

describe("starting a holder", () => {
  it("sends the spec on stdin and resolves on ready, leaving the holder unwaited for", async () => {
    const run = started(always(holderAt(START)));
    await expect.poll(() => run.child.sent).not.toBe("");
    run.child.stdout.write("ready\n");
    const holder = await run.start;
    expect(holder).toMatchObject({ pid: PID, start: START });
    expect([JSON.parse(run.child.sent), run.child.unrefed, run.kills]).toEqual([
      run.spec,
      true,
      [],
    ]);
    expect(run.spawned).toEqual([{ file: BINARY, args: [], env: {} }]);
    expect(statSync(holdersDir(run.root)).mode & 0o777).toBe(0o700);
  });

  it("fails with the exit code and stderr of a holder that exits first, and kills nothing", async () => {
    const run = started(always(holderAt(START)));
    await expect.poll(() => run.child.sent).not.toBe("");
    run.child.stderr.write("bazhen-holder: invalid spawn spec: no argv\n");
    run.child.exit(2);
    const failure = await failureOf(run);
    expect(failure).toBeInstanceOf(HolderStartFailed);
    expect(failure).toMatchObject({
      ending: { code: 2 },
      stderr: expect.stringContaining("no argv"),
      running: false,
    });
    expect([run.kills, run.reads()]).toEqual([[], 1]);
  });

  it("survives a holder that exits before it reads its spec, breaking the pipe", async () => {
    const child = new FakeChild();
    child.stdin.end = () => {
      child.stdin.emit("error", epipe());
      queueMicrotask(() => child.exit(9));
      return child.stdin;
    };
    const run = started(always(holderAt(START)), {}, child);
    await expect(failureOf(run)).resolves.toMatchObject({ ending: { code: 9 }, running: false });
    expect(run.kills).toEqual([]);
  });

  it("kills a holder that says anything but ready, once, by a proof for its pid and start", async () => {
    const run = started(always(holderAt(START)));
    await expect.poll(() => run.child.sent).not.toBe("");
    run.child.stdout.write("hello\n");
    await expect(failureOf(run)).resolves.toMatchObject({
      message: expect.stringContaining('saying "hello\\n"; it was killed'),
      running: false,
    });
    expect(run.kills).toEqual([{ pid: PID, start: START }]);
  });

  it("takes a first line no longer than it reads, rather than waiting on one that never ends", async () => {
    const run = started(always(holderAt(START)));
    await expect.poll(() => run.child.sent).not.toBe("");
    run.child.stdout.write("x".repeat(100));
    await expect(failureOf(run)).resolves.toMatchObject({
      message: expect.stringContaining(`saying "${"x".repeat(64)}"`),
    });
    expect(run.kills).toHaveLength(1);
  });

  it("keeps no more of stderr than it reports", async () => {
    const run = started(always(holderAt(START)));
    await expect.poll(() => run.child.sent).not.toBe("");
    run.child.stderr.write("e".repeat(20_000));
    run.child.exit(1);
    await expect(failureOf(run)).resolves.toMatchObject({ stderr: "e".repeat(8 * 1024) });
  });

  it("kills a silent holder once, and only after ps has shown it is the holder", async () => {
    const run = started(always(holderAt(START)), { readyMs: 50 });
    await expect(failureOf(run)).resolves.toMatchObject({ ending: "silent", running: false });
    expect([run.kills, run.reads()]).toEqual([[{ pid: PID, start: START }], 2]);
  });

  it("leaves a stranger at the holder's pid alone, names it, and says it may still run", async () => {
    const run = started(readsThen(holderAt(START), stranger), { readyMs: 50 });
    await expect(failureOf(run)).resolves.toMatchObject({
      message: expect.stringContaining(`pid ${PID} is left running`),
      running: true,
    });
    expect(run.kills).toEqual([]);
  });

  it("leaves a holder alone whose start no longer matches, as a reused pid's wouldn't", async () => {
    const run = started(readsThen(holderAt(START), holderAt(START + 60)), { readyMs: 50 });
    await expect(failureOf(run)).resolves.toMatchObject({ running: true });
    expect(run.kills).toEqual([]);
  });

  it("fails a binary that can't be run, as one that never started", async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const run = started(always(holderAt(START)), {}, child);
    child.emit("error", new Error("spawn /opt/bazhen/bazhen-holder ENOENT"));
    await expect(failureOf(run)).resolves.toMatchObject({
      ending: "unstarted",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it("ends a holder whose recording fails, before it reads its spec, with that as the cause", async () => {
    const recorded: unknown[] = [];
    const child = new FakeChild();
    const noLedger = new Error("no ledger");
    const run = started(
      always(holderAt(START)),
      {
        readyMs: 50,
        onStarted: (holder) => {
          recorded.push([holder, child.sent]);
          throw noLedger;
        },
      },
      child,
    );
    const failure = await failureOf(run);
    expect(failure).toBeInstanceOf(HolderStartFailed);
    expect(failure).toMatchObject({ cause: noLedger });
    expect([recorded, child.stdinEnded, run.kills]).toEqual([
      [[{ pid: PID, start: START }, ""]],
      true,
      [{ pid: PID, start: START }],
    ]);
  });

  it("runs the binary under its CPU limit through a fixed shell that execs it", async () => {
    const run = started(always(holderAt(START)), {
      env: { PATH: "/bin" },
      limits: { cpuSeconds: 10 },
    });
    await expect.poll(() => run.child.sent).not.toBe("");
    run.child.stdout.write("ready\n");
    await run.start;
    expect(run.spawned).toEqual([
      {
        file: "/bin/sh",
        args: ["-c", 'ulimit -t 10 && exec "$0" "$@"', BINARY],
        env: { PATH: "/bin" },
      },
    ]);
  });

  it("kills nothing when the holder exits while ps is read to vouch for it", async () => {
    const child = new FakeChild();
    const read = inTurn(
      () => holderAt(START),
      () => (child.exit(137), holderAt(START)),
    );
    const run = started(read, { readyMs: 50 }, child);
    await expect(failureOf(run)).resolves.toMatchObject({ running: false });
    expect(run.kills).toEqual([]);
  });

  it("says a holder ps can't read as it starts may still run, and never calls it silent", async () => {
    const run = started(always("unreadable"), { readyMs: 50 });
    await expect(failureOf(run)).resolves.toMatchObject({ ending: "unchecked", running: true });
    expect([run.kills, run.child.stdinEnded]).toEqual([[], true]);
  });

  it("says one ps can't read but that exits once it finds no spec has ended", async () => {
    const child = new FakeChild();
    child.stdin.once("finish", () => queueMicrotask(() => child.exit(2)));
    const run = started(always("unreadable"), { readyMs: 50 }, child);
    await expect(failureOf(run)).resolves.toMatchObject({ ending: { code: 2 }, running: false });
  });
});

/** What `startHolderWith` throws for `options`, having spawned nothing. */
async function refused(options: Partial<StartHolderOptions>, root = privateRoot()) {
  let spawned = 0;
  const spawn = () => {
    spawned += 1;
    return new FakeChild();
  };
  const spec = { terminalId: "term_1", socket: holderSocket(root, "term_1") };
  const error = await startHolderWith(
    { binary: BINARY, root, spec, env: {}, ...options },
    { spawn },
  ).then(
    () => null,
    (e: unknown) => e,
  );
  return { spawned, error: String(error) };
}

describe("refusing to start a holder, before anything is spawned", () => {
  it("refuses a socket outside the run root's holders directory", async () => {
    const root = privateRoot();
    const spec = { terminalId: "term_1", socket: join(root, "term_1.sock") };
    expect(await refused({ spec }, root)).toEqual({
      spawned: 0,
      error: expect.stringMatching(/refusing holder socket/),
    });
  });

  it("refuses a run root or a holders directory others can enter, or a link for one", async () => {
    const open = privateRoot();
    chmodSync(open, 0o755);
    const openDir = privateRoot();
    mkdirSync(holdersDir(openDir));
    chmodSync(holdersDir(openDir), 0o755);
    const linked = privateRoot();
    symlinkSync(privateRoot(), holdersDir(linked));
    const results = [
      await refused({}, open),
      await refused({}, openDir),
      await refused({}, linked),
    ];
    expect(results).toEqual([
      { spawned: 0, error: expect.stringMatching(/open to other users/) },
      { spawned: 0, error: expect.stringMatching(/open to other users/) },
      { spawned: 0, error: expect.stringMatching(/not a directory/) },
    ]);
  });

  it("refuses a spec over what a holder reads, a relative binary, and a wait out of range", async () => {
    const root = privateRoot();
    const big = {
      terminalId: "term_1",
      socket: holderSocket(root, "term_1"),
      pad: "x".repeat(1 << 20),
    };
    const results = [
      await refused({ spec: big }, root),
      await refused({ binary: "bazhen-holder" }),
      await refused({ readyMs: 0 }),
      await refused({ readyMs: Number.NaN }),
      await refused({ limits: { cpuSeconds: 1.5 } }),
    ];
    expect(results).toEqual([
      { spawned: 0, error: expect.stringMatching(/over the 1048576/) },
      { spawned: 0, error: expect.stringMatching(/isn't absolute/) },
      { spawned: 0, error: expect.stringMatching(/readyMs/) },
      { spawned: 0, error: expect.stringMatching(/readyMs/) },
      { spawned: 0, error: expect.stringMatching(/cpuSeconds/) },
    ]);
  });
});

describe("telling a holder this process started to rebind", () => {
  const holder = { pid: PID, start: START };

  /** A holder started and said ready, and the rebinds sent to it. */
  async function readyHolder() {
    const sent: HolderProcess[] = [];
    const send = (proof: HolderProcess) => (sent.push(proof), true);
    const run = started(always(holderAt(START)));
    await expect.poll(() => run.child.sent).not.toBe("");
    return { run, sent, send };
  }

  it("sends nothing before it said ready or once it has exited, whatever ps says", async () => {
    const { run, sent, send } = await readyHolder();
    const before = await rebindHolderWith(holder, always(holderAt(START)), send);
    run.child.stdout.write("ready\n");
    await run.start;
    const ready = await rebindHolderWith(holder, always(holderAt(START)), send);
    run.child.exit(0);
    const after = await rebindHolderWith(holder, always(holderAt(START)), send);
    expect([before, ready, after, sent]).toEqual([false, true, false, [holder]]);
  });

  it("sends nothing to one that exits while ps is read", async () => {
    const { run, sent, send } = await readyHolder();
    run.child.stdout.write("ready\n");
    await run.start;
    const exitsMeanwhile = async () => {
      run.child.exit(0);
      return holderAt(START);
    };
    expect([await rebindHolderWith(holder, exitsMeanwhile, send), sent]).toEqual([false, []]);
  });
});
