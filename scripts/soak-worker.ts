// The program each terminal of a soak runs, typed into its shell: `node scripts/soak-worker.ts
// <mode> <name> <jsonl> [options]`. Every mode prints numbered marker lines, `#soak <name> <n>`,
// so a line lost or repeated anywhere between this program and a viewer shows as a gap or a
// repeat in the numbers, and probes the terminal with CPR and DA, timing the replies from inside
// the terminal. What it observes goes to its own JSON lines file, never to the terminal:
//   {"kind":"start","name":…,"mode":…,"pid":…,"t":…}
//   {"kind":"probe","name":…,"t":…,"ms":<number>|null}: null when no reply came in time
//   {"kind":"marker","name":…,"t":…,"n":…}: every marker up to n has been written, once a probe round
// Written means the terminal took the bytes: the write returned, so they sit in the PTY, read by
// the holder or about to be. A worker can't know a viewer has them; the judge allows for that.
//   {"kind":"hup","name":…,"t":…}
//   {"kind":"exit","name":…,"t":…,"why":"input-ended"|"input-failed"|"output-failed"}
// It signals nothing, and ends when its terminal's input ends or fails, or it is hung up, recording
// only the first of those.
//
// A probe's time is the holder's: in a flood, the bytes queued ahead of the probe are the
// holder's to drain before it can read it, which is why flood writes are small.

import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { agentStream } from "../tests/support/agent-stream.ts";
import { isMain } from "./is-main.ts";

export type Mode = "replay" | "flood" | "idle" | "echo";
const MODES: readonly string[] = ["replay", "flood", "idle", "echo"] satisfies Mode[];
const isMode = (m: string | undefined): m is Mode => m !== undefined && MODES.includes(m);

const ESC = "\x1b";
/** Cursor position report, then primary device attributes. */
export const PROBE = `${ESC}[6n${ESC}[c`;

export function marker(name: string, n: number): string {
  return `#soak ${name} ${n}\r\n`;
}

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The marker numbers of `name` in `text`, in order, from whole marker lines only: one cut short
 * at the end of `text` might yet gain digits. Reads the raw stream, where a terminal's output
 * processing has turned each `\r\n` into `\r\r\n`, as well as rendered lines joined with `\n`.
 */
export function markersIn(text: string, name: string): number[] {
  const pattern = new RegExp(`#soak ${escapeRegExp(name)} (\\d+)\\r*\\n`, "g");
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

/**
 * An agent's stream cut into turns, each starting at a tool call. A marker printed between turns
 * is never drawn over: the stream moves the cursor back only within a turn, to repaint its own
 * spinner and box.
 */
export function replayTurns(lines: number): string[] {
  return agentStream(lines).split(new RegExp(`(?=${ESC}\\[38;5;\\d+m●)`));
}

/** Whether a flood that started `elapsedMs` ago is in its on phase. */
export function flooding(elapsedMs: number, onMs: number, offMs: number): boolean {
  return elapsedMs % (onMs + offMs) < onMs;
}

/**
 * What an echo terminal prints of what was typed: printable ASCII only, so no typed CR, tab or
 * backspace moves the cursor onto a marker line and breaks it.
 */
export function printable(typed: string): string {
  return typed.replaceAll(/[^\x20-\x7e]/g, "");
}

const CPR = new RegExp(`^${ESC}\\[\\d+;\\d+R`);
const DA = new RegExp(`^${ESC}\\[\\?[\\d;]*c`);
/** What could still become a reply once more bytes come. */
const PARTIAL = new RegExp(`^${ESC}(\\[[\\d;?]*)?$`);

export interface Replies {
  readonly cpr: number;
  readonly da: number;
  /** Everything that isn't a reply, as typed into the terminal. */
  readonly typed: string;
  /** The start of a reply still coming, to read again with what follows. */
  readonly rest: string;
}

/** Splits what the terminal sent into probe replies and typed input. Unknown escapes are dropped. */
export function takeReplies(input: string): Replies {
  let cpr = 0;
  let da = 0;
  let typed = "";
  let at = 0;
  while (at < input.length) {
    const tail = input.slice(at);
    if (!tail.startsWith(ESC)) {
      const next = tail.indexOf(ESC);
      typed += next === -1 ? tail : tail.slice(0, next);
      at += next === -1 ? tail.length : next;
      continue;
    }
    const cprMatch = CPR.exec(tail);
    const daMatch = DA.exec(tail);
    if (cprMatch !== null) {
      cpr++;
      at += cprMatch[0].length;
    } else if (daMatch !== null) {
      da++;
      at += daMatch[0].length;
    } else if (PARTIAL.test(tail)) {
      return { cpr, da, typed, rest: tail };
    } else {
      at += 1;
    }
  }
  return { cpr, da, typed, rest: "" };
}

export interface WorkerOptions {
  readonly mode: Mode;
  readonly name: string;
  readonly out: string;
  readonly probeEveryMs: number;
  readonly probeTimeoutMs: number;
  readonly markerEveryMs: number;
  readonly linesPerSecond: number;
  readonly floodOnMs: number;
  readonly floodOffMs: number;
  /** Reads replies only this long after each probe, to prove a slow reply is reported. */
  readonly slowProbeMs: number;
}

const USAGE =
  "usage: soak-worker <replay|flood|idle|echo> <name> <jsonl> [--probe-every ms] " +
  "[--probe-timeout ms] [--marker-every ms] [--lines-per-second n] [--flood-on ms] " +
  "[--flood-off ms] [--slow-probe ms]";

export function parseWorkerArgs(args: readonly string[]): WorkerOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      "probe-every": { type: "string", default: "10000" },
      "probe-timeout": { type: "string", default: "1000" },
      "marker-every": { type: "string", default: "1000" },
      "lines-per-second": { type: "string", default: "50" },
      "flood-on": { type: "string", default: "60000" },
      "flood-off": { type: "string", default: "300000" },
      "slow-probe": { type: "string", default: "0" },
    },
  });
  const [mode, name, out] = positionals;
  if (!isMode(mode) || name === undefined || out === undefined || positionals.length > 3) {
    throw new Error(USAGE);
  }
  if (!/^\S+$/.test(name)) throw new Error(`a worker's name has no spaces: ${name}`);
  const count = (key: keyof typeof values, least: number) => {
    const n = Number(values[key]);
    if (!Number.isInteger(n) || n < least)
      throw new Error(`--${key} takes a whole number ≥ ${least}`);
    return n;
  };
  return {
    mode,
    name,
    out,
    probeEveryMs: count("probe-every", 1),
    probeTimeoutMs: count("probe-timeout", 1),
    markerEveryMs: count("marker-every", 1),
    linesPerSecond: count("lines-per-second", 1),
    floodOnMs: count("flood-on", 1),
    floodOffMs: count("flood-off", 0),
    slowProbeMs: count("slow-probe", 0),
  };
}

/**
 * One probe at a time, timed on `now`. A probe is answered once both its replies are read; one
 * whose time runs out first is a probe never answered, and no probe follows it for `quietMs`, so
 * a reply that comes late lands with no probe waiting rather than being taken for the next one's.
 */
export class Prober {
  readonly #now: () => number;
  readonly #quietMs: number;
  #pending: { id: number; sent: number; cpr: boolean; da: boolean } | undefined;
  #quietUntil = Number.NEGATIVE_INFINITY;
  #sent = 0;

  constructor(now: () => number, quietMs: number) {
    this.#now = now;
    this.#quietMs = quietMs;
  }

  /** Starts a probe and gives its id; none while one waits, or soon after one expired. */
  send(): number | undefined {
    const now = this.#now();
    if (this.#pending !== undefined || now < this.#quietUntil) return undefined;
    this.#pending = { id: ++this.#sent, sent: now, cpr: false, da: false };
    return this.#sent;
  }

  /** Replies read from the terminal; the waiting probe's time once it has both. */
  read(cpr: number, da: number): number | undefined {
    const pending = this.#pending;
    if (pending === undefined) return undefined;
    pending.cpr ||= cpr > 0;
    pending.da ||= da > 0;
    if (!pending.cpr || !pending.da) return undefined;
    this.#pending = undefined;
    return this.#now() - pending.sent;
  }

  /** Probe `id`'s time ran out: whether it was still waiting, and so never answered. */
  expire(id: number): boolean {
    if (this.#pending?.id !== id) return false;
    this.#pending = undefined;
    this.#quietUntil = this.#now() + this.#quietMs;
    return true;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * How long a worker whose input or output failed waits before it exits: a hang-up's SIGHUP comes
 * with its EIO, and is let land first, so the record says what happened.
 */
const HANGUP_GRACE_MS = 100;
/**
 * Lines a flood writes at once. A write to a terminal blocks until the holder has read room for
 * it, so a probe waits behind at most this much: enough to flood, little enough to probe.
 */
const FLOOD_BATCH = 50;
/** How much agent stream to cut into turns, replayed round and round. */
const REPLAY_LINES = 3_000;

async function run(options: WorkerOptions): Promise<void> {
  const { name, out } = options;
  const record = (event: Record<string, unknown>) =>
    appendFileSync(out, `${JSON.stringify({ ...event, name, t: Date.now() })}\n`);
  let ending = false;
  /** Ends the worker once, with the first cause to arrive. */
  const end = (event: Record<string, unknown>, code: number) => {
    if (ending) return;
    ending = true;
    record(event);
    process.exit(code);
  };
  const fail = (why: string, code: number) =>
    setTimeout(() => end({ kind: "exit", why }, code), HANGUP_GRACE_MS);
  record({ kind: "start", mode: options.mode, pid: process.pid });
  process.on("SIGHUP", () => end({ kind: "hup" }, 129));

  const stdout = process.stdout;
  stdout.on("error", () => fail("output-failed", 1));
  const write = async (text: string) => {
    if (!stdout.write(text)) await new Promise((drained) => stdout.once("drain", drained));
  };
  let markers = 0;
  /** The last marker whose write has returned: the terminal has taken it. */
  let written = 0;
  const nextMarker = () => marker(name, ++markers);
  /** Writes `text`, which ends in markers up to the last one made, and counts them written. */
  const writeMarkers = async (text: string) => {
    const last = markers;
    await write(text);
    written = last;
  };

  const prober = new Prober(() => performance.now(), options.probeTimeoutMs);
  let buffered = "";
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("end", () => fail("input-ended", 0));
  stdin.on("error", () => fail("input-failed", 1));
  stdin.on("data", (chunk: string) => {
    const replies = takeReplies(buffered + chunk);
    buffered = replies.rest;
    const echoed = options.mode === "echo" ? printable(replies.typed) : "";
    if (echoed !== "") stdout.write(echoed);
    const ms = prober.read(replies.cpr, replies.da);
    if (ms !== undefined) record({ kind: "probe", ms: Math.round(ms) });
  });
  setInterval(() => {
    if (written > 0) record({ kind: "marker", n: written });
    const id = prober.send();
    if (id === undefined) return;
    setTimeout(() => {
      // Input that came while this process was busy is read first: timers run before I/O.
      setImmediate(() => {
        if (prober.expire(id)) record({ kind: "probe", ms: null });
      });
    }, options.probeTimeoutMs);
    stdout.write(PROBE);
    if (options.slowProbeMs > 0) {
      stdin.pause();
      setTimeout(() => stdin.resume(), options.slowProbeMs);
    }
  }, options.probeEveryMs);

  switch (options.mode) {
    case "replay": {
      const turns = replayTurns(REPLAY_LINES);
      const msPerLine = 1000 / options.linesPerSecond;
      for (let i = 0; ; i = (i + 1) % turns.length) {
        const turn = turns[i] ?? "";
        await writeMarkers(turn + nextMarker());
        await sleep(turn.split("\r\n").length * msPerLine);
      }
    }
    case "flood": {
      const started = performance.now();
      for (;;) {
        if (flooding(performance.now() - started, options.floodOnMs, options.floodOffMs)) {
          await writeMarkers(Array.from({ length: FLOOD_BATCH }, nextMarker).join(""));
          await new Promise(setImmediate);
        } else {
          await writeMarkers(nextMarker());
          await sleep(options.markerEveryMs);
        }
      }
    }
    case "idle":
    case "echo":
      for (;;) {
        await writeMarkers(nextMarker());
        await sleep(options.markerEveryMs);
      }
  }
}

if (isMain(import.meta)) await run(parseWorkerArgs(process.argv.slice(2)));
