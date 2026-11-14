// Writes the protocol's JSON Schema into packages/protocol/schema/ (foundation-design §5.5), and
// the holder protocol's fixtures for its current version into
// packages/protocol/fixtures/holder/<version>/. With `--check`, writes nothing and fails when the
// committed files differ from a fresh export, so a protocol change can't ship without them. Only
// files git tracks count as committed: a generated file left unstaged would pass here and fail in
// CI. An older version's fixtures are never written: they are what its peers really sent.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDER_PROTOCOL_VERSION } from "../packages/protocol/src/holder.ts";
import { holderFixtures } from "../packages/protocol/src/holder-fixtures.ts";
import { jsonSchemas } from "../packages/protocol/src/json-schema.ts";
import { isMain } from "./is-main.ts";

/** The files that are missing, stale or extra in `actual`, compared with `expected`. */
export function drift(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): string[] {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...names].filter((name) => expected[name] !== actual[name]).toSorted();
}

const root = fileURLToPath(new URL("../packages/protocol/", import.meta.url));

/** Each generated directory, relative to the package, with the files it should hold. */
const outputs = (): Record<string, Record<string, string>> => ({
  "schema/": jsonSchemas(),
  [`fixtures/holder/${HOLDER_PROTOCOL_VERSION}/`]: holderFixtures(),
});

function committed(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const tracked = execFileSync("git", ["ls-files", "--", "*.json"], { cwd: dir, encoding: "utf8" });
  return Object.fromEntries(
    tracked
      .split("\n")
      .filter(Boolean)
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}

if (isMain(import.meta)) {
  const check = process.argv.includes("--check");
  let failed = false;
  for (const [relative, expected] of Object.entries(outputs())) {
    const dir = join(root, relative);
    const stale = drift(expected, committed(dir));
    if (check) {
      if (stale.length > 0) {
        console.error(
          `packages/protocol/${relative} is stale (${stale.join(", ")}): run \`pnpm schema\` and commit the result.`,
        );
        failed = true;
      }
      continue;
    }
    mkdirSync(dir, { recursive: true });
    for (const name of stale) {
      const content = expected[name];
      if (content === undefined) rmSync(join(dir, name));
      else writeFileSync(join(dir, name), content);
    }
  }
  if (failed) process.exit(1);
}
