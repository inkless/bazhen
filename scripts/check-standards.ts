// Repository standards that no linter covers (docs/standards/code.md, testing.md). Runs first in
// `pnpm check`; every failure names the file and the fix.

import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures: string[] = [];

// Source files whose behaviour is covered by a test somewhere other than a sibling file. Each
// entry names that test, and the check fails if it disappears.
const COVERED_ELSEWHERE: Record<string, string> = {
  "packages/runtime-tmux/src/index.ts": "tests/integration/tmux-runtime.test.ts",
  "apps/daemon/src/pty/node-pty.ts": "tests/integration/tmux-runtime.test.ts",
  "apps/daemon/src/main.ts": "tests/e2e/health.spec.ts",
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
  "apps/web/src/Fleet.tsx": "tests/e2e/terminal.spec.ts",
  "apps/web/src/terminal/TerminalView.tsx": "tests/e2e/keys.spec.ts",
  "apps/web/src/terminal/scroll-input.ts": "tests/e2e/keys.spec.ts",
};

function sourceFiles(dir: string): string[] {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) return sourceFiles(rel);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")
      ? [rel]
      : [];
  });
}

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

// Agent context is read on every session, so it stays short, and every path and command it names
// must exist: stale context misleads every agent that reads it.
const AGENTS_MAX_LINES = 60;
const CONTEXT_DOCS = [
  "AGENTS.md",
  "docs/standards/code.md",
  "docs/standards/testing.md",
  "docs/standards/review.md",
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

  if (failures.length > 0) {
    console.error(`Standards check failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
}
