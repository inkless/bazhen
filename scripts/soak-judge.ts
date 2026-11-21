// The verdict on a soak run, from what its driver and workers recorded (scripts/soak.ts,
// scripts/soak-worker.ts): one result per criterion, each judged on its own signal, so a run
// that fails says which promise it broke. Discrete faults (a death, a hang-up, a lost line, a
// seam that differs) count over the whole run, warm-up included; slopes, baselines and echo
// latency only over the measured window.
//
// Nothing passes for want of data. Each criterion needs evidence that it was exercised: the
// terminals the driver opened are what every program, holder, state and attach is checked
// against, so one that never started or was never seen fails. A criterion only a longer run
// could judge, such as a slope over a window shorter than a slope needs, is `unmeasured`, which
// fails the gate and not the smoke run.
//
// Loss is judged on what each attach saw against what the worker had written by then: an attach
// must see every marker written a moment before it, in order, and every worker terminal is
// attached at least twice over its life. Lines that scroll out of a holder's history between two
// attaches are gone by design, and no attach is asked for them.
//
// What the driver must hold to for this to be sound: a terminal's name is never reused, its
// `open` is recorded once the daemon has made it, and its `close` before the close is asked
// for, so nothing the close causes predates it.

import type { Mode } from "./soak-worker.ts";

/** What a terminal runs: a worker's mode, or a real agent. */
export type Load = Mode | "agent";

export interface DaemonSample {
  readonly pid: number;
  readonly rss: number;
  readonly fds: number;
  /** A settled sample's fd count at each of its reads, in order: `fds` is the least of them. */
  readonly fdReads?: readonly number[];
  /** How long this daemon process has run. */
  readonly ageMs: number;
}

export interface HolderSample {
  readonly name: string;
  readonly pid: number;
  readonly load: Load;
  /** Null where the OS won't say. */
  readonly rss: number | null;
  readonly fds: number | null;
  /** A settled sample's fd count at each of its reads, in order: `fds` is the least of them. */
  readonly fdReads?: readonly number[];
  readonly engineBytes: number;
  readonly engineResets: number;
}

/** A terminal as `/v1/state` shows it. */
export interface TerminalSample {
  readonly name: string;
  readonly load: Load;
  readonly state: string;
}

/** Consecutive marker numbers, from the first to the last. */
export type MarkerRun = readonly [first: number, last: number];

/**
 * `numbers` as runs of consecutive numbers, in the order seen: expanded, the runs are `numbers`
 * again. A flood's attach sees millions of markers, which as runs are one or two.
 */
export function markerRuns(numbers: readonly number[]): MarkerRun[] {
  const runs: [number, number][] = [];
  for (const n of numbers) {
    const last = runs.at(-1);
    if (last !== undefined && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

export type SoakEvent =
  /** Warm-up ends at `measure`; the run at `end`. */
  | { readonly kind: "window"; readonly t: number; readonly phase: "measure" | "end" }
  /**
   * The daemon has made a terminal: from here on it has a holder, a state and, unless it runs an
   * agent, a worker.
   */
  | { readonly kind: "open"; readonly t: number; readonly name: string; readonly load: Load }
  | {
      readonly kind: "sample";
      readonly t: number;
      /** Taken with the churn held, every churned thing settled: counts must be at baseline. */
      readonly settled: boolean;
      /** Null while the daemon is down. */
      readonly daemon: DaemonSample | null;
      /** Every holder alive, whether or not the daemon is up. */
      readonly holders: readonly HolderSample[];
      /** Every terminal the daemon shows; empty while it is down. */
      readonly terminals: readonly TerminalSample[];
      /**
       * PTY masters the soak's holders and daemon hold. Not the machine's count, which is the
       * kernel's across every container on it: a test container's would move with the host's
       * terminals. A master some other process held would go uncounted; the children of a
       * closed terminal, which hold its other end, are checked as orphans instead.
       */
      readonly ptys: number;
    }
  /** The driver is about to close a terminal: its holder and program may end from here on. */
  | { readonly kind: "close"; readonly t: number; readonly name: string }
  /** The daemon went down or came back up; `why` says why a daemon no one killed went down. */
  | { readonly kind: "daemon"; readonly t: number; readonly up: boolean; readonly why?: string }
  /** The marker numbers one attach saw, in its snapshot and then in its stream, as runs. */
  | {
      readonly kind: "attach";
      readonly t: number;
      readonly name: string;
      readonly snapshot: readonly MarkerRun[];
      readonly stream: readonly MarkerRun[];
    }
  /** A seam tried on a terminal whose output never paused long enough to compare. */
  | { readonly kind: "unpaused"; readonly t: number; readonly name: string }
  /** A viewer's screen compared cell by cell with the holder's own at the same offset. */
  | { readonly kind: "seam"; readonly t: number; readonly name: string; readonly equal: boolean }
  /** A keystroke typed through a view, until its echo came back; null if it never did. */
  | {
      readonly kind: "echo";
      readonly t: number;
      readonly ms: number | null;
      readonly flooding: boolean;
    }
  /** A program still running after its holder closed. */
  | { readonly kind: "orphan"; readonly t: number; readonly name: string; readonly pid: number }
  | { readonly kind: "panic"; readonly t: number; readonly name: string; readonly line: string }
  | { readonly kind: "start"; readonly t: number; readonly name: string; readonly pid: number }
  | {
      readonly kind: "probe";
      readonly t: number;
      readonly name: string;
      readonly ms: number | null;
    }
  /** Every marker up to `n` has been written to the terminal, as its worker records. */
  | { readonly kind: "marker"; readonly t: number; readonly name: string; readonly n: number }
  /**
   * A churn step the driver took, or tried to: a restart, an agent cycle, an idle shell replaced,
   * an attach, a seam, a settled sample. One that failed says why.
   */
  | {
      readonly kind: "step";
      readonly t: number;
      readonly step: string;
      readonly ok: boolean;
      readonly why?: string;
    }
  | { readonly kind: "hup"; readonly t: number; readonly name: string }
  | { readonly kind: "exit"; readonly t: number; readonly name: string; readonly why: string };

/** How many daemon processes a run has, which decides how its memory is read. */
export type DaemonLives =
  /** Killed and restarted as churn: each life's RSS is read at `ageMs`, so lives compare. */
  | { readonly lives: "many"; readonly ageMs: number }
  /** One process throughout: its RSS is fitted over the window, and going down is a fault. */
  | { readonly lives: "one" };

export interface JudgeOptions {
  /** The shortest measured window that counts: the gate's whole duration. */
  readonly minMeasuredMs: number;
  /** A probe answered after this many milliseconds fails. */
  readonly probeMs: number;
  /** How often each worker probes: a worker silent for several of these has stopped. */
  readonly probeEveryMs: number;
  /** How often the driver samples, which bounds how far past its age a daemon is read. */
  readonly sampleEveryMs: number;
  /**
   * Echo's p99 during floods fails at this many milliseconds or more: over the window, and with
   * one daemon life, in each of its whole hours too, since a heap that ages slows its later hours
   * first. A part hour left at the window's end is judged only within the window's p99.
   */
  readonly echoP99Ms: number;
  /** A holder's RSS slope fails at this many MiB an hour or more. */
  readonly holderSlope: number;
  /** The daemon's RSS slope, across lives or within its one, fails at this many MiB an hour or more. */
  readonly daemonSlope: number;
  readonly daemon: DaemonLives;
  /** The shortest window a slope is judged over: over minutes, noise is all a slope shows. */
  readonly slopeWindowMs: number;
  /**
   * How long a terminal may go without running, creating, starting, unknown or, for an agent the
   * soak made exit, exited, before it counts as stuck.
   */
  readonly startingMs: number;
  readonly engineBudget: Readonly<Record<Load, number>>;
  readonly seamsPerHour: number;
  /**
   * How often the driver takes each churn step that must happen: a window holds at least as many
   * of each as fit in it, less one for where the window falls between two.
   */
  readonly churnEveryMs: Readonly<Record<string, number>>;
  /** Whether `unmeasured` fails the run, as it does for the gate. */
  readonly requireAll: boolean;
}

const MiB = 1 << 20;
const HOUR = 3_600_000;
/** Probe intervals a worker may miss before it counts as stopped: one slow reply isn't silence. */
const SILENT_PROBES = 3;
/** The fewest points a slope is fitted to, after the readings are pooled. */
const MIN_SLOPE_POINTS = 6;
/** The part of the measured window a slope's points must span. */
const SLOPE_COVERAGE = 0.8;
/** How many pools a slope window's readings fall into, each fitted as its median. */
const POOLS_PER_SLOPE_WINDOW = 12;
/** How long a worker shorter-lived than this may go unchecked, and the least it may live. */
const MIN_CHECKED_MS = 30_000;
/**
 * How long a written marker may take to reach a viewer: an attach must see those older. A worker
 * counts a marker written in its write's callback, once the OS has taken the bytes: they are in
 * the PTY and not yet the holder's. A write blocks while the PTY is full, so the holder is behind
 * by one PTY buffer and one flood batch at most, which a holder still reading drains in
 * milliseconds. One that hasn't in a second has stalled, which is a fault.
 */
const WRITE_LAG_MS = 1_000;
/** The fewest daemon lives whose baselines are fitted for growth across lives. */
const MIN_LIVES = 3;
/**
 * The end of a one-life window whose slope is judged again on its own: over a day, a leak that
 * starts late moves the whole window's robust slope hardly at all.
 */
const TAIL_MS = 6 * HOUR;
/** What a float may be off by and still sit on a bar: 1 MiB/h fitted is not 0.9999999. */
const EPSILON = 1e-9;

/** The gate's bars (design §12.4; D1's engine budgets). */
export const GATE: JudgeOptions = {
  minMeasuredMs: 24 * HOUR,
  probeMs: 50,
  probeEveryMs: 10_000,
  sampleEveryMs: 30_000,
  echoP99Ms: 25,
  holderSlope: 0.5,
  daemonSlope: 1,
  daemon: { lives: "many", ageMs: 9 * 60_000 },
  slopeWindowMs: HOUR,
  startingMs: 2 * 60_000,
  churnEveryMs: { restart: 10 * 60_000, agent: 5 * 60_000, idle: 60_000 },
  engineBudget: {
    replay: 8 * MiB,
    agent: 8 * MiB,
    idle: 8 * MiB,
    echo: 8 * MiB,
    flood: 15 * MiB,
  },
  seamsPerHour: 100,
  requireAll: true,
};

export type Status = "pass" | "fail" | "unmeasured";
export interface Criterion {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}
export interface Verdict {
  readonly pass: boolean;
  readonly criteria: readonly Criterion[];
}

type Of<K extends SoakEvent["kind"]> = Extract<SoakEvent, { kind: K }>;
const ofKind = <K extends SoakEvent["kind"]>(events: readonly SoakEvent[], kind: K) =>
  events.filter((e): e is Of<K> => e.kind === kind);

const result = (name: string, faults: readonly string[], measured: string): Criterion =>
  faults.length > 0
    ? { name, status: "fail", detail: faults.join("; ") }
    : { name, status: "pass", detail: measured };
const unmeasured = (name: string, why: string): Criterion => ({
  name,
  status: "unmeasured",
  detail: why,
});
const atLeast = (value: number, bar: number) => value >= bar - EPSILON;

/** The median of `values`, which must not be empty. */
function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? Number.NaN)
    : ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2;
}

type Point = readonly [number, number];

/**
 * The Theil–Sen slope of `points`, in y per x: the median of the slopes between every two points
 * at different x. One reading far off the rest moves it hardly at all, where it would drag a
 * least-squares line. Zero when no two points differ in x.
 */
export function theilSen(points: readonly Point[]): number {
  const slopes: number[] = [];
  for (const [i, [x1, y1]] of points.entries()) {
    for (const [x2, y2] of points.slice(i + 1)) {
      if (x1 !== x2) slopes.push((y2 - y1) / (x2 - x1));
    }
  }
  return slopes.length === 0 ? 0 : median(slopes);
}

/**
 * `points` pooled by x into spans of `width`, each pool as its medians: a day of readings every
 * 30 s, fitted pair by pair, would be millions of slopes.
 */
function pooled(points: readonly Point[], width: number): Point[] {
  const pools = Map.groupBy(points, ([x]) => Math.floor(x / width));
  return [...pools.values()].map((pool) => [
    median(pool.map(([x]) => x)),
    median(pool.map(([, y]) => y)),
  ]);
}

/** The nearest-rank percentile `p` (0–100) of `values`, which must not be empty. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}

/** The largest of `values`, which may be too many to spread into `Math.max`. */
const largest = (values: readonly number[]) => values.reduce((a, b) => (b > a ? b : a), -Infinity);

/** When each terminal's close was recorded. */
type Closes = ReadonlyMap<string, number>;
const closedBy = (closes: Closes, name: string, t: number) => (closes.get(name) ?? Infinity) <= t;

/** What the run recorded, as each criterion reads it. */
interface Run {
  readonly events: readonly SoakEvent[];
  readonly opens: readonly Of<"open">[];
  readonly samples: readonly Of<"sample">[];
  readonly closes: Closes;
  /** The measured window; infinite where the run recorded none. */
  readonly from: number;
  readonly to: number;
  /** The last thing the run recorded. */
  readonly end: number;
  readonly options: JudgeOptions;
}

const hasWindow = (run: Run) => Number.isFinite(run.from) && Number.isFinite(run.to);
const inWindow = <T extends { readonly t: number }>(items: readonly T[], run: Run) =>
  items.filter((item) => item.t >= run.from && item.t <= run.to);
/** Whether the measured window is long enough to fit a slope over. */
const slopeFits = (run: Run) => hasWindow(run) && run.to - run.from >= run.options.slopeWindowMs;

function duration(run: Run) {
  if (!hasWindow(run)) return unmeasured("duration", "the run recorded no measured window");
  const hours = (run.to - run.from) / HOUR;
  const needed = run.options.minMeasuredMs / HOUR;
  return result(
    "duration",
    run.to - run.from < run.options.minMeasuredMs
      ? [`measured ${hours.toFixed(2)} h of ${needed} h`]
      : [],
    `measured ${hours.toFixed(2)} h`,
  );
}

function holderDeaths({ samples, opens, closes }: Run) {
  if (samples.length === 0) return result("holder-deaths", ["no sample was taken"], "");
  const alive = new Map<string, number>();
  const seen = new Set<string>();
  const faults: string[] = [];
  for (const sample of samples) {
    const now = new Map(sample.holders.map((h) => [h.name, h.pid]));
    for (const name of now.keys()) seen.add(name);
    for (const [name, pid] of alive) {
      if (now.get(name) === pid || closedBy(closes, name, sample.t)) continue;
      faults.push(`${name}'s holder ${pid} ${now.has(name) ? "was replaced" : "died"} unasked`);
      alive.delete(name);
    }
    for (const [name, pid] of now) if (!closedBy(closes, name, sample.t)) alive.set(name, pid);
  }
  for (const open of opens) {
    const sampledOpen = samples.some((s) => s.t > open.t && !closedBy(closes, open.name, s.t));
    if (sampledOpen && !seen.has(open.name)) faults.push(`${open.name} never had a holder`);
  }
  return result("holder-deaths", faults, `${samples.length} samples, no holder died unasked`);
}

/**
 * Workers that never started, or whose probes stopped with their terminal open: blocked, or
 * killed with no word.
 */
function silences(run: Run) {
  const silentMs = SILENT_PROBES * run.options.probeEveryMs;
  const startOf = new Map(ofKind(run.events, "start").map((s) => [s.name, s.t]));
  const probesOf = Map.groupBy(ofKind(run.events, "probe"), (p) => p.name);
  return run.opens
    .filter((open) => open.load !== "agent")
    .flatMap((open) => {
      const until = Math.min(run.closes.get(open.name) ?? run.end, run.end);
      const started = startOf.get(open.name);
      if (started === undefined) {
        return until - open.t > silentMs ? [`${open.name} never started`] : [];
      }
      const times = [open.t, started, ...(probesOf.get(open.name) ?? []).map((p) => p.t), until];
      const gap = times.findIndex((t, i) => i > 0 && t - (times[i - 1] ?? t) > silentMs);
      return gap === -1 ? [] : [`${open.name} went silent after ${times[gap - 1]}`];
    });
}

function children(run: Run) {
  const { events, closes } = run;
  const starts = Map.groupBy(ofKind(events, "start"), (s) => s.name);
  const opened = new Set(run.opens.map((o) => o.name));
  const workers = run.opens.filter((o) => o.load !== "agent").length;
  const faults = [
    ...(workers === 0 ? ["no worker terminal was opened"] : []),
    ...[...starts].filter(([, s]) => s.length > 1).map(([name]) => `${name} was started twice`),
    ...[...starts.keys()]
      .filter((name) => !opened.has(name))
      .map((name) => `${name} started in a terminal never opened`),
    ...ofKind(events, "hup")
      .filter((e) => !closedBy(closes, e.name, e.t))
      .map((e) => `${e.name} was hung up unasked`),
    ...ofKind(events, "exit")
      .filter((e) => !closedBy(closes, e.name, e.t))
      .map((e) => `${e.name} exited unasked (${e.why})`),
    ...silences(run),
    ...ofKind(events, "orphan").map((e) => `${e.name}'s program ${e.pid} outlived its holder`),
  ];
  return result("children", faults, `${starts.size} programs, each ended only by its close`);
}

/**
 * Whether a terminal not closed may show `state` for a while, on its way to running: a daemon
 * just started knows its terminals only once it has found their holders again, and the soak makes
 * its agent exit, to respawn it. A shell exits only if it broke.
 */
function passing({ load, state }: TerminalSample, settled: boolean): boolean {
  return (
    state === "creating" ||
    state === "starting" ||
    (state === "unknown" && !settled) ||
    (state === "exited" && load === "agent")
  );
}

function terminalStates({ samples, opens, closes, options }: Run) {
  const up = samples.filter((s) => s.daemon !== null);
  if (up.length === 0) return result("terminal-states", ["no sample saw the daemon up"], "");
  const faults = new Set<string>();
  const since = new Map<string, number>();
  for (const sample of up) {
    const shown = new Set(sample.terminals.map((t) => t.name));
    for (const open of opens) {
      if (open.t < sample.t && !shown.has(open.name) && !closedBy(closes, open.name, sample.t)) {
        faults.add(`${open.name} was missing from the daemon's state`);
      }
    }
    for (const terminal of sample.terminals) {
      if (closedBy(closes, terminal.name, sample.t) || terminal.state === "running") {
        since.delete(terminal.name);
      } else if (passing(terminal, sample.settled)) {
        const from = since.get(terminal.name) ?? sample.t;
        since.set(terminal.name, from);
        if (sample.t - from > options.startingMs) {
          faults.add(`${terminal.name} was stuck ${terminal.state}`);
        }
      } else {
        faults.add(`${terminal.name} was ${terminal.state}`);
      }
    }
  }
  return result("terminal-states", [...faults], `${opens.length} terminals, none lost or broken`);
}

/** Where the numbers `runs` hold skip or repeat: each two in a row that aren't n, n + 1. */
function breaks(runs: readonly MarkerRun[]): string[] {
  const found: string[] = [];
  for (let i = 1; i < runs.length; i++) {
    const [a = 0, b = 0] = [runs[i - 1]?.[1], runs[i]?.[0]];
    if (b !== a + 1) found.push(b <= a ? `${b} after ${a}` : `${a + 1}..${b - 1} missing`);
  }
  return found;
}

const newest = (runs: readonly MarkerRun[]) => largest(runs.map(([, last]) => last));
const howMany = (runs: readonly MarkerRun[]) =>
  runs.reduce((sum, [first, last]) => sum + last - first + 1, 0);

/**
 * Every attach whole and in order, and holding every marker its worker had written a moment
 * before it; and every worker terminal open long enough attached at least twice over its life,
 * its markers moving on between: a terminal whose output stopped, or that no attach saw, proves
 * nothing about loss. One closed sooner than it could be checked is a fault of the run's.
 */
function outputLoss(run: Run) {
  const seen = ofKind(run.events, "attach").map((a) => ({
    ...a,
    runs: [...a.snapshot, ...a.stream],
  }));
  const faults = seen.flatMap((a) => breaks(a.runs).map((b) => `${a.name} at ${a.t}: ${b}`));
  const written = Map.groupBy(ofKind(run.events, "marker"), (m) => m.name);
  for (const a of seen) {
    const before = written.get(a.name)?.findLast((m) => m.t <= a.t - WRITE_LAG_MS);
    const upTo = newest(a.runs);
    if (before !== undefined && upTo < before.n) {
      faults.push(`${a.name} at ${a.t} saw up to ${upTo}, of ${before.n} written`);
    }
  }
  if (!hasWindow(run)) {
    return faults.length > 0
      ? result("output-loss", faults, "")
      : unmeasured("output-loss", "the run recorded no measured window");
  }
  const workers = run.opens.filter((o) => o.load !== "agent");
  if (workers.length === 0) faults.push("no worker terminal was opened");
  const checkable = Map.groupBy(
    seen.filter((a) => howMany(a.runs) >= 2),
    (a) => a.name,
  );
  let watched = 0;
  for (const { name, t: opened } of workers) {
    const closed = run.closes.get(name) ?? Number.POSITIVE_INFINITY;
    // A close after the window is the run's teardown, which closes whatever is open.
    if (closed - opened < MIN_CHECKED_MS && closed <= run.to) {
      faults.push(`${name} was closed ${closed - opened} ms after it opened, too soon to check`);
      continue;
    }
    if (Math.min(closed, run.to) - Math.max(opened, run.from) < MIN_CHECKED_MS) continue;
    watched++;
    const checked = (checkable.get(name) ?? []).filter((a) => a.t >= opened && a.t <= closed);
    const [first, last] = [checked[0], checked.at(-1)];
    if (first === undefined || last === undefined || first === last) {
      faults.push(`${name} was checked ${checked.length} times, not twice`);
    } else if (newest(last.runs) <= newest(first.runs)) {
      faults.push(`${name}'s markers stopped at ${newest(last.runs)}`);
    }
  }
  if (watched === 0) faults.push("no worker terminal was open 30 s of the window to check");
  return result(
    "output-loss",
    faults,
    `${watched} terminals, every marker written seen once, in order, and moving on`,
  );
}

function seams(run: Run) {
  const found = ofKind(run.events, "seam");
  const faults = found.filter((s) => !s.equal).map((s) => `${s.name} at ${s.t} differs`);
  const hours = hasWindow(run) ? (run.to - run.from) / HOUR : 0;
  const measured = inWindow(found, run).length;
  const tries = measured + inWindow(ofKind(run.events, "unpaused"), run).length;
  const rate = `${measured} seams in ${hours.toFixed(2)} measured hours, ${
    hours === 0 ? 0 : Math.round(measured / hours)
  } an hour, of ${tries} tries`;
  if (faults.length === 0 && (hours === 0 || measured / hours < run.options.seamsPerHour)) {
    return unmeasured("seams", rate);
  }
  return result("seams", faults, `${rate}; each equal cell by cell`);
}

/** The spans the daemon was down, from its `daemon` events. */
function downSpans(events: readonly Of<"daemon">[]): Point[] {
  const spans: Point[] = [];
  let downAt: number | undefined;
  for (const e of events) {
    if (!e.up && downAt === undefined) downAt = e.t;
    if (e.up && downAt !== undefined) {
      spans.push([downAt, e.t]);
      downAt = undefined;
    }
  }
  if (downAt !== undefined) spans.push([downAt, Number.POSITIVE_INFINITY]);
  return spans;
}

const worst = (list: readonly Of<"probe">[]) =>
  list.length === 0 ? "none" : `${largest(list.map((p) => p.ms ?? Infinity))} ms`;

/**
 * Every probe answered in time. With a daemon restarted as churn, some must have been taken while
 * it was down, since a holder must answer without it; with one daemon life there is no such time.
 */
function probes({ events, options }: Run) {
  const all = ofKind(events, "probe");
  if (all.length === 0) return result("probes", ["no probe was recorded"], "");
  const faults = all
    .filter((p) => p.ms === null || p.ms > options.probeMs)
    .map((p) => `${p.name} at ${p.t}: ${p.ms === null ? "no reply" : `${p.ms} ms`}`);
  if (options.daemon.lives === "one") {
    return result("probes", faults, `${all.length} probes, worst ${worst(all)}`);
  }
  const spans = downSpans(ofKind(events, "daemon"));
  const down = all.filter((p) => spans.some(([from, to]) => p.t >= from && p.t <= to));
  if (faults.length === 0 && down.length === 0) {
    return unmeasured("probes", "no probe was taken while the daemon was down");
  }
  return result(
    "probes",
    faults,
    `${all.length} probes, worst ${worst(all)}; ${down.length} while the daemon was down, worst ${worst(down)}`,
  );
}

/**
 * Why `points`, in hours, can't carry a slope over the window: too few of them, or spanning too
 * little of it. Undefined when they can.
 */
function thin(points: readonly Point[], window: number): string | undefined {
  if (points.length < MIN_SLOPE_POINTS) return `${points.length} points`;
  const span = ((points.at(-1)?.[0] ?? 0) - (points[0]?.[0] ?? 0)) * HOUR;
  return span < SLOPE_COVERAGE * window
    ? `points over ${(span / HOUR).toFixed(2)} h of ${(window / HOUR).toFixed(2)}`
    : undefined;
}

/**
 * The slope of RSS `readings`, each a time and bytes, in MiB an hour, over a span `window` long;
 * `thin` says why they can't carry one.
 */
function rssSlope(
  readings: readonly Point[],
  run: Run,
  window = run.to - run.from,
): { perHour: number; thin?: string } {
  const poolMs = run.options.slopeWindowMs / POOLS_PER_SLOPE_WINDOW;
  const points = pooled(readings, poolMs).map(([t, rss]): Point => [t / HOUR, rss / MiB]);
  const why = thin(points, window);
  return { perHour: theilSen(points), ...(why !== undefined && { thin: why }) };
}

function holderSlopes(run: Run) {
  const { options } = run;
  if (!slopeFits(run)) {
    return unmeasured("holder-memory", "the measured window is shorter than a slope needs");
  }
  const samples = inWindow(run.samples, run);
  const last = samples.at(-1);
  const kept = (samples[0]?.holders ?? []).filter((h) =>
    last?.holders.some((l) => l.name === h.name && l.pid === h.pid),
  );
  const faults: string[] = [];
  if (kept.length === 0) faults.push("no holder was read at both ends of the window");
  for (const holder of kept) {
    const readings = samples.flatMap((s): Point[] => {
      const rss = s.holders.find((h) => h.name === holder.name && h.pid === holder.pid)?.rss;
      return rss === null || rss === undefined ? [] : [[s.t, rss]];
    });
    const { perHour, thin: why } = rssSlope(readings, run);
    if (why !== undefined) faults.push(`${holder.name}'s holder had too few RSS readings: ${why}`);
    else if (atLeast(perHour, options.holderSlope)) {
      faults.push(`${holder.name}'s holder grew ${perHour.toFixed(2)} MiB/h`);
    }
  }
  return result(
    "holder-memory",
    faults,
    `${kept.length} holders, each under ${options.holderSlope} MiB/h`,
  );
}

function engineBudget({ samples, options }: Run) {
  const over = new Map<string, string>();
  let readings = 0;
  for (const sample of samples) {
    for (const h of sample.holders) {
      readings++;
      const budget: number | undefined = options.engineBudget[h.load];
      if (over.has(h.name)) continue;
      if (budget === undefined) over.set(h.name, `${h.name} runs ${h.load}, which has no budget`);
      else if (!(h.engineBytes <= budget)) {
        over.set(h.name, `${h.name}'s engine held ${h.engineBytes} bytes, over ${budget}`);
      }
    }
  }
  const faults = readings === 0 ? ["no holder's engine was read"] : [...over.values()];
  return result("engine-budget", faults, `${readings} readings, every engine within its budget`);
}

/**
 * Settled counts against their baselines. The machine's PTYs stay at the first settled sample's.
 * The daemon's fds, and each holder's, stay at each daemon life's baseline: its second settled
 * count, since a restart is a new daemon, which opens some of what it needs on first use, and a
 * holder's fds include its daemon's connections. One such is a terminal's control connection
 * (runtime-holder's `Control`), opened on the terminal's first input or resize and kept while any
 * stream views it: one per viewed terminal, which never grows. The first settled count of a life,
 * before that first use, is its warm-up.
 * Across lives the baselines must not climb: a robust slope over them, one point a life, above
 * zero is a leak each restart adds to, while one lazy step stays at zero.
 */
function counts(run: Run) {
  const settled = inWindow(run.samples, run).filter((s) => s.settled);
  const [base] = settled;
  if (base === undefined || settled.length < 2) {
    return unmeasured("counts", "fewer than two settled samples in the measured window");
  }
  /** Each process's counts in each daemon life, in order. */
  const lives = new Map<string, Map<number, { t: number; fds: number }[]>>();
  const faults: string[] = [];
  const count = (process: string, life: number, fds: number, t: number) => {
    const byLife = lives.get(process) ?? new Map<number, { t: number; fds: number }[]>();
    lives.set(process, byLife);
    byLife.set(life, [...(byLife.get(life) ?? []), { t, fds }]);
  };
  for (const sample of settled) {
    if (sample.ptys !== base.ptys) {
      faults.push(`${sample.ptys} PTYs at ${sample.t}, not ${base.ptys}`);
    }
    const daemon = sample.daemon;
    if (daemon === null) continue;
    count("the daemon", daemon.pid, daemon.fds, sample.t);
    for (const h of sample.holders) {
      if (h.fds !== null) count(`${h.name}'s holder`, daemon.pid, h.fds, sample.t);
    }
  }
  let compared = 0;
  for (const [process, byLife] of lives) {
    const baselines: Point[] = [];
    for (const [warmUp, baseline, ...after] of byLife.values()) {
      if (warmUp === undefined || baseline === undefined) continue;
      baselines.push([baselines.length, baseline.fds]);
      for (const later of after) {
        compared++;
        if (later.fds !== baseline.fds) {
          faults.push(`${process} held ${later.fds} fds at ${later.t}, not ${baseline.fds}`);
        }
      }
    }
    const perLife = theilSen(baselines);
    if (baselines.length >= MIN_LIVES && perLife > 0) {
      faults.push(`${process}'s fds grew ${perLife.toFixed(2)} a daemon life`);
    }
  }
  if (faults.length === 0 && compared === 0) {
    return unmeasured("counts", "no daemon life had a settled count past its baseline");
  }
  return result("counts", faults, `${compared} settled counts, each at its life's baseline`);
}

function daemonMemory(run: Run) {
  const { daemon } = run.options;
  return daemon.lives === "one" ? daemonInOneLife(run) : daemonAcrossLives(run, daemon.ageMs);
}

/**
 * The daemon's RSS read once in each life that began in the window, at the same age, so lives
 * compare like with like: a life already running when the window opened was started at no age
 * the window saw, and one read well past the age has grown for longer.
 */
function daemonAcrossLives(run: Run, ageMs: number) {
  const { options } = run;
  if (!slopeFits(run)) {
    return unmeasured("daemon-memory", "the measured window is shorter than a slope needs");
  }
  const atAge = new Map<number, Point>();
  for (const s of inWindow(run.samples, run)) {
    const d = s.daemon;
    const readable =
      d !== null &&
      s.t - d.ageMs >= run.from &&
      d.ageMs >= ageMs &&
      d.ageMs <= ageMs + options.sampleEveryMs;
    if (readable && !atAge.has(d.pid)) atAge.set(d.pid, [s.t / HOUR, d.rss / MiB]);
  }
  const points = [...atAge.values()];
  const why = thin(points, run.to - run.from);
  if (why !== undefined) {
    return result("daemon-memory", [`too few daemon lives read at their age: ${why}`], "");
  }
  const perHour = theilSen(points);
  return result(
    "daemon-memory",
    atLeast(perHour, options.daemonSlope)
      ? [`the daemon grew ${perHour.toFixed(2)} MiB/h across lives`]
      : [],
    `${points.length} lives, ${perHour.toFixed(2)} MiB/h`,
  );
}

const mib = (bytes: number) => (bytes / MiB).toFixed(1);

/**
 * The one daemon's RSS over the whole window, fitted as a holder's is. The run is premised on that
 * daemon living throughout, so its going down at any time, a sample it didn't answer in the
 * window, or a second pid there, is a fault, and the driver ends a run whose daemon died.
 */
function daemonInOneLife(run: Run): Criterion {
  const { options } = run;
  const faults = ofKind(run.events, "daemon")
    .filter((d) => !d.up)
    .map(
      (d) =>
        `the daemon went down at ${new Date(d.t).toISOString()}` +
        (d.why === undefined ? "" : `: ${d.why}`),
    );
  if (faults.length === 0 && !slopeFits(run)) {
    return unmeasured("daemon-memory", "the measured window is shorter than a slope needs");
  }
  const samples = inWindow(run.samples, run);
  const unanswered = samples.filter((s) => s.daemon === null);
  const [firstUnanswered] = unanswered;
  if (firstUnanswered !== undefined) {
    faults.push(
      `the daemon went unread in ${unanswered.length} of the window's ${samples.length} ` +
        `samples, first at ${new Date(firstUnanswered.t).toISOString()}`,
    );
  }
  const readings = samples.flatMap((s): Point[] =>
    s.daemon === null ? [] : [[s.t, s.daemon.rss]],
  );
  const pids = new Set(samples.flatMap((s) => (s.daemon === null ? [] : [s.daemon.pid])));
  if (pids.size > 1)
    faults.push(`the daemon ran as ${pids.size} processes: ${[...pids].join(", ")}`);
  if (!slopeFits(run)) return result("daemon-memory", faults, "");
  const { perHour, thin: why } = rssSlope(readings, run);
  if (why !== undefined) {
    faults.push(`too few daemon RSS readings: ${why}`);
    return result("daemon-memory", faults, "");
  }
  if (atLeast(perHour, options.daemonSlope)) {
    faults.push(`the daemon grew ${perHour.toFixed(2)} MiB/h in its one life`);
  }
  let slopes = `${perHour.toFixed(2)} MiB/h`;
  if (run.to - run.from > TAIL_MS) {
    const tailFrom = run.to - TAIL_MS;
    const tail = rssSlope(
      readings.filter(([t]) => t >= tailFrom),
      run,
      TAIL_MS,
    );
    const hours = TAIL_MS / HOUR;
    if (tail.thin !== undefined) {
      faults.push(`too few daemon RSS readings in the last ${hours} h: ${tail.thin}`);
    } else if (atLeast(tail.perHour, options.daemonSlope)) {
      faults.push(`the daemon grew ${tail.perHour.toFixed(2)} MiB/h over the last ${hours} h`);
    }
    slopes += `, ${tail.perHour.toFixed(2)} over the last ${hours} h`;
  }
  const rss = readings.map(([, bytes]) => bytes);
  const measured =
    `one life, ${slopes}; RSS ${mib(rss[0] ?? 0)} MiB at the window's start, ` +
    `${mib(rss.at(-1) ?? 0)} at its end, ${mib(largest(rss))} at most`;
  // The baseline the run is for, reported beside whatever else failed.
  return faults.length === 0
    ? result("daemon-memory", [], measured)
    : { name: "daemon-memory", status: "fail", detail: [...faults, measured].join("; ") };
}

const p99Of = (echoes: readonly Of<"echo">[]) =>
  percentile(
    echoes.map((e) => e.ms ?? Infinity),
    99,
  );

function echo(run: Run) {
  const found = ofKind(run.events, "echo");
  const lost = found.filter((e) => e.ms === null).length;
  const flooded = inWindow(found, run).filter((e) => e.flooding);
  const p99 = flooded.length === 0 ? 0 : p99Of(flooded);
  const faults = [
    ...(lost > 0 ? [`${lost} keystrokes never echoed`] : []),
    ...(flooded.length > 0 && atLeast(p99, run.options.echoP99Ms)
      ? [`echo p99 ${p99} ms during floods`]
      : []),
  ];
  if (faults.length === 0 && flooded.length === 0) {
    return unmeasured("echo", "no keystroke was timed during a flood");
  }
  const measured = `${flooded.length} keystrokes during floods, p99 ${p99} ms`;
  const hours = hasWindow(run) ? Math.floor((run.to - run.from) / HOUR) : 0;
  if (run.options.daemon.lives === "many" || hours === 0) return result("echo", faults, measured);
  const byHour = Map.groupBy(flooded, (e) => Math.floor((e.t - run.from) / HOUR));
  let worstHour = 0;
  for (let hour = 0; hour < hours; hour++) {
    const echoes = byHour.get(hour) ?? [];
    if (echoes.length === 0) {
      faults.push(`no keystroke was timed during a flood in hour ${hour + 1}`);
      continue;
    }
    const hourly = p99Of(echoes);
    worstHour = Math.max(worstHour, hourly);
    if (atLeast(hourly, run.options.echoP99Ms)) {
      faults.push(`echo p99 ${hourly} ms during floods in hour ${hour + 1}`);
    }
  }
  return result("echo", faults, `${measured}; worst hour's p99 ${worstHour} ms`);
}

/**
 * The churn itself: every step the driver took went through, and the window holds as many of
 * each required step as its cadence fits. A soak whose churn stopped judges a quiet machine.
 */
function churn(run: Run) {
  const steps = ofKind(run.events, "step");
  const faults = steps
    .filter((s) => !s.ok)
    .map((s) => `${s.step} failed at ${s.t}${s.why === undefined ? "" : `: ${s.why}`}`);
  if (!hasWindow(run)) {
    return faults.length > 0
      ? result("churn", faults, "")
      : unmeasured("churn", "the run recorded no measured window");
  }
  const done = inWindow(steps, run).filter((s) => s.ok);
  for (const [step, everyMs] of Object.entries(run.options.churnEveryMs)) {
    const expected = Math.floor((run.to - run.from) / everyMs) - 1;
    const took = done.filter((s) => s.step === step).length;
    if (took < expected) faults.push(`${took} ${step} steps in the window, not ${expected}`);
  }
  return result("churn", faults, `${done.length} churn steps in the window, none failed`);
}

function engine({ events, samples }: Run) {
  const read = samples.some((s) => s.holders.length > 0);
  const reset = new Set(
    samples.flatMap((s) => s.holders.filter((h) => h.engineResets > 0).map((h) => h.name)),
  );
  const faults = [
    ...(read ? [] : ["no holder's stats were read"]),
    ...ofKind(events, "panic").map((p) => `${p.name}'s holder logged: ${p.line}`),
    ...[...reset].map((name) => `${name}'s engine was reset`),
  ];
  return result("engine", faults, "no panic logged, no engine reset");
}

export function judge(events: readonly SoakEvent[], options: JudgeOptions = GATE): Verdict {
  const ordered = events.toSorted((a, b) => a.t - b.t);
  const windows = ofKind(ordered, "window");
  const run: Run = {
    events: ordered,
    opens: ofKind(ordered, "open"),
    samples: ofKind(ordered, "sample"),
    closes: new Map(ofKind(ordered, "close").map((c) => [c.name, c.t])),
    from: windows.find((w) => w.phase === "measure")?.t ?? Number.POSITIVE_INFINITY,
    to: windows.find((w) => w.phase === "end")?.t ?? Number.POSITIVE_INFINITY,
    end: ordered.at(-1)?.t ?? 0,
    options,
  };
  const criteria = [
    duration(run),
    holderDeaths(run),
    children(run),
    terminalStates(run),
    outputLoss(run),
    seams(run),
    probes(run),
    holderSlopes(run),
    engineBudget(run),
    counts(run),
    daemonMemory(run),
    echo(run),
    churn(run),
    engine(run),
  ];
  const pass = criteria.every(
    (c) => c.status === "pass" || (c.status === "unmeasured" && !options.requireAll),
  );
  return { pass, criteria };
}

/** The verdict as lines a person reads, failures first. */
export function report(verdict: Verdict): string {
  const rank: Record<Status, number> = { fail: 0, unmeasured: 1, pass: 2 };
  const lines = verdict.criteria
    .toSorted((a, b) => rank[a.status] - rank[b.status])
    .map((c) => `${c.status.toUpperCase().padEnd(10)} ${c.name.padEnd(16)} ${c.detail}`);
  return [...lines, verdict.pass ? "soak passed" : "soak failed"].join("\n");
}
