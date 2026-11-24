// Repository standards that no linter covers (docs/standards/code.md, testing.md). Runs first in
// `moon run :check`; every failure names the file and the fix.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { MIGRATIONS, NUMBERED_MIGRATIONS } from "../apps/daemon/src/store/migrations.ts";
import { cssDeclarations } from "../apps/web/src/ui/token-sheet.ts";
import { gateEnv } from "./rust-gate.ts";
import { COUNTED_KILLS_FLAG } from "./capped.ts";
import { mergeBase } from "./falsify.ts";
import { isMain } from "./is-main.ts";
import {
  type Item,
  type Module,
  ModuleTable,
  pathBefore,
  type Resolution,
  typePaths,
  type UseBinding,
} from "./rust-modules.ts";
import { isIdent, itemEnd, newlinesIn, RUST_WHITESPACE, rustCode } from "./rust-source.ts";
import {
  SIGNALS_IGNORE,
  SIGNAL_CHOKEPOINTS,
  SIGNAL_CRATES,
  ALLOWED_SIGNALS,
  ENDS_WITHOUT_A_CALL,
  allowedSignalFailures,
  chokepointFor,
  chokepointReaches,
  rawSignalCalls,
} from "./signal-paths.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures: string[] = [];

// Source files whose behaviour is covered by a test somewhere other than a sibling file. Each
// entry names that test, and the check fails if it disappears.
const COVERED_ELSEWHERE: Record<string, string> = {
  "packages/runtime-tmux/src/index.ts": "tests/integration/tmux-runtime.test.ts",
  "scripts/child-process.ts": "scripts/signal-paths.test.ts",
  "packages/runtime-holder/src/runtime-stream.ts":
    "packages/runtime-holder/src/runtime.medium.test.ts",
  "packages/runtime-holder/src/title-watch.ts":
    "packages/runtime-holder/src/runtime.medium.test.ts",
  "apps/daemon/src/main.ts": "tests/e2e/health.spec.ts",
  "packages/protocol/src/semantics.ts": "scripts/protocol-schema.medium.test.ts",
  "apps/daemon/src/start.ts": "tests/api/cli.test.ts",
  "apps/daemon/src/detach.ts": "tests/api/cli.test.ts",
  "apps/daemon/src/store/migrations.ts": "apps/daemon/src/store/store.medium.test.ts",
  "apps/daemon/src/store/projections.ts": "apps/daemon/src/store/store.medium.test.ts",
  "apps/daemon/src/mailbox/ingress.ts": "tests/api/mail.test.ts",
  "apps/daemon/src/auth/agent-token.ts": "apps/daemon/src/auth/callers.test.ts",
  "apps/daemon/src/testing/fixtures.ts": "apps/daemon/src/mailbox/mailbox.medium.test.ts",
  "apps/daemon/src/testing/browser-terminal.ts": "apps/daemon/src/stream/snapshot-contract.test.ts",
  "apps/daemon/src/stream/screen-source.ts": "apps/daemon/src/stream/hub.test.ts",
  "apps/daemon/src/testing/fake-app-server.ts": "apps/daemon/src/codex/app-server.medium.test.ts",
  "apps/daemon/src/testing/full-backlog.ts": "apps/daemon/src/socket/probe.medium.test.ts",
  "packages/runtime-holder/src/testing/fake-holder.ts":
    "packages/runtime-holder/src/client.test.ts",
  "packages/runtime-tmux/src/testing/fake-tmux.ts":
    "packages/runtime-tmux/src/server-exit.medium.test.ts",
  "packages/core/src/environment.ts": "packages/env-local/src/index.test.ts",
  "packages/protocol/src/holder-fixtures.ts": "scripts/protocol-schema.medium.test.ts",
  "packages/core/src/testing/runtime-contract.ts": "packages/core/src/testing/fake-runtime.test.ts",
  "packages/core/src/testing/platform.ts": "packages/core/src/testing/fake-runtime.test.ts",
  "apps/web/src/App.tsx": "tests/e2e/health.spec.ts",
  "apps/web/src/main.tsx": "tests/e2e/health.spec.ts",
  "apps/web/src/api.ts": "tests/e2e/terminal.spec.ts",
  "apps/web/src/Dashboard.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/Pairing.tsx": "tests/e2e/pairing.spec.ts",
  "apps/web/src/fleet/AttachCommand.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/fleet/AgentRename.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/fleet/FleetList.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/fleet/Messages.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/fleet/Workspace.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/shells/Dock.tsx": "tests/e2e/shells.spec.ts",
  "apps/web/src/shells/action.ts": "tests/e2e/shells.spec.ts",
  "apps/web/src/shells/ShellsRail.tsx": "tests/e2e/shells.spec.ts",
  "apps/web/src/shells/ShellPane.tsx": "tests/e2e/shells.spec.ts",
  "apps/web/src/ui/Tabs.tsx": "tests/e2e/shells.spec.ts",
  "apps/web/src/inbox/Inbox.tsx": "tests/e2e/inbox.spec.ts",
  "apps/web/src/tasks/Tasks.tsx": "tests/e2e/tasks.spec.ts",
  "apps/web/src/fleet/ThemeNotice.tsx": "tests/e2e/terminal.spec.ts",
  "apps/web/src/ui/LiveStatus.tsx": "tests/e2e/keys.spec.ts",
  "apps/web/src/terminal/TerminalView.tsx": "tests/e2e/keys.spec.ts",
  "apps/web/src/terminal/scroll-input.ts": "tests/e2e/keys.spec.ts",
  "apps/web/src/terminal/KeyBar.tsx": "tests/e2e/keys.spec.ts",
  "apps/web/src/ui/ToggleButton.tsx": "tests/e2e/keys.spec.ts",
  "apps/web/src/ui/Toolbar.tsx": "tests/e2e/keys.spec.ts",
  "apps/web/src/ui/Button.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/ui/ConfirmDialog.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/ui/swatches.tsx": "tests/e2e/swatches.spec.ts",
  "apps/web/src/ui/ThemeSwitch.tsx": "tests/e2e/health.spec.ts",
};

/** Every file under `dir`, recursively, as repository-relative paths. */
function filesUnder(dir: string): string[] {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(root, rel)).isDirectory() ? filesUnder(rel) : [rel];
  });
}

const sourceFiles = (dir: string) =>
  filesUnder(dir).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts"),
  );

/** Removes comments, leaving string and template literals intact. */
function stripComments(js: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < js.length; i++) {
    const c = js[i] ?? "";
    if (quote !== "") {
      out += c;
      if (c === "\\") out += js[++i] ?? "";
      else if (c === quote) quote = "";
    } else if (c === "/" && js[i + 1] === "/") {
      while (i < js.length && js[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && js[i + 1] === "*") {
      const end = js.indexOf("*/", i + 2);
      i = end === -1 ? js.length : end + 1;
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
  }
  return out;
}

/**
 * True when the TypeScript source has code that runs, not just types and re-exports.
 *
 * `stripTypeScriptTypes` warns as experimental on Node 26, so the `check` script runs this file
 * with `--disable-warning=ExperimentalWarning`. Drop that flag once this call is replaced or the
 * API is stable.
 */
export function hasRuntimeCode(source: string): boolean {
  const code = stripComments(stripTypeScriptTypes(source))
    .replace(/^\s*export\s+(\*|\{[^}]*\})\s+from\s+["'][^"']+["'];?/gm, "")
    .replace(/^\s*export\s*\{\s*\};?/gm, "");
  return code.trim().length > 0;
}

const SIBLING_TESTS = [".test.ts", ".test.tsx", ".medium.test.ts", ".medium.test.tsx"];

function checkSiblingTests(): void {
  const dirs = readdirSync(join(root, "packages"))
    .map((p) => `packages/${p}/src`)
    .concat(readdirSync(join(root, "apps")).map((a) => `apps/${a}/src`))
    .concat(["scripts"]);
  for (const file of dirs.flatMap(sourceFiles)) {
    const covering =
      COVERED_ELSEWHERE[file] ??
      (file.startsWith(`${MIGRATIONS_DIR}/`) ? MIGRATIONS_TEST : undefined);
    if (covering !== undefined) {
      if (!existsSync(join(root, covering))) {
        failures.push(`${file}: its covering test ${covering} no longer exists.`);
      }
      continue;
    }
    if (!file.endsWith(".tsx") && !hasRuntimeCode(readFileSync(join(root, file), "utf8"))) {
      continue;
    }
    const stem = file.replace(/\.tsx?$/, "");
    if (!SIBLING_TESTS.some((ext) => existsSync(join(root, stem + ext)))) {
      failures.push(
        `${file}: has runtime code but no ${stem}.test.ts or .medium.test.ts beside it ` +
          "(docs/standards/testing.md). If another test covers it, add it to COVERED_ELSEWHERE " +
          "in scripts/check-standards.ts.",
      );
    }
  }
  for (const file of Object.keys(COVERED_ELSEWHERE)) {
    if (!existsSync(join(root, file))) {
      failures.push(`scripts/check-standards.ts: COVERED_ELSEWHERE lists missing ${file}.`);
    }
  }
}

// apps/web's screens use only its semantic tokens (docs/standards/ui.md); oxlint doesn't read CSS.
const PALETTE_CSS = "apps/web/src/ui/palette.css";
const TOKENS_CSS = "apps/web/src/ui/tokens.css";
const COLOUR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const HEX_COLOUR = /(#|%23)[0-9a-f]{3,8}\b/i;
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

// Forced colours (Windows High Contrast) is the one place a system colour belongs.
const SYSTEM_COLOURS = new Set(
  (
    "accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext " +
    "field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem " +
    "selecteditemtext visitedtext"
  ).split(" "),
);
const FORCED_COLOURS = "@media (forced-colors: active)";
const BORDER_STYLE = /\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/;
/** The token files, and the code that reads them and draws every token from their text. */
const TOKEN_FILES = new Set([
  PALETTE_CSS,
  TOKENS_CSS,
  "apps/web/src/ui/token-sheet.ts",
  "apps/web/src/ui/swatches.tsx",
]);
/**
 * The app icon, which the browser and the OS draw as an image outside any page, where no token
 * resolves. docs/standards/ui.md, under Adding a colour, names the palette steps it holds.
 */
const ICON_FILES = new Set(["apps/web/public/icon.svg"]);

/** The custom properties a stylesheet declares, wherever it declares them. */
export function declaredTokens(css: string): Set<string> {
  return new Set(
    cssDeclarations(css)
      .filter((d) => d.property.startsWith("--"))
      .map((d) => d.property.slice(2)),
  );
}

const wordsOf = (value: string) => value.toLowerCase().split(/[^a-z-]+/);

/** A var() naming anything but a declared token, a computed name included. */
const unknownVar = (value: string, tokens: Set<string>) =>
  [...value.matchAll(/var\(\s*--([^\s,)]*)/g)].some(([, n = ""]) => !tokens.has(n));

/** Whether a CSS value sets a colour of its own rather than naming a semantic token. */
function offTokenValue(value: string, tokens: Set<string>, forcedColours: boolean): boolean {
  const w = wordsOf(value);
  return (
    HEX_COLOUR.test(value) ||
    COLOUR_FUNCTION.test(value) ||
    w.some((x) => NAMED_COLOURS.has(x)) ||
    (!forcedColours && w.some((x) => SYSTEM_COLOURS.has(x))) ||
    unknownVar(value, tokens)
  );
}

/** Whether a string literal in a script or markup is, or carries, a colour of its own. */
function offTokenLiteral(literal: string, tokens: Set<string>): boolean {
  const w = wordsOf(literal.trim());
  const colourWord = w.some((x) => NAMED_COLOURS.has(x) || SYSTEM_COLOURS.has(x));
  return (
    HEX_COLOUR.test(literal) ||
    COLOUR_FUNCTION.test(literal) ||
    unknownVar(literal, tokens) ||
    (colourWord && (w.length === 1 || BORDER_STYLE.test(literal)))
  );
}

/**
 * Lines of a file in apps/web that go around the semantic tokens: a hex colour (`%23` in a data
 * URI too), a colour function, a named colour, a system colour outside forced colours, or a
 * `var()` naming anything but one of `tokens`. CSS is read declaration by declaration; scripts and
 * markup by their string literals and attribute values, so prose and comments don't count.
 */
export function offTokenLines(
  source: string,
  kind: "css" | "script",
  tokens: Set<string>,
): { line: number; text: string }[] {
  const lines = source.split("\n");
  if (kind === "css") {
    return cssDeclarations(source)
      .filter((d) => offTokenValue(d.value, tokens, d.within.includes(FORCED_COLOURS)))
      .map((d) => ({ line: d.line, text: `${d.property}: ${d.value}` }));
  }
  return lines.flatMap((text, i) =>
    [...text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].some(([, , literal = ""]) =>
      offTokenLiteral(literal, tokens),
    )
      ? [{ line: i + 1, text: text.trim() }]
      : [],
  );
}

function checkWebTokens(): void {
  const tokens = declaredTokens(readFileSync(join(root, TOKENS_CSS), "utf8"));
  const files = filesUnder("apps/web")
    .filter((f) => !/\/(node_modules|dist|dist-types)\//.test(f))
    .filter((f) => /\.(css|tsx?|html|svg)$/.test(f) && !/\.test\.tsx?$/.test(f));
  for (const file of files) {
    if (TOKEN_FILES.has(file) || ICON_FILES.has(file)) continue;
    const source = readFileSync(join(root, file), "utf8");
    const kind = file.endsWith(".css") ? "css" : "script";
    for (const { line, text } of offTokenLines(source, kind, tokens)) {
      failures.push(
        `${file}:${line}: \`${text}\` goes around the semantic tokens; use one ${TOKENS_CSS} ` +
          "defines, adding it there (mapped onto palette.css) if none fits (docs/standards/ui.md).",
      );
    }
  }
}

// Agent context is read on every session, so it stays short, and every path and command it names
// must exist: stale context misleads every agent that reads it.
const AGENTS_MAX_LINES = 60;
const CONTEXT_DOCS = [
  "AGENTS.md",
  "docs/standards/code.md",
  "docs/standards/testing.md",
  "docs/standards/review.md",
  "docs/standards/ui.md",
  "docs/standards/rust.md",
];
const PNPM_BUILTINS = new Set(["install", "exec", "add", "remove", "update"]);
// pnpm options that take a value as the next word; every other option is a bare flag.
const PNPM_VALUE_FLAGS = new Set(["--filter", "-F", "--dir", "-C", "--reporter", "--loglevel"]);
const LINT_RULE = /^(import|vitest|typescript|unicorn|react|react-hooks|eslint|bazhen)\//;
const PATH_LIKE = /^(\.?[\w@-]+\/)+[\w.@-]*$|^\.?[\w-]+\.(ts|tsx|md|json)$/;

/** A package.json's scripts, by name, read with `read`; the root one unless `file` says. */
function packageScripts(
  read: (path: string) => string,
  file = "package.json",
): Record<string, string> {
  const pkg: unknown = JSON.parse(read(file));
  const scripts =
    typeof pkg === "object" && pkg !== null && "scripts" in pkg ? pkg.scripts : undefined;
  if (typeof scripts !== "object" || scripts === null) return {};
  return Object.fromEntries(
    Object.entries(scripts).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
  );
}

/** The root package.json's scripts, and the moon tasks a person may run, by `project:task`. */
const menu = () => ({
  scripts: new Set(Object.keys(packageScripts((p) => readFileSync(join(root, p), "utf8")))),
  targets: publicTargets(moonTasks(repoFiles(), readRepoFile).tasks),
});

/** The text of every inline code span, and every whitespace-separated word in fenced blocks. */
function codeSpans(text: string): string[] {
  const spans: string[] = [];
  const prose = text.replace(/^ *```[^\n]*\n([\s\S]*?)^ *```[^\n]*$/gm, (_, body: string) => {
    for (const line of body.split("\n")) spans.push(line, ...line.split(/\s+/).filter(Boolean));
    return "";
  });
  for (const [, span = ""] of prose.matchAll(/`([^`\n]+)`/g)) spans.push(span);
  return spans;
}

/** Script names run by the `pnpm ...` commands in a code span, skipping options and values. */
export function pnpmScripts(span: string): string[] {
  const scripts: string[] = [];
  for (const [, rest = ""] of span.matchAll(/\bpnpm((?: +\S+)*)/g)) {
    const words = rest.trim().split(/ +/).filter(Boolean);
    let i = 0;
    while (words[i]?.startsWith("-")) {
      const flag = words[i] ?? "";
      i += PNPM_VALUE_FLAGS.has(flag) ? 2 : 1;
    }
    if (words[i] === "run") i++;
    while (words[i]?.startsWith("-")) i++;
    const script = words[i];
    if (script !== undefined && /^[\w:-]+$/.test(script)) scripts.push(script);
  }
  return scripts;
}

/** The targets of the `moon run ...` commands in a code span, up to the args after `--`. */
export function moonTargets(span: string): string[] {
  const targets: string[] = [];
  for (const [, rest = ""] of span.matchAll(/\bmoon run((?: +\S+)*)/g)) {
    for (const word of rest.trim().split(/ +/)) {
      if (word === "--") break;
      if (/^[\w-]*:[\w.-]+$/.test(word)) targets.push(word);
    }
  }
  return targets;
}

/** Whether `target`, as `moon run` takes it (`:task` in any project), names one of `targets`. */
export function isMoonTarget(target: string, targets: ReadonlySet<string>): boolean {
  if (!target.startsWith(":")) return targets.has(target);
  return [...targets].some((t) => t.endsWith(target));
}

/** Paths named in the code spans and fenced blocks of a Markdown document. */
export function pathCandidates(text: string): string[] {
  const paths = new Set<string>();
  for (const span of codeSpans(text)) {
    const candidate = span.replace(/:\d+$/, "");
    if (PATH_LIKE.test(candidate) && !LINT_RULE.test(candidate) && !candidate.startsWith("@")) {
      paths.add(candidate);
    }
  }
  return [...paths];
}

function checkContextFile(doc: string, { scripts, targets }: ReturnType<typeof menu>): void {
  const text = readFileSync(join(root, doc), "utf8");
  const named = new Set(codeSpans(text).flatMap(pnpmScripts));
  for (const script of named) {
    if (!PNPM_BUILTINS.has(script) && !scripts.has(script)) {
      failures.push(`${doc}: names \`pnpm ${script}\`, which is not a package.json script.`);
    }
  }
  for (const target of new Set(codeSpans(text).flatMap(moonTargets))) {
    if (!isMoonTarget(target, targets)) {
      failures.push(
        `${doc}: names \`moon run ${target}\`, which is not a moon task a person runs.`,
      );
    }
  }
  for (const candidate of pathCandidates(text)) {
    const local = join(root, doc, "..", candidate);
    if (!existsSync(join(root, candidate)) && !existsSync(local)) {
      failures.push(`${doc}: names \`${candidate}\`, which does not exist.`);
    }
  }
}

function checkAgentContext(): void {
  const named = menu();
  const agents = join(root, "AGENTS.md");
  if (!existsSync(agents)) {
    failures.push("AGENTS.md is missing.");
    return;
  }
  const lines = readFileSync(agents, "utf8").trimEnd().split("\n").length;
  if (lines > AGENTS_MAX_LINES) {
    failures.push(
      `AGENTS.md is ${lines} lines (budget ${AGENTS_MAX_LINES}). Keep only what an agent cannot ` +
        "discover or would otherwise get wrong; move rationale to docs/standards/.",
    );
  }
  const claude = join(root, "CLAUDE.md");
  if (!existsSync(claude) || readFileSync(claude, "utf8").trim() !== "@AGENTS.md") {
    failures.push(
      "CLAUDE.md must contain only `@AGENTS.md`: Claude Code skips AGENTS.md otherwise.",
    );
  }
  for (const doc of CONTEXT_DOCS) {
    if (existsSync(join(root, doc))) checkContextFile(doc, named);
    else failures.push(`${doc} is missing.`);
  }
}

// The modules that may hold `unsafe` code, each with why it must (docs/standards/rust.md § Unsafe).
// Each may set `#![expect(unsafe_code, reason = "...")]`, and nothing else in crates/ may.
const UNSAFE_MODULES: Record<string, string> = {
  "crates/bazhen-daemon/src/session.rs":
    "Command::pre_exec, to make the detached daemon a session leader between fork and exec, as " +
    "Node's detached does, so no signal to the starting terminal reaches it; std's process_group " +
    "would leave it a group leader, which can't then call setsid",
  "crates/bazhen-holder/src/linux.rs":
    "a raw pidfd_send_signal syscall, the one way to send signal 0, which sends nothing, through " +
    "a pidfd, so the holder learns at start whether it may send through one; rustix's takes " +
    "only a real signal",
  "crates/bazhen-holder/src/pty.rs":
    "Command::pre_exec, to make the child a session leader on its PTY between fork and exec, and " +
    "libc's sigprocmask and signal there, to give it an empty signal mask and default " +
    "dispositions; libc's sigprocmask in the holder itself, to unblock the signals its loop " +
    "wakes on; and libc's fcntl and close, for the fds the holder inherited, which no Rust " +
    "value owns; rustix covers none of them",
  "crates/bazhen-holder/src/macos.rs":
    "libc's sysctl(KERN_PROC_PID), the one call that says when a macOS process started, a zombie " +
    "included, which ps reads too, sysctl(KERN_PROC_ALL), which lists every process, and " +
    "sysctl(KERN_PROCARGS2), which names a process's arguments; proc_pidinfo, which names " +
    "another process's parent and user; rustix covers neither. rustix's kevent, which watches a " +
    "process for its exit before a close signals it, is unsafe",
  "crates/bazhen-pid/src/sys.rs":
    "libc's getsid and getpgid, since rustix's getsid, getpgid and getpgrp build a non-zero Pid " +
    "from the kernel's answer, which is 0 for a leader outside this process's PID namespace; " +
    "libc's getsockopt(SO_PEERCRED) on Linux, since rustix's socket_peercred builds one from the " +
    "0 the kernel answers for a peer outside it, and std's peer_cred is unstable; and on macOS " +
    "getpeereid and getsockopt's LOCAL_PEERPID, which name a socket peer's user and process, " +
    "which rustix doesn't cover; and libc's sigaction, the one call that gives SIGCHLD its " +
    "default disposition with no SA_NOCLDWAIT, so the kernel keeps a daemon's exited children " +
    "for it to wait for, and reads back whether it does; rustix covers neither",
};

/** The index just past the `]` that closes the `[` at `open`, or the end of `code`. */
function closingBracket(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "[") depth++;
    else if (code[i] === "]" && --depth === 0) return i + 1;
  }
  return code.length;
}

// The cfg predicates code may be compiled under, each with why: the gates build every one of
// them, so no lint or test misses code behind it. A predicate they don't build (release-only,
// another OS, a feature turned off) hides the code from both, and `not` (as in `not(test)`) hides
// it from the tests.
const CFG_ALLOWED: Record<string, string> = {
  test: "nextest and clippy's --all-targets build the test configuration",
  feature:
    "bazhen-holder's sandbox-tripwire, and the protocol crates' schema, are each on in every " +
    "test build, by the crate's dev-dependency on itself, which the workspace's clippy and " +
    "nextest build; and off in the crate as it ships, which lint checks too, in each crate's " +
    "as-shipped pass (`alone_as_shipped` in crates/bazhen-xtask/src/gate.rs). CFG_VALUES holds " +
    "it to those two",
  target_os:
    "`check` builds Linux and `rust-macos` builds macOS, each running clippy and nextest; " +
    "CFG_VALUES holds it to those two",
};

// The values a CFG_ALLOWED key that takes one may be given: only those a gate builds.
const CFG_VALUES: Record<string, readonly string[]> = {
  target_os: ["linux", "macos"],
  feature: ["sandbox-tripwire", "schema"],
};

/** The predicate of a cfg or cfg_attr attribute, or undefined for any other attribute. */
function cfgPredicate(body: string): string | undefined {
  const cfg = /^cfg(_attr)?\s*\(/.exec(body);
  if (cfg === null) return undefined;
  let predicate = body.slice(cfg[0].length);
  if (cfg[1] !== undefined) {
    for (let i = 0, depth = 0; i < predicate.length; i++) {
      depth += predicate[i] === "(" ? 1 : predicate[i] === ")" ? -1 : 0;
      if (predicate[i] === "," && depth === 0) {
        predicate = predicate.slice(0, i);
        break;
      }
    }
  }
  return predicate;
}

/** The predicates of a cfg or cfg_attr attribute that aren't in CFG_ALLOWED. */
export function cfgOutsideAllowList(body: string): string[] {
  const atoms = cfgPredicate(body)?.match(/\b[A-Za-z_]\w*\b/g) ?? [];
  return [...new Set(atoms)].filter((a) => !["all", "any"].includes(a) && !(a in CFG_ALLOWED));
}

/**
 * The values a cfg or cfg_attr attribute gives a CFG_VALUES key that aren't on its list, anywhere
 * in it, a cfg nested in a cfg_attr included. `body` is the attribute as rustCode gives it, with
 * comments gone and each string `""`, and `strings` the contents of those strings, in order. A use
 * of the key that isn't `key = "value"` counts as outside the list.
 */
export function cfgValuesOutsideAllowList(body: string, strings: readonly string[]): string[] {
  if (cfgPredicate(body) === undefined) return [];
  const out: string[] = [];
  for (const [key, allowed] of Object.entries(CFG_VALUES)) {
    const uses = body.match(new RegExp(`\\b${key}\\b`, "g"))?.length ?? 0;
    const given = [...body.matchAll(new RegExp(`\\b${key}\\s*=\\s*""`, "g"))].map((m) => {
      const nth = body.slice(0, m.index + m[0].length).match(/""/g)?.length ?? 0;
      return strings[nth - 1] ?? "";
    });
    out.push(...given.filter((v) => !allowed.includes(v)).map((v) => `${key} = "${v}"`));
    if (given.length !== uses) out.push(`${key} written other than as ${key} = "..."`);
  }
  return out;
}

const UNSAFE_EXPECT = /^expect\s*\(\s*unsafe_code\s*,\s*reason\s*=\s*""\s*,?\s*\)$/;
const SEE_RUST_MD = "(docs/standards/rust.md § Lints).";

// How a test ignored as signalling processes starts: by refusing to run off a sandbox.
const REQUIRES_SANDBOX =
  /^\s*bazhen_test_signal\s*::\s*require_sandbox\s*\(\s*\)\s*(?:\.\s*unwrap\s*\(\s*\)|\?)\s*;/;

/**
 * Where the body of the first `fn` at or after `from` begins: just past its `{`, or, for a
 * function declared without one (`fn f(&self);` in a trait), just past its `;`, with no body.
 * The end of `code` if there is none.
 */
function fnBodyStart(code: string, from: number): number {
  const fn = /\bfn\s+\$?\w+/g;
  fn.lastIndex = from;
  const found = fn.exec(code);
  if (found === null) return code.length;
  let depth = 0;
  for (let i = found.index + found[0].length; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "]" || (c === ">" && code[i - 1] !== "-")) depth--;
    else if (depth <= 0 && (c === "{" || c === ";")) return i + 1;
  }
  return code.length;
}

/**
 * Why the attributes in a Rust file don't hold to the standard. Every `#` must begin an attribute
 * written out in full, so a macro can't assemble one from tokens no scan reads; no attribute may
 * allow or expect a lint, but an unsafe module's `#![expect(unsafe_code)]`; and no code may come
 * from a file the scan doesn't read (`include!`, `#[path]`).
 */
export function attributeFailures(
  file: string,
  source: string,
  unsafeModules: Record<string, string>,
): string[] {
  const strings: string[] = [];
  const code = rustCode(source, strings);
  const out: string[] = [];
  const at = (i: number) => `${file}:${code.slice(0, i).split("\n").length}`;
  for (let i = code.indexOf("#"); i !== -1; i = code.indexOf("#", i + 1)) {
    if (code[i - 1] === "r" && !isIdent(code[i - 2]) && isIdent(code[i + 1])) continue;
    const head = /^#\s*(!?)\s*\[/.exec(code.slice(i));
    if (head === null) {
      out.push(
        `${at(i)}: a \`#\` that doesn't begin an attribute, as a macro building one from tokens ` +
          `writes it. Write the attribute out in full ${SEE_RUST_MD}`,
      );
      continue;
    }
    const end = closingBracket(code, i + head[0].length - 1);
    const body = code.slice(i + head[0].length, end - 1).trim();
    const where = at(i);
    const attribute = `#${head[1]}[${body.replaceAll(/\s+/g, " ")}]`;
    const first = code.slice(0, i + head[0].length).match(/""/g)?.length ?? 0;
    const values = cfgValuesOutsideAllowList(body, strings.slice(first));
    i = end - 1;
    if (body.includes("$")) {
      out.push(
        `${where}: ${attribute} is built by a macro, so it could carry a lint suppression no check ` +
          `sees. Write the attribute out ${SEE_RUST_MD}`,
      );
    } else if (/\bpath\s*=/.test(body)) {
      out.push(
        `${where}: ${attribute} loads a module from a path the checks don't read. Put the module ` +
          "where Rust looks for it by default.",
      );
    } else if (/\b(allow|expect)\b/.test(body)) {
      const allowed = file in unsafeModules && head[1] === "!" && UNSAFE_EXPECT.test(body);
      if (!allowed) {
        out.push(
          `${where}: ${attribute} suppresses a lint. Fix the code instead; the only exceptions are ` +
            "the workspace allow-list in Cargo.toml and an unsafe module's " +
            "#![expect(unsafe_code)] (UNSAFE_MODULES in scripts/check-standards.ts, " +
            "docs/standards/rust.md).",
        );
      }
    } else if (cfgOutsideAllowList(body).length > 0) {
      out.push(
        `${where}: ${attribute} compiles code only under ${cfgOutsideAllowList(body).join(", ")}, ` +
          "which the gates never build, so no lint or test reads it. Use a cfg in CFG_ALLOWED in " +
          `scripts/check-standards.ts, or add one there with why ${SEE_RUST_MD}`,
      );
    } else if (values.length > 0) {
      out.push(
        `${where}: ${attribute} compiles code only under ${values.join(", ")}, which no gate ` +
          "builds. Use a value in CFG_VALUES in scripts/check-standards.ts, or add a gate that " +
          `builds it ${SEE_RUST_MD}`,
      );
    } else if (
      head[1] === "" &&
      /^ignore\s*=\s*""$/.test(body) &&
      strings[first] === SIGNALS_IGNORE
    ) {
      // A test that signals processes it didn't start: skipped on the host, and run in a sandbox
      // by `cargo xtask gate test-all` (scripts/signal-paths.ts). It refuses to run anywhere else
      // itself, so the attribute can't serve as a plain way to switch a test off.
      if (!REQUIRES_SANDBOX.test(code.slice(fnBodyStart(code, end)))) {
        out.push(
          `${where}: a test ignored as "${SIGNALS_IGNORE}" must start with ` +
            "`bazhen_test_signal::require_sandbox().unwrap();`, so a run off a sandbox fails " +
            "instead of signalling anything (docs/standards/testing.md).",
        );
      }
    } else if (/(?:^|,)\s*(ignore|should_panic)\b/.test(body)) {
      out.push(
        `${where}: ${attribute} skips a test, or passes it when it fails. A test runs, and fails ` +
          "on what it asserts; check an error with a Result, not a panic. The one exception is " +
          `#[ignore = "${SIGNALS_IGNORE}"] (docs/standards/testing.md).`,
      );
    } else if (/\bclippy\b/.test(body)) {
      out.push(
        `${where}: ${attribute} hides code from clippy or changes how it lints. Clippy reads ` +
          `all of the code, under the workspace's lints ${SEE_RUST_MD}`,
      );
    }
  }
  for (const m of code.matchAll(/\binclude\b|\$\s*\w+\s*!/g)) {
    out.push(
      `${at(m.index)}: \`${m[0]}\` brings in code the checks don't read, or a macro the scan ` +
        "can't name. Write the code in a module of the crate.",
    );
  }
  return out;
}

// The modules that may define a macro_rules! macro, each with why. Clippy doesn't lint inside a
// macro's expansion, so a macro of ours wrapping `.unwrap()` hides it from `unwrap_used`; a macro
// here is one a review has read.
const MACRO_MODULES: Record<string, string> = {};

/** A macro of another crate whose expansion a review read: the crates read, at their versions. */
export interface ForeignMacro {
  /** Each crate whose source was read, by name: the version, and its crates.io checksum. */
  read: Record<string, { version: string; checksum: string }>;
  reason: string;
}

// The macros of other crates the decoder rule trusts to write no impl, by path, each held to the
// versions of the crates whose source was read. Any other macro may write an impl of a trait for a
// type of ours that wins a call the rule would clear, so it takes every type to answer any name. A
// version Cargo.lock moves off fails until the expansion is read again at the new one.
const FOREIGN_MACROS: Record<string, ForeignMacro> = {
  "tracing::debug": {
    read: {
      tracing: {
        version: "0.1.44",
        checksum: "63e71662fa4b2a2c3a26f570f037eb95bb1f85397f3cd8076caed2f026a6d100",
      },
      "tracing-core": {
        version: "0.1.36",
        checksum: "db97caf9d906fbde555dd62fa95ddba9eecfd14cb388e4f491a66d74cd5fb79a",
      },
    },
    reason:
      "read tracing@0.1.44 src/macros.rs and tracing-core@0.1.36 src/lib.rs (metadata!, " +
      "identify_callsite!): expansion writes no impl",
  },
  "tracing::error": {
    read: {
      tracing: {
        version: "0.1.44",
        checksum: "63e71662fa4b2a2c3a26f570f037eb95bb1f85397f3cd8076caed2f026a6d100",
      },
      "tracing-core": {
        version: "0.1.36",
        checksum: "db97caf9d906fbde555dd62fa95ddba9eecfd14cb388e4f491a66d74cd5fb79a",
      },
    },
    reason:
      "read tracing@0.1.44 src/macros.rs and tracing-core@0.1.36 src/lib.rs (metadata!, " +
      "identify_callsite!): expansion writes no impl",
  },
  "tracing::info": {
    read: {
      tracing: {
        version: "0.1.44",
        checksum: "63e71662fa4b2a2c3a26f570f037eb95bb1f85397f3cd8076caed2f026a6d100",
      },
      "tracing-core": {
        version: "0.1.36",
        checksum: "db97caf9d906fbde555dd62fa95ddba9eecfd14cb388e4f491a66d74cd5fb79a",
      },
    },
    reason:
      "read tracing@0.1.44 src/macros.rs and tracing-core@0.1.36 src/lib.rs (metadata!, " +
      "identify_callsite!): expansion writes no impl",
  },
  "tracing::warn": {
    read: {
      tracing: {
        version: "0.1.44",
        checksum: "63e71662fa4b2a2c3a26f570f037eb95bb1f85397f3cd8076caed2f026a6d100",
      },
      "tracing-core": {
        version: "0.1.36",
        checksum: "db97caf9d906fbde555dd62fa95ddba9eecfd14cb388e4f491a66d74cd5fb79a",
      },
    },
    reason:
      "read tracing@0.1.44 src/macros.rs and tracing-core@0.1.36 src/lib.rs (metadata!, " +
      "identify_callsite!): expansion writes no impl",
  },
  "tokio::select": {
    read: {
      tokio: {
        version: "1.54.1",
        checksum: "b52fd3255258d26fac7264ab5a76b53c13367136dc011d3d6ad4f8ed070396a3",
      },
      "tokio-macros": {
        version: "2.7.2",
        checksum: "78773a2a397f451582ce068015985c33193cf6dea8b74d2a639fe457b2f07b0e",
      },
    },
    reason:
      "read tokio@1.54.1 src/macros/select.rs and tokio-macros@2.7.2 src/select.rs (an enum " +
      "and a type alias): expansion writes no impl",
  },
  "serde_json::json": {
    read: {
      serde_json: {
        version: "1.0.154",
        checksum: "e7e9cc8b1b85264074fbcc02a88680c4096b1e47df8f739dceb03bf482f04bd6",
      },
    },
    reason:
      "read serde_json@1.0.154 src/macros.rs (json!, json_internal!): expansion writes no impl",
  },
  "schemars::json_schema": {
    read: {
      schemars: {
        version: "1.2.3",
        checksum: "ab508826f74a77ca9d5aba6ff19b522583ee3eaf28a19384ff3d0e5835fadf6e",
      },
      serde_json: {
        version: "1.0.154",
        checksum: "e7e9cc8b1b85264074fbcc02a88680c4096b1e47df8f739dceb03bf482f04bd6",
      },
    },
    reason:
      "read schemars@1.2.3 src/macros.rs (json_schema!, whose unwrap can't fire: its `{…}` arm " +
      "always builds an object, and Schema::try_from in src/schema.rs fails only on a value that " +
      "is neither an object nor a bool) and serde_json@1.0.154 src/macros.rs (json!, " +
      "json_internal!, which it calls as schemars::_private::serde_json::json!): expansion " +
      "writes no impl",
  },
  "clap::value_parser": {
    read: {
      clap: {
        version: "4.6.7",
        checksum: "aa8876b300ab35ba921adea3dfd70157a46249b33f95c9084ae5709785478946",
      },
      clap_builder: {
        version: "4.6.7",
        checksum: "ec0797fb7aeb1406c84efac526901f7ec3ead2124f946b494e72879d4b54704d",
      },
    },
    reason:
      "read clap@4.6.7 src/lib.rs (pub use clap_builder::*) and clap_builder@4.6.7 " +
      "src/builder/value_parser.rs (value_parser!, a block of a use and a call): expansion " +
      "writes no impl",
  },
};

/** Why a file outside MACRO_MODULES may not define a macro. */
export function macroFailures(
  file: string,
  source: string,
  macroModules: Record<string, string>,
): string[] {
  const code = rustCode(source);
  const at = (i: number) => `${file}:${code.slice(0, i).split("\n").length}`;
  return file in macroModules
    ? []
    : [...code.matchAll(/\bmacro_rules\s*!/g)].map(
        (m) =>
          `${at(m.index)}: defines a macro, inside which clippy doesn't lint, so a macro can ` +
          "hide what it would flag. Write the code out, or list the module in MACRO_MODULES in " +
          "scripts/check-standards.ts with why (docs/standards/rust.md § Lints).",
      );
}

// Every function in crates/ that takes bytes from outside (a slice, a buffer or a reader), or reads
// them in its body (from a socket, a file or stdin), is a decoder until it is shown not to be:
// listed here with the fuzz target that drives it, or in NOT_DECODERS with why it isn't one
// (docs/standards/rust.md § Tests). A decoder of text from outside is listed here by hand, as
// pane_title's body is: the rule can't tell such text apart. A target is
// crates/<crate>/fuzz/fuzz_targets/<target>.rs, and must call the function.
const FUZZED_DECODERS: Record<string, string> = {
  "crates/bazhen-client/src/framing.rs::reply_end": "framing",
  "crates/bazhen-client/src/framing.rs::Framing::end_of": "framing",
  "crates/bazhen-client/src/framing.rs::is_truncated": "framing",
  "crates/bazhen-client/src/framing.rs::split_head": "framing",
  "crates/bazhen-client/src/framing.rs::header": "framing",
  "crates/bazhen-client/src/framing.rs::headers": "framing",
  "crates/bazhen-client/src/framing.rs::content_length": "framing",
  "crates/bazhen-client/src/framing.rs::status": "framing",
  "crates/bazhen-client/src/framing.rs::body": "framing",
  "crates/bazhen-core/src/role_file.rs::parse_role": "parse_role",
  "crates/bazhen-daemon/src/channel/rpc.rs::decode": "rpc_frame",
  "crates/bazhen-harness/src/claude_code/mod.rs::ClaudeCode::ingest": "ingest",
  "crates/bazhen-harness/src/codex/mod.rs::Codex::ingest": "codex_ingest",
  "crates/bazhen-hook/src/lib.rs::parse_reply": "parse_reply",
  "crates/bazhen-hook/src/lib.rs::is_late": "parse_reply",
  "crates/bazhen/src/reply.rs::decode": "reply",
  "crates/bazhen/src/attach/attachment.rs::Attachment::keys": "attach",
  "crates/bazhen/src/attach/attachment.rs::Attachment::frame": "attach",
  "crates/bazhen/src/attach/attachment.rs::DetachScan::new": "attach",
  "crates/bazhen/src/attach/attachment.rs::DetachScan::scan": "attach",
  "crates/bazhen/src/attach/attachment.rs::Attachment::new": "attach",
  "crates/bazhen/src/attach/direct.rs::Direct::new": "attach",
  "crates/bazhen/src/attach/direct.rs::Direct::keys": "attach",
  "crates/bazhen-protocol/src/wire.rs::well_formed": "wire",
  "crates/bazhen-protocol/src/wire.rs::from_slice": "wire",
  "crates/bazhen-protocol/src/edge.rs::edge": "edge",
  "crates/bazhen-protocol/src/edge.rs::is_object": "edge",
  "crates/bazhen-protocol/src/edge.rs::object": "edge",
  "crates/bazhen-protocol/src/input.rs::has_keystrokes": "input",
  "crates/bazhen-protocol/src/input.rs::without_replies": "input",
  "crates/bazhen-protocol/src/detach_keys.rs::DetachKeys::bytes": "detach_keys",
  "crates/bazhen-hook/src/pane_title.rs::body": "pane_title",
  "crates/bazhen-store/src/events.rs::StoredEvent::frame": "frame",
  "crates/bazhen-daemon/src/stream/said.rs::read": "stream_frame",
  "crates/bazhen-daemon/src/tasks.rs::asked": "tasks",
  "crates/bazhen-hook/src/shell_report.rs::report_body": "shell_report",
  "crates/bazhen-hook/src/shell_report.rs::micros": "shell_report",
  "crates/bazhen-holder-proto/src/frame.rs::FrameDecoder::push": "frame",
  "crates/bazhen-holder-proto/src/frame.rs::FrameDecoder::next_frame": "frame",
  "crates/bazhen-holder-proto/src/lib.rs::decode_spawn_spec": "spawn_spec",
  "crates/bazhen-holder-engine/src/lib.rs::Engine::advance": "advance",
  "crates/bazhen-holder-engine/src/replies.rs::replies_are_whole": "advance",
  "crates/bazhen-holder/src/start_time.rs::epoch_seconds": "proc_stat",
  "crates/bazhen-holder/src/start_time.rs::start_ticks": "proc_stat",
  "crates/bazhen-holder/src/start_time.rs::boot_time": "proc_stat",
  "crates/bazhen-holder/src/rss.rs::resident_pages": "proc_stat",
  "crates/bazhen-holder/src/start_time.rs::stat_field": "proc_stat",
  "crates/bazhen-holder/src/start_time.rs::own_pid": "proc_stat",
  "crates/bazhen-host-guard/src/scope.rs::parse_probe": "containment",
  "crates/bazhen-host-guard/src/scope.rs::systemd_version": "containment",
  "crates/bazhen-host-guard/src/scope.rs::cgroup_of": "containment",
  "crates/bazhen-host-guard/src/scope.rs::mem_total": "containment",
  "crates/bazhen-host-guard/src/scope.rs::memory_max_refusal": "containment",
  "crates/bazhen-host-guard/src/scope.rs::swap_max_refusal": "containment",
  "crates/bazhen-host-guard/src/scope.rs::is_terminal_scope": "containment",
  "crates/bazhen-holder/src/start_time.rs::parent_field": "proc_stat",
  "crates/bazhen-holder/src/start_time.rs::session_field": "proc_stat",
  "crates/bazhen-holder/src/start_time.rs::has_exited": "proc_stat",
  "crates/bazhen-holder/src/session.rs::member_state": "proc_stat",
  "crates/bazhen-holder/src/process.rs::status_uid": "proc_args",
  "crates/bazhen-holder/src/process.rs::status_credentials": "proc_args",
  "crates/bazhen-holder/src/process.rs::cmdline_args": "proc_args",
  "crates/bazhen-holder/src/process.rs::procargs2_args": "proc_args",
  "crates/bazhen-holder/src/process.rs::procargs2_env": "proc_args",
  "crates/bazhen-daemon/src/config.rs::parse_config": "config",
};
const NOT_DECODERS: Record<string, string> = {
  "crates/bazhen-harness/src/js.rs::Js::parse":
    "scans its text once for escapes and nesting, then hands it to serde_json's parser, whose values its visitor only collects; reached from a hook's payload through ClaudeCode::ingest, which the ingest target fuzzes, and the same way from a Claude Code settings file's text and each transcript line is_conversation_entry reads through scan_transcript",
  "crates/bazhen-harness/src/lib.rs::ingest":
    "Harness::ingest's declaration, with no body: each adapter's implementation is listed with its own fuzz target",
  "crates/bazhen-harness/src/lib.rs::route":
    "Session::route's declaration, with no body: each adapter's implementation is listed with its own fuzz target",
  "crates/bazhen-daemon/src/devices.rs::token_of":
    "encodes random bytes the daemon read itself as base64url; parses nothing",
  "crates/bazhen-daemon/src/paired.rs::dismiss":
    "reads its body only as serde_json's derive for DismissNoticeRequest, one string field, refusing anything else whole",
  "crates/bazhen-daemon/src/pairing.rs::code_from":
    "maps random bytes the daemon read itself to the code's letters; parses nothing",
  "crates/bazhen-daemon/src/pairing.rs::random_bytes":
    "reads a fixed count of bytes from /dev/urandom and hands them back; parses nothing",
  "crates/bazhen-daemon/src/pairing.rs::PairingCodes::issue_from":
    "hands random bytes the daemon read itself to code_from; parses nothing",
  "crates/bazhen-daemon/src/events.rs::stream":
    "splits the socket for over; decodes nothing itself. follow reads a client's frames only once tungstenite has bounded them to 1 KiB, and only as serde's derive for a tag and a bool, dropping each either way",
  "crates/bazhen-daemon/src/routes.rs::create_task":
    "hands its body to tasks::asked, which its tasks target fuzzes; decodes nothing itself",
  "crates/bazhen-daemon/src/shell_routes.rs::parsed":
    "reads a request body only as serde_json's derive for the shell request it names, refusing anything else whole",
  "crates/bazhen-daemon/src/shell_routes.rs::open_request":
    "hands its body to parsed, then checks the fields serde_json's derive gave it; reads no bytes itself",
  "crates/bazhen-daemon/src/shell_routes.rs::close_request":
    "hands its body to parsed, then checks the fields serde_json's derive gave it; reads no bytes itself",
  "crates/bazhen-daemon/src/shell_routes.rs::restart_request":
    "hands its body to parsed, then checks the fields serde_json's derive gave it; reads no bytes itself",
  "crates/bazhen-daemon/src/shell_routes.rs::rename_request":
    "hands its body to parsed, then checks the name serde_json's derive gave it; reads no bytes itself",
  "crates/bazhen-daemon/src/shell_routes.rs::open":
    "hands its body to open_request; decodes nothing itself",
  "crates/bazhen-daemon/src/shell_routes.rs::close":
    "hands its body to close_request; decodes nothing itself",
  "crates/bazhen-daemon/src/shell_routes.rs::restart":
    "hands its body to restart_request; decodes nothing itself",
  "crates/bazhen-daemon/src/shell_routes.rs::rename":
    "hands its body to rename_request; decodes nothing itself",
  "crates/bazhen-daemon/src/shell_routes.rs::reported":
    "reads a body only as serde_json's derive for the shell report it names, then holds it to its bounds; refuses anything else whole",
  "crates/bazhen-daemon/src/shell_routes.rs::report":
    "hands its body to reported; decodes nothing itself",
  "crates/bazhen-daemon/src/shell_routes.rs::prompt":
    "hands its body to reported; decodes nothing itself",
  "crates/bazhen-daemon/src/shell_routes.rs::decline":
    "hands its body to reported; decodes nothing itself",
  "crates/bazhen-daemon/src/web.rs::page":
    "reads only the request's method and path, never its body; the file bytes look hands back go to the response as they are, unparsed",
  "crates/bazhen-daemon/src/web.rs::bundled":
    "reads a bundle file whole and hands its bytes back unparsed, as the response body; the path it takes is refused whole if a segment is empty, starts with a dot, or carries a backslash or %, and realpath(3) does the rest, held inside the bundle's own; its tests and a proptest climb out every way web.medium.test.ts does",
  "crates/bazhen-daemon/src/stream/hub.rs::write":
    "the trait method a terminal's stream writes the driver's input with, which has no body here; the hub calls it only with what without_replies, which its input target fuzzes, kept",
  "crates/bazhen-daemon/src/stream/hub.rs::Hub::clone":
    "clones the Arc of the hub's state; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Hub::join":
    "hands the view to Shared::join; reads no bytes itself",
  "crates/bazhen-daemon/src/stream/hub.rs::Hub::write":
    "hands a view's input to Shared::write; reads no bytes itself",
  "crates/bazhen-daemon/src/stream/hub.rs::Hub::engage":
    "holds the hub's state, whose views hold output queued for them; moves the lease, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Hub::declare_epoch":
    "holds the hub's state, whose views hold output queued for them; sets the view's epoch, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Hub::resize":
    "holds the hub's state, whose views hold output queued for them; sets the view's size, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Hub::leave":
    "holds the hub's state, whose views hold output queued for them; ends the view, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::join":
    "holds the hub's state, whose views hold output queued for them; hands the snapshot's VT to send_snapshot and the held output to pass whole, parsing neither",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::begin":
    "cuts the output held for a view by seam, which slices it only at the offsets its stream gave; parses none of it",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::watch":
    "holds the hub's state, whose views hold output queued for them; opens or finds the terminal's stream, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::open":
    "keeps the snapshot its stream opened on whole, for a view to replay; parses none of it",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::take_events":
    "hands each event its terminal's stream told to apply; reads no bytes itself",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::apply":
    "moves the stream's position on by the length of each output and hands the output whole to deliver; parses none of it",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::deliver":
    "queues each output whole for a view, or hands it to pass; parses none of it",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::closed":
    "holds the hub's state, whose views hold output queued for them; ends every view with a frame, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::take_snapshot":
    "asks the stream for a snapshot and hands it back whole, comparing only its position and size; parses none of its VT",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::send_snapshot":
    "cuts a snapshot's VT into pieces of a fixed size and queues each whole for its view; parses none of it",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::write":
    "hands a view's input to input; reads no bytes itself",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::input":
    "hands a view's input to without_replies and has_keystrokes, which its input target fuzzes, and writes what without_replies kept; parses none itself",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::engage":
    "holds the hub's state, whose views hold output queued for them; moves the lease, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::fit_to":
    "holds the hub's state, whose views hold output queued for them; picks the view whose size the terminal takes, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::apply_size":
    "holds the hub's state, whose views hold output queued for them; starts a resize, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::resized":
    "holds the hub's state, whose views hold output queued for them; tells views a resize failed and starts the next, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::evict":
    "holds the hub's state, whose views hold output queued for them; ends a view with a frame, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::end":
    "holds the hub's state, whose views hold output queued for them; drops a view, its queue with it, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::make_room":
    "weighs the sizes of the snapshots being sent against the cap and ends stalled views; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::admit":
    "weighs the sizes of the snapshots being sent against the cap and picks the stalled views to end; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::end_stalled":
    "ends the views picked for stalled snapshots that haven't moved on, by id and time; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::unload":
    "takes a view out of those whose snapshots are being sent, by its id; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::park":
    "keeps a stream whose last view has left and starts the timer that closes it; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::unpark":
    "takes a stream out of its terminal's parked ones, by identity; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::release":
    "closes a parked stream; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::release_all_but":
    "closes a terminal's other parked streams; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::on":
    "runs a closure on a terminal's state, which holds output queued for its views; reads none of it itself",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::forget":
    "removes a terminal's entry from the hub's map; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::forget_watched":
    "removes a terminal's entry from the hub's map; reads no bytes",
  "crates/bazhen-daemon/src/stream/hub.rs::Joining::drop":
    "holds the hub's state, whose views hold output queued for them; ends a view whose join was dropped, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::Watched::lock":
    "locks a terminal's state, which holds output queued for its views; reads none of it",
  "crates/bazhen-daemon/src/stream/hub.rs::Watched::until":
    "runs a closure on a terminal's state whenever it moves; reads none of the output it holds itself",
  "crates/bazhen-daemon/src/stream/hub.rs::State::view":
    "finds a view by its id; reads none of the output it holds",
  "crates/bazhen-daemon/src/stream/hub.rs::State::view_mut":
    "finds a view by its id; reads none of the output it holds",
  "crates/bazhen-daemon/src/stream/hub.rs::announce_lease":
    "holds the hub's state, whose views hold output queued for them; queues each a lease frame, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::lease_frame":
    "holds the hub's state, whose views hold output queued for them; builds a lease frame from its lease and device names, reading none of that output",
  "crates/bazhen-daemon/src/stream/hub.rs::pass":
    "queues output for a view whole, and frames for the rest; parses none of it",
  "crates/bazhen-daemon/src/stream/screen.rs::Snapshot::new":
    "keeps a snapshot's VT whole; parses nothing",
  "crates/bazhen-daemon/src/stream/screen.rs::Snapshot::vt":
    "hands back a snapshot's VT whole; parses nothing",
  "crates/bazhen-daemon/src/stream/screen.rs::Snapshot::fmt":
    "shows only how long a snapshot's VT is; reads none of it",
  "crates/bazhen-daemon/src/stream/screen.rs::Opening::new":
    "keeps a snapshot whole beside the size it was drawn at; parses nothing",
  "crates/bazhen-daemon/src/stream/screen.rs::Opening::usable":
    "compares a snapshot's position and size, and hands the snapshot back whole; reads none of its VT",
  "crates/bazhen-daemon/src/stream/seam.rs::held_bytes":
    "counts the bytes a held item adds; reads none of them",
  "crates/bazhen-daemon/src/stream/seam.rs::seam":
    "slices held output only at the offset a snapshot's position gives, which its seam property tests; parses none of it",
  "crates/bazhen-daemon/src/stream/view.rs::Outbox::send":
    "hands output whole to queue; reads no bytes itself",
  "crates/bazhen-daemon/src/stream/view.rs::Outbox::send_piece":
    "hands a snapshot's piece whole to queue; reads no bytes itself",
  "crates/bazhen-daemon/src/stream/view.rs::Outbox::queue":
    "counts output by its length and queues it whole for the view's writer; parses none of it",
  "crates/bazhen-daemon/src/stream/view.rs::Outbox::notify":
    "queues a frame the hub built for the view's writer; reads no bytes",
  "crates/bazhen-daemon/src/stream/view.rs::Inbox::recv":
    "hands back what the hub queued, whole; parses nothing",
  "crates/bazhen-daemon/src/stream/view.rs::Inbox::try_recv":
    "hands back what the hub has queued so far, whole; parses nothing",
  "crates/bazhen-daemon/src/stream/view.rs::Output::into_parts":
    "hands back output the hub queued, whole; parses nothing",
  "crates/bazhen-daemon/src/stream/view.rs::output":
    "the trait method a view's socket sends output with, which has no body here; it is handed output the hub queued whole, to send as it is",
  "crates/bazhen-daemon/src/stream/view.rs::write_one":
    "sends one thing the hub queued to a view's socket whole; parses none of it",
  "crates/bazhen-daemon/src/serve.rs::listen":
    "builds and stops what the daemon serves, among it the holder runtime views stream from, and passes that runtime on; reads no bytes",
  "crates/bazhen-daemon/src/serve.rs::shells":
    "hands the runner, holder runtime and all, to Shells; reads no bytes",
  "crates/bazhen-daemon/src/stream.rs::on_holders":
    "builds the hub over the holder runtime it is given; reads no bytes",
  "crates/bazhen-daemon/src/stream/holder.rs::HolderStreams::new":
    "keeps the store and the HolderRuntime it is given; reads no bytes",
  "crates/bazhen-daemon/src/stream/holder.rs::HolderStreams::attach":
    "reads the recorded locator through HolderLocator::decode, serde_json of text the daemon wrote, then opens a stream through HolderRuntime::attach, whose frames FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, and hands its snapshot on whole; parses nothing",
  "crates/bazhen-daemon/src/stream/holder.rs::HolderStream::size":
    "the HolderStream's own size, which it was told in frames FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes; reads no bytes",
  "crates/bazhen-daemon/src/stream/holder.rs::HolderStream::write":
    "hands a view's input whole to HolderStream::write; parses none of it",
  "crates/bazhen-daemon/src/stream/holder.rs::HolderStream::resize":
    "asks HolderStream::resize, whose answer FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes; reads no bytes",
  "crates/bazhen-daemon/src/stream/holder.rs::HolderStream::snapshot":
    "takes a snapshot through HolderStream::snapshot, whose frames FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, and hands its bytes on whole; parses none of them",
  "crates/bazhen-daemon/src/stream/holder.rs::HolderStream::close":
    "closes the HolderStream; reads no bytes",
  "crates/bazhen-daemon/src/stream/holder.rs::StreamEvents::recv":
    "takes the next event StreamEvents decoded from frames FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, and hands it to told; parses nothing",
  "crates/bazhen-daemon/src/stream/holder.rs::told":
    "moves a holder stream's event, its output whole, into the hub's; parses none of it",
  "crates/bazhen-daemon/src/stream/hub.rs::Hub::close":
    "holds the hub's state, whose views hold output queued for them; closes each stream, reading none of that output",
  "crates/bazhen-daemon/src/stream/route.rs::join":
    "the Views trait's join, which has no body here, and the route's join, which asks whether the terminal runs, then hands the view to Views::join; reads no bytes",
  "crates/bazhen-daemon/src/stream/route.rs::write":
    "the Views trait's write, which has no body here and is handed a view's input whole, and the socket's writer, which sends what the hub queued and what the route sends itself whole; parses none of it",
  "crates/bazhen-daemon/src/stream/route.rs::write_queued":
    "sends what the hub has queued so far to the socket whole, ahead of the route's close; parses none of it",
  "crates/bazhen-daemon/src/stream/route.rs::Hub::join":
    "hands the view to Hub::join; reads no bytes",
  "crates/bazhen-daemon/src/stream/route.rs::Hub::write":
    "hands a view's input whole to Hub::write; parses none of it",
  "crates/bazhen-daemon/src/stream/route.rs::Hub::engage":
    "hands the view to Hub::engage; reads no bytes",
  "crates/bazhen-daemon/src/stream/route.rs::Hub::declare_epoch":
    "hands the view's epoch to Hub::declare_epoch; reads no bytes",
  "crates/bazhen-daemon/src/stream/route.rs::Hub::resize":
    "hands the view's size to Hub::resize; reads no bytes",
  "crates/bazhen-daemon/src/stream/route.rs::Hub::leave":
    "hands the view to Hub::leave; reads no bytes",
  "crates/bazhen-daemon/src/stream/route.rs::Hub::close": "calls Hub::close; reads no bytes",
  "crates/bazhen-daemon/src/stream/route.rs::View::heard":
    "parses a text frame through read, serde_json of a str, and hands a binary frame's input whole to Views::write; parses none of the input",
  "crates/bazhen-daemon/src/stream/route.rs::View::said":
    "moves the view as a frame read already parsed says; reads no bytes",
  "crates/bazhen-daemon/src/stream/route.rs::View::hello":
    "checks a hello read already parsed and starts the view's join; reads no bytes",
  "crates/bazhen-daemon/src/stream/route.rs::Socket::output":
    "sends output the hub queued as one binary frame, whole; parses none of it",
  "crates/bazhen-host-guard/src/ptys.rs::Machine::read_file":
    "reads a kernel counter file whole as text for count, which takes it only as a whole number; parses nothing itself",
  "crates/bazhen-host-guard/src/group.rs::read_out":
    "copies at most OUTPUT_MAX bytes of a child's pipe into a buffer and drops the rest; parses nothing",
  "crates/bazhen-host-guard/src/scope.rs::said":
    "trims a step's stderr, already text, and keeps its first 2000 characters; parses nothing",
  "crates/bazhen-host-guard/src/scope.rs::in_terminal_scope":
    "reads /proc/<pid>/cgroup only to hand it to in_terminal_scope_by",
  "crates/bazhen-host-guard/src/scope.rs::in_terminal_scope_by":
    "hands a cgroup file to cgroup_of and is_terminal_scope, which its containment target fuzzes",
  "crates/bazhen-host-guard/src/scope.rs::step_of":
    "makes a step's stderr text, lossily, and passes its stdout on to parse_probe or systemd_version, which its containment target fuzzes",
  "crates/bazhen-host-guard/src/scope.rs::Host::total_memory":
    "reads /proc/meminfo only to hand it to mem_total, which its containment target fuzzes",
  "crates/bazhen-host-guard/src/scope.rs::Host::random":
    "writes six random bytes as hex; parses nothing",
  "crates/bazhen-host-guard/src/holder.rs::start_holder_with":
    "hands a child's stdout to first_line and its stderr to Run::new, and writes its spec to its stdin; decodes nothing itself",
  "crates/bazhen-host-guard/src/holder.rs::Run::new":
    "hands a child's stderr to keep_stderr; reads nothing itself",
  "crates/bazhen-host-guard/src/holder.rs::Run::said":
    "makes the stderr keep_stderr kept text through whole_text; parses nothing",
  "crates/bazhen-host-guard/src/holder.rs::Run::unchecked":
    "takes a child's stderr only as text, through said; parses nothing",
  "crates/bazhen-host-guard/src/holder.rs::Run::unlaunched":
    "takes a child's stderr only as text, through said; parses nothing",
  "crates/bazhen-host-guard/src/holder.rs::Run::failure":
    "takes a child's stderr only as text, through said; parses nothing",
  "crates/bazhen-host-guard/src/holder.rs::Run::end_unready":
    "reads no bytes: it asks whether the child has exited, and the kernel whether its pid is the holder, through read_process",
  "crates/bazhen-host-guard/src/holder.rs::execed":
    "reads no bytes: it asks whether the child has exited, and the kernel whether its pid is the holder, through read_process",
  "crates/bazhen-host-guard/src/holder.rs::keep_stderr":
    "copies at most STDERR_MAX bytes of a child's stderr into a buffer and drops the rest; parses nothing",
  "crates/bazhen-host-guard/src/holder.rs::whole_text":
    "makes a child's kept stderr text, lossily, less a character its cap cut in two; parses nothing",
  "crates/bazhen-host-guard/src/holder.rs::first_line":
    "reads at most 65 bytes of a child's stdout up to its first newline, only to compare them with ready; parses nothing",
  "crates/bazhen-host-guard/src/holder.rs::quoted":
    "shows a holder's first line, lossily, as a JSON string in an error; parses nothing",
  "crates/bazhen-host-guard/src/lib.rs::send_process":
    "reads its own ancestry only through bazhen_holder::process::parent, whose parent_field proc_stat fuzzes; parses nothing itself",
  "crates/bazhen-host-guard/src/lib.rs::send_pinned":
    "reads its own ancestry only through bazhen_holder::process::parent, whose parent_field proc_stat fuzzes; parses nothing itself",
  "crates/bazhen-host-guard/src/lib.rs::is_alive":
    "reads its own ancestry only through bazhen_holder::process::parent, whose parent_field proc_stat fuzzes; parses nothing itself",
  "crates/bazhen-holder/src/process.rs::comm":
    "hands back a process's name from /proc/<pid>/comm or proc_pidinfo less its newline, which is compared whole, never parsed",
  "crates/bazhen-host-guard/src/lib.rs::send":
    "reads its own ancestry only through bazhen_holder::process::parent, whose parent_field proc_stat fuzzes; parses nothing itself",
  "crates/bazhen-store/src/lib.rs::Reader::reads":
    "wraps its connection for queries; reads no bytes",
  "crates/bazhen-daemon/src/config.rs::read_config_file":
    "reads config.toml only to hand its bytes to parse_config, which its config target fuzzes",
  "crates/bazhen-xtask/src/cargo_config.rs::config_failures":
    "finds the keys in a cargo config's text that refuse a gate, building nothing from it; a property drives it with any text",
  "crates/bazhen-xtask/src/cargo_config.rs::shadow_failure":
    "asks only whether the repository's .cargo/config is there, never what it says",
  "crates/bazhen-xtask/src/gate.rs::run":
    "hands cargo configs' text to config_failures; parses nothing itself",
  "crates/bazhen-xtask/src/schema/mod.rs::run":
    "hands cargo configs' text to config_failures, and what the protocol crates' own emit_schema example prints to write_shadow; parses nothing itself",
  "crates/bazhen-protocol/src/schema.rs::verdict":
    "hands its bytes to edge, which the edge target fuzzes, and writes back what edge took; built only under the schema feature, for the corpus",
  "crates/bazhen-xtask/src/schema/mod.rs::write_corpus":
    "reads the JSON the protocol crates' own emit_schema example prints, through serde_json, and the protocol's schemas and fixtures under packages/protocol; reads nothing from outside the repository",
  "crates/bazhen-xtask/src/schema/mod.rs::write_shadow":
    "reads the JSON the protocol crates' own emit_schema example prints, through serde_json, and the names the repository's checks.ts exports; reads nothing from outside the repository",
  "crates/bazhen-xtask/src/main.rs::Real::read":
    "reads a cargo config's text for config_failures; parses nothing",
  "crates/bazhen-holder/src/process.rs::procargs2_split":
    "reached only through procargs2_args and procargs2_env, which proc_args fuzzes",
  "crates/bazhen-holder/src/engine.rs::advance":
    "passes the child's output to the engine's Engine::advance, which its advance target fuzzes",
  "crates/bazhen-holder/src/engine.rs::Engine::advance":
    "passes the child's output to the engine's Engine::advance, which its advance target fuzzes",
  "crates/bazhen-holder/src/engine.rs::Walled::advance":
    "passes the child's output to the engine's Engine::advance, which its advance target fuzzes",
  "crates/bazhen-holder/src/engine.rs::Screen::write":
    "copies the child's output into the ring and the engine's Engine::advance, which its advance target fuzzes",
  "crates/bazhen-holder/src/engine.rs::Screen::new": "keeps a ring and an engine; reads no bytes",
  "crates/bazhen-holder/src/engine.rs::Screen::ring": "returns a field; reads no bytes",
  "crates/bazhen-holder/src/holder.rs::Holder::reply":
    "queues replies the engine wrote itself for the child; reads no bytes",
  "crates/bazhen-holder/src/input.rs::InputQueue::offer_replies":
    "queues replies the engine wrote itself, whole; parses nothing",
  "crates/bazhen-holder/src/server.rs::input":
    "queues a decoded input request's bytes for the child; parses nothing",
  "crates/bazhen-holder/src/server.rs::stats":
    "reads the holder's own counts; no bytes from a peer",
  "crates/bazhen-holder/src/server.rs::paste":
    "answers a paste FrameDecoder::next_frame decoded, which the proto crate's frame target fuzzes",
  "crates/bazhen-holder/src/server.rs::screen":
    "answers a screen request FrameDecoder::next_frame decoded, which the proto crate's frame target fuzzes",
  "crates/bazhen-holder/src/server.rs::screen_text":
    "renders the engine's own grid as text for a decoded request's count; parses nothing",
  "crates/bazhen-holder/src/holder.rs::Holder::paste":
    "queues a decoded paste's checked text for the child; parses nothing",
  "crates/bazhen-holder/src/conn.rs::Connection::hold": "keeps a decoded request; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::held_since":
    "returns when the request it holds was held; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::holds_a_snapshot":
    "says whether it holds a request; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::reading":
    "says whether it waits for a request, from its state; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::has_request":
    "says whether a decoded request waits; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::take_next":
    "takes FrameDecoder::next_frame's result, which the proto crate's frame target fuzzes",
  "crates/bazhen-holder/src/conn.rs::Connection::next_request":
    "hands over FrameDecoder::next_frame's result, which the proto crate's frame target fuzzes",
  "crates/bazhen-holder/src/conn.rs::Connection::queue_subscribed":
    "queues a frame this holder encoded, with where output then starts; reads nothing",
  "crates/bazhen-holder/src/conn.rs::Connection::queue_exited":
    "queues a frame this holder encoded; reads nothing",
  "crates/bazhen-holder/src/conn.rs::Connection::requeue_exited":
    "queues a frame this holder encoded in place of one it queued; reads nothing",
  "crates/bazhen-holder/src/conn.rs::Connection::queue_snapshot":
    "queues a snapshot this holder encoded; reads nothing",
  "crates/bazhen-holder/src/conn.rs::Connection::queue_state":
    "queues a report this holder encoded in place of one it queued; reads nothing",
  "crates/bazhen-holder/src/server.rs::Server::publish":
    "reads the engine's title and screen and queues reports it encodes; reads no bytes",
  "crates/bazhen-holder/src/server.rs::Server::broadcast":
    "queues a report this holder encodes; reads nothing",
  "crates/bazhen-holder/src/server.rs::Server::evict_stuck_snapshots":
    "drops connections by their state; reads no bytes",
  "crates/bazhen-holder/src/server.rs::evicting_at":
    "computes a deadline from connections' state; reads no bytes",
  "crates/bazhen-holder/src/server.rs::snapshot":
    "answers a decoded snapshot request from the engine; reads no bytes",
  "crates/bazhen-holder/src/server.rs::owed_snapshots": "sums counts; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::next_frame":
    "chooses and encodes the next frame from the queue and the ring; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::flush":
    "writes frames this holder encoded; reads nothing",
  "crates/bazhen-holder/src/conn.rs::Connection::lose_peer":
    "drops the frames this holder encoded for a peer that has gone; reads nothing",
  "crates/bazhen-holder/src/conn.rs::only_asks":
    "says whether a decoded request only gets an answer, from its kind; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::interest":
    "says what poll should wait for; reads nothing",
  "crates/bazhen-holder/src/conn.rs::Connection::is_finished":
    "returns a field or a state; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::queue":
    "queues a frame this holder encoded; reads nothing",
  "crates/bazhen-holder/src/conn.rs::Connection::polled":
    "hands its buffer to receive, or drops the connection on a hang-up; parses nothing itself",
  "crates/bazhen-holder/src/conn.rs::Connection::subscribed":
    "reads the connection's own state; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::latest_subscription":
    "finds a position in the connection's queue; reads no bytes",
  "crates/bazhen-holder/src/server.rs::snapshot_line":
    "orders connections by their state; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::receive":
    "reads the socket into FrameDecoder::push, which the proto crate's frame target fuzzes; parses nothing itself",
  "crates/bazhen-holder/src/ring.rs::Ring::capacity": "returns a field or a state; reads no bytes",
  "crates/bazhen-holder/src/ring.rs::Ring::held": "returns a field or a state; reads no bytes",
  "crates/bazhen-holder/src/ring.rs::Ring::push":
    "copies the child's output into the ring as it came; parses nothing",
  "crates/bazhen-holder/src/ring.rs::Ring::read":
    "returns a slice of bytes already held; parses nothing",
  "crates/bazhen-holder/src/ring.rs::Ring::slot": "returns a field or a state; reads no bytes",
  "crates/bazhen-holder/src/ring.rs::Ring::start": "returns a field or a state; reads no bytes",
  "crates/bazhen-holder/src/holder.rs::Holder::after_poll":
    "reads the master into the Output, a sink that parses nothing; reaps the child",
  "crates/bazhen-holder/src/server.rs::Server::accept": "accepts connections; reads no bytes",
  "crates/bazhen-holder/src/server.rs::Server::poll_conns": "waits on fds; reads nothing",
  "crates/bazhen-holder/src/server.rs::Server::wait": "waits on fds; reads nothing",
  "crates/bazhen-holder/src/server.rs::Server::after_poll":
    "runs the turn; bytes it reads go to Connection::receive and the ring",
  "crates/bazhen-holder/src/server.rs::Server::read_and_serve":
    "serves a connection; bytes it reads go to Connection::receive",
  "crates/bazhen-holder/src/server.rs::Server::close_done":
    "checks whether a close is done; reads nothing",
  "crates/bazhen-holder/src/server.rs::Server::release_writer":
    "frees the writer slot once no open connection holds it; reads nothing",
  "crates/bazhen-holder/src/server.rs::Server::deadline":
    "returns a field or a state; reads no bytes",
  "crates/bazhen-holder/src/server.rs::Server::poll": "waits on fds; reads nothing",
  "crates/bazhen-holder/src/server.rs::Server::run":
    "runs turns; bytes it reads go to Connection::receive and the ring",
  "crates/bazhen-holder/src/server.rs::Server::turn":
    "runs the loop; bytes it reads go to Connection::receive and the ring",
  "crates/bazhen-holder/src/server.rs::Server::victim":
    "returns a field or a state; reads no bytes",
  "crates/bazhen-holder/src/server.rs::waiting_now":
    "asks each connection whether a request waits; reads no bytes",
  "crates/bazhen-holder/src/server.rs::Server::send_exit":
    "queues the child's exit, an event this holder encoded; reads nothing",
  "crates/bazhen-holder/src/server.rs::subscribe": "answers a decoded subscribe; reads no bytes",
  "crates/bazhen-holder/src/server.rs::answer": "answers one decoded request; reads no bytes",
  "crates/bazhen-holder/src/server.rs::hello": "answers a decoded hello; reads no bytes",
  "crates/bazhen-holder/src/server.rs::ok": "queues an ok this holder encodes; reads nothing",
  "crates/bazhen-holder/src/server.rs::Server::respawn":
    "starts a decoded process spec on a new PTY and queues events it encodes; reads no bytes",
  "crates/bazhen-holder/src/server.rs::respawn_refusal":
    "checks a decoded process spec against the holder's state; reads no bytes",
  "crates/bazhen-holder/src/conn.rs::Connection::queue_respawned":
    "queues an event this holder encoded; reads nothing",
  "crates/bazhen-holder/src/conn.rs::Connection::push_event":
    "queues an event this holder encoded; reads nothing",
  "crates/bazhen-holder/src/holder.rs::Holder::respawn":
    "swaps in a new PTY and child; reads no bytes",
  "crates/bazhen-holder/src/server.rs::foreground":
    "reads the foreground group and a start time; no bytes from a peer",
  "crates/bazhen-holder/src/server.rs::Server::apply_resize":
    "applies a size from a decoded resize; reads no bytes",
  "crates/bazhen-holder/src/holder.rs::Holder::master_interest": "returns a state; reads no bytes",
  "crates/bazhen-holder/src/holder.rs::Holder::offer_input":
    "queues decoded input for the child, parsing none of it",
  "crates/bazhen-holder/src/holder.rs::Holder::flush_input":
    "writes queued input to the master; reads nothing",
  "crates/bazhen-holder/src/holder.rs::Holder::master_closed":
    "marks the master's output over and drops queued input; reads nothing",
  "crates/bazhen-holder/src/input.rs::InputQueue::is_empty":
    "returns a field or a state; reads no bytes",
  "crates/bazhen-holder/src/input.rs::InputQueue::len":
    "returns a field or a state; reads no bytes",
  "crates/bazhen-holder/src/input.rs::InputQueue::offer":
    "queues decoded input for the child, parsing none of it",
  "crates/bazhen-holder/src/input.rs::InputQueue::clear": "drops what is queued; reads nothing",
  "crates/bazhen-holder/src/input.rs::InputQueue::write_to":
    "writes queued input to the master; reads nothing",
  "crates/bazhen-holder/src/server.rs::hello_reply":
    "builds the hello reply from the holder's state; reads no bytes",
  "crates/bazhen-holder/src/server.rs::refuse": "queues an error reply; reads no bytes",
  "crates/bazhen-holder/src/server.rs::send": "encodes and queues a reply; reads no bytes",
  "crates/bazhen-holder/src/server.rs::serve":
    "answers requests FrameDecoder decoded, which the proto crate's frame target fuzzes",
  "crates/bazhen-protocol/src/input.rs::strip":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen-protocol/src/input.rs::find":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen-protocol/src/input.rs::At::peek":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen-protocol/src/input.rs::At::byte":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen-protocol/src/input.rs::At::one_of":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen-protocol/src/input.rs::At::many":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen-protocol/src/input.rs::At::digits":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen-protocol/src/input.rs::At::any":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen-protocol/src/input.rs::event_report":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen-protocol/src/input.rs::reply":
    "a step of has_keystrokes, which the input target fuzzes",
  "crates/bazhen/src/attach/direct.rs::Direct::reply":
    "acts on a decoded Reply, handing its bytes to the screen whole; parses nothing",
  "crates/bazhen/src/attach/attachment.rs::Attachment::declare":
    "hands the keys Attachment::keys held over, whole; parses nothing",
  "crates/bazhen/src/attach/attachment.rs::Attachment::engage":
    "asks for the lease when keys are held for it; reads no bytes",
  "crates/bazhen-protocol/src/detach_keys.rs::DetachKeys::fmt":
    "writes the keys DetachKeys::parse has read as a person reads them; parses nothing",
  "crates/bazhen/src/attach/keys.rs::detach":
    "reads config.toml with the toml crate and passes its keys to DetachKeys::parse, which the protocol's detach_keys target fuzzes",
  "crates/bazhen/src/attach.rs::straight":
    "takes the keys DetachKeys::parse read, for Direct::new, which the attach target fuzzes",
  "crates/bazhen/src/attach.rs::starting": "shows the keys DetachKeys::parse read; parses nothing",
  "crates/bazhen/src/attach/attachment.rs::DetachScan::push":
    "reached only through DetachScan::scan, which the attach target fuzzes",
  "crates/bazhen/src/attach/attachment.rs::Attachment::sized":
    "keeps a size and a sequence DetachKeys::parse has read; reads no bytes",
  "crates/bazhen/src/attach/link.rs::drain":
    "reads the daemon's frames through tungstenite, and their text through Attachment::frame, which the attach target fuzzes",
  "crates/bazhen/src/attach/link.rs::act": "writes frames and keys this build made; reads nothing",
  "crates/bazhen/src/attach/direct.rs::pump":
    "moves bytes between a holder's socket and the person's terminal; bazhen-holder-proto's FrameDecoder, which its frame target fuzzes, and Direct::keys, which the attach target fuzzes, read them",
  "crates/bazhen/src/attach/direct.rs::write_whole":
    "writes a request this build encoded; reads nothing",
  "crates/bazhen/src/events.rs::drain":
    "reads the daemon's frames through tungstenite, and their text through wire::from_slice, which the wire target fuzzes",
  "crates/bazhen/src/attach/link.rs::pump":
    "moves bytes between the daemon's socket and the person's terminal; tungstenite frames them, and Attachment::keys and frame, which the attach target fuzzes, read them",
  "crates/bazhen/src/attach/tty.rs::Wakeups::clear":
    "discards signal wake-ups, whose bytes the handler wrote and which carry no content",
  "crates/bazhen-holder/src/signals.rs::Wakeups::clear":
    "discards signal wake-ups, whose bytes the handler wrote and which carry no content",
  "crates/bazhen-holder/src/start_time.rs::decimal":
    "reached only through start_ticks and boot_time, which proc_stat fuzzes",
  "crates/bazhen-holder/src/holder.rs::write":
    "the Output trait's method: a sink handed the child's bytes in order, to keep",
  "crates/bazhen-holder/src/holder.rs::Discard::write":
    "drops the bytes it is handed; parses nothing",
  "crates/bazhen-holder/src/holder.rs::Holder::read_master":
    "copies the child's output to the Output in chunks, unparsed",
  "crates/bazhen-holder/src/holder.rs::Holder::step":
    "reaps the child and publishes its exit; reads no bytes",
  "crates/bazhen-holder/src/log.rs::Line::write":
    "hands the holder's own log line to the log, or drops it; parses nothing",
  "crates/bazhen-holder/src/log.rs::BoundedLog::line":
    "an encoder: writes a log line the holder formatted",
  "crates/bazhen-holder/src/log.rs::BoundedLog::write":
    "an encoder: hands tracing's formatted line to line",
  "crates/bazhen-holder/src/start.rs::start": "reads stdin only through read_spec",
  "crates/bazhen-holder/src/start.rs::start_marked": "reads stdin only through read_spec",
  "crates/bazhen-holder/src/start.rs::read_spec":
    "reads at most MAX_REQUEST_BYTES + 1 bytes for decode_spawn_spec, which is fuzzed (spawn_spec), then checks the strings it decoded",
  "crates/bazhen-hook/src/lib.rs::hook_request": "an encoder: it writes the request",
  "crates/bazhen/src/call.rs::Daemon::call":
    "writes a request; the reply goes to reply::decode, fuzzed",
  "crates/bazhen-client/src/sha256.rs::sha256":
    "a hash of the run directory's path, which the caller made from its own settings; it reads its input as data only",
  "crates/bazhen-client/src/sha256.rs::compress":
    "reached only through sha256, of a path the caller made",
  "crates/bazhen-client/src/sha256.rs::hex": "an encoder: it writes bytes as hex",
  "crates/bazhen-protocol/src/wire.rs::hex4": "reached only through well_formed, fuzzed",
  "crates/bazhen-hook/src/lib.rs::ask": "sends a request; the reply goes to parse_reply",
  "crates/bazhen-hook/src/lib.rs::post": "writes a request; the reply goes to read_response",
  "crates/bazhen-hook/src/lib.rs::post_as": "writes a request; the reply goes to read_response",
  "crates/bazhen-client/src/lib.rs::exchange":
    "writes a request; the reply goes to read_response, then to the caller's decoder",
  "crates/bazhen-client/src/lib.rs::send": "writes a request; the reply goes to read_response",
  "crates/bazhen-client/src/framing.rs::read_response":
    "reads the socket until Framing::end_of, fuzzed, says where the frame ends",
  "crates/bazhen-client/src/framing.rs::in_chunks":
    "reached only through Framing::end_of and body, both fuzzed",
  "crates/bazhen-client/src/framing.rs::ChunkScan::advance":
    "reached only through Framing::end_of and body, both fuzzed",
  "crates/bazhen-client/src/framing.rs::ChunkScan::end":
    "reached only through Framing::end_of, fuzzed",
  "crates/bazhen-client/src/framing.rs::end_by_head":
    "reached only through reply_end and Framing::end_of, both fuzzed",
  "crates/bazhen-hook/src/statusline.rs::report":
    "forwards the status line's input to the daemon in a hook request, without parsing it",
  "crates/bazhen-holder-proto/src/frame.rs::frame":
    "an encoder: it writes a frame's header before its payload",
  "crates/bazhen-holder-proto/src/frame.rs::with_json":
    "an encoder: it appends a body's JSON to a frame's binary prefix",
  "crates/bazhen-holder-proto/src/frame.rs::with_offset":
    "an encoder: it appends an offset to a frame's binary prefix",
  "crates/bazhen-holder-proto/src/frame.rs::Request::name": "names the variant; reads no bytes",
  "crates/bazhen-holder-proto/src/frame.rs::Request::code":
    "names the variant's type byte; reads no bytes",
  "crates/bazhen-holder-proto/src/frame.rs::Request::id":
    "returns the variant's id; reads no bytes",
  "crates/bazhen-holder-proto/src/frame.rs::Request::encode": "an encoder: it writes the request",
  "crates/bazhen-holder-proto/src/frame.rs::Reply::code":
    "names the variant's type byte; reads no bytes",
  "crates/bazhen-holder-proto/src/frame.rs::Reply::encode": "an encoder: it writes the reply",
  "crates/bazhen-holder-proto/src/frame.rs::FrameDecoder::new": "sets a decoder up; reads nothing",
  "crates/bazhen-holder-proto/src/frame.rs::split_u32":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::split_id":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::split_offset":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::parse":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::body":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::hello_request":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::hello_reply":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::request_body":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::decode_request":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::decode_reply":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-proto/src/frame.rs::FrameDecoder::take":
    "reached only through FrameDecoder::next_frame, fuzzed",
  "crates/bazhen-holder-engine/src/lib.rs::Engine::parse":
    "reached only through Engine::advance, which is fuzzed",
  "crates/bazhen-holder-engine/src/lib.rs::whole_chars":
    "reached only through Engine::advance, which is fuzzed",
  "crates/bazhen-holder-engine/src/seam.rs::Utf8Seam::finish":
    "reached only through Engine::advance, which is fuzzed",
  "crates/bazhen-holder-engine/src/seam.rs::Utf8Seam::note":
    "reached only through Engine::advance, which is fuzzed",
  "crates/bazhen-holder-engine/src/budget.rs::Budget::csi_dispatch":
    "vte's callback with what it parsed; reached only through Engine::advance, which is fuzzed",
  "crates/bazhen-holder-engine/src/budget.rs::Budget::esc_dispatch":
    "vte's callback with what it parsed; reached only through Engine::advance, which is fuzzed",
  "crates/bazhen-holder-engine/src/lib.rs::Engine::advance_passed":
    "reached only through Engine::advance, which is fuzzed",
  "crates/bazhen-holder-engine/src/osc.rs::OscCap::split":
    "reached only through Engine::advance, which is fuzzed",
  "crates/bazhen-holder-engine/src/capped.rs::Capped::clipboard_store":
    "vte's callback with what it parsed; reached only through Engine::advance, which is fuzzed",
  "crates/bazhen-client/src/lib.rs::read_regular":
    "reads at most max + 1 bytes of a regular file for its caller, parsing none of them",
  "crates/bazhen-holder-engine/src/bin/replay.rs::replay":
    "feeds a recording to Engine::advance, which its advance target fuzzes",
  "crates/bazhen-holder-engine/src/bin/replay.rs::run":
    "reads stdin only to wait for its end, and discards it",
  "crates/bazhen-holder/src/process.rs::uid":
    "reads /proc/<pid>/status for status_uid, which proc_args fuzzes",
  "crates/bazhen-holder/src/process.rs::credentials":
    "reads /proc/<pid>/status for status_credentials, which proc_args fuzzes",
  "crates/bazhen-holder/src/process.rs::status_ids":
    "reached only through status_uid and status_credentials, which proc_args fuzzes",
  "crates/bazhen-holder/src/process.rs::args":
    "reads /proc/<pid>/cmdline for cmdline_args, which proc_args fuzzes",
  "crates/bazhen-holder/src/process.rs::environ":
    "reads /proc/<pid>/environ for cmdline_args, which proc_args fuzzes",
  "crates/bazhen-holder/src/rss.rs::resident_bytes":
    "reads /proc/self/statm for resident_pages, which proc_stat fuzzes",
  "crates/bazhen-holder/src/session.rs::visit":
    "reads /proc/<pid>/stat for member_state, which proc_stat fuzzes",
  "crates/bazhen-holder/src/session.rs::list": "reads /proc/<pid>/stat for seen",
  "crates/bazhen-holder/src/session.rs::seen": "passes the line read to listed_session",
  "crates/bazhen-holder/src/session.rs::listed_session":
    "reads the line only through session_field and member_state, which proc_stat fuzzes",
  "crates/bazhen-holder/src/start.rs::run": "reads stdin only through read_spec",
  "crates/bazhen-holder/src/start_time.rs::read":
    "reads /proc/stat and /proc/<pid>/stat for epoch_seconds, which proc_stat fuzzes",
  "crates/bazhen-hook/src/lib.rs::run":
    "reads stdin for hook_request, which forwards it unparsed; the reply goes to parse_reply, fuzzed",
  "crates/bazhen-hook/src/shell_report.rs::read_line":
    "reads at most MAX_LINE + 1 bytes of stdin for the copy to send, parsing none of them",
  "crates/bazhen-hook/src/shell_report.rs::send_line":
    "reads stdin for report_body, which shell_report fuzzes",
  "crates/bazhen-hook/src/shell_report.rs::send_prompt":
    "posts a body prompt_body wrote, and reads nothing of the reply",
  "crates/bazhen-hook/src/statusline.rs::run":
    "reads stdin to hand the user's command and report, parsing none of it",
  "crates/bazhen-peer/src/main.rs::main":
    "hands stdin's fd to bazhen_peer::of, which asks the kernel for the peer; reads no bytes",
  "crates/bazhen-daemon/src/holder.rs::Holder::new":
    "keeps the HolderRuntime and history depth it is given; reads no bytes",
  "crates/bazhen-daemon/src/holder.rs::Holder::told":
    "subscribes to the runtime's events, and keeps a reread that lists the terminals through HolderRuntime::inventory, whose hellos FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes; parses nothing",
  "crates/bazhen-daemon/src/holder.rs::Holder::close":
    "reads the recorded locator through holder_ref's HolderLocator::decode, serde_json of text the daemon wrote, then closes the terminal through HolderRuntime::close, whose answers FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, and forgets it in what each events receiver keeps; parses nothing",
  "crates/bazhen-daemon/src/holder.rs::Holder::health":
    "maps the report HolderRuntime::health reads from hellos, which FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, to the daemon's; parses nothing",
  "crates/bazhen-daemon/src/holder.rs::Holder::reachable":
    "reads the recorded locator through holder_ref's HolderLocator::decode, serde_json of text the daemon wrote, then asks HolderRuntime::health, which reads hellos FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, whether the recorded terminals' holders answer; parses nothing",
  "crates/bazhen-daemon/src/holder.rs::Holder::compatibility":
    "maps what HolderRuntime::compatibility reads from hellos, which FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, to ids; parses nothing",
  "crates/bazhen-daemon/src/holder.rs::Holder::holders":
    "maps the builds HolderRuntime::builds reads, which FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, to running holders; parses nothing",
  "crates/bazhen-daemon/src/holder.rs::Holder::events":
    "boxes the HolderTold that told makes; reads no bytes",
  "crates/bazhen-daemon/src/holder.rs::Holder::runtime":
    "hands out the HolderRuntime it keeps, for views to stream from; reads no bytes",
  "crates/bazhen-daemon/src/peer.rs::Peers::read":
    "hands a connection's fd to bazhen_peer::of, which asks the kernel for the peer; reads no bytes",
  "crates/bazhen-daemon/src/callers.rs::Stored::reads":
    "opens the store's reader connection for queries; reads no bytes",
  "crates/bazhen-daemon/src/callers.rs::Stored::agent_of":
    "looks a token's hash up in the store through tokens::agent_of; parses no bytes",
  "crates/bazhen-daemon/src/callers.rs::Stored::untokened":
    "looks an agent id up in the store; parses no bytes",
  "crates/bazhen-daemon/src/callers.rs::Stored::codex_agent":
    "looks a thread up in the store and checks the id it names; parses no bytes",
  "crates/bazhen-daemon/src/callers.rs::who":
    "reads the peer through Peers::read and the credentials through Stored; parses no bytes",
  "crates/bazhen/src/attach/direct.rs::open":
    "reads the holder's socket into FrameDecoder::push, which the proto crate's frame target fuzzes",
  "crates/bazhen-protocol/src/ids.rs::Id::mint":
    "writes 16 bytes its caller drew at random as an id's hex; parses nothing",
  "crates/bazhen-daemon/src/probe.rs::spoken":
    "reads a health answer only through bazhen-client's split_head, status and body, which its " +
    "framing fuzz target drives, and serde_json; it decodes nothing of its own",
  "crates/bazhen-daemon/src/probe.rs::answer_of":
    "sorts an exchange's outcome by its error variant and hands a reply's bytes to spoken; it " +
    "reads none of them itself",
  "crates/bazhen-daemon/src/detach.rs::detach":
    "reads the daemon's own log only to print its last lines, lossily as text; parses nothing",
  "crates/bazhen-daemon/src/env.rs::matches":
    "compares a variable's name with an agents.env rule byte for byte; parses nothing",
  "crates/bazhen-daemon/src/env.rs::denying":
    "finds the agents.env rule a variable's name matches, through matches; parses nothing",
  "crates/bazhen-store/src/lib.rs::urandom":
    "reads 16 random bytes from /dev/urandom for an id; parses nothing",
  "crates/bazhen/src/fmt.rs::uuid":
    "reads 16 random bytes from /dev/urandom and formats them; parses nothing",
  "crates/bazhen/src/tasks.rs::read_file":
    "reads stdin or read_regular's bytes as lossy UTF-8 text, parsing none of them",
  "crates/bazhen-holder/src/guard.rs::parent":
    "reads /proc/<pid>/stat for parent_field, which proc_stat fuzzes",
  "crates/bazhen-holder/src/process.rs::parent":
    "reads /proc/<pid>/stat for has_exited and parent_field, which proc_stat fuzzes",
  "crates/bazhen-peer/src/lib.rs::step":
    "reads /proc/<pid>/stat for has_exited, parent_field and start_ticks, which proc_stat fuzzes",
  "crates/bazhen-holder/src/session.rs::supported":
    "reads /proc/self/stat for own_pid, which proc_stat fuzzes",
  "crates/bazhen-runtime-holder/src/client.rs::HolderEvents::recv":
    "hands on events the reader made of frames from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderEvents::try_recv":
    "hands on events the reader made of frames from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderEvents::poll_next":
    "hands on events the reader made of frames from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Answered::into_hello":
    "unwraps an answer made of a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Answered::into_snapshot":
    "unwraps an answer made of a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Answered::into_stats":
    "unwraps an answer made of a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Answered::into_foreground":
    "unwraps an answer made of a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Answered::into_screen":
    "unwraps an answer made of a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Answered::into_ok":
    "unwraps an answer made of a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Answered::name":
    "names an answer's kind; reads no bytes",
  "crates/bazhen-runtime-holder/src/client.rs::offer":
    "a trait's method with no body: Typed::offer is its one impl",
  "crates/bazhen-runtime-holder/src/client.rs::Typed::offer":
    "gives the request waiting an answer made of a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Shared::hang_up":
    "queues the hang-up; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Shared::send":
    "queues frames this client encoded; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Waiter::drop":
    "removes a request from those waiting; reads no bytes",
  "crates/bazhen-runtime-holder/src/client.rs::waiting":
    "awaits an answer made of a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::ask":
    "encodes a request and queues it; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::dispatch":
    "routes a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it) by its type; parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::answer":
    "gives a request its answer, made of a frame from FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::take_frames":
    "takes frames from FrameDecoder::next_frame (the proto crate's frame target fuzzes it) and hands them to dispatch; parses nothing itself",
  "crates/bazhen-runtime-holder/src/client.rs::read_loop":
    "reads the socket into FrameDecoder::push, which the proto crate's frame target fuzzes; parses nothing itself",
  "crates/bazhen-runtime-holder/src/client.rs::drain":
    "writes frames this client encoded; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::write_loop":
    "writes frames this client encoded, through drain; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::Owner::drop": "hangs up; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::open":
    "hands the socket's halves to read_loop and write_loop and says hello through ask; decodes nothing itself",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::shared":
    "returns a field; reads no bytes",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::is_open":
    "reads the connection's own state; reads no bytes",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::room":
    "reads the connection's own state; reads no bytes",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::drained":
    "reads the connection's own state; reads no bytes",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::generation":
    "reads the connection's own state; reads no bytes",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::end": "hangs up; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::ended":
    "reads the connection's own state; reads no bytes",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::closed":
    "waits for the connection's tasks; reads no bytes",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::snapshot":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::attach":
    "encodes two requests and queues them in one write; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::subscribe":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::input":
    "frames the caller's input for the holder and queues it; parses nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::resize":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::signal":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::paste":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::respawn":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::set_tags":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::set_theme":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::stats":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::foreground":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::screen":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/client.rs::HolderClient::close":
    "encodes a request and queues it through ask; reads nothing",
  "crates/bazhen-runtime-holder/src/install.rs::build_of":
    "hashes the copy install_holder made of a build; parses nothing",
  "crates/bazhen-runtime-holder/src/runtime.rs::unit_random":
    "turns /dev/urandom's bytes into hex for a scope's unit name; parses nothing",
  "crates/bazhen-runtime-holder/src/runtime.rs::Starting::start":
    "starts a holder and reads hellos through connect, whose frames FrameDecoder::next_frame decodes, which the proto crate's frame target fuzzes; parses nothing",
  "crates/bazhen-runtime-holder/src/runtime.rs::Forgetting::drop":
    "forgets a terminal's control connection through Controls::forget as a close ends; reads no bytes",
  "crates/bazhen-runtime-holder/src/runtime.rs::HolderRuntime::listed":
    "lists the holders' directory and reads hellos through connect, whose frames FrameDecoder::next_frame decodes, which the proto crate's frame target fuzzes; parses nothing",
  "crates/bazhen-runtime-holder/src/runtime.rs::HolderRuntime::health":
    "reads hellos through connect, whose frames FrameDecoder::next_frame decodes, which the proto crate's frame target fuzzes; parses nothing",
  "crates/bazhen-runtime-holder/src/runtime.rs::HolderRuntime::compatibility":
    "reads hellos through connect, whose frames FrameDecoder::next_frame decodes, which the proto crate's frame target fuzzes; parses nothing",
  "crates/bazhen-runtime-holder/src/runtime.rs::HolderRuntime::builds":
    "reads hellos through connect, whose frames FrameDecoder::next_frame decodes, which the proto crate's frame target fuzzes, and the stats a holder answers, decoded the same way; parses nothing",
  "crates/bazhen-runtime-holder/src/runtime.rs::HolderRuntime::attach":
    "connects a reader through holder_of and hands it, its events and a control guard to stream::attach; parses nothing",
  "crates/bazhen-runtime-holder/src/runtime.rs::HolderRuntime::control":
    "returns the guard acquire makes; reads no bytes",
  "crates/bazhen-runtime-holder/src/runtime.rs::HolderRuntime::acquire":
    "builds the control connection's Opening from the runtime's options and asks Controls::acquire for a guard; reads no bytes",
  "crates/bazhen-runtime-holder/src/runtime.rs::HolderRuntime::close":
    "closes the holder through its client, whose answers FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, forgetting its control connection through Forgetting however it ends; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Attached::vt":
    "returns the VT of the attach's snapshot, which FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decoded, as a slice; reads none of it",
  "crates/bazhen-runtime-holder/src/stream.rs::StreamEvents::recv":
    "hands on the StreamEvents a stream's task made of HolderEvents, decoded by FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::StreamEvents::try_recv":
    "hands on a StreamEvent waiting in the channel, made of HolderEvents decoded by FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Writer::close":
    "drops the writer's events, hangs up its client and awaits its socket closing; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Control::is":
    "compares two handles' shared state by pointer; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Control::write":
    "counts the caller's input against the unsent cap and queues it whole, as one command sent under the lock; reads none",
  "crates/bazhen-runtime-holder/src/stream.rs::Control::resize":
    "queues a resize for the control task and awaits its reply; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Control::snapshot":
    "asks the control task for HolderClient::snapshot's answer, which FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, and awaits it; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Control::stop":
    "sends the task its End or Retire, cancelling the token if the task has stopped; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::run":
    "acts on commands, an ending's deadline and the writer's HolderEvents, decoded by FrameDecoder::next_frame (the proto crate's frame target fuzzes it), by their variant; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::end":
    "drops what is left queued and hangs up, resolving once the connection has closed; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::unsent":
    "sums the lengths of the queued writes not yet sent; reads none of their bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::poll_wake":
    "polls the task's futures, an ending's deadline, its channel and the writer's HolderEvents for the next thing to act on; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::take":
    "moves a command's write or resize onto the queue, or answers a snapshot from the open connection; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::open":
    "returns the writer while its client says it is open; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::connected":
    "keeps the connection connect opened, or fails what waits with its error; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::pump":
    "compares the length of a queued write's next part with the client's room and hands parts and resizes to the client in order; reads none",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::send_head":
    "hands the next part of the queued write to HolderClient::input and uncounts its length; reads none of it",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::drop_queue":
    "drops the queued input, counting only the length of what is unsent, and fails resizes and snapshots waiting; reads none",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::closing":
    "hangs up the writer and any connection still opening, resolving once their sockets close; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Actor::connect":
    "opens a connection through connect, whose hello FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, and checks that hello's holder and writer fields; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::part":
    "slices the next INPUT_PART bytes of a write, past those already sent; reads none of them",
  "crates/bazhen-runtime-holder/src/stream.rs::Controls::acquire":
    "finds or starts a terminal's control connection and registers a user of it; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Controls::release":
    "unregisters a user and ends the control connection once none is left; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Controls::forget":
    "removes a terminal's control connection and tells it to retire; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::ControlGuard::write":
    "passes the caller's input to Control::write; reads none of it",
  "crates/bazhen-runtime-holder/src/stream.rs::ControlGuard::failure":
    "clones the control connection's last failure; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::ControlGuard::drop":
    "releases the guard's user through Controls::release; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::View::release":
    "drops the stream's control guard, if it still holds one; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::HolderStream::size":
    "reads the size the stream last heard from its own state; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::HolderStream::exited":
    "clones the exit the stream last heard from its own state; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::HolderStream::is_closed":
    "loads the stream's closed flag; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::HolderStream::write":
    "passes the caller's input to Control::write unless the stream has closed; reads none of it",
  "crates/bazhen-runtime-holder/src/stream.rs::HolderStream::resize":
    "resizes through Control::resize, then asks the stream's task to confirm the size it heard; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::HolderStream::snapshot":
    "takes Control::snapshot's answer, which FrameDecoder::next_frame (the proto crate's frame target fuzzes it) decodes, and waits for the task to reach its position; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::HolderStream::close":
    "drops the stream's control guard and tells its task to close; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::HolderStream::drop":
    "drops the stream's control guard through View::release; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::attach":
    "resizes through the control connection, starts the stream's task on the reader and awaits the snapshot it takes from HolderEvents decoded by FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Pump::run":
    "acts on the stream's commands, notices and the reader's HolderEvents, decoded by FrameDecoder::next_frame (the proto crate's frame target fuzzes it), by their variant; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Pump::poll_wake":
    "polls the stream's commands, answers, notices and, while its consumer's channel has room, HolderEvents, delivering what waits; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Pump::attached":
    "takes HolderEvents waiting, decoded by FrameDecoder::next_frame (the proto crate's frame target fuzzes it), up to the attach's snapshot and hands that snapshot on; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Pump::confirmed":
    "handles the HolderEvents waiting, decoded by FrameDecoder::next_frame (the proto crate's frame target fuzzes it), then compares the size heard with the one asked; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Pump::handle":
    "turns a HolderEvent, decoded by FrameDecoder::next_frame (the proto crate's frame target fuzzes it), into a StreamEvent, adding a Data's length to the offset and passing its bytes on unread; parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Pump::before_snapshot":
    "keeps the attach's snapshot or a resize's size from a HolderEvent decoded by FrameDecoder::next_frame (the proto crate's frame target fuzzes it); parses nothing",
  "crates/bazhen-runtime-holder/src/stream.rs::Pump::push":
    "delivers a StreamEvent on the stream's bounded channel, or keeps it in order until there is room; reads no bytes",
  "crates/bazhen-runtime-holder/src/stream.rs::Pump::close":
    "hangs up the reader, pushes Closed and fails what waits on the stream; reads no bytes",
  "crates/bazhen-runtime-holder/src/watch.rs::next":
    "hands on events HolderEvents::recv gives, made of FrameDecoder::next_frame, which the proto crate's frame target fuzzes; parses nothing",
  "crates/bazhen-runtime-holder/src/watch.rs::Watches::adopt":
    "hands a connection and its events to a watch; parses nothing",
  "crates/bazhen-runtime-holder/src/watch.rs::Watches::run":
    "acts on events HolderEvents::recv gives, made of FrameDecoder::next_frame, which the proto crate's frame target fuzzes; parses nothing",
};

// A carrier's bytes are found by the methods of its own crate that use the field holding them, so
// a field another crate can read is listed here with why its bytes aren't from outside.
const PUBLIC_BYTE_FIELDS: Record<string, string> = {
  "crates/bazhen-runtime-holder/src/client.rs::HolderSnapshot::bytes":
    "VT a holder sent, which FrameDecoder::next_frame decoded and the proto crate's frame target fuzzes, for a terminal to draw as it does HolderEvent::Data's",
  "crates/bazhen-holder-proto/src/body.rs::ThemeColours::text":
    "a built-in theme's RGB, which Theme::colours makes in-process",
  "crates/bazhen-holder-proto/src/body.rs::ThemeColours::background":
    "a built-in theme's RGB, which Theme::colours makes in-process",
};

// Rust's whitespace as a regex class: `\s` has U+00A0 but not the marks U+200E and U+200F.
const SPACE = `[${[...RUST_WHITESPACE].join("")}]`;

// Where an impl item starts, its head read on by implHead. An impl block's associated types are
// its trait's, so they aren't aliases. (A trait's own associated types take no `= …` on stable, so
// the alias pattern never matches them.)
const IMPL_START = new RegExp(
  `(?<=^|[;{}])${SPACE}*(?:(?:pub(?:\\([^)]*\\))?|unsafe)${SPACE}+)*impl\\b`,
  "gm",
);

// Types a function takes that carry bytes from outside the process: anything holding u8s, a
// reader of any kind, a handle that can only be read (stdin, a child's output), or a WebSocket,
// whose `read()` takes nothing to read into, so BODY_READS can't see it. A socket, a file or an fd
// isn't one, since holding it isn't reading it: a function that reads one does so in its body,
// which BODY_READS reads.
const U8 = String.raw`(?:(?:r#)?(?:core|std)::(?:r#)?primitive::)?(?:r#)?u8`;
const BYTES_IN = new RegExp(
  String.raw`\[${U8}\b|\b(?:Vec|VecDeque)<${U8}>|\*\s*(?:const|mut)\s+${U8}\b|\bItem\s*=\s*${U8}\b|` +
    String.raw`\b(?:(?:Async)?(?:Buf)?Read(?:er)?|Buf|Bytes|BytesMut|Stdin\w*|Child(?:Stdout|Stderr)|WebSocket)\b`,
);

// The reads of std::io, the socket and fd calls, and the reads of a file, whether called as a
// method, by path or by a bare name a `use` brought in.
const READS =
  "read|read_exact|read_to_end|read_to_string|read_line|read_until|read_vectored|read_buf|" +
  "read_buf_exact|read_at|read_exact_at|recv|recv_from|recv_vectored|recvfrom|recvmsg|recvmmsg|" +
  "peek|peek_from|pread|readv|preadv";

// A read in a function's body. A method must be given something to read into, so a channel's
// `recv()`, an iterator's `peek()` and `OpenOptions::read(true)` aren't reads; stdin counts once it
// is read from or kept, not when it is only handed to `isatty` or `tcgetattr`. A call by a bare
// name is BARE_READ's.
const BODY_READS = new RegExp(
  [
    `\\.\\s*(?:${READS})\\s*\\(\\s*(?!(?:true|false)\\s*\\))[^)\\s]`,
    `::\\s*(?:${READS}|fill_buf)\\s*\\(`,
    "\\.\\s*fill_buf\\s*\\(",
    "\\bio\\s*::\\s*copy\\s*\\(",
    "\\bfrom_reader\\s*\\(",
    "\\bBufReader\\b",
    "\\bstdin\\s*\\(\\s*\\)\\s*(?:\\.\\s*(?:lock|lines|bytes)\\b|;)",
  ].join("|"),
);

// A read called by a bare name, as a `use libc::read;` or `use std::io::copy;` lets it be. A
// function of the file's own by that name is read where it is defined, so a call to it isn't one.
const BARE_READ = new RegExp(`(?<![.:]\\s*|\\bfn\\s+)\\b(${READS}|fill_buf|copy)\\s*\\(`, "g");

// A call through `self.` or `Self::` to a method named as a read. When the call is to a method the
// type's impl defines, it is read where that method is defined, as a bare name's is: one that takes
// bytes is a decoder there, and its callers through it. `Self::read` names the impl's own first.
// `self.read` does only where method lookup reaches it before a trait's: lookup tries the
// receiver's own type before borrowing it, so `self.read(&mut b)` in a `&mut self` method is
// io::Read's when the impl's own `read` takes `&self`, and in a `&self` method a trait's `&self`
// read wins over an own one taking `&mut self`. The own method wins only when it takes self as the
// caller does.
const SELF_READ = new RegExp(`\\b(self\\s*\\.|Self\\s*::)\\s*(${READS})(?=\\s*\\()`, "g");

// How a function takes self: `&mut`, `&` or by value, or none of these, as with `self: Box<Self>`
// or no self at all.
const receiver = (takes: string): "&mut" | "&" | "self" | undefined => {
  const first = /\(\s*(&\s*(?:'\w+\s+)?(mut\s+)?)?(?:mut\s+)?self\s*[,)]/.exec(takes);
  if (first === null) return undefined;
  if (first[1] === undefined) return "self";
  return first[2] === undefined ? "&" : "&mut";
};

// The names a `use … as` may not rename: each byte type above, and the containers that hold u8s.
const BYTE_TYPE_NAMES = new Set(
  (
    "u8 Read BufRead AsyncRead AsyncBufRead Reader BufReader Buf Bytes BytesMut Stdin StdinLock " +
    "ChildStdout ChildStderr WebSocket Vec VecDeque"
  ).split(" "),
);

/** The fields of a carrier that hold its bytes; `undefined` when any use of `self` may reach them. */
type Fields = Set<string> | undefined;

const unionFields = (a: Fields, b: Fields): Fields =>
  a === undefined || b === undefined ? undefined : new Set([...a, ...b]);

/** A name as a type is written: the path ending at it, `undefined` when it can't be followed. */
type Named = { name: string; path: string[] | undefined };

/** An identifier as Rust reads it: `r#type` is `type`. */
const rawless = (name: string) => name.replace(/^r#/, "");

/**
 * Each byte field, by name, of a struct carrier whose type names struct carriers only by a plain
 * path, behind at most a reference, `Box`, `Arc` or `Rc`: the carriers it may be. A use of such a
 * field may be shown not to reach their bytes (`Scope.reaches`); any other byte field's can't.
 */
type Views = Map<string, Item[]>;

/** A carrier's byte fields, and the views of those that have one. */
type Carrier = { fields: Fields; views: Views };

/**
 * What the names written in one file mean to the decoder rule. A carrier is a type holding bytes
 * from outside, by a field of a byte type or of another carrier: an enum, whose variants are read
 * by `match self`, holds them in any use of `self`, as does a struct whose bytes come by a type
 * parameter bounded by a byte trait (`struct R<T: Read>`).
 */
interface Scope {
  /** Whether a type written in `text`, at `at` in the file's code, is a carrier. */
  names(text: string, at: number): boolean;
  /** The fields holding the bytes of the type `named`, at `at`, names; `null` if not a carrier. */
  carrier(named: Named, at: number): Carrier | null;
  /**
   * Whether the use of a field, from `from` to `to` in `body`, whose view is `items` may reach
   * their bytes. It may unless it reads a field of theirs that holds none, or calls a method that
   * every one of them has inherently, whose signature can't hand bytes either way and which isn't a
   * decoder itself, where no trait may answer the call instead.
   */
  reaches(items: Item[], body: string, from: number, to: number): boolean;
  /** The byte-carrying variants of the enum `named`, at `at`, names, each with its byte fields. */
  variants(named: Named, at: number): Map<string, Fields> | undefined;
  /** The name of each enum with a byte-carrying variant. */
  enums: Set<string>;
}

const NO_CARRIERS: Scope = {
  names: () => false,
  carrier: () => null,
  reaches: () => true,
  variants: () => undefined,
  enums: new Set(),
};

/** The workspace's carriers, and by name, for a name that can't be resolved to its type. */
interface Carriers {
  fields: Map<Item, Fields>;
  variants: Map<Item, Map<string, Fields>>;
  byName: Map<string, Fields>;
  variantsByName: Map<string, Map<string, Fields>>;
  views: Map<Item, Views>;
  /** Each struct carrier's fields, by name. */
  named: Map<Item, Set<string>>;
}

/**
 * What the decoder rule reads an item's bytes from: an enum's head and its fields' types, an
 * alias's type, and an associated type's bounds and type (`type R: Read`, `type Item = Frame`).
 */
function itemTypes(item: Item, assoc: boolean): string {
  if (assoc) return item.text.replace(/^type\s+(?:r#)?\w+/, "");
  if (item.kind === "type") return /=([\s\S]*)$/.exec(item.text)?.[1] ?? "";
  if (item.kind !== "enum") return item.text.slice(item.kind.length + 1).replace(/^\s*\w+/, "");
  const variants = enumVariants(item.text);
  return variants === undefined
    ? item.text
    : [
        variants.head,
        ...variants.variants.flatMap((v) => v.fields?.map((f) => f.type) ?? v.text),
      ].join("\n");
}

const resolveNamed = (table: ModuleTable, module: Module, { name, path }: Named): Resolution =>
  path === undefined
    ? { items: [], modules: [], unresolved: new Set([name]) }
    : table.resolve(module, path);

/**
 * The carriers among the workspace's types, found by resolving each name in a type from the
 * module it is written in. A name that can't be resolved is taken for every carrier of that name,
 * so what resolution can't settle counts as it would by name alone. An associated type is one of
 * them, since only such a name reaches it: `Self::Item`, whatever impl sets it, is every `Item`.
 */
function carriersOf(table: ModuleTable): Carriers {
  const assocs = new Set(table.assocs);
  const types = [...table.items.filter((i) => i.kind !== "trait"), ...assocs];
  const named = new Map(
    types.map((item) => [
      item,
      typePaths(itemTypes(item, assocs.has(item))).map((n) => resolveNamed(table, item.module, n)),
    ]),
  );
  const found = new Set(
    types.filter((i) =>
      BYTES_IN.test(
        i.kind === "struct" || i.kind === "union" ? i.text : itemTypes(i, assocs.has(i)),
      ),
    ),
  );
  // A type holding a carrier carries bytes too, however deep: repeat until nothing is added.
  for (let grew = true; grew;) {
    grew = false;
    const names = new Set([...found].map((i) => i.name));
    for (const item of types.filter((t) => !found.has(t))) {
      const resolutions = named.get(item) ?? [];
      if (
        resolutions.some(
          (r) => r.items.some((i) => found.has(i)) || [...r.unresolved].some((n) => names.has(n)),
        )
      ) {
        found.add(item);
        grew = true;
      }
    }
  }
  const names = new Set([...found].map((i) => i.name));
  const isCarrier = (r: Resolution) =>
    r.items.some((i) => found.has(i)) || [...r.unresolved].some((n) => names.has(n));
  const holds = (type: string, module: Module) =>
    BYTES_IN.test(type) || typePaths(type).some((n) => isCarrier(resolveNamed(table, module, n)));
  const fields = new Map<Item, Fields>();
  const fieldNames = new Map<Item, Set<string>>();
  for (const item of found) {
    const struct = item.kind === "struct" ? structFields(item.text) : undefined;
    if (struct === undefined || holds(struct.head, item.module)) {
      fields.set(item, undefined);
      continue;
    }
    fields.set(
      item,
      new Set(struct.fields.filter((f) => holds(f.type, item.module)).map((f) => f.name)),
    );
    fieldNames.set(item, new Set(struct.fields.map((f) => rawless(f.name))));
  }
  const views = new Map<Item, Views>();
  for (const item of fieldNames.keys()) {
    const byField: Views = new Map();
    for (const f of structFields(item.text)?.fields ?? []) {
      const viewed = holds(f.type, item.module) ? viewOf(table, item.module, f.type) : undefined;
      if (viewed?.every((i) => fieldNames.has(i)) === true) byField.set(rawless(f.name), viewed);
    }
    views.set(item, byField);
  }
  const byName = new Map<string, Fields>();
  for (const [item, f] of fields) {
    byName.set(item.name, byName.has(item.name) ? unionFields(byName.get(item.name), f) : f);
  }
  const variants = new Map<Item, Map<string, Fields>>();
  const variantsByName = new Map<string, Map<string, Fields>>();
  for (const item of types.filter((i) => i.kind === "enum")) {
    const parsed = enumVariants(item.text);
    if (parsed === undefined) continue;
    const whole = holds(parsed.head, item.module);
    const byVariant = new Map<string, Fields>();
    for (const v of parsed.variants) {
      if (v.fields === undefined) {
        if (holds(v.text.slice(v.name.length), item.module)) byVariant.set(v.name, undefined);
        continue;
      }
      const held = v.fields
        .map((f, i) => ({ ...f, last: String(i - (v.fields?.length ?? 0)) }))
        .filter((f) => whole || holds(f.type, item.module))
        .flatMap((f) => [f.name, f.last]);
      if (held.length > 0) byVariant.set(v.name, new Set(held));
    }
    if (byVariant.size === 0) continue;
    variants.set(item, byVariant);
    variantsByName.set(item.name, mergeVariants(variantsByName.get(item.name), byVariant));
  }
  return { fields, variants, byName, variantsByName, views, named: fieldNames };
}

// A field's type that names one type by a plain path, behind at most a reference, an Arc, an Rc
// or a Box, whose methods a call on the field reaches by auto-deref, with none of the wrapper's own
// in the way. Anything else (a Mutex, an Option, a generic) answers calls with methods of its own.
const VIEWED =
  /^(?:&\s*(?:'\w+\s+)?(?:mut\s+)?)?(?:((?:(?:r#)?\w+\s*::\s*)*)(Arc|Rc|Box)\s*<\s*([^<>]*?)\s*>|([^<>]*?))$/;

const fromStdPath = (path: string[]) => /^(?:std|core|alloc)$/.test(path[0] ?? "");

/**
 * The items a field's `type`, written in `module`, names when it has VIEWED's shape and its wrapper
 * is std's: written by a std path, or brought in by a `use` of one (`Box` needs none). `undefined`
 * when it doesn't, or when a name in it can't be resolved.
 */
function viewOf(table: ModuleTable, module: Module, type: string): Item[] | undefined {
  const shape = VIEWED.exec(type.trim());
  const inner = shape?.[3] ?? shape?.[4];
  if (shape === null || inner === undefined) return undefined;
  const wrapper = shape[2];
  if (wrapper !== undefined) {
    const prefix = (shape[1] ?? "").split("::").map((p) => rawless(p.trim()));
    const bound = module.uses.get(wrapper)?.map((b) => b.value.path) ?? [];
    const fromStd =
      prefix.length > 1
        ? fromStdPath(prefix)
        : bound.length > 0
          ? bound.every(fromStdPath)
          : wrapper === "Box" && module.globs.length === 0;
    if (!fromStd) return undefined;
  }
  const path = inner.split("::").map((p) => rawless(p.trim()));
  const r = resolveNamed(table, module, { name: path.at(-1) ?? "", path });
  return r.unresolved.size === 0 && r.items.length > 0 ? r.items : undefined;
}

/**
 * Two carriers' views, as one: a field keeps its view only where every carrier holding bytes in it
 * gives it one.
 */
function mergeViews(a: Carrier, b: Carrier): Views {
  const holds = (c: Carrier, field: string) =>
    c.fields === undefined || [...c.fields].some((f) => rawless(f) === field);
  const out: Views = new Map();
  for (const field of new Set([...a.views.keys(), ...b.views.keys()])) {
    const va = a.views.get(field);
    const vb = b.views.get(field);
    if ((va === undefined && holds(a, field)) || (vb === undefined && holds(b, field))) continue;
    out.set(field, [...(va ?? []), ...(vb ?? [])]);
  }
  return out;
}

/** Two enums' byte-carrying variants, as one: either's fields may be the one a pattern binds. */
function mergeVariants(
  a: Map<string, Fields> | undefined,
  b: Map<string, Fields>,
): Map<string, Fields> {
  const out = new Map(a);
  for (const [v, f] of b) out.set(v, out.has(v) ? unionFields(out.get(v), f) : f);
  return out;
}

/** What a use of a field with a view is checked against: the same for every file. */
interface Through {
  /** Whether views are read: not on the first pass, which finds the decoders without them. */
  active: boolean;
  /** The decoders the last pass found, by key (`file::Type::fn`). */
  takers: Set<string>;
  /** Each viewed carrier's inherent methods, by name: each one's key, and whether it exposes bytes. */
  methods: Map<Item, Map<string, { key: string; exposes: boolean }[]>>;
  /** The names an impl of a trait for a type naming the item may answer; `undefined`: any. */
  traits: Map<Item, Set<string> | undefined>;
  /** The names an impl of a trait for every type may answer; `undefined`: any. */
  blanket: Set<string> | undefined;
  /** The types an attribute the scan can't read is on, which may answer any name or rewrite a field. */
  opaque: Set<Item>;
}

const unionNames = (a: Set<string> | undefined, b: Set<string> | undefined) =>
  a === undefined || b === undefined ? undefined : new Set([...a, ...b]);

// The methods a trait may answer for a carrier, or a reference, an Arc, an Rc or a Box of one, by
// an impl the scan can't read: one std writes for every type, a derive writes, or std writes for
// the wrapper. A carrier's own method of one of these names may lose the call to it.
const TRAIT_METHODS = new Set(
  (
    "as_mut as_ref borrow borrow_mut clamp clone clone_from clone_into cmp deref deref_mut drop " +
    "eq fmt ge gt hash hash_slice into le lt max min ne partial_cmp to_owned to_string try_into " +
    "type_id"
  ).split(" "),
);

// The std traits with no method outside TRAIT_METHODS, so that an impl of one answers no other
// name. An impl of any other trait from outside the workspace may answer any, and so may one of
// Deref or DerefMut: a call the type's own methods don't answer goes on to its target's.
const STD_TRAITS = new Set(
  (
    "AsMut AsRef Borrow BorrowMut Clone Copy Debug Default Display Drop Eq From Hash Ord " +
    "PartialEq PartialOrd Send Sync Unpin"
  ).split(" "),
);

// Types of std a `use` may bring in that aren't traits. Any other name from outside the workspace
// a `use` brings in may be a trait, whose methods the scan can't read.
const STD_TYPES = new Set(
  (
    "Arc AtomicBool AtomicI64 AtomicU32 AtomicU64 AtomicUsize BTreeMap BTreeSet BinaryHeap Cell " +
    "Condvar Cow Duration HashMap HashSet Instant LazyLock Mutex MutexGuard OnceCell OnceLock " +
    "Ordering OsStr OsString Path PathBuf PhantomData Pin PoisonError Rc RefCell RwLock " +
    "SystemTime VecDeque Weak"
  ).split(" "),
);

/**
 * Whether a `use` in `file`, or in a module of the workspace a glob of its brings in, may bring a
 * trait from outside the workspace into scope: by a glob, as `_`, or by a name that isn't one of
 * STD_TYPES. Its methods, which the scan can't read, may answer a call on a field. A name a module
 * of the workspace holds that isn't an item (a const, a function) is no trait; one it brings in by
 * a `use` of its own is that `use`'s.
 */
function foreignTraits(table: ModuleTable, file: string): boolean {
  const seen = new Set<UseBinding>();
  const foreignUse = (module: Module, b: UseBinding): boolean => {
    if (seen.has(b)) return false;
    seen.add(b);
    const r = table.resolve(module, b.path);
    if (r.items.length > 0 || r.modules.length > 0) {
      return b.name === "*" && r.modules.some((m) => m.bindings.some((g) => foreignUse(m, g)));
    }
    const last = rawless(b.path.at(-1) ?? "");
    const holders = b.path.length > 1 ? table.resolve(module, b.path.slice(0, -1)).modules : [];
    if (b.name !== "*" && holders.length > 0) {
      return holders.some((m) => (m.uses.get(last) ?? []).some((u) => foreignUse(m, u.value)));
    }
    return (
      b.name === "*" ||
      b.renamed?.endsWith(" as _") === true ||
      (/^[A-Z]/.test(last) && !(fromStdPath(b.path) && STD_TYPES.has(last)))
    );
  };
  return table.modulesIn(file).some((m) => m.bindings.some((b) => foreignUse(m, b)));
}

/** Whether the code at `at` in `body` is inside a macro's brackets, whose tokens it may rearrange. */
function inMacro(body: string, at: number): boolean {
  for (let open = enclosingBracket(body, at); open !== -1; open = enclosingBracket(body, open)) {
    if (/!\s*$/.test(body.slice(0, open))) return true;
  }
  return false;
}

/**
 * What the names in `file` mean, each resolved from the module it is written in, and, once
 * `through` is active, which uses of a field with a view may reach its bytes.
 */
function fileScope(table: ModuleTable, carriers: Carriers, file: string, through?: Through): Scope {
  const resolutions = (named: Named, at: number) => {
    const modules = table.modulesAt(file, at);
    return modules.length === 0
      ? [{ items: [], modules: [], unresolved: new Set([named.name]) }]
      : modules.map((m) => resolveNamed(table, m, named));
  };
  const carrier = (named: Named, at: number) => {
    let out: Carrier | null = null;
    const add = (fields: Fields, views: Views) => {
      out =
        out === null
          ? { fields, views }
          : { fields: unionFields(out.fields, fields), views: mergeViews(out, { fields, views }) };
    };
    for (const r of resolutions(named, at)) {
      for (const item of r.items) {
        if (carriers.fields.has(item)) {
          add(carriers.fields.get(item), carriers.views.get(item) ?? new Map());
        }
      }
      for (const name of r.unresolved)
        if (carriers.byName.has(name)) add(carriers.byName.get(name), new Map());
    }
    return out;
  };
  let opaque: boolean | undefined;
  const reaches = (items: Item[], body: string, from: number, to: number) => {
    if (through?.active !== true || /\buse\b/.test(body) || inMacro(body, from)) return true;
    if (items.some((i) => through.opaque.has(i))) return true;
    opaque ??= foreignTraits(table, file);
    if (opaque) return true;
    const next = new RegExp(String.raw`^\s*\.\s*(?:r#)?(\w+)(${TURBOFISH}\s*\()?`).exec(
      body.slice(to),
    );
    const name = next?.[1];
    if (name === undefined) return true;
    if (next?.[2] === undefined) {
      const held = (i: Item) =>
        [...(carriers.fields.get(i) ?? [name])].some((f) => rawless(f) === name);
      return !items.every((i) => carriers.named.get(i)?.has(name) === true && !held(i));
    }
    const { methods, traits, blanket, takers } = through;
    if (TRAIT_METHODS.has(name) || blanket === undefined || blanket.has(name)) return true;
    return !items.every((i) => {
      if (traits.has(i) && (traits.get(i)?.has(name) ?? true)) return false;
      const own = methods.get(i)?.get(name) ?? [];
      return own.length > 0 && own.every((m) => !m.exposes && !takers.has(m.key));
    });
  };
  return {
    names: (text, at) => typePaths(text).some((n) => carrier(n, at) !== null),
    carrier,
    reaches,
    variants: (named, at) => {
      let out: Map<string, Fields> | undefined;
      for (const r of resolutions(named, at)) {
        for (const item of r.items) {
          const v = carriers.variants.get(item);
          if (v !== undefined) out = mergeVariants(out, v);
        }
        for (const name of r.unresolved) {
          const v = carriers.variantsByName.get(name);
          if (v !== undefined) out = mergeVariants(out, v);
        }
      }
      return out;
    },
    enums: new Set(carriers.variantsByName.keys()),
  };
}

/**
 * A struct's fields, by name or, in a tuple struct, by index, each with whether it is `pub` to
 * other crates, and its head: its generics and `where` clause. `undefined` when the fields can't
 * be told apart. A `<` or `>` is a bracket only where a type can have one, outside any `( [ {`
 * nested in a field or the generics, since one inside may be a shift in a length (`[u8; 1 << 4]`).
 */
function structFields(
  item: string,
): { head: string; fields: { name: string; type: string; public: boolean }[] } | undefined {
  const name = /\bstruct\s+\w+\s*/.exec(item);
  const from = (name?.index ?? 0) + (name?.[0].length ?? 0);
  let i = from;
  for (let angles = 0, nested = 0; i < item.length; i++) {
    const c = item[i] ?? "";
    if (nested === 0 && angles === 0 && "{(;".includes(c)) break;
    if ("([{".includes(c)) nested++;
    else if (")]}".includes(c)) nested--;
    else if (nested === 0 && c === "<") angles++;
    else if (nested === 0 && c === ">" && item[i - 1] !== "-") angles--;
  }
  const open = item[i];
  if (open !== "{" && open !== "(") return { head: item.slice(from), fields: [] };
  const parts: string[] = [];
  let start = i + 1;
  let close = -1;
  let angles = 0;
  for (let j = i, nested = 0; j < item.length; j++) {
    const c = item[j] ?? "";
    if ("([{".includes(c)) {
      nested++;
    } else if (")]}".includes(c)) {
      nested--;
      if (nested === 0) {
        close = j;
        break;
      }
    } else if (nested === 1 && c === "<") {
      angles++;
    } else if (nested === 1 && c === ">" && item[j - 1] !== "-") {
      angles--;
    } else if (nested === 1 && angles === 0 && c === ",") {
      parts.push(item.slice(start, j));
      start = j + 1;
    }
  }
  if (close === -1 || angles !== 0) return undefined;
  parts.push(item.slice(start, close));
  const fields = parts
    .map((p) => p.replace(/#\s*\[(?:[^[\]]|\[[^\]]*\])*\]/g, "").trim())
    .filter((p) => p !== "")
    .map((p, index) => {
      const visibility = /^pub\b\s*(\([^)]*\))?\s*/.exec(p);
      const field = p.slice(visibility?.[0].length ?? 0);
      const named = /^((?:r#)?\w+)\s*:(?!:)([\s\S]*)$/.exec(field);
      return {
        name: open === "{" ? named?.[1] : String(index),
        type: open === "{" ? (named?.[2] ?? field) : field,
        public: visibility !== null && visibility[1] === undefined,
      };
    });
  if (fields.some((f) => f.name === undefined)) return undefined;
  return {
    head: item.slice(from, i) + item.slice(close + 1),
    fields: fields.map((f) => ({ ...f, name: f.name ?? "" })),
  };
}

type Variant = { name: string; text: string; fields: { name: string; type: string }[] | undefined };

/**
 * An enum's head (its generics and `where` clause) and its variants, each with its fields as a
 * struct's are read (`undefined` when they can't be told apart). `undefined` when the enum has no
 * body.
 */
function enumVariants(item: string): { head: string; variants: Variant[] } | undefined {
  const name = /\benum\s+\w+\s*/.exec(item);
  const from = (name?.index ?? 0) + (name?.[0].length ?? 0);
  let open = from;
  for (let angles = 0, nested = 0; open < item.length; open++) {
    const c = item[open] ?? "";
    if (nested === 0 && angles === 0 && c === "{") break;
    if ("([".includes(c)) nested++;
    else if (")]".includes(c)) nested--;
    else if (nested === 0 && c === "<") angles++;
    else if (nested === 0 && c === ">" && item[open - 1] !== "-") angles--;
  }
  if (item[open] !== "{") return undefined;
  const close = itemEnd(item, open) - 1;
  const parts: string[] = [];
  let start = open + 1;
  for (let i = start, nested = 0; i < close; i++) {
    const c = item[i] ?? "";
    if ("([{".includes(c)) nested++;
    else if (")]}".includes(c)) nested--;
    else if (nested === 0 && c === ",") {
      parts.push(item.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(item.slice(start, close));
  const variants = parts
    .map((p) => p.replace(/#\s*\[(?:[^[\]]|\[[^\]]*\])*\]/g, "").trim())
    .filter((p) => p !== "")
    .map((text) => {
      // Anything else before or after the name (an attribute left half stripped) and its fields
      // can't be told apart, so it fails rather than reading as a variant with none.
      const variant = /^(?:r#)?(\w+)\s*(?=$|[({=])/.exec(text);
      const rest = text.slice(variant?.[0].length ?? 0);
      const fields =
        variant === null
          ? undefined
          : /^[({]/.test(rest)
            ? structFields(`struct ${variant[1] ?? ""} ${rest}`)?.fields
            : [];
      return { name: variant?.[1] ?? /\w+/.exec(text)?.[0] ?? "", text, fields };
    });
  return { head: item.slice(from, open), variants };
}

/**
 * Whether a method body reaches the bytes of `self`, whose type holds them in `fields`
 * (`undefined`: in any use of `self`). It does by `self` itself handed on or matched, by calling a
 * method of its own that does (`calls`) or one it doesn't know, or by a use of one of those fields,
 * from `from` to `to` in `body`, that `field` says may reach them.
 */
function reachesBytes(
  body: string,
  fields: Set<string> | undefined,
  calls: (method: string) => boolean,
  field: (name: string, from: number, to: number) => boolean = () => true,
): boolean {
  if (fields === undefined) return true;
  if (/\bself\b(?!\s*(?:\.|::))/.test(body)) return true;
  const held = [...fields].map(rawless);
  if (
    held.length > 0 &&
    [...body.matchAll(new RegExp(`\\bself\\s*\\.\\s*(?:r#)?(${held.join("|")})\\b`, "g"))].some(
      (m) => field(m[1] ?? "", m.index, m.index + m[0].length),
    )
  ) {
    return true;
  }
  return [...body.matchAll(/\bself\s*\.\s*(?:r#)?(\w+)\s*(?:::\s*<[^()]*>\s*)?\(/g)].some(([, m]) =>
    calls(m ?? ""),
  );
}

/** The index of the bracket closing the `(`, `[` or `{` at `open`, or the end of `code`. */
function matchingBracket(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if ("([{".includes(code[i] ?? " ")) depth++;
    else if (")]}".includes(code[i] ?? " ") && --depth === 0) return i;
  }
  return code.length;
}

/** The index of the innermost bracket open around `at`, or -1. */
function enclosingBracket(code: string, at: number): number {
  for (let i = at - 1, depth = 0; i >= 0; i--) {
    if (")]}".includes(code[i] ?? " ")) depth++;
    else if ("([{".includes(code[i] ?? " ") && depth-- === 0) return i;
  }
  return -1;
}

/**
 * The text before `at` back to the start of its arm or statement: just past the nearest `,`, `;`
 * or `}` outside brackets (an arm whose body is a block needs no comma), or the bracket open
 * around it.
 */
function headBefore(code: string, at: number): string {
  let i = at - 1;
  for (let depth = 0; i >= 0; i--) {
    const c = code[i] ?? "";
    if (depth === 0 && ",;}".includes(c)) break;
    if (")]}".includes(c)) depth++;
    else if ("([{".includes(c) && depth-- === 0) break;
  }
  return code.slice(i + 1, at);
}

/** Text ending in a value a `[` after it indexes: a name that isn't a keyword, or a bracket. */
const INDEXED =
  /(?:[)\]]|\b(?!(?:let|in|match|if|while|for|return|break|else|move|yield)\b)(?:r#)?\w+)\s*$/;

/**
 * Whether the value from `start` to `end` in `code` is (part of) a pattern: what follows it, once
 * out of the brackets around it (a tuple, a slice, `Some(…)`, a struct), is a match arm's `=>`
 * with no guard before it, an or-pattern's `|` (a closure's parameters' too), a guard's `if`
 * (`matches!`'s too), a `for`'s `in`, the `:` before a `let`'s or a parameter's type, or an `=`:
 * a `let`'s, a destructuring assignment's, or a `select!` arm's. A value built rather than matched
 * is followed by none of those: what follows the brackets around it is a `;`, the end of its
 * block, or a guard's `=>`; and one in an index is an expression, even one assigned to. A pattern
 * binding a name in `matches!` without a guard can't use it, so that needs no case.
 */
function inPattern(code: string, start: number, end: number): boolean {
  for (let from = start, to = end; ;) {
    const next = code.slice(to).trimStart();
    if (next.startsWith("=>")) return !/\bif\b/.test(headBefore(code, from));
    if (/^(?:=(?!=)|:(?!:)|\|(?!\|)|if\b|in\b)/.test(next)) return true;
    const open = enclosingBracket(code, from);
    if (open === -1 || (code[open] === "[" && INDEXED.test(code.slice(0, open)))) return false;
    from = open;
    to = matchingBracket(code, open) + 1;
  }
}

/**
 * Whether a pattern binds a name: a lowercase identifier that isn't a path, a field's name, `_` or
 * a literal. (`ref` and `mut` count, but only ever before a name that binds.)
 */
const bindsName = (pattern: string) =>
  [...pattern.matchAll(/(?<![\w.:]|::\s*)(?:r#)?[a-z_]\w*\b(?!\s*(?:::|[({!"']|:(?!:)))/g)].some(
    ([word]) => !/^(?:_|true|false)$/.test(word),
  );

/** A bracket's contents split at its top-level commas, each trimmed. */
function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0, depth = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return [...parts, text.slice(start)].map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * Whether a variant's pattern, `inner` its bracket's contents, binds a field of `fields`
 * (`undefined`: any field). A tuple variant's fields count from the front before a `..` and from
 * the back after it, as `-1` for the last.
 */
function bindsField(inner: string, named: boolean, fields: Set<string> | undefined): boolean {
  const parts = topLevelParts(inner);
  if (!named) {
    const rest = parts.indexOf("..");
    return parts.some(
      (p, i) =>
        p !== ".." &&
        bindsName(p) &&
        (fields === undefined ||
          fields.has(rest !== -1 && i > rest ? String(i - parts.length) : String(i))),
    );
  }
  return parts.some((p) => {
    const field = /^((?:r#)?\w+)\s*:(?!:)([\s\S]*)$/.exec(p);
    const name = field?.[1] ?? /(\w+)$/.exec(p)?.[1] ?? "";
    const bound = field === null ? p !== ".." : bindsName(field[2] ?? "");
    return bound && (fields === undefined || fields.has(name));
  });
}

/**
 * Where each `name @ subpattern` in `body` puts its subpattern: from just past the `@` through the
 * subpattern's path and the bracket after it (`m @ Some(…)`, `m @ (… | …)`, `m @ &Msg::Raw(…)`).
 */
function atBindings(body: string): [number, number][] {
  return [...body.matchAll(/\b(?:r#)?[a-z_]\w*\s*@/g)].map((m) => {
    const from = m.index + m[0].length;
    const lead = /^(?:\s|&|\bmut\b|\bbox\b|(?:r#)?\w+|::|<(?:[^<>]|<[^<>]*>)*>)*/.exec(
      body.slice(from),
    );
    const at = from + (lead?.[0].length ?? 0);
    return [from, "([{".includes(body[at] ?? " ") ? matchingBracket(body, at) + 1 : at];
  });
}

/** Generic arguments in a path (`::<T>`), as a pattern may give an enum or a variant. */
const TURBOFISH = String.raw`(?:\s*::\s*<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?`;

/**
 * Whether `body`, at `offset` in its file's code, has a pattern naming a variant of an enum with
 * one carrying bytes that binds a field holding them, or binds a value holding the variant whole
 * (`r @ Reply::Data { .. }`, `r @ Some(Reply::Data { .. })`). `own`, the type an impl is for, is
 * what `Self::` names there.
 */
function bindsByteVariant(
  body: string,
  offset: number,
  scope: Scope,
  own?: { named: Named; at: number },
): boolean {
  const ownVariants = own === undefined ? undefined : scope.variants(own.named, own.at);
  const enums = [...scope.enums, ...(ownVariants === undefined ? [] : ["Self"])];
  if (enums.length === 0) return false;
  const bound = atBindings(body);
  const path = new RegExp(
    `\\b(${enums.join("|")})${TURBOFISH}\\s*::\\s*(?:r#)?(\\w+)\\b${TURBOFISH}(?!\\s*::)`,
    "g",
  );
  for (const m of body.matchAll(path)) {
    const name = m[1] ?? "";
    const byVariant =
      name === "Self"
        ? ownVariants
        : scope.variants({ name, path: pathBefore(body, m.index, name) }, offset + m.index);
    if (byVariant === undefined || !byVariant.has(m[2] ?? "")) continue;
    if (bound.some(([from, to]) => from <= m.index && m.index < to)) return true;
    const after = m.index + m[0].length;
    const open = after + (body.slice(after).length - body.slice(after).trimStart().length);
    const bracket = body[open] === "(" || body[open] === "{";
    const close = bracket ? matchingBracket(body, open) : after - 1;
    if (!inPattern(body, m.index, close + 1)) continue;
    const fields = byVariant.get(m[2] ?? "");
    if (bracket && bindsField(body.slice(open + 1, close), body[open] === "{", fields)) {
      return true;
    }
  }
  return false;
}

/**
 * Each impl block in `code`: where it spans, the type it is for, and whether its generics or
 * `where` clause bound a parameter by a byte trait (`impl<R: Read> Reader<R>`).
 */
function implBlocks(code: string): {
  start: number;
  end: number;
  head: string;
  type: string;
  named: Named;
  byteBound: boolean;
}[] {
  return implHeads(code).flatMap(({ start, open }) => {
    if (open === undefined) return [];
    const head = code.slice(start, open);
    const type = /((?:::\s*)?(?:(?:r#)?\w+\s*::\s*)*)(\w+)\s*(?:<|$)/.exec(implParts(head).type);
    const name = type?.[2] ?? "";
    const prefix = (type?.[1] ?? "")
      .split("::")
      .slice(0, -1)
      .map((p) => rawless(p.trim()));
    return [
      {
        start,
        end: itemEnd(code, open),
        head,
        type: name,
        named: { name, path: [...prefix, name] },
        byteBound: BYTES_IN.test(head),
      },
    ];
  });
}

/**
 * Each impl item in `code`: where it starts, and its body's `{`, or `undefined` where its head
 * can't be read, with where reading the head stopped. An `impl` at a line's start after anything
 * but a `;`, a brace or an attribute's `]` may be an `impl Trait` type that a long signature
 * wrapped onto its own line, or an impl in a macro's body (`=> (`, `$(`): it is an item if its
 * head can be read, and a type, passed over, if not. Reading resumes where the last head stopped,
 * so a file of heads that never end is read once.
 */
function implHeads(code: string): { start: number; open: number | undefined; end: number }[] {
  const out: { start: number; open: number | undefined; end: number }[] = [];
  const starts = new RegExp(IMPL_START.source, IMPL_START.flags);
  for (let m = starts.exec(code); m !== null; m = starts.exec(code)) {
    let before = m.index - 1;
    while (before >= 0 && RUST_WHITESPACE.has(code[before] ?? "")) before--;
    const head = implHead(code, m.index + m[0].length);
    starts.lastIndex = head.end;
    if (head.open === undefined && before >= 0 && !";{}]".includes(code[before] ?? "")) continue;
    out.push({ start: m.index, ...head });
  }
  return out;
}

/**
 * Where an impl's head that goes on from `from` ends: `open` is its body's `{`, or `undefined`
 * where it can't be read, at `end`. Brackets are matched (a `>` after `-` is an arrow's), and a
 * brace block inside them is skipped whole, so neither an array's `;` nor a const expression's
 * `>` ends the head. After an array's `;` comes its length, an expression, where `<` and `>` are
 * operators (`[u8; 8 >> 1]`). A `;` or `}` outside them, a closer that doesn't match, or the end
 * of the code can't be read.
 */
function implHead(code: string, from: number): { open: number | undefined; end: number } {
  const open: Bracket[] = [];
  for (let i = from; i < code.length; i++) {
    const c = code[i] ?? "";
    const top = open.at(-1);
    if (c === "{" && top === undefined) return { open: i, end: i };
    if (c === "{") i = closingBrace(code, i + 1) - 1;
    else if (!takeBracket(open, c, code[i - 1])) return { open: undefined, end: i };
  }
  return { open: undefined, end: code.length };
}

interface Bracket {
  closer: string;
  /** Whether it is in an array's length, where `<` and `>` are operators. */
  expression: boolean;
}

/**
 * Takes `c`, after `previous`, into the brackets `open` in a type: false where it can't be read
 * there, a closer that doesn't match or a `;` or `}` outside an array.
 */
function takeBracket(open: Bracket[], c: string, previous: string | undefined): boolean {
  const top = open.at(-1);
  const expression = top?.expression ?? false;
  const closer = { "(": ")", "[": "]", "<": expression ? undefined : ">" }[c];
  if (closer !== undefined) open.push({ closer, expression });
  else if (c === ")" || c === "]" || (c === ">" && !expression && previous !== "-")) {
    return open.pop()?.closer === c;
  } else if (c === ";" && top?.closer === "]") top.expression = true;
  else if (c === ";" || c === "}") return false;
  return true;
}

/** The line of each impl in `code` whose head can't be read. */
function unreadImplLines(code: string): number[] {
  const lines: number[] = [];
  let line = 1;
  let counted = 0;
  for (const { start, open } of implHeads(code)) {
    if (open !== undefined) continue;
    let at = start;
    while (RUST_WHITESPACE.has(code[at] ?? "")) at++;
    for (; counted < at; counted++) if (code[counted] === "\n") line++;
    lines.push(line);
  }
  return lines;
}

/** `code` with each item matched by `head` blanked to its end, newlines kept. */
function blankItems(code: string, head: RegExp): string {
  return blankSpans(
    code,
    [...code.matchAll(head)].map((m) => ({
      start: m.index,
      end: itemEnd(code, m.index + m[0].length),
    })),
  );
}

/** `code` with each of `spans`, in the order they start, blanked, newlines kept. */
function blankSpans(code: string, spans: { start: number; end: number }[]): string {
  let out = "";
  let at = 0;
  for (const { start, end } of spans) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    out += code.slice(at, from) + newlinesIn(code.slice(from, end)).padStart(end - from);
    at = end;
  }
  return out + code.slice(at);
}

/** The code of a Rust file with every `#[cfg(test)]` item blanked out, newlines kept. */
const withoutTests = (code: string) => blankItems(code, /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g);

/**
 * Where an item's signature ends (its first `{` or `;` outside brackets), and what a function
 * takes: the signature less its return type, so its generics, parameters and `where` clause.
 * Brackets are counted, so a `;` in `[u8; 4]` or a `->` in a parameter's `fn() -> u8` isn't
 * taken for the signature's own.
 */
function signature(rest: string): { end: number; takes: string } {
  let depth = 0;
  let arrow = -1;
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    const isArrow = c === "-" && rest[i + 1] === ">";
    if (c === "(" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "]" || (c === ">" && rest[i - 1] !== "-")) depth--;
    else if (isArrow && depth <= 0 && arrow === -1) arrow = i;
    else if ((c === "{" || c === ";") && depth <= 0) {
      end = i;
      break;
    }
  }
  const whole = rest.slice(0, end);
  if (arrow === -1) return { end, takes: whole };
  const where = whole.slice(arrow).search(/\bwhere\b/);
  return { end, takes: whole.slice(0, arrow) + (where === -1 ? "" : whole.slice(arrow + where)) };
}

const inside = (i: number, spans: { start: number; end: number }[]) =>
  spans.some((s) => s.start < i && i < s.end);

/**
 * The functions in a Rust file's non-test code that take bytes: by a parameter or bound of a
 * byte type or of one of `carriers`, as a method of a carrier, through `self`, by a read in the
 * body, or by a pattern binding a byte field of one of `variants`, which is public wherever its
 * enum is. A method is named with its type (`Reader::next_frame`), so two types' methods of one
 * name stay apart.
 */
export function byteTakers(source: string, scope: Scope = NO_CARRIERS): string[] {
  const code = withoutTests(rustCode(source));
  const { blocks, fns, bodies } = rustFunctions(code);
  const carrierOf = new Map(
    blocks.map((b) => [
      b,
      b.byteBound ? { fields: undefined, views: new Map() } : scope.carrier(b.named, b.start),
    ]),
  );
  const own = new Set(
    fns
      .filter(({ m }) => !inside(m.index, blocks) && !inside(m.index, bodies))
      .map(({ m }) => m[1]),
  );
  const methods = (type: string) => fns.filter((f) => f.block?.type === type);
  const selfMethods = fns.filter(
    (f) =>
      f.block !== undefined &&
      (carrierOf.get(f.block) ?? null) !== null &&
      /\bself\b/.test(f.takes),
  );
  // A method reaching bytes through a method of its own: repeat until nothing is added.
  const viaSelf = new Set<(typeof fns)[number]>();
  for (let grew = true; grew;) {
    grew = false;
    for (const f of selfMethods.filter((s) => !viaSelf.has(s))) {
      const type = f.block?.type ?? "";
      const held = f.block === undefined ? undefined : carrierOf.get(f.block);
      const calls = (name: string) => {
        const called = methods(type).filter((g) => g.fn === name);
        return called.length === 0 || called.some((g) => viaSelf.has(g));
      };
      const field = (name: string, from: number, to: number) => {
        const items = held?.views.get(name);
        return items === undefined || scope.reaches(items, f.body, from, to);
      };
      if (reachesBytes(f.body, held?.fields, calls, field)) {
        viaSelf.add(f);
        grew = true;
      }
    }
  }
  // A call through `self` to a method of the type's own is left to that method, until the method
  // is found to be a decoder: then the call is read again, so its caller is one too.
  const nameOf = ({ fn, block }: (typeof fns)[number]) =>
    block === undefined ? fn : `${block.type}::${fn}`;
  const takersLeaving = (decoders: Set<string>) =>
    fns.flatMap((f) => {
      const { block, takes, body } = f;
      const name = nameOf(f);
      const takesSelfType =
        block !== undefined &&
        (carrierOf.get(block) ?? null) !== null &&
        /\bSelf\b/.test(takes.replace(/\bself\s*:[^,)]*/, ""));
      // The impl's own methods, not a function declared inside one's body, that aren't decoders.
      const left = fns.filter(
        (g) =>
          block !== undefined &&
          g.block === block &&
          !inside(g.m.index, bodies) &&
          !decoders.has(nameOf(g)),
      );
      const caller = receiver(takes);
      const reached = (via: string, method: string) =>
        left.some(
          (g) =>
            g.fn === method &&
            (via.startsWith("Self") || (caller !== undefined && receiver(g.takes) === caller)),
        );
      const called = body.replace(SELF_READ, (call, via: string, g: string) =>
        reached(via, g) ? call.slice(0, -g.length) + "_".repeat(g.length) : call,
      );
      const reads =
        BODY_READS.test(called) ||
        [...called.matchAll(BARE_READ)].some(([, g]) => !own.has(g)) ||
        bindsByteVariant(
          body,
          f.open,
          scope,
          block === undefined ? undefined : { named: block.named, at: block.start },
        );
      return BYTES_IN.test(takes) ||
        scope.names(takes, f.m.index) ||
        takesSelfType ||
        viaSelf.has(f) ||
        reads
        ? [name]
        : [];
    });
  for (let found = takersLeaving(new Set()); ;) {
    const next = takersLeaving(new Set(found));
    if (next.length === found.length) return next;
    found = next;
  }
}

/**
 * The impl blocks and functions of a Rust file's code, and where each function's body spans. A
 * function is in the first block around it, and named as rustc reads it (`fn r#type` is `type`).
 */
function rustFunctions(code: string) {
  const blocks = implBlocks(code);
  const fns = [...code.matchAll(/\bfn\s+(?:r#)?(\w+)/g)].map((m) => {
    const { end, takes } = signature(code.slice(m.index));
    const open = m.index + end;
    const close = code[open] === "{" ? itemEnd(code, open) : open;
    const block = blocks.find((b) => b.start < m.index && m.index < b.end);
    const sig = code.slice(m.index, open);
    return { m, fn: m[1] ?? "", block, takes, sig, open, close, body: code.slice(open, close) };
  });
  return { blocks, fns, bodies: fns.map((f) => ({ start: f.open, end: f.close })) };
}

/** Every function in a Rust file's non-test code, a method named with its type. */
function definedFunctions(source: string): string[] {
  return rustFunctions(withoutTests(rustCode(source))).fns.map(({ fn, block }) =>
    block === undefined ? fn : `${block.type}::${fn}`,
  );
}

interface ImplParts {
  params: Set<string>;
  /** Whether a type parameter carries a bound or the impl has a `where` clause. */
  bounded: boolean;
  trait: string | undefined;
  type: string;
}

/**
 * An impl's head, read for what may answer a call: the type parameters it declares, the last name
 * of the trait it implements, if any, and the type it is for, less any `where` clause.
 */
function implParts(head: string): ImplParts {
  let rest = expressionsBlanked(head.replace(/^[\s\S]*?\bimpl\b\s*/, ""));
  const params = new Set<string>();
  let bounded = false;
  if (rest.startsWith("<")) {
    let end = 0;
    for (let depth = 0; end < rest.length; end++) {
      if (rest[end] === "<") depth++;
      else if (rest[end] === ">" && rest[end - 1] !== "-" && --depth === 0) break;
    }
    for (const part of topLevelParts(rest.slice(1, end))) {
      const name = /^(?:r#)?(\w+)/.exec(part)?.[1];
      if (name !== undefined && name !== "const") params.add(name);
      bounded ||= /^(?:r#)?\w+\s*:/.test(part);
    }
    rest = rest.slice(end + 1);
  }
  let forAt = -1;
  let whereAt = rest.length;
  for (let i = 0, depth = 0; i < rest.length; i++) {
    const c = rest[i] ?? "";
    if ("<([".includes(c)) depth++;
    else if ((c === ">" && rest[i - 1] !== "-") || ")]".includes(c)) depth--;
    else if (depth === 0 && /\w/.test(c) && !/[\w#]/.test(rest[i - 1] ?? " ")) {
      const word = /^\w+/.exec(rest.slice(i))?.[0];
      if (word === "where") {
        whereAt = i;
        break;
      }
      if (word === "for" && forAt === -1 && !/^for\s*</.test(rest.slice(i))) forAt = i;
    }
  }
  const trait = forAt === -1 ? undefined : rest.slice(0, forAt).trim();
  return {
    params,
    bounded: bounded || whereAt < rest.length,
    trait:
      trait === undefined
        ? undefined
        : rawless(/((?:r#)?\w+)\s*(?:<[\s\S]*)?$/.exec(trait)?.[1] ?? ""),
    type: rest.slice(forAt === -1 ? 0 : forAt + 3, whereAt).trim(),
  };
}

/**
 * `text`, an impl's head, with each const expression in it blanked: what a brace block holds, and
 * an array's length. So a `<` or `>` in one (`{ 1 > 0 }`, `[u8; 1 << 2]`) isn't a bracket.
 */
function expressionsBlanked(text: string): string {
  let out = "";
  const open: Bracket[] = [];
  for (let i = 0, braces = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (braces === 0 && c !== "{") takeBracket(open, c, text[i - 1]);
    if (c === "}" && braces > 0) braces--;
    out += braces > 0 || (open.at(-1)?.expression ?? false) ? " " : c;
    if (c === "{") braces++;
  }
  return out;
}

// A trait impl's type that is one of its own parameters, behind at most a reference or a std
// pointer, so that it is implemented for every type, a carrier and its Arc among them.
const BLANKET =
  /^(?:&\s*(?:'\w+\s+)?(?:mut\s+)?)?(?:(?:(?:::\s*)?(?:(?:r#)?\w+\s*::\s*)+)?(?:r#)?(?:Arc|Rc|Box|Pin)\s*<\s*(?:r#)?(\w+)\s*>|(?:r#)?(\w+))$/;

/**
 * Whether a method's signature `sig`, at `at` in its file, may hand bytes to its caller or take
 * them: it names a byte type, a carrier, a type alias that `alias` says does, `u8`, `Self`, an
 * `impl` or `dyn` type, a qualified path (`<T as Trait>::Out`), or a type parameter of its own.
 */
function exposes(sig: string, at: number, scope: Scope, alias: (n: Named) => boolean): boolean {
  return (
    BYTES_IN.test(sig) ||
    /\b(?:u8|Self|dyn|impl|as|where)\b/.test(sig) ||
    /^fn\s+(?:r#)?\w+\s*<\s*(?:'\w+\s*(?::[^,>]*)?,\s*)*(?!')[^\s>]/.test(sig) ||
    scope.names(sig, at) ||
    typePaths(sig).some(alias)
  );
}

// An attribute that may leave out what it is on: `#[cfg(…)]`, or a `cfg_attr`, which may add one.
const CFG_ATTRIBUTE = /#\s*\[\s*cfg(?:_attr)?\s*\(/;

// What may come between a function's attributes and its `fn`.
const FN_QUALIFIERS =
  /(?:(?:pub(?:\s*\([^)]*\))?|async|const|unsafe|default|extern(?:\s*"[^"]*")?)\s+)*$/;

/** The attributes written right before `at` in `code`, outer ones first. */
function attributesBefore(code: string, at: number): string {
  let start = at;
  for (;;) {
    let close = start;
    while (close > 0 && /\s/.test(code[close - 1] ?? "")) close--;
    if (code[close - 1] !== "]") break;
    let open = close - 1;
    for (let depth = 0; open >= 0; open--) {
      if (code[open] === "]") depth++;
      else if (code[open] === "[" && --depth === 0) break;
    }
    let hash = open - 1;
    while (hash >= 0 && /\s/.test(code[hash] ?? "")) hash--;
    if (code[hash] !== "#") break;
    start = hash;
  }
  return code.slice(start, at);
}

/** Whether a module, or one it is in, may be left out by a `cfg`. */
function cfgModule(module: Module | undefined): boolean {
  const parent = module?.parent;
  if (module === undefined || parent === undefined) return false;
  const declared = [...parent.children.values()].flat().filter((b) => b.value === module);
  return declared.some((b) => b.conditional) || cfgModule(parent);
}

/**
 * Whether an inherent impl's methods are a type's under every build and for every one of its
 * instances: no `cfg` may leave the impl or its module out, each type argument of its type is one
 * of the impl's own parameters (`impl Runtime<Fast>` is not every `Runtime`'s), and none of those
 * carries a bound (`impl<O: Output> Holder<O>` is only the `Holder`s whose `O` meets it), which
 * the scan can't tell of a field's type.
 */
function everyInstance(code: string, at: number, modules: Module[], parts: ImplParts): boolean {
  if (CFG_ATTRIBUTE.test(attributesBefore(code, at)) || modules.some(cfgModule)) return false;
  if (parts.bounded) return false;
  const args = /<([\s\S]*)>\s*$/.exec(parts.type)?.[1];
  return args === undefined || topLevelParts(args).every((a) => parts.params.has(a.trim()));
}

/** Whether a `cfg` may leave out the function whose `fn` is at `at` in `code`. */
function cfgFunction(code: string, at: number): boolean {
  const before = code.slice(Math.max(0, at - 200), at);
  const qualifiers = FN_QUALIFIERS.exec(before)?.[0].length ?? 0;
  return CFG_ATTRIBUTE.test(attributesBefore(code, at - qualifiers));
}

// The macros of std, none of which writes an impl. `include!` isn't one: it brings in code the scan
// doesn't read.
const STD_MACROS = new Set(
  (
    "addr_of addr_of_mut assert assert_eq assert_ne cfg column compile_error concat dbg " +
    "debug_assert debug_assert_eq debug_assert_ne env eprint eprintln file format format_args " +
    "include_bytes include_str line matches module_path option_env panic pin print println " +
    "stringify thread_local todo unimplemented unreachable vec write writeln"
  ).split(" "),
);

// The macros of STD_MACROS a file names only by a path or a `use`: the rest are in its prelude.
const UNPRELUDED_MACROS = new Set(["addr_of", "addr_of_mut", "pin"]);

// The attributes the compiler reads itself, which write no item.
const BUILTIN_ATTRIBUTES = new Set(
  (
    "allow cfg cold deny deprecated doc expect forbid ignore inline must_use non_exhaustive repr " +
    "should_panic test track_caller warn"
  ).split(" "),
);

// The derives of std. Each writes an impl, for the type derived only, of a trait whose methods are
// all in TRAIT_METHODS.
const STD_DERIVES = new Set("Clone Copy Debug Default Eq Hash Ord PartialEq PartialOrd".split(" "));

// The helper attributes of the derives the workspace uses (serde's, thiserror's, Default's,
// schemars'), which the derive reads and the compiler drops.
const DERIVE_HELPERS = new Set("backtrace default error from schemars serde source".split(" "));

// The `!` of a macro call, its path read back from it, so a long run of names is read once.
const MACRO_BANG = /!\s*[({[]/g;

// Words that may come right before a `!` that negates, as `if !(x)` does.
const KEYWORDS = new Set(
  "as break else if in let loop match move mut return unsafe where while yield".split(" "),
);

/** Every list's names, or `undefined` when any one is. */
const allOf = (lists: (string[] | undefined)[]) =>
  lists.some((l) => l === undefined) ? undefined : lists.flatMap((l) => l ?? []);

/**
 * Where a macro or attribute written as `path` in `module` comes from, as each path outside the
 * workspace it may name (`std::format`, `tracing::warn`) or `prelude::<name>` for a bare name no
 * `use` binds where `prelude` allows one. `undefined` when it may be the workspace's own, or the
 * scan can't tell: a glob in a module on the way may bring the name in, a `use` binds a crate's
 * name to another path, or a re-export goes round.
 */
function macroOrigins(
  table: ModuleTable,
  module: Module,
  path: string[],
  prelude: boolean,
  depth = 0,
): string[] | undefined {
  const segments = path.map(rawless);
  const [first = "", ...rest] = segments;
  const last = rest.at(-1) ?? first;
  const follow = (m: Module, p: string[], bare: boolean) =>
    depth > 16 ? undefined : macroOrigins(table, m, p, bare, depth + 1);
  if (rest.length === 0) {
    if (module.globs.length > 0) return undefined;
    const uses = module.uses.get(first) ?? [];
    if (uses.length === 0) return prelude ? [`prelude::${first}`] : undefined;
    return allOf(uses.map((u) => follow(module, u.value.path, false)));
  }
  if (!["crate", "self", "super"].includes(first)) {
    if (module.globs.length > 0) return undefined;
    const uses = module.uses.get(first) ?? [];
    if (uses.some((u) => u.value.path.filter((p) => p !== "").join("::") !== first)) {
      return undefined;
    }
  }
  const holder = table.resolve(module, segments.slice(0, -1));
  if (holder.items.length > 0 || holder.unresolved.size > 0) return undefined;
  if (holder.modules.length === 0) return [segments.filter((p) => p !== "").join("::")];
  return allOf(holder.modules.map((m) => follow(m, [last], false)));
}

/** Whether every module at `at` in `file` takes `path` to a name `known` accepts. */
function knownIn(
  table: ModuleTable,
  file: string,
  at: number,
  path: string[],
  known: (origin: string) => boolean,
): boolean {
  return table
    .modulesAt(file, at)
    .every((m) => macroOrigins(table, m, path, true)?.every(known) === true);
}

/** Each attribute written in `text`, outer or inner, as the path it names and its arguments. */
function attributesIn(text: string): { path: string[]; args: string; at: number }[] {
  const out: { path: string[]; args: string; at: number }[] = [];
  for (const m of text.matchAll(/#\s*!?\s*\[/g)) {
    const open = m.index + m[0].length - 1;
    out.push({ ...attributeParts(text.slice(open + 1, matchingBracket(text, open))), at: m.index });
  }
  return out;
}

/** An attribute's body, `path(args)` or `path = value`, split; a path it can't read is `[]`. */
function attributeParts(body: string): { path: string[]; args: string } {
  const head = /^\s*((?:r#)?\w+(?:\s*::\s*(?:r#)?\w+)*)\s*/.exec(body);
  if (head === null) return { path: [], args: "" };
  const path = (head[1] ?? "").split("::").map((p) => rawless(p.trim()));
  const rest = body.slice(head[0].length);
  return { path, args: rest.startsWith("(") ? rest.slice(1, rest.lastIndexOf(")")) : "" };
}

/**
 * Whether an attribute `path(args)`, in a module at `at` in `file`, is one `name` accepts: it is
 * the compiler's own, or a `cfg_attr` adding only such, read by a name no `use` rebinds.
 */
function knownAttribute(
  table: ModuleTable,
  file: string,
  at: number,
  attribute: { path: string[]; args: string },
  name: (n: string, args: string) => boolean,
): boolean {
  const { path, args } = attribute;
  if (path.length === 0) return false;
  if (path.length === 1 && path[0] === "cfg_attr") {
    return topLevelParts(args)
      .slice(1)
      .every((a) => knownAttribute(table, file, at, attributeParts(a), name));
  }
  return knownIn(
    table,
    file,
    at,
    path,
    (o) => o.startsWith("prelude::") && name(o.slice("prelude::".length), args),
  );
}

/** Whether a derive by `path` is one of std's, in a module at `at` in `file`. */
function stdDerive(table: ModuleTable, file: string, at: number, path: string[]): boolean {
  return knownIn(table, file, at, path, (o) => {
    const [from = "", ...rest] = o.split("::");
    return STD_DERIVES.has(rest.at(-1) ?? "") && /^(?:prelude|std|core)$/.test(from);
  });
}

/**
 * Whether `code`, the code of `file`, may write an impl the scan can't read, for a type it can't
 * tell: by a macro, anywhere, that is neither std's nor one of `trusted`, or by an attribute,
 * anywhere, that is neither the compiler's own nor a helper of a derive. A macro's expansion may
 * hold a block, and an impl in a block holds for the whole crate. A call of one of the
 * workspace's own macros, `rules`, is never known, since its body may assemble an impl from the
 * tokens it is handed. Each path a macro of another crate is called by goes into `called`.
 */
function unreadImpls(
  table: ModuleTable,
  file: string,
  code: string,
  trusted: Set<string>,
  rules: Set<string>,
  called: Set<string>,
): boolean {
  let unread = false;
  const known = (origin: string) => {
    const [from = "", ...rest] = origin.split("::");
    const name = rest.at(-1) ?? "";
    if (from === "prelude") {
      return STD_MACROS.has(name) && !UNPRELUDED_MACROS.has(name) && !rules.has(name);
    }
    if (/^(?:std|core|alloc)$/.test(from)) return STD_MACROS.has(name);
    called.add(origin);
    return trusted.has(origin);
  };
  for (const m of code.matchAll(MACRO_BANG)) {
    let end = m.index;
    while (end > 0 && /\s/.test(code[end - 1] ?? "")) end--;
    let start = end;
    while (start > 0 && /\w/.test(code[start - 1] ?? "")) start--;
    const name = code.slice(start, end);
    if (name === "") continue;
    const raw = code.slice(start - 2, start) === "r#";
    if (!raw && KEYWORDS.has(name)) continue;
    const path = pathBefore(code, raw ? start - 2 : start, name);
    if (path === undefined || !knownIn(table, file, m.index, path, known)) unread = true;
  }
  for (const attribute of attributesIn(code)) {
    const ok = knownAttribute(
      table,
      file,
      attribute.at,
      attribute,
      (n) => BUILTIN_ATTRIBUTES.has(n) || DERIVE_HELPERS.has(n) || n === "derive",
    );
    if (!ok) unread = true;
  }
  return unread;
}

/**
 * Whether a type, `item`, carries an attribute the scan can't read: one other than the compiler's
 * own, or a derive other than std's, which writes impls of traits the scan doesn't read, Deref
 * among them; or an attribute macro, which may rewrite the type whole.
 */
function opaqueItem(table: ModuleTable, code: string, item: Item): boolean {
  const qualifiers = FN_QUALIFIERS.exec(code.slice(Math.max(0, item.at - 200), item.at));
  const attributes = attributesIn(attributesBefore(code, item.at - (qualifiers?.[0].length ?? 0)));
  return !attributes.every((a) =>
    knownAttribute(table, item.file, item.at, a, (n, args) =>
      n === "derive"
        ? topLevelParts(args).every((d) =>
            stdDerive(table, item.file, item.at, attributeParts(d).path),
          )
        : BUILTIN_ATTRIBUTES.has(n),
    ),
  );
}

/**
 * The workspace's methods and trait impls a use of a field with a view is checked against, read
 * from each of `codes`' files with its scope.
 */
function throughOf(
  table: ModuleTable,
  codes: Map<string, string>,
  scopes: Map<string, Scope>,
  trusted: Set<string>,
  called: Set<string>,
): Pick<Through, "methods" | "traits" | "blanket" | "opaque"> {
  const through: Pick<Through, "methods" | "traits" | "blanket" | "opaque"> = {
    methods: new Map(),
    traits: new Map(),
    blanket: new Set(),
    opaque: new Set(
      table.items.filter(
        (i) => i.kind === "struct" && opaqueItem(table, codes.get(i.file) ?? "", i),
      ),
    ),
  };
  const rules = new Set(
    [...codes.values()].flatMap((code) =>
      [...code.matchAll(/\b(?:macro_rules\s*!|macro)\s+(?:r#)?(\w+)/g)].map((m) => m[1] ?? ""),
    ),
  );
  const declared = new Map<string, Set<string> | undefined>();
  for (const t of table.items.filter((i) => i.kind === "trait")) {
    const name = rawless(t.name);
    const fns = /\w\s*!\s*[({[]/.test(t.text)
      ? undefined
      : new Set([...t.text.matchAll(/\bfn\s+(?:r#)?(\w+)/g)].map((m) => m[1] ?? ""));
    declared.set(name, declared.has(name) ? unionNames(declared.get(name), fns) : fns);
  }
  const resolvedIn = (file: string, named: Named, at: number) =>
    table.modulesAt(file, at).flatMap((m) => {
      const r = resolveNamed(table, m, named);
      return [...r.items, ...table.items.filter((i) => r.unresolved.has(i.name))];
    });
  // The items a name may be, and through a type alias, the items the type it names may be.
  const aliased = (file: string, n: Named, at: number, seen: Set<Item>): Item[] =>
    resolvedIn(file, n, at).flatMap((i) => {
      const target = i.kind === "type" ? /=([\s\S]*);\s*$/.exec(i.text)?.[1] : undefined;
      if (target === undefined || seen.has(i)) return [i];
      const next = new Set([...seen, i]);
      return [i, ...typePaths(target).flatMap((m) => aliased(i.file, m, i.at, next))];
    });
  // A type alias exposes what the type it names does, read where the alias is written.
  const aliasIn =
    (file: string, at: number, seen: Set<Item>) =>
    (n: Named): boolean =>
      resolvedIn(file, n, at).some((i) => {
        if (i.kind !== "type") return false;
        const target = /=([\s\S]*);\s*$/.exec(i.text)?.[1];
        const scope = scopes.get(i.file);
        if (target === undefined || scope === undefined || seen.has(i)) return true;
        return exposes(target, i.at, scope, aliasIn(i.file, i.at, new Set([...seen, i])));
      });
  for (const [file, code] of codes) {
    const scope = scopes.get(file) ?? NO_CARRIERS;
    const resolved = (named: Named, at: number) => resolvedIn(file, named, at);
    const alias = (at: number) => aliasIn(file, at, new Set());
    const { blocks, fns, bodies } = rustFunctions(code);
    if (unreadImpls(table, file, code, trusted, rules, called)) through.blanket = undefined;
    for (const block of blocks) {
      const parts = implParts(block.head);
      const own = fns.filter((f) => f.block === block && !inside(f.m.index, bodies));
      if (parts.trait === undefined) {
        const modules = table.modulesAt(file, block.start);
        if (!everyInstance(code, block.start, modules, parts)) continue;
        for (const item of resolved(block.named, block.start)) {
          const byName = through.methods.get(item) ?? new Map();
          through.methods.set(item, byName);
          for (const f of own.filter((g) => !cfgFunction(code, g.m.index))) {
            byName.set(f.fn, [
              ...(byName.get(f.fn) ?? []),
              {
                key: `${file}::${block.type}::${f.fn}`,
                exposes: exposes(f.sig, f.m.index, scope, alias(f.m.index)),
              },
            ]);
          }
        }
        continue;
      }
      const names = new Set(own.map((f) => f.fn));
      const answered = declared.has(parts.trait)
        ? unionNames(declared.get(parts.trait), names)
        : STD_TRAITS.has(parts.trait)
          ? names
          : undefined;
      const base = BLANKET.exec(parts.type);
      const param = base?.[1] ?? base?.[2];
      if (param !== undefined && parts.params.has(param)) {
        through.blanket = unionNames(through.blanket, answered);
        continue;
      }
      for (const n of typePaths(parts.type)) {
        for (const item of aliased(file, n, block.start, new Set())) {
          through.traits.set(
            item,
            through.traits.has(item) ? unionNames(through.traits.get(item), answered) : answered,
          );
        }
      }
    }
  }
  return through;
}

interface Locked {
  version: string;
  source: string | undefined;
  checksum: string | undefined;
  replace: string | undefined;
}

// Where Cargo.lock says a package from crates.io comes from. A git or path source, or a path
// `[patch]`, has another or none, and code no review read; a `[replace]` keeps it, and adds a
// `replace` naming the package built instead.
const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

/** Each package Cargo.lock locks, by name: its version, source and checksum. */
function lockedPackages(lock: string): Map<string, Locked[]> {
  const out = new Map<string, Locked[]>();
  for (const block of lock.split(/^\[\[package\]\]$/m).slice(1)) {
    const field = (key: string) => new RegExp(`^${key} = "([^"]+)"$`, "m").exec(block)?.[1];
    const name = field("name");
    const version = field("version");
    if (name !== undefined && version !== undefined) {
      const locked = {
        version,
        source: field("source"),
        checksum: field("checksum"),
        replace: field("replace"),
      };
      out.set(name, [...(out.get(name) ?? []), locked]);
    }
  }
  return out;
}

/**
 * The paths of `foreign` whose every crate read is the one package Cargo.lock locks, at the version
 * and with the checksum read, from crates.io; whose reason says it read each; and no crate of which
 * a manifest renames, or takes under its name. Why each other isn't goes into `out`.
 */
function pinnedMacros(
  paths: string[],
  read: (path: string) => string,
  foreign: Record<string, ForeignMacro>,
  out: string[],
): Set<string> {
  const lock: Map<string, Locked[]> = paths.includes("Cargo.lock")
    ? lockedPackages(read("Cargo.lock"))
    : new Map();
  const manifests = paths
    .filter((p) => /(?:^|\/)Cargo\.toml$/.test(p))
    .map((p) => [p, manifestNames(p, read(p))] as const);
  const unreadable = manifests.some(([, m]) => m.failures.length > 0);
  const renamed = new Map<string, string>();
  for (const [manifest, { renames }] of manifests) {
    for (const [key, name] of renames) {
      for (const n of [key, name]) renamed.set(n.replace(/-/g, "_"), manifest);
    }
  }
  const pinned = new Set<string>();
  for (const [path, { read: crates, reason }] of Object.entries(foreign)) {
    let held = Object.keys(crates).length > 0 && !unreadable;
    for (const name of new Set([path.split("::")[0] ?? "", ...Object.keys(crates)])) {
      const manifest = renamed.get(name.replace(/-/g, "_"));
      if (manifest !== undefined) {
        held = false;
        out.push(
          `${manifest}: renames a crate to or from ${name}, which FOREIGN_MACROS trusts ${path} ` +
            "by, so the name may be another crate's: take the crate by its own name.",
        );
      }
    }
    for (const [name, { version, checksum }] of Object.entries(crates)) {
      const locked = lock.get(name) ?? [];
      if (locked.length !== 1 || locked[0]?.version !== version) {
        held = false;
        out.push(
          `scripts/check-standards.ts: FOREIGN_MACROS read ${path} in ${name} ${version}, but ` +
            `Cargo.lock locks ${locked.length === 0 ? "no " : ""}${name}` +
            `${locked.length === 0 ? "" : ` ${locked.map((l) => l.version).join(", ")}`}: read ` +
            "its expansion at the locked version again, and pin that version if it still writes " +
            "no impl.",
        );
      } else if (
        locked[0]?.source !== CRATES_IO ||
        locked[0].checksum !== checksum ||
        locked[0].replace !== undefined
      ) {
        held = false;
        out.push(
          `scripts/check-standards.ts: FOREIGN_MACROS read ${path} in ${name} ${version} from ` +
            `crates.io with checksum ${checksum}, but Cargo.lock takes it from ` +
            `${locked[0]?.source ?? "no registry"} with checksum ${locked[0]?.checksum ?? "none"}` +
            `${locked[0]?.replace === undefined ? "" : `, replaced by ${locked[0].replace}`}: ` +
            "read the expansion of the source it takes, and pin that if it still writes no impl.",
        );
      }
      if (
        !reason.includes(`${name}@${version} `) ||
        !/^read .+: expansion writes no impl$/.test(reason)
      ) {
        held = false;
        out.push(
          `scripts/check-standards.ts: FOREIGN_MACROS's reason for ${path} doesn't say it read ` +
            `${name}@${version}: write it as \`read <crate>@<version> <file>: expansion writes no impl\`.`,
        );
      }
    }
    if (held) pinned.add(path);
  }
  return pinned;
}

/** Each decoder of `takers`, by file, as its key: `file::Type::fn`. */
const keysOf = (takers: Map<string, string[]>) =>
  new Set([...takers].flatMap(([file, fns]) => fns.map((fn) => `${file}::${fn}`)));

/**
 * Why a function that takes bytes has no fuzz target and no reason it needs none, why a `pub` byte
 * field has no reason it holds no bytes from outside, or why an entry in a list is stale or its
 * target missing.
 */
export function decoderFailures(
  paths: string[],
  read: (path: string) => string,
  fuzzed: Record<string, string>,
  notDecoders: Record<string, string>,
  publicByteFields: Record<string, string> = {},
  foreignMacros: Record<string, ForeignMacro> = {},
): string[] {
  const out: string[] = [];
  const trusted = pinnedMacros(paths, read, foreignMacros, out);
  const called = new Set<string>();
  const found = new Set<string>();
  const publicFound = new Set<string>();
  const defined = new Set<string>();
  const sources = paths.filter((p) => /^crates\/[^/]+\/src\/.+\.rs$/.test(p));
  const testOnly = testModuleFiles(sources, read);
  const product = sources.filter((p) => !testOnly.has(p));
  const codes = new Map(product.map((file) => [file, withoutTests(rustCode(read(file)))]));
  const crates = [...new Set(product.map(crateOf))];
  const idents = crateIdents(paths, read, crates);
  const table = new ModuleTable(
    codes,
    crates.map((dir) => ({
      dir,
      idents: idents.get(dir) ?? [],
      deps: outsideDependencies(paths, read, dir),
    })),
  );
  const carriers = carriersOf(table);
  const scopes = new Map<string, Scope>();
  const through: Through = {
    active: false,
    takers: new Set(),
    methods: new Map(),
    traits: new Map(),
    blanket: new Set(),
    opaque: new Set(),
  };
  for (const file of product) scopes.set(file, fileScope(table, carriers, file, through));
  Object.assign(through, throughOf(table, codes, scopes, trusted, called));
  // A use of a field may reach its bytes by calling a decoder, which the scan is finding: start
  // from the decoders with no view read, the most there can be, and read views against the last
  // pass's until a pass finds no fewer. A cycle of calls between types so stays a decoder.
  const takersOf = () =>
    new Map(product.map((file) => [file, byteTakers(read(file), scopes.get(file))]));
  let takers = takersOf();
  through.active = true;
  for (let keys = keysOf(takers); ;) {
    through.takers = keys;
    takers = takersOf();
    const next = keysOf(takers);
    if (next.size === keys.size) break;
    keys = next;
  }
  for (const file of product) {
    const scope = scopes.get(file) ?? NO_CARRIERS;
    const whole = codes.get(file) ?? "";
    for (const line of unreadImplLines(whole)) {
      out.push(
        `${file}:${line}: an impl whose head the decoder rule can't read, so it can't tell ` +
          "what the impl is for or whether it takes bytes: balance its brackets.",
      );
    }
    const code = blankSpans(whole, implBlocks(whole));
    for (const fn of definedFunctions(read(file))) defined.add(`${file}::${fn}`);
    for (const { statement, bindings } of useStatements(table, file)) {
      for (const { path, renamed, at } of bindings) {
        const to = renamed?.split(" as ")[1];
        if (renamed === undefined || to === "_") continue;
        const from = path.at(-1) ?? "";
        if (BYTE_TYPE_NAMES.has(from) || scope.carrier({ name: from, path }, at) !== null) {
          out.push(
            `${file}: \`${renamed}\` renames a byte type, which hides it from the decoder ` +
              "rule. Use the type's own name.",
          );
        }
      }
      const named = new Set<string>();
      for (const { name, path, at } of bindings) {
        const enumPath = name === "*" ? path : path.slice(0, -1);
        const enumName = enumPath.at(-1);
        if (enumName === undefined || enumName === "") continue;
        const variants = scope.variants({ name: enumName, path: enumPath }, at);
        if (variants !== undefined && (name === "*" || variants.has(path.at(-1) ?? ""))) {
          named.add(enumName);
        }
      }
      for (const name of named) {
        out.push(
          `${file}: \`${statement}\` brings in a variant of ${name} that carries bytes by its own ` +
            "name, which hides a match on it from the decoder rule. Name it as " +
            `\`${name}::Variant\`.`,
        );
      }
    }
    for (const item of code.matchAll(/\benum\s+(?:r#)?(\w+)/g)) {
      const parsed = enumVariants(code.slice(item.index, itemEnd(code, item.index)));
      for (const v of (parsed?.variants ?? []).filter((w) => w.fields === undefined)) {
        if (BYTES_IN.test(v.text.slice(v.name.length))) {
          out.push(
            `${file}::${item[1]}::${v.name}: its fields can't be told apart, so the decoder rule ` +
              "can't see which a pattern binds bytes from: write each as `name: Type`, or `Type`.",
          );
        }
      }
    }
    for (const struct of code.matchAll(/\bstruct\s+(?:r#)?(\w+)/g)) {
      const item = code.slice(struct.index, itemEnd(code, struct.index));
      const parsed = structFields(item);
      if (parsed === undefined && BYTES_IN.test(item)) {
        out.push(
          `${file}::${struct[1]}: its fields can't be told apart, so the decoder rule can't see ` +
            "which hold bytes or whether one is pub: write each field as `name: Type`.",
        );
      }
      for (const field of (parsed?.fields ?? []).filter((f) => f.public && BYTES_IN.test(f.type))) {
        const key = `${file}::${struct[1]}::${field.name}`;
        publicFound.add(key);
        if (!(key in publicByteFields)) {
          out.push(
            `${key}: a pub byte field, which another crate can read where the decoder rule ` +
              "doesn't look: make it private and read it in a method of its type, or list it in " +
              "PUBLIC_BYTE_FIELDS with why its bytes aren't from outside.",
          );
        }
      }
    }
    for (const alias of code.matchAll(/\btype\s+(?:r#)?(\w+)[^=;]*=([^;]*);/g)) {
      if (BYTES_IN.test(alias[2] ?? "") || scope.names(alias[2] ?? "", alias.index)) {
        out.push(
          `${file}::${alias[1]}: names a byte type, which hides it from the decoder rule. ` +
            "Write the byte type in each signature instead.",
        );
      }
    }
    for (const fn of takers.get(file) ?? []) {
      const key = `${file}::${fn}`;
      found.add(key);
      if (!(key in fuzzed) && !(key in notDecoders)) {
        out.push(
          `${key}: takes bytes from outside, so it is a decoder: add a cargo-fuzz target that ` +
            "calls it and list it in FUZZED_DECODERS, or list it in NOT_DECODERS with why it " +
            "isn't one (scripts/check-standards.ts, docs/standards/rust.md § Tests).",
        );
      }
    }
  }
  for (const key of Object.keys(foreignMacros).filter((k) => !called.has(k))) {
    out.push(
      `scripts/check-standards.ts: FOREIGN_MACROS lists ${key}, which no product code calls.`,
    );
  }
  for (const [key, reason] of Object.entries(publicByteFields)) {
    if (!publicFound.has(key)) {
      out.push(`scripts/check-standards.ts: ${key} is listed, but no such pub byte field exists.`);
    } else if (reason.trim() === "") {
      out.push(
        `scripts/check-standards.ts: ${key} is in PUBLIC_BYTE_FIELDS with no reason its bytes ` +
          "aren't from outside.",
      );
    }
  }
  for (const key of Object.keys(fuzzed).filter((k) => !defined.has(k))) {
    out.push(`scripts/check-standards.ts: ${key} is listed, but no such function exists.`);
  }
  for (const [key, reason] of Object.entries(notDecoders)) {
    if (!found.has(key)) {
      out.push(`scripts/check-standards.ts: ${key} is listed, but no such function takes bytes.`);
    } else if (reason.trim() === "") {
      out.push(
        `scripts/check-standards.ts: ${key} is in NOT_DECODERS with no reason it isn't one.`,
      );
    }
  }
  for (const [key, target] of Object.entries(fuzzed)) {
    const crate = /^crates\/[^/]+/.exec(key)?.[0] ?? "";
    const file = `${crate}/fuzz/fuzz_targets/${target}.rs`;
    const path = key.slice(key.indexOf(".rs::") + 5);
    const [owner, fn] = path.includes("::") ? path.split("::") : [undefined, path];
    const code = paths.includes(file) ? rustCode(read(file)) : "";
    // A call may name its type parameters, as `edge::<T>(body)` does, within one expression.
    const turbofish = String.raw`(?:\s*::\s*<[^(){};]*>)?`;
    const calls =
      owner === undefined
        ? new RegExp(`\\b${fn}${turbofish}\\s*\\(`).test(code)
        : new RegExp(`\\b${owner}::${fn}${turbofish}\\s*\\(`).test(code) ||
          (new RegExp(`\\b${owner}\\b`).test(code) &&
            new RegExp(`\\.${fn}${turbofish}\\s*\\(`).test(code));
    if (!paths.includes(file)) {
      out.push(`${key}: its fuzz target ${file} doesn't exist.`);
    } else if (!calls) {
      out.push(`${file}: doesn't call ${path}, the decoder FUZZED_DECODERS says it drives.`);
    }
  }
  return out;
}

/**
 * The `use` statements of `file`, in order, each with its bindings, once each however many crate
 * roots reach the file.
 */
function useStatements(
  table: ModuleTable,
  file: string,
): { statement: string; bindings: UseBinding[] }[] {
  const out = new Map<number, { statement: string; bindings: UseBinding[] }>();
  for (const module of table.modulesIn(file)) {
    for (const binding of module.bindings) {
      const known = out.get(binding.at);
      if (known === undefined) {
        out.set(binding.at, { statement: binding.statement, bindings: [binding] });
      } else if (!known.bindings.some((b) => sameBinding(b, binding))) {
        known.bindings.push(binding);
      }
    }
  }
  return [...out].toSorted(([a], [b]) => a - b).map(([, statement]) => statement);
}

const sameBinding = (a: UseBinding, b: UseBinding) =>
  a.name === b.name && a.renamed === b.renamed && a.path.join("::") === b.path.join("::");

/**
 * The files among `paths` that hold a module compiled only under test: one declared out of line
 * as `#[cfg(test)] mod name;`, and every module inside it. A declaration inside an inline `mod
 * outer { … }` names `outer/name.rs`. A declaration with another attribute, such as `#[path]`, is
 * left alone, so its file is still read as product code.
 */
function testModuleFiles(paths: string[], read: (path: string) => string): Set<string> {
  const out = new Set<string>();
  const declared = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g;
  for (const file of paths) {
    const dir = /(?:^|\/)(?:lib|main|mod)\.rs$/.test(file)
      ? file.replace(/[^/]+$/, "")
      : file.replace(/\.rs$/, "/");
    const code = rustCode(read(file));
    const inline = [...code.matchAll(/\bmod\s+(\w+)\s*\{/g)].map((m) => ({
      name: m[1] ?? "",
      start: m.index,
      end: itemEnd(code, m.index),
    }));
    for (const m of code.matchAll(declared)) {
      const outer = inline.filter((o) => inside(m.index, [o])).map((o) => `${o.name}/`);
      const at = `${dir}${outer.join("")}${m[1] ?? ""}`;
      for (const p of paths) if (p === `${at}.rs` || p.startsWith(`${at}/`)) out.add(p);
    }
  }
  return out;
}

const crateOf = (file: string) => /^crates\/[^/]+/.exec(file)?.[0] ?? "";

/** `text` split at each top-level `sep` outside strings and brackets, each part trimmed. */
function tomlSplit(text: string, sep: string, limit = Infinity): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0, depth = 0; i < text.length && parts.length < limit - 1; i++) {
    const c = text[i] ?? "";
    if (quote !== "") {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (depth === 0 && c === sep) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return [...parts, text.slice(start)].map((p) => p.trim());
}

/** A TOML key's parts, each bare or quoted, or `undefined` when it isn't a key. */
function tomlKey(text: string): string[] | undefined {
  const parts = tomlSplit(text, ".").map((p) =>
    /^(?:([\w-]+)|"([^"\\]*)"|'([^']*)')$/
      .exec(p)
      ?.slice(1)
      .find((g) => g !== undefined),
  );
  return parts.every((p) => p !== undefined) ? parts : undefined;
}

/** A TOML string with no escapes in it, basic or literal, or `undefined` for anything else. */
const tomlString = (text: string) =>
  /^(?:"([^"\\]*)"|'([^']*)')$/
    .exec(text.trim())
    ?.slice(1)
    .find((g) => g !== undefined);

const DEPENDENCIES = /^(?:dev-|build-)?dependencies$/;

/** Whether a table's key is a dependencies table: of a package, a target or the workspace. */
const isDependencies = (key: string[]) =>
  (key.length === 1 && DEPENDENCIES.test(key[0] ?? "")) ||
  (key.length === 2 && key[0] === "workspace" && key[1] === "dependencies") ||
  (key.length === 3 && key[0] === "target" && DEPENDENCIES.test(key[2] ?? ""));

/**
 * Each dependency a manifest renames, as `[name, package]`, whichever way the TOML writes it: inline
 * (`q = { package = "x" }`), dotted (`q.package = 'x'`) or in the dependency's own table; and why a
 * `package` key in a dependencies table, or the package's `name`, can't be read as a plain string.
 */
function manifestNames(
  manifest: string,
  text: string,
): {
  name?: string | undefined;
  renames: [string, string][];
  deps: Map<string, Set<string>>;
  failures: string[];
} {
  const out: {
    name?: string | undefined;
    renames: [string, string][];
    deps: Map<string, Set<string>>;
    failures: string[];
  } = { renames: [], deps: new Map(), failures: [] };
  const unreadable = (line: string) =>
    out.failures.push(
      `${manifest}: can't read \`${line}\` for a package's name, so neither the decoder rule nor ` +
        "the signal scan can tell which crate it names: write it as a plain string " +
        '(`package = "name"`).',
    );
  const entry = (line: string, key: string[], value: string) => {
    if (key.length === 2 && key[0] === "package" && key[1] === "name") {
      out.name = tomlString(value);
      if (out.name === undefined) unreadable(line);
      return;
    }
    const at = [1, 2, 3].find((i) => isDependencies(key.slice(0, i)));
    if (at === undefined) return;
    const [dependency = "", ...rest] = key.slice(at);
    const keys = out.deps.get(dependency.replace(/-/g, "_")) ?? new Set<string>();
    out.deps.set(dependency.replace(/-/g, "_"), keys);
    if (rest[0] !== undefined) keys.add(rest[0]);
    if (rest.length === 0 && value.startsWith("{") && value.endsWith("}")) {
      for (const part of tomlSplit(value.slice(1, -1), ",").filter((p) => p !== "")) {
        const [inner = "", innerValue = ""] = tomlSplit(part, "=", 2);
        const innerKey = tomlKey(inner);
        if (innerKey === undefined) {
          keys.add("?");
          if (/\bpackage\b/.test(inner)) unreadable(line);
        } else entry(line, [...key, ...innerKey], innerValue);
      }
    } else if (rest.length === 1 && rest[0] === "package") {
      const name = tomlString(value);
      if (name === undefined) {
        keys.add("?");
        unreadable(line);
      } else out.renames.push([dependency, name]);
    } else if (rest.includes("package")) {
      keys.add("?");
      unreadable(line);
    }
  };
  let table: string[] = [];
  let header: string | undefined;
  for (const line of tomlLines(text)) {
    if (TOML_HEADER.test(line)) {
      const key = line.startsWith("[[") ? ["[["] : tomlKey(line.slice(1, -1));
      header = key === undefined ? line : undefined;
      table = key ?? [];
      continue;
    }
    // A table whose name can't be read may be a dependencies table, so a rename in it fails.
    if (header !== undefined) {
      if (/\bpackage\b["']?\s*=/.test(line)) unreadable(`${header} ${line}`);
      continue;
    }
    const [key = "", value = ""] = tomlSplit(line, "=", 2);
    const parts = tomlKey(key);
    if (parts !== undefined) entry(line, [...table, ...parts], value);
    else if (/\bpackage\b/.test(key)) unreadable(line);
  }
  return out;
}

/**
 * The names Rust code may give each crate of `crates`: its package name, with `-` as `_`, and each
 * name a manifest gives it by `package = "…"`. A name it can't read fails `cargoManifestFailures`.
 */
function crateIdents(
  paths: string[],
  read: (path: string) => string,
  crates: string[],
): Map<string, string[]> {
  const manifests = new Map(
    paths
      .filter((p) => /(?:^|\/)Cargo\.toml$/.test(p))
      .map((p) => [p, manifestNames(p, read(p))] as const),
  );
  const byPackage = new Map<string, string>();
  for (const crate of crates) {
    const name = manifests.get(`${crate}/Cargo.toml`)?.name;
    byPackage.set(name ?? crate.slice("crates/".length), crate);
  }
  const idents = new Map([...byPackage].map(([name, crate]) => [crate, [name.replace(/-/g, "_")]]));
  for (const { renames } of manifests.values()) {
    for (const [key, name] of renames) {
      const crate = byPackage.get(name);
      if (crate !== undefined) idents.get(crate)?.push(key.replace(/-/g, "_"));
    }
  }
  return idents;
}

const isOutside = (keys: Set<string> | undefined) =>
  keys !== undefined && !keys.has("path") && !keys.has("?");

/**
 * The names `dir`'s crate gives the crates outside the workspace it depends on: each dependency
 * its manifest declares that isn't a path to another crate, directly or through the workspace's
 * table, and whose entry reads cleanly. A path dependency may be a workspace crate under a name
 * nothing else gives it, so a path through it is never taken for one into a crate outside.
 */
function outsideDependencies(paths: string[], read: (path: string) => string, dir: string) {
  const deps = (manifest: string) =>
    paths.includes(manifest) ? manifestNames(manifest, read(manifest)).deps : new Map();
  const workspace = deps("Cargo.toml");
  return [...deps(`${dir}/Cargo.toml`)]
    .filter(
      ([name, keys]) =>
        isOutside(keys) && (!keys.has("workspace") || isOutside(workspace.get(name))),
    )
    .map(([name]) => name);
}

/**
 * Each crate of SIGNAL_CRATES a manifest takes under another name, which the signal scan, reading
 * that crate's kills by its name, wouldn't read; and each name a manifest gives that can't be read,
 * which may be one of those or a crate the decoder rule follows.
 */
export function cargoManifestFailures(paths: string[], read: (path: string) => string): string[] {
  return paths
    .filter((p) => /(?:^|\/)Cargo\.toml$/.test(p))
    .flatMap((manifest) => {
      const { renames, failures: unread } = manifestNames(manifest, read(manifest));
      const hidden = renames.filter(([key, name]) => SIGNAL_CRATES.includes(name) && key !== name);
      return [
        ...unread,
        ...hidden.map(
          ([key, name]) =>
            `${manifest}: renames ${name} to \`${key}\`, a name the signal scan doesn't read ` +
            `${name}'s kills by; take ${name} by its own name (docs/standards/rust.md § Signals).`,
        ),
      ];
    });
}

/** Why a crate's fuzz manifest isn't a cargo-fuzz crate of its own with exact pins. */
export function fuzzManifestFailures(manifest: string, text: string): string[] {
  const tables = tomlTables(text);
  const out: string[] = [];
  if (!(tables.get("[package.metadata]") ?? []).includes("cargo-fuzz = true")) {
    out.push(`${manifest}: a fuzz crate sets \`cargo-fuzz = true\` in [package.metadata].`);
  }
  if (!tables.has("[workspace]")) {
    out.push(
      `${manifest}: a fuzz crate is a workspace of its own (\`[workspace]\`): it builds on nightly.`,
    );
  }
  for (const header of tables.keys()) {
    if (header !== "[dependencies]" && /dependencies/.test(header)) {
      out.push(
        `${manifest}: ${header}: a fuzz crate takes its dependencies in [dependencies] only.`,
      );
    }
  }
  for (const line of tables.get("[dependencies]") ?? []) {
    const pinned = /^[\w-]+\s*=\s*"=[^"]+"$/.test(line);
    const parent = /^[\w-]+\s*=\s*\{\s*path\s*=\s*"\.\."\s*\}$/.test(line);
    if (!pinned && !parent) {
      out.push(
        `${manifest}: \`${line}\` must pin an exact version (\`"=x.y.z"\`) or be the crate it fuzzes (\`path = ".."\`).`,
      );
    }
  }
  return out;
}

const CRATE_ROOT = /^crates\/[^/]+\/(?:src\/(?:lib|main)\.rs|src\/bin\/.+|build\.rs)$/;

/** Why an unsafe module could let `unsafe` reach beyond its own file. */
export function unsafeModuleFailures(file: string, source: string): string[] {
  const out: string[] = [];
  if (CRATE_ROOT.test(file)) {
    out.push(
      `${file}: is a crate root, so its #![expect(unsafe_code)] would cover the whole crate. Keep ` +
        "the unsafe code in a module of its own (docs/standards/rust.md § Unsafe).",
    );
  }
  for (const m of rustCode(source).matchAll(/\bmod\s+\w+\s*[;{]/g)) {
    out.push(
      `${file}: \`${m[0]}\` declares a child module, which its #![expect(unsafe_code)] would ` +
        "cover too. An unsafe module has no child modules (docs/standards/rust.md § Unsafe).",
    );
  }
  return out;
}

/** Whether a crate's manifest takes the workspace's lints. */
export function inheritsWorkspaceLints(manifest: string): boolean {
  const table = /^\[lints\][ \t]*(?:#.*)?\r?$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(manifest)?.[1];
  return table !== undefined && /^[ \t]*workspace[ \t]*=[ \t]*true\b/m.test(table);
}

// The lint levels every crate inherits, and the test allowances, as Cargo.toml and clippy.toml
// must hold them. Changing a lint level is a change to docs/standards/rust.md: make it in both
// places, and here, in one commit that says why.
export const WORKSPACE_LINTS = [
  "[workspace.lints.rust]",
  'unsafe_code = "deny"',
  'unsafe_op_in_unsafe_fn = "forbid"',
  'missing_debug_implementations = "forbid"',
  'unreachable_pub = "forbid"',
  'rust_2018_idioms = { level = "deny", priority = -1 }',
  "[workspace.lints.clippy]",
  'pedantic = { level = "deny", priority = -1 }',
  'must_use_candidate = "allow"',
  'unwrap_used = "forbid"',
  'expect_used = "forbid"',
  'panic = "forbid"',
  'todo = "forbid"',
  'unimplemented = "forbid"',
  'dbg_macro = "forbid"',
  'print_stdout = "forbid"',
  'print_stderr = "forbid"',
  'indexing_slicing = "forbid"',
  'string_slice = "forbid"',
  'unreachable = "forbid"',
  'undocumented_unsafe_blocks = "forbid"',
  'multiple_unsafe_ops_per_block = "forbid"',
  'allow_attributes = "forbid"',
  'allow_attributes_without_reason = "forbid"',
];
// The root manifest's other tables, exactly: one workspace over crates/, nothing excluded, the
// profile the hook's release build uses, and the holder's, which must unwind: the holder catches
// a panic in its terminal engine and replaces the engine, and under `abort` the panic would end
// the holder and hang its terminal up. bazhen-client is optimized in `dev`, which `test` inherits.
// Every daemon start hashes the whole holder build with bazhen-client's SHA-256, and a debug
// holder is tens of megabytes: unoptimized, that hash is most of a test daemon's start.
// Any other table (a patch, a test profile) is refused.
export const ROOT_TABLES: Record<string, string[]> = {
  "[workspace]": ['members = ["crates/*"]', 'resolver = "3"'],
  "[workspace.package]": ['edition = "2024"', 'rust-version = "1.100"', "publish = false"],
  "[profile.release]": ["lto = true", "codegen-units = 1", 'panic = "abort"', "strip = true"],
  "[profile.release-holder]": ['inherits = "release"', 'panic = "unwind"'],
  "[profile.dev.package.bazhen-client]": ["opt-level = 3"],
};
export const TOOLCHAIN_CONFIG = [
  "[toolchain]",
  'channel = "1.100.0"',
  'profile = "minimal"',
  'components = ["rustfmt", "clippy", "rust-analyzer", "rust-src"]',
];
const DISALLOWED = (path: string, reason: string) => `{ path = "${path}", reason = "${reason}" },`;
const SETS_NO_O_CLOEXEC = "it sets no O_CLOEXEC; use std::fs::OpenOptions, which does";
// A task nothing awaits loses its error (docs/standards/rust.md § Async and the daemon).
const UNOWNED_TASK = "every task has an owner: spawn through a TaskTracker or a JoinSet";

export const CLIPPY_CONFIG = [
  "allow-unwrap-in-tests = true",
  "allow-expect-in-tests = true",
  "allow-panic-in-tests = true",
  "allow-indexing-slicing-in-tests = true",
  "max-struct-bools = 4",
  // One line: an entry the formatter wraps is read joined (tomlLines).
  [
    "disallowed-methods = [",
    DISALLOWED("rustix::fs::open", SETS_NO_O_CLOEXEC),
    DISALLOWED("rustix::fs::openat", SETS_NO_O_CLOEXEC),
    DISALLOWED(
      "rustix::io::dup",
      "the copy has no FD_CLOEXEC; use OwnedFd::try_clone, which sets it",
    ),
    DISALLOWED("rustix::net::socket", "it sets no SOCK_CLOEXEC; use std's sockets, which do"),
    DISALLOWED(
      "rustix::net::socketpair",
      "it sets SOCK_CLOEXEC only if asked; use UnixStream::pair, which does",
    ),
    DISALLOWED(
      "rustix::net::accept",
      "it sets no SOCK_CLOEXEC; use UnixListener::accept, which does",
    ),
    DISALLOWED(
      "rustix::net::acceptfrom",
      "it sets no SOCK_CLOEXEC; use UnixListener::accept, which does",
    ),
    DISALLOWED(
      "rustix::net::socket_with",
      "it sets SOCK_CLOEXEC only if asked; use std's sockets, which do",
    ),
    DISALLOWED(
      "rustix::net::accept_with",
      "it sets SOCK_CLOEXEC only if asked; use UnixListener::accept, which does",
    ),
    DISALLOWED(
      "rustix::net::acceptfrom_with",
      "it sets SOCK_CLOEXEC only if asked; use UnixListener::accept, which does",
    ),
    DISALLOWED("tokio::spawn", UNOWNED_TASK),
    DISALLOWED("tokio::task::spawn", UNOWNED_TASK),
    DISALLOWED(
      "rustix::net::recvmsg",
      "fds it receives have no FD_CLOEXEC unless asked; the holder receives none",
    ),
    "]",
  ].join(" "),
];

export const DENY_CONFIG = [
  "[graph]",
  "all-features = true",
  // One line: an entry the formatter wraps is read joined (tomlLines).
  'targets = [ "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin", ' +
    '"aarch64-apple-darwin", ]',
  "[advisories]",
  'yanked = "deny"',
  "[licenses]",
  'allow = ["Apache-2.0", "BSD-3-Clause", "MIT", "Unicode-3.0"]',
  "include-dev = true",
  "private = { ignore = true }",
  "[bans]",
  'multiple-versions = "deny"',
  'wildcards = "deny"',
  "allow-wildcard-paths = true",
  "deny = [ " +
    [
      ["sysinfo", "Process::kill signals any pid"],
      ["psutil", "Process::kill signals any pid"],
      ["heim", "Process::kill signals any pid"],
      ["kill_tree", "kill_tree signals any pid's tree"],
      ["pidfd", "PidFd::from_pid holds any pid to signal"],
    ]
      .map(
        ([name, why]) => `{ crate = "${name}", reason = "${why}; signal through a chokepoint" }, `,
      )
      .join("") +
    "]",
  "[sources]",
  'unknown-registry = "deny"',
  'unknown-git = "deny"',
];

// The moon tasks that run the Rust gates, exactly, and the steps of `check` and `format-check` that
// run each of them. The commands themselves are fixed in crates/bazhen-xtask/src/gate.rs; the
// tests run under a cap like any. `check` also runs `rust-schema-check`, the Rust schema's
// generator and its leak checks, which nothing else after a merge runs.
const GATE = "scripts/xtask.sh gate";
export const RUST_GATE_TASKS: Record<string, string> = {
  "gate-fmt": `${GATE} fmt`,
  "lint-rust": `${GATE} lint`,
  deny: `${GATE} deny`,
  "test-rust": `node scripts/capped.ts --memory 4G --time 30m -- ${GATE} test`,
};
export const GATE_STEPS: Record<string, readonly string[]> = {
  check: [
    "format-check",
    "lint-rust",
    "deny",
    "test-rust",
    "rust-schema-check",
    "protocol-dual-types",
  ],
  "format-check": ["gate-fmt"],
};

// cargo's target runner, which caps every test binary, and cargo-mutants' test tool, nextest,
// which runs no doctests: rustdoc starts those without the runner (docs/standards/testing.md
// § Memory and time caps).
export const CARGO_CONFIG = [
  "[target.'cfg(all())']",
  'runner = ["scripts/capped.ts", "--test-binary", "--"]',
  "[alias]",
  'xtask = [ "run", "--quiet", "--locked", "--package", "bazhen-xtask", "--config", ' +
    `"target.'cfg(all())'.runner=['env']", "--config", "build.rustc-wrapper=''", ` +
    `"--config", "build.rustc-workspace-wrapper=''", "--config", "build.rustc='rustc'", "--", ]`,
];
// scripts/xtask.sh, which every Rust gate script runs through, less its comments and blank lines:
// it builds xtask where no cargo config or caller's variable reaches the build, and runs it
// itself, so no target runner stands in for it.
export const XTASK_WRAPPER = [
  "#!/bin/sh",
  "set -u",
  'root=$(cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1',
  "refuse() {",
  '  echo "scripts/xtask.sh: $*" >&2',
  "  exit 1",
  "}",
  'toolchain=$(sed -n \'s/^channel = "\\([0-9.]*\\)"$/\\1/p\' "$root/rust-toolchain.toml")',
  '[ -n "$toolchain" ] || refuse "rust-toolchain.toml names no channel this can read."',
  "home=${HOME:-}",
  'case $home in /*) ;; *) refuse "HOME names no full path." ;; esac',
  "cargo_home=${CARGO_HOME:-$home/.cargo}",
  'case $cargo_home in /*) ;; *) refuse "CARGO_HOME names no full path." ;; esac',
  "rustup_home=${RUSTUP_HOME:-$home/.rustup}",
  "build=$root/target/xtask",
  "own_home=$build/cargo-home",
  "for name in config config.toml; do",
  '  if [ -e "/.cargo/$name" ] || [ -L "/.cargo/$name" ]; then',
  '    refuse "cargo would read /.cargo/$name while it builds xtask. Remove it."',
  "  fi",
  "done",
  'mkdir -p -- "$cargo_home/registry" "$cargo_home/git" "$own_home" || exit 1',
  "for name in registry git; do",
  '  ln -sfn -- "$cargo_home/$name" "$own_home/$name" || exit 1',
  "done",
  "for name in config config.toml; do",
  '  if [ -e "$own_home/$name" ] || [ -L "$own_home/$name" ]; then',
  '    refuse "the build\'s own cargo home has a $name."',
  "  fi",
  "done",
  "isolated() {",
  '  (cd / && env -i PATH="${PATH:-}" HOME="$home" RUSTUP_HOME="$rustup_home" \\',
  '    RUSTUP_TOOLCHAIN="$toolchain" CARGO_HOME="$own_home" CARGO_TARGET_DIR="$build" \\',
  '    cargo "$@" --quiet --locked --manifest-path "$root/Cargo.toml" --package bazhen-xtask)',
  "}",
  'isolated clean || refuse "cargo couldn\'t remove the xtask it built before."',
  "built=$(isolated build --bin bazhen-xtask --message-format=json-render-diagnostics) ||",
  '  refuse "cargo couldn\'t build xtask."',
  'bins=$(printf \'%s\\n\' "$built" | sed -n \'s/.*"executable":"\\([^"\\\\]*\\)".*/\\1/p\')',
  '[ "$(printf \'%s\\n\' "$bins" | grep -c .)" = 1 ] ||',
  '  refuse "cargo named no single executable for bazhen-xtask this can run."',
  "bin=$bins",
  '[ -x "$bin" ] || refuse "cargo named $bin for bazhen-xtask, which isn\'t an executable."',
  "unset CARGO_MANIFEST_DIR",
  "BAZHEN_XTASK_ROOT=$root",
  "export BAZHEN_XTASK_ROOT",
  'exec "$bin" "$@"',
];

/** A shell script's lines, less its comments and blank lines. */
const shellLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.trim() !== "" && !/^\s*#(?!!)/.test(line));

export const MUTANTS_CONFIG = ['test_tool = "nextest"'];

// What starts tests: vitest, playwright, nextest, cargo-mutants, cargo-fuzz, cargo test and bench,
// and the scripts that run one of those. A script step that does runs under scripts/capped.ts, at
// most at these caps.
const TEST_RUNNER =
  /\b(?:vitest|playwright|cargo-(?:nextest|mutants|fuzz)|cargo\s+(?:\+\S+\s+)?(?:test|bench|nextest|mutants|fuzz)|(?:cargo xtask|xtask\.sh) gate test|falsify\.ts|hook-bench\.ts|engine-replay\.ts|test-real\.ts)\b/;
const CAPPED_STEP = new RegExp(
  "^node (?:\\.\\./)*scripts/capped\\.ts --memory (\\d+)G --time (\\d+)m" +
    `(?: ${COUNTED_KILLS_FLAG})? -- \\S`,
);
export const MAX_CAP = { gib: 24, minutes: 120 };

// The root's tasks whose command counts its tests' memory kills as outcomes, as a mutation run
// does, and so may pass capped's flag that keeps such a kill from failing the run. Anywhere else a
// memory kill fails the run that saw it.
export const COUNTED_KILLS_TASKS: ReadonlySet<string> = new Set([
  "test-falsify",
  "test-falsify-base",
  "test-mutants-holder",
]);

/**
 * Why a package.json's scripts, or moon's tasks as `noun` says, would start tests without a cap,
 * or with one too big to bite, or would let a memory kill pass where `countsKills` doesn't name
 * the script.
 */
export function cappedScriptFailures(
  file: string,
  scripts: Record<string, string>,
  noun = "script",
  countsKills: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const [name, script] of Object.entries(scripts)) {
    if (script.includes(COUNTED_KILLS_FLAG) && !countsKills.has(name)) {
      out.push(
        `${file}: the "${name}" ${noun} passes capped \`${COUNTED_KILLS_FLAG}\`, which only a ` +
          "root task that counts its tests' memory kills may (COUNTED_KILLS_TASKS in " +
          "scripts/check-standards.ts): anywhere else a memory kill fails the run.",
      );
    }
    if (!TEST_RUNNER.test(script)) continue;
    if (/[|;\n\r`]|\$\(|(?<!&)&(?!&)/.test(script)) {
      out.push(
        `${file}: the "${name}" ${noun} starts tests, so it joins its steps with \`&&\` alone: ` +
          "a `|`, `;`, `&`, line break or command substitution could run one round its cap.",
      );
      continue;
    }
    for (const step of script.split("&&").map((s) => s.trim())) {
      if (!TEST_RUNNER.test(step)) continue;
      const capped = CAPPED_STEP.exec(step);
      if (capped === null) {
        out.push(
          `${file}: the "${name}" ${noun} starts tests without a memory and time cap. Run the ` +
            "step as `node scripts/capped.ts --memory <n>G --time <n>m -- <command>` " +
            "(docs/standards/testing.md § Memory and time caps).",
        );
      } else if (Number(capped[1]) > MAX_CAP.gib || Number(capped[2]) > MAX_CAP.minutes) {
        out.push(
          `${file}: the "${name}" ${noun}'s cap is above ${MAX_CAP.gib}G or ` +
            `${MAX_CAP.minutes}m (MAX_CAP in scripts/check-standards.ts), too big to bite.`,
        );
      }
    }
  }
  return out;
}

// Files that may name a flag or variable that can switch lints off, each with why. Anywhere else,
// naming one is setting it where a gate would run.
const RUST_FLAG_EXEMPT: Record<string, string> = {
  ".cargo/config.toml":
    "overrides a configured wrapper for xtask's own build; CARGO_CONFIG pins it",
  "scripts/xtask.sh":
    "builds xtask with no variable from the caller but those it names; XTASK_WRAPPER pins it",
  "crates/bazhen-xtask/src/gate.rs":
    "removes them from every gate's environment, and tests it does",
  "crates/bazhen-xtask/src/cargo_config.rs": "plants them in configs to check they are refused",
  "scripts/cargo-config.medium.test.ts":
    "sets a host runner and CARGO_ALIAS_XTASK to show scripts/xtask.sh fails a run xtask never saw",
  "scripts/rust-gate.ts":
    "removes them from the environment falsify and holder-mutants run cargo in",
  "scripts/rust-gate.test.ts": "sets them to check gateEnv removes them",
  "scripts/xtask-gate.medium.test.ts": "sets them to check the tool never sees them",
  "scripts/check-standards.ts": "names them to find them",
  "scripts/check-standards.test.ts": "plants them to check they are found",
};
const LINT_FLAG =
  /(?:\b|_)rust(?:doc)?flags\b|rustc[-_](?:workspace[-_])?wrapper|\bcargo_alias_|cap-lints/i;

// moon is the repository's menu: its tasks are every command the repository runs. Its configs are
// read here as moon reads them and held to what made the scripts safe to run: every task runs
// afresh, every step that starts tests runs under a cap, the gates run their pinned commands, and
// `check` runs each gate. A config moon would read that this doesn't (a .moon/tasks file every
// project inherits, a moon.yml) is refused, and so is a key of a task this doesn't know, so no
// task can run something round these rules.
const MOON_WORKSPACE = ".moon/workspace.toml";
const PROTOTOOLS = ".prototools";
const MOON_CONFIG = /^\.moon\/|(?:^|\/)moon\.(?:ya?ml|json5?|jsonc|pkl|hcl|toml)$/;
const MOON_PACKAGE = /^@moonrepo\//;
// The moon CI and the test image run: the lockfile's, which pnpm installs from hashed packages
// without running an install script, at the version .prototools pins for every host's proto.
const MOON_CLI = "@moonrepo/cli";
const ROOT_PROJECT = "root";
// The keys of a task, and of its options, this check reads; any other could change what it runs
// or let it pass unrun (`extends`, `options.allowFailure`, `options.envFile`, …).
const MOON_TASK_KEYS = new Set(["command", "args", "script", "deps", "options"]);
const MOON_TASK_OPTIONS = new Set([
  "cache",
  "runDepsInParallel",
  "persistent",
  "interactive",
  "runInCI",
  "internal",
  // Only where moon prints a task's output, and only as "stream", which hides none of it.
  "outputStyle",
]);
// The only package.json scripts: pnpm's own install hook, which moon can't start.
export const PACKAGE_SCRIPTS: Record<string, Record<string, string>> = {
  "package.json": { prepare: "husky" },
};

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A task's command or args, a string or a list of words, as one line. */
const taskWords = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).join(" ") : typeof value === "string" ? value : "";

/** What moon runs for a task: its script, or its command and args as one line. */
function taskCommand(task: Table): string {
  if (typeof task["script"] === "string") return task["script"];
  return [taskWords(task["command"]), taskWords(task["args"])].filter((w) => w !== "").join(" ");
}

/** A moon task, with the config it is in. */
export interface MoonTask {
  file: string;
  task: Table;
}

/**
 * moon's tasks by `project:task`, read from the projects .moon/workspace.toml lists, and why one
 * couldn't be read.
 */
export function moonTasks(
  paths: readonly string[],
  read: (path: string) => string,
): { tasks: Map<string, MoonTask>; failures: string[] } {
  const tasks = new Map<string, MoonTask>();
  const problems: string[] = [];
  const toml = (file: string): Table | undefined => {
    try {
      return parseToml(read(file));
    } catch (error) {
      problems.push(`${file}: moon can't read it: ${String(error).split("\n")[0]}`);
      return undefined;
    }
  };
  if (!paths.includes(MOON_WORKSPACE)) {
    problems.push(`${MOON_WORKSPACE} is missing; moon's tasks are the repository's commands.`);
    return { tasks, failures: problems };
  }
  const workspace = toml(MOON_WORKSPACE);
  if (workspace === undefined) return { tasks, failures: problems };
  if (workspace["telemetry"] !== false) {
    problems.push(`${MOON_WORKSPACE}: set \`telemetry = false\`; moon reports usage otherwise.`);
  }
  const projects = workspace["projects"];
  const folders = isTable(projects) ? Object.entries(projects) : [];
  if (
    !isTable(projects) ||
    folders.some(([, folder]) => typeof folder !== "string") ||
    projects[ROOT_PROJECT] !== "."
  ) {
    problems.push(
      `${MOON_WORKSPACE}: list the projects as a table of id = "folder", with ` +
        `${ROOT_PROJECT} = "." for the workspace-wide tasks; a glob would hide which configs moon reads.`,
    );
  }
  const configs = new Map<string, string>();
  for (const [id, folder] of folders) {
    if (typeof folder === "string")
      configs.set(folder === "." ? "moon.toml" : `${folder}/moon.toml`, id);
  }
  for (const file of paths.filter((p) => MOON_CONFIG.test(p))) {
    if (file !== MOON_WORKSPACE && !configs.has(file)) {
      problems.push(
        `${file}: moon reads it, and this check doesn't. A project's tasks go in its moon.toml, ` +
          `the project listed in ${MOON_WORKSPACE}.`,
      );
    }
  }
  for (const [file, id] of configs) {
    if (!paths.includes(file)) continue;
    const config = toml(file);
    const table = config?.["tasks"] ?? {};
    if (!isTable(table)) {
      problems.push(`${file}: \`tasks\` must be a table of tasks.`);
      continue;
    }
    for (const [name, task] of Object.entries(table)) {
      if (isTable(task)) tasks.set(`${id}:${name}`, { file, task });
      else problems.push(`${file}: the "${name}" task must be a table.`);
    }
  }
  return { tasks, failures: problems };
}

/** The tasks a person or CI may run, as `project:task`: every task but the internal ones. */
export function publicTargets(tasks: ReadonlyMap<string, MoonTask>): Set<string> {
  return new Set(
    [...tasks].flatMap(([target, { task }]) =>
      isTable(task["options"]) && task["options"]["internal"] === true ? [] : [target],
    ),
  );
}

/** Why moon's config, .prototools or a package.json's scripts would let a command run unchecked. */
export function moonFailures(paths: readonly string[], read: (path: string) => string): string[] {
  const { tasks, failures: out } = moonTasks(paths, read);
  for (const [target, { file, task }] of tasks) {
    const name = target.split(":")[1] ?? "";
    for (const key of Object.keys(task).filter((k) => !MOON_TASK_KEYS.has(k))) {
      out.push(
        `${file}: the "${name}" task sets \`${key}\`, which scripts/check-standards.ts doesn't read.`,
      );
    }
    const options = isTable(task["options"]) ? task["options"] : {};
    for (const key of Object.keys(options).filter((k) => !MOON_TASK_OPTIONS.has(k))) {
      out.push(
        `${file}: the "${name}" task sets \`options.${key}\`, which scripts/check-standards.ts ` +
          "doesn't read; add it to MOON_TASK_OPTIONS there, with why it can't let a task pass unrun.",
      );
    }
    if ("outputStyle" in options && options["outputStyle"] !== "stream") {
      out.push(
        `${file}: the "${name}" task sets \`options.outputStyle\` to anything but "stream": ` +
          "`none` and `hash` print no log, and a failing task's log is what says why.",
      );
    }
    if (options["cache"] !== false) {
      out.push(
        `${file}: the "${name}" task needs \`options = { cache = false }\`: moon would replay an ` +
          "earlier run's result in place of running it.",
      );
    }
    if ("runInCI" in options && options["persistent"] !== true && options["interactive"] !== true) {
      out.push(
        `${file}: the "${name}" task sets \`options.runInCI\`, which only a server or the CLI ` +
          "(`persistent` or `interactive`) may: CI would skip it.",
      );
    }
    const deps = task["deps"] ?? [];
    if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== "string")) {
      out.push(
        `${file}: the "${name}" task must name its deps as a list of targets; a dep given args or ` +
          "env runs another command than that task's own.",
      );
    }
    const countsKills = target === `${ROOT_PROJECT}:${name}` ? COUNTED_KILLS_TASKS : undefined;
    out.push(...cappedScriptFailures(file, { [name]: taskCommand(task) }, "task", countsKills));
  }
  const rootTask = (name: string) => tasks.get(`${ROOT_PROJECT}:${name}`)?.task;
  for (const [name, command] of Object.entries(RUST_GATE_TASKS)) {
    const task = rootTask(name);
    const extra = Object.keys(task ?? {}).filter((key) => key !== "command" && key !== "options");
    if (task === undefined || task["command"] !== command || extra.length > 0) {
      out.push(
        `moon.toml: the "${name}" task must run \`${command}\` and nothing else (RUST_GATE_TASKS ` +
          "in scripts/check-standards.ts); a gate's command changes in crates/bazhen-xtask/src/gate.rs.",
      );
    }
  }
  for (const [name, steps] of Object.entries(GATE_STEPS)) {
    const deps = rootTask(name)?.["deps"];
    const named = Array.isArray(deps)
      ? deps.map((dep) => String(dep).replace(/^(?:root|~):/, ""))
      : [];
    for (const step of steps.filter((s) => !named.includes(s))) {
      out.push(`moon.toml: the "${name}" task must run \`${step}\` among its deps.`);
    }
  }
  out.push(...prototoolsFailures(paths, read));
  const pin = prototoolsMoon(paths, read);
  for (const file of paths.filter((p) => fileName(p) === "package.json")) {
    const pkg: unknown = JSON.parse(read(file));
    const scripts = packageScripts(read, file);
    const allowed = PACKAGE_SCRIPTS[file] ?? {};
    const names = [...new Set([...Object.keys(scripts), ...Object.keys(allowed)])];
    for (const name of names.filter((n) => scripts[n] !== allowed[n])) {
      out.push(
        allowed[name] === undefined
          ? `${file}: the "${name}" script belongs in a moon task: the repository's commands are ` +
              "moon's (PACKAGE_SCRIPTS in scripts/check-standards.ts)."
          : `${file}: the "${name}" script must be \`${allowed[name]}\`.`,
      );
    }
    const pinned = `"${MOON_CLI}": "${pin ?? "<the moon version>"}"`;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = isTable(pkg) && isTable(pkg[field]) ? pkg[field] : {};
      for (const [dep, version] of Object.entries(deps).filter(([d]) => MOON_PACKAGE.test(d))) {
        const rootCli = file === "package.json" && field === "devDependencies" && dep === MOON_CLI;
        if (rootCli && (pin === undefined || version === pin)) continue;
        out.push(
          `${file}: depends on ${dep} ${String(version)}; the one moon package is ${pinned} in ` +
            `package.json's devDependencies, at the version ${PROTOTOOLS} pins.`,
        );
      }
    }
    const dev = isTable(pkg) && isTable(pkg["devDependencies"]) ? pkg["devDependencies"] : {};
    if (file === "package.json" && !(MOON_CLI in dev)) {
      out.push(
        `package.json: needs ${pinned} in devDependencies: CI and the test image run the moon ` +
          `the lockfile pins, at the version ${PROTOTOOLS} pins.`,
      );
    }
  }
  return out;
}

/** The one exact moon version .prototools pins, alone; undefined if it pins anything else. */
function prototoolsMoon(paths: readonly string[], read: (path: string) => string) {
  if (!paths.includes(PROTOTOOLS)) return undefined;
  try {
    const pins = parseToml(read(PROTOTOOLS));
    const moon = pins["moon"];
    return Object.keys(pins).length === 1 &&
      typeof moon === "string" &&
      /^\d+\.\d+\.\d+$/.test(moon)
      ? moon
      : undefined;
  } catch {
    return undefined;
  }
}

/** Why .prototools doesn't pin moon to one exact version, or pins something this doesn't read. */
function prototoolsFailures(paths: readonly string[], read: (path: string) => string): string[] {
  if (!paths.includes(PROTOTOOLS))
    return [`${PROTOTOOLS} is missing; it pins the moon every host runs.`];
  return prototoolsMoon(paths, read) === undefined
    ? [`${PROTOTOOLS}: must pin moon to one exact version (\`moon = "x.y.z"\`) and nothing else.`]
    : [];
}

const TOML_HEADER = /^\[\[?[^\]]*\]\]?$/;

/**
 * Scans one line of TOML from where the scan before it left off. Returns the line with its comment
 * cut and trimmed, how many brackets are open outside strings, and the quote of a multi-line
 * string still open (`"""` or `'''`), or "". A `#` starts a comment only outside a string.
 *
 * @throws on a one-line string left open at the end of its line, which no valid TOML has: carried
 *   on, it would join every later line into one entry and hide the tables there.
 */
function tomlScan(
  line: string,
  depth: number,
  quote: string,
): { code: string; depth: number; quote: string } {
  let end = line.length;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== "") {
      if (c === "\\" && quote.startsWith('"')) i++;
      else if (line.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = "";
      }
    } else if (c === "#") {
      end = i;
      break;
    } else if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      quote = line.slice(i, i + 3);
      i += 2;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  if (quote === '"' || quote === "'") {
    throw new Error(`TOML: a string left open at the end of the line \`${line.trim()}\``);
  }
  return { code: line.slice(0, end).trim(), depth, quote };
}

/**
 * TOML's lines with comments and blank lines dropped, each trimmed, and an entry the formatter
 * wrapped across lines (a long inline table or array) joined back into one. Comments and brackets
 * are found outside strings only, and a table header always starts afresh, so no entry left open
 * can swallow the tables after it.
 */
function tomlLines(text: string): string[] {
  const lines: string[] = [];
  let entry = "";
  let scan = { depth: 0, quote: "" };
  const flush = () => {
    if (entry !== "") lines.push(entry);
    entry = "";
    scan = { depth: 0, quote: "" };
  };
  for (const line of text.split(/\r?\n/)) {
    const inString = scan.quote !== "";
    const next = tomlScan(line, scan.depth, scan.quote);
    if (next.code === "") continue;
    if (!inString && TOML_HEADER.test(next.code)) {
      flush();
      lines.push(next.code);
      continue;
    }
    entry = entry === "" ? next.code : `${entry} ${next.code}`;
    scan = { depth: next.depth, quote: next.quote };
    if (scan.depth <= 0 && scan.quote === "") flush();
  }
  flush();
  return lines;
}

/** Each table's lines, by its header; the lines before any header are under "". */
export function tomlTables(text: string): Map<string, string[]> {
  const tables = new Map<string, string[]>([["", []]]);
  let current: string[] = tables.get("") ?? [];
  for (const line of tomlLines(text)) {
    if (TOML_HEADER.test(line)) {
      current = tables.get(line) ?? [];
      tables.set(line, current);
    } else current.push(line);
  }
  return tables;
}

const DEPENDENCY_TABLE = /^\[(?:target\..+\.)?(?:dev-|build-)?dependencies\]$/;

/** Why a member manifest's dependencies don't all come from `[workspace.dependencies]`. */
export function memberDependencyFailures(manifest: string, text: string): string[] {
  const out: string[] = [];
  for (const [header, lines] of tomlTables(text)) {
    if (/^\[(?:target\..+\.)?(?:dev-|build-)?dependencies\./.test(header)) {
      out.push(`${manifest}: ${header} must be an entry \`{ workspace = true }\` instead.`);
    }
    if (!DEPENDENCY_TABLE.test(header)) continue;
    for (const line of lines) {
      const inherited =
        /^[\w-]+\s*=\s*\{\s*workspace\s*=\s*true\s*(?:,\s*features\s*=\s*\[[^\]]*\]\s*)?(?:,\s*optional\s*=\s*true\s*)?\}$/.test(
          line,
        ) || /^[\w-]+\.workspace\s*=\s*true$/.test(line);
      if (!inherited) {
        out.push(
          `${manifest}: \`${line}\` must be \`{ workspace = true }\`, its version pinned in the ` +
            "root Cargo.toml's [workspace.dependencies] (docs/standards/rust.md § Dependencies).",
        );
      }
    }
  }
  return out;
}

/** A target in `cargo metadata`'s report, as far as the checks read it. */
export type CargoTarget = {
  kind: string[];
  name: string;
  src_path: string;
  test: boolean;
  "required-features"?: string[];
};
/** A dependency in `cargo metadata`'s report. */
export type CargoDependency = { name: string; req: string; kind: string | null; path?: string };
/** The parts of `cargo metadata --no-deps --format-version 1` the checks read. */
export type CargoMetadata = {
  workspace_root: string;
  packages: {
    name: string;
    manifest_path: string;
    targets: CargoTarget[];
    dependencies: CargoDependency[];
  }[];
};

// Where Cargo looks for each kind of target by default, relative to the crate: the only places
// a target may be, so the scan reads every one.
const TARGET_PLACES: Record<string, RegExp> = {
  lib: /^src\/lib\.rs$/,
  bin: /^src\/(?:main\.rs|bin\/[\w-]+\.rs|bin\/[\w-]+\/main\.rs)$/,
  test: /^tests\/(?:[\w-]+\.rs|[\w-]+\/main\.rs)$/,
  bench: /^benches\/(?:[\w-]+\.rs|[\w-]+\/main\.rs)$/,
  example: /^examples\/(?:[\w-]+\.rs|[\w-]+\/main\.rs)$/,
};
const TARGET_FILE =
  /^crates\/[^/]+\/(src\/(?:lib|main)\.rs|src\/bin\/[^/]+\.rs|src\/bin\/[^/]+\/main\.rs|(?:tests|benches|examples)\/[^/]+\.rs|(?:tests|benches|examples)\/[^/]+\/main\.rs)$/;

/**
 * Why the workspace Cargo reports doesn't build what the checks read: every crate in crates/ a
 * member; every target of a kind the gates build, at Cargo's default place, run by the tests and
 * needing no feature; no build script or proc macro; every file at a default place a target; and
 * every dependency an exact version, or a path to a crate of ours. Read from Cargo itself, so no
 * spelling of a manifest can say one thing to the scan and another to Cargo.
 */
export function metadataFailures(meta: CargoMetadata, paths: string[]): string[] {
  const out: string[] = [];
  const top = meta.workspace_root.replace(/\/?$/, "/");
  const rel = (path: string) => (path.startsWith(top) ? path.slice(top.length) : path);
  const sources = new Set<string>();
  const members = new Set(meta.packages.map((p) => rel(p.manifest_path)));
  for (const manifest of paths.filter((p) => /^crates\/[^/]+\/Cargo\.toml$/.test(p))) {
    if (!members.has(manifest)) {
      out.push(`${manifest}: isn't a member of the root workspace, so no gate builds it.`);
    }
  }
  for (const pkg of meta.packages) {
    const dir = rel(pkg.manifest_path).replace(/Cargo\.toml$/, "");
    for (const t of pkg.targets) {
      const src = rel(t.src_path);
      sources.add(src);
      const [kind = ""] = t.kind;
      const place = TARGET_PLACES[kind];
      if (place === undefined || t.kind.length !== 1) {
        out.push(
          `${dir}: target ${t.name} is a ${t.kind.join("/")}. A build script or proc macro of ` +
            "ours could change what is compiled, or emit code no check reads.",
        );
      } else if (!src.startsWith(dir) || !place.test(src.slice(dir.length))) {
        out.push(
          `${dir}: target ${t.name} is built from ${src}. Keep each target where Cargo looks by ` +
            "default (src/lib.rs, src/main.rs, src/bin/, tests/), where the checks read it.",
        );
      } else if (
        (["lib", "bin", "test"].includes(kind) && !t.test) ||
        (t["required-features"] ?? []).length > 0
      ) {
        out.push(
          `${dir}: target ${t.name} is left out of the tests or needs a feature. Every target ` +
            "builds and runs its tests.",
        );
      }
    }
    for (const dep of pkg.dependencies) {
      const ours = dep.path !== undefined && /^crates\/[^/]+\/?$/.test(rel(dep.path) + "/");
      if (dep.kind === "build") {
        out.push(
          `${dir}: ${dep.name} is a build dependency, and a crate here has no build script.`,
        );
      } else if (!ours && !dep.req.startsWith("=")) {
        out.push(
          `${dir}: ${dep.name} is \`${dep.req}\`. A dependency is pinned exactly in ` +
            "[workspace.dependencies], or is a crate of ours in crates/.",
        );
      }
    }
  }
  for (const file of paths.filter((p) => TARGET_FILE.test(p) && !sources.has(p))) {
    out.push(`${file}: is where Cargo looks for a target, but no target builds it.`);
  }
  return out;
}

/**
 * The crates a short-lived client must never build: an async runtime, the HTTP stack, SQLite. The
 * CLI and the hook start on every call, and a crate both they and the daemon use passes on
 * whatever it takes (docs/standards/rust.md § Crates).
 */
export const HEAVY_CRATES = [
  "tokio",
  "async-std",
  "smol",
  "hyper",
  "axum",
  "reqwest",
  "rusqlite",
  "libsqlite3-sys",
  "sqlx",
  "diesel",
  "ureq",
  "h2",
  "tower",
];

// The members that may reach a crate in HEAVY_CRATES, each with why. A member that depends on
// one of them reaches the heavy crate too, so it needs its own entry.
const HEAVY_ALLOWED: Record<string, string> = {
  "bazhen-daemon":
    "the Rust daemon: its async runtime and HTTP stack serve the API, and it opens the store",
  "bazhen-host-guard":
    "the daemon's signal chokepoint: its bounded runs wait on a child under tokio, as only the " +
    "daemon does",
  "bazhen-runtime-holder":
    "the daemon's holder runtime: its client talks to each holder's socket under tokio, as only " +
    "the daemon does",
  "bazhen-store": "the daemon's SQLite seam: it builds SQLite, which only the daemon needs",
};

/** Each package's dependencies, by name, as Cargo.lock records them. */
export function lockGraph(lock: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const block of lock.split(/^\[\[package\]\]$/m).slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    if (name === undefined) continue;
    const list = /^dependencies = \[([^\]]*)\]/m.exec(block)?.[1] ?? "";
    // An entry is `"name"`, or `"name version"` where two versions are locked.
    const deps = [...list.matchAll(/"([^"\s]+)[^"]*"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
    graph.set(name, [...(graph.get(name) ?? []), ...deps]);
  }
  return graph;
}

/**
 * Where a member reaches a crate in HEAVY_CRATES through what it builds, and isn't listed in
 * `allowed`, each with the chain that gets there, and an entry of `allowed` that is stale. A
 * member's own edges come from `cargo metadata`, so dev-dependencies, which only its tests build,
 * don't count, and anything else does; past the first crate that isn't ours, from Cargo.lock.
 */
export function heavyDependencyFailures(
  meta: CargoMetadata,
  lock: string,
  allowed: Record<string, string>,
  heavy: readonly string[] = HEAVY_CRATES,
): string[] {
  const third = lockGraph(lock);
  const members = new Map(
    meta.packages.map((p) => [
      p.name,
      p.dependencies.filter((d) => d.kind !== "dev").map((d) => d.name),
    ]),
  );
  const edges = (name: string) => members.get(name) ?? third.get(name) ?? [];
  const chains = (start: string) => {
    const via = new Map<string, string>();
    const queue = [start];
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      for (const next of edges(name)) {
        if (next === start || via.has(next)) continue;
        via.set(next, name);
        queue.push(next);
      }
    }
    const chain = (end: string) => {
      const path = [end];
      for (let at = via.get(end); at !== undefined; at = via.get(at)) path.unshift(at);
      return path.join(" → ");
    };
    return heavy.filter((h) => via.has(h)).map(chain);
  };
  const out: string[] = [];
  for (const name of members.keys()) {
    const reached = chains(name);
    if (Object.hasOwn(allowed, name)) {
      if (reached.length === 0) {
        out.push(
          `scripts/check-standards.ts: HEAVY_ALLOWED lists ${name}, which reaches none of ` +
            "HEAVY_CRATES; remove it.",
        );
      }
      continue;
    }
    for (const chain of reached) {
      out.push(
        `${name}: builds ${chain}. The CLI, the hook and the crates they share start on every ` +
          "call, so they take no async runtime, HTTP stack or SQLite; a crate that needs one goes " +
          "in HEAVY_ALLOWED in scripts/check-standards.ts, with why (docs/standards/rust.md § Crates).",
      );
    }
  }
  for (const name of Object.keys(allowed).filter((n) => !members.has(n))) {
    out.push(`scripts/check-standards.ts: HEAVY_ALLOWED lists missing ${name}.`);
  }
  return out;
}

/**
 * Why a member manifest gives a test target a harness of its own, which could run nothing, or
 * holds an escape: a quoted key can spell `harness` with escapes (`"\u0068arness"`) that no text
 * check reads as the word, so a member manifest has none.
 */
export function harnessFailures(manifest: string, text: string): string[] {
  if (text.includes("\\")) {
    return [
      `${manifest}: holds a \\ escape, which can spell a key the checks don't read as itself. ` +
        "Write every key and value out plainly.",
    ];
  }
  // A bare key may hold `-`, so `bazhen-harness = …`, a dependency, is a key of its own.
  return /(?<![\w-])["']?harness["']?\s*=/.test(text)
    ? [`${manifest}: sets a test harness. Tests run under libtest, which nextest drives.`]
    : [];
}

/** Why the root manifest's lints or pinned dependencies are not what the standard says. */
export function rootManifestFailures(text: string): string[] {
  const out: string[] = [];
  const tables = tomlTables(text);
  for (const [header, lines] of tables) {
    const pinned = ROOT_TABLES[header];
    if (pinned !== undefined && lines.join("\n") !== pinned.join("\n")) {
      out.push(`Cargo.toml: ${header} differs from ROOT_TABLES in scripts/check-standards.ts.`);
    } else if (
      pinned === undefined &&
      header !== "[workspace.dependencies]" &&
      !header.startsWith("[workspace.lints") &&
      (header !== "" || lines.length > 0)
    ) {
      out.push(
        `Cargo.toml: ${header || lines[0]} isn't one of the root manifest's tables. Patches, ` +
          "excluded crates and other profiles change what the gates build; they aren't used here.",
      );
    }
  }
  for (const header of Object.keys(ROOT_TABLES).filter((h) => !tables.has(h))) {
    out.push(`Cargo.toml: ${header} is missing (ROOT_TABLES in scripts/check-standards.ts).`);
  }
  const lints = [...tables]
    .filter(([header]) => header.startsWith("[workspace.lints"))
    .flatMap(([header, lines]) => [header, ...lines]);
  if (lints.join("\n") !== WORKSPACE_LINTS.join("\n")) {
    out.push(
      "Cargo.toml: [workspace.lints] differs from WORKSPACE_LINTS in scripts/check-standards.ts. " +
        "A lint level changes in both, with docs/standards/rust.md, in one commit that says why.",
    );
  }
  for (const line of tables.get("[workspace.dependencies]") ?? []) {
    const version = /^[\w-]+\s*=\s*(?:"([^"]*)"|\{.*\bversion\s*=\s*"([^"]*)".*\})$/.exec(line);
    const path = /^([\w-]+)\s*=\s*\{(?!.*\bversion\b).*\bpath\s*=\s*"crates\/\1".*\}$/.test(line);
    if (!path && !(version?.[1] ?? version?.[2] ?? "").startsWith("=")) {
      out.push(
        `Cargo.toml: \`${line}\` must pin an exact version (\`"=x.y.z"\`) or be a path to a ` +
          'crate of ours (`path = "crates/<name>"`).',
      );
    }
  }
  return out;
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The crates whose product code may name a harness, each with why. Every other crate's code is
 * harness-blind: it asks the harness's adapter in bazhen-harness, or reads its capabilities, so a
 * harness is added there alone. A new crate is blind until it is listed here.
 */
const HARNESS_CRATES: Record<string, string> = {
  "bazhen-harness": "the adapters: where each harness is named and read",
  "bazhen-peer":
    "caller identity's process-tree marks, a Codex app-server among them: a security edge",
  "bazhen-protocol": "the wire, which names each harness and its vocabulary",
};

/**
 * Each identifier in bazhen-protocol's product code that holds `codex` or `claude`, and whether
 * harness-blind code may name it freely: a state or sign the daemon records as an adapter gives
 * it, and never branches on. A name that stands in for a harness is bound: each use needs its
 * file's HARNESS_NAMED entry. The list is held to the protocol both ways, so a new name there
 * fails until it is listed.
 */
const HARNESS_VOCABULARY: Record<string, { free: boolean; why: string }> = {
  ClaudeCode: { free: false, why: "a HarnessId variant" },
  ClaudeHook: {
    free: true,
    why: "a readiness and compaction sign, recorded as the adapter gives it",
  },
  ClaudeSession: { free: false, why: "an ExternalRefKind, which stands in for its harness" },
  Codex: { free: false, why: "a HarnessId variant" },
  CodexItem: { free: true, why: "a compaction source, recorded as the adapter gives it" },
  CodexThread: { free: false, why: "an ExternalRefKind, which stands in for its harness" },
  CodexTitle: { free: true, why: "a readiness sign, recorded as the adapter gives it" },
  QueuedInCodex: { free: true, why: "a mailbox state the store passes through" },
  codex: { free: false, why: "the doctor reply's field for one harness's block" },
};

/**
 * The harness names each file of a harness-blind crate may hold, exactly, and why. A name is an
 * identifier, or the word in a string literal that holds `codex` or `claude`, listed with a
 * leading `"` (`"codex`): each kind is held apart, so listing one never lets the other through. A
 * free HARNESS_VOCABULARY identifier needs no entry.
 */
const HARNESS_NAMED: Record<string, { names: string[]; why: string }> = {
  "crates/bazhen/src/attach.rs": {
    names: ['"Codex', "ClaudeCode", '"Claude', "Codex"],
    why: "names each harness to the person attaching, and a Codex thread apart from a session",
  },
  "crates/bazhen/src/doctor.rs": {
    names: ['"codex', "codex", '"Codex'],
    why: "renders the doctor reply's Codex block",
  },
  "crates/bazhen/src/lib.rs": {
    names: ['"claude-code', '"codex'],
    why: "the usage text, which lists the harnesses",
  },
  "crates/bazhen-client/src/lib.rs": {
    names: ['"codex_thread', "codex_thread", '"CODEX_THREAD_ID', '"Bazhen-Codex-Thread'],
    why: "the Codex thread header a call presents, read from the agent's environment",
  },
  "crates/bazhen-hook/src/pane_title.rs": {
    names: ['"codex'],
    why: "the pane-title hook, which posts a Codex TUI's title to its route",
  },
  "crates/bazhen-daemon/src/callers.rs": {
    names: [
      '"Codex',
      "codex_agent",
      "as_codex",
      "is_codex_thread",
      '"bazhen-codex-thread',
      "Codex",
      '"codex',
    ],
    why:
      "caller identity, a security edge, read from the kernel-vouched process tree and a " +
      "header; it must not depend on adapter code that parses untrusted reports. Permanent",
  },
  "crates/bazhen-daemon/src/doctor.rs": {
    names: ["codex"],
    why: "the doctor reply's `codex` field, which the protocol names",
  },
  "crates/bazhen-daemon/src/env.rs": {
    names: [
      '"CLAUDECODE',
      '"CLAUDE_CODE_SESSION_ID',
      '"CLAUDE_CODE_ENTRYPOINT',
      '"CLAUDE_CODE_CHILD_SESSION',
      '"CLAUDE_CODE_MESSAGING_SOCKET',
      '"CLAUDE_CODE_MESSAGING_TOKEN',
      '"CLAUDE_PID',
      '"CLAUDE_CODE_SESSION_ATTENDED',
      '"CLAUDE_CODE_EXECPATH',
      '"CLAUDE_ENV_FILE',
      '"CLAUDE_PROJECT_DIR',
      '"CODEX_THREAD_ID',
      '"CODEX_SANDBOX',
      '"CODEX_SANDBOX_NETWORK_DISABLED',
    ],
    why: "each harness's session variables, which no terminal inherits, whatever runs in it",
  },
  "crates/bazhen-daemon/src/peer.rs": {
    names: ["Codex", "codex_server"],
    why: "caller identity, as callers.rs: a Codex app-server among the caller's ancestors. Permanent",
  },
  "crates/bazhen-store/src/agent_events.rs": {
    names: ['"codex-thread', '"Codex', "CodexThread"],
    why: "the stored `codex-thread` ref, which one live agent at a time may hold",
  },
  "crates/bazhen-store/src/agents.rs": {
    names: ["codex_agent", '"codex', '"codex-thread'],
    why: "caller identity's query, for callers.rs: the live agent bound to a Codex thread",
  },
  "crates/bazhen-xtask/src/schema/corpus.rs": {
    names: ['"codex'],
    why: "a launch agentOrLaunch's cases plant, which must name a harness the protocol's HarnessId holds",
  },
};

/**
 * Where bazhen-daemon's product code reaches `bazhen_harness::compiled`: by its path, a `use`
 * that names it, or a bare `compiled(..)` call in a file that glob-imports the crate. `compiled`
 * holds every adapter the build has, served or not, so its tests and fuzz targets can drive one;
 * the daemon serves what `production` gives it, so an adapter isn't reached by a user before it
 * is served. The daemon's tests may call it. An accepted gap: a crate imported by another name
 * (`use bazhen_harness as h;` then `h::compiled`) isn't seen.
 */
export function compiledFailures(paths: string[], read: (path: string) => string): string[] {
  const sources = paths.filter((p) => /^crates\/bazhen-daemon\/src\/.+\.rs$/.test(p));
  const testOnly = testModuleFiles(sources, read);
  const out: string[] = [];
  for (const file of sources.filter((p) => !testOnly.has(p))) {
    const product = withoutTests(rustCode(read(file)));
    const named = product.matchAll(/\bbazhen_harness\s*::\s*(?:compiled\b|\{[^;]*\bcompiled\b)/g);
    // A glob brings it in unnamed, so each call by the bare name may be it.
    const globbed = /\bbazhen_harness\s*::\s*(?:\*|\{[^;]*\*)/.test(product)
      ? product.matchAll(/(?<![\w:.]\s*|\bfn\s+)\bcompiled\s*\(/g)
      : [];
    for (const m of [...named, ...globbed]) {
      out.push(
        `${file}:${product.slice(0, m.index).split("\n").length}: the daemon serves the ` +
          "harnesses bazhen_harness::production gives it; compiled holds adapters it doesn't " +
          "serve yet, so only its tests may call it.",
      );
    }
  }
  return out;
}

/**
 * The names in a Rust file's product code that name a harness, once as an identifier and once in
 * a string literal, each with its first line.
 */
function harnessNames(source: string): { name: string; line: number; literal: boolean }[] {
  const strings: string[] = [];
  const code = rustCode(source, strings);
  const product = withoutTests(code);
  const out = new Map<string, { name: string; line: number; literal: boolean }>();
  let n = 0;
  for (const m of code.matchAll(/""|[A-Za-z_]\w*/g)) {
    const literal = m[0] === '""';
    const text = literal ? (strings[n++] ?? "") : m[0];
    if (product.slice(m.index, m.index + m[0].length) !== m[0]) continue;
    const names = literal ? text.match(/[\w-]*(?:codex|claude)[\w-]*/gi) : [text];
    for (const name of names ?? []) {
      const key = `${literal ? '"' : ""}${name}`;
      if (!/codex|claude/i.test(name) || out.has(key)) continue;
      out.set(key, { name, line: code.slice(0, m.index).split("\n").length, literal });
    }
  }
  return [...out.values()];
}

/** A found name as a HARNESS_NAMED entry lists it: a string's word with a leading `"`. */
const entryName = (n: { name: string; literal: boolean }) => `${n.literal ? '"' : ""}${n.name}`;

/**
 * Why a harness-blind crate's product code names a harness: by a name its file's HARNESS_NAMED
 * entry doesn't list, as `HarnessId::Codex`, `"claude-code"` or `as_codex` do, where the name
 * isn't the protocol's own vocabulary. Each entry is held both ways: a name it lists that the
 * file no longer holds, a file missing, or one in a crate free to name harnesses, fails too.
 * Comments, test code and test-only modules are not read. `concat!`, `format!` and indexing
 * `HarnessId::ALL` can still spell a harness, and so can branching on a free name, as
 * `if sign == ReadySign::CodexTitle` does: accepted gaps.
 */
export function harnessNameFailures(
  paths: string[],
  read: (path: string) => string,
  crates: Record<string, string>,
  vocabulary: Record<string, { free: boolean; why: string }>,
  named: Record<string, { names: string[]; why: string }>,
): string[] {
  const out: string[] = [];
  const sources = paths.filter((p) => /^crates\/[^/]+\/src\/.+\.rs$/.test(p));
  const testOnly = testModuleFiles(sources, read);
  const product = sources.filter((p) => !testOnly.has(p));
  const free = (file: string) => (file.split("/")[1] ?? "") in crates;
  const protocol = new Set(
    product
      .filter((p) => p.startsWith("crates/bazhen-protocol/"))
      .flatMap((p) =>
        harnessNames(read(p))
          .filter((n) => !n.literal)
          .map((n) => n.name),
      ),
  );
  for (const name of protocol) {
    if (!(name in vocabulary)) {
      out.push(
        `scripts/check-standards.ts: bazhen-protocol names ${name}, which HARNESS_VOCABULARY ` +
          "doesn't list. List it, free only if harness-blind code may name it, with why.",
      );
    }
  }
  for (const name of Object.keys(vocabulary).filter((n) => !protocol.has(n))) {
    out.push(
      `scripts/check-standards.ts: HARNESS_VOCABULARY lists ${name}, which bazhen-protocol's ` +
        "product code doesn't name. Drop it.",
    );
  }
  for (const file of product.filter((p) => !free(p))) {
    const listed = new Set(named[file]?.names ?? []);
    const found = harnessNames(read(file));
    for (const { name, line, literal } of found) {
      if (listed.has(entryName({ name, literal }))) continue;
      if (!literal && vocabulary[name]?.free === true) continue;
      out.push(
        `${file}:${line}: names a harness (\`${literal ? `"${name}"` : name}\`). Code outside the crates in ` +
          "HARNESS_CRATES asks the harness's adapter, or reads its capabilities; a name it " +
          "must hold goes in its file's HARNESS_NAMED entry in scripts/check-standards.ts, with why.",
      );
    }
    for (const name of listed) {
      if (!found.some((n) => entryName(n) === name)) {
        out.push(
          `scripts/check-standards.ts: HARNESS_NAMED lists ${name} for ${file}, which no longer ` +
            "holds it. Drop the name.",
        );
      }
    }
  }
  for (const crate of Object.keys(crates)) {
    if (!paths.some((p) => p.startsWith(`crates/${crate}/`))) {
      out.push(`scripts/check-standards.ts: HARNESS_CRATES lists missing ${crate}.`);
    }
  }
  for (const file of Object.keys(named)) {
    if (!product.includes(file)) {
      out.push(
        `scripts/check-standards.ts: HARNESS_NAMED lists ${file}, which isn't product code.`,
      );
    } else if (free(file)) {
      out.push(
        `scripts/check-standards.ts: HARNESS_NAMED lists ${file}, whose crate HARNESS_CRATES ` +
          "frees already.",
      );
    }
  }
  return out;
}

/**
 * The Rust rules' failures for a repository holding `paths`, read with `read`: crates only in
 * crates/, each taking the workspace lints and its dependencies from the workspace; the lint
 * configuration as the standard says, with nothing beside it to loosen it; and no source that
 * suppresses a lint or builds an attribute a scan can't read.
 */
export function rustFailures(
  paths: string[],
  read: (path: string) => string,
  unsafeModules: Record<string, string>,
  options: {
    metadata?: CargoMetadata;
    macroModules?: Record<string, string>;
    fuzzed?: Record<string, string>;
    notDecoders?: Record<string, string>;
    publicByteFields?: Record<string, string>;
    foreignMacros?: Record<string, ForeignMacro>;
    heavyAllowed?: Record<string, string>;
    harnessCrates?: Record<string, string>;
    harnessVocabulary?: Record<string, { free: boolean; why: string }>;
    harnessNamed?: Record<string, { names: string[]; why: string }>;
  } = {},
): string[] {
  const out: string[] = [];
  for (const manifest of paths.filter((p) => fileName(p) === "Cargo.toml")) {
    if (manifest === "Cargo.toml") {
      out.push(...rootManifestFailures(read(manifest)));
    } else if (/^crates\/[^/]+\/fuzz\/Cargo\.toml$/.test(manifest)) {
      out.push(...fuzzManifestFailures(manifest, read(manifest)));
    } else if (!/^crates\/[^/]+\/Cargo\.toml$/.test(manifest)) {
      out.push(`${manifest}: a crate lives in crates/<name>/, as a member of the root workspace.`);
    } else {
      if (!inheritsWorkspaceLints(read(manifest))) {
        out.push(
          `${manifest}: needs \`[lints]\` with \`workspace = true\`, so the workspace lints apply.`,
        );
      }
      out.push(...memberDependencyFailures(manifest, read(manifest)));
      out.push(...harnessFailures(manifest, read(manifest)));
    }
  }
  for (const file of paths.filter((p) => p.endsWith(".rs"))) {
    if (!file.startsWith("crates/")) {
      out.push(`${file}: Rust source lives in a crate under crates/, where the checks read it.`);
      continue;
    }
    out.push(...attributeFailures(file, read(file), unsafeModules));
    out.push(...macroFailures(file, read(file), options.macroModules ?? {}));
  }
  if (options.metadata !== undefined) {
    out.push(...metadataFailures(options.metadata, paths));
    if (paths.includes("Cargo.lock")) {
      const lock = read("Cargo.lock");
      out.push(...heavyDependencyFailures(options.metadata, lock, options.heavyAllowed ?? {}));
    } else out.push("Cargo.lock is missing; the gates build with --locked.");
  }
  for (const file of Object.keys(options.macroModules ?? {}).filter((f) => !paths.includes(f))) {
    out.push(`scripts/check-standards.ts: MACRO_MODULES lists missing ${file}.`);
  }
  for (const file of Object.keys(unsafeModules)) {
    if (paths.includes(file)) out.push(...unsafeModuleFailures(file, read(file)));
    else out.push(`scripts/check-standards.ts: UNSAFE_MODULES lists missing ${file}.`);
  }
  for (const file of paths) {
    const base = fileName(file);
    if (/(^|\/)\.cargo\/config(\.toml)?$/.test(file) && file !== ".cargo/config.toml") {
      out.push(
        `${file}: cargo config can pass flags that turn lints off; the root .cargo/config.toml ` +
          "is the only one.",
      );
    } else if (["clippy.toml", ".clippy.toml"].includes(base) && file !== "clippy.toml") {
      out.push(`${file}: clippy reads only the root clippy.toml here.`);
    } else if (["rustfmt.toml", ".rustfmt.toml"].includes(base)) {
      out.push(`${file}: rustfmt runs with its defaults (docs/standards/rust.md § Formatting).`);
    } else if (/^rust-toolchain(\.toml)?$/.test(base) && file !== "rust-toolchain.toml") {
      out.push(`${file}: the root rust-toolchain.toml is the one toolchain pin.`);
    } else if (/(^|\/)\.config\/nextest\.toml$/.test(file)) {
      out.push(`${file}: nextest runs with its defaults, so no profile can filter tests out.`);
    } else if (["deny.toml", ".deny.toml"].includes(base) && file !== "deny.toml") {
      out.push(`${file}: cargo-deny reads only the root deny.toml here.`);
    }
    if (!file.endsWith(".md") && !(file in RUST_FLAG_EXEMPT)) {
      const flag = LINT_FLAG.exec(read(file));
      if (flag !== null) {
        out.push(
          `${file}: names \`${flag[0]}\`, which can switch the Rust lints off. The gates run ` +
            "through `cargo xtask gate`, which removes it; a file that must set it goes in " +
            "RUST_FLAG_EXEMPT in scripts/check-standards.ts, with why.",
        );
      }
    }
  }
  for (const file of Object.keys(RUST_FLAG_EXEMPT).filter((f) => !paths.includes(f))) {
    out.push(`scripts/check-standards.ts: RUST_FLAG_EXEMPT lists missing ${file}.`);
  }
  const pinned = (file: string, lines: string[], name: string) => {
    if (!paths.includes(file)) out.push(`${file} is missing; the Rust gates need it.`);
    else if (tomlLines(read(file)).join("\n") !== lines.join("\n")) {
      out.push(`${file}: differs from ${name} in scripts/check-standards.ts.`);
    }
  };
  pinned("deny.toml", DENY_CONFIG, "DENY_CONFIG");
  pinned("rust-toolchain.toml", TOOLCHAIN_CONFIG, "TOOLCHAIN_CONFIG");
  pinned("clippy.toml", CLIPPY_CONFIG, "CLIPPY_CONFIG");
  pinned(".cargo/config.toml", CARGO_CONFIG, "CARGO_CONFIG");
  pinned(".cargo/mutants.toml", MUTANTS_CONFIG, "MUTANTS_CONFIG");
  if (!paths.includes("scripts/xtask.sh")) {
    out.push("scripts/xtask.sh is missing; the Rust gates need it.");
  } else if (shellLines(read("scripts/xtask.sh")).join("\n") !== XTASK_WRAPPER.join("\n")) {
    out.push("scripts/xtask.sh: differs from XTASK_WRAPPER in scripts/check-standards.ts.");
  }
  out.push(
    ...decoderFailures(
      paths,
      read,
      options.fuzzed ?? {},
      options.notDecoders ?? {},
      options.publicByteFields ?? {},
      options.foreignMacros ?? {},
    ),
  );
  out.push(
    ...harnessNameFailures(
      paths,
      read,
      options.harnessCrates ?? {},
      options.harnessVocabulary ?? {},
      options.harnessNamed ?? {},
    ),
  );
  out.push(...compiledFailures(paths, read));
  return out;
}

/** The repository's files, tracked or not yet added, as git sees them. */
function repoFiles(): string[] {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p !== "" && existsSync(join(root, p)) && statSync(join(root, p)).isFile());
}

/** The workspace as Cargo reads it, through the Rust gates' clean environment. */
function cargoMetadata(): CargoMetadata | string {
  const run = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {
    cwd: root,
    env: gateEnv(process.env),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) return run.stderr || "cargo metadata failed to run";
  const parsed: unknown = JSON.parse(run.stdout);
  return isCargoMetadata(parsed) ? parsed : "cargo metadata printed a report the checks can't read";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown) => typeof v === "string";

/** Whether `cargo metadata`'s output has every field the checks read. */
export function isCargoMetadata(value: unknown): value is CargoMetadata {
  return (
    isRecord(value) &&
    str(value.workspace_root) &&
    Array.isArray(value.packages) &&
    value.packages.every(
      (p) =>
        isRecord(p) &&
        str(p.name) &&
        str(p.manifest_path) &&
        Array.isArray(p.targets) &&
        p.targets.every(
          (t) =>
            isRecord(t) &&
            Array.isArray(t.kind) &&
            t.kind.every(str) &&
            str(t.name) &&
            str(t.src_path) &&
            typeof t.test === "boolean",
        ) &&
        Array.isArray(p.dependencies) &&
        p.dependencies.every(
          (d) => isRecord(d) && str(d.name) && str(d.req) && (d.kind === null || str(d.kind)),
        ),
    )
  );
}

function checkRust(): void {
  const metadata = cargoMetadata();
  if (typeof metadata === "string") {
    failures.push(
      `Cargo.toml: \`cargo metadata\` failed, so the workspace can't be read:\n${metadata}`,
    );
    return;
  }
  failures.push(
    ...rustFailures(repoFiles(), (p) => readFileSync(join(root, p), "utf8"), UNSAFE_MODULES, {
      metadata,
      macroModules: MACRO_MODULES,
      fuzzed: FUZZED_DECODERS,
      notDecoders: NOT_DECODERS,
      foreignMacros: FOREIGN_MACROS,
      publicByteFields: PUBLIC_BYTE_FIELDS,
      heavyAllowed: HEAVY_ALLOWED,
      harnessCrates: HARNESS_CRATES,
      harnessVocabulary: HARNESS_VOCABULARY,
      harnessNamed: HARNESS_NAMED,
    }),
  );
}

/** The index just past the `}` that closes the `{` just before `from`, or the end of `code`. */
function closingBrace(code: string, from: number): number {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return i + 1;
  }
  return code.length;
}

// What signals processes a test didn't start: a holder, which signals its child's whole
// session when it closes; a child's close or signal; a respawn, which retires the old session; a
// session's sweep, made by an ending, a retirement or a pass over a session's processes; and the
// ledger sweep, which kills holders. A
// send through the guard alone isn't one: off a disposable host, a test build's guard sends
// nothing. An ending signals only through a `Session` it was given, so what is matched is any
// mention of `Session`, however one is made or named, and `Ending::start`, which takes one. Not
// `Ending::new` on its own, which a test gives a stand-in that signals nothing. That `Session` is
// bazhen-holder's, so the mention counts only in a crate that can reach it; another `Session`,
// such as a key's variant, signals nothing.
const HOLDER_BINARY = "CARGO_BIN_EXE_bazhen-holder";
const SIGNALLING_CALL =
  /\.\s*(?:close(?:_step)?|signal|respawn)\s*\(|\bsweep\s*\(|\bsession\s*\(\s*\)\s*\.|\b(?:pass_among|retire)\s*\(|\bEnding\s*::\s*start\b/;
const SIGNALLING_OR_SESSION = new RegExp(`${SIGNALLING_CALL.source}|\\bSession\\b`);

/**
 * The workspace crates, by directory, that can name bazhen-holder's `Session`: the holder, and
 * each member that depends on it through a dependency of any kind, dev-dependencies too, however
 * many members deep. Read from Cargo, so a crate that comes to depend on the holder is in it.
 */
export function holderReachingCrates(meta: CargoMetadata): Set<string> {
  const reaches = new Set(["bazhen-holder"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of meta.packages) {
      if (!reaches.has(p.name) && p.dependencies.some((d) => reaches.has(d.name))) {
        reaches.add(p.name);
        grew = true;
      }
    }
  }
  const workspace = meta.workspace_root.replace(/\/?$/, "/");
  return new Set(
    meta.packages
      .filter((p) => reaches.has(p.name) && p.manifest_path.startsWith(workspace))
      .map((p) => p.manifest_path.slice(workspace.length).replace(/\/Cargo\.toml$/, "")),
  );
}

/** A Rust test file's test binary: `tests/<name>.rs`, or every file under `tests/<name>/`. */
const testBinary = (file: string) => /^(crates\/[^/]+\/tests\/[^/.]+)/.exec(file)?.[1];

/** Types whose `close()` only stops them giving out more, by their full paths. */
const HARMLESS_CLOSERS = ["tokio::sync::Semaphore", "tokio_util::task::TaskTracker"];

/** Each path a file's `use`s bring in, with the name it is brought in as. */
function usedPaths(code: string): { path: string; as: string }[] {
  return [...code.matchAll(/\buse\s+([^;]+);/g)].flatMap((m) => {
    const text = (m[1] ?? "")
      .replace(/\s+/g, " ")
      .replace(/\s*::\s*/g, "::")
      .trim();
    const group = /^(.*?)::\{(.*)\}$/.exec(text);
    const parts = group === null ? [text] : (group[2] ?? "").split(",").map((part) => part.trim());
    return parts.flatMap((part) => {
      if (part === "" || part === "self") return [];
      const [path = "", alias] = part.split(/ as /);
      const full = (group === null ? path : `${group[1] ?? ""}::${path}`).replace(/^::/, "");
      return [{ path: full, as: alias ?? full.split("::").at(-1) ?? "" }];
    });
  });
}

/**
 * Whether `type`, as `code` writes it, is one of HARMLESS_CLOSERS, alone, borrowed or in an `Arc`:
 * its full path, or its last name where every `use` of that name in the file brings in that path,
 * at least one does, and no item of the file takes the name. Any other type of that name, or a
 * name a glob may bring in, isn't one.
 */
function harmlessType(type: string, code: string): boolean {
  const bare = type
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, "")
    .replace(/^(?:(?:::\s*)?std\s*::\s*sync\s*::\s*)?Arc\s*<\s*(.*?)\s*>$/, "$1")
    .replace(/\s*::\s*/g, "::")
    .replace(/^::/, "");
  return HARMLESS_CLOSERS.some((path) => {
    if (bare === path) return true;
    const name = path.split("::").at(-1) ?? "";
    if (bare !== name) return false;
    const uses = usedPaths(code);
    const named = uses.filter((u) => u.as === name);
    const globbed = uses.some((u) => u.as === "*" && !/^(?:super|self)\b/.test(u.path));
    const item = new RegExp(`\\b(?:struct|enum|union|trait|type)\\s+${name}\\b`).test(code);
    return named.length > 0 && named.every((u) => u.path === path) && !globbed && !item;
  });
}

/** The text up to the first `,`, `;`, `=`, `|`, `{` or unopened bracket outside any brackets. */
function toTopLevelEnd(text: string): string {
  for (let i = 0, depth = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if ("<([".includes(c)) depth++;
    else if (">)]".includes(c) && !(c === ">" && text[i - 1] === "-") && --depth < 0) {
      return text.slice(0, i);
    } else if (depth === 0 && ",;={|}".includes(c)) return text.slice(0, i);
  }
  return text;
}

/** Whether `value`, as `code` writes it, makes one of HARMLESS_CLOSERS: `T::new(`, or in `Arc::new(`. */
function makesHarmless(value: string, code: string): boolean {
  const made =
    /^\s*(?:Arc\s*::\s*new\s*\(\s*)?((?:::\s*)?(?:(?:r#)?\w+\s*::\s*)*?\w+)\s*::\s*new\s*\(/.exec(
      value,
    );
  return made !== null && harmlessType(made[1] ?? "", code);
}

/**
 * Whether `value`, the rest of a `let` after its `=`, is a call of a function `code` defines once
 * that is declared to return one of HARMLESS_CLOSERS, or a tuple holding one as its part `index`:
 * `f(..)` or `f(..).await`, and nothing more, before its `;`.
 */
function returnsHarmless(value: string, index: number | undefined, code: string): boolean {
  const call = /^\s*(?:r#)?(\w+)\s*\(/.exec(value);
  if (call === null) return false;
  const after = value.slice(matchingBracket(value, call[0].length - 1) + 1);
  if (!/^\s*(?:\.\s*await\s*)?;/.test(after)) return false;
  const defined = rustFunctions(code).fns.filter((f) => f.fn === call[1]);
  const returns = /->([\s\S]*)$/.exec(defined.length === 1 ? (defined[0]?.sig ?? "") : "")?.[1];
  const type = (returns ?? "").split(/\bwhere\b/)[0]?.trim() ?? "";
  if (index === undefined) return type !== "" && harmlessType(type, code);
  const parts = /^\(([\s\S]*)\)$/.exec(type)?.[1];
  const part = parts === undefined ? undefined : topLevelParts(parts)[index];
  return part !== undefined && harmlessType(part, code);
}

/** Where a `let`'s pattern ends, tried from the character before: at a lone `=`, or a `;`. */
const LET_PATTERN_END = /^[\s\S](?:=(?![=>])|;)/;

/**
 * Where in `text` the pattern that starts it ends: at the first `stop` outside any brackets, or
 * at a bracket closing one opened before it. `stop` is tried on each character with the one before
 * it, a space at the start, so it can tell where a word starts.
 */
function patternEnd(text: string, stop: RegExp): number {
  for (let i = 0, depth = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (depth === 0 && stop.test((text[i - 1] ?? " ") + text.slice(i, i + 4))) return i;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth < 0) return i;
  }
  return text.length;
}

/**
 * The spans of `text`, a function from its `fn` with its body from `body` on, where a pattern may
 * bind a name, or a macro may, besides a `let`'s, which `bindingsOf` reads: its signature; each
 * `for`'s pattern, to its `in`; a closure's parameters; each match arm's pattern and guard, to its
 * `=>`; and a macro call's arguments.
 */
function patternRegions(text: string, body: number): [number, number][] {
  const regions: [number, number][] = [[0, body]];
  for (const m of text.matchAll(/\bfor\s+/g)) {
    const at = m.index + m[0].length;
    regions.push([at, at + patternEnd(text.slice(at), /^(?:\Win\b|[\s\S];)/)]);
  }
  // Any pipe may open a closure's parameters, whatever `||` or `|` came before it, so each span
  // from one to the next counts, overlapping.
  for (const m of text.matchAll(/\|(?=([^|]*)\|)/g)) {
    regions.push([m.index, m.index + 1 + (m[1] ?? "").length + 1]);
  }
  for (const m of text.matchAll(/\b(?:r#)?\w+\s*!\s*[([{]/g)) {
    const open = m.index + m[0].length - 1;
    regions.push([open, matchingBracket(text, open)]);
  }
  for (const m of text.matchAll(/\bmatch\b/g)) {
    const scrutinee = m.index + m[0].length;
    const open = scrutinee + patternEnd(text.slice(scrutinee), /^[\s\S]\{/);
    if (text[open] !== "{") continue;
    regions.push(...armPatterns(text, open + 1, matchingBracket(text, open)));
  }
  return regions;
}

/**
 * The spans of a match block's arms, from `start` to `end`, that hold each arm's pattern and guard:
 * from the block's start, or the end of the arm before, to the arm's `=>`.
 */
function armPatterns(text: string, start: number, end: number): [number, number][] {
  const arms: [number, number][] = [];
  let from: number | undefined = start;
  let blockBody = false;
  for (let i = start, depth = 0; i < end; i++) {
    const c = text[i] ?? "";
    if (depth === 0 && from !== undefined && text.startsWith("=>", i)) {
      arms.push([from, i]);
      from = undefined;
      i++;
      blockBody = /^\s*\{/.test(text.slice(i + 1));
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      depth--;
      if (depth === 0 && from === undefined && blockBody && c === "}") from = i + 1;
    } else if (depth === 0 && from === undefined && c === ",") {
      from = i + 1;
    }
  }
  return arms;
}

/**
 * Where `text`, a function from its `fn`, binds `name`, each with whether that binding is surely
 * one of HARMLESS_CLOSERS: `name: T`, as a parameter, a `let` or a closure's; `let name = T::new(`
 * or that in an `Arc`; a tuple `let` whose part for `name` is that; either from a call whose
 * function is declared to return one there (`returnsHarmless`). Any other `name:`, and every
 * mention of the name not followed by a `.` or a `(` where a pattern may bind it
 * (`patternRegions`), counts as a binding, unsure. `text` is the function from its `fn`, its body
 * from `body` on.
 */
function bindingsOf(name: string, text: string, body: number, code: string): Map<number, boolean> {
  const sites = new Map<number, boolean>();
  const word = `(?<![\\w.]\\s*)(?:r#)?${name}\\b`;
  for (const m of text.matchAll(new RegExp(`${word}\\s*:(?!:)`, "g"))) {
    const after = text.slice(m.index + m[0].length);
    sites.set(m.index, harmlessType(toTopLevelEnd(after), code));
  }
  for (const m of text.matchAll(/\blet\s+/g)) {
    const rest = text.slice(m.index + m[0].length);
    const pattern = rest.slice(0, patternEnd(rest, LET_PATTERN_END));
    const at = m.index + m[0].length;
    const single = new RegExp(`^(?:mut\\s+)?(?:r#)?${name}\\s*$`).exec(pattern);
    if (single !== null) {
      const offset = at + pattern.indexOf(name);
      if (!sites.has(offset)) {
        const value = rest.slice(pattern.length);
        const made = value.slice(1);
        sites.set(
          offset,
          value.startsWith("=") &&
            (makesHarmless(made, code) || returnsHarmless(made, undefined, code)),
        );
      }
      continue;
    }
    const tupled = /^\(([\s\S]*)\)\s*$/.exec(pattern)?.[1];
    const names = tupled === undefined ? undefined : topLevelParts(tupled);
    const value = rest.slice(pattern.length);
    const tuple = /^=\s*\(/.exec(value);
    for (const found of pattern.matchAll(new RegExp(word, "g"))) {
      const offset = at + found.index;
      if (sites.has(offset)) continue;
      const index = names?.findIndex((n) => new RegExp(`^(?:mut\\s+)?(?:r#)?${name}$`).test(n));
      let sure = false;
      if (index !== undefined && index >= 0 && tuple !== null) {
        const open = pattern.length + tuple[0].length - 1;
        const inner = rest.slice(open + 1, matchingBracket(rest, open));
        const part = topLevelParts(inner)[index];
        sure = part !== undefined && makesHarmless(part, code);
      } else if (index !== undefined && index >= 0 && value.startsWith("=")) {
        sure = returnsHarmless(value.slice(1), index, code);
      }
      sites.set(offset, sure);
    }
  }
  // Every other mention of it where a pattern may bind it, not followed by a `.` or a `(`, is a
  // binding the scan can't be sure of. Out of those places it is a use.
  const mention = new RegExp(`${word}(?!\\s*[.(])`, "g");
  for (const [start, end] of patternRegions(text, body)) {
    for (const found of text.slice(start, end).matchAll(mention)) {
      if (!sites.has(start + found.index)) sites.set(start + found.index, false);
    }
  }
  return sites;
}

/**
 * `code` with each `close()` of a tokio Semaphore or TaskTracker blanked out, to its length so
 * positions hold: a tracker's only stops it taking tasks, and a semaphore's only refuses more
 * permits, waking those waiting with an error; neither signals anything. Only a close with nothing
 * in its parentheses is one, and only on a binding that is surely one: a name the innermost
 * function around it binds once, as one (`bindingsOf`), or `self.<name>`, where the type the
 * function's impl is for is declared once in the file, with that field as one. Anything else, a
 * name bound twice or a field of another type, still counts.
 */
export function withoutHarmlessCloses(code: string): string {
  const { fns } = rustFunctions(code);
  const close = /(?<![\w.]\s*)(self\s*\.\s*)?(?:r#)?(\w+)\s*\.\s*close\s*\(\s*\)/g;
  return code.replace(close, (call, self: string | undefined, name: string, at: number) => {
    const f = fns
      .filter((g) => g.m.index < at && at < g.close)
      .toSorted((a, b) => b.m.index - a.m.index)[0];
    if (f === undefined) return call;
    let harmless: boolean;
    if (self === undefined) {
      const text = code.slice(f.m.index, f.close);
      const sites = [...bindingsOf(name, text, f.open - f.m.index, code).values()];
      harmless = sites.length === 1 && sites[0] === true;
    } else {
      const type = f.block?.type;
      const structs = [
        ...code.matchAll(new RegExp(`\\bstruct\\s+(?:r#)?${type ?? "\\b"}\\b`, "g")),
      ];
      const item = structs.length === 1 && type !== undefined ? structs[0] : undefined;
      const fields =
        item === undefined
          ? []
          : (structFields(code.slice(item.index, itemEnd(code, item.index)))?.fields ?? []).filter(
              (field) => field.name === name,
            );
      harmless = fields.length === 1 && harmlessType(fields[0]?.type ?? "", code);
    }
    return harmless ? call.replace(/[^\n]/g, " ") : call;
  });
}

/**
 * Closes the signal scan passes over, by the function they are in (`file::Type::fn`), each with
 * why it signals nothing. The scan matches methods by name, so without this a close that only
 * hangs up a connection reads as a holder's. Only a `close()` with nothing in its parentheses on a
 * path ending in `stream` is passed over, and only in the listed function: any other call there
 * still counts.
 */
const NON_SIGNALLING_CLOSES: Record<string, string> = {
  "crates/bazhen-daemon/src/stream/hub.rs::Shared::release":
    "closes a terminal stream, which hangs up its connections to the holder and never sends it " +
    "`close` (HolderStream::close); a holder ends only on `close`",
};

/**
 * `code` of `file` with the closes `listed` passes over blanked out, to their length. Each entry
 * found in `file` goes in `seen`: 1 if its function closed a stream, 0 if it closed none.
 */
function withoutListedCloses(
  file: string,
  code: string,
  listed: Record<string, string>,
  seen: Map<string, number>,
): string {
  let out = code;
  const { fns } = rustFunctions(code);
  for (const key of Object.keys(listed).filter((k) => k.startsWith(`${file}::`))) {
    const path = key.slice(file.length + 2).split("::");
    const fn = path.at(-1);
    const type = path.length > 1 ? path.at(-2) : undefined;
    const found = fns.find((f) => f.fn === fn && f.block?.type === type);
    if (found === undefined) continue;
    const body = out.slice(found.open, found.close);
    const closes = /(?<![\w.]\s*)(?:(?:r#)?\w+\s*\.\s*)*stream\s*\.\s*close\s*\(\s*\)/g;
    const blanked = body.replace(closes, (call) => call.replace(/[^\n]/g, " "));
    seen.set(key, blanked === body ? 0 : 1);
    out = out.slice(0, found.open) + blanked + out.slice(found.close);
  }
  return out;
}

/** Why an entry of `listed` is stale or has no reason, given what the scan saw of each. */
function listedCloseFailures(listed: Record<string, string>, seen: Map<string, number>): string[] {
  return Object.entries(listed).flatMap(([key, reason]) => {
    if (!seen.has(key)) {
      return [
        `scripts/check-standards.ts: ${key} is in NON_SIGNALLING_CLOSES, but no such function exists.`,
      ];
    }
    if (seen.get(key) === 0) {
      return [
        `scripts/check-standards.ts: ${key} is in NON_SIGNALLING_CLOSES, but closes no stream.`,
      ];
    }
    if (reason.trim() === "") {
      return [
        `scripts/check-standards.ts: ${key} is in NON_SIGNALLING_CLOSES with no reason it signals nothing.`,
      ];
    }
    return [];
  });
}

/**
 * Each Rust test that signals processes it didn't start but isn't ignored as doing so: every
 * test of a binary that runs the holder, and any whose own body closes a child or sweeps the
 * ledger. Such a test runs only on a disposable host (docs/standards/testing.md § Hermeticity).
 * A mention of `Session` counts only in the crates `holderCrates` names, by directory; with none
 * given, it counts in every crate.
 */
export function unmarkedSignallingTests(
  files: readonly string[],
  read: (file: string) => string,
  nonSignallingCloses: Record<string, string> = {},
  holderCrates?: ReadonlySet<string>,
): string[] {
  const rust = files.filter((f) => /^crates\/.+\.rs$/.test(f) && !f.includes("/fuzz/"));
  const holderBinaries = new Set(
    rust.flatMap((f) => (read(f).includes(HOLDER_BINARY) ? [testBinary(f) ?? ""] : [])),
  );
  holderBinaries.delete("");
  const seen = new Map<string, number>();
  const unmarked = rust.flatMap((file) => {
    const strings: string[] = [];
    const code = withoutListedCloses(
      file,
      withoutHarmlessCloses(rustCode(read(file), strings)),
      nonSignallingCloses,
      seen,
    );
    const wholeBinary = holderBinaries.has(testBinary(file) ?? "");
    const crate = /^crates\/[^/]+/.exec(file)?.[0] ?? "";
    const signalling =
      holderCrates === undefined || holderCrates.has(crate)
        ? SIGNALLING_OR_SESSION
        : SIGNALLING_CALL;
    // A helper in the same file that closes or sweeps makes each test calling it signal too, and
    // so does a const or static whose value names a session. A test's own helpers count however
    // many deep; product code one call deep, since methods are matched by name alone and a
    // generic one, as an ending's `step`, signals only through what it was given.
    // A bodyless function's "body" runs to the `}` closing its trait or extern block: empty.
    const bodyOf = (start: number) => code.slice(start, closingBrace(code, start));
    const product = testBinary(file) === undefined ? withoutTests(code) : "";
    const fns = [...code.matchAll(/\bfn\s+(\w+)/g)].map((m) => ({
      name: m[1] ?? "",
      body: bodyOf(fnBodyStart(code, m.index)),
      test: product[m.index] !== "f",
    }));
    const values = [...code.matchAll(/\b(?:const|static)\s+(\w+)\s*:([^;]*);/g)].flatMap((m) =>
      signalling.test(m[2] ?? "") ? [new RegExp(`\\b${m[1] ?? ""}\\b`)] : [],
    );
    const helpers = new Set<string>();
    const callsHelper = (body: string) =>
      values.some((value) => value.test(body)) ||
      [...helpers].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(body));
    for (const { name, body } of fns) if (signalling.test(body)) helpers.add(name);
    for (let grew = true; grew;) {
      grew = false;
      for (const { name, body, test } of fns) {
        if (test && !helpers.has(name) && callsHelper(body)) {
          helpers.add(name);
          grew = true;
        }
      }
    }
    // A type whose Drop closes or signals, one helper deep, makes each test naming it signal.
    const dropping = [...code.matchAll(/\bimpl\s+Drop\s+for\s+(\w+)[^{]*\{/g)].flatMap((m) => {
      const block = code.slice(m.index, closingBrace(code, m.index + m[0].length));
      return signalling.test(block) || callsHelper(block) ? [m[1] ?? ""] : [];
    });
    // A macro's test body can come from where it is invoked, so a file that closes or sweeps
    // anywhere makes each test its macros generate a signalling one.
    const fileSignals = signalling.test(code);
    const macros = [...code.matchAll(/\bmacro_rules\s*!\s*\w+\s*\{/g)].map((m) => ({
      from: m.index,
      to: closingBrace(code, m.index + m[0].length),
    }));
    const signals = (body: string, at: number) =>
      signalling.test(body) ||
      callsHelper(body) ||
      dropping.some((type) => new RegExp(`\\b${type}\\b`).test(body)) ||
      (fileSignals && macros.some((m) => at >= m.from && at < m.to));
    const out: string[] = [];
    for (const test of code.matchAll(/#\s*\[\s*test\s*\]/g)) {
      const bodyStart = fnBodyStart(code, test.index);
      const body = bodyOf(bodyStart);
      if (!wholeBinary && !signals(body, test.index)) continue;
      const before = code.slice(0, bodyStart);
      const itemStart =
        Math.max(before.lastIndexOf("}", test.index), before.lastIndexOf(";", test.index)) + 1;
      const marked = [...before.slice(itemStart).matchAll(/#\s*\[\s*ignore\s*=\s*""\s*\]/g)].some(
        (m) =>
          strings[(code.slice(0, itemStart + m.index).match(/""/g) ?? []).length] ===
          SIGNALS_IGNORE,
      );
      if (!marked) {
        out.push(
          `${file}:${code.slice(0, test.index).split("\n").length}: this test signals processes it ` +
            `didn't start (${wholeBinary ? "its binary runs the holder" : "it closes a child or sweeps the ledger"}), ` +
            `so it carries #[ignore = "${SIGNALS_IGNORE}"] and starts with ` +
            "`bazhen_test_signal::require_sandbox().unwrap();` (docs/standards/testing.md).",
        );
      }
    }
    return out;
  });
  return [...unmarked, ...listedCloseFailures(nonSignallingCloses, seen)];
}

/** The lines of Rust source that are test code: under `#[cfg(test)]`. */
function testLines(source: string): Set<number> {
  const all = rustCode(source).split("\n");
  const product = withoutTests(rustCode(source)).split("\n");
  return new Set(all.flatMap((line, i) => (line === product[i] ? [] : [i + 1])));
}

/** A dev-dependencies table, plain or a target's, or a crate's own table inside one. */
const devTable = (name: string) => /(?:^|\.)dev-dependencies(?:\.|$)/.test(name);

/** The chokepoints that are product code, whose test modules are checked like any test. */
const PRODUCT_CHOKEPOINTS = new Set([
  "crates/bazhen-holder/src/guard.rs",
  "crates/bazhen-host-guard/src/lib.rs",
  "crates/bazhen-holder/src/linux.rs",
]);

const TEST_SIGNAL_MANIFEST = "crates/bazhen-test-signal/Cargo.toml";

/**
 * A Rust chokepoint outside the tests' own crate that PRODUCT_CHOKEPOINTS doesn't list, and an
 * entry there that is no chokepoint. Unlisted, a chokepoint is exempt whole, so a test in its
 * `#[cfg(test)]` module could send a raw signal without bazhen_test_signal's checks.
 */
export function productChokepointFailures(
  chokepoints: readonly string[],
  product: ReadonlySet<string>,
): string[] {
  const unlisted = chokepoints.filter(
    (f) => f.endsWith(".rs") && !f.startsWith("crates/bazhen-test-signal/") && !product.has(f),
  );
  return [
    ...unlisted.map(
      (f) =>
        `scripts/check-standards.ts: ${f} is a Rust chokepoint; list it in PRODUCT_CHOKEPOINTS, ` +
        "so its tests send through bazhen_test_signal like any others.",
    ),
    ...[...product]
      .filter((f) => !chokepoints.includes(f))
      .map(
        (f) =>
          `scripts/check-standards.ts: PRODUCT_CHOKEPOINTS lists ${f}, which is no chokepoint.`,
      ),
  ];
}

/**
 * Where a member's manifest takes bazhen-test-signal for anything but its tests. It sends
 * signals to whatever a test names, with checks fit for a test, so no product may link it.
 */
export function testSignalDependencyFailures(manifest: string, text: string): string[] {
  let table = "";
  return text.split("\n").flatMap((line, i) => {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header !== null) table = (header[1] ?? "").trim().replaceAll(/["']/g, "");
    if (!/\bbazhen-test-signal\b/.test(line) || devTable(table)) return [];
    return [
      `${manifest}:${i + 1}: takes bazhen-test-signal under [${table}]; only [dev-dependencies] ` +
        "may, as it signals whatever a test names (docs/standards/testing.md).",
    ];
  });
}

/**
 * A raw signal call anywhere but a chokepoint (scripts/signal-paths.ts), each by file and line,
 * and a chokepoint that no longer exists. A pid there unchecked can end every process the user
 * owns, so each signal goes through code that checks its target.
 */
export function signalChokepointFailures(
  files: readonly string[],
  read: (file: string) => string,
): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (file.includes("node_modules/")) continue;
    // A product chokepoint is exempt in its product code alone: its tests send through the
    // tests' own chokepoint like any others.
    const product = PRODUCT_CHOKEPOINTS.has(file);
    if (Object.hasOwn(SIGNAL_CHOKEPOINTS, file) && !product) continue;
    const text = read(file);
    const tests = file.endsWith(".rs") ? testLines(text) : new Set<number>();
    out.push(...allowedSignalFailures(file, text));
    const calls = rawSignalCalls(file, text);
    for (const { line, call, unread, unfollowed, held } of calls) {
      if (product && !tests.has(line)) {
        if (held !== undefined) {
          out.push(
            `${file}:${line}: ${held === "imported" ? "imports a raw signal" : "takes a raw signal as a value"} ` +
              `(${call}); a chokepoint calls each by its path where it names it, as a name it ` +
              "imports or holds reaches the file's tests (docs/standards/rust.md § Signals).",
          );
        }
        continue;
      }
      if (unfollowed === true) {
        out.push(
          `${file}:${line}: ${call}, so the check can't read the options a start there is given, ` +
            "which may set a timeout, killSignal or signal that Node enforces with a kill; call " +
            "each start by the name it's imported as, or as a member of child_process imported " +
            "with `import … from`, with its options in the call (docs/standards/testing.md).",
        );
        continue;
      }
      if (unread === true) {
        out.push(
          `${file}:${line}: ${call}, so the check can't tell whether they set a timeout, ` +
            "killSignal or signal, which Node enforces with a kill; write the args as an array " +
            "and the options as an object literal in the call, `[...args]` and `{}` included " +
            "(docs/standards/testing.md).",
        );
        continue;
      }
      out.push(
        `${file}:${line}: sends a signal directly (${call}); send it through ` +
          `${chokepointFor(file, tests.has(line))}, which checks its target ` +
          "(docs/standards/testing.md).",
      );
    }
    if (product) {
      const reaches = chokepointReaches(text).filter(
        (r) => tests.has(r.line) && !calls.some((c) => c.line === r.line),
      );
      for (const { line, call } of reaches) {
        out.push(
          `${file}:${line}: a test in a chokepoint reaches its product code's imports through ` +
            `${call}, which the scan doesn't read; name what it takes, and send through ` +
            "bazhen_test_signal (docs/standards/rust.md § Signals).",
        );
      }
    }
    if (/^crates\/[^/]+\/Cargo\.toml$/.test(file) && file !== TEST_SIGNAL_MANIFEST) {
      out.push(...testSignalDependencyFailures(file, text));
    }
  }
  for (const chokepoint of Object.keys(SIGNAL_CHOKEPOINTS)) {
    if (!files.includes(chokepoint)) {
      out.push(`scripts/signal-paths.ts: SIGNAL_CHOKEPOINTS lists missing ${chokepoint}.`);
    }
  }
  return out;
}

/**
 * A listed file that no longer exists: an ALLOWED_SIGNALS one's entries would allow a copy put
 * there, and an ENDS_WITHOUT_A_CALL one, moved, would leave its new path unprotected.
 */
export function allowedSignalFileFailures(files: readonly string[]): string[] {
  const lists = { ALLOWED_SIGNALS, ENDS_WITHOUT_A_CALL };
  return Object.entries(lists).flatMap(([name, list]) =>
    Object.keys(list)
      .filter((file) => !files.includes(file))
      .map((file) => `scripts/signal-paths.ts: ${name} lists missing ${file}.`),
  );
}

const readRepoFile = (p: string) => readFileSync(join(root, p), "utf8");

function checkSignalChokepoints(): void {
  failures.push(...signalChokepointFailures(repoFiles(), readRepoFile));
  failures.push(...allowedSignalFileFailures(repoFiles()));
  failures.push(...productChokepointFailures(Object.keys(SIGNAL_CHOKEPOINTS), PRODUCT_CHOKEPOINTS));
  // With no report from Cargo, every crate is taken to reach the holder.
  const metadata = cargoMetadata();
  const holderCrates = typeof metadata === "string" ? undefined : holderReachingCrates(metadata);
  failures.push(
    ...unmarkedSignallingTests(repoFiles(), readRepoFile, NON_SIGNALLING_CLOSES, holderCrates),
  );
  failures.push(...cargoManifestFailures(repoFiles(), readRepoFile));
}

function checkMoon(): void {
  failures.push(...moonFailures(repoFiles(), readRepoFile));
}

// An api test runs on holders, the default runtime, unless it is about tmux: those cases live in a
// *.tmux.test.ts sibling, so a runtime-neutral case can't drift back onto tmux unseen.
const API_TESTS = "tests/api/";
const HOLDER = /^(["'`])holder\1$/;

/** The top-level arguments of every call to `name` in `source`, each trimmed. */
function callArguments(source: string, name: string): string[][] {
  const calls: string[][] = [];
  for (const match of source.matchAll(new RegExp(`(?<![\\w$])${name}\\s*\\(`, "g"))) {
    const args: string[] = [];
    let depth = 0;
    let quote = "";
    let arg = "";
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const c = source[i] ?? "";
      if (quote !== "") {
        arg += c;
        if (c === "\\") arg += source[++i] ?? "";
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      if ("([{".includes(c)) depth++;
      if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      }
      if (c === "," && depth === 0) {
        args.push(arg.trim());
        arg = "";
      } else arg += c;
    }
    if (arg.trim() !== "") args.push(arg.trim());
    calls.push(args);
  }
  return calls;
}

/** Why an api test that isn't a *.tmux.test.ts would put its terminals on anything but holders. */
export function tmuxPinFailures(path: string, source: string): string[] {
  if (!path.startsWith(API_TESTS) || !path.endsWith(".test.ts") || path.endsWith(".tmux.test.ts"))
    return [];
  const code = stripComments(source);
  const chosen = [
    ...[...code.matchAll(/(?<![\w$.])runtime\s*:\s*([^,}\n]+)/g)].map((m) => m[1] ?? ""),
    ...[...code.matchAll(/[{,]\s*runtime\s*(?=[,}])/g)].map(() => "runtime"),
    ...callArguments(code, "useRuntime").map((args) => args[0] ?? ""),
    ...callArguments(code, "startWithCli").flatMap((args) => args.slice(2, 3)),
  ].map((value) => value.trim());
  const out = chosen
    .filter((value) => !HOLDER.test(value))
    .map(
      (value) =>
        `${path}: picks its runtime with ${value}. An api test runs on holders, the default; a ` +
        "case about tmux goes in a *.tmux.test.ts sibling (docs/standards/testing.md).",
    );
  if (/\[runtime\]|runtime\.default/.test(code))
    out.push(
      `${path}: sets runtime.default in its config. An api test runs on holders, the default; a ` +
        "case about tmux goes in a *.tmux.test.ts sibling (docs/standards/testing.md).",
    );
  return out;
}

function checkTmuxPins(): void {
  for (const path of repoFiles().filter((p) => p.startsWith(API_TESTS))) {
    failures.push(...tmuxPinFailures(path, readFileSync(join(root, path), "utf8")));
  }
}

// Skills live once in .agents/skills (Codex, pi, opencode); .claude/skills links to it.
const SKILLS_DIR = ".agents/skills";
const DESCRIPTION_MAX = 1024;

function skillDocs(): string[] {
  if (!existsSync(join(root, SKILLS_DIR))) return [];
  return readdirSync(join(root, SKILLS_DIR))
    .filter((name) => statSync(join(root, SKILLS_DIR, name)).isDirectory())
    .map((name) => `${SKILLS_DIR}/${name}/SKILL.md`);
}

function checkSkills(named: ReturnType<typeof menu>): void {
  let link = "";
  try {
    link = readlinkSync(join(root, ".claude/skills"));
  } catch {
    // Missing or not a link.
  }
  if (link !== "../.agents/skills") {
    failures.push(
      ".claude/skills must be a symlink to ../.agents/skills (one source for every harness).",
    );
  }
  for (const doc of skillDocs()) {
    const dir = doc.split("/")[2] ?? "";
    if (!existsSync(join(root, doc))) {
      failures.push(`${SKILLS_DIR}/${dir} has no SKILL.md.`);
      continue;
    }
    failures.push(...skillFailures(doc, dir, readFileSync(join(root, doc), "utf8")));
    checkContextFile(doc, named);
  }
}

const PLAIN_SCALAR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

/**
 * Reads skill frontmatter as one-line `key: value` entries, each value plain, "double-quoted" or
 * 'single-quoted', and reports anything outside that subset. Strict YAML parsers reject some text
 * that lenient ones accept (a plain value holding ": "), and a harness that uses a strict one
 * silently skips the skill, so the check allows only YAML that every parser reads the same way.
 */
function frontmatter(front: string): {
  values: Map<string, string>;
  invalid: Set<string>;
  problems: string[];
} {
  const values = new Map<string, string>();
  const invalid = new Set<string>();
  const problems: string[] = [];
  for (const line of front.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const entry = /^([\w-]+):(?: +(.*))?$/.exec(line);
    if (!entry) {
      problems.push(
        `"${line}" is not a one-line key: value entry; put each value on its key's line`,
      );
      continue;
    }
    const [, key = "", raw = ""] = entry;
    const value = scalar(raw.trimEnd());
    if (typeof value === "string") {
      if (values.has(key)) problems.push(`${key} appears twice`);
      values.set(key, value);
    } else {
      invalid.add(key);
      problems.push(`${key} ${value.problem}`);
    }
  }
  return { values, invalid, problems };
}

function scalar(raw: string): string | { problem: string } {
  if (raw === "") return { problem: "has no value on its line" };
  if (raw.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
      return { problem: "has a double-quoted value with text after its closing quote" };
    }
    const unparsed = {
      problem: 'has an escape or control character in its "..." value that JSON lacks',
    };
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : unparsed;
    } catch {
      return unparsed;
    }
  }
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) {
      return { problem: "has a single-quoted value with an unpaired ' inside; write it as ''" };
    }
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  const quote = 'wrap the value in "double quotes"';
  if (PLAIN_SCALAR_START.test(raw)) {
    return { problem: `starts with "${raw[0]}", which YAML reads as syntax; ${quote}` };
  }
  if (/:\s/.test(raw)) {
    return { problem: `holds ": ", which strict YAML parsers reject; ${quote} or reword it` };
  }
  if (raw.endsWith(":")) {
    return { problem: `ends in ":", which strict YAML parsers reject; ${quote} or reword it` };
  }
  if (/\s#/.test(raw)) {
    return { problem: `holds " #", which YAML reads as a comment; ${quote} or reword it` };
  }
  return raw;
}

export function skillFailures(doc: string, dir: string, text: string): string[] {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  const { values, invalid, problems } = frontmatter(front);
  const out = problems.map((problem) => `${doc}: frontmatter ${problem}.`);
  const name = values.get("name");
  const description = values.get("description") ?? "";
  if (!invalid.has("name") && (name !== dir || !dir.startsWith("bz-"))) {
    out.push(`${doc}: name must equal its directory and start with "bz-" (got "${name}").`);
  }
  if (invalid.has("description")) return out;
  if (description.length === 0 || description.length > DESCRIPTION_MAX) {
    out.push(`${doc}: description must be 1-${DESCRIPTION_MAX} characters.`);
  }
  if (!description.includes("changing Bazhen's source in this repository")) {
    out.push(
      `${doc}: description must say it applies "when changing Bazhen's source in this ` +
        "repository\", so it doesn't compete with the product's bazhen-* skills.",
    );
  }
  return out;
}

// A database runs each migration it hasn't recorded by name, so the names are the contract: a
// migration changed after it shipped forks the schema of every database that ran it from new ones.
const MIGRATIONS_FILE = "apps/daemon/src/store/migrations.ts";
const MIGRATIONS_DIR = "apps/daemon/src/store/migrations";
/** Upgrades a database through every migration, from every version the numbering runner left. */
const MIGRATIONS_TEST = "apps/daemon/src/store/store.medium.test.ts";
const MIGRATION_NAME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/;

/** What is wrong with the migrations' names in `MIGRATIONS`, given the files in their directory. */
export function migrationListFailures(
  names: readonly string[],
  files: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) out.push(`${MIGRATIONS_FILE}: lists ${name} twice.`);
    seen.add(name);
    if (!MIGRATION_NAME.test(name)) {
      out.push(`${MIGRATIONS_FILE}: ${name} isn't named YYYY-MM-DD-slug, the day it was written.`);
    }
    if (!files.includes(`${name}.ts`)) {
      out.push(`${MIGRATIONS_FILE}: ${name} is named for no file ${MIGRATIONS_DIR}/${name}.ts.`);
    }
  }
  for (const file of files) {
    if (!seen.has(file.replace(/\.ts$/, ""))) {
      out.push(`${MIGRATIONS_DIR}/${file}: no migration in MIGRATIONS is named for it.`);
    }
  }
  return out;
}

// After types are stripped: `import … from`, `export … from`, `import "…"`, and any import at run
// time. A migration's file imports nothing that runs.
const RUNTIME_IMPORT =
  /\b(?:import|export)\s[^;'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(import\s*\(|require\s*\()/g;

/**
 * Why a migration file's imports could change what it does after it shipped: it may import types
 * and nothing else, so all it does is in its file. Types are what Node's own stripping erases, so
 * `import type from "x"`, a value named `type`, still counts.
 */
export function migrationImportFailures(file: string, source: string): string[] {
  return [...stripTypeScriptTypes(source).matchAll(RUNTIME_IMPORT)].map(
    ([, from, bare, dynamic]) => {
      const what = dynamic === undefined ? `imports ${from ?? bare}` : "imports at run time";
      return `${file}: ${what}; a migration imports only types.`;
    },
  );
}

/**
 * Why a migration file exports more than its migration: anything else it exports, a mutable value
 * above all, is something code elsewhere could reach into it through.
 */
export function migrationExportFailures(file: string, source: string): string[] {
  return [...stripTypeScriptTypes(source).matchAll(/\bexport\s+(?!default\b)(\S+)/g)].map(
    ([, what]) => `${file}: exports ${what} as well; a migration file exports only its default.`,
  );
}

/** Which migrations' exports aren't frozen, so code elsewhere could change one in place. */
export function migrationFrozenFailures(exported: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(exported).flatMap(([name, value]) =>
    Object.isFrozen(value)
      ? []
      : [`${MIGRATIONS_DIR}/${name}.ts: export it frozen, with Object.freeze, so it can't change.`],
  );
}

/** The names `NUMBERED_MIGRATIONS` lists in `MIGRATIONS_FILE`'s text, or none where it has none. */
export function listedNumbered(source: string): string[] {
  const text = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const list = /NUMBERED_MIGRATIONS[^=]*= \[([^\]]*)\]/.exec(text)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].flatMap(([, name]) => (name === undefined ? [] : [name]));
}

/**
 * Whether `NUMBERED_MIGRATIONS` changed from the base's. A base before named migrations has none
 * to keep; a base with migration files whose list reads empty was misread, and fails.
 */
export function numberedHistoryFailures(
  before: readonly string[],
  now: readonly string[],
  baseHasFiles: boolean,
): string[] {
  if (before.length === 0 && !baseHasFiles) return [];
  if (before.join() === now.join()) return [];
  return [
    before.length === 0
      ? `${MIGRATIONS_FILE}: read no NUMBERED_MIGRATIONS from main's list, which has migration ` +
        "files; this check can't hold the numbered names to an unreadable list."
      : `${MIGRATIONS_FILE}: NUMBERED_MIGRATIONS changed from main's; databases the numbering ` +
        "runner left are converted by it, so it never changes.",
  ];
}

/** `git diff --name-status` output, as each change's status and the path it ends at. */
export function parseNameStatus(text: string): { status: string; path: string }[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", path = "", renamed] = line.split("\t");
      return { status, path: renamed ?? path };
    });
}

/** The commit to hold the migrations against, as `find` gives it, or why there is none. */
export function migrationBase(find: () => string): { base: string } | { failure: string } {
  try {
    return { base: find() };
  } catch (err) {
    return {
      failure:
        `${MIGRATIONS_DIR}: no merge base with main to check shipped migrations against ` +
        `(a shallow clone needs fetch-depth: 0): ${String(err)}`,
    };
  }
}

/** Whether the base's list was read whole: one name for each migration file the base has. */
export function baseListFailures(before: readonly string[], files: number): string[] {
  return before.length === files
    ? []
    : [
        `${MIGRATIONS_FILE}: read ${before.length} migrations from main's list, which has ` +
          `${files} files; this check can't hold main's migrations to an unreadable list.`,
      ];
}

/**
 * Which entries of `MIGRATIONS` aren't their file's own default export, as a spread or a copy with
 * its SQL or `run` changed would be: the file would be unchanged, the migration not.
 */
export function migrationIdentityFailures(
  listed: readonly { readonly name: string }[],
  exported: Readonly<Record<string, unknown>>,
): string[] {
  return listed.flatMap((m) =>
    exported[m.name] === m
      ? []
      : [`${MIGRATIONS_FILE}: lists ${m.name} as something other than its file's default export.`],
  );
}

/** Whether `MIGRATIONS` starts with the numbered migrations, in their order. */
export function numberedFailures(names: readonly string[], numbered: readonly string[]): string[] {
  return names.slice(0, numbered.length).join() === numbered.join()
    ? []
    : [
        `${MIGRATIONS_FILE}: MIGRATIONS doesn't start with NUMBERED_MIGRATIONS in order, so a ` +
          "database from the runner that numbered them would record the wrong ones as run.",
      ];
}

/** The migrations `MIGRATIONS_FILE`'s text lists, in order, by the files it imports them from. */
export function listedMigrations(text: string): string[] {
  const source = text.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const files = new Map<string, string>();
  for (const [, id, name] of source.matchAll(
    /^import (\w+) from "\.\/migrations\/([^"]+)\.ts";$/gm,
  )) {
    if (id !== undefined && name !== undefined) files.set(id, name);
  }
  const list = /export const MIGRATIONS[^=]*= \[([^\]]*)\]/.exec(source)?.[1] ?? "";
  return [...list.matchAll(/(\w+),/g)].flatMap(([, id]) => {
    const name = id === undefined ? undefined : files.get(id);
    return name === undefined ? [] : [name];
  });
}

/**
 * Whether the branch changed a migration that was on the base: `changed` is `git diff
 * --name-status` from the merge base over the migrations' directory, and `before` and `now` the
 * names `MIGRATIONS` lists there and here. A migration is only ever added, after the ones before.
 */
export function migrationHistoryFailures(
  changed: readonly { status: string; path: string }[],
  before: readonly string[],
  now: readonly string[],
): string[] {
  const out = changed
    .filter(({ status }) => status !== "A")
    .map(
      ({ status, path }) =>
        `${path}: ${status.startsWith("R") ? "renamed" : status === "D" ? "removed" : "edited"} ` +
        "after it was on main. A shipped migration has run on users' databases: add a new one.",
    );
  const gone = before.filter((name) => !now.includes(name));
  if (gone.length > 0) out.push(`${MIGRATIONS_FILE}: no longer lists ${gone.join(", ")}.`);
  else if (now.slice(0, before.length).join() !== before.join()) {
    out.push(
      `${MIGRATIONS_FILE}: changes the order of the migrations that were on main; ` +
        "add new ones after them.",
    );
  }
  return out;
}

/** Each migration file's default export, by its name. */
const MIGRATION_EXPORTS: Record<string, unknown> = Object.fromEntries(
  await Promise.all(
    readdirSync(join(root, MIGRATIONS_DIR))
      .filter((file) => file.endsWith(".ts"))
      .map(async (file) => {
        const module: unknown = await import(pathToFileURL(join(root, MIGRATIONS_DIR, file)).href);
        return [file.replace(/\.ts$/, ""), Reflect.get(Object(module), "default")] as const;
      }),
  ),
);

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export function checkMigrations(): void {
  const files = readdirSync(join(root, MIGRATIONS_DIR)).filter((f) => f.endsWith(".ts"));
  const names = MIGRATIONS.map((m) => m.name);
  failures.push(...migrationListFailures(names, files));
  failures.push(...numberedFailures(names, NUMBERED_MIGRATIONS));
  failures.push(...migrationIdentityFailures(MIGRATIONS, MIGRATION_EXPORTS));
  for (const file of files) {
    const path = `${MIGRATIONS_DIR}/${file}`;
    const source = readFileSync(join(root, path), "utf8");
    failures.push(
      ...migrationImportFailures(path, source),
      ...migrationExportFailures(path, source),
    );
  }
  failures.push(...migrationFrozenFailures(MIGRATION_EXPORTS));
  const found = migrationBase(mergeBase);
  if ("failure" in found) {
    failures.push(found.failure);
    return;
  }
  const { base } = found;
  const changed = parseNameStatus(git("diff", "--name-status", base, "--", MIGRATIONS_DIR));
  const listing = git("show", `${base}:${MIGRATIONS_FILE}`);
  const before = listedMigrations(listing);
  const shipped = git("ls-tree", "--name-only", base, `${MIGRATIONS_DIR}/`)
    .split("\n")
    .filter((path) => path.endsWith(".ts"));
  failures.push(...baseListFailures(before, shipped.length));
  failures.push(
    ...numberedHistoryFailures(listedNumbered(listing), NUMBERED_MIGRATIONS, shipped.length > 0),
  );
  failures.push(...migrationHistoryFailures(changed, before, names));
}

const SUPPRESSION_FILES = /\.(?:[cm]?[jt]sx?|html)$/;

/**
 * What a directive looks like at the start of a comment's line. The tools differ in what they
 * obey: tsc reads `@ts-ignore` and `@ts-expect-error` on a block comment's last line and
 * `@ts-nocheck` only in a line comment, in any case; oxlint and oxfmt read the start of a comment,
 * in the case they spell. One pattern matches all of it, case-insensitive and on every line, as
 * a deliberate over-match.
 */
const DIRECTIVE =
  /^(@ts-(?:ignore|expect-error|nocheck)|(?:oxlint|eslint)-(?:disable|enable)[\w-]*|biome-ignore[\w-]*|oxfmt-ignore|prettier-ignore)/i;

const LINE_END = /\r\n?|[\n\u2028\u2029]/;
const NOT_LINE_END = "[^\\n\\r\\u2028\\u2029]*";

/**
 * Every place a comment may start, each read to its end, even one a string's slashes hide: a
 * line or block comment, an HTML comment, and a `-->`, which a script reads as a line comment
 * wherever only whitespace and comments come before it on the line.
 */
const COMMENT = new RegExp(
  "(?=(//" +
    NOT_LINE_END +
    "|/\\*[\\s\\S]*?(?:\\*/|$)|<!--[\\s\\S]*?(?:-->|$)" +
    "|-->" +
    NOT_LINE_END +
    "))",
  "g",
);

const linesIn = (text: string) => text.split(LINE_END);

/**
 * Every comment that switches a check off for the code beside it. A failing check is fixed in the
 * code, so no directive is allowed, in source, tests or a page's inline script.
 *
 * It looks for comments without parsing, so no comment can hide a directive from it, and the
 * price is that a string holding a comment's opener followed by a directive fails too: split the
 * string. Files git ignores, generated output among them, aren't scanned.
 */
export function suppressionFailures(path: string, source: string): string[] {
  const found = new Map<number, string>();
  let line = 1;
  let seen = 0;
  for (const match of source.matchAll(COMMENT)) {
    line += linesIn(source.slice(seen, match.index)).length - 1;
    seen = match.index;
    for (const [i, text] of linesIn(match[1] ?? "").entries()) {
      const directive = DIRECTIVE.exec(text.replace(/^(?:<!--|[\s/*>-])+/, ""))?.[1];
      if (directive !== undefined) found.set(line + i, directive);
    }
  }
  return [...found].map(
    ([at, directive]) =>
      `${path}:${at}: \`${directive}\` switches a check off. Fix the code the check ` +
      "reports; if the check is wrong, change the check and say why in the commit.",
  );
}

function checkSuppressions(): void {
  for (const file of repoFiles().filter((f) => SUPPRESSION_FILES.test(f))) {
    failures.push(...suppressionFailures(file, readFileSync(join(root, file), "utf8")));
  }
}

/** Every check `moon run :check` runs, in order. */
export const STANDARDS_CHECKS: readonly (() => void)[] = [
  checkSiblingTests,
  checkAgentContext,
  () => checkSkills(menu()),
  checkWebTokens,
  checkRust,
  checkMoon,
  checkTmuxPins,
  checkSignalChokepoints,
  checkMigrations,
  checkSuppressions,
];

if (isMain(import.meta)) {
  for (const check of STANDARDS_CHECKS) check();

  if (failures.length > 0) {
    console.error(`Standards check failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
}
