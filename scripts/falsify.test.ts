import { describe, expect, it } from "vitest";
import {
  classify,
  harnessFiles,
  hasControl,
  addedRustTests,
  binaryInputs,
  cargoErrors,
  depInfoSources,
  binariesOf,
  isRevertible,
  manifestNames,
  namedBinaries,
  workspaceBins,
  workspaceExports,
  newTitles,
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

  it("leaves out an existing test whose call line only became async", () => {
    const text = [
      "+++ b/" + FILE,
      '-  it("was sync", () => {',
      '+  it("was sync", async () => {',
      '+  it("is new", async () => {',
    ].join("\n");
    expect(newTitles(text, FILE)).toEqual(["is new"]);
  });

  it("judges a test removed and added again under the same title, or with another change", () => {
    const text = [
      "+++ b/" + FILE,
      '-  it("moved and rewritten", () => {',
      '-  it("renamed its argument", (a) => {',
      '+  it("moved and rewritten", () => {',
      '+  it("renamed its argument", async (b) => {',
    ].join("\n");
    expect(newTitles(text, FILE)).toEqual(["moved and rewritten", "renamed its argument"]);
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

describe("hasControl", () => {
  it("finds a Control trailer in any commit message of the branch", () => {
    expect([
      hasControl("feat: a\n\nbody\n\nfix: b\n\nControl: drop the guard -> expected 1, got 2\n"),
      hasControl("feat: a\n\nControl: no arrow here\n"),
      hasControl("feat: a\n\nThe Control: x -> y is mid-line\n"),
    ]).toEqual([true, false, false]);
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

const refusal = (base: string | undefined, head: string) =>
  renameRefusal(base, head, "adds one", "adds one to v");

/** The source with the first test's closing line cut. */
const cut = (source: string) => source.replace('});\n\nit("keeps v"', '\nit("keeps v"');

/** A copy of the base's first test under `title`, after the rest. */
const withCopy = (source: string, title: string) =>
  source + lines(`it("${title}", () => {`, "  expect(v + 1).toBe(2);", "});");

describe("renameTrailers", () => {
  it("reads each Renamed line, at every arrow a title could split at", () => {
    const messages = lines(
      "test: rename",
      "",
      "Renamed: adds one -> adds one to v",
      "Control: x -> y",
      "Renamed: a -> b -> c",
      "  Renamed: indented -> ignored",
    );
    expect(renameTrailers(messages)).toEqual([
      { trailer: "adds one -> adds one to v", from: "adds one", to: "adds one to v" },
      { trailer: "a -> b -> c", from: "a", to: "b -> c" },
      { trailer: "a -> b -> c", from: "a -> b", to: "c" },
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
      renameRefusal(BASE_TESTS, oneLine, "keeps v", "keeps v as it was"),
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
    expect(renameRefusal(BASE_TESTS, head, "adds one", "doubles v")).toBe(
      '"doubles v" isn\'t "adds one" with only its title changed',
    );
  });

  it("judges as new a test whose old title HEAD still has", () => {
    expect(refusal(BASE_TESTS, withCopy(RENAMED, "adds one"))).toBe(
      'HEAD still has a test "adds one"',
    );
  });

  it("judges as new a test whose new title the base already has", () => {
    const base = withCopy(BASE_TESTS, "adds one to v");
    expect(refusal(base, renamedTo("adds one to v", base))).toBe(
      'the base already has a test "adds one to v"',
    );
  });

  it("judges as new a test whose old or new title is on two tests, or whose file is new", () => {
    expect([
      refusal(withCopy(BASE_TESTS, "adds one"), RENAMED),
      refusal(BASE_TESTS, withCopy(RENAMED, "adds one to v")),
      refusal(undefined, RENAMED),
    ]).toEqual([
      'the base has 2 tests "adds one"',
      'HEAD has 2 tests "adds one to v"',
      'the base has no test "adds one"',
    ]);
  });

  it("judges as new a test whose block has no closing line", () => {
    expect(refusal(cut(BASE_TESTS), cut(RENAMED))).toBe('the end of "adds one" can\'t be found');
  });
});

describe("renamedFrom", () => {
  it("names the lost base test a new test renames, and nothing for a new test", () => {
    expect([
      renamedFrom(BASE_TESTS, RENAMED, "adds one to v"),
      renamedFrom(BASE_TESTS, RENAMED.replace("toBe(2)", "toBe(3)"), "adds one to v"),
      renamedFrom(BASE_TESTS, withCopy(RENAMED, "adds one"), "adds one to v"),
    ]).toEqual(["adds one", undefined, undefined]);
  });
});
