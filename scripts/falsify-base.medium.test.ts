// Runs scripts/falsify-base.ts in a throwaway repository whose scripts/falsify.ts is a stub: with
// --harness it prints its own tree's harness.txt, so the base and the branch can list different
// files; otherwise it logs where it ran from and exits STUB_EXIT. A stub `pnpm` stands in for
// install.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("falsify-base.ts", import.meta.url));

const STUB_FALSIFY = `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--harness") {
  process.stdout.write(readFileSync(new URL("../harness.txt", import.meta.url), "utf8"));
  process.exit(0);
}
appendFileSync(process.env.STUB_LOG, \`FALSIFY \${import.meta.url} IN \${process.cwd()} \${args.join(" ")}\\n\`);
process.exit(Number(process.env.STUB_EXIT ?? "0"));
`;

const STUB_PNPM = `#!/bin/sh
echo "PNPM: $*" >> "$STUB_LOG"
[ "\${STUB_INSTALL_FAIL:-}" = 1 ] && exit 1
exit 0
`;

let root: string;
let repo: string;
let tmp: string;
let log: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return {
    ...clean,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
    TMPDIR: tmp,
    STUB_LOG: log,
    ...extra,
  };
}

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, env: env(), encoding: "utf8" });

function write(file: string, text: string): void {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), text);
}

function commit(files: Record<string, string>, message: string): void {
  for (const [file, text] of Object.entries(files)) write(file, text);
  git("add", ...Object.keys(files));
  git("commit", "--quiet", "-m", message);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bz-fixture-falsify-base-")));
  repo = join(root, "repo");
  tmp = join(root, "tmp");
  log = join(root, "stub.log");
  mkdirSync(tmp);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/pnpm"), STUB_PNPM);
  chmodSync(join(root, "bin/pnpm"), 0o755);
  writeFileSync(log, "");
  mkdirSync(repo);
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Falsify Test");
  git("config", "user.email", "falsify@example.com");
  commit(
    {
      "scripts/falsify.ts": STUB_FALSIFY,
      "scripts/base-only.ts": "export {};\n",
      "harness.txt": "scripts/falsify.ts\nscripts/base-only.ts\n",
      "package.json": "{}\n",
      "notes.txt": "one\n",
    },
    "base",
  );
  git("checkout", "--quiet", "-b", "work");
  // The branch's falsify no longer lists base-only.ts, so only the base's list names it.
  commit({ "harness.txt": "scripts/falsify.ts\n" }, "shorten the harness list");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function falsifyBase(extra: Record<string, string> = {}) {
  const result = spawnSync("node", [SCRIPT, "--base", "main"], {
    cwd: repo,
    env: env(extra),
    encoding: "utf8",
    timeout: 30_000,
  });
  const ran = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("FALSIFY "));
  return { status: result.status, ran, left: readdirSync(tmp) };
}

it("judges a branch that changes falsify with the base's falsify, on its exit code", () => {
  commit({ "scripts/falsify.ts": `${STUB_FALSIFY}// weakened\n` }, "change falsify");
  const { status, ran, left } = falsifyBase({ STUB_EXIT: "3" });
  expect({ status, ran: ran.length, left }).toEqual({ status: 3, ran: 1, left: [] });
  // The base's copy, from its worktree, judging the branch's checkout against the base ref.
  expect(ran[0]).toMatch(/^FALSIFY file:\/\/.*\/bz-falsify-[^/]+\/scripts\/falsify\.ts IN /);
  expect(ran[0]?.endsWith(` IN ${repo} --base main`)).toBe(true);
});

it("judges a change to a file only the base's harness lists", () => {
  commit({ "scripts/base-only.ts": "export const weaker = true;\n" }, "change base-only");
  expect(falsifyBase()).toEqual({ status: 0, ran: [expect.any(String)], left: [] });
});

it("judges a change to how falsify is run", () => {
  commit({ "package.json": '{ "scripts": {} }\n' }, "change package.json");
  expect(falsifyBase().ran).toHaveLength(1);
});

it("leaves a branch that changes none of falsify's files to falsify alone", () => {
  commit({ "notes.txt": "two\n" }, "change notes");
  expect(falsifyBase({ STUB_EXIT: "3" })).toEqual({ status: 0, ran: [], left: [] });
});

it("fails without judging when the base's dependencies don't install", () => {
  commit({ "scripts/falsify.ts": `${STUB_FALSIFY}// weakened\n` }, "change falsify");
  expect(falsifyBase({ STUB_INSTALL_FAIL: "1" })).toEqual({ status: 1, ran: [], left: [] });
});
