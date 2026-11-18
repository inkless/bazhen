// Runs cargo-mutants over the holder crate, one group of its code at a time, and judges each
// mutant its Rust tests miss again with the holder suite, the black-box contract the daemon
// relies on (docs/standards/testing.md § Falsification). It reports each mutant as:
//   caught     a Rust test failed
//   suite      no Rust test failed, but the holder suite did
//   missed     neither did: a gap in the tests, or a mutant that changes nothing
//   unviable   it didn't build
//   timeout    the Rust tests ran out of time on it
// It leaves out the mutants the first sweep classed equivalent (`EQUIVALENTS`), each with its reason.
// It is a tool, not a check: a count of survivors is no gate (testing.md). Its table is for
// someone to read, class each survivor and write the test that kills it. `--only` narrows a group
// to the mutants a regex names, to see new tests kill them: each one caught is printed with the
// tests that failed on it and why, what a `Control:` trailer names.
//
// A mutant of the holder can send a signal to any pid the mutated code computes, so this refuses
// to start, before it lists or builds anything, anywhere but a sandbox: the `pnpm test:real`
// container or a marked CI runner (scripts/signal-paths.ts). In the container the tree is the
// image's own copy, so a mutant applied in place is undone with the container at the latest.
//
// Usage: node scripts/holder-mutants.ts --group <signal|lifecycle|rest|macos> [--shard k/n]
//        [--only <regex>] [--jobs n]
// `--only` takes a JavaScript regex, matched against cargo-mutants' names for the group's mutants.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateEnv } from "./cargo-gate.ts";
import { isolatedEnv } from "./falsify.ts";
import { isMain } from "./is-main.ts";
import { patchOf } from "./rust-mutants.ts";
import { DISPOSABLE_HOST_MARKER, inSignalSandbox } from "./signal-paths.ts";

const CRATE = "bazhen-holder";
const SRC = `crates/${CRATE}/src`;

// Functions of the server and its connections that close, drop, evict, accept, or look for the
// socket again: what decides whether a peer's end, a stuck peer or a lost socket ends a terminal.
const LIFECYCLE_FUNCTIONS = [
  "Server::(?:accept|close_done|deadline|evict_stuck_snapshots|listening|release_writer|run|send_exit|turn|victim)",
  "Connection::(?:deadline|drop_now|flush|hang_up|is_finished|is_gone|polled)",
  "evicting_at",
];
const LIFECYCLE_NAME = `^${SRC}/(?:server|conn)\\.rs:\\d+:\\d+: .*\\b(?:${LIFECYCLE_FUNCTIONS.join("|")})\\b`;
const SIGNAL_FILES = ["guard.rs", "child.rs", "session.rs", "pty.rs", "signals.rs"];
const LIFECYCLE_FILES = ["socket.rs"];
/** Every module lib.rs declares under `#[cfg(target_os = "macos")]`. */
export const MACOS_FILES: readonly string[] = ["macos.rs"];
/** The files whose lifecycle functions `LIFECYCLE_NAME` picks out. */
const LIFECYCLE_NAME_FILES = ["server.rs", "conn.rs"];

/**
 * A survivor class the first sweep read and found to change nothing, left out of every group so a
 * re-sweep doesn't triage it again. It names the mutants by their function and mutation, not
 * their line, so an edit to the code around one doesn't move the exclusion onto another; where
 * one function holds two mutants of the same kind (`+`→`*` twice in `requeue_exited`), a column
 * tells them apart, and the source at that place is checked, so a pin the code has moved away from
 * is refused rather than left on whatever now stands there.
 */
export interface Equivalent {
  /** A regex, in the syntax both of JavaScript and of the Rust regex crate, on a mutant's name. */
  readonly re: string;
  /** How many mutants it names today: a different count means the code moved under it. */
  readonly count: number;
  /** Why none of them changes what the code does. */
  readonly why: string;
  /** Text each mutant's line of source must contain. */
  readonly on?: string;
}

const reOf = (file: string, mutant: string) => `^${SRC}/${file}:\\d+:\\d+: ${mutant}$`;
const reAtColumn = (file: string, column: number, mutant: string) =>
  `^${SRC}/${file}:\\d+:${column}: ${mutant}$`;

/** The classified equivalents. Anything that isn't one of these is a gap or a catch, not here. */
export const EQUIVALENTS: readonly Equivalent[] = [
  {
    re: reAtColumn("conn.rs", 30, "replace \\+ with \\* in Connection::requeue_exited"),
    count: 1,
    on: ".map_or(0, |i| i + 1)",
    why: "`i * 1` starts the search at the `respawned` frame, which is never `exit`, so the same frame is found",
  },
  {
    re: reOf("holder.rs", "replace Output::take_replies -> Vec<u8> with vec!\\[[01]?\\]"),
    count: 3,
    why: "`vec![]` is `Vec::new()`; the default reaches only `Discard` and tests, and `Screen`, the only production output, overrides it",
  },
  {
    re: reOf("holder.rs", "replace \\| with \\^ in Holder<O>::master_interest"),
    count: 1,
    why: "`IN` and `OUT` are disjoint bits, so `^` is `|`",
  },
  {
    re: reOf("holder.rs", "replace \\|\\| with && in Holder<O>::flush_input"),
    count: 1,
    why: "`&&` returns only on an empty queue with the master closed; an empty queue writes nothing, and input is never queued once the master closes",
  },
  {
    re: reOf("holder.rs", "replace < with <= in Holder<O>::read_master"),
    count: 1,
    why: "one more read in a turn, only when the turn's reads came to exactly the cap, which still holds to within a chunk",
  },
  {
    re: reOf("input.rs", "replace < with <= in InputQueue::write_to"),
    count: 1,
    why: "at the cap the extra pass takes a chunk of `min(len, 0)` bytes, which is empty, and breaks",
  },
  {
    re: reOf(
      "log.rs",
      "replace <impl Write for Line<'_, W>>::flush -> io::Result<\\(\\)> with Ok\\(\\(\\)\\)",
    ),
    count: 1,
    why: "a `Line` holds a `BoundedLog`, whose `flush` is `Ok(())`: it writes each line whole as it comes",
  },
  {
    re: reAtColumn("server.rs", 17, "replace != with == in foreground"),
    count: 1,
    on: "if pgid != child &&",
    why: "`pgid != child` gives the same answer with a job in front; the mutant re-reads the child's own start, which can't differ while it is unreaped, and skips the re-read of another group, which differs only in a pid-reuse race",
  },
  {
    re: reAtColumn("start_time.rs", 68, "replace == with != in read"),
    count: 1,
    on: "e.raw_os_error() == Some(libc::ESRCH)",
    why: "a gone process fails the open with `ENOENT`, already `Absent`; `ESRCH` comes only from an exit between the open and the read, and untestable without injecting the read",
  },
  {
    re: `^${SRC}/start_time\\.rs:60:5: replace read -> Result<u64, StartTimeError> with Ok\\([01]\\)$`,
    count: 2,
    on: "crate::macos::start_seconds(pid)",
    why: "the macOS `read`, which Linux doesn't compile, so here the mutant changes nothing; `says_what_ps_says_…` kills it on `rust (macos)`",
  },
  {
    re: reOf("macos.rs", "replace (?:\\+ with [-*]|/ with [%*]) in pids"),
    count: 4,
    why: "each changes only the slack over the sized length: less is `ENOMEM` on a race, which retries; more goes unused",
  },
  {
    re: reOf("macos.rs", "replace == with != in pids"),
    count: 1,
    why: "the `ENOMEM` retry differs only when processes start between the two calls, or on another error; untestable without injecting the syscall",
  },
];

interface GroupSpec {
  readonly files: readonly string[];
  readonly excludeFiles: readonly string[];
  readonly excludeRe: readonly string[];
  /** Mutants it also takes, by name, wherever they are. */
  readonly also?: string;
  /** The only platform its code compiles on, where it isn't every one. */
  readonly platform?: NodeJS.Platform;
}

/** The groups, most valuable first. */
export const GROUPS: Readonly<Record<"signal" | "lifecycle" | "rest" | "macos", GroupSpec>> = {
  /** Code that sends signals, or decides what they reach. */
  signal: { files: SIGNAL_FILES, excludeFiles: [], excludeRe: [] },
  /** Binding and rebinding the socket, and the close and drop paths of the server. */
  lifecycle: { files: LIFECYCLE_FILES, excludeFiles: [], excludeRe: [], also: LIFECYCLE_NAME },
  rest: {
    files: [],
    excludeFiles: [...SIGNAL_FILES, ...LIFECYCLE_FILES, ...MACOS_FILES],
    excludeRe: [LIFECYCLE_NAME],
  },
  /**
   * The files compiled only on macOS. cargo-mutants lists them on Linux too, where each of their
   * mutants builds, passes every test and would read as missed. Groups go by file, so a macOS-only
   * item in a file Linux shares stays in that file's group and reads as missed on Linux: classed
   * by reading, not by a run.
   */
  macos: { files: MACOS_FILES, excludeFiles: [], excludeRe: [], platform: "darwin" },
};
export type Group = keyof typeof GROUPS;
const isGroup = (name: string): name is Group => Object.hasOwn(GROUPS, name);

/**
 * The cargo-mutants filters that select `group`. `lifecycle` is two selections, since a mutant
 * there is in socket.rs or is a lifecycle function of the server: the second is returned apart.
 * That one names its files as well as its pattern: cargo-mutants 27.1.0 lists a mutant that
 * deletes a struct field whatever `--re` and `--exclude-re` say, so only a file filter keeps one
 * out. A field deletion in server.rs or conn.rs would land in two groups, which the partition
 * check refuses.
 */
export function groupFilters(group: Group): string[][] {
  const spec = GROUPS[group];
  const equivalents = EQUIVALENTS.flatMap((e) => ["--exclude-re", e.re]);
  const base = [
    ...spec.files.flatMap((f) => ["--file", `${SRC}/${f}`]),
    ...spec.excludeFiles.flatMap((f) => ["--exclude", `${SRC}/${f}`]),
    ...spec.excludeRe.flatMap((re) => ["--exclude-re", re]),
    ...equivalents,
  ];
  if (spec.also === undefined) return [base];
  const byName = [
    ...LIFECYCLE_NAME_FILES.flatMap((f) => ["--file", `${SRC}/${f}`]),
    "--re",
    spec.also,
    ...equivalents,
  ];
  return [base, byName];
}

/** Which group a mutant, by its cargo-mutants name, belongs to. */
export function groupOf(name: string): Group {
  const file = /^crates\/[^/]+\/src\/([^:]+):/.exec(name)?.[1] ?? "";
  if ((SIGNAL_FILES as readonly string[]).includes(file)) return "signal";
  if ((LIFECYCLE_FILES as readonly string[]).includes(file)) return "lifecycle";
  if (MACOS_FILES.includes(file)) return "macos";
  return new RegExp(LIFECYCLE_NAME).test(name) ? "lifecycle" : "rest";
}

/** `names` without those `equivalents` leave out. */
export function withoutEquivalents(
  names: readonly string[],
  equivalents: readonly Equivalent[],
): string[] {
  const res = equivalents.map((e) => new RegExp(e.re));
  return names.filter((name) => !res.some((re) => re.test(name)));
}

/**
 * Each of `equivalents` that names other than the number of mutants it says, of `all` the crate's
 * mutants, or names one whose line of `source` isn't the one it was classified on: the code moved, and
 * what it leaves out is no longer what was classified.
 */
export function equivalentFaults(
  all: readonly string[],
  equivalents: readonly Equivalent[],
  source: (file: string) => readonly string[],
): string[] {
  return equivalents.flatMap((e) => {
    const re = new RegExp(e.re);
    const found = all.filter((name) => re.test(name));
    const counted =
      found.length === e.count
        ? []
        : [
            `the equivalent ${e.re} names ${found.length} mutants, not the ${e.count} it was classed for`,
          ];
    const moved = found.flatMap((name) => {
      const place = /^([^:]+):(\d+):/.exec(name);
      if (place === null) return [`${name} has no file and line`];
      const lines = source(place[1]!);
      const line = Number(place[2]);
      const here = lines[line - 1] ?? "";
      return e.on === undefined || here.includes(e.on)
        ? []
        : [`${name} isn't on a line with ${e.on}`];
    });
    return [...counted, ...moved];
  });
}

/** What went wrong with a partition of `all` into the groups' listings, or nothing. */
export function partitionFaults(all: readonly string[], listed: Record<Group, string[]>): string[] {
  const faults: string[] = [];
  const seen = new Map<string, Group>();
  for (const group of Object.keys(listed).filter(isGroup)) {
    for (const name of listed[group]) {
      const other = seen.get(name);
      if (other !== undefined) faults.push(`${name} is in ${other} and ${group}`);
      seen.set(name, group);
      if (groupOf(name) !== group)
        faults.push(`${name} is listed in ${group}, not ${groupOf(name)}`);
    }
  }
  for (const name of all) if (!seen.has(name)) faults.push(`${name} is in no group`);
  return faults;
}

export type Summary = "caught" | "missed" | "unviable" | "timeout";
export interface Outcome {
  readonly name: string;
  readonly file: string;
  readonly summary: Summary;
  /** Where its diff is, relative to the mutants.out it came from. */
  readonly diffPath: string;
  /** Where its build and test output is, relative to the same. */
  readonly logPath: string;
  /** Seconds its build and tests took. */
  readonly seconds: number;
}

const SUMMARIES: Readonly<Record<string, Summary>> = {
  CaughtMutant: "caught",
  MissedMutant: "missed",
  Unviable: "unviable",
  Timeout: "timeout",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The mutants' outcomes in a cargo-mutants 27.1.0 `outcomes.json`, the baseline left out. It throws
 * on anything else, a failed baseline included, so a run that went wrong never reads as "nothing
 * missed".
 */
export function parseOutcomes(json: unknown): Outcome[] {
  if (!isObject(json) || !Array.isArray(json["outcomes"])) {
    throw new Error("not a cargo-mutants outcomes.json: no outcomes");
  }
  const outcomes: Outcome[] = [];
  for (const entry of json["outcomes"] as unknown[]) {
    if (!isObject(entry))
      throw new Error("not a cargo-mutants outcomes.json: an outcome is not one");
    const { scenario, summary } = entry;
    if (scenario === "Baseline") {
      if (summary !== "Success") throw new Error(`the baseline didn't pass: ${String(summary)}`);
      continue;
    }
    const mutant = isObject(scenario) ? scenario["Mutant"] : undefined;
    const ours = typeof summary === "string" ? SUMMARIES[summary] : undefined;
    if (
      !isObject(mutant) ||
      typeof mutant["name"] !== "string" ||
      typeof mutant["file"] !== "string" ||
      typeof entry["diff_path"] !== "string" ||
      typeof entry["log_path"] !== "string" ||
      ours === undefined
    ) {
      throw new Error(`not a cargo-mutants outcomes.json: can't read ${JSON.stringify(scenario)}`);
    }
    const phases = Array.isArray(entry["phase_results"]) ? entry["phase_results"] : [];
    const seconds = phases.reduce(
      (sum: number, phase: unknown) =>
        sum + (isObject(phase) && typeof phase["duration"] === "number" ? phase["duration"] : 0),
      0,
    );
    outcomes.push({
      name: mutant["name"],
      file: mutant["file"],
      summary: ours,
      diffPath: entry["diff_path"],
      logPath: entry["log_path"],
      seconds,
    });
  }
  return outcomes;
}

export type Verdict = Exclude<Summary, "missed"> | "suite" | "missed";

/**
 * The last line of a mutant's log in which nextest says how many tests it ran and skipped, or
 * null for a log with none: what shows a survivor met every test, ignored ones included.
 */
export function nextestSummary(log: string): string | null {
  const lines = log.split("\n").filter((line) => /\bSummary \[.*\btests? run:/.test(line));
  return lines.at(-1)?.trim() ?? null;
}

/** A terminal colour escape, which nextest writes when it thinks its output is a terminal. */
const COLOUR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

/**
 * The tests nextest says failed in a mutant's log, each once, then each panic's place and message:
 * what shows a mutant was caught by a test's assertion rather than by a crash or a timeout.
 */
export function failures(log: string): string[] {
  const lines = log.replace(COLOUR, "").split("\n");
  const failed = lines
    .map((line) => line.trim())
    .filter((line) => /^(?:FAIL|TIMEOUT|SIG[A-Z]+) \[/.test(line))
    .map((line) => line.replace(/^\S+ \[[^\]]*\]\s*(?:\(\s*\d+\/\d+\)\s*)?/, ""));
  const panics = lines.flatMap((line, i) => {
    const at = /panicked at (.*):$/.exec(line.trim());
    return at === null ? [] : [`${at[1]}: ${lines[i + 1]?.trim() ?? ""}`];
  });
  return [...new Set(failed), ...panics];
}

/**
 * The table a run prints: a line per mutant the Rust tests missed, with what nextest said it ran
 * on it; a line per mutant caught, with what failed on it, for those `caught` holds; then the
 * counts.
 */
export function report(
  group: Group,
  outcomes: readonly Outcome[],
  verdicts: Map<string, Verdict>,
  ran: Map<string, string | null> = new Map(),
  caught: Map<string, readonly string[]> = new Map(),
) {
  const counts = new Map<Verdict, number>();
  for (const o of outcomes) {
    const verdict = verdicts.get(o.name) ?? o.summary;
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }
  const lines = outcomes
    .filter((o) => o.summary === "missed")
    .map(
      (o) =>
        `${verdicts.get(o.name) ?? "missed"}\t${o.name}\t${ran.get(o.name) ?? "(no nextest summary)"}`,
    );
  const catches = outcomes.flatMap((o) => {
    const why = caught.get(o.name);
    if (why === undefined) return [];
    const shown = why.length === 0 ? ["(no failing test found)"] : why;
    return [`caught\t${o.name}`, ...shown.map((line) => `\t${line}`)];
  });
  const seconds = outcomes.reduce((sum, o) => sum + o.seconds, 0);
  const each = outcomes.length === 0 ? 0 : seconds / outcomes.length;
  return [
    `holder-mutants: ${group}: ${outcomes.length} mutants, ${each.toFixed(1)} s of build and Rust tests each`,
    ...lines,
    ...catches,
    `holder-mutants: ${group}: ${[...counts].map(([v, n]) => `${v} ${n}`).join(", ")}`,
  ];
}

export interface Args {
  readonly group: Group;
  readonly shard?: string;
  /** Of the group's mutants, only those whose name this matches. */
  readonly only?: RegExp;
  readonly jobs: number;
}

export function parseArgs(args: readonly string[]): Args {
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  const group = value("--group");
  const shard = value("--shard");
  const only = value("--only");
  const jobs = Number(value("--jobs") ?? "2");
  if (group === undefined || !isGroup(group)) {
    throw new Error(
      `usage: holder-mutants --group <${Object.keys(GROUPS).join("|")}> [--shard k/n] ` +
        "[--only <regex>] [--jobs n]",
    );
  }
  if (shard !== undefined && !/^\d+\/\d+$/.test(shard))
    throw new Error(`--shard takes k/n, not ${shard}`);
  if (args.includes("--only") && (only === undefined || only === ""))
    throw new Error("--only takes a regex of mutant names");
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs takes a count, not ${jobs}`);
  return {
    group,
    ...(shard === undefined ? {} : { shard }),
    ...(only === undefined ? {} : { only: new RegExp(only) }),
    jobs,
  };
}

/** `text` as a regex, in the syntax of the Rust regex crate, that matches it and nothing else. */
export function rustLiteral(text: string): string {
  return text.replace(/[\\.+*?()|[\]{}^$#&~-]/g, "\\$&");
}

/**
 * `filters` narrowed to the mutants `names`: whatever `--file` and `--re` they had are replaced by
 * the names' files and one regex matching the names whole. cargo-mutants takes a mutant matching
 * any `--re`, so adding one would widen the selection; its `--exclude` and `--exclude-re` still
 * apply after. A struct-field deletion in one of those files is listed whatever `--re` says, which
 * `narrowingFaults` catches.
 */
export function narrowed(filters: readonly string[], names: readonly string[]): string[] {
  const replaced = new Set(["--re", "--file"]);
  const kept = filters.filter(
    (arg, i) => !replaced.has(arg) && !replaced.has(filters[i - 1] ?? ""),
  );
  const files = [...new Set(names.map((name) => name.slice(0, name.indexOf(":"))))];
  return [
    ...kept,
    ...files.flatMap((file) => ["--file", file]),
    "--re",
    `^(?:${names.map(rustLiteral).join("|")})$`,
  ];
}

/** How what narrowed selections list differs from the mutants they were narrowed to, or nothing. */
export function narrowingFaults(named: readonly string[], listed: readonly string[]): string[] {
  const want = new Set(named);
  const got = new Set(listed);
  return [
    ...[...got]
      .filter((name) => !want.has(name))
      .map(
        (name) =>
          `${name} is listed though --only doesn't name it: cargo-mutants lists a struct-field ` +
          "deletion whatever --re says, so name it in --only too",
      ),
    ...[...want].filter((name) => !got.has(name)).map((name) => `${name} is named but not listed`),
  ];
}

const cargoEnv = () => gateEnv(isolatedEnv());

/** The names cargo-mutants lists with `filters`, which only reads the source. */
function listMutants(filters: readonly string[]): string[] {
  const out = spawnSync(
    "cargo",
    ["mutants", "--list", "--json", "--no-config", "-p", CRATE, ...filters],
    { env: cargoEnv(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (out.status !== 0) throw new Error(`cargo mutants --list failed:\n${out.stderr}`);
  const listing: unknown = out.stdout.trim() === "" ? [] : JSON.parse(out.stdout);
  if (!Array.isArray(listing)) throw new Error("not a cargo-mutants listing");
  return listing.map((entry: unknown) => (isObject(entry) ? String(entry["name"]) : ""));
}

/** Runs a command to its end with its output on ours; its exit code. */
function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", fail);
    child.once("exit", (code, signal) => done(code ?? (signal === null ? 1 : 128)));
  });
}

/**
 * Why a run of mutants mustn't start here, or nothing: a test of this script replaces every
 * effect, and a real run under one would mutate the holder and run its signalling tests on
 * whatever machine runs the tests.
 */
export function refusalUnderTest(env: NodeJS.ProcessEnv): string | undefined {
  return env["VITEST"] === undefined
    ? undefined
    : "holder-mutants: refusing to run cargo-mutants or the holder suite under a test";
}

function refuseUnderTest(): void {
  const why = refusalUnderTest(process.env);
  if (why !== undefined) throw new Error(why);
}

/** A cargo-mutants run over one selection: its outcomes, and what it wrote of each. */
export interface MutantRun {
  readonly outcomes: readonly Outcome[];
  /** An outcome's build and test output. */
  readonly log: (outcome: Outcome) => string;
  /** Where an outcome's diff is. */
  readonly diffFile: (outcome: Outcome) => string;
}

/** Runs cargo-mutants over one selection, and the outcomes it wrote. */
async function runCargoMutants(
  filters: readonly string[],
  shard: string | undefined,
  jobs: number,
): Promise<MutantRun> {
  refuseUnderTest();
  const out = mkdtempSync(join(tmpdir(), "bz-holder-mutants-"));
  const args = [
    "mutants",
    "--no-config",
    "-p",
    CRATE,
    "--test-tool",
    "nextest",
    "--jobs",
    String(jobs),
    "--output",
    out,
    ...(shard === undefined ? [] : ["--shard", shard]),
    ...filters,
    "--",
    "--run-ignored",
    "all",
  ];
  // cargo-mutants exits 2 when it missed mutants and 3 on timeouts: outcomes.json says which.
  const code = await run("cargo", args, cargoEnv());
  if (code !== 0 && code !== 2 && code !== 3) throw new Error(`cargo mutants exited ${code}`);
  const dir = join(out, "mutants.out");
  const json: unknown = JSON.parse(readFileSync(join(dir, "outcomes.json"), "utf8"));
  return {
    outcomes: parseOutcomes(json),
    log: (o) => readFileSync(join(dir, o.logPath), "utf8"),
    diffFile: (o) => join(dir, o.diffPath),
  };
}

/**
 * Applies the mutant whose diff is at `diffFile` to `file` in the working tree, runs the holder
 * suite, and puts the file back as it was. Null when the patch left the file unchanged.
 */
async function judgeBySuite(file: string, diffFile: string): Promise<boolean | null> {
  refuseUnderTest();
  const original = readFileSync(file, "utf8");
  const patch = patchOf(file, readFileSync(diffFile, "utf8"));
  if (patch === null) throw new Error(`${diffFile} is not a cargo-mutants diff`);
  const scratch = mkdtempSync(join(tmpdir(), "bz-holder-mutant-"));
  try {
    writeFileSync(join(scratch, "mutant.patch"), patch);
    spawnSync("git", ["apply", join(scratch, "mutant.patch")], { env: isolatedEnv() });
    if (readFileSync(file, "utf8") === original) return null;
    return (await run("pnpm", ["test:holder"], isolatedEnv())) !== 0;
  } finally {
    writeFileSync(file, original);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Everything `main` reaches outside itself. A test passes its own, so nothing a test calls can
 * build a mutant or start a holder; there is no default.
 */
export interface Effects {
  readonly sandboxed: () => boolean;
  readonly list: (filters: readonly string[]) => string[];
  readonly platform: NodeJS.Platform;
  /** The classified equivalents the run checks `all` against: the groups leave these out. */
  readonly equivalents: readonly Equivalent[];
  /** The lines of a source file, by its path in the workspace. */
  readonly source: (file: string) => readonly string[];
  readonly mutate: (
    filters: readonly string[],
    shard: string | undefined,
    jobs: number,
  ) => Promise<MutantRun>;
  /** Whether the holder suite fails on a mutant, null when its diff leaves the file unchanged. */
  readonly judge: (file: string, diffFile: string) => Promise<boolean | null>;
}

const REAL: Effects = {
  sandboxed: inSignalSandbox,
  list: listMutants,
  platform: process.platform,
  equivalents: EQUIVALENTS,
  source: (file) => readFileSync(file, "utf8").split("\n"),
  mutate: runCargoMutants,
  judge: judgeBySuite,
};

/**
 * The cargo-mutants selections a run makes: the group's, or, with `only`, each narrowed to the
 * mutants of it whose names `only` matches, leaving out any that matches none.
 */
export function selections(
  group: Group,
  only: RegExp | undefined,
  list: (filters: readonly string[]) => string[],
): string[][] {
  if (only === undefined) return groupFilters(group);
  return groupFilters(group).flatMap((filters) => {
    const names = list(filters).filter((name) => only.test(name));
    return names.length === 0 ? [] : [narrowed(filters, names)];
  });
}

export async function main(
  args: readonly string[],
  { sandboxed, list, platform, equivalents, source, mutate, judge }: Effects,
): Promise<number> {
  if (!sandboxed()) {
    console.error(
      "holder-mutants: refusing to run here. A mutant of the holder can signal any pid it " +
        "computes, so this runs only in the test container (pnpm test:real mutants) or on a CI " +
        `runner carrying a root-owned ${DISPOSABLE_HOST_MARKER}.`,
    );
    return 1;
  }
  const { group, shard, only, jobs } = parseArgs(args);
  const compiledOn = GROUPS[group].platform;
  if (compiledOn !== undefined && compiledOn !== platform) {
    console.error(
      `holder-mutants: the ${group} group's code is compiled only on ${compiledOn}, so here ` +
        "every mutant of it would read as missed.",
    );
    return 1;
  }
  const listed = (g: Group) => groupFilters(g).flatMap(list);
  const all = list([]);
  const moved = equivalentFaults(all, equivalents, source);
  if (moved.length > 0) {
    console.error(
      `holder-mutants: the classified equivalents no longer name what was classified:\n${moved.join("\n")}`,
    );
    return 1;
  }
  const faults = partitionFaults(withoutEquivalents(all, equivalents), {
    signal: listed("signal"),
    lifecycle: listed("lifecycle"),
    rest: listed("rest"),
    macos: listed("macos"),
  });
  if (faults.length > 0) {
    console.error(`holder-mutants: the groups don't partition the mutants:\n${faults.join("\n")}`);
    return 1;
  }
  const chosen = selections(group, only, list);
  if (chosen.length === 0) {
    console.error(`holder-mutants: --only ${String(only)} names no mutant of ${group}`);
    return 1;
  }
  if (only !== undefined) {
    const named = groupFilters(group)
      .flatMap(list)
      .filter((name) => only.test(name));
    const wrong = narrowingFaults(named, chosen.flatMap(list));
    if (wrong.length > 0) {
      console.error(`holder-mutants: --only selects other than it names:\n${wrong.join("\n")}`);
      return 1;
    }
  }
  const outcomes: Outcome[] = [];
  const verdicts = new Map<string, Verdict>();
  const ran = new Map<string, string | null>();
  const caught = new Map<string, readonly string[]>();
  for (const filters of chosen) {
    const { outcomes: these, log, diffFile } = await mutate(filters, shard, jobs);
    outcomes.push(...these);
    if (only !== undefined) {
      for (const o of these.filter((m) => m.summary === "caught")) {
        caught.set(o.name, failures(log(o)));
      }
    }
    for (const o of these.filter((m) => m.summary === "missed")) {
      ran.set(o.name, nextestSummary(log(o)));
      const failed = await judge(o.file, diffFile(o));
      if (failed === null) throw new Error(`holder-mutants: ${o.name} didn't apply`);
      verdicts.set(o.name, failed ? "suite" : "missed");
    }
  }
  for (const line of report(group, outcomes, verdicts, ran, caught)) console.log(line);
  return 0;
}

if (isMain(import.meta)) process.exitCode = await main(process.argv.slice(2), REAL);
