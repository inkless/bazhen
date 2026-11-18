import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GATE,
  type HolderSample,
  type JudgeOptions,
  judge,
  markerRuns,
  percentile,
  report,
  type SoakEvent,
  theilSen,
} from "./soak-judge.ts";

const MiB = 1 << 20;
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const MEASURE = 10 * MIN;
const END = 130 * MIN;
const LIFE = 10 * MIN;

/** The gate's bars over a two-hour run, with seams sampled at a rate a test can list. */
const OPTIONS: JudgeOptions = { ...GATE, minMeasuredMs: 2 * HOUR, seamsPerHour: 10 };

const HOLDERS: readonly HolderSample[] = [
  {
    name: "r1",
    pid: 101,
    load: "replay",
    rss: 10 * MiB,
    fds: 8,
    engineBytes: 2 * MiB,
    engineResets: 0,
  },
  {
    name: "f1",
    pid: 102,
    load: "flood",
    rss: 12 * MiB,
    fds: 8,
    engineBytes: 3 * MiB,
    engineResets: 0,
  },
  {
    name: "i1",
    pid: 103,
    load: "idle",
    rss: 6 * MiB,
    fds: 7,
    engineBytes: 1 * MiB,
    engineResets: 0,
  },
  {
    name: "e1",
    pid: 104,
    load: "echo",
    rss: 6 * MiB,
    fds: 9,
    engineBytes: 1 * MiB,
    engineResets: 0,
  },
  {
    name: "a1",
    pid: 105,
    load: "agent",
    rss: 9 * MiB,
    fds: 8,
    engineBytes: 2 * MiB,
    engineResets: 0,
  },
];
const WORKERS = ["r1", "f1", "i1", "e1"];
const TERMINALS = HOLDERS.map((h) => ({ name: h.name, load: h.load, state: "running" }));

/** An attach at `t` that saw markers moving on a minute's worth since the last. */
function attachAt(t: number, name: string): SoakEvent {
  const n = (t / MIN) * 10;
  return {
    kind: "attach",
    t,
    name,
    snapshot: markerRuns([n + 1, n + 2, n + 3]),
    stream: markerRuns([n + 4, n + 5]),
  };
}

/** A worker's record, half a minute after an attach, of the markers that attach saw written. */
function writtenAt(t: number, name: string): SoakEvent {
  return { kind: "marker", t, name, n: Math.floor(t / MIN) * 10 + 5 };
}

/**
 * A run that meets every bar: a sample a minute, one more while each restart has the daemon
 * down, a daemon killed and restarted every 10 minutes, and each worker probing every 10 s.
 */
function cleanRun(): SoakEvent[] {
  const events: SoakEvent[] = [
    { kind: "window", t: MEASURE, phase: "measure" },
    { kind: "window", t: END, phase: "end" },
  ];
  for (const holder of HOLDERS) {
    events.push({ kind: "open", t: 0, name: holder.name, load: holder.load });
  }
  for (const [i, name] of WORKERS.entries()) {
    events.push({ kind: "start", t: 0, name, pid: 200 + i });
  }
  for (let t = 0; t <= END; t += MIN) {
    const life = Math.floor(t / LIFE);
    events.push({
      kind: "sample",
      t,
      settled: true,
      daemon: { pid: 1000 + life, rss: 100 * MiB, fds: 40, ageMs: t - life * LIFE },
      holders: HOLDERS,
      terminals: TERMINALS,
      ptys: 5,
    });
  }
  for (let start = LIFE; start <= END; start += LIFE) {
    events.push(
      { kind: "daemon", t: start - 2 * SEC, up: false },
      {
        kind: "sample",
        t: start - SEC,
        settled: false,
        daemon: null,
        holders: HOLDERS,
        terminals: [],
        ptys: 5,
      },
      { kind: "daemon", t: start, up: true },
      { kind: "step", t: start, step: "restart", ok: true },
    );
  }
  for (let t = MIN; t <= END; t += MIN) {
    events.push({ kind: "step", t, step: "idle", ok: true });
    if (t % (5 * MIN) === 0) events.push({ kind: "step", t, step: "agent", ok: true });
  }
  for (let t = 0; t <= END; t += 10 * SEC) {
    for (const [i, name] of WORKERS.entries()) {
      events.push({ kind: "probe", t: t + i * 500, name, ms: 4 });
    }
  }
  for (let t = 0; t <= END; t += MIN) {
    events.push(...WORKERS.map((name) => attachAt(t, name)));
    if (t < END) events.push(...WORKERS.map((name) => writtenAt(t + 30 * SEC, name)));
    events.push(
      { kind: "seam", t, name: "f1", equal: true },
      { kind: "echo", t, ms: 6, flooding: true },
    );
  }
  return events;
}

type Sample = Extract<SoakEvent, { kind: "sample" }>;
type Daemon = NonNullable<Sample["daemon"]>;
const mapSamples = (events: readonly SoakEvent[], change: (s: Sample) => Sample) =>
  events.map((e) => (e.kind === "sample" ? change(e) : e));
const mapHolder = (s: Sample, name: string, change: (h: HolderSample) => HolderSample): Sample => ({
  ...s,
  holders: s.holders.map((h) => (h.name === name ? change(h) : h)),
});
const mapTerminal = (s: Sample, name: string, state: string): Sample => ({
  ...s,
  terminals: s.terminals.map((t) => (t.name === name ? { ...t, state } : t)),
});
const withoutHolder = (s: Sample, name: string): Sample => ({
  ...s,
  holders: s.holders.filter((h) => h.name !== name),
  terminals: s.terminals.filter((t) => t.name !== name),
});
const after = (t: number, change: (s: Sample) => Sample) => (s: Sample) =>
  s.t >= t ? change(s) : s;
const onlyAt = (t: number, change: (s: Sample) => Sample) => (s: Sample) =>
  s.t === t ? change(s) : s;
const during = (from: number, to: number, change: (s: Sample) => Sample) => (s: Sample) =>
  s.t >= from && s.t <= to ? change(s) : s;
const withDaemon =
  (change: (d: Daemon, s: Sample) => Partial<Daemon>) =>
  (s: Sample): Sample =>
    s.daemon === null ? s : { ...s, daemon: { ...s.daemon, ...change(s.daemon, s) } };
const settledOnly = (change: (s: Sample) => Sample) => (s: Sample) => (s.settled ? change(s) : s);

/** The sample a clean run takes at `t`. */
function sampleAt(events: readonly SoakEvent[], t: number): Sample {
  const found = events.find((e): e is Sample => e.kind === "sample" && e.t === t);
  if (found === undefined) throw new Error(`no sample at ${t}`);
  return found;
}

const notPassing = (events: readonly SoakEvent[], options = OPTIONS) =>
  judge(events, options)
    .criteria.filter((c) => c.status !== "pass")
    .map((c) => `${c.name}: ${c.status}`);

/** Keeps a seam every half hour, of the clean run's one a minute. */
const fewSeams = (e: SoakEvent) => e.kind !== "seam" || e.t % (30 * MIN) === 0;
const SHORT_END = 40 * MIN;
const beforeShortEnd = (e: SoakEvent) => e.t <= SHORT_END && e.kind !== "window";
const notProbe = (name: string, from: number) => (e: SoakEvent) =>
  e.kind !== "probe" || e.name !== name || e.t < from;
const notDuringOutage = (e: SoakEvent) =>
  e.kind !== "probe" || (e.t % LIFE > 5 * SEC && e.t % LIFE < LIFE - 5 * SEC);
/** A record with a load the soak's types don't know, as one read from a file could carry. */
const unknownLoad = (h: HolderSample): HolderSample =>
  JSON.parse(JSON.stringify({ ...h, load: "codex" }));
/** RSS read only at the hour and a minute after, growing between. */
const twoReadings = (s: Sample) => (h: HolderSample) => ({
  ...h,
  rss: s.t === HOUR ? MiB : s.t === HOUR + MIN ? 50 * MiB : null,
});
/** RSS read only at the window's start, middle and end, flat. */
const threeReadings = (s: Sample) => (h: HolderSample) => ({
  ...h,
  rss: [MEASURE, 70 * MIN, END].includes(s.t) ? h.rss : null,
});
/** RSS read only in the window's first half hour. */
const firstHalfHour = (s: Sample) => (h: HolderSample) => ({
  ...h,
  rss: s.t <= MEASURE + 30 * MIN ? h.rss : null,
});
/** r1's holder growing `perHour` MiB an hour from the start. */
const holderGrowing = (perHour: number) => (s: Sample) =>
  mapHolder(s, "r1", (h) => ({ ...h, rss: 10 * MiB + (s.t / HOUR) * perHour * MiB }));
/** The daemon's RSS growing `perHour` MiB an hour from the start, at every age. */
const daemonGrowing = (perHour: number) =>
  withDaemon((_, s) => ({ rss: 100 * MiB + (s.t / HOUR) * perHour * MiB }));
/** `count` keystrokes timed during floods at the hour, each echoed in `ms`. */
const floodEchoes = (ms: number, count = 10) =>
  Array.from({ length: count }, (_, i): SoakEvent => ({
    kind: "echo",
    t: HOUR + i,
    ms,
    flooding: true,
  }));
/** r1's holder at 500 MiB for the five minutes from `t`, and as it was otherwise. */
const spikeFrom = (t: number) => (s: Sample) =>
  s.t >= t && s.t < t + 5 * MIN ? mapHolder(s, "r1", (h) => ({ ...h, rss: 500 * MiB })) : s;
/** An agent terminal the daemon shows running, but no holder for it. */
const withHolderless = (s: Sample): Sample =>
  s.daemon === null
    ? s
    : { ...s, terminals: [...s.terminals, { name: "a2", load: "agent", state: "running" }] };
/** r1's attaches seeing the same markers every time. */
const stuckMarkers = (e: SoakEvent): SoakEvent =>
  e.kind === "attach" && e.name === "r1"
    ? { ...e, snapshot: markerRuns([1, 2, 3]), stream: markerRuns([4, 5]) }
    : e;
/** Each attach's markers as one run, all in its snapshot and none left for its stream. */
const allInSnapshot = (e: SoakEvent): SoakEvent =>
  e.kind === "attach"
    ? { ...e, snapshot: [[e.snapshot[0]?.[0] ?? 0, e.stream.at(-1)?.[1] ?? 0]], stream: [] }
    : e;
/** f1's attaches each seeing a million markers and more, in order, as a flood's do. */
const flood = (e: SoakEvent): SoakEvent =>
  e.kind === "attach" && e.name === "f1"
    ? { ...e, snapshot: [[1, 900_000]], stream: [[900_001, 1_000_000 + e.t]] }
    : e;
/** A worker opened at the hour, its holder, state and probes as a clean run's, attached or not. */
function withLateWorker(events: readonly SoakEvent[], attached: boolean): SoakEvent[] {
  const late = { name: "i2", load: "idle" } as const;
  const holder: HolderSample = {
    ...late,
    pid: 106,
    rss: 6 * MiB,
    fds: 7,
    engineBytes: MiB,
    engineResets: 0,
  };
  const added: SoakEvent[] = [
    { kind: "open", t: HOUR, ...late },
    { kind: "start", t: HOUR, name: late.name, pid: 206 },
  ];
  for (let t = HOUR; t <= END; t += 10 * SEC) {
    added.push({ kind: "probe", t, name: late.name, ms: 4 });
  }
  const attaches = attached ? [HOUR + MIN, HOUR + 30 * MIN] : [];
  added.push(...attaches.map((t) => attachAt(t, late.name)));
  const sampled = mapSamples(
    events,
    after(HOUR + 1, (s) => ({
      ...s,
      holders: [...s.holders, holder],
      terminals: s.daemon === null ? [] : [...s.terminals, { ...late, state: "running" }],
    })),
  );
  return [...sampled, ...added];
}
/** A worker opened at the hour and closed `lifeMs` later, with nothing else to show. */
const shortLived = (lifeMs: number): SoakEvent[] => [
  { kind: "open", t: HOUR, name: "i3", load: "idle" },
  { kind: "start", t: HOUR + SEC, name: "i3", pid: 207 },
  { kind: "close", t: HOUR + lifeMs, name: "i3" },
];
const closedBeforeWindow = (name: string): SoakEvent => ({ kind: "close", t: MEASURE - MIN, name });
/** One more fd for each daemon life. */
const fdsByLife = (s: Sample) => 9 + Math.floor(s.t / LIFE);
/** Drops `step`'s records from `t` on. */
const notStepAfter = (step: string, t: number) => (e: SoakEvent) =>
  e.kind !== "step" || e.step !== step || e.t < t;
const notStartOf = (name: string) => (e: SoakEvent) => e.kind !== "start" || e.name !== name;
const notAttachOf = (name: string) => (e: SoakEvent) => e.kind !== "attach" || e.name !== name;

describe("judge", () => {
  it("passes a run that meets every bar", () => {
    expect(notPassing(cleanRun())).toEqual([]);
    expect(judge(cleanRun(), OPTIONS).pass).toBe(true);
  });

  it("fails a run measured for less than the gate's duration on duration alone", () => {
    const dayLong = { ...OPTIONS, minMeasuredMs: GATE.minMeasuredMs };
    expect(notPassing(cleanRun(), dayLong)).toEqual(["duration: fail"]);
  });

  const faults: [string, string, (events: SoakEvent[]) => SoakEvent[]][] = [
    [
      "a holder that vanishes unasked",
      "holder-deaths",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => ({ ...s, holders: s.holders.filter((h) => h.name !== "a1") })),
        ),
    ],
    [
      "a holder whose pid changes unasked",
      "holder-deaths",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapHolder(s, "a1", (h) => ({ ...h, pid: 999 }))),
        ),
    ],
    [
      "a program hung up with its terminal open",
      "children",
      (events) => [...events, { kind: "hup", t: HOUR, name: "i1" }],
    ],
    [
      "a program that exits with its terminal open",
      "children",
      (events) => [...events, { kind: "exit", t: HOUR, name: "i1", why: "input-ended" }],
    ],
    [
      "a program whose probes stop with its terminal open",
      "children",
      (events) => events.filter(notProbe("i1", HOUR)),
    ],
    [
      "a program started twice under one name",
      "children",
      (events) => [...events, { kind: "start", t: HOUR, name: "i1", pid: 300 }],
    ],
    [
      "a program started in a terminal the soak never opened",
      "children",
      (events) => [...events, { kind: "start", t: HOUR, name: "x9", pid: 301 }],
    ],
    [
      "a program that outlives its holder",
      "children",
      (events) => [...events, { kind: "orphan", t: HOUR, name: "i1", pid: 777 }],
    ],
    [
      "a terminal shown lost",
      "terminal-states",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapTerminal(s, "a1", "lost")),
        ),
    ],
    [
      "a shell shown exited",
      "terminal-states",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapTerminal(s, "i1", "exited")),
        ),
    ],
    [
      "a terminal shown closed that the soak never closed",
      "terminal-states",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapTerminal(s, "i1", "closed")),
        ),
    ],
    [
      "a terminal stuck starting",
      "terminal-states",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapTerminal(s, "a1", "starting")),
        ),
    ],
    [
      "an agent the soak made exit that never ran again",
      "terminal-states",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapTerminal(s, "a1", "exited")),
        ),
    ],
    [
      "a terminal still unknown in one settled sample",
      "terminal-states",
      (events) =>
        mapSamples(
          events,
          onlyAt(HOUR, (s) => mapTerminal(s, "a1", "unknown")),
        ),
    ],
    [
      "a terminal gone from the daemon's state while its holder runs",
      "terminal-states",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => ({ ...s, terminals: s.terminals.filter((t) => t.name !== "a1") })),
        ),
    ],
    [
      "a marker missing at an attach's seam",
      "output-loss",
      (events) => [
        ...events,
        {
          kind: "attach",
          t: HOUR,
          name: "r1",
          snapshot: markerRuns([1, 2, 3]),
          stream: markerRuns([5, 6]),
        },
      ],
    ],
    [
      "a marker repeated across an attach's seam",
      "output-loss",
      (events) => [
        ...events,
        {
          kind: "attach",
          t: HOUR,
          name: "r1",
          snapshot: markerRuns([1, 2, 3]),
          stream: markerRuns([3, 4]),
        },
      ],
    ],
    [
      "a marker missing inside a snapshot",
      "output-loss",
      (events) => [
        ...events,
        {
          kind: "attach",
          t: HOUR,
          name: "r1",
          snapshot: markerRuns([1, 3]),
          stream: markerRuns([]),
        },
      ],
    ],
    [
      "a terminal whose markers stop moving on",
      "output-loss",
      (events) => events.map(stuckMarkers),
    ],
    [
      "an attach that missed markers its worker had written",
      "output-loss",
      (events) => [...events, { kind: "marker", t: HOUR - 2 * SEC, name: "r1", n: 10_000 }],
    ],
    [
      "a worker opened in the window that no attach saw",
      "output-loss",
      (events) => withLateWorker(events, false),
    ],
    [
      "a worker closed 10 s after it opened, too soon to check",
      "output-loss",
      (events) => [...events, ...shortLived(10 * SEC)],
    ],
    [
      "every worker closed before the window, leaving none to check",
      "output-loss",
      (events) => [...events, ...WORKERS.map(closedBeforeWindow)],
    ],
    ["a terminal no attach saw", "output-loss", (events) => events.filter(notAttachOf("r1"))],
    [
      "attaches that saw fewer than two markers",
      "output-loss",
      (events) =>
        events.map((e) =>
          e.kind === "attach" ? { ...e, snapshot: markerRuns([]), stream: markerRuns([7]) } : e,
        ),
    ],
    [
      "a seam whose cells differ",
      "seams",
      (events) => [...events, { kind: "seam", t: HOUR, name: "f1", equal: false }],
    ],
    [
      "a seam whose cells differ during warm-up",
      "seams",
      (events) => [...events, { kind: "seam", t: MIN, name: "f1", equal: false }],
    ],
    [
      "a probe answered after 50 ms",
      "probes",
      (events) => [...events, { kind: "probe", t: HOUR, name: "r1", ms: 51 }],
    ],
    [
      "a probe never answered",
      "probes",
      (events) => [...events, { kind: "probe", t: HOUR, name: "r1", ms: null }],
    ],
    [
      "a holder whose RSS grows 1 MiB an hour",
      "holder-memory",
      (events) => mapSamples(events, holderGrowing(1)),
    ],
    [
      "a holder whose RSS grows 0.5 MiB an hour, on the bar",
      "holder-memory",
      (events) => mapSamples(events, holderGrowing(0.5)),
    ],
    [
      "a holder whose RSS was read only twice, a minute apart",
      "holder-memory",
      (events) => mapSamples(events, (s) => mapHolder(s, "r1", twoReadings(s))),
    ],
    [
      "a holder whose RSS was read only three times, across the whole window",
      "holder-memory",
      (events) => mapSamples(events, (s) => mapHolder(s, "r1", threeReadings(s))),
    ],
    [
      "a holder whose RSS was read only in the window's first half hour",
      "holder-memory",
      (events) => mapSamples(events, (s) => mapHolder(s, "r1", firstHalfHour(s))),
    ],
    [
      "a flood's engine over 15 MiB",
      "engine-budget",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapHolder(s, "f1", (h) => ({ ...h, engineBytes: 16 * MiB }))),
        ),
    ],
    [
      "an agent stream's engine over 8 MiB",
      "engine-budget",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapHolder(s, "r1", (h) => ({ ...h, engineBytes: 9 * MiB }))),
        ),
    ],
    [
      "a holder whose load has no budget",
      "engine-budget",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapHolder(s, "r1", unknownLoad)),
        ),
    ],
    [
      "a daemon fd not back to its life's baseline once settled",
      "counts",
      (events) =>
        mapSamples(
          events,
          after(
            HOUR + 3 * MIN,
            withDaemon(() => ({ fds: 41 })),
          ),
        ),
    ],
    [
      "a holder fd not back to baseline once settled",
      "counts",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapHolder(s, "e1", (h) => ({ ...h, fds: 10 }))),
        ),
    ],
    [
      "a holder whose fds grow by one with each daemon life, steady within each",
      "counts",
      (events) =>
        mapSamples(events, (s) => mapHolder(s, "e1", (h) => ({ ...h, fds: fdsByLife(s) }))),
    ],
    [
      "a PTY not back to baseline once settled",
      "counts",
      (events) =>
        mapSamples(
          events,
          after(
            HOUR,
            settledOnly((s) => ({ ...s, ptys: 6 })),
          ),
        ),
    ],
    [
      "a daemon whose RSS at the same age grows 2 MiB an hour",
      "daemon-memory",
      (events) => mapSamples(events, daemonGrowing(2)),
    ],
    [
      "a daemon whose RSS at the same age grows 1 MiB an hour, on the bar",
      "daemon-memory",
      (events) => mapSamples(events, daemonGrowing(1)),
    ],
    [
      "a daemon read only well past the age its lives are compared at",
      "daemon-memory",
      (events) =>
        mapSamples(
          events,
          withDaemon((d) => ({ ageMs: d.ageMs + 45 * SEC })),
        ),
    ],
    ["echo p99 over 25 ms during floods", "echo", (events) => [...events, ...floodEchoes(30)]],
    [
      "echo p99 of 25 ms during floods, on the bar",
      "echo",
      (events) => [...events, ...floodEchoes(25)],
    ],
    [
      "a keystroke never echoed, even in warm-up",
      "echo",
      (events) => [...events, { kind: "echo", t: MIN, ms: null, flooding: false }],
    ],
    [
      "a churn step that failed, an attach's snapshot timing out say",
      "churn",
      (events) => [
        ...events,
        { kind: "step", t: HOUR, step: "rotate", ok: false, why: "timed out waiting" },
      ],
    ],
    [
      "restarts that stopped halfway through the window",
      "churn",
      (events) => events.filter(notStepAfter("restart", HOUR)),
    ],
    [
      "a panic in a holder's log",
      "engine",
      (events) => [
        ...events,
        { kind: "panic", t: HOUR, name: "f1", line: "panicked at engine.rs" },
      ],
    ],
    [
      "an engine reset in a holder's stats",
      "engine",
      (events) =>
        mapSamples(
          events,
          after(HOUR, (s) => mapHolder(s, "f1", (h) => ({ ...h, engineResets: 1 }))),
        ),
    ],
  ];

  it.each(faults)("fails %s on %s alone", (_, criterion, inject) => {
    expect(notPassing(inject(cleanRun()))).toEqual([`${criterion}: fail`]);
    expect(judge(inject(cleanRun()), OPTIONS).pass).toBe(false);
  });

  const harmless: [string, (events: SoakEvent[]) => SoakEvent[]][] = [
    [
      "a terminal closed, then its holder gone, its program hung up and its probes stopped",
      (events) => [
        ...mapSamples(
          events,
          after(HOUR, (s) => withoutHolder(s, "i1")),
        ).filter(notProbe("i1", HOUR)),
        { kind: "close", t: HOUR - 1, name: "i1" },
        { kind: "hup", t: HOUR, name: "i1" },
        { kind: "exit", t: HOUR, name: "i1", why: "input-ended" },
      ],
    ],
    [
      "an agent shown exited for a minute, as the soak makes it to respawn it",
      (events) =>
        mapSamples(
          events,
          during(HOUR + 1, HOUR + MIN, (s) => mapTerminal(s, "a1", "exited")),
        ),
    ],
    ["a worker opened in the window and attached twice", (events) => withLateWorker(events, true)],
    [
      "a marker written too late before an attach for it to be seen",
      (events) => [...events, { kind: "marker", t: HOUR - 500, name: "r1", n: 10_000 }],
    ],
    [
      "a worker opened as the run ends, closed by its teardown seconds later",
      (events) => [
        ...events,
        { kind: "open", t: END, name: "i5", load: "idle" },
        { kind: "start", t: END, name: "i5", pid: 209 },
        { kind: "close", t: END + 5 * SEC, name: "i5" },
      ],
    ],
    [
      "a worker opened as the run ends, too late to be checked",
      (events) => [
        ...events,
        { kind: "open", t: END, name: "i4", load: "idle" },
        { kind: "start", t: END, name: "i4", pid: 208 },
      ],
    ],
    [
      "a terminal unknown in an unsettled sample, just after a restart",
      (events) => [
        ...events,
        { ...mapTerminal(sampleAt(events, HOUR), "a1", "unknown"), t: HOUR + 1, settled: false },
      ],
    ],
    [
      "a probe answered in exactly 50 ms",
      (events) => [...events, { kind: "probe", t: HOUR, name: "r1", ms: 50 }],
    ],
    [
      "a holder whose RSS grows 0.4 MiB an hour",
      (events) => mapSamples(events, holderGrowing(0.4)),
    ],
    [
      "a holder whose RSS spikes for five minutes near the end, and is flat otherwise",
      (events) => mapSamples(events, spikeFrom(END - 10 * MIN)),
    ],
    [
      "a daemon whose RSS at the same age grows 0.9 MiB an hour",
      (events) => mapSamples(events, daemonGrowing(0.9)),
    ],
    ["echo p99 of 24 ms during floods", (events) => [...events, ...floodEchoes(24)]],
    [
      "a terminal starting for a minute, then running",
      (events) =>
        mapSamples(events, (s) =>
          s.t > HOUR && s.t <= HOUR + MIN ? mapTerminal(s, "a1", "starting") : s,
        ),
    ],
    [
      "an extra fd while the churn runs, in a sample not settled",
      (events) => [...events, { ...sampleAt(events, HOUR), t: HOUR + 1, settled: false, ptys: 9 }],
    ],
    [
      "a daemon that opens an fd on first use in each life, after that life's first settled count",
      (events) =>
        mapSamples(
          events,
          withDaemon((d) => ({ fds: d.ageMs < MIN ? 40 : 41 })),
        ),
    ],
    [
      "a holder whose fds step up once, at the window's first restart, and hold",
      (events) =>
        mapSamples(events, (s) =>
          mapHolder(s, "e1", (h) => ({ ...h, fds: s.t >= MEASURE + LIFE ? 10 : 9 })),
        ),
    ],
    [
      "a daemon that holds more fds in one life than another, steady within each",
      (events) =>
        mapSamples(
          events,
          withDaemon((d) => ({ fds: 40 + (d.pid % 3) })),
        ),
    ],
    [
      "a daemon whose RSS read young grows from life to life, and read at its age stays flat",
      (events) =>
        mapSamples(
          events,
          withDaemon((d, s) =>
            d.ageMs >= OPTIONS.daemonAgeMs ? {} : { rss: 50 * MiB + (s.t / HOUR) * 10 * MiB },
          ),
        ),
    ],
    [
      "a window holding one restart fewer than its cadence fits, the fewest it may",
      (events) => events.filter(notStepAfter("restart", END - 2 * LIFE + 1)),
    ],
    [
      "slow echo with no flood running",
      (events) => [...events, ...floodEchoes(100).map((e) => ({ ...e, flooding: false }))],
    ],
    [
      "attaches that saw all their markers as one run in the snapshot, none in the stream",
      (events) => events.map(allInSnapshot),
    ],
    [
      "an attach whose newest marker, the last of a run of several, is the one written just before",
      (events) => [...events, { kind: "marker", t: HOUR - 2 * SEC, name: "r1", n: 605 }],
    ],
  ];

  it.each(harmless)("passes %s", (_, change) => {
    expect(notPassing(change(cleanRun()))).toEqual([]);
  });

  it("reports the seams' measured rate and how many tries found output paused", () => {
    const unpaused = Array.from({ length: 10 }, (_, i): SoakEvent => ({
      kind: "unpaused",
      t: HOUR + i,
      name: "r1",
    }));
    const seams = judge([...cleanRun(), ...unpaused], OPTIONS).criteria.find(
      (c) => c.name === "seams",
    );
    expect(seams).toMatchObject({
      status: "pass",
      detail: "121 seams in 2.00 measured hours, 61 an hour, of 131 tries; each equal cell by cell",
    });
  });

  it("splits out the probes taken while the daemon was down", () => {
    const events = [...cleanRun(), { kind: "probe", t: LIFE - SEC, name: "f1", ms: 33 } as const];
    const probes = judge(events, OPTIONS).criteria.find((c) => c.name === "probes");
    expect(probes?.status).toBe("pass");
    expect(probes?.detail).toMatch(/while the daemon was down, worst 33 ms$/);
  });

  const unjudged: [string, string, (events: SoakEvent[]) => SoakEvent[]][] = [
    [
      "no probe taken while the daemon was down",
      "probes",
      (events) => events.filter(notDuringOutage),
    ],
    ["seams sampled below the rate asked", "seams", (events) => events.filter(fewSeams)],
  ];

  it.each(unjudged)("calls %s unmeasured on %s", (_, criterion, change) => {
    expect(notPassing(change(cleanRun()))).toEqual([`${criterion}: unmeasured`]);
  });

  it("calls a run too short to judge unmeasured, which fails the gate but not a smoke run", () => {
    const events: SoakEvent[] = [
      ...cleanRun().filter(beforeShortEnd),
      { kind: "window", t: MEASURE, phase: "measure" },
      { kind: "window", t: SHORT_END, phase: "end" },
    ];
    const smoke = { ...OPTIONS, minMeasuredMs: 20 * MIN };
    expect(notPassing(events, smoke)).toEqual([
      "holder-memory: unmeasured",
      "daemon-memory: unmeasured",
    ]);
    expect(judge(events, smoke).pass).toBe(false);
    expect(judge(events, { ...smoke, requireAll: false }).pass).toBe(true);
  });

  it("passes nothing on no evidence, even where unmeasured is let pass", () => {
    const lenient = { ...OPTIONS, requireAll: false };
    expect(judge([], lenient).pass).toBe(false);
    expect(notPassing([], lenient)).toEqual([
      "duration: unmeasured",
      "holder-deaths: fail",
      "children: fail",
      "terminal-states: fail",
      "output-loss: unmeasured",
      "seams: unmeasured",
      "probes: fail",
      "holder-memory: unmeasured",
      "engine-budget: fail",
      "counts: unmeasured",
      "daemon-memory: unmeasured",
      "echo: unmeasured",
      "churn: unmeasured",
      "engine: fail",
    ]);
  });

  it("fails a terminal the soak opened that never had a holder on holder-deaths alone", () => {
    const events: SoakEvent[] = [
      ...mapSamples(cleanRun(), withHolderless),
      { kind: "open", t: 0, name: "a2", load: "agent" },
    ];
    expect(notPassing(events)).toEqual(["holder-deaths: fail"]);
  });

  it("fails a worker the soak opened that never started", () => {
    const events = cleanRun().filter(notStartOf("i1"));
    const children = judge(events, OPTIONS).criteria.find((c) => c.name === "children");
    expect(children).toMatchObject({ status: "fail", detail: "i1 never started" });
  });

  it("judges a day's probes without running out of stack", () => {
    const many = Array.from({ length: 300_000 }, (_, i): SoakEvent => ({
      kind: "probe",
      t: i,
      name: "r1",
      ms: 4,
    }));
    const probes = judge([...cleanRun(), ...many], OPTIONS).criteria.find(
      (c) => c.name === "probes",
    );
    expect(probes?.status).toBe("pass");
  });

  it("passes a flood's attach of a million markers in order, recorded as one run", () => {
    const loss = judge(cleanRun().map(flood), OPTIONS).criteria.find(
      (c) => c.name === "output-loss",
    );
    expect(loss?.status).toBe("pass");
  });
});

/** The numbers `runs` stand for, in order. */
const expand = (runs: readonly (readonly [number, number])[]) =>
  runs.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i));

/** Whether `numbers`' runs expand back to them, and no two of them could be one. */
function roundTrips(numbers: readonly number[]): boolean {
  const runs = markerRuns(numbers);
  const joinable = runs.some(([, last], i) => runs[i + 1]?.[0] === last + 1);
  return JSON.stringify(expand(runs)) === JSON.stringify(numbers) && !joinable;
}

describe("markerRuns", () => {
  it("joins consecutive numbers, and starts a run at each repeat, step back or gap", () => {
    expect(markerRuns([1, 2, 3, 3, 4, 2, 7, 8, 9])).toEqual([
      [1, 3],
      [3, 4],
      [2, 2],
      [7, 9],
    ]);
    expect(markerRuns([5])).toEqual([[5, 5]]);
    expect(markerRuns([])).toEqual([]);
  });

  it("expands back to exactly the numbers it was given, in runs that can't be joined", () => {
    const numbers = fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 60 });
    expect(() => fc.assert(fc.property(numbers, roundTrips))).not.toThrow();
  });
});

describe("theilSen", () => {
  it("is the slope of points on a line, and zero for points at one x", () => {
    const line = [0, 1, 2, 3].map((x): [number, number] => [x, 1 + 2 * x]);
    expect(theilSen(line)).toBe(2);
    expect(
      theilSen([
        [4, 1],
        [4, 9],
      ]),
    ).toBe(0);
  });

  it("is hardly moved by one point far off the rest, as least squares would be", () => {
    const flat: [number, number][] = [0, 1, 2, 3, 4, 5, 6].map((x) => [x, 10]);
    flat.push([7, 500]);
    expect(theilSen(flat)).toBe(0);
  });
});

describe("percentile", () => {
  it("takes the nearest rank, so one slow value in a hundred is not p99", () => {
    const values = [...Array.from({ length: 99 }, () => 5), 500];
    expect(percentile(values, 99)).toBe(5);
    expect(percentile([...values, 500], 99)).toBe(500);
  });
});

describe("report", () => {
  it("lists failures first and ends with the verdict", () => {
    const text = report(
      judge([...cleanRun(), { kind: "orphan", t: HOUR, name: "i1", pid: 7 }], OPTIONS),
    );
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^FAIL +children +i1's program 7 outlived its holder$/);
    expect(lines.at(-1)).toBe("soak failed");
    expect(report(judge(cleanRun(), OPTIONS)).split("\n").at(-1)).toBe("soak passed");
  });
});
