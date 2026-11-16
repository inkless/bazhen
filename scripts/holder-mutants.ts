// Runs cargo-mutants over the holder crate, one group of its code at a time, and judges each
// mutant its Rust tests miss again with the holder suite, the black-box contract the daemon
// relies on (docs/standards/testing.md § Falsification). It reports each mutant as:
//   caught     a Rust test failed
//   suite      no Rust test failed, but the holder suite did
//   missed     neither did: a gap in the tests, or a mutant that changes nothing
//   unviable   it didn't build
//   timeout    the Rust tests ran out of time on it
// It is a tool, not a check: a count of survivors is no gate (testing.md). Its table is for
// someone to read, class each survivor and write the test that kills it.
//
// A mutant of the holder can send a signal to any pid the mutated code computes, so this refuses
// to start, before it lists or builds anything, anywhere but a sandbox: the `pnpm test:real`
// container or a marked CI runner (scripts/signal-paths.ts). In the container the tree is the
// image's own copy, so a mutant applied in place is undone with the container at the latest.
//
// Usage: node scripts/holder-mutants.ts --group <signal|lifecycle|rest> [--shard k/n] [--jobs n]

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
/** The files whose lifecycle functions `LIFECYCLE_NAME` picks out. */
const LIFECYCLE_NAME_FILES = ["server.rs", "conn.rs"];

interface GroupSpec {
  readonly files: readonly string[];
  readonly excludeFiles: readonly string[];
  readonly excludeRe: readonly string[];
  /** Mutants it also takes, by name, wherever they are. */
  readonly also?: string;
}

/** The groups, most valuable first: each is one container run's worth. */
export const GROUPS: Readonly<Record<"signal" | "lifecycle" | "rest", GroupSpec>> = {
  /** Code that sends signals, or decides what they reach. */
  signal: { files: SIGNAL_FILES, excludeFiles: [], excludeRe: [] },
  /** Binding and rebinding the socket, and the close and drop paths of the server. */
  lifecycle: { files: LIFECYCLE_FILES, excludeFiles: [], excludeRe: [], also: LIFECYCLE_NAME },
  rest: {
    files: [],
    excludeFiles: [...SIGNAL_FILES, ...LIFECYCLE_FILES],
    excludeRe: [LIFECYCLE_NAME],
  },
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
  const base = [
    ...spec.files.flatMap((f) => ["--file", `${SRC}/${f}`]),
    ...spec.excludeFiles.flatMap((f) => ["--exclude", `${SRC}/${f}`]),
    ...spec.excludeRe.flatMap((re) => ["--exclude-re", re]),
  ];
  if (spec.also === undefined) return [base];
  const byName = [
    ...LIFECYCLE_NAME_FILES.flatMap((f) => ["--file", `${SRC}/${f}`]),
    "--re",
    spec.also,
  ];
  return [base, byName];
}

/** Which group a mutant, by its cargo-mutants name, belongs to. */
export function groupOf(name: string): Group {
  const file = /^crates\/[^/]+\/src\/([^:]+):/.exec(name)?.[1] ?? "";
  if ((SIGNAL_FILES as readonly string[]).includes(file)) return "signal";
  if ((LIFECYCLE_FILES as readonly string[]).includes(file)) return "lifecycle";
  return new RegExp(LIFECYCLE_NAME).test(name) ? "lifecycle" : "rest";
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

/**
 * The table a run prints: a line per mutant the Rust tests missed, with what nextest said it ran
 * on it, then the counts.
 */
export function report(
  group: Group,
  outcomes: readonly Outcome[],
  verdicts: Map<string, Verdict>,
  ran: Map<string, string | null> = new Map(),
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
  const seconds = outcomes.reduce((sum, o) => sum + o.seconds, 0);
  const each = outcomes.length === 0 ? 0 : seconds / outcomes.length;
  return [
    `holder-mutants: ${group}: ${outcomes.length} mutants, ${each.toFixed(1)} s of build and Rust tests each`,
    ...lines,
    `holder-mutants: ${group}: ${[...counts].map(([v, n]) => `${v} ${n}`).join(", ")}`,
  ];
}

export function parseArgs(args: readonly string[]): { group: Group; shard?: string; jobs: number } {
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  const group = value("--group");
  const shard = value("--shard");
  const jobs = Number(value("--jobs") ?? "2");
  if (group === undefined || !isGroup(group)) {
    throw new Error(
      `usage: holder-mutants --group <${Object.keys(GROUPS).join("|")}> [--shard k/n] [--jobs n]`,
    );
  }
  if (shard !== undefined && !/^\d+\/\d+$/.test(shard))
    throw new Error(`--shard takes k/n, not ${shard}`);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs takes a count, not ${jobs}`);
  return { group, ...(shard === undefined ? {} : { shard }), jobs };
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

/** Runs cargo-mutants over one selection into `out`, and the outcomes it wrote. */
async function mutate(
  filters: readonly string[],
  out: string,
  shard: string | undefined,
  jobs: number,
) {
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
  const json: unknown = JSON.parse(readFileSync(join(out, "mutants.out", "outcomes.json"), "utf8"));
  return { outcomes: parseOutcomes(json), dir: join(out, "mutants.out") };
}

/**
 * Applies the mutant whose diff is at `diffFile` to `file` in the working tree, runs the holder
 * suite, and puts the file back as it was. Null when the patch left the file unchanged.
 */
async function judgeBySuite(file: string, diffFile: string): Promise<boolean | null> {
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

/** What `main` reaches outside itself before it mutates anything, which a test replaces. */
export interface Effects {
  readonly sandboxed: () => boolean;
  readonly list: (filters: readonly string[]) => string[];
}

export async function main(
  args: readonly string[],
  { sandboxed, list }: Effects = { sandboxed: inSignalSandbox, list: listMutants },
): Promise<number> {
  if (!sandboxed()) {
    console.error(
      "holder-mutants: refusing to run here. A mutant of the holder can signal any pid it " +
        "computes, so this runs only in the test container (pnpm test:real mutants) or on a CI " +
        `runner carrying a root-owned ${DISPOSABLE_HOST_MARKER}.`,
    );
    return 1;
  }
  const { group, shard, jobs } = parseArgs(args);
  const listed = (g: Group) => groupFilters(g).flatMap(list);
  const faults = partitionFaults(list([]), {
    signal: listed("signal"),
    lifecycle: listed("lifecycle"),
    rest: listed("rest"),
  });
  if (faults.length > 0) {
    console.error(`holder-mutants: the groups don't partition the mutants:\n${faults.join("\n")}`);
    return 1;
  }
  const out = mkdtempSync(join(tmpdir(), "bz-holder-mutants-"));
  const outcomes: Outcome[] = [];
  const verdicts = new Map<string, Verdict>();
  const ran = new Map<string, string | null>();
  for (const [i, filters] of groupFilters(group).entries()) {
    const { outcomes: these, dir } = await mutate(filters, join(out, String(i)), shard, jobs);
    outcomes.push(...these);
    for (const o of these.filter((m) => m.summary === "missed")) {
      ran.set(o.name, nextestSummary(readFileSync(join(dir, o.logPath), "utf8")));
      const failed = await judgeBySuite(o.file, join(dir, o.diffPath));
      if (failed === null) throw new Error(`holder-mutants: ${o.name} didn't apply`);
      verdicts.set(o.name, failed ? "suite" : "missed");
    }
  }
  for (const line of report(group, outcomes, verdicts, ran)) console.log(line);
  return 0;
}

if (isMain(import.meta)) process.exitCode = await main(process.argv.slice(2));
