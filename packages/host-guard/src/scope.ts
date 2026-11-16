// Transient systemd user scopes: the argv that starts a command in one, whether this machine's
// user manager enforces a memory cap on one, and which scope a process runs in.
//
// `systemd-run --scope` asks the manager over D-Bus to make a scope of its own pid, then execs the
// command, which keeps that pid. Nothing here sends a signal: systemd moves the process, and only
// the kernel kills, inside the scope, past its cap.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { totalmem } from "node:os";
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

/** The memory caps terminals get, as systemd's `MemoryMax=` and `MemorySwapMax=` take them. */
export interface TerminalCaps {
  /** Each terminal's scope's memory. */
  readonly terminal: string;
  /** All terminals' memory together: `TERMINALS_SLICE`. */
  readonly total: string;
  /** Each terminal's scope's swap. */
  readonly swap: string;
}

const UNIT_BYTES: Readonly<Record<string, number>> = {
  "": 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};
/** The least a memory cap may be: below it a terminal's own shell and holder can't start. */
export const MIN_MEMORY_MAX = 64 * 1024 ** 2;
const SIZE_FORM = "bytes with an optional K, M, G or T";

/** A size in bytes, as `<n>[K|M|G|T]` gives it, or undefined for anything else. */
function sizeBytes(text: string): number | undefined {
  const match = /^(\d+)([KMGT]?)$/.exec(text);
  if (match === null) return undefined;
  const bytes = Number(match[1]) * (UNIT_BYTES[match[2] ?? ""] ?? 1);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/** A whole percentage from 1 to 100, as `<n>%` gives it, or undefined for anything else. */
function percentage(text: string): number | undefined {
  const match = /^(\d{1,3})%$/.exec(text);
  const percent = Number(match?.[1]);
  return match !== null && percent >= 1 && percent <= 100 ? percent : undefined;
}

/**
 * Why `value` can't cap a terminal's memory, or all terminals', or undefined when it can: bytes
 * with an optional K, M, G or T of at least 64M, a whole percentage of RAM from 1 to 100, or
 * `infinity`.
 */
export function memoryMaxRefusal(value: string): string | undefined {
  if (value === "infinity" || percentage(value) !== undefined) return undefined;
  const bytes = sizeBytes(value);
  if (bytes === undefined)
    return `must be ${SIZE_FORM}, a whole percentage from 1% to 100%, or infinity`;
  return bytes < MIN_MEMORY_MAX ? "must be at least 64M, or a terminal can't start" : undefined;
}

/** Why `value` can't cap a terminal's swap, or undefined when it can: bytes, 0 included, or `infinity`. */
export function swapMaxRefusal(value: string): string | undefined {
  return value === "infinity" || sizeBytes(value) !== undefined
    ? undefined
    : `must be ${SIZE_FORM}, 0 for none, or infinity`;
}

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
      /** Each cap as the kernel enforces it: bytes, or null for none. */
      readonly enforced: { readonly [K in keyof TerminalCaps]: number | null };
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
  /** The machine's memory, which a percentage cap is taken of. */
  readonly totalMemory: number;
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
  totalMemory: totalmem(),
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

/** How far a cap the kernel shows may lie below the bytes asked: it rounds down to a page. */
const PAGE_SLACK = 64 * 1024;

/**
 * Whether the kernel's reading is the cap asked: `max` for `infinity`; the bytes asked, rounded down
 * to a page; or a percentage of the machine's memory, within a percent of it, as systemd takes its
 * memory from what the kernel says it has.
 */
function enforces(asked: string, got: number | null | undefined, totalMemory: number): boolean {
  if (asked === "infinity") return got === null;
  if (typeof got !== "number") return false;
  const percent = percentage(asked);
  if (percent !== undefined)
    return Math.abs(got - (totalMemory * percent) / 100) <= totalMemory / 100;
  const bytes = sizeBytes(asked);
  return bytes !== undefined && got <= bytes && got > bytes - PAGE_SLACK;
}

const shown = (text: string | undefined) => text?.trim() ?? "nothing";

/**
 * Whether this machine can contain each terminal in a scope with `caps`: it sets the terminals'
 * slice to `caps.total`, then starts a scope as a terminal's would be and reads both caps back
 * from inside it.
 */
export async function probeContainment(
  caps: TerminalCaps,
  deps: ProbeDeps = realProbeDeps(),
): Promise<Containment> {
  const refusal =
    memoryMaxRefusal(caps.terminal) ?? memoryMaxRefusal(caps.total) ?? swapMaxRefusal(caps.swap);
  if (refusal !== undefined)
    throw new RangeError(`refusing caps ${JSON.stringify(caps)}: ${refusal}`);
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
  const read = {
    terminal: ["a scope's memory.max", reading.memory],
    total: [`${TERMINALS_SLICE}'s memory.max`, reading.slice],
    swap: ["a scope's memory.swap.max", reading.swap],
  } as const;
  const enforced: Record<keyof TerminalCaps, number | null> = {
    terminal: null,
    total: null,
    swap: null,
  };
  for (const name of ["terminal", "total", "swap"] as const) {
    const [what, text] = read[name];
    const bytes = kernelBytes(text);
    if (!enforces(caps[name], bytes, deps.totalMemory)) {
      return uncontained(
        `systemd ${systemd} was asked for ${caps[name]}, but the kernel shows ${what} as ` +
          `${shown(text)}, so it doesn't enforce that cap here`,
      );
    }
    enforced[name] = bytes ?? null;
  }
  return { kind: "scoped", systemd, oomPolicy, caps, enforced, systemdRun, runtimeDir };
}

/** The properties of a terminal's scope. */
function terminalProperties(caps: TerminalCaps, oomPolicy: boolean): string[] {
  return [
    `MemoryMax=${caps.terminal}`,
    // Uncapped, a runaway at its memory cap would go on into swap and stall every terminal before
    // the kernel killed it.
    `MemorySwapMax=${caps.swap}`,
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
