// Transient systemd user scopes: the argv that starts a command in one, whether this machine's
// user manager enforces a memory cap on one, and which scope a process runs in.
//
// `systemd-run --scope` asks the manager over D-Bus to make a scope of its own pid, then execs the
// command, which keeps that pid. Nothing here sends a signal: systemd moves the process, and only
// the kernel kills, inside the scope, past its cap.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The first systemd whose scopes take `OOMPolicy`; older ones refuse the property. */
export const MIN_SYSTEMD = 253;
/** Where every terminal's scope goes: a dash in a slice's name nests it under `bazhen.slice`. */
export const TERMINALS_SLICE = "bazhen-terminals.slice";
const TERMINAL_UNIT = /^bazhen-terminal-[A-Za-z0-9_-]+\.scope$/;
const STEP_TIMEOUT_MS = 10_000;
const STDERR_MAX = 2_000;

export const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The unified-hierarchy cgroup a `/proc/<pid>/cgroup` names. */
export const cgroupOf = (text: string) => /^0::(\/\S*)$/m.exec(text)?.[1];

/** The `systemd-run` arguments that start the command after them in a scope of the user manager. */
export const scopeArgs = (unit: string, slice: string, properties: readonly string[]) => [
  "--user",
  "--scope",
  "--quiet",
  `--unit=${unit}`,
  `--slice=${slice}`,
  ...properties.flatMap((property) => ["-p", property]),
  "--",
];

/** How a command ran: its exit code (null for a signal or a failure to start) and its output. */
export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const runCommand = (
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout = STEP_TIMEOUT_MS,
): Promise<Ran> =>
  new Promise((done) => {
    execFile(file, args, { env, timeout, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      done({ code, stdout, stderr: stderr || (error?.message ?? "") });
    });
  });

/** The systemd a `systemd-run --version` names, or undefined. */
export const systemdVersion = (text: string) => {
  const version = Number(/^systemd (\d+)/.exec(text)?.[1]);
  return Number.isInteger(version) ? version : undefined;
};

/**
 * What a probe scope reads of its own caps and its slice's, as JSON on stdout. Read from inside,
 * because a user manager without the memory controller takes `MemoryMax` and enforces nothing.
 */
export const PROBE_SCRIPT = `
const { readFileSync: r } = require("node:fs");
const at = (p) => { try { return r(p, "utf8"); } catch { return undefined; } };
const cg = "/sys/fs/cgroup" + /^0::(\\/\\S*)$/m.exec(at("/proc/self/cgroup") ?? "")?.[1];
const slice = cg.slice(0, cg.lastIndexOf("/"));
process.stdout.write(JSON.stringify({
  memory: at(cg + "/memory.max"),
  swap: at(cg + "/memory.swap.max"),
  slice: at(slice + "/memory.max"),
  sliceSwap: at(slice + "/memory.swap.max"),
}));`;

/** What a probe read from inside a scope. */
export interface ProbeReading {
  readonly memory?: string | undefined;
  readonly swap?: string | undefined;
  readonly slice?: string | undefined;
  readonly sliceSwap?: string | undefined;
}

/** A probe's stdout as a reading, or undefined for anything but its JSON. */
export function parseProbe(stdout: string): ProbeReading | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const field = (name: string) => {
    const value: unknown = Reflect.get(parsed, name);
    return typeof value === "string" ? value : undefined;
  };
  return {
    memory: field("memory"),
    swap: field("swap"),
    slice: field("slice"),
    sliceSwap: field("sliceSwap"),
  };
}

/** A unit name no earlier unit had, so a journal line or a scope still collected never matches. */
export const uniqueUnit = (prefix: string, random = () => randomBytes(6).toString("hex")) =>
  `${prefix}-${random()}.scope`;

/** The memory caps terminals get, in any form systemd's `MemoryMax=` takes. */
export interface TerminalCaps {
  /** Each terminal's scope. */
  readonly terminal: string;
  /** All terminals together: `TERMINALS_SLICE`. */
  readonly total: string;
}

/** A size `MemoryMax=` takes: bytes with an optional K/M/G/T suffix, a percentage, or infinity. */
export const MEMORY_MAX = /^(?:\d+[KMGT]?|(?:100|\d{1,2}(?:\.\d+)?)%|infinity)$/;

/**
 * Whether new terminals start contained, and if not, why. A cap reads back from the kernel as
 * bytes, or null for none (`infinity`).
 */
export type Containment =
  | {
      readonly kind: "scoped";
      readonly systemd: number;
      /** Whether each scope takes `OOMPolicy=continue`; before 253 the kernel's kill is all. */
      readonly oomPolicy: boolean;
      readonly caps: TerminalCaps;
      readonly terminalBytes: number | null;
      readonly totalBytes: number | null;
      /** The `systemd-run` every scope starts through, by absolute path. */
      readonly systemdRun: string;
      /** Where the user manager's bus is, which `systemd-run` needs and a holder's env lacks. */
      readonly runtimeDir: string;
    }
  | { readonly kind: "uncontained"; readonly why: string };

/** The OS calls `probeContainment` makes, replaced in its tests. */
export interface ProbeDeps {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly which: (command: string, path: string | undefined) => string | undefined;
  readonly run: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<Ran>;
  readonly node: string;
}

/** The first executable named `command` on `path`. */
export function which(command: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    const file = join(dir, command);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Not here; the next directory may have it.
    }
  }
  return undefined;
}

const realProbeDeps = (): ProbeDeps => ({
  platform: process.platform,
  env: process.env,
  which,
  run: (file, args, env) => runCommand(file, args, env),
  node: process.execPath,
});

const said = (ran: Ran) => ran.stderr.trim().slice(0, STDERR_MAX) || `exit ${String(ran.code)}`;

/** A cap as the kernel shows it: bytes, null for `max`, undefined for no reading. */
function kernelBytes(text: string | undefined): number | null | undefined {
  const value = text?.trim();
  if (value === "max") return null;
  const bytes = Number(value);
  return value !== undefined && value !== "" && Number.isSafeInteger(bytes) ? bytes : undefined;
}

const uncontained = (why: string): Containment => ({ kind: "uncontained", why });

/** Whether the kernel's reading enforces what was asked: a number for a cap, `max` for none. */
const enforces = (asked: string, got: number | null | undefined) =>
  asked === "infinity" ? got === null : typeof got === "number";

/**
 * Whether this machine can contain each terminal in a scope with `caps`: it sets the terminals'
 * slice to `caps.total`, then starts a scope as a terminal's would be and reads both caps back
 * from inside it.
 */
export async function probeContainment(
  caps: TerminalCaps,
  deps: ProbeDeps = realProbeDeps(),
): Promise<Containment> {
  for (const [name, value] of Object.entries(caps)) {
    if (!MEMORY_MAX.test(value)) return uncontained(`the ${name} cap ${value} isn't a MemoryMax`);
  }
  if (deps.platform !== "linux") return uncontained(`${deps.platform} has no cgroups`);
  const runtimeDir = deps.env["XDG_RUNTIME_DIR"];
  if (runtimeDir === undefined || !runtimeDir.startsWith("/")) {
    return uncontained("XDG_RUNTIME_DIR isn't set, so no systemd user manager can be reached");
  }
  const systemdRun = deps.which("systemd-run", deps.env["PATH"]);
  const systemctl = deps.which("systemctl", deps.env["PATH"]);
  if (systemdRun === undefined || systemctl === undefined) {
    return uncontained("systemd-run or systemctl isn't on PATH");
  }
  const env = { XDG_RUNTIME_DIR: runtimeDir };
  const versionRan = await deps.run(systemdRun, ["--version"], env);
  const systemd = systemdVersion(versionRan.stdout);
  if (systemd === undefined)
    return uncontained(`systemd-run --version failed: ${said(versionRan)}`);
  const set = await deps.run(
    systemctl,
    ["--user", "set-property", "--runtime", TERMINALS_SLICE, `MemoryMax=${caps.total}`],
    env,
  );
  if (set.code !== 0) {
    return uncontained(`systemctl couldn't set ${TERMINALS_SLICE}'s cap: ${said(set)}`);
  }
  const oomPolicy = systemd >= MIN_SYSTEMD;
  const unit = uniqueUnit(`bazhen-terminal-probe-${process.pid}`);
  const probe = await deps.run(
    systemdRun,
    [
      ...scopeArgs(unit, TERMINALS_SLICE, terminalProperties(caps, oomPolicy)),
      deps.node,
      "-e",
      PROBE_SCRIPT,
    ],
    env,
  );
  const reading = probe.code === 0 ? parseProbe(probe.stdout) : undefined;
  if (reading === undefined) return uncontained(`a probe scope wouldn't start: ${said(probe)}`);
  const terminalBytes = kernelBytes(reading.memory);
  const totalBytes = kernelBytes(reading.slice);
  if (!enforces(caps.terminal, terminalBytes) || !enforces(caps.total, totalBytes)) {
    return uncontained(
      `systemd ${systemd} takes a scope's MemoryMax but the kernel shows ` +
        `${reading.memory?.trim() ?? "no memory.max"}, so it enforces no cap here`,
    );
  }
  return {
    kind: "scoped",
    systemd,
    oomPolicy,
    caps,
    terminalBytes: terminalBytes ?? null,
    totalBytes: totalBytes ?? null,
    systemdRun,
    runtimeDir,
  };
}

/** The properties of a terminal's scope. */
function terminalProperties(caps: TerminalCaps, oomPolicy: boolean): string[] {
  return [
    `MemoryMax=${caps.terminal}`,
    // Past its cap the kernel kills the scope's biggest process, a runaway rather than its small
    // holder, and the default policy would then stop the holder too.
    ...(oomPolicy ? ["OOMPolicy=continue"] : []),
    // A scope whose processes were killed fails, and would stay listed until reset.
    "CollectMode=inactive-or-failed",
  ];
}

/** What starts a command in a scope: argv to put before it, and the env it needs. */
export interface ScopeLaunch {
  readonly argv: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
}

/** The launch that starts `terminalId`'s holder in a scope of its own, under `containment`. */
export function terminalScope(
  containment: Extract<Containment, { kind: "scoped" }>,
  terminalId: string,
  random?: () => string,
): ScopeLaunch {
  const unit = uniqueUnit(`bazhen-terminal-${terminalId}`, random);
  const properties = terminalProperties(containment.caps, containment.oomPolicy);
  return {
    argv: [containment.systemdRun, ...scopeArgs(unit, TERMINALS_SLICE, properties)],
    env: { XDG_RUNTIME_DIR: containment.runtimeDir },
  };
}

/**
 * Whether a cgroup path is a terminal's scope in the terminals' slice, as `/proc/<pid>/cgroup`
 * names it.
 */
export function isTerminalScope(cgroup: string): boolean {
  const parts = cgroup.split("/");
  return (
    TERMINAL_UNIT.test(parts.at(-1) ?? "") &&
    parts.at(-2) === TERMINALS_SLICE &&
    parts.at(-3) === "bazhen.slice"
  );
}

/**
 * Whether `pid` runs in a terminal's scope: null where that can't be read, as for a process that
 * has gone or an OS without cgroups.
 */
export function inTerminalScope(pid: number, read = readText): boolean | null {
  const cgroup = cgroupOf(read(`/proc/${pid}/cgroup`) ?? "");
  return cgroup === undefined ? null : isTerminalScope(cgroup);
}
