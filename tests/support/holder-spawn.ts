// The one way a holder test starts a process: in the run's HOME, with an environment
// ./holder-home.ts checks, so nothing it starts can reach the user's tmux servers or files.
// tests/holder may not import child_process or node-pty itself (scripts/lint-config.ts); the
// helper that spawns a real holder belongs here too, passing its spec's env the same way.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HolderStartFailed, inSignalSandbox, readProcess, startHolder } from "@bazhen/host-guard";
import { HOLDER_PROTOCOL_VERSION, type HolderTheme } from "@bazhen/protocol";
import { connectHolder, type HolderClient } from "@bazhen/runtime-holder";
import {
  holderEnv,
  holderProcessSpec,
  holderSocket,
  requireHolderEnv,
  runDir,
  testHome,
  userDir,
} from "./holder-home.ts";
import { requireSignalSandbox } from "./disposable-host.ts";
import { record } from "./holder-ledger.ts";

/** Runs `argv` to its end in the run's HOME, with `env`, which `requireHolderEnv` must pass. */
export function runInHome(
  argv: readonly [string, ...string[]],
  env: Readonly<Record<string, string>> = holderEnv(),
): SpawnSyncReturns<string> {
  const [file, ...args] = argv;
  return spawnSync(file, args, {
    env: requireHolderEnv(env),
    cwd: userDir(testHome()),
    encoding: "utf8",
  });
}

/** The pid of a process that has exited and been reaped, as a closed holder's is. */
export const exitedPid = (): number => runInHome(["true"]).pid;

/** The binaries `pnpm test:holder` builds first (`build:holder`). */
export const HOLDER_BINARY = fileURLToPath(
  new URL("../../target/debug/bazhen-holder", import.meta.url),
);
/** The engine's replay bin, which feeds a recording to an engine of its own and reports its stats. */
const REPLAY_BINARY = fileURLToPath(
  new URL("../../target/debug/bazhen-holder-replay", import.meta.url),
);
/** What `bazhen-holder-replay` says of an engine it fed a recording. */
export interface EngineReport {
  readonly engineBytes: number;
  readonly historyBytes: number;
  readonly historyRows: number;
}

function isEngineReport(parsed: unknown): parsed is EngineReport {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "engineBytes" in parsed &&
    typeof parsed.engineBytes === "number" &&
    "historyBytes" in parsed &&
    typeof parsed.historyBytes === "number" &&
    "historyRows" in parsed &&
    typeof parsed.historyRows === "number"
  );
}

/**
 * Feeds `recording` to an engine of the replay bin's own, of `size` keeping `historyLines` rows,
 * and returns its stats: what a holder's engine fed the same bytes must report.
 */
export function replayEngine(
  recording: string,
  size: { readonly cols: number; readonly rows: number },
  historyLines: number,
): EngineReport {
  const args = [String(size.cols), String(size.rows), String(historyLines), "1", recording];
  const run = spawnSync(REPLAY_BINARY, args, { input: "", encoding: "utf8" });
  if (run.status !== 0) throw new Error(`the replay bin failed: ${run.stderr || run.error}`);
  const parsed: unknown = JSON.parse(run.stdout);
  if (!isEngineReport(parsed)) throw new Error(`the replay bin said ${run.stdout}`);
  return parsed;
}

/** CPU-seconds a holder may use: one that spins, under a mutant say, dies of SIGXCPU instead. */
const CPU_SECONDS = 10;
const CLOSE_MS = 5_000;

export interface SpawnedHolder {
  readonly terminalId: string;
  readonly socket: string;
  readonly pid: number;
  /** Its exit code, once it has exited; null for a signal. */
  readonly exited: Promise<number | null>;
  /** Its ledger entry, which `closeHolder` removes. */
  readonly entry: string;
}

/**
 * Starts a holder for `terminalId` running `argv`, as the daemon does, through host-guard's
 * `startHolder`, and waits for `ready`. Its socket is the run's, its child's env what
 * `holderEnv()` builds, and it is recorded in the ledger before it reads its spec, so a run that
 * dies before closing it has it swept by the next.
 */
export async function spawnHolder(
  terminalId: string,
  argv: readonly [string, ...string[]],
  {
    theme,
    sandboxed = inSignalSandbox(),
    bareHolder = false,
  }: {
    readonly theme?: HolderTheme;
    readonly sandboxed?: boolean;
    /** Start the holder itself with no environment at all, as the daemon does. */
    readonly bareHolder?: boolean;
  } = {},
): Promise<SpawnedHolder> {
  requireSignalSandbox(sandboxed);
  const socket = holderSocket(terminalId);
  const spec = {
    protocol: [HOLDER_PROTOCOL_VERSION],
    terminalId,
    socket,
    tags: {},
    size: { cols: 80, rows: 24 },
    ...holderProcessSpec(argv),
    ...(theme === undefined ? {} : { theme }),
  };
  let entry: string | undefined;
  try {
    const started = await startHolder({
      binary: HOLDER_BINARY,
      root: runDir(testHome()),
      spec,
      env: bareHolder ? {} : requireHolderEnv(holderEnv()),
      cwd: userDir(testHome()),
      launcher: ["/bin/sh", "-c", `ulimit -t ${CPU_SECONDS} && exec "$0" "$@"`],
      onStarted: async ({ pid, start }) => {
        entry = await record(pid, start, socket);
      },
    });
    return { terminalId, socket, pid: started.pid, exited: started.exited, entry: entry! };
  } catch (error) {
    // One left running stays recorded, for the next run's sweep to kill.
    const running = error instanceof HolderStartFailed && error.running;
    if (entry !== undefined && !running) rmSync(entry, { force: true });
    throw error;
  }
}

const closed = new WeakMap<SpawnedHolder, Promise<number | null>>();

/**
 * Closes a holder by the protocol and waits, for `within` ms at most, for it to hang up and exit,
 * with its exit code; one already exited just has its exit code returned. Closing one twice is
 * closing it once. Its ledger entry goes once its exit is seen; one that didn't exit stays
 * recorded, for the next run's sweep to kill.
 */
export function closeHolder(holder: SpawnedHolder, within = CLOSE_MS): Promise<number | null> {
  const already = closed.get(holder);
  if (already !== undefined) return already;
  const closing = (async () => {
    const before = await exitedAlready(holder);
    if (before !== null) {
      forget(holder);
      return before.code;
    }
    const signal = AbortSignal.timeout(within);
    const deadline = new Promise<never>((_, refuse) =>
      signal.addEventListener("abort", () => refuse(signal.reason)),
    );
    // Its refusal matters only where it is raced, below; one that never is goes unhandled.
    deadline.catch(() => {});
    let client: HolderClient | undefined;
    try {
      client = await connectHolder(holder.socket, { onEvent: () => {}, signal });
      await client.close({ signal });
      await Promise.race([client.ended, deadline]);
      const code = await Promise.race([holder.exited, deadline]);
      forget(holder);
      return code;
    } catch (error) {
      if (!signal.aborted) throw error;
      throw new Error(`the holder ${holder.pid} didn't close within ${within} ms`, {
        cause: error,
      });
    } finally {
      client?.end();
    }
  })();
  closed.set(holder, closing);
  return closing;
}

/** Its exit code if it has already exited, without waiting for it: null if it hasn't. */
const exitedAlready = (holder: SpawnedHolder) =>
  Promise.race([
    holder.exited.then((code) => ({ code })),
    // A macrotask runs after every settled promise's callbacks, so an exit seen wins.
    new Promise<null>((done) => setImmediate(() => done(null))),
  ]);

/** Forgets a holder seen to exit, so the ledger keeps no entry for it. */
function forget(holder: SpawnedHolder): void {
  rmSync(holder.entry, { force: true });
}

export { START_SKEW_S } from "@bazhen/host-guard";

/** When `pid` started, in epoch seconds, as `ps` says; null for a pid with no process. */
export async function processStart(pid: number): Promise<number | null> {
  const reading = await readProcess(pid);
  if (reading === "absent") return null;
  if (reading === "unreadable") throw new Error(`ps can't say what ${pid} is`);
  return reading.start;
}
