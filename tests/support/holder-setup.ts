// Vitest globalSetup for the holder project, which runs real PTYs and holders on the host
// (docs/standards/testing.md).
// - It refuses to start when the machine is close to running out of PTYs, before anything else.
// - Every run gets a temporary BAZHEN_HOME under /tmp, so a holder's socket path stays inside
//   the 103 bytes a Unix socket allows on macOS too, and tests find it only through
//   ./holder-home.ts, which refuses any home but this one.
// - No test can reach a tmux server: `tmux` on PATH is a script that refuses, TMUX is unset, and
//   TMUX_TMPDIR is an empty directory of the run's, not a file or a missing path, from which
//   tmux would fall back to /tmp and the user's own servers. Teardown fails the run if anything
//   appears there.
// - Setup drops every inherited BAZHEN_ variable, so nothing a test runs can reach a real daemon.
// - Teardown closes every holder still answering in the home, through the protocol, and fails
//   the run naming them. It signals nothing: host-guard is the one place that does. A holder that
//   may still run keeps the home in place, its tmux refusal included. One that closes in time
//   has ended its child's process group, as holder/1's `close` requires, so nothing it ran is
//   left using the home.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { connectHolder, HolderDisconnected } from "@bazhen/runtime-holder";
import { holdersDir, RUN_ENV, RUN_MARKER } from "./holder-home.ts";
import { requirePtyHeadroom } from "./ptys.ts";

/** What `tmux` on the holder tests' PATH is: a script that refuses. */
export const TMUX_REFUSAL = '#!/bin/sh\necho "holder tests never run tmux" >&2\nexit 127\n';
const CLOSE_WAIT_MS = 2000;
/** Every run's home, and every scratch home a test makes, starts with this. */
export const RUN_PREFIX = "/tmp/bz-h-";

const tmuxDir = (home: string) => join(home, "tmux");

let home: string | undefined;

function isolateTmux(dir: string): void {
  delete process.env["TMUX"];
  delete process.env["TMUX_PANE"];
  mkdirSync(tmuxDir(dir), { mode: 0o700 });
  process.env["TMUX_TMPDIR"] = tmuxDir(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), TMUX_REFUSAL, { mode: 0o755 });
  process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
}

/** Drops from `env` the variables that point a Bazhen CLI or hook at a real daemon. */
export function scrubBazhenEnv(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) if (name.startsWith("BAZHEN_")) delete env[name];
}

export function setup(): void {
  requirePtyHeadroom();
  home = mkdtempSync(RUN_PREFIX);
  for (const dir of [join(home, "run"), holdersDir(home)]) {
    mkdirSync(dir);
    chmodSync(dir, 0o700);
  }
  isolateTmux(home);
  const run = randomUUID();
  writeFileSync(join(home, RUN_MARKER), run);
  scrubBazhenEnv(process.env);
  process.env["BAZHEN_HOME"] = home;
  process.env[RUN_ENV] = run;
}

export interface LeakedHolder {
  readonly socket: string;
  /** Null for a holder that took the connection but gave no usable answer to `hello`. */
  readonly terminalId: string | null;
  readonly holderPid: number | null;
  /** Whether it answered `close` and hung up in time; one that didn't may still be running. */
  readonly closed: boolean;
  /** Why `hello` failed, for one that took the connection. */
  readonly hello: string | null;
}

const timeout = (ms: number) => new Promise<void>((done) => setTimeout(done, ms).unref());

const GONE = new Set(["ENOENT", "ECONNREFUSED"]);

/** Nothing listens on the socket: no file, or a file its holder left behind. */
function gone(error: unknown): boolean {
  if (!(error instanceof HolderDisconnected) || error.end.reason !== "error") return false;
  const cause = error.end.error;
  return "code" in cause && typeof cause.code === "string" && GONE.has(cause.code);
}

async function closeIfLive(socket: string, waitMs: number): Promise<LeakedHolder | null> {
  let client;
  try {
    client = await connectHolder(socket, {
      onEvent: () => {},
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (error) {
    if (gone(error)) return null;
    const hello = error instanceof Error ? error.message : String(error);
    return { socket, terminalId: null, holderPid: null, closed: false, hello };
  }
  const { terminalId, holderPid } = client.hello;
  const answered = await client.close({ signal: AbortSignal.timeout(waitMs) }).then(
    () => true,
    () => false,
  );
  // A holder hangs up once its child's group is gone, so `ok` alone doesn't say it has exited.
  const closed =
    answered &&
    (await Promise.race([client.ended.then(() => true), timeout(waitMs).then(() => false)]));
  client.end();
  return { socket, terminalId, holderPid, closed, hello: null };
}

/**
 * Closes every holder still answering on a socket in `dir`, and says which they were. Refuses a
 * directory outside the holder tests' own, so it can't close a real holder.
 */
export async function closeLiveHolders(
  dir: string,
  waitMs: number = CLOSE_WAIT_MS,
): Promise<LeakedHolder[]> {
  if (!resolve(dir).startsWith(RUN_PREFIX)) {
    throw new Error(`Refusing to close holders in ${dir}: it isn't under ${RUN_PREFIX}*.`);
  }
  const sockets = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".sock")) : [];
  const found = await Promise.all(sockets.map((name) => closeIfLive(join(dir, name), waitMs)));
  return found.filter((holder) => holder !== null);
}

function describeLeak(holder: LeakedHolder): string {
  if (holder.terminalId === null) return `${holder.socket} (no answer to hello: ${holder.hello})`;
  const state = holder.closed ? "closed" : "didn't close in time; may still run";
  return `${holder.terminalId} (pid ${holder.holderPid}, ${state})`;
}

export interface TeardownReport {
  readonly problems: readonly string[];
  /** A holder that may still run keeps the home, its tmux refusal and its socket, in place. */
  readonly keep: boolean;
}

/** What a run left behind in its home `dir`, closing any holder that still answers. */
export async function teardownReport(dir: string, waitMs?: number): Promise<TeardownReport> {
  const leaked = await closeLiveHolders(holdersDir(dir), waitMs);
  const ranTmux = existsSync(tmuxDir(dir)) ? readdirSync(tmuxDir(dir)) : [];
  const keep = leaked.some((holder) => !holder.closed);
  const problems: string[] = [];
  if (leaked.length > 0) {
    problems.push(
      `Tests left ${leaked.length} holder(s) running: ${leaked.map(describeLeak).join(", ")}. ` +
        "Close every holder a test starts in afterAll (docs/standards/testing.md).",
    );
  }
  if (keep) {
    problems.push(
      `Left ${dir} in place, as a holder in it may still be running; ` +
        "remove it once each pid named has exited.",
    );
  }
  if (ranTmux.length > 0)
    problems.push(`A holder test ran tmux, which made ${ranTmux.join(", ")}.`);
  return { problems, keep };
}

// Vitest's source-map lookup hides errors thrown from globalSetup, so print it as well.
function fail(message: string): never {
  console.error(`\n${message}\n`);
  throw new Error(message);
}

export async function teardown(): Promise<void> {
  const dir = home;
  home = undefined;
  if (dir === undefined) return;
  const { problems, keep } = await teardownReport(dir);
  if (!keep) rmSync(dir, { recursive: true, force: true });
  if (problems.length > 0) fail(problems.join("\n"));
}
