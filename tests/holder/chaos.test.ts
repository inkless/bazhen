// Holders under the faults a daemon's machine deals them, with real holders and a real process on
// the daemon's side of their sockets.
//
// That process is tests/support/stand-in-daemon.ts, not the daemon. It runs the daemon's own
// holder code, HolderRuntime, attaching and attaching again as the daemon's hub does, so what
// crosses the sockets is what the daemon sends and reads. A daemon that starts again attaches
// to a snapshot, so each attach is checked whole: its output starts where its snapshot ends, and
// its snapshot draws what all the output before it does. The daemon's own bookkeeping across a
// crash (which terminals it finds again, which agents it calls lost) is
// tests/api/runtimes.test.ts's, with a real daemon.
//
// Every signal goes through tests/support/holder-spawn.ts to a process this file started: a
// stand-in's own group, or a holder vouched for by its pid and start. Every wait is for something
// to happen, never for time to pass, and stops early once what it waits for can't happen, so a
// fault fails on the assertion it breaks; each gives up after a generous cap, naming what it
// waited for.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import headless from "@xterm/headless";
import { HolderRuntime, connectHolder } from "@bazhen/runtime-holder";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holderEnv, holderTerminalSpec, testHome, userDir } from "../support/holder-home.ts";
import {
  closeHolder,
  cpuSeconds,
  HOLDER_BINARY,
  holderStarter,
  killTestHolder,
  type SpawnedHolder,
  type StandInOptions,
  type StandInProcess,
  startStandIn,
} from "../support/holder-spawn.ts";

type Ref = Awaited<ReturnType<HolderRuntime["create"]>>;

const SIZE = { cols: 80, rows: 24 };
const MiB = 1 << 20;
/** How long any one thing a case waits for may take before the case fails naming it. */
const WAIT_MS = 20_000;
/** A case's own limit: several waits' worth, so a wait's cap, not the case's, says what failed. */
const CASE_MS = 120_000;
/**
 * CPU-seconds each holder here may use. A flooded holder spends CPU for as long as its child
 * floods, which the cases bound by bytes, not time; past this it dies of SIGXCPU.
 */
const CPU_SECONDS = 60;
/** The most lines a flood prints, so one never stopped still ends. */
const LINES = 8_000_000;

/**
 * Waits for `done`, or for `hopeless` to name a reason it never will be, which the caller then
 * asserts on. Not `expect.poll`, which can't stop early: a wait for a holder that has died would
 * run out its time and fail as a timeout, not on the assertion that names what broke.
 */
async function until(
  done: () => boolean | Promise<boolean>,
  what: string,
  hopeless: () => unknown[] = () => [],
) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await done()) && hopeless().length === 0) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((wait) => setTimeout(wait, 20));
  }
}

// `seq`'s output through a terminal that turns each newline into CRLF: line n is `${n}\r\n`, so
// the lines of d digits, 9·10^(d-1) of them, are d + 2 bytes each.

/** The line holding byte `offset` of `seq`'s output, and where that line starts. */
function lineAt(offset: number): { line: number; start: number } {
  let start = 0;
  let line = 1;
  for (let digits = 1; ; digits++) {
    const count = 9 * 10 ** (digits - 1);
    if (offset < start + count * (digits + 2)) {
      const into = Math.floor((offset - start) / (digits + 2));
      return { line: line + into, start: start + into * (digits + 2) };
    }
    start += count * (digits + 2);
    line += count;
  }
}

/** Where line `n` of `seq`'s output starts. */
function lineStart(n: number): number {
  let start = 0;
  let line = 1;
  for (let digits = 1; ; digits++) {
    const count = 9 * 10 ** (digits - 1);
    if (n < line + count) return start + (n - line) * (digits + 2);
    start += count * (digits + 2);
    line += count;
  }
}

/** Bytes `from` to `to` of `seq`'s output. */
function seqBytes(from: number, to: number): Buffer {
  const { line, start } = lineAt(from);
  const parts: string[] = [];
  let length = 0;
  for (let n = line; start + length < to; n++) {
    const text = `${n}\r\n`;
    parts.push(text);
    length += text.length;
  }
  return Buffer.from(parts.join("")).subarray(from - start, to - start);
}

/** The screen a browser's terminal shows after `bytes`: its rows and its cursor. */
async function screen(bytes: Uint8Array) {
  const term = new headless.Terminal({ ...SIZE, allowProposedApi: true });
  await new Promise<void>((done) => term.write(bytes, done));
  const buffer = term.buffer.active;
  const rows = Array.from({ length: SIZE.rows }, (_, y) =>
    (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "").trimEnd(),
  );
  term.dispose();
  return { rows, cursor: [buffer.cursorX, buffer.cursorY] };
}

/** The screen `seq`'s output up to `offset` leaves, drawn from far enough back to fill it. */
const seqScreen = (offset: number) =>
  screen(seqBytes(lineStart(Math.max(1, lineAt(offset).line - SIZE.rows * 2)), offset));

/** One attach a stand-in made: its snapshot, the output after it, and how its stream ended. */
interface Attach {
  readonly offset: number;
  readonly vt: Buffer;
  readonly data: Buffer[];
  closed: string | null;
}

const attachEnd = (attach: Attach | undefined) =>
  attach === undefined ? 0 : attach.offset + Buffer.concat(attach.data).length;

type Line = { t: string; type: string; [field: string]: unknown };
const isLine = (value: unknown): value is Line =>
  typeof value === "object" && value !== null && "t" in value && "type" in value;

/** A stand-in daemon on `refs`, and what it printed of each terminal. */
class StandIn {
  readonly attaches = new Map<string, Attach[]>();
  /** Each terminal it was refused an attach to. */
  readonly refused = new Map<string, string>();
  readonly process: StandInProcess;
  readonly received = new Map<string, number>();
  exhausted = false;
  freed = false;
  /**
   * A line that isn't JSON. Only a stand-in killed mid-line prints one, as its very last, which
   * the pipe still hands over as it closes; one with anything after it is a fault.
   */
  private torn: string | null = null;
  private readonly misread: string[] = [];
  /** Failures its HolderRuntime reported with no caller waiting on them, which nothing should. */
  private readonly errors: string[] = [];

  constructor(refs: readonly Ref[], options?: StandInOptions) {
    this.process = startStandIn(root, refs, (line) => this.read(line), options);
  }

  private read(text: string): void {
    if (this.torn !== null)
      this.misread.push(`a line that isn't JSON came before ${text.slice(0, 80)}`);
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      this.torn = text;
      return;
    }
    if (!isLine(line)) return;
    const of = this.attaches.get(line.t) ?? [];
    const last = of.at(-1);
    if (line.type === "attached") {
      const vt = Buffer.from(String(line["vt"]), "base64");
      of.push({ offset: Number(line["offset"]), vt, data: [], closed: null });
      this.attaches.set(line.t, of);
    } else if (line.type === "data" && last !== undefined) {
      const bytes = Buffer.from(String(line["bytes"]), "base64");
      last.data.push(bytes);
      this.received.set(line.t, (this.received.get(line.t) ?? 0) + bytes.length);
    } else if (line.type === "closed" && last !== undefined) {
      last.closed = String(line["why"]);
    } else if (line.type === "refused") {
      this.refused.set(line.t, String(line["error"]));
    } else if (line.type === "exhausted") {
      this.exhausted = true;
    } else if (line.type === "freed") {
      this.freed = true;
    } else if (line.type === "error") {
      this.errors.push(`the runtime reported ${String(line["error"])}`);
    }
  }

  /** Output bytes it has printed of `ref`, every attach together, or of every terminal. */
  bytes(ref?: Ref): number {
    if (ref !== undefined) return this.received.get(ref.terminalId) ?? 0;
    return [...this.received.values()].reduce((sum, n) => sum + n, 0);
  }

  /** Where its latest attach to `ref` has reached. */
  reached(ref: Ref): number {
    return attachEnd(this.attaches.get(ref.terminalId)?.at(-1));
  }

  /**
   * Lines it printed that broke its protocol, failures its runtime reported, and the attaches
   * refused it, as `<terminal>: <why>`.
   */
  troubles(): string[] {
    const refused = [...this.refused].map(([t, why]) => `${t}: ${why}`);
    return [...this.misread, ...this.errors, ...refused];
  }
}

const running = new Set<StandIn>();
const started: SpawnedHolder[] = [];
let root: string;
let files: string;
let runtime: HolderRuntime;

beforeAll(() => {
  root = join(testHome(), "chaos");
  files = join(userDir(testHome()), "chaos");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(files);
  runtime = new HolderRuntime({
    root,
    binary: HOLDER_BINARY,
    env: holderEnv(),
    exitPollMs: 50,
    start: holderStarter(started, undefined, CPU_SECONDS),
  });
});

afterAll(async () => {
  await Promise.all([...running].map((made) => kill(made)));
  await Promise.allSettled(started.map((holder) => closeHolder(holder)));
});

function standIn(refs: readonly Ref[], options?: StandInOptions): StandIn {
  const made = new StandIn(refs, options);
  running.add(made);
  return made;
}

async function kill(made: StandIn): Promise<void> {
  running.delete(made);
  made.process.signal("SIGKILL");
  await made.process.done;
}

const file = (name: string) => join(files, name);

/**
 * A terminal that floods `seq`'s output until `<name>.stop` exists, at most `LINES` lines, then
 * writes the last line it printed to `<name>.done` and sleeps. A hangup while it floods is written
 * to `<name>.hup`. Printed by awk, which prints an integer as one: macOS's seq prints 1000000 and
 * on as `1e+06`.
 */
function flooder(name: string): Promise<Ref> {
  const chunk = 100_000;
  const script =
    // Whatever reaches the terminal's input is kept in `<name>.in`, not echoed into the output,
    // and passed on byte by byte rather than a line at a time. A job of a shell without job
    // control reads /dev/null unless told otherwise, so the terminal is handed to it on fd 3.
    // The terminal passes output on as it is: a BSD one, as macOS's, whose output queue fills
    // between the carriage return it adds to a newline and the newline writes the carriage
    // return again, so each line prints its own.
    `stty -echo -icanon min 1 -onlcr; exec 3<&0; cat <&3 > "${file(`${name}.in`)}" & exec 3<&-; ` +
    `trap 'echo hup >> "${file(`${name}.hup`)}"; exit 129' HUP; i=0; ` +
    `while [ ! -e "${file(`${name}.stop`)}" ] && [ $i -lt ${LINES / chunk} ]; do ` +
    `awk -v a=$((i*${chunk}+1)) -v b=$((i*${chunk}+${chunk})) ` +
    `'BEGIN { for (n = a; n <= b; n++) printf "%d\\r\\n", n }'; i=$((i+1)); done; ` +
    `echo $((i*${chunk})) > "${file(`${name}.part`)}"; ` +
    `mv "${file(`${name}.part`)}" "${file(`${name}.done`)}"; exec sleep 600`;
  return runtime.create(holderTerminalSpec(["sh", "-c", script]));
}

/** Where a flood writes the last line it printed, once it has stopped. */
const doneFile = (name: string) => file(`${name}.done`);

/**
 * Stops the floods `names`, whose terminals are `refs`, and returns where each one's output ends,
 * once its holder has read all of it: `seq` returns with its last lines still in the terminal.
 */
async function stopFloods(names: readonly string[], refs: readonly Ref[]): Promise<number[]> {
  for (const name of names) writeFileSync(file(`${name}.stop`), "");
  await expect
    .poll(() => names.filter((name) => !existsSync(doneFile(name))), { timeout: WAIT_MS })
    .toEqual([]);
  const ends = names.map((name) => lineStart(Number(readFileSync(doneFile(name), "utf8")) + 1));
  for (const [i, ref] of refs.entries()) {
    const end = ends[i] ?? 0;
    let at = 0;
    // A holder past the end can't come back to it, so the wait stops there and shows what's past.
    await until(
      async () => (at = (await hello(ref)).offset) === end,
      `${names[i]}'s holder reading to the end of its flood`,
      () => (at > end ? [at] : []),
    );
    const past = at === end ? "" : await outputBetween(ref, end - 80, at);
    expect({ at, past }).toEqual({ at: end, past: "" });
  }
  return ends;
}

/** What `ref`'s terminal printed from byte `from` to byte `to`, as JSON writes it. */
const outputBetween = async (ref: Ref, from: number, to: number) =>
  JSON.stringify((await readOutput(ref, Math.max(0, from), to)).toString("latin1"));

/**
 * `ref`'s output from byte `from` to byte `to`, or up to where its ring had already dropped some,
 * which a gap says.
 */
async function readOutput(ref: Ref, from: number, to: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let reached = from;
  let cut = false;
  const client = await connectHolder(socketOf(ref), {
    onEvent: (event) => {
      if (event.type === "gap") cut = true;
      if (event.type !== "data" || cut) return;
      chunks.push(Buffer.from(event.bytes));
      reached = event.offset + event.bytes.length;
    },
  });
  try {
    await client.subscribe({ generation: 0, offset: from });
    await until(() => reached >= to || cut, `the output to ${to}`);
    return Buffer.concat(chunks).subarray(0, to - from);
  } finally {
    client.end();
  }
}

/** Where `data`, output from byte `offset`, first departs from seq's, and what it says there. */
function departure(offset: number, data: Buffer): string | null {
  const seq = seqBytes(offset, offset + data.length);
  const at = data.findIndex((byte, k) => byte !== seq[k]);
  if (at === -1) return null;
  const there = JSON.stringify(data.subarray(Math.max(0, at - 20), at + 100).toString("latin1"));
  return `departs from seq's at ${offset + at}: ${there}`;
}

/** The floods of `names` that saw a hangup. */
const hungUp = (names: readonly string[]) =>
  names.filter((name) => existsSync(file(`${name}.hup`)));

/** What reached flood `name`'s input so far, which nothing should send it; "" for nothing. */
function inputTo(name: string): string {
  const path = file(`${name}.in`);
  const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  return bytes.length === 0
    ? ""
    : `${bytes.toString("hex")} ${JSON.stringify(bytes.toString("latin1"))}`;
}

/** How many bytes had reached flood `name`'s input so far. */
const inputLength = (name: string) =>
  existsSync(file(`${name}.in`)) ? readFileSync(file(`${name}.in`)).length : 0;

/**
 * A terminal that, once `go` exists, asks where its cursor is and keeps what it read in `reply`:
 * the answer, or nothing once 5 s pass with none.
 */
function prober(): Promise<Ref> {
  const script =
    `while [ ! -e "${file("go")}" ]; do sleep 0.05; done; stty raw -echo min 0 time 50; ` +
    `printf '\\033[6n'; dd bs=64 count=1 2>/dev/null > "${file("reply.part")}"; ` +
    `mv "${file("reply.part")}" "${file("reply")}"; exec sleep 600`;
  return runtime.create(holderTerminalSpec(["sh", "-c", script]));
}

/** A cursor position report, ESC [ row ; column R, as JSON writes it. */
const POSITION_REPORT = /^"\\u001b\[\d+;\d+R"$/;

async function statsOf(ref: Ref) {
  const client = await connectHolder(socketOf(ref), { onEvent: () => {} });
  try {
    return await client.stats();
  } finally {
    client.end();
  }
}

/**
 * Who answers at `ref`'s socket: its holder, its child, whether that exited, its engine's resets
 * and its output so far.
 */
async function hello(ref: Ref) {
  const client = await connectHolder(socketOf(ref), { onEvent: () => {} });
  const { engineResets } = await client.stats();
  client.end();
  const { holderPid, childPid, generation, exit, offset } = client.hello;
  return { holderPid, childPid, generation, exited: exit !== null, offset, engineResets };
}

/** What `hello` should say of a terminal it said `before` of, once its output reached `offset`. */
const unharmed = (before: Awaited<ReturnType<typeof hello>>, offset: number) => ({
  ...before,
  exited: false,
  engineResets: 0,
  offset,
});

/** What `hello` should say of the terminals it said `before` of, their outputs ending at `ends`. */
const allUnharmed = (before: Awaited<ReturnType<typeof hello>>[], ends: readonly number[]) =>
  before.map((was, i) => unharmed(was, ends[i] ?? 0));

/** The socket a terminal's holder binds. */
function socketOf(ref: Ref): string {
  const { socket } = ref.locator;
  if (socket === undefined) throw new Error(`${ref.terminalId} names no socket`);
  return socket;
}

/** What is wrong with `attaches`, in order: each must start where its snapshot does, and be `seq`. */
async function seamFaults(attaches: readonly Attach[]): Promise<string[]> {
  const faults: string[] = [];
  let previous = 0;
  for (const [i, attach] of attaches.entries()) {
    if (attach.offset < previous) faults.push(`attach ${i} went back to ${attach.offset}`);
    previous = attach.offset;
    const departs = departure(attach.offset, Buffer.concat(attach.data));
    if (departs !== null) faults.push(`attach ${i}'s output ${departs}`);
    const [drawn, expected] = await Promise.all([screen(attach.vt), seqScreen(attach.offset)]);
    if (JSON.stringify(drawn) !== JSON.stringify(expected)) {
      faults.push(`attach ${i}'s snapshot at ${attach.offset} draws ${JSON.stringify(drawn)}`);
    }
  }
  return faults;
}

/** Every attach the stand-ins in `seen` made to `ref`, oldest first. */
const attachesTo = (seen: readonly StandIn[], ref: Ref) =>
  seen.flatMap((daemon) => daemon.attaches.get(ref.terminalId) ?? []);

/** The holder a test started for `ref`. */
function holderOf(ref: Ref): SpawnedHolder {
  const holder = started.find((h) => h.socket === ref.locator.socket);
  if (holder === undefined) throw new Error(`no holder started for ${ref.terminalId}`);
  return holder;
}

/** CPU seconds the holder of `ref` used per MiB its child wrote while `flood` ran; null off Linux. */
async function cpuPerMiB(ref: Ref, flood: () => Promise<void>): Promise<number | null> {
  const pid = Number(ref.locator.holderPid);
  const [cpu, { offset }] = [cpuSeconds(pid), await hello(ref)];
  await flood();
  const [after, end] = [cpuSeconds(pid), (await hello(ref)).offset];
  if (cpu === null || after === null) return null;
  return (after - cpu) / ((end - offset) / MiB);
}

/** How much `ref`'s holder's resident set grew from `before`; 0 where the OS won't say. */
async function residentGrowth(ref: Ref, before: number | null): Promise<number> {
  const { rss } = await statsOf(ref);
  return rss === null || before === null ? 0 : rss - before;
}

describe("a daemon killed with -9 again and again while its terminals flood", () => {
  const ROUNDS = 6;
  const names = ["a", "b", "c"];

  it(
    "leaves every holder and child running, each attach whole, and queries answered meanwhile",
    { timeout: CASE_MS },
    async () => {
      const refs = await Promise.all(names.map(flooder));
      // Each flood read from its first byte, begun before its ring can have dropped any.
      const starts = refs.map((ref) => readOutput(ref, 0, MiB + MiB / 4));
      const probe = await prober();
      expect((await Promise.all(starts)).map((data) => departure(0, data))).toEqual(
        names.map(() => null),
      );
      const before = await Promise.all(refs.map(hello));
      const seen: StandIn[] = [];
      /** Bytes that had reached each flood's input after each round. */
      const arrived: number[][] = [];

      for (let round = 0; round < ROUNDS; round++) {
        const daemon = standIn(refs);
        seen.push(daemon);
        // Every flood read some, so each is attached and streaming when the kill lands.
        await until(
          () => refs.every((ref) => daemon.bytes(ref) >= MiB / 4),
          `round ${round}'s stand-in reading from every flood`,
          () => daemon.troubles(),
        );
        await kill(daemon);
        expect(daemon.troubles()).toEqual([]);
        arrived.push(names.map(inputLength));
      }
      // Nothing may write to a program's input as daemons die and attach; what did, and when.
      expect({ input: names.map(inputTo), arrived }).toEqual({
        input: names.map(() => ""),
        arrived: arrived.map(() => names.map(() => 0)),
      });
      // Checked before the floods stop, so a seam that's wrong is shown where it is.
      expect(await Promise.all(refs.map((ref) => seamFaults(attachesTo(seen, ref))))).toEqual(
        names.map(() => []),
      );

      // No daemon is on any socket: the floods stop, and the probe asks its question.
      writeFileSync(file("go"), "");
      await until(() => existsSync(file("reply")), "the probe's reply");
      expect(JSON.stringify(readFileSync(file("reply"), "latin1"))).toMatch(POSITION_REPORT);
      const ends = await stopFloods(names, refs);

      const last = standIn(refs);
      seen.push(last);
      await until(
        () => refs.every((ref) => last.attaches.has(ref.terminalId)),
        "the last stand-in attaching to every flood",
        () => last.troubles(),
      );
      await kill(last);
      expect(last.troubles()).toEqual([]);
      expect(refs.map((ref) => last.attaches.get(ref.terminalId)?.[0]?.offset)).toEqual(ends);

      expect(await Promise.all(refs.map(hello))).toEqual(allUnharmed(before, ends));
      expect(hungUp(names)).toEqual([]);
      expect(names.map(inputTo)).toEqual(names.map(() => ""));
      const attaches = refs.map((ref) => attachesTo(seen, ref));
      expect(attaches.map((of) => of.length > ROUNDS)).toEqual(names.map(() => true));
      expect(await Promise.all(attaches.map(seamFaults))).toEqual(names.map(() => []));
      expect((await hello(probe)).exited).toBe(false);
    },
  );
});

describe("a subscriber stopped with SIGSTOP while its terminal floods", () => {
  /** What the child writes while the subscriber is stopped: far past the ring and any buffer. */
  const STALL = 8 * MiB;
  /**
   * The most the holder's resident set may grow meanwhile: a stalled peer's output isn't kept,
   * and a holder that kept it would grow by most of `STALL`.
   */
  const MOST_GROWTH = 4 * MiB;

  it(
    "holds up neither the child nor the other subscriber, keeps the holder's memory bounded, and lets it catch up",
    { timeout: CASE_MS },
    async ({ annotate }) => {
      const ref = await flooder("s");
      const before = await hello(ref);

      const alone = await cpuPerMiB(ref, async () => {
        const from = (await hello(ref)).offset;
        await until(
          async () => (await hello(ref)).offset >= from + 4 * MiB,
          "the flood writing 4 MiB with no subscriber",
        );
      });

      const reader = standIn([ref]);
      const read = await cpuPerMiB(ref, async () => {
        const from = reader.bytes(ref);
        await until(
          () => reader.bytes(ref) >= from + 4 * MiB,
          "the reader reading 4 MiB",
          () => reader.troubles(),
        );
      });

      const stopped = standIn([ref]);
      await until(
        () => stopped.bytes(ref) >= MiB,
        "the second subscriber reading a MiB",
        () => stopped.troubles(),
      );
      const { rss } = await statsOf(ref);
      stopped.process.signal("SIGSTOP");
      const stoppedAt = (await hello(ref)).offset;
      const stalled = await cpuPerMiB(ref, async () => {
        await until(
          () => reader.reached(ref) >= stoppedAt + STALL,
          "the reader reading on past the stopped subscriber",
          () => reader.troubles(),
        );
      });
      const growth = await residentGrowth(ref, rss);
      expect(growth).toBeLessThan(MOST_GROWTH);
      // Caught up, by attaching again or by reading on, to where the reader was as it went on.
      const target = reader.reached(ref);
      stopped.process.signal("SIGCONT");
      await until(
        () => stopped.reached(ref) >= target,
        "the stopped subscriber catching up",
        () => stopped.troubles(),
      );
      const [end = 0] = await stopFloods(["s"], [ref]);
      await Promise.all([kill(reader), kill(stopped)]);

      // Measured, not asserted: what a flood costs the holder depends on the machine.
      const cpu = `holder CPU s per MiB written: ${JSON.stringify({ alone, read, stalled })}`;
      await annotate(cpu, "flood-cpu");
      console.log(`flood-cpu: ${cpu}; resident growth while stalled ${growth} bytes`);
      expect([reader.troubles(), stopped.troubles()]).toEqual([[], []]);
      expect(await hello(ref)).toEqual(unharmed(before, end));
      expect(hungUp(["s"])).toEqual([]);
      expect(inputTo("s")).toBe("");
      expect(await seamFaults(attachesTo([reader], ref))).toEqual([]);
      expect(await seamFaults(attachesTo([stopped], ref))).toEqual([]);
    },
  );
});

describe("one holder of several killed with -9", () => {
  it(
    "ends only its own terminal: the others stream on, their children untouched",
    { timeout: CASE_MS },
    async () => {
      const [a, b, c] = [await flooder("k1"), await flooder("k2"), await flooder("k3")];
      const refs = [a, b, c];
      const before = await Promise.all([a, c].map(hello));
      const daemon = standIn(refs);
      await until(
        () => refs.every((ref) => daemon.bytes(ref) >= MiB),
        "every flood read",
        () => daemon.troubles(),
      );

      await killTestHolder(holderOf(b));
      const marks = new Map([a, c].map((ref) => [ref, daemon.bytes(ref)]));
      await until(
        () => daemon.refused.has(b.terminalId),
        "the killed terminal's attach refused",
        () => [a, c].filter((ref) => daemon.refused.has(ref.terminalId)),
      );
      await until(
        () => [...marks].every(([ref, mark]) => daemon.bytes(ref) >= mark + MiB),
        "the others reading on",
        () => [a, c].filter((ref) => daemon.refused.has(ref.terminalId)),
      );
      const ends = await stopFloods(["k1", "k3"], [a, c]);
      await kill(daemon);

      expect([...daemon.refused.keys()]).toEqual([b.terminalId]);
      expect(await Promise.all(refs.map((ref) => runtime.gone(ref)))).toEqual([false, true, false]);
      expect(await Promise.all([a, c].map(hello))).toEqual(allUnharmed(before, ends));
      expect(hungUp(["k1", "k3"])).toEqual([]);
      expect(["k1", "k3"].map(inputTo)).toEqual(["", ""]);
      expect(await Promise.all(refs.map((ref) => seamFaults(attachesTo([daemon], ref))))).toEqual([
        [],
        [],
        [],
      ]);
    },
  );
});

describe("holder sockets deleted while their terminals flood", () => {
  const names = ["d1", "d2"];

  it(
    "are bound again, with the connections already open streaming on meanwhile",
    { timeout: CASE_MS },
    async () => {
      const refs = await Promise.all(names.map(flooder));
      const before = await Promise.all(refs.map(hello));
      const first = standIn(refs);
      await until(
        () => first.bytes() >= MiB,
        "the first stand-in reading a MiB",
        () => first.troubles(),
      );

      for (const ref of refs) unlinkSync(socketOf(ref));
      const mark = first.bytes();
      await until(
        () => first.bytes() >= mark + MiB,
        "the open connections streaming on",
        () => first.troubles(),
      );
      const health = await runtime.health(refs);
      await until(() => refs.every((ref) => existsSync(socketOf(ref))), "every socket bound again");
      await kill(first);

      const after = standIn(refs);
      await until(
        () => after.bytes() >= MiB,
        "a new stand-in reading a MiB",
        () => after.troubles(),
      );
      const ends = await stopFloods(names, refs);
      await kill(after);

      expect(health.state).not.toBe("not-running");
      expect([first.troubles(), after.troubles()]).toEqual([[], []]);
      expect(await Promise.all(refs.map(hello))).toEqual(allUnharmed(before, ends));
      expect(hungUp(names)).toEqual([]);
      expect(names.map(inputTo)).toEqual(names.map(() => ""));
      expect(
        await Promise.all(refs.map((ref) => seamFaults(attachesTo([first, after], ref)))),
      ).toEqual([[], []]);
    },
  );
});

describe("a daemon out of file descriptors", () => {
  const names = ["f1", "f2"];

  it(
    "is refused its attaches at once, harms no holder, and attaches whole once it has some again",
    { timeout: CASE_MS },
    async () => {
      const refs = await Promise.all(names.map(flooder));
      const before = await Promise.all(refs.map(hello));
      const daemon = standIn(refs, { exhaust: true, nofile: 256 });
      await until(() => daemon.freed, "the stand-in trying every attach with no descriptor free");
      const refused = [...daemon.refused.keys()];
      daemon.refused.clear();
      await until(
        () => daemon.bytes() >= MiB,
        "the stand-in reading once it has descriptors",
        () => daemon.troubles(),
      );
      const ends = await stopFloods(names, refs);
      await kill(daemon);

      expect(daemon.exhausted).toBe(true);
      expect(refused.toSorted()).toEqual(refs.map((ref) => ref.terminalId).toSorted());
      expect(daemon.troubles()).toEqual([]);
      expect(await Promise.all(refs.map(hello))).toEqual(allUnharmed(before, ends));
      expect(hungUp(names)).toEqual([]);
      expect(names.map(inputTo)).toEqual(names.map(() => ""));
      expect(await Promise.all(refs.map((ref) => seamFaults(attachesTo([daemon], ref))))).toEqual([
        [],
        [],
      ]);
    },
  );
});
