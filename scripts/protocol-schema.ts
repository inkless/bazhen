// Writes the protocol's JSON Schema into packages/protocol/schema/ (foundation-design §5.5), the
// holder protocol's fixtures for its current version into
// packages/protocol/fixtures/holder/<version>/, and the API messages' fixtures, which hold other
// languages' types to these, into packages/protocol/fixtures/api/. With `--check`, writes nothing and fails when the
// committed files differ from a fresh export, so a protocol change can't ship without them. Only
// files git tracks count as committed: a generated file left unstaged would pass here and fail in
// CI. An older version's fixtures are never written: they are what its peers really sent, so
// each is pinned by its hash in FROZEN_HOLDER_FIXTURES, and both modes fail when one changes.
// It also writes the protocol id the Rust crates speak, crates/bazhen-protocol/src/id.rs, held
// to the same check.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiFixtures } from "../packages/protocol/src/api-fixtures.ts";
import { storeFixture } from "../apps/daemon/src/store/fixture.ts";
import { configFixture } from "../apps/daemon/src/config/fixture.ts";
import { HOLDER_PROTOCOL_VERSION } from "../packages/protocol/src/holder.ts";
import { holderFixtures } from "../packages/protocol/src/holder-fixtures.ts";
import { coreFixture } from "./core-fixtures.ts";
import { roleFixture } from "./role-fixtures.ts";
import { filesHash, protocolFiles, protocolId } from "../packages/protocol/src/id.ts";
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
export const FROZEN_HOLDER_FIXTURES: Readonly<Record<string, string>> = {
  "1.0": "95fc5e9e131f49682d48f9f38d0d95ef4f64027064cca1649465e4c9c9107657",
  "1.1": "ee44ec4937861b11b86e3224ca37ed6067982e2e03d51b438a39a0208216ef1d",
  "1.2": "600eb94fb9d51ad6a2016d16c5c305846ca4f718a11949b75107ebd1c6f21c53",
  "1.3": "3c2f3c0d11f50daf718d2edc8e687dae91b127b41424c2922f9803ecec66d466",
};

/**
 * Why the older versions' fixtures, keyed by version, don't match their pins: one unpinned,
 * edited since it was pinned, or gone.
 */
export async function frozenFailures(
  versions: Readonly<Record<string, Readonly<Record<string, string>>>>,
  current: string,
  pinned: Readonly<Record<string, string>> = FROZEN_HOLDER_FIXTURES,
): Promise<string[]> {
  const older = Object.entries(versions).filter(([version]) => version !== current);
  const judged = await Promise.all(
    older.map(async ([version, files]) => {
      const hash = await filesHash(files);
      const pin = pinned[version];
      if (pin === undefined) {
        return [
          `fixtures/holder/${version}/ is frozen: pin "${version}": "${hash}" in FROZEN_HOLDER_FIXTURES.`,
        ];
      }
      return pin === hash ? [] : [`fixtures/holder/${version}/ was changed after it froze.`];
    }),
  );
  const failures = judged.flat();
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
  "schema/": protocolFiles(),
  [`fixtures/holder/${HOLDER_PROTOCOL_VERSION}/`]: holderFixtures(),
  "fixtures/api/": apiFixtures(),
  "fixtures/store/": storeFixture(),
  "fixtures/config/": configFixture(),
  "fixtures/core/": coreFixture(),
  "fixtures/roles/": roleFixture(),
});

/** Where the Rust crates' protocol id is written, relative to the repository. */
const RUST_ID = "crates/bazhen-protocol/src/id.rs";

/** The Rust source that names `id` as the protocol the Rust crates speak. */
export function rustProtocolId(id: string): string {
  return [
    "//! The protocol this build speaks, as `protocolId()` in packages/protocol/src/id.ts hashes it.",
    "//! Written by `moon run :schema`, and held to it by `moon run :schema -- --check`: don't edit it by hand.",
    "",
    "/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\\0content\\0` in",
    "/// name order. A daemon that answers with another is another build, to restart.",
    `pub const PROTOCOL_ID: &str = "${id}";`,
    "",
  ].join("\n");
}

/** A file as git tracks it, or undefined when git doesn't: an unstaged one would pass in CI. */
function trackedFile(path: string): string | undefined {
  const repo = join(root, "../..");
  const tracked = execFileSync("git", ["ls-files", "--", path], { cwd: repo, encoding: "utf8" });
  return tracked.trim() === "" ? undefined : readFileSync(join(repo, path), "utf8");
}

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
          `packages/protocol/${relative} is stale (${stale.join(", ")}): run \`moon run :schema\` and commit the result.`,
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
  const rust = rustProtocolId(await protocolId());
  if (trackedFile(RUST_ID) !== rust) {
    if (check) {
      console.error(`${RUST_ID} is stale: run \`moon run :schema\` and commit the result.`);
      failed = true;
    } else {
      writeFileSync(join(root, "../..", RUST_ID), rust);
    }
  }
  const versions = existsSync(holderRoot) ? readdirSync(holderRoot) : [];
  const frozen = await frozenFailures(
    Object.fromEntries(versions.map((version) => [version, committed(join(holderRoot, version))])),
    HOLDER_PROTOCOL_VERSION,
  );
  for (const failure of frozen) console.error(`packages/protocol/${failure}`);
  if (failed || frozen.length > 0) process.exit(1);
}
