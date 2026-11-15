#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Runs a test command under a memory cap and a time cap (packages/host-guard/src/cap.ts), so a
// test that runs away dies alone (docs/standards/testing.md § Memory and time caps).
//
// Usage:
//   node scripts/capped.ts --memory <n>G --time <n>m -- <command> [args...]
//   scripts/capped.ts --test-binary -- <binary> [args...]
// `--test-binary` is cargo's target runner (.cargo/config.toml): cargo test, nextest and
// cargo-mutants start every test binary through it, so each test process gets a cap of its own,
// a hand-typed `cargo mutants` included. Inside a capped run it needs no probe. Outside one, on a
// host where systemd can't cap, it refuses rather than start an uncapped test.
//
// host-guard is imported by path, not by package name, and needs only node: built-ins: cargo-mutants
// runs the tests in a copy of the tree that may leave out node_modules, and CI's macOS Rust job
// runs the Rust gates without installing it.

import {
  chooseMode,
  clampMemory,
  runIn,
  type Cap,
  type Ended,
  type Mode,
} from "../packages/host-guard/src/cap.ts";
import { dieBy } from "../packages/host-guard/src/signal.ts";
import { appendFileSync } from "node:fs";
import { isMain } from "./is-main.ts";

const GIB = 1024 ** 3;
/** Each test process's own cap; scripts/check-standards.ts holds a script's caps to its maxima. */
export const TEST_BINARY_CAP: Cap = { memory: 4 * GIB, timeMs: 15 * 60_000 };

/** A file a test binary killed at its memory cap is named in, for falsify to read. */
export const KILLS_ENV = "BZ_CAPPED_KILLS";

const SIZE_UNITS: Record<string, number> = { M: 1024 ** 2, G: GIB };
const TIME_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** `512M` or `8G`, in bytes. */
export function parseSize(text: string): number {
  const [, n, unit = ""] = /^(\d+)([MG])$/.exec(text) ?? [];
  const bytes = Number(n) * (SIZE_UNITS[unit] ?? Number.NaN);
  if (!(bytes > 0)) throw new Error(`a memory cap is a whole number of M or G, not "${text}"`);
  return bytes;
}

/** `90s`, `20m` or `2h`, in milliseconds. */
export function parseDuration(text: string): number {
  const [, n, unit = ""] = /^(\d+)([smh])$/.exec(text) ?? [];
  const ms = Number(n) * (TIME_UNITS[unit] ?? Number.NaN);
  if (!(ms > 0)) throw new Error(`a time cap is a whole number of s, m or h, not "${text}"`);
  return ms;
}

export type Invocation =
  | { kind: "run"; cap: Cap; command: string; args: string[] }
  | { kind: "test-binary"; command: string; args: string[] };

const USAGE =
  "usage: node scripts/capped.ts --memory <n>G --time <n>m -- <command> [args...], " +
  "or scripts/capped.ts --test-binary -- <binary> [args...]";

export function parseArgs(argv: readonly string[]): Invocation {
  const split = argv.indexOf("--");
  const options = split < 0 ? [] : argv.slice(0, split);
  // `pnpm capped -- cargo test` hands on its own `--` as well.
  const rest = argv.slice(split + 1);
  const [command, ...args] = rest[0] === "--" ? rest.slice(1) : rest;
  if (split < 0 || command === undefined) throw new Error(USAGE);
  if (options.length === 1 && options[0] === "--test-binary") {
    return { kind: "test-binary", command, args };
  }
  const [m, memory = "", t, time = ""] = options;
  if (options.length !== 4 || m !== "--memory" || t !== "--time") throw new Error(USAGE);
  return {
    kind: "run",
    cap: { memory: parseSize(memory), timeMs: parseDuration(time) },
    command,
    args,
  };
}

export function formatBytes(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

export const formatDuration = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;

/** What a run's end says about its caps; a test binary says nothing unless a cap fired. */
export function report(ended: Ended, cap: Cap, mode: Mode, testBinary: boolean): string[] {
  const lines: string[] = [];
  const memory = formatBytes(cap.memory);
  if (!testBinary && mode !== "through") {
    lines.push(`capped: peak ${formatBytes(ended.peak)} of ${memory}`);
  }
  if (ended.memoryKills > 0) {
    lines.push(
      mode === "scope"
        ? `capped: killed ${ended.memoryKills} process(es) at the ${memory} memory cap`
        : `capped: stopped the run at the ${memory} memory cap`,
    );
  } else if (ended.timedOut) {
    lines.push(`capped: stopped at the ${formatDuration(cap.timeMs)} time cap`);
  } else if (testBinary && mode === "scope" && ended.signal === "SIGKILL") {
    lines.push(`capped: killed by SIGKILL, most likely at the ${memory} memory cap`);
  }
  return lines;
}

async function run(invocation: Invocation): Promise<number | NodeJS.Signals> {
  const { command, args } = invocation;
  const testBinary = invocation.kind === "test-binary";
  const asked = testBinary ? TEST_BINARY_CAP : invocation.cap;
  const cap = { ...asked, memory: clampMemory(asked.memory) };
  const chosen = await chooseMode(cap, testBinary, process.env);
  if ("refused" in chosen) {
    console.error(
      `capped: refusing to start a test binary outside a capped run: ${chosen.refused}, and ` +
        "nothing else would cap it. Run it as `pnpm capped -- <command>` " +
        "(docs/standards/testing.md § Memory and time caps).",
    );
    return 2;
  }
  if (chosen.note !== undefined) {
    console.error(`capped: ${chosen.note}, so a watchdog checks memory instead`);
  }
  const ended = await runIn(chosen.mode, command, args, cap, process.env);
  const lines = report(ended, cap, chosen.mode, testBinary);
  for (const line of lines) console.error(line);
  const kills = process.env[KILLS_ENV];
  if (testBinary && kills !== undefined && lines.some((l) => l.includes("memory cap"))) {
    appendFileSync(kills, `${[command, ...args].join(" ")}\n`);
  }
  return ended.signal ?? ended.code ?? 1;
}

async function main(argv: readonly string[]): Promise<number | NodeJS.Signals> {
  let invocation: Invocation;
  try {
    invocation = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  return run(invocation);
}

if (isMain(import.meta)) {
  void main(process.argv.slice(2)).then((end) =>
    typeof end === "string" ? dieBy(end) : process.exit(end),
  );
}
