// Writes the protocol's JSON Schema into packages/protocol/schema/ (foundation-design §5.5), and
// the holder protocol's fixtures for its current version into
// packages/protocol/fixtures/holder/<version>/. With `--check`, writes nothing and fails when the
// committed files differ from a fresh export, so a protocol change can't ship without them. Only
// files git tracks count as committed: a generated file left unstaged would pass here and fail in
// CI. An older version's fixtures are never written: they are what its peers really sent, so
// each is pinned by its hash in FROZEN_HOLDER_FIXTURES, and both modes fail when one changes.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The hash of each older holder version's fixtures, once `HOLDER_PROTOCOL_VERSION` has moved past
 * it. Pin a version in the commit that moves past it, from the hash `--check` prints; a pin is
 * never changed after, as no peer can resend what that version sent.
 */
export const FROZEN_HOLDER_FIXTURES: Readonly<Record<string, string>> = {};

/** A directory's files, by name and content, as one hash. */
export function fixtureHash(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).toSorted()) hash.update(`${name}\0${files[name]}\0`);
  return hash.digest("hex");
}

/**
 * Why the older versions' fixtures, keyed by version, don't match their pins: one unpinned,
 * edited since it was pinned, or gone.
 */
export function frozenFailures(
  versions: Readonly<Record<string, Readonly<Record<string, string>>>>,
  current: string,
  pinned: Readonly<Record<string, string>> = FROZEN_HOLDER_FIXTURES,
): string[] {
  const older = Object.entries(versions).filter(([version]) => version !== current);
  const failures = older.flatMap(([version, files]) => {
    const hash = fixtureHash(files);
    const pin = pinned[version];
    if (pin === undefined) {
      return [
        `fixtures/holder/${version}/ is frozen: pin "${version}": "${hash}" in FROZEN_HOLDER_FIXTURES.`,
      ];
    }
    return pin === hash ? [] : [`fixtures/holder/${version}/ was changed after it froze.`];
  });
  const missing = Object.keys(pinned).filter((version) => !(version in versions));
  return [
    ...failures,
    ...missing.map((version) => `fixtures/holder/${version}/ is pinned but gone.`),
  ];
}

const root = fileURLToPath(new URL("../packages/protocol/", import.meta.url));
const holderRoot = join(root, "fixtures/holder");

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
  const versions = existsSync(holderRoot) ? readdirSync(holderRoot) : [];
  const frozen = frozenFailures(
    Object.fromEntries(versions.map((version) => [version, committed(join(holderRoot, version))])),
    HOLDER_PROTOCOL_VERSION,
  );
  for (const failure of frozen) console.error(`packages/protocol/${failure}`);
  if (failed || frozen.length > 0) process.exit(1);
}
