// `pnpm test:real [suite…] [--base <ref>]`: the real-tmux suites, in a container built from this
// worktree (docs/standards/testing.md). The build context is a fresh repository holding HEAD and
// falsify's base, overlaid with the worktree's uncommitted files, so falsify judges commits and
// the other suites test what is on disk. Each suite gets a container of its own, with nothing of
// the host's: no mount, no socket, no network.
//
// A run removes its containers, image and context on every exit it can observe, a signal
// included: docker runs asynchronously in a process group of its own, and a signal is forwarded
// to it rather than ending this process mid-step; a second signal abandons the cleanup. What a run
// killed outright or abandoned left is removed by the next run's sweep, which goes by the owner
// pid and host each run's names and labels carry.

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
import { constants, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isAlive, signalGroup, spawnGroup } from "@bazhen/host-guard";
import { isMain } from "./is-main.ts";

const SUITES = {
  integration: "test:integration",
  api: "test:api",
  e2e: "test:e2e",
  falsify: "test:falsify",
} as const;
type Suite = keyof typeof SUITES;
const DEFAULT_SUITES: Suite[] = ["integration", "api", "e2e"];
const DEFAULT_BASE = "origin/main";
/** What falsify's base is called inside the image, whatever it was called here. */
const BASE_REF = "refs/remotes/origin/main";

const isSuite = (name: string): name is Suite => Object.hasOwn(SUITES, name);
const USAGE = `usage: pnpm test:real [${Object.keys(SUITES).join("|")}]… [--base <ref>]`;

/** The suites named on the command line, in order, or the default set, and falsify's base. */
export function parseArgs(args: readonly string[]): { suites: Suite[]; base: string } {
  const at = args.indexOf("--base");
  const base = at === -1 ? DEFAULT_BASE : args[at + 1];
  const names = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  const unknown = names.filter((a) => !isSuite(a));
  if (base === undefined || base.startsWith("-") || unknown.length > 0) {
    throw new Error(unknown.length > 0 ? `unknown suite ${unknown.join(", ")}; ${USAGE}` : USAGE);
  }
  return {
    suites: names.length === 0 ? DEFAULT_SUITES : [...new Set(names.filter(isSuite))],
    base,
  };
}

/** The image's build arguments, read from the repository's own pins. */
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
  };
}

/**
 * The tmux the image builds, when `BZ_TMUX_VERSION` and `BZ_TMUX_SHA256` name another than the
 * Dockerfile's default: a release's version and the SHA-256 of its source tarball, together.
 */
export function tmuxBuildArgs(env: Readonly<Record<string, string | undefined>>) {
  const version = env["BZ_TMUX_VERSION"];
  const sha256 = env["BZ_TMUX_SHA256"];
  if (version === undefined && sha256 === undefined) return {};
  if (!version || !sha256) {
    throw new Error("BZ_TMUX_VERSION and BZ_TMUX_SHA256 are set together, or not at all");
  }
  return { TMUX_VERSION: version, TMUX_SHA256: sha256 };
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
  if (skipped.length > 0) console.warn(`test:real: left out of the image: ${skipped.join(", ")}`);
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
        ? `test:real: removed ${ref}, left by a run that is gone`
        : `test:real: kept ${ref}: ${errors(removed.err).join("; ")}`,
    );
  }
  for (const dir of host.runDirs()) {
    if (dead(ownerOf(basename(dir)))) host.removeDir(dir);
  }
}

const exitCodeFor = (signal: NodeJS.Signals) => 128 + constants.signals[signal];

/**
 * Runs the suites in `args`; the exit code, 128 + the signal's number once one arrived. The first
 * signal stops the command in flight and the run cleans up; a second abandons the cleanup, so a
 * wedged Docker can't hold the run, and the next run's sweep removes what was left.
 */
export async function run(args: readonly string[], host: Host): Promise<number> {
  const { suites, base } = parseArgs(args);
  const inFlight = new Set<DockerCall>();
  let interrupted: NodeJS.Signals | undefined;
  const { promise: abandoned, resolve: abandon } = Promise.withResolvers<undefined>();
  let isAbandoned = false;
  // Stays subscribed through cleanup, so a second signal can still cut it short.
  const unsubscribe = host.onSignal((signal) => {
    if (interrupted === undefined) {
      interrupted = signal;
      for (const call of inFlight) call.stop(signal);
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
      const failedSuites: Suite[] = [];
      for (const suite of suites) {
        const container = `${name}-${suite}`;
        containers.push(container);
        const passed = await step([
          "run",
          "--rm",
          "--init",
          "--name",
          container,
          ...labels,
          "--network",
          "none",
          // Chromium needs more shared memory than a container's default 64 MB.
          "--shm-size",
          "1g",
          image,
          "pnpm",
          SUITES[suite],
          ...(suite === "falsify" ? ["--base", BASE_REF] : []),
        ]);
        if (interrupted !== undefined) return 1;
        if (!passed) failedSuites.push(suite);
      }
      console.log(
        failedSuites.length === 0
          ? `test:real: ${suites.join(", ")} passed`
          : `test:real: ${failedSuites.join(", ")} failed`,
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
      console.warn(`test:real: left ${left.join(", ")}; the next run's sweep removes them`);
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
  docker,
  prepare(base, prefix) {
    const dir = buildContext(git(process.cwd(), "rev-parse", "--show-toplevel"), base, prefix);
    return {
      dir,
      buildArgs: {
        ...pins((p) => readFileSync(join(dir, p), "utf8")),
        ...tmuxBuildArgs(process.env),
      },
    };
  },
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
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
      console.error(`test:real: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
