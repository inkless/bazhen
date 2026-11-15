// Runs a command under a memory cap and a time cap, so a test that runs away dies alone instead of
// taking the machine's memory, and with it whatever the kernel or systemd picks to end next.
//
// Where a systemd user manager can enforce it, the command runs in a scope of its own inside one
// slice that every capped run shares. The kernel then kills only the biggest process in a scope
// past its cap, and the slice keeps all capped runs together below the machine's memory.
// Elsewhere (macOS, CI runners, containers) a watchdog sums the anonymous memory of the command's
// process tree, and stops the whole group it started when the tree passes the cap: it never
// signals a pid read from a listing.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { totalmem } from "node:os";
import { isAlive, signalGroup, spawnGroup } from "./signal.ts";

export interface Cap {
  readonly memory: number;
  readonly timeMs: number;
}

/** How a capped run ended, and what its memory did. */
export interface Ended {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly peak: number;
  readonly memoryKills: number;
  readonly timedOut: boolean;
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly why: string };

export const SLICE = "bazhen-tests.slice";
/** Where systemd puts `SLICE`: a dash in a slice's name nests it under the slice before it. */
const SLICE_DIR = "bazhen.slice/bazhen-tests.slice";
const UNIT = /^bazhen-capped-[\w-]+\.scope$/;
/** The first systemd whose scopes take `OOMPolicy`; older ones end the whole scope instead. */
export const MIN_SYSTEMD = 253;
const PAGE = 4096;
const STOP_GRACE_MS = 10_000;
const STEP_TIMEOUT_MS = 10_000;
/** Names the variable a capped run hands its children: `<mode>:<unit or watchdog pid>`. */
export const CAPPED_ENV = "BZ_CAPPED";

const page = (bytes: number) => Math.floor(bytes / PAGE) * PAGE;

/** A run's own cap, at most half the machine, so it can fire on a machine smaller than it. */
export const clampMemory = (bytes: number, total = totalmem()) => page(Math.min(bytes, total / 2));

/** What all capped runs together may use: most of the machine, never all of it. */
export const sliceMemory = (total = totalmem()) => page(total * 0.6);

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The unified-hierarchy cgroup a `/proc/<pid>/cgroup` names. */
export const cgroupOf = (text: string) => /^0::(\/\S*)$/m.exec(text)?.[1];

/**
 * The memory cap of the capped scope this process runs in, read from the kernel rather than the
 * environment, which anything can set; undefined outside one.
 */
export function cappedScope(read = readText): number | undefined {
  const path = cgroupOf(read("/proc/self/cgroup") ?? "");
  const parts = path?.split("/") ?? [];
  if (!UNIT.test(parts.at(-1) ?? "") || parts.at(-2) !== SLICE) return undefined;
  const max = Number(read(`/sys/fs/cgroup${path}/memory.max`)?.trim());
  return Number.isSafeInteger(max) && max > 0 ? max : undefined;
}

/** The watchdog pid a fallback run hands its children, if that watchdog is still alive. */
export function fallbackWatchdog(env: NodeJS.ProcessEnv, alive = isAlive): number | undefined {
  const pid = Number(/^fallback:(\d+)$/.exec(env[CAPPED_ENV] ?? "")?.[1]);
  return Number.isInteger(pid) && pid > 1 && alive(pid) ? pid : undefined;
}

export function scopeArgv(unit: string, cap: Cap, command: string, args: readonly string[]) {
  return [
    "--user",
    "--scope",
    "--quiet",
    `--unit=${unit}`,
    `--slice=${SLICE}`,
    "-p",
    `MemoryMax=${cap.memory}`,
    "-p",
    "MemorySwapMax=0",
    "-p",
    "OOMPolicy=continue",
    "-p",
    `RuntimeMaxSec=${Math.ceil(cap.timeMs / 1000)}`,
    "-p",
    "TimeoutStopSec=10",
    // A scope that failed (timed out, or killed) would otherwise stay listed until reset.
    "-p",
    "CollectMode=inactive-or-failed",
    "--",
    command,
    ...args,
  ];
}

/** What a probe read from inside a scope started like a real one. */
export interface ProbeReading {
  readonly version?: number | undefined;
  readonly memory?: string | undefined;
  readonly swap?: string | undefined;
  readonly slice?: string | undefined;
}

/** Whether a probe's reading shows systemd enforcing the caps it was asked for. */
export function judgeProbe(cap: Cap, slice: number, got: ProbeReading): Verdict {
  if (got.version === undefined) return { ok: false, why: "systemd-run is missing" };
  if (got.version < MIN_SYSTEMD) {
    return { ok: false, why: `systemd ${got.version} is older than ${MIN_SYSTEMD}` };
  }
  const want = [
    ["memory.max", got.memory, cap.memory],
    ["memory.swap.max", got.swap, 0],
    [`the slice's memory.max`, got.slice, slice],
  ] as const;
  for (const [name, value, expected] of want) {
    if (value?.trim() !== String(expected)) {
      return {
        ok: false,
        why: `a probe scope's ${name} reads ${value?.trim() ?? "nothing"}, not ${expected}`,
      };
    }
  }
  return { ok: true };
}

const PROBE_SCRIPT = `
const { readFileSync: r } = require("node:fs");
const at = (p) => { try { return r(p, "utf8"); } catch { return undefined; } };
const cg = "/sys/fs/cgroup" + /^0::(\\/\\S*)$/m.exec(at("/proc/self/cgroup") ?? "")?.[1];
process.stdout.write(JSON.stringify({
  memory: at(cg + "/memory.max"),
  swap: at(cg + "/memory.swap.max"),
  slice: at(cg.slice(0, cg.lastIndexOf("/")) + "/memory.max"),
}));`;

function output(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(command, args, { timeout: STEP_TIMEOUT_MS }, (error, stdout) =>
      done(error === null ? stdout : undefined),
    );
  });
}

let units = 0;
const unitName = () => `bazhen-capped-${process.pid}-${(units += 1)}.scope`;

/**
 * Whether systemd enforces `cap` here: it sets the shared slice's cap, then starts a scope like a
 * real one and reads the caps from inside it. A user manager without the memory controller takes
 * `MemoryMax` and enforces nothing, and only reading it back tells the two apart.
 */
export async function probeSystemd(cap: Cap, slice = sliceMemory()): Promise<Verdict> {
  const versionText = await output("systemd-run", ["--version"]);
  const version = Number(/^systemd (\d+)/.exec(versionText ?? "")?.[1]);
  if (!Number.isInteger(version)) return judgeProbe(cap, slice, {});
  if (version < MIN_SYSTEMD) return judgeProbe(cap, slice, { version });
  const set = await output("systemctl", [
    "--user",
    "set-property",
    "--runtime",
    SLICE,
    `MemoryMax=${slice}`,
    "MemorySwapMax=0",
  ]);
  if (set === undefined) return { ok: false, why: `systemctl couldn't set ${SLICE}'s cap` };
  const probe = { memory: cap.memory, timeMs: STEP_TIMEOUT_MS };
  const read = await output(
    "systemd-run",
    scopeArgv(unitName(), probe, process.execPath, ["-e", PROBE_SCRIPT]),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(read ?? "");
  } catch {
    return { ok: false, why: "a probe scope wouldn't start" };
  }
  const field = (name: string) => {
    const value: unknown =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, name) : undefined;
    return typeof value === "string" ? value : undefined;
  };
  return judgeProbe(cap, slice, {
    version,
    memory: field("memory"),
    swap: field("swap"),
    slice: field("slice"),
  });
}

/** The bytes a `memory.stat` counts as anonymous, and the kills a `memory.events` counts. */
export const statAnon = (text: string) => Number(/^anon (\d+)$/m.exec(text)?.[1] ?? 0);
export const oomKills = (text: string) => Number(/^oom_kill (\d+)$/m.exec(text)?.[1] ?? 0);

/**
 * Hands SIGTERM and SIGHUP to `handler` while a run lasts. SIGINT goes to it only for a child in
 * a group of its own: otherwise the terminal sent it to the child as well, and a second one makes
 * vitest and pnpm abandon their cleanup, so it is only waited out.
 */
function onSignals(handler: (signal: NodeJS.Signals) => void, ownGroup: boolean): () => void {
  const onInt = ownGroup ? handler : () => undefined;
  const forwarded = ["SIGTERM", "SIGHUP"] as const;
  process.on("SIGINT", onInt);
  for (const signal of forwarded) process.on(signal, handler);
  return () => {
    process.off("SIGINT", onInt);
    for (const signal of forwarded) process.off(signal, handler);
  };
}

/**
 * Runs a command in a capped scope. Signals reach the whole scope through systemd, which also
 * reaches processes in other groups (nextest gives each test its own), and a scope that outlives
 * a stop request by 10 s is killed. The child stays in this process's group, so a signal to the
 * group, from nextest or a terminal, reaches the command directly too.
 */
export function runInScope(
  command: string,
  args: readonly string[],
  cap: Cap,
  env: NodeJS.ProcessEnv,
): Promise<Ended> {
  const unit = unitName();
  const uid = process.getuid?.() ?? 0;
  const dir = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/${SLICE_DIR}/${unit}`;
  const started = Date.now();
  let peak = 0;
  let kills = 0;
  let watcher: FSWatcher | undefined;
  const sample = () => {
    peak = Math.max(peak, statAnon(readText(`${dir}/memory.stat`) ?? ""));
    kills = Math.max(kills, oomKills(readText(`${dir}/memory.events`) ?? ""));
    if (watcher !== undefined) return;
    try {
      watcher = watch(`${dir}/memory.events`, sample);
    } catch {
      // The scope isn't there yet, or is already gone: the poll keeps reading.
    }
  };
  const kill = (signal: NodeJS.Signals) =>
    void output("systemctl", ["--user", "kill", `--signal=${signal}`, unit]);
  let escalation: NodeJS.Timeout | undefined;
  const offSignals = onSignals((signal) => {
    kill(signal);
    escalation ??= setTimeout(() => kill("SIGKILL"), STOP_GRACE_MS);
  }, false);
  const child = spawn("systemd-run", scopeArgv(unit, cap, command, args), {
    stdio: "inherit",
    env: { ...env, [CAPPED_ENV]: `systemd:${unit}` },
  });
  // The kernel counts a kill a moment before the scope empties and its cgroup goes, so the counter
  // is read often, and on every change once the watcher is on.
  const poll = setInterval(sample, 20);
  return new Promise((done) => {
    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      sample();
      clearInterval(poll);
      clearTimeout(escalation);
      watcher?.close();
      offSignals();
      const timedOut = Date.now() - started >= cap.timeMs;
      if (kills === 0 && (signal !== null || code !== 0)) kills = await journaledKills(unit);
      done({ code, signal, peak, memoryKills: kills, timedOut });
    };
    child.once("error", () => void finish(127, null));
    child.once("exit", (code, signal) => void finish(code, signal));
  });
}

/** The OOM kills systemd logged for a unit: a scope's cgroup can go before its counter is read. */
export const journalKills = (text: string) =>
  text.split("\n").filter((l) => l.includes("killed by the OOM killer")).length;

async function journaledKills(unit: string): Promise<number> {
  // systemd may log the kill a moment after the scope's last process has gone.
  for (let tries = 0; tries < 5; tries += 1) {
    const text = await output("journalctl", ["--user", "-u", unit, "-o", "cat", "--no-pager"]);
    const kills = journalKills(text ?? "");
    if (kills > 0) return kills;
    await new Promise((wait) => setTimeout(wait, 100));
  }
  return 0;
}

/** A process's parent and its anonymous memory, as a listing reports them. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly bytes: number;
}

/** `root` and every process below it, by parent pid: a child in a group of its own counts. */
export function treeRows(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const tree: ProcessRow[] = [];
  const seen = new Set<number>();
  const stack = rows.filter((r) => r.pid === root);
  for (let row = stack.pop(); row !== undefined; row = stack.pop()) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    tree.push(row);
    stack.push(...(children.get(row.pid) ?? []));
  }
  return tree;
}

const sum = (rows: readonly ProcessRow[]) => rows.reduce((total, r) => total + r.bytes, 0);

const UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/**
 * The rows of `top -l 1 -stats pid,ppid,mem`. MEM is darwin's footprint, which counts compressed
 * memory: RSS leaves it out, and a loop that repeats the same data compresses well.
 */
export function parseTop(text: string): ProcessRow[] {
  return [...text.matchAll(/^\s*(\d+)\s+(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/gm)].map(
    ([, pid, ppid, size, unit]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      bytes: Math.round(Number(size) * (UNITS[unit ?? "B"] ?? 1)),
    }),
  );
}

/** A `/proc/<pid>/stat`'s parent pid: the second field after the command's closing paren. */
export const statParent = (text: string) =>
  Number(text.slice(text.lastIndexOf(")") + 2).split(" ")[1]);
/** A `/proc/<pid>/status`'s anonymous resident memory, in bytes. */
export const statusAnon = (text: string) =>
  Number(/^RssAnon:\s+(\d+) kB$/m.exec(text)?.[1] ?? 0) * 1024;

function linuxRows(): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readText(`/proc/${name}/stat`);
    if (stat === undefined) continue;
    rows.push({ pid: Number(name), ppid: statParent(stat), bytes: 0 });
  }
  return rows;
}

/** The tree's memory: `/proc` on Linux, `top` on darwin. */
async function sampleTree(root: number): Promise<number> {
  if (process.platform === "darwin") {
    const top = await output("top", ["-l", "1", "-stats", "pid,ppid,mem"]);
    return sum(treeRows(parseTop(top ?? ""), root));
  }
  return sum(
    treeRows(linuxRows(), root).map((r) => ({
      ...r,
      bytes: statusAnon(readText(`/proc/${r.pid}/status`) ?? ""),
    })),
  );
}

/**
 * Runs a command in a process group of its own and watches its tree's memory: past the cap the
 * group gets SIGKILL at once (at gigabytes a second, a grace period is gigabytes more), and past
 * the time cap SIGTERM, then SIGKILL 10 s later.
 */
export function runWatched(
  command: string,
  args: readonly string[],
  cap: Cap,
  env: NodeJS.ProcessEnv,
): Promise<Ended> {
  const child: ChildProcess = spawnGroup(command, args, {
    stdio: "inherit",
    env: { ...env, [CAPPED_ENV]: `fallback:${process.pid}` },
  });
  const pid = child.pid;
  let peak = 0;
  let kills = 0;
  let timedOut = false;
  let sampling = false;
  const stop = (signal: NodeJS.Signals) => {
    try {
      signalGroup(child, signal);
    } catch {
      // The group has gone.
    }
  };
  const offSignals = onSignals(stop, true);
  const watchdog = setInterval(
    () => {
      if (sampling || pid === undefined) return;
      sampling = true;
      void sampleTree(pid).then((bytes) => {
        sampling = false;
        peak = Math.max(peak, bytes);
        if (bytes > cap.memory && kills === 0) {
          kills = 1;
          stop("SIGKILL");
        }
      });
    },
    process.platform === "darwin" ? 1000 : 250,
  );
  let escalation: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    stop("SIGTERM");
    escalation = setTimeout(() => stop("SIGKILL"), STOP_GRACE_MS);
  }, cap.timeMs);
  return new Promise((done) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearInterval(watchdog);
      clearTimeout(timer);
      clearTimeout(escalation);
      offSignals();
      done({ code, signal, peak, memoryKills: kills, timedOut });
    };
    child.once("error", () => finish(127, null));
    child.once("exit", finish);
  });
}

/**
 * Runs a command inside a capped run that already covers it, in this process's group, and ends
 * the way it ended. Signals to this process alone are waited out: the group's reach the child.
 */
export function runThrough(command: string, args: readonly string[]): Promise<Ended> {
  const offSignals = onSignals(() => undefined, false);
  const child = spawn(command, args, { stdio: "inherit" });
  return new Promise((done) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      offSignals();
      done({ code, signal, peak: 0, memoryKills: 0, timedOut: false });
    };
    child.once("error", () => finish(127, null));
    child.once("exit", finish);
  });
}

/** How a capped run runs: its own scope, a watchdog over its tree, or inside the run around it. */
export type Mode = "scope" | "watched" | "through";

export interface ModeDeps {
  readonly inScope: () => boolean;
  readonly watchdog: (env: NodeJS.ProcessEnv) => number | undefined;
  readonly probe: (cap: Cap) => Promise<Verdict>;
}

const realDeps: ModeDeps = {
  inScope: () => cappedScope() !== undefined,
  watchdog: (env) => fallbackWatchdog(env),
  probe: (cap) => probeSystemd(cap),
};

/**
 * How to run under `cap`. Inside a capped scope a new one needs no probe. A test binary inside a
 * watched run is already covered by its watchdog, and one outside any capped run where systemd
 * can't cap is refused: the alternative is a watchdog per test process. A whole command where
 * systemd can't cap gets a watchdog, and `note` says why.
 */
export async function chooseMode(
  cap: Cap,
  testBinary: boolean,
  env: NodeJS.ProcessEnv,
  deps: ModeDeps = realDeps,
): Promise<{ mode: Mode; note?: string } | { refused: string }> {
  if (deps.inScope()) return { mode: "scope" };
  if (testBinary && deps.watchdog(env) !== undefined) return { mode: "through" };
  const verdict = await deps.probe(cap);
  if (verdict.ok) return { mode: "scope" };
  return testBinary ? { refused: verdict.why } : { mode: "watched", note: verdict.why };
}

export function runIn(
  mode: Mode,
  command: string,
  args: readonly string[],
  cap: Cap,
  env: NodeJS.ProcessEnv,
): Promise<Ended> {
  if (mode === "scope") return runInScope(command, args, cap, env);
  if (mode === "watched") return runWatched(command, args, cap, env);
  return runThrough(command, args);
}

/**
 * Why this process can't count as inside a capped run, or undefined when it is. Under systemd
 * that is read from the kernel. The variable a watched run hands its children counts only where
 * systemd can't cap, so setting it by hand on a host that can is no way round the cap.
 */
export async function cappedRunRefusal(
  env: NodeJS.ProcessEnv,
  deps: ModeDeps = realDeps,
): Promise<string | undefined> {
  if (deps.inScope()) return undefined;
  if (deps.watchdog(env) === undefined) return "it isn't inside a capped run";
  const verdict = await deps.probe({ memory: 64 * 1024 ** 2, timeMs: STEP_TIMEOUT_MS });
  return verdict.ok
    ? `${CAPPED_ENV} names a watchdog, but systemd can cap a run here, so it doesn't count`
    : undefined;
}
