import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANSWERS,
  LISTS,
  MESSAGES,
  RESULTS,
  SENT,
  STARTED,
  STARTS,
  codexFixture,
} from "./codex-fixtures.ts";
import { SCHEMA_DIR, messageProblems, problems, schemaFile } from "./codex-schema.ts";

const files = await codexFixture();
const reads: readonly { read: Readonly<Record<string, unknown>> }[] = JSON.parse(
  files["messages.json"] ?? "[]",
);
/** Each reader, and those that read something from some message. */
const READERS = Object.keys(reads[0]?.read ?? {});
const FOUND = new Set(
  reads.flatMap((m) =>
    Object.entries(m.read)
      .filter(([, v]) => v != null)
      .map(([k]) => k),
  ),
);
type Sent = { method: string; params: unknown };
const started: readonly { launch: { requests: Sent[] }; resume: { requests: Sent[] } }[] =
  JSON.parse(files["starts.json"] ?? "[]");
const sent = started.flatMap((s) => [...s.launch.requests, ...s.resume.requests]);
/** Each request the daemon sends that its method's params schema refuses, with why. */
const sentProblems = sent.flatMap((r) => {
  const file = SENT[r.method];
  if (file === undefined) return [{ method: r.method, problems: ["no schema for its params"] }];
  const found = problems(schemaFile(file), r.params);
  return found.length === 0 ? [] : [{ method: r.method, problems: found }];
});
const built: Readonly<Record<string, readonly { result: unknown }[]>> = JSON.parse(
  files["builders.json"] ?? "{}",
);
/** Each approval or question result that the schema of what it answers refuses, with why. */
const answerProblems = Object.entries(ANSWERS).flatMap(([builder, schemaFiles]) =>
  (built[builder] ?? []).flatMap(({ result }) =>
    schemaFiles.flatMap((file) => {
      const found = problems(schemaFile(file), result);
      return found.length === 0 ? [] : [{ builder, file, problems: found }];
    }),
  ),
);
const answersBuilt = Object.keys(ANSWERS).map((builder) => built[builder]?.length ?? 0);

const CLI = readFileSync(join(SCHEMA_DIR, "cli-version.txt"), "utf8").trim();
const PINS = readFileSync(
  fileURLToPath(new URL("../tests/api/package.json", import.meta.url)),
  "utf8",
);

/** Whether each case is valid against the schema, beside whether it is marked bad. */
const judged = (cases: readonly { name: string; bad?: true }[], valid: (i: number) => boolean) =>
  cases.map((c, i) => ({ name: c.name, bad: c.bad === true, valid: valid(i) }));
const misjudged = (cases: ReturnType<typeof judged>) => cases.filter((c) => c.valid === c.bad);

const RESUMED = schemaFile("ThreadResumeResponse.json");
const STARTED_SCHEMA = schemaFile("ThreadStartResponse.json");
const LISTED = schemaFile("ThreadListResponse.json");

const messages = judged(MESSAGES, (i) => {
  const m = MESSAGES[i]!;
  return messageProblems(m.method, m.params).length === 0;
});
const results = judged(RESULTS, (i) => problems(RESUMED, RESULTS[i]!.result).length === 0);
const lists = judged(LISTS, (i) => problems(LISTED, LISTS[i]!.result).length === 0);
const answered = STARTS.filter((s) => s.resumed !== undefined);
const resumes = judged(answered, (i) => problems(RESUMED, answered[i]!.resumed).length === 0);

describe("the codex fixture", () => {
  it("holds each message to Codex's schema, unless it is off the schema on purpose", () => {
    expect(misjudged(messages)).toEqual([]);
  });

  it("holds each answer to thread/resume and thread/list to Codex's schema the same way", () => {
    expect(misjudged(results)).toEqual([]);
    expect(misjudged(lists)).toEqual([]);
    expect(misjudged(resumes)).toEqual([]);
    expect(problems(STARTED_SCHEMA, STARTED)).toEqual([]);
  });

  it("holds each request the daemon sends to the schema of its method's params", () => {
    expect(new Set(sent.map((r) => r.method))).toEqual(new Set(Object.keys(SENT)));
    expect(sentProblems).toEqual([]);
  });

  it("holds each approval and question result to the schema of the request it answers", () => {
    expect(answersBuilt.every((n) => n > 0)).toBe(true);
    expect(answerProblems).toEqual([]);
  });

  // The control: a check that passed everything would pass the cases marked bad.
  it("has cases on the schema and off it, for each kind of input", () => {
    for (const cases of [messages, results, lists]) {
      expect(cases.map((c) => c.bad)).toContain(true);
      expect(cases.map((c) => c.bad)).toContain(false);
    }
  });

  it("was checked against the schema of the Codex CLI the api tests pin", () => {
    expect(CLI).toMatch(/^codex-cli \d+\.\d+\.\d+$/);
    expect(PINS).toContain(`"@openai/codex": "${CLI.slice("codex-cli ".length)}"`);
  });

  it("finds something with each reader", () => {
    expect(READERS.length).toBeGreaterThan(0);
    expect(READERS.filter((reader) => !FOUND.has(reader))).toEqual([]);
  });

  it("names its cases apart", () => {
    for (const cases of [MESSAGES, RESULTS, LISTS, STARTS]) {
      expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    }
  });
});
