// Where Bazhen sends process signals, and where a test that does may run. A signal sent to the
// wrong pid ends someone else's work, and one sent to -1 every process the user owns, so:
//
// - raw signal calls appear only in the chokepoints below, each of which checks its target;
// - a test that may signal processes it didn't start runs only in a sandbox, where the worst a
//   wrong pid can reach is the sandbox itself.
//
// Read by check-standards (the chokepoint rule) and falsify (what it may mutate here). Only Node
// built-ins, so it loads where node_modules isn't installed.

import {
  DISPOSABLE_HOST_MARKER,
  SANDBOX_RULE,
  type SandboxHost,
  inSignalSandbox,
  thisHost,
} from "../packages/host-guard/src/index.ts";
import { CHILD_PROCESS_MODULES, CHILD_PROCESS_STARTS } from "./child-process.ts";
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
  "crates/bazhen-host-guard/src/lib.rs":
    "every Rust signal outside the holder and the tests: to a group whose leader this process " +
    "started and hasn't reaped; to one process alone, a child it started and hasn't reaped, or a " +
    "bazhen-holder vouched for by its name and start time in the last second, SIGKILL or " +
    "SIGUSR1 as the proof was made for; and signal 0, which sends nothing; never init, this " +
    "process, its ancestors or its own group",
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

/** The crates whose kills RUST_RAW reads by the crate's name, which a Cargo rename would hide. */
export const SIGNAL_CRATES: readonly string[] = ["libc", "nix"];

/**
 * Each glob `use` and each bare `kill`, not a method's, in Rust source. In a chokepoint's tests
 * either reaches a name its product code imports, which the scan doesn't read there.
 */
export function chokepointReaches(text: string): { line: number; call: string }[] {
  const code = rustCode(text);
  const globs = [...code.matchAll(RUST_USE)]
    .filter((m) => m[0].includes("*"))
    .map((m) => ({ index: m.index, call: m[0].replaceAll(/\s+/g, " ").trim() }));
  const bare = [...code.matchAll(/(?<!\.\s*(?:r#)?)\b(?:r#)?kill\b/g)].map((m) => ({
    index: m.index,
    call: "a bare `kill`",
  }));
  return [...globs, ...bare]
    .toSorted((a, b) => a.index - b.index)
    .map(({ index, call }) => ({ line: lineAt(code, index), call }));
}

function signalImports(code: string) {
  return [...code.matchAll(RUST_USE)].flatMap((m) => {
    const words = (m[0].match(/(?:r#)?[A-Za-z_]\w*|\*/g) ?? []).map((w) => w.replace(/^r#/, ""));
    const names = words.includes("libc") || words.includes("signal");
    const brings = m[1] !== undefined || words.some((w) => w === "kill" || w === "*" || w === "as");
    if (!names || !brings) return [];
    const what = words.includes("libc") ? "libc" : "a `signal` module";
    const how =
      m[1] !== undefined
        ? "is a `pub use`"
        : words.includes("kill")
          ? "imports `kill`"
          : words.includes("*")
            ? "imports a glob"
            : "renames";
    const call = `${m[0].replaceAll(/\s+/g, " ").trim()}, which names ${what} and ${how}`;
    return [{ index: m.index, end: m.index + m[0].length, line: lineAt(code, m.index), call }];
  });
}

const TS_KILL = /\bprocess\s*\??\.\s*(?:_?kill|abort)\b/g;
const TS_KILL_COMPUTED = /\bprocess\s*\??\.?\s*\[\s*["'`](?:_?kill|abort)["'`]\s*\]/g;
const TS_KILL_BOUND = /\{[^}]*\b(?:_kill|abort)\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/g;
const TS_KILL_IMPORT =
  /\b(?:import|export)\s*(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*\b(?:_?kill|abort)\b[^}]*\}\s*from\s*["'](?:node:)?process["']/g;
const PROCESS_SOURCE = String.raw`\s*["'](?:node:)?process["']`;
// `process` re-exported whole, or as its module's default: either hands another file its kill.
const PROCESS_REEXPORT = new RegExp(
  String.raw`\bexport\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\bdefault\b[^}]*\})\s*from` +
    PROCESS_SOURCE,
  "g",
);
// A value import of `process`'s module: a default, a namespace, or named imports, `default` among
// them, or a default beside either of the others.
const PROCESS_IMPORT = new RegExp(
  String.raw`\bimport\s+(?:([\w$]+)\s*,\s*)?(?:\*\s+as\s+([\w$]+)|([\w$]+)|\{([^}]*)\})\s+from` +
    PROCESS_SOURCE,
  "g",
);
/** A pattern matching the name `name` alone, not inside a longer one. */
const tsName = (name: string) => String.raw`(?<![\w$])${name.replaceAll("$", "\\$")}(?![\w$])`;
/** `process`, or one of `names`, as a whole value rather than a member's receiver. */
const wholeProcess = (names: readonly string[]) =>
  String.raw`(?:globalThis\s*\.\s*)?(?:${["process", ...names].map(tsName).join("|")})(?!\s*\.)`;

// A variable's type, as far as a name and its unions: no further, so that each name is read once.
const TYPE_ANNOTATION = String.raw`(?::\s*(?:typeof\s+)?[\w$.]+(?:\s*\|\s*[\w$.]+)*\s*)?`;

/**
 * The names this file gives `process`, each where it is bound: a default or namespace import of
 * its module, an import of the name `default`, or a variable declared or assigned as it or as
 * another of these.
 */
function processAliases(code: string, kept: string): { name: string; index: number }[] {
  const out: { name: string; index: number }[] = [];
  for (const m of kept.matchAll(PROCESS_IMPORT)) {
    const defaults = (m[4] ?? "").split(",").flatMap((spec) => {
      const [imported, local] = spec.trim().split(/\s+as\s+/);
      return imported === "default" && local !== undefined ? [local] : [];
    });
    for (const name of [m[1], m[2], m[3], ...defaults])
      if (name !== undefined) out.push({ name, index: m.index });
  }
  for (let size = -1; size !== out.length;) {
    size = out.length;
    const bound = new RegExp(
      String.raw`(?<![\w$.])([\w$]+)\s*${TYPE_ANNOTATION}=\s*` +
        wholeProcess(out.map((a) => a.name)),
      "g",
    );
    for (const m of code.matchAll(bound))
      if (m[1] !== undefined && !out.some((a) => a.name === m[1]))
        out.push({ name: m[1], index: m.index });
  }
  return out;
}

/**
 * Each export of `process` or of a name this file gives it: another file can call its kill under
 * a name of its own, as a Rust `pub use` of a signal module lets it.
 */
function processExports(code: string, names: readonly string[]) {
  const whole = wholeProcess(names);
  const declared = found(
    code,
    new RegExp(
      String.raw`\bexport\s*(?:default\s*|=\s*|(?:const|let|var)\s+[\w$]+\s*=\s*)(?:\(\s*)*` +
        whole,
      "g",
    ),
  );
  const listed = [...code.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from\b)/g)]
    .filter((m) =>
      (m[1] ?? "")
        .split(",")
        .some((spec) => names.includes(spec.trim().split(/\s+as\s+/)[0] ?? "")),
    )
    .map((m) => ({ index: m.index, line: lineAt(code, m.index), call: m[0] }));
  return [...declared, ...listed];
}

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
const STARTERS = CHILD_PROCESS_STARTS;
const STARTER_NAME = `(?:${STARTERS.join("|")})`;
const MODULE_NAME = `(?:${CHILD_PROCESS_MODULES.join("|")})`;
const CHILD_PROCESS_MODULE = `["']${MODULE_NAME}["']`;
// A static import of child_process the scan reads, `import type` included: a default, a namespace
// or named imports, or a default beside either of the others.
const CHILD_PROCESS_IMPORT = new RegExp(
  `\\bimport\\s+(?:type\\s+)?(?:([\\w$]+)\\s*,\\s*)?(?:([\\w$]+)|\\*\\s+as\\s+([\\w$]+)|\\{([^}]*)\\})` +
    `\\s+from\\s*${CHILD_PROCESS_MODULE}`,
  "g",
);
// child_process named as a string, which a `require`, an `import()` or a re-export loads it by.
const CHILD_PROCESS_NAMED = new RegExp(`["'\`]${MODULE_NAME}["'\`]`, "g");
// What makes a name a call: type arguments without parens or braces, and `?.`, before its `(`.
const CALLED = "\\s*(?:<[^()<>;{}]*>\\s*)?(?:\\?\\.\\s*)?\\(";
// A name's start, not a member's, though a spread's `...` may come before it: `\b` alone misses a
// name opening with `$`.
const NOT_MEMBER = "(?<!(?<!\\.)\\.\\s*)(?:\\b|(?<![\\w$]))";
// What a key's name follows: a member's, a field's, a parameter's or a property's start, then
// any modifiers. Inside a conditional's branch a name follows an operator instead, as in
// `ok ? a && execFile : b`, where it is a value.
const KEY_AFTER =
  /(?:^|[{}(,;])\s*(?:(?:readonly|private|public|protected|static|declare|abstract|override|accessor)\s+)*$/;
const alternation = (names: Iterable<string>) =>
  [...names].map((n) => n.replaceAll("$", "\\$")).join("|");
// A key, a getter's or a method's included, as each sets the option.
const START_OPTION =
  /(?<=[{,]\s*(?:(?:get|set|async)\s+|\*\s*)?)\b(timeout|killSignal|signal)\b(?=\s*[:,}(])/g;
// What a declaration's name follows: a statement's or a member's start, or a modifier.
const DECLARED_AFTER =
  /(?:^|[;{},*]|\b(?:function|async|static|public|private|protected|readonly|override|abstract|declare|get|set))\s*$/;

/** The index of the `)` closing the `(` at `open` in blanked code, or the end of the code. */
function closingParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i;
  }
  return code.length;
}

/** Each `(` in blanked code, by index, with the index of the `)` closing it or the code's end. */
function parenPairs(code: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "(") open.push(i);
    else if (code[i] === ")") {
      const from = open.pop();
      if (from !== undefined) pairs.set(from, i);
    }
  }
  for (const from of open) pairs.set(from, code.length);
  return pairs;
}

const OPENS = "([{";
const CLOSES = ")]}";

/**
 * The top-level items of the bracketed list that `list`, blanked code, opens with: each trimmed,
 * with its offset in `list`. The list runs to its closing bracket, or to the end of `list`.
 */
function listItems(list: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let depth = 0;
  let from = 1;
  const item = (to: number) => {
    const raw = list.slice(from, to);
    const text = raw.trim();
    if (text !== "") out.push({ text, at: from + raw.length - raw.trimStart().length });
  };
  for (let i = 0; i < list.length; i++) {
    const c = list.charAt(i);
    if (OPENS.includes(c)) depth++;
    else if (CLOSES.includes(c) && --depth === 0) {
      item(i);
      return out;
    } else if (c === "," && depth === 1) {
      item(i);
      from = i + 1;
    }
  }
  item(list.length);
  return out;
}

/** Blanked code with each bracketed group's contents dropped: `f(a)[0]` is `f()[]`. */
function outline(text: string): string {
  let depth = 0;
  let out = "";
  for (const c of text) {
    if (OPENS.includes(c) && depth++ === 0) out += c;
    else if (CLOSES.includes(c) && --depth === 0) out += c;
    else if (depth === 0) out += c;
  }
  return out;
}

const isFunction = (shape: string) =>
  /^(?:async\s+)?function\b/.test(shape) ||
  /^(?:async\s*)?(?:\(\)\s*(?::[^=?]*)?|[\w$]+\s*)=>/.test(shape);

const NOTHING = /^(?:undefined|null)$/;
// A key in a literal object the scan can't read as a name: a spread, a computed key, or a quoted
// one, whose quotes are blanked; a getter's, a setter's or a method's included.
const UNREAD_KEY = /^(?:\.\.\.|(?:(?:get|set|async)\s*)?(?:\*\s*)?["'`[])/;

/**
 * Where in a start's argument `arg` options may be that the scan can't read: all of it, unless it
 * is a literal object, an array (the args), a function (the callback), undefined or null; in a
 * literal object, each key it can't read. Offsets are in `arg.text`.
 */
function unreadOptions(arg: { text: string }): number[] {
  const shape = outline(arg.text);
  if (shape === "{}") {
    return listItems(arg.text)
      .filter((entry) => UNREAD_KEY.test(entry.text))
      .map((entry) => entry.at);
  }
  return shape === "[]" || NOTHING.test(shape) || isFunction(shape) ? [] : [0];
}

/**
 * The arguments of a start Node may read its options from. `exec`'s second; for the others the
 * third, and the second too unless a third follows that may be the options, since Node takes a
 * second argument that isn't an array as the options, and `execFile(file, options, callback)`
 * takes undefined or null for the callback. Where a third may be the options, the second is
 * taken for the args: Node's types allow only an array there, so options in it, as in
 * `spawn(cmd, OPTS, undefined)`, need a cast past TypeScript.
 */
function optionSlots(start: string, args: { text: string; at: number }[]) {
  if (start === "exec" || start === "execSync") return args.slice(1, 2);
  const third = args[2] === undefined ? "" : outline(args[2].text);
  return third === "" || NOTHING.test(third) || isFunction(third)
    ? args.slice(1, 3)
    : args.slice(2, 3);
}

/** A start's arguments spread from a value, up to its last options slot: any may be the options. */
const spreadArguments = (start: string, args: { text: string; at: number }[]) =>
  args
    .slice(0, start === "exec" || start === "execSync" ? 2 : 3)
    .filter((arg) => arg.text.startsWith("..."));

/**
 * What a file binds to child_process's starts. `named` maps each name a call of which is a start
 * to the start: every start's own name, called bare, whether imported or not, then each import
 * alias and each name bound by `promisify`. `bound` holds the names this file binds itself, by
 * importing or promisifying a start; `modules` its default and namespace imports, `{ default as
 * cp }` included. `imports` spans each import the scan reads, and `promisified` is where each
 * `promisify` it resolves names the start it binds, and the name it binds it to unless exported.
 */
interface StartBindings {
  named: Map<string, string>;
  bound: Set<string>;
  modules: string[];
  imports: [number, number][];
  promisified: Set<number>;
}

function startBindings(code: string, kept: string): StartBindings {
  const named = new Map<string, string>(STARTERS.map((s) => [s, s]));
  const bound = new Set<string>();
  const modules: string[] = [];
  const imports: [number, number][] = [];
  for (const m of kept.matchAll(CHILD_PROCESS_IMPORT)) {
    if (code.slice(m.index, m.index + 6) !== "import") continue;
    imports.push([m.index, m.index + m[0].length]);
    for (const whole of [m[1], m[2], m[3]]) if (whole !== undefined) modules.push(whole);
    for (const spec of (m[4] ?? "").split(",")) {
      const [imported, local] = spec.trim().split(/\s+as\s+/);
      const start = imported?.replace(/^(["'])(.*)\1$/, "$2");
      if (start === "default" && local !== undefined) modules.push(local);
      if (start === undefined || !STARTERS.some((s) => s === start)) continue;
      named.set(local ?? start, start);
      bound.add(local ?? start);
    }
  }
  const module = modules.length > 0 ? `(?:${alternation(modules)})\\s*\\??\\.\\s*` : "";
  const promisify = new RegExp(
    `\\b(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*(?:\\w+\\s*\\.\\s*)?promisify\\s*\\(\\s*` +
      `((?:${module === "" ? NOT_MEMBER : `${module}|${NOT_MEMBER}`})` +
      `(${alternation(named.keys())}))\\s*\\)`,
    "dg",
  );
  const promisified = new Set<number>();
  for (const m of code.matchAll(promisify)) {
    const [local, start, name, at] = [m[1], m[3], m.indices?.[1]?.[0], m.indices?.[2]?.[0]];
    if (local === undefined || start === undefined || name === undefined || at === undefined)
      continue;
    named.set(local, named.get(start) ?? start);
    bound.add(local);
    promisified.add(at);
    // Exported, the name is called in files that don't bind it, where no call of it is read.
    if (!/\bexport\s+$/.test(code.slice(0, m.index))) promisified.add(name);
  }
  return { named, bound, modules, imports, promisified };
}

/** Each call of a start: by a name in `named`, or as a member of child_process imported whole. */
function startCalls({ named, modules }: StartBindings) {
  const bare = `${NOT_MEMBER}(${alternation(named.keys())})`;
  const member =
    modules.length === 0 ? "" : `|(?:${alternation(modules)})\\s*\\??\\.\\s*(${STARTER_NAME})`;
  return new RegExp(`(?:${bare}${member})${CALLED}`, "g");
}

/**
 * Each `timeout`, `killSignal` or `signal` key in a child_process start's arguments, and each
 * place its options aren't written out where the scan can read them: the start called bare or
 * through an import alias, as a member of child_process imported whole, or bound by `promisify`
 * to a name of its own. A wrapper taking a timeout of its own isn't a start; the kill it causes is
 * found where it calls Node. A declaration named for a start has parameters, not options.
 */
function startOptions(code: string, bindings: StartBindings) {
  const { named } = bindings;
  return [...code.matchAll(startCalls(bindings))].flatMap((call) => {
    const open = call.index + call[0].length - 1;
    const close = closingParen(code, open);
    const args = code.slice(open, close);
    const start = call[2] ?? named.get(call[1] ?? "") ?? "";
    const options = [...args.matchAll(START_OPTION)].map((option) => ({
      index: open + option.index,
      line: lineAt(code, open + option.index),
      call: `${option[1]} option of ${start}`,
    }));
    const declared =
      DECLARED_AFTER.test(code.slice(0, call.index)) && /^\s*[{:]/.test(code.slice(close + 1));
    if (declared) return options;
    const items = listItems(args);
    const spread = spreadArguments(start, items);
    // Past a spread no argument's slot is known, so the spread alone stands for the call.
    const unread =
      spread.length > 0
        ? spread.map((arg) => open + arg.at)
        : optionSlots(start, items).flatMap((arg) =>
            unreadOptions(arg).map((at) => open + arg.at + at),
          );
    return [
      ...options,
      ...unread.map((index) => ({
        index,
        line: lineAt(code, index),
        call: `options of ${start} not written inline`,
        unread: true as const,
      })),
    ];
  });
}

/**
 * Each place a start this file binds goes where the scan can't follow it to a call: a mention of
 * a bound name, or of child_process imported whole, that isn't a start's call, the `promisify`
 * that binds it, its import, a `typeof` or a key (`KEY_AFTER`); a start or `default` read as a member of child_process imported whole but not
 * called; and child_process named as a string anywhere but the source of an import the scan
 * reads. Through any of these a start can be called with options
 * no rule reads, `.call`, `Reflect.apply`, an alias, a seam object, `require` and `import()`
 * among them, so each is flagged rather than followed.
 */
function unfollowedStarts(code: string, kept: string, bindings: StartBindings) {
  const { named, bound, modules, imports, promisified } = bindings;
  const calls = new Set([...code.matchAll(startCalls(bindings))].map((m) => m.index));
  const imported = (index: number) => imports.some(([from, to]) => index >= from && index < to);
  const unfollowed = (index: number, call: string) => ({
    index,
    line: lineAt(code, index),
    call,
    unfollowed: true as const,
  });
  const names = [...bound, ...modules];
  const mentions =
    names.length === 0
      ? []
      : [...code.matchAll(new RegExp(`${NOT_MEMBER}(${alternation(names)})(?![\\w$])`, "g"))];
  const references = mentions.flatMap((m) => {
    const name = m[1] ?? "";
    const before = code.slice(0, m.index);
    const after = code.slice(m.index + name.length);
    const followed =
      calls.has(m.index) ||
      promisified.has(m.index) ||
      imported(m.index) ||
      /\btypeof\s+$/.test(before) ||
      (/^\s*[?!]?\s*:/.test(after) && KEY_AFTER.test(before));
    if (followed) return [];
    if (bound.has(name)) {
      const start = named.get(name) ?? name;
      return [
        unfollowed(
          m.index,
          `${name === start ? name : `${name} (${start})`} used other than in a call`,
        ),
      ];
    }
    const member = /^\s*\??\.\s*([\w$]+)/.exec(after)?.[1];
    if (member === undefined) return [unfollowed(m.index, `${name} used other than in a call`)];
    return member === "default" || STARTERS.some((s) => s === member)
      ? [unfollowed(m.index, `${name}.${member} used other than in a call`)]
      : [];
  });
  const loads = [...kept.matchAll(CHILD_PROCESS_NAMED)]
    .filter((m) => code[m.index] === kept[m.index] && !imported(m.index))
    .map((m) => ({
      ...unfollowed(m.index, "child_process named outside an import"),
      // Loaded, by `require`, `import()` or a re-export, it is no fixture's text.
      literal: !/\b(?:(?:require|import)\s*\(|from)\s*$/.test(
        code.slice(Math.max(0, m.index - 40), m.index),
      ),
    }));
  return [...references, ...loads];
}

const blank = (text: string) => text.replaceAll(/[^\n]/g, " ");

// After these, a `/` opens a regular expression rather than dividing: an operator, an opening
// bracket, a statement's end, or a keyword that takes an expression, though not a member named
// like one (`map.delete`). `<` is left out, as JSX's `</` closes a tag.
const REGEX_AFTER =
  /(?:[=(,:[&|?{};+\-*%>~^]|(?<!\.\s*)\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof))$/;
// How much of the code before a `/` is read, past its whitespace: only its end decides.
const LOOKBEHIND = 64;
/** Whether a `/` after `out`'s first `end` characters opens a regular expression. */
const opensRegex = (out: string, end = out.length): boolean => {
  let last = end;
  while (last > 0 && /\s/.test(out.charAt(last - 1))) last--;
  if (last === 0) return true;
  const before = out.slice(Math.max(0, last - LOOKBEHIND), last);
  const run = /(?:!+|\++|-+)$/.exec(before)?.[0] ?? "";
  if (run === "") return REGEX_AFTER.test(before.slice(-16));
  // A `!`, `++` or `--` straight after a value is postfix, a non-null assertion or an increment,
  // which a `/` after it divides; formatted code puts no space before one. Tokens are read longest
  // first, so an odd run of `+` or `-` ends in a binary or unary one.
  const rest = last - run.length;
  const prefix = rest === 0 || /\s/.test(out.charAt(rest - 1)) || opensRegex(out, rest);
  return prefix || (!run.startsWith("!") && run.length % 2 === 1);
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

const WORD = /[\p{L}\p{N}]/u;

/**
 * The index past the quote that closes a string opening at `at`, or -1 where none does. A string
 * can't run past its line unless a backslash continues it, and a quote between two letters or
 * digits is an apostrophe, as in JSX text: formatted code puts none there.
 */
function quoteEnd(source: string, at: number): number {
  if (WORD.test(source[at - 1] ?? "") && WORD.test(source[at + 1] ?? "")) return -1;
  for (let i = at + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i += source.startsWith("\r\n", i + 1) ? 2 : 1;
    else if (c === source[at]) return i + 1;
    else if (c === "\n" || c === "\r") return -1;
  }
  return -1;
}

/**
 * TypeScript with comments blanked, and with every string, template text and regular expression
 * literal's contents blanked unless `keepStrings`, character for character, so an index in one is
 * an index in the other and in the source. A template's substitutions, `${…}`, are code, read as
 * any other. A `/` opens a regular expression where the code before it can't be a value it
 * divides; JSX's `</` never does. A quote that closes no string on its line is read as code, so
 * one in JSX text hides nothing past its line. The lint rule, which reads the syntax tree, is the
 * check that needs no such reading.
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
    const quoted = c === '"' || c === "'" ? quoteEnd(source, i) : -1;
    if (c === "/" && (next === "/" || next === "*")) {
      const end = next === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2) + 2;
      i = end < start + 2 ? source.length : end;
      out += blank(source.slice(start, i));
    } else if (c === "/" && opensRegex(out) && regexEnd(source, i) > 0) {
      i = regexEnd(source, i);
      out += "/" + text(source.slice(start + 1, i - 1)) + source[i - 1];
    } else if (quoted > 0) {
      i = quoted;
      const body = source.slice(start + 1, i - 1);
      literals.push({ index: start, body });
      out += c + text(body) + c;
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
// What starts a program: Rust's Command, and Node's and host-guard's process starts.
const PROGRAM_START = String.raw`(?:Command\s*::\s*new|\b(?:spawn\w*|exec\w*|fork|runBounded|runIn\w*|output|run))`;
// What runs a program named by the literal that follows.
const STARTS_PROGRAM = new RegExp(String.raw`${PROGRAM_START}\s*\(\s*\[?\s*$`);
// A call of anything named like a process start, a member's included.
const STARTS_A_PROGRAM = new RegExp(PROGRAM_START + CALLED, "g");
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
   * Text that names kills or child_process and runs or loads none: it allows only a kill by a
   * command line and child_process named outside an import, and doesn't make its file one that
   * signals.
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
  "scripts/child-process.ts": [
    {
      code: /\bCHILD_PROCESS_MODULES = \["child_process", "node:child_process"\]/,
      at: /"child_process", "node:child_process"/,
      why: "the names the checks know child_process's imports by, which load nothing",
      fixture: true,
    },
  ],
  "scripts/lint-config.ts": [
    {
      code: /"tls",\s*"child_process",\s*"worker_threads",/,
      at: /"child_process"/,
      why: "a module a small test may not import, named in its ban, which loads nothing",
      fixture: true,
    },
    {
      code: /\.\.\.\["child_process", "module", "cluster", "worker_threads"\]/,
      at: /"child_process"/,
      why: "a module that starts processes, named where a wrapper must start them, which loads nothing",
      fixture: true,
    },
  ],
  "scripts/lint-config.test.ts": [
    {
      code: /banned\("scripts\/\*\*\/\*\.test\.ts"\)\.includes\("node:child_process"\)/,
      at: /"node:child_process"/,
      why: "a test that a small test's bans name child_process, which loads nothing",
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
      "ps, reading many processes' foreground groups or commands at once",
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
  "packages/runtime-holder/src/install.ts": [
    timedOut(
      /run\("ps", ps, \{ env: PS_ENV, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES \}\)/,
      "ps, listing the processes that run a holder build",
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
  "scripts/soak.ts": [
    timedOut(
      /execFileSync\("(?:ps|lsof)", \[[^\]]*\], \{\s*encoding: "utf8",\s*timeout: 5_000,\s*\}\)/,
      "ps and lsof, reading a soak's processes",
      2,
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
      /execFile\(\s*program,\s*args,\s*\{ env: \{ \.\.\.this\.env, BAZHEN_PORT: String\(this\.port\) \}, timeout: 30_000 \}/,
      "a second daemon, which should refuse to start",
    ),
    timedOut(/run\("codex", args, \{ env, timeout: 90_000 \}\)/, "the codex CLI"),
    timedOut(
      /run\("codex", \["app-server", "daemon", "stop"\], \{ env: this\.env, timeout: 90_000 \}\)/,
      "codex's own daemon stop",
    ),
  ],
  "tests/cli/cli.ts": [
    timedOut(/execFile\(file, args, \{ env, cwd, timeout: RUN_MS \}/, "the CLI under test"),
    timedOut(
      /spawn\(file, args, \{ env, cwd, timeout: RUN_MS \}/,
      "the CLI under test, left running",
    ),
  ],
};

/**
 * The literals that start a kill: a program sending one, or a shell or systemctl doing so. One
 * passed to a start is run here, so it is no fixture's text, though its file's are.
 */
function kills(
  literals: { index: number; body: string; cooked?: boolean | undefined }[],
  code: string,
) {
  const closes = parenPairs(code);
  const started = [...code.matchAll(STARTS_A_PROGRAM)].map((m) => {
    const open = m.index + m[0].length - 1;
    return [open, closes.get(open) ?? code.length] as const;
  });
  const literal = (index: number) => !started.some(([from, to]) => index > from && index < to);
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
      literal: literal(l.index),
    }));
  // A program and its arguments as literals in a row: systemctl's or loginctl's kill verbs,
  // fuser -k, or a launcher handed a kill program.
  literals.forEach((l, n) => {
    const next = literals.slice(n + 1, n + 5).map((a) => a.body);
    const hit = (call: string) =>
      out.push({ index: l.index, line: lineAt(code, l.index), call, literal: literal(l.index) });
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

/**
 * A signal found in a file. `unread` marks a start's options the scan can't read, which may set a
 * kill or not; `unfollowed` a start reached where the scan can't follow it to a call, or
 * child_process loaded where it can't see what is started. `literal` marks text that names a
 * kill or child_process, which a fixture may hold. `held` marks a raw Rust call named but not
 * called: brought in by a `use` or `extern crate`, or taken as a value, which a child module, the
 * file's tests, can reach by a name the scan doesn't read.
 */
type Signal = {
  index: number;
  line: number;
  call: string;
  literal?: boolean;
  unread?: boolean;
  unfollowed?: boolean;
  held?: Held;
};

type Held = "imported" | "a value";

/** Whether one of `allowed` lets `signal` through: a fixture lets only its text's, `literal`. */
const allows = (allowed: ReturnType<typeof allowedIn>, signal: Signal) =>
  allowed.some(
    ({ entry, spans }) =>
      (entry.fixture !== true || signal.literal === true) &&
      spans.some(([from, to]) => signal.index >= from && signal.index < to),
  );

const asCalls = (signals: Signal[]) =>
  signals
    .toSorted((a, b) => a.index - b.index)
    .map(({ line, call, unread, unfollowed, held }) => {
      if (unread === true) return { line, call, unread };
      if (held !== undefined) return { line, call, held };
      return unfollowed === true ? { line, call, unfollowed } : { line, call };
    });

/** Each raw signal call in a file, by line, whatever else the file is. */
export function rawSignalCalls(
  file: string,
  text: string,
): { line: number; call: string; unread?: true; unfollowed?: true; held?: Held }[] {
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
    const uses = [...code.matchAll(RUST_USE)].map((m) => [m.index, m.index + m[0].length]);
    const direct = found(code, RUST_RAW).map((d): Signal => {
      const imported =
        d.call.startsWith("extern") ||
        uses.some(([from = 0, to = 0]) => d.index >= from && d.index < to);
      const after = code.slice(d.index + d.call.length);
      // A syscall's number is a value by nature: it counts as called only as `syscall`'s first
      // argument.
      const called = d.call.startsWith("SYS_")
        ? /\bsyscall\s*\(\s*(?:\w+\s*::\s*)*$/.test(code.slice(0, d.index)) && /^\s*,/.test(after)
        : /^\s*(?:::\s*<[^<>]*>\s*)?\(/.test(after);
      if (imported) return { ...d, held: "imported" };
      return called ? d : { ...d, held: "a value" };
    });
    const imports = signalImports(code)
      .filter((u) => !direct.some((d) => d.index >= u.index && d.index < u.end))
      .map(({ index, line, call }): Signal => ({ index, line, call, held: "imported" }));
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
  const aliases = processAliases(code, kept).filter(({ index }) => inCode({ index }));
  const names = aliases.map(({ name }) => name);
  const viaAlias = names.flatMap((alias) => [
    ...found(code, new RegExp(`${tsName(alias)}\\s*\\??\\.\\s*(?:_?kill|abort)\\b`, "g")),
    ...found(
      kept,
      new RegExp(`${tsName(alias)}\\s*\\??\\.?\\s*\\[\\s*["'\`](?:_?kill|abort)["'\`]\\s*\\]`, "g"),
    ).filter(inCode),
  ]);
  const exported = [
    ...found(kept, PROCESS_REEXPORT).filter((m) => code.slice(m.index, m.index + 6) === "export"),
    ...processExports(code, names),
  ];
  const memberComputed = [...kept.matchAll(TS_MEMBER_KILL_COMPUTED)]
    .filter((m) => inCode(m) && !NOT_RECEIVERS.has(m[1] ?? ""))
    .map((m) => ({ index: m.index, line: lineAt(code, m.index), call: m[0] }));
  const starts = startBindings(code, kept);
  const allowed = allowedIn(file, kept);
  const seen = new Set<number>();
  const signals = [
    ...found(code, TS_KILL),
    ...found(code, TS_KILL_BOUND),
    ...imports,
    ...computed,
    ...viaAlias,
    ...exported,
    ...found(code, TS_MEMBER_KILL),
    ...memberComputed,
    ...found(code, TS_MEMBER_KILL_BOUND),
    ...found(code, /\bkillSignal\b/g),
    ...startOptions(code, starts),
    ...unfollowedStarts(code, kept, starts),
    ...kills(literals, code),
    ...fixtureStarts(code, starts, allowed),
  ].filter((m) => !seen.has(m.index) && seen.add(m.index));
  return { signals, allowed };
}

/**
 * Each start called in a fixture's text. A fixture runs nothing, and a start called there may run
 * a kill the fixture's literals hold, through a variable the scan doesn't follow.
 */
function fixtureStarts(code: string, starts: StartBindings, allowed: ReturnType<typeof allowedIn>) {
  const fixtures = allowed.flatMap(({ entry, spans }) => (entry.fixture === true ? spans : []));
  return [...code.matchAll(startCalls(starts))]
    .filter((m) => fixtures.some(([from, to]) => m.index >= from && m.index < to))
    .map((m): Signal => ({
      index: m.index,
      line: lineAt(code, m.index),
      call: `${m[1] ?? m[2] ?? "a start"} called in fixture text`,
    }));
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
    "signalPaneAt",
    "signalServerAt",
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
export const SIGNALS_IGNORE = "signals processes; runs in moon run :test-real -- rust";

/**
 * Whether a file holds tests that may signal processes they didn't start: Rust tests ignored as
 * signalling, and the holder and soak suites, whose holders signal whole sessions when they close.
 */
export function isSignallingTest(file: string, text: string): boolean {
  if (file.startsWith("tests/holder/") || file.startsWith("tests/soak/")) return true;
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
