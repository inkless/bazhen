// Runs the installed make, GNU Make 3.81 on macOS and 4.x on Linux, on the root Makefile and on one
// carrying only its settings: the ARGS convention and `make help` hold as make runs them, not just
// as scripts/check-standards.ts reads the file. Only `make -n` runs the root's targets, which runs
// just the `$(MAKE)` lines, and those under -n too.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MAKEFILE_SETTINGS, OWN_ARGS, makefileTargets, menuTargets } from "./check-standards.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "bz-makefile-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** What make prints for `args` in `cwd`, run as a person runs it, under no make of its own. */
function make(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const name of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES", "ARGS"])
    delete env[name];
  const run = spawnSync("make", args, { cwd, env, encoding: "utf8" });
  expect(run.stderr).toBe("");
  return run.stdout;
}

describe("the root Makefile under make", () => {
  it("lists on `make help` the targets with a `##`, and no others", () => {
    const listed = [...make(repo, "help").matchAll(/^ {2}([a-z][a-z0-9-]*) /gm)].map(
      ([, name]) => name,
    );
    const { targets } = makefileTargets(readFileSync(join(repo, "Makefile"), "utf8"));
    expect(new Set(listed)).toEqual(menuTargets(targets));
  });

  it("hands ARGS, quotes and `$` as written, to the named target's command and not its deps'", () => {
    const lines = make(repo, "-n", "test-bench", 'ARGS=-t "a $b"').trimEnd().split("\n");
    expect(lines.filter((line) => line.startsWith("cargo ")).map((line) => line.trimEnd())).toEqual(
      [
        "cargo build --release --quiet --locked -p bazhen-hook -p bazhen-peer",
        "cargo build --release --quiet --locked -p bazhen",
      ],
    );
    expect(lines.at(-1)).toBe(
      "node scripts/capped.ts --memory 4G --time 10m -- node_modules/.bin/vitest run --project bench " +
        '-t "a $b"',
    );
  });
});

describe("the Makefile's settings", () => {
  // `a` runs `b` as a dep and as a script would, and `b` prints the ARGS it got either way.
  const file = join(scratch, "Makefile");
  writeFileSync(
    file,
    [
      ...MAKEFILE_SETTINGS,
      ".PHONY: a b",
      "a:",
      "\t@$(MAKE) b",
      `\t@printf '<%s>' a ${OWN_ARGS} && env make b`,
      "b:",
      `\t@printf '<%s>' b ${OWN_ARGS} "$$ARGS" && echo`,
      "",
    ].join("\n"),
  );

  it("give ARGS to the named target alone: no dep's make, nor one its command starts, sees it", () => {
    expect(make(scratch, "a", "ARGS=--only 'x$' y")).toBe("<b><>\n<a><--only><x$><y><b><>\n");
  });
});
