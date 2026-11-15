// The falsify that judges a branch is the branch's own, so a branch that weakens it could pass on
// the weakened check. When the branch changes falsify, anything it imports, or how it is run, this
// judges the branch with the base's falsify as well (docs/standards/testing.md § Falsification).
// The files are the base's list and the branch's together, so a branch can't shorten the list to
// skip this. A base whose falsify has no --harness lists nothing, and the branch's list stands
// alone. CI and `pnpm test:real falsify` both run it, after `pnpm test:falsify`.
//
// The base's falsify runs from a worktree of the base, locked as falsify locks its own, so a run
// killed before it could clean up is swept by the next falsify. It runs only in a sandbox: a base
// older than falsify's signalling check would revert and mutate signalling code wherever it ran.
//
// Usage: node scripts/falsify-base.ts --base <ref>

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inSandbox } from "./falsify-signals.ts";
import {
  INSTALL_MODES,
  INSTALL_TIMEOUT_MS,
  WORKTREE_PREFIX,
  addWorktree,
  installArgs,
  isolatedEnv,
  removeWorktree,
  workFromRoot,
} from "./falsify.ts";
import { isMain } from "./is-main.ts";

/** How CI and the container run falsify: a change to either is a change to falsify. */
const RUNNERS = [
  ".github/workflows/ci.yml",
  "package.json",
  "scripts/falsify-base.ts",
  "scripts/test-real.ts",
  "tests/real/Dockerfile",
];

const USAGE = "usage: node scripts/falsify-base.ts --base <ref>";

function parseArgs(args: readonly string[]): string {
  const [flag, ref, ...rest] = args;
  if (flag !== "--base" || ref === undefined || ref.startsWith("-") || rest.length > 0) {
    throw new Error(USAGE);
  }
  return ref;
}

const git = (...args: string[]) =>
  execFileSync("git", args, {
    env: isolatedEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

/** The files a `--harness` run printed, one per line, or none when it failed. */
function harness(falsify: string, cwd: string): string[] {
  const listed = spawnSync("node", [falsify, "--harness"], {
    cwd,
    env: isolatedEnv(),
    encoding: "utf8",
  });
  return listed.status === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
}

function main(args: readonly string[]): number {
  let ref: string;
  try {
    ref = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : USAGE);
    return 2;
  }
  if (!inSandbox()) {
    console.error(
      "falsify-base: the base's falsify may revert or mutate code that signals processes, so " +
        "this runs only in a sandbox: CI, or `pnpm test:real falsify`.",
    );
    return 1;
  }
  const top = git("rev-parse", "--show-toplevel");
  workFromRoot(top);
  const base = git("merge-base", ref, "HEAD");
  const dir = mkdtempSync(join(tmpdir(), WORKTREE_PREFIX));
  try {
    addWorktree(dir, base, top);
    const installed = INSTALL_MODES.some(
      (mode) =>
        spawnSync("pnpm", installArgs(mode), {
          cwd: dir,
          env: isolatedEnv(),
          stdio: "inherit",
          timeout: INSTALL_TIMEOUT_MS,
        }).status === 0,
    );
    if (!installed) {
      console.error("falsify-base: couldn't install the base's dependencies in its worktree");
      return 1;
    }
    const files = [
      ...new Set([
        ...harness(join(dir, "scripts/falsify.ts"), dir),
        ...harness(join(top, "scripts/falsify.ts"), top),
        ...RUNNERS,
      ]),
    ];
    const unchanged =
      spawnSync("git", ["diff", "--quiet", base, "HEAD", "--", ...files], {
        cwd: top,
        env: isolatedEnv(),
      }).status === 0;
    if (unchanged) {
      console.log("falsify-base: falsify, its imports and how it is run are unchanged.");
      return 0;
    }
    console.log(`falsify-base: the branch changes falsify, so the base's judges it too.`);
    const judged = spawnSync("node", [join(dir, "scripts/falsify.ts"), "--base", ref], {
      cwd: top,
      env: isolatedEnv(),
      stdio: "inherit",
    });
    return judged.status ?? 1;
  } finally {
    removeWorktree(dir, top);
  }
}

if (isMain(import.meta)) process.exit(main(process.argv.slice(2)));
