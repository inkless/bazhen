// `make test-real ARGS='[suite…] [--base <ref>] [--group <g> [--shard k/n] [--only <regex>]]'`:
// the real-tmux suites, the holder's mutants by group (scripts/holder-mutants.ts), and the soak's
// short runs (scripts/soak.ts), in a container built from this worktree
// (docs/standards/testing.md). The build context is a fresh repository holding HEAD and falsify's
// base, overlaid with the worktree's uncommitted files, so falsify judges commits and the other
// suites test what is on disk. Each suite gets a container of its own, with nothing of the host's:
// no mount, no socket, no network.
//
// A run removes its containers, image and context on every exit it can observe, a signal
// included: docker runs asynchronously in a process group of its own, and a signal is forwarded
// to it, as a SIGINT, rather than ending this process mid-step; a second signal abandons the
// cleanup. What a run killed outright or abandoned left is removed by the next run's sweep, which
// goes by the owner pid and host each run's names and labels carry.

import { execFileSync, type ChildProcess } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { availableParallelism, constants, hostname, tmpdir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { SLICE, inSignalSandbox, isAlive, signalGroup, spawnGroup } from "@bazhen/host-guard";
import { RUST_TOOLS } from "./rust-gate.ts";
import { isMain } from "./is-main.ts";

const SUITES = {
  integration: "test-integration",
  api: "test-api",
  "api-rust": "test-api-rust",
  e2e: "test-e2e",
  falsify: "test-falsify",
  rust: "test-rust-all",
  holder: "test-holder",
  mutants: "test-mutants-holder",
  soak: "test-soak",
} as const;
type Suite = keyof typeof SUITES;
const DEFAULT_SUITES: Suite[] = ["integration", "api", "e2e", "holder", "rust"];
const DEFAULT_BASE = "origin/main";
/** What falsify's base is called inside the image, whatever it was called here. */
const BASE_REF = "refs/remotes/origin/main";

const isSuite = (name: string): name is Suite => Object.hasOwn(SUITES, name);
/** Every suite test-real can run. */
export const SUITE_NAMES: readonly Suite[] = Object.keys(SUITES).filter(isSuite);
const USAGE =
  `usage: make test-real ARGS='[${SUITE_NAMES.join("|")}]… [--base <ref>] ` +
  "[--group <g> [--shard k/n] [--only <regex>]]'";

/**
 * The groups of the holder's mutants, as scripts/holder-mutants.ts names them, whose code the
 * container's Linux compiles.
 */
export const MUTANT_GROUPS: readonly string[] = ["signal", "lifecycle", "rest"];

/**
 * Which of the holder's mutants the `mutants` suite runs: a group, a shard of it, and of those
 * only the ones a regex names.
 */
export interface MutantsPart {
  readonly group: string;
  readonly shard?: string;
  readonly only?: string;
}

/**
 * What a suite's container runs. Falsify judges against the base the image carries, and then, as
 * CI does, has the base's falsify judge a branch that changes falsify.
 */
export function suiteCommand(suite: Suite, mutants?: MutantsPart): string[] {
  if (suite === "mutants") {
    if (mutants === undefined) throw new Error(`the mutants suite needs --group; ${USAGE}`);
    const shard = mutants.shard === undefined ? [] : ["--shard", mutants.shard];
    const only = mutants.only === undefined ? [] : ["--only", mutants.only];
    return makeRun(SUITES.mutants, "--group", mutants.group, ...shard, ...only);
  }
  if (suite !== "falsify") return makeRun(SUITES[suite]);
  const base = `ARGS='--base ${BASE_REF}'`;
  return ["sh", "-c", `make ${SUITES.falsify} ${base} && make test-falsify-base ${base}`];
}

/** A word as a shell reads it back: as it is when plain, else in single quotes. */
export const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** `make` of a target, with the arguments its command takes in ARGS, which its shell reads back. */
const makeRun = (target: string, ...args: string[]): string[] => [
  "make",
  target,
  ...(args.length === 0 ? [] : [`ARGS=${args.map(shellWord).join(" ")}`]),
];

/** Why `text` isn't a JavaScript regex, as holder-mutants reads `--only`, or nothing. */
function regexError(text: string): string | undefined {
  try {
    return new RegExp(text).source === "(?:)" ? "it is empty" : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const OPTIONS = ["--base", "--group", "--shard", "--only"] as const;

/**
 * The suites named on the command line, in order, or the default set; falsify's base; and, for
 * the mutants suite, its group, shard and narrowing, which it needs and nothing else takes.
 */
export function parseArgs(args: readonly string[]): {
  suites: Suite[];
  base: string;
  mutants?: MutantsPart;
} {
  const values = new Map<string, string | undefined>();
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!(OPTIONS as readonly string[]).includes(arg)) {
      names.push(arg);
      continue;
    }
    const value = args[i + 1];
    values.set(arg, value === undefined || value.startsWith("-") ? undefined : value);
    i++;
  }
  const unknown = names.filter((a) => !isSuite(a));
  if (unknown.length > 0) throw new Error(`unknown suite ${unknown.join(", ")}; ${USAGE}`);
  if ([...values.values()].includes(undefined)) throw new Error(USAGE);
  const base = values.get("--base") ?? DEFAULT_BASE;
  const group = values.get("--group");
  const shard = values.get("--shard");
  const only = values.get("--only");
  const suites = names.length === 0 ? DEFAULT_SUITES : [...new Set(names.filter(isSuite))];
  if (
    (group !== undefined) !== suites.includes("mutants") ||
    ((shard !== undefined || only !== undefined) && group === undefined)
  ) {
    throw new Error(
      `--group, --shard and --only go with the mutants suite, which needs a group; ${USAGE}`,
    );
  }
  if (group === undefined) return { suites, base };
  // Refused here, before an image is built for a run that would refuse it.
  if (!MUTANT_GROUPS.includes(group)) {
    throw new Error(`no mutant group ${group}; it is one of ${MUTANT_GROUPS.join(", ")}`);
  }
  const unreadable = only === undefined ? undefined : regexError(only);
  if (unreadable !== undefined) throw new Error(`--only takes a regex: ${unreadable}`);
  return {
    suites,
    base,
    mutants: {
      group,
      ...(shard === undefined ? {} : { shard }),
      ...(only === undefined ? {} : { only }),
    },
  };
}

/** The image's build arguments: the repository's own pins, and the Rust tools falsify runs. */
export function pins(read: (path: string) => string): Record<string, string> {
  const pkg = (path: string): Record<string, unknown> => JSON.parse(read(path));
  const manager = String(pkg("package.json")["packageManager"]);
  const e2eDeps = pkg("tests/e2e/package.json")["devDependencies"];
  const playwright =
    typeof e2eDeps === "object" && e2eDeps !== null
      ? Reflect.get(e2eDeps, "@playwright/test")
      : undefined;
  if (!manager.startsWith("pnpm@") || typeof playwright !== "string") {
    throw new Error("package.json's packageManager or tests/e2e's @playwright/test is not pinned");
  }
  return {
    NODE_VERSION: read(".nvmrc").trim(),
    PNPM_VERSION: manager.slice("pnpm@".length),
    PLAYWRIGHT_VERSION: playwright,
    NEXTEST_VERSION: RUST_TOOLS["cargo-nextest"],
    CARGO_MUTANTS_VERSION: RUST_TOOLS["cargo-mutants"],
  };
}

/**
 * The CPUs a suite's container may use: half the machine, `BZ_TEST_CPUS` when set. A suite that
 * starts one busy process per core would otherwise take every core from the agents working on the
 * same machine, so the quota is what keeps a test run a guest rather than the owner.
 */
export function cpuBudget(
  env: Readonly<Record<string, string | undefined>>,
  cores: number,
): string {
  const override = env["BZ_TEST_CPUS"];
  if (override !== undefined && override !== "") {
    const value = Number(override);
    if (!Number.isFinite(value) || value < 0.1) {
      throw new Error(`BZ_TEST_CPUS must be a number of CPUs, at least 0.1, got "${override}"`);
    }
    return String(value);
  }
  return String(Math.max(2, Math.floor(cores / 2)));
}

/**
 * The memory a suite's container may use, in bytes, swap included, `BZ_TEST_MEMORY` (in GiB) when
 * set. A test that runs away is then OOM-killed inside its container, never by the machine's own
 * OOM killer, which may pick any process on it. In the slice every capped run shares, whose cap
 * holds all the containers together, a container may have half the machine, as with its CPUs.
 * A run goes outside it only on a disposable host, where nothing else shares the machine, and
 * each container gets a quarter there.
 */
export function memoryBudget(
  env: Readonly<Record<string, string | undefined>>,
  total: number,
  inSlice: boolean,
): string {
  const override = env["BZ_TEST_MEMORY"];
  if (override !== undefined && override !== "") {
    const gib = Number(override);
    if (!Number.isFinite(gib) || gib < 1) {
      throw new Error(`BZ_TEST_MEMORY must be a number of GiB, at least 1, got "${override}"`);
    }
    return String(Math.floor(gib * 1024 ** 3));
  }
  return String(Math.floor(total / (inSlice ? 2 : 4)));
}

/** Where a run's containers go: the flag that puts them in the slice, or why they can't go there. */
export type Placement = { readonly parent: string[] } | { readonly why: string };

/**
 * Whether a run's containers can join the slice every capped run shares, so their memory counts
 * against its cap with every other test's. A probe container started with the flag decides, and
 * is tried twice, so a host under load alone doesn't keep a run out. It must land in this user's
 * own slice, under the user's systemd, and the slice must have a cap: rootful Docker makes a
 * system slice of the same name, and a run not started through scripts/capped.ts may find the
 * slice uncapped.
 */
export async function sliceParent(
  host: Host,
  quiet: Quiet,
  probe: { image: string; names: readonly string[]; labels: readonly string[] },
  interrupted: () => boolean = () => false,
): Promise<Placement> {
  const ours = `/user@${process.getuid?.() ?? -1}.service/bazhen.slice/${SLICE}`;
  let why = `a probe container wouldn't start in ${SLICE}`;
  for (const name of probe.names) {
    if (interrupted()) break;
    const started = await quiet([
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      ...probe.labels,
      "--network",
      "none",
      "--cgroup-parent",
      SLICE,
      "--entrypoint",
      "sleep",
      probe.image,
      // `--rm` removes it once stopped, or once it ends by itself, should this run be killed.
      "60",
    ]);
    if (started.code !== 0) continue;
    let placement: Placement | undefined;
    try {
      const inspected = await quiet(["inspect", "--format", "{{.State.Pid}} {{.Id}}", name]);
      // Read while the probe runs: once it is stopped and reaped, its /proc entry is gone.
      placement = landing(host, inspected.out, ours);
    } finally {
      await quiet(["stop", "--time", "0", name]);
    }
    if (placement !== undefined) return placement;
    why = "a probe container's cgroup couldn't be read";
  }
  return { why };
}

/**
 * Where a probe landed, from its `inspect` pid and id, or undefined where its cgroup can't be read.
 * The pid is the runtime's, and in a pid namespace of the runtime's own it can name one of this
 * host's processes, even one in the slice, so the cgroup must also be the container's own.
 */
function landing(host: Host, inspected: string, ours: string): Placement | undefined {
  const [pidText = "", id = ""] = inspected.trim().split(/\s+/);
  const pid = Number(pidText);
  const cgroup = pid > 1 && /^[0-9a-f]{64}$/.test(id) ? host.cgroupOf(pid) : undefined;
  if (cgroup === undefined) return undefined;
  if (!cgroup.includes(id)) {
    return { why: `the probe's pid ${pid} names a process in ${cgroup}, not the probe` };
  }
  const at = cgroup.indexOf(`${ours}/`);
  if (at < 0) return { why: `a container lands in ${cgroup}, not ${ours}` };
  // The slice itself, however deep a runtime puts its containers below it.
  const cap = host.memoryMax(cgroup.slice(0, at + ours.length));
  // A cap of the whole machine holds nothing together.
  return cap === undefined || cap >= host.totalMemory
    ? { why: `${SLICE} has no memory cap` }
    : { parent: ["--cgroup-parent", SLICE] };
}

/** A cgroup's `memory.max` in bytes, or undefined where it is unset (`max`) or can't be read. */
export function readMemoryMax(cgroup: string, root = "/sys/fs/cgroup"): number | undefined {
  try {
    const max = Number(readFileSync(`${root}${cgroup}/memory.max`, "utf8").trim());
    return Number.isSafeInteger(max) && max > 0 ? max : undefined;
  } catch {
    return undefined;
  }
}

const SECRET_NAME =
  /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519).*|\.npmrc|\.netrc)$/i;
const SECRET_WORD = /credential|secret/i;

/** Whether a file HEAD doesn't have looks like a secret, which never goes into an image. */
export function looksSecret(path: string): boolean {
  const name = basename(path);
  return SECRET_NAME.test(name) || SECRET_WORD.test(name);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const gitList = (top: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: top, encoding: "utf8" }).split("\0").filter(Boolean);

/** Whether `file`'s directory, its symlinks resolved, lies within `top`. */
export function isInside(top: string, file: string): boolean {
  const rel = relative(realpathSync(top), realpathSync(dirname(join(top, file))));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** How the worktree at `top` differs from HEAD, as files to copy over HEAD and files to remove. */
export interface Overlay {
  readonly copy: string[];
  readonly remove: string[];
  /** New files that look like secrets, left out. */
  readonly skipped: string[];
}

/**
 * The worktree's difference from HEAD, staged or not: what `git diff HEAD` names, a rename as a
 * removal and an addition, plus the untracked files. A file HEAD lacks is left out when it looks
 * like a secret. A file whose directory resolves outside `top` throws: nothing outside the
 * repository goes into an image.
 */
export function overlay(top: string): Overlay {
  const copy: string[] = [];
  const remove: string[] = [];
  const skipped: string[] = [];
  const add = (file: string, isNew: boolean) => {
    if (isNew && looksSecret(file)) skipped.push(file);
    else if (isInside(top, file)) copy.push(file);
    else throw new Error(`${file} lies outside the repository, through a symlink`);
  };
  const changes = gitList(top, "diff", "-z", "--name-status", "--no-renames", "HEAD", "--");
  for (let i = 0; i + 1 < changes.length; i += 2) {
    const file = changes[i + 1] ?? "";
    if (changes[i] === "D") remove.push(file);
    else add(file, changes[i] === "A");
  }
  // A file whose deletion is staged and which was then recreated is listed here too, so is
  // copied after its removal.
  for (const file of gitList(top, "ls-files", "-z", "--others", "--exclude-standard")) {
    add(file, true);
  }
  return { copy: [...new Set(copy)], remove, skipped };
}

const REPOSITORY = "bazhen-test-real";
const LABEL = "org.bazhen.test-real";
const OWNER_LABEL = `${LABEL}.owner-pid`;
/** Which machine's pids the owner label counts in: a pid means nothing on another host. */
const HOST_LABEL = `${LABEL}.host`;
const RUN_NAME = /^bz-real-(\d+)-[\w.-]+$/;
/** How long docker gets to stop after a forwarded signal before its group is killed. */
const STOP_GRACE_MS = 10_000;
/** How long a sweep or cleanup command may take: a wedged daemon must not hold the run. */
const QUIET_TIMEOUT_MS = 30_000;

/** A run's name, `bz-real-<owner pid>-<random>`: its context dir, image tag and containers. */
const runPrefix = (pid: number) => `bz-real-${pid}-`;

/** The pid of the run a context dir or image tag belongs to. */
export function ownerOf(name: string): number | undefined {
  const pid = Number(RUN_NAME.exec(name)?.[1]);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/** A dir named by `prefix` holding HEAD and `base` with the worktree at `top` checked out on it. */
export function buildContext(top: string, base: string, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    fillContext(dir, top, base);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function fillContext(dir: string, top: string, base: string): void {
  git(dir, "init", "--quiet");
  git(
    dir,
    "fetch",
    "--quiet",
    top,
    "+HEAD:refs/heads/work",
    `+${git(top, "rev-parse", base)}:${BASE_REF}`,
  );
  git(dir, "checkout", "--quiet", "work");
  const { copy, remove, skipped } = overlay(top);
  for (const file of remove) rmSync(join(dir, file), { force: true });
  for (const file of copy) copyEntry(join(top, file), join(dir, file));
  if (skipped.length > 0) console.warn(`test-real: left out of the image: ${skipped.join(", ")}`);
}

/** Copies a file, or a symlink as the same link, never what it points at. */
function copyEntry(from: string, to: string): void {
  if (!lstatSync(from).isSymbolicLink()) {
    cpSync(from, to, { force: true });
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  // A link may replace a directory HEAD has.
  rmSync(to, { recursive: true, force: true });
  symlinkSync(readlinkSync(from), to);
}

export interface DockerResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** One docker command in flight. */
export interface DockerCall {
  readonly done: Promise<DockerResult>;
  /** Passes a signal on to the command, which then gets a grace period to stop. */
  stop(signal: NodeJS.Signals): void;
}

/** Starts docker with `args`; a quiet call captures its output instead of printing it. */
export type Docker = (args: readonly string[], quiet?: boolean) => DockerCall;

/** Everything a run does to the host, so a test can stand in for it. */
export interface Host {
  readonly pid: number;
  /** This machine, as the host label records it. */
  readonly id: string;
  readonly docker: Docker;
  /** Creates this run's build context, a dir named by `runPrefix`, and its build arguments. */
  prepare(base: string, prefix: string): { dir: string; buildArgs: Record<string, string> };
  removeDir(dir: string): void;
  /** Every run's context dir on this host, by path. */
  runDirs(): string[];
  isAlive(pid: number): boolean;
  /** Subscribes to SIGINT, SIGTERM and SIGHUP in place of their default exit; returns the undo. */
  onSignal(handler: (signal: NodeJS.Signals) => void): () => void;
  /** Settles after `ms`, without keeping the process alive. */
  after(ms: number): Promise<void>;
  /**
   * Whether this host exists to be thrown away, a CI runner: no other run shares its memory, so
   * containers may run outside the shared slice there, and nowhere else.
   */
  readonly disposable: boolean;
  /** This machine's memory, in bytes. */
  readonly totalMemory: number;
  /** The cgroup a process on this host is in, from its `/proc/<pid>/cgroup`. */
  cgroupOf(pid: number): string | undefined;
  /** A cgroup's `memory.max` in bytes, or undefined where it is unset or can't be read. */
  memoryMax(cgroup: string): number | undefined;
}

/** Runs one quiet docker command to its end, or its timeout. */
export type Quiet = (args: readonly string[]) => Promise<DockerResult>;

const failed = (err: string): DockerResult => ({ code: null, out: "", err });

/** A quiet call's result, or a failure once `QUIET_TIMEOUT_MS` passes, the call then stopped. */
async function withTimeout(host: Host, call: DockerCall, args: readonly string[]) {
  const timedOut = host.after(QUIET_TIMEOUT_MS).then(() => undefined);
  const result = await Promise.race([call.done, timedOut]);
  if (result !== undefined) return result;
  call.stop("SIGTERM");
  return failed(`docker ${args.slice(0, 2).join(" ")} timed out`);
}

/** Quiet commands, each bounded by `QUIET_TIMEOUT_MS`. */
export const bounded =
  (host: Host): Quiet =>
  (args) =>
    withTimeout(host, host.docker(args, true), args);

/** The lines a quiet docker command printed, or none when it failed. */
async function lines(quiet: Quiet, args: readonly string[]): Promise<string[]> {
  const { code, out } = await quiet(args);
  return code === 0 ? out.split("\n").filter(Boolean) : [];
}

/** What podman-docker's `docker` prints on every call, unless the host opted out. */
const SHIM_NOTICE = /^Emulate Docker CLI using podman\./;

/** What a command said went wrong. */
const errors = (err: string) =>
  err.split("\n").filter((line) => line !== "" && !SHIM_NOTICE.test(line));

/** Whether a removal failed only because there was nothing left to remove. */
const gone = ({ code, err }: DockerResult) =>
  code === 0 ||
  // Docker says "No such image"; Podman, "image not known".
  (code !== null && errors(err).every((line) => /no such|not known/i.test(line)));

/** A ref to an image of this repository, as Docker lists it or as Podman does, under localhost/. */
const OUR_IMAGE = new RegExp(`^(localhost/)?${REPOSITORY}:`);

/** Container states in which a container has stopped, in Docker's words and in Podman's. */
const STOPPED = new Set(["created", "configured", "exited", "stopped", "dead"]);

/** The owner pid and host a container or image is labelled with, as the labels read. */
async function ownerLabels(quiet: Quiet, kind: "container" | "image", ref: string) {
  const [labels = ""] = await lines(quiet, [
    kind,
    "inspect",
    "--format",
    `{{index .Config.Labels "${OWNER_LABEL}"}}\t{{index .Config.Labels "${HOST_LABEL}"}}`,
    ref,
  ]);
  const [owner, id] = labels.split("\t");
  return { owner: Number(owner), id };
}

/**
 * Removes what runs on this host that died without cleaning up left behind: their stopped
 * containers, then each image of this repository labelled by this script whose owner is gone and
 * which no container uses, then their context dirs. A pid that was reused reads as alive, so the
 * sweep can only keep a dead run's leftovers longer, never take a live run's. Nothing is forced.
 */
export async function sweep(host: Host, quiet: Quiet = bounded(host)): Promise<void> {
  const dead = (pid: number | undefined) =>
    pid !== undefined && pid > 1 && pid !== host.pid && !host.isAlive(pid);
  const ours = ["--filter", `label=${OWNER_LABEL}`, "--filter", `label=${HOST_LABEL}=${host.id}`];
  // Labels and states are read with templates and filters both Docker and Podman know: Podman
  // refuses `status=dead` and the `.Label` function, and an error here would read as no output.
  const containers = await lines(quiet, [
    "ps",
    "--all",
    ...ours,
    "--format",
    "{{.Names}}\t{{.State}}",
  ]);
  for (const line of containers) {
    const [name = "", state = ""] = line.split("\t");
    if (!RUN_NAME.test(name) || !STOPPED.has(state)) continue;
    const { owner, id } = await ownerLabels(quiet, "container", name);
    if (id === host.id && dead(owner)) await quiet(["rm", name]);
  }
  const refs = await lines(quiet, [
    "image",
    "ls",
    "--filter",
    `reference=${REPOSITORY}`,
    ...ours,
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);
  for (const ref of refs.filter((r) => OUR_IMAGE.test(r))) {
    const { owner, id } = await ownerLabels(quiet, "image", ref);
    if (id !== host.id || !dead(owner)) continue;
    const users = await lines(quiet, ["ps", "--all", "--quiet", "--filter", `ancestor=${ref}`]);
    if (users.length > 0) continue;
    const removed = await quiet(["image", "rm", ref]);
    console.warn(
      removed.code === 0
        ? `test-real: removed ${ref}, left by a run that is gone`
        : `test-real: kept ${ref}: ${errors(removed.err).join("; ")}`,
    );
  }
  for (const dir of host.runDirs()) {
    if (dead(ownerOf(basename(dir)))) host.removeDir(dir);
  }
}

const exitCodeFor = (signal: NodeJS.Signals) => 128 + constants.signals[signal];

/**
 * Runs the suites in `args`; the exit code, 128 + the signal's number once one arrived. The first
 * signal stops the command in flight with a SIGINT, and the run cleans up; a second abandons the
 * cleanup, so a wedged Docker can't hold the run, and the next run's sweep removes what was left.
 */
export async function run(args: readonly string[], host: Host): Promise<number> {
  const { suites, base, mutants } = parseArgs(args);
  const inFlight = new Set<DockerCall>();
  let interrupted: NodeJS.Signals | undefined;
  const { promise: abandoned, resolve: abandon } = Promise.withResolvers<undefined>();
  let isAbandoned = false;
  // Stays subscribed through cleanup, so a second signal can still cut it short.
  const unsubscribe = host.onSignal((signal) => {
    if (interrupted === undefined) {
      interrupted = signal;
      // A SIGINT, whatever arrived. In a suite's container the init passes it to the whole group
      // of the suite's command, make and capped, and a shell between them where falsify has one.
      // make leaves a SIGINT to its group, and capped passes it on to the suite's own group: so
      // each process of the suite gets it once. make passes a SIGTERM on to its children as well,
      // so a SIGTERM would reach capped twice, a second signal, which vitest and nextest take as
      // one to abandon their cleanup.
      for (const call of inFlight) call.stop("SIGINT");
    } else if (!isAbandoned) {
      isAbandoned = true;
      abandon(undefined);
      for (const call of inFlight) call.stop("SIGKILL");
    }
  });
  const track = async (call: DockerCall, done: Promise<DockerResult>) => {
    inFlight.add(call);
    const result = await Promise.race([done, abandoned]);
    inFlight.delete(call);
    return result ?? failed("abandoned");
  };
  const step = async (dockerArgs: readonly string[]) => {
    if (interrupted !== undefined) return false;
    const call = host.docker(dockerArgs);
    return (await track(call, call.done)).code === 0;
  };
  const quiet: Quiet = async (dockerArgs) => {
    if (isAbandoned) return failed("abandoned");
    const call = host.docker(dockerArgs, true);
    return track(call, withTimeout(host, call, dockerArgs));
  };
  let dir: string | undefined;
  let image: string | undefined;
  const containers: string[] = [];
  let code = 1;
  try {
    code = await (async () => {
      await sweep(host, (a) =>
        interrupted === undefined ? quiet(a) : Promise.resolve(failed("interrupted")),
      );
      if (interrupted !== undefined) return 1;
      const prepared = host.prepare(base, runPrefix(host.pid));
      dir = prepared.dir;
      const name = basename(dir);
      image = `${REPOSITORY}:${name}`;
      const labels = [
        "--label",
        `${LABEL}=1`,
        "--label",
        `${OWNER_LABEL}=${host.pid}`,
        "--label",
        `${HOST_LABEL}=${host.id}`,
      ];
      const built = await step([
        "build",
        "--tag",
        image,
        ...labels,
        ...Object.entries(prepared.buildArgs).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
        "-f",
        join(dir, "tests/real/Dockerfile"),
        dir,
      ]);
      if (!built) return 1;
      const probes = [`${name}-slice-probe-0`, `${name}-slice-probe-1`];
      // A probe whose stop timed out may outlive the run, but for the removal on the way out.
      containers.push(...probes);
      const placement = await sliceParent(
        host,
        quiet,
        { image, names: probes, labels },
        () => interrupted !== undefined,
      );
      if (interrupted !== undefined) return 1;
      const inSlice = "parent" in placement;
      if (!inSlice && !host.disposable) {
        console.error(
          `test-real: ${placement.why}, so its containers would run outside the memory cap ` +
            `every capped run shares. Refusing to start: run it where containers join ${SLICE} ` +
            "(rootless Podman, or rootless Docker with the systemd cgroup driver, under a user " +
            "systemd), or on a disposable host. Rootful Docker and Docker Desktop put " +
            "containers outside it, so a workstation can't run it on them",
        );
        return 1;
      }
      if (!inSlice) {
        console.warn(
          `test-real: ${placement.why}, so on this disposable host each container gets a ` +
            "quarter of the machine's memory, outside the cap every capped run shares",
        );
      }
      const parent = inSlice ? placement.parent : [];
      const memory = memoryBudget(process.env, host.totalMemory, inSlice);
      const failedSuites: Suite[] = [];
      for (const suite of suites) {
        const container = `${name}-${suite}`;
        containers.push(container);
        const passed = await step([
          "run",
          "--rm",
          "--init",
          // The init passes a forwarded signal to the suite's whole process group, not to make
          // alone, or to falsify's shell alone: each waits out a SIGINT for the child it is
          // running, so the suite would never get it. So a stop reaches the suite, which prints
          // what it ran, before the client's grace runs out.
          "--env",
          "TINI_KILL_PROCESS_GROUP=1",
          "--name",
          container,
          ...labels,
          "--network",
          "none",
          // Chromium needs more shared memory than a container's default 64 MB.
          "--shm-size",
          "1g",
          // A suite may start a busy process per core; the quota keeps the machine usable for the
          // agents working on it while the run goes on.
          "--cpus",
          cpuBudget(process.env, availableParallelism()),
          ...parent,
          // The same for memory and memory plus swap: no swap, so a runaway meets the cap at once.
          "--memory",
          memory,
          "--memory-swap",
          memory,
          image,
          ...suiteCommand(suite, mutants),
        ]);
        if (interrupted !== undefined) return 1;
        if (!passed) failedSuites.push(suite);
      }
      console.log(
        failedSuites.length === 0
          ? `test-real: ${suites.join(", ")} passed`
          : `test-real: ${failedSuites.join(", ")} failed`,
      );
      return failedSuites.length === 0 ? 0 : 1;
    })();
  } finally {
    const left: string[] = [];
    // `--rm` usually got there first; a container whose docker client died did not.
    if (containers.length > 0 && !gone(await quiet(["rm", "--force", ...containers]))) {
      left.push(...containers);
    }
    // By tag, unforced: another run's tag on the same image keeps it.
    if (image !== undefined && !gone(await quiet(["image", "rm", image]))) left.push(image);
    if (dir !== undefined) host.removeDir(dir);
    unsubscribe();
    if (left.length > 0) {
      console.warn(`test-real: left ${left.join(", ")}; the next run's sweep removes them`);
    }
  }
  return interrupted === undefined ? code : exitCodeFor(interrupted);
}

// The host's own architecture: a shell's default platform can name one Docker would emulate.
const { DOCKER_DEFAULT_PLATFORM: _emulated, ...dockerEnv } = process.env;

const after = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * A command's `stop`: passes the signal on, then kills the command if it is still running
 * `STOP_GRACE_MS` later. A command that has exited is never signalled again.
 */
export function stopper(
  send: (signal: NodeJS.Signals) => void,
  hasExited: () => boolean,
  wait: (ms: number) => Promise<void>,
): (signal: NodeJS.Signals) => void {
  let escalating = false;
  return (signal) => {
    if (hasExited()) return;
    send(signal);
    if (escalating || signal === "SIGKILL") return;
    escalating = true;
    void wait(STOP_GRACE_MS).then(() => {
      if (!hasExited()) send("SIGKILL");
    });
  };
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

const docker: Docker = (args, quietly = false) => {
  const child = spawnGroup("docker", args, {
    env: dockerEnv,
    stdio: quietly ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
  const done = new Promise<DockerResult>((resolve) => {
    child.once("error", (error) => resolve({ code: null, out, err: err + error.message }));
    child.once("close", (code) => resolve({ code, out, err }));
  });
  return {
    done,
    stop: stopper(
      (signal) => signalGroup(child, signal),
      () => exited(child),
      after,
    ),
  };
};

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const host: Host = {
  pid: process.pid,
  id: hostname(),
  disposable: inSignalSandbox(),
  totalMemory: totalmem(),
  docker,
  prepare(base, prefix) {
    const dir = buildContext(git(process.cwd(), "rev-parse", "--show-toplevel"), base, prefix);
    return {
      dir,
      buildArgs: {
        ...pins((p) => readFileSync(join(dir, p), "utf8")),
        BASE_REF,
      },
    };
  },
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  memoryMax: (cgroup) => readMemoryMax(cgroup),
  cgroupOf(pid) {
    try {
      return /^0::(\S*)$/m.exec(readFileSync(`/proc/${pid}/cgroup`, "utf8"))?.[1];
    } catch {
      return undefined;
    }
  },
  runDirs: () =>
    readdirSync(tmpdir())
      .filter((name) => RUN_NAME.test(name))
      .map((name) => join(tmpdir(), name)),
  isAlive,
  after,
  onSignal(handler) {
    for (const signal of SIGNALS) process.on(signal, handler);
    return () => {
      for (const signal of SIGNALS) process.off(signal, handler);
    };
  },
};

if (isMain(import.meta)) {
  run(process.argv.slice(2), host).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      console.error(`test-real: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
