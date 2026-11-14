import { describe, expect, it } from "vitest";
import {
  failedOnAssertion,
  filterable,
  libtestTargets,
  nextestFilter,
  parseMutants,
  inTestCode,
  testCode,
  trackCallers,
  testEvents,
  unmutate,
} from "./rust-mutants.ts";

const LIB = "crates/bazhen-hook/src/lib.rs";

// Trimmed from `cargo mutants --list --json --diff` (cargo-mutants 27.1.0).
const mutant = (name: string, fn: { start: number; end: number } | null, diff?: string) => ({
  name: `${LIB}:${name}`,
  file: LIB,
  package: "bazhen-hook",
  genre: "FnValue",
  replacement: "true",
  span: { start: { line: 88, column: 5 }, end: { line: 90, column: 70 } },
  function:
    fn === null
      ? null
      : {
          function_name: "is_token",
          return_type: "-> bool",
          span: { start: { line: fn.start, column: 1 }, end: { line: fn.end, column: 2 } },
        },
  ...(diff === undefined ? {} : { diff }),
});

const DIFF =
  `--- ${LIB}\n+++ replace is_token -> bool with true\n` +
  "@@ -85,9 +85,7 @@\n fn is_token(id: &str) -> bool {\n-    !id.is_empty()\n+    true\n }\n";

// Trimmed from `cargo nextest list --message-format json` (nextest 0.9.152).
const listReport = (suites: Record<string, [pkg: string, binary: string]>) => ({
  "rust-suites": Object.fromEntries(
    Object.entries(suites).map(([id, [pkg, binary]]) => [
      id,
      { "package-name": pkg, "binary-name": binary, "binary-id": id, testcases: {} },
    ]),
  ),
});

const TARGETS = new Map([["bazhen-hook::bazhen_hook", "bazhen-hook"]]);

// Lines of nextest's `--message-format libtest-json-plus` output.
const event = (name: string, outcome: string, stdout?: string) =>
  JSON.stringify({
    type: "test",
    event: outcome,
    name,
    ...(stdout === undefined ? {} : { stdout }),
  });

const panic = (at: string, message = "assertion `left == right` failed") =>
  `\nthread 'tests::t' (1) panicked at ${at}:\n${message}\nnote: run with \`RUST_BACKTRACE=1\``;

describe("parseMutants", () => {
  it("names the mutated file in the patch's headers, where the listing names the mutant", () => {
    expect(parseMutants([mutant("88:5: replace is_token -> bool with true", null, DIFF)])).toEqual([
      {
        name: `${LIB}:88:5: replace is_token -> bool with true`,
        file: LIB,
        patch: `--- a/${LIB}\n+++ b/${LIB}\n@@ -85,9 +85,7 @@\n fn is_token(id: &str) -> bool {\n-    !id.is_empty()\n+    true\n }\n`,
      },
    ]);
  });

  it("refuses a listing that isn't one, or a mutant with no diff, rather than read no mutants", () => {
    for (const listing of [null, {}, "[]", [{ file: LIB }], [mutant("x", null)]]) {
      expect(() => parseMutants(listing)).toThrow(/not a cargo-mutants listing/);
    }
  });
});

describe("libtestTargets", () => {
  it("maps each binary's libtest prefix to its target, a crate's lib and bins sharing one", () => {
    expect(
      libtestTargets(
        listReport({
          "bazhen-hook": ["bazhen-hook", "bazhen_hook"],
          "bazhen-hook::bin/bazhen-hook": ["bazhen-hook", "bazhen-hook"],
          "holder-proto::contract": ["holder-proto", "contract"],
        }),
      ),
    ).toEqual(
      new Map([
        ["bazhen-hook::bazhen_hook", "bazhen-hook"],
        ["bazhen-hook::bazhen-hook", "bazhen-hook"],
        ["holder-proto::contract", "holder-proto::contract"],
      ]),
    );
  });

  it("drops a prefix two targets share, so no result is credited to the wrong test", () => {
    const targets = libtestTargets(
      listReport({
        x: ["x", "x"],
        "x::x": ["x", "x"],
        y: ["y", "y"],
      }),
    );
    expect(targets).toEqual(new Map([["y::y", "y"]]));
  });

  it("refuses a report without package and binary names", () => {
    expect(() => libtestTargets({ "rust-suites": { x: { testcases: {} } } })).toThrow(
      /not a nextest list report/,
    );
  });
});

describe("testEvents", () => {
  it("names each result by target and path, skipping other lines and unknown binaries", () => {
    const output = [
      "    Starting 2 tests across 2 binaries",
      '{"type":"test","event":"failed","name":"bazhen-hook::bazhen_hook$tests::cut',
      event("bazhen-hook::bazhen_hook$tests::a", "ok"),
      event("bazhen-hook::bazhen_hook$tests::b", "failed", "x"),
      event("other::other$tests::c", "failed"),
      JSON.stringify({ type: "suite", event: "failed" }),
    ].join("\n");
    expect(testEvents(output, TARGETS)).toEqual([
      { test: "bazhen-hook tests::a", event: "ok", stdout: "" },
      { test: "bazhen-hook tests::b", event: "failed", stdout: "x" },
    ]);
  });
});

// A crate's source as rustfmt writes it: product code, a test module, and product code after it.
const SOURCE = [
  "pub fn double(x: u32) -> u32 {",
  "    x * 2",
  "}",
  "",
  "#[track_caller]",
  "pub fn checked(x: u32) -> u32 {",
  "    x",
  "}",
  "",
  "pub fn never() -> ! {",
  '    panic!("never")',
  "}",
  "",
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  "",
  "    #[test]",
  "    fn doubles() {",
  "        assert_eq!(double(2), 4);",
  "        assert_eq!(checked(1), 1);",
  "    }",
  "}",
  "",
  "pub fn after() {}",
  "",
].join("\n");

const TESTS = { file: LIB, start: 14, end: 23 };
const unchanged = (_file: string, line: number) => line;

describe("testCode", () => {
  it("is each item under #[cfg(test)], to its closing brace at column 0", () => {
    expect(testCode(LIB, SOURCE)).toEqual([TESTS]);
  });

  it("is one line for an item that ends on its own line, and none for an item left open", () => {
    expect({
      oneLine: testCode(LIB, "#[cfg(test)]\n#[allow(x)]\nconst N: u8 = 1;\nfn f() {}\n"),
      open: testCode(LIB, "#[cfg(test)]\nmod tests {\n    fn t() {}\n"),
      notBare: testCode(LIB, "#[cfg(all(test, unix))]\nmod tests {\n}\n"),
    }).toEqual({ oneLine: [{ file: LIB, start: 1, end: 3 }], open: [], notBare: [] });
  });

  it("is the whole of a file in a crate's tests/", () => {
    expect(testCode("crates/bazhen-hook/tests/reply.rs", "fn a() {}\nfn b() {}")).toEqual([
      { file: "crates/bazhen-hook/tests/reply.rs", start: 1, end: 2 },
    ]);
  });
});

describe("trackCallers", () => {
  it("names the product functions marked #[track_caller], not the tests'", () => {
    const inTests = `${SOURCE}#[cfg(test)]\nmod more {\n    #[track_caller]\n    fn helper() {}\n}\n`;
    expect(trackCallers(inTests, testCode(LIB, inTests))).toEqual(["checked"]);
  });
});

const result = (outcome: string, stdout: string) => ({ test: "t", event: outcome, stdout });

describe("failedOnAssertion", () => {
  const isTest = inTestCode(new Map([[LIB, SOURCE]]))(unchanged);

  it("counts a failure that panicked at a line of test code", () => {
    expect(failedOnAssertion(result("failed", panic(`${LIB}:20:9`)), isTest)).toBe(true);
  });

  it("doesn't count a pass, a failure with no panic, or a panic anywhere but test code", () => {
    const at = (place: string) => failedOnAssertion(result("failed", panic(place)), isTest);
    expect({
      passed: failedOnAssertion(result("ok", panic(`${LIB}:20:9`)), isTest),
      noPanic: failedOnAssertion(result("failed", "test timed out"), isTest),
      productNoMutantLists: at(`${LIB}:11:5`),
      productAfterTheTests: at(`${LIB}:25:1`),
      trackCallerProduct: at(`${LIB}:21:9`),
      std: at(
        "/rustc/4d91de4e48198da2e33413efdcd9cd2cc0c46688/library/std/src/collections/hash/map.rs:1456:23",
      ),
      dependency: at("/home/u/.cargo/registry/src/index.crates.io-1/serde-1.0.0/src/de.rs:10:5"),
      unknownFile: at("crates/other/src/lib.rs:20:9"),
      proptestReport: failedOnAssertion(
        result("failed", panic(`${LIB}:20:9`, `Test failed: never at ${LIB}:11:5.`)),
        isTest,
      ),
    }).toEqual({
      passed: false,
      noPanic: false,
      productNoMutantLists: false,
      productAfterTheTests: false,
      trackCallerProduct: false,
      std: false,
      dependency: false,
      unknownFile: false,
      proptestReport: false,
    });
  });

  it("reads a place in the mutated file as the line it was before the mutant", () => {
    // The mutant made `double`'s three lines one, so every later line moved up two.
    const shrunk = inTestCode(new Map([[LIB, SOURCE]]))(unmutate("@@ -1,3 +1,1 @@\n", LIB));
    expect({
      movedTestLine: shrunk(LIB, 18),
      movedPastTheTests: shrunk(LIB, 22),
      inTheMutant: shrunk(LIB, 1),
    }).toEqual({ movedTestLine: true, movedPastTheTests: false, inTheMutant: false });
  });
});

describe("nextestFilter", () => {
  it("selects each test by its full path in its target's lib and bins", () => {
    expect(
      nextestFilter([
        { file: "bazhen-hook", title: "tests::a" },
        { file: "holder-proto::contract", title: "decodes" },
      ]),
    ).toBe(
      "((binary_id(=bazhen-hook) | binary_id(bazhen-hook::bin/*)) & test(=tests::a)) | " +
        "((binary_id(=holder-proto::contract) | binary_id(holder-proto::contract::bin/*)) & " +
        "test(=decodes))",
    );
  });

  it("refuses a name that would be read as filter syntax", () => {
    expect({
      plain: filterable({ file: "bazhen-hook", title: "tests::a" }),
      title: filterable({ file: "bazhen-hook", title: "a) | all() | test(b" }),
      target: filterable({ file: "x) | all(", title: "a" }),
    }).toEqual({ plain: true, title: false, target: false });
  });
});
