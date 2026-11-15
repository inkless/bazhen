// Where Bazhen sends process signals, and where a test that does may run. A signal sent to the
// wrong pid ends someone else's work, and one sent to -1 every process the user owns, so:
//
// - raw signal calls appear only in the chokepoints below, each of which checks its target;
// - a test that may signal processes it didn't start runs only in a sandbox, where the worst a
//   wrong pid can reach is the sandbox itself.
//
// Read by check-standards (the chokepoint rule), cargo-gate (which tests may run here) and
// falsify (what it may mutate here). Only Node built-ins, as cargo-gate needs.

import {
  DISPOSABLE_HOST_MARKER,
  SANDBOX_RULE,
  type SandboxHost,
  inSignalSandbox,
  thisHost,
} from "../packages/host-guard/src/sandbox.ts";
import { rustCode } from "./rust-source.ts";

export { DISPOSABLE_HOST_MARKER, SANDBOX_RULE, type SandboxHost, inSignalSandbox, thisHost };

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
export function chokepointFor(file: string, inTest = false): string {
  if (inTest || /^crates\/[^/]+\/tests\//.test(file))
    return "bazhen_test_signal (crates/bazhen-test-signal)";
  if (file.endsWith(".rs")) return "crates/bazhen-holder/src/child.rs";
  return "@bazhen/host-guard (packages/host-guard/src/signal.ts)";
}

// Named, not only called, so an import or an alias counts too. `test_kill_process`, which sends
// no signal, doesn't match: `\b` doesn't fall inside an identifier.
const RUST_RAW =
  /\b(?:kill_process|kill_process_group|kill_current_process_group|pidfd_send_signal|killpg)\b|\b(?:libc|signal)\s*::\s*kill\b/g;
const TS_KILL = /\bprocess\s*\??\.\s*kill\b/g;
const TS_KILL_COMPUTED = /\bprocess\s*\??\.?\s*\[\s*["'`]kill["'`]\s*\]/g;
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
export function tsCode(
  source: string,
  keepStrings = false,
  literals: { index: number; body: string }[] = [],
): string {
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
      literals.push({ index: start, body });
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

const KILL_PROGRAM = /^(?:\S*\/)?(?:kill|pkill|killall)$/;
// What runs a program named by the literal that follows: Rust's Command, and Node's and
// host-guard's process starts.
const STARTS_PROGRAM =
  /(?:Command\s*::\s*new|\b(?:spawn\w*|exec\w*|fork|runBounded|runIn\w*|output|run))\s*\(\s*\[?\s*$/;
const SHELL_KILL = /(?:^|[\s;&|(`])(?:\S*\/)?(kill|pkill|killall)\s+(\S+(?:\s+\S+)*)/g;
// Whether a shell `kill`'s first operand is a target: a pid, a group, a variable or a job.
const KILL_TARGET = /^(?:-?\d+|-?\\?\$\S*|%\S*)$/;
// Its own process ($$) or last background job ($!): a test fixture's script ending itself.
const SHELL_ITSELF = /^(?:\\?\$\\?\$|\$!)$/;
const SYSTEMCTL = /^(?:\S*\/)?systemctl$/;
const SHELL_SYSTEMCTL_KILL = /\bsystemctl\s+(?:-\S+\s+)*kill\b/;

/** The operands of a shell `kill`, past its options: `-TERM`, `-s TERM`, `-9`. */
function killOperands(args: string): string[] {
  const words =
    args
      .split(/[;&|)\n]/)[0]
      ?.trim()
      .split(/\s+/) ?? [];
  let i = 0;
  while (i < words.length && /^-[A-Za-z]/.test(words[i] ?? "")) i += words[i] === "-s" ? 2 : 1;
  return words.slice(i).filter((w) => !/^\d?>/.test(w));
}

/**
 * Whether a string literal starts a kill: a shell command that runs `kill` on anything but the
 * shell itself or its own job, or `pkill` or `killall` at all. A process started to send a
 * signal checks nothing the chokepoints would.
 */
export function startsKill(literal: string): boolean {
  if (SHELL_SYSTEMCTL_KILL.test(literal)) return true;
  for (const m of literal.matchAll(SHELL_KILL)) {
    if (m[1] !== "kill") return true;
    const [target, ...more] = killOperands(m[2] ?? "");
    if (target === undefined || !KILL_TARGET.test(target)) continue;
    if (!SHELL_ITSELF.test(target) || more.length > 0) return true;
  }
  return false;
}

/** The files allowed to start a kill, each with the target it stops and why it may. */
export const CLI_KILLS: Readonly<Record<string, string>> = {
  "scripts/signal-paths.ts": "the patterns that find kills, which start nothing",
  "scripts/signal-paths.test.ts": "the fixtures those patterns are tested on, which start nothing",
  "packages/host-guard/src/cap.ts":
    "`systemctl --user kill` of the scope unit this process named and started, which reaches " +
    "only that scope's processes",
};

/** The literals that start a kill: a program sending one, or a shell or systemctl doing so. */
function kills(literals: { index: number; body: string }[], code: string) {
  const out = literals
    .filter(
      (l) =>
        startsKill(l.body) ||
        (KILL_PROGRAM.test(l.body) &&
          STARTS_PROGRAM.test(code.slice(Math.max(0, l.index - 40), l.index))),
    )
    .map((l) => ({ index: l.index, line: lineAt(code, l.index), call: `a kill by "${l.body}"` }));
  // `systemctl kill` as a program and its arguments: "systemctl", options, then "kill".
  literals.forEach((l, n) => {
    if (SYSTEMCTL.test(l.body) && literals.slice(n + 1, n + 5).some((a) => a.body === "kill"))
      out.push({ index: l.index, line: lineAt(code, l.index), call: "systemctl kill" });
  });
  return out;
}

/** Each raw signal call in a file, by line, whatever else the file is. */
export function rawSignalCalls(file: string, text: string): { line: number; call: string }[] {
  const startable = !Object.hasOwn(CLI_KILLS, file);
  if (file.endsWith(".rs")) {
    const strings: string[] = [];
    const code = rustCode(text, strings);
    const literals = [...code.matchAll(/""/g)].map((m, n) => ({
      index: m.index,
      body: strings[n] ?? "",
    }));
    return [...found(code, RUST_RAW), ...(startable ? kills(literals, code) : [])]
      .toSorted((a, b) => a.index - b.index)
      .map(({ line, call }) => ({ line, call }));
  }
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
  const literals: { index: number; body: string }[] = [];
  const code = tsCode(text, false, literals);
  const kept = tsCode(text, true);
  // An import or a computed `process["kill"]` is matched with its strings kept, and counted only
  // where it is code.
  const inCode = (m: { index: number }) =>
    code.slice(m.index, m.index + 1) === kept.slice(m.index, m.index + 1);
  const imports = found(kept, TS_KILL_IMPORT).filter(
    (m) => code.slice(m.index, m.index + 6) === "import",
  );
  const computed = found(kept, TS_KILL_COMPUTED).filter(inCode);
  return [
    ...found(code, TS_KILL),
    ...found(code, TS_KILL_BOUND),
    ...imports,
    ...computed,
    ...(startable ? kills(literals, code) : []),
  ]
    .toSorted((a, b) => a.index - b.index)
    .map(({ line, call }) => ({ line, call }));
}

/** The chokepoints' own ways in: a file calling one sends signals, though not directly. */
const TS_SENDERS = /\b(?:signalGroup|signalPane|signalServer|killHolder|runBounded)\b/;
// The holder's own: its child's close and signal, which reach its group and the terminal's
// foreground group, and the guard module that floors them.
const RUST_SENDERS =
  /\b(?:bazhen_test_signal|ChildProcess|close_step|kill_now|signal_groups?|signal_member|guard\s*::)|\bchild\s*\.\s*(?:close|signal)\s*\(/;

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
