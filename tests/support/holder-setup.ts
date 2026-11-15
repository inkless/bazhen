// Vitest globalSetup for the holder project, which runs real PTYs and holders on the host
// (docs/standards/testing.md).
// - It refuses to start when the machine is close to running out of PTYs, before anything else.
// - Every run gets a temporary BAZHEN_HOME under /tmp, so a holder's socket path stays inside
//   the 103 bytes a Unix socket allows on macOS too, and tests find it only through
//   ./holder-home.ts, which refuses any home but this one.
// - No test can reach a tmux server: `tmux` on PATH is a script that refuses, TMUX is unset, and
//   TMUX_TMPDIR is an empty directory of the run's, not a file or a missing path, from which
//   tmux would fall back to /tmp and the user's own servers. Teardown fails the run if anything
//   appears there. That holds for this process and the tests'; what a holder runs gets only its
//   spec's env, which ./holder-home.ts's holderEnv() builds and requireHolderEnv() checks, with
//   HOME and XDG_* in the home too, so no shell reads the user's rc files or history.
// - Setup drops every inherited BAZHEN_ variable, so nothing a test runs can reach a real daemon.
// - Teardown closes every holder still answering in the home, through the protocol, and fails
//   the run naming them. It signals nothing: host-guard is the one place that does. It counts a
//   holder closed only once it has hung up and its pid no longer exists, rather than trust the
//   holder under test to have ended its child's group; any other keeps the home in place, its
//   tmux refusal included, for whatever it ran.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isAlive } from "@bazhen/host-guard";
import { connectHolder, HolderDisconnected } from "@bazhen/runtime-holder";
import {
  binDir,
  holderEnv,
  holdersDir,
  RUN_ENV,
  RUN_MARKER,
  tmuxDir,
  userDir,
} from "./holder-home.ts";
import { requirePtyHeadroom } from "./ptys.ts";
import { failSetup } from "./setup-error.ts";

/** What `tmux` on the holder tests' PATH is: a script that refuses. */
export const TMUX_REFUSAL = '#!/bin/sh\necho "holder tests never run tmux" >&2\nexit 127\n';
const WAIT_MS = 2000;
/** Every run's home, and every scratch home a test makes, starts with this. */
export const RUN_PREFIX = "/tmp/bz-h-";

let home: string | undefined;

function isolateTmux(dir: string): void {
  delete process.env["TMUX"];
  delete process.env["TMUX_PANE"];
  mkdirSync(tmuxDir(dir), { mode: 0o700 });
  process.env["TMUX_TMPDIR"] = tmuxDir(dir);
  const bin = binDir(dir);
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), TMUX_REFUSAL, { mode: 0o755 });
  const path = process.env["PATH"];
  process.env["PATH"] = path === undefined || path === "" ? bin : `${bin}:${path}`;
}

/** Drops from `env` the variables that point a Bazhen CLI or hook at a real daemon. */
export function scrubBazhenEnv(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) if (name.startsWith("BAZHEN_")) delete env[name];
}

export function setup(): void {
  requirePtyHeadroom();
  home = mkdtempSync(RUN_PREFIX);
  for (const dir of [join(home, "run"), holdersDir(home), userDir(home)]) {
    mkdirSync(dir);
    chmodSync(dir, 0o700);
  }
  isolateTmux(home);
  const run = randomUUID();
  writeFileSync(join(home, RUN_MARKER), run);
  scrubBazhenEnv(process.env);
  process.env["BAZHEN_HOME"] = home;
  process.env[RUN_ENV] = run;
  // A child's XDG_RUNTIME_DIR must exist and be private, as the system's is.
  mkdirSync(String(holderEnv()["XDG_RUNTIME_DIR"]), { mode: 0o700 });
}

export interface LeakedHolder {
  readonly socket: string;
  /** Null for a holder that took the connection but gave no usable answer to `hello`. */
  readonly terminalId: string | null;
  readonly holderPid: number | null;
  /** Whether it answered `close`, hung up and exited in time; any other may still be running. */
  readonly closed: boolean;
  /** Why `hello` failed, for one that took the connection. */
  readonly hello: string | null;
}

const timeout = (ms: number) => new Promise<void>((done) => setTimeout(done, ms).unref());

/** How long teardown waits on each holder: for `hello`, and then for `close` to take. */
export interface CloseWait {
  readonly helloMs?: number;
  readonly closeMs?: number;
}

const exited = (pid: number) => {
  try {
    return !isAlive(pid);
  } catch {
    // A pid host-guard won't probe, such as 1, proves nothing.
    return false;
  }
};

/** Whether `pid` is gone before `deadline`; a pid reused since reads as still running. */
async function exitsBy(pid: number, deadline: number): Promise<boolean> {
  while (!exited(pid)) {
    if (Date.now() >= deadline) return false;
    await timeout(10);
  }
  return true;
}

const GONE = new Set(["ENOENT", "ECONNREFUSED"]);

/** Nothing listens on the socket: no file, or a file its holder left behind. */
function gone(error: unknown): boolean {
  if (!(error instanceof HolderDisconnected) || error.end.reason !== "error") return false;
  const cause = error.end.error;
  return "code" in cause && typeof cause.code === "string" && GONE.has(cause.code);
}

async function closeIfLive(socket: string, wait: CloseWait): Promise<LeakedHolder | null> {
  const { helloMs = WAIT_MS, closeMs = WAIT_MS } = wait;
  let client;
  try {
    client = await connectHolder(socket, {
      onEvent: () => {},
      signal: AbortSignal.timeout(helloMs),
    });
  } catch (error) {
    if (gone(error)) return null;
    const hello = error instanceof Error ? error.message : String(error);
    return { socket, terminalId: null, holderPid: null, closed: false, hello };
  }
  const { terminalId, holderPid } = client.hello;
  const deadline = Date.now() + closeMs;
  const answered = await client.close({ signal: AbortSignal.timeout(closeMs) }).then(
    () => true,
    () => false,
  );
  // `ok` alone doesn't say the holder has exited; nor does a connection this side ended, or one
  // the holder ended, as one that crashed would, without its pid gone.
  const hungUp =
    answered &&
    (await Promise.race([
      client.ended.then((end) => end.reason === "eof"),
      timeout(closeMs).then(() => false),
    ]));
  const closed = hungUp && (await exitsBy(holderPid, deadline));
  client.end();
  return { socket, terminalId, holderPid, closed, hello: null };
}

/** Whether `dir`, wherever a symlink takes it, is under a holder test home. */
function inTestHome(dir: string): boolean {
  if (!existsSync(dir)) return resolve(dir).startsWith(RUN_PREFIX);
  // /tmp itself is a symlink on macOS.
  return realpathSync(dir).startsWith(join(realpathSync("/tmp"), "bz-h-"));
}

/**
 * Closes every holder still answering on a socket in `dir`, and says which they were. Refuses a
 * directory outside the holder tests' own, however it is reached, so it can't close a real holder.
 */
export async function closeLiveHolders(dir: string, wait: CloseWait = {}): Promise<LeakedHolder[]> {
  if (!inTestHome(dir)) {
    throw new Error(`Refusing to close holders in ${dir}: it isn't under ${RUN_PREFIX}*.`);
  }
  const sockets = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".sock")) : [];
  const found = await Promise.all(sockets.map((name) => closeIfLive(join(dir, name), wait)));
  return found.filter((holder) => holder !== null);
}

function describeLeak(holder: LeakedHolder): string {
  if (holder.terminalId === null) return `${holder.socket} (no answer to hello: ${holder.hello})`;
  const state = holder.closed ? "closed" : "didn't close and exit in time; may still run";
  return `${holder.terminalId} (pid ${holder.holderPid}, ${state})`;
}

export interface TeardownReport {
  readonly problems: readonly string[];
  /** A holder that may still run keeps the home, its tmux refusal and its socket, in place. */
  readonly keep: boolean;
}

/** What a run left behind in its home `dir`, closing any holder that still answers. */
export async function teardownReport(dir: string, wait?: CloseWait): Promise<TeardownReport> {
  const leaked = await closeLiveHolders(holdersDir(dir), wait);
  const ranTmux = existsSync(tmuxDir(dir)) ? readdirSync(tmuxDir(dir)) : [];
  // A tmux server a test started still runs; its socket is how a person stops it.
  const keep = leaked.some((holder) => !holder.closed) || ranTmux.length > 0;
  const problems: string[] = [];
  if (leaked.length > 0) {
    problems.push(
      `Tests left ${leaked.length} holder(s) running: ${leaked.map(describeLeak).join(", ")}. ` +
        "Close every holder a test starts in afterAll (docs/standards/testing.md).",
    );
  }
  if (keep) {
    problems.push(
      `Left ${dir} in place, as a holder or tmux server in it may still be running; ` +
        "remove it once each has exited.",
    );
  }
  if (ranTmux.length > 0) {
    problems.push(
      `A holder test ran tmux, which made ${ranTmux.join(", ")} in ${tmuxDir(dir)}: ` +
        "stop its server by its socket there.",
    );
  }
  return { problems, keep };
}

export async function teardown(): Promise<void> {
  const dir = home;
  home = undefined;
  if (dir === undefined) return;
  const { problems, keep } = await teardownReport(dir);
  if (!keep) rmSync(dir, { recursive: true, force: true });
  if (problems.length > 0) failSetup(problems.join("\n"));
}
