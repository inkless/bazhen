// falsify's own vitest reporter. vitest's JSON reporter writes only when the run ends, so a run
// stopped at falsify's cap leaves no report and no verdict for any of its tests. This one appends
// a line to the file RESULTS_FILE_ENV names as each test module is collected, each test finishes
// and each module ends, and `partialReport()` reads what a stopped run left into the JSON
// report's shape, giving each finished test the verdict the full report would have.
//
// A reporter hears of a result only when the worker sends it. A worker sends its updates through
// a 100 ms throttle that reads Date.now() while its timer runs on a coarser monotonic clock, so a
// deferred send often finds 100 ms or less has passed and isn't tried again: what it holds waits
// for the worker's first update more than 100 ms after its last send. A test that ends within
// 100 ms of that send, followed by one that runs until the run is stopped, may go unrecorded, and
// stays INVALID.
//
// A write that fails stops the record rather than throwing: vitest doesn't catch a throw from
// onTestModuleCollected, which would fail collection and change the JSON report's verdicts. The
// lines it misses leave their tests INVALID.
//
// falsify loads it from beside itself, not from its worktree, which may have reverted it.

import { appendFileSync } from "node:fs";
import type { Reporter, TestCase, TestModule } from "vitest/node";
import type { VitestReport } from "./falsify.ts";

export const RESULTS_FILE_ENV = "BZ_FALSIFY_RESULTS_FILE";
/** The status of a collected test with no result: the JSON report's, for a test still running. */
export const UNFINISHED = "pending";

type Line =
  | { kind: "collected"; file: string; tests: { id: string; title: string }[] }
  | { kind: "result"; file: string; id: string; status: string; failureMessages: string[] }
  | { kind: "ended"; file: string; message: string };

export default class FalsifyReporter implements Reporter {
  readonly #file: string;
  #broken = false;

  constructor() {
    const file = process.env[RESULTS_FILE_ENV];
    if (file === undefined || file === "") {
      throw new Error(`falsify's reporter needs ${RESULTS_FILE_ENV} to name the file it writes`);
    }
    this.#file = file;
  }

  #write(line: Line): void {
    if (this.#broken) return;
    try {
      appendFileSync(this.#file, `${JSON.stringify(line)}\n`);
    } catch {
      this.#broken = true;
    }
  }

  onTestModuleCollected(module: TestModule): void {
    const tests = [...module.children.allTests()].map((t) => ({ id: t.id, title: t.name }));
    this.#write({ kind: "collected", file: module.moduleId, tests });
  }

  onTestCaseResult(test: TestCase): void {
    const result = test.result();
    this.#write({
      kind: "result",
      file: test.module.moduleId,
      id: test.id,
      status: result.state,
      failureMessages: (result.errors ?? []).map((e) => e.stack || e.message),
    });
  }

  onTestModuleEnd(module: TestModule): void {
    this.#write({
      kind: "ended",
      file: module.moduleId,
      message: module.errors()[0]?.message ?? "",
    });
  }
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.entries(value).find(([k]) => k === key)?.[1]
    : undefined;

function testsOf(value: unknown): { id: string; title: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tests = value.map((t: unknown) => ({ id: field(t, "id"), title: field(t, "title") }));
  return tests.every((t) => isString(t.id) && isString(t.title))
    ? tests.map((t) => ({ id: String(t.id), title: String(t.title) }))
    : undefined;
}

function lineOf(text: string): Line | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const file = field(value, "file");
  if (!isString(file)) return undefined;
  const kind = field(value, "kind");
  if (kind === "collected") {
    const tests = testsOf(field(value, "tests"));
    return tests && { kind, file, tests };
  }
  if (kind === "result") {
    const [id, status, failureMessages] = ["id", "status", "failureMessages"].map((k) =>
      field(value, k),
    );
    return isString(id) && isString(status) && isStrings(failureMessages)
      ? { kind, file, id, status, failureMessages }
      : undefined;
  }
  const message = field(value, "message");
  return kind === "ended" && isString(message) ? { kind, file, message } : undefined;
}

/**
 * What a run's reporter lines say, as a vitest JSON report. Only lines ended by a newline count:
 * a run killed mid-write leaves its last one cut short. A collected test with no result is
 * `pending`, and every collected test is kept, so a title two tests share still matches none.
 * A result for a test no collected line names is dropped. Each of these leaves the test with no
 * verdict.
 */
export function partialReport(text: string): VitestReport {
  const suites = new Map<string, VitestReport["testResults"][number]>();
  const byId = new Map<string, { file: string; index: number }>();
  const suiteOf = (file: string) => {
    const known = suites.get(file);
    if (known !== undefined) return known;
    const suite = { name: file, message: "", assertionResults: [] };
    suites.set(file, suite);
    return suite;
  };
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  for (const raw of complete.split("\n")) {
    const line = lineOf(raw);
    if (line === undefined) continue;
    if (line.kind === "collected") {
      const suite = suiteOf(line.file);
      for (const t of line.tests) {
        byId.set(t.id, { file: line.file, index: suite.assertionResults.length });
        suite.assertionResults.push({ title: t.title, status: UNFINISHED, failureMessages: [] });
      }
    } else if (line.kind === "result") {
      const at = byId.get(line.id);
      const test =
        at?.file === line.file ? suites.get(at.file)?.assertionResults[at.index] : undefined;
      if (test === undefined) continue;
      test.status = line.status;
      test.failureMessages = line.failureMessages;
    } else {
      suiteOf(line.file).message = line.message;
    }
  }
  return { testResults: [...suites.values()] };
}
