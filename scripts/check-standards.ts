// Repository standards that no linter covers (docs/standards/code.md, testing.md). Runs first in
// `pnpm check`; every failure names the file and the fix.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures: string[] = [];

// Source files whose behaviour is covered by a test somewhere other than a sibling file. Each
// entry names that test, and the check fails if it disappears.
const COVERED_ELSEWHERE: Record<string, string> = {
  "packages/runtime-tmux/src/index.ts": "tests/integration/tmux-runtime.test.ts",
  "apps/daemon/src/pty/node-pty.ts": "tests/integration/tmux-runtime.test.ts",
  "apps/daemon/src/main.ts": "tests/e2e/health.spec.ts",
  "apps/daemon/src/store/migrations.ts": "apps/daemon/src/store/store.medium.test.ts",
  "apps/web/src/App.tsx": "tests/e2e/health.spec.ts",
  "apps/web/src/main.tsx": "tests/e2e/health.spec.ts",
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

/** True when the module has code that runs, not just types and re-exports. */
function hasRuntimeCode(file: string): boolean {
  if (file.endsWith(".tsx")) return true;
  const js = stripTypeScriptTypes(readFileSync(join(root, file), "utf8"));
  const code = js
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^\s*export\s+(\*|\{[^}]*\})\s+from\s+["'][^"']+["'];?/gm, "")
    .replace(/^\s*export\s*\{\s*\};?/gm, "");
  return code.trim().length > 0;
}

function checkSiblingTests(): void {
  const dirs = readdirSync(join(root, "packages"))
    .map((p) => `packages/${p}/src`)
    .concat(readdirSync(join(root, "apps")).map((a) => `apps/${a}/src`));
  for (const file of dirs.flatMap(sourceFiles)) {
    const covering = COVERED_ELSEWHERE[file];
    if (covering !== undefined) {
      if (!existsSync(join(root, covering))) {
        failures.push(`${file}: its covering test ${covering} no longer exists.`);
      }
      continue;
    }
    if (!hasRuntimeCode(file)) continue;
    const stem = file.replace(/\.tsx?$/, "");
    if (![".test.ts", ".medium.test.ts"].some((ext) => existsSync(join(root, stem + ext)))) {
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

function checkHooks(): void {
  let hooksPath = "";
  try {
    hooksPath = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    // Unset.
  }
  if (hooksPath !== ".githooks") {
    failures.push(
      `git hooks are not installed (core.hooksPath is "${hooksPath}"): run \`pnpm run prepare\`.`,
    );
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
const LINT_RULE = /^(import|vitest|typescript|unicorn|react|react-hooks|eslint)\//;
const PATH_LIKE = /^(\.?[\w@-]+\/)+[\w.@-]*$|^\.?[\w-]+\.(ts|tsx|md|json)$/;

function scriptNames(): Set<string> {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scripts =
    typeof pkg === "object" && pkg !== null && "scripts" in pkg ? pkg.scripts : undefined;
  return new Set(typeof scripts === "object" && scripts !== null ? Object.keys(scripts) : []);
}

function checkContextFile(doc: string, scripts: Set<string>): void {
  const text = readFileSync(join(root, doc), "utf8");
  for (const [, span = ""] of text.matchAll(/`([^`\n]+)`/g)) {
    for (const [, first = "", second = ""] of span.matchAll(/\bpnpm ([\w:-]+)(?: ([\w:-]+))?/g)) {
      const script = first === "run" ? second : first;
      if (!PNPM_BUILTINS.has(script) && !scripts.has(script)) {
        failures.push(`${doc}: names \`pnpm ${script}\`, which is not a package.json script.`);
      }
    }
    const candidate = span.replace(/:\d+$/, "");
    if (!PATH_LIKE.test(candidate) || LINT_RULE.test(candidate) || candidate.startsWith("@")) {
      continue;
    }
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
  return readdirSync(join(root, SKILLS_DIR)).map((name) => `${SKILLS_DIR}/${name}/SKILL.md`);
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

checkSiblingTests();
checkHooks();
checkAgentContext();
checkSkills(scriptNames());

if (failures.length > 0) {
  console.error(`Standards check failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
