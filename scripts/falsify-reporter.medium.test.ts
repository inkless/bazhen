// falsify's reporter run inside real vitest, on fixture tests in a temporary folder. The fixtures
// use vitest's globals and a plain-object config, so nothing has to resolve from that folder.

import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify, failureLine, isReport, type VitestReport } from "./falsify.ts";
import { RESULTS_FILE_ENV, partialReport } from "./falsify-reporter.ts";

const REPORTER = fileURLToPath(new URL("falsify-reporter.ts", import.meta.url));
const VITEST = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

const CONFIG = `export default { test: { globals: true, include: ["*.test.mjs"], testTimeout: 30000 } };\n`;

const FIXTURES = new URL("falsify-reporter.fixtures/", import.meta.url);
const fixture = (name: string, as: string) =>
  copyFileSync(fileURLToPath(new URL(name, FIXTURES)), join(dir, as));

const EVERY_KIND_TITLES = [
  "passes",
  "fails",
  "is skipped",
  "is to do",
  "shares a title",
  "fails nested",
  "times out",
  "passes on its retry",
  "fails every try",
  "is expected to fail",
  "passes concurrently",
  "fails concurrently",
  "passes before a failing afterAll",
];

const EVERY_KIND_OUTCOMES = [
  "passes: SURVIVED",
  "fails: KILLED",
  "is skipped: INVALID",
  "is to do: INVALID",
  "shares a title: INVALID",
  "fails nested: KILLED",
  "times out: INVALID",
  "passes on its retry: SURVIVED",
  "fails every try: KILLED",
  "is expected to fail: SURVIVED",
  "passes concurrently: SURVIVED",
  "fails concurrently: KILLED",
  "passes before a failing afterAll: SURVIVED",
  "loads: INVALID",
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bz-falsify-reporter-"));
  writeFileSync(join(dir, "vitest.config.mjs"), CONFIG);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const results = () => join(dir, "results.jsonl");
const jsonReport = () => join(dir, "report.json");
const gate = () => join(dir, "gate");
const waiting = () => join(dir, "waiting");

function startVitest(...files: string[]) {
  const child = spawn(
    "node",
    [
      VITEST,
      "run",
      "--root",
      dir,
      "--config",
      join(dir, "vitest.config.mjs"),
      `--reporter=${REPORTER}`,
      "--reporter=json",
      `--outputFile=${jsonReport()}`,
      ...files,
    ],
    {
      cwd: dir,
      env: { ...process.env, [RESULTS_FILE_ENV]: results(), GATE: gate(), WAITING: waiting() },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let said = "";
  child.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));
  return { exited: once(child, "exit"), said: () => said };
}

function readJsonReport(said: string): VitestReport {
  const full: unknown = existsSync(jsonReport())
    ? JSON.parse(readFileSync(jsonReport(), "utf8"))
    : undefined;
  if (!isReport(full)) throw new Error(`vitest wrote no JSON report:\n${said}`);
  return full;
}

const recorded = () => (existsSync(results()) ? readFileSync(results(), "utf8") : "");
const verdict = (report: VitestReport, file: string, title: string) => ({
  title,
  outcome: classify(report, file, title),
  failure: failureLine(report, file, title),
});

const everyKind = (report: VitestReport) => [
  ...EVERY_KIND_TITLES.map((t) => verdict(report, "every.test.mjs", t)),
  verdict(report, "broken.test.mjs", "loads"),
];
const outcomes = (verdicts: { title: string; outcome: string }[]) =>
  verdicts.map((v) => `${v.title}: ${v.outcome}`);

const gatedVerdicts = () =>
  ["fails first", "passes first", "waits on the gate"].map(
    (t) => verdict(partialReport(recorded()), "gated.test.mjs", t).outcome,
  );

describe("falsify's reporter", () => {
  it("gives every test of a run that ends the verdict its JSON report gives", async () => {
    fixture("every-kind.mjs", "every.test.mjs");
    fixture("broken.mjs", "broken.test.mjs");
    const run = startVitest();
    await run.exited;
    const full = readJsonReport(run.said());
    const fromJson = everyKind(full);
    expect(everyKind(partialReport(recorded()))).toEqual(fromJson);
    expect(outcomes(fromJson)).toEqual(EVERY_KIND_OUTCOMES);
    expect(fromJson.at(-1)?.failure).toMatch(/missing\.mjs/);
  }, 30_000);

  it("leaves the JSON report's verdicts as they were when it can't write", async () => {
    fixture("every-kind.mjs", "every.test.mjs");
    fixture("broken.mjs", "broken.test.mjs");
    mkdirSync(results());
    const run = startVitest();
    await run.exited;
    expect(outcomes(everyKind(readJsonReport(run.said())))).toEqual(EVERY_KIND_OUTCOMES);
  }, 30_000);

  it("leaves what a run stopped now would: the finished tests' verdicts, none for the rest", async () => {
    fixture("gated.mjs", "gated.test.mjs");
    const run = startVitest();
    try {
      // The gated test can't finish while the gate is shut, so this is where the lines stay.
      await expect.poll(() => existsSync(waiting()), { timeout: 20_000 }).toBe(true);
      expect(gatedVerdicts()).toEqual(["KILLED", "SURVIVED", "INVALID"]);
      expect(existsSync(jsonReport())).toBe(false);
    } finally {
      writeFileSync(gate(), "");
      await run.exited;
    }
    expect(gatedVerdicts()).toEqual(["KILLED", "SURVIVED", "SURVIVED"]);
  }, 60_000);
});
