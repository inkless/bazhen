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
} from "../packages/host-guard/src/index.ts";
import { rustCode } from "./rust-source.ts";

export { DISPOSABLE_HOST_MARKER, SANDBOX_RULE, type SandboxHost, inSignalSandbox, thisHost };

/** The files allowed a raw signal call, each with what it checks before it sends. */
export const SIGNAL_CHOKEPOINTS: Readonly<Record<string, string>> = {
  "packages/host-guard/src/signal.ts":
    "every TypeScript signal: a group this process started, a child it spawned and hasn't " +
    "reaped, or a target checked to be one of Bazhen's own, a holder by its command and start " +
    "time, never 0, ±1, this process or its parent",
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

/**
 * Files that end processes through no call the scan reads, each with how. Each counts as a
 * signalling source, so a revert or mutant of it runs only in a sandbox.
 */
export const ENDS_WITHOUT_A_CALL: Readonly<Record<string, string>> = {
  "apps/daemon/src/pty/node-pty.ts":
    "the PTY seam's hang-up, which closes the master for the kernel to hang up the session, " +
    "and replaces node-pty's kill, which signals by pid, with one that sends nothing",
};

/** Where a file that wants to send a signal should send it from. */
export function chokepointFor(file: string, inTest = false): string {
  if (inTest || /^crates\/[^/]+\/tests\//.test(file))
    return "bazhen_test_signal (crates/bazhen-test-signal)";
  if (file.startsWith("crates/bazhen-holder/src/")) return "crates/bazhen-holder/src/guard.rs";
  if (file.endsWith(".rs")) return "crates/bazhen-host-guard (docs/standards/rust.md § Signals)";
  return "@bazhen/host-guard (packages/host-guard/src/signal.ts)";
}

// Named, not only called, so an import or an alias counts too. `test_kill_process`, which sends
// no signal, doesn't match: `\b` doesn't fall inside an identifier.
// A `use` of nix's or libc's `kill` inside braces counts as one, and so do the raw syscalls and a
// renamed `extern crate` of libc or nix.
const RUST_RAW =
  /\b(?:kill_process|kill_process_group|kill_current_process_group|pidfd_send_signal|killpg|tgkill|tkill|sigqueue|SYS_kill|SYS_tkill|SYS_tgkill|SYS_pidfd_send_signal|SYS_rt_sigqueueinfo)\b|\b(?:libc|signal)\s*::\s*(?:r#)?kill\b|\buse\s+(?:nix\s*::\s*sys\s*::\s*signal|libc)\s*::\s*\{[^}]*\bkill\b[^}]*\}|\bextern\s+crate\s+(?:libc|nix)\s+as\b/g;
// A `use` that names libc or a `signal` module, at any depth of its groups, and imports `kill`, a
// glob or a rename, brings a kill into scope under a name RUST_RAW doesn't read; a `pub use` of
// either lets another file do the same through a path of ours. Each counts as a call, read as one
// statement so no nesting of groups hides it.
const RUST_USE = /\b(?:(pub)\b(?:\s*\([^)]*\))?\s*)?use\b[^;]*/g;

function signalImports(code: string) {
  return [...code.matchAll(RUST_USE)].flatMap((m) => {
    const words = (m[0].match(/(?:r#)?[A-Za-z_]\w*|\*/g) ?? []).map((w) => w.replace(/^r#/, ""));
    const names = words.includes("libc") || words.includes("signal");
    const brings = m[1] !== undefined || words.some((w) => w === "kill" || w === "*" || w === "as");
    if (!names || !brings) return [];
    const call = m[0].replaceAll(/\s+/g, " ").trim();
    return [{ index: m.index, end: m.index + m[0].length, line: lineAt(code, m.index), call }];
  });
}

const TS_KILL = /\bprocess\s*\??\.\s*(?:_?kill|abort)\b/g;
const TS_KILL_COMPUTED = /\bprocess\s*\??\.?\s*\[\s*["'`](?:_?kill|abort)["'`]\s*\]/g;
const TS_KILL_BOUND = /\{[^}]*\b(?:_kill|abort)\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/g;
const TS_KILL_IMPORT =
  /\b(?:import|export)\s*(?:type\s+)?\{[^}]*\b(?:_?kill|abort)\b[^}]*\}\s*from\s*["'](?:node:)?process["']/g;
// A member named kill on anything: a ChildProcess's, a node-pty IPty's, process's. Text can't tell
// them apart, so each is a signal, and an API whose kill sends none is named for what it does.
const TS_MEMBER_KILL = /(?:[\w$]+\s*)?\??\.\s*kill\b/g;
const TS_MEMBER_KILL_COMPUTED = /(?:([\w$]+)|[)\]])\s*(?:\?\.)?\s*\[\s*["'`]kill["'`]\s*\]/g;
const TS_MEMBER_KILL_BOUND = /\{[^{}]*\bkill\b[^{}]*\}\s*=(?![=>])/g;
// Words a `[` can follow that make it an array, not an index.
const NOT_RECEIVERS = new Set([
  "return",
  "of",
  "in",
  "typeof",
  "case",
  "yield",
  "await",
  "void",
  "delete",
  "throw",
  "new",
  "else",
  "do",
]);

// child_process's own starts, each of which Node kills the child for when given a `timeout`,
// `killSignal` or `signal` (an AbortSignal).
const STARTERS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;
const STARTER_NAME = `(?:${STARTERS.join("|")})`;
const CHILD_PROCESS_MODULE = `["'](?:node:)?child_process["']`;
const START_OPTION = /(?<=[{,]\s*)\b(timeout|killSignal|signal)\b(?=\s*[:,}])/g;

/** The index of the `)` closing the `(` at `open` in blanked code, or the end of the code. */
function closingParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i;
  }
  return code.length;
}

/**
 * Each `timeout`, `killSignal` or `signal` key in a child_process start's arguments: the start
 * called bare or through an import alias, as a member of child_process imported whole, or bound
 * by `promisify` to a name of its own. A wrapper taking a timeout of its own isn't a start; the
 * kill it causes is found where it calls Node.
 */
function startOptions(code: string, kept: string) {
  const named = new Map<string, string>(STARTERS.map((s) => [s, s]));
  const modules: string[] = [];
  const imports = new RegExp(
    `\\bimport\\s+(?:(\\w+)|\\*\\s+as\\s+(\\w+)|\\{([^}]*)\\})\\s+from\\s*${CHILD_PROCESS_MODULE}`,
    "g",
  );
  for (const m of kept.matchAll(imports)) {
    if (code.slice(m.index, m.index + 6) !== "import") continue;
    const whole = m[1] ?? m[2];
    if (whole !== undefined) modules.push(whole);
    for (const spec of (m[3] ?? "").split(",")) {
      const [imported, local] = spec.trim().split(/\s+as\s+/);
      if (imported !== undefined && local !== undefined && named.has(imported))
        named.set(local, imported);
    }
  }
  const module = modules.length > 0 ? `(?:${modules.join("|")})\\s*\\.\\s*` : "";
  const notMember = "(?<!\\.\\s*)\\b";
  const promisified = new RegExp(
    `\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:\\w+\\s*\\.\\s*)?promisify\\s*\\(\\s*` +
      `(?:${module === "" ? notMember : `${module}|${notMember}`})` +
      `(${[...named.keys()].join("|")})\\s*\\)`,
    "g",
  );
  for (const m of code.matchAll(promisified))
    if (m[1] !== undefined && m[2] !== undefined) named.set(m[1], named.get(m[2]) ?? m[2]);
  const bare = `${notMember}(${[...named.keys()].join("|")})`;
  const member = module === "" ? "" : `|${module}(${STARTER_NAME})`;
  const calls = new RegExp(`(?:${bare}${member})\\s*\\(`, "g");
  return [...code.matchAll(calls)].flatMap((call) => {
    const open = call.index + call[0].length - 1;
    const args = code.slice(open, closingParen(code, open));
    const start = call[2] ?? named.get(call[1] ?? "") ?? "";
    return [...args.matchAll(START_OPTION)].map((option) => ({
      index: open + option.index,
      line: lineAt(code, open + option.index),
      call: `${option[1]} option of ${start}`,
    }));
  });
}

const blank = (text: string) => text.replaceAll(/[^\n]/g, " ");

// After these, a `/` opens a regular expression rather than dividing: an operator, an opening
// bracket, a statement's end, or a keyword that takes an expression. `<` is left out, as JSX's
// `</` closes a tag.
const REGEX_AFTER =
  /(?:[=(,:[!&|?{};+\-*%>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof))$/;
const opensRegex = (out: string) => {
  const before = out.trimEnd();
  return before === "" || REGEX_AFTER.test(before.slice(-16));
};

/** The end of a regular expression literal opening at `at`, past its flags, or -1 if none does. */
function regexEnd(source: string, at: number): number {
  let inClass = false;
  for (let i = at + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") return -1;
    if (c === "\\") i++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let end = i + 1;
      while (/[a-z]/.test(source[end] ?? "")) end++;
      return end;
    }
  }
  return -1;
}

/**
 * TypeScript with comments blanked, and with every string, template text and regular expression
 * literal's contents blanked unless `keepStrings`, character for character, so an index in one is
 * an index in the other and in the source. A template's substitutions, `${…}`, are code, read as
 * any other. A `/` opens a regular expression where the code before it can't be a value it
 * divides; JSX's `</` never does. The lint rule, which reads the syntax tree, is the check that
 * needs no such reading.
 */
export function tsCode(
  source: string,
  keepStrings = false,
  literals: { index: number; body: string }[] = [],
): string {
  let out = "";
  let i = 0;
  // For each template whose substitution is open, where it began and its unclosed braces.
  const templates: { start: number; depth: number }[] = [];
  const text = (body: string) => (keepStrings ? body : blank(body));
  /** Reads template text from `i` to its next substitution or its closing backtick. */
  const templateText = (start: number) => {
    const from = i;
    while (i < source.length && source[i] !== "`" && !source.startsWith("${", i))
      i += source[i] === "\\" ? 2 : 1;
    i = Math.min(i, source.length);
    out += text(source.slice(from, i));
    if (source.startsWith("${", i)) {
      templates.push({ start, depth: 0 });
      out += "${";
      i += 2;
    } else if (i < source.length) {
      literals.push({ index: start, body: source.slice(start + 1, i) });
      out += "`";
      i++;
    } else literals.push({ index: start, body: source.slice(start + 1) });
  };
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    const start = i;
    const open = templates.at(-1);
    if (c === "/" && (next === "/" || next === "*")) {
      const end = next === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2) + 2;
      i = end < start + 2 ? source.length : end;
      out += blank(source.slice(start, i));
    } else if (c === "/" && opensRegex(out) && regexEnd(source, i) > 0) {
      i = regexEnd(source, i);
      out += "/" + text(source.slice(start + 1, i - 1)) + source[i - 1];
    } else if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, source.length);
      const body = source.slice(start + 1, i - 1);
      literals.push({ index: start, body });
      out += c + text(body) + (i - start > 1 ? c : "");
    } else if (c === "`") {
      out += c;
      i++;
      templateText(start);
    } else if (c === "}" && open !== undefined && open.depth === 0) {
      templates.pop();
      out += c;
      i++;
      templateText(open.start);
    } else {
      if (open !== undefined && c === "{") open.depth++;
      if (open !== undefined && c === "}") open.depth--;
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
const STARTER = /^(?:\w+=\S*|then|do|else|elif|if|while|until|time|coproc|!|\{|\})$/;
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

// A word that opens a redirection, and one that is the operator alone, whose target is the next
// word. `>&-` closes a descriptor and takes no target. A here-string's target is the input the
// command reads, which may be a command line for a shell.
const REDIRECTION = /^\d*(?:[<>]|&>)/;
const REDIRECTION_OPERATOR = /^\d*(?:<<-|[<>&][<>&|]*)$/;
const HERE_STRING = /^\d*<<</;
// A substitution's place in a word: an argument, and never a target the shell owns.
const SUBSTITUTION = "$()";

/** A quote or a substitution the line opens and never closes, at `quote` if a quote. */
class Unclosed {
  readonly quote: number | undefined;
  constructor(quote?: number) {
    this.quote = quote;
  }
}

/** The index of the `"` that closes a double quote whose content starts at `from`. */
function doubleQuoteEnd(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === '"') return i;
    else if (line[i] === "`") i = backtickEnd(line, i);
    else if (line.startsWith("$(", i)) i = substitutionEnd(line, i + 2);
  }
  throw new Unclosed(from - 1);
}

function backtickEnd(line: string, at: number): number {
  for (let i = at + 1; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "`") return i;
  }
  throw new Unclosed();
}

/** The index of the `'` that closes an ANSI-C quote, `$'…'`, whose content starts at `from`. */
function ansiQuoteEnd(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "'") return i;
  }
  throw new Unclosed(from - 1);
}

/** The index of the `)` that closes a `$(` whose content starts at `from`. */
function substitutionEnd(line: string, from: number): number {
  let depth = 1;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const open = i;
      i = line.indexOf("'", open + 1);
      if (i < 0) throw new Unclosed(open);
    } else if (c === '"') i = doubleQuoteEnd(line, i + 1);
    else if (c === "`") i = backtickEnd(line, i);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new Unclosed();
}

const ANSI_C: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** What an ANSI-C quote's content means, its escapes, a letter spelled by its code included. */
function ansiC(body: string): string {
  return body.replaceAll(
    /\\(?:([0-7]{1,3})|x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|([\s\S]))/g,
    (escape, octal?: string, hex?: string, u4?: string, u8?: string, c?: string) => {
      if (c !== undefined) return ANSI_C[c] ?? (/["'\\?]/.test(c) ? c : escape);
      const code =
        octal === undefined
          ? Number.parseInt(hex ?? u4 ?? u8 ?? "", 16)
          : Number.parseInt(octal, 8);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    },
  );
}

/**
 * What a double quote's content means: a backslash there escapes only `$`, a backtick, `"`,
 * `\` and a newline.
 */
const doubleQuoted = (body: string) =>
  body.replaceAll(/\\([$`"\\\n])/g, (_, c: string) => (c === "\n" ? "" : c));

type Word = { text: string; bare: boolean; quoted: boolean };

/**
 * A shell line's commands, each as its words with their quotes and escapes removed, and the text
 * that may be a command line of its own: inside each quote and substitution, each word with a
 * quoted part, and each here-string. A substitution stands in its word as `$()`. A word is `bare`
 * when no part of it was quoted, escaped or substituted. Throws `Unclosed`.
 */
function shellCommands(line: string) {
  const commands: Word[][] = [[]];
  const inner: string[] = [];
  let word: Word | undefined;
  const end = () => {
    if (word === undefined) return;
    commands.at(-1)?.push(word);
    if (word.quoted) inner.push(word.text);
    word = undefined;
  };
  const add = (text: string, kind: "bare" | "quoted" | "substituted") => {
    word ??= { text: "", bare: true, quoted: false };
    word.text += text;
    word.bare &&= kind === "bare";
    word.quoted ||= kind === "quoted";
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    let close: number;
    if (c === "\\") {
      if (line[i + 1] !== "\n") add(line[i + 1] ?? "", "quoted");
      i++;
    } else if (c === "#" && word === undefined) {
      const newline = line.indexOf("\n", i);
      i = (newline < 0 ? line.length : newline) - 1;
    } else if (c === "$" && line[i + 1] === "'") {
      close = ansiQuoteEnd(line, i + 2);
      const body = ansiC(line.slice(i + 2, close));
      inner.push(body);
      add(body, "quoted");
      i = close;
    } else if (c === "$" && line[i + 1] === '"') {
      continue;
    } else if (c === "'") {
      close = line.indexOf("'", i + 1);
      if (close < 0) throw new Unclosed(i);
      inner.push(line.slice(i + 1, close));
      add(line.slice(i + 1, close), "quoted");
      i = close;
    } else if (c === '"') {
      close = doubleQuoteEnd(line, i + 1);
      const body = doubleQuoted(line.slice(i + 1, close));
      inner.push(body);
      add(body.replace(/(?:\$\(|`)[\s\S]*/, SUBSTITUTION), "quoted");
      i = close;
    } else if (c === "`" || line.startsWith("$(", i)) {
      close = c === "`" ? backtickEnd(line, i) : substitutionEnd(line, i + 2);
      inner.push(line.slice(i + (c === "`" ? 1 : 2), close));
      add(SUBSTITUTION, "substituted");
      i = close;
    } else if (
      (c === "&" || c === "|") &&
      (/[<>]$/.test(word?.text ?? "") || (c === "&" && line[i + 1] === ">"))
    ) {
      add(c, "bare");
    } else if (/[;&|\n()]/.test(c)) {
      end();
      commands.push([]);
      if ((c === "&" || c === "|") && line[i + 1] === c) i++;
    } else if (/\s/.test(c)) end();
    else add(c, "bare");
  }
  end();
  return { commands: commands.map((words) => withoutRedirections(words, inner)), inner };
}

/** A command's words less its redirections and their targets, a here-string's kept in `inner`. */
function withoutRedirections(words: Word[], inner: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const { text, bare } = words[i] ?? { text: "", bare: true };
    if (!bare || !REDIRECTION.test(text)) {
      out.push(text);
      continue;
    }
    const target = REDIRECTION_OPERATOR.test(text)
      ? words[++i]?.text
      : text.replace(HERE_STRING, "");
    if (HERE_STRING.test(text) && target !== undefined) inner.push(target);
  }
  return out;
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

const COOKED: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v" };

/**
 * A string literal's text as the program sees it: its language's escapes taken, and a line
 * continuation dropped.
 */
const cook = (literal: string) =>
  literal.replaceAll(/\\(\r?\n|[\s\S])/g, (_, c: string) =>
    c.endsWith("\n") ? "" : (COOKED[c] ?? c),
  );

/**
 * Whether a string literal is a shell command line that sends a signal: a best-effort reading
 * that fails closed. `cooked` says the literal is its text as written, a raw string; otherwise
 * its escapes are taken first. The line is read into commands at the shell's operators, and each
 * command into words, with quoted and escaped parts joined to the text they touch, so `k''ill` is
 * `kill`. The text inside each quote and substitution, each word with a quoted part and each
 * here-string is read again as a command line, so `sh -c "kill -9 -1"` counts. Any word that
 * names a kill program starts a kill wherever it sits after a launcher, whatever options that
 * launcher takes, or wherever an argument follows it. A `kill` passes only when, past one signal
 * spec and a `--`, and less its redirections with their targets, each operand is the shell
 * itself, its last job or a plain variable; a substitution is none of them. Every other kill
 * program, `systemctl kill`, `loginctl terminate-user` and the like, and `fuser -k`, count, and so
 * does a program word built by a substitution where the line names a kill. A line naming a kill
 * that leaves a substitution open counts. One that leaves a quote open, as an apostrophe in prose
 * does, counts if it is a kill read either with the quote running to the end of the line or with
 * it as a plain character. A literal holding no whitespace is a program's name rather than a
 * command line: a process started with it is caught where the literal is passed (`kills`).
 */
export function startsKill(literal: string, cooked = false): boolean {
  const line = cooked ? literal : cook(literal);
  return /\s/.test(line) && readsAsKill(line, 0, 0);
}

// How many open quotes a line is read both ways for, and how deep text inside text is read again,
// before a line naming a kill counts as one unread.
const OPEN_QUOTE_READINGS = 4;
const NESTED_READINGS = 8;
// What a line must hold, its quotes and escapes taken out, to send a signal at all: a word, not
// part of a name like `skillFailures`.
const NAMES_A_KILL = /\b(?:kill|pkill|killall5?|skill|systemctl|loginctl|fuser)\b/;
const namesAKill = (text: string) =>
  NAMES_A_KILL.test(text.replaceAll(/["'`\\]/g, "")) ||
  NAMES_A_KILL.test(text.replaceAll(/["'`\\]/g, " "));

function readsAsKill(line: string, openQuotes: number, depth: number): boolean {
  if (depth > NESTED_READINGS) return namesAKill(line);
  let read: ReturnType<typeof shellCommands>;
  try {
    read = shellCommands(line);
  } catch (error) {
    if (!(error instanceof Unclosed)) throw error;
    if (!namesAKill(line)) return false;
    const at = error.quote;
    if (at === undefined || openQuotes >= OPEN_QUOTE_READINGS) return true;
    return (
      readsAsKill(line + line[at], openQuotes + 1, depth) ||
      readsAsKill(line.slice(0, at) + line.slice(at + 1), openQuotes + 1, depth)
    );
  }
  const named = namesAKill(line);
  return (
    read.commands.some((words) => commandKills(words, named)) ||
    read.inner.some((inner) => readsAsKill(inner, openQuotes, depth + 1))
  );
}

/** Whether one command's words send a signal, `named` saying whether its line names a kill. */
function commandKills(words: string[], named: boolean): boolean {
  const program = words.find((w) => !LAUNCHER.test(w) && !STARTER.test(w)) ?? "";
  if (program.includes(SUBSTITUTION) && (named || namesAKill(program.replaceAll(SUBSTITUTION, ""))))
    return true;
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
  return false;
}

interface AllowedSignal {
  readonly code: RegExp;
  readonly why: string;
  /** How many places `code` matches, 1 unless given: any other count fails, 0 included. */
  readonly count?: number;
  /**
   * Text that names kills and runs none: it allows a kill by a command line alone, and doesn't
   * make its file one that signals.
   */
  readonly fixture?: boolean;
  /** The part of each match that is allowed, its first match within it, when not all of it. */
  readonly at?: RegExp;
}

/**
 * A start whose `timeout` Node enforces by killing the child it started, through that child's own
 * handle, which reaches nothing once the child is reaped: what `signalOwnChild` checks. Only the
 * `timeout` key is allowed, so another option at the same call still counts.
 */
const timedOut = (code: RegExp, what: string, count = 1): AllowedSignal => ({
  code,
  why: `${what}, which Node kills through its own handle once it outlives its timeout`,
  count,
  at: /\btimeout\b/,
});

/**
 * The signals allowed outside a chokepoint, each by file, the exact code that sends it, how many
 * times it appears there, and why it may: a signal found anywhere else in the file still counts.
 * A pattern that runs over several lines stops at a `;`, so it can't reach into the next statement.
 */
export const ALLOWED_SIGNALS: Readonly<Record<string, readonly AllowedSignal[]>> = {
  "scripts/signal-paths.ts": [
    { code: /[\s\S]*/, why: "the patterns that find kills, which start nothing", fixture: true },
  ],
  "scripts/signal-paths.test.ts": [
    {
      code: /[\s\S]*/,
      why: "the fixtures those patterns are tested on, which start nothing",
      fixture: true,
    },
  ],
  "scripts/lint-plugin.medium.test.ts": [
    {
      code: /const FIXTURE = \[[\s\S]*?\]\.join\("\\n"\)/,
      why: "the lint rule's fixture, which oxlint reads and nothing runs",
      fixture: true,
    },
  ],
  "packages/host-guard/src/cap.ts": [
    {
      code: /output\(\s*"systemctl",\s*\["--user",\s*"kill",\s*`--signal=\$\{signal\}`,\s*unit\]\)/,
      why:
        "`systemctl --user kill` of the scope unit this process named and started, which reaches " +
        "only that scope's processes",
    },
    timedOut(/execFile\(command, args, \{ timeout \}/, "each systemd and cgroup step it runs"),
    timedOut(
      /execFileSync\(path, \["--pdeathsig", "KILL", "--", "true"\], \{ stdio: "ignore", timeout: 2_000 \}\)/,
      "setpriv's probe for --pdeathsig",
    ),
  ],
  "packages/host-guard/src/scope.ts": [
    timedOut(
      /execFile\(file, args, \{ env, timeout, encoding: "utf8" \}/,
      "each systemd-run and systemctl step it runs",
    ),
  ],
  "packages/host-guard/src/cwd.ts": [
    timedOut(/run\("lsof", args, \{\s*env: LSOF_ENV,\s*timeout: TIMEOUT_MS,/, "lsof"),
  ],
  "packages/host-guard/src/ptys.ts": [
    timedOut(
      /execFileSync\("\/usr\/sbin\/sysctl", \["-n", "kern\.tty\.ptmx_max"\], \{\s*encoding: "utf8",\s*timeout: 5_000,/,
      "sysctl",
    ),
  ],
  "packages/host-guard/src/tmux.ts": [
    timedOut(
      /execFileSync\("tmux", \["-V"\], \{ encoding: "utf8", timeout: TIMEOUT_MS \}\)/,
      "tmux -V",
    ),
    timedOut(/run\("ps", args, \{ env: PS_ENV, timeout: TIMEOUT_MS \}\)/, "ps, reading a holder"),
    timedOut(
      /run\("ps", args, \{\s*env: PS_ENV,\s*timeout: TIMEOUT_MS,/,
      "ps, reading terminals' foreground groups",
    ),
    timedOut(
      /execFile\(\s*bin,\s*argv,\s*\{\s*env: opts\.env,\s*timeout: opts\.timeout \?\? TIMEOUT_MS,\s*maxBuffer:/,
      "tmux, run by TmuxServer.run",
    ),
    timedOut(
      /execFileSync\(bin, argv, \{\s*env: opts\.env,\s*timeout: opts\.timeout \?\? TIMEOUT_MS,\s*stdio:/,
      "tmux, run by TmuxServer.runSync",
    ),
    timedOut(
      /execFile\(\s*bin,\s*argv,\s*\{ env: opts\.env, timeout: opts\.timeout \?\? TIMEOUT_MS, encoding: "utf8" \}/,
      "tmux, reading a script on stdin in TmuxServer.source",
    ),
  ],
  "apps/daemon/src/codex/channel.ts": [
    timedOut(/run\("codex", args, \{ env, timeout: 60_000 \}\)/, "the codex CLI"),
    timedOut(/run\("codex", \["--version"\], \{ env, timeout: 1_000 \}\)/, "codex --version"),
  ],
  "apps/daemon/src/mailbox/binding.ts": [
    timedOut(
      /execFile\("ps", \["-o", "ppid=,comm=", "-p", String\(pid\)\], \{ timeout: 2000 \}/,
      "ps, reading a caller's parent",
    ),
  ],
  "scripts/falsify-base.ts": [
    timedOut(
      /spawnSync\("pnpm", installArgs\(mode\), \{[^;]*?timeout: INSTALL_TIMEOUT_MS,/,
      "pnpm install",
    ),
  ],
  "scripts/hook-bench.ts": [
    timedOut(
      /spawn\(argv\[0\], argv\.slice\(1\), \{[^;]*?timeout: Math\.max\(1, Math\.ceil\(Math\.min\(hangMs, leftMs\)\)\),/,
      "the hook client it measures",
    ),
  ],
  "scripts/capped.medium.test.ts": [
    timedOut(
      /spawnSync\(capped, \["--test-binary", "--memory", "128M", "--", \.\.\.argv\], \{[^;]*?timeout: 60_000,/,
      "the capped runner under test",
    ),
  ],
  "scripts/falsify-base.medium.test.ts": [
    timedOut(
      /spawnSync\("node", \[SCRIPT, "--base", "main"\], \{[^;]*?timeout: 30_000,/,
      "falsify-base under test",
    ),
  ],
  "scripts/falsify.medium.test.ts": [
    timedOut(
      /spawnSync\("node", \[FALSIFY, [^\]]*\], \{[^;]*?timeout: 30_000,/,
      "falsify under test",
      4,
    ),
  ],
  "tests/api/daemon.ts": [
    timedOut(/execFile\(CLI, args, \{ env, timeout: 30_000 \}/, "the bazhen CLI"),
    timedOut(
      /execFile\(\s*process\.execPath,\s*\[join\(repo, "apps\/daemon\/src\/main\.ts"\)\],\s*\{ env: \{ \.\.\.this\.env, BAZHEN_PORT: String\(this\.port\) \}, timeout: 30_000 \}/,
      "a second daemon, which should refuse to start",
    ),
    timedOut(/run\("codex", args, \{ env: this\.env, timeout: 90_000 \}\)/, "the codex CLI"),
    timedOut(
      /run\("codex", \["app-server", "daemon", "stop"\], \{ env: this\.env, timeout: 90_000 \}\)/,
      "codex's own daemon stop",
    ),
  ],
  "tests/cli/cli.ts": [
    timedOut(/execFile\(file, args, \{ env, cwd, timeout: RUN_MS \}/, "the CLI under test"),
  ],
};

/** The literals that start a kill: a program sending one, or a shell or systemctl doing so. */
function kills(
  literals: { index: number; body: string; cooked?: boolean | undefined }[],
  code: string,
) {
  const out = literals
    .filter(
      (l) =>
        startsKill(l.body, l.cooked) ||
        (KILL_PROGRAM.test(l.body) &&
          STARTS_PROGRAM.test(code.slice(Math.max(0, l.index - 40), l.index))),
    )
    .map((l): Signal => ({
      index: l.index,
      line: lineAt(code, l.index),
      call: `a kill by "${l.body}"`,
      literal: true,
    }));
  // A program and its arguments as literals in a row: systemctl's or loginctl's kill verbs,
  // fuser -k, or a launcher handed a kill program.
  literals.forEach((l, n) => {
    const next = literals.slice(n + 1, n + 5).map((a) => a.body);
    const hit = (call: string) =>
      out.push({ index: l.index, line: lineAt(code, l.index), call, literal: true });
    if (SYSTEMCTL.test(l.body) && next.includes("kill")) hit("systemctl kill");
    if (LOGINCTL.test(l.body) && next.some((a) => LOGINCTL_KILL.test(a))) hit("loginctl kill");
    if (FUSER.test(l.body) && next.some((a) => FUSER_KILL.test(a))) hit("fuser -k");
    if (LAUNCHER.test(l.body) && next.some((a) => KILL_PROGRAM.test(a)))
      hit(`a kill by "${l.body}"`);
  });
  return out;
}

/** Each entry for `file` with where in `text`, ALLOWED_SIGNALS's text for it, it allows. */
function allowedIn(file: string, text: string) {
  return (ALLOWED_SIGNALS[file] ?? []).map((entry) => {
    const spans = [...text.matchAll(new RegExp(entry.code.source, "g"))]
      .filter((m) => m[0] !== "")
      .map((m): [number, number] => {
        const part = entry.at === undefined ? undefined : entry.at.exec(m[0]);
        return part === undefined || part === null
          ? [m.index, m.index + m[0].length]
          : [m.index + part.index, m.index + part.index + part[0].length];
      });
    return { entry, spans };
  });
}

type Signal = { index: number; line: number; call: string; literal?: boolean };

/** Whether one of `allowed` lets `signal` through: a fixture lets only a command line's. */
const allows = (allowed: ReturnType<typeof allowedIn>, signal: Signal) =>
  allowed.some(
    ({ entry, spans }) =>
      (entry.fixture !== true || signal.literal === true) &&
      spans.some(([from, to]) => signal.index >= from && signal.index < to),
  );

const asCalls = (signals: Signal[]) =>
  signals.toSorted((a, b) => a.index - b.index).map(({ line, call }) => ({ line, call }));

/** Each raw signal call in a file, by line, whatever else the file is. */
export function rawSignalCalls(file: string, text: string): { line: number; call: string }[] {
  const { signals, allowed } = signalsIn(file, text);
  return asCalls(signals.filter((s) => !allows(allowed, s)));
}

/**
 * Each ALLOWED_SIGNALS entry for `file` that its text doesn't match exactly as many times as the
 * entry says: a copy of an allowed call, or an entry whose call has gone.
 */
export function allowedSignalFailures(file: string, text: string): string[] {
  return signalsIn(file, text).allowed.flatMap(({ entry, spans }) =>
    spans.length === (entry.count ?? 1)
      ? []
      : [
          `${file}: an allowed signal (${entry.why}) is found ${spans.length} times, not ` +
            `${entry.count ?? 1}; list each call it allows in scripts/signal-paths.ts.`,
        ],
  );
}

/** Every signal in a file, allowed or not, and what ALLOWED_SIGNALS allows there. */
function signalsIn(
  file: string,
  text: string,
): { signals: Signal[]; allowed: ReturnType<typeof allowedIn> } {
  if (file.endsWith(".rs")) {
    const strings: string[] = [];
    const raw: boolean[] = [];
    const code = rustCode(text, strings, raw);
    const literals = [...code.matchAll(/""/g)].map((m, n) => ({
      index: m.index,
      body: strings[n] ?? "",
      cooked: raw[n],
    }));
    const direct = found(code, RUST_RAW);
    const imports = signalImports(code).filter(
      (u) => !direct.some((d) => d.index >= u.index && d.index < u.end),
    );
    return {
      signals: [...direct, ...imports, ...kills(literals, code)],
      allowed: allowedIn(file, code),
    };
  }
  if (!/\.[cm]?[jt]sx?$/.test(file)) return { signals: [], allowed: allowedIn(file, "") };
  const literals: { index: number; body: string }[] = [];
  const code = tsCode(text, false, literals);
  const kept = tsCode(text, true);
  // An import or a computed `process["kill"]` is matched with its strings kept, and counted only
  // where it is code.
  const inCode = (m: { index: number }) =>
    code.slice(m.index, m.index + 1) === kept.slice(m.index, m.index + 1);
  const imports = found(kept, TS_KILL_IMPORT).filter((m) =>
    ["import", "export"].includes(code.slice(m.index, m.index + 6)),
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
    ...found(code, new RegExp(`\\b${alias}\\s*\\??\\.\\s*(?:_?kill|abort)\\b`, "g")),
    ...found(
      kept,
      new RegExp(`\\b${alias}\\s*\\??\\.?\\s*\\[\\s*["'\`](?:_?kill|abort)["'\`]\\s*\\]`, "g"),
    ).filter(inCode),
  ]);
  const memberComputed = [...kept.matchAll(TS_MEMBER_KILL_COMPUTED)]
    .filter((m) => inCode(m) && !NOT_RECEIVERS.has(m[1] ?? ""))
    .map((m) => ({ index: m.index, line: lineAt(code, m.index), call: m[0] }));
  const seen = new Set<number>();
  const signals = [
    ...found(code, TS_KILL),
    ...found(code, TS_KILL_BOUND),
    ...imports,
    ...computed,
    ...viaAlias,
    ...found(code, TS_MEMBER_KILL),
    ...memberComputed,
    ...found(code, TS_MEMBER_KILL_BOUND),
    ...found(code, /\bkillSignal\b/g),
    ...startOptions(code, kept),
    ...kills(literals, code),
  ].filter((m) => !seen.has(m.index) && seen.add(m.index));
  return { signals, allowed: allowedIn(file, kept) };
}

/**
 * The chokepoints' own ways in, and the PTY seam's hang-up, which ends its child through the
 * kernel: a file calling one ends processes, though it sends no signal itself.
 */
const TS_SENDERS = new RegExp(
  `\\b(?:${[
    "signalGroup",
    "signalOwnChild",
    "signalPane",
    "signalServer",
    "killHolder",
    "rebindHolder",
    "rebindHolderSocket",
    "startHolder",
    "runBounded",
    "killHolderAt",
    "rebindHolderAt",
    "rebindHolderWith",
    "startHolderWith",
  ].join("|")})\\b|\\.\\s*hangUp\\b`,
);
// The holder's own: its child's close and signal, which reach its group and the terminal's
// foreground group, and the guard module that floors them.
// A session's and an ending's constructors, or an import of either from the holder's session
// module, not the bare names: the engine has an `Ending` of its own, which ends a line of output
// and signals nothing.
const RUST_SENDERS =
  /\b(?:bazhen_test_signal|bazhen_host_guard|ChildProcess|close_step|pass_among|signal_group|signal_member|guard\s*::)|\bSession\s*::\s*led_by\b|\bEnding\s*::\s*start\b|\bsession\s*::\s*(?:\{[^}]*)?\b(?:Session|Ending)\b|\b(?:child|holder|old)\s*\.\s*(?:close|signal|respawn|retire)\s*\(/;

/**
 * Whether a file sends signals, directly or through a chokepoint. Reverting or mutating one can
 * turn a check of a target into a signal to anything, so it is changed only in a sandbox.
 */
export function isSignallingSource(file: string, text: string): boolean {
  if (Object.hasOwn(SIGNAL_CHOKEPOINTS, file) || Object.hasOwn(ENDS_WITHOUT_A_CALL, file)) {
    return true;
  }
  // Read before the allowed ones are let through: an allowed signal is still a signal.
  const { signals, allowed } = signalsIn(file, text);
  const fixtures = allowed.filter(({ entry }) => entry.fixture === true);
  if (signals.some((s) => !allows(fixtures, s))) return true;
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
