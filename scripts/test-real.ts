// `pnpm test:real [suite…]`: the real-tmux suites, in a container built from this worktree
// (docs/standards/testing.md). The build context is a fresh repository holding HEAD, main and
// the worktree's uncommitted files, so falsify can judge commits and the other suites test what is
// on disk. Each suite gets a container of its own, with nothing of the host's mounted: no
// worktree, no socket, no tmux directory.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isMain } from "./is-main.ts";

const SUITES = {
  integration: "test:integration",
  api: "test:api",
  e2e: "test:e2e",
  falsify: "test:falsify",
} as const;
type Suite = keyof typeof SUITES;
const DEFAULT_SUITES: Suite[] = ["integration", "api", "e2e"];

const isSuite = (name: string): name is Suite => Object.hasOwn(SUITES, name);

/** The suites named on the command line, in order, or the default set; throws on an unknown one. */
export function parseSuites(args: readonly string[]): Suite[] {
  const unknown = args.filter((a) => !isSuite(a));
  if (unknown.length > 0) {
    throw new Error(
      `unknown suite ${unknown.join(", ")}; usage: pnpm test:real [${Object.keys(SUITES).join("|")}]…`,
    );
  }
  return args.length === 0 ? DEFAULT_SUITES : [...new Set(args.filter(isSuite))];
}

/** The image's build arguments, read from the repository's own pins. */
export function pins(read: (path: string) => string): Record<string, string> {
  const pkg = (path: string): Record<string, unknown> => JSON.parse(read(path));
  const manager = String(pkg("package.json")["packageManager"]);
  const e2eDeps = pkg("tests/e2e/package.json")["devDependencies"];
  const playwright =
    typeof e2eDeps === "object" && e2eDeps !== null
      ? Reflect.get(e2eDeps, "@playwright/test")
      : undefined;
  if (!manager.startsWith("pnpm@") || typeof playwright !== "string") {
    throw new Error("package.json's packageManager or tests/e2e's @playwright/test is not pinned");
  }
  return {
    NODE_VERSION: read(".nvmrc").trim(),
    PNPM_VERSION: manager.slice("pnpm@".length),
    PLAYWRIGHT_VERSION: playwright,
  };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function hasCommit(cwd: string, ref: string): boolean {
  try {
    git(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

const gitFiles = (top: string, flag: string) =>
  git(top, "ls-files", "-z", flag, "--exclude-standard").split("\0").filter(Boolean);

function buildContext(top: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bz-real-"));
  git(dir, "init", "--quiet");
  const refs = ["+HEAD:refs/heads/work"];
  if (hasCommit(top, "origin/main")) {
    refs.push("+refs/remotes/origin/main:refs/remotes/origin/main");
  }
  git(dir, "fetch", "--quiet", top, ...refs);
  git(dir, "checkout", "--quiet", "work");
  // `--modified` lists deleted files too.
  const deleted = new Set(gitFiles(top, "--deleted"));
  for (const file of deleted) rmSync(join(dir, file), { force: true });
  for (const file of [...gitFiles(top, "--modified"), ...gitFiles(top, "--others")]) {
    if (!deleted.has(file)) cpSync(join(top, file), join(dir, file), { force: true });
  }
  return dir;
}

// The host's own architecture: a shell's default platform can name one Docker would emulate.
const { DOCKER_DEFAULT_PLATFORM: _emulated, ...dockerEnv } = process.env;

function docker(args: string[]): boolean {
  return spawnSync("docker", args, { stdio: "inherit", env: dockerEnv }).status === 0;
}

function main(args: string[]): number {
  const suites = parseSuites(args);
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  const context = buildContext(top);
  const iidFile = join(tmpdir(), `${basename(context)}.iid`);
  try {
    const buildArgs = Object.entries(pins((p) => readFileSync(join(context, p), "utf8")));
    const built = docker([
      "build",
      "--iidfile",
      iidFile,
      // One tag per worktree, so a rebuild replaces its own image and no other worktree's.
      "--tag",
      `bazhen-test-real:${createHash("sha256").update(top).digest("hex").slice(0, 12)}`,
      ...buildArgs.flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
      "-f",
      join(context, "tests/real/Dockerfile"),
      context,
    ]);
    if (!built) return 1;
    // The images this replaced; one still running a suite is kept.
    docker(["image", "prune", "--force", "--filter", "label=org.bazhen.test-real=1"]);
    const image = readFileSync(iidFile, "utf8").trim();
    const failed = suites.filter(
      (suite) =>
        !docker([
          "run",
          "--rm",
          "--init",
          // Chromium needs more shared memory than a container's default 64 MB.
          "--shm-size",
          "1g",
          image,
          "pnpm",
          SUITES[suite],
        ]),
    );
    console.log(
      failed.length === 0
        ? `test:real: ${suites.join(", ")} passed`
        : `test:real: ${failed.join(", ")} failed`,
    );
    return failed.length === 0 ? 0 : 1;
  } finally {
    rmSync(context, { recursive: true, force: true });
    rmSync(iidFile, { force: true });
  }
}

if (isMain(import.meta)) process.exitCode = main(process.argv.slice(2));
