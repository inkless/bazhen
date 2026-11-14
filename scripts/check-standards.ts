// Repository standards that no linter covers (docs/standards/code.md, testing.md). Runs first in
// `pnpm check`; every failure names the file and the fix.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cssDeclarations } from "../apps/web/src/ui/token-sheet.ts";
import { gateEnv } from "./cargo-gate.ts";
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
  "docs/standards/rust.md",
];
const PNPM_BUILTINS = new Set(["install", "exec", "add", "remove", "update"]);
// pnpm options that take a value as the next word; every other option is a bare flag.
const PNPM_VALUE_FLAGS = new Set(["--filter", "-F", "--dir", "-C", "--reporter", "--loglevel"]);
const LINT_RULE = /^(import|vitest|typescript|unicorn|react|react-hooks|eslint|bazhen)\//;
const PATH_LIKE = /^(\.?[\w@-]+\/)+[\w.@-]*$|^\.?[\w-]+\.(ts|tsx|md|json)$/;

/** package.json's scripts, by name, read with `read`. */
function packageScripts(read: (path: string) => string): Record<string, string> {
  const pkg: unknown = JSON.parse(read("package.json"));
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
const UNSAFE_MODULES: Record<string, string> = {};

const RAW_STRING = /r(#*)"/y;
const isIdent = (c: string | undefined) => c !== undefined && /\w/.test(c);
const newlinesIn = (text: string) => text.replaceAll(/[^\n]/g, "");

/**
 * Rust source with its comments removed and every string and char literal emptied, so neither a
 * `//` in a string nor an attribute quoted in one changes what the attributes are. Newlines are
 * kept, so a line in the result is the same line in the source.
 */
export function rustCode(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    const start = i;
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
      out += ` ${newlinesIn(source.slice(start, i))}`;
    } else if (
      c === "r" &&
      !isIdent(/[bc]/.test(source[i - 1] ?? "") ? source[i - 2] : source[i - 1])
    ) {
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
      out += `""${newlinesIn(source.slice(start, i))}`;
    } else if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      i++;
      out += `""${newlinesIn(source.slice(start, i))}`;
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
};

/** The predicates of a cfg or cfg_attr attribute that aren't in CFG_ALLOWED. */
export function cfgOutsideAllowList(body: string): string[] {
  const cfg = /^cfg(_attr)?\s*\(/.exec(body);
  if (cfg === null) return [];
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
  const atoms = predicate.match(/\b[A-Za-z_]\w*\b/g) ?? [];
  return [...new Set(atoms)].filter((a) => !["all", "any"].includes(a) && !(a in CFG_ALLOWED));
}

const UNSAFE_EXPECT = /^expect\s*\(\s*unsafe_code\s*,\s*reason\s*=\s*""\s*,?\s*\)$/;
const SEE_RUST_MD = "(docs/standards/rust.md § Lints).";

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
  const code = rustCode(source);
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
    } else if (/(?:^|,)\s*(ignore|should_panic)\b/.test(body)) {
      out.push(
        `${where}: ${attribute} skips a test, or passes it when it fails. A test runs, and fails ` +
          "on what it asserts; check an error with a Result, not a panic.",
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
// The root manifest's other tables, exactly: one workspace over crates/, nothing excluded, and the
// one profile the hook's release build uses. Any other table (a patch, a test profile) is refused.
export const ROOT_TABLES: Record<string, string[]> = {
  "[workspace]": ['members = ["crates/*"]', 'resolver = "3"'],
  "[workspace.package]": ['edition = "2024"', 'rust-version = "1.100"', "publish = false"],
  "[profile.release]": ["lto = true", "codegen-units = 1", 'panic = "abort"', "strip = true"],
};
export const TOOLCHAIN_CONFIG = [
  "[toolchain]",
  'channel = "1.100.0"',
  'profile = "minimal"',
  'components = ["rustfmt", "clippy"]',
];
export const CLIPPY_CONFIG = [
  "allow-unwrap-in-tests = true",
  "allow-expect-in-tests = true",
  "allow-panic-in-tests = true",
  "allow-indexing-slicing-in-tests = true",
];

export const DENY_CONFIG = [
  "[graph]",
  "all-features = true",
  "[advisories]",
  'yanked = "deny"',
  "[licenses]",
  'allow = ["Apache-2.0", "MIT"]',
  "include-dev = true",
  "private = { ignore = true }",
  "[bans]",
  'multiple-versions = "deny"',
  'wildcards = "deny"',
  "allow-wildcard-paths = true",
  "[sources]",
  'unknown-registry = "deny"',
  'unknown-git = "deny"',
];

// The package.json scripts that run the Rust gates, exactly, and `check` runs each of them. The
// commands themselves are fixed in scripts/cargo-gate.ts.
const GATE = "node --disable-warning=ExperimentalWarning scripts/cargo-gate.ts";
export const RUST_GATE_SCRIPTS: Record<string, string> = {
  "format:check": `${GATE} fmt && oxfmt --check`,
  "lint:rust": `${GATE} lint`,
  deny: `${GATE} deny`,
  "test:rust": `${GATE} test`,
};

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

/** Why a member manifest gives a test target a harness of its own, which could run nothing. */
export function harnessFailures(manifest: string, text: string): string[] {
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
  options: { metadata?: CargoMetadata; macroModules?: Record<string, string> } = {},
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
  if (options.metadata !== undefined) out.push(...metadataFailures(options.metadata, paths));
  for (const file of Object.keys(options.macroModules ?? {}).filter((f) => !paths.includes(f))) {
    out.push(`scripts/check-standards.ts: MACRO_MODULES lists missing ${file}.`);
  }
  for (const file of Object.keys(unsafeModules)) {
    if (paths.includes(file)) out.push(...unsafeModuleFailures(file, read(file)));
    else out.push(`scripts/check-standards.ts: UNSAFE_MODULES lists missing ${file}.`);
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
        p.dependencies.every((d) => isRecord(d) && str(d.name) && str(d.req)),
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
    }),
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
