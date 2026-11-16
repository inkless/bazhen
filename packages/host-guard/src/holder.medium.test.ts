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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HolderChild,
  HolderStartFailed,
  holderSocket,
  holdersDir,
  rebindHolderWith,
  type StartHolderOptions,
  startHolderWith,
  UNKNOWN_START,
} from "./holder.ts";
import type { HolderProcess } from "./signal.ts";
import type { PsReading } from "./tmux.ts";

// Above every system's pid limit, so even a broken guard reaches no process.
const PID = 2 ** 22 + 1;
const START = 1_794_630_000;
/** A regular file named as the holder is, which nothing here runs: the spawn is a fake. */
const BINARY_DIR = mkdtempSync(join(tmpdir(), "bz-hg-bin-"));
const BINARY = join(BINARY_DIR, "bazhen-holder");
writeFileSync(BINARY, "", { mode: 0o755 });
afterAll(() => rmSync(BINARY_DIR, { recursive: true, force: true }));

/** A child that does what each test says, and records what it was sent. */
class FakeChild extends EventEmitter implements HolderChild {
  pid: number | undefined = PID;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  unrefed = false;
  sent = "";
  stdinEnded = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** The signals sent through its own handle; none reaches a process. */
  readonly signalled: NodeJS.Signals[] = [];

  constructor() {
    super();
    this.stdin.setEncoding("utf8").on("data", (chunk: string) => (this.sent += chunk));
    this.stdin.once("finish", () => (this.stdinEnded = true));
  }

  unref(): void {
    this.unrefed = true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signalled.push(signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
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

  it("says a holder ps can't read as it starts may still run, and records it for a person", async () => {
    const recorded: unknown[] = [];
    const run = started(always("unreadable"), {
      readyMs: 50,
      onStarted: (holder) => void recorded.push(holder),
    });
    await expect(failureOf(run)).resolves.toMatchObject({ ending: "unchecked", running: true });
    expect([run.kills, run.child.stdinEnded, run.child.sent, recorded]).toEqual([
      [],
      true,
      "",
      [{ pid: PID, start: UNKNOWN_START }],
    ]);
    expect(run.reads()).toBeGreaterThan(1);
  });

  it("asks ps again when it fails at first, and starts the holder once it reads", async () => {
    const recorded: unknown[] = [];
    const run = started(
      inTurn(
        () => "unreadable",
        () => holderAt(START),
      ),
      { onStarted: (holder) => void recorded.push(holder) },
    );
    await expect.poll(() => run.child.sent).not.toBe("");
    run.child.stdout.write("ready\n");
    await expect(run.start).resolves.toMatchObject({ pid: PID, start: START });
    expect(recorded).toEqual([{ pid: PID, start: START }]);
  });

  it("says one ps can't read but that exits once it finds no spec has ended", async () => {
    const child = new FakeChild();
    child.stdin.once("finish", () => queueMicrotask(() => child.exit(2)));
    const run = started(always("unreadable"), { readyMs: 50 }, child);
    await expect(failureOf(run)).resolves.toMatchObject({ ending: { code: 2 }, running: false });
  });

  it("runs under a CPU limit of 1 second or of a day, the bounds it takes", async () => {
    const shells: unknown[] = [];
    for (const cpuSeconds of [1, 86_400]) {
      const run = started(always(holderAt(START)), { limits: { cpuSeconds } });
      await expect.poll(() => run.child.sent).not.toBe("");
      run.child.stdout.write("ready\n");
      await run.start;
      shells.push(run.spawned[0]?.args[1]);
    }
    expect(shells).toEqual(['ulimit -t 1 && exec "$0" "$@"', 'ulimit -t 86400 && exec "$0" "$@"']);
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

describe("starting a holder in a scope of its own", () => {
  const SYSTEMD_RUN = "/usr/bin/systemd-run";
  const scope = {
    argv: [SYSTEMD_RUN, "--user", "--scope", "--unit=bazhen-terminal-term_1-ab.scope", "--"],
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
  } as const;
  const launcherAt = (start: number): PsReading => ({
    comm: "systemd-run",
    start,
    args: `${SYSTEMD_RUN} --user --scope -- ${BINARY}`,
  });
  /** `ps` showing the launcher until `at`, in epoch ms, and the holder it execs from then on. */
  const execsAt = (at: number) => async () =>
    Date.now() < at ? launcherAt(START) : holderAt(START);

  it("runs the scope's launcher first, which execs the CPU limit's shell, which execs it", async () => {
    const run = started(always(holderAt(START)), {
      env: { PATH: "/bin" },
      limits: { cpuSeconds: 10 },
      scope,
    });
    await expect.poll(() => run.child.sent).not.toBe("");
    run.child.stdout.write("ready\n");
    await run.start;
    expect(run.spawned).toEqual([
      {
        file: SYSTEMD_RUN,
        args: [...scope.argv.slice(1), "/bin/sh", "-c", 'ulimit -t 10 && exec "$0" "$@"', BINARY],
        env: { PATH: "/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
      },
    ]);
  });

  it("records and returns the spawned pid with its start, which the exec keeps, as the holder's", async () => {
    const recorded: HolderProcess[] = [];
    const run = started(
      inTurn(
        () => launcherAt(START),
        () => holderAt(START),
      ),
      { scope, onStarted: (holder) => void recorded.push(holder) },
    );
    await expect.poll(() => run.child.sent).not.toBe("");
    run.child.stdout.write("ready\n");
    await expect(run.start).resolves.toMatchObject({ pid: PID, start: START });
    expect(recorded).toEqual([{ pid: PID, start: START }]);
    expect(run.spawned.map((spawn) => spawn.file)).toEqual([SYSTEMD_RUN]);
  });

  it("gives a launcher that hasn't exec'd the holder in time no spec, and ends it by its own handle", async () => {
    const run = started(always(launcherAt(START)), { scope, launchMs: 100 });
    await expect(failureOf(run)).resolves.toMatchObject({
      ending: "unlaunched",
      message: expect.stringContaining(`pid ${PID} was sent SIGKILL`),
      running: true,
    });
    expect([run.child.sent, run.child.stdinEnded, run.child.signalled]).toEqual([
      "",
      true,
      ["SIGKILL"],
    ]);
    expect(run.kills).toEqual([]);
    expect(run.spawned.map((spawn) => spawn.file)).toEqual([SYSTEMD_RUN]);
  });

  it("writes the spec only once ps shows the holder exec'd, and times ready from then", async () => {
    const execAt = Date.now() + 300;
    let sentAt = 0;
    const child = new FakeChild();
    child.stdin.once("data", () => (sentAt = Date.now()));
    const run = started(execsAt(execAt), { scope, readyMs: 150 }, child);
    await expect.poll(() => run.child.sent, { timeout: 2_000 }).not.toBe("");
    run.child.stdout.write("ready\n");
    await expect(run.start).resolves.toMatchObject({ pid: PID, start: START });
    expect(sentAt).toBeGreaterThanOrEqual(execAt);
  });

  it("fails with the launcher's exit and stderr when systemd can't make the scope", async () => {
    const run = started(always(launcherAt(START)), { scope });
    run.child.stderr.write("Failed to start transient scope unit: Unit already exists.\n");
    run.child.exit(1);
    await expect(failureOf(run)).resolves.toMatchObject({
      ending: { code: 1 },
      stderr: expect.stringContaining("Failed to start transient scope unit"),
      running: false,
    });
    expect([run.kills, run.child.signalled, run.child.sent]).toEqual([[], [], ""]);
    expect(run.spawned.map((spawn) => spawn.file)).toEqual([SYSTEMD_RUN]);
  });

  it("refuses a launcher that isn't an absolute path, before spawning", async () => {
    const run = started(always(holderAt(START)), {
      scope: { argv: ["systemd-run", "--user", "--scope", "--"], env: {} },
    });
    await expect(failureOf(run)).resolves.toBeInstanceOf(RangeError);
    expect(run.spawned).toEqual([]);
  });
});

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
      await refused({ limits: { cpuSeconds: 0 } }),
      await refused({ limits: { cpuSeconds: -0 } }),
      await refused({ limits: { cpuSeconds: 86_401 } }),
      await refused({ limits: { cpuSeconds: Number.NaN } }),
    ];
    expect(results).toEqual([
      { spawned: 0, error: expect.stringMatching(/over the 1048576/) },
      { spawned: 0, error: expect.stringMatching(/isn't absolute/) },
      { spawned: 0, error: expect.stringMatching(/readyMs/) },
      { spawned: 0, error: expect.stringMatching(/readyMs/) },
      { spawned: 0, error: expect.stringMatching(/cpuSeconds/) },
      { spawned: 0, error: expect.stringMatching(/cpuSeconds/) },
      { spawned: 0, error: expect.stringMatching(/cpuSeconds/) },
      { spawned: 0, error: expect.stringMatching(/cpuSeconds/) },
      { spawned: 0, error: expect.stringMatching(/cpuSeconds/) },
    ]);
  });

  it("refuses a binary that isn't a regular file named as the holder, or links elsewhere", async () => {
    const links = privateRoot();
    const toShell = join(links, "bazhen-holder");
    symlinkSync("/bin/sh", toShell);
    const dirNamed = join(privateRoot(), "bazhen-holder");
    mkdirSync(dirNamed);
    const results = [
      await refused({ binary: "/bin/sh" }),
      await refused({ binary: toShell }),
      await refused({ binary: dirNamed }),
      await refused({ binary: join(privateRoot(), "bazhen-holder") }),
    ];
    expect(results).toEqual([
      { spawned: 0, error: expect.stringMatching(/isn't named bazhen-holder/) },
      { spawned: 0, error: expect.stringMatching(/links to/) },
      { spawned: 0, error: expect.stringMatching(/isn't a regular file/) },
      { spawned: 0, error: expect.stringMatching(/doesn't exist/) },
    ]);
  });

  it("refuses a binary every user may write, who would choose what the next holder runs", async () => {
    const dir = privateRoot();
    const binary = join(dir, "bazhen-holder");
    writeFileSync(binary, "");
    const refusals = [];
    for (const mode of [0o757, 0o777]) {
      chmodSync(binary, mode);
      refusals.push(await refused({ binary }));
    }
    expect(refusals).toEqual([
      { spawned: 0, error: expect.stringMatching(/every user may write it/) },
      { spawned: 0, error: expect.stringMatching(/every user may write it/) },
    ]);
  });

  it("refuses an environment name that isn't a plain identifier, which a shell could run", async () => {
    const env = { PATH: "/bin", "BASH_FUNC_ulimit%%": "() { :; }" };
    expect(await refused({ env })).toEqual({
      spawned: 0,
      error: expect.stringMatching(/BASH_FUNC_ulimit%%/),
    });
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
