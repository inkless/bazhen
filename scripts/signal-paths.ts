// Where Bazhen sends process signals, and where a test that does may run. A signal sent to the
// wrong pid ends someone else's work, and one sent to -1 every process the user owns, so:
//
// - raw signal calls appear only in the chokepoints below, each of which checks its target;
// - a test that may signal processes it didn't start runs only in a sandbox, where the worst a
//   wrong pid can reach is the sandbox itself.
//
// Read by check-standards (the chokepoint rule), cargo-gate (which tests may run here) and
// falsify (what it may mutate here). Only Node built-ins, as cargo-gate needs.

import { lstatSync, readlinkSync } from "node:fs";
import { rustCode } from "./rust-source.ts";

/** The files allowed a raw signal call, each with what it checks before it sends. */
export const SIGNAL_CHOKEPOINTS: Readonly<Record<string, string>> = {
  "packages/host-guard/src/signal.ts":
    "every TypeScript signal: a group this process started, or a target checked to be one of " +
    "Bazhen's own, never 0, ±1, this process or its parent",
  "crates/bazhen-holder/src/child.rs":
    "the holder's signals to its child's group, which it leads, and to the terminal's foreground " +
    "group",
  "crates/bazhen-test-signal/src/lib.rs":
    "every Rust test's signals: to a process it started or checked is still the one it started, " +
    "never 0, ±1, the test, its parent or its own group",
};

/** Where a file that wants to send a signal should send it from. */
export function chokepointFor(file: string): string {
  if (/^crates\/[^/]+\/tests\//.test(file)) return "bazhen_test_signal (crates/bazhen-test-signal)";
  if (file.endsWith(".rs")) return "crates/bazhen-holder/src/child.rs";
  return "@bazhen/host-guard (packages/host-guard/src/signal.ts)";
}

// Named, not only called, so an import or an alias counts too. `test_kill_process`, which sends
// no signal, doesn't match: `\b` doesn't fall inside an identifier.
const RUST_RAW =
  /\b(?:kill_process|kill_process_group|kill_current_process_group|pidfd_send_signal|killpg)\b|\b(?:libc|signal)\s*::\s*kill\b/g;
const TS_KILL = /\bprocess\s*\??\.\s*kill\b/g;
const TS_KILL_BOUND = /\{[^}]*\bkill\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/g;
const TS_KILL_IMPORT =
  /\bimport\s*(?:type\s+)?\{[^}]*\bkill\b[^}]*\}\s*from\s*["'](?:node:)?process["']/g;

const blank = (text: string) => text.replaceAll(/[^\n]/g, " ");

/**
 * TypeScript with comments blanked, and with every string and template literal's contents
 * blanked unless `keepStrings`, character for character, so an index in one is an index in the
 * other and in the source. A regular expression literal holding a quote can hide what follows
 * it; the lint rule, which reads the syntax tree, is the TypeScript check that can't be fooled.
 */
export function tsCode(source: string, keepStrings = false): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    const start = i;
    if (c === "/" && (next === "/" || next === "*")) {
      const end = next === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2) + 2;
      i = end < start + 2 ? source.length : end;
      out += blank(source.slice(start, i));
    } else if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, source.length);
      const body = source.slice(start + 1, i - 1);
      out += c + (keepStrings ? body : blank(body)) + (i - start > 1 ? c : "");
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const lineAt = (code: string, index: number) => code.slice(0, index).split("\n").length;
const found = (code: string, pattern: RegExp) =>
  [...code.matchAll(pattern)].map((m) => ({
    index: m.index,
    line: lineAt(code, m.index),
    call: m[0],
  }));

/** Each raw signal call in a file, by line, whatever else the file is. */
export function rawSignalCalls(file: string, text: string): { line: number; call: string }[] {
  if (file.endsWith(".rs"))
    return found(rustCode(text), RUST_RAW).map(({ line, call }) => ({ line, call }));
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
  const code = tsCode(text);
  // An import is matched with its module's name kept, and counted only where it is code.
  const imports = found(tsCode(text, true), TS_KILL_IMPORT).filter(
    (m) => code.slice(m.index, m.index + 6) === "import",
  );
  return [...found(code, TS_KILL), ...found(code, TS_KILL_BOUND), ...imports]
    .toSorted((a, b) => a.line - b.line)
    .map(({ line, call }) => ({ line, call }));
}

/** The chokepoints' own ways in: a file calling one sends signals, though not directly. */
const TS_SENDERS = /\b(?:signalGroup|signalPane|signalServer|killHolder|runBounded)\b/;
const RUST_SENDERS = /\bbazhen_test_signal\b/;

/**
 * Whether a file sends signals, directly or through a chokepoint. Reverting or mutating one can
 * turn a check of a target into a signal to anything, so it is changed only in a sandbox.
 */
export function isSignallingSource(file: string, text: string): boolean {
  if (Object.hasOwn(SIGNAL_CHOKEPOINTS, file) || rawSignalCalls(file, text).length > 0) return true;
  if (file.endsWith(".rs")) return RUST_SENDERS.test(rustCode(text));
  return /\.[cm]?[jt]sx?$/.test(file) && TS_SENDERS.test(tsCode(text));
}

/** The reason a Rust test that signals processes it didn't start is ignored outside a sandbox. */
export const SIGNALS_IGNORE = "signals processes; runs in pnpm test:real rust";

/**
 * Whether a file holds tests that may signal processes they didn't start: Rust tests ignored as
 * signalling, and the holder suite, whose holders signal whole sessions when they close.
 */
export function isSignallingTest(file: string, text: string): boolean {
  if (file.startsWith("tests/holder/")) return true;
  if (!file.endsWith(".rs")) return false;
  const strings: string[] = [];
  const code = rustCode(text, strings);
  let literal = 0;
  for (const m of code.matchAll(/#\s*\[\s*ignore\s*=\s*""|""/g)) {
    if (m[0] !== '""' && strings[literal] === SIGNALS_IGNORE) return true;
    literal++;
  }
  return false;
}

/** `/proc/self/ns/pid` in the initial PID namespace: the kernel's fixed PROC_PID_INIT_INO. */
export const INIT_PID_NAMESPACE = "pid:[4026531836]";
/** Marks a host that exists to be thrown away: the test container, or a CI runner. */
export const DISPOSABLE_HOST_MARKER = "/etc/bazhen-disposable-host";

/** What decides whether a host is a sandbox: its platform, PID namespace and marker. */
export interface SandboxHost {
  readonly platform: NodeJS.Platform;
  /** `/proc/self/ns/pid`'s link, or undefined if it can't be read. */
  readonly pidNamespace: string | undefined;
  /** The marker's owner, if it is a file and not a link; undefined if it isn't there. */
  readonly markerOwner: number | undefined;
}

function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

/** This host, as `inSignalSandbox` reads it. */
export function thisHost(): SandboxHost {
  const marker = read(() => lstatSync(DISPOSABLE_HOST_MARKER));
  return {
    platform: process.platform,
    pidNamespace: read(() => readlinkSync("/proc/self/ns/pid")),
    markerOwner: marker?.isFile() === true ? marker.uid : undefined,
  };
}

/** Whether the marker is there and root's, so no user could have made it by habit. */
export const markedDisposable = (host: SandboxHost) => host.markerOwner === 0;

/**
 * Whether a test may signal processes it didn't start: on a marked disposable host, or on Linux
 * in a PID namespace of its own, where nothing outside the namespace can be named.
 */
export function inSignalSandbox(host: SandboxHost = thisHost()): boolean {
  if (markedDisposable(host)) return true;
  return (
    host.platform === "linux" &&
    host.pidNamespace !== undefined &&
    host.pidNamespace !== INIT_PID_NAMESPACE
  );
}

/** Why a signalling test won't run here, and where it does. */
export const SANDBOX_RULE =
  "such a test signals processes it didn't start, so it runs only in a sandbox: pnpm test:real, " +
  `CI, or a Linux PID namespace (/proc/self/ns/pid other than ${INIT_PID_NAMESPACE}), or on a ` +
  `host carrying a root-owned ${DISPOSABLE_HOST_MARKER}. Never create that file on a machine ` +
  "you work on";
