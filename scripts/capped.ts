#!/usr/bin/env node
// Runs a test command under a memory cap and a time cap (packages/host-guard/src/cap.ts), so a
// test that runs away dies alone.
//
// Usage:
//   node scripts/capped.ts --memory <n>G --time <n>m -- <command> [args...]
//   scripts/capped.ts --test-binary [--memory <n>M] -- <binary> [args...]
// `--test-binary` is the form for cargo's target runner: cargo test, nextest and cargo-mutants
// start every test binary through it, so a test process outside any capped run, a hand-typed
// `cargo mutants` included, gets a cap of its own. Inside a capped scope it runs the binary as it
// is, held by the scope's cap. A run with a memory kill appends the command to the file
// `BZ_CAPPED_KILLS` names, for falsify to read.
//
// host-guard is imported by path, not by package name, and needs only node: built-ins: cargo-mutants
// runs the tests in a copy of the tree that may leave out node_modules, and CI's macOS Rust job
// runs the Rust gates without installing it.

import {
  cappedScope,
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

/** Names the file a run with a memory kill appends its command to. */
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

export type Invocation = {
  kind: "run" | "test-binary";
  cap: Cap;
  command: string;
  args: string[];
};

const USAGE =
  "usage: node scripts/capped.ts --memory <n>G --time <n>m -- <command> [args...], " +
  "or scripts/capped.ts --test-binary [--memory <n>M] -- <binary> [args...]";

export function parseArgs(argv: readonly string[]): Invocation {
  const split = argv.indexOf("--");
  const options = split < 0 ? [] : argv.slice(0, split);
  // `pnpm capped -- cargo test` hands on its own `--` as well.
  const rest = argv.slice(split + 1);
  const [command, ...args] = rest[0] === "--" ? rest.slice(1) : rest;
  if (split < 0 || command === undefined) throw new Error(USAGE);
  if (options[0] === "--test-binary") {
    const [, m, memory = ""] = options;
    if (options.length === 1) return { kind: "test-binary", cap: TEST_BINARY_CAP, command, args };
    if (options.length !== 3 || m !== "--memory") throw new Error(USAGE);
    const cap = { ...TEST_BINARY_CAP, memory: parseSize(memory) };
    return { kind: "test-binary", cap, command, args };
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

const KILLED: Record<Mode, string> = {
  scope: "killed N process(es) at the",
  watched: "stopped the run at the",
  owned: "killed the test process at the",
  through: "killed by the enclosing run's",
};

/**
 * What a run's end says about its caps; a test binary says nothing unless a cap fired. A run
 * through has the enclosing run's memory cap, which `cap.memory` then is, and its own time cap.
 */
export function report(ended: Ended, cap: Cap, mode: Mode, testBinary: boolean): string[] {
  const lines: string[] = [];
  const memory = formatBytes(cap.memory);
  if (!testBinary) {
    lines.push(
      mode === "through"
        ? `capped: under the enclosing run's ${memory} memory cap`
        : `capped: peak ${formatBytes(ended.peak)} of ${memory}`,
    );
  }
  if (ended.memoryKills > 0) {
    const killed = KILLED[mode].replace("N", String(ended.memoryKills));
    lines.push(`capped: ${killed} ${memory} memory cap`);
  } else if (ended.timedOut) {
    lines.push(`capped: stopped at the ${formatDuration(cap.timeMs)} time cap`);
  } else if (ended.signal === "SIGXCPU") {
    lines.push("capped: stopped at its CPU-time limit, set for a test whose runner had died");
  }
  return lines;
}

async function run(invocation: Invocation): Promise<number | NodeJS.Signals> {
  const { command, args } = invocation;
  const testBinary = invocation.kind === "test-binary";
  const cap = { ...invocation.cap, memory: clampMemory(invocation.cap.memory) };
  const chosen = await chooseMode(cap, testBinary);
  // Once a run, not once a test process.
  if (chosen.note !== undefined && !testBinary) {
    console.error(`capped: ${chosen.note}, so a watchdog checks memory instead`);
  }
  const ended = await runIn(chosen.mode, command, args, cap, process.env);
  const enclosing = chosen.mode === "through" ? cappedScope() : undefined;
  const reported = { ...cap, memory: enclosing ?? cap.memory };
  for (const line of report(ended, reported, chosen.mode, testBinary)) console.error(line);
  const kills = process.env[KILLS_ENV];
  if (kills !== undefined && ended.memoryKills > 0) {
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
