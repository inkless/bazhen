import { describe, expect, it } from "vitest";
import {
  classify,
  newTitles,
  parseNameStatus,
  signalExitCode,
  staleWorktrees,
  type VitestReport,
} from "./falsify.ts";

const FILE = "packages/core/src/x.test.ts";

const diff = (...added: string[]) =>
  ["+++ b/" + FILE, " unchanged()", ...added.map((line) => `+${line}`)].join("\n");

type Assertion = VitestReport["testResults"][number]["assertionResults"][number];

const report = (...assertionResults: Assertion[]): VitestReport => ({
  testResults: [{ name: `/tmp/wt/${FILE}`, status: "failed", assertionResults }],
});

const result = (title: string, status: string, failureMessages: string[] = []): Assertion => ({
  title,
  status,
  failureMessages,
});

describe("newTitles", () => {
  it("reads single- and double-quoted titles from added lines only", () => {
    const text = [
      "+++ b/" + FILE,
      ' it("kept line", () => {})',
      '+  it("adds a", () => {});',
      "+  test('adds b', () => {});",
      '-  it("removed", () => {});',
    ].join("\n");
    expect(newTitles(text, FILE)).toEqual(["adds a", "adds b"]);
  });

  it("reads a backtick title without interpolation", () => {
    expect(newTitles(diff("it(`plain backtick`, () => {});"), FILE)).toEqual(["plain backtick"]);
  });

  it("marks a test whose title can't be read as unparsed", () => {
    expect(newTitles(diff("it(name, () => {});"), FILE)).toEqual([`<unparsed test in ${FILE}>`]);
  });

  it("marks an interpolated backtick title as unparsed", () => {
    expect(newTitles(diff("it(`adds ${n}`, () => {});"), FILE)).toEqual([
      `<unparsed test in ${FILE}>`,
    ]);
  });

  it("adds the unparsed marker for each unreadable test, alongside the readable titles", () => {
    expect(
      newTitles(diff('it("a", () => {});', "it(", '  "wrapped",', "it(`b ${x}`, f);"), FILE),
    ).toEqual(["a", `<unparsed test in ${FILE}>`]);
  });

  it("unescapes quotes inside the title", () => {
    expect(newTitles(diff(String.raw`it('doesn\'t say \"no\"', () => {});`), FILE)).toEqual([
      `doesn't say "no"`,
    ]);
  });

  it("reads the title of it.each", () => {
    expect(newTitles(diff('it.each([1, 2])("adds %i", (n) => {});'), FILE)).toEqual(["adds %i"]);
  });

  it("ignores a regex .test( call", () => {
    expect(newTitles(diff('const ok = /x/.test("abc");'), FILE)).toEqual([]);
  });
});

describe("classify", () => {
  it("calls a test that passes without the change SURVIVED", () => {
    expect(classify(report(result("t", "passed")), FILE, "t")).toBe("SURVIVED");
  });

  it("calls a test that fails without the change KILLED", () => {
    expect(classify(report(result("t", "failed", ["expected 1"])), FILE, "t")).toBe("KILLED");
  });

  it("calls a timed-out test INVALID", () => {
    const timedOut = result("t", "failed", ["Error: Test timed out in 5000ms."]);
    expect(classify(report(timedOut), FILE, "t")).toBe("INVALID");
  });

  it("calls a skipped test INVALID", () => {
    expect(classify(report(result("t", "skipped")), FILE, "t")).toBe("INVALID");
  });

  it("calls a test in a suite missing from the report INVALID", () => {
    expect(classify({ testResults: [] }, FILE, "t")).toBe("INVALID");
  });

  it("calls a title shared by two tests INVALID", () => {
    expect(classify(report(result("t", "failed"), result("t", "passed")), FILE, "t")).toBe(
      "INVALID",
    );
  });
});

describe("parseNameStatus", () => {
  it("reads plain statuses", () => {
    expect(parseNameStatus("M\ta.ts\nA\tb.ts\nD\tc.ts\n")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "A", path: "b.ts" },
      { status: "D", path: "c.ts" },
    ]);
  });

  it("keeps the old path of a rename", () => {
    expect(parseNameStatus("R087\told.test.ts\tnew.test.ts\n")).toEqual([
      { status: "R", path: "new.test.ts", oldPath: "old.test.ts" },
    ]);
  });
});

const porcelain = [
  "worktree /repo\nHEAD abc\nbranch refs/heads/main",
  "worktree /tmp/bz-falsify-dead\nHEAD abc\ndetached\nlocked bz-falsify pid=999999",
  "worktree /tmp/bz-falsify-live\nHEAD abc\ndetached\nlocked bz-falsify pid=42",
  "worktree /tmp/bz-falsify-unlocked\nHEAD abc\ndetached",
  "worktree /tmp/other\nHEAD abc\ndetached\nlocked bz-falsify pid=999999",
  "worktree /tmp/bz-falsify-mine\nHEAD abc\ndetached\nlocked someone else's reason",
].join("\n\n");

describe("staleWorktrees", () => {
  it("lists only bz-falsify- worktrees locked by a pid that is dead", () => {
    expect(staleWorktrees(porcelain, (pid) => pid === 42)).toEqual(["/tmp/bz-falsify-dead"]);
  });
});

describe("signalExitCode", () => {
  it("maps a child killed by SIGINT, SIGTERM or SIGHUP to 130, 143 or 129, and nothing else", () => {
    expect(
      [
        { signal: "SIGINT" },
        { signal: "SIGTERM" },
        { signal: "SIGHUP" },
        { signal: null },
        new Error("x"),
        null,
      ].map(signalExitCode),
    ).toEqual([130, 143, 129, undefined, undefined, undefined]);
  });
});
