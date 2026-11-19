// Runs the api test files tests/rust-daemon.txt lists against the Rust daemon, while both daemons
// are built: each file there passes on it, and a file leaves the list only by the cutover. With
// --base <ref>, it first refuses a list that lost a line against that ref's, so none leaves quietly.
//
// Usage: node scripts/rust-daemon.ts [--base <ref>]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
export const LIST = "tests/rust-daemon.txt";
/** The daemon the files run against: the release build `pnpm build:daemon` makes. */
export const DAEMON_BIN = join(root, "target/release/bazhen-daemon");

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

/** Each file the base's list named that this one doesn't. */
export function removed(base: readonly string[], now: readonly string[]): string[] {
  return base.filter((file) => !now.includes(file));
}

function baseList(ref: string): string[] {
  const shown = spawnSync("git", ["show", `${ref}:${LIST}`], { cwd: root, encoding: "utf8" });
  // A base from before the list names nothing a branch could lose.
  return shown.status === 0 ? listed(shown.stdout) : [];
}

function main(args: string[]): number {
  const at = args.indexOf("--base");
  const base = at === -1 ? undefined : args[at + 1];
  if (at !== -1 && base === undefined) {
    console.error("usage: node scripts/rust-daemon.ts [--base <ref>]");
    return 2;
  }
  const files = listed(readFileSync(join(root, LIST), "utf8"));
  const wrong = [
    ...problems(files, (file) => existsSync(join(root, file))),
    ...(base === undefined ? [] : removed(baseList(base), files)).map(
      (file) => `${LIST} lost ${file} against ${base}: a file leaves it only at the cutover`,
    ),
  ];
  if (files.length === 0) wrong.push(`${LIST} names no file`);
  if (!existsSync(DAEMON_BIN)) wrong.push(`no ${DAEMON_BIN}: run pnpm build:daemon`);
  if (wrong.length > 0) {
    for (const line of wrong) console.error(line);
    return 1;
  }
  const run = spawnSync("vitest", ["run", "--project", "api", ...files], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, BAZHEN_DAEMON_BIN: DAEMON_BIN },
  });
  return run.status ?? 1;
}

if (isMain(import.meta)) process.exitCode = main(process.argv.slice(2));
