// Repository standards that no linter covers (docs/standards/code.md, testing.md). Runs first in
// `pnpm check`; every failure names the file and the fix.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MIGRATIONS, NUMBERED_MIGRATIONS } from "../apps/daemon/src/store/migrations.ts";
import { cssDeclarations } from "../apps/web/src/ui/token-sheet.ts";
import { gateEnv } from "./cargo-gate.ts";
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
import { isIdent, itemEnd, newlinesIn, rustCode } from "./rust-source.ts";
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
  "apps/daemon/src/auth/agent-token.ts": "apps/daemon/src/socket/client.medium.test.ts",
  "apps/daemon/src/testing/fixtures.ts": "apps/daemon/src/mailbox/mailbox.medium.test.ts",
  "apps/daemon/src/testing/browser-terminal.ts": "apps/daemon/src/stream/snapshot-contract.test.ts",
  "apps/daemon/src/stream/screen-source.ts": "apps/daemon/src/stream/hub.test.ts",
  "apps/daemon/src/testing/fake-app-server.ts": "apps/daemon/src/codex/app-server.medium.test.ts",
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
  "apps/web/src/terminal/takeover.ts": "tests/e2e/keys.spec.ts",
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

const scriptNames = () =>
  new Set(Object.keys(packageScripts((p) => readFileSync(join(root, p), "utf8"))));

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

function checkContextFile(doc: string, scripts: Set<string>): void {
  const text = readFileSync(join(root, doc), "utf8");
  const named = new Set(codeSpans(text).flatMap(pnpmScripts));
  for (const script of named) {
    if (!PNPM_BUILTINS.has(script) && !scripts.has(script)) {
      failures.push(`${doc}: names \`pnpm ${script}\`, which is not a package.json script.`);
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
  const scripts = scriptNames();
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
    if (existsSync(join(root, doc))) checkContextFile(doc, scripts);
    else failures.push(`${doc} is missing.`);
  }
}

// The modules that may hold `unsafe` code, each with why it must (docs/standards/rust.md § Unsafe).
// Each may set `#![expect(unsafe_code, reason = "...")]`, and nothing else in crates/ may.
const UNSAFE_MODULES: Record<string, string> = {
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
    "which rustix doesn't cover",
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
    "bazhen-holder's sandbox-tripwire is on in every test build, by its dev-dependency on " +
    "itself, which the workspace's clippy and nextest build; and off in the holder as it ships, " +
    "which lint checks too (SHIPPED_LINT in scripts/cargo-gate.ts). CFG_VALUES holds it to that one",
  target_os:
    "`check` builds Linux and `rust-macos` builds macOS, each running clippy and nextest; " +
    "CFG_VALUES holds it to those two",
};

// The values a CFG_ALLOWED key that takes one may be given: only those a gate builds.
const CFG_VALUES: Record<string, readonly string[]> = {
  target_os: ["linux", "macos"],
  feature: ["sandbox-tripwire"],
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
      // by `cargo-gate test-all` (scripts/signal-paths.ts). It refuses to run anywhere else
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
  "crates/bazhen-hook/src/lib.rs::parse_reply": "parse_reply",
  "crates/bazhen-hook/src/lib.rs::is_late": "parse_reply",
  "crates/bazhen/src/reply.rs::decode": "reply",
  "crates/bazhen/src/attach/attachment.rs::Attachment::keys": "attach",
  "crates/bazhen/src/attach/attachment.rs::Attachment::frame": "attach",
  "crates/bazhen/src/attach/attachment.rs::DetachKeys::scan": "attach",
  "crates/bazhen/src/attach/direct.rs::Direct::keys": "attach",
  "crates/bazhen-protocol/src/wire.rs::well_formed": "wire",
  "crates/bazhen-protocol/src/wire.rs::from_slice": "wire",
  "crates/bazhen-protocol/src/input.rs::has_keystrokes": "input",
  "crates/bazhen-hook/src/pane_title.rs::body": "pane_title",
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
  "crates/bazhen-holder/src/start_time.rs::parent_field": "proc_stat",
  "crates/bazhen-holder/src/start_time.rs::session_field": "proc_stat",
  "crates/bazhen-holder/src/start_time.rs::has_exited": "proc_stat",
  "crates/bazhen-holder/src/session.rs::member_state": "proc_stat",
  "crates/bazhen-holder/src/process.rs::status_uid": "proc_args",
  "crates/bazhen-holder/src/process.rs::cmdline_args": "proc_args",
  "crates/bazhen-holder/src/process.rs::procargs2_args": "proc_args",
  "crates/bazhen-holder/src/process.rs::procargs2_env": "proc_args",
};
const NOT_DECODERS: Record<string, string> = {
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
  "crates/bazhen-protocol/src/input.rs::without_replies":
    "a step of has_keystrokes, which the input target fuzzes",
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
  "crates/bazhen/src/sha256.rs::sha256":
    "a hash of the run directory's path, which the CLI made itself; it reads its input as data only",
  "crates/bazhen/src/sha256.rs::compress": "reached only through sha256, of a path the CLI made",
  "crates/bazhen/src/sha256.rs::hex": "an encoder: it writes bytes as hex",
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
  "crates/bazhen/src/attach/direct.rs::open":
    "reads the holder's socket into FrameDecoder::push, which the proto crate's frame target fuzzes",
  "crates/bazhen/src/fmt.rs::uuid":
    "reads 16 random bytes from /dev/urandom and formats them; parses nothing",
  "crates/bazhen/src/tasks.rs::read_file":
    "reads stdin or read_regular's bytes as lossy UTF-8 text, parsing none of them",
  "crates/bazhen-holder/src/guard.rs::parent":
    "reads /proc/<pid>/stat for parent_field, which proc_stat fuzzes",
  "crates/bazhen-holder/src/process.rs::parent":
    "reads /proc/<pid>/stat for has_exited and parent_field, which proc_stat fuzzes",
  "crates/bazhen-holder/src/session.rs::supported":
    "reads /proc/self/stat for own_pid, which proc_stat fuzzes",
};

// A carrier's bytes are found by the methods of its own crate that use the field holding them, so
// a field another crate can read is listed here with why its bytes aren't from outside.
const PUBLIC_BYTE_FIELDS: Record<string, string> = {
  "crates/bazhen-holder-proto/src/body.rs::ThemeColours::text":
    "a built-in theme's RGB, which Theme::colours makes in-process",
  "crates/bazhen-holder-proto/src/body.rs::ThemeColours::background":
    "a built-in theme's RGB, which Theme::colours makes in-process",
};

// An impl block, whose associated types its trait requires, so they aren't aliases. (A trait's
// own associated types take no `= …` on stable, so the alias pattern never matches them.)
const IMPL_BLOCK = /(?<=^|[;{}])\s*(?:(?:pub(?:\([^)]*\))?|unsafe)\s+)*impl\b[^{;]*(?=\{)/gm;

// Types a function takes that carry bytes from outside the process: anything holding u8s, a
// reader of any kind, a handle that can only be read (stdin, a child's output), or a WebSocket,
// whose `read()` takes nothing to read into, so BODY_READS can't see it. A socket, a file or an fd
// isn't one, since holding it isn't reading it: a function that reads one does so in its body,
// which BODY_READS reads.
const BYTES_IN =
  /\[(?:(?:core|std)::primitive::)?u8\b|\b(?:Vec|VecDeque)<(?:(?:core|std)::primitive::)?u8>|\*\s*(?:const|mut)\s+u8\b|\bItem\s*=\s*u8\b|\b(?:(?:Async)?(?:Buf)?Read(?:er)?|Buf|Bytes|BytesMut|Stdin\w*|Child(?:Stdout|Stderr)|WebSocket)\b/;

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
  carrier(named: Named, at: number): { fields: Fields } | null;
  /** The byte-carrying variants of the enum `named`, at `at`, names, each with its byte fields. */
  variants(named: Named, at: number): Map<string, Fields> | undefined;
  /** The name of each enum with a byte-carrying variant. */
  enums: Set<string>;
}

const NO_CARRIERS: Scope = {
  names: () => false,
  carrier: () => null,
  variants: () => undefined,
  enums: new Set(),
};

/** The workspace's carriers, and by name, for a name that can't be resolved to its type. */
interface Carriers {
  fields: Map<Item, Fields>;
  variants: Map<Item, Map<string, Fields>>;
  byName: Map<string, Fields>;
  variantsByName: Map<string, Map<string, Fields>>;
}

/** What the decoder rule reads an item's bytes from: an enum's head and its fields' types. */
function itemTypes(item: Item): string {
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
 * so what resolution can't settle counts as it would by name alone.
 */
function carriersOf(table: ModuleTable): Carriers {
  const types = table.items.filter((i) => i.kind !== "trait");
  const named = new Map(
    types.map((item) => [
      item,
      typePaths(itemTypes(item)).map((n) => resolveNamed(table, item.module, n)),
    ]),
  );
  const found = new Set(
    types.filter((i) =>
      BYTES_IN.test(i.kind === "struct" || i.kind === "union" ? i.text : itemTypes(i)),
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
  for (const item of found) {
    const struct = item.kind === "struct" ? structFields(item.text) : undefined;
    fields.set(
      item,
      struct === undefined || holds(struct.head, item.module)
        ? undefined
        : new Set(struct.fields.filter((f) => holds(f.type, item.module)).map((f) => f.name)),
    );
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
  return { fields, variants, byName, variantsByName };
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

/** What the names in `file` mean, each resolved from the module it is written in. */
function fileScope(table: ModuleTable, carriers: Carriers, file: string): Scope {
  const resolutions = (named: Named, at: number) => {
    const modules = table.modulesAt(file, at);
    return modules.length === 0
      ? [{ items: [], modules: [], unresolved: new Set([named.name]) }]
      : modules.map((m) => resolveNamed(table, m, named));
  };
  const carrier = (named: Named, at: number) => {
    let out: { fields: Fields } | null = null;
    const add = (f: Fields) => {
      out = out === null ? { fields: f } : { fields: unionFields(out.fields, f) };
    };
    for (const r of resolutions(named, at)) {
      for (const item of r.items) if (carriers.fields.has(item)) add(carriers.fields.get(item));
      for (const name of r.unresolved)
        if (carriers.byName.has(name)) add(carriers.byName.get(name));
    }
    return out;
  };
  return {
    names: (text, at) => typePaths(text).some((n) => carrier(n, at) !== null),
    carrier,
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
 * (`undefined`: in any use of `self`). It does by one of those fields, by `self` itself handed on
 * or matched, or by calling a method of its own that does (`calls`) or one it doesn't know.
 */
function reachesBytes(
  body: string,
  fields: Set<string> | undefined,
  calls: (method: string) => boolean,
): boolean {
  if (fields === undefined) return true;
  if (/\bself\b(?!\s*(?:\.|::))/.test(body)) return true;
  if (
    fields.size > 0 &&
    new RegExp(`\\bself\\s*\\.\\s*(?:${[...fields].join("|")})\\b`).test(body)
  ) {
    return true;
  }
  return [...body.matchAll(/\bself\s*\.\s*(\w+)\s*(?:::\s*<[^()]*>\s*)?\(/g)].some(([, m]) =>
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
    `\\b(${enums.join("|")})${TURBOFISH}\\s*::\\s*(\\w+)\\b${TURBOFISH}(?!\\s*::)`,
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
function implBlocks(
  code: string,
): { start: number; end: number; type: string; named: Named; byteBound: boolean }[] {
  return [...code.matchAll(IMPL_BLOCK)].map((m) => {
    const head = m[0].replace(/^[\s\S]*?\bimpl\b\s*/, "").replace(/^<(?:[^<>]|<[^<>]*>)*>\s*/, "");
    const type = /(?:\bfor\s+)?((?:[\w:]+::)?)(\w+)\s*(?:<|where\b|$)/.exec(
      head.split(/\bfor\b/).pop() ?? "",
    );
    const name = type?.[2] ?? "";
    const prefix = (type?.[1] ?? "").split("::").slice(0, -1);
    return {
      start: m.index,
      end: itemEnd(code, m.index + m[0].length),
      type: name,
      named: { name, path: [...prefix, name] },
      byteBound: BYTES_IN.test(m[0]),
    };
  });
}

/** `code` with each item matched by `head` blanked to its end, newlines kept. */
function blankItems(code: string, head: RegExp): string {
  let out = code;
  for (const m of code.matchAll(head)) {
    const end = itemEnd(code, m.index + m[0].length);
    out =
      out.slice(0, m.index) +
      newlinesIn(code.slice(m.index, end)).padStart(end - m.index) +
      out.slice(end);
  }
  return out;
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
  const blocks = implBlocks(code);
  const carrierOf = new Map(
    blocks.map((b) => [b, b.byteBound ? { fields: undefined } : scope.carrier(b.named, b.start)]),
  );
  const fns = [...code.matchAll(/\bfn\s+(\w+)/g)].map((m) => {
    const { end, takes } = signature(code.slice(m.index));
    const open = m.index + end;
    const close = code[open] === "{" ? itemEnd(code, open) : open;
    const block = blocks.find((b) => b.start < m.index && m.index < b.end);
    return { m, fn: m[1] ?? "", block, takes, open, close, body: code.slice(open, close) };
  });
  const bodies = fns.map((f) => ({ start: f.open, end: f.close }));
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
      const fields = f.block === undefined ? undefined : carrierOf.get(f.block)?.fields;
      const calls = (name: string) => {
        const called = methods(type).filter((g) => g.fn === name);
        return called.length === 0 || called.some((g) => viaSelf.has(g));
      };
      if (reachesBytes(f.body, fields, calls)) {
        viaSelf.add(f);
        grew = true;
      }
    }
  }
  return fns.flatMap((f) => {
    const { fn, block, takes, body } = f;
    const name = block === undefined ? fn : `${block.type}::${fn}`;
    const takesSelfType =
      block !== undefined &&
      (carrierOf.get(block) ?? null) !== null &&
      /\bSelf\b/.test(takes.replace(/\bself\s*:[^,)]*/, ""));
    const reads =
      BODY_READS.test(body) ||
      [...body.matchAll(BARE_READ)].some(([, g]) => !own.has(g)) ||
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
}

/** Every function in a Rust file's non-test code, a method named with its type. */
function definedFunctions(source: string): string[] {
  const code = withoutTests(rustCode(source));
  const blocks = implBlocks(code);
  return [...code.matchAll(/\bfn\s+(\w+)/g)].map((m) => {
    const owner = blocks.find((b) => b.start < m.index && m.index < b.end)?.type;
    return owner === undefined ? (m[1] ?? "") : `${owner}::${m[1] ?? ""}`;
  });
}

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
): string[] {
  const out: string[] = [];
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
  for (const file of product) {
    const scope = fileScope(table, carriers, file);
    const code = blankItems(codes.get(file) ?? "", IMPL_BLOCK);
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
    for (const item of code.matchAll(/\benum\s+(\w+)/g)) {
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
    for (const struct of code.matchAll(/\bstruct\s+(\w+)/g)) {
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
    for (const alias of code.matchAll(/\btype\s+(\w+)[^=;]*=([^;]*);/g)) {
      if (BYTES_IN.test(alias[2] ?? "") || scope.names(alias[2] ?? "", alias.index)) {
        out.push(
          `${file}::${alias[1]}: names a byte type, which hides it from the decoder rule. ` +
            "Write the byte type in each signature instead.",
        );
      }
    }
    for (const fn of byteTakers(read(file), scope)) {
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
    const calls =
      owner === undefined
        ? new RegExp(`\\b${fn}\\s*\\(`).test(code)
        : new RegExp(`\\b${owner}::${fn}\\s*\\(`).test(code) ||
          (new RegExp(`\\b${owner}\\b`).test(code) && new RegExp(`\\.${fn}\\s*\\(`).test(code));
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
// the holder and hang its terminal up. Any other table (a patch, a test profile) is refused.
export const ROOT_TABLES: Record<string, string[]> = {
  "[workspace]": ['members = ["crates/*"]', 'resolver = "3"'],
  "[workspace.package]": ['edition = "2024"', 'rust-version = "1.100"', "publish = false"],
  "[profile.release]": ["lto = true", "codegen-units = 1", 'panic = "abort"', "strip = true"],
  "[profile.release-holder]": ['inherits = "release"', 'panic = "unwind"'],
};
export const TOOLCHAIN_CONFIG = [
  "[toolchain]",
  'channel = "1.100.0"',
  'profile = "minimal"',
  'components = ["rustfmt", "clippy", "rust-analyzer", "rust-src"]',
];
const NO_CLOEXEC = (path: string, reason: string) => `{ path = "${path}", reason = "${reason}" },`;
const SETS_NO_O_CLOEXEC = "it sets no O_CLOEXEC; use std::fs::OpenOptions, which does";

export const CLIPPY_CONFIG = [
  "allow-unwrap-in-tests = true",
  "allow-expect-in-tests = true",
  "allow-panic-in-tests = true",
  "allow-indexing-slicing-in-tests = true",
  "max-struct-bools = 4",
  // One line: an entry the formatter wraps is read joined (tomlLines).
  [
    "disallowed-methods = [",
    NO_CLOEXEC("rustix::fs::open", SETS_NO_O_CLOEXEC),
    NO_CLOEXEC("rustix::fs::openat", SETS_NO_O_CLOEXEC),
    NO_CLOEXEC(
      "rustix::io::dup",
      "the copy has no FD_CLOEXEC; use OwnedFd::try_clone, which sets it",
    ),
    NO_CLOEXEC("rustix::net::socket", "it sets no SOCK_CLOEXEC; use std's sockets, which do"),
    NO_CLOEXEC(
      "rustix::net::socketpair",
      "it sets SOCK_CLOEXEC only if asked; use UnixStream::pair, which does",
    ),
    NO_CLOEXEC(
      "rustix::net::accept",
      "it sets no SOCK_CLOEXEC; use UnixListener::accept, which does",
    ),
    NO_CLOEXEC(
      "rustix::net::acceptfrom",
      "it sets no SOCK_CLOEXEC; use UnixListener::accept, which does",
    ),
    NO_CLOEXEC(
      "rustix::net::socket_with",
      "it sets SOCK_CLOEXEC only if asked; use std's sockets, which do",
    ),
    NO_CLOEXEC(
      "rustix::net::accept_with",
      "it sets SOCK_CLOEXEC only if asked; use UnixListener::accept, which does",
    ),
    NO_CLOEXEC(
      "rustix::net::acceptfrom_with",
      "it sets SOCK_CLOEXEC only if asked; use UnixListener::accept, which does",
    ),
    NO_CLOEXEC(
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
  'allow = ["Apache-2.0", "MIT", "Unicode-3.0"]',
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

// The package.json scripts that run the Rust gates, exactly, and `check` runs each of them. The
// commands themselves are fixed in scripts/cargo-gate.ts; the tests run under a cap like any.
const GATE = "node scripts/cargo-gate.ts";
export const RUST_GATE_SCRIPTS: Record<string, string> = {
  "format:check": `${GATE} fmt && oxfmt --check`,
  "lint:rust": `${GATE} lint`,
  deny: `${GATE} deny`,
  "test:rust": `node scripts/capped.ts --memory 4G --time 30m -- ${GATE} test`,
};

// cargo's target runner, which caps every test binary, and cargo-mutants' test tool, nextest,
// which runs no doctests: rustdoc starts those without the runner (docs/standards/testing.md
// § Memory and time caps).
export const CARGO_CONFIG = [
  "[target.'cfg(all())']",
  'runner = ["scripts/capped.ts", "--test-binary", "--"]',
];
export const MUTANTS_CONFIG = ['test_tool = "nextest"'];

// What starts tests: vitest, playwright, nextest, cargo-mutants, cargo-fuzz, cargo test and bench,
// and the scripts that run one of those. A script step that does runs under scripts/capped.ts, at
// most at these caps.
const TEST_RUNNER =
  /\b(?:vitest|playwright|cargo-(?:nextest|mutants|fuzz)|cargo\s+(?:\+\S+\s+)?(?:test|bench|nextest|mutants|fuzz)|cargo-gate\.ts test|falsify\.ts|hook-bench\.ts|engine-replay\.ts|test-real\.ts)\b/;
const CAPPED_STEP = /^node (?:\.\.\/)*scripts\/capped\.ts --memory (\d+)G --time (\d+)m -- \S/;
export const MAX_CAP = { gib: 24, minutes: 120 };

/** Why a package.json's scripts would start tests without a cap, or with one too big to bite. */
export function cappedScriptFailures(file: string, scripts: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, script] of Object.entries(scripts)) {
    if (!TEST_RUNNER.test(script)) continue;
    if (/[|;\n\r`]|\$\(|(?<!&)&(?!&)/.test(script)) {
      out.push(
        `${file}: the "${name}" script starts tests, so it joins its steps with \`&&\` alone: ` +
          "a `|`, `;`, `&`, line break or command substitution could run one round its cap.",
      );
      continue;
    }
    for (const step of script.split("&&").map((s) => s.trim())) {
      if (!TEST_RUNNER.test(step)) continue;
      const capped = CAPPED_STEP.exec(step);
      if (capped === null) {
        out.push(
          `${file}: the "${name}" script starts tests without a memory and time cap. Run the ` +
            "step as `node scripts/capped.ts --memory <n>G --time <n>m -- <command>` " +
            "(docs/standards/testing.md § Memory and time caps).",
        );
      } else if (Number(capped[1]) > MAX_CAP.gib || Number(capped[2]) > MAX_CAP.minutes) {
        out.push(
          `${file}: the "${name}" script's cap is above ${MAX_CAP.gib}G or ` +
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
  "scripts/cargo-gate.ts": "removes them from every gate's environment",
  "scripts/cargo-gate.test.ts": "sets them to check the gate removes them",
  "scripts/cargo-gate.medium.test.ts": "sets them to check the tool never sees them",
  "scripts/check-standards.ts": "names them to find them",
  "scripts/check-standards.test.ts": "plants them to check they are found",
};
const LINT_FLAG =
  /(?:\b|_)rust(?:doc)?flags\b|rustc[-_](?:workspace[-_])?wrapper|\bcargo_alias_|cap-lints/i;

/** Why the package.json scripts don't run the Rust gates as RUST_GATE_SCRIPTS says. */
export function gateScriptFailures(scripts: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, command] of Object.entries(RUST_GATE_SCRIPTS)) {
    if (scripts[name] !== command) {
      out.push(
        `package.json: the "${name}" script must be \`${command}\` (RUST_GATE_SCRIPTS in ` +
          "scripts/check-standards.ts); a gate's command changes in scripts/cargo-gate.ts.",
      );
    }
  }
  const check = scripts.check ?? "";
  const steps = /[|;\n\r]|(?<!&)&(?!&)/.test(check) ? [] : check.split("&&").map((c) => c.trim());
  for (const name of Object.keys(RUST_GATE_SCRIPTS)) {
    if (!steps.includes(`pnpm run ${name}`)) {
      out.push(
        `package.json: the "check" script must run \`pnpm run ${name}\` as one of its \`&&\` ` +
          "steps, with no `|`, `;` or line break that could step round it.",
      );
    }
  }
  return out;
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
const HEAVY_ALLOWED: Record<string, string> = {};

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
  return /["']?\bharness["']?\s*=/.test(text)
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
    heavyAllowed?: Record<string, string>;
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
            "through scripts/cargo-gate.ts, which removes it; a file that must set it goes in " +
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
  if (paths.includes("package.json")) out.push(...gateScriptFailures(packageScripts(read)));
  else out.push("package.json is missing; the Rust gates run from its scripts.");
  pinned("clippy.toml", CLIPPY_CONFIG, "CLIPPY_CONFIG");
  pinned(".cargo/config.toml", CARGO_CONFIG, "CARGO_CONFIG");
  pinned(".cargo/mutants.toml", MUTANTS_CONFIG, "MUTANTS_CONFIG");
  out.push(
    ...decoderFailures(
      paths,
      read,
      options.fuzzed ?? {},
      options.notDecoders ?? {},
      options.publicByteFields ?? {},
    ),
  );
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
      publicByteFields: PUBLIC_BYTE_FIELDS,
      heavyAllowed: HEAVY_ALLOWED,
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
// `Ending::new` on its own, which a test gives a stand-in that signals nothing.
const HOLDER_BINARY = "CARGO_BIN_EXE_bazhen-holder";
const SIGNALLING_CALL =
  /\.\s*(?:close(?:_step)?|signal|respawn)\s*\(|\bsweep\s*\(|\bsession\s*\(\s*\)\s*\.|\b(?:pass_among|retire)\s*\(|\bEnding\s*::\s*start\b|\bSession\b/;

/** A Rust test file's test binary: `tests/<name>.rs`, or every file under `tests/<name>/`. */
const testBinary = (file: string) => /^(crates\/[^/]+\/tests\/[^/.]+)/.exec(file)?.[1];

/**
 * Each Rust test that signals processes it didn't start but isn't ignored as doing so: every
 * test of a binary that runs the holder, and any whose own body closes a child or sweeps the
 * ledger. Such a test runs only on a disposable host (docs/standards/testing.md § Hermeticity).
 */
export function unmarkedSignallingTests(
  files: readonly string[],
  read: (file: string) => string,
): string[] {
  const rust = files.filter((f) => /^crates\/.+\.rs$/.test(f) && !f.includes("/fuzz/"));
  const holderBinaries = new Set(
    rust.flatMap((f) => (read(f).includes(HOLDER_BINARY) ? [testBinary(f) ?? ""] : [])),
  );
  holderBinaries.delete("");
  return rust.flatMap((file) => {
    const strings: string[] = [];
    const code = rustCode(read(file), strings);
    const wholeBinary = holderBinaries.has(testBinary(file) ?? "");
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
      SIGNALLING_CALL.test(m[2] ?? "") ? [new RegExp(`\\b${m[1] ?? ""}\\b`)] : [],
    );
    const helpers = new Set<string>();
    const callsHelper = (body: string) =>
      values.some((value) => value.test(body)) ||
      [...helpers].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(body));
    for (const { name, body } of fns) if (SIGNALLING_CALL.test(body)) helpers.add(name);
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
      return SIGNALLING_CALL.test(block) || callsHelper(block) ? [m[1] ?? ""] : [];
    });
    // A macro's test body can come from where it is invoked, so a file that closes or sweeps
    // anywhere makes each test its macros generate a signalling one.
    const fileSignals = SIGNALLING_CALL.test(code);
    const macros = [...code.matchAll(/\bmacro_rules\s*!\s*\w+\s*\{/g)].map((m) => ({
      from: m.index,
      to: closingBrace(code, m.index + m[0].length),
    }));
    const signals = (body: string, at: number) =>
      SIGNALLING_CALL.test(body) ||
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
  failures.push(...unmarkedSignallingTests(repoFiles(), readRepoFile));
  failures.push(...cargoManifestFailures(repoFiles(), readRepoFile));
}

function checkCappedScripts(): void {
  for (const file of repoFiles().filter((p) => fileName(p) === "package.json")) {
    const scripts = packageScripts((p) => readFileSync(join(root, p), "utf8"), file);
    failures.push(...cappedScriptFailures(file, scripts));
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

function checkSkills(scripts: Set<string>): void {
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
    checkContextFile(doc, scripts);
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

/** Every check `pnpm check` runs, in order. */
export const STANDARDS_CHECKS: readonly (() => void)[] = [
  checkSiblingTests,
  checkAgentContext,
  () => checkSkills(scriptNames()),
  checkWebTokens,
  checkRust,
  checkCappedScripts,
  checkSignalChokepoints,
  checkMigrations,
];

if (isMain(import.meta)) {
  for (const check of STANDARDS_CHECKS) check();

  if (failures.length > 0) {
    console.error(`Standards check failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
}
