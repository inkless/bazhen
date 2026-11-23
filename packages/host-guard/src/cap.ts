// Runs a command under a memory cap and a time cap, so a test that runs away dies alone instead of
// taking the machine's memory, and with it whatever the kernel or systemd picks to end next.
//
// Where a systemd user manager can enforce it, the command runs in a scope of its own inside one
// slice that every capped run shares. The kernel then kills only the biggest process in a scope
// past its cap, and the slice keeps all capped runs together below the machine's memory.
// Elsewhere (macOS, CI runners, containers) a watchdog sums the anonymous memory of the command's
// process tree, and stops the group it started when the tree passes the cap. A test binary there
// is capped by the runner that spawned it, which may signal its own child, because a test in a
// process group of its own (nextest gives each one) is out of the group's reach. Nothing here
// signals a pid read from a listing.

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import {
  MIN_SYSTEMD,
  PROBE_SCRIPT,
  cgroupOf,
  parseProbe,
  readText,
  scopeArgs,
  systemdVersion,
  uniqueUnit,
  type ProbeReading,
} from "./scope.ts";
import { heard } from "./child.ts";
import { isAlive, rethrowUnsafe, signalGroup, spawnGroup } from "./signal.ts";

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
  /**
   * The processes still in the run's own scope or group once its command had gone and they had had
   * `LEFTOVER_SETTLE_MS` to end, which the run then stopped. A test binary's is 0: its runner
   * doesn't count them.
   */
  readonly leftover: number;
  /** Why a memory kill may have gone uncounted, when one may have. */
  readonly uncounted?: string;
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly why: string };

export const SLICE = "bazhen-tests.slice";
/** Where systemd puts `SLICE`: a dash in a slice's name nests it under the slice before it. */
const SLICE_DIR = "bazhen.slice/bazhen-tests.slice";
const UNIT = /^bazhen-capped-[\w-]+\.scope$/;
const MIB = 1024 ** 2;
const STOP_GRACE_MS = 10_000;
const STEP_TIMEOUT_MS = 10_000;
/** Names the variable a capped run hands its children: `<mode>:<unit or watchdog pid>`. */
export const CAPPED_ENV = "BZ_CAPPED";

// Whole MiB: a multiple of every page size, so a cap reads back from the kernel as it was set.
const wholeMib = (bytes: number) => Math.floor(bytes / MIB) * MIB;

/**
 * A run's own cap, at most half the machine, and at most 90% of a memory limit on a cgroup it
 * runs in. In a container `totalmem()` reports the host's memory, and a cap above the container's
 * own limit would never fire before the container's OOM. The container's limit is this run's
 * budget already, so only the margin a cap needs to fire first comes off it.
 */
export const clampMemory = (bytes: number, total = totalmem(), cgroup = cgroupLimit()) =>
  wholeMib(Math.min(bytes, total / 2, cgroup * 0.9));

/**
 * The smallest `memory.max` on the way from this process's cgroup up to the root, or Infinity:
 * in a container's own cgroup namespace its path is `/`, whose `memory.max` is the container's.
 */
export function cgroupLimit(read = readText): number {
  const path = cgroupOf(read("/proc/self/cgroup") ?? "");
  if (path === undefined) return Infinity;
  const parts = path.split("/").filter(Boolean);
  let limit = Infinity;
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const dir = parts.slice(0, depth).join("/");
    const max = Number(read(`/sys/fs/cgroup${dir === "" ? "" : `/${dir}`}/memory.max`)?.trim());
    if (Number.isSafeInteger(max) && max > 0) limit = Math.min(limit, max);
  }
  return limit;
}

/** What all capped runs together may use: most of the machine, never all of it. */
export const sliceMemory = (total = totalmem()) => wholeMib(total * 0.6);

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

/** A `/proc/<pid>/stat`'s fields after the command, whose parens may hold spaces and parens. */
const statFields = (text: string) => text.slice(text.lastIndexOf(")") + 2).split(" ");

/** A `/proc/<pid>/stat`'s parent pid: the second field after the command's closing paren. */
export const statParent = (text: string) => Number(statFields(text)[1]);

/** Whether a `/proc/<pid>/stat` is a live process in group `pgid`; a zombie holds nothing. */
export function statInGroup(text: string, pgid: number): boolean {
  const [state = "", , pgrp] = statFields(text);
  return Number(pgrp) === pgid && state !== "Z" && state !== "X";
}

/** How many live processes `ps -o pgid=,stat=`'s rows put in group `pgid`. */
export const psGroupCount = (text: string, pgid: number) =>
  [...text.matchAll(/^\s*(\d+)\s+(\S+)\s*$/gm)].filter(
    ([, group, stat = ""]) => Number(group) === pgid && !/^[ZX]/.test(stat),
  ).length;

/** How many live processes are in group `pgid`: a read of `/proc` or `ps`, no signal. */
async function groupCount(pgid: number): Promise<number> {
  if (process.platform === "darwin") {
    return psGroupCount((await output("ps", ["-A", "-o", "pgid=,stat="])) ?? "", pgid);
  }
  let count = 0;
  for (const entry of readdirSync("/proc")) {
    if (/^\d+$/.test(entry) && statInGroup(readText(`/proc/${entry}/stat`) ?? "", pgid)) count++;
  }
  return count;
}

/**
 * How long a run waits, once its command has gone and something is still in it, before it counts
 * that again: a process killed, or ending, as the command exits is gone by then, so it isn't left
 * over. A run whose command left nothing doesn't wait.
 */
export const LEFTOVER_SETTLE_MS = 500;

/** `count`'s answer once the end of the command has settled: a second read, after the settle. */
async function settledCount(count: () => number | Promise<number>): Promise<number> {
  if ((await count()) === 0) return 0;
  await new Promise((wait) => setTimeout(wait, LEFTOVER_SETTLE_MS));
  return count();
}

function parentOf(pid: number): number | undefined {
  if (process.platform === "linux") {
    const stat = readText(`/proc/${pid}/stat`);
    return stat === undefined ? undefined : statParent(stat);
  }
  try {
    const ppid = Number(
      execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }),
    );
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pid` is an ancestor of this process, walking parent pids up to init. */
export function isAncestor(pid: number, parent = parentOf, self = process.pid): boolean {
  const seen = new Set<number>();
  for (let at = parent(self); at !== undefined && at > 1 && !seen.has(at); at = parent(at)) {
    if (at === pid) return true;
    seen.add(at);
  }
  return false;
}

/**
 * The watchdog a watched run hands its children, if the variable names a live ancestor of this
 * process: one left over from another run, or set by hand, names some other process.
 */
export function fallbackWatchdog(
  env: NodeJS.ProcessEnv,
  alive = isAlive,
  ancestor: (pid: number) => boolean = isAncestor,
): number | undefined {
  const pid = Number(/^fallback:(\d+)$/.exec(env[CAPPED_ENV] ?? "")?.[1]);
  return Number.isInteger(pid) && pid > 1 && alive(pid) && ancestor(pid) ? pid : undefined;
}

export function scopeArgv(unit: string, cap: Cap, command: string, args: readonly string[]) {
  return [
    ...scopeArgs(unit, SLICE, [
      `MemoryMax=${cap.memory}`,
      "MemorySwapMax=0",
      "OOMPolicy=continue",
      `RuntimeMaxSec=${Math.ceil(cap.timeMs / 1000)}`,
      "TimeoutStopSec=10",
      // A scope that failed (timed out, or killed) would otherwise stay listed until reset.
      "CollectMode=inactive-or-failed",
    ]),
    command,
    ...args,
  ];
}

/** Whether a probe's reading shows systemd enforcing the caps it was asked for. */
export function judgeProbe(
  cap: Cap,
  slice: number,
  got: ProbeReading & { readonly version?: number | undefined },
): Verdict {
  if (got.version === undefined) return { ok: false, why: "systemd-run is missing" };
  if (got.version < MIN_SYSTEMD) {
    return { ok: false, why: `systemd ${got.version} is older than ${MIN_SYSTEMD}` };
  }
  const want = [
    ["memory.max", got.memory, cap.memory],
    ["memory.swap.max", got.swap, 0],
    [`the slice's memory.max`, got.slice, slice],
    [`the slice's memory.swap.max`, got.sliceSwap, 0],
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

function output(
  command: string,
  args: readonly string[],
  timeout = STEP_TIMEOUT_MS,
): Promise<string | undefined> {
  return new Promise((done) => {
    heard(
      execFile(command, args, { timeout }, (error, stdout) =>
        done(error === null ? stdout : undefined),
      ),
    );
  });
}

const unitName = () => uniqueUnit(`bazhen-capped-${process.pid}`);

/**
 * Whether systemd enforces `cap` here: it sets the shared slice's cap, then starts a scope like a
 * real one and reads the caps from inside it. A user manager without the memory controller takes
 * `MemoryMax` and enforces nothing, and only reading it back tells the two apart.
 */
export async function probeSystemd(cap: Cap, slice = sliceMemory()): Promise<Verdict> {
  const version = systemdVersion((await output("systemd-run", ["--version"])) ?? "");
  if (version === undefined) return judgeProbe(cap, slice, {});
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
  const reading = parseProbe(read ?? "");
  if (reading === undefined) return { ok: false, why: "a probe scope wouldn't start" };
  return judgeProbe(cap, slice, { version, ...reading });
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
 * a stop request by 10 s is killed. Once the command has gone, so does its scope: whatever it
 * left behind, counted first, would otherwise run on to the time cap, holding cargo's lock. The
 * child stays in this process's group, so a signal to the group, from nextest or a terminal,
 * reaches it too.
 *
 * A kill the command outlived goes uncounted when the command exits before the counter is read
 * again, taking the scope with it. `asRun`, for a run rather than a test binary, reads the journal
 * after any run that saw none, at about half a second a run, and counts what the command left;
 * without it, the journal is read only after a command that died by SIGKILL, and nothing is
 * counted.
 */
export function runInScope(
  command: string,
  args: readonly string[],
  cap: Cap,
  env: NodeJS.ProcessEnv,
  asRun = false,
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
  // A zombie isn't listed, and the scope may already have gone with its last process.
  const procs = () => (readText(`${dir}/cgroup.procs`) ?? "").split("\n").filter(Boolean);
  const kill = (signal: NodeJS.Signals) =>
    output("systemctl", ["--user", "kill", `--signal=${signal}`, unit]);
  let escalation: NodeJS.Timeout | undefined;
  const offSignals = onSignals((signal) => {
    void kill(signal);
    escalation ??= setTimeout(() => void kill("SIGKILL"), STOP_GRACE_MS);
  }, false);
  const child = heard(
    spawn("systemd-run", scopeArgv(unit, cap, command, args), {
      stdio: "inherit",
      env: { ...env, [CAPPED_ENV]: `systemd:${unit}` },
    }),
  );
  // The kernel counts a kill a moment before the scope empties and its cgroup goes, so the counter
  // is read often, and on every change once the watcher is on.
  const poll = setInterval(sample, 20);
  return new Promise((done) => {
    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      // Before the settle and the stop, which may wait out a leftover ignoring SIGTERM.
      const timedOut = Date.now() - started >= cap.timeMs;
      sample();
      clearInterval(poll);
      watcher?.close();
      const leftover = asRun ? await settledCount(() => procs().length) : 0;
      // `stop` sends what is left SIGTERM, and SIGKILL after the scope's TimeoutStopSec of 10 s,
      // and returns once it has gone.
      await output("systemctl", ["--user", "stop", unit], STOP_GRACE_MS + STEP_TIMEOUT_MS);
      clearTimeout(escalation);
      offSignals();
      const journaled =
        kills === 0 && (asRun || signal === "SIGKILL")
          ? await journaledKills(unit, started)
          : { memoryKills: kills };
      done({ code, signal, peak, timedOut, leftover, ...journaled });
    };
    child.once("error", () => void finish(127, null));
    child.once("exit", (code, signal) => void finish(code, signal));
  });
}

/**
 * systemd's id for a unit's OOM kill. Its text is reworded between releases (systemd 259 has
 * "The kernel OOM killer killed some processes in this unit."); the id is not.
 */
const UNIT_OOM_MESSAGE_ID = "fe6faa94e7774663a0da52717891d8ef";

const messageId = (line: string): unknown => {
  try {
    const entry: unknown = JSON.parse(line);
    return typeof entry === "object" && entry !== null && "MESSAGE_ID" in entry
      ? entry.MESSAGE_ID
      : undefined;
  } catch {
    return undefined;
  }
};

/** The OOM kills systemd logged for a unit, in `journalctl -o json`'s one entry a line. */
export const journalKills = (text: string) =>
  text.split("\n").filter((line) => messageId(line) === UNIT_OOM_MESSAGE_ID).length;

/**
 * journalctl's arguments for the OOM kills systemd logged for `unit` since `since`, matched by id
 * in the journal and printed as the id alone, so the output stays a line an entry however much
 * the unit logged.
 */
export const journalArgs = (unit: string, since: number) => [
  "--user",
  "-u",
  unit,
  `MESSAGE_ID=${UNIT_OOM_MESSAGE_ID}`,
  `--since=@${Math.floor(since / 1000)}`,
  "-o",
  "json",
  "--output-fields=MESSAGE_ID",
  "--no-pager",
];

async function journaledKills(
  unit: string,
  since: number,
): Promise<Pick<Ended, "memoryKills" | "uncounted">> {
  // systemd may log the kill a moment after the scope's last process has gone.
  for (let tries = 0; tries < 5; tries += 1) {
    const text = await output("journalctl", journalArgs(unit, since));
    if (text === undefined) return { memoryKills: 0, uncounted: JOURNAL_UNREAD };
    const kills = journalKills(text);
    if (kills > 0) return { memoryKills: kills };
    await new Promise((wait) => setTimeout(wait, 100));
  }
  return { memoryKills: 0 };
}

const JOURNAL_UNREAD =
  "journalctl couldn't be read, so a memory kill logged after the scope had gone may have gone uncounted";

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

/**
 * The rows of `ps -o pid=,ppid=,rss=`, its sizes in KiB. On darwin that is resident memory, which
 * leaves out compressed memory. top's footprint counts it, but a `top -l 1` costs about 170 ms of
 * CPU against `ps`'s 4 ms (measured on CI's macOS runner), and a sampler runs once a second for
 * every test process.
 */
export function parsePs(text: string): ProcessRow[] {
  return [...text.matchAll(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/gm)].map(([, pid, ppid, kib]) => ({
    pid: Number(pid),
    ppid: Number(ppid),
    bytes: Number(kib) * 1024,
  }));
}

/**
 * A `/proc/<pid>/status`'s own anonymous memory in bytes, resident and swapped out. Shared memory
 * is left to `smapsShmem`: counted here, it would count once for every process that maps it.
 */
export function statusAnon(text: string): number {
  return (kib(text, "RssAnon") + kib(text, "VmSwap")) * 1024;
}

const kib = (text: string, field: string) =>
  Number(new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(text)?.[1] ?? 0);

/** A `/proc/<pid>/smaps_rollup`'s share of the shared memory it maps, in bytes. */
export const smapsShmem = (text: string) => kib(text, "Pss_Shmem") * 1024;

/** A process's memory: its own anonymous memory, and its proportional share of what it shares. */
function processMemory(pid: number): number {
  const status = readText(`/proc/${pid}/status`) ?? "";
  // smaps_rollup walks the process's page tables, so it is read only where there is shmem.
  const shared =
    kib(status, "RssShmem") > 0 ? smapsShmem(readText(`/proc/${pid}/smaps_rollup`) ?? "") : 0;
  return statusAnon(status) + shared;
}

/** `root` and its descendants, from each thread's `children` file: no scan of all of `/proc`. */
function linuxTree(root: number): number[] {
  const tree: number[] = [];
  const stack = [root];
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (tree.includes(pid)) continue;
    tree.push(pid);
    let tasks: string[] = [];
    try {
      tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
      continue;
    }
    for (const task of tasks) {
      const children = readText(`/proc/${pid}/task/${task}/children`) ?? "";
      stack.push(...children.split(" ").filter(Boolean).map(Number));
    }
  }
  return tree;
}

/** The memory of `root` and, but for darwin's `onlyRoot`, its tree: `/proc` or `ps`. */
async function sampleTree(root: number, onlyRoot: boolean): Promise<number> {
  if (process.platform === "darwin") {
    const which = onlyRoot ? ["-p", String(root)] : ["-A"];
    const ps = await output("ps", [...which, "-o", "pid=,ppid=,rss="]);
    return sum(treeRows(parsePs(ps ?? ""), root));
  }
  return linuxTree(root).reduce((total, pid) => total + processMemory(pid), 0);
}

const SAMPLE_MS = process.platform === "darwin" ? 500 : 100;
// Under nextest's own grace of 10 s, so the group's kill lands before nextest kills the runner and
// leaves the group with no one watching it.
const FORWARD_GRACE_MS = 5_000;

/** What a group's own watchdog samples: its whole tree, its root alone, or nothing. */
type Watch = "tree" | "root" | "none";

/**
 * Runs `bin` in a process group of its own and, but for `none`, watches its memory. Past the
 * memory cap the group gets SIGKILL at once (at gigabytes a second, a grace period is gigabytes
 * more); past the time cap, or on a SIGTERM or SIGHUP passed on to it, SIGTERM, then SIGKILL if
 * it hasn't gone. Once the command has gone, whatever it left in its group is killed, and with
 * `countsLeftover` counted first.
 */
async function runGroup(
  bin: string,
  argv: readonly string[],
  cap: Cap,
  env: NodeJS.ProcessEnv,
  watching: Watch,
  countsLeftover: boolean,
): Promise<Ended> {
  const scopeKillsBefore = watching === "none" ? scopeKills() : 0;
  const child = spawnGroup(bin, argv, {
    stdio: "inherit",
    env: watching === "none" ? env : { ...env, [CAPPED_ENV]: `fallback:${process.pid}` },
  });
  const pid = child.pid;
  const stop = (signal: NodeJS.Signals) => {
    try {
      signalGroup(child, signal);
    } catch (error) {
      // The group has gone; a refused target is a fault, and surfaces.
      rethrowUnsafe(error);
    }
  };
  let peak = 0;
  let kills = 0;
  let timedOut = false;
  let sampling = false;
  let escalation: NodeJS.Timeout | undefined;
  const stopSoon = (signal: NodeJS.Signals, graceMs: number) => {
    stop(signal);
    escalation ??= setTimeout(() => stop("SIGKILL"), graceMs);
  };
  const offSignals = onSignals((signal) => stopSoon(signal, FORWARD_GRACE_MS), true);
  const watchdog = setInterval(() => {
    if (sampling || pid === undefined || watching === "none") return;
    sampling = true;
    void sampleTree(pid, watching === "root").then((bytes) => {
      sampling = false;
      peak = Math.max(peak, bytes);
      if (bytes > cap.memory && kills === 0) {
        kills = 1;
        stop("SIGKILL");
      }
    });
  }, SAMPLE_MS);
  const timer = setTimeout(() => {
    timedOut = true;
    stopSoon("SIGTERM", STOP_GRACE_MS);
  }, cap.timeMs);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) => {
    child.once("error", () => done([127, null]));
    child.once("exit", (c, s) => done([c, s]));
  });
  clearInterval(watchdog);
  clearTimeout(timer);
  clearTimeout(escalation);
  const leftover =
    countsLeftover && pid !== undefined ? await settledCount(() => groupCount(pid)) : 0;
  stop("SIGKILL");
  offSignals();
  // A run through dies of the enclosing scope's cap: one that died by SIGKILL while the scope
  // counted an OOM kill is taken as that kill.
  if (watching === "none" && signal === "SIGKILL" && scopeKills() > scopeKillsBefore) kills = 1;
  return { code, signal, peak, memoryKills: kills, timedOut, leftover };
}

/** Runs a command in a process group of its own, watching its tree and stopping the group. */
export function runWatched(
  command: string,
  args: readonly string[],
  cap: Cap,
  env: NodeJS.ProcessEnv,
): Promise<Ended> {
  return runGroup(command, args, cap, env, "tree", true);
}

/**
 * The setpriv that can set a parent-death signal: util-linux before 2.33 has no `--pdeathsig`, and
 * would refuse every test with "unknown option", so a dry run decides, the first time a runner
 * needs it rather than whenever host-guard is imported.
 */
let setprivFound: string | null | undefined;
function setprivWithPdeathsig(): string | null {
  if (setprivFound !== undefined) return setprivFound;
  setprivFound = null;
  const path = ["/usr/bin/setpriv", "/bin/setpriv"].find((p) => existsSync(p));
  if (path === undefined) return null;
  try {
    execFileSync(path, ["--pdeathsig", "KILL", "--", "true"], { stdio: "ignore", timeout: 2_000 });
    setprivFound = path;
  } catch {
    // Too old for --pdeathsig, or it hung.
  }
  return setprivFound;
}

/**
 * The CPU time, in seconds, a test binary may use while no runner watches it. The kernel counts CPU
 * summed over every thread, so the wall-clock time cap is multiplied by the cores a test could use:
 * the runner's timer is the real time cap, and this only ends a test whose runner has died.
 */
export const cpuLimit = (cap: Cap, cores = availableParallelism()) =>
  Math.ceil(cap.timeMs / 1000) * cores;

/**
 * The argv that starts a test binary under limits that hold it even if its runner is killed and
 * leaves it unwatched:
 * - a CPU-time limit, everywhere, its soft limit 10 s below its hard one, so the test gets SIGXCPU,
 *   which says why, before the kernel's SIGKILL;
 * - on Linux, a data limit (RLIMIT_DATA counts anonymous mappings), a quarter above the cap, so the
 *   watchdog's kill comes first and says why, and never below 2 GiB, since a runtime's own
 *   reservations under a smaller one (V8's) would stop it starting;
 * - on Linux where util-linux's `setpriv` can, SIGKILL when its runner dies. The signal is set after
 *   the fork, so a runner that dies in that moment still leaves its test running.
 * darwin has no data limit that counts mappings and no parent-death signal, so a test whose runner
 * was killed there is bounded by its CPU time alone.
 */
export function ownedArgv(
  command: string,
  args: readonly string[],
  cap: Cap,
  platform = process.platform,
  setpriv = setprivWithPdeathsig(),
  cores = availableParallelism(),
): [string, string[]] {
  const cpu = cpuLimit(cap, cores);
  const cpuArgs = [String(cpu), String(cpu + 10)];
  const cpuScript = 'ulimit -S -t "$1" && ulimit -H -t "$2" && shift 2';
  if (platform !== "linux") {
    return ["sh", ["-c", `${cpuScript} && exec "$@"`, "sh", ...cpuArgs, command, ...args]];
  }
  const data = String(Math.ceil(Math.max(cap.memory * 1.25, 2 * 1024 ** 3) / 1024));
  const script = `ulimit -d "$1" && shift && ${cpuScript} && exec "$@"`;
  const limited = ["sh", "-c", script, "sh", data, ...cpuArgs, command, ...args];
  return setpriv === null
    ? ["sh", limited.slice(1)]
    : [setpriv, ["--pdeathsig", "KILL", "--", ...limited]];
}

/**
 * Runs a test binary in a group of its own that its runner watches, where systemd can't cap it:
 * nextest gives each test a group, so the runner, which spawned the test, is the one process
 * that may stop the test and anything the test starts.
 */
export function runOwned(
  command: string,
  args: readonly string[],
  cap: Cap,
  env: NodeJS.ProcessEnv,
): Promise<Ended> {
  const [bin, argv] = ownedArgv(command, args, cap);
  return runGroup(bin, argv, cap, env, "root", false);
}

/** The OOM kills the capped scope this process runs in has counted so far. */
function scopeKills(read = readText): number {
  const path = cgroupOf(read("/proc/self/cgroup") ?? "");
  return path === undefined ? 0 : oomKills(read(`/sys/fs/cgroup${path}/memory.events`) ?? "");
}

/**
 * Runs a command inside the capped scope around it, so the scope's memory cap holds it, in a
 * group of its own that keeps its own time cap: a scope's runtime is the outer run's, and longer.
 * `asRun`, for a run rather than a test binary, counts what the command left in its group.
 */
export function runThrough(
  command: string,
  args: readonly string[],
  cap: Cap,
  env: NodeJS.ProcessEnv,
  asRun = false,
): Promise<Ended> {
  return runGroup(command, args, cap, env, "none", asRun);
}

/**
 * How a capped run runs: in a scope of its own, watched in a group of its own, a test binary
 * watched by its runner, or inside the capped scope around it.
 */
export type Mode = "scope" | "watched" | "owned" | "through";

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
 * How to run under `cap`, and, when systemd can't cap here, why. Inside a capped scope a command
 * runs through, so the scope's cap holds it too: a scope of its own would be a sibling, outside
 * that cap. Anywhere else it gets a scope of its own, or a watch where systemd can't cap.
 */
export async function chooseMode(
  cap: Cap,
  testBinary: boolean,
  deps: ModeDeps = realDeps,
): Promise<{ mode: Mode; note?: string }> {
  if (deps.inScope()) return { mode: "through" };
  const verdict = await deps.probe(cap);
  if (verdict.ok) return { mode: "scope" };
  return { mode: testBinary ? "owned" : "watched", note: verdict.why };
}

/**
 * Runs `command` as `mode` says. `asRun` is for a run rather than a test binary: it counts what
 * the command left, and under systemd every kill the command outlived (`runInScope`).
 */
export function runIn(
  mode: Mode,
  command: string,
  args: readonly string[],
  cap: Cap,
  env: NodeJS.ProcessEnv,
  asRun = false,
): Promise<Ended> {
  if (mode === "scope") return runInScope(command, args, cap, env, asRun);
  if (mode === "watched") return runWatched(command, args, cap, env);
  if (mode === "owned") return runOwned(command, args, cap, env);
  return runThrough(command, args, cap, env, asRun);
}

/**
 * Why this process can't count as inside a capped run, or undefined when it is. Under systemd
 * that is read from the kernel. The variable a watched run hands its children counts only when it
 * names a live ancestor, and only where systemd can't cap, so setting it by hand is no way round.
 */
export async function cappedRunRefusal(
  env: NodeJS.ProcessEnv,
  deps: ModeDeps = realDeps,
): Promise<string | undefined> {
  if (deps.inScope()) return undefined;
  if (deps.watchdog(env) === undefined) return "it isn't inside a capped run";
  const verdict = await deps.probe({ memory: 64 * MIB, timeMs: STEP_TIMEOUT_MS });
  return verdict.ok
    ? `${CAPPED_ENV} names a watchdog, but systemd can cap a run here, so it doesn't count`
    : undefined;
}
