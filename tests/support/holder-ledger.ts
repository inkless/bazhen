// The ledger of holders the tests started: one entry per holder, written when it starts and
// removed when its test closes it. A holder ends only by a close or a signal, in a session of its
// own, so one whose test process died first runs on; the next run's setup sweeps it. The Rust
// binary tests (crates/bazhen-holder/tests/binary/main.rs) keep the same ledger, in the same
// format, so either sweeps the other's leftovers.

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  type HolderProcess,
  killHolder,
  readProcess,
  START_SKEW_S,
  vouchHolder,
} from "@bazhen/host-guard";

/**
 * One entry: the holder's pid and start, its owning test process's pid and start, in epoch
 * seconds, and the holder's socket, which says whose holder it is.
 */
export interface LedgerEntry {
  readonly holder: number;
  readonly holderStart: number;
  readonly owner: number;
  readonly ownerStart: number;
  readonly socket: string;
}

/** Where the TypeScript and the Rust holder tests put their homes, and so their sockets. */
const TEST_HOMES = ["/tmp/bz-h-", "/tmp/bz-hb-"];
/** How old an entry that isn't one must be before the sweep removes it, as surely abandoned. */
const STALE_MS = 24 * 60 * 60 * 1000;

/** Whether `socket` is a test holder's, so its holder is one a sweep may kill. */
export const inTestHome = (socket: string) =>
  TEST_HOMES.some((home) => socket.startsWith(home)) && !socket.includes("/../");

/** The ledger, one per user whatever ran the tests, private to the user. */
export function ledgerDir(env: NodeJS.ProcessEnv = process.env): string {
  const { uid } = userInfo();
  const dir = join(env["XDG_RUNTIME_DIR"] ?? tmpdir(), `bazhen-test-holders-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} isn't a private directory of this user's`);
  }
  return dir;
}

const decimal = (text: string | undefined) =>
  text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;

/** An entry from its file's name and text, or undefined for one that isn't. */
export function parseEntry(name: string, text: string): LedgerEntry | undefined {
  const lines = text.split("\n");
  if (lines.length !== 5 || lines[4] !== "") return undefined;
  const [holder, holderStart, owner, ownerStart] = [name, ...lines.slice(0, 3)].map(decimal);
  const socket = lines[3] ?? "";
  if (holder === undefined || holderStart === undefined) return undefined;
  if (owner === undefined || ownerStart === undefined || socket === "") return undefined;
  return { holder, holderStart, owner, ownerStart, socket };
}

export const entryText = (entry: LedgerEntry) =>
  `${entry.holderStart}\n${entry.owner}\n${entry.ownerStart}\n${entry.socket}\n`;

/** A process's start, in epoch seconds, or that it has none, or that `ps` can't say. */
export type Start = number | "absent" | "unreadable";

async function startOf(pid: number): Promise<Start> {
  const reading = await readProcess(pid);
  return typeof reading === "string" ? reading : reading.start;
}

let ownStart: number | undefined;

/**
 * Records a holder this process started, at `socket`, and returns the entry's path. Written
 * whole or not at all, so a sweep never reads half of one.
 */
export async function record(holder: number, holderStart: number, socket: string): Promise<string> {
  if (ownStart === undefined) {
    const start = await startOf(process.pid);
    // An owner of unknown start would read as dead to every sweep, its holders killed in use.
    if (typeof start !== "number") throw new Error(`ps says this process is ${start}`);
    ownStart = start;
  }
  const entry = { holder, holderStart, owner: process.pid, ownerStart: ownStart, socket };
  const path = join(ledgerDir(), String(holder));
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, entryText(entry), { mode: 0o600 });
  renameSync(partial, path);
  return path;
}

const sameStart = (a: number, b: number) => Math.abs(a - b) <= START_SKEW_S;

/** Whether an entry's owner is provably gone: no process, or another one at its pid. */
export const ownerGone = (entry: LedgerEntry, start: Start) =>
  start === "absent" || (typeof start === "number" && !sameStart(start, entry.ownerStart));

export interface SweepDeps {
  readonly list: (dir: string) => string[];
  readonly startOf: (pid: number) => Promise<Start>;
  readonly vouch: (holder: HolderProcess) => Promise<HolderProcess | null>;
  readonly kill: (proof: HolderProcess) => boolean;
  readonly now: () => number;
}

const DEPS: SweepDeps = {
  list: (dir) => readdirSync(dir),
  startOf,
  vouch: (holder) => vouchHolder(holder),
  kill: (proof) => killHolder(proof),
  now: Date.now,
};

/** The entry's text, or undefined once a concurrent sweep or its test has removed it. */
function readEntry(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Kills the holders of test processes that died before closing them, and forgets them. Nothing
 * is killed whose owner may live, whose socket isn't in a test home, or that `ps` doesn't still
 * show as the entry's own holder, so a reused pid is left alone. Returns how many it killed.
 */
export async function sweep(dir: string = ledgerDir(), deps: SweepDeps = DEPS): Promise<number> {
  let killed = 0;
  for (const name of deps.list(dir)) {
    const path = join(dir, name);
    const text = readEntry(path);
    if (text === undefined) continue;
    const entry = parseEntry(name, text);
    if (entry === undefined) {
      const age = deps.now() - (lstatSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Infinity);
      if (age > STALE_MS) rmSync(path, { force: true });
      continue;
    }
    if (!ownerGone(entry, await deps.startOf(entry.owner))) continue;
    if (inTestHome(entry.socket)) {
      const proof = await deps.vouch({ pid: entry.holder, start: entry.holderStart });
      if (proof !== null && deps.kill(proof)) killed++;
    }
    // A holder started since, at the same pid, has an entry of its own here.
    if (readEntry(path) === text) rmSync(path, { force: true });
  }
  return killed;
}
