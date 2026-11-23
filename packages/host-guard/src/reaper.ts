// Makes a capped run on Linux a child subreaper, so that whatever its command starts stays in its
// process tree. A process that calls setsid, double-forks, enters a child cgroup or is moved into a
// scope of its own never changes its parent, and once its parent has gone it is reparented to the
// nearest living subreaper above it rather than to the user's systemd. The run is then exactly
// this process's live descendants.
//
// Node can't call prctl, but the flag survives execve, so the run re-execs itself once, keeping its
// pid, through a python3 that sets it. A probe then checks that it took: the marker alone proves
// nothing, as anything can set it. Nothing here sends a signal.

import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { heard } from "./child.ts";

/** Carries, across the re-exec, the pid it was made for and the `LC_CTYPE` python may change. */
export const REAPER_ENV = "BZ_CAPPED_REAPER";

/**
 * For tests only: set to `1` in a sandbox, it makes a run there act as on the host, so the host's
 * way can be tested where tests may run. It works only where `inSignalSandbox()` holds, where all
 * it does is make the run stop less; on a host the run acts as one already.
 */
export const TEST_HOST_MODE_ENV = "BZ_CAPPED_TEST_HOST_MODE";

/**
 * Whether a run acts as on the host: a subreaper that names what leaves it, leaves out the daemons
 * the user shares, and stops none of it. Outside a sandbox always, whatever `env` says.
 */
export const actsAsHost = (env: NodeJS.ProcessEnv, inSandbox: boolean) =>
  !inSandbox || env[TEST_HOST_MODE_ENV] === "1";

/** What the marker holds: `lcCtype` is null where `LC_CTYPE` was unset. */
export interface Marker {
  readonly pid: number;
  readonly lcCtype: string | null;
}

export const encodeMarker = (marker: Marker) =>
  Buffer.from(JSON.stringify(marker)).toString("base64");

/** The marker `text` holds, or undefined for anything that isn't one. */
export function decodeMarker(text: string | undefined): Marker | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    if (!("pid" in value) || !("lcCtype" in value)) return undefined;
    const { pid, lcCtype } = value;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid)) return undefined;
    if (typeof lcCtype !== "string" && lcCtype !== null) return undefined;
    return { pid, lcCtype };
  } catch {
    return undefined;
  }
}

/**
 * Sets PR_SET_CHILD_SUBREAPER (36) and execs the rest of its argv. `-I -S` keeps the user's
 * site and PYTHON* variables out. A refused prctl still execs: the probe then says why the run
 * can't see what leaves it.
 */
export const SHIM =
  "import ctypes, os, sys\n" +
  "if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:\n" +
  "    sys.stderr.write('capped: prctl(PR_SET_CHILD_SUBREAPER): ' + " +
  "os.strerror(ctypes.get_errno()) + '\\n')\n" +
  "os.execv(sys.argv[1], sys.argv[1:])\n";

/** The argv that re-execs `node` with `nodeArgv` through python3 with the subreaper flag set. */
export const shimArgv = (python: string, node: string, nodeArgv: readonly string[]) => [
  python,
  "-I",
  "-S",
  "-c",
  SHIM,
  node,
  ...nodeArgv,
];

/** The first executable `name` on `path`, or undefined. */
export function onPath(
  name: string,
  path = process.env.PATH ?? "",
  executable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): string | undefined {
  return path
    .split(delimiter)
    .filter((dir) => dir.startsWith("/"))
    .map((dir) => join(dir, name))
    .find(executable);
}

/** What a run does before its first spawn: re-exec as a reaper, carry on as one, or say why not. */
export type ReaperStart =
  | {
      readonly kind: "exec";
      readonly file: string;
      readonly argv: string[];
      readonly env: NodeJS.ProcessEnv;
    }
  | { readonly kind: "reaper"; readonly env: NodeJS.ProcessEnv }
  | { readonly kind: "none"; readonly why: string };

/**
 * Whether this process, `pid`, has come back from its re-exec (the marker names its own pid; a
 * nested capped inherits its parent's), and if not, how it re-execs. A run back from one gets the
 * env it had before python touched it, without the marker.
 */
export function reaperStart(
  env: NodeJS.ProcessEnv,
  pid: number,
  node: string,
  nodeArgv: readonly string[],
  python: string | undefined,
): ReaperStart {
  const marker = decodeMarker(env[REAPER_ENV]);
  if (marker?.pid === pid) {
    const rest = { ...env };
    delete rest[REAPER_ENV];
    delete rest.LC_CTYPE;
    return {
      kind: "reaper",
      env: marker.lcCtype === null ? rest : { ...rest, LC_CTYPE: marker.lcCtype },
    };
  }
  if (python === undefined) return { kind: "none", why: "there is no python3 to set the flag" };
  return {
    kind: "exec",
    file: python,
    argv: shimArgv(python, node, nodeArgv),
    env: { ...env, [REAPER_ENV]: encodeMarker({ pid, lcCtype: env.LC_CTYPE ?? null }) },
  };
}

/** Replaces `target`'s contents with `env`'s, as `process.env` takes them. */
export function replaceEnv(target: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(target)) if (!Object.hasOwn(env, name)) delete target[name];
  Object.assign(target, env);
}

const statFields = (text: string) => text.slice(text.lastIndexOf(")") + 2).split(" ");

/**
 * Why a probe's reading shows this process isn't a reaper whose children stay pinned, or
 * undefined if it is: `self` is `/proc/self/stat`, `orphan` the orphan's `/proc/<pid>/stat`.
 */
export function probeRefusal(
  pid: number,
  self: string | undefined,
  orphan: string | undefined,
): string | undefined {
  if (self === undefined) return "there is no /proc to read";
  if (Number(self.slice(0, self.indexOf(" "))) !== pid) {
    return "/proc belongs to another pid namespace";
  }
  if (orphan === undefined) return "the probe's orphan was gone before it was read";
  const [state, ppid] = statFields(orphan);
  if (state === "Z" || state === "X") return "the probe's orphan was gone before it was read";
  return Number(ppid) === pid ? undefined : "an orphan of its run isn't reparented to it";
}

const readOrUndefined = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Checks that this process is a subreaper, with no signal and no timing: `sh` starts a `cat`
 * blocked on a pipe this process holds, prints its pid and exits. The kernel reparents the `cat`
 * before the `sh`'s exit is reported, so its parent is read only after that. Closing the pipe then
 * ends the `cat`, as this process's own end would. Why not, or undefined when it is one.
 */
export async function probeReaper(): Promise<string | undefined> {
  const child = heard(
    spawn("sh", ["-c", "cat <&3 >/dev/null & echo $!"], {
      stdio: ["ignore", "pipe", "ignore", "pipe"],
    }),
  );
  const held = child.stdio[3];
  let out = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  // Not `close`, which waits on every stdio stream, the pipe this process holds included.
  const read = new Promise((done) => child.stdout?.once("end", done) ?? done(undefined));
  const started = await new Promise<boolean>((done) => {
    child.once("error", () => done(false));
    child.once("exit", () => done(true));
  });
  if (started) await read;
  try {
    if (!started) return "the probe's sh didn't start";
    const orphan = Number(out.trim());
    if (!Number.isSafeInteger(orphan) || orphan <= 1) return "the probe's sh printed no pid";
    return probeRefusal(
      process.pid,
      readOrUndefined("/proc/self/stat"),
      readOrUndefined(`/proc/${orphan}/stat`),
    );
  } finally {
    held?.destroy();
  }
}
