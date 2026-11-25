import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as generated from "./gen/protocol.ts";
import * as protocol from "./index.ts";

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

/** Command lines, each of `ShellCommandLine`'s rules met and broken. */
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

const AGENT = "agent_01900000000070008000000000000000";

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
  ["ShellCommandLine", COMMAND_LINES],
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
      const theirs = schemaIn(generated, name, "the Rust schema's zod");
      const ours = schemaIn(protocol, name, "the protocol");
      for (const value of values) {
        expect({ value, ...verdict(theirs, value) }).toEqual({ value, ...verdict(ours, value) });
      }
    },
  );
});
