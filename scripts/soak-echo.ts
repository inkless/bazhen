// The soak's keystroke timer, a process of its own, so nothing the driver does (rendering a
// snapshot of thousands of lines, say) stands between a keystroke's echo and its timing:
// `node scripts/soak-echo.ts <url> <terminalId> <jsonl> [--every ms] [--flood-on ms]
// [--flood-off ms] [--flood-starts t,t,…]`, with the paired browser's cookie in `SOAK_COOKIE`.
//
// It drives a view of the echo shell (scripts/soak-worker.ts in echo mode) and types an `x` every
// `--every` ms, timing each until its echo arrives, or recording null after two seconds:
//   {"kind":"echo","t":…,"ms":<number>|null,"flooding":<whether a flood was in its on phase>,
//    "viewMs":<how long its view had been open, as after a restart>}
// The driver steers it over its input, a line at a time, around each daemon restart: `pause`
// stops the typing, waits for the keystroke in flight and closes the view, then answers `paused`;
// `resume <url>` opens a view on the restarted daemon and answers `resumed`. It ends with its input.

import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { openView, type View } from "../tests/api/daemon.ts";
import { isMain } from "./is-main.ts";
import { flooding } from "./soak-worker.ts";

/** Every soak view's size, and so every soak terminal's. */
export const SOAK_SIZE = { cols: 120, rows: 40 } as const;
/** How long a keystroke may go without its echo before it counts as never echoed. */
const ECHO_TIMEOUT_MS = 2_000;

/** What `EchoTimer` needs of a view. */
export interface Typing {
  type(text: string): void;
  onOutput(listener: (chunk: Buffer) => void): void;
  hasSnapshot(): boolean;
}

/**
 * Times keystrokes through `view` on `now`: an `x`, until output holding one comes back. Only the
 * echo prints an `x` in an echo shell, whose markers hold none; the snapshot the view opened on may
 * hold earlier ones, so nothing counts before it has arrived.
 */
export class EchoTimer {
  readonly #view: Typing;
  readonly #now: () => number;
  #waiting: (() => void) | undefined;

  constructor(view: Typing, now: () => number) {
    this.#view = view;
    this.#now = now;
    view.onOutput((chunk) => {
      if (view.hasSnapshot() && chunk.includes("x")) this.#waiting?.();
    });
  }

  /** Types a keystroke; its echo's time, or null if none came within `timeoutMs`. */
  async time(timeoutMs = ECHO_TIMEOUT_MS): Promise<number | null> {
    const echoed = Promise.withResolvers<number | null>();
    const typed = this.#now();
    this.#waiting = () => echoed.resolve(Math.round(this.#now() - typed));
    const giveUp = setTimeout(() => echoed.resolve(null), timeoutMs);
    this.#view.type("x");
    try {
      return await echoed.promise;
    } finally {
      clearTimeout(giveUp);
      this.#waiting = undefined;
    }
  }
}

export interface EchoOptions {
  readonly url: string;
  readonly terminalId: string;
  readonly out: string;
  readonly everyMs: number;
  readonly floodOnMs: number;
  readonly floodOffMs: number;
  /** When each flood worker started, by its own record. */
  readonly floodStarts: readonly number[];
}

export function parseEchoArgs(args: readonly string[]): EchoOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      every: { type: "string", default: "1000" },
      "flood-on": { type: "string", default: "60000" },
      "flood-off": { type: "string", default: "300000" },
      "flood-starts": { type: "string", default: "" },
    },
  });
  const [url, terminalId, out] = positionals;
  if (
    url === undefined ||
    terminalId === undefined ||
    out === undefined ||
    positionals.length > 3
  ) {
    throw new Error(
      "usage: soak-echo <url> <terminalId> <jsonl> [--every ms] [--flood-on ms] " +
        "[--flood-off ms] [--flood-starts t,t,…]",
    );
  }
  const floodStarts =
    values["flood-starts"] === "" ? [] : values["flood-starts"].split(",").map(Number);
  const numbers = [values.every, values["flood-on"], values["flood-off"]].map(Number);
  if ([...numbers, ...floodStarts].some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error("soak-echo's times are milliseconds, none negative");
  }
  const [everyMs = 0, floodOnMs = 0, floodOffMs = 0] = numbers;
  return { url, terminalId, out, everyMs, floodOnMs, floodOffMs, floodStarts };
}

/** Answers the driver, a line at a time. */
const say = (line: string) => process.stdout.write(`${line}\n`);

async function run(options: EchoOptions, cookie: string): Promise<void> {
  let view: View | undefined;
  let timer: EchoTimer | undefined;
  let inFlight: Promise<void> | undefined;
  let openedAt = 0;
  const open = async (url: string) => {
    const opened = await openView(url, options.terminalId, "interactive", {
      origin: url,
      size: SOAK_SIZE,
      cookie,
    });
    await opened.drive();
    openedAt = Date.now();
    view = opened;
    timer = new EchoTimer(opened, () => performance.now());
  };
  await open(options.url);
  say("ready");
  setInterval(() => {
    const ready = timer;
    if (ready === undefined || inFlight !== undefined) return;
    inFlight = (async () => {
      const ms = await ready.time();
      const now = Date.now();
      const flooded = options.floodStarts.some((start) =>
        flooding(now - start, options.floodOnMs, options.floodOffMs),
      );
      appendFileSync(
        options.out,
        `${JSON.stringify({ kind: "echo", t: now, ms, flooding: flooded, viewMs: now - openedAt })}\n`,
      );
    })().finally(() => {
      inFlight = undefined;
    });
  }, options.everyMs);
  for await (const line of createInterface({ input: process.stdin })) {
    const [command, url] = line.trim().split(" ");
    if (command === "pause") {
      timer = undefined;
      await inFlight;
      view?.close();
      view = undefined;
      say("paused");
    } else if (command === "resume" && url !== undefined) {
      await open(url);
      say("resumed");
    }
  }
  process.exit(0);
}

if (isMain(import.meta)) {
  await run(parseEchoArgs(process.argv.slice(2)), process.env["SOAK_COOKIE"] ?? "");
}
