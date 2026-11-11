// Runs the generated .oxlintrc.json through the real oxlint on fixture files laid out like the
// repository, so the import matrix is checked as oxlint applies it, not just as JSON.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));

const FIXTURES: Record<string, string> = {
  "apps/web/src/a.ts":
    'export { a } from "../../../packages/core/src/ids.ts";\n' +
    'export { b } from "../../core/src/ids.ts";\n',
  "apps/daemon/src/b.medium.test.ts":
    'export { readFileSync } from "node:fs";\nexport { web } from "@bazhen/web";\n',
  "packages/core/src/c.test.ts": 'export { readFileSync } from "node:fs";\n',
};

type Diagnostic = { code?: string; filename?: string };

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bz-lint-config-"));
  for (const [file, text] of Object.entries(FIXTURES)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const config: Record<string, unknown> = JSON.parse(
    readFileSync(join(repo, ".oxlintrc.json"), "utf8"),
  );
  delete config["$schema"];
  writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify(config));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Rule codes oxlint reports for each fixture file, sorted. */
function ruleHits(): Record<string, string[]> {
  const out = spawnSync(
    join(repo, "node_modules/.bin/oxlint"),
    ["-c", ".oxlintrc.json", "--format", "json", ...Object.keys(FIXTURES)],
    { cwd: dir, encoding: "utf8" },
  );
  const parsed: { diagnostics: Diagnostic[] } = JSON.parse(out.stdout);
  const hits: Record<string, string[]> = Object.fromEntries(
    Object.keys(FIXTURES).map((file) => [file, []]),
  );
  for (const d of parsed.diagnostics) (hits[d.filename ?? "?"] ??= []).push(d.code ?? "?");
  return Object.fromEntries(Object.entries(hits).map(([file, codes]) => [file, codes.toSorted()]));
}

describe("the generated oxlint config, run by oxlint", () => {
  it("enforces the import matrix and the small-test bans by path", () => {
    expect(ruleHits()).toEqual({
      "apps/web/src/a.ts": ["eslint(no-restricted-imports)", "eslint(no-restricted-imports)"],
      "apps/daemon/src/b.medium.test.ts": ["eslint(no-restricted-imports)"],
      "packages/core/src/c.test.ts": ["eslint(no-restricted-imports)", "import(no-nodejs-modules)"],
    });
  });
});
