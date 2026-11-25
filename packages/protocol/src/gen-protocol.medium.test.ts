import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiFixtures } from "./api-fixtures.ts";
import { wellFormed } from "./fixture-coverage.ts";
import * as generated from "./gen/protocol.ts";

/**
 * Each message the protocol's fixtures hold, by the file its writer gives it, which
 * `node scripts/protocol-schema.ts --check` holds the committed folder to. `checks.json` holds no
 * message.
 */
const messages = Object.keys(apiFixtures())
  .filter((file) => file !== "checks.json")
  .map((file) => file.slice(0, -".json".length));

/** A file imported as its text, which keeps a lone surrogate's escape that a JSON module refuses. */
const Raw = z.object({ default: z.string() });

/**
 * A fixture file: each example of its message, what was sent and what the protocol reads it as,
 * each lone surrogate in its text made U+FFFD, as the writer holds it.
 */
const Fixture = z
  .array(z.object({ name: z.string(), wire: z.unknown(), parsed: z.unknown() }))
  .min(1);

const schemas = new Map<string, unknown>(Object.entries(generated));

/** The generated schema of a message, or none. */
function schemaOf(message: string): z.ZodType | undefined {
  const schema = schemas.get(message);
  return schema instanceof z.ZodType ? schema : undefined;
}

/** A message's committed examples. */
async function examplesOf(message: string) {
  const url = new URL(`../fixtures/api/${message}.json`, import.meta.url);
  const text = Raw.parse(await import(`${url.href}?raw`)).default;
  return Fixture.parse(JSON.parse(text)).map((example) => ({ message, ...example }));
}

/** What the generated schema makes of an example, beside what the protocol made of it. */
function reading(example: Awaited<ReturnType<typeof examplesOf>>[number]) {
  const read = schemaOf(example.message)?.safeParse(example.wire);
  const at = { message: example.message, example: example.name };
  return {
    read: { ...at, value: wellFormed(read?.data), issues: read?.error?.issues ?? [] },
    expected: { ...at, value: example.parsed, issues: [] },
  };
}

const examples = (await Promise.all(messages.map(examplesOf))).flat();

/** Where `cargo xtask schema` writes the planted corpus, which `moon run :rust-schema-check` runs. */
const CORPUS = new URL("../../../target/protocol-shadow/corpus.json", import.meta.url);

/**
 * A planted case: a fixture example of a message broken or stretched at one field, and whether the
 * Rust protocol's schema takes it, as the keyword it was planted by says.
 */
const Case = z.object({
  schema: z.string(),
  path: z.string(),
  kind: z.string(),
  body: z.string(),
  expect: z.enum(["accept", "refuse"]),
});
type Case = z.infer<typeof Case>;

/** corpus.json, as a JSON module, or why it won't load. */
async function corpus(): Promise<Case[]> {
  try {
    const loaded: unknown = await import(CORPUS.href, { with: { type: "json" } });
    return z.object({ default: z.array(Case).min(1) }).parse(loaded).default;
  } catch (error) {
    throw new Error(`${CORPUS.pathname} won't load: run \`scripts/xtask.sh schema\``, {
      cause: error,
    });
  }
}

/** Where the generated schema judges a case otherwise than its keyword says, or has no schema. */
function misjudged(c: Case): string[] {
  const schema = schemaOf(c.schema);
  if (schema === undefined) return [`${c.schema}: no generated schema`];
  const takes = schema.safeParse(JSON.parse(c.body)).success;
  return takes === (c.expect === "accept")
    ? []
    : [`${c.schema}${c.path} (${c.kind}): ${takes ? "takes" : "refuses"} ${c.body}`];
}

const cases = await corpus();

describe("the zod the Rust protocol writes", () => {
  it("has a schema for each message the protocol's fixtures hold", () => {
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.filter((message) => schemaOf(message) === undefined)).toEqual([]);
  });

  it("reads each fixture's example as the protocol reads it", () => {
    expect(examples.length).toBeGreaterThan(messages.length);
    const readings = examples.map(reading);
    expect(readings.map((r) => r.read)).toEqual(readings.map((r) => r.expected));
  });

  it("judges each planted case as the Rust protocol's schema says", () => {
    expect(new Set(cases.map((c) => c.expect))).toEqual(new Set(["accept", "refuse"]));
    expect(cases.flatMap(misjudged)).toEqual([]);
  });
});
