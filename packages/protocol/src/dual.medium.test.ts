import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as protocol from "./index.ts";

/** Where `cargo xtask schema` writes the zod it generates from the Rust protocol, and its corpus. */
const SHADOW = new URL("../../../target/protocol-shadow/", import.meta.url);

/** A planted case: a message's body, and whether the protocol takes it. */
const Case = z.object({
  schema: z.string(),
  path: z.string(),
  kind: z.string(),
  body: z.string(),
  expect: z.enum(["accept", "refuse"]),
});
type Case = z.infer<typeof Case>;

/** corpus.json, as a JSON module. */
const Corpus = z.object({ default: z.array(Case).min(1) });

type Side = "protocol" | "generated";
const SIDES: readonly Side[] = ["protocol", "generated"];

/** A case's key one side judges otherwise than the corpus expects, with what owns it and why. */
interface Known {
  readonly side: Side;
  readonly schema: string;
  readonly path: string;
  readonly kind: string;
  readonly owner: string;
  readonly why: string;
}

/**
 * Where a side judges a case otherwise than the corpus expects. Each case of an entry's key must
 * be judged so, by that side alone. The list only shrinks: an entry no case meets fails.
 */
const DUAL_KNOWN: readonly Known[] = [];

/** The module at `file` under the shadow, or why it won't load. */
async function shadowed(file: string, json = false): Promise<unknown> {
  const url = new URL(file, SHADOW);
  try {
    return await (json ? import(url.href, { with: { type: "json" } }) : import(url.href));
  } catch (error) {
    throw new Error(`${url.pathname} won't load: run \`scripts/xtask.sh schema\``, {
      cause: error,
    });
  }
}

/** The schema `module` exports as `name`, if any. */
function schemaIn(module: unknown, name: string): z.ZodType | undefined {
  const value: unknown = Reflect.get(Object(module), name);
  return value instanceof z.ZodType ? value : undefined;
}

const keyOf = (c: { schema: string; path: string; kind: string }) =>
  `${c.schema}${c.path} (${c.kind})`;

/** What the two sides make of the corpus. */
interface Judged {
  /** Each case judged otherwise than DUAL_KNOWN allows, each entry no case meets, and each schema
   * the corpus names that a side doesn't export. */
  readonly found: string[];
  /** What each side parses each case both take to, keyed by the case's place in the corpus. */
  readonly parsed: Record<Side, Record<string, unknown>>;
}

function judge(cases: readonly Case[], generated: unknown): Judged {
  const found: string[] = [];
  const parsed: Judged["parsed"] = { protocol: {}, generated: {} };
  const met = new Set<Known>();
  const unexported = new Set<string>();
  cases.forEach((c, at) => {
    const ours = schemaIn(protocol, c.schema);
    const theirs = schemaIn(generated, c.schema);
    if (!ours || !theirs) {
      unexported.add(c.schema);
      return;
    }
    const body: unknown = JSON.parse(c.body);
    const results = { protocol: ours.safeParse(body), generated: theirs.safeParse(body) };
    const off = SIDES.filter((side) => results[side].success !== (c.expect === "accept"));
    const known = DUAL_KNOWN.find((k) => keyOf(k) === keyOf(c));
    if (known) met.add(known);
    if (off.join() !== (known?.side ?? "")) {
      const listing = known ? ` (DUAL_KNOWN says the ${known.side} side alone: ${known.why})` : "";
      const sides = off.join(" and ") || "neither side";
      found.push(
        `${keyOf(c)}: ${sides} judges ${c.body} otherwise than the corpus's ${c.expect}${listing}`,
      );
    }
    if (results.protocol.success && results.generated.success) {
      const key = `${at} ${keyOf(c)}: ${c.body}`;
      parsed.protocol[key] = results.protocol.data;
      parsed.generated[key] = results.generated.data;
    }
  });
  for (const schema of unexported) found.push(`${schema}: not a schema both sides export`);
  for (const known of DUAL_KNOWN.filter((k) => !met.has(k))) {
    found.push(`DUAL_KNOWN lists ${keyOf(known)}, owned by ${known.owner}, which no case meets`);
  }
  return { found, parsed };
}

describe("the protocol and the zod generated from the Rust protocol", async () => {
  const corpus = Corpus.parse(await shadowed("corpus.json", true)).default;
  const { found, parsed } = judge(corpus, await shadowed("gen/protocol.ts"));

  it("judge each planted case as the corpus expects", () => {
    expect(found).toEqual([]);
  });

  it("parse each case both take to the same value", () => {
    expect(Object.keys(parsed.protocol).length).toBeGreaterThan(0);
    expect(parsed.generated).toStrictEqual(parsed.protocol);
  });
});
