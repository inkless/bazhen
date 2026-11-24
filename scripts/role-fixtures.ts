// What the TypeScript daemon makes of a role file's text, recorded for the Rust daemon, which reads
// role files too: for each case, the definition it reads or the problem it names. A problem a YAML
// syntax error raises is marked `syntax`, since only the words before the parser's own differ
// from one parser to another. The built-in roles are recorded as the daemon reads them.
// `moon run :schema` writes it to packages/protocol/fixtures/roles/.

import { builtinRoles, parseRole } from "../apps/daemon/src/roles/roles.ts";

/** A role file of front matter and a body, as one is written. */
const file = (front: string, body = "Do the work.") => `---\n${front}\n---\n${body}\n`;

/** The prefix of the problem a YAML syntax error raises; the parser's words follow it. */
export const SYNTAX = "its front matter isn't YAML: ";

interface Case {
  readonly name: string;
  readonly key?: string;
  readonly text: string;
}

const PROMPT_MAX = 10_000;

/** Front matter's every key, and how each kind of YAML scalar reads in it. */
const FRONT: readonly Case[] = [
  { name: "a title alone", text: file("title: Tester") },
  {
    name: "every key",
    text: file(
      "title: Tester\ndescription: Tests it.\ngrants: [worker, lead]\nsinglePerTask: true\nmaxActiveTasks: 2",
    ),
  },
  { name: "grants as a block list", text: file("title: T\ngrants:\n  - worker\n  - reviewer") },
  { name: "an empty grant list", text: file("title: T\ngrants: []") },
  { name: "a quoted title", text: file("title: 'Tester: the one'") },
  { name: "a double-quoted title with escapes", text: file('title: "Tab\\there \\u00e9"') },
  { name: "a block title", text: file("title: |\n  Two\n  lines") },
  { name: "a folded description", text: file("title: T\ndescription: >\n  one\n  two\n") },
  { name: "a multi-line plain title", text: file("title: Two\n  lines\n\n  and a third") },
  { name: "a multi-line plain description", text: file("title: T\ndescription: one\n  two") },
  { name: "keys a number and a string", text: file('title: T\n1: a\n"1": b') },
  { name: "keys a bool and a string", text: file("title: T\ntrue: a\n'true': b") },
  { name: "keys a number twice", text: file("title: T\n1: a\n1.0: b") },
  { name: "keys null twice", text: file("title: T\n~: a\nnull: b") },
  { name: "a title keyed twice by quoting", text: file("title: A\n'title': B") },
  { name: "a title trimmed", text: file("title: '  T  '") },
  { name: "a title of spaces", text: file("title: '   '") },
  { name: "an empty title", text: file("title: ''") },
  { name: "a title of 80", text: file(`title: ${"t".repeat(80)}`) },
  { name: "a title of 81", text: file(`title: ${"t".repeat(81)}`) },
  { name: "a title of 80 astral", text: file(`title: ${"😀".repeat(80)}`) },
  { name: "a title of 81 astral", text: file(`title: ${"😀".repeat(81)}`) },
  { name: "a title of 81 code units", text: file(`title: ${"😀".repeat(40)}t`) },
  { name: "a title of 81 combined", text: file(`title: ${"e\u0301".repeat(40)}e`) },
  { name: "a description of 500", text: file(`title: T\ndescription: ${"d".repeat(500)}`) },
  { name: "a description of 501", text: file(`title: T\ndescription: ${"d".repeat(501)}`) },
  { name: "a title in non-breaking spaces", text: file('title: "\\u00a0T\\u3000"') },
  { name: "a title in a byte order mark", text: file('title: "\\ufeffT\\ufeff"') },
  { name: "a title in next-lines", text: file('title: "\\u0085T\\u0085"') },
  { name: "a title in zero-width spaces", text: file('title: "\\u200bT"') },
  { name: "a number title", text: file("title: 12") },
  { name: "a bool title", text: file("title: true") },
  { name: "a null title", text: file("title: ~") },
  { name: "an empty title value", text: file("title:") },
  { name: "a list title", text: file("title: [a]") },
  { name: "a map title", text: file("title: {a: b}") },
  { name: "a null description", text: file("title: T\ndescription: null") },
  { name: "a number description", text: file("title: T\ndescription: 3") },
  { name: "singlePerTask True", text: file("title: T\nsinglePerTask: True") },
  { name: "singlePerTask FALSE", text: file("title: T\nsinglePerTask: FALSE") },
  { name: "singlePerTask yes", text: file("title: T\nsinglePerTask: yes") },
  { name: "singlePerTask quoted", text: file("title: T\nsinglePerTask: 'true'") },
  { name: "singlePerTask 1", text: file("title: T\nsinglePerTask: 1") },
  { name: "singlePerTask null", text: file("title: T\nsinglePerTask: null") },
  ...[
    "1",
    "+3",
    "007",
    "1.0",
    "2.",
    "1e1",
    "1.5e1",
    "0x10",
    "0o7",
    "0b1",
    "0",
    "-1",
    "1.5",
    ".5",
    "1_000",
    "'1'",
    "~",
    "null",
    "NULL",
    "Null",
    "nul",
    ".inf",
    "-.Inf",
    ".nan",
    ".NaN",
    "9007199254740993",
    "1e400",
    "[1]",
    "true",
  ].map((v) => ({ name: `maxActiveTasks ${v}`, text: file(`title: T\nmaxActiveTasks: ${v}`) })),
  { name: "grants not a list", text: file("title: T\ngrants: worker") },
  { name: "a grant of no valid role", text: file("title: T\ngrants: [Lead]") },
  { name: "a grant of a number", text: file("title: T\ngrants: [1]") },
  { name: "a grant of null", text: file("title: T\ngrants: [~]") },
  { name: "a second grant invalid", text: file("title: T\ngrants: [worker, 'a b']") },
  { name: "a grant of 33", text: file(`title: T\ngrants: [a${"b".repeat(32)}]`) },
  { name: "a grant of 32", text: file(`title: T\ngrants: [a${"b".repeat(31)}]`) },
  { name: "an unknown key", text: file("title: W\nmaxActiveTask: 1") },
  { name: "two unknown keys", text: file("title: W\nzed: 1\nalpha: 2") },
  { name: "an unknown key and a bad value", text: file("zed: 1\ntitle: 3") },
  { name: "a bad value then an unknown key", text: file("title: 3\nzed: 1") },
  { name: "two bad values", text: file("title: 3\ndescription: 4") },
  { name: "bad values out of order", text: file("description: 4\ntitle: 3") },
  { name: "a missing title and a bad grant", text: file("grants: [X]") },
  { name: "a quoted key", text: file('"title": T') },
  { name: "a number key", text: file("title: T\n1: x") },
  { name: "a comment", text: file("# a comment\ntitle: T # trailing") },
  { name: "a flow map", text: file("{title: T, singlePerTask: true}") },
  { name: "a duplicate key", text: file("title: A\ntitle: B") },
  { name: "front matter a scalar", text: file("hello") },
  { name: "front matter a list", text: file("- a") },
  { name: "front matter null", text: file("~") },
  { name: "front matter a comment", text: file("# nothing") },
  { name: "front matter blank", text: file("") },
  { name: "front matter of spaces", text: file("   ") },
  { name: "a document end marker", text: file("title: T\n...") },
  { name: "a tab in indentation", text: file("title: T\ngrants:\n\t- worker") },
  { name: "an unclosed flow", text: file("title: [unclosed\nsecret: hunter2") },
  { name: "a bad indent", text: file("title: T\n  description: d") },
  { name: "an unclosed quote", text: file("title: 'T") },
  { name: "a bad escape", text: file('title: "\\q"') },
  { name: "a lone colon", text: file(": x") },
];

/** Where front matter starts and ends, and what follows. */
const SHAPE: readonly Case[] = [
  { name: "no front matter", text: "Do the work." },
  { name: "front matter unclosed", text: "---\ntitle: T\nDo the work." },
  { name: "nothing between the lines", text: "---\n---\nDo the work." },
  { name: "a blank line between", text: "---\n\n---\nDo the work." },
  { name: "CRLF lines", text: "---\r\ntitle: T\r\n---\r\nDo the work.\r\n" },
  { name: "a closing line with spaces", text: "---\ntitle: T\n--- \t\nDo the work." },
  { name: "a closing line with text", text: "---\ntitle: T\n--- x\nDo the work.\n---\nmore" },
  { name: "a closing line at the end", text: "---\ntitle: T\n---" },
  { name: "a closing line of four", text: "---\ntitle: T\n----\nDo it.\n---\nAgain." },
  { name: "a body with its own rule", text: "---\ntitle: T\n---\nOne.\n---\nTwo.\n" },
  { name: "a space before the opening", text: " ---\ntitle: T\n---\nDo it." },
  { name: "a byte order mark first", text: "﻿---\ntitle: T\n---\nDo it." },
  { name: "an opening with spaces", text: "--- \ntitle: T\n---\nDo it." },
  { name: "a body of spaces", text: file("title: W", "  \n") },
  { name: "a body in a byte order mark", text: file("title: W", "﻿") },
  { name: "a body in next-lines", text: file("title: W", "\u0085x\u0085") },
  { name: "a body trimmed", text: file("title: W", "\n\n  Test it.  \n\n") },
  { name: "a body of 10000", text: file("title: W", "p".repeat(PROMPT_MAX)) },
  { name: "a body of 10001", text: file("title: W", "p".repeat(PROMPT_MAX + 1)) },
  { name: "a body of 10000 astral", text: file("title: W", "😀".repeat(PROMPT_MAX / 2)) },
  { name: "a body of 10001 astral", text: file("title: W", `${"😀".repeat(PROMPT_MAX / 2)}p`) },
  { name: "a body of 10000 accents", text: file("title: W", "é".repeat(PROMPT_MAX)) },
  { name: "a replacement character", text: file("title: W�", "x�") },
];

/** File names, as the role's key. */
const KEYS: readonly Case[] = [
  ...["Worker", "1worker", "-a", "a_b", "a.b", "", `a${"b".repeat(32)}`, "é"].map((key) => ({
    name: `a file named ${JSON.stringify(key)}`,
    key,
    text: file("title: W"),
  })),
  { name: "a file named a-1", key: "a-1", text: file("title: W") },
  { name: "a file of 32", key: `a${"b".repeat(31)}`, text: file("title: W") },
  { name: "a bad name and no front matter", key: "Bad", text: "x" },
];

const CASES: readonly Case[] = [...FRONT, ...SHAPE, ...KEYS];

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function roleFixture(): Record<string, string> {
  const names = new Set<string>();
  const cases = CASES.map(({ name, key = "tester", text }) => {
    if (names.has(name)) throw new Error(`two role fixture cases are named ${name}`);
    names.add(name);
    const parsed = parseRole(key, text, "user");
    if (!("problem" in parsed)) return { name, key, text, role: parsed };
    const syntax = parsed.problem.startsWith(SYNTAX);
    return { name, key, text, problem: parsed.problem, ...(syntax ? { syntax } : {}) };
  });
  return { "cases.json": json(cases), "builtins.json": json(builtinRoles()) };
}
