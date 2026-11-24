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

/** A schema the protocol exports that the Rust protocol doesn't emit yet, with what owns it. */
interface NotYet {
  readonly name: string;
  readonly owner: string;
  readonly why: string;
}

const ATTENTION = "the attention routes' port";
const ATTENTION_WHY = "the Rust daemon serves no attention route yet";
const HOLDER = "this protocol's holder-proto schema";

/**
 * The schemas the protocol exports that the zod generated from the Rust protocol doesn't. A schema
 * exported and not listed fails, and so does an entry the generated zod now exports: the change
 * that emits a schema removes its entry.
 */
const NOT_YET_IN_RUST: readonly NotYet[] = [
  { name: "AnswerAttentionRequest", owner: ATTENTION, why: ATTENTION_WHY },
  { name: "AnswerAttentionResponse", owner: ATTENTION, why: ATTENTION_WHY },
  { name: "DismissAttentionRequest", owner: ATTENTION, why: ATTENTION_WHY },
  { name: "DismissAttentionResponse", owner: ATTENTION, why: ATTENTION_WHY },
  { name: "ReplyAttentionRequest", owner: ATTENTION, why: ATTENTION_WHY },
  { name: "ReplyAttentionResponse", owner: ATTENTION, why: ATTENTION_WHY },
  { name: "ResendAttentionRequest", owner: ATTENTION, why: ATTENTION_WHY },
  { name: "ResendAttentionResponse", owner: ATTENTION, why: ATTENTION_WHY },
  {
    name: "BroadcastMessageRequest",
    owner: "the mailbox routes' port",
    why: "the Rust daemon serves no mailbox route yet",
  },
  {
    name: "UnlinkShellRequest",
    owner: "the linked shells' port",
    why: "the Rust daemon serves no linked shell's route yet",
  },
  {
    name: "PaneTitleChanged",
    owner: "the tmux runtime",
    why: "/v1/codex/pane-title goes with tmux at the cutover, and is removed at the flip, not ported",
  },
  {
    name: "HolderHelloFrozen",
    owner: HOLDER,
    why: "the part of a hello every major reads first, to know which major the rest is in, which the holder's own hello holds inline",
  },
  {
    name: "HolderHelloReplyFrozen",
    owner: HOLDER,
    why: "the part of a hello reply every major reads first, which the holder's own reply holds inline",
  },
  {
    name: "HolderProcessSpec",
    owner: HOLDER,
    why: "the holder's requests write what a terminal runs inline",
  },
  {
    name: "HolderRequestName",
    owner: HOLDER,
    why: "the holder's requests name themselves inline, by each one's tag",
  },
];

/**
 * Each schema the protocol exports and `generated` doesn't, unlisted; each entry it does; and each
 * name listed more than once.
 */
function notYetInRust(generated: unknown) {
  const handOnly = Object.keys(protocol).filter(
    (name) => schemaIn(protocol, name) && !schemaIn(generated, name),
  );
  const names = NOT_YET_IN_RUST.map((entry) => entry.name);
  return {
    unlisted: handOnly.filter((name) => !names.includes(name)),
    duplicated: names.filter((name, at) => names.indexOf(name) !== at),
    emitted: NOT_YET_IN_RUST.filter((entry) => !handOnly.includes(entry.name)).map(
      (entry) => `${entry.name}, owned by ${entry.owner}`,
    ),
  };
}

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

/**
 * Lines `ShellCommandLine` is judged on, each of its rules met and broken: no message holds it,
 * so the corpus plants no case in it.
 */
const COMMAND_LINES = [
  "git status",
  "\u{1f600} caf\u00e9",
  "",
  " git status",
  "make\n",
  "a\x1b[Db",
  "a\u009bb",
  "ls \u202e/etc",
  "a\ud800b",
  "a\u200bb",
  "a\u2060b",
  "\u00e9".repeat(1024),
  `${"\u00e9".repeat(1024)}a`,
];

/** Whether `module`'s `ShellCommandLine` takes each of `COMMAND_LINES`. */
const judgedLines = (module: unknown) =>
  COMMAND_LINES.map((line) => schemaIn(module, "ShellCommandLine")?.safeParse(line).success);

describe("the protocol and the zod generated from the Rust protocol", async () => {
  const corpus = Corpus.parse(await shadowed("corpus.json", true)).default;
  const generated = await shadowed("gen/protocol.ts");
  const { found, parsed } = judge(corpus, generated);

  it("judge each planted case as the corpus expects", () => {
    expect(found).toEqual([]);
  });

  it("parse each case both take to the same value", () => {
    expect(Object.keys(parsed.protocol).length).toBeGreaterThan(0);
    expect(parsed.generated).toStrictEqual(parsed.protocol);
  });

  it("judge each command line ShellCommandLine is given alike", () => {
    expect(judgedLines(protocol)).toContain(true);
    expect(judgedLines(protocol)).toContain(false);
    expect(judgedLines(generated)).toEqual(judgedLines(protocol));
  });

  it("differ in the schemas they export only by those NOT_YET_IN_RUST lists", () => {
    expect(notYetInRust(generated)).toEqual({ unlisted: [], duplicated: [], emitted: [] });
  });
});
