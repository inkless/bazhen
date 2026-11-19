// Runs the api test files tests/rust-daemon.txt lists against the Rust daemon, while both daemons
// are built: each file there passes on it, and a file leaves the list only by the cutover. With
// --base <ref>, it first refuses a list that lost a line against that ref's, so none leaves quietly:
// a ref that doesn't resolve to a commit fails the run, and a file git sees renamed counts under its
// new name. It then fails a listed file that ran no test, or skipped or left one to do, so a file
// can't stay listed by running nothing.
//
// Usage: node scripts/rust-daemon.ts [--base <ref>]

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
export const LIST = "tests/rust-daemon.txt";
/** The variable naming the daemon binary the api suite starts in place of the TypeScript one. */
export const SELECTOR = "BAZHEN_TEST_DAEMON_BIN";
/** The daemon the files run against, in target/: the release build `pnpm build:daemon` makes. */
export const DAEMON = "target/release/bazhen-daemon";
export const DAEMON_BIN = join(root, DAEMON);

/** The files a list names, one per line, blank lines and `#` comments aside. */
export function listed(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** What is wrong with a list: each file it names that isn't an api test file, or isn't there. */
export function problems(files: readonly string[], exists: (path: string) => boolean): string[] {
  const seen = new Set<string>();
  return files.flatMap((file) => {
    if (seen.has(file)) return [`${LIST} names ${file} twice`];
    seen.add(file);
    if (!/^tests\/api\/[^/]+\.test\.ts$/.test(file)) {
      return [`${LIST} names ${file}, which isn't a tests/api/*.test.ts file`];
    }
    return exists(file) ? [] : [`${LIST} names ${file}, which doesn't exist`];
  });
}

/**
 * Each file the base's list named that this one doesn't, under the name `renamed` gives it, if
 * any: a file renamed and listed by its new name is still listed.
 */
export function removed(
  base: readonly string[],
  now: readonly string[],
  renamed: ReadonlyMap<string, string> = new Map(),
): string[] {
  return base.filter((file) => !now.includes(renamed.get(file) ?? file));
}

/** A git run in the checkout: its exit status and what it printed. */
export type Git = (args: readonly string[]) => { status: number | null; stdout: string };

const git: Git = (args) => {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout };
};

/**
 * The files `ref`'s list names, or why they can't be known. A ref that isn't a commit is an error,
 * never an empty list, so a base that didn't resolve can't pass the ratchet; a commit from before
 * the list names nothing a branch could lose.
 */
export function baseList(ref: string, run: Git): string[] | { error: string } {
  if (run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status !== 0) {
    return { error: `the base ${ref} isn't a commit here: fetch it, or name another` };
  }
  const tree = run(["ls-tree", "--name-only", ref, "--", LIST]);
  if (tree.status !== 0) return { error: `can't read ${ref}'s tree` };
  if (tree.stdout.trim() === "") return [];
  const shown = run(["show", `${ref}:${LIST}`]);
  return shown.status === 0 ? listed(shown.stdout) : { error: `can't read ${LIST} at ${ref}` };
}

/** Each api test file git sees renamed between `ref` and the work tree: old name to new. */
export function renamesSince(ref: string, run: Git): Map<string, string> | { error: string } {
  const diff = run(["diff", "--name-status", "-M", "--diff-filter=R", ref, "--", "tests/api"]);
  if (diff.status !== 0) return { error: `can't diff against ${ref}` };
  return new Map(
    diff.stdout.split("\n").flatMap((line) => {
      const [, from, to] = line.split("\t");
      return from === undefined || to === undefined ? [] : [[from, to] as const];
    }),
  );
}

/** What vitest's JSON reporter says of each file it ran, as far as the ratchet reads it. */
export interface Report {
  readonly testResults: readonly {
    readonly name: string;
    readonly assertionResults: readonly { readonly fullName: string; readonly status: string }[];
  }[];
}

const isText = (v: unknown) => typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Whether `value` reads as a `Report`: each file a name, and each test a name and a status. */
export function isReport(value: unknown): value is Report {
  return (
    isObject(value) &&
    Array.isArray(value["testResults"]) &&
    value["testResults"].every(
      (file: unknown) =>
        isObject(file) &&
        isText(file["name"]) &&
        Array.isArray(file["assertionResults"]) &&
        file["assertionResults"].every(
          (test: unknown) => isObject(test) && isText(test["fullName"]) && isText(test["status"]),
        ),
    )
  );
}

/**
 * Each listed file that ran no test, and each test of one that didn't run: skipped, to do or
 * otherwise neither passed nor failed. Names in `report` are absolute, under `under`.
 */
export function unrun(files: readonly string[], report: Report, under: string): string[] {
  const byFile = new Map(report.testResults.map((r) => [relative(under, r.name), r]));
  return files.flatMap((file) => {
    const tests = byFile.get(file)?.assertionResults ?? [];
    if (tests.length === 0) return [`${file} ran no test against the Rust daemon`];
    return tests.flatMap((t) =>
      t.status === "passed" || t.status === "failed"
        ? []
        : [`${file} › ${t.fullName} was ${t.status}: a listed file runs every test it has`],
    );
  });
}

/** The listed files run against the daemon: vitest's exit status, and its report if it wrote one. */
export type RunFiles = (files: readonly string[]) => { status: number | null; report?: Report };

const runFiles: RunFiles = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "bz-rust-daemon-"));
  const out = join(dir, "report.json");
  try {
    const run = spawnSync(
      "vitest",
      [
        "run",
        "--project",
        "api",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${out}`,
        ...files,
      ],
      { cwd: root, stdio: "inherit", env: { ...process.env, [SELECTOR]: DAEMON_BIN } },
    );
    const read: unknown = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined;
    const report = isReport(read) ? read : undefined;
    return { status: run.status, ...(report !== undefined && { report }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** What `main` reaches outside itself, so a test can stand in for each. */
export interface World {
  readonly read: (file: string) => string;
  readonly exists: (file: string) => boolean;
  readonly git: Git;
  readonly run: RunFiles;
  readonly error: (line: string) => void;
}

const world: World = {
  read: (file) => readFileSync(join(root, file), "utf8"),
  exists: (file) => existsSync(file.startsWith("/") ? file : join(root, file)),
  git,
  run: runFiles,
  error: (line) => console.error(line),
};

export function main(args: readonly string[], w: World = world, under = root): number {
  const at = args.indexOf("--base");
  const base = at === -1 ? undefined : args[at + 1];
  if (at !== -1 && base === undefined) {
    w.error("usage: node scripts/rust-daemon.ts [--base <ref>]");
    return 2;
  }
  const files = listed(w.read(LIST));
  const wrong = [...problems(files, w.exists), ...lost(files, base, w.git)];
  if (files.length === 0) wrong.push(`${LIST} names no file`);
  if (!w.exists(DAEMON_BIN)) wrong.push(`no ${DAEMON_BIN}: run pnpm build:daemon`);
  if (wrong.length === 0) {
    const ran = w.run(files);
    if (ran.report === undefined) wrong.push("vitest wrote no report");
    else wrong.push(...unrun(files, ran.report, under));
    if (wrong.length === 0) return ran.status ?? 1;
  }
  for (const line of wrong) w.error(line);
  return 1;
}

/** Why the list fails the ratchet against `base`: each line it lost, or why that can't be known. */
function lost(files: readonly string[], base: string | undefined, run: Git): string[] {
  if (base === undefined) return [];
  const before = baseList(base, run);
  if ("error" in before) return [before.error];
  const renamed = renamesSince(base, run);
  if ("error" in renamed) return [renamed.error];
  return removed(before, files, renamed).map(
    (file) => `${LIST} lost ${file} against ${base}: a file leaves it only at the cutover`,
  );
}

if (isMain(import.meta)) process.exitCode = main(process.argv.slice(2));
