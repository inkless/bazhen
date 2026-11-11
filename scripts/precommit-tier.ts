// Picks the pre-commit gate for the staged paths (docs/standards/review.md):
//   docs  only Markdown, docs/ or skill text: the standards check and formatting
//   fast  `pnpm check:fast`
//   full  `pnpm check:fast`, then the integration tests: the change can reach tmux
// Run as a script, it prints the tier for the staged change.

import { execFileSync } from "node:child_process";
import { isMain } from "./is-main.ts";

export type Tier = "docs" | "fast" | "full";

const FULL_DIRS = [
  "packages/runtime-tmux/",
  "packages/core/",
  "packages/protocol/",
  "apps/daemon/",
  "tests/integration/",
  "tests/support/",
];
const FULL_FILES = new Set([
  "vitest.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);
const TEST_PACKAGE = /^tests\/[^/]+\/package\.json$/;

// Under .agents only Markdown is docs: skills may ship scripts.
const isDocs = (path: string) =>
  path.startsWith(".agents/")
    ? path.endsWith(".md")
    : path.endsWith(".md") || path.startsWith("docs/");

const isFull = (path: string) =>
  FULL_DIRS.some((dir) => path.startsWith(dir)) || FULL_FILES.has(path) || TEST_PACKAGE.test(path);

/** The gate for a set of staged paths. Pass both sides of a rename. */
export function tier(paths: string[]): Tier {
  if (paths.every(isDocs)) return "docs";
  return paths.some(isFull) ? "full" : "fast";
}

if (isMain(import.meta)) {
  const staged = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMRD", "-z"],
    { encoding: "utf8" },
  );
  console.log(tier(staged.split("\0").filter(Boolean)));
}
