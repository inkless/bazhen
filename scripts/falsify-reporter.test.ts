import { describe, expect, it } from "vitest";
import { classify, failureLine } from "./falsify.ts";
import { partialReport } from "./falsify-reporter.ts";

const FILE = "packages/core/src/x.test.ts";
const PATH = `/tmp/wt/${FILE}`;

const collected = (...tests: [id: string, title: string][]) =>
  JSON.stringify({
    kind: "collected",
    file: PATH,
    tests: tests.map(([id, title]) => ({ id, title })),
  });
const result = (id: string, status: string, failureMessages: string[] = [], file = PATH) =>
  JSON.stringify({ kind: "result", file, id, status, failureMessages });
const ended = (message: string) => JSON.stringify({ kind: "ended", file: PATH, message });
const lines = (...each: string[]) => each.map((l) => `${l}\n`).join("");

const verdicts = (text: string, ...titles: string[]) =>
  titles.map((title) => classify(partialReport(text), FILE, title));

describe("partialReport", () => {
  it("gives each finished test its verdict, and one that didn't finish none", () => {
    const text = lines(
      collected(["1", "fails"], ["2", "passes"], ["3", "unfinished"]),
      result("1", "failed", ["AssertionError: expected 1"]),
      result("2", "passed"),
    );
    expect(verdicts(text, "fails", "passes", "unfinished")).toEqual([
      "KILLED",
      "SURVIVED",
      "INVALID",
    ]);
    expect(failureLine(partialReport(text), FILE, "fails")).toBe("AssertionError: expected 1");
  });

  it("drops a last line a stopped run cut short", () => {
    const whole = lines(collected(["1", "t"]), result("1", "failed", ["boom"]));
    expect([
      verdicts(whole, "t"),
      verdicts(whole.slice(0, -1), "t"),
      verdicts(whole.slice(0, -8), "t"),
    ]).toEqual([["KILLED"], ["INVALID"], ["INVALID"]]);
  });

  it("gives no verdict to a result whose test no whole collected line names", () => {
    const cut = collected(["1", "t"]).slice(0, 20);
    expect([
      verdicts(lines(cut, result("1", "failed", ["boom"])), "t"),
      verdicts(lines(result("1", "failed", ["boom"])), "t"),
      verdicts(
        lines(collected(["1", "t"]), result("1", "failed", ["boom"], "/tmp/wt/y.test.ts")),
        "t",
      ),
    ]).toEqual([["INVALID"], ["INVALID"], ["INVALID"]]);
  });

  it("takes a test's last result, as the final one of its retries", () => {
    const text = lines(
      collected(["1", "t"]),
      result("1", "failed", ["boom"]),
      result("1", "passed"),
    );
    expect(verdicts(text, "t")).toEqual(["SURVIVED"]);
  });

  it("gives no verdict to a title two collected tests share, even when only one finished", () => {
    const text = lines(collected(["1", "t"], ["2", "t"]), result("1", "failed", ["boom"]));
    expect(verdicts(text, "t")).toEqual(["INVALID"]);
  });

  it("keeps the message of a module that ended without collecting, as one that won't load", () => {
    const report = partialReport(lines(ended("Failed to load url ./y.ts")));
    expect([classify(report, FILE, "t"), failureLine(report, FILE, "t")]).toEqual([
      "INVALID",
      "Failed to load url ./y.ts",
    ]);
  });

  it("skips a line that isn't one of its own, and reads the rest", () => {
    const text = lines(
      "not json",
      "[]",
      JSON.stringify({ kind: "result", file: PATH, id: "1", status: "failed" }),
      JSON.stringify({ kind: "collected", file: PATH, tests: [{ id: 1, title: "t" }] }),
      collected(["1", "t"]),
      result("1", "failed", ["boom"]),
    );
    expect(verdicts(text, "t")).toEqual(["KILLED"]);
  });
});
