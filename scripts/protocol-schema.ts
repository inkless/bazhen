// Writes the protocol's JSON Schema into packages/protocol/schema/ (foundation-design §5.5). With
// `--check`, writes nothing and fails when the committed files differ from a fresh export, so a
// protocol change can't ship without its schema.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const dir = fileURLToPath(new URL("../packages/protocol/schema/", import.meta.url));

function committed(): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}

if (isMain(import.meta)) {
  const expected = jsonSchemas();
  const stale = drift(expected, committed());
  if (process.argv.includes("--check")) {
    if (stale.length > 0) {
      console.error(
        `packages/protocol/schema/ is stale (${stale.join(", ")}): run \`pnpm schema\` and commit the result.`,
      );
      process.exit(1);
    }
  } else {
    mkdirSync(dir, { recursive: true });
    for (const name of stale) {
      const content = expected[name];
      if (content === undefined) rmSync(join(dir, name));
      else writeFileSync(join(dir, name), content);
    }
  }
}
