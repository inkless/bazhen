// `pnpm soak [--profile gate|smoke] [--hours n] [--out dir] [--fault close-holder|slow-probe]…`:
// a real daemon on holders, under design §12.4's load and churn, for hours, then the verdict of
// scripts/soak-judge.ts on what it recorded. `pnpm soak --judge <dir>` judges a finished run's
// directory again.
//
// The load is 25 terminals: shells running scripts/soak-worker.ts (agent-stream replays, floods,
// idle shells and one that echoes) and a Claude Code agent on the fake model. The churn kills the
// daemon outright and restarts it, attaches views and detaches them, closes an idle shell and opens
// another, and makes the agent exit and respawns it. Two terminals stay viewed throughout, and
// keystrokes typed through one of them are timed until their echo. Every 30 s the driver samples
// the daemon, every holder over its own protocol (so also while the daemon is down), the
// terminals' states and the machine's PTYs; every few minutes it holds the churn and takes a
// settled sample, whose counts must be back at their baselines.
//
// Everything goes to the run's directory as it happens, as JSON lines, so a run cut short keeps its
// evidence: `events.jsonl` (the driver's), `workers/<name>.jsonl` (each worker's), `driver.log`,
// then `verdict.json` and the report. Faults are recorded, never thrown: the run goes to its end and
// the judge reports them all. It runs only on a disposable host: its holders signal every process
// in their sessions as they close.
//
// The contract the judge relies on: names are never reused; `open` is recorded once the daemon has
// made the terminal; `close` before the close is asked for; and an attach's `t` is when its
// snapshot had arrived, so whatever a worker wrote a second before is in that snapshot or in the
// stream the attach then reads for seconds more.

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  closeSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import headless from "@xterm/headless";
import { inSignalSandbox, isAlive } from "@bazhen/host-guard";
import { HISTORY_LINES, MAX_ROWS, ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { connectHolder } from "@bazhen/runtime-holder";
import { closeHolder, Daemon, holderSockets, type View } from "../tests/api/daemon.ts";
import { startFakeModel, type FakeModel } from "../tests/api/fake-model.ts";
import { requireSignalSandbox } from "../tests/support/disposable-host.ts";
import { ptysInUse } from "../tests/support/ptys.ts";
import { isMain } from "./is-main.ts";
import {
  GATE,
  type HolderSample,
  type JudgeOptions,
  judge,
  type Load,
  report,
  type SoakEvent,
  type TerminalSample,
} from "./soak-judge.ts";
import { SOAK_SIZE } from "./soak-echo.ts";
import { markersIn, type Mode } from "./soak-worker.ts";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** Every view's size, and so every terminal's: the first driving view sizes a shell. */
const SIZE = SOAK_SIZE;
const WORKER = fileURLToPath(new URL("soak-worker.ts", import.meta.url));
const ECHO = fileURLToPath(new URL("soak-echo.ts", import.meta.url));

export interface Profile {
  readonly name: "gate" | "smoke";
  readonly hours: number;
  readonly warmupMs: number;
  readonly measureMs: number;
  readonly restartEveryMs: number;
  /** How long the daemon stays down at each restart: workers probe their holders meanwhile. */
  readonly downMs: number;
  readonly rotateEveryMs: number;
  /** How long an attach reads the stream after its snapshot. */
  readonly attachHoldMs: number;
  readonly idleChurnEveryMs: number;
  readonly agentCycleEveryMs: number;
  readonly sampleEveryMs: number;
  readonly settleEveryMs: number;
  readonly seamEveryMs: number;
  readonly echoEveryMs: number;
  readonly worker: {
    readonly probeEveryMs: number;
    readonly linesPerSecond: number;
    readonly floodOnMs: number;
    readonly floodOffMs: number;
    readonly markerEveryMs: number;
  };
  /** How many terminals run each worker mode; one agent runs beside them. */
  readonly load: Readonly<Record<Mode, number>>;
  readonly judge: JudgeOptions;
}

/**
 * The smoke run's echo bar. The gate's 25 ms is for a host that runs the soak and nothing else;
 * the smoke run shares a test container's CPUs, so it judges echo only against a bar a broken or
 * stalled echo path misses.
 */
const SMOKE_ECHO_P99_MS = 250;
const MODES: readonly Mode[] = ["replay", "flood", "idle", "echo"];
const LOAD: Readonly<Record<Mode, number>> = { replay: 15, flood: 5, idle: 3, echo: 1 };

/**
 * The gate's profile, §12.4's rates over a warm-up hour and `hours` measured; or the smoke run's,
 * the same load with the churn compressed, over minutes, judged with what only hours can show
 * left unmeasured.
 */
export function profile(name: "gate" | "smoke", hours: number): Profile {
  const measureMs = Math.round(hours * HOUR);
  if (name === "gate") {
    return {
      name,
      hours,
      warmupMs: HOUR,
      measureMs,
      restartEveryMs: 10 * MIN,
      downMs: 5 * SEC,
      rotateEveryMs: 5 * SEC,
      attachHoldMs: 3 * SEC,
      idleChurnEveryMs: MIN,
      agentCycleEveryMs: 5 * MIN,
      sampleEveryMs: 30 * SEC,
      settleEveryMs: 2.5 * MIN,
      seamEveryMs: 15 * SEC,
      echoEveryMs: SEC,
      worker: {
        probeEveryMs: 10 * SEC,
        linesPerSecond: 50,
        floodOnMs: MIN,
        floodOffMs: 5 * MIN,
        markerEveryMs: SEC,
      },
      load: LOAD,
      judge: {
        ...GATE,
        minMeasuredMs: measureMs,
        churnEveryMs: { restart: 10 * MIN, agent: 5 * MIN, idle: MIN },
      },
    };
  }
  return {
    name,
    hours,
    warmupMs: 2 * MIN,
    measureMs,
    restartEveryMs: 3 * MIN,
    downMs: 5 * SEC,
    rotateEveryMs: 5 * SEC,
    attachHoldMs: 3 * SEC,
    idleChurnEveryMs: 30 * SEC,
    agentCycleEveryMs: 2 * MIN,
    sampleEveryMs: 15 * SEC,
    settleEveryMs: 45 * SEC,
    seamEveryMs: 10 * SEC,
    echoEveryMs: SEC,
    worker: {
      probeEveryMs: 10 * SEC,
      linesPerSecond: 50,
      floodOnMs: 20 * SEC,
      floodOffMs: MIN,
      markerEveryMs: SEC,
    },
    load: LOAD,
    judge: {
      ...GATE,
      minMeasuredMs: measureMs,
      sampleEveryMs: 15 * SEC,
      echoP99Ms: SMOKE_ECHO_P99_MS,
      churnEveryMs: { restart: 3 * MIN, agent: 2 * MIN, idle: 30 * SEC },
      requireAll: false,
    },
  };
}

export type Fault = "close-holder" | "slow-probe";
const FAULTS: readonly string[] = ["close-holder", "slow-probe"] satisfies Fault[];
const isFault = (f: string): f is Fault => FAULTS.includes(f);

export type SoakArgs =
  | { readonly judge: string }
  | {
      readonly profile: Profile;
      readonly out: string;
      readonly faults: readonly Fault[];
    };

const USAGE =
  "usage: pnpm soak [--profile gate|smoke] [--hours n] [--out dir] " +
  "[--fault close-holder|slow-probe]… | pnpm soak --judge <dir>";

/** The command line's run, or the directory to judge again. */
export function parseSoakArgs(args: readonly string[], now = new Date()): SoakArgs {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      profile: { type: "string", default: "gate" },
      hours: { type: "string" },
      out: { type: "string" },
      fault: { type: "string", multiple: true, default: [] },
      judge: { type: "string" },
    },
  });
  if (positionals.length > 0) throw new Error(USAGE);
  if (values.judge !== undefined) return { judge: values.judge };
  const name = values.profile;
  if (name !== "gate" && name !== "smoke") throw new Error(`no profile ${name}; ${USAGE}`);
  const hours = Number(values.hours ?? (name === "gate" ? 24 : 0.2));
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`--hours takes a positive number`);
  const unknown = values.fault.filter((f) => !isFault(f));
  if (unknown.length > 0) throw new Error(`no fault ${unknown.join(", ")}; ${USAGE}`);
  const stamp = now.toISOString().replaceAll(/[:.]/g, "-");
  return {
    profile: profile(name, hours),
    out: resolve(values.out ?? `soak-${name}-${stamp}`),
    faults: values.fault.filter(isFault),
  };
}

/**
 * Whether `value` is a record of a run's: a kind and a time. The driver and the workers wrote
 * them, so the rest is theirs to vouch for.
 */
function isEvent(value: unknown): value is SoakEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "t" in value &&
    typeof value.t === "number"
  );
}

/** One JSON line as a record, or undefined for one torn or not a record: a run cut short. */
function asEvent(line: string): SoakEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isEvent(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Every record of a run's directory: the driver's, the echo timer's and each worker's. */
export function readRun(dir: string): SoakEvent[] {
  const workers = join(dir, "workers");
  const files = [
    join(dir, "events.jsonl"),
    join(dir, "echo.jsonl"),
    ...(existsSync(workers)
      ? readdirSync(workers)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => join(workers, f))
      : []),
  ];
  return files.flatMap((file) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line) => asEvent(line) ?? [])
      : [],
  );
}

/** A terminal like a browser's, with `bytes` written to it. */
async function rendered(bytes: Uint8Array, size: { cols: number; rows: number }) {
  const term = new headless.Terminal({
    ...size,
    scrollback: HISTORY_LINES + MAX_ROWS,
    allowProposedApi: true,
  });
  await new Promise<void>((done) => term.write(bytes, done));
  return term;
}

/**
 * A snapshot's text split at its cursor's line: the whole lines above it, each ending in a
 * newline, and what the cursor's line holds. That line's end is the stream's to write: a marker
 * the snapshot cut short there is finished by the stream, and one the snapshot cut between its CR
 * and its LF, the cursor back at the line's start, is ended by it. So the line goes before the
 * stream, whole, where the cursor stands.
 */
export async function splitAtCursor(
  bytes: Uint8Array,
  size: { cols: number; rows: number },
): Promise<{ above: string; line: string }> {
  const term = await rendered(bytes, size);
  const buffer = term.buffer.active;
  const row = buffer.baseY + buffer.cursorY;
  const above = Array.from(
    { length: row },
    (_, y) => `${buffer.getLine(y)?.translateToString(true) ?? ""}\n`,
  ).join("");
  // Trimmed of cells never written, never of spaces written, as a marker's own.
  const line = buffer.getLine(row)?.translateToString(true) ?? "";
  term.dispose();
  return { above, line };
}

/** The visible screen and cursor `bytes` draw, to compare cell by cell. */
export async function screenOf(
  bytes: Uint8Array,
  size: { cols: number; rows: number },
): Promise<string> {
  const term = await rendered(bytes, size);
  const buffer = term.buffer.active;
  const lines = Array.from(
    { length: term.rows },
    (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(false) ?? "",
  );
  term.dispose();
  return [...lines, `cursor ${buffer.cursorX},${buffer.cursorY}`].join("\n");
}

/** What an attach saw: the markers in its snapshot, then in the stream after it. */
export async function attachMarkers(
  name: string,
  snapshot: Uint8Array,
  stream: Uint8Array,
  size: { cols: number; rows: number },
): Promise<{ snapshot: number[]; stream: number[] }> {
  const { above, line } = await splitAtCursor(snapshot, size);
  return {
    snapshot: markersIn(above, name),
    stream: markersIn(line + Buffer.from(stream).toString("utf8"), name),
  };
}

/**
 * How many times a settled sample reads each process's fds, keeping the least: a connection
 * passing through, the daemon polling a holder say, isn't a leak, and a leak is there every time.
 */
const SETTLED_READS = 3;
/** Longer than Node's HTTP server keeps an idle connection open, five seconds. */
const KEEP_ALIVE_MS = 6 * SEC;

/**
 * Each of `pids`' fewest open fds, and fewest PTY masters, over `reads` reads a second apart;
 * none for one unreadable.
 */
async function leastFds(
  pids: readonly number[],
  reads: number,
): Promise<Map<number, { fds: number; ptys: number }>> {
  const least = new Map<number, { fds: number; ptys: number }>();
  for (let i = 0; i < reads; i++) {
    if (i > 0) await sleep(SEC);
    for (const pid of pids) {
      const { fds, ptys } = processUse(pid);
      if (fds === null || ptys === null) continue;
      const was = least.get(pid) ?? { fds, ptys };
      least.set(pid, { fds: Math.min(was.fds, fds), ptys: Math.min(was.ptys, ptys) });
    }
  }
  return least;
}

/**
 * The kinds of output a seam step tries a terminal of, one each: replays pause between turns,
 * floods between bursts, idle and echo shells between markers.
 */
const SEAM_GROUPS: readonly (readonly Load[])[] = [["replay"], ["flood"], ["idle", "echo"]];
/** How many times a seam step tries each terminal for output that pauses. */
const SEAM_ATTEMPTS = 5;
/** How long a closed shell's worker has to go before it counts as outliving its holder. */
const ORPHAN_AFTER_MS = 5 * SEC;

/** How many of the last round's attaches run at once. */
const FINAL_ATTACHES_AT_ONCE = 6;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** How long a holder gets to answer: one that doesn't is missing from the sample, not its end. */
const timeout = () => AbortSignal.timeout(5 * SEC);

async function waitFor<T>(
  what: string,
  ms: number,
  read: () => T | undefined | Promise<T | undefined>,
  everyMs = 100,
) {
  const until = performance.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** What `watch` reads of a view. */
export interface Viewing {
  hasSnapshot(): boolean;
  snapshot(): Buffer;
  received(): Buffer;
}

/**
 * A view's snapshot and the stream after it, read for `holdMs` once the snapshot has arrived, and
 * the attach's time: when it had, read on `now`. Every marker written a second before that time
 * is in the snapshot or, written after the snapshot was taken, in the stream read for seconds more.
 */
export async function watch(
  view: Viewing,
  holdMs: number,
  now: () => number = Date.now,
): Promise<{ t: number; snapshot: Buffer; stream: Buffer }> {
  await waitFor("a view's snapshot", 10 * SEC, () => (view.hasSnapshot() ? true : undefined), 10);
  const t = now();
  await sleep(holdMs);
  const snapshot = view.snapshot();
  return { t, snapshot, stream: view.received().subarray(snapshot.length) };
}

/**
 * How many of a process's open files, by what each names, are PTY masters: the `ptmx` a PTY is
 * opened through, at `/dev/ptmx` or a devpts mount's own.
 */
export function ptyMasters(names: readonly string[]): number {
  return names.filter((name) => name === "/dev/ptmx" || name.endsWith("/pts/ptmx")).length;
}

/** What each of a process's fds names, from /proc; one closed between the listing and the read names nothing. */
function fdTargets(pid: number): string[] {
  const dir = `/proc/${pid}/fd`;
  return readdirSync(dir).map((fd) => {
    try {
      return readlinkSync(join(dir, fd));
    } catch {
      return "";
    }
  });
}

/** A process's resident memory, open fds and PTY masters, or nulls where this OS won't say. */
function processUse(pid: number): { rss: number | null; fds: number | null; ptys: number | null } {
  try {
    if (process.platform === "linux") {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const kib = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]);
      const targets = fdTargets(pid);
      return {
        rss: Number.isFinite(kib) ? kib * 1024 : null,
        fds: targets.length,
        ptys: ptyMasters(targets),
      };
    }
    // Each with a timeout: a hung one is ended, and costs one reading, not the run.
    const ps = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const lsof = execFileSync("lsof", ["-n", "-P", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const kib = Number(ps.trim());
    // A line a file, under a header; its name last.
    const files = lsof.trim().split("\n").slice(1);
    return {
      rss: Number.isFinite(kib) ? kib * 1024 : null,
      fds: files.length,
      ptys: ptyMasters(files.map((line) => line.split(/\s+/).at(-1) ?? "")),
    };
  } catch {
    return { rss: null, fds: null, ptys: null };
  }
}

/** One at a time: what holds it has the holders' connections, or the churn, to itself. */
class Lock {
  private tail: Promise<void> = Promise.resolve();
  async hold<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}

/** What a churn step came to, when it didn't throw: done, or nothing it could do now. */
type Outcome = "done" | "skipped" | void;

/** Which of the churn's lanes a step takes. */
type Lane = "views" | "terminals" | "both";

interface Terminal {
  readonly name: string;
  readonly load: Load;
  terminalId: string;
  /** The worker's pid and when it started, once its record says so. */
  pid?: number;
  startedAt?: number;
  /** Set once the driver begins closing it: from then on its holder may go at any moment. */
  closing?: boolean;
  /** The holder's child, the shell, by the holder's latest word: it must go with its holder. */
  childPid?: number;
  /** The holder itself, by its latest word: it must go once its terminal is closed. */
  holderPid?: number;
}

/**
 * Which of a closed terminal's processes are still alive, by `alive`: its worker, its shell and
 * its holder, any of which, outliving the close, may hold its PTY open.
 */
export function outliving(
  terminal: Pick<Terminal, "pid" | "childPid" | "holderPid">,
  alive: (pid: number) => boolean,
): number[] {
  const pids = [terminal.pid, terminal.childPid, terminal.holderPid];
  return [...new Set(pids)].filter((pid): pid is number => pid !== undefined && alive(pid));
}

/**
 * What a step that failed on `terminal` comes to: nothing, when the driver itself was closing
 * that terminal under it, as the views lane's steps run beside the one closing idle shells. Any
 * other failure is the step's own, thrown again for the judge.
 */
export function closedUnder(terminal: { readonly closing?: boolean }, error: unknown): "skipped" {
  if (terminal.closing === true) return "skipped";
  throw error;
}

/** One soak run, from its first terminal to its verdict. */
class Soak {
  private daemon: Daemon | undefined;
  private model: FakeModel | undefined;
  private readonly terminals = new Map<string, Terminal>();
  private readonly counts = new Map<string, number>();
  private readonly idle: string[] = [];
  private agentId = "";
  private daemonUp = false;
  private daemonStartedAt = 0;
  private stopping = false;
  private readonly timers: NodeJS.Timeout[] = [];
  /** The churn's two lanes: views (rotating attaches, seams), and terminals (shells, agent). */
  private readonly viewsLane = new Lock();
  private readonly terminalsLane = new Lock();
  private readonly holders = new Lock();
  private readonly queued = new Set<string>();
  private rotation = 0;
  /** Each seam group's turn: which of its terminals the next seam step tries. */
  private readonly seamTurns = new Map<readonly Load[], number>();
  private readonly logOffsets = new Map<string, number>();
  private viewed: { name: string; view: View; at: number }[] = [];
  /** Whether a settled sample is being taken, which the regular samples keep out of. */
  private settling = false;
  private echo:
    | { process: ChildProcessWithoutNullStreams; lines: AsyncIterator<string> }
    | undefined;

  private readonly profile: Profile;
  private readonly out: string;
  private readonly faults: readonly Fault[];

  constructor(chosen: Profile, out: string, faults: readonly Fault[]) {
    this.profile = chosen;
    this.out = out;
    this.faults = faults;
  }

  private record(event: SoakEvent): void {
    appendFileSync(join(this.out, "events.jsonl"), `${JSON.stringify(event)}\n`);
  }

  private log(line: string): void {
    appendFileSync(join(this.out, "driver.log"), `${new Date().toISOString()} ${line}\n`);
  }

  private get live(): Daemon {
    if (this.daemon === undefined) throw new Error("no daemon");
    return this.daemon;
  }

  private nextName(load: Load): string {
    const n = (this.counts.get(load) ?? 0) + 1;
    this.counts.set(load, n);
    return `${load === "agent" ? "a" : load[0]}${n}`;
  }

  private byTerminal(id: string): Terminal | undefined {
    return [...this.terminals.values()].find((t) => t.terminalId === id);
  }

  async run(): Promise<number> {
    mkdirSync(join(this.out, "workers"), { recursive: true });
    writeFileSync(
      join(this.out, "profile.json"),
      `${JSON.stringify({ name: this.profile.name, hours: this.profile.hours, faults: this.faults })}\n`,
    );
    try {
      await this.begin();
      await this.soak();
    } catch (error) {
      this.log(`the run stopped early: ${String(error)}`);
    } finally {
      await this.end();
    }
    const verdict = judge(readRun(this.out), this.profile.judge);
    writeFileSync(join(this.out, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
    const text = report(verdict);
    writeFileSync(join(this.out, "verdict.txt"), `${text}\n`);
    console.log(text);
    return verdict.pass ? 0 : 1;
  }

  /** The daemon on holders, and the load. */
  private async begin(): Promise<void> {
    this.model = await startFakeModel();
    this.daemonStartedAt = Date.now();
    this.daemon = await Daemon.start({
      modelUrl: this.model.url,
      config: '[runtime]\ndefault = "holder"\n',
    });
    this.daemonUp = true;
    for (const mode of MODES) {
      for (let i = 0; i < this.profile.load[mode]; i++) await this.openWorker(mode);
    }
    await this.openAgent();
    await this.view();
    await this.startEcho();
  }

  /** The keystroke timer, a process of its own driving the echo shell's view. */
  private async startEcho(): Promise<void> {
    const e1 = this.terminals.get("e1");
    if (e1 === undefined) return;
    const w = this.profile.worker;
    const starts = [...this.terminals.values()]
      .filter((t) => t.load === "flood")
      .map((t) => t.startedAt ?? 0);
    const child = spawn(
      process.execPath,
      [
        ECHO,
        this.live.url,
        e1.terminalId,
        join(this.out, "echo.jsonl"),
        "--every",
        String(this.profile.echoEveryMs),
        "--flood-on",
        String(w.floodOnMs),
        "--flood-off",
        String(w.floodOffMs),
        "--flood-starts",
        starts.join(","),
      ],
      { env: { ...process.env, SOAK_COOKIE: await this.live.cookie() }, stdio: "pipe" },
    );
    child.stderr.on("data", (chunk: Buffer) => this.log(`echo: ${chunk.toString().trim()}`));
    child.on("exit", (code) => this.log(`the echo timer exited with ${String(code)}`));
    this.echo = {
      process: child,
      lines: createInterface({ input: child.stdout })[Symbol.asyncIterator](),
    };
    await this.echoSays("ready");
  }

  /** Tells the echo timer `command` and waits for its `answer`. */
  private async echoSays(answer: string, command?: string): Promise<void> {
    const echo = this.echo;
    if (echo === undefined) return;
    if (command !== undefined) echo.process.stdin.write(`${command}\n`);
    const said = await Promise.race([echo.lines.next(), sleep(30 * SEC).then(() => undefined)]);
    if (said?.value !== answer) {
      throw new Error(`the echo timer said ${String(said?.value)}, not ${answer}`);
    }
  }

  /** A shell running a worker in `mode`, under a name never used before. */
  private async openWorker(mode: Mode): Promise<string> {
    const daemon = this.live;
    const name = this.nextName(mode);
    const opened = await daemon.request("/v1/shells", {
      method: "POST",
      body: { idempotencyKey: `soak-${name}`, cwd: daemon.work },
    });
    const { terminalId } = ShellCommandResponse.parse(opened.body);
    const shell = StateSnapshot.parse((await daemon.request("/v1/state")).body).shells.find(
      (s) => s.id === terminalId,
    );
    if (!shell?.attachCommand?.startsWith("bazhen attach")) {
      throw new Error(`${name} is not on the holder runtime: ${shell?.attachCommand ?? "none"}`);
    }
    const terminal: Terminal = { name, load: mode, terminalId };
    this.terminals.set(name, terminal);
    this.record({ kind: "open", t: Date.now(), name, load: mode });
    const w = this.profile.worker;
    const slow = this.faults.includes("slow-probe") && name === "r3" ? ["--slow-probe", "150"] : [];
    const argv = [
      process.execPath,
      WORKER,
      mode,
      name,
      join(this.out, "workers", `${name}.jsonl`),
      "--probe-every",
      String(w.probeEveryMs),
      "--lines-per-second",
      String(w.linesPerSecond),
      "--flood-on",
      String(w.floodOnMs),
      "--flood-off",
      String(w.floodOffMs),
      "--marker-every",
      String(w.markerEveryMs),
      ...slow,
    ];
    const view = await daemon.view(terminalId, "interactive", undefined, SIZE);
    await view.drive();
    view.type(`${argv.join(" ")}\r`);
    await this.started(terminal);
    view.close();
    if (mode === "idle") this.idle.push(name);
    return name;
  }

  /** Waits for a worker's start record, and keeps its pid and start. */
  private async started(terminal: Terminal): Promise<void> {
    const file = join(this.out, "workers", `${terminal.name}.jsonl`);
    const start = await waitFor(`${terminal.name}'s start`, 30 * SEC, () =>
      existsSync(file)
        ? readFileSync(file, "utf8")
            .split("\n")
            .map(asEvent)
            .find((e) => e?.kind === "start")
        : undefined,
    );
    if (start.kind === "start") {
      terminal.pid = start.pid;
      terminal.startedAt = start.t;
    }
  }

  private async openAgent(): Promise<void> {
    const daemon = this.live;
    const launched = await daemon.launch("soak-agent");
    this.agentId = launched.agentId;
    const agent = await this.agent("running", MIN);
    const name = this.nextName("agent");
    this.terminals.set(name, { name, load: "agent", terminalId: String(agent.terminalId) });
    this.record({ kind: "open", t: Date.now(), name, load: "agent" });
    // One real turn on the fake model, so the session has a conversation a respawn resumes: a
    // TUI asked to resume a session with none exits as soon as it starts.
    await daemon.prompt({ agentId: this.agentId, terminalId: String(agent.terminalId) }, "hello");
    await waitFor("the agent's session to be resumable", MIN, async () =>
      StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.find(
        (a) => a.id === this.agentId && a.resumable,
      ),
    );
  }

  /** The agent, once the daemon shows it in `state`. */
  private agent(state: string, ms: number) {
    return waitFor(`the agent ${state}`, ms, async () =>
      StateSnapshot.parse((await this.live.request("/v1/state")).body).agents.find(
        (a) => a.id === this.agentId && a.state === state,
      ),
    );
  }

  /** The view kept open, a replay's; the echo timer keeps the echo shell's. */
  private async view(): Promise<void> {
    const r1 = this.terminals.get("r1");
    if (r1 === undefined) return;
    const view = await this.live.view(r1.terminalId, "observe", undefined, SIZE);
    await waitFor("r1's snapshot", 10 * SEC, () => (view.hasSnapshot() ? true : undefined), 10);
    this.viewed = [{ name: "r1", view, at: Date.now() }];
    // A second view's snapshot is the first use of r1's control connection, which then stays
    // while the kept view does. Made now, it comes before any settled count of this daemon's.
    await this.attach("r1");
  }

  /** Records what each kept view saw, and closes it. */
  private async unview(): Promise<void> {
    const viewed = this.viewed;
    this.viewed = [];
    for (const { name, view, at } of viewed) {
      view.close();
      await this.recordAttach(name, view, at);
    }
  }

  private async recordAttach(name: string, view: View, t: number): Promise<void> {
    const snapshot = view.snapshot();
    const seen = await attachMarkers(
      name,
      snapshot,
      view.received().subarray(snapshot.length),
      SIZE,
    );
    this.record({ kind: "attach", t, name, ...seen });
  }

  /**
   * Attaches a view to `name`'s terminal for a few seconds, as a browser would; whether it did,
   * which it doesn't to a terminal gone, nor while the daemon is down.
   */
  private async attach(name: string): Promise<boolean> {
    const terminal = this.terminals.get(name);
    if (terminal === undefined || !this.daemonUp) return false;
    const view = await this.live.view(terminal.terminalId, "observe", undefined, SIZE);
    try {
      const { t, snapshot, stream } = await watch(view, this.profile.attachHoldMs);
      this.record({
        kind: "attach",
        t,
        name,
        ...(await attachMarkers(name, snapshot, stream, SIZE)),
      });
      return true;
    } finally {
      view.close();
    }
  }

  /** The churn and the samples, each on its own timer, until the window ends. */
  private async soak(): Promise<void> {
    const p = this.profile;
    const started = Date.now();
    const every = (ms: number, kind: string, lane: Lane, task: () => Promise<Outcome>) =>
      this.timers.push(setInterval(() => this.enqueue(kind, lane, task), ms));
    every(p.restartEveryMs, "restart", "both", () => this.restart());
    every(p.rotateEveryMs, "rotate", "views", () => this.rotate());
    every(p.seamEveryMs, "seam", "views", () => this.seam());
    every(p.idleChurnEveryMs, "idle", "terminals", () => this.churnIdle());
    every(p.agentCycleEveryMs, "agent", "terminals", () => this.cycleAgent());
    every(p.settleEveryMs, "settled", "both", async () => {
      // From the wait on: what the driver does meanwhile would be counted as the processes'.
      this.settling = true;
      try {
        if (!(await this.settle())) throw new Error("not every terminal ran in 20 s");
        await this.takeSample(true);
        this.log(
          `settled; load average ${loadavg()[0]?.toFixed(1) ?? "?"}, ` +
            `${ptysInUse().used} PTYs on the machine`,
        );
      } finally {
        this.settling = false;
      }
    });
    this.timers.push(
      setInterval(
        () => void this.sample().catch((e: unknown) => this.log(`sample: ${String(e)}`)),
        p.sampleEveryMs,
      ),
    );
    if (this.faults.includes("close-holder")) {
      this.timers.push(
        setTimeout(
          () =>
            this.enqueue("fault", "both", async () => {
              const target = this.terminals.get("r2");
              if (target === undefined) return;
              this.log("fault: closing r2's holder behind the daemon's back");
              await closeHolder(
                join(this.live.home, "run", "holders", `${target.terminalId}.sock`),
              );
            }),
          p.warmupMs / 2,
        ),
      );
    }
    await sleep(started + p.warmupMs - Date.now());
    const from = Date.now();
    this.record({ kind: "window", t: from, phase: "measure" });
    // Timers never fire early, so the window is never short of what was asked.
    await sleep(p.measureMs);
    this.record({ kind: "window", t: Math.max(Date.now(), from + p.measureMs), phase: "end" });
  }

  /**
   * Waits, with the churn held, until the daemon shows every terminal of the soak's whose holder
   * still answers as running, as it does once a restart has found their holders again and the
   * agent is back; then for closed connections to go.
   */
  private async settle(): Promise<boolean> {
    const settled = await waitFor("every terminal running", 20 * SEC, async () => {
      const state = StateSnapshot.parse((await this.live.request("/v1/state")).body);
      const shown = [
        ...state.shells.map((s) => [s.id, s.state] as const),
        ...state.agents.map((a) => [String(a.terminalId), a.state] as const),
      ];
      // A terminal whose holder is gone stays lost, which is the judge's to see, not a wait's.
      const held = (id: string) => existsSync(join(this.live.home, "run", "holders", `${id}.sock`));
      const ours = shown.filter(([id]) => this.byTerminal(id) !== undefined && held(id));
      return ours.length > 0 && ours.every(([, st]) => st === "running") ? true : undefined;
    }).catch(async () => {
      const state = StateSnapshot.parse((await this.live.request("/v1/state")).body);
      const states = [...state.shells, ...state.agents].map((t) => t.state).join(" ");
      this.log(`no settled sample: not every terminal ran in 20 s (${states})`);
      return false;
    });
    // Past the daemon's HTTP keep-alive, so no connection of the driver's is counted as its.
    if (settled) await sleep(KEEP_ALIVE_MS);
    return settled;
  }

  /**
   * Queues a churn step in its lane unless one of its kind is waiting already. Steps in a lane run
   * one by one; one in both waits for both lanes to empty, and holds both.
   */
  private enqueue(kind: string, lane: Lane, task: () => Promise<Outcome>): void {
    if (this.stopping || this.queued.has(kind)) return;
    this.queued.add(kind);
    const step = async () => {
      this.queued.delete(kind);
      if (this.stopping) return;
      const began = performance.now();
      try {
        // A step with nothing to do, an empty pool or a daemon down, did nothing to record.
        if ((await task()) !== "skipped") {
          this.record({ kind: "step", t: Date.now(), step: kind, ok: true });
        }
      } catch (error) {
        this.record({ kind: "step", t: Date.now(), step: kind, ok: false, why: String(error) });
        throw error;
      }
      const took = performance.now() - began;
      if (took > 30 * SEC) this.log(`${kind} took ${Math.round(took / SEC)} s`);
    };
    const held =
      lane === "views"
        ? this.viewsLane.hold(step)
        : lane === "terminals"
          ? this.terminalsLane.hold(step)
          : this.viewsLane.hold(() => this.terminalsLane.hold(step));
    held.catch((error: unknown) => this.log(`${kind} failed: ${String(error)}`));
  }

  private async restart(): Promise<void> {
    const daemon = this.live;
    await this.steerEcho("paused", "pause");
    await this.unview();
    this.daemonUp = false;
    this.record({ kind: "daemon", t: Date.now(), up: false });
    await daemon.crash();
    await sleep(this.profile.downMs);
    this.daemonStartedAt = Date.now();
    await daemon.restart();
    this.record({ kind: "daemon", t: Date.now(), up: true });
    this.daemonUp = true;
    await this.view();
    await this.steerEcho("resumed", `resume ${daemon.url}`);
  }

  /**
   * Tells the echo timer `command`. One that doesn't answer as it should is out of step with the
   * driver for good, so it is stopped, and its failure recorded for the judge, rather than left
   * to stop every restart after it.
   */
  private async steerEcho(answer: string, command: string): Promise<void> {
    try {
      await this.echoSays(answer, command);
    } catch (error) {
      this.record({ kind: "step", t: Date.now(), step: "echo", ok: false, why: String(error) });
      this.echo?.process.stdin.end();
      this.echo = undefined;
    }
  }

  /** The workers whose holders still answer, in a fixed order. */
  private workers(): Terminal[] {
    const home = this.live.home;
    return [...this.terminals.values()].filter(
      (t) =>
        t.load !== "agent" &&
        t.closing !== true &&
        existsSync(join(home, "run", "holders", `${t.terminalId}.sock`)),
    );
  }

  private async rotate(): Promise<Outcome> {
    const workers = this.workers();
    const next = workers[this.rotation++ % Math.max(1, workers.length)];
    if (next === undefined) return "skipped";
    try {
      return (await this.attach(next.name)) ? "done" : "skipped";
    } catch (error) {
      return closedUnder(next, error);
    }
  }

  /** Closes the oldest idle shell, checked last, and opens another, checked first. */
  private async churnIdle(): Promise<Outcome> {
    const name = this.idle.shift();
    const terminal = name === undefined ? undefined : this.terminals.get(name);
    if (name === undefined || terminal === undefined) return "skipped";
    await this.attach(name);
    terminal.closing = true;
    this.record({ kind: "close", t: Date.now(), name });
    const closedAt = Date.now();
    try {
      const closed = await this.live.request(`/v1/shells/${terminal.terminalId}/close`, {
        method: "POST",
        body: { idempotencyKey: `soak-close-${name}`, generation: 0, confirmBusy: true },
      });
      if (closed.status !== 200) {
        throw new Error(`closing ${name}: ${closed.status} ${JSON.stringify(closed.body)}`);
      }
      const opened = await this.openWorker("idle");
      await sleep(2 * SEC);
      await this.attach(opened);
    } finally {
      // The closed terminal's processes have had seconds to go; one still here outlived the
      // close, and may hold its PTY open.
      await sleep(closedAt + ORPHAN_AFTER_MS - Date.now());
      for (const pid of outliving(terminal, isAlive)) {
        this.record({ kind: "orphan", t: Date.now(), name, pid });
      }
      this.terminals.delete(name);
    }
  }

  /** Makes the agent exit, then respawns it, as a person restarting it would. */
  private async cycleAgent(): Promise<void> {
    const daemon = this.live;
    const running = await this.agent("running", 30 * SEC);
    const command = async (verb: string, body: Record<string, unknown>) => {
      const answered = await daemon.request(`/v1/agents/${this.agentId}/${verb}`, {
        method: "POST",
        body: {
          idempotencyKey: `soak-${verb}-${Date.now()}`,
          generation: running.generation,
          ...body,
        },
      });
      if (answered.status !== 200) {
        this.log(`agent ${verb}: ${answered.status} ${JSON.stringify(answered.body)}`);
      }
    };
    await command("signal", { signal: "SIGTERM" });
    const exited = await this.agent("exited", 30 * SEC).catch(async () => {
      this.log("the agent didn't exit on SIGTERM in 30 s; sending SIGKILL");
      await command("signal", { signal: "SIGKILL" });
      return this.agent("exited", 30 * SEC);
    });
    if (!exited.resumable || !exited.commands.includes("respawn")) {
      this.log(`the agent can't be respawned: ${JSON.stringify(exited)}`);
    }
    await command("respawn", {});
    const again = await this.agent("running", MIN);
    this.log(`the agent exited and ran again, at generation ${again.generation}`);
    const a1 = [...this.terminals.values()].find((t) => t.load === "agent");
    if (a1 !== undefined && String(again.terminalId) !== a1.terminalId) {
      this.log(`the agent's terminal moved from ${a1.terminalId} to ${String(again.terminalId)}`);
      a1.terminalId = String(again.terminalId);
    }
  }

  /**
   * A viewer's screen against the holder's own at the same offset: the holder's snapshot, a view
   * opened through the daemon, and the holder's snapshot again, kept only when no output came
   * between. Output pauses often, between a replay's turns, between a flood's bursts and between
   * an idle shell's markers, but not always, so a step tries a few terminals, a few times each.
   */
  private async seam(): Promise<Outcome> {
    const workers = this.workers();
    if (workers.length === 0 || !this.daemonUp) return "skipped";
    // One terminal of each kind of output, in turn within each, so no step tries only replays.
    for (const group of SEAM_GROUPS) {
      const kind = workers.filter((w) => group.includes(w.load));
      const turn = this.seamTurns.get(group) ?? 0;
      this.seamTurns.set(group, turn + 1);
      const target = kind[turn % Math.max(1, kind.length)];
      if (target === undefined || !this.daemonUp) continue;
      const seamed = await this.seamOn(target).catch((error: unknown) =>
        closedUnder(target, error),
      );
      if (seamed === "skipped") continue;
      if (seamed) return "done";
      this.record({ kind: "unpaused", t: Date.now(), name: target.name });
    }
    return "done";
  }

  /** One terminal's seam, if its output pauses in time: whether one was recorded. */
  private async seamOn(target: Terminal): Promise<boolean> {
    const socket = join(this.live.home, "run", "holders", `${target.terminalId}.sock`);
    return this.holders.hold(async () => {
      const client = await connectHolder(socket, { onEvent: () => {}, signal: timeout() });
      try {
        const size = client.hello.size;
        for (let attempt = 0; attempt < SEAM_ATTEMPTS; attempt++) {
          const first = await client.snapshot({ signal: timeout() });
          const view = await this.live.view(target.terminalId, "observe", undefined, size);
          try {
            await waitFor("the seam's snapshot", 10 * SEC, () =>
              view.hasSnapshot() ? true : undefined,
            );
            await sleep(300);
            const second = await client.snapshot({ signal: timeout() });
            if (first.offset !== second.offset || first.generation !== second.generation) continue;
            const equal =
              (await screenOf(view.received(), size)) === (await screenOf(first.bytes, size));
            this.record({ kind: "seam", t: Date.now(), name: target.name, equal });
            return true;
          } finally {
            view.close();
          }
        }
        return false;
      } finally {
        client.end();
      }
    });
  }

  /** A regular sample, unless a settled one is being taken, whose counts it would disturb. */
  private async sample(): Promise<void> {
    if (!this.settling) await this.takeSample(false);
  }

  /** Every holder over its own protocol, then the daemon, its terminals, and the machine's PTYs. */
  private async takeSample(settled: boolean): Promise<void> {
    const home = this.live.home;
    const daemonPid = this.daemonUp ? this.daemon?.pid : undefined;
    const read = await this.holders.hold(async () => {
      const answered: {
        terminal: Terminal;
        pid: number;
        stats: { engineBytes: number; rss: number | null; engineResets?: number | undefined };
      }[] = [];
      for (const socket of holderSockets(home)) {
        const terminal = this.byTerminal(basename(socket, ".sock"));
        if (terminal === undefined) continue;
        try {
          const client = await connectHolder(socket, { onEvent: () => {}, signal: timeout() });
          try {
            const stats = await client.stats({ signal: timeout() });
            terminal.childPid = client.hello.childPid;
            terminal.holderPid = client.hello.holderPid;
            answered.push({ terminal, pid: client.hello.holderPid, stats });
          } finally {
            client.end();
            await client.closed;
          }
        } catch {
          // A holder gone between the listing and the connection is missing from this sample.
        }
      }
      // Its hang-ups taken, so no fd counted is this sample's own.
      await sleep(settled ? SEC : 500);
      const pids = [...answered.map((a) => a.pid), ...(daemonPid === undefined ? [] : [daemonPid])];
      const fds = await leastFds(pids, settled ? SETTLED_READS : 1);
      return {
        daemonFds: daemonPid === undefined ? null : (fds.get(daemonPid)?.fds ?? null),
        // The soak's own: the machine's count, a kernel-wide one, counts every container's too.
        ptys: [...fds.values()].reduce((sum, use) => sum + use.ptys, 0),
        holders: answered.map(({ terminal, pid, stats }): HolderSample => ({
          name: terminal.name,
          pid,
          load: terminal.load,
          rss: stats.rss ?? processUse(pid).rss,
          fds: fds.get(pid)?.fds ?? null,
          engineBytes: stats.engineBytes,
          engineResets: stats.engineResets ?? 0,
        })),
      };
    });
    const pid = daemonPid;
    let terminals: TerminalSample[] = [];
    let daemon: { pid: number; rss: number; fds: number; ageMs: number } | null = null;
    if (pid !== undefined) {
      try {
        const state = StateSnapshot.parse((await this.live.request("/v1/state")).body);
        const shown = [
          ...state.shells.map((s) => [s.id, s.state] as const),
          ...state.agents.map((a) => [String(a.terminalId), a.state] as const),
        ];
        terminals = shown.flatMap(([id, shownState]) => {
          const terminal = this.byTerminal(id);
          return terminal === undefined
            ? []
            : [{ name: terminal.name, load: terminal.load, state: shownState }];
        });
        const rss = processUse(pid).rss;
        if (rss !== null && read.daemonFds !== null) {
          daemon = { pid, rss, fds: read.daemonFds, ageMs: Date.now() - this.daemonStartedAt };
        }
      } catch (error) {
        this.log(`the daemon didn't answer a sample: ${String(error)}`);
        terminals = [];
      }
    }
    this.record({
      kind: "sample",
      t: Date.now(),
      settled: settled && daemon !== null,
      daemon,
      holders: read.holders,
      terminals: daemon === null ? [] : terminals,
      ptys: read.ptys,
    });
    this.panics(home);
  }

  /** Panic lines new in each holder's log since the last look. */
  private panics(home: string): void {
    for (const terminal of this.terminals.values()) {
      const file = join(home, "run", "holders", `${terminal.terminalId}.log`);
      if (!existsSync(file)) continue;
      const size = statSync(file).size;
      const from = (this.logOffsets.get(file) ?? 0) > size ? 0 : (this.logOffsets.get(file) ?? 0);
      this.logOffsets.set(file, size);
      if (size === from) continue;
      const bytes = Buffer.alloc(size - from);
      const fd = openSync(file, "r");
      try {
        readSync(fd, bytes, 0, bytes.length, from);
      } finally {
        closeSync(fd);
      }
      for (const line of bytes.toString("utf8").split("\n")) {
        if (line.includes("panicked")) {
          this.record({
            kind: "panic",
            t: Date.now(),
            name: terminal.name,
            line: line.slice(0, 500),
          });
        }
      }
    }
  }

  /** Copies the holders' logs into the run's directory: stopping the daemon deletes its home. */
  private keepHolderLogs(): void {
    const holders =
      this.daemon === undefined ? undefined : join(this.daemon.home, "run", "holders");
    try {
      if (holders === undefined || !existsSync(holders)) return;
      const kept = join(this.out, "holder-logs");
      mkdirSync(kept, { recursive: true });
      for (const file of readdirSync(holders).filter((f) => /\.log(\.1)?$/.test(f))) {
        // One that can't be copied, gone or unreadable, costs its lines, never the teardown.
        try {
          copyFileSync(join(holders, file), join(kept, file));
        } catch (error) {
          this.log(`keeping ${file}: ${String(error)}`);
        }
      }
    } catch (error) {
      this.log(`keeping the holders' logs: ${String(error)}`);
    }
  }

  /** Stops the churn and closes every terminal, each close recorded first. */
  private async end(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    await this.viewsLane.hold(() => this.terminalsLane.hold(async () => {}));
    this.echo?.process.stdin.end();
    if (this.daemonUp) {
      // Each worker checked once more, so loss after its last rotating attach is seen too.
      const workers = this.workers();
      for (let i = 0; i < workers.length; i += FINAL_ATTACHES_AT_ONCE) {
        await Promise.all(
          workers
            .slice(i, i + FINAL_ATTACHES_AT_ONCE)
            .map((w) =>
              this.attach(w.name).catch((e: unknown) => this.log(`final attach: ${String(e)}`)),
            ),
        );
      }
      await this.unview().catch((e: unknown) => this.log(`unview: ${String(e)}`));
    }
    for (const name of this.terminals.keys()) this.record({ kind: "close", t: Date.now(), name });
    this.keepHolderLogs();
    await this.daemon?.stop().catch((e: unknown) => this.log(`stopping the daemon: ${String(e)}`));
    await this.model?.close();
  }
}

/** `pnpm soak`: a run, refused off a disposable host, or a run's directory judged again. */
export async function main(
  args: readonly string[],
  sandboxed = inSignalSandbox(),
): Promise<number> {
  const parsed = parseSoakArgs(args);
  if ("judge" in parsed) {
    const saved: unknown = JSON.parse(readFileSync(join(parsed.judge, "profile.json"), "utf8"));
    const named = typeof saved === "object" && saved !== null && "name" in saved ? saved.name : "";
    const hours = typeof saved === "object" && saved !== null && "hours" in saved ? saved.hours : 0;
    if ((named !== "gate" && named !== "smoke") || typeof hours !== "number") {
      throw new Error(`${parsed.judge}/profile.json names no profile`);
    }
    const verdict = judge(readRun(parsed.judge), profile(named, hours).judge);
    console.log(report(verdict));
    return verdict.pass ? 0 : 1;
  }
  // Before anything is made: a run's holders signal every process in their sessions.
  requireSignalSandbox(sandboxed);
  console.log(
    `soak: ${parsed.profile.name}, ${parsed.profile.hours} h measured, into ${parsed.out}`,
  );
  return new Soak(parsed.profile, parsed.out, parsed.faults).run();
}

// Exits outright: a handle left open by a view or a holder connection can't keep the run alive.
if (isMain(import.meta)) process.exit(await main(process.argv.slice(2)));
