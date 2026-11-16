import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  type HolderChild,
  HolderStartFailed,
  holderSocket,
  holdersDir,
  startHolder,
  type StartSeams,
} from "./holder.ts";
import type { PsReading } from "./tmux.ts";

// Above every system's pid limit, so even a broken guard reaches no process.
const PID = 2 ** 22 + 1;
const START = 1_794_630_000;

/** A child that does what each test says, and records what it was sent. */
class FakeChild extends EventEmitter implements HolderChild {
  readonly pid: number | undefined = PID;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  unrefed = false;
  sent = "";

  constructor() {
    super();
    this.stdin.setEncoding("utf8").on("data", (chunk: string) => (this.sent += chunk));
  }

  unref(): void {
    this.unrefed = true;
  }

  exit(code: number | null, signal: string | null = null): void {
    this.stderr.end();
    this.emit("exit", code, signal);
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bz-hg-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

const holderAt = (start: number): PsReading => ({
  comm: "/opt/bazhen/bazhen-holder",
  start,
  args: "bazhen-holder",
});

function started(child: FakeChild, read: (pid: number) => Promise<PsReading>, readyMs = 2_000) {
  const root = privateRoot();
  const spawned: { file: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const seams: StartSeams = {
    spawn: (file, args, { env }) => {
      spawned.push({ file, args, env });
      return child;
    },
    read,
  };
  const spec = { terminalId: "term_1", socket: holderSocket(root, "term_1"), argv: ["sh"] };
  const options = { binary: "/opt/bazhen/bazhen-holder", root, spec, env: {}, readyMs };
  return { root, spec, spawned, start: startHolder(options, seams) };
}

const always = (reading: PsReading) => async () => reading;
/** `ps` showing `first`, then `then` from the next read on, as a pid reused meanwhile would. */
const readsThen = (first: PsReading, then: PsReading) => {
  const readings = [first];
  return async () => readings.shift() ?? then;
};

describe("starting a holder", () => {
  it("sends the spec on stdin and resolves on ready, leaving the holder unwaited for", async () => {
    const child = new FakeChild();
    const run = started(child, always(holderAt(START)));
    await expect.poll(() => child.sent).not.toBe("");
    child.stdout.write("ready\n");
    const holder = await run.start;
    expect([holder.pid, holder.start, JSON.parse(child.sent), child.unrefed]).toEqual([
      PID,
      START,
      run.spec,
      true,
    ]);
    expect(run.spawned).toEqual([{ file: "/opt/bazhen/bazhen-holder", args: [], env: {} }]);
    expect(statSync(holdersDir(run.root)).mode & 0o777).toBe(0o700);
  });

  it("fails with the exit code and stderr of a holder that exits first", async () => {
    const child = new FakeChild();
    const run = started(child, always(holderAt(START)));
    await expect.poll(() => child.sent).not.toBe("");
    child.stderr.write("bazhen-holder: invalid spawn spec: no argv\n");
    child.exit(2);
    const failure = await run.start.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HolderStartFailed);
    expect(failure).toMatchObject({
      ending: { code: 2 },
      stderr: expect.stringContaining("no argv"),
    });
  });

  it("fails a holder that says anything but ready, and ends the one ps shows is it", async () => {
    const child = new FakeChild();
    const run = started(child, always(holderAt(START)));
    await expect.poll(() => child.sent).not.toBe("");
    child.stdout.write("hello\n");
    // The pid is above any system's limit, so the kill finds no process: as one that just exited.
    await expect(run.start).rejects.toThrow(/saying "hello\\n"/);
  });

  it("fails a silent holder, and kills it only once ps shows it is the holder", async () => {
    const child = new FakeChild();
    const readings = [holderAt(START)];
    let reads = 0;
    const read = async () => {
      reads += 1;
      return readings[0]!;
    };
    const run = started(child, read, 50);
    const failure = await run.start.catch((error: unknown) => error);
    expect(failure).toMatchObject({ ending: "silent", running: false });
    expect(String(failure)).not.toMatch(/left running/);
    expect(reads).toBe(2);
  });

  it("leaves a stranger at the holder's pid alone, and names it", async () => {
    const child = new FakeChild();
    const read = readsThen(holderAt(START), { comm: "sleep", start: START, args: "sleep 300" });
    const run = started(child, read, 50);
    await expect(run.start).rejects.toMatchObject({
      message: expect.stringContaining(`pid ${PID} is left running`),
      running: true,
    });
  });

  it("leaves a holder alone whose start no longer matches, as a reused pid's wouldn't", async () => {
    const child = new FakeChild();
    const read = readsThen(holderAt(START), holderAt(START + 60));
    const run = started(child, read, 50);
    await expect(run.start).rejects.toThrow(`pid ${PID} is left running`);
  });

  it("refuses a socket outside the run root's holders directory, starting nothing", async () => {
    const root = privateRoot();
    let spawned = 0;
    const spawn = () => {
      spawned += 1;
      return new FakeChild();
    };
    const spec = { terminalId: "term_1", socket: join(root, "term_1.sock") };
    const options = { binary: "/opt/bazhen-holder", root, spec, env: {} };
    await expect(startHolder(options, { spawn })).rejects.toThrow(/refusing holder socket/);
    expect(spawned).toBe(0);
  });

  it("refuses a run root other users can enter, starting nothing", async () => {
    const root = privateRoot();
    chmodSync(root, 0o755);
    let spawned = 0;
    const spawn = () => {
      spawned += 1;
      return new FakeChild();
    };
    const spec = { terminalId: "term_1", socket: holderSocket(root, "term_1") };
    const options = { binary: "/opt/bazhen-holder", root, spec, env: {} };
    await expect(startHolder(options, { spawn })).rejects.toThrow(/open to other users/);
    expect(spawned).toBe(0);
  });

  it("records the holder before it reads its spec, and ends it when recording fails", async () => {
    const child = new FakeChild();
    const root = privateRoot();
    const spec = { terminalId: "term_1", socket: holderSocket(root, "term_1") };
    const recorded: unknown[] = [];
    const options = {
      binary: "/opt/bazhen-holder",
      root,
      spec,
      env: {},
      readyMs: 50,
      onStarted: (holder: unknown) => {
        recorded.push([holder, child.sent]);
        throw new Error("no ledger");
      },
    };
    const seams = { spawn: () => child, read: always(holderAt(START)) };
    await expect(startHolder(options, seams)).rejects.toThrow("no ledger");
    expect(recorded).toEqual([[{ pid: PID, start: START }, ""]]);
  });

  it("fails a binary that can't be run, as one that never started", async () => {
    const child = Object.assign(new FakeChild(), { pid: undefined });
    const run = started(child, always(holderAt(START)));
    child.emit("error", new Error("spawn /opt/bazhen/bazhen-holder ENOENT"));
    await expect(run.start).rejects.toMatchObject({
      ending: "unstarted",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it("runs a launcher with the binary as its last argument", async () => {
    const child = new FakeChild();
    const root = privateRoot();
    const spec = { terminalId: "term_1", socket: holderSocket(root, "term_1") };
    const spawned: unknown[] = [];
    const options = {
      binary: "/opt/bazhen-holder",
      root,
      spec,
      env: { PATH: "/bin" },
      launcher: ["sh", "-c", 'exec "$0"'] as const,
    };
    const seams: StartSeams = {
      spawn: (file, args, { env }) => {
        spawned.push([file, args, env]);
        return child;
      },
      read: always(holderAt(START)),
    };
    const start = startHolder(options, seams);
    await expect.poll(() => child.sent).not.toBe("");
    child.stdout.write("ready\n");
    await start;
    expect(spawned).toEqual([["sh", ["-c", 'exec "$0"', "/opt/bazhen-holder"], { PATH: "/bin" }]]);
  });
});
