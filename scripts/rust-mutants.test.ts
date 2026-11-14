import { describe, expect, it } from "vitest";
import {
  failedOnAssertion,
  filterable,
  libtestTargets,
  nextestFilter,
  parseMutants,
  productSpans,
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

describe("productSpans", () => {
  it("takes each mutated function's lines once, and nothing for a mutant outside a function", () => {
    const fn = { start: 84, end: 91 };
    expect(productSpans([mutant("a", fn), mutant("b", fn), mutant("c", null)])).toEqual([
      { file: LIB, start: 84, end: 91 },
    ]);
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

const result = (outcome: string, stdout: string) => ({ test: "t", event: outcome, stdout });

describe("failedOnAssertion", () => {
  const product = [{ file: LIB, start: 84, end: 91 }];

  it("counts a failure that panicked at a line outside product code", () => {
    expect(failedOnAssertion(result("failed", panic(`${LIB}:386:13`)), product)).toBe(true);
  });

  it("doesn't count a pass, a failure with no panic, or a panic product code raised", () => {
    expect({
      passed: failedOnAssertion(result("ok", panic(`${LIB}:386:13`)), product),
      noPanic: failedOnAssertion(result("failed", "test timed out"), product),
      inProduct: failedOnAssertion(
        result("failed", panic(`${LIB}:88:5`, "attempt to add with overflow")),
        product,
      ),
      proptestReport: failedOnAssertion(
        result(
          "failed",
          panic(`${LIB}:400:5`, `Test failed: attempt to add with overflow at ${LIB}:90:9.`),
        ),
        product,
      ),
    }).toEqual({ passed: false, noPanic: false, inProduct: false, proptestReport: false });
  });

  it("doesn't count a panic raised in the standard library or a dependency", () => {
    const std =
      "/rustc/4d91de4e48198da2e33413efdcd9cd2cc0c46688/library/std/src/collections/hash/map.rs:1456:23";
    const dependency = "/home/u/.cargo/registry/src/index.crates.io-1/serde-1.0.0/src/de.rs:10:5";
    expect({
      std: failedOnAssertion(result("failed", panic(std, "no entry found for key")), product),
      dependency: failedOnAssertion(result("failed", panic(dependency)), product),
    }).toEqual({ std: false, dependency: false });
  });

  it("reads a place in the mutated file as the line it was before the mutant", () => {
    // The mutant made lines 84-91 into 84-86, so the old 120 is now 115.
    const shrunk = unmutate("@@ -84,8 +84,3 @@\n", LIB);
    const at = (line: number) => result("failed", panic(`${LIB}:${line}:9`));
    expect({
      movedIntoProduct: failedOnAssertion(at(87), [{ file: LIB, start: 92, end: 95 }], shrunk),
      inTheMutant: failedOnAssertion(at(85), [], shrunk),
      after: failedOnAssertion(at(115), [{ file: LIB, start: 115, end: 115 }], shrunk),
    }).toEqual({ movedIntoProduct: false, inTheMutant: false, after: true });
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
