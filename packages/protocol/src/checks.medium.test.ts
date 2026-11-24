import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as protocol from "./index.ts";

/** Where `cargo xtask schema` writes the zod it generates from the Rust protocol. */
const GENERATED = new URL("../../../target/protocol-shadow/gen/protocol.ts", import.meta.url);

/** Text each rule should judge: plain, each kind of control and invisible, and at the budgets. */
const TEXTS = [
  "",
  "  ",
  "plain",
  "two\nlines",
  "a\ttab",
  "a\rreturn",
  "bell\u0007",
  "escape\u001b[1m",
  "del\u007f",
  "c1\u0085",
  "over‮ride",
  "isolate⁦",
  "zero​width",
  "word⁠joiner",
  "bom﻿",
  "tag\u{e0041}",
  "lone\ud83d",
  "pair😀",
  "é",
  "a".repeat(64),
  "a".repeat(65),
  "a".repeat(protocol.TASK_NOTE_MAX_BYTES),
  "a".repeat(protocol.TASK_NOTE_MAX_BYTES + 1),
  `${"é".repeat(protocol.TASK_NOTE_MAX_BYTES / 2)}a`,
];

const AGENT = "agent_01900000000070008000000000000000";

/** The generated module, or why it won't load. */
async function generated(): Promise<unknown> {
  try {
    return await import(GENERATED.href);
  } catch (error) {
    throw new Error(`${GENERATED.pathname} won't load: run \`scripts/xtask.sh schema\``, {
      cause: error,
    });
  }
}

/** The schema `module` exports as `name`. */
function schemaIn(module: unknown, name: string, what: string): z.ZodType {
  const value: unknown = Reflect.get(Object(module), name);
  if (!(value instanceof z.ZodType)) throw new Error(`${what} exports no schema ${name}`);
  return value;
}

/** What `schema` makes of `value`: what it takes, or each message it refuses with. */
function verdict(schema: z.ZodType, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { took: parsed.data }
    : { refused: parsed.error.issues.map((i) => i.message) };
}

/** Each message the protocol names whose schema a refinement judges, and the values to judge. */
const CASES: [string, unknown[]][] = [
  ["NewTaskTitle", TEXTS],
  ["TaskNoteText", TEXTS],
  ["FinishNoteText", TEXTS],
  ["HolderTitle", TEXTS.map((text) => ({ offset: 0, text }))],
  ["HolderOk", TEXTS.map((request) => ({ request }))],
  ["HolderScreen", TEXTS.map((text) => ({ text, history: 0 }))],
  [
    "HolderPasteRequest",
    TEXTS.flatMap((text) => [true, false].map((brackets) => ({ generation: 0, text, brackets }))),
  ],
  ["HolderTags", TEXTS.flatMap((text) => [{ [text]: "v" }, { k: text }])],
  [
    "DelegateTaskRequest",
    [
      { agentId: AGENT },
      { launch: { harness: "codex" } },
      { agentId: AGENT, launch: { harness: "codex" } },
      {},
    ].map((who) => ({ idempotencyKey: "k", title: "t", brief: "b", ...who })),
  ],
  [
    "OpenShellRequest",
    [{}, { cwd: "/tmp" }, { linkedAgentId: AGENT }, { linkedAgentId: AGENT, cwd: "/tmp" }].map(
      (shell) => ({ idempotencyKey: "k", ...shell }),
    ),
  ],
];

describe("the zod the Rust schema is written as", () => {
  it.each(CASES)(
    "judges a %s as the protocol does, with the protocol's messages",
    async (name, values) => {
      const theirs = schemaIn(await generated(), name, "the Rust schema's zod");
      const ours = schemaIn(protocol, name, "the protocol");
      for (const value of values) {
        expect({ value, ...verdict(theirs, value) }).toEqual({ value, ...verdict(ours, value) });
      }
    },
  );
});
