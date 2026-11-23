import { describe, expect, it } from "vitest";
import {
  brokenPathRefusal,
  classify,
  crateBinaries,
  failedInTest,
  failedOnOwnAssertion,
  closedBlock,
  guardErrors,
  guardsOf,
  isFailsTest,
  numstatPaths,
  onBothDaemons,
  unrunReason,
  failureLine,
  harnessFiles,
  indentedTail,
  controlLine,
  addedRustTests,
  appliedRenames,
  binaryInputs,
  cargoErrors,
  depInfoSources,
  binariesOf,
  isRevertible,
  leavableTestFiles,
  manifestNames,
  namedBinaries,
  workspaceBins,
  workspaceExports,
  changedTests,
  counterparts,
  noOutputReason,
  timeoutFrom,
  leftRunning,
  parseArgs,
  parseNameStatus,
  projectsOf,
  relatedReverts,
  renamedFrom,
  renameRefusal,
  renameTrailers,
  revertsOf,
  rustTestIds,
  signalExitCode,
  staleWorktrees,
  uncontrolledRustTests,
  uncontrolledTests,
  type VitestReport,
} from "./falsify.ts";
import { report as cappedReport } from "./capped.ts";

const FILE = "packages/core/src/x.test.ts";

type Assertion = VitestReport["testResults"][number]["assertionResults"][number];

const report = (...assertionResults: Assertion[]): VitestReport => ({
  testResults: [{ name: `/tmp/wt/${FILE}`, assertionResults }],
});

const result = (title: string, status: string, failureMessages: string[] = []): Assertion => ({
  title,
  status,
  failureMessages,
});

const changed = (base: string | undefined, head: string) =>
  changedTests({ file: FILE, base, head }).titles;

const UNPARSED = `<unparsed test in ${FILE}>`;

describe("changedTests", () => {
  it("is each title HEAD has a test under and the base has none, in a new file too", () => {
    const base = 'it("kept", () => {});\nit("removed", () => {});\n';
    const head = 'it("kept", () => {});\nit("adds a", () => {});\ntest(\'adds b\', () => {});\n';
    expect([changed(base, head), changed(undefined, head)]).toEqual([
      ["adds a", "adds b"],
      ["kept", "adds a", "adds b"],
    ]);
  });

  it("leaves out a test that moved, even where the diff reads it as removed and added", () => {
    const signals =
      'it("signals a running process", () => {\n  expect(signal(p)).toBe(true);\n});\n';
    const other = 'describe("other", () => {\n  it("moves", () => {});\n});\n';
    expect(changed(other + signals, `${signals}${other}it("is new", () => {});\n`)).toEqual([
      "is new",
    ]);
  });

  it("leaves out a test whose body, layout or async changed under its title", () => {
    const base = 'it("was sync", () => {\n  expect(read()).toBe(1);\n});\n';
    const head =
      'it(\n  "was sync",\n  async () => {\n    expect(await read()).toBe(2);\n  },\n);\n';
    expect(changed(base, head)).toEqual([]);
  });

  it("judges a title HEAD has more tests under than the base, once", () => {
    const one = 'it("twice", () => {});\n';
    expect([changed(one, one + one), changed(one, one + one + one)]).toEqual([
      ["twice"],
      ["twice"],
    ]);
  });

  it("reads the title a chain's call wraps onto its next line", () => {
    const head = 'it.runIf(linux)(\n  "integrates the shell",\n  async () => {},\n);\n';
    expect(changed("", head)).toEqual(["integrates the shell"]);
  });

  it("marks a new test whose title can't be read as unparsed, once, by its title's tokens", () => {
    const base = "it(name, () => {});\n";
    expect([
      changed(base, base),
      changed(base, `${base}it(other, () => {});\nit(\`adds \${n}\`, f);\nit("a", f);\n`),
    ]).toEqual([[], [UNPARSED, "a"]]);
  });

  it("finds no test in a fixture string", () => {
    expect(changed("", "const fixture = 'it(\"fixture\", f)';\n")).toEqual([]);
  });

  it("marks a .tsx file as unparsed, since its JSX can't be read, and says why", () => {
    const tsx = "packages/a/src/view.test.tsx";
    const head = 'it("renders", () => {\n  render(<p>Don\'t</p>);\n});\n';
    expect(changedTests({ file: tsx, base: head, head })).toEqual({
      titles: [`<unparsed test in ${tsx}>`],
      unreadable: "falsify reads tests only from .ts, .mts and .cts files",
    });
  });

  it("marks a .ts file git renamed from one that isn't TypeScript as unparsed, since its base's JSX can fake a test call", () => {
    const base = lines(
      'it("renders", () => {',
      '  render(<p>it("adds a", () => {})</p>, <b>x</b>);',
      "});",
    );
    const head = lines('it("renders", () => {});', 'it("adds a", () => {});');
    const pairedWith = (counterpart: string) =>
      changedTests({ file: FILE, base, head, counterpart });
    const others = ["x.test.tsx", "x.test.jsx", "x.test.TS", "x.mdx"].map(
      (p) => `packages/core/src/${p}`,
    );
    expect([pairedWith("packages/core/src/x.test.mts"), ...others.map(pairedWith)]).toEqual([
      { titles: [] },
      ...others.map((counterpart) => ({
        titles: [UNPARSED],
        unreadable: `falsify reads tests only from .ts, .mts and .cts files, and its base copy is ${counterpart}`,
      })),
    ]);
  });

  it("marks a file either side of which can't be read as unparsed, and says why", () => {
    const good = 'it("a", () => {});\n';
    expect([
      changedTests({ file: FILE, base: 'it("a", () => {;\n', head: good }),
      changedTests({ file: FILE, base: good, head: 'it("a, () => {});\n' }),
    ]).toEqual([
      { titles: [UNPARSED], unreadable: "the base's copy has brackets left open at its end" },
      { titles: [UNPARSED], unreadable: expect.stringMatching(/^HEAD's copy has an unterminated/) },
    ]);
  });
});

const nextestList = (suites: Record<string, string[]>) => ({
  "rust-suites": Object.fromEntries(
    Object.entries(suites).map(([binary, names]) => [
      binary,
      { testcases: Object.fromEntries(names.map((n) => [n, { "filter-match": {} }])) },
    ]),
  ),
});

describe("rustTestIds", () => {
  it("names each test by its target and full path, a crate's lib and bins sharing one", () => {
    expect(
      rustTestIds(
        nextestList({
          "bazhen-hook::bin/bazhen-hook": ["tests::reads_a_frame"],
          "bazhen-hook": ["properties::round_trips"],
          "holder-proto::contract": ["decodes"],
        }),
      ),
    ).toEqual([
      "bazhen-hook tests::reads_a_frame",
      "bazhen-hook properties::round_trips",
      "holder-proto::contract decodes",
    ]);
  });

  it("refuses anything that isn't a list report, rather than read it as no tests", () => {
    for (const listed of [null, {}, { "rust-suites": { x: {} } }, "[]"]) {
      expect(() => rustTestIds(listed)).toThrow(/not a nextest list report/);
    }
  });
});

describe("addedRustTests", () => {
  it("is the tests HEAD lists that the base didn't, however they were declared", () => {
    const base = ["hook tests::kept", "hook tests::old_name"];
    const head = ["hook tests::kept", "hook tests::new_name", "proto frame::cases::macro_made"];
    expect(addedRustTests(base, head)).toEqual([
      { file: "hook", title: "tests::new_name" },
      { file: "proto", title: "frame::cases::macro_made" },
    ]);
  });

  it("counts a new test with the same path as one the base has elsewhere in the crate", () => {
    const base = ["hook tests::reads"];
    const head = ["hook tests::reads", "hook tests::reads"];
    expect(addedRustTests(base, head)).toEqual([{ file: "hook", title: "tests::reads" }]);
  });
});

describe("uncontrolledRustTests", () => {
  const names = ["tests::reads_a_frame", "properties::round_trips", "tests::reads"];

  it("is every test no Control trailer names by its full path, as a whole path", () => {
    const messages = [
      "feat: a",
      "",
      "Control: tests::reads_a_frame: drop the length check -> expected Err, got Ok",
      "",
      "feat: b",
      "",
      "Control: made round_trips fail -> it failed",
      "The Control: properties::round_trips -> mid-line is no trailer",
      "Control: properties::round_trips, with no arrow",
      "Control: tests::reads::deeper: a longer path -> y",
      "Control: other::tests::reads: a module of the same name -> y",
    ].join("\n");
    expect(uncontrolledRustTests(names, messages)).toEqual([
      "properties::round_trips",
      "tests::reads",
    ]);
  });

  it("takes one trailer naming several tests, and none when every test has one", () => {
    const messages =
      "Control: tests::reads_a_frame, tests::reads and properties::round_trips: x -> y\n";
    expect(uncontrolledRustTests(names, messages)).toEqual([]);
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

describe("failureLine", () => {
  it("is the first line with text of the test's first failure message", () => {
    const failed = result("t", "failed", [
      "\n  AssertionError: expected 1\n    at x.ts:1",
      "second",
    ]);
    expect(failureLine(report(failed), FILE, "t")).toBe("AssertionError: expected 1");
  });

  it("drops terminal escapes, and cuts a long line short", () => {
    const failed = result("t", "failed", [`\u001b[31mError: ${"x".repeat(400)}\u001b[39m`]);
    expect(failureLine(report(failed), FILE, "t")).toBe(`Error: ${"x".repeat(292)}…`);
  });

  it("puts a space for each control character, and never cuts a character in two", () => {
    const controlled = result("t", "failed", ["Error: a\rb\tc\u0007d\u007fe"]);
    const long = result("t", "failed", ["😀".repeat(400)]);
    expect([
      failureLine(report(controlled), FILE, "t"),
      failureLine(report(long), FILE, "t"),
    ]).toEqual(["Error: a b c d e", `${"😀".repeat(299)}…`]);
  });

  it("is the file's message for a test it doesn't have, as a file that won't load", () => {
    const failedToLoad: VitestReport = {
      testResults: [
        {
          name: `/tmp/wt/${FILE}`,
          message: "Failed to load url ./y.ts\nmore",
          assertionResults: [],
        },
      ],
    };
    expect(failureLine(failedToLoad, FILE, "t")).toBe("Failed to load url ./y.ts");
  });

  it("is nothing for a test with no failure message, or none in the report", () => {
    expect([
      failureLine(report(result("t", "passed")), FILE, "t"),
      failureLine(report(result("t", "failed", ["", "  "])), FILE, "t"),
      failureLine({ testResults: [] }, FILE, "t"),
    ]).toEqual([undefined, undefined, undefined]);
  });
});

describe("noOutputReason", () => {
  const ended = { timedOut: false, code: 0, signal: null };
  const missing = { kind: "missing" } as const;

  it("names falsify's cap when the run timed out, however its group then ended", () => {
    expect(
      noOutputReason({ timedOut: true, code: null, signal: "SIGKILL" }, missing, "report", 300_000),
    ).toBe("it timed out after 300 s, falsify's cap on one vitest run");
  });

  it("says how the run ended when it failed on its own", () => {
    expect([
      noOutputReason({ ...ended, code: null, error: "spawn pnpm ENOENT" }, missing, "report", 1),
      noOutputReason({ ...ended, code: null, signal: "SIGSEGV" }, missing, "report", 1),
      noOutputReason({ ...ended, code: 2 }, { kind: "json", value: [] }, "listing", 1),
    ]).toEqual([
      "it couldn't start: spawn pnpm ENOENT",
      "it was stopped by SIGSEGV",
      "it exited with code 2",
    ]);
  });

  it("says what is wrong with what a run that exited 0 wrote", () => {
    expect([
      noOutputReason(ended, missing, "report", 1),
      noOutputReason(ended, { kind: "not JSON" }, "report", 1),
      noOutputReason(ended, { kind: "json", value: { results: [] } }, "report", 1),
      noOutputReason(ended, missing, "listing", 1),
      noOutputReason(ended, { kind: "unreadable", code: "EISDIR" }, "report", 1),
    ]).toEqual([
      "it wrote no report",
      "its report isn't JSON",
      "its report isn't a vitest report",
      "it wrote no listing",
      "its report couldn't be read (EISDIR)",
    ]);
  });
});

// capped's own report, so that a change to its wording fails here rather than letting a leak by.
const reported = (leftover: number, left?: string[]) =>
  [
    ...cappedReport(
      {
        code: 0,
        signal: null,
        peak: 2 ** 30,
        memoryKills: 0,
        timedOut: false,
        leftover,
        ...(left === undefined ? {} : { left }),
      },
      { memory: 8 * 2 ** 30, timeMs: 360_000 },
      "scope",
      false,
    ),
    "",
  ].join("\n");

describe("leftRunning", () => {
  it("reads what capped's report says a run left running, by name or by count", () => {
    expect([
      leftRunning(reported(4, ["bazhen-holder", "cat", "bazhen-holder", "cat"])),
      leftRunning(reported(3)),
      leftRunning(reported(0)),
    ]).toEqual(["bazhen-holder ×2, cat ×2", "3 process(es)", undefined]);
  });
});

describe("timeoutFrom", () => {
  it("is the variable's whole number of ms, from 1 to the most a timer holds", () => {
    expect([
      timeoutFrom("T", "1", 300_000),
      timeoutFrom("T", "2147483647", 300_000),
      timeoutFrom("T", undefined, 300_000),
      timeoutFrom("T", "", 300_000),
    ]).toEqual([1, 2_147_483_647, 300_000, 300_000]);
  });

  it.each(["0", "-5", "2147483648", "1e3", "1.5", " 5", "abc"])(
    "refuses %j, which a timer would fire at once for or isn't a whole number of ms",
    (value) => {
      expect(() => timeoutFrom("T", value, 300_000)).toThrow(
        `T is a whole number of ms from 1 to 2147483647, not "${value}"`,
      );
    },
  );
});

describe("indentedTail", () => {
  it("is the last 20 lines with text, each indented, keeping their own indent", () => {
    const said = [...Array.from({ length: 25 }, (_, i) => `line ${i + 1}`), "", "    at x.ts:1"];
    expect(indentedTail(said.join("\n")).split("\n")).toEqual([
      ...Array.from({ length: 19 }, (_, i) => `  line ${i + 7}`),
      "      at x.ts:1",
    ]);
  });

  it("drops terminal escapes, puts a space for each control character, and cuts a long line", () => {
    const said = ["\u001b[31mError\u001b[39m: a\rb\tc\u0007d", "dos line\r", "😀".repeat(400)];
    expect(indentedTail(said.join("\n")).split("\n")).toEqual([
      "  Error: a b c d",
      "  dos line",
      `  ${"😀".repeat(299)}…`,
    ]);
  });

  it("says nothing was printed when there is no text", () => {
    expect(indentedTail("\n \u001b[0m\n")).toBe("  (nothing)");
  });
});

describe("parseNameStatus", () => {
  it("reads plain statuses", () => {
    expect(parseNameStatus("M\0a.ts\0A\0b.ts\0D\0c.ts\0")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "A", path: "b.ts" },
      { status: "D", path: "c.ts" },
    ]);
  });

  it("keeps the old path of a rename", () => {
    expect(parseNameStatus("R087\0old.test.ts\0new.test.ts\0M\0a.ts\0")).toEqual([
      { status: "R", path: "new.test.ts", oldPath: "old.test.ts" },
      { status: "M", path: "a.ts" },
    ]);
  });

  it("reads a path git would quote, with a tab or a quote in it, as it is", () => {
    expect(parseNameStatus('M\0odd\tname "x".ts\0')).toEqual([
      { status: "M", path: 'odd\tname "x".ts' },
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

const rejects = (args: string[]) => {
  try {
    parseArgs(args);
    return false;
  } catch {
    return true;
  }
};

describe("parseArgs", () => {
  it("reads an optional --base ref", () => {
    expect([parseArgs([]), parseArgs(["--base", "origin/main"])]).toEqual([
      {},
      { base: "origin/main" },
    ]);
  });

  it("reads --harness alone", () => {
    expect([["--harness"], ["--harness", "--base", "main"]].map(rejects)).toEqual([false, true]);
    expect(parseArgs(["--harness"])).toEqual({ harness: true });
  });

  it("rejects a missing ref, a flag as the ref, extra arguments and a bare revision", () => {
    expect([["--base"], ["--base", "--x"], ["--base", "a", "b"], ["HEAD"]].map(rejects)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

const trailers = (...lines: string[]) => lines.map((l) => `feat: x\n\n${l}\n`).join("\n");

const invalid = (title: string, file = FILE) => ({ file, title, outcome: "INVALID" as const });
const killed = (title: string, file = FILE) => ({ file, title, outcome: "KILLED" as const });

describe("uncontrolledTests", () => {
  const OTHER = "packages/core/src/y.test.ts";

  it("is every INVALID test no Control trailer names by its file and title, in any commit", () => {
    const tests = [
      invalid("caps"),
      invalid("trims"),
      invalid("caps", OTHER),
      invalid("pads"),
      invalid("wraps"),
      killed("rounds"),
    ];
    const messages = trailers(
      `Control: ${FILE} › caps: return v -> expected 2, got 1`,
      `Control: ${FILE} › trims -> it failed`,
      `Control: ${FILE} › pads, with no arrow`,
      `The Control: ${FILE} › wraps: x -> y is mid-line`,
    );
    expect(uncontrolledTests(tests, messages)).toEqual([
      invalid("caps", OTHER),
      invalid("pads"),
      invalid("wraps"),
    ]);
  });

  it("takes no title that is only part of the one the trailer names", () => {
    const messages = trailers(
      `Control: ${FILE} › caps twice: x -> y`,
      `Control: ${FILE} › big caps: x -> y`,
      `Control: ${FILE} › caps twice, as ${FILE} › caps twice: x -> y`,
      `Control: ${FILE} › capsule: x -> y`,
    );
    expect(uncontrolledTests([invalid("caps")], messages)).toEqual([invalid("caps")]);
  });

  it("names a test only by a trailer that starts with its whole path", () => {
    const messages = trailers(
      "Control: src/x.test.ts › caps: x -> y",
      `Control: a/${FILE} › caps: x -> y`,
      `Control: ${FILE}x › caps: x -> y`,
      `Control: see ${FILE} › caps: x -> y`,
      "Control: caps: x -> y",
    );
    expect(uncontrolledTests([invalid("caps")], messages)).toEqual([invalid("caps")]);
  });

  it("takes a test named only after the trailer's last arrow as not named", () => {
    const messages = trailers(`Control: return v -> ${FILE} › caps: failed`);
    expect(uncontrolledTests([invalid("caps")], messages)).toEqual([invalid("caps")]);
  });

  it("names a title holding an arrow, a colon or a regex symbol, and one under a describe", () => {
    const tests = [
      invalid("maps a -> b"),
      invalid("says: no"),
      invalid("nests"),
      invalid("reads [x] (y)+"),
    ];
    const messages = trailers(
      `Control: ${FILE} › maps a -> b: x -> y`,
      `Control: ${FILE} › says: no: x -> y`,
      `Control: ${FILE} › the group › nests: x -> y`,
      `Control: ${FILE} › reads [x] (y)+: x -> y`,
    );
    expect(uncontrolledTests(tests, messages)).toEqual([]);
  });

  it("names one test per trailer, the longest title that fits", () => {
    const messages = trailers(`Control: ${FILE} › parse: keys: broke the split -> x`);
    expect(uncontrolledTests([invalid("parse"), invalid("parse: keys")], messages)).toEqual([
      invalid("parse"),
    ]);
  });

  it("takes no describe name holding a colon, so a trailer's break names no second test", () => {
    const messages = trailers(`Control: ${FILE} › other: broke y › caps: z -> x`);
    expect(uncontrolledTests([invalid("caps")], messages)).toEqual([invalid("caps")]);
  });

  it("names a test whose title couldn't be read by a trailer starting with its file", () => {
    const tests = [invalid(`<unparsed test in ${FILE}>`), invalid(`<unparsed test in ${OTHER}>`)];
    const messages = trailers(`Control: ${FILE} › reads each case: x -> y`);
    expect(uncontrolledTests(tests, messages)).toEqual([invalid(`<unparsed test in ${OTHER}>`)]);
  });

  it("takes no trailer for another new test in the file, or one only mentioning the file, for one whose title couldn't be read", () => {
    const unparsed = invalid(`<unparsed test in ${FILE}>`);
    const messages = trailers(
      `Control: ${FILE} › parsed one: broke -> fail`,
      `Control: ${OTHER} › t: moved a helper out of ${FILE} -> fail`,
    );
    expect(uncontrolledTests([unparsed, killed("parsed one")], messages)).toEqual([unparsed]);
  });
});

describe("controlLine", () => {
  it("is the trailer a test needs, with its file and title filled in", () => {
    expect([
      controlLine({ file: FILE, title: "caps" }),
      controlLine({ file: FILE, title: `<unparsed test in ${FILE}>` }),
    ]).toEqual([
      `Control: ${FILE} › caps: <what you broke> -> <how it failed>`,
      `Control: ${FILE} › <the test's title>: <what you broke> -> <how it failed>`,
    ]);
  });
});

describe("isRevertible", () => {
  it("reverts a script and a script folder's TypeScript, but not a script's test", () => {
    expect(
      [
        "scripts/test-real.ts",
        "scripts/lib/paths.tsx",
        "scripts/test-real.test.ts",
        "scripts/test-real.medium.test.ts",
        "scripts/setup.sh",
      ].map(isRevertible),
    ).toEqual([true, true, false, false, false]);
  });

  it("reverts an app's or package's source of any kind, but not its tests", () => {
    expect(
      [
        "packages/core/src/machine.ts",
        "apps/web/src/ui/tokens.css",
        "apps/web/src/App.test.tsx",
        "packages/core/package.json",
        "tests/support/disposable-host.ts",
      ].map(isRevertible),
    ).toEqual([true, true, false, false, false]);
  });
});

describe("harnessFiles", () => {
  it("follows falsify's runtime imports, and lists a workspace package it imports as a folder", () => {
    const tree: Record<string, string> = {
      "scripts/falsify.ts":
        'import { a } from "./a.ts";\nimport { g } from "@bazhen/host-guard";\nimport "node:fs";',
      "scripts/a.ts": 'export { b } from "./lib/b";',
      "scripts/lib/b.ts": "export const b = 1;",
      "scripts/unrelated.ts": "export const u = 1;",
    };
    expect(
      harnessFiles((path) => tree[path], { "@bazhen/host-guard": "packages/host-guard" }),
    ).toEqual(["packages/host-guard/", "scripts/a.ts", "scripts/falsify.ts", "scripts/lib/b.ts"]);
  });
});

const modified = (...paths: string[]) => paths.map((path) => ({ status: "M", path }));

describe("revertsOf", () => {
  it("reverts a generator's changed output with the generator", () => {
    const changes = modified("scripts/lint-config.ts", ".oxlintrc.json", "README.md");
    expect(revertsOf(changes).map((c) => c.path)).toEqual([
      "scripts/lint-config.ts",
      ".oxlintrc.json",
    ]);
  });

  it("reverts the protocol's schema and fixtures with the protocol source they come from", () => {
    const changes = modified(
      "packages/protocol/src/holder.ts",
      "packages/protocol/schema/HolderOk.json",
      "packages/protocol/fixtures/holder/1.0/frames.json",
    );
    expect(revertsOf(changes)).toEqual(changes);
  });

  it("keeps a generator's output when the branch changes the output alone", () => {
    expect(revertsOf(modified(".oxlintrc.json", "scripts/lint-config.medium.test.ts"))).toEqual([]);
  });

  it("reverts the protocol id the Rust crates speak with the protocol source", () => {
    const changes = modified("packages/protocol/src/holder.ts", "crates/bazhen-protocol/src/id.rs");
    expect(revertsOf(changes)).toEqual(changes);
  });

  it("reverts the Rust workspace's changes when a test runs a binary, and only then", () => {
    const rust = [
      ...modified("crates/bazhen/src/main.rs", "Cargo.toml", "Cargo.lock"),
      { status: "R", oldPath: "crates/bazhen/src/old.rs", path: "crates/bazhen/src/new.rs" },
    ];
    const changes = [...rust, ...modified("README.md", "crates.md")];
    expect({ rust: revertsOf(changes, { rust: true }), other: revertsOf(changes) }).toEqual({
      rust,
      other: [],
    });
  });
});

describe("depInfoSources", () => {
  it("lists the files under the tree a binary was built from, relative to it", () => {
    const text =
      "/t/release/bazhen: /wt/crates/bazhen/src/main.rs /wt/crates/a\\ b/src/lib.rs " +
      "/home/u/.cargo/registry/src/x/lib.rs /wtx/crates/y.rs\n\n/wt/crates/bazhen/src/main.rs:\n";
    expect(depInfoSources(text, "/wt")).toEqual([
      "crates/bazhen/src/main.rs",
      "crates/a b/src/lib.rs",
    ]);
  });
});

describe("binaryInputs", () => {
  it("adds the manifest of each crate built from, and not the workspace's or its lockfile", () => {
    expect(
      binaryInputs([
        "crates/bazhen/src/main.rs",
        "crates/bazhen/src/args.rs",
        "crates/p/src/id.rs",
      ]),
    ).toEqual([
      "crates/bazhen/src/main.rs",
      "crates/bazhen/src/args.rs",
      "crates/p/src/id.rs",
      "crates/bazhen/Cargo.toml",
      "crates/p/Cargo.toml",
    ]);
  });
});

describe("namedBinaries", () => {
  it("reads a path joined to the repository and a URL resolving into its target/", () => {
    const source = [
      'const CLI = join(repo, "target/release/bazhen");',
      "const H = new URL('../../../../target/release-holder/bazhen-holder', import.meta.url);",
      "const R = `target/debug/bazhen-holder-replay`;",
    ].join("\n");
    expect(namedBinaries("apps/daemon/src/terminals/x.ts", source)).toEqual([
      "release/bazhen",
      "debug/bazhen-holder-replay",
      "release-holder/bazhen-holder",
    ]);
  });

  it("ignores a fixture's absolute path, a URL resolving elsewhere, and a deeper path", () => {
    const source = [
      'hookClient: { path: "/repo/target/release/bazhen-hook" },',
      'new URL("../target/release/bazhen", import.meta.url);',
      'const built = "target/falsify/release/bazhen";',
    ].join("\n");
    expect(namedBinaries("tests/cli/x.test.ts", source)).toEqual([]);
  });
});

describe("projectsOf", () => {
  it("groups the listed files by project, relative to whichever root holds them", () => {
    const listing = [
      { file: "/wt/tests/api/a.test.ts", projectName: "api" },
      { file: "/real/wt/tests/holder/h.test.ts", projectName: "holder" },
      { file: "/wt/tests/api/b.test.ts", projectName: "api" },
    ];
    expect([...projectsOf(listing, ["/wt", "/real/wt"])]).toEqual([
      ["api", ["tests/api/a.test.ts", "tests/api/b.test.ts"]],
      ["holder", ["tests/holder/h.test.ts"]],
    ]);
  });

  it("refuses a file outside the worktree, rather than run it", () => {
    const listing = [{ file: "/elsewhere/x.test.ts", projectName: "unit" }];
    expect(() => projectsOf(listing, ["/wt"])).toThrow(/not a vitest file listing/);
  });
});

describe("workspaceExports", () => {
  it("maps each package specifier its exports name to the file, and skips a package without", () => {
    const manifests = [
      {
        dir: "packages/protocol",
        text: JSON.stringify({
          name: "@bazhen/protocol",
          exports: { ".": "./src/index.ts", "./id": "./src/id.ts" },
        }),
      },
      { dir: "apps/web", text: JSON.stringify({ name: "@bazhen/web" }) },
    ];
    expect(workspaceExports(manifests)).toEqual({
      "@bazhen/protocol": "packages/protocol/src/index.ts",
      "@bazhen/protocol/id": "packages/protocol/src/id.ts",
    });
  });
});

describe("workspaceBins", () => {
  it("maps each binary target to its package, and no library", () => {
    const metadata = {
      packages: [
        {
          name: "bazhen-holder-engine",
          targets: [
            { name: "bazhen_holder_engine", kind: ["lib"] },
            { name: "bazhen-holder-replay", kind: ["bin"] },
          ],
        },
        { name: "bazhen", targets: [{ name: "bazhen", kind: ["bin"] }] },
      ],
    };
    expect([...workspaceBins(metadata)]).toEqual([
      ["bazhen-holder-replay", "bazhen-holder-engine"],
      ["bazhen", "bazhen"],
    ]);
  });

  it("refuses what isn't a listing, rather than read it as no binaries", () => {
    expect(() => workspaceBins({ error: "no manifest" })).toThrow(/not a cargo metadata listing/);
  });
});

describe("manifestNames", () => {
  it("gives the package's name and each binary's, and no dependency's", () => {
    const manifest = [
      "[package]",
      'name = "bazhen-holder-engine"',
      "[dependencies]",
      'vt = { package = "alacritty", version = "1" }',
      "[[bin]]",
      'name = "bazhen-holder-replay"',
      'path = "src/bin/replay.rs"',
    ].join("\n");
    expect(manifestNames(manifest)).toEqual(["bazhen-holder-engine", "bazhen-holder-replay"]);
  });
});

describe("binariesOf", () => {
  const files: Record<string, string> = {
    "tests/x/a.test.ts": 'import { h } from "./helper.ts";\nconst B = "target/debug/b";',
    "tests/x/helper.ts": 'import "../support/deep";\nconst C = "target/release/c";',
    "tests/support/deep.ts": 'import "./deeper.ts";\nimport "@bazhen/core";',
    "tests/support/deeper.ts": 'import "../x/helper.ts";\nconst D = "target/release/d";',
    "tests/x/spawns.test.ts": 'const main = join(repo, "apps/d/src/main.ts");',
    "apps/d/src/main.ts": 'import "./h.ts";',
    "apps/d/src/h.ts": 'const H = new URL("../../../target/release-holder/h", import.meta.url);',
    "tests/x/package.test.ts": 'import { h } from "@bazhen/d/h";',
  };
  const read = (path: string) => files[path];

  it("names directly what the test and its own imports name, and reaches the rest", () => {
    expect(binariesOf("tests/x/a.test.ts", read)).toEqual({
      direct: ["debug/b", "release/c"],
      reached: ["debug/b", "release/c", "release/d"],
    });
  });

  it("follows a workspace package's export as it follows a relative import", () => {
    expect(
      binariesOf("tests/x/package.test.ts", read, { "@bazhen/d/h": "apps/d/src/h.ts" }),
    ).toEqual({ direct: ["release-holder/h"], reached: ["release-holder/h"] });
  });

  it("reaches what a source file it names by its path from the root leads to", () => {
    expect(binariesOf("tests/x/spawns.test.ts", read)).toEqual({
      direct: [],
      reached: ["release-holder/h"],
    });
  });
});

describe("cargoErrors", () => {
  it("picks cargo's error lines out of what a build said", () => {
    const said = [
      "   Compiling bazhen v0.1.0",
      "error[E0425]: cannot find value `x` in this scope",
      " --> crates/bazhen/src/main.rs:3:5",
      "warning: unused import",
      'error: could not compile `bazhen` (bin "bazhen") due to 1 previous error',
    ].join("\n");
    expect(cargoErrors(said)).toEqual([
      "error[E0425]: cannot find value `x` in this scope",
      'error: could not compile `bazhen` (bin "bazhen") due to 1 previous error',
    ]);
  });
});

describe("relatedReverts", () => {
  const TEST = "packages/core/src/terminal.test.ts";
  const PACKAGES = { "@bazhen/protocol": "packages/protocol", "@bazhen/core": "packages/core" };
  const related = (source: string, reverted: string[]) =>
    relatedReverts(TEST, source, reverted, PACKAGES);

  it("counts a relative import of a reverted file", () => {
    const source = 'import { nextState } from "./terminal.ts";';
    expect(related(source, ["packages/core/src/terminal.ts"])).toEqual([
      "packages/core/src/terminal.ts",
    ]);
  });

  it("ignores reverted files the test doesn't import", () => {
    const source = 'import { nextState } from "./terminal.ts";\nimport { x } from "../lib/y.ts";';
    expect(related(source, ["packages/core/src/other.ts", "apps/daemon/src/y.ts"])).toEqual([]);
  });

  it("counts any reverted file under an imported workspace package", () => {
    const source = 'import { schema } from "@bazhen/protocol";';
    expect(related(source, ["packages/protocol/src/x.ts"])).toEqual(["packages/protocol/src/x.ts"]);
  });

  it("maps a workspace subpath export to its package", () => {
    const source = 'import { schema } from "@bazhen/protocol/messages";';
    expect(related(source, ["packages/protocol/src/x.ts"])).toEqual(["packages/protocol/src/x.ts"]);
  });

  it("resolves an extensionless specifier", () => {
    expect(related('import { a } from "./util";', ["packages/core/src/util.ts"])).toEqual([
      "packages/core/src/util.ts",
    ]);
    expect(related('import { a } from "./lib";', ["packages/core/src/lib/index.ts"])).toEqual([
      "packages/core/src/lib/index.ts",
    ]);
  });

  it("counts a dynamic import and a side-effect import", () => {
    const source = 'const m = await import("../../protocol/src/x.ts");\nimport "./setup.ts";';
    expect(related(source, ["packages/protocol/src/x.ts", "packages/core/src/setup.ts"])).toEqual([
      "packages/protocol/src/x.ts",
      "packages/core/src/setup.ts",
    ]);
  });

  it("counts a reverted script a test runs through new URL", () => {
    const source = 'const SCRIPT = fileURLToPath(new URL("falsify.ts", import.meta.url));';
    expect(
      relatedReverts("scripts/falsify.medium.test.ts", source, ["scripts/falsify.ts"], PACKAGES),
    ).toEqual(["scripts/falsify.ts"]);
  });

  it("counts a reverted input of the binaries the test names, and no other", () => {
    const test = "apps/daemon/src/mailbox/hook.medium.test.ts";
    const reverted = ["crates/bazhen-hook/src/main.rs", "crates/bazhen-holder/src/lib.rs"];
    const inputs = ["crates/bazhen-hook/src/main.rs", "Cargo.lock"];
    const source = 'import { hook } from "./hook-command.ts";';
    expect(relatedReverts(test, source, reverted, PACKAGES, inputs)).toEqual([
      "crates/bazhen-hook/src/main.rs",
    ]);
  });

  it("ignores a type-only import", () => {
    const source = 'import type { TerminalState } from "@bazhen/protocol";';
    expect(related(source, ["packages/protocol/src/index.ts"])).toEqual([]);
  });
});

const lines = (...text: string[]) => text.join("\n") + "\n";

const BASE_TESTS = lines(
  'import { expect, it } from "vitest";',
  'import { v } from "./x.ts";',
  "",
  'it("adds one", () => {',
  "  expect(v + 1).toBe(2);",
  "});",
  "",
  'it("keeps v", () => expect(v).toBe(1));',
);

const renamedTo = (title: string, source = BASE_TESTS) =>
  source.replace('it("adds one"', `it("${title}"`);

const RENAMED = renamedTo("adds one to v");

const CHANGED = '"adds one to v" isn\'t "adds one" with only its title changed';

const OTHER = "packages/core/src/y.test.ts";

/** A test titled `title`, in `file`, whose file is `base` at the base and `head` at HEAD. */
const end = (title: string, base: string | undefined, head: string | undefined, file = FILE) => ({
  file,
  title,
  base,
  head,
});

const refusal = (base: string | undefined, head: string) =>
  renameRefusal(end("adds one", base, head), end("adds one to v", base, head));

/** The source with the first test's closing line cut. */
const cut = (source: string) => source.replace('});\n\nit("keeps v"', '\nit("keeps v"');

// Each fixture has a backtick in a string or comment ahead of a template with a `}` line at the
// call's indent, and a body change after that line, which a reader cutting the call there would miss.
const miscounted = (...body: string[]) => {
  const base = lines('it("renders", () => {', ...body, "});", "", 'it("keeps", () => {});');
  const head = base.replace('"renders"', '"renders it"').replace("toBe(1)", "toBe(2)");
  return renameRefusal(end("renders", base, head), end("renders it", base, head));
};

/** A copy of the base's first test under `title`, after the rest. */
const withCopy = (source: string, title: string) =>
  source + lines(`it("${title}", () => {`, "  expect(v + 1).toBe(2);", "});");

/** The base's test file without its first test, as it is once that test moves out. */
const LEFT = BASE_TESTS.replace(/it\("adds one"[\s\S]*?\n\}\);\n\n/, "");

/** Another test file holding the base's first test, under `title`. */
const movedTo = (title: string) =>
  lines(
    'import { expect, it } from "vitest";',
    'import { v } from "./x.ts";',
    "",
    `it("${title}", () => {`,
    "  expect(v + 1).toBe(2);",
    "});",
  );

const ref = (file: string, title: string) => ({ file, title });

type Move = { oldHead?: string | undefined; newBase?: string; newHead?: string };

/** Whether the base's first test, moved out of FILE to OTHER as `title`, is refused, and why. */
const moveRefusal = (title: string, move: Move = {}) =>
  renameRefusal(
    end("adds one", BASE_TESTS, "oldHead" in move ? move.oldHead : LEFT),
    end(title, move.newBase, move.newHead ?? movedTo(title), OTHER),
  );

describe("renameTrailers", () => {
  it("reads each Renamed line, at every arrow and first › each side could split at", () => {
    const messages = lines(
      "test: rename",
      "",
      `Renamed: ${FILE} › adds one -> ${OTHER} › adds one to v`,
      "Control: x -> y",
      `Renamed: ${FILE} › a › b -> c -> ${OTHER} › d`,
      "  Renamed: a.test.ts › indented -> a.test.ts › ignored",
    );
    expect(renameTrailers(messages)).toEqual([
      {
        trailer: `${FILE} › adds one -> ${OTHER} › adds one to v`,
        readings: [{ from: ref(FILE, "adds one"), to: ref(OTHER, "adds one to v") }],
      },
      {
        trailer: `${FILE} › a › b -> c -> ${OTHER} › d`,
        readings: [
          { from: ref(FILE, "a › b"), to: ref(`c -> ${OTHER}`, "d") },
          { from: ref(FILE, "a › b -> c"), to: ref(OTHER, "d") },
        ],
      },
    ]);
  });

  it("reads no rename from a line that names no file on a side", () => {
    expect(
      renameTrailers(
        lines(
          "Renamed: adds one -> adds one to v",
          `Renamed: ${FILE} › adds one -> adds one to v`,
          `Renamed: ${FILE} ›  -> ${FILE} › adds one to v`,
        ),
      ),
    ).toEqual([
      { trailer: "adds one -> adds one to v", readings: [] },
      { trailer: `${FILE} › adds one -> adds one to v`, readings: [] },
      { trailer: `${FILE} ›  -> ${FILE} › adds one to v`, readings: [] },
    ]);
  });
});

describe("renameRefusal", () => {
  it("accepts a test whose block is the base's but for its title, quotes and indent", () => {
    const moved = lines(
      'import { describe, expect, it } from "vitest";',
      'import { v } from "./x.ts";',
      "",
      'describe("v", () => {',
      "  it('adds one to v', () => {",
      "    expect(v + 1).toBe(2);",
      "  });",
      "});",
      "",
      'it("keeps v", () => expect(v).toBe(1));',
    );
    const oneLine = BASE_TESTS.replace('it("keeps v"', 'it("keeps v as it was"');
    expect([
      refusal(BASE_TESTS, RENAMED),
      refusal(BASE_TESTS, moved),
      renameRefusal(
        end("keeps v", BASE_TESTS, oneLine),
        end("keeps v as it was", BASE_TESTS, oneLine),
      ),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it("judges as new a renamed test whose body changed", () => {
    expect(refusal(BASE_TESTS, RENAMED.replace("toBe(2)", "toBeGreaterThan(1)"))).toBe(CHANGED);
  });

  it("judges as new a renamed test given an option, or skipped", () => {
    const options = BASE_TESTS.replace('it("adds one", ', 'it("adds one to v", { retry: 2 }, ');
    const skipped = BASE_TESTS.replace('it("adds one"', 'it.skip("adds one to v"');
    expect([refusal(BASE_TESTS, options), refusal(BASE_TESTS, skipped)]).toEqual([
      CHANGED,
      CHANGED,
    ]);
  });

  it("judges as new a different test that a trailer claims renames a deleted one", () => {
    const head = BASE_TESTS.replace('it("adds one"', 'it("doubles v"').replace("v + 1", "v * 2");
    expect(
      renameRefusal(end("adds one", BASE_TESTS, head), end("doubles v", BASE_TESTS, head)),
    ).toBe('"doubles v" isn\'t "adds one" with only its title changed');
  });

  it("judges as new a test whose old title HEAD still has", () => {
    expect(refusal(BASE_TESTS, withCopy(RENAMED, "adds one"))).toBe(
      `HEAD still has a test "adds one" in ${FILE}`,
    );
  });

  it("judges as new a test whose new title the base already has", () => {
    const base = withCopy(BASE_TESTS, "adds one to v");
    expect(refusal(base, renamedTo("adds one to v", base))).toBe(
      `the base already has a test "adds one to v" in ${FILE}`,
    );
  });

  it("judges as new a test whose old or new title is on two tests, or whose file is new", () => {
    expect([
      refusal(withCopy(BASE_TESTS, "adds one"), RENAMED),
      refusal(BASE_TESTS, withCopy(RENAMED, "adds one to v")),
      refusal(undefined, RENAMED),
    ]).toEqual([
      `the base has 2 tests "adds one" in ${FILE}`,
      `HEAD has 2 tests "adds one to v" in ${FILE}`,
      `the base has no test "adds one" in ${FILE}`,
    ]);
  });

  it("judges as new a test in a file whose brackets don't balance, or whose template never closes", () => {
    const open = lines('it("renders", () => {', "  expect(render()).toBe(`{", "});");
    const reopened = open.replace('"renders"', '"renders it"');
    expect([
      refusal(cut(BASE_TESTS), cut(RENAMED)),
      refusal(BASE_TESTS, cut(RENAMED)),
      renameRefusal(end("renders", open, reopened), end("renders it", open, reopened)),
    ]).toEqual([
      `the base's copy of ${FILE} has brackets left open at its end`,
      `HEAD's copy of ${FILE} has brackets left open at its end`,
      expect.stringMatching(new RegExp(`^the base's copy of ${FILE} has an unterminated literal`)),
    ]);
  });

  it("reads a backtick in a string or a comment as part of it, so a change after a template is seen", () => {
    const rendersChanged = '"renders it" isn\'t "renders" with only its title changed';
    expect([
      miscounted('  expect(render()).toBe(`a ${"`"} b', "}", "`);", "  expect(other()).toBe(1);"),
      miscounted(
        '  expect(msg).toContain("list` failed");',
        "  expect(render()).toBe(`{",
        '  "a": 1',
        "}",
        "`);",
        "  expect(other()).toBe(1);",
      ),
      miscounted(
        "  /* a lone ` here */",
        "  expect(render()).toBe(`{",
        "}",
        '  "a": 1',
        "`);",
        "  /* and ` here */",
        "  expect(other()).toBe(1);",
      ),
    ]).toEqual([rendersChanged, rendersChanged, rendersChanged]);
  });

  it("accepts a test moved to another file, under its title or a new one, out of a file kept or deleted", () => {
    expect([
      moveRefusal("adds one"),
      moveRefusal("adds one to v"),
      moveRefusal("adds one", { oldHead: undefined }),
      moveRefusal("adds one", { newBase: lines('it("other", () => {});') }),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("judges as new a test moved to another file whose body changed", () => {
    expect(
      moveRefusal("adds one", { newHead: movedTo("adds one").replace("v + 1", "1 + v") }),
    ).toBe('"adds one" isn\'t "adds one" with only its title changed');
  });

  it("judges as new a copy of a test the old file keeps", () => {
    expect(moveRefusal("adds one", { oldHead: BASE_TESTS })).toBe(
      `HEAD still has a test "adds one" in ${FILE}`,
    );
  });

  it("judges as new a move into a file the base already has the title in, or out of one the base lacks", () => {
    expect([
      moveRefusal("adds one", { newBase: movedTo("adds one") }),
      renameRefusal(
        end("adds one", undefined, LEFT),
        end("adds one", undefined, movedTo("adds one"), OTHER),
      ),
    ]).toEqual([
      `the base already has a test "adds one" in ${OTHER}`,
      `the base has no test "adds one" in ${FILE}`,
    ]);
  });
});

/** The test files a move or rename could have left: FILE, as `head` at HEAD, and OTHER. */
const olds = (head: string | undefined) => [
  { file: OTHER, base: undefined, head: movedTo("adds one") },
  { file: FILE, base: BASE_TESTS, head },
];

/** The base test the first test renamed to "adds one to v" in `head` is, if it is one. */
const renamedIn = (head: string) => renamedFrom(end("adds one to v", BASE_TESTS, head), olds(head));

describe("renameRefusal, when git renamed a file", () => {
  it("names the file's path on the side the copy is", () => {
    const renamedFile = "packages/core/src/x2.test.ts";
    const from = { ...end("adds one", BASE_TESTS, BASE_TESTS), counterpart: renamedFile };
    const to = end("adds one", undefined, movedTo("adds one"), OTHER);
    expect(renameRefusal(from, to)).toBe(`HEAD still has a test "adds one" in ${renamedFile}`);
  });

  it("refuses a move whose file isn't TypeScript on any side, since falsify can't read its tests", () => {
    const [oldTsx, oldJsx] = [`${FILE}x`, FILE.replace(/\.ts$/, ".jsx")];
    const newJsx = OTHER.replace(/\.ts$/, ".jsx");
    const from = end("adds one", BASE_TESTS, LEFT);
    const to = end("adds one", undefined, movedTo("adds one"), OTHER);
    expect([
      renameRefusal(from, to),
      renameRefusal({ ...from, file: oldTsx }, to),
      renameRefusal({ ...from, counterpart: oldTsx }, to),
      renameRefusal({ ...from, file: oldJsx }, to),
      renameRefusal({ ...from, counterpart: oldJsx }, to),
      renameRefusal(from, { ...to, counterpart: newJsx }),
      renameRefusal(from, { ...to, file: newJsx }),
    ]).toEqual([
      undefined,
      `${oldTsx}: falsify reads tests only from .ts, .mts and .cts files`,
      `${oldTsx}: falsify reads tests only from .ts, .mts and .cts files`,
      `${oldJsx}: falsify reads tests only from .ts, .mts and .cts files`,
      `${oldJsx}: falsify reads tests only from .ts, .mts and .cts files`,
      `${newJsx}: falsify reads tests only from .ts, .mts and .cts files`,
      `${newJsx}: falsify reads tests only from .ts, .mts and .cts files`,
    ]);
  });
});

const THIRD = "packages/core/src/z.test.ts";

/** What `appliedRenames` makes of `messages` when the base's first test left FILE for `found`. */
const applied = (found: { file: string; title: string }[], ...messages: string[]) =>
  appliedRenames(
    found,
    renameTrailers(lines(...messages)),
    new Map([[FILE, { file: FILE, base: BASE_TESTS, head: LEFT }]]),
    (file) => ({ file, base: undefined, head: movedTo("adds one") }),
  );

describe("leavableTestFiles", () => {
  it("is each test file the branch changed, deleted or renamed, by its base path, while neither path is .tsx", () => {
    const changes = parseNameStatus(
      [
        ["M", "b.test.ts"],
        ["D", "c.test.ts"],
        ["R090", "f.test.ts", "g.test.ts"],
        ["R090", "a.test.ts", "a.test.tsx"],
        ["R090", "h.test.tsx", "h.test.ts"],
        ["M", "e.test.tsx"],
        ["A", "d.test.ts"],
        ["M", "x.ts"],
        [""],
      ]
        .flat()
        .join("\0"),
    );
    expect(leavableTestFiles(changes)).toEqual(["b.test.ts", "c.test.ts", "f.test.ts"]);
  });
});

describe("appliedRenames", () => {
  it("leaves out a test one trailer moves, and refuses a trailer that applies to none", () => {
    const moved = `${FILE} › adds one -> ${OTHER} › adds one`;
    expect(
      applied(
        [ref(OTHER, "adds one")],
        `Renamed: ${moved}`,
        "Renamed: a.test.ts › x -> b.test.ts › y",
      ),
    ).toEqual({
      renamed: [{ from: ref(FILE, "adds one"), to: ref(OTHER, "adds one") }],
      refused: new Map([
        ["a.test.ts › x -> b.test.ts › y", "the branch adds no test of that name"],
      ]),
    });
  });

  it("refuses every trailer that claims one base test as two tests", () => {
    const twice = [
      `${FILE} › adds one -> ${OTHER} › adds one`,
      `${FILE} › adds one -> ${THIRD} › adds one`,
    ];
    const why = `${FILE} › adds one is named the old test of more than one test`;
    expect(
      applied(
        [ref(OTHER, "adds one"), ref(THIRD, "adds one")],
        ...twice.map((t) => `Renamed: ${t}`),
      ),
    ).toEqual({ renamed: [], refused: new Map(twice.map((t) => [t, why])) });
  });

  it("refuses every trailer that renames one base test in place as two tests", () => {
    const head = withCopy(RENAMED, "adds one twice");
    const sides = { file: FILE, base: BASE_TESTS, head };
    const twice = [
      `${FILE} › adds one -> ${FILE} › adds one to v`,
      `${FILE} › adds one -> ${FILE} › adds one twice`,
    ];
    const why = `${FILE} › adds one is named the old test of more than one test`;
    expect(
      appliedRenames(
        [ref(FILE, "adds one to v"), ref(FILE, "adds one twice")],
        renameTrailers(lines(...twice.map((t) => `Renamed: ${t}`))),
        new Map([[FILE, sides]]),
        () => sides,
      ),
    ).toEqual({ renamed: [], refused: new Map(twice.map((t) => [t, why])) });
  });

  it("refuses an old file that isn't exactly the base path of a test file the branch changed", () => {
    const aliased = `./${FILE} › adds one -> ${OTHER} › adds one`;
    const source = `packages/core/src/x.ts › adds one -> ${OTHER} › adds one`;
    expect(applied([ref(OTHER, "adds one")], `Renamed: ${aliased}`, `Renamed: ${source}`)).toEqual({
      renamed: [],
      refused: new Map([
        [aliased, `./${FILE} isn't the base path of a .test.ts file the branch changed`],
        [
          source,
          "packages/core/src/x.ts isn't the base path of a .test.ts file the branch changed",
        ],
      ]),
    });
  });

  it("refuses a trailer that names no file", () => {
    expect(applied([ref(OTHER, "adds one")], "Renamed: adds one -> adds one").refused).toEqual(
      new Map([
        [
          "adds one -> adds one",
          `it names no file: write it as <old file> › <old title> -> <new file> › <new title>`,
        ],
      ]),
    );
  });
});

describe("renamedFrom", () => {
  it("names the lost base test a new test renames, and nothing for a new test", () => {
    expect([
      renamedIn(RENAMED),
      renamedIn(RENAMED.replace("toBe(2)", "toBe(3)")),
      renamedIn(withCopy(RENAMED, "adds one")),
    ]).toEqual([{ file: FILE, title: "adds one" }, undefined, undefined]);
  });

  it("names the lost base test in another file that a new test moves, and nothing for a copy", () => {
    const moved = end("adds one", undefined, movedTo("adds one"), OTHER);
    expect([renamedFrom(moved, olds(LEFT)), renamedFrom(moved, olds(BASE_TESTS))]).toEqual([
      { file: FILE, title: "adds one" },
      undefined,
    ]);
  });

  it("names nothing when two lost base tests could each be the one moved", () => {
    const twin = { file: "packages/core/src/z.test.ts", base: BASE_TESTS, head: LEFT };
    const moved = end("adds one", undefined, movedTo("adds one"), OTHER);
    expect(renamedFrom(moved, [...olds(LEFT), twin])).toBeUndefined();
  });
});

describe("counterparts", () => {
  it("pairs a renamed file's paths, and leaves any other file's as they are", () => {
    const changes = parseNameStatus(["R087", "a.test.ts", "b.test.ts", "M", "c.ts", ""].join("\0"));
    const { atHead, atBase } = counterparts(changes);
    expect([atHead("a.test.ts"), atBase("b.test.ts"), atHead("c.ts"), atBase("c.ts")]).toEqual([
      "b.test.ts",
      "a.test.ts",
      "c.ts",
      "c.ts",
    ]);
  });
});

const onRust = (outcome: "KILLED" | "SURVIVED" | "INVALID") => ({
  outcome,
  failure: outcome === "SURVIVED" ? undefined : "expected 421, got 200",
  ...(outcome === "INVALID" && { why: "timed out on the Rust daemon" }),
});

describe("a listed test's verdict from both daemons", () => {
  const t = { file: "tests/api/r.test.ts", title: "caps" };

  it("keeps the TypeScript daemon's kill, whatever the Rust daemon did", () => {
    const onTs = { ...t, outcome: "KILLED" as const, failure: "ts" };
    expect(onBothDaemons(onTs, onRust("SURVIVED"))).toBe(onTs);
  });

  it("takes the Rust daemon's kill over a TypeScript pass, and says where it came from", () => {
    expect(onBothDaemons({ ...t, outcome: "INVALID", unrelated: true }, onRust("KILLED"))).toEqual({
      ...t,
      outcome: "KILLED",
      failure: "expected 421, got 200",
      note: " (on the Rust daemon)",
    });
  });

  it("survives when either daemon passed it while related to the change", () => {
    expect([
      onBothDaemons({ ...t, outcome: "INVALID", unrelated: true }, onRust("SURVIVED")).note,
      onBothDaemons({ ...t, outcome: "SURVIVED" }, onRust("SURVIVED")).note,
      onBothDaemons({ ...t, outcome: "SURVIVED" }, onRust("INVALID")).outcome,
    ]).toEqual([" (passed on the Rust daemon)", " (passed on both daemons)", "SURVIVED"]);
  });

  it("has no verdict when the Rust daemon's run timed out and the TypeScript one didn't kill it", () => {
    expect(onBothDaemons({ ...t, outcome: "INVALID", unrelated: true }, onRust("INVALID"))).toEqual(
      {
        ...t,
        outcome: "INVALID",
        failure: "expected 421, got 200",
        note: " (timed out on the Rust daemon)",
      },
    );
  });
});

describe("why a listed test has no result on the Rust daemon", () => {
  const t = { file: "tests/api/r.test.ts", title: "caps" };
  const run = (status?: string, unreported = new Map<string, string>()) => ({
    report: {
      testResults: [
        {
          name: `/w/${t.file}`,
          assertionResults:
            status === undefined ? [] : [{ title: t.title, status, failureMessages: [] }],
        },
      ],
    },
    unreported,
  });

  it("is none when the test passed or failed", () => {
    expect([unrunReason(run("passed"), t), unrunReason(run("failed"), t)]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("names how it ended otherwise, or why its run left no result", () => {
    expect([
      unrunReason(run("skipped"), t),
      unrunReason(run("todo"), t),
      unrunReason(run(), t),
      unrunReason(run(undefined, new Map([[t.file, "the api run: it wrote no report"]])), t),
    ]).toEqual([
      "it was skipped",
      "it was todo",
      "its run has no result for it",
      "the api run: it wrote no report",
    ]);
  });
});

const binaries = (tree: Record<string, string>) =>
  [...crateBinaries(new Set(Object.keys(tree)), (path) => tree[path])].toSorted();

describe("the binaries a workspace's crates build", () => {
  it("takes a crate's own for a src/main.rs, and none for a library", () => {
    expect(
      binaries({
        "crates/d/Cargo.toml": '[package]\nname = "bazhen-daemon"\n',
        "crates/d/src/main.rs": "",
        "crates/s/Cargo.toml": '[package]\nname = "store"\n',
        "crates/s/src/lib.rs": "",
      }),
    ).toEqual(["bazhen-daemon"]);
  });

  it("takes one for each file and folder under src/bin", () => {
    expect(
      binaries({
        "crates/t/Cargo.toml": '[package]\nname = "t"\n',
        "crates/t/src/bin/one.rs": "",
        "crates/t/src/bin/two/main.rs": "",
        "crates/t/src/bin/two/util.rs": "",
      }),
    ).toEqual(["one", "two"]);
  });

  it("takes a [[bin]] whose name follows an array", () => {
    expect(
      binaries({
        "crates/t/Cargo.toml":
          '[package]\nname = "t"\n\n[[bin]]\nrequired-features = ["x"]\nname = "spawned"\npath = "src/spawned.rs"\n',
      }),
    ).toEqual(["spawned"]);
  });

  it("infers none with autobins off, and keeps each [[bin]]", () => {
    expect(
      binaries({
        "crates/t/Cargo.toml":
          '[package]\nname = "t"\nautobins = false\n\n[[bin]]\nname = "kept"\npath = "src/kept.rs"\n',
        "crates/t/src/main.rs": "",
        "crates/t/src/bin/other.rs": "",
      }),
    ).toEqual(["kept"]);
  });

  it("drops a binary cargo would infer from a path a [[bin]] takes", () => {
    expect(
      binaries({
        "crates/t/Cargo.toml":
          '[package]\nname = "t"\n\n[[bin]]\nname = "tool"\npath = "./src/main.rs"\n',
        "crates/t/src/main.rs": "",
      }),
    ).toEqual(["tool"]);
  });

  it("takes none from a manifest that doesn't parse, or one outside a crate's folder", () => {
    expect(
      binaries({
        "crates/t/Cargo.toml": '[package\nname = "t"\n',
        "crates/t/src/main.rs": "",
        "Cargo.toml": '[package]\nname = "root"\n',
        "src/main.rs": "",
      }),
    ).toEqual([]);
  });
});

describe("whether a failure failed in the test file itself", () => {
  const file = "tests/api/r.test.ts";

  it("is so for an expect in the test, past the frames of node and node_modules", () => {
    expect(
      [
        "AssertionError: expected 200 to be 421\n" +
          "    at Proxy.<anonymous> (/w/node_modules/.pnpm/vitest/dist/index.js:9:1)\n" +
          "    at node:internal/process/task_queues:95:5\n" +
          `    at /w/${file}:3:5`,
        "Error: expected [Function] to throw\n" +
          "    at async node:internal/process/task_queues:95:5\n" +
          `    at async /w/${file}:7:5`,
        `AssertionError: no\n    at async Object.check (/w/my repo/${file}:7:5)`,
        `AssertionError: no\n    at file:///w/my%20repo/${file}:7:5`,
      ].map((m) => failedInTest(m, file)),
    ).toEqual([true, true, true, true]);
  });

  it("isn't for a throw from a helper, a stack with no place of its own, or none", () => {
    expect(
      [
        "Error: the daemon exited\n" +
          "    at async Promise.all (index 0)\n" +
          "    at Daemon.start (/w/tests/api/daemon.ts:9:3)\n" +
          `    at /w/${file}:3:5`,
        "Error: Hook timed out\n    at /w/node_modules/.pnpm/vitest/dist/index.js:9:1",
        "Error: no stack",
        `AssertionError: no\n    at /w/tests/api/other-${file.slice("tests/api/".length)}:3:5`,
      ].map((m) => failedInTest(m, file)),
    ).toEqual([false, false, false, false]);
  });
});

const FENCE = "```";

/** A `git log --format=%H%x00%B%x00` record. */
const commit = (hash: string, ...body: string[]) => `${hash}\0${body.join("\n")}\n\0\n`;

describe("guardsOf", () => {
  it("gives a commit's Guard: subjects the break its fenced diff blocks make together", () => {
    const log = commit(
      "c1",
      "test: guard",
      "",
      `${FENCE}diff`,
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      FENCE,
      `${FENCE}diff`,
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
      FENCE,
      "",
      "Guard: x.test.ts › one: swaps a",
      "Guard: x.test.ts › two: swaps a",
    );
    expect(guardsOf(log)).toEqual([
      {
        commit: "c1",
        subjects: ["x.test.ts › one: swaps a", "x.test.ts › two: swaps a"],
        patch:
          "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-c\n+d\n",
      },
    ]);
  });

  it("ends a block at its last line, without the blank lines before its fence", () => {
    const log = commit(
      "c1",
      `${FENCE}diff`,
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      "",
      "-b",
      "+c",
      "",
      "",
      FENCE,
      "Guard: x.test.ts › one",
    );
    expect(guardsOf(log)[0]?.patch).toBe("--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");
  });

  it("gives a guard whose commit has no block, or only one left open, no break", () => {
    const log =
      commit("c1", "Guard: x.test.ts › one") +
      commit("c2", `${FENCE}diff`, "--- a/x.ts", "Guard: x.test.ts › two");
    expect(guardsOf(log).map((g) => [g.commit, g.patch])).toEqual([
      ["c1", ""],
      ["c2", ""],
    ]);
  });

  it("reads no guard in a commit without a Guard: line, nor one a block holds", () => {
    const log =
      commit("c1", `${FENCE}diff`, "Guard: x.test.ts › one", FENCE) +
      commit("c2", "Control: x.test.ts › one: broke it -> failed", " Guard: x.test.ts › one");
    expect(guardsOf(log)).toEqual([]);
  });
});

describe("brokenPathRefusal", () => {
  const related = [
    "packages/a/src/x.ts",
    "apps/d/src/store/fixture.ts",
    "packages/c/src/testing/fake.ts",
  ];

  it("lets a break change source the test imports that the branch changed", () => {
    expect(brokenPathRefusal("packages/a/src/x.ts", related)).toBeUndefined();
  });

  it("refuses test support, even when the test imports it and the branch changed it", () => {
    expect(
      [
        "apps/d/src/store/fixture.ts",
        "packages/c/src/testing/fake.ts",
        "packages/p/src/api-Fixtures.ts",
      ].map((path) => brokenPathRefusal(path, [...related, "packages/p/src/api-Fixtures.ts"])),
    ).toEqual([
      "apps/d/src/store/fixture.ts is test support",
      "packages/c/src/testing/fake.ts is test support",
      "packages/p/src/api-Fixtures.ts is test support",
    ]);
  });

  it("refuses a file the test isn't related to", () => {
    expect(brokenPathRefusal("packages/a/src/y.ts", related)).toBe(
      "packages/a/src/y.ts isn't source the branch changed that the test imports",
    );
  });
});

describe("numstatPaths", () => {
  it("reads the paths a patch modifies", () => {
    expect(numstatPaths("1\t1\ta.ts\u00002\t0\tb/c.ts\u0000")).toEqual(["a.ts", "b/c.ts"]);
  });

  it("is undefined for a binary or a renamed file", () => {
    expect([
      numstatPaths("-\t-\tlogo.png\u0000"),
      numstatPaths("1\t1\t\u0000a.ts\u0000b.ts\u0000"),
    ]).toEqual([undefined, undefined]);
  });
});

describe("isFailsTest", () => {
  it("tells a test written with .fails from one that isn't", () => {
    const source =
      'it.fails("inverted", () => {});\ntest.concurrent.fails("too", () => {});\nit("plain", () => {});\n';
    expect(["inverted", "too", "plain"].map((title) => isFailsTest(source, title))).toEqual([
      true,
      true,
      false,
    ]);
  });
});

/** A stack frame at `where`. */
const at = (where: string) => `    at ${where}:3:5`;

describe("failedOnOwnAssertion", () => {
  const file = "packages/a/src/x.test.ts";

  it("is an AssertionError, chai's or node:assert's, at the test's own frame", () => {
    expect([
      failedOnOwnAssertion([`AssertionError: expected 1 to be 2\n${at(`/w/${file}`)}`], file),
      failedOnOwnAssertion(
        [`AssertionError [ERR_ASSERTION]: false == true\n${at(`/w/${file}`)}`],
        file,
      ),
    ]).toEqual([true, true]);
  });

  it("isn't another error at the test's frame, nor an assertion in a helper", () => {
    expect([
      failedOnOwnAssertion([`TypeError: x is undefined\n${at(`/w/${file}`)}`], file),
      failedOnOwnAssertion(
        [
          `AssertionError: expected 1 to be 2\n${at("/w/packages/a/src/helper.ts")}\n${at(`/w/${file}`)}`,
        ],
        file,
      ),
      failedOnOwnAssertion([], file),
    ]).toEqual([false, false, false]);
  });
});

describe("guardErrors", () => {
  const t = { file: FILE, title: "t" };

  it("names a Guard: that names no new test, and a test it names that didn't survive", () => {
    expect(
      guardErrors(
        { plans: [{ tests: [t, { file: FILE, title: "u" }] }], strays: ["Guard: nothing"] },
        [
          { ...t, outcome: "KILLED" },
          { file: FILE, title: "u", outcome: "GUARDED" },
        ],
      ),
    ).toEqual(["Guard: nothing (it names no new TypeScript test)", `${FILE} › t (KILLED)`]);
  });

  it("names nothing for a guard of a surviving test", () => {
    expect(
      guardErrors({ plans: [{ tests: [t] }], strays: [] }, [{ ...t, outcome: "SURVIVED" }]),
    ).toEqual([]);
  });
});

describe("closedBlock", () => {
  const hunk = ["--- a/x.ts", "+++ b/x.ts"];

  it("takes back as blank context the empty lines its last hunk's header says it lacks", () => {
    expect(closedBlock([...hunk, "@@ -1,2 +1,2 @@", "-a", "+b", "", ""])).toEqual([
      ...hunk,
      "@@ -1,2 +1,2 @@",
      "-a",
      "+b",
      " ",
    ]);
  });

  it("drops the empty lines after a hunk its header says is whole", () => {
    expect(closedBlock([...hunk, "@@ -1 +1 @@", "-a", "+b", ""])).toEqual([
      ...hunk,
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ]);
  });

  it("counts the empty lines inside a hunk as the blank context they are", () => {
    expect(closedBlock([...hunk, "@@ -1,3 +1,3 @@", " a", "", "-b", "+c", ""])).toEqual([
      ...hunk,
      "@@ -1,3 +1,3 @@",
      " a",
      "",
      "-b",
      "+c",
    ]);
  });

  it("drops the empty lines of a block that holds no hunk", () => {
    expect(closedBlock(["diff --git a/x b/x", "old mode 100644", "new mode 100755", ""])).toEqual([
      "diff --git a/x b/x",
      "old mode 100644",
      "new mode 100755",
    ]);
  });
});
