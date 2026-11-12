// `pnpm test:real [suite…] [--base <ref>]`: the real-tmux suites, in a container built from this
// worktree (docs/standards/testing.md). The build context is a fresh repository holding HEAD and
// falsify's base, overlaid with the worktree's uncommitted files, so falsify judges commits and
// the other suites test what is on disk. Each suite gets a container of its own, with nothing of
// the host's: no mount, no socket, no network.

import { execFileSync, spawnSync } from "node:child_process";
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
const DEFAULT_BASE = "origin/main";
/** What falsify's base is called inside the image, whatever it was called here. */
const BASE_REF = "refs/remotes/origin/main";

const isSuite = (name: string): name is Suite => Object.hasOwn(SUITES, name);
const USAGE = `usage: pnpm test:real [${Object.keys(SUITES).join("|")}]… [--base <ref>]`;

/** The suites named on the command line, in order, or the default set, and falsify's base. */
export function parseArgs(args: readonly string[]): { suites: Suite[]; base: string } {
  const at = args.indexOf("--base");
  const base = at === -1 ? DEFAULT_BASE : args[at + 1];
  const names = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  const unknown = names.filter((a) => !isSuite(a));
  if (base === undefined || base.startsWith("-") || unknown.length > 0) {
    throw new Error(unknown.length > 0 ? `unknown suite ${unknown.join(", ")}; ${USAGE}` : USAGE);
  }
  return {
    suites: names.length === 0 ? DEFAULT_SUITES : [...new Set(names.filter(isSuite))],
    base,
  };
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

const SECRET_NAME =
  /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519).*|\.npmrc|\.netrc)$/i;
const SECRET_WORD = /credential|secret/i;

/** Whether an untracked file looks like a secret, which never goes into an image. */
export function looksSecret(path: string): boolean {
  const name = basename(path);
  return SECRET_NAME.test(name) || SECRET_WORD.test(name);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const gitFiles = (top: string, flag: string) =>
  git(top, "ls-files", "-z", flag, "--exclude-standard").split("\0").filter(Boolean);

function buildContext(top: string, base: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bz-real-"));
  git(dir, "init", "--quiet");
  git(
    dir,
    "fetch",
    "--quiet",
    top,
    "+HEAD:refs/heads/work",
    `+${git(top, "rev-parse", base)}:${BASE_REF}`,
  );
  git(dir, "checkout", "--quiet", "work");
  // `--modified` lists deleted files too.
  const deleted = new Set(gitFiles(top, "--deleted"));
  for (const file of deleted) rmSync(join(dir, file), { force: true });
  const untracked = gitFiles(top, "--others");
  const skipped = untracked.filter(looksSecret);
  for (const file of [...gitFiles(top, "--modified"), ...untracked]) {
    if (!deleted.has(file) && !skipped.includes(file)) {
      cpSync(join(top, file), join(dir, file), { force: true });
    }
  }
  if (skipped.length > 0) console.warn(`test:real: left out of the image: ${skipped.join(", ")}`);
  return dir;
}

// The host's own architecture: a shell's default platform can name one Docker would emulate.
const { DOCKER_DEFAULT_PLATFORM: _emulated, ...dockerEnv } = process.env;

function docker(args: string[]): boolean {
  return spawnSync("docker", args, { stdio: "inherit", env: dockerEnv }).status === 0;
}

function main(args: string[]): number {
  const { suites, base } = parseArgs(args);
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  const context = buildContext(top, base);
  // A tag of this run's own, so a run elsewhere never removes the image this one is using.
  const image = `bazhen-test-real:${basename(context).replace(/[^\w.-]/g, "")}`;
  let built = false;
  try {
    built = docker([
      "build",
      "--tag",
      image,
      ...Object.entries(pins((p) => readFileSync(join(context, p), "utf8"))).flatMap(([k, v]) => [
        "--build-arg",
        `${k}=${v}`,
      ]),
      "-f",
      join(context, "tests/real/Dockerfile"),
      context,
    ]);
    if (!built) return 1;
    const failed = suites.filter(
      (suite) =>
        !docker([
          "run",
          "--rm",
          "--init",
          "--network",
          "none",
          // Chromium needs more shared memory than a container's default 64 MB.
          "--shm-size",
          "1g",
          image,
          "pnpm",
          SUITES[suite],
          ...(suite === "falsify" ? ["--base", BASE_REF] : []),
        ]),
    );
    console.log(
      failed.length === 0
        ? `test:real: ${suites.join(", ")} passed`
        : `test:real: ${failed.join(", ")} failed`,
    );
    return failed.length === 0 ? 0 : 1;
  } finally {
    if (built) docker(["image", "rm", image]);
    rmSync(context, { recursive: true, force: true });
  }
}

if (isMain(import.meta)) process.exitCode = main(process.argv.slice(2));
