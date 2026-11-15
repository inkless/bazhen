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
  "crates/bazhen-holder/src/linux.rs":
    "signal 0, which sends nothing, through the holder's own pidfd, to learn at start whether " +
    "it may send through one",
  "crates/bazhen-holder/src/guard.rs":
    "every holder signal: to its own unreaped child's group, or to a process held and checked to " +
    "be in the session that child leads; never ≤ 1, the holder, its group, session or ancestors",
  "crates/bazhen-test-signal/src/lib.rs":
    "every Rust test's signals: to a process it started or checked is still the one it started, " +
    "never 0, ±1, the test, its parent or its own group",
};

/** Where a file that wants to send a signal should send it from. */
export function chokepointFor(file: string, inTest = false): string {
  if (inTest || /^crates\/[^/]+\/tests\//.test(file))
    return "bazhen_test_signal (crates/bazhen-test-signal)";
  if (file.endsWith(".rs")) return "crates/bazhen-holder/src/guard.rs";
  return "@bazhen/host-guard (packages/host-guard/src/signal.ts)";
}

// Named, not only called, so an import or an alias counts too. `test_kill_process`, which sends
// no signal, doesn't match: `\b` doesn't fall inside an identifier.
// A `use` of nix's or libc's `kill` inside braces counts as one, and so do the raw syscalls.
const RUST_RAW =
  /\b(?:kill_process|kill_process_group|kill_current_process_group|pidfd_send_signal|killpg|sigqueue|SYS_kill|SYS_tkill|SYS_tgkill|SYS_pidfd_send_signal|SYS_rt_sigqueueinfo)\b|\b(?:libc|signal)\s*::\s*kill\b|\buse\s+(?:nix\s*::\s*sys\s*::\s*signal|libc)\s*::\s*\{[^}]*\bkill\b[^}]*\}/g;
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

const KILL_PROGRAM = /^(?:\S*\/)?(?:kill|pkill|killall|killall5|skill)$/;
// What runs a program named by the literal that follows: Rust's Command, and Node's and
// host-guard's process starts.
const STARTS_PROGRAM =
  /(?:Command\s*::\s*new|\b(?:spawn\w*|exec\w*|fork|runBounded|runIn\w*|output|run))\s*\(\s*\[?\s*$/;
// Programs that run the program their arguments name, so `["env", "kill", ...]` is a kill.
const LAUNCHER =
  /^(?:\S*\/)?(?:env|sudo|doas|timeout|setsid|nohup|nice|ionice|xargs|stdbuf|chrt|taskset|flock|unshare|chroot|runuser|su|busybox|toybox|exec|command|builtin)$/;
// What a command line may open with before the program it runs: a launcher, an assignment, or
// a shell keyword.
const STARTER = /^(?:\w+=\S*|then|do|else|elif|if|while|until|!|\{|\})$/;
// A word that reads as a program's argument, not prose: an option, a number, a variable, a job,
// a brace or a path. Prose punctuation ends no shell argument, so "after a kill -9, with" is a
// sentence.
const ARGUMENT = /^(?!.*[,.:]$)(?:-\S*|\d\S*|[$%{]\S*|\/\w\S*)$/;
const SYSTEMCTL = /^(?:\S*\/)?systemctl$/;
const LOGINCTL = /^(?:\S*\/)?loginctl$/;
const LOGINCTL_KILL = /^(?:terminate-user|kill-user|terminate-session|kill-session)$/;
const FUSER = /^(?:\S*\/)?fuser$/;
const FUSER_KILL = /^-\w*k|^--kill$/;
// A `kill`'s one signal spec, and the only operands it may take: the shell itself, its last
// background job, or a plain positive variable holding a pid the script started.
const SIGNAL_SPEC = /^-(?:SIG)?[A-Z]+[0-9+]*$|^-\d+$|^--signal=\S+$/;
const SIGNAL_SPEC_WITH_VALUE = /^(?:-s|-n|--signal)$/;
const OWN_TARGET = /^(?:\$\$|\$!|\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\})$/;

/** A shell command's words, unescaped, less its redirections and any comment. */
function shellWords(segment: string): string[] {
  return segment
    .replace(/(?:^|\s)#.*$/, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "" && !/^\d*[<>]&?\S*$/.test(w));
}

/** Whether a `kill`'s words, past the program, name only its own targets. */
function killsOnlyItsOwn(words: string[]): boolean {
  let i = 0;
  if (SIGNAL_SPEC_WITH_VALUE.test(words[i] ?? "")) i += 2;
  else if (SIGNAL_SPEC.test(words[i] ?? "")) i++;
  if (words[i] === "--") i++;
  const operands = words.slice(i);
  return operands.length > 0 && operands.every((w) => OWN_TARGET.test(w));
}

/**
 * Whether a string literal is a shell command line that sends a signal. It fails closed. Each
 * command is read, the line split at the shell's operators and its quotes, so `sh -c "kill -9
 * -1"` is read as its inner command; and any word of it that names a kill program starts a
 * kill wherever it sits after a launcher, whatever options that launcher takes, or wherever an
 * argument follows it. A `kill` passes only when, past
 * one signal spec and a `--`, each operand is the shell itself, its last job or a plain
 * variable; every other kill program, `systemctl kill`, `loginctl terminate-user` and the like,
 * and `fuser -k`, count. A literal holding no whitespace, escaped whitespace aside, is a
 * program's name rather than a command line: a process started with it is caught where the
 * literal is passed (`kills`).
 */
export function startsKill(literal: string): boolean {
  const unescaped = literal.replaceAll(/\\[tnrfv]/g, " ");
  if (!/\s/.test(unescaped)) return false;
  // A quoted variable is one word, not a nested command: unquote it before splitting at quotes.
  const line = unescaped.replaceAll("\\", "").replaceAll(/(["'])(\$\{?\w+\}?|\$\$|\$!)\1/g, "$2");
  for (const segment of line.split(/&&|\|\||[;&|\n()`"']|\$\(/)) {
    const words = shellWords(segment);
    const launched = LAUNCHER.test(words[0] ?? "") || STARTER.test(words[0] ?? "");
    for (const [i, word] of words.entries()) {
      const rest = words.slice(i + 1);
      // A word names the program a command runs when it opens the command, follows a launcher
      // and its options however many there are, or takes an argument; elsewhere it is prose.
      if (i > 0 && !launched && !ARGUMENT.test(rest[0] ?? "")) continue;
      if (word === "kill" || word.endsWith("/kill")) {
        if (!killsOnlyItsOwn(rest)) return true;
      } else if (KILL_PROGRAM.test(word)) return true;
      else if (SYSTEMCTL.test(word) && rest.includes("kill")) return true;
      else if (LOGINCTL.test(word) && rest.some((w) => LOGINCTL_KILL.test(w))) return true;
      else if (FUSER.test(word) && rest.some((w) => FUSER_KILL.test(w))) return true;
    }
  }
  return false;
}

/**
 * The kills by a started process that are allowed, each by file, the code that may start it,
 * and why it may: a kill found anywhere else in the file still counts.
 */
export const CLI_KILLS: Readonly<Record<string, { code: RegExp; why: string }>> = {
  "scripts/signal-paths.ts": {
    code: /[\s\S]*/,
    why: "the patterns that find kills, which start nothing",
  },
  "scripts/signal-paths.test.ts": {
    code: /[\s\S]*/,
    why: "the fixtures those patterns are tested on, which start nothing",
  },
  "scripts/lint-plugin.medium.test.ts": {
    code: /const FIXTURE = \[[\s\S]*?\]\.join\("\\n"\)/,
    why: "the lint rule's fixture, which oxlint reads and nothing runs",
  },
  "packages/host-guard/src/cap.ts": {
    code: /output\(\s*"systemctl",\s*\["--user",\s*"kill",\s*`--signal=\$\{signal\}`,\s*unit\]\)/,
    why:
      "`systemctl --user kill` of the scope unit this process named and started, which reaches " +
      "only that scope's processes",
  },
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
  // A program and its arguments as literals in a row: systemctl's or loginctl's kill verbs,
  // fuser -k, or a launcher handed a kill program.
  literals.forEach((l, n) => {
    const next = literals.slice(n + 1, n + 5).map((a) => a.body);
    const hit = (call: string) => out.push({ index: l.index, line: lineAt(code, l.index), call });
    if (SYSTEMCTL.test(l.body) && next.includes("kill")) hit("systemctl kill");
    if (LOGINCTL.test(l.body) && next.some((a) => LOGINCTL_KILL.test(a))) hit("loginctl kill");
    if (FUSER.test(l.body) && next.some((a) => FUSER_KILL.test(a))) hit("fuser -k");
    if (LAUNCHER.test(l.body) && next.some((a) => KILL_PROGRAM.test(a)))
      hit(`a kill by "${l.body}"`);
  });
  return out;
}

/** The spans of `text` where a kill by a started process is allowed (CLI_KILLS). */
function allowedKills(file: string, text: string): [number, number][] {
  const allowed = CLI_KILLS[file];
  if (allowed === undefined) return [];
  const pattern = new RegExp(allowed.code.source, "g");
  return [...text.matchAll(pattern)].map((m) => [m.index, m.index + m[0].length]);
}

const outside = (spans: [number, number][]) => (m: { index: number }) =>
  !spans.some(([from, to]) => m.index >= from && m.index < to);

/** Each raw signal call in a file, by line, whatever else the file is. */
export function rawSignalCalls(file: string, text: string): { line: number; call: string }[] {
  if (file.endsWith(".rs")) {
    const strings: string[] = [];
    const code = rustCode(text, strings);
    const literals = [...code.matchAll(/""/g)].map((m, n) => ({
      index: m.index,
      body: strings[n] ?? "",
    }));
    const spans = allowedKills(file, code);
    return [...found(code, RUST_RAW), ...kills(literals, code).filter(outside(spans))]
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
  // What else names `process`: a default or namespace import of it, or a constant bound to it.
  const aliases = [
    ...kept.matchAll(/\bimport\s+(?:\*\s+as\s+)?(\w+)\s+from\s*["'](?:node:)?process["']/g),
    ...code.matchAll(
      /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:globalThis\s*\.\s*)?process\b(?!\s*\.)/g,
    ),
  ].flatMap((m) => (m[1] === undefined || !inCode(m) ? [] : [m[1]]));
  const viaAlias = aliases.flatMap((alias) => [
    ...found(code, new RegExp(`\\b${alias}\\s*\\??\\.\\s*kill\\b`, "g")),
    ...found(
      kept,
      new RegExp(`\\b${alias}\\s*\\??\\.?\\s*\\[\\s*["'\`]kill["'\`]\\s*\\]`, "g"),
    ).filter(inCode),
  ]);
  return [
    ...found(code, TS_KILL),
    ...found(code, TS_KILL_BOUND),
    ...imports,
    ...computed,
    ...viaAlias,
    ...kills(literals, code).filter(outside(allowedKills(file, kept))),
  ]
    .toSorted((a, b) => a.index - b.index)
    .map(({ line, call }) => ({ line, call }));
}

/** The chokepoints' own ways in: a file calling one sends signals, though not directly. */
const TS_SENDERS = /\b(?:signalGroup|signalPane|signalServer|killHolder|runBounded)\b/;
// The holder's own: its child's close and signal, which reach its group and the terminal's
// foreground group, and the guard module that floors them.
const RUST_SENDERS =
  /\b(?:bazhen_test_signal|ChildProcess|Session|Ending|close_step|pass_among|signal_group|signal_member|guard\s*::)|\b(?:child|holder|old)\s*\.\s*(?:close|signal|respawn|retire)\s*\(/;

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
