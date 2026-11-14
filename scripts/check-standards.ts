// Repository standards that no linter covers (docs/standards/code.md, testing.md). Runs first in
// `pnpm check`; every failure names the file and the fix.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cssDeclarations } from "../apps/web/src/ui/token-sheet.ts";
import { isMain } from "./is-main.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures: string[] = [];

// Source files whose behaviour is covered by a test somewhere other than a sibling file. Each
// entry names that test, and the check fails if it disappears.
const COVERED_ELSEWHERE: Record<string, string> = {
  "packages/runtime-tmux/src/index.ts": "tests/integration/tmux-runtime.test.ts",
  "apps/daemon/src/pty/node-pty.ts": "tests/integration/tmux-runtime.test.ts",
  "apps/daemon/src/main.ts": "tests/e2e/health.spec.ts",
  "apps/cli/src/main.ts": "tests/api/cli.test.ts",
  "apps/daemon/src/start.ts": "tests/api/cli.test.ts",
  "apps/daemon/src/detach.ts": "tests/api/cli.test.ts",
  "apps/daemon/src/store/migrations.ts": "apps/daemon/src/store/store.medium.test.ts",
  "apps/daemon/src/store/projections.ts": "apps/daemon/src/store/store.medium.test.ts",
  "apps/daemon/src/mailbox/ingress.ts": "tests/api/mail.test.ts",
  "apps/daemon/src/testing/fixtures.ts": "apps/daemon/src/mailbox/mailbox.medium.test.ts",
  "apps/daemon/src/testing/fake-app-server.ts": "apps/daemon/src/codex/app-server.medium.test.ts",
  "packages/core/src/environment.ts": "packages/env-local/src/index.test.ts",
  "packages/core/src/runtime.ts": "packages/core/src/testing/fake-runtime.test.ts",
  "packages/core/src/testing/runtime-contract.ts": "packages/core/src/testing/fake-runtime.test.ts",
  "packages/core/src/testing/platform.ts": "packages/core/src/testing/fake-runtime.test.ts",
  "apps/web/src/App.tsx": "tests/e2e/health.spec.ts",
  "apps/web/src/main.tsx": "tests/e2e/health.spec.ts",
  "apps/web/src/api.ts": "tests/e2e/terminal.spec.ts",
  "apps/web/src/Dashboard.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/Pairing.tsx": "tests/e2e/pairing.spec.ts",
  "apps/web/src/fleet/AttachCommand.tsx": "tests/e2e/dashboard.spec.ts",
  "apps/web/src/fleet/FleetList.tsx": "tests/e2e/dashboard.spec.ts",
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

/** True when the TypeScript source has code that runs, not just types and re-exports. */
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
    const covering = COVERED_ELSEWHERE[file];
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
    if (TOKEN_FILES.has(file)) continue;
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
];
const PNPM_BUILTINS = new Set(["install", "exec", "add", "remove", "update"]);
// pnpm options that take a value as the next word; every other option is a bare flag.
const PNPM_VALUE_FLAGS = new Set(["--filter", "-F", "--dir", "-C", "--reporter", "--loglevel"]);
const LINT_RULE = /^(import|vitest|typescript|unicorn|react|react-hooks|eslint|bazhen)\//;
const PATH_LIKE = /^(\.?[\w@-]+\/)+[\w.@-]*$|^\.?[\w-]+\.(ts|tsx|md|json)$/;

function scriptNames(): Set<string> {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scripts =
    typeof pkg === "object" && pkg !== null && "scripts" in pkg ? pkg.scripts : undefined;
  return new Set(typeof scripts === "object" && scripts !== null ? Object.keys(scripts) : []);
}

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
// Each may set `#[expect(unsafe_code, reason = "...")]`, and nothing else in crates/ may.
const UNSAFE_MODULES: Record<string, string> = {};

const RAW_STRING = /r(#*)"/y;
const isIdent = (c: string | undefined) => c !== undefined && /\w/.test(c);

/**
 * Rust source with its comments removed and every string and char literal emptied, so neither a
 * `//` in a string nor an attribute quoted in one changes what the attributes are.
 */
export function rustCode(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        const pair = source.slice(i, i + 2);
        const step = pair === "/*" ? 1 : pair === "*/" ? -1 : 0;
        depth += step;
        i += step === 0 ? 1 : 2;
      }
      out += " ";
    } else if (c === "r" && !isIdent(source[i - 1] === "b" ? source[i - 2] : source[i - 1])) {
      RAW_STRING.lastIndex = i;
      const raw = RAW_STRING.exec(source);
      if (raw === null) {
        out += c;
        i++;
        continue;
      }
      const close = `"${raw[1] ?? ""}`;
      const end = source.indexOf(close, i + raw[0].length);
      i = end === -1 ? source.length : end + close.length;
      out += '""';
    } else if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
    } else if (c === "'" && (next === "\\" || source[i + 2] === "'")) {
      i += next === "\\" ? 3 : 1;
      while (i < source.length && source[i] !== "'") i++;
      i++;
      out += "' '";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const LINT_LEVEL = /#\s*!?\s*\[\s*(?:cfg_attr\s*\([^\]]*?,\s*)?(allow|expect)\s*\(([^)]*)\)/g;

/** Each `allow(...)` or `expect(...)` lint attribute in Rust source, comments and strings aside. */
export function lintSuppressions(source: string): { level: string; lints: string[] }[] {
  return [...rustCode(source).matchAll(LINT_LEVEL)].map(([, level = "", list = ""]) => ({
    level,
    lints: list
      .replace(/reason\s*=\s*""/g, "")
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  }));
}

/** Why each lint suppression in `file` is not allowed: none at all, but `unsafe_code` in an unsafe module. */
export function suppressionFailures(
  file: string,
  source: string,
  unsafeModules: Record<string, string>,
): string[] {
  return lintSuppressions(source)
    .filter(
      ({ level, lints }) =>
        !(file in unsafeModules && level === "expect" && lints.join() === "unsafe_code"),
    )
    .map(
      ({ level, lints }) =>
        `${file}: #[${level}(${lints.join(", ")})] suppresses a lint. Fix the code instead; the ` +
        "only exceptions are the workspace allow-list in Cargo.toml and UNSAFE_MODULES in " +
        "scripts/check-standards.ts (docs/standards/rust.md).",
    );
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
  'unsafe_op_in_unsafe_fn = "deny"',
  'missing_debug_implementations = "deny"',
  'unreachable_pub = "deny"',
  'rust_2018_idioms = { level = "deny", priority = -1 }',
  "[workspace.lints.clippy]",
  'pedantic = { level = "warn", priority = -1 }',
  'must_use_candidate = "allow"',
  'unwrap_used = "warn"',
  'expect_used = "warn"',
  'panic = "warn"',
  'todo = "warn"',
  'unimplemented = "warn"',
  'dbg_macro = "warn"',
  'print_stdout = "warn"',
  'print_stderr = "warn"',
  'indexing_slicing = "warn"',
  'string_slice = "warn"',
  'unreachable = "warn"',
  'undocumented_unsafe_blocks = "warn"',
  'multiple_unsafe_ops_per_block = "warn"',
  'allow_attributes = "warn"',
  'allow_attributes_without_reason = "warn"',
];
export const CLIPPY_CONFIG = [
  "allow-unwrap-in-tests = true",
  "allow-expect-in-tests = true",
  "allow-panic-in-tests = true",
  "allow-indexing-slicing-in-tests = true",
];

/** TOML's lines with comments and blank lines dropped, each trimmed. Strings hold no `#` here. */
function tomlLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s#.*$|^#.*$/, "").trim())
    .filter((l) => l !== "");
}

/** Each table's lines, by its header; the lines before any header are under "". */
export function tomlTables(text: string): Map<string, string[]> {
  const tables = new Map<string, string[]>([["", []]]);
  let current: string[] = tables.get("") ?? [];
  for (const line of tomlLines(text)) {
    if (/^\[[^\]]*\]$/.test(line)) {
      current = [];
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

/** Why the root manifest's lints or pinned dependencies are not what the standard says. */
export function rootManifestFailures(text: string): string[] {
  const out: string[] = [];
  const tables = tomlTables(text);
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
    const path = /^[\w-]+\s*=\s*\{(?!.*\bversion\b).*\bpath\s*=\s*"[^"]*".*\}$/.test(line);
    if (!path && !(version?.[1] ?? version?.[2] ?? "").startsWith("=")) {
      out.push(
        `Cargo.toml: \`${line}\` must pin an exact version (\`"=x.y.z"\`) or be a path to a ` +
          "crate of ours.",
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
): string[] {
  const out: string[] = [];
  for (const manifest of paths.filter((p) => fileName(p) === "Cargo.toml")) {
    if (manifest === "Cargo.toml") {
      out.push(...rootManifestFailures(read(manifest)));
    } else if (!/^crates\/[^/]+\/Cargo\.toml$/.test(manifest)) {
      out.push(`${manifest}: a crate lives in crates/<name>/, as a member of the root workspace.`);
    } else {
      if (!inheritsWorkspaceLints(read(manifest))) {
        out.push(
          `${manifest}: needs \`[lints]\` with \`workspace = true\`, so the workspace lints apply.`,
        );
      }
      out.push(...memberDependencyFailures(manifest, read(manifest)));
    }
  }
  for (const file of paths.filter((p) => p.endsWith(".rs"))) {
    if (!file.startsWith("crates/")) {
      out.push(`${file}: Rust source lives in a crate under crates/, where the checks read it.`);
      continue;
    }
    const source = read(file);
    out.push(...suppressionFailures(file, source, unsafeModules));
    if (/\$\s*\w+\s*:\s*meta\b|#\s*!?\s*\[\s*\$/.test(rustCode(source))) {
      out.push(
        `${file}: a macro passes an attribute through (\`$x:meta\` or \`#[$x]\`), which could ` +
          "carry a lint suppression no check sees. Write the attribute out.",
      );
    }
  }
  for (const file of Object.keys(unsafeModules).filter((f) => !paths.includes(f))) {
    out.push(`scripts/check-standards.ts: UNSAFE_MODULES lists missing ${file}.`);
  }
  for (const file of paths) {
    const base = fileName(file);
    if (/(^|\/)\.cargo\/config(\.toml)?$/.test(file)) {
      out.push(`${file}: cargo config can pass flags that turn lints off; there is none here.`);
    } else if (["clippy.toml", ".clippy.toml"].includes(base) && file !== "clippy.toml") {
      out.push(`${file}: clippy reads only the root clippy.toml here.`);
    } else if (["rustfmt.toml", ".rustfmt.toml"].includes(base)) {
      out.push(`${file}: rustfmt runs with its defaults (docs/standards/rust.md § Formatting).`);
    } else if (/^rust-toolchain(\.toml)?$/.test(base) && file !== "rust-toolchain.toml") {
      out.push(`${file}: the root rust-toolchain.toml is the one toolchain pin.`);
    }
  }
  if (
    paths.includes("clippy.toml") &&
    tomlLines(read("clippy.toml")).join("\n") !== CLIPPY_CONFIG.join("\n")
  ) {
    out.push("clippy.toml: differs from CLIPPY_CONFIG in scripts/check-standards.ts.");
  }
  return out;
}

/** The repository's files, tracked or not yet added, as git sees them. */
function repoFiles(): string[] {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p !== "" && existsSync(join(root, p)));
}

function checkRust(): void {
  failures.push(
    ...rustFailures(repoFiles(), (p) => readFileSync(join(root, p), "utf8"), UNSAFE_MODULES),
  );
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
    const text = readFileSync(join(root, doc), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    const name = /^name: (.+)$/m.exec(front)?.[1]?.trim();
    const description = /^description: (.+)$/m.exec(front)?.[1]?.trim() ?? "";
    if (name !== dir || !dir.startsWith("bz-")) {
      failures.push(`${doc}: name must equal its directory and start with "bz-" (got "${name}").`);
    }
    if (description.length === 0 || description.length > DESCRIPTION_MAX) {
      failures.push(`${doc}: description must be 1-${DESCRIPTION_MAX} characters.`);
    }
    if (!description.includes("changing Bazhen's source in this repository")) {
      failures.push(
        `${doc}: description must say it applies "when changing Bazhen's source in this ` +
          "repository\", so it doesn't compete with the product's bazhen-* skills.",
      );
    }
    checkContextFile(doc, scripts);
  }
}

if (isMain(import.meta)) {
  checkSiblingTests();
  checkAgentContext();
  checkSkills(scriptNames());
  checkWebTokens();
  checkRust();

  if (failures.length > 0) {
    console.error(`Standards check failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
}
