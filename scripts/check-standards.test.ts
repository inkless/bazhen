import { describe, expect, it } from "vitest";
import {
  CARGO_CONFIG,
  XTASK_WRAPPER,
  CLIPPY_CONFIG,
  MAX_CAP,
  MUTANTS_CONFIG,
  cappedScriptFailures,
  harnessNameFailures,
  compiledFailures,
  tmuxPinFailures,
  ROOT_TABLES,
  TOOLCHAIN_CONFIG,
  DENY_CONFIG,
  RUST_GATE_TASKS,
  WORKSPACE_LINTS,
  byteTakers,
  cargoManifestFailures,
  decoderFailures,
  declaredTokens,
  fuzzManifestFailures,
  tomlTables,
  makefileFailures,
  makefileTargets,
  makeNameFailures,
  makeTargets,
  menuTargets,
  GATE_STEPS,
  CHECK_HALVES,
  HELP_COMMAND,
  MAKEFILE_SETTINGS,
  OWN_ARGS,
  PARALLEL_TARGETS,
  hasRuntimeCode,
  inheritsWorkspaceLints,
  attributeFailures,
  memberDependencyFailures,
  harnessFailures,
  macroFailures,
  metadataFailures,
  productChokepointFailures,
  isCargoMetadata,
  heavyDependencyFailures,
  lockGraph,
  type CargoMetadata,
  rootManifestFailures,
  offTokenLines,
  pathCandidates,
  pnpmScripts,
  rustFailures,
  signalChokepointFailures,
  allowedSignalFileFailures,
  testSignalDependencyFailures,
  holderReachingCrates,
  unmarkedSignallingTests,
  skillFailures,
  suppressionFailures,
  unsafeModuleFailures,
  migrationListFailures,
  migrationImportFailures,
  migrationIdentityFailures,
  migrationFrozenFailures,
  migrationExportFailures,
  listedNumbered,
  numberedHistoryFailures,
  parseNameStatus,
  migrationBase,
  baseListFailures,
  numberedFailures,
  migrationHistoryFailures,
  listedMigrations,
  checkMigrations,
  STANDARDS_CHECKS,
} from "./check-standards.ts";
import { ALLOWED_SIGNALS, ENDS_WITHOUT_A_CALL } from "./signal-paths.ts";

const A = "2026-11-01-first";
const B = "2026-11-02-second";
const C = "2026-11-02-third";

describe("migrationListFailures", () => {
  it("takes migrations each named once, for a file of that name", () => {
    expect(migrationListFailures([A, B], [`${B}.ts`, `${A}.ts`])).toEqual([]);
  });

  it("refuses a name listed twice, a name not dated, a name with no file and a file not listed", () => {
    expect([
      migrationListFailures([A, A], [`${A}.ts`]),
      migrationListFailures(["second"], ["second.ts"]),
      migrationListFailures([A, B], [`${A}.ts`]),
      migrationListFailures([A], [`${A}.ts`, `${B}.ts`]),
    ]).toEqual([
      [expect.stringContaining(`lists ${A} twice`)],
      [expect.stringContaining("second isn't named YYYY-MM-DD-slug")],
      [expect.stringContaining(`${B} is named for no file`)],
      [expect.stringContaining(`${B}.ts: no migration in MIGRATIONS is named for it`)],
    ]);
  });
});

describe("migrationImportFailures", () => {
  it("takes type imports", () => {
    const source =
      'import type { DatabaseSync } from "node:sqlite";\n' +
      'import type { Migration } from "../migrations.ts";\n';
    expect(migrationImportFailures("m.ts", source)).toEqual([]);
  });

  it("refuses a value from Node's own modules too, as readFileSync would bring another file in", () => {
    expect(migrationImportFailures("m.ts", 'import { readFileSync } from "node:fs";\n')).toEqual([
      expect.stringContaining("imports node:fs"),
    ]);
  });

  it("refuses a value imported from the code base, and an import at run time", () => {
    expect([
      migrationImportFailures("m.ts", 'import { nameBase } from "../names.ts";\n'),
      migrationImportFailures("m.ts", 'const m = await import("../names.ts");\n'),
    ]).toEqual([
      [expect.stringContaining("imports ../names.ts")],
      [expect.stringContaining("imports at run time")],
    ]);
  });

  it("refuses a re-export, a value import after a type import on one line, and a value named type", () => {
    expect([
      migrationImportFailures("m.ts", 'export { default } from "../impl.ts";\n'),
      migrationImportFailures("m.ts", 'export * from "../impl.ts";\n'),
      migrationImportFailures(
        "m.ts",
        'import type { A } from "node:sqlite"; import { nameBase } from "../names.ts";\n',
      ),
      migrationImportFailures("m.ts", 'import type from "../names.ts";\n'),
    ]).toEqual([
      [expect.stringContaining("imports ../impl.ts")],
      [expect.stringContaining("imports ../impl.ts")],
      [expect.stringContaining("imports ../names.ts")],
      [expect.stringContaining("imports ../names.ts")],
    ]);
  });
});

describe("migrationIdentityFailures", () => {
  const shipped = { name: A, sql: "CREATE TABLE a (x)" };

  it("takes a list of each file's own default export", () => {
    expect(migrationIdentityFailures([shipped], { [A]: shipped })).toEqual([]);
  });

  it("refuses a copy of a shipped migration with its SQL changed", () => {
    const changed = { ...shipped, sql: "CREATE TABLE a (x, y)" };
    expect(migrationIdentityFailures([changed], { [A]: shipped })).toEqual([
      expect.stringContaining(`lists ${A} as something other than its file's default export`),
    ]);
  });
});

describe("migrationExportFailures", () => {
  it("takes the default export alone, and refuses any other", () => {
    expect([
      migrationExportFailures("m.ts", "export default Object.freeze({ name: 'a' });\n"),
      migrationExportFailures("m.ts", "export const extra = { sql: '' };\nexport default x;\n"),
      migrationExportFailures("m.ts", "const y = 1;\nexport { y };\n"),
    ]).toEqual([
      [],
      [expect.stringContaining("exports const as well")],
      [expect.stringContaining("exports { as well")],
    ]);
  });
});

describe("migrationFrozenFailures", () => {
  it("takes frozen exports, and names one that could change in place", () => {
    expect(migrationFrozenFailures({ [A]: Object.freeze({ name: A }), [B]: { name: B } })).toEqual([
      expect.stringContaining(`${B}.ts: export it frozen`),
    ]);
  });
});

/** `MIGRATIONS_FILE`'s text with `NUMBERED_MIGRATIONS` listing `names`. */
const listing = (names: string[]) =>
  `export const NUMBERED_MIGRATIONS: readonly string[] = [\n${names.map((n) => `  "${n}",\n`).join("")}];\n`;

describe("numberedHistoryFailures", () => {
  it("reads the base's numbered names, and none from a base without them", () => {
    expect([
      listedNumbered(listing([A, B])),
      listedNumbered("export const MIGRATIONS = [];"),
    ]).toEqual([[A, B], []]);
  });

  it("takes the same names, or a base from before named migrations, and refuses any change", () => {
    expect([
      numberedHistoryFailures([A, B], [A, B], true),
      numberedHistoryFailures([], [A, B], false),
      numberedHistoryFailures([A, B], [B, A], true),
    ]).toEqual([[], [], [expect.stringContaining("NUMBERED_MIGRATIONS changed from main's")]]);
  });

  it("refuses a base list read empty when the base has migration files", () => {
    expect(numberedHistoryFailures([], [A, B], true)).toEqual([
      expect.stringContaining("read no NUMBERED_MIGRATIONS from main's list"),
    ]);
  });

  it("reads past comments in the base's list, whatever they hold", () => {
    const text = `export const NUMBERED_MIGRATIONS: readonly string[] = [\n  "${A}",\n  // ["${C}"] once\n  "${B}",\n];\n`;
    expect(listedNumbered(text)).toEqual([A, B]);
  });
});

describe("the git half of checkMigrations", () => {
  it("reads each change's status and the path it ends at, a rename's new one", () => {
    expect(
      parseNameStatus(`A\tdir/${C}.ts\nM\tdir/${A}.ts\nR087\tdir/${B}.ts\tdir/x.ts\n`),
    ).toEqual([
      { status: "A", path: `dir/${C}.ts` },
      { status: "M", path: `dir/${A}.ts` },
      { status: "R087", path: "dir/x.ts" },
    ]);
  });

  it("fails, rather than checks nothing, without a merge base", () => {
    const missing = migrationBase(() => {
      throw new Error("fatal: Not a valid object name origin/main");
    });
    expect([migrationBase(() => "abc"), missing]).toEqual([
      { base: "abc" },
      { failure: expect.stringContaining("no merge base with main") },
    ]);
  });

  it("refuses a base list read short of the base's files", () => {
    expect([baseListFailures([A, B], 2), baseListFailures([A], 2)]).toEqual([
      [],
      [expect.stringContaining("read 1 migrations from main's list, which has 2 files")],
    ]);
  });
});

describe("numberedFailures", () => {
  it("takes migrations that start with the numbered ones, in order, and more after", () => {
    expect(numberedFailures([A, B, C], [A, B])).toEqual([]);
  });

  it("refuses numbered migrations swapped, or one missing", () => {
    expect([numberedFailures([B, A, C], [A, B]), numberedFailures([A], [A, B])]).toEqual([
      [expect.stringContaining("doesn't start with NUMBERED_MIGRATIONS")],
      [expect.stringContaining("doesn't start with NUMBERED_MIGRATIONS")],
    ]);
  });
});

describe("listedMigrations", () => {
  it("reads the list's order, not the imports'", () => {
    const source =
      `import second from "./migrations/${B}.ts";\n` +
      `import first from "./migrations/${A}.ts";\n\n` +
      "export const MIGRATIONS: readonly Migration[] = [\n  first,\n  second,\n];\n";
    expect(listedMigrations(source)).toEqual([A, B]);
  });

  it("reads past comments in the list, whatever they hold", () => {
    const source =
      `import first from "./migrations/${A}.ts";\n` +
      `import second from "./migrations/${B}.ts";\n\n` +
      "export const MIGRATIONS: readonly Migration[] = [\n" +
      "  // see [docs]: second, then first,\n  first,\n  /* second, */ second,\n];\n";
    expect(listedMigrations(source)).toEqual([A, B]);
  });

  it("reads nothing from a list of numbered migrations", () => {
    const source =
      "export const MIGRATIONS: readonly Migration[] = [\n  {\n    version: 1,\n  },\n];\n";
    expect(listedMigrations(source)).toEqual([]);
  });
});

describe("migrationHistoryFailures", () => {
  const added = { status: "A", path: `dir/${C}.ts` };

  it("takes migrations added after the ones on main", () => {
    expect(migrationHistoryFailures([added], [A, B], [A, B, C])).toEqual([]);
  });

  it("refuses a migration on main edited, removed or renamed", () => {
    expect(
      migrationHistoryFailures(
        [
          { status: "M", path: `dir/${A}.ts` },
          { status: "D", path: `dir/${B}.ts` },
          { status: "R100", path: `dir/${C}.ts` },
        ],
        [],
        [],
      ),
    ).toEqual([
      expect.stringContaining(`${A}.ts: edited after it was on main`),
      expect.stringContaining(`${B}.ts: removed after it was on main`),
      expect.stringContaining(`${C}.ts: renamed after it was on main`),
    ]);
  });

  it("refuses a list that drops, reorders or puts a new one before migrations on main", () => {
    expect([
      migrationHistoryFailures([], [A, B], [A]),
      migrationHistoryFailures([], [A, B], [B, A]),
      migrationHistoryFailures([added], [A, B], [A, C, B]),
    ]).toEqual([
      [expect.stringContaining(`no longer lists ${B}`)],
      [expect.stringContaining("changes the order")],
      [expect.stringContaining("changes the order")],
    ]);
  });

  it("is one of the checks make check runs", () => {
    expect(STANDARDS_CHECKS).toContain(checkMigrations);
  });
});

describe("hasRuntimeCode", () => {
  it("is false for a type-only module", () => {
    expect(hasRuntimeCode("// a comment\nexport type Id = string;\ninterface X { a: 1 }\n")).toBe(
      false,
    );
  });

  it("is false for a module of re-exports", () => {
    expect(hasRuntimeCode('export * from "./a.ts";\nexport { b } from "./b.ts";\n')).toBe(false);
  });

  it("is true for a module with a function", () => {
    expect(hasRuntimeCode("export function f(): number { return 1; }\n")).toBe(true);
  });

  it("keeps a string that contains //", () => {
    expect(hasRuntimeCode('export const url = "http://localhost";\n')).toBe(true);
  });
});

describe("pathCandidates", () => {
  it("reads paths from code spans and fenced blocks, not prose or lint rules", () => {
    const doc = [
      "See `scripts/falsify.ts:12`, `AGENTS.md` and `vitest/no-identical-title`.",
      "Plain scripts/prose.ts is not code.",
      "```sh",
      "node scripts/check-standards.ts",
      "```",
    ].join("\n");
    expect(pathCandidates(doc).toSorted()).toEqual([
      "AGENTS.md",
      "scripts/check-standards.ts",
      "scripts/falsify.ts",
    ]);
  });
});

describe("pnpmScripts", () => {
  it("skips options and their values", () => {
    expect(
      ["pnpm test", "pnpm run lint", "pnpm --filter @bazhen/web test", "pnpm -r build", "pnpm"].map(
        pnpmScripts,
      ),
    ).toEqual([["test"], ["lint"], ["test"], ["build"], []]);
  });
});

const tokens = declaredTokens(":root {\n  --color-text: light-dark(a, b);\n  --space-2: 8px;\n}");
const css = (body: string) => offTokenLines(`.x {\n${body}\n}`, "css", tokens).map((f) => f.line);
const script = (line: string) => offTokenLines(line, "script", tokens).length;

describe("offTokenLines in CSS", () => {
  it("passes a rule that uses only semantic tokens and colour keywords", () => {
    expect(css("  color: var(--color-text);\n  padding: var(--space-2);")).toEqual([]);
    expect(css("  background: transparent;\n  border: 1px solid currentcolor;")).toEqual([]);
  });

  it("flags a literal colour, however it is written", () => {
    for (const value of ["#e5a50a", "rgb(0 0 0)", "oklch(0.5 0.1 20)", "red", "light-dark(a, b)"]) {
      expect({ value, lines: css(`  color: ${value};`) }).toEqual({ value, lines: [2] });
    }
    expect(css("  background: color-mix(in srgb, var(--color-text) 10%, transparent);")).toEqual([
      2,
    ]);
    expect(css(`  background: url("data:image/svg+xml,<svg fill='%23ff0000'/>");`)).toEqual([2]);
  });

  it("flags a primitive or a token tokens.css doesn't define", () => {
    expect(css("  color: var(--color-neutral-12);")).toEqual([2]);
    expect(css("  color: var(--colour-text);")).toEqual([2]);
  });

  it("allows a system colour only under forced colours", () => {
    expect(css("  outline-color: Highlight;")).toEqual([2]);
    const forced =
      "@media (forced-colors: active) {\n  .x {\n    outline-color: Highlight;\n  }\n}";
    expect(offTokenLines(forced, "css", tokens)).toEqual([]);
  });

  it("reads selectors, selector lists over several lines and comments as no colour", () => {
    expect(css("  /* red, #fff */\n  color: var(--color-text);")).toEqual([]);
    const list =
      ".red:hover,\n.tan a,\n.fleet .agent[aria-current='true'] {\n  color: var(--color-text);\n}";
    expect(offTokenLines(list, "css", tokens)).toEqual([]);
  });

  it("names the line a declaration over several lines starts on", () => {
    expect(css("  color: var(--color-text);\n  background:\n    #fff;")).toEqual([3]);
  });
});

describe("offTokenLines in scripts and markup", () => {
  it("flags a colour in a style, a prop or an attribute", () => {
    expect(script('const c = "#ff0000";')).toBe(1);
    expect(script('<path fill="red" />')).toBe(1);
    expect(script("style={{ color: 'white' }}")).toBe(1);
    expect(script('style={{ border: "1px solid navy" }}')).toBe(1);
    expect(script('<img src="data:image/svg+xml,%23f00" />')).toBe(1);
  });

  it("flags a var() naming a primitive, an unknown token, or one computed at run time", () => {
    expect(script('style={{ color: "var(--color-blue-9)" }}')).toBe(1);
    expect(script("style={{ background: `var(--${name})` }}")).toBe(1);
    expect(script('style={{ color: "var(--color-text)" }}')).toBe(0);
  });

  it("leaves prose, identifiers and comments alone", () => {
    expect(script("const red = true;")).toBe(0);
    expect(script('<p>{"Mark the red line as done"}</p>')).toBe(0);
    expect(script("// #fff is white")).toBe(0);
  });
});

const unsafeModules = { "crates/x/src/pty.rs": "the PTY's FFI" };
const scan = (source: string, file = "crates/x/src/a.rs") =>
  attributeFailures(file, source, unsafeModules);

describe("attributeFailures", () => {
  it("names allow and expect, inner, outer, spaced, over several lines or under cfg_attr", () => {
    const source = [
      "#![allow(clippy::pedantic)]",
      '#[expect(clippy::unwrap_used, reason = "x")]',
      "#[cfg_attr(all(test, unix), allow(dead_code))]",
      "# [allow(unused)]",
      '#![expect(\n    unsafe_code,\n    reason = "the PTY (openpty, ioctl)"\n)]',
      "#[cfg_attr(unix, cfg_attr(test, expect(dead_code)))]",
      "#[r#allow(dead_code)]",
      "/* a comment\n   over two lines */ #[allow (dead_code)]",
      "#[warn(missing_docs)]",
      "#[derive(Debug)] #[cfg(test)] #[must_use]",
    ].join("\n");
    expect(scan(source).map((f) => f.split(": ")[0])).toEqual([
      "crates/x/src/a.rs:1",
      "crates/x/src/a.rs:2",
      "crates/x/src/a.rs:3",
      "crates/x/src/a.rs:4",
      "crates/x/src/a.rs:5",
      "crates/x/src/a.rs:9",
      "crates/x/src/a.rs:10",
      "crates/x/src/a.rs:12",
    ]);
  });

  it("still reads an attribute whose reason holds //, quotes or brackets", () => {
    const source = [
      '#[expect(clippy::unwrap_used, reason = "see https://doc.rust-lang.org/x")]',
      '#[allow(dead_code, reason = "a \\"quoted\\" (word)")]',
      'let u = "http://x"; #[allow(unused)]',
      '#[cfg_attr(feature = "a[b]", allow(missing_docs))]',
    ].join("\n");
    expect(scan(source)).toHaveLength(4);
  });

  it("leaves an attribute written in a comment, a string, a char or a raw string alone", () => {
    const source = [
      "// never #[allow(clippy::pedantic)]",
      "/// see `#[expect(dead_code)]` and # alone",
      "/* #[allow(x)] /* nested */ still a comment */",
      'let s = "#[allow(y)] #";',
      'let r = r##"a "#[allow(z)]" b"##; let b = br##"#"##;',
      "let c = '#'; let q = '\"'; fn f<'a>(x: &'a str) {}",
      'let r#type = 1; let allow_list = include_str!("x");',
    ].join("\n");
    expect(scan(source)).toEqual([]);
  });

  it("refuses a # a macro emits apart from its bracket, and an attribute it builds", () => {
    const split = "macro_rules! pound { ($($t:tt)*) => { # $($t)* }; }";
    const call = "pound! { [expect(clippy::cast_possible_truncation)] fn f() {} }";
    const built = "macro_rules! m { ($a:meta) => { #[$a] fn g() {} } }";
    const inner = "macro_rules! m { ($($t:tt)*) => { #[ $($t)* ] fn g() {} } }";
    const token = "m!(#);";
    expect([scan(`${split}\n${call}`), scan(built), scan(inner), scan(token)]).toEqual([
      [expect.stringContaining("crates/x/src/a.rs:1: a `#` that doesn't begin an attribute")],
      [expect.stringContaining("is built by a macro")],
      [expect.stringContaining("is built by a macro")],
      [expect.stringContaining("doesn't begin an attribute")],
    ]);
  });

  it("refuses code from a file the scan doesn't read, however include! is reached", () => {
    expect([
      scan('include!("../extra.txt");'),
      scan('std::include!("x.rs");'),
      scan("use core::include as inc;"),
      scan('macro_rules! call { ($m:ident) => { $m!("x.txt") } }'),
      scan('#[path = "../outside.txt"] mod outside;'),
      scan('#[cfg_attr(unix, path = "unix.rs")] mod sys;'),
    ]).toEqual([
      [expect.stringContaining("`include`")],
      [expect.stringContaining("`include`")],
      [expect.stringContaining("`include`")],
      [expect.stringContaining("`$m!`")],
      [expect.stringContaining("from a path the checks don't read")],
      [expect.stringContaining("from a path the checks don't read")],
    ]);
  });

  it("refuses an attribute that skips a test, inverts it, or hides code from clippy", () => {
    const source = [
      "#[test]",
      '#[ignore = "slow"]',
      "fn a() {}",
      "#[test]",
      '#[should_panic(expected = "x")]',
      "fn b() {}",
      "#[cfg_attr(unix, ignore)]",
      "#[cfg(not(clippy))]",
      "fn c() {}",
      '#[clippy::msrv = "1.0"]',
      "fn d() {}",
      "#[cfg(test)] #[test] fn ignores_nothing() {}",
    ].join("\n");
    expect(scan(source).map((f) => f.split(": ")[0])).toEqual([
      "crates/x/src/a.rs:2",
      "crates/x/src/a.rs:5",
      "crates/x/src/a.rs:7",
      "crates/x/src/a.rs:8",
      "crates/x/src/a.rs:10",
    ]);
  });

  it("lets a test that signals processes it didn't start be ignored, by that reason alone", () => {
    const source = [
      "#[test]",
      '#[ignore = "signals processes; runs in make test-real ARGS=rust"]',
      "fn a() { bazhen_test_signal::require_sandbox().unwrap(); }",
      '#[ignore = "signals processes"]',
      '#![ignore = "signals processes; runs in make test-real ARGS=rust"]',
      '#[cfg_attr(test, ignore = "signals processes; runs in make test-real ARGS=rust")]',
    ].join("\n");
    expect(scan(source).map((f) => f.split(": ")[0])).toEqual([
      "crates/x/src/a.rs:4",
      "crates/x/src/a.rs:5",
      "crates/x/src/a.rs:6",
    ]);
  });
  it("requires such a test to refuse to run off a sandbox, before anything else", () => {
    const ignored = '#[test]\n#[ignore = "signals processes; runs in make test-real ARGS=rust"]\n';
    const source = [
      `${ignored}fn a() {\n    bazhen_test_signal::require_sandbox().unwrap();\n    sweep();\n}`,
      `${ignored}fn b() -> Result<()> { bazhen_test_signal::require_sandbox()?; Ok(()) }`,
      `${ignored}fn c() { sweep(); bazhen_test_signal::require_sandbox().unwrap(); }`,
      `${ignored}fn d() { let _ = bazhen_test_signal::require_sandbox(); }`,
      `${ignored}fn e() {}`,
    ].join("\n");
    expect(scan(source).map((f) => f.split(": ")[0])).toEqual([
      "crates/x/src/a.rs:11",
      "crates/x/src/a.rs:14",
      "crates/x/src/a.rs:17",
    ]);
  });

  it("refuses code compiled only under a cfg the gates never build", () => {
    const source = [
      "#[cfg(not(debug_assertions))]",
      '#[cfg(feature = "slow")]',
      '#[cfg_attr(target_os = "windows", derive(Debug))]',
      "#[cfg(all(test, unix))]",
      "#[cfg(not(test))]",
      "#[cfg(test)]",
      "#[cfg(all(test))]",
      "#[cfg_attr(test, derive(Debug))]",
      "#[educe(Debug(ignore))]",
      "#[cfg_attr(test, ignore)]",
    ].join("\n");
    expect(scan(source).map((f) => f.split(": ")[0])).toEqual([
      "crates/x/src/a.rs:1",
      "crates/x/src/a.rs:2",
      "crates/x/src/a.rs:3",
      "crates/x/src/a.rs:4",
      "crates/x/src/a.rs:5",
      "crates/x/src/a.rs:10",
    ]);
  });

  it("lets code be built for Linux or macOS alone, which a gate each builds, and no other OS", () => {
    const source = [
      '#[cfg(target_os = "linux")]',
      '#[cfg(any(target_os = "linux", target_os = "macos"))]',
      '#[cfg_attr(target_os = "macos", derive(Debug))]',
      '#[cfg(target_os = r"linux")] // a raw string is read for its value',
      '#[cfg(target_os = "windows")]',
      '#[cfg(any(target_os = "linux", target_os = "freebsd"))]',
      '#[cfg(target_os = r#"windows"#)]',
      "#[cfg(target_os)]",
      '#[cfg(not(target_os = "linux"))]',
      "#[cfg(",
      '    target_os = "ios"',
      ")]",
      '#[cfg(target_os = r"windows")] // target_os = "linux"',
      '#[cfg(target_os = "linux")] #[cfg(target_os = "android")]',
      '#[cfg_attr(target_os = "linux", cfg(target_os = r"windows"))]',
    ].join("\n");
    const failures = scan(source);
    expect(failures.map((f) => f.split(": ")[0])).toEqual([
      "crates/x/src/a.rs:5",
      "crates/x/src/a.rs:6",
      "crates/x/src/a.rs:7",
      "crates/x/src/a.rs:8",
      "crates/x/src/a.rs:9",
      "crates/x/src/a.rs:10",
      "crates/x/src/a.rs:13",
      "crates/x/src/a.rs:14",
      "crates/x/src/a.rs:15",
    ]);
    const named = (line: number) =>
      failures.find((f) => f.startsWith(`crates/x/src/a.rs:${line}:`));
    expect(named(6)).toContain('target_os = "freebsd"');
    expect(named(7)).toContain('target_os = "windows"');
    expect(named(10)).toContain('target_os = "ios"');
    expect(named(13)).toContain('target_os = "windows"');
    expect(named(14)).toContain('target_os = "android"');
    expect(named(15)).toContain('target_os = "windows"');
  });

  it("reads a C raw string as a string, so it can't hide what follows", () => {
    const source = 'const A: &CStr = cr"\\";\n#[allow(dead_code)]\nfn f() {}\nconst B: &str = "x";';
    expect(scan(source)).toEqual([
      expect.stringContaining("crates/x/src/a.rs:2: #[allow(dead_code)]"),
    ]);
  });

  it("lets only an unsafe module expect unsafe_code, inner and with a reason, and nothing else", () => {
    const unsafeCode = '#![expect(unsafe_code, reason = "the PTY\'s FFI (openpty, ioctl)")]\n';
    expect(scan(unsafeCode, "crates/x/src/pty.rs")).toEqual([]);
    expect(scan(unsafeCode)).toHaveLength(1);
    const more = [
      "#![allow(unsafe_code)]",
      '#![expect(unsafe_code, dead_code, reason = "x")]',
      "#![expect(unsafe_code)]",
      '#[expect(unsafe_code, reason = "x")] fn f() {}',
    ].join("\n");
    expect(scan(more, "crates/x/src/pty.rs")).toHaveLength(4);
  });
});

describe("unsafeModuleFailures", () => {
  it("accepts a module with no children", () => {
    expect(unsafeModuleFailures("crates/x/src/pty.rs", "fn open() {}\n// mod later;\n")).toEqual(
      [],
    );
  });

  it("refuses a crate root, and a module declaring a child, inline or in a file", () => {
    expect([
      unsafeModuleFailures("crates/x/src/lib.rs", ""),
      unsafeModuleFailures("crates/x/src/main.rs", ""),
      unsafeModuleFailures("crates/x/src/bin/tool.rs", ""),
      unsafeModuleFailures("crates/x/src/pty.rs", "mod ffi;\n#[cfg(test)]\nmod tests {}\n"),
    ]).toEqual([
      [expect.stringContaining("is a crate root")],
      [expect.stringContaining("is a crate root")],
      [expect.stringContaining("is a crate root")],
      [expect.stringContaining("`mod ffi;`"), expect.stringContaining("`mod tests {`")],
    ]);
  });
});

const ROOT = "/repo/";
type Pkg = CargoMetadata["packages"][number];
const target = (kind: string, name: string, src: string, extra: object = {}) => ({
  kind: [kind],
  name,
  src_path: `${ROOT}${src}`,
  test: true,
  ...extra,
});
const pkg = (name: string, targets: Pkg["targets"], dependencies: Pkg["dependencies"] = []) => ({
  name,
  manifest_path: `${ROOT}crates/${name}/Cargo.toml`,
  targets,
  dependencies,
});
const meta = (...packages: Pkg[]): CargoMetadata => ({ workspace_root: ROOT, packages });
const files = ["crates/a/Cargo.toml", "crates/a/src/lib.rs", "crates/a/src/main.rs"];
const usual = () =>
  pkg(
    "a",
    [target("lib", "a", "crates/a/src/lib.rs"), target("bin", "a", "crates/a/src/main.rs")],
    [
      { name: "proptest", req: "=1.12.0", kind: "dev" },
      { name: "b", req: "*", kind: null, path: `${ROOT}crates/b` },
    ],
  );

describe("metadataFailures", () => {
  it("accepts targets where Cargo looks by default, and exact or local dependencies", () => {
    expect(metadataFailures(meta(usual()), files)).toEqual([]);
  });

  it("refuses a target elsewhere, however the manifest put it there", () => {
    const moved = usual();
    moved.targets = [target("lib", "a", "crates/a/src/lib.txt"), target("bin", "x", "x.rs")];
    expect(metadataFailures(meta(moved), [...files, "crates/a/src/lib.txt"])).toEqual([
      expect.stringContaining("target a is built from crates/a/src/lib.txt"),
      expect.stringContaining("target x is built from x.rs"),
      expect.stringContaining("crates/a/src/lib.rs: is where Cargo looks for a target"),
      expect.stringContaining("crates/a/src/main.rs: is where Cargo looks for a target"),
    ]);
  });

  it("refuses a build script, a proc macro, a build dependency and a loose version", () => {
    const odd = usual();
    odd.targets.push(target("custom-build", "build-script-build", "crates/a/build.rs"));
    odd.targets.push(target("proc-macro", "m", "crates/a/src/lib.rs"));
    odd.dependencies.push({ name: "cc", req: "=1.0.0", kind: "build" });
    odd.dependencies.push({ name: "serde", req: "^1", kind: null });
    expect(metadataFailures(meta(odd), files)).toEqual([
      expect.stringContaining("target build-script-build is a custom-build"),
      expect.stringContaining("target m is a proc-macro"),
      expect.stringContaining("cc is a build dependency"),
      expect.stringContaining("serde is `^1`"),
    ]);
  });

  it("refuses a target left out of the tests, or needing a feature", () => {
    const left = usual();
    left.targets = [
      target("lib", "a", "crates/a/src/lib.rs", { test: false }),
      target("bin", "a", "crates/a/src/main.rs", { "required-features": ["slow"] }),
    ];
    expect(metadataFailures(meta(left), files)).toEqual([
      expect.stringContaining("target a is left out of the tests"),
      expect.stringContaining("target a is left out of the tests"),
    ]);
  });

  it("refuses a crate in crates/ the workspace doesn't build, and a file no target builds", () => {
    expect(
      metadataFailures(meta(usual()), [...files, "crates/x/Cargo.toml", "crates/a/tests/t.rs"]),
    ).toEqual([
      expect.stringContaining("crates/x/Cargo.toml: isn't a member of the root workspace"),
      expect.stringContaining("crates/a/tests/t.rs: is where Cargo looks for a target"),
    ]);
  });
});

const local = (name: string) => ({ name, req: "*", kind: null, path: `${ROOT}crates/${name}` });
const dep = (name: string, kind: string | null = null) => ({ name, req: "=1.0.0", kind });

const report = (dependency: object) => ({
  workspace_root: ROOT,
  packages: [{ name: "x", manifest_path: "m", targets: [], dependencies: [dependency] }],
});

describe("heavyDependencyFailures", () => {
  const lock = [
    "version = 4",
    "",
    "[[package]]",
    'name = "axum"',
    'version = "1.0.0"',
    "dependencies = [",
    ' "hyper",',
    ' "tokio 1.0.0",',
    "]",
    "",
    "[[package]]",
    'name = "tokio"',
    'version = "1.0.0"',
    "",
    "[[package]]",
    'name = "hyper"',
    'version = "1.0.0"',
    "",
    "[[package]]",
    'name = "cli"',
    'version = "0.1.0"',
    "dependencies = [",
    ' "proptest",',
    ' "tokio",',
    "]",
  ].join("\n");
  const workspace = meta(
    pkg("cli", [], [local("client"), dep("tokio", "dev")]),
    pkg("client", [], [dep("serde")]),
    pkg("daemon", [], [local("client"), dep("axum")]),
    pkg("tool", [], [local("daemon")]),
  );

  it("reads each package's dependencies from Cargo.lock, a versioned entry by its name", () => {
    expect(lockGraph(lock).get("axum")).toEqual(["hyper", "tokio"]);
    expect(lockGraph(lock).get("tokio")).toEqual([]);
  });

  it("names each heavy crate a member builds, with the chain, through ours and theirs", () => {
    expect(heavyDependencyFailures(workspace, lock, {}, ["tokio", "axum"])).toEqual([
      expect.stringMatching(/^daemon: builds daemon → axum → tokio\. /),
      expect.stringMatching(/^daemon: builds daemon → axum\. /),
      expect.stringMatching(/^tool: builds tool → daemon → axum → tokio\. /),
      expect.stringMatching(/^tool: builds tool → daemon → axum\. /),
    ]);
  });

  it("passes a listed member, but not one that depends on it, nor a dev-dependency's reach", () => {
    expect(heavyDependencyFailures(workspace, lock, { daemon: "the daemon" }, ["tokio"])).toEqual([
      expect.stringMatching(/^tool: builds tool → daemon → axum → tokio\. .*HEAVY_ALLOWED/),
    ]);
  });

  const viaRustChecks = (paths: string[]) =>
    rustFailures(paths, (f) => (f === "Cargo.lock" ? lock : ""), {}, { metadata: workspace })
      .filter((f) => / builds |Cargo\.lock/.test(f))
      .map((f) => f.split(". ")[0]);

  it("is part of the Rust checks, which refuse a workspace with no Cargo.lock to read", () => {
    expect(viaRustChecks(["Cargo.lock"])).toEqual([
      "daemon: builds daemon → axum → tokio",
      "daemon: builds daemon → axum → hyper",
      "daemon: builds daemon → axum",
      "tool: builds tool → daemon → axum → tokio",
      "tool: builds tool → daemon → axum → hyper",
      "tool: builds tool → daemon → axum",
    ]);
    expect(viaRustChecks([])).toEqual(["Cargo.lock is missing; the gates build with --locked."]);
  });

  it("counts every dependency but a dev one, and reads no report with a dependency of no kind", () => {
    const built = meta(pkg("x", [], [dep("tokio", "build"), dep("axum", "normal")]));
    expect(
      heavyDependencyFailures(built, lock, {}, ["tokio", "axum"]).map((f) => f.split(". ")[0]),
    ).toEqual(["x: builds x → tokio", "x: builds x → axum"]);
    expect(isCargoMetadata(report({ name: "tokio", req: "=1.0.0", kind: null }))).toBe(true);
    expect(isCargoMetadata(report({ name: "tokio", req: "=1.0.0" }))).toBe(false);
  });

  it("names a listed member that reaches no heavy crate, or isn't a member", () => {
    expect(
      heavyDependencyFailures(workspace, lock, { daemon: "", tool: "", client: "", gone: "" }, [
        "tokio",
      ]),
    ).toEqual([
      "scripts/check-standards.ts: HEAVY_ALLOWED lists client, which reaches none of HEAVY_CRATES; remove it.",
      "scripts/check-standards.ts: HEAVY_ALLOWED lists missing gone.",
    ]);
  });
});

describe("harnessFailures", () => {
  it("refuses a harness of a test's own, however the key is spelled", () => {
    expect(
      [
        "[[test]]\nharness = false\n",
        '[[test]]\n"harness" = false\n',
        '[[test]]\nname = "t"\n"\\u0068arness" = false\n',
        '[package]\ndescription = "a \\"quoted\\" word"\n',
        "[lib]\ndoctest = false\n",
        '[dependencies]\nbazhen-harness = { workspace = true }\n"a-harness" = "1"\n',
      ].map((t) => harnessFailures("crates/a/Cargo.toml", t)),
    ).toEqual([
      [expect.stringContaining("sets a test harness")],
      [expect.stringContaining("sets a test harness")],
      [expect.stringContaining("holds a \\ escape")],
      [expect.stringContaining("holds a \\ escape")],
      [],
      [],
    ]);
  });
});

describe("macroFailures", () => {
  const source =
    '// macro_rules! in a comment\nlet s = "macro_rules!";\nmacro_rules! hide { () => {} }\n';

  it("refuses a macro defined outside MACRO_MODULES, and takes one in it", () => {
    expect([
      macroFailures("crates/a/src/lib.rs", source, {}),
      macroFailures("crates/a/src/lib.rs", source, { "crates/a/src/lib.rs": "read" }),
    ]).toEqual([[expect.stringContaining("crates/a/src/lib.rs:3: defines a macro")], []]);
  });
});

describe("inheritsWorkspaceLints", () => {
  it("is true for a [lints] table that says workspace = true, however it is laid out", () => {
    const tables = [
      '[package]\nname = "a"\n\n[lints]\nworkspace = true\n',
      "[lints] # shared\n\n# every crate\nworkspace = true # see Cargo.toml\n",
      "[lints]\r\nworkspace = true\r\n",
    ];
    expect(tables.map(inheritsWorkspaceLints)).toEqual([true, true, true]);
  });

  it("is false without one, or when it is off or in another table", () => {
    const tables = [
      '[package]\nname = "a"\n',
      "[lints]\nworkspace = false\n",
      '[lints.clippy]\npedantic = "warn"\n',
      "[lints]\n\n[package]\nworkspace = true\n",
    ];
    expect(tables.map(inheritsWorkspaceLints)).toEqual([false, false, false, false]);
  });
});

const clippyFailures = (text: string) =>
  rustFailures(["clippy.toml"], () => text, {}).filter((f) => f.startsWith("clippy.toml"));

describe("rustFailures", () => {
  const member =
    '[package]\nname = "a"\n\n[dependencies]\nproptest = { workspace = true }\n\n[lints]\nworkspace = true\n';
  const repo: Record<string, string> = {
    "crates/a/Cargo.toml": member,
    "crates/a/src/main.rs": "fn main() {}\n",
    "crates/b/Cargo.toml": "[package]\n",
    "crates/b/src/lib.rs": "#[expect(dead_code)]\nfn f() {}\n",
    "crates/b/src/meta.rs": "macro_rules! m { ($a:meta) => { #[$a] fn g() {} } }\n",
    "crates/b/src/pty.rs": "mod ffi;\n",
    "crates/c/Cargo.toml": `${member}\n[[test]]\nname = "t"\nharness = false\n`,
    "apps/x/Cargo.toml": member,
    "crates/a/b/Cargo.toml": member,
    "apps/x/src/sneaky.rs": "#![expect(unsafe_code)]\n",
    "crates/notes/README.md": "#[allow(x)]\n",
    "crates/a/.cargo/config.toml": "[build]\njobs = 2\n",
    "crates/a/clippy.toml": "allow-unwrap-in-tests = true\n",
    "rustfmt.toml": "max_width = 120\n",
    "crates/a/rust-toolchain.toml": '[toolchain]\nchannel = "nightly"\n',
  };
  const failures = rustFailures(Object.keys(repo), (p) => repo[p] ?? "", {
    "crates/a/src/gone.rs": "a module since removed",
    "crates/b/src/pty.rs": "the PTY's FFI",
  });
  const about = (path: string) =>
    failures.filter((f) => f.replace(/^([^:]+):\d+: /, "$1: ").startsWith(`${path}: `));

  it("refuses a crate or Rust source anywhere but crates/<name>", () => {
    expect([
      about("apps/x/Cargo.toml"),
      about("crates/a/b/Cargo.toml"),
      about("apps/x/src/sneaky.rs"),
    ]).toEqual([
      [expect.stringContaining("a crate lives in crates/<name>/")],
      [expect.stringContaining("a crate lives in crates/<name>/")],
      [expect.stringContaining("Rust source lives in a crate under crates/")],
    ]);
  });

  it("names a manifest without the workspace lints, a suppression, and an attribute a macro builds", () => {
    expect([
      about("crates/a/Cargo.toml"),
      about("crates/b/Cargo.toml"),
      about("crates/b/src/lib.rs"),
      about("crates/b/src/meta.rs"),
      about("crates/notes/README.md"),
    ]).toEqual([
      [],
      [expect.stringContaining("needs `[lints]`")],
      [expect.stringContaining("#[expect(dead_code)] suppresses a lint")],
      [expect.stringContaining("is built by a macro"), expect.stringContaining("defines a macro")],
      [],
    ]);
  });

  it("refuses a cargo config, and clippy, rustfmt or toolchain files, beside the root ones", () => {
    expect([
      about("crates/a/.cargo/config.toml"),
      about("crates/a/clippy.toml"),
      about("rustfmt.toml"),
      about("crates/a/rust-toolchain.toml"),
    ]).toEqual([
      [expect.stringContaining("cargo config")],
      [expect.stringContaining("only the root clippy.toml")],
      [expect.stringContaining("its defaults")],
      [expect.stringContaining("one toolchain pin")],
    ]);
  });

  it("reads each listed unsafe module, and each member's harness", () => {
    expect([about("crates/b/src/pty.rs"), about("crates/c/Cargo.toml")]).toEqual([
      [expect.stringContaining("declares a child module")],
      [expect.stringContaining("sets a test harness")],
    ]);
  });

  it("reads the workspace Cargo reports, and names a listed macro module that's gone", () => {
    const withMeta = rustFailures(
      ["crates/a/src/lib.rs"],
      () => "",
      {},
      {
        metadata: meta(pkg("a", [target("lib", "a", "crates/a/src/lib.txt")])),
        macroModules: { "crates/a/src/gone.rs": "read" },
      },
    );
    expect(withMeta.filter((f) => /crates\/a\/|MACRO_MODULES/.test(f))).toEqual([
      expect.stringContaining("target a is built from crates/a/src/lib.txt"),
      expect.stringContaining("crates/a/src/lib.rs: is where Cargo looks for a target"),
      "scripts/check-standards.ts: MACRO_MODULES lists missing crates/a/src/gone.rs.",
    ]);
  });

  it("names an unsafe module that no longer exists", () => {
    expect(about("scripts/check-standards.ts").filter((f) => f.includes("UNSAFE"))).toEqual([
      "scripts/check-standards.ts: UNSAFE_MODULES lists missing crates/a/src/gone.rs.",
    ]);
  });

  it("refuses a clippy.toml other than the standard's", () => {
    const standard = CLIPPY_CONFIG.join("\n");
    expect([
      clippyFailures(standard),
      clippyFailures(`${standard}\navoid-breaking-exported-api = false`),
    ]).toEqual([[], [expect.stringContaining("differs from CLIPPY_CONFIG")]]);
  });
});

const table = (header: string) => [header, ...(ROOT_TABLES[header] ?? []), ""];

describe("rootManifestFailures", () => {
  const root = [
    ...table("[workspace]"),
    ...table("[workspace.package]"),
    "# Pinned here.",
    "[workspace.dependencies]",
    'proptest = { version = "=1.12.0", default-features = false }',
    "",
    ...WORKSPACE_LINTS.flatMap((l) => (l.startsWith("[") ? ["", l] : [l])),
    "",
    ...table("[profile.release]"),
    ...table("[profile.release-holder]"),
    ...table("[profile.dev.package.bazhen-client]"),
  ].join("\n");

  const deps = (lines: string) =>
    rootManifestFailures(
      root.replace("[workspace.dependencies]\n", `[workspace.dependencies]\n${lines}\n`),
    );

  const wrapped = (version: string) =>
    deps(`rustix = { version = "${version}", features = [\n  "std",\n  "pty",\n] }`);

  it("accepts a manifest holding the standard's lints and exact pins", () => {
    expect(rootManifestFailures(root)).toEqual([]);
  });

  it("refuses a lint level that differs from the standard's", () => {
    const relaxed = root.replace('unwrap_used = "forbid"', 'unwrap_used = "deny"');
    const added = root.replace(
      "[workspace.lints.clippy]\n",
      '[workspace.lints.clippy]\ncast_lossless = "allow"\n',
    );
    expect([rootManifestFailures(relaxed), rootManifestFailures(added)]).toEqual([
      [expect.stringContaining("differs from WORKSPACE_LINTS")],
      [expect.stringContaining("differs from WORKSPACE_LINTS")],
    ]);
  });

  it("refuses a workspace other than the standard's: excluded crates, patches, other profiles", () => {
    expect([
      rootManifestFailures(
        root.replace('resolver = "3"', 'resolver = "3"\nexclude = ["crates/x"]'),
      ),
      rootManifestFailures(`${root}\n[patch.crates-io]\nproptest = { path = "crates/p" }\n`),
      rootManifestFailures(`${root}\n[profile.test]\noverflow-checks = false\n`),
      rootManifestFailures(root.replace("lto = true", "")),
      rootManifestFailures(root.replace(/\[profile\.release\][^[]*/, "")),
      rootManifestFailures(root.replace('panic = "unwind"', 'panic = "abort"')),
      rootManifestFailures(root.replace(/\[profile\.release-holder\][^[]*/, "")),
      rootManifestFailures(root.replace("opt-level = 3", "opt-level = 1")),
      rootManifestFailures(root.replace(/\[profile\.dev\.package\.bazhen-client\][^[]*/, "")),
    ]).toEqual([
      [expect.stringContaining("[workspace] differs from ROOT_TABLES")],
      [expect.stringContaining("[patch.crates-io] isn't one of the root manifest's tables")],
      [expect.stringContaining("[profile.test] isn't one of")],
      [expect.stringContaining("[profile.release] differs")],
      [expect.stringContaining("[profile.release] is missing")],
      [expect.stringContaining("[profile.release-holder] differs")],
      [expect.stringContaining("[profile.release-holder] is missing")],
      [expect.stringContaining("[profile.dev.package.bazhen-client] differs")],
      [expect.stringContaining("[profile.dev.package.bazhen-client] is missing")],
    ]);
  });

  it("refuses a workspace dependency not pinned exactly, but takes a path to a crate of ours", () => {
    expect([
      deps('serde = "1.0.200"'),
      deps('serde = { version = "^1", features = ["derive"] }'),
      deps('serde = { version = "=1.0.200", default-features = false }'),
      deps('holder-proto = { path = "crates/holder-proto" }'),
      deps('evil = { path = "vendor/evil" }'),
    ]).toEqual([
      [expect.stringContaining('`serde = "1.0.200"` must pin an exact version')],
      [expect.stringContaining("must pin an exact version")],
      [],
      [],
      [expect.stringContaining('(`path = "crates/<name>"`)')],
    ]);
  });

  it("reads an entry the formatter wrapped across lines as one", () => {
    expect([wrapped("=1.1.6"), wrapped("1.1")]).toEqual([
      [],
      [expect.stringContaining('`rustix = { version = "1.1", features = [ "std", "pty", ] }`')],
    ]);
  });
});

describe("memberDependencyFailures", () => {
  it("takes only dependencies inherited from the workspace", () => {
    const manifest = [
      "[dependencies]",
      "a = { workspace = true }",
      'b = { workspace = true, features = ["x"] }',
      "c.workspace = true",
      'd = "1.0"',
      "[dev-dependencies]",
      'e = { version = "=1.0" }',
      "[target.'cfg(unix)'.dependencies]",
      'f = { path = "../f" }',
      "[build-dependencies.g]",
      'version = "1"',
    ].join("\n");
    expect(memberDependencyFailures("crates/x/Cargo.toml", manifest)).toEqual([
      expect.stringContaining('`d = "1.0"` must be `{ workspace = true }`'),
      expect.stringContaining('`e = { version = "=1.0" }`'),
      expect.stringContaining('`f = { path = "../f" }`'),
      expect.stringContaining("[build-dependencies.g] must be an entry"),
    ]);
  });
});

function skill(frontmatter: string): string {
  return `---\nname: bz-x\n${frontmatter}\n---\n\n# X\n`;
}

describe("skillFailures", () => {
  const doc = ".agents/skills/bz-x/SKILL.md";
  const valid = "Does X. Use when changing Bazhen's source in this repository.";
  const failures = (frontmatter: string): string[] =>
    skillFailures(doc, "bz-x", skill(frontmatter));

  it("passes a valid skill", () => {
    expect(failures(`description: ${valid}`)).toEqual([]);
  });

  it.each([
    ["a quoted value", `description: "Does X (run: 2). ${valid}"`],
    [
      "an apostrophe doubled in single quotes",
      `description: 'Does X (run: 2). ${valid.replace("'", "''")}'`,
    ],
    ["an escape in double quotes", `description: "Does \\"X\\". ${valid}"`],
    ["a colon not followed by a space", `description: Runs pnpm test:real. ${valid}`],
    ["a hash not after a space", `description: Issue#3. ${valid}`],
    ["two spaces after the key", `description:  "a: b. ${valid}"`],
  ])("accepts %s, reading the value YAML reads", (_, frontmatter) => {
    expect(failures(frontmatter)).toEqual([]);
  });

  it.each([
    [
      '": " in a plain value',
      `description: Does X ("Refusing to run: 2 PTYs"). ${valid}`,
      'holds ": "',
    ],
    ["a plain value ending in a colon", `description: ${valid} Covers:`, 'ends in ":"'],
    ['" #" in a plain value', `description: ${valid} #2`, 'holds " #"'],
    ["a plain value starting with a backtick", `description: \`pnpm\` ${valid}`, 'starts with "`"'],
    ["a plain value starting with a dash", `description: - ${valid}`, 'starts with "-"'],
    ["a plain value starting with a star", `description: *X ${valid}`, 'starts with "*"'],
    [
      "text after a closing double quote",
      `description: "Refusing" to run: 2. ${valid}`,
      "after its closing quote",
    ],
    ["an unpaired apostrophe in single quotes", `description: '${valid}'`, "unpaired '"],
    [
      "a continuation line",
      `description: ${valid}\n  more: text`,
      '"  more: text" is not a one-line',
    ],
    ["a block scalar", `description: |\n  ${valid}`, 'starts with "|"'],
    ["a key repeated", `description: ${valid}\ndescription: ${valid}`, "description appears twice"],
  ])("rejects %s", (_, frontmatter, problem) => {
    expect(failures(frontmatter)).toContainEqual(expect.stringContaining(problem));
  });

  it.each([
    ["name", "name: *bz-x\ndescription: " + valid],
    ["description", "name: bz-x\ndescription: *X"],
  ])("reports only the parse problem when %s fails to parse", (key, frontmatter) => {
    expect(skillFailures(doc, "bz-x", `---\n${frontmatter}\n---\n`)).toEqual([
      expect.stringContaining(`frontmatter ${key} starts with "*"`),
    ]);
  });

  it("checks the description as YAML reads it, not as written", () => {
    expect(failures(`description: '${valid.replace("'", "''")}'`)).toEqual([]);
    expect(failures(`description: "${valid.replace("'", "\\u0027")}"`)).toEqual([]);
  });
});

describe("rustFailures on the gates' own configuration", () => {
  const standard: Record<string, string> = {
    "deny.toml": DENY_CONFIG.join("\n"),
    "clippy.toml": CLIPPY_CONFIG.join("\n"),
    "rust-toolchain.toml": TOOLCHAIN_CONFIG.join("\n"),
    ".cargo/config.toml": CARGO_CONFIG.join("\n"),
    ".cargo/mutants.toml": MUTANTS_CONFIG.join("\n"),
    "scripts/xtask.sh": `#!/bin/sh\n# Why.\n\n${XTASK_WRAPPER.slice(1).join("\n  # and\n")}\n`,
    "scripts/cargo-config.medium.test.ts": "RUSTFLAGS",
    "scripts/rust-gate.ts": "RUSTFLAGS",
    "scripts/rust-gate.test.ts": "RUSTFLAGS",
    "scripts/xtask-gate.medium.test.ts": "RUSTFLAGS",
    "crates/bazhen-xtask/src/gate.rs": "RUSTFLAGS",
    "crates/bazhen-xtask/src/cargo_config.rs": "RUSTFLAGS",
    "scripts/check-standards.ts": "RUSTFLAGS",
    "scripts/check-standards.test.ts": "RUSTFLAGS",
    "docs/standards/rust.md": "`RUSTFLAGS` and `--cap-lints` are removed by the gate.",
  };
  const failures = (extra: Record<string, string>, drop: string[] = []) => {
    const repo = { ...standard, ...extra };
    const paths = Object.keys(repo).filter((p) => !drop.includes(p));
    return rustFailures(paths, (p) => repo[p] ?? "", {});
  };

  it("accepts the standard's configuration, and flags named only where they are removed", () => {
    expect(failures({})).toEqual([]);
  });

  it("refuses a deny.toml other than the standard's, or none", () => {
    expect([
      failures({ "deny.toml": DENY_CONFIG.join("\n").replace('"deny"', '"warn"') }),
      failures({}, ["deny.toml"]),
      failures({ "crates/a/deny.toml": "" }),
    ]).toEqual([
      [expect.stringContaining("deny.toml: differs from DENY_CONFIG")],
      [expect.stringContaining("deny.toml is missing")],
      [expect.stringContaining("reads only the root deny.toml")],
    ]);
  });

  it("refuses a toolchain other than the pinned one, such as one at a path", () => {
    const fake = '[toolchain]\npath = "/repo/crates/x/tc"\n';
    expect([
      failures({ "rust-toolchain.toml": fake }),
      failures({}, ["rust-toolchain.toml"]),
    ]).toEqual([
      [expect.stringContaining("rust-toolchain.toml: differs from TOOLCHAIN_CONFIG")],
      [expect.stringContaining("rust-toolchain.toml is missing")],
    ]);
  });

  it("refuses a gate wrapper that differs from the pinned one but in comments, or none", () => {
    const edited = XTASK_WRAPPER.join("\n").replace('exec "$bin" "$@"', 'exec cargo xtask "$@"');
    expect([failures({ "scripts/xtask.sh": edited }), failures({}, ["scripts/xtask.sh"])]).toEqual([
      ["scripts/xtask.sh: differs from XTASK_WRAPPER in scripts/check-standards.ts."],
      [
        "scripts/check-standards.ts: RUST_FLAG_EXEMPT lists missing scripts/xtask.sh.",
        "scripts/xtask.sh is missing; the Rust gates need it.",
      ],
    ]);
  });

  it("refuses a .cargo/config, which cargo reads in place of the pinned one", () => {
    expect(failures({ ".cargo/config": "[build]\njobs = 2\n" })).toEqual([
      expect.stringContaining(".cargo/config: cargo config can pass flags"),
    ]);
  });

  it("refuses a cargo config without the capping test runner, or none", () => {
    expect([
      failures({ ".cargo/config.toml": "[build]\njobs = 2\n" }),
      failures({}, [".cargo/config.toml"]),
    ]).toEqual([
      [expect.stringContaining(".cargo/config.toml: differs from CARGO_CONFIG")],
      [
        "scripts/check-standards.ts: RUST_FLAG_EXEMPT lists missing .cargo/config.toml.",
        expect.stringContaining(".cargo/config.toml is missing"),
      ],
    ]);
  });

  it("refuses a cargo-mutants config whose test tool would run doctests uncapped", () => {
    expect(failures({ ".cargo/mutants.toml": 'test_tool = "cargo"\n' })).toEqual([
      expect.stringContaining(".cargo/mutants.toml: differs from MUTANTS_CONFIG"),
    ]);
  });

  it("refuses a nextest config, which could filter tests out", () => {
    expect(failures({ ".config/nextest.toml": "[profile.default]\n" })).toEqual([
      expect.stringContaining("nextest runs with its defaults"),
    ]);
  });

  it("refuses a lint-loosening flag set anywhere a gate could run, however it is spelled", () => {
    expect(
      failures({
        ".github/workflows/ci.yml": "env:\n  RUSTFLAGS: -A warnings\n",
        "tests/real/Dockerfile": "ENV CARGO_ENCODED_RUSTFLAGS=--cap-lints=allow\n",
        "scripts/build.ts": 'env: { CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "" }',
        "crates/a/run.sh": "cargo --config 'build.rustc-wrapper=\"x\"' build\n",
        "Cargo.toml.bak": "[alias]\n# CARGO_ALIAS_CLIPPY\n",
        "scripts/a.sh": "cargo clippy -- --cap-lints allow\n",
        "scripts/b.sh": "RUSTDOCFLAGS=-Awarnings cargo doc\n",
        "crates/a/x.toml": '[build]\nrustflags = ["-A", "warnings"]\n',
        "scripts/c.sh": "RUSTC_WORKSPACE_WRAPPER=x cargo check\n",
      }).map((f) => f.split(":")[0]),
    ).toEqual([
      ".github/workflows/ci.yml",
      "tests/real/Dockerfile",
      "scripts/build.ts",
      "crates/a/run.sh",
      "Cargo.toml.bak",
      "scripts/a.sh",
      "scripts/b.sh",
      "crates/a/x.toml",
      "scripts/c.sh",
    ]);
  });

  it("names an exempt file that no longer exists", () => {
    expect(failures({}, ["scripts/rust-gate.test.ts"])).toEqual([
      "scripts/check-standards.ts: RUST_FLAG_EXEMPT lists missing scripts/rust-gate.test.ts.",
    ]);
  });
});

/** A capped test script's failures at the given caps. */
const overCap = (memory: number, minutes: number) =>
  cappedScriptFailures("package.json", {
    t: `node scripts/capped.ts --memory ${memory}G --time ${minutes}m -- vitest run`,
  });

describe("cappedScriptFailures", () => {
  const cap = "node scripts/capped.ts --memory 8G --time 20m --";

  it("accepts a capped test step, a script that only runs another, and no test at all", () => {
    expect(
      cappedScriptFailures("package.json", {
        test: `${cap} vitest run --project unit`,
        "test:medium": `pnpm run build:hook && ${cap} vitest run --project medium`,
        check: "pnpm run lint && pnpm run test:rust",
        "lint:rust": "scripts/xtask.sh gate lint",
      }),
    ).toEqual([]);
  });

  it("accepts a workspace package's script reaching capped.ts by a relative path", () => {
    const e2e = { test: "node ../../scripts/capped.ts --memory 8G --time 20m -- playwright test" };
    expect(cappedScriptFailures("tests/e2e/package.json", e2e)).toEqual([]);
  });

  it("refuses each runner started without a cap, wherever it sits in the script", () => {
    expect(
      [
        "vitest run",
        "pnpm run build:hook && vitest run --project medium",
        "playwright test",
        "cargo-nextest nextest run",
        "cargo mutants --in-diff x",
        "cargo +nightly test",
        "cargo nextest run",
        "cargo bench",
        "cargo +nightly-2026-11-01 fuzz run parse_reply",
        "cargo xtask gate test",
        "scripts/xtask.sh gate test-all",
        "node scripts/falsify.ts",
        "node scripts/hook-bench.ts",
        "node scripts/test-real.ts",
        `vitest run && ${cap} vitest run`,
      ].map((t) => cappedScriptFailures("package.json", { t }).length),
    ).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("refuses a capped step joined by anything but && to one that could run round it", () => {
    expect(
      ["; vitest", " | tee x", " & vitest", "\nvitest", " $(vitest)", " `vitest`"].map(
        (tail) => cappedScriptFailures("package.json", { t: `${cap} vitest run${tail}` })[0],
      ),
    ).toEqual(Array.from({ length: 6 }, () => expect.stringContaining("`&&` alone")));
  });

  it("keeps a run that counts its memory kills where it may, and flags one anywhere else", () => {
    const counted = "node scripts/capped.ts --memory 8G --time 120m --memory-kills-counted --";
    const may = new Set(["test-falsify"]);
    const flagged = [expect.stringContaining("passes capped `--memory-kills-counted`")];
    expect([
      cappedScriptFailures(
        "Makefile",
        { "test-falsify": `${counted} node scripts/falsify.ts` },
        "recipe",
        may,
      ),
      cappedScriptFailures("Makefile", { "test-medium": `${counted} vitest run` }, "recipe", may),
      cappedScriptFailures("Makefile", { capped: `${counted} sh -c true` }, "recipe", may),
      cappedScriptFailures("package.json", {
        "test-falsify": `${counted} node scripts/falsify.ts`,
      }),
    ]).toEqual([[], flagged, flagged, flagged]);
  });

  it("refuses a cap too big to bite", () => {
    expect([
      overCap(MAX_CAP.gib, MAX_CAP.minutes),
      overCap(MAX_CAP.gib + 1, 20),
      overCap(8, MAX_CAP.minutes + 1),
    ]).toEqual([
      [],
      [expect.stringContaining("too big to bite")],
      [expect.stringContaining("too big")],
    ]);
  });
});

/** A .PHONY target of a Makefile, its recipe a line each, with `doc` after its `##`. */
const makeRule = (name: string, lines: readonly string[], doc?: string) =>
  `.PHONY: ${name}\n${name}:${doc === undefined ? "" : ` ## ${doc}`}\n` +
  lines.map((line) => `\t${line}\n`).join("");
/** A package.json with these scripts. */
const packageJson = (scripts: Record<string, string>) => JSON.stringify({ scripts });
const standardMakefile = [
  ...MAKEFILE_SETTINGS,
  "",
  makeRule("help", [HELP_COMMAND], "This menu"),
  makeRule(
    "check",
    (GATE_STEPS["check"] ?? []).map((step) => `$(MAKE) ${step}`),
    "Every gate",
  ),
  makeRule("check-ts", ["$(MAKE) format-check"], "Half"),
  makeRule(
    "check-rust",
    ["$(MAKE) rust-schema-check", "$(MAKE) lint-rust", "$(MAKE) deny"],
    "Half",
  ),
  makeRule("format-check", ["$(MAKE) gate-fmt", `oxfmt --check ${OWN_ARGS}`], "Formatting"),
  makeRule("rust-schema-check", [`scripts/xtask.sh schema --check ${OWN_ARGS}`]),
  ...Object.entries(RUST_GATE_TASKS).map(([name, command]) =>
    makeRule(name, [`${command} ${OWN_ARGS}`]),
  ),
].join("\n");

describe("makefileFailures", () => {
  const standard: Record<string, string> = {
    Makefile: standardMakefile,
    "package.json": packageJson({ prepare: "husky" }),
    "apps/web/package.json": JSON.stringify({ dependencies: { vite: "1.0.0" } }),
  };
  const failures = (extra: Record<string, string>, drop: string[] = []) => {
    const repo = { ...standard, ...extra };
    const paths = Object.keys(repo).filter((p) => !drop.includes(p));
    return makefileFailures(paths, (p) => repo[p] ?? "");
  };
  /** The standard Makefile with these lines after it. */
  const plus = (...lines: string[]) => ({ Makefile: `${standardMakefile}\n${lines.join("\n")}\n` });
  /** The standard Makefile with a target `t` whose recipe is `lines`. */
  const withTarget = (...lines: string[]) => plus(makeRule("t", lines, "A target"));
  const edited = (from: string, to: string) => ({ Makefile: standardMakefile.replace(from, to) });

  it("accepts the standard's settings, targets and package.json", () => {
    expect(failures({})).toEqual([]);
  });

  it("refuses a target make could take as up to date, and a .PHONY naming no target", () => {
    expect([failures(edited(".PHONY: deny\n", "")), failures(plus(".PHONY: gone"))]).toEqual([
      [expect.stringContaining('the "deny" target must be .PHONY')],
      ["Makefile: .PHONY names `gone`, which is no target."],
    ]);
  });

  it("runs deps in order, one `$(MAKE)` line each before the target's own command", () => {
    expect([
      failures(withTarget("$(MAKE) deny", "$(MAKE) lint-rust", `vite build ${OWN_ARGS}`)),
      failures(plus(".PHONY: t", "t: deny", "\tvite build")),
      failures(withTarget("vite build", "$(MAKE) deny")),
      failures(withTarget("$(MAKE) deny lint-rust")),
      failures(withTarget("$(MAKE) deny ARGS=x")),
      failures(withTarget("$(MAKE) deny && vite build")),
      failures(withTarget("$(MAKE) gone")),
    ]).toEqual([
      [],
      [expect.stringContaining('the "t" target names prerequisites')],
      [expect.stringContaining('the "t" target runs a dep after its own command')],
      [expect.stringContaining("must run one dep and nothing else")],
      [expect.stringContaining("must run one dep and nothing else")],
      [expect.stringContaining("runs $(MAKE) inside a command")],
      [expect.stringContaining('the "t" target runs `gone`, which is no target')],
    ]);
  });

  it("lets only the targets PARALLEL_TARGETS lists run their deps at once, a job each", () => {
    expect(Object.keys(PARALLEL_TARGETS)).toEqual(["dev"]);
    expect([
      failures(plus(makeRule("dev", ["$(MAKE) -j2 deny lint-rust"], "Servers"))),
      failures(plus(makeRule("dev", ["$(MAKE) -j3 deny lint-rust"], "Servers"))),
      failures(withTarget("$(MAKE) -j2 deny lint-rust")),
    ]).toEqual([
      [],
      [expect.stringContaining('the "dev" target runs its deps at once')],
      [expect.stringContaining('the "t" target runs its deps at once')],
    ]);
  });

  it("refuses what make reads and the check doesn't: a variable, an include, a rule it can't read", () => {
    expect([
      failures(withTarget("vite build $(FLAGS)")),
      failures(withTarget("echo $HOME")),
      failures(withTarget("echo $${HOME} $(value ARGS)")),
      failures(plus("FLAGS = --x")),
      failures(plus("include other.mk")),
      failures(plus("%.o: %.c", "\tcc $<")),
      failures(plus("\techo stray")),
    ]).toEqual([
      [expect.stringContaining('the "t" target names `$(FLAGS)`')],
      [expect.stringContaining('the "t" target names `$H`')],
      [],
      [expect.stringContaining("make reads `FLAGS = --x`")],
      [expect.stringContaining("make reads `include other.mk`")],
      [
        expect.stringContaining("make reads `%.o: %.c`"),
        expect.stringContaining("follows no target"),
      ],
      [expect.stringContaining("a recipe line that follows no target")],
    ]);
  });

  it("refuses a line whose failure make would pass, a second command and a target that runs nothing", () => {
    expect([
      failures(withTarget("-vite build")),
      failures(withTarget("+vite build")),
      failures(withTarget("vite build", "chmod -R g-w dist")),
      failures(plus(".PHONY: t", "t: ## Nothing")),
      failures(plus(makeRule("deny", ["true"]))),
    ]).toEqual([
      [expect.stringContaining("starts a line with `-`")],
      [expect.stringContaining("starts a line with `+`")],
      [expect.stringContaining('the "t" target has a second command line')],
      [expect.stringContaining('the "t" target has no recipe')],
      [
        expect.stringContaining('the "deny" target is defined twice'),
        expect.stringContaining('the "deny" target must run'),
      ],
    ]);
  });

  it("needs the settings that keep ARGS to the named target, and no makefile but the root's", () => {
    expect([
      failures(edited("unexport ARGS\n", "")),
      failures({ "apps/web/Makefile": "", GNUmakefile: "", "tools/x.mk": "" }),
      failures({}, ["Makefile"]),
    ]).toEqual([
      [expect.stringContaining("needs `unexport ARGS`")],
      [
        expect.stringContaining("apps/web/Makefile: make would read it"),
        expect.stringContaining("GNUmakefile: make would read it"),
        expect.stringContaining("tools/x.mk: make would read it"),
      ],
      [
        "Makefile is missing; its targets are the repository's commands.",
        expect.stringContaining('the "help" target'),
        ...Object.keys(RUST_GATE_TASKS).map(() => expect.stringContaining("target must run")),
        ...["format-check", "lint-rust", "deny", "test-rust", "rust-schema-check", "gate-fmt"].map(
          (step) => expect.stringContaining(`must run \`${step}\` among its deps`),
        ),
      ],
    ]);
  });

  it("refuses a target that starts tests without a cap, and counts memory kills only where it may", () => {
    const counted = "node scripts/capped.ts --memory 8G --time 120m --memory-kills-counted --";
    expect([
      failures(withTarget(`vitest run ${OWN_ARGS}`)),
      failures(
        withTarget(
          "cd tests/e2e && node ../../scripts/capped.ts --memory 4G --time 9m -- playwright test",
        ),
      ),
      failures(
        withTarget("node scripts/capped.ts --memory 4G --time 9m -- vitest run; vitest run"),
      ),
      failures(
        plus(makeRule("test-falsify", [`${counted} node scripts/falsify.ts ${OWN_ARGS}`], "Tests")),
      ),
      failures(plus(makeRule("test-medium", [`${counted} vitest run`], "Tests"))),
    ]).toEqual([
      [expect.stringContaining('the "t" target starts tests without a memory and time cap')],
      [],
      [expect.stringContaining("`&&` alone")],
      [],
      [expect.stringContaining("passes capped `--memory-kills-counted`")],
    ]);
  });

  it("holds the gates to their pinned commands, check and format-check to running them, and help to the menu", () => {
    expect([
      failures(edited(`${RUST_GATE_TASKS["lint-rust"]} ${OWN_ARGS}`, "cargo clippy --workspace")),
      failures(edited("\t$(MAKE) deny\n", "")),
      failures(edited("\t$(MAKE) gate-fmt\n", "")),
      failures(edited(".PHONY: deny\ndeny:\n", ".PHONY: deny\ndeny:\n\t$(MAKE) gate-fmt\n")),
      failures(edited(HELP_COMMAND, "@echo menu")),
    ]).toEqual([
      [expect.stringContaining('the "lint-rust" target must run')],
      [
        'Makefile: the "check" target must run `deny` among its deps.',
        expect.stringContaining('check-ts and check-rust run `deny` and "check" doesn\'t'),
      ],
      ['Makefile: the "format-check" target must run `gate-fmt` among its deps.'],
      [expect.stringContaining('the "deny" target must run')],
      [expect.stringContaining('the "help" target, on its own menu, must run')],
    ]);
  });

  it("keeps check's steps, test-rust aside, to the halves CI runs, and the halves to check's", () => {
    const rust = ["$(MAKE) rust-schema-check", "$(MAKE) lint-rust", "$(MAKE) deny"];
    const halves = { "check-ts": ["$(MAKE) format-check"], "check-rust": rust };
    const half = (name: keyof typeof halves, lines: string[]) =>
      edited(makeRule(name, halves[name], "Half"), makeRule(name, lines, "Half"));
    expect(CHECK_HALVES).toEqual(["check-ts", "check-rust"]);
    expect([
      failures(half("check-rust", rust.slice(0, 2))),
      failures(half("check-ts", ["$(MAKE) format-check", "$(MAKE) test-rust"])),
      failures(half("check-ts", ["$(MAKE) format-check", "$(MAKE) gate-fmt"])),
    ]).toEqual([
      [
        expect.stringContaining(
          'the "check" target runs `deny`, which neither of check-ts and check-rust does',
        ),
      ],
      [expect.stringContaining('check-ts and check-rust run `test-rust` and "check" doesn\'t')],
      [expect.stringContaining('check-ts and check-rust run `gate-fmt` and "check" doesn\'t')],
    ]);
  });

  it("keeps package.json to pnpm's install hook", () => {
    expect([
      failures({ "package.json": packageJson({ prepare: "husky", check: "make check" }) }),
      failures({ "package.json": packageJson({ prepare: "husky --x" }) }),
      failures({ "apps/web/package.json": packageJson({ dev: "vite" }) }),
    ]).toEqual([
      [expect.stringContaining('package.json: the "check" script belongs in a Makefile target')],
      ['package.json: the "prepare" script must be `husky`.'],
      [
        expect.stringContaining(
          'apps/web/package.json: the "dev" script belongs in a Makefile target',
        ),
      ],
    ]);
  });
});

describe("menuTargets", () => {
  it("lists the targets with a `##`, which make help shows, and not the ones without", () => {
    expect([...menuTargets(makefileTargets(standardMakefile).targets)].toSorted()).toEqual([
      "check",
      "check-rust",
      "check-ts",
      "format-check",
      "help",
    ]);
  });
});

describe("makeTargets", () => {
  it("reads the targets a make command names, past the variables set for it and its options, and none in prose", () => {
    expect(
      [
        "make check",
        "make test-real ARGS=rust",
        "PROPTEST_RNG_SEED=1 make test-rust",
        "make -C ../.. web-dev",
        "make -j2 daemon-dev web-dev",
        "make test-falsify ARGS='--base x' && make other",
        "run make check",
        "make",
        "make $TASK",
        "make dev exited at start:",
      ].map(makeTargets),
    ).toEqual([
      ["check"],
      ["test-real"],
      ["test-rust"],
      ["web-dev"],
      ["daemon-dev", "web-dev"],
      ["test-falsify"],
      [],
      [],
      [],
      [],
    ]);
  });
});

describe("makeNameFailures", () => {
  const menu = new Set(["check", "test-real", "test-holder"]);
  it("flags a target off the menu that a doc, script or workflow names, and passes one on it", () => {
    expect([
      makeNameFailures("docs/x.md", "Run `make check`, then `make tests`.\n", menu),
      makeNameFailures("docs/x.md", "```sh\nmake test-real ARGS=rust\nmake gone\n```\n", menu),
      makeNameFailures("docs/x.md", "To make sure, make gone.\n", menu),
      makeNameFailures("x.yml", "      - run: make check && make gone\n      # make gone\n", menu),
      makeNameFailures("x.sh", 'if ! FC_SEED="$s" make gone; then\n', menu),
      makeNameFailures(
        "x.ts",
        '// `make gone`\nrun("make", ["test-holder"]);\nrun("make", ["gone"]);\n',
        menu,
      ),
      makeNameFailures("x.ts", 'const why = "make gone";\n', menu),
    ]).toEqual([
      ["docs/x.md: names `make tests`, which is not a target on `make help`'s menu."],
      [expect.stringContaining("names `make gone`")],
      [],
      [expect.stringContaining("names `make gone`")],
      [expect.stringContaining("names `make gone`")],
      [expect.stringContaining("names `make gone`")],
      [],
    ]);
  });
});

// How long byteTakers takes to read `source`, in ms.
const elapsed = (source: string) => {
  const from = performance.now();
  byteTakers(source);
  return performance.now() - from;
};

describe("byteTakers", () => {
  it("names each function that takes bytes from outside, by parameter or bound", () => {
    const source = [
      "#[cfg(test)]",
      "use std::io::Cursor;",
      "pub fn parse(frame: &[u8]) -> Option<Frame> { None }",
      "fn fill(buf: &mut [u8]) {}",
      "fn header(bytes: [u8; 4]) {}",
      "fn own(bytes: Vec<u8>) {}",
      "fn from(r: impl Read) {}",
      "fn feed<R: BufRead>(r: R) {}",
      "fn pump<R>(r: R) where R: std::io::Read {}",
      "fn drain<R>(r: R) -> usize where R: Read { 0 }",
      "fn twice(a: fn() -> u8, c: fn() -> u8, b: [u8; 4]) {}",
      "fn any(b: impl AsRef<[u8]>) {}",
      "fn boxed(b: Box<[u8]>, c: Cow<'_, [u8]>) {}",
      "#[cfg(test)]",
      "const _: bool = 1 < 2;",
      "fn spelled(b: &[core::primitive::u8]) {}",
      "fn piped(i: Stdin, l: StdinLock<'_>) {}",
      "fn child(o: ChildStdout) {}",
      "fn reads(r: impl AsyncRead) {}",
      "fn chunk<B: Buf>(b: B) {}",
      "fn queued(q: VecDeque<u8>) {}",
      "fn each(i: impl Iterator<Item = u8>) {}",
      "unsafe fn raw(p: *const u8, q: *mut u8) {}",
    ].join("\n");
    expect(byteTakers(source)).toEqual([
      "parse",
      "fill",
      "header",
      "own",
      "from",
      "feed",
      "pump",
      "drain",
      "twice",
      "any",
      "boxed",
      "spelled",
      "piped",
      "child",
      "reads",
      "chunk",
      "queued",
      "each",
      "raw",
    ]);
  });

  it("reads an impl's head past an array or a brace block, for its bound and its type", () => {
    const source = [
      "pub struct Gate<const B: bool> { n: u32 }",
      "impl<T> Peek for T where T: AsRef<[u8; 4]> { fn peek(&self) -> u32 { 0 } }",
      "impl<T> Look for T where T: AsRef<[u16; 4]> { fn look(&self) -> u32 { 0 } }",
      "impl<R, const N: usize> Gate<{ N > 1 }> where R: Read { fn pull(&self) {} }",
      "impl<R, const N: usize> Gate<{ N > 1 }> where R: Clone { fn hold(&self) {} }",
      "fn wrapped() -> (",
      "    impl Future<Output = u8>,",
      "    u8,",
      ") { todo() }",
    ].join("\n");
    expect(byteTakers(source)).toEqual(["T::peek", "Gate::pull"]);
  });

  it("reads an array's length in an impl's head as an expression, its << and >> operators", () => {
    const source = [
      "impl<T> Peek for T where T: AsRef<[u8; 8 >> 1]> { fn peek(&self) -> u32 { 0 } }",
      "impl<T> Look for T where T: AsRef<[u16; 1 << 2]> { fn look(&self) -> u32 { 0 } }",
    ].join("\n");
    expect(byteTakers(source)).toEqual(["T::peek"]);
  });

  it("reads an impl a macro's body writes on a line of its own, after a ( or a $(", () => {
    const source = [
      "macro_rules! readers {",
      "    () => (",
      "        impl<R: Read> Reader<R> {",
      "            pub fn pull(&mut self) {}",
      "        }",
      "        impl<T> Peek for T where T: AsRef<[u8; 4]> {",
      "            fn peek(&self) -> u32 { 0 }",
      "        }",
      "    );",
      "    ($($t:ident),*) => {",
      "        $(",
      "        impl<S: BufRead> Feed<S> {",
      "            pub fn feed(&mut self) {}",
      "        }",
      "        )*",
      "    };",
      "}",
    ].join("\n");
    expect(byteTakers(source)).toEqual(["Reader::pull", "T::peek", "Feed::feed"]);
  });

  it("reads a file of impl heads it can't finish in time linear in its length", () => {
    const lines = 20_000;
    expect({
      open: elapsed("impl X<(\n".repeat(lines)) < 500,
      braces: elapsed("impl X<{\n".repeat(lines)) < 500,
      wrapped: elapsed("(\nimpl X<(\n".repeat(lines)) < 500,
    }).toEqual({ open: true, braces: true, wrapped: true });
  });

  it("leaves a function that only holds a socket, a file or an fd, and names one reading it", () => {
    const source = [
      "fn serve(s: &mut UnixStream) {}",
      "fn size(f: File) -> u64 { f.metadata().len() }",
      "fn listen(l: UnixListener) -> UnixStream { l.accept() }",
      "fn owned(fd: OwnedFd) { ioctl(&fd, 0) }",
      "fn spawned(c: Child) {}",
      "fn net(s: TcpStream, u: UdpSocket) {}",
      "fn drain(s: &mut UnixStream) { s.read(&mut chunk) }",
      "fn frames(ws: &mut WebSocket<UnixStream>) { match ws.read() { _ => {} } }",
      "fn lines(r: BufReader<File>) { for l in r.lines() {} }",
      "fn pulled<R: AsyncBufRead>(r: R) {}",
    ].join("\n");
    expect(byteTakers(source)).toEqual(["drain", "frames", "lines", "pulled"]);
  });

  it("names a function that reads in its body, and leaves what only looks like a read", () => {
    const source = [
      "fn method(s: &Sock) { s.read(&mut b) }",
      "fn exact() { f.read_exact(&mut head) }",
      "fn whole() { s.read_to_end(&mut all) }",
      "fn text() { f.read_to_string(&mut s) }",
      "fn line() { r.read_line(&mut s) }",
      "fn until() { r.read_until(b'\\n', &mut v) }",
      "fn vectored() { s.read_vectored(&mut bufs) }",
      "fn into() { s.read_buf(&mut cursor) }",
      "fn received() { sock.recv(&mut b) }",
      "fn from() { sock.recv_from(&mut b) }",
      "fn gathered() { sock.recv_vectored(&mut bufs) }",
      "fn peeked() { sock.peek(&mut b) }",
      "fn peeked_from() { sock.peek_from(&mut b) }",
      "fn filled() { r.fill_buf() }",
      "fn raw(fd: BorrowedFd<'_>) { rustix::io::read(fd, &mut b) }",
      "fn bare() { read(fd, &mut b) }",
      "fn ufcs() { Read::read_exact(&mut s, &mut b) }",
      "fn file() { std::fs::read(path) }",
      "fn file_text() { fs::read_to_string(path) }",
      "fn received_raw() { unsafe { libc::recv(fd, p, n, 0) } }",
      "fn received_from() { libc::recvfrom(fd, p, n, 0, a, l) }",
      "fn received_msg() { libc::recvmsg(fd, m, 0) }",
      "fn positioned() { libc::pread(fd, p, n, 0) }",
      "fn scattered() { libc::readv(fd, v, 2) }",
      "fn scattered_at() { libc::preadv(fd, v, 2, 0) }",
      "fn copied() { io::copy(&mut from, &mut to) }",
      "fn json() { serde_json::from_reader(f) }",
      "fn buffered() { let r = BufReader::new(f); }",
      "fn locked() { io::stdin().lock() }",
      "fn bound() { let input = io::stdin(); }",
      "fn lines() { std::io::stdin().lines() }",
      "fn each() { io::stdin().bytes() }",
      "fn spaced() { s . read (\n &mut b) }",
      "fn opened() { OpenOptions::new().read(true).open(p)?.read_to_end(&mut v) }",
      "fn closure() { let f = |s: &mut T| s.read(&mut b); }",
      "fn at() { f.read_at(&mut b, 0) }",
      "fn exact_at() { f.read_exact_at(&mut b, 0) }",
      "fn many() { libc::recvmmsg(fd, v, n, 0, t) }",
      "fn buf_exact() { r.read_buf_exact(cursor) }",
      "fn copied_bare() { copy(&mut from, &mut to) }",
      "fn moved() { std::ptr::copy(a, b, n) }",
      "fn sliced() { v.copy_from_slice(w) }",
      "fn guarded() -> RwLockReadGuard<'_, u8> { lock.read() }",
      "fn options() { OpenOptions::new().read(true).write(false).open(p) }",
      "fn closed() { o.read( false ) }",
      "fn channel() { rx.recv() }",
      "fn waited() { rx.recv_timeout(d) }",
      "fn ahead() { chars.peek() }",
      "fn tty() { isatty(io::stdin()) }",
      "fn termios() { tcgetattr(io::stdin()) }",
      "fn piped() { Command::new(p).stdin(Stdio::piped()) }",
      "fn listed() { fs::read_dir(p) }",
      "fn reader() -> u8 { already_read(x) }",
      'fn quoted() { let s = "s.read(&mut b)"; }',
      "fn noted() { // s.read(&mut b)\n}",
      "fn declared() { fn read(b: u8) {} }",
      "fn read_line() -> u8 { 0 }",
      "fn prompt() { read_line() }",
      "impl Sock { fn recv(&self) {} }",
      "fn leaves() { recv(fd, &mut b) }",
      "trait Source { fn pull(&mut self); }",
      "#[cfg(test)]",
      "fn tested() { s.read(&mut b) }",
    ].join("\n");
    expect(byteTakers(source)).toEqual([
      "method",
      "exact",
      "whole",
      "text",
      "line",
      "until",
      "vectored",
      "into",
      "received",
      "from",
      "gathered",
      "peeked",
      "peeked_from",
      "filled",
      "raw",
      "bare",
      "ufcs",
      "file",
      "file_text",
      "received_raw",
      "received_from",
      "received_msg",
      "positioned",
      "scattered",
      "scattered_at",
      "copied",
      "json",
      "buffered",
      "locked",
      "bound",
      "lines",
      "each",
      "spaced",
      "opened",
      "closure",
      "at",
      "exact_at",
      "many",
      "buf_exact",
      "copied_bare",
      "leaves",
    ]);
  });

  it("leaves a call to a method of the type's own named as a read, but not one of another's", () => {
    const source = [
      "impl T { fn a(self) { self.read(v, None) } fn read(self, v: &V, a: Option<u32>) {} }",
      "impl P { fn b(self) { Self::recv(self, v) } fn recv(self, v: &V) {} }",
      "impl U { fn c(&mut self) { self.read(&mut b) } }",
      "impl W { fn d(&mut self) { self.inner.read(&mut b) } fn read(&self) {} }",
      "impl X { fn e(&mut self) { self.read(&mut b) } fn read(&mut self, b: &mut [u8]) {} }",
      "impl R { fn f(&mut self) { self.read(&mut b) } fn read(&self, v: &V) {} }",
      "impl N { fn g(&mut self) { fn read(v: &V) {} self.read(&mut b) } }",
      "impl O { fn j(&mut self) { fn read(v: &V) {} Self::read(self, &mut b) } }",
      "impl M { fn h(&mut self) { self.read(&mut v) } fn read(&mut self, v: &mut V) {} }",
      "impl S { fn k(&self) { self.read(&v) } fn read(&self, v: &V) {} }",
      "impl Z { fn k(&self) { self.read_at(&mut b, 0) } fn read_at(&mut self, v: &V, o: u64) {} }",
    ].join("\n");
    expect(byteTakers(source)).toEqual([
      "U::c",
      "W::d",
      "X::e",
      "X::read",
      "R::f",
      "N::g",
      "O::j",
      "Z::k",
    ]);
  });

  it("leaves a function that only returns bytes, takes text, or is test code", () => {
    const source = [
      "fn encode(x: u8) -> Vec<u8> { vec![x] }",
      "fn name(pane: &str) -> Option<Vec<u8>> { None }",
      "// fn commented(b: &[u8]) {}",
      "#[cfg(test)]",
      "mod tests {",
      "    fn framed(body: &[u8]) -> Vec<u8> { body.to_vec() }",
      "}",
      "#[cfg(test)]",
      "fn helper(b: &[u8]) {}",
      "#[cfg(test)]",
      "fn sized(b: [u8; 4]) -> Vec<u8> {",
      "    fn inner(c: &[u8]) {}",
      "    b.to_vec()",
      "}",
    ].join("\n");
    expect(byteTakers(source)).toEqual([]);
  });
});

/** A crate's source holding one type whose field is `field`, with a method using it and one not. */
const carrierCrate = (name: string, field: string, head = "") =>
  [
    head,
    `pub struct ${name} { f: ${field}, n: u64 }`,
    `impl ${name} {`,
    "    pub fn f(&self) { look(&self.f) }",
    "    pub fn n(&self) -> u64 { self.n }",
    "}",
  ].join("\n");

const manifestFailures = (tree: Record<string, string>) =>
  cargoManifestFailures(Object.keys(tree), (p) => tree[p] ?? "");

// A type holding a runtime of another crate, written after `head`, and two types whose
// methods a call on theirs may reach instead: one by Deref, one by an impl of Iterator.
const answeredHolder = (head: string) =>
  [
    head,
    "use std::sync::Arc;",
    "pub struct Holder { runtime: Arc<::q::Runtime>, wrapped: Wrapped, other: ::q::Other }",
    "pub struct Wrapped { inner: ::q::Runtime }",
    "impl ::std::ops::Deref for Wrapped {",
    "    type Target = ::q::Runtime;",
    "    fn deref(&self) -> &::q::Runtime { &self.inner }",
    "}",
    "impl Holder {",
    "    pub fn id(&self) -> u64 { self.runtime.id() }",
    "    pub fn deref(&self) -> u64 { self.wrapped.id() }",
    "    pub fn other(&self) -> u64 { self.other.id() }",
    "}",
  ].join("\n");
const flaggedIn = (file: string, methods: string[]) =>
  methods.map((m) => `crates/r/src/${file}.rs::${m}`);

// A type holding a runtime that holds bytes and has `Controls::size` by Deref, if `extra` gives it
// one, whose `leak` calls `size` on it: a call rustc may send to a method other than the one the
// scan reads.
const heldRuntime = (struct: string, extra: string[]) =>
  [
    "use std::sync::Arc;",
    "pub struct Controls { tx: Vec<u8> }",
    "impl Controls { pub fn size(&self) -> usize { self.tx.len() } }",
    struct,
    "pub struct Holder { runtime: Arc<Runtime> }",
    "impl Holder { pub fn leak(&self) -> usize { self.runtime.size() } }",
    ...extra,
  ].join("\n");

// A Cargo.lock locking each of `packages`: a name, a version, and the lines after them, by default
// those of a crate from crates.io with the checksum `sum`.
const lockOf = (packages: [string, string, string?][]) =>
  [
    "version = 4",
    ...packages.map(
      ([name, version, rest = `source = "${CRATES_IO}"\nchecksum = "sum"`]) =>
        `\n[[package]]\nname = "${name}"\nversion = "${version}"\n${rest}`,
    ),
  ].join("\n");
const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

// The failures for each entry of ext read at 1.0.0, from crates.io with the checksum `sum`, when
// Cargo.lock takes it `from` elsewhere.
const taken = (from: string) =>
  ["name", "gone"].map(
    (name) =>
      `scripts/check-standards.ts: FOREIGN_MACROS read ext::${name} in ext 1.0.0 from ` +
      `crates.io with checksum sum, but Cargo.lock takes it from ${from}: read the ` +
      "expansion of the source it takes, and pin that if it still writes no impl.",
  );

// The failures for each entry of ext when `manifest` renames a crate to or from ext.
const renamesOf = (file: string) =>
  ["name", "gone"].map(
    (name) =>
      `${file}: renames a crate to or from ext, which FOREIGN_MACROS trusts ext::${name} ` +
      "by, so the name may be another crate's: take the crate by its own name.",
  );

// The manifest of crate r, depending on `deps`.
const manifestOf = (deps: string) => ({
  "crates/r/Cargo.toml": `[package]\nname = "r"\n\n[dependencies]\n${deps}\n`,
});

// The failures for each entry of ext read at 1.0.0 when Cargo.lock locks `locked` instead.
const moved = (locked: string) =>
  ["name", "gone"].map(
    (name) =>
      `scripts/check-standards.ts: FOREIGN_MACROS read ext::${name} in ext 1.0.0, but ` +
      `Cargo.lock locks ${locked}: read its expansion at the locked version again, and pin ` +
      "that version if it still writes no impl.",
  );

// A type holding a runtime under `attribute` whose `leak` reads a field of it that holds no bytes.
const counted = (attribute: string) =>
  [
    "use std::sync::Arc;",
    "pub struct Controls { tx: Vec<u8> }",
    attribute,
    "pub struct Runtime { controls: Controls, count: usize }",
    "pub struct Holder { runtime: Arc<Runtime> }",
    "impl Holder { pub fn leak(&self) -> usize { self.runtime.count } }",
  ].join("\n");

describe("decoderFailures", () => {
  const lib = "pub fn decode(b: &[u8]) {}\nfn send(b: &[u8]) {}\nfn other(x: u8) {}\n";
  const repo: Record<string, string> = {
    "crates/p/src/lib.rs": lib,
    "crates/p/fuzz/fuzz_targets/decode.rs": "fuzz_target!(|b: &[u8]| { p::decode(b); });",
    "crates/p/tests/api.rs": "fn helper(b: &[u8]) {}",
  };
  /** The repo with decode's fuzz target making `call`. */
  const decodeTargetCalling = (call: string) => ({
    ...repo,
    "crates/p/fuzz/fuzz_targets/decode.rs": `fuzz_target!(|b: &[u8]| { ${call}; });`,
  });
  const failures = (
    fuzzed: Record<string, string>,
    notDecoders: Record<string, string>,
    tree = repo,
    publicFields: Record<string, string> = {},
    foreign: Parameters<typeof decoderFailures>[5] = {},
  ) =>
    decoderFailures(
      Object.keys(tree),
      (p) => tree[p] ?? "",
      fuzzed,
      notDecoders,
      publicFields,
      foreign,
    );
  const fuzzed = { "crates/p/src/lib.rs::decode": "decode" };
  const exempt = { "crates/p/src/lib.rs::send": "an encoder" };
  // The repo with an impl of Peek for Runtime written with `impl` as its head, on line 3.
  const head = (impl: string) => ({
    ...repo,
    "crates/p/src/odd.rs": [
      "pub struct Runtime { n: u32 }",
      "pub trait Peek { fn size(&self) -> usize; }",
      `${impl} {`,
      "    fn size(&self) -> usize { 0 }",
      "}",
    ].join("\n"),
  });

  it("accepts each byte-taking function, fuzzed or exempt with a reason", () => {
    expect(failures(fuzzed, exempt)).toEqual([]);
  });

  it("names one in neither list, whatever its name or visibility", () => {
    expect([failures(fuzzed, {}), failures({}, exempt)]).toEqual([
      [expect.stringContaining("crates/p/src/lib.rs::send: takes bytes from outside")],
      [expect.stringContaining("crates/p/src/lib.rs::decode: takes bytes from outside")],
    ]);
  });

  it("names a type alias of a byte type, which would hide a decoder's input", () => {
    const aliased = {
      ...repo,
      "crates/p/src/frame.rs":
        "pub type Frame<'a> = &'a [u8];\n#[cfg(test)]\nmod tests {\n    type Raw = Vec<u8>;\n}\n" +
        "impl Deref for Buf {\n    type Target = [u8];\n}\n" +
        "pub(crate) unsafe impl<T: Fn() -> u8> Tr for It<T> where T: Copy {\n    type Item = Vec<u8>;\n}\n" +
        "trait Pr {\n    type Out<'a>: AsRef<[u8]>;\n    fn take(&self) {}\n}\n" +
        "type Raw = Vec<u8>;\n",
    };
    expect(failures(fuzzed, exempt, aliased)).toEqual([
      expect.stringContaining("crates/p/src/frame.rs::Frame: names a byte type"),
      expect.stringContaining("crates/p/src/frame.rs::Raw: names a byte type"),
    ]);
  });

  it("names methods with their type, so one type's target doesn't cover another's", () => {
    const methods = {
      ...repo,
      "crates/p/src/two.rs":
        "impl A {\n    pub fn decode(b: &[u8]) {}\n}\nimpl<T> Tr for B<T> {\n    fn decode(b: &[u8]) {}\n}\n",
      "crates/p/fuzz/fuzz_targets/a.rs": "fuzz_target!(|b: &[u8]| { p::A::decode(b); });",
    };
    expect(failures({ ...fuzzed, "crates/p/src/two.rs::A::decode": "a" }, exempt, methods)).toEqual(
      [expect.stringContaining("crates/p/src/two.rs::B::decode: takes bytes from outside")],
    );
  });

  it("blanks a test-only field or initialiser to its own end, and reads on past it", () => {
    const testOnly = {
      ...repo,
      "crates/p/src/counted.rs": [
        "pub struct Waits {",
        "    n: u32,",
        "    #[cfg(test)]",
        "    pub seen: Vec<u8>,",
        "    #[cfg(test)]",
        "    reads: HashMap<u8, u32>,",
        "}",
        "impl Waits {",
        "    pub fn new() -> Self {",
        "        Self {",
        "            n: 0,",
        "            #[cfg(test)]",
        "            seen: Vec::new(),",
        "            #[cfg(test)]",
        "            reads: HashMap::from([(0, 1)]),",
        "        }",
        "    }",
        "    pub fn count(&self) -> u32 { self.n }",
        "}",
        "pub fn send(b: &[u8]) {}",
        "pub fn sum(b: &[u8]) {}",
      ].join("\n"),
    };
    const listed = {
      ...exempt,
      "crates/p/src/counted.rs::send": "an encoder",
      "crates/p/src/counted.rs::sum": "a checksum",
    };
    expect(failures(fuzzed, listed, testOnly)).toEqual([]);
  });

  it("takes a type of ours holding bytes for a byte type, and its methods for decoders", () => {
    const reader = {
      ...repo,
      "crates/p/src/reader.rs": [
        "pub struct Framer {",
        "    buf: Vec<u8>,",
        "}",
        "pub struct Frame<'a>(&'a [u8]);",
        "pub struct Plain {",
        "    n: u32,",
        "}",
        "impl Framer {",
        "    pub fn new() -> Self { todo() }",
        "    pub fn next_frame(&mut self) -> Option<u8> { self.buf.pop() }",
        "}",
        "impl Plain {",
        "    pub fn get(&self) -> u32 { 0 }",
        "}",
        "pub fn decode(f: Frame<'_>) {}",
        "type Alias = Framer;",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, reader).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/reader.rs::Alias",
      "crates/p/src/reader.rs::Framer::next_frame",
      "crates/p/src/reader.rs::decode",
    ]);
  });

  it("doesn't take an associated type named like a carrier for it, but takes the type bound to it", () => {
    const output = {
      ...repo,
      "crates/p/src/out.rs": [
        "pub struct Output { buf: Vec<u8> }",
        "pub fn feed(o: Output) {}",
        "pub fn wait<F: Future<Output = u32>>(f: F) {}",
        "type Outputs = Box<dyn Iterator<Item = Output>>;",
      ].join("\n"),
      "crates/p/src/other.rs": [
        "pub fn spawn(f: Pin<Box<dyn Future<Output = ()> + Send>>) {}",
        "pub fn run<F>(f: F) where F: Future<Output = ()> {}",
        "type Boxed = Pin<Box<dyn Future<Output = ()> + Send>>;",
        "type Made = ty!(x, Output = 1);",
        "pub struct Holds { f: ty!(x, Output = 1) }",
        "pub fn hold(h: Holds) {}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, output).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/out.rs::Outputs",
      "crates/p/src/out.rs::feed",
      "crates/p/src/other.rs::Made",
      "crates/p/src/other.rs::hold",
    ]);
  });

  it("reads a raw name as its name, where a carrier is written and where it is defined", () => {
    const raw = {
      ...repo,
      "crates/p/src/lib.rs": `${lib}pub mod raw;\npub mod other;\n`,
      "crates/p/src/other.rs": [
        "pub mod raw { pub struct Packet; pub struct Plain; }",
        "pub mod far { pub struct Plain { b: Vec<u8> } }",
        "impl crate::r#raw::Packet { pub fn other_size(&self) -> usize { self.buf.len() } }",
        "impl crate::r#raw::Plain { pub fn handed(&self) { send(self) } }",
        "pub mod p { pub mod raw { pub struct Packet; } }",
        "impl ::p::r#raw::Packet { pub fn rooted(&self) -> usize { self.buf.len() } }",
      ].join("\n"),
      "crates/p/src/raw.rs": [
        "pub struct Frame { buf: Vec<u8> }",
        "pub struct Plain { n: usize }",
        "pub enum r#Odd { #[x([[1]])] A(Vec<u8>) }",
        "type r#Bytes = Vec<u8>;",
        "pub struct r#Packet { buf: Vec<u8> }",
        "pub struct r#Open { pub buf: Vec<u8> }",
        "pub struct Wide { pub r#buf: Vec<r#u8> }",
        "pub enum r#Event { r#Data { b: Vec<u8> }, Tick }",
        "pub struct Holds { f: r#Frame }",
        "pub fn param(x: r#Frame) {}",
        "pub fn nested(x: Vec<crate::r#raw::Frame>) {}",
        "pub fn bound(x: impl Iterator<Item = r#Frame>) {}",
        "pub fn byte_slice(x: &[r#u8]) {}",
        "pub fn byte_vec(x: Vec<r#std::primitive::u8>) {}",
        "pub fn byte_ptr(x: *const core::r#primitive::u8) {}",
        "pub fn byte_items(x: impl Iterator<Item = r#u8>) {}",
        "pub fn packet(p: Packet) {}",
        "pub fn event(e: Event) {}",
        "pub fn holds(h: Holds) {}",
        "pub fn arm() { match next() { Event::r#Data { b } => look(b), _ => {} } }",
        "impl r#Packet { pub fn size(&self) -> usize { self.buf.len() } }",
        "type Alias = r#Frame;",
        "pub fn plain(x: u16) {}",
        "pub fn tick() { match next() { Event::Tick => {}, _ => {} } }",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, raw).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/other.rs::Packet::other_size",
      "crates/p/src/other.rs::Packet::rooted",
      "crates/p/src/raw.rs::Odd::A",
      "crates/p/src/raw.rs::Open::buf",
      "crates/p/src/raw.rs::Wide::r#buf",
      "crates/p/src/raw.rs::Bytes",
      "crates/p/src/raw.rs::Alias",
      "crates/p/src/raw.rs::param",
      "crates/p/src/raw.rs::nested",
      "crates/p/src/raw.rs::bound",
      "crates/p/src/raw.rs::byte_slice",
      "crates/p/src/raw.rs::byte_vec",
      "crates/p/src/raw.rs::byte_ptr",
      "crates/p/src/raw.rs::byte_items",
      "crates/p/src/raw.rs::packet",
      "crates/p/src/raw.rs::event",
      "crates/p/src/raw.rs::holds",
      "crates/p/src/raw.rs::arm",
      "crates/p/src/raw.rs::Packet::size",
    ]);
  });

  it("flags a raw associated type holding bytes, and reads its name as a name, not as a type", () => {
    const one = {
      ...repo,
      "crates/p/src/one.rs": [
        "pub struct One;",
        "impl Tr for One {",
        "    type r#Item = u8;",
        "    type r#Raw = Vec<u8>;",
        "    fn one(&self, x: Self::Item) {}",
        "    fn raw(&self, x: Self::Raw) {}",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, one).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/one.rs::One::raw",
    ]);
  });

  it("takes an associated type holding bytes for a carrier, by its name wherever a path reaches it", () => {
    const assoc = {
      ...repo,
      "crates/p/src/assoc.rs": [
        "pub struct Frame { buf: Vec<u8> }",
        "pub struct S;",
        "impl Tr for S {",
        "    type Item = Frame;",
        "    type Next = Self::Item;",
        "    type Raw = Vec<u8>;",
        "    type Count = u16;",
        "    fn own(&self, x: Self::Item) {}",
        "    fn nested(&self, x: Vec<Self::Next>) {}",
        "    fn bytes(&self, x: Self::Raw) {}",
        "    fn qualified(&self, x: <Self as Tr>::Item) {}",
        "    fn count(&self, x: Self::Count) {}",
        "}",
        "pub struct W<T>(T);",
        "impl<T> Tr for W<T> { type Item = Frame; fn generic(&self, x: Self::Item) {} }",
        "pub trait Pull { type Source: std::io::Read; fn pull(&self, s: Self::Source) {} }",
        "pub trait Tr { type Item; fn default_method(&self, x: Self::Item) {} }",
        "pub fn projected<T: Tr>(x: T::Item) {}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, assoc).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/assoc.rs::S::own",
      "crates/p/src/assoc.rs::S::nested",
      "crates/p/src/assoc.rs::S::bytes",
      "crates/p/src/assoc.rs::S::qualified",
      "crates/p/src/assoc.rs::W::generic",
      "crates/p/src/assoc.rs::pull",
      "crates/p/src/assoc.rs::default_method",
      "crates/p/src/assoc.rs::projected",
    ]);
  });

  it("takes a generic reader bounded by a byte trait, and a type holding a carrier, for carriers", () => {
    const generic = {
      ...repo,
      "crates/p/src/gen.rs": [
        "pub struct Reader<R> { inner: R }",
        "impl<R: Read> Reader<R> {",
        "    pub fn next_frame(&mut self) {}",
        "}",
        "pub struct Feed<S> { s: S }",
        "impl<S> Feed<S> where S: BufRead {",
        "    pub fn feed(&mut self) {}",
        "}",
        "pub struct Bounded<R: Read> { r: R }",
        "impl<R> Bounded<R> {",
        "    pub fn pull(&mut self) {}",
        "}",
        "struct Inner { buf: Vec<u8> }",
        "struct Middle { inner: Inner }",
        "pub struct Outer { m: Middle }",
        "impl Outer {",
        "    pub fn go(&self) { walk(&self.m) }",
        "}",
        "pub struct Plain<T> { t: T }",
        "impl<T: Clone> Plain<T> {",
        "    pub fn get(&self) {}",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, generic).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/gen.rs::Reader::next_frame",
      "crates/p/src/gen.rs::Feed::feed",
      "crates/p/src/gen.rs::Bounded::pull",
      "crates/p/src/gen.rs::Outer::go",
    ]);
  });

  it("reads the type of an impl whose bound nests three generics deep", () => {
    const deep = {
      ...repo,
      "crates/p/src/deep.rs": [
        "pub struct Framer<T> { buf: Vec<u8>, t: T }",
        "impl<T: Into<Vec<Vec<u16>>>> Framer<T> {",
        "    pub fn pending(&self) -> usize { self.buf.len() }",
        "}",
        "pub struct Plain<T> { n: u32, t: T }",
        "impl<T: Into<Vec<Vec<u16>>>> Plain<T> {",
        "    pub fn count(&self) -> u32 { self.n }",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, deep).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/deep.rs::Framer::pending",
    ]);
  });

  it("fails on an impl head it can't read, naming its file and line", () => {
    expect([
      failures(fuzzed, exempt, head("impl Peek for Arc<Runtime>")),
      failures(fuzzed, exempt, head("impl Peek for Arc<Runtime>>")),
      failures(fuzzed, exempt, {
        ...repo,
        "crates/p/src/wrapped.rs": [
          "pub fn wrapped(\n    n: u32,\n) -> (",
          "    impl Iterator<Item = u32>,",
          "    u32,",
          ") { todo() }",
        ].join("\n"),
      }),
    ]).toEqual([
      [],
      [
        "crates/p/src/odd.rs:3: an impl whose head the decoder rule can't read, so it can't " +
          "tell what the impl is for or whether it takes bytes: balance its brackets.",
      ],
      [],
    ]);
  });

  it("reads an impl after a direction mark, on a line of its own, after an attribute or before it", () => {
    const tree = {
      ...repo,
      "crates/p/src/marks.rs": [
        "pub trait Peek { fn peek(&self) -> u32; }",
        "\u200e",
        "impl<T> Peek for T where T: AsRef<[u8; 4]> { fn peek(&self) -> u32 { 0 } }",
        "\u200f",
        "impl Peek for Arc<Runtime>> { fn peek(&self) -> u32 { 0 } }",
        "#[cfg(unix)]\u200e",
        "impl Peek for Arc<Holder>> { fn peek(&self) -> u32 { 0 } }",
        "pub struct Reader<R> { r: R }\u200e impl<R: Read> Reader<R> { pub fn pull(&mut self) {} }",
      ].join("\n"),
    };
    expect(
      failures(fuzzed, exempt, tree)
        .map((f) => f.slice(0, f.indexOf(": ")))
        .toSorted(),
    ).toEqual([
      "crates/p/src/marks.rs:5",
      "crates/p/src/marks.rs:7",
      "crates/p/src/marks.rs::Reader::pull",
      "crates/p/src/marks.rs::T::peek",
    ]);
  });

  it("takes no associated type of an impl whose head holds an array for an alias", () => {
    const tree = {
      ...repo,
      "crates/p/src/assoc.rs":
        "impl<T> Tr for W<T> where [u8; 4]: Sized {\n    type Item = Vec<u8>;\n}\n" +
        "type Raw = Vec<u8>;\n",
    };
    expect(failures(fuzzed, exempt, tree)).toEqual([
      expect.stringContaining("crates/p/src/assoc.rs::Raw: names a byte type"),
    ]);
  });

  it("takes a type holding only an fd for no carrier, and one holding bytes as well for one", () => {
    const tree = {
      ...repo,
      "crates/p/src/fd.rs": [
        "pub struct Watch { fd: OwnedFd }",
        "impl Watch {",
        "    pub fn fd(&self) -> BorrowedFd<'_> { self.fd.as_fd() }",
        "    pub fn clear(&self) { (&self.fd).read(&mut drained); }",
        "}",
        "pub struct Sock { s: UnixStream, buf: Vec<u8> }",
        "impl Sock {",
        "    pub fn pending(&self) -> usize { self.buf.len() }",
        "}",
        "pub fn watch(w: &Watch) {}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/fd.rs::Watch::clear",
      "crates/p/src/fd.rs::Sock::pending",
    ]);
  });

  it("takes a carrier's method for a decoder only when it uses a field holding the bytes", () => {
    const tree = {
      ...repo,
      "crates/p/src/conn.rs": [
        "pub struct Conn {",
        "    id: u64,",
        "    buffered: bool,",
        "    cache: HashMap<u64, String>,",
        "    frames: HashMap<u64, Vec<u8>>,",
        "    hook: fn(u64) -> u64,",
        "    #[allow(dead_code)]",
        "    buf: Vec<u8>,",
        "    inner: Inner,",
        "}",
        "struct Inner { b: Box<[u8]> }",
        "pub struct Pair(u64, Vec<u8>);",
        "impl Conn {",
        "    pub fn id(&self) -> u64 { self.id }",
        "    pub fn is_buffered(&self) -> bool { self.buffered }",
        "    pub fn cached(&self) -> usize { self.cache.len() }",
        "    pub fn framed(&self) -> usize { self.frames.len() }",
        "    pub fn hooked(&self) -> u64 { (self.hook)(self.id) }",
        "    pub fn alias(&self) -> usize { let b = &self.buf; b.len() }",
        "    pub fn helper(&self) { parse(&self.buf) }",
        "    pub fn closure(&self) -> bool { (0..4).any(|i| self.buf.get(i).is_some()) }",
        "    pub fn nested(&self) { touch(&self.inner) }",
        "    pub fn path(&self) { self::log(self.id) }",
        "}",
        "impl Pair {",
        "    pub fn first(&self) -> u64 { self.0 }",
        "    pub fn second(&self) -> usize { self.1.len() }",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/conn.rs::Conn::framed",
      "crates/p/src/conn.rs::Conn::alias",
      "crates/p/src/conn.rs::Conn::helper",
      "crates/p/src/conn.rs::Conn::closure",
      "crates/p/src/conn.rs::Conn::nested",
      "crates/p/src/conn.rs::Pair::second",
    ]);
  });

  it("takes a carrier's method that hands on or matches self, or calls one that counts", () => {
    const tree = {
      ...repo,
      "crates/p/src/conn.rs": [
        "pub struct Conn { id: u64, buf: Vec<u8> }",
        "impl Conn {",
        "    pub fn handed(&self) { parse_conn(self) }",
        "    pub fn matched(&self) -> usize { let Self { buf, .. } = self; buf.len() }",
        "    pub fn by_path(&mut self) { Self::reset(self) }",
        "    pub fn second(&self) -> Option<u8> { self.first() }",
        "    pub fn first(&self) -> Option<u8> { self.bytes().first().copied() }",
        "    fn bytes(&self) -> &[u8] { &self.buf }",
        "    pub fn named(&self) -> u64 { self.id }",
        "    pub fn quiet(&self) -> u64 { self.named() }",
        "    pub fn elsewhere(&self) { self.flush_all() }",
        "    pub fn merge(&mut self, other: &Self) {}",
        "    pub fn boxed(self: Box<Self>) -> u64 { self.id }",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/conn.rs::Conn::handed",
      "crates/p/src/conn.rs::Conn::matched",
      "crates/p/src/conn.rs::Conn::by_path",
      "crates/p/src/conn.rs::Conn::second",
      "crates/p/src/conn.rs::Conn::first",
      "crates/p/src/conn.rs::Conn::bytes",
      "crates/p/src/conn.rs::Conn::elsewhere",
      "crates/p/src/conn.rs::Conn::merge",
    ]);
  });

  it("splits a struct's fields where a length shifts, and pins nothing it can't split", () => {
    const tree = {
      ...repo,
      "crates/p/src/shift.rs": [
        "pub struct Shifted { id: u64, scratch: [u32; 1 << 4], buf: Vec<u8> }",
        "pub struct Halved { lens: Vec<[u32; N >> 2]>, pub buf: Vec<u8> }",
        "pub struct Odd { a: Foo<u8, b: Vec<u8>, n: u64 }",
        "pub struct Raw { r#type: Vec<u8>, n: u64 }",
        "pub struct Junk { Vec<u8>, n: u64 }",
        "pub struct Hooked<F: Fn(Option<u32>) -> u32> { buf: Vec<u8>, n: u64, f: F }",
        "impl Shifted {",
        "    pub fn id(&self) -> u64 { self.id }",
        "    pub fn peek(&self) -> u8 { self.buf[0] }",
        "}",
        "impl Halved {",
        "    pub fn lens(&self) -> u32 { self.lens[0][0] }",
        "}",
        "impl Odd {",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
        "impl Raw {",
        "    pub fn n(&self) -> u64 { self.n }",
        "    pub fn kind(&self) -> u8 { self.r#type[0] }",
        "}",
        "impl Junk {",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
        "impl<F> Hooked<F> {",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/shift.rs::Halved::buf",
      "crates/p/src/shift.rs::Odd",
      "crates/p/src/shift.rs::Junk",
      "crates/p/src/shift.rs::Shifted::peek",
      "crates/p/src/shift.rs::Odd::n",
      "crates/p/src/shift.rs::Raw::kind",
      "crates/p/src/shift.rs::Junk::n",
    ]);
  });

  it("takes a carrier of another crate its `use` or a path names for a byte type", () => {
    const tree = {
      ...repo,
      "crates/q/src/lib.rs": [
        "pub struct Frames { buf: Vec<u8> }",
        "pub struct Screen { rows: Vec<u8> }",
        "pub mod wire {",
        "    pub struct Packet { b: Vec<u8> }",
        "}",
      ].join("\n"),
      "crates/p/src/conn.rs": [
        "use q::Frames;",
        "pub struct Screen { rows: u32 }",
        "pub struct Conn { id: u64, frames: Option<Frames>, packet: q::wire::Packet, screen: Screen }",
        "impl Conn {",
        "    pub fn id(&self) -> u64 { self.id }",
        "    pub fn frames(&self) -> bool { self.frames.is_some() }",
        "    pub fn packet(&self) { send(&self.packet) }",
        "    pub fn rows(&self) -> u32 { self.screen.rows }",
        "}",
        "pub fn show(f: &Frames) {}",
        "pub fn draw(s: &Screen) {}",
      ].join("\n"),
      "crates/r/src/lib.rs": [
        "use p::Conn;",
        "use q::*;",
        "use q::Frames as F;",
        "pub struct Holder { c: Conn, n: u64 }",
        "pub struct Globbed { s: Screen }",
        "impl Holder {",
        "    pub fn c(&self) { look(&self.c) }",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
        "impl Globbed {",
        "    pub fn s(&self) { look(&self.s) }",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/conn.rs::Conn::frames",
      "crates/p/src/conn.rs::Conn::packet",
      "crates/p/src/conn.rs::show",
      "crates/r/src/lib.rs",
      "crates/r/src/lib.rs::Holder::c",
      "crates/r/src/lib.rs::Globbed::s",
    ]);
  });

  // A runtime of another crate holding bytes in a private field, as a holder runtime's control
  // connections do, and a type holding it that only calls what it offers.
  const runtime = [
    "pub struct Controls { tx: Vec<u8> }",
    "pub struct Runtime { id: u64, pub name: String, controls: Controls }",
    "pub struct Id<K>(K);",
    "pub type Tag = Id<u32>;",
    "pub type Label = Tag;",
    "impl std::fmt::Debug for Runtime {",
    '    fn fmt(&self, f: &mut std::fmt::Formatter<\'_>) -> std::fmt::Result { f.write_str("r") }',
    "}",
    "impl Drop for Runtime { fn drop(&mut self) {} }",
    "impl Runtime {",
    "    pub fn id(&self) -> u64 { self.id }",
    "    pub async fn create(&self, spec: Spec) -> Result<Made, Error> { make(spec) }",
    "    pub fn health<'a>(&'a self, known: &[Made]) -> Health { check(known) }",
    "    pub fn r#type(&self) -> u32 { 0 }",
    "    pub fn label(&self, known: &[Label]) -> Option<Tag> { None }",
    "    pub fn untagged(&self) -> Option<Tag> { None }",
    "}",
  ].join("\n");

  it("takes no method for a decoder that calls a field's methods and reads a field holding no bytes", () => {
    const tree = {
      ...repo,
      "crates/q/src/lib.rs": runtime,
      "crates/r/src/lib.rs": [
        "use std::sync::{Arc, Mutex};",
        "use q::Runtime;",
        "pub struct Holder { runtime: Arc<Runtime>, boxed: Box<Runtime>, n: u64 }",
        "impl Holder {",
        "    pub fn id(&self) -> u64 { self.runtime.id() }",
        "    pub async fn create(&self, spec: Spec) -> Result<Made, Error> {",
        "        self.runtime",
        "            .create(spec)",
        "            .await",
        "    }",
        "    pub fn named(&self) -> usize { self.runtime.name.len() }",
        "    pub fn health(&self) -> Health { Box::pin(async move { self.runtime.health(&[]) }) }",
        "    pub fn raw(&self) -> u32 { self.runtime.r#type() }",
        "    pub fn label(&self) -> bool { self.runtime.label(&[]).is_none() }",
        "    pub fn boxed(&self) -> u64 { self.boxed.id() }",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree)).toEqual([]);
  });

  it("takes a method for a decoder that hands a field on, reads its bytes or calls what may reach them", () => {
    const tree = {
      ...repo,
      "crates/q/src/lib.rs": [
        "pub struct Controls { tx: Vec<u8> }",
        "pub struct Runtime { id: u64, pub bytes: Vec<u8>, controls: Controls }",
        "pub struct Wire;",
        "pub trait Shape { type Out; }",
        "impl Shape for Wire { type Out = Vec<u8>; }",
        "pub type Snap = <Wire as Shape>::Out;",
        "pub type Shot = Snap;",
        "pub trait Probe { fn probe(&self) -> u32 { 0 } }",
        "impl Probe for Runtime {}",
        "pub trait Count { fn count(&self) -> u32; }",
        "pub trait Spin { fn spin(&self) -> u32; }",
        "impl<T> Spin for T { fn spin(&self) -> u32 { 0 } }",
        "pub trait Turn { fn turn(&self) -> u32; }",
        "impl<r#U> Turn for r#U { fn turn(&self) -> u32 { 0 } }",
        "pub trait Total { fn total(self) -> u32; }",
        "impl Total for Runtime { fn total(self) -> u32 { 0 } }",
        "impl Runtime {",
        "    pub fn id(&self) -> u64 { self.id }",
        "    pub fn write(&self, b: &[u8]) {}",
        "    pub fn snapshot(&self) -> Vec<u8> { Vec::new() }",
        "    pub fn fresh(&self) -> Controls { make() }",
        "    pub fn twin(&self) -> Self { make() }",
        "    pub fn get<T: Default>(&self) -> T { T::default() }",
        "    pub fn chunks(&self) -> impl Iterator<Item = u32> { 0..1 }",
        "    pub fn boxed(&self) -> Box<dyn Shown> { make() }",
        "    pub fn byte(&self) -> u8 { 0 }",
        "    pub fn input(&self) -> Option<Stdin> { None }",
        "    pub fn snap(&self) -> Snap { make() }",
        "    pub fn framed(&self) -> Option<Shot> { None }",
        "    pub fn shaped(&self) -> <Wire as Shape>::Out { make() }",
        "    pub fn bounded(&self) -> u32 where u32: Copy { 0 }",
        "    pub fn close(&self) { self.controls.tx.clear() }",
        "    pub fn r#reset(&self) { forget(&self.controls) }",
        "    pub fn count(&self) -> u32 { 0 }",
        "    pub fn spin(&self) -> u32 { 0 }",
        "    pub fn turn(&self) -> u32 { 0 }",
        "    pub fn total(&self) -> u32 { 0 }",
        "    pub fn into(&self) -> u32 { 0 }",
        "}",
        "pub struct Local { rt: Runtime }",
        "impl Local {",
        "    pub fn peek(&self) -> usize { self.rt.controls.tx.len() }",
        "    pub fn id(&self) -> u64 { self.rt.id() }",
        "}",
      ].join("\n"),
      "crates/r/src/lib.rs": [
        "mod boxes;",
        "mod open;",
        "mod twin;",
        "mod hijack;",
        "use std::sync::{Arc, Mutex};",
        "use q::Runtime;",
        "pub struct Holder {",
        "    runtime: Arc<Runtime>,",
        "    locked: Mutex<Runtime>,",
        "    lost: gone::Runtime,",
        "    mine: own::Arc<Runtime>,",
        "}",
        "impl Holder {",
        "    pub fn id(&self) -> u64 { self.runtime.id() }",
        "    pub fn write(&self) { self.runtime.write(&[]) }",
        "    pub fn snapshot(&self) -> usize { self.runtime.snapshot().len() }",
        "    pub fn fresh(&self) { self.runtime.fresh(); }",
        "    pub fn twin(&self) { self.runtime.twin(); }",
        "    pub fn get(&self) -> u32 { self.runtime.get::<u32>() }",
        "    pub fn chunks(&self) -> usize { self.runtime.chunks().count() }",
        "    pub fn boxed(&self) { self.runtime.boxed(); }",
        "    pub fn byte(&self) -> u8 { self.runtime.byte() }",
        "    pub fn input(&self) { self.runtime.input(); }",
        "    pub fn snap(&self) { self.runtime.snap(); }",
        "    pub fn framed(&self) { self.runtime.framed(); }",
        "    pub fn shaped(&self) { self.runtime.shaped(); }",
        "    pub fn bounded(&self) -> u32 { self.runtime.bounded() }",
        "    pub fn close(&self) { self.runtime.close() }",
        "    pub fn reset(&self) { self.runtime.r#reset() }",
        "    pub fn probe(&self) -> u32 { self.runtime.probe() }",
        "    pub fn missing(&self) { self.runtime.missing() }",
        "    pub fn cloned(&self) -> Arc<Runtime> { self.runtime.clone() }",
        "    pub fn count(&self) -> u32 { self.runtime.count() }",
        "    pub fn spin(&self) -> u32 { self.runtime.spin() }",
        "    pub fn turn(&self) -> u32 { self.runtime.turn() }",
        "    pub fn total(&self) -> u32 { self.runtime.total() }",
        "    pub fn into(&self) -> u32 { self.runtime.into() }",
        "    pub fn bytes(&self) -> usize { self.runtime.bytes.len() }",
        "    pub fn handed(&self) { send(&self.runtime) }",
        "    pub fn local(&self) -> u64 { let r = &self.runtime; r.id() }",
        "    pub fn shared(&self) -> Arc<Runtime> { Arc::clone(&self.runtime) }",
        "    pub async fn waited(&self) { self.runtime.await }",
        "    pub fn matched(&self) { match *self.runtime { _ => {} } }",
        '    pub fn logged(&self) { println!("{}", self.runtime.id()) }',
        "    pub fn imported(&self) -> u64 { use q::Probe; self.runtime.id() }",
        "    pub fn locked(&self) -> u64 { self.locked.lock().id() }",
        "    pub fn lost(&self) -> u64 { self.lost.id() }",
        "    pub fn mine(&self) -> u64 { self.mine.id() }",
        "}",
      ].join("\n"),
      "crates/r/src/boxes.rs": [
        "use own::*;",
        "pub struct Boxes { inner: Box<crate::open::Inner> }",
      ].join("\n"),
      "crates/r/src/open.rs": [
        "pub struct Inner { tx: Vec<u8> }",
        "impl Inner { pub fn id(&self) -> u64 { 0 } }",
        "impl crate::boxes::Boxes { pub fn id(&self) -> u64 { self.inner.id() } }",
      ].join("\n"),
      "crates/r/src/twin.rs": [
        "#[cfg(unix)]",
        "pub struct Twin { runtime: std::sync::Arc<q::Runtime> }",
        "#[cfg(not(unix))]",
        "pub struct Twin { runtime: std::sync::Mutex<q::Runtime> }",
        "impl Twin { pub fn id(&self) -> u64 { self.runtime.id() } }",
      ].join("\n"),
      "crates/r/src/hijack.rs":
        "impl q::Count for Arc<q::Runtime> { fn count(&self) -> u32 { 0 } }",
    };
    expect(
      failures(fuzzed, exempt, tree, { "crates/q/src/lib.rs::Runtime::bytes": "a test's" }).map(
        (f) => f.split(": ")[0],
      ),
    ).toEqual([
      "crates/q/src/lib.rs::Snap",
      "crates/q/src/lib.rs::Shot",
      "crates/q/src/lib.rs::Runtime::write",
      "crates/q/src/lib.rs::Runtime::close",
      "crates/q/src/lib.rs::Runtime::reset",
      "crates/q/src/lib.rs::Local::peek",
      ...[
        "write",
        "snapshot",
        "fresh",
        "twin",
        "get",
        "chunks",
        "boxed",
        "byte",
        "input",
        "snap",
        "framed",
        "shaped",
        "bounded",
        "close",
        "reset",
        "probe",
        "missing",
        "cloned",
        "count",
        "spin",
        "turn",
        "total",
        "into",
        "bytes",
        "handed",
        "local",
        "shared",
        "waited",
        "matched",
        "logged",
        "imported",
        "locked",
        "lost",
        "mine",
      ].map((m) => `crates/r/src/lib.rs::Holder::${m}`),
      "crates/r/src/open.rs::Boxes::id",
      "crates/r/src/twin.rs::Twin::id",
    ]);
  });

  it("takes a field's methods for a decoder where a trait it can't read may answer them", () => {
    const tree = {
      ...repo,
      "crates/q/src/lib.rs": [
        runtime,
        "pub struct Other { c: Controls }",
        "impl Other { pub fn id(&self) -> u64 { 0 } }",
        "impl Iterator for Other { type Item = u32; fn next(&mut self) -> Option<u32> { None } }",
        "pub use ext::Shape as Shaped;",
        "pub const LIMIT: u64 = 1;",
      ].join("\n"),
      "crates/r/src/lib.rs": [
        "mod named;",
        "mod anon;",
        "mod globbed;",
        "mod plain;",
        "mod passed;",
        "mod limit;",
        "mod written;",
        "mod prelude;",
        "mod preluded;",
      ].join("\n"),
      "crates/r/src/named.rs": answeredHolder("use tracing::Instrument;"),
      "crates/r/src/anon.rs": answeredHolder("use ext::shape as _;"),
      "crates/r/src/globbed.rs": answeredHolder("use ext::*;"),
      "crates/r/src/plain.rs": answeredHolder("use ext::shape;"),
      "crates/r/src/passed.rs": answeredHolder("use q::Shaped;"),
      "crates/r/src/limit.rs": answeredHolder("use q::LIMIT;"),
      "crates/r/src/written.rs": answeredHolder("use std::io::Write;"),
      "crates/r/src/prelude.rs": "pub use tracing::Instrument;",
      "crates/r/src/preluded.rs": answeredHolder("use crate::prelude::*;"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      ...flaggedIn("named", ["Wrapped::deref", "Holder::id", "Holder::deref", "Holder::other"]),
      ...flaggedIn("anon", ["Wrapped::deref", "Holder::id", "Holder::deref", "Holder::other"]),
      ...flaggedIn("globbed", ["Wrapped::deref", "Holder::id", "Holder::deref", "Holder::other"]),
      ...flaggedIn("plain", ["Wrapped::deref", "Holder::deref", "Holder::other"]),
      ...flaggedIn("passed", ["Wrapped::deref", "Holder::id", "Holder::deref", "Holder::other"]),
      ...flaggedIn("limit", ["Wrapped::deref", "Holder::deref", "Holder::other"]),
      ...flaggedIn("written", ["Wrapped::deref", "Holder::id", "Holder::deref", "Holder::other"]),
      ...flaggedIn("preluded", ["Wrapped::deref", "Holder::id", "Holder::deref", "Holder::other"]),
    ]);
  });

  // A crate `r` that depends on `ext`, whose `name!` a review has read at the version locked, and
  // on `other`, whose macros nobody has.
  const withDeps = {
    "crates/r/Cargo.toml": '[package]\nname = "r"\n\n[dependencies]\next = "1"\nother = "1"\n',
    "Cargo.lock": lockOf([["ext", "1.0.0"]]),
  };
  const readExt = {
    "ext::name": {
      read: { ext: { version: "1.0.0", checksum: "sum" } },
      reason: "read ext@1.0.0 src/lib.rs: expansion writes no impl",
    },
  };

  // Whether `Holder::leak` of heldRuntime, in `written` added to the repo, takes bytes.
  const leaks = (written: Record<string, string>) =>
    failures(fuzzed, exempt, { ...repo, ...withDeps, ...written }, {}, readExt).some((f) =>
      f.startsWith("crates/r/src/lib.rs::Holder::leak: "),
    );

  it("takes a field's method for a decoder where rustc may call another of its name", () => {
    const plain = "pub struct Runtime { controls: Controls }";
    const shim = "impl Runtime { pub fn size(&self) -> usize { 0 } }";
    const deref = [
      "impl std::ops::Deref for Runtime {",
      "    type Target = Controls;",
      "    fn deref(&self) -> &Controls { &self.controls }",
      "}",
    ];
    const peek = [
      "pub trait Peek { fn size(&self) -> usize; }",
      "pub fn setup() { peek!(Arc<Runtime>); }",
    ];
    const peekImpl = "impl Peek for $t { fn size(&self) -> usize { 0 } }";
    const cases: Record<string, [Record<string, string>, Record<string, string>]> = {
      "a cfg on the impl": [
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim]) },
        { "crates/r/src/lib.rs": heldRuntime(plain, ["#[cfg(windows)]", shim]) },
      ],
      "a cfg on the method": [
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim]) },
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            "impl Runtime {",
            "    #[cfg(windows)]",
            "    #[inline]",
            "    pub fn size(&self) -> usize { 0 }",
            "}",
          ]),
        },
      ],
      "a cfg on the impl's module": [
        {
          "crates/r/src/lib.rs": heldRuntime(plain, ["mod win;"]),
          "crates/r/src/win.rs": "mod imp;",
          "crates/r/src/win/imp.rs": `use crate::Runtime;\n${shim}`,
        },
        {
          "crates/r/src/lib.rs": heldRuntime(plain, ["#[cfg(windows)]", "mod win;"]),
          "crates/r/src/win.rs": "mod imp;",
          "crates/r/src/win/imp.rs": `use crate::Runtime;\n${shim}`,
        },
      ],
      "an impl for one instance": [
        {
          "crates/r/src/lib.rs": heldRuntime(
            "pub struct Runtime<K = ()> { controls: Controls, kind: std::marker::PhantomData<K> }",
            ["impl<K> Runtime<K> { pub fn size(&self) -> usize { 0 } }"],
          ),
        },
        {
          "crates/r/src/lib.rs": heldRuntime(
            "pub struct Runtime<K = ()> { controls: Controls, kind: std::marker::PhantomData<K> }",
            ["pub struct Fast;", "impl Runtime<Fast> { pub fn size(&self) -> usize { 0 } }"],
          ),
        },
      ],
      "a Deref to a carrier": [
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim]) },
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim, ...deref]) },
      ],
      "a trait impl for an alias": [
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            "pub trait Peek { fn size(&self) -> usize; }",
          ]),
        },
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            "pub trait Peek { fn size(&self) -> usize; }",
            "pub type Shared = Arc<Runtime>;",
            "impl Peek for Shared { fn size(&self) -> usize { 0 } }",
          ]),
        },
      ],
      "a macro_rules! writing an impl": [
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            "macro_rules! two { () => { 2 }; }",
            'const NAME: &str = concat!("r");',
          ]),
        },
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            ...peek,
            `macro_rules! peek { ($t:ty) => (${peekImpl}); }`,
          ]),
        },
      ],
      "a macro writing an impl from its fragments": [
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim]) },
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            ...peek,
            `macro peek($t:ty) { ${peekImpl} }`,
          ]),
        },
      ],
      "a macro of another crate called where an item may be": [
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            "thread_local! { static N: u32 = 0; }",
            "pub fn name() -> String { ext::name!() }",
          ]),
        },
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim, "ext::peek!(Arc<Runtime>);"]) },
      ],
      "a macro called by a raw path": [
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim]) },
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim, "r#ext::peek!(Arc<Runtime>);"]) },
      ],
      "a macro called by a path with a raw module": [
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim]) },
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim, "crate::r#m::peek!(Arc<Runtime>);"]) },
      ],
      "a blanket impl for a raw pointer by a raw path": [
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            "pub trait Peek { fn size(&self) -> usize; }",
          ]),
        },
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            "pub trait Peek { fn size(&self) -> usize; }",
            "impl<T> Peek for ::r#std::sync::r#Arc<r#T> { fn size(&self) -> usize { 0 } }",
          ]),
        },
      ],
    };
    expect(
      Object.fromEntries(
        Object.entries(cases).map(([name, [clean, tricked]]) => [
          name,
          [leaks(clean), leaks(tricked)],
        ]),
      ),
    ).toEqual(Object.fromEntries(Object.keys(cases).map((name) => [name, [false, true]])));
  });

  it("reads no method of a bounded impl, or of a type an attribute it can't read is on", () => {
    const generic =
      "pub struct Runtime<K = ()> { controls: Controls, kind: std::marker::PhantomData<K> }";
    const plain = "pub struct Runtime { controls: Controls }";
    const shim = "impl Runtime { pub fn size(&self) -> usize { 0 } }";
    const apart = (use: string, derive: string) => ({
      "crates/r/src/lib.rs": heldRuntime("mod rt;\nuse crate::rt::Runtime;", []),
      "crates/r/src/rt.rs": [
        "use crate::Controls;",
        use,
        `#[derive(${derive})]`,
        "pub struct Runtime { controls: Controls }",
        shim,
      ].join("\n"),
    });
    const cases: Record<string, [Record<string, string>, Record<string, string>]> = {
      "a bound on the impl's parameter": [
        {
          "crates/r/src/lib.rs": heldRuntime(generic, [
            "pub trait Kind {}",
            "impl<K> Runtime<K> { pub fn size(&self) -> usize { 0 } }",
          ]),
        },
        {
          "crates/r/src/lib.rs": heldRuntime(generic, [
            "pub trait Kind {}",
            "impl<K: Kind> Runtime<K> { pub fn size(&self) -> usize { 0 } }",
          ]),
        },
      ],
      "a where clause on the impl": [
        {
          "crates/r/src/lib.rs": heldRuntime(generic, [
            "pub trait Kind {}",
            "impl<K> Runtime<K> { pub fn size(&self) -> usize { 0 } }",
          ]),
        },
        {
          "crates/r/src/lib.rs": heldRuntime(generic, [
            "pub trait Kind {}",
            "impl<K> Runtime<K> where K: Kind { pub fn size(&self) -> usize { 0 } }",
          ]),
        },
      ],
      "a derive from outside std": [
        { "crates/r/src/lib.rs": heldRuntime(`#[derive(Debug, Clone)]\n${plain}`, [shim]) },
        {
          "crates/r/src/lib.rs": heldRuntime(`#[derive(Debug, derive_more::Deref)]\n${plain}`, [
            shim,
          ]),
        },
      ],
      "a derive a cfg_attr may add": [
        {
          "crates/r/src/lib.rs": heldRuntime(`#[cfg_attr(unix, derive(Clone))]\n${plain}`, [shim]),
        },
        {
          "crates/r/src/lib.rs": heldRuntime(
            `#[cfg_attr(unix, derive(derive_more::Deref))]\n${plain}`,
            [shim],
          ),
        },
      ],
      "a derive by a name a use rebinds": [apart("", "Clone"), apart("use other::Clone;", "Clone")],
      "an attribute macro on the type": [
        { "crates/r/src/lib.rs": heldRuntime(`#[must_use]\n#[repr(C)]\n${plain}`, [shim]) },
        { "crates/r/src/lib.rs": heldRuntime(`#[ext::wrap]\n${plain}`, [shim]) },
      ],
      "a field read of a type an attribute macro may rewrite": [
        { "crates/r/src/lib.rs": counted("#[repr(C)]") },
        { "crates/r/src/lib.rs": counted("#[wrap]") },
      ],
    };
    expect(
      Object.fromEntries(
        Object.entries(cases).map(([name, [clean, tricked]]) => [
          name,
          [leaks(clean), leaks(tricked)],
        ]),
      ),
    ).toEqual(Object.fromEntries(Object.keys(cases).map((name) => [name, [false, true]])));
  });

  it("reads an impl whose head holds an array or a brace block, for what may answer a call", () => {
    const plain = "pub struct Runtime { controls: Controls }";
    const shim = "impl Runtime { pub fn size(&self) -> usize { 0 } }";
    const peek = "pub trait Peek<const B: bool> { fn size(&self) -> usize; }";
    const generic = "pub trait Peek<T> { fn size(&self) -> usize; }";
    const cases: Record<string, [Record<string, string>, Record<string, string>]> = {
      "a Deref whose where clause names an array": [
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim]) },
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            "impl std::ops::Deref for Runtime where [u8; 4]: Sized {",
            "    type Target = Controls;",
            "    fn deref(&self) -> &Controls { &self.controls }",
            "}",
          ]),
        },
      ],
      "a trait impl whose trait takes an array with a shift in its length": [
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim, generic]) },
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            generic,
            "impl Peek<[u8; 1 << 2]> for Runtime { fn size(&self) -> usize { 0 } }",
          ]),
        },
      ],
      "a trait impl whose trait takes a brace block": [
        { "crates/r/src/lib.rs": heldRuntime(plain, [shim, peek]) },
        {
          "crates/r/src/lib.rs": heldRuntime(plain, [
            shim,
            peek,
            "impl Peek<{ 1 > 0 }> for Runtime { fn size(&self) -> usize { 0 } }",
          ]),
        },
      ],
    };
    expect(
      Object.fromEntries(
        Object.entries(cases).map(([name, [clean, tricked]]) => [
          name,
          [leaks(clean), leaks(tricked)],
        ]),
      ),
    ).toEqual(Object.fromEntries(Object.keys(cases).map((name) => [name, [false, true]])));
  });

  it("takes every type to answer any name once a macro or attribute it can't read is called", () => {
    const plain = "pub struct Runtime { controls: Controls }";
    const shim = "impl Runtime { pub fn size(&self) -> usize { 0 } }";
    const held = (...extra: string[]) => ({
      "crates/r/src/lib.rs": heldRuntime(plain, [shim, ...extra]),
    });
    const peek = "pub trait Peek { fn size(&self) -> usize; }";
    const peekImpl = "impl Peek for Arc<Runtime> { fn size(&self) -> usize { 0 } }";
    const counts = "pub fn count() -> usize { vec![1u32].len() }";
    const named = "pub fn name() -> String { ext::name!() }";
    const cases: Record<string, [Record<string, string>, Record<string, string>]> = {
      "a macro of another crate in a function body": [
        held(named),
        held(peek, "pub fn setup() { other::peek!(Arc<Runtime>); }"),
      ],
      "a macro of another crate in a const": [
        held('pub const NAME: &str = concat!("r");'),
        held("pub const N: usize = other::count!(Arc<Runtime>);"),
      ],
      "a foreign macro's crate locked at a version nobody read": [
        held(named),
        { ...held(named), "Cargo.lock": lockOf([["ext", "1.0.1"]]) },
      ],
      "a foreign macro's crate name a use rebinds": [held(named), held("use other as ext;", named)],
      "a foreign macro's crate a manifest renames": [
        held(named),
        {
          ...held(named),
          "crates/r/Cargo.toml":
            '[package]\nname = "r"\n\n[dependencies]\next = { package = "evil", version = "1" }\n',
          "Cargo.lock": lockOf([
            ["ext", "1.0.0"],
            ["evil", "1.0.0"],
          ]),
        },
      ],
      "a foreign macro's crate a manifest takes another under the name of": [
        held(named),
        {
          ...held(named),
          "crates/q/Cargo.toml":
            '[package]\nname = "q"\n\n[dependencies]\nevil = { package = "ext", version = "1" }\n',
        },
      ],
      "a foreign macro beside a manifest whose renames can't be read": [
        held(named),
        {
          ...held(named),
          "crates/q/Cargo.toml":
            '[package]\nname = "q"\n\n[dependencies]\nx = { package = 1, version = "1" }\n',
        },
      ],
      "a foreign macro brought in from the root": [
        held("use ::ext::name;", "pub fn n() -> String { name!() }"),
        held("use ::other::name;", "pub fn n() -> String { name!() }"),
      ],
      "a foreign macro named bare": [
        held("use ext::name;", "pub fn n() -> String { name!() }"),
        held("use other::name;", "pub fn n() -> String { name!() }"),
      ],
      "a macro of the crate's own handed an impl": [
        held(counts),
        held(
          peek,
          "macro_rules! items { ($($t:tt)*) => { $($t)* }; }",
          `pub fn setup() { items!(${peekImpl}); }`,
        ),
      ],
      "a macro of the crate's own named as std's": [
        held(counts),
        held(
          peek,
          "macro_rules! vec { ($($t:tt)*) => { $($t)* }; }",
          `pub fn setup() { vec!(${peekImpl}); }`,
        ),
      ],
      "a std macro a use rebinds": [held(counts), held("use other::vec;", counts)],
      "a std macro a re-export rebinds": [
        held(
          "mod util { pub use std::format; }",
          "use crate::util::format;",
          'pub fn n() -> String { format!("r") }',
        ),
        held(
          "mod util { pub use other::format; }",
          "use crate::util::format;",
          'pub fn n() -> String { format!("r") }',
        ),
      ],
      "a std macro a glob may rebind": [
        { ...held("mod m;"), "crates/r/src/m.rs": counts },
        { ...held("mod m;"), "crates/r/src/m.rs": `use other::*;\n${counts}` },
      ],
      "a std macro outside the prelude": [
        held("use std::pin::pin;", "pub fn p() { let _f = pin!(async {}); }"),
        held("pub fn p() { let _f = pin!(async {}); }"),
      ],
      "a macro by a path into the crate": [
        held("pub fn p() -> usize { std::vec![1u32].len() }"),
        held("pub fn p() -> usize { crate::vec![1u32].len() }"),
      ],
      "a re-export that goes round": [
        held("mod a { pub use std::vec; }", "use crate::a::vec;", counts),
        held(
          "mod a { pub use crate::b::vec; }",
          "mod b { pub use crate::a::vec; }",
          "use crate::a::vec;",
          counts,
        ),
      ],
      "a foreign macro's crate a glob may rebind": [
        { ...held("mod m;"), "crates/r/src/m.rs": named },
        { ...held("mod m;"), "crates/r/src/m.rs": `use other::*;\n${named}` },
      ],
      "a foreign macro's crate name an item of ours takes": [
        held(named),
        held("#[allow(non_camel_case_types)]\npub struct ext;", named),
      ],
      "an attribute macro inside a module": [
        { ...held("mod m;"), "crates/r/src/m.rs": `#![allow(unused)]\n${counts}` },
        { ...held("mod m;"), "crates/r/src/m.rs": `#![other::thing]\n${counts}` },
      ],
      "a macro of the crate's own by macro, named as std's": [
        held(counts),
        held(peek, "macro vec($($t:tt)*) { $($t)* }", `pub fn setup() { vec!(${peekImpl}); }`),
      ],
      "a file no module declares": [
        { ...held(), "crates/r/src/stray.rs": named },
        { ...held(), "crates/r/src/stray.rs": "pub fn s() { other::peek!(Arc<Runtime>); }" },
      ],
      "an attribute macro on a function": [
        held("#[must_use]\npub fn count() -> usize { 0 }"),
        held("#[other::export]\npub fn count() -> usize { 0 }"),
      ],
      "a derive helper a use rebinds": [
        held('#[derive(serde::Serialize)]\npub struct Msg { #[serde(rename = "n")] n: u32 }'),
        held(
          "use other::serde;",
          '#[derive(serde::Serialize)]\npub struct Msg { #[serde(rename = "n")] n: u32 }',
        ),
      ],
      "a keyword before a !": [
        held("pub fn not(x: bool) -> bool { if !(x) { return !(x); } x }"),
        held("pub fn not(x: bool) -> bool { iff!(x) }"),
      ],
      "a macro with space before its !": [
        held('pub fn n() -> String { format !("n") }'),
        held("pub fn not(x: bool) -> bool { iff !(x) }"),
      ],
      "a ! that follows no name": [
        held("pub fn not(x: bool, y: bool) -> bool { x && !(y) || !![x][0] }"),
        held("pub fn not(x: bool, y: bool) -> bool { x && m!(y) }"),
      ],
      "a macro by a raw name": [
        held('pub fn n() -> String { std::r#format!("n") }'),
        held('pub fn n() -> String { other::r#format!("n") }'),
      ],
      "a macro whose path can't be read back": [
        held('pub fn n() -> String { std::format!("n") }'),
        held('pub fn n() -> String { <other::Fmt>::format!("n") }'),
      ],
      "a macro by a raw keyword": [
        held("pub fn not(x: bool) -> bool { if !(x) { return false; } x }"),
        held("use other::r#if;", "pub fn not(x: bool) -> bool { r#if!(x) }"),
      ],
    };
    expect(
      Object.fromEntries(
        Object.entries(cases).map(([name, [clean, tricked]]) => [
          name,
          [leaks(clean), leaks(tricked)],
        ]),
      ),
    ).toEqual(Object.fromEntries(Object.keys(cases).map((name) => [name, [false, true]])));
  });

  // The failures of a crate calling `ext::name!`, with two entries for ext read at 1.0.0, one of a
  // macro nobody calls, under a Cargo.lock locking `lock`.
  const readAt = (
    lock: [string, string, string?][],
    reason = "read ext@1.0.0 src/lib.rs: expansion writes no impl",
    manifests: Record<string, string> = {},
  ) =>
    failures(
      fuzzed,
      exempt,
      {
        ...repo,
        ...withDeps,
        ...manifests,
        "Cargo.lock": lockOf(lock),
        "crates/r/src/lib.rs": "pub fn name() -> String { ext::name!() }",
      },
      {},
      {
        "ext::name": { read: { ext: { version: "1.0.0", checksum: "sum" } }, reason },
        "ext::gone": {
          read: { ext: { version: "1.0.0", checksum: "sum" } },
          reason: "read ext@1.0.0 src/lib.rs: expansion writes no impl",
        },
      },
    );

  it("holds each foreign macro to the version of its crate a review read", () => {
    const stale =
      "scripts/check-standards.ts: FOREIGN_MACROS lists ext::gone, which no product code calls.";
    expect(readAt([["ext", "1.0.0"]])).toEqual([stale]);
    expect(readAt([["ext", "1.0.1"]])).toEqual([...moved("ext 1.0.1"), stale]);
    expect(
      readAt([
        ["ext", "1.0.0"],
        ["ext", "1.0.1"],
      ]),
    ).toEqual([...moved("ext 1.0.0, 1.0.1"), stale]);
    expect(readAt([])).toEqual([...moved("no ext"), stale]);
    const unsaid =
      "scripts/check-standards.ts: FOREIGN_MACROS's reason for ext::name doesn't say it read " +
      "ext@1.0.0: write it as `read <crate>@<version> <file>: expansion writes no impl`.";
    expect(
      readAt([["ext", "1.0.0"]], "read ext@0.9.0 src/lib.rs: expansion writes no impl"),
    ).toEqual([unsaid, stale]);
    expect(readAt([["ext", "1.0.0"]], "looked at ext@1.0.0 src/lib.rs")).toEqual([unsaid, stale]);
  });

  it("holds each foreign macro to the crates.io package a review read, under its own name", () => {
    const stale =
      "scripts/check-standards.ts: FOREIGN_MACROS lists ext::gone, which no product code calls.";
    const git = 'source = "git+https://example.com/ext#0a1b"';
    expect(readAt([["ext", "1.0.0", git]])).toEqual([
      ...taken("git+https://example.com/ext#0a1b with checksum none"),
      stale,
    ]);
    // A `[patch]` or `[replace]` by a path locks the package with no source and no checksum.
    expect(readAt([["ext", "1.0.0", ""]])).toEqual([
      ...taken("no registry with checksum none"),
      stale,
    ]);
    // A lock written by hand, giving a git source the checksum read.
    expect(readAt([["ext", "1.0.0", `${git}\nchecksum = "sum"`]])).toEqual([
      ...taken("git+https://example.com/ext#0a1b with checksum sum"),
      stale,
    ]);
    // A `[replace]` keeps the source and builds the package it names instead.
    const replaced = `source = "${CRATES_IO}"\nchecksum = "sum"\nreplace = "ext 1.0.0 (git+https://example.com/ext#0a1b)"`;
    expect(readAt([["ext", "1.0.0", replaced]])).toEqual([
      ...taken(
        `${CRATES_IO} with checksum sum, replaced by ext 1.0.0 (git+https://example.com/ext#0a1b)`,
      ),
      stale,
    ]);
    const other = `source = "${CRATES_IO}"\nchecksum = "other"`;
    expect(readAt([["ext", "1.0.0", other]])).toEqual([
      ...taken(`${CRATES_IO} with checksum other`),
      stale,
    ]);
    const lock: [string, string][] = [
      ["ext", "1.0.0"],
      ["evil", "1.0.0"],
    ];
    expect(
      readAt(lock, undefined, manifestOf('ext = { package = "evil", version = "1" }')),
    ).toEqual([...renamesOf("crates/r/Cargo.toml"), stale]);
    expect(
      readAt(lock, undefined, manifestOf('ext = "1"\nevil = { package = "ext", version = "1" }')),
    ).toEqual([...renamesOf("crates/r/Cargo.toml"), stale]);
    expect(readAt(lock, undefined, manifestOf('ext = "1"\nevil = "1"'))).toEqual([stale]);
    // A macro named through a crate other than the one read, which re-exports it.
    const through = (deps: string) =>
      failures(
        fuzzed,
        exempt,
        {
          ...repo,
          ...manifestOf(deps),
          "Cargo.lock": lockOf([...lock, ["ext_impl", "1.0.0"]]),
          "crates/r/src/lib.rs": "pub fn name() -> String { ext::name!() }",
        },
        {},
        {
          "ext::name": {
            read: { ext_impl: { version: "1.0.0", checksum: "sum" } },
            reason: "read ext_impl@1.0.0 src/lib.rs: expansion writes no impl",
          },
        },
      );
    expect(through('ext = "1"')).toEqual([]);
    expect(through('ext = "1"\nimpl2 = { package = "ext_impl", version = "1" }')).toEqual([
      "crates/r/Cargo.toml: renames a crate to or from ext_impl, which FOREIGN_MACROS trusts " +
        "ext::name by, so the name may be another crate's: take the crate by its own name.",
    ]);
    expect(through('ext = { package = "evil", version = "1" }')).toEqual([
      "crates/r/Cargo.toml: renames a crate to or from ext, which FOREIGN_MACROS trusts " +
        "ext::name by, so the name may be another crate's: take the crate by its own name.",
    ]);
  });

  it("follows a field's methods through every type that holds it, and keeps a cycle", () => {
    const tree = {
      ...repo,
      "crates/q/src/lib.rs": [
        "pub struct Inner { tx: Vec<u8> }",
        "impl Inner {",
        "    pub fn tick(&self) { self.tx.clear() }",
        "    pub fn count(&self) -> u32 { 0 }",
        "}",
        "pub struct Mid { inner: Inner }",
        "impl Mid {",
        "    pub fn tick(&self) { self.inner.tick() }",
        "    pub fn count(&self) -> u32 { self.inner.count() }",
        "}",
        "pub struct Top { mid: Mid }",
        "impl Top {",
        "    pub fn tick(&self) { self.mid.tick() }",
        "    pub fn count(&self) -> u32 { self.mid.count() }",
        "}",
        "pub struct A { b: std::sync::Arc<B>, tx: Vec<u8> }",
        "pub struct B { a: std::sync::Arc<A> }",
        "impl A { pub fn f(&self) -> u32 { self.b.g() } }",
        "impl B { pub fn g(&self) -> u32 { self.a.f() } }",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/q/src/lib.rs::Inner::tick",
      "crates/q/src/lib.rs::Mid::tick",
      "crates/q/src/lib.rs::Top::tick",
      "crates/q/src/lib.rs::A::f",
      "crates/q/src/lib.rs::B::g",
    ]);
  });

  it("follows another crate's carrier through a module, a renamed crate, an alias or a re-export", () => {
    const tree = {
      ...repo,
      "crates/q/src/lib.rs": [
        "pub mod frame {",
        "    pub struct Request { b: Vec<u8> }",
        "}",
        "pub struct Decoder { buf: Vec<u8> }",
        "pub struct Other { buf: Vec<u8> }",
        "pub struct Third { buf: Vec<u8> }",
        "pub struct Fourth { buf: Vec<u8> }",
        "pub struct Fifth { buf: Vec<u8> }",
      ].join("\n"),
      "crates/p/src/conn.rs": [
        "use q::frame;",
        "use q as proto;",
        "use q::{self as hq};",
        "extern crate q as eq;",
        "pub use q::Fourth;",
        "type Dec = proto::Fifth;",
        "pub struct Conn {",
        "    id: u64,",
        "    held: Option<frame::Request>,",
        "    d: proto::Decoder,",
        "    o: hq::Other,",
        "    t: eq::Third,",
        "}",
        "impl Conn {",
        "    pub fn id(&self) -> u64 { self.id }",
        "    pub fn held(&self) -> bool { self.held.is_some() }",
        "    pub fn d(&self) { look(&self.d) }",
        "    pub fn o(&self) { look(&self.o) }",
        "    pub fn t(&self) { look(&self.t) }",
        "}",
      ].join("\n"),
      "crates/w/src/lib.rs": [
        "use q::{self as hw};",
        "mod inner {",
        "    pub struct Decoder { n: u64 }",
        "}",
        "pub struct W { f: self::inner::Decoder, n: u64 }",
        "impl W {",
        "    pub fn f(&self) { look(&self.f) }",
        "}",
      ].join("\n"),
      "crates/r/src/lib.rs": [
        "use p::Fourth;",
        "pub struct Boxed { f: Fourth, n: u64 }",
        "impl Boxed {",
        "    pub fn f(&self) { look(&self.f) }",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/conn.rs::Dec",
      "crates/p/src/conn.rs::Conn::held",
      "crates/p/src/conn.rs::Conn::d",
      "crates/p/src/conn.rs::Conn::o",
      "crates/p/src/conn.rs::Conn::t",
      "crates/r/src/lib.rs::Boxed::f",
    ]);
  });

  // The alias and the byte enum of one crate, as the CLI has them, in modules of their own.
  const steps: Record<string, string> = {
    "crates/c/src/tasks.rs": "pub struct Stop;\npub type Step<T> = Result<T, Stop>;\n",
    "crates/c/src/attach/mod.rs": "pub mod direct;\npub use direct::Step;\n",
    "crates/c/src/attach/direct.rs": [
      "pub enum Step {",
      "    Send(u32),",
      "    Show(Vec<u8>),",
      "    End,",
      "}",
    ].join("\n"),
  };

  it("takes a name for the type its module brings in, not another type of that name", () => {
    const tree = {
      ...repo,
      ...steps,
      "crates/c/src/lib.rs": [
        "pub mod tasks;",
        "pub mod attach;",
        "pub mod verbs;",
        "pub mod globbed;",
        "pub mod both;",
        "pub mod inline;",
        "pub mod blocks;",
      ].join("\n"),
      "crates/c/src/verbs.rs": [
        "use crate::tasks::Step;",
        "use crate::attach::{self, direct};",
        "pub fn answer(step: Step<String>) -> u8 { 0 }",
        "pub fn boxed(steps: Vec<Option<Step<u8>>>) {}",
        "pub fn shown(step: direct::Step) {}",
        "pub fn full(step: crate::attach::direct::Step) {}",
        "pub fn parent(step: super::attach::direct::Step) {}",
        "pub fn exported(step: attach::Step) {}",
        "pub fn matched(n: u8) {",
        "    if let direct::Step::Show(b) = make(n) { look(b) }",
        "}",
      ].join("\n"),
      "crates/c/src/blocks.rs": [
        "use crate::tasks::Step;",
        "pub fn local(n: u8) {",
        "    use crate::attach::direct::Step;",
        "    if let Step::Show(b) = make(n) { look(b) }",
        "}",
      ].join("\n"),
      "crates/c/src/globbed.rs": "use crate::attach::direct::*;\npub fn globbed(step: Step) {}\n",
      "crates/c/src/both.rs": [
        "use crate::attach::direct::*;",
        "use crate::tasks::Step;",
        "pub fn both(step: Step<u8>) {}",
      ].join("\n"),
      "crates/c/src/inline.rs": [
        "mod inner {",
        "    pub use crate::attach::direct::Step;",
        "}",
        "use crate::tasks::Step;",
        "pub fn inner(step: inner::Step) {}",
        "pub fn outer(step: Step<u8>) {}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/c/src/verbs.rs::shown",
      "crates/c/src/verbs.rs::full",
      "crates/c/src/verbs.rs::parent",
      "crates/c/src/verbs.rs::exported",
      "crates/c/src/verbs.rs::matched",
      "crates/c/src/blocks.rs::local",
      "crates/c/src/globbed.rs::globbed",
      "crates/c/src/inline.rs::inner",
    ]);
  });

  it("refuses a rename of a carrier, and of its variant, but not of a type sharing its name", () => {
    const tree = {
      ...repo,
      ...steps,
      "crates/c/src/lib.rs": "pub mod tasks;\npub mod attach;\npub mod verbs;\n",
      "crates/c/src/verbs.rs": [
        "use crate::tasks::Step as Plain;",
        "use crate::attach::direct::Step as Byte;",
        "use crate::tasks::{Stop, Step as Again};",
        "use crate::attach::direct::Step::Show;",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree)).toEqual([
      expect.stringContaining("verbs.rs: `Step as Byte` renames a byte type"),
      expect.stringContaining("brings in a variant of Step that carries bytes"),
    ]);
  });

  it("doesn't take a carrier one module brings in from another crate for another module's type", () => {
    const tree = {
      ...repo,
      ...steps,
      "crates/q/src/lib.rs": "pub enum Step { Show(Vec<u8>) }\n",
      "crates/c/src/lib.rs": "pub mod tasks;\npub mod foreign;\npub mod verbs;\n",
      "crates/c/src/foreign.rs": "use q::Step;\npub fn foreign(step: Step) {}\n",
      "crates/c/src/verbs.rs": "use crate::tasks::Step;\npub fn answer(step: Step<String>) {}\n",
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/c/src/foreign.rs::foreign",
    ]);
  });

  it("takes a type through a crate it can't name for any carrier of that name", () => {
    const tree = {
      ...repo,
      "Cargo.toml": '[workspace.dependencies]\nqp = { path = "crates/q" }\nserde = "1"\n',
      "crates/q/Cargo.toml": '[package]\nname = "queue"\n',
      "crates/q/src/lib.rs": "pub struct Frames { buf: Vec<u8> }",
      "crates/a/src/lib.rs": carrierCrate("A", "Frames", "use mystery::Frames;"),
      "crates/b/Cargo.toml": '[dependencies]\nqq = { path = "../q" }\n',
      "crates/b/src/lib.rs": carrierCrate("B", "qq::Frames"),
      "crates/c/Cargo.toml": "[dependencies]\nqp = { workspace = true }\n",
      "crates/c/src/lib.rs": carrierCrate("C", "qp::Frames"),
      "crates/d/Cargo.toml": "[dependencies]\nserde = { workspace = true }\n",
      "crates/d/src/lib.rs": carrierCrate("D", "Frames", "use serde::Frames;"),
      "crates/e/src/lib.rs": carrierCrate("E", "std::io::Frames"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/a/src/lib.rs::A::f",
      "crates/b/src/lib.rs::B::f",
      "crates/c/src/lib.rs::C::f",
    ]);
  });

  it("takes a module that may not be the one a path names for one that may not hide a carrier", () => {
    const glob = "use crate::attach::*;\n";
    const inline = "mod direct {\n    pub struct Step;\n}\n";
    const takes = "pub fn f(s: direct::Step) {}\n";
    const tree = {
      ...repo,
      ...steps,
      "crates/c/Cargo.toml": '[dependencies]\nlog = "0.4"\n',
      "crates/c/src/lib.rs": ["attach", "a", "b", "g", "l", "o", "n"]
        .map((m) => `pub mod ${m};`)
        .join("\n"),
      "crates/c/src/a.rs": `${glob}#[cfg(windows)]\n${inline}${takes}`,
      "crates/c/src/b.rs": `${glob}#[cfg(windows)]\nmod direct;\n${takes}`,
      "crates/c/src/b/direct.rs": "pub struct Step;\n",
      "crates/c/src/g.rs": `${glob}fn g() {\n${inline}}\n${takes}`,
      "crates/c/src/l.rs": '#[path = "x.rs"]\nmod log;\npub fn f(s: log::Step) {}\n',
      "crates/c/src/x.rs": "pub struct Step;\n",
      "crates/c/src/o.rs":
        '#[cfg_attr(unix, path = "real.rs")]\nmod os;\npub fn f(s: os::Step) {}\n',
      "crates/c/src/o/os.rs": "pub struct Step;\n",
      "crates/c/src/n.rs": `${glob}${inline}${takes}`,
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/c/src/a.rs::f",
      "crates/c/src/b.rs::f",
      "crates/c/src/g.rs::f",
      "crates/c/src/l.rs::f",
      "crates/c/src/o.rs::f",
    ]);
  });

  it("takes a crate's name for a carrier where a glob it can't follow may bring the name in", () => {
    const takes = "pub fn f(s: log::Step) {}\n";
    const tree = {
      ...repo,
      ...steps,
      "crates/c/Cargo.toml": '[dependencies]\nlog = "0.4"\n',
      "crates/c/src/lib.rs": ["attach", "p", "u", "s"].map((m) => `pub mod ${m};`).join("\n"),
      "crates/c/src/p.rs": `#[path = "x.rs"]\nmod imp;\nuse imp::*;\n${takes}`,
      "crates/c/src/x.rs": "pub mod log {\n    pub use crate::attach::Step;\n}\n",
      "crates/c/src/u.rs": `use mystery::*;\n${takes}`,
      "crates/c/src/s.rs": `use std::io::*;\n${takes}`,
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/c/src/p.rs::f",
      "crates/c/src/u.rs::f",
    ]);
  });

  it("takes a type of cfg'd twin modules for a carrier when either twin's is one", () => {
    const tree = {
      ...repo,
      "crates/c/src/lib.rs": [
        '#[cfg(target_os = "linux")]',
        "mod imp {",
        "    pub struct Event { b: Vec<u8> }",
        "}",
        '#[cfg(target_os = "macos")]',
        "mod imp {",
        "    pub struct Event { n: u32 }",
        "}",
        "pub struct Event { n: u32 }",
        "pub fn wait(e: imp::Event) {}",
        "pub fn top(e: Event) {}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/c/src/lib.rs::wait",
    ]);
  });

  it("names a crate by its package, and by each name a manifest gives it", () => {
    const tree = {
      ...repo,
      "Cargo.toml": '[workspace.dependencies]\nqw = { package = "queue", path = "crates/q" }\n',
      "crates/q/Cargo.toml": [
        "[package]",
        'name = "queue"',
        "[package.metadata.docs]",
        'qm = { package = "queue" }',
      ].join("\n"),
      "crates/q/src/lib.rs": "pub struct Frames { buf: Vec<u8> }",
      "crates/a/Cargo.toml": '[dependencies]\nqq = { package = "queue", path = "../q" }\n',
      "crates/a/src/lib.rs": carrierCrate("A", "qq::Frames"),
      "crates/b/Cargo.toml": '[dependencies.qz]\npackage = "queue"\npath = "../q"\n',
      "crates/b/src/lib.rs": carrierCrate("B", "qz::Frames"),
      "crates/c/src/lib.rs": carrierCrate("C", "qw::Frames"),
      "crates/d/Cargo.toml": '[dependencies]\nq = "1"\n',
      "crates/d/src/lib.rs": carrierCrate("D", "Frames", "use q::Frames;"),
      "crates/e/src/lib.rs": carrierCrate("E", "Frames", "use queue::Frames;"),
      "crates/m/Cargo.toml": '[dependencies]\nqm = "1"\n',
      "crates/m/src/lib.rs": carrierCrate("M", "qm::Frames"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/a/src/lib.rs::A::f",
      "crates/b/src/lib.rs::B::f",
      "crates/c/src/lib.rs::C::f",
      "crates/e/src/lib.rs::E::f",
    ]);
  });

  it("names a crate whichever way its manifest writes the name", () => {
    const tree = {
      ...repo,
      "Cargo.toml": '[workspace.dependencies]\nqd.package = "queue"\nqd.path = "crates/q"\n',
      "crates/q/Cargo.toml": "[package]\nname = 'queue'\n",
      "crates/q/src/lib.rs": "pub struct Frames { buf: Vec<u8> }",
      "crates/a/Cargo.toml": "[dependencies]\nqs = { package = 'queue', path = \"../q\" }\n",
      "crates/a/src/lib.rs": carrierCrate("A", "qs::Frames"),
      "crates/b/Cargo.toml": "[dependencies . qt]\npackage = 'queue'\n",
      "crates/b/src/lib.rs": carrierCrate("B", "qt::Frames"),
      "crates/c/src/lib.rs": carrierCrate("C", "qd::Frames"),
      "crates/d/Cargo.toml":
        '[target.\'cfg(unix)\'.dependencies]\n"qk" = {\n  path = "../q",\n  package = "queue",\n}\n',
      "crates/d/src/lib.rs": carrierCrate("D", "qk::Frames"),
      "crates/e/src/lib.rs": carrierCrate("E", "Frames", "use queue::Frames;"),
      "crates/f/Cargo.toml": "dev-dependencies.qv.package = 'queue'\n",
      "crates/f/src/lib.rs": carrierCrate("F", "qv::Frames"),
      "crates/g/Cargo.toml":
        '[package.metadata.x]\nqx.package = "queue"\n[dependencies]\nqx = "1"\n',
      "crates/g/src/lib.rs": carrierCrate("G", "qx::Frames"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/a/src/lib.rs::A::f",
      "crates/b/src/lib.rs::B::f",
      "crates/c/src/lib.rs::C::f",
      "crates/d/src/lib.rs::D::f",
      "crates/e/src/lib.rs::E::f",
      "crates/f/src/lib.rs::F::f",
    ]);
  });

  it("leaves a manifest whose package name it can't read to the manifest check, which names it", () => {
    const tree = {
      ...repo,
      "Cargo.toml": [
        "[workspace.dependencies]",
        'qe = { package = "qu\\u0065ue" }',
        "qn.package = 1",
        "qp.package.name = 'queue'",
        "qi = { package = { name = 'queue' } }",
        'qo = { version = "1" }',
        "[package.metadata.x]",
        "qm.package = 1",
        '[target."cfg(unix = \\"1\\")".dependencies]',
        "qt = { package = 'queue' }",
        'qd.package = "queue"',
        'qv = "1"',
      ].join("\n"),
      "crates/q/Cargo.toml": '[package]\nname = """queue"""\n',
    };
    expect(failures(fuzzed, exempt, tree)).toEqual([]);
    expect(manifestFailures(tree)).toEqual([
      expect.stringContaining('Cargo.toml: can\'t read `qe = { package = "qu\\u0065ue" }`'),
      expect.stringContaining("Cargo.toml: can't read `qn.package = 1`"),
      expect.stringContaining("Cargo.toml: can't read `qp.package.name = 'queue'`"),
      expect.stringContaining("Cargo.toml: can't read `qi = { package = { name = 'queue' } }`"),
      expect.stringContaining(
        'Cargo.toml: can\'t read `[target."cfg(unix = \\"1\\")".dependencies] qt = { package',
      ),
      expect.stringContaining(
        'Cargo.toml: can\'t read `[target."cfg(unix = \\"1\\")".dependencies] qd.package',
      ),
      expect.stringContaining('crates/q/Cargo.toml: can\'t read `name = """queue"""`'),
    ]);
  });

  it("takes every self method of a carrier no field pins its bytes to", () => {
    const tree = {
      ...repo,
      "crates/p/src/a.rs": [
        "pub enum Msg { Data(Vec<u8>), Ping }",
        "impl Msg {",
        "    pub fn code(&self) -> u8 { 0 }",
        "}",
        "pub struct Keyed { n: u64, b: Vec<u8> }",
        "impl Keyed {",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
        "pub struct Twin { n: u64, b: Vec<u8> }",
        "impl Twin {",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
        "pub enum Mirror { A(Vec<u8>) }",
        "pub struct Bounded<R> where R: Read { r: R, n: u64 }",
        "impl<R> Bounded<R> {",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
      ].join("\n"),
      "crates/p/src/b.rs": [
        "pub enum Twin { A(Vec<u8>) }",
        "pub struct Mirror { n: u64, b: Vec<u8> }",
        "impl Mirror {",
        "    pub fn n(&self) -> u64 { self.n }",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/a.rs::Msg::code",
      "crates/p/src/a.rs::Bounded::n",
    ]);
  });

  it("names a pub byte field another crate could read, unless listed with a reason", () => {
    const tree = {
      ...repo,
      "crates/p/src/pubs.rs": [
        "pub struct Open {",
        "    #[allow(dead_code)]",
        "    pub buf: Vec<u8>,",
        "    pub n: u64,",
        "    pub(crate) mine: Vec<u8>,",
        "    own: Vec<u8>,",
        "}",
        "pub struct Tuple(pub [u8; 4], pub(super) Vec<u8>);",
        "pub struct Listed { pub rgb: [u8; 3], pub bare: [u8; 3] }",
      ].join("\n"),
    };
    const listed = {
      "crates/p/src/pubs.rs::Listed::rgb": "a colour",
      "crates/p/src/pubs.rs::Listed::bare": " ",
      "crates/p/src/pubs.rs::Gone::x": "a colour",
    };
    expect(failures(fuzzed, exempt, tree, listed)).toEqual([
      expect.stringContaining("crates/p/src/pubs.rs::Open::buf: a pub byte field"),
      expect.stringContaining("crates/p/src/pubs.rs::Tuple::0: a pub byte field"),
      expect.stringContaining("Listed::bare is in PUBLIC_BYTE_FIELDS with no reason"),
      expect.stringContaining("Gone::x is listed, but no such pub byte field exists"),
    ]);
  });

  it("takes an enum for a carrier by its variants' fields, not by their names", () => {
    const tree = {
      ...repo,
      "crates/p/src/e.rs": [
        "pub struct Ring { buf: Vec<u8> }",
        "pub enum Origin { Ring, Snapshot = 2 }",
        "impl Origin {",
        "    pub fn code(&self) -> u8 { 0 }",
        "}",
        "pub enum Holds { A(Ring), B }",
        "impl Holds {",
        "    pub fn code(&self) -> u8 { 0 }",
        "}",
        "pub enum Named { Input { bytes: Vec<u8> }, Ring { n: u64 } }",
        "impl Named {",
        "    pub fn code(&self) -> u8 { 0 }",
        "}",
        "pub enum Bounded<R> where R: Read { A(R), B }",
        "impl<R> Bounded<R> {",
        "    pub fn code(&self) -> u8 { 0 }",
        "}",
        "pub enum Op { Read, Buf }",
        "impl Op {",
        "    pub fn code(&self) -> u8 { 0 }",
        "}",
        "pub fn origin(o: Origin) {}",
        "pub fn op(o: Op) {}",
        "pub fn holds(h: Holds) {}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/e.rs::Holds::code",
      "crates/p/src/e.rs::Named::code",
      "crates/p/src/e.rs::Bounded::code",
      "crates/p/src/e.rs::holds",
    ]);
  });

  it("takes a function whose pattern binds a byte field of a variant, however it got the value", () => {
    const tree = {
      ...repo,
      "crates/q/src/lib.rs": [
        "pub enum Msg {",
        "    Data { id: u64, bytes: Vec<u8> },",
        "    Raw(u64, Vec<u8>),",
        "    Trio(Vec<u8>, u64),",
        "    Ping(u64),",
        "    Nested(Option<Inner>),",
        "    Odd { Vec<u8>, n: u64 },",
        "    Gone,",
        "}",
        "pub enum Inner { Flag(bool), Body(Vec<u8>), Tagged { tag: u64, body: Vec<u8> } }",
        "pub enum Wrap<R> where R: Read { Raw(R), Ping }",
        "pub enum Attr { #[a[b[c]]] Raw(Vec<u8>), Late #[a[b[c]]] (Vec<u8>), Ping }",
        "pub fn send(m: Msg) {}",
      ].join("\n"),
      "crates/a/src/lib.rs": [
        "use q::{Attr, Inner, Msg, Wrap};",
        "fn arm() { match next() { Msg::Data { bytes, .. } => look(bytes), _ => {} } }",
        "fn renamed() { match next() { Msg::Data { bytes: b, .. } => look(b), _ => {} } }",
        "fn tuple() { if let Msg::Raw(_, b) = next() { look(b) } }",
        "fn tail() { if let Msg::Raw(.., b) = next() { look(b) } }",
        "fn front() { if let Msg::Trio(b, ..) = next() { look(b) } }",
        "fn by_ref() { match &next() { &Msg::Data { ref bytes, .. } => look(bytes), _ => {} } }",
        "fn by_ref_mut() { match next() { Msg::Raw(_, ref mut b) => look(b), _ => {} } }",
        "fn by_amp() { if let Some(&Msg::Raw(_, ref b)) = all().first() { look(b) } }",
        "fn boxed() { match next() { Msg::Raw(_, box b) => look(b), _ => {} } }",
        "fn either() { match next() { Msg::Raw(_, b) | Msg::Data { bytes: b, .. } => look(b), _ => {} } }",
        "fn first() { match next() { Ok(Msg::Raw(_, b)) | Err(b) => look(b), _ => {} } }",
        "fn guard() { match next() { Msg::Raw(_, b) if b.is_empty() => {} _ => {} } }",
        "fn nested(n: u64) { if n > 0 { match next() { Msg::Raw(_, b) => look(b), _ => {} } } }",
        "fn after_guard(n: u64) { match next() { Msg::Ping(m) if m == n => a(), Msg::Raw(_, b) => look(b), _ => {} } }",
        "fn after_if(n: u64) { match next() { Msg::Ping(0) => if n > 0 { a() } else { c() } Msg::Raw(_, b) => look(b), _ => {} } }",
        "fn or_else() { let Msg::Raw(_, b) = next() else { return }; look(b) }",
        "fn each() { while let Some(Msg::Data { bytes, .. }) = queue() { look(bytes) } }",
        "fn check() -> bool { matches!(next(), Msg::Raw(_, b) if b.is_empty()) }",
        "fn slice() { if let [Msg::Raw(_, b), ..] = all() { look(b) } }",
        "fn looped() { for Msg::Raw(_, b) in all() { look(b) } }",
        "fn typed() { let Msg::Raw(_, b): Msg = next() else { return }; look(b) }",
        "fn closure() { all().map(|Msg::Raw(_, b): Msg| look(b)) }",
        "fn selected() { select! { Some(Msg::Raw(_, b)) = rx.recv() => look(b) } }",
        "fn assigned() { let b; Msg::Raw(_, b) = next(); look(b) }",
        "fn generic_enum() { if let Msg::<u8>::Raw(_, b) = next() { look(b) } }",
        "fn generic_variant() { if let Msg::Raw::<u8>(_, b) = next() { look(b) } }",
        "fn pair() { match (next(), 1) { (Msg::Data { bytes, .. }, _) => look(bytes), _ => {} } }",
        "fn held() { match get() { Holder { msg: Msg::Raw(_, b), .. } => look(b) } }",
        "fn whole() { if let m @ Msg::Data { .. } = next() { keep(m) } }",
        "fn whole_some() { if let m @ Some(Msg::Data { .. }) = all().pop() { keep(m) } }",
        "fn whole_or() { match next() { m @ (Msg::Raw(..) | Msg::Data { .. }) => keep(m), _ => {} } }",
        "fn whole_ref() { if let m @ &Msg::Raw(..) = &next() { keep(m) } }",
        "fn pathed() { if let q::Msg::Raw(_, b) = next() { look(b) } }",
        "fn body() { if let Msg::Nested(Some(Inner::Body(b))) = next() { look(b) } }",
        "fn wrapped() { if let Wrap::Raw(r) = make() { look(r) } }",
        "fn odd() { if let Msg::Odd { n, .. } = next() { look(n) } }",
        "fn attr() { if let Attr::Raw(b) = make() { look(b) } }",
        "fn at_before() { if let (m @ Some(_), Msg::Data { .. }) = pair() { keep(m) } }",
        "fn ranged(n: u64) { match n { k @ 1..=3 => keep(Msg::Raw(k, make())), _ => {} } }",
        "fn rest() { match next() { Msg::Data { .. } => {} _ => {} } }",
        "fn other_field() { match next() { Msg::Data { id, .. } => look(id), Msg::Raw(n, _) => look(n), _ => {} } }",
        "fn trio_tail() { if let Msg::Trio(.., n) = next() { look(n) } }",
        "fn plain() { if let Msg::Ping(n) = next() { look(n) } }",
        "fn unit() { if let Msg::Gone = next() {} }",
        "fn ignored() { if let Msg::Raw(_, _) = next() {} }",
        "fn odd_rest() { if let Msg::Odd { .. } = next() {} }",
        "fn flagged() { if let Msg::Nested(Some(Inner::Flag(true))) = next() {} }",
        "fn none() { if let Msg::Nested(None) = next() {} }",
        "fn tagged() { if let Msg::Nested(Some(Inner::Tagged { tag: 1, .. })) = next() {} }",
        "fn built() -> Msg { let bytes = make(); Msg::Data { id: 0, bytes } }",
        "fn sent() { let b = make(); let m = Msg::Raw(0, b); q::send(m); q::send(Msg::Raw(0, b)); }",
        "fn listed() -> Vec<Msg> { let b = make(); vec![Msg::Raw(0, b), Msg::Ping(0)] }",
        "fn chosen(n: u64) -> Option<Msg> { let b = make(); match n { 0 => Some(Msg::Raw(n, b)), _ => None } }",
        "fn blocked(n: u64) -> Msg { let b = make(); if n > 0 { Msg::Raw(n, b) } else { Msg::Gone } }",
        "fn same() -> bool { let b = make(); let same = Msg::Raw(0, b) == next(); same }",
        "fn either_built() -> bool { let b = make(); keep(Msg::Raw(0, b)) || done() }",
        "fn compared() { let b = make(); match next() { m if m == Msg::Raw(0, b) => {} _ => {} } }",
        "fn indexed() { let b = make(); slots[Msg::Raw(0, b)] = 1; }",
        "fn indexed_call() { let b = make(); slots()[Msg::Raw(0, b)] = 1; }",
        "fn indexed_twice() { let b = make(); grid[0][Msg::Raw(0, b)] = 1; }",
        "fn forward() { let m = next(); match m { Msg::Data { .. } => q::send(m), _ => {} } }",
      ].join("\n"),
      "crates/b/src/lib.rs": [
        "pub enum Msg { Raw(u64, u64) }",
        "fn local() { if let Msg::Raw(_, n) = make() { look(n) } }",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/q/src/lib.rs::Msg::Odd",
      "crates/q/src/lib.rs::Attr::Raw",
      "crates/q/src/lib.rs::Attr::Late",
      "crates/q/src/lib.rs::send",
      ...[
        "arm",
        "renamed",
        "tuple",
        "tail",
        "front",
        "by_ref",
        "by_ref_mut",
        "by_amp",
        "boxed",
        "either",
        "first",
        "guard",
        "nested",
        "after_guard",
        "after_if",
        "or_else",
        "each",
        "check",
        "slice",
        "looped",
        "typed",
        "closure",
        "selected",
        "assigned",
        "generic_enum",
        "generic_variant",
        "pair",
        "held",
        "whole",
        "whole_some",
        "whole_or",
        "whole_ref",
        "pathed",
        "body",
        "wrapped",
        "odd",
        "attr",
      ].map((fn) => `crates/a/src/lib.rs::${fn}`),
    ]);
  });

  it("takes a pattern on Self in the enum's own impl, and fails an alias of the enum", () => {
    const tree = {
      ...repo,
      "crates/p/src/f.rs": [
        "pub enum Frame { Data(Vec<u8>), Ping }",
        "pub struct Other { n: u64 }",
        "pub enum Kind { Data(u64) }",
        "impl Frame {",
        "    pub fn parse() -> Self { match make() { Self::Data(b) => Self::Data(b), f => f } }",
        "    pub fn ping() -> Self { Self::Ping }",
        "    pub fn wrap(b: Vec<u8>) -> Self { Self::Data(b) }",
        "}",
        "impl Kind {",
        "    pub fn n() -> u64 { match make() { Self::Data(n) => n } }",
        "}",
        "impl Other {",
        "    pub fn n() -> u64 { match make() { Self::Data(n) => n, _ => 0 } }",
        "}",
        "fn free() { match make() { Frame::Data(b) => look(b), _ => {} } }",
        "type Alias = Frame;",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/f.rs::Alias",
      "crates/p/src/f.rs::Frame::parse",
      "crates/p/src/f.rs::Frame::wrap",
      "crates/p/src/f.rs::free",
    ]);
  });

  it("names a `use` that brings in a byte-carrying variant by its own name", () => {
    const tree = {
      ...repo,
      "crates/q/src/lib.rs": "pub enum Msg { Raw(Vec<u8>), Ping }\npub enum Kind { A, B }\n",
      "crates/a/src/lib.rs": [
        "use q::Msg::*;",
        "use q::Msg::{Ping, Raw};",
        "use q::Msg::Raw;",
        "use q::Msg::{self};",
        "use q::Msg::Ping;",
        "use q::Msg;",
        "use q::Kind::*;",
        "pub struct A { n: u64 }",
        "impl A {",
        "    fn f() { use q::Msg::{self as M, *}; }",
        "}",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree)).toEqual([
      expect.stringContaining("`use q::Msg::*;` brings in a variant of Msg that carries bytes"),
      expect.stringContaining("`use q::Msg::{Ping, Raw};` brings in a variant of Msg"),
      expect.stringContaining("`use q::Msg::Raw;` brings in a variant of Msg"),
      expect.stringContaining("crates/a/src/lib.rs: `self as M` renames a byte type"),
      expect.stringContaining("`use q::Msg::{self as M, *};` brings in a variant of Msg"),
    ]);
  });

  it("skips a module compiled only under test, declared out of line, and the modules in it", () => {
    const tree = {
      ...repo,
      "crates/p/src/lib.rs": `${lib}#[cfg(test)]\nmod t;\nmod q;\n#[cfg(test)]\npub(crate) mod u;\n`,
      "crates/p/src/t.rs": "fn a(b: &[u8]) {}\nmod deep;\n",
      "crates/p/src/t/deep.rs": "fn c(b: &[u8]) {}",
      "crates/p/src/u/mod.rs": "fn d(b: &[u8]) {}",
      "crates/p/src/q.rs": "fn e(b: &[u8]) {}\nmod t;\n#[cfg(test)]\nmod v;\n",
      "crates/p/src/q/t.rs": "fn f(b: &[u8]) {}",
      "crates/p/src/q/v.rs": "fn g(b: &[u8]) {}",
      "crates/r/src/lib.rs":
        "mod t;\n// #[cfg(test)]\nmod u;\nmod outer {\n    #[cfg(test)]\n    mod w;\n}\n",
      "crates/r/src/w.rs": "fn j(b: &[u8]) {}",
      "crates/r/src/outer/w.rs": "fn k(b: &[u8]) {}",
      "crates/r/src/t.rs": "fn h(b: &[u8]) {}",
      "crates/r/src/u.rs": "fn i(b: &[u8]) {}",
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/q.rs::e",
      "crates/p/src/q/t.rs::f",
      "crates/r/src/w.rs::j",
      "crates/r/src/t.rs::h",
      "crates/r/src/u.rs::i",
    ]);
  });

  it("reads carriers per crate, and lets a trait in by `as _` but no carrier renamed", () => {
    const crates = {
      ...repo,
      "crates/q/src/lib.rs": "pub struct Frame { b: Vec<u8> }\nuse crate::Frame as F;\n",
      "crates/p/src/other.rs":
        "use std::io::Read as _;\npub struct Frame;\npub fn take(f: Frame) {}\n",
    };
    expect(failures(fuzzed, exempt, crates)).toEqual([
      expect.stringContaining("crates/q/src/lib.rs: `Frame as F` renames a byte type"),
    ]);
  });

  it("checks a method's target calls that type's method, by path or on a value of the type", () => {
    const tree = {
      ...repo,
      "crates/p/src/two.rs":
        "pub struct R { b: Vec<u8> }\nimpl R {\n    pub fn next(&mut self) {}\n}\n",
      "crates/p/fuzz/fuzz_targets/r.rs":
        "fuzz_target!(|b: &[u8]| { let mut r = p::R::new(b); r.next(); });",
      "crates/p/fuzz/fuzz_targets/s.rs": "fuzz_target!(|b: &[u8]| { p::S::next(b); });",
    };
    expect([
      failures({ ...fuzzed, "crates/p/src/two.rs::R::next": "r" }, exempt, tree),
      failures({ ...fuzzed, "crates/p/src/two.rs::R::next": "s" }, exempt, tree),
    ]).toEqual([[], [expect.stringContaining("s.rs: doesn't call R::next")]]);
  });

  it("refuses a rename of a byte type, and a NOT_DECODERS entry with no reason", () => {
    const renamed = {
      ...repo,
      "crates/p/src/use.rs":
        "use std::io::{Read as R, Write as W};\nuse core::primitive::u8 as Byte;\n",
    };
    expect([
      failures(fuzzed, exempt, renamed),
      failures(fuzzed, { "crates/p/src/lib.rs::send": "  " }),
    ]).toEqual([
      [
        expect.stringContaining("`Read as R` renames a byte type"),
        expect.stringContaining("`u8 as Byte` renames a byte type"),
      ],
      [expect.stringContaining("lib.rs::send is in NOT_DECODERS with no reason")],
    ]);
  });

  it("refuses a rename of a buffered reader or a WebSocket, which are byte types", () => {
    const renamed = {
      ...repo,
      "crates/p/src/use.rs":
        "use std::io::BufReader as Lines;\nuse tungstenite::WebSocket as Ws;\n",
    };
    expect(failures(fuzzed, exempt, renamed)).toEqual([
      expect.stringContaining("`BufReader as Lines` renames a byte type"),
      expect.stringContaining("`WebSocket as Ws` renames a byte type"),
    ]);
  });

  it("takes a decoder of text listed by hand, and names one listed that doesn't exist", () => {
    const text = {
      ...repo,
      "crates/p/src/pane.rs": "pub fn id(pane: &str) -> bool { true }\n",
      "crates/p/fuzz/fuzz_targets/id.rs": "fuzz_target!(|s: &str| { p::pane::id(s); });",
    };
    const listed = { ...fuzzed, "crates/p/src/pane.rs::id": "id" };
    expect([
      failures(listed, exempt, text),
      failures({ ...listed, "crates/p/src/pane.rs::gone": "id" }, exempt, text),
    ]).toEqual([
      [],
      [
        expect.stringContaining("pane.rs::gone is listed, but no such function exists"),
        expect.stringContaining("doesn't call gone"),
      ],
    ]);
  });

  it("takes a private type's method called through a trait it implements", () => {
    const port = {
      ...repo,
      "crates/p/src/conn.rs":
        "struct Conn;\nimpl Port for Conn {\n    fn route(&self, b: &[u8]) {}\n}\n",
      "crates/p/fuzz/fuzz_targets/route.rs":
        "fuzz_target!(|b: &[u8]| { let c: Box<dyn Port> = p::port(); c.route(b); });",
    };
    const listed = { ...fuzzed, "crates/p/src/conn.rs::Conn::route": "route" };
    const unnamed = {
      ...port,
      "crates/p/fuzz/fuzz_targets/route.rs": "fuzz_target!(|b: &[u8]| { p::port().route(b); });",
    };
    // The trait's name alone, as a variant or a path, isn't the trait.
    const mentioned = {
      ...port,
      "crates/p/fuzz/fuzz_targets/route.rs":
        "fuzz_target!(|b: &[u8]| { let _ = Key::Port; p::port().route(b); });",
    };
    expect([
      failures(listed, exempt, port),
      failures(listed, exempt, unnamed),
      failures(listed, exempt, mentioned),
    ]).toEqual([
      [],
      [expect.stringContaining("doesn't call Conn::route")],
      [expect.stringContaining("doesn't call Conn::route")],
    ]);
  });

  it("names a stale entry, a missing target, and a target that doesn't call its decoder", () => {
    expect([
      failures(fuzzed, { ...exempt, "crates/p/src/lib.rs::other": "x" }),
      failures({ "crates/p/src/lib.rs::decode": "gone" }, exempt),
      failures(fuzzed, exempt, {
        ...repo,
        "crates/p/fuzz/fuzz_targets/decode.rs": "fuzz_target!(|b: &[u8]| { p::parse(b); });",
      }),
    ]).toEqual([
      [expect.stringContaining("lib.rs::other is listed, but no such function takes bytes")],
      [expect.stringContaining("its fuzz target crates/p/fuzz/fuzz_targets/gone.rs doesn't exist")],
      [expect.stringContaining("doesn't call decode")],
    ]);
  });

  it("counts a call that names its type parameters, by path or as a method", () => {
    expect([
      failures(fuzzed, exempt, decodeTargetCalling("p::decode::<Frame>(b)")),
      failures(fuzzed, exempt, decodeTargetCalling("p::decode :: <Vec<Frame>> (b)")),
      failures(fuzzed, exempt, decodeTargetCalling("p::decoded::<Frame>(b)")),
    ]).toEqual([[], [], [expect.stringContaining("doesn't call decode")]]);
  });

  it("counts a method's call that names its type parameters, and no turbofish past its statement", () => {
    const methods = {
      ...repo,
      "crates/p/src/lib.rs": `${lib}pub struct Reader;\nimpl Reader { pub fn decode<T>(&self, b: &[u8]) {} }\n`,
    };
    const reading = (call: string) => ({
      ...methods,
      "crates/p/fuzz/fuzz_targets/decode.rs": `fuzz_target!(|b: &[u8]| { p::decode(b); let r = p::Reader; ${call}; });`,
    });
    const both = { ...fuzzed, "crates/p/src/lib.rs::Reader::decode": "decode" };
    expect([
      failures(both, exempt, reading("r.decode::<Frame>(b)")),
      failures(both, exempt, reading("r.decode::<Frame>; Box::<u8>(b)")),
      failures(fuzzed, exempt, decodeTargetCalling("p::decode::<T>; Box::<u8>(b)")),
      failures(fuzzed, exempt, decodeTargetCalling("p::decode::<T> { Box::<u8>(b) }")),
    ]).toEqual([
      [],
      [expect.stringContaining("doesn't call Reader::decode")],
      [expect.stringContaining("doesn't call decode")],
      [expect.stringContaining("doesn't call decode")],
    ]);
  });
});

const fuzzFailures = (text: string) => fuzzManifestFailures("crates/p/fuzz/Cargo.toml", text);

describe("fuzzManifestFailures", () => {
  const manifest = [
    "[package]",
    'name = "p-fuzz"',
    "[package.metadata]",
    "cargo-fuzz = true",
    "[dependencies]",
    'p = { path = ".." }',
    'libfuzzer-sys = "=0.4.13"',
    "[[bin]]",
    'name = "decode"',
    'path = "fuzz_targets/decode.rs"',
    "[workspace]",
  ].join("\n");

  it("accepts a cargo-fuzz crate of its own with exact pins", () => {
    expect(fuzzFailures(manifest)).toEqual([]);
  });

  it("refuses one that isn't marked, isn't its own workspace, or takes a loose dependency", () => {
    expect([
      fuzzFailures(manifest.replace("cargo-fuzz = true", "")),
      fuzzFailures(manifest.replace("[workspace]", "")),
      fuzzFailures(manifest.replace('"=0.4.13"', '"0.4"')),
      fuzzFailures(manifest.replace('{ path = ".." }', '{ path = "../../q" }')),
      fuzzFailures(`${manifest}\n[dev-dependencies]\nx = "1"\n`),
    ]).toEqual([
      [expect.stringContaining("cargo-fuzz = true")],
      [expect.stringContaining("a workspace of its own")],
      [expect.stringContaining("libfuzzer-sys")],
      [expect.stringContaining("the crate it fuzzes")],
      [expect.stringContaining("[dev-dependencies]: a fuzz crate takes its dependencies")],
    ]);
  });
});

describe("tomlTables", () => {
  it("keeps every entry of a repeated array table", () => {
    expect(tomlTables('[[bin]]\nname = "a"\n[[bin]]\nname = "b"\n').get("[[bin]]")).toEqual([
      'name = "a"',
      'name = "b"',
    ]);
  });

  it("joins an entry wrapped across lines, counting no bracket inside a string", () => {
    const tables = tomlTables(
      [
        "[package]",
        'description = "a [draft {"',
        "name = 'x]'",
        'notes = """',
        "[dependencies]",
        '"""',
        "[dependencies]",
        'serde = { version = "=1.0.229", features = [',
        '  "derive",',
        "] }",
        'proptest = "=1.12.0"',
      ].join("\n"),
    );
    expect([tables.get("[package]"), tables.get("[dependencies]")]).toEqual([
      ['description = "a [draft {"', "name = 'x]'", 'notes = """ [dependencies] """'],
      ['serde = { version = "=1.0.229", features = [ "derive", ] }', 'proptest = "=1.12.0"'],
    ]);
  });

  it("cuts a comment only outside a string", () => {
    const tables = tomlTables(
      [
        "[package]",
        'description = "Fixes #12"',
        'name = "x"#\'',
        "edition = '2024' # a comment",
        "[dependencies]",
        'serde = "1.0"',
      ].join("\n"),
    );
    expect([tables.get("[package]"), tables.get("[dependencies]")]).toEqual([
      ['description = "Fixes #12"', 'name = "x"', "edition = '2024'"],
      ['serde = "1.0"'],
    ]);
  });

  it("refuses a one-line string left open at the end of its line", () => {
    expect(() => tomlTables('[package]\nname = "x\n[dependencies]\nserde = "1.0"\n')).toThrow(
      /a string left open at the end of the line `name = "x`/,
    );
  });

  it("starts each table afresh, whatever an entry before it left open", () => {
    const tables = tomlTables(
      '[package]\nname = { a = [\n[dependencies]\nserde = { version = "1.0", features = [\n  "derive",\n] }\n',
    );
    expect([tables.get("[package]"), tables.get("[dependencies]")]).toEqual([
      ["name = { a = ["],
      ['serde = { version = "1.0", features = [ "derive", ] }'],
    ]);
  });

  it("reads an array table's header as a table of its own", () => {
    const tables = tomlTables('[dependencies]\na = "=1.0.0"\n[[bin]]\nname = "x"\n');
    expect([tables.get("[dependencies]"), tables.get("[[bin]]")]).toEqual([
      ['a = "=1.0.0"'],
      ['name = "x"'],
    ]);
  });
});

describe("rustFailures on decoders and fuzz crates", () => {
  const repo: Record<string, string> = {
    "crates/p/src/lib.rs": "pub fn decode(b: &[u8]) {}\n",
    "crates/p/fuzz/Cargo.toml": '[package]\nname = "p-fuzz"\n',
  };
  const failures = rustFailures(
    Object.keys(repo),
    (p) => repo[p] ?? "",
    {},
    {
      fuzzed: {},
      notDecoders: {},
    },
  );

  it("reads each crate's decoders, and a fuzz crate's manifest as one", () => {
    expect([
      failures.filter((f) => f.startsWith("crates/p/src/lib.rs::decode:")),
      failures.filter((f) => f.startsWith("crates/p/fuzz/Cargo.toml:")),
    ]).toEqual([
      [expect.stringContaining("takes bytes from outside")],
      [
        expect.stringContaining("cargo-fuzz = true"),
        expect.stringContaining("a workspace of its own"),
      ],
    ]);
  });
});

/** A reader that gives `source` for the holder's chokepoint and nothing for any other file. */
const guardOnly =
  (source: string) =>
  (f: string): string =>
    f === "crates/bazhen-holder/src/guard.rs" ? source : "";

describe("the signal chokepoints", () => {
  const CHOKEPOINTS = [
    "packages/host-guard/src/signal.ts",
    "crates/bazhen-holder/src/guard.rs",
    "crates/bazhen-holder/src/linux.rs",
    "crates/bazhen-host-guard/src/lib.rs",
    "crates/bazhen-test-signal/src/lib.rs",
  ];
  const failures = (sources: Record<string, string>) =>
    signalChokepointFailures([...CHOKEPOINTS, ...Object.keys(sources)], (f) => sources[f] ?? "");
  const hits = (source: string) =>
    failures({ "packages/host-guard/src/scope.ts": source }).map((f) => f.split(": ")[0]);
  const scoped = 'execFile(file, args, { env, timeout, encoding: "utf8" }, (error, stdout) => {});';

  it("allows only the exact call an allowed signal names, not another in the same file", () => {
    expect(hits(scoped)).toEqual([]);
    expect(
      hits(
        [
          scoped,
          'execFile(file, args, { env, timeout: 1, encoding: "utf8" }, done);',
          "child.kill();",
          'execFile(other, args, { env, timeout, encoding: "utf8" }, done);',
        ].join("\n"),
      ),
    ).toEqual([
      "packages/host-guard/src/scope.ts:2",
      "packages/host-guard/src/scope.ts:3",
      "packages/host-guard/src/scope.ts:4",
    ]);
    expect(hits(`${scoped}\nconst pty = { hangUp: () => proc.kill() };`)).toEqual([
      "packages/host-guard/src/scope.ts:2",
    ]);
  });

  it("fails an allowed signal found more or fewer times than it says, a copy or none", () => {
    expect(hits(`${scoped}\n${scoped}`)).toEqual(["packages/host-guard/src/scope.ts"]);
    expect(failures({ "packages/host-guard/src/scope.ts": `${scoped}\n${scoped}` })).toEqual([
      expect.stringMatching(/scope\.ts: an allowed signal .* is found 2 times, not 1/),
    ]);
    expect(failures({ "packages/host-guard/src/scope.ts": "export {};" })).toEqual([
      expect.stringMatching(/scope\.ts: an allowed signal .* is found 0 times, not 1/),
    ]);
  });

  it("fails an allowed signal listed for a file that no longer exists", () => {
    expect(allowedSignalFileFailures(["packages/host-guard/src/scope.ts"])).toContainEqual(
      "scripts/signal-paths.ts: ALLOWED_SIGNALS lists missing packages/host-guard/src/tmux.ts.",
    );
    expect(allowedSignalFileFailures(["packages/host-guard/src/scope.ts"])).toContainEqual(
      "scripts/signal-paths.ts: ENDS_WITHOUT_A_CALL lists missing apps/daemon/src/pty/node-pty.ts.",
    );
    expect(
      allowedSignalFileFailures([
        ...Object.keys(ALLOWED_SIGNALS),
        ...Object.keys(ENDS_WITHOUT_A_CALL),
      ]),
    ).toEqual([]);
  });

  it("names each raw signal call outside them, and where to send it instead", () => {
    expect(
      failures({
        "crates/bazhen-holder/tests/a.rs": "fn f() {}\nkill_process(pid, Signal::KILL);",
        "crates/bazhen-holder/src/b.rs": "unsafe { libc::killpg(g, 9) };",
        "scripts/c.ts": "process.kill(pid);",
      }),
    ).toEqual([
      expect.stringMatching(
        /^crates\/bazhen-holder\/tests\/a\.rs:2: .*kill_process.*bazhen_test_signal/,
      ),
      expect.stringMatching(/^crates\/bazhen-holder\/src\/b\.rs:1: .*killpg.*src\/guard\.rs/),
      expect.stringMatching(/^scripts\/c\.ts:1: .*process[.]kill.*@bazhen\/host-guard/),
    ]);
  });

  it("sends a raw call in a crate other than the holder to the host-guard crate", () => {
    expect(
      failures({
        "crates/bazhen-cli/src/main.rs": "use libc::*;\nfn f() {}",
        "crates/bazhen-holder-engine/src/a.rs": "nix::sys::signal::kill(pid, None);",
      }),
    ).toEqual([
      expect.stringMatching(
        /^crates\/bazhen-cli\/src\/main\.rs:1: .*use libc::\*.*bazhen-host-guard/,
      ),
      expect.stringMatching(
        /^crates\/bazhen-holder-engine\/src\/a\.rs:1: .*signal::kill.*bazhen-host-guard/,
      ),
    ]);
  });

  it("finds a signal module re-exported through a path of ours, and the import from it", () => {
    expect(
      failures({
        "crates/bazhen-x/src/a.rs": "pub use nix::sys::signal;",
        "crates/bazhen-x/src/b.rs": "use crate::a::signal::*;",
      }),
    ).toEqual([
      expect.stringMatching(
        /^crates\/bazhen-x\/src\/a\.rs:1: .*pub use nix::sys::signal.*host-guard/,
      ),
      expect.stringMatching(
        /^crates\/bazhen-x\/src\/b\.rs:1: .*use crate::a::signal::\*.*host-guard/,
      ),
    ]);
  });

  it("holds every Rust chokepoint but the tests' own crate to PRODUCT_CHOKEPOINTS", () => {
    const listed = new Set(["crates/bazhen-holder/src/guard.rs", "crates/gone/src/x.rs"]);
    expect(
      productChokepointFailures(
        [
          "packages/host-guard/src/signal.ts",
          "crates/bazhen-holder/src/guard.rs",
          "crates/bazhen-host-guard/src/signal.rs",
          "crates/bazhen-test-signal/src/lib.rs",
        ],
        listed,
      ),
    ).toEqual([
      "scripts/check-standards.ts: crates/bazhen-host-guard/src/signal.rs is a Rust chokepoint; " +
        "list it in PRODUCT_CHOKEPOINTS, so its tests send through bazhen_test_signal like any others.",
      "scripts/check-standards.ts: PRODUCT_CHOKEPOINTS lists crates/gone/src/x.rs, which is no chokepoint.",
    ]);
  });

  it("asks for a start's unread options to be written in the call, not sent elsewhere", () => {
    expect(failures({ "scripts/a.ts": "execFileSync(cmd, args, OPTS);\nchild.kill();" })).toEqual([
      "scripts/a.ts:1: options of execFileSync not written inline, so the check can't tell " +
        "whether they set a timeout, killSignal or signal, which Node enforces with a kill; " +
        "write the args as an array and the options as an object literal in the call, " +
        "`[...args]` and `{}` included (docs/standards/testing.md).",
      expect.stringMatching(/^scripts\/a\.ts:2: sends a signal directly \(child\.kill\); send it/),
    ]);
  });

  it("asks for a start the scan can't follow to be called by name, not sent elsewhere", () => {
    const source = 'import { execFile } from "node:child_process";\nconst ef = execFile;';
    expect(failures({ "scripts/a.ts": source })).toEqual([
      "scripts/a.ts:2: execFile used other than in a call, so the check can't read the options a " +
        "start there is given, which may set a timeout, killSignal or signal that Node enforces " +
        "with a kill; call each start by the name it's imported as, or as a member of " +
        "child_process imported with `import … from`, with its options in the call " +
        "(docs/standards/testing.md).",
    ]);
  });

  it("allows them in the chokepoints, and leaves installed packages alone", () => {
    const raw = "kill_process(pid, Signal::KILL); process.kill(pid);";
    expect(signalChokepointFailures([...CHOKEPOINTS, "node_modules/x/a.ts"], () => raw)).toEqual(
      [],
    );
  });

  it("sends a test module's raw call to the test crate, and product code's to the holder's", () => {
    const source =
      "fn f() { kill_process(p, s); }\n#[cfg(test)]\nmod tests {\n    fn g() { kill_process(p, s); }\n}";
    expect(failures({ "crates/bazhen-holder/src/a.rs": source })).toEqual([
      expect.stringMatching(/^crates\/bazhen-holder\/src\/a\.rs:1: .*src\/guard\.rs/),
      expect.stringMatching(/^crates\/bazhen-holder\/src\/a\.rs:4: .*bazhen_test_signal/),
    ]);
  });

  it("lets only a member's dev-dependencies take the test crate", () => {
    const manifest = [
      "[dependencies]",
      "bazhen-test-signal = { workspace = true }",
      "[target.'cfg(unix)'.dependencies]",
      "bazhen-test-signal = { workspace = true }",
      "[dev-dependencies]",
      "bazhen-test-signal = { workspace = true }",
      "[dependencies.bazhen-test-signal]",
      "workspace = true",
      "[target.'cfg(unix)'.dev-dependencies.bazhen-test-signal]",
      "workspace = true",
    ].join("\n");
    expect(
      testSignalDependencyFailures("crates/x/Cargo.toml", manifest).map((f) => f.split(": ")[0]),
    ).toEqual(["crates/x/Cargo.toml:2", "crates/x/Cargo.toml:4", "crates/x/Cargo.toml:7"]);
  });

  it("exempts the holder's chokepoint in its product code alone, not in its tests", () => {
    const source =
      "fn f() { kill_process(p, s); }\n#[cfg(test)]\nmod tests {\n    fn g() { kill_process(p, s); }\n}";
    expect(
      signalChokepointFailures(CHOKEPOINTS, guardOnly(source)).map((f) => f.split(": ")[0]),
    ).toEqual(["crates/bazhen-holder/src/guard.rs:4"]);
  });

  it("fails a glob use or a bare kill in a chokepoint's tests, which reach its imports unseen", () => {
    // Built, as a string holding `kill(` reads as a shell's kill to the scan of this file.
    const bare = "kill";
    const source = [
      `use std::io::*; fn f() { ${bare}(p, 9); }`,
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "    use crate::guard::{self, *};",
      "    use std::process::Command;",
      "    fn g() {",
      `        ${bare}(p, 9);`,
      "        super::kill(p, 9);",
      "        let k = r#kill;",
      "        child.kill().unwrap();",
      "        child . r#kill();",
      "        test_kill_process(p);",
      "        let _ = Signal::KILL;",
      "        unsafe { libc::kill(p, 9) };",
      "        // kill(p, 9) in a comment",
      `        let s = "${bare}";`,
      "        let killed = kill_switch.is_on();",
      "    }",
      "}",
    ].join("\n");
    const found = signalChokepointFailures(CHOKEPOINTS, guardOnly(source));
    expect(found.map((f) => f.split(": ")[0])).toEqual([
      "crates/bazhen-holder/src/guard.rs:15",
      "crates/bazhen-holder/src/guard.rs:4",
      "crates/bazhen-holder/src/guard.rs:5",
      "crates/bazhen-holder/src/guard.rs:8",
      "crates/bazhen-holder/src/guard.rs:9",
      "crates/bazhen-holder/src/guard.rs:10",
    ]);
    expect(found[0]).toMatch(/sends a signal directly \(libc::kill\)/);
    expect(found[1]).toMatch(/use super::\*.*name what it takes/);
    expect(found[3]).toMatch(/a bare `kill`.*bazhen_test_signal/);
  });

  it("fails a raw call imported or held as a value on a chokepoint's product lines, not one called by its path", () => {
    const source = [
      "use libc::kill as k;",
      "use nix::sys::signal as s;",
      "extern crate libc as l;",
      "pub use libc::kill;",
      "use rustix::process::kill_process;",
      "use rustix::process::{Pid, Signal};",
      "fn f() { rustix::process::kill_process_group(p, s); unsafe { libc::kill(p, 9) }; }",
      "const K: fn(Pid, Signal) -> io::Result<()> = rustix::process::kill_process;",
      "const N: c_long = libc::SYS_kill;",
      "fn g() { unsafe { f(libc::SYS_tkill) } }",
      "fn h() { unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd, 0, none, 0) }; }",
      "fn i() { rustix::process::kill_process_group::<P>(p, s); }",
      "pub use nix::sys::signal::Signal;",
    ].join("\n");
    const found = signalChokepointFailures(CHOKEPOINTS, guardOnly(source));
    expect(found.map((f) => f.split(": ")[0])).toEqual([
      "crates/bazhen-holder/src/guard.rs:1",
      "crates/bazhen-holder/src/guard.rs:2",
      "crates/bazhen-holder/src/guard.rs:3",
      "crates/bazhen-holder/src/guard.rs:4",
      "crates/bazhen-holder/src/guard.rs:5",
      "crates/bazhen-holder/src/guard.rs:8",
      "crates/bazhen-holder/src/guard.rs:9",
      "crates/bazhen-holder/src/guard.rs:10",
      "crates/bazhen-holder/src/guard.rs:13",
    ]);
    expect(found[0]).toMatch(/imports a raw signal \(libc::kill\).*by its path/);
    expect(found[5]).toMatch(/takes a raw signal as a value \(kill_process\)/);
    expect(found[8]).toMatch(
      /imports a raw signal \(pub use nix::sys::signal::Signal, which names a `signal` module and is a `pub use`\)/,
    );
  });

  it("names a chokepoint that no longer exists", () => {
    expect(signalChokepointFailures(CHOKEPOINTS.slice(1), () => "")).toEqual([
      "scripts/signal-paths.ts: SIGNAL_CHOKEPOINTS lists missing packages/host-guard/src/signal.ts.",
    ]);
  });
});

describe("cargoManifestFailures", () => {
  it("fails libc or nix taken under another name, in every table a manifest names them in", () => {
    const tree = {
      "Cargo.toml": [
        "[workspace.dependencies]",
        'lc = { version = "=0.2.191", package = "libc" }',
        'libc = { version = "=0.2.191" }',
      ].join("\n"),
      "crates/a/Cargo.toml": [
        "[package]",
        'name = "a"',
        "[dependencies]",
        'l = { package = "libc", workspace = true }',
        "\"q\" = { package = 'nix' }",
        "libc = { workspace = true }",
        'nix = { package = "nix" }',
        "[dependencies.n2]",
        'package = "nix"',
        "[dev-dependencies]",
        'n3.package = "libc"',
        "[target.'cfg(unix)'.dependencies]",
        'n4 = { package = "nix" }',
        "[target.'cfg(unix)'.dependencies.n5]",
        'package = "nix"',
        "[build-dependencies]",
        's = { package = "serde" }',
      ].join("\n"),
    };
    expect(
      manifestFailures(tree).map((f) => /^(\S+): renames (\w+) to `(\w+)`/.exec(f)?.slice(1)),
    ).toEqual([
      ["Cargo.toml", "libc", "lc"],
      ["crates/a/Cargo.toml", "libc", "l"],
      ["crates/a/Cargo.toml", "nix", "q"],
      ["crates/a/Cargo.toml", "nix", "n2"],
      ["crates/a/Cargo.toml", "libc", "n3"],
      ["crates/a/Cargo.toml", "nix", "n4"],
      ["crates/a/Cargo.toml", "nix", "n5"],
    ]);
  });
});

/** A file of runtime-holder's, by its name. */
const inCrate = (name: string) => `crates/bazhen-runtime-holder/src/${name}.rs`;
/** A test that closes `client` once `lets` has bound it. */
const closing = (lets: string) => `#[test]\nfn a() { ${lets} client.close().await; }`;

/** A test that closes a child between two copies of `form`. */
const around = (form: string) =>
  `#[test]\nfn a() { let _ = stringify!(${form}); child.close(group, now); let _ = stringify!(${form}); }`;

/** A hub whose `Shared::release` runs `release`, and a test that calls a release of its own. */
const releasing = (release: string) =>
  [
    "impl<R> Shared<R> {",
    `    fn release(&self) { ${release} }`,
    "}",
    "#[test]\nfn a() { h.rt.release(); }",
  ].join("\n");

/** The closers the signal scan passes over, each as a file names it and the `use` that names it. */
const CLOSERS = [
  { type: "Semaphore", use: "use tokio::sync::Semaphore;" },
  { type: "TaskTracker", use: "use tokio_util::task::TaskTracker;" },
];

/** The lines of the tests in `source`, one file, that must be marked. */
const flagged = (source: string) =>
  unmarkedSignallingTests(["crates/h/src/x.rs"], () => source).map(
    (f) => f.split(": ")[0]?.split(":")[1] ?? f,
  );

/** The lines to mark of a test that makes `client` as `type`, which `use` brings in, then runs
 * `body`; `bind!` is a macro that binds its argument as a holder's client. */
const rebinding = (type: string, use: string, body: string) =>
  flagged(
    `${use}\nmacro_rules! bind { ($n:ident) => { let $n = connect_holder(); }; }\n` +
      `#[test]\nfn a() { let client = ${type}::new(0); ${body} }`,
  );

const unmarked = (sources: Record<string, string>, holderCrates?: ReadonlySet<string>) =>
  unmarkedSignallingTests(Object.keys(sources), (f) => sources[f] ?? "", {}, holderCrates).map(
    (f) => f.split(": ")[0],
  );

/** One test, in crate `crate`, whose body is `call`. */
const testIn = (crate: string, call: string) => ({
  [`crates/${crate}/src/t.rs`]: `#[test]\nfn a() { ${call} }`,
});

describe("tests that signal processes they didn't start", () => {
  const MARK = '#[ignore = "signals processes; runs in make test-real ARGS=rust"]';
  const marked = `#[test]\n${MARK}\nfn m() {\n    bazhen_test_signal::require_sandbox().unwrap();\n}`;

  it("must be marked in a binary that runs the holder, in any of its files", () => {
    expect(
      unmarked({
        "crates/h/tests/binary/main.rs":
          'const BIN: &str = env!("CARGO_BIN_EXE_bazhen-holder");\n#[test]\nfn a() {}',
        "crates/h/tests/binary/socket.rs": `#[test]\nfn b() {}\n${marked}`,
        "crates/h/tests/other.rs": "#[test]\nfn c() {}",
      }),
    ).toEqual(["crates/h/tests/binary/main.rs:2", "crates/h/tests/binary/socket.rs:1"]);
  });

  it("must be marked when its body sweeps a session, ends one, retires one or respawns", () => {
    const bodies = [
      "leader.session().count();",
      "session.pass_among([pid], None);",
      "holder.retire(child);",
      "let e = Ending::start(session, now);",
      "let s = Session::led_by(pid);",
      "holder.respawn(pty, child, generation);",
      "signal_group(pid, Signal::CONT);",
    ];
    const source = bodies.map((body, i) => `#[test]\nfn t${String(i)}() { ${body} }`).join("\n");
    expect(unmarked({ "crates/h/src/session.rs": source })).toEqual(
      bodies.slice(0, -1).map((_, i) => `crates/h/src/session.rs:${String(2 * i + 1)}`),
    );
  });

  it("names the holder's Session only in a crate that can reach the holder", () => {
    const sources = {
      ...testIn("holder", "let s = Session::led_by(pid);"),
      ...testIn("leader", "leader.session().count();"),
      ...testIn("harness", 'assert_eq!(k, Key::Session(s)); codex.session().expect("one");'),
      ...testIn("core", "child.close();"),
    };
    expect(unmarked(sources, new Set(["crates/holder", "crates/leader"]))).toEqual([
      "crates/holder/src/t.rs:1",
      "crates/leader/src/t.rs:1",
      "crates/core/src/t.rs:1",
    ]);
  });

  it("takes a Session that a type names, as an enum's variant, for none of the holder's", () => {
    const bodies = [
      "assert_eq!(k, Key::Session(s));",
      "let k = harness :: Key :: Session(s);",
      "let s = session::Session::led_by(pid);",
      "let s = bazhen_holder::Session::led_by(pid);",
    ];
    const source = bodies.map((body, i) => `#[test]\nfn t${String(i)}() { ${body} }`).join("\n");
    expect(unmarked({ "crates/h/src/t.rs": source })).toEqual([
      "crates/h/src/t.rs:5",
      "crates/h/src/t.rs:7",
    ]);
  });

  it("finds the crates that reach the holder through any dependency, however deep", () => {
    const reaching = holderReachingCrates(
      meta(
        pkg("bazhen-holder", []),
        pkg("tested", [], [dep("bazhen-holder", "dev")]),
        pkg("deep", [], [dep("tested")]),
        pkg("apart", [], [dep("serde")]),
      ),
    );
    expect(reaching).toEqual(new Set(["crates/bazhen-holder", "crates/deep", "crates/tested"]));
  });

  it("can't tell the crates that reach the holder when the holder isn't under the root", () => {
    const rootless = { ...meta(pkg("bazhen-holder", [])), workspace_root: "/elsewhere" };
    expect(holderReachingCrates(rootless)).toMatch(
      /names no bazhen-holder at crates\/bazhen-holder/,
    );
  });

  it("must be marked when an ending is given a real session, and needn't when given a stand-in", () => {
    const source = [
      "#[test]\nfn a() { let e = Ending::new(Session(pid), now); }",
      "#[test]\nfn b() { let e = Ending::new(Session::led_by(pid).unwrap(), now); }",
      "#[test]\nfn c() { let e = Ending::new(Scripted::default(), now); e.step(true, now); }",
      "#[test]\nfn d() { let e = Ending::new(Session { 0: pid }, now); }",
      "#[test]\nfn e() { let e = Ending::new(pid.map(Session).unwrap(), now); }",
      "#[test]\nfn f() { let e = Ending::<Session>::new(made(), now); }",
    ].join("\n");
    expect(unmarked({ "crates/h/src/session.rs": source })).toEqual(
      [1, 3, 7, 9, 11].map((line) => `crates/h/src/session.rs:${String(line)}`),
    );
  });

  it("must be marked when a test's helper, however deep, or a const it names makes a real session", () => {
    const source = [
      "fn step(&mut self) { self.pass(); }",
      "fn pass(&mut self) -> Sweep { self.sweeper.sweep(None) }",
      "#[cfg(test)]",
      "mod tests {",
      "fn leader(pid: Pid) -> Pid { session_of(pid) }",
      "fn session_of(pid: Pid) -> Pid { inner(pid) }",
      "fn inner(pid: Pid) -> Pid { Session::led_by(pid).unwrap().0 }",
      "const LEADER: Session = Session(PID);",
      "#[test]\nfn a() { let e = Ending::new(leader(pid), now); }",
      "#[test]\nfn b() { let e = Ending::new(LEADER, now); }",
      "#[test]\nfn c() { let mut e = Ending::new(Scripted::default(), now); e.step(); }",
      "}",
    ].join("\n");
    expect(unmarked({ "crates/h/src/session.rs": source })).toEqual([
      "crates/h/src/session.rs:9",
      "crates/h/src/session.rs:11",
    ]);
  });

  it("must be marked anywhere when its own body closes a child or sweeps the ledger", () => {
    const source = [
      "#[test]\nfn a() { running.child.close(group, now); }",
      "#[test]\nfn b() { child.close_step(group, now); }",
      "#[test]\nfn c() { sweep().unwrap(); }",
      "#[test]\nfn d() { let x = 1; }",
      marked.replace("fn m() {", "fn e() {\n    child.close(group, now);"),
    ].join("\n");
    expect(unmarked({ "crates/h/src/child.rs": source })).toEqual([
      "crates/h/src/child.rs:1",
      "crates/h/src/child.rs:3",
      "crates/h/src/child.rs:5",
    ]);
  });

  it("must be marked when an astral char literal comes before its close", () => {
    const source = [
      "#[test]\nfn a() { let _ = vec!{'😀','\"', child.close(group, now), '\"'}; }",
      "#[test]\nfn b() { let _ = vec!{'é','\"', child.close(group, now), '\"'}; }",
    ].join("\n");
    expect(unmarked({ "crates/h/src/child.rs": source })).toEqual([
      "crates/h/src/child.rs:1",
      "crates/h/src/child.rs:3",
    ]);
  });

  it("needn't be marked for a task tracker's own close(), and must be for any other call", () => {
    // A tracker's close(), with nothing in its parentheses, only stops it taking tasks. Any other
    // call on it, a close of what isn't one, or of one the file never types, still counts.
    const source = [
      "use tokio_util::task::TaskTracker;",
      "struct Pool { tracker: TaskTracker }",
      "impl Pool { fn end(&self) { self.tracker\n.close( ); } }",
      "fn drained(tracker: &TaskTracker) { tracker.close(); }",
      "async fn serving() -> (u16, TaskTracker) { (0, TaskTracker::new()) }",
      "#[test]\nfn a() { drained(&tracker); pool.end(); }",
      "#[test]\nfn b() { let t = TaskTracker::new();\n t.close(); }",
      "#[test]\nfn c() { let (stop, t) = (Token::new(), TaskTracker::new());\n t.close(); }",
      "#[test]\nfn d() { let (_, t) = serving().await;\n t.close(); }",
      "#[test]\nfn e() { let t = TaskTracker::new(); t.close(now); }",
      "#[test]\nfn f() { let t = TaskTracker::new(); t.signal(9); }",
      "#[test]\nfn g() { let t = TaskTracker::new(); t.respawn(x); }",
      "#[test]\nfn h() { let t = TaskTracker::new(); t.close_step(); }",
      "#[test]\nfn i() { holder.tracker.close(); }",
      "#[test]\nfn j() { child.close(); }",
    ].join("\n");
    const untyped = "#[test]\nfn a() { tracker.close(); }";
    expect(unmarked({ "crates/h/src/serve.rs": source, "crates/h/src/x.rs": untyped })).toEqual([
      "crates/h/src/serve.rs:18",
      "crates/h/src/serve.rs:20",
      "crates/h/src/serve.rs:22",
      "crates/h/src/serve.rs:24",
      "crates/h/src/serve.rs:26",
      "crates/h/src/serve.rs:28",
      "crates/h/src/x.rs:1",
    ]);
  });

  it("needn't be marked for a close of a field that is surely one, on a binding of a struct", () => {
    for (const { type, use } of CLOSERS) {
      const source = [
        use,
        `struct Rig { tasks: ${type}, child: Child }`,
        "struct Other { tasks: Child }",
        "fn rig() -> Rig { todo!() }",
        "#[test]\nfn a() { let rig = rig(); rig.tasks.close(); }",
        "#[test]\nfn b(r: &Rig) { r.tasks.close(); }",
        "#[test]\nfn c() { let rig = other(); rig.tasks.close(); }",
        "#[test]\nfn d() { let rig = rig(); rig.child.close(); }",
        "#[test]\nfn e(rig: &Other) { rig.tasks.close(); }",
        "#[test]\nfn f() { let rig = rig(); let rig = other(); rig.tasks.close(); }",
        "#[test]\nfn g() { let rig = rig(); rig.tasks.close(now); }",
      ].join("\n");
      expect(flagged(source)).toEqual(["9", "11", "13", "15", "17"]);
    }
  });

  it("needn't be marked for a semaphore's own close(), and must be for any other call", () => {
    // A semaphore's close(), with nothing in its parentheses, only refuses more permits. Any other
    // call on it, or a close of one the file never types, still counts.
    const source = [
      "use tokio::sync::{Semaphore, mpsc};",
      "struct Slow { gate: Arc<Semaphore> }",
      "impl Slow { fn disconnect(&self) { self.gate.close(); } }",
      "fn shut(gate: &Arc<tokio::sync::Semaphore>) { gate.close(); }",
      "#[test]\nfn a() { shut(&gate); slow.disconnect(); }",
      "#[test]\nfn b() { let g = Arc::new(Semaphore::new(0));\n g.close(); }",
      "#[test]\nfn c() { let g = ::tokio::sync::Semaphore::new(1);\n g.close(); }",
      "#[test]\nfn d() { let g = Semaphore::new(1); g.close(now); }",
      "#[test]\nfn e() { let g = Semaphore::new(1); g.close_step(); }",
      "#[test]\nfn f() { child.close(); }",
    ].join("\n");
    const untyped = "#[test]\nfn a() { gate.close(); }";
    expect(unmarked({ "crates/h/src/hub.rs": source, "crates/h/src/x.rs": untyped })).toEqual([
      "crates/h/src/hub.rs:13",
      "crates/h/src/hub.rs:15",
      "crates/h/src/hub.rs:17",
      "crates/h/src/x.rs:1",
    ]);
  });

  describe("a close of what the scan can't be sure is a semaphore or a task tracker", () => {
    // Each case is run for both types, and beside it the nearest case that is surely one, so
    // what makes it count is the one difference between them.
    it("must be marked when the file never brings the type in from tokio", () => {
      for (const { type, use } of CLOSERS) {
        const source = `fn f(holder: Arc<${type}>) { holder.close(); }\n#[test]\nfn a() { f(h); }`;
        expect([flagged(source), flagged(`${use}\n${source}`)]).toEqual([["2"], []]);
      }
    });

    it("must be marked when only a struct literal's field of that name is made as one", () => {
      for (const { type, use } of CLOSERS) {
        const made = (binding: string) =>
          flagged(`${use}\n#[test]\nfn a() { ${binding};\n child.close(); }`);
        expect([
          made(`let x = X { child: ${type}::new(0) }`),
          made(`let child = ${type}::new(0)`),
        ]).toEqual([["2"], []]);
      }
    });

    it("must be marked when a type of that name may come from elsewhere", () => {
      for (const { type, use } of CLOSERS) {
        const source = `fn f(gate: ${type}) { gate.close(); }\n#[test]\nfn a() { f(g); }`;
        expect(
          [
            `use crate::holder::${type};`,
            `${use}\nuse crate::holder::*;`,
            `${use}\nuse crate::holder::{Other as ${type}};`,
            `${use}\nstruct ${type};`,
            `${use}\nuse super::*;`,
          ].map((head) => flagged(`${head}\n${source}`)),
        ).toEqual([["3"], ["4"], ["4"], ["4"], []]);
      }
    });

    it("must be marked when its field is one only on a type other than its impl's", () => {
      for (const { type, use } of CLOSERS) {
        const source = (impl: string) =>
          flagged(
            `${use}\nstruct A { holder: ${type} }\nstruct B { holder: Client }\n` +
              `impl ${impl} { fn end(&self) { self.holder.close(); } }\n#[test]\nfn a() { b.end(); }`,
          );
        expect([source("B"), source("C"), source("A")]).toEqual([["5"], ["5"], []]);
      }
    });

    it("must be marked when a closure's parameter binds its name again after another pipe", () => {
      for (const { type, use } of CLOSERS) {
        expect(
          [
            "let f = || go(); g(|client| client.close());",
            "let n = a | b; let f = |client| client.close();",
            "let f = |x| x; let n = a | b; g(|client| client.close());",
            "let f = || go(); let n = a | b; g(|other| client.close());",
          ].map((body) => rebinding(type, use, body)),
        ).toEqual([["3"], ["3"], ["3"], []]);
      }
    });

    it("must be marked when a struct pattern binds its name again", () => {
      for (const { type, use } of CLOSERS) {
        expect(
          [
            "let Conn { client, .. } = conn(); client.close();",
            "for Conn { client } in conns { client.close(); }",
            "let Conn { other, .. } = conn(); client.close();",
          ].map((body) => rebinding(type, use, body)),
        ).toEqual([["3"], ["3"], []]);
      }
    });

    it("must be marked when a struct pattern's field binds its name again", () => {
      for (const { type, use } of CLOSERS) {
        expect(
          [
            "let Conn { holder: client } = conn(); client.close();",
            "let Conn { holder: other } = conn(); client.close();",
          ].map((body) => rebinding(type, use, body)),
        ).toEqual([["3"], []]);
      }
    });

    it("must be marked when an if let's struct pattern binds its name again", () => {
      for (const { type, use } of CLOSERS) {
        expect(
          [
            "if let Conn { client } = conn() { client.close(); }",
            "if let Conn { other } = conn() { client.close(); }",
          ].map((body) => rebinding(type, use, body)),
        ).toEqual([["3"], []]);
      }
    });

    it("must be marked when a macro's argument may bind its name again", () => {
      for (const { type, use } of CLOSERS) {
        expect(
          ["bind!(client); client.close();", "bind!(other); client.close();"].map((body) =>
            rebinding(type, use, body),
          ),
        ).toEqual([["3"], []]);
      }
    });

    it("must be marked when its name is bound more than once in its function", () => {
      for (const { type, use } of CLOSERS) {
        const source = (body: string) =>
          flagged(`${use}\n#[test]\nfn a() { let holder = ${type}::new(); ${body} }`);
        expect(
          [
            "let holder = spawn_holder(); holder.close();",
            "run(|holder| holder.close());",
            "for holder in holders { holder.close(); }",
            "match x { Some(holder) => holder.close(), None => {} }",
            "holder.close();",
          ].map(source),
        ).toEqual([["2"], ["2"], ["2"], ["2"], []]);
      }
    });
  });

  describe("closes listed as signalling nothing", () => {
    const LISTED = {
      "crates/h/src/hub.rs::Shared::release": "hangs up a stream's connections; signals nothing",
    };
    const listed = (sources: Record<string, string>, closes: Record<string, string> = LISTED) =>
      unmarkedSignallingTests(Object.keys(sources), (f) => sources[f] ?? "", closes);

    it("needn't be marked for a stream's close() in the listed function", () => {
      expect(listed({ "crates/h/src/hub.rs": releasing("found.watched.stream.close();") })).toEqual(
        [],
      );
    });

    it("must be marked for any other signalling call in the listed function", () => {
      for (const release of [
        "found.watched.stream.close(); child.signal(9);",
        "found.watched.stream.close(); child.close();",
      ]) {
        expect(
          listed({ "crates/h/src/hub.rs": releasing(release) }).map((f) => f.split(": ")[0]),
        ).toEqual(["crates/h/src/hub.rs:4"]);
      }
      // A close given something isn't passed over, so the entry passes over nothing.
      expect(
        listed({ "crates/h/src/hub.rs": releasing("found.watched.stream.close(now);") }).map(
          (f) => f.split(": ")[0],
        ),
      ).toEqual(["crates/h/src/hub.rs:4", "scripts/check-standards.ts"]);
    });

    it("passes over a stream's close() in the listed function alone, not in one beside it", () => {
      const source = [
        "impl<R> Shared<R> {",
        "    fn release(&self) { found.watched.stream.close(); }",
        "    fn release_all(&self) { found.watched.stream.close(); }",
        "}",
        "#[test]\nfn a() { h.release(); }",
        "#[test]\nfn b() { h.release_all(); }",
      ].join("\n");
      expect(listed({ "crates/h/src/hub.rs": source }).map((f) => f.split(": ")[0])).toEqual([
        "crates/h/src/hub.rs:7",
      ]);
    });

    it("refuses an entry whose function is gone, closes no stream, or gives no reason", () => {
      expect(
        listed(
          { "crates/h/src/hub.rs": releasing("found.timer.abort();") },
          {
            ...LISTED,
            "crates/h/src/hub.rs::Shared::gone": "signals nothing",
            "crates/h/src/other.rs::Shared::release": "signals nothing",
          },
        ),
      ).toEqual([
        "scripts/check-standards.ts: crates/h/src/hub.rs::Shared::release is in NON_SIGNALLING_CLOSES, but closes no stream.",
        "scripts/check-standards.ts: crates/h/src/hub.rs::Shared::gone is in NON_SIGNALLING_CLOSES, but no such function exists.",
        "scripts/check-standards.ts: crates/h/src/other.rs::Shared::release is in NON_SIGNALLING_CLOSES, but no such function exists.",
      ]);
      expect(
        listed(
          { "crates/h/src/hub.rs": releasing("found.watched.stream.close();") },
          { "crates/h/src/hub.rs::Shared::release": " " },
        ),
      ).toEqual([
        "scripts/check-standards.ts: crates/h/src/hub.rs::Shared::release is in NON_SIGNALLING_CLOSES with no reason it signals nothing.",
      ]);
    });
  });

  it("must be marked when a lifetime or a literal's suffix named r comes before its close", () => {
    const forms = [
      String.raw`'r"\" "`,
      String.raw`'a'r"\" "`,
      String.raw`"a"r"\" "`,
      String.raw`'ér"\" "`,
    ];
    const sources = Object.fromEntries(
      forms.map((form, n) => [`crates/h/src/t${n}.rs`, around(form)]),
    );
    expect(unmarked(sources)).toEqual(Object.keys(sources).map((file) => `${file}:1`));
  });

  it("must be marked when a shebang line rustc drops opens a string before its close", () => {
    const test = '#!/** x */[] "\n#[test]\nfn a() { child.close(group, now); }\n// "\n';
    const sources = { "crates/h/src/t0.rs": test, "crates/h/src/t1.rs": `\ufeff${test}` };
    expect(unmarked(sources)).toEqual(Object.keys(sources).map((file) => `${file}:2`));
  });

  it("must be marked for requests on a fake holder's client, as on any other", () => {
    // Source text can't show the client reaches only the fake: a trait method taking `self` by
    // value can stand in for `close`, and a path in a string attribute can reach past the fake.
    const fake = [
      "pub(crate) struct FakeHolder { stream: UnixStream }",
      "impl FakeHolder {",
      "    pub(crate) async fn client() -> Connected {",
      "        let (near, far) = UnixStream::pair().unwrap();",
      "        open(near, &ClientOptions::default()).await",
      "    }",
      "}",
    ].join("\n");
    const fakeLet = "let Connected { client, .. } = FakeHolder::client().await;";
    const source = [
      "use crate::fake_holder::{Connected, FakeHolder};",
      closing(fakeLet),
      `#[test]\nfn b() { ${fakeLet} client.signal(Signal::Sigint).await; }`,
      `#[test]\nfn c() { ${fakeLet} client.respawn(spec).await; }`,
    ].join("\n");
    expect(unmarked({ [inCrate("fake_holder")]: fake, [inCrate("client")]: source })).toEqual(
      [2, 4, 6].map((line) => `${inCrate("client")}:${line}`),
    );
  });

  it("must be marked when it calls a same-file helper that closes or sweeps", () => {
    const source = [
      "fn end(r: &mut Running) { r.child.close(group, now); }",
      "#[test]\nfn a() { end(&mut running); }",
      "#[test]\nfn b() { let x = 1; }",
    ].join("\n");
    expect(unmarked({ "crates/h/tests/x.rs": source })).toEqual(["crates/h/tests/x.rs:2"]);
  });

  it("must be marked inside a macro that generates tests that close or sweep", () => {
    const source = [
      "macro_rules! closes {",
      "    ($name:ident, $body:expr) => {",
      "        #[test]",
      "        fn $name() { $body; }",
      "    };",
      "}",
      "closes!(a, running.child.close(group, now));",
    ].join("\n");
    expect(unmarked({ "crates/h/tests/x.rs": source })).toEqual(["crates/h/tests/x.rs:3"]);
  });

  it("must be marked when it names a type whose Drop closes, or signals a child itself", () => {
    const source = [
      "struct Failing;",
      "impl Drop for Failing {\n    fn drop(&mut self) { self.holder.close(now); }\n}",
      "#[test]\nfn a() { let f = Failing::start(); }",
      "#[test]\nfn b() { child.signal(Sigint).unwrap(); }",
      "#[test]\nfn c() { let x = 1; }",
    ].join("\n");
    expect(unmarked({ "crates/h/src/server.rs": source })).toEqual([
      "crates/h/src/server.rs:5",
      "crates/h/src/server.rs:7",
    ]);
  });

  it("must be marked when it names a type whose Drop only calls a helper that closes", () => {
    const source = [
      "struct Guard;",
      "fn end(h: &mut Holder) { h.close(now); }",
      "impl Drop for Guard {\n    fn drop(&mut self) { end(&mut self.holder); }\n}",
      "#[test]\nfn a() { let g = Guard; }",
    ].join("\n");
    expect(unmarked({ "crates/h/src/server.rs": source })).toEqual(["crates/h/src/server.rs:6"]);
  });

  it("doesn't take a bodyless function for one with the next function's body", () => {
    const source = [
      "trait Tidy { fn tidy(&self); }",
      "fn other() { x.close(now); }",
      "#[test]\nfn a() { t.tidy(); }",
    ].join("\n");
    expect(unmarked({ "crates/h/tests/x.rs": source })).toEqual([]);
  });

  it("isn't marked by another ignore, or by the reason in a string", () => {
    const source = [
      '#[test]\n#[ignore = "slow"]\nfn a() { sweep(); }',
      `#[test]\nfn b() { let s = "${MARK.replaceAll('"', '\\"')}"; sweep(); }`,
    ].join("\n");
    expect(unmarked({ "crates/h/tests/x.rs": source })).toEqual([
      "crates/h/tests/x.rs:1",
      "crates/h/tests/x.rs:4",
    ]);
  });
});

const pins = (path: string, source: string) => tmuxPinFailures(path, source).length;

describe("tmuxPinFailures", () => {
  it("lets a *.tmux.test.ts pick tmux, and any api test pick holders", () => {
    expect([
      pins("tests/api/x.tmux.test.ts", 'Daemon.start({ runtime: "tmux" }); d.useRuntime("tmux");'),
      pins("tests/api/x.test.ts", 'Daemon.start({ runtime: "holder" }); d.useRuntime("holder");'),
      pins("tests/api/x.test.ts", 'Daemon.startWithCli("", {}, "holder"); Daemon.start();'),
      pins("tests/api/x.test.ts", '// runtime: "tmux" in a comment\nDaemon.start();'),
      pins("tests/api/daemon.ts", '`[runtime]\\ndefault = "${runtime}"`; useRuntime(runtime);'),
      pins("tests/integration/x.test.ts", 'start({ runtime: "tmux" });'),
    ]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("refuses tmux picked in a runtime-neutral api test, however it is picked", () => {
    expect([
      pins("tests/api/keys.test.ts", 'daemon = await Daemon.start({ runtime: "tmux" });'),
      pins("tests/api/x.test.ts", 'await Daemon.startWithCli(\n  "",\n  {},\n  "tmux",\n);'),
      pins("tests/api/x.test.ts", 'daemon.useRuntime("tmux");'),
      pins("tests/api/x.test.ts", "Daemon.start({ modelUrl, runtime: kind });"),
      pins("tests/api/x.test.ts", "const runtime = pick(); Daemon.start({ env, runtime });"),
      pins("tests/api/x.test.ts", "Daemon.startWithCli(config, env, kind);"),
      pins("tests/api/x.test.ts", 'Daemon.startWithCli("[runtime]\\ndefault = \\"tmux\\"", {});'),
    ]).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("names the file and where the case belongs", () => {
    expect(tmuxPinFailures("tests/api/k.test.ts", 'Daemon.start({ runtime: "tmux" });')).toEqual([
      expect.stringMatching(
        /^tests\/api\/k\.test\.ts: picks its runtime with "tmux".*\.tmux\.test\.ts/,
      ),
    ]);
  });
});

const line = (directive: string) => `const a = 1;\n// ${directive}\nconst b = 2;\n`;
const block = (directive: string) => `const a = 1;\n/* ${directive} */\nconst b = 2;\n`;
const inDoc = (directive: string) => `/**\n * Why.\n * ${directive}\n */\nconst b = 2;\n`;
const at = (opener: string, rest: string) => `${opener}${rest}\n`;

describe("suppressionFailures", () => {
  const directives = [
    "oxlint-disable",
    "oxlint-disable-next-line bazhen/stdio-guard",
    "oxlint-disable-line no-console",
    "oxlint-enable",
    "eslint-disable",
    "eslint-disable-next-line no-console",
    "eslint-enable",
    "@ts-ignore",
    "@ts-expect-error",
    "@ts-nocheck",
    "biome-ignore lint: reason",
    "oxfmt-ignore",
    "prettier-ignore",
    "@TS-NOCHECK",
    "ESLint-Disable",
    "biome-ignore-all lint: reason",
    "biome-ignore-start lint",
  ];

  it.each(directives)("flags %s in a line comment, a block comment and a doc comment", (d) => {
    expect(suppressionFailures("a.ts", line(d))).toHaveLength(1);
    expect(suppressionFailures("a.ts", block(d))).toHaveLength(1);
    expect(suppressionFailures("a.ts", inDoc(d))).toHaveLength(1);
  });

  it("names the file and the line, and says to fix the code", () => {
    const [failure] = suppressionFailures("packages/core/src/a.ts", line("oxlint-disable-line x"));
    expect(failure).toContain("packages/core/src/a.ts:2");
    expect(failure).toContain("Fix the code");
  });

  it("flags a directive after the comment marker's own spacing or slashes", () => {
    expect(suppressionFailures("a.ts", at("//", "eslint-disable-line x"))).toHaveLength(1);
    expect(suppressionFailures("a.ts", at("///   ", "@ts-ignore"))).toHaveLength(1);
    expect(suppressionFailures("a.ts", at("foo(); //", " eslint-disable-line x"))).toHaveLength(1);
    expect(suppressionFailures("a.ts", at("/*", "eslint-disable*/ foo();"))).toHaveLength(1);
  });

  it("flags a directive on a later line of a block comment, with or without a leading star", () => {
    const shapes = [
      "/*\n  eslint-disable\n*/",
      "/*\n\toxlint-disable\n*/",
      "/*\noxlint-disable-next-line */",
      "/*\n  @ts-ignore */",
      "/* why\n   @ts-expect-error */",
      "/**\n * Why.\n *\n * @ts-ignore\n */",
    ];
    for (const shape of shapes) {
      expect(suppressionFailures("a.ts", `${shape}\nconst b = 2;\n`)).toHaveLength(1);
    }
    expect(suppressionFailures("a.ts", `a;\n/*\n\n  eslint-disable\n*/\n`)).toEqual([
      expect.stringContaining("a.ts:4"),
    ]);
  });

  it("flags a directive a string's slashes would hide from a reader of syntax", () => {
    const hidden = at("const u = 'http://x'; /* ", "oxlint-disable */");
    expect(suppressionFailures("a.ts", hidden)).toHaveLength(1);
    expect(suppressionFailures("a.ts", at("const r = /'/; //", " @ts-ignore"))).toHaveLength(1);
  });

  it("flags a directive in an html comment, on its line or a later one", () => {
    const d = "prettier-ignore";
    for (const shape of [
      `<!-- ${d} -->`,
      `<!--${d}-->`,
      `<!--\n  ${d}\n-->`,
      `a;\n--> ${d}`,
      `a;\n  -->${d}`,
      `a;\n/* a */ --> ${d}`,
      `a;\n/*\n*/ --> ${d}`,
      `a;\n\u00a0\v--> ${d}`,
    ]) {
      expect(suppressionFailures("a.cjs", `${shape}\nconst b = 2;\n`)).toHaveLength(1);
    }
  });

  it("flags a directive on a line that ends with a carriage return or a unicode separator", () => {
    const d = "oxlint-disable";
    for (const end of ["\r", "\r\n", "\u2028", "\u2029"]) {
      expect(suppressionFailures("a.ts", `/* why${end}${d} */`)).toHaveLength(1);
      expect(suppressionFailures("a.ts", `// why${end}// ${d}`)).toHaveLength(1);
      expect(suppressionFailures("a.ts", `a;${end}b;${end}/* ${end}${d} */`)).toEqual([
        expect.stringContaining("a.ts:4"),
      ]);
    }
  });

  it("flags every directive, one failure each", () => {
    const source = `${line("@ts-ignore")}${line("oxlint-disable")}`;
    expect(suppressionFailures("a.ts", source)).toHaveLength(2);
  });

  it("flags a directive in an inline script of an html page", () => {
    const page = `<script>\n  ${line("@ts-ignore")}</script>\n`;
    expect(suppressionFailures("apps/web/index.html", page)).toHaveLength(1);
  });

  it("Control: leaves code and prose that only mention suppressions alone", () => {
    expect(suppressionFailures("a.ts", "const a = 1;\n")).toEqual([]);
    expect(suppressionFailures("a.ts", "// Never disable a lint rule here.\n")).toEqual([]);
    expect(suppressionFailures("a.ts", "// The ignore list names the rule.\n")).toEqual([]);
    expect(
      suppressionFailures("a.ts", "// A directive such as oxlint-disable is banned.\n"),
    ).toEqual([]);
    expect(suppressionFailures("a.ts", "const w = a * b;\n")).toEqual([]);
    expect(suppressionFailures("a.ts", "const u = 'http://example.com/a';\n")).toEqual([]);
    expect(suppressionFailures("a.ts", "/* Why\n   the rule is on. */\n")).toEqual([]);
    expect(suppressionFailures("a.html", "<!-- Why -->\n<p>a --> b</p>\n")).toEqual([]);
    expect(suppressionFailures("a.ts", "while (n --> 0) f(n);\n")).toEqual([]);
    expect(suppressionFailures("a.ts", "// Why\r\n// the rule is on.\r\n")).toEqual([]);
  });
});

const harnessNames = (
  sources: Record<string, string>,
  named: Record<string, { names: string[]; why: string }> = {},
) =>
  harnessNameFailures(Object.keys(sources), (p) => sources[p] ?? "", FREE, VOCABULARY, named).map(
    (f) => (f.includes(": names a harness") ? f.slice(0, f.indexOf(". Code outside")) : f),
  );

const FREE = { "bazhen-protocol": "the wire" };
const VOCABULARY = {
  ClaudeCode: { free: false, why: "w" },
  Codex: { free: false, why: "w" },
  CodexThread: { free: false, why: "w" },
  QueuedInCodex: { free: true, why: "w" },
  codex: { free: false, why: "w" },
};
const PROTOCOL = {
  "crates/bazhen-protocol/src/lib.rs": [
    "pub enum HarnessId { ClaudeCode, Codex }",
    'impl HarnessId { fn as_str(self) -> &str { match self { Self::Codex => "codex" } } }',
    "pub enum MailboxState { QueuedInCodex }",
    'pub enum ExternalRefKind { #[serde(rename = "codex-thread")] CodexThread }',
    "pub struct DaemonDoctor { pub codex: Option<u8> }",
    "",
  ].join("\n"),
};

const compiledIn = (sources: Record<string, string>) =>
  compiledFailures(Object.keys(sources), (p) => sources[p] ?? "");
const compiledRefused = (where: string) =>
  `${where}: the daemon serves the harnesses bazhen_harness::production gives it; compiled ` +
  "holds adapters it doesn't serve yet, so only its tests may call it.";

describe("compiledFailures", () => {
  it("refuses the daemon's product code reaching compiled by a path, a use or a glob", () => {
    expect(
      compiledIn({
        "crates/bazhen-daemon/src/a.rs":
          "fn a(d: HarnessDeps) {\n  bazhen_harness::compiled(d);\n}\n",
        "crates/bazhen-daemon/src/b.rs": "use bazhen_harness::compiled;\n",
        "crates/bazhen-daemon/src/c.rs":
          "use bazhen_harness::{\n  production,\n  compiled as all,\n};\n",
        "crates/bazhen-daemon/src/e.rs":
          "use bazhen_harness::*;\nfn e(d: HarnessDeps) {\n  compiled (d);\n}\n",
      }),
    ).toEqual([
      compiledRefused("crates/bazhen-daemon/src/a.rs:2"),
      compiledRefused("crates/bazhen-daemon/src/b.rs:1"),
      compiledRefused("crates/bazhen-daemon/src/c.rs:1"),
      compiledRefused("crates/bazhen-daemon/src/e.rs:3"),
    ]);
  });

  it("lets the daemon's tests, other crates and other names called compiled be", () => {
    expect(
      compiledIn({
        "crates/bazhen-daemon/src/lib.rs":
          "#[cfg(test)]\nmod tests;\n#[cfg(test)]\nmod t {\n  use bazhen_harness::compiled;\n}\n",
        "crates/bazhen-daemon/src/tests.rs": "use bazhen_harness::compiled;\n",
        "crates/bazhen-daemon/tests/api.rs": "use bazhen_harness::compiled;\n",
        "crates/bazhen-cli/src/x.rs": "use bazhen_harness::compiled;\n",
        "crates/bazhen-daemon/src/d.rs":
          '// bazhen_harness::compiled\nconst S: &str = "bazhen_harness::compiled";\nuse bazhen_harness::production;\nfn compiled() {}\nuse regex::compiled;\n',
        "crates/bazhen-daemon/src/f.rs":
          "use bazhen_harness::*;\nfn compiled() {}\nfn f(r: R) {\n  r.compiled();\n  regex::compiled(1);\n}\n",
        "crates/bazhen-daemon/src/g.rs": "use other::*;\nfn g() {\n  compiled();\n}\n",
      }),
    ).toEqual([]);
  });
});

describe("harnessNameFailures", () => {
  const daemon = "crates/bazhen-daemon/src/route.rs";

  it("refuses a harness named by a path, an identifier or a string, in any crate not freed", () => {
    expect(
      harnessNames({
        ...PROTOCOL,
        [daemon]: "fn a(h: HarnessId) -> bool {\n  h == HarnessId::Codex\n}\n",
        "crates/bazhen-store/src/q.rs": "const Q: &str = \"WHERE harness = 'claude-code'\";\n",
        "crates/bazhen-core/src/m.rs": "fn as_codex() {}\n",
        "crates/bazhen-new/src/lib.rs": "use bazhen_protocol::HarnessId::ClaudeCode;\n",
        "crates/bazhen/src/attach.rs": "fn label() { HarnessId::ClaudeCode; }\n",
        "crates/bazhen-holder/src/b.rs":
          'const B: &[u8] = b"codex";\nconst R: &str = r#"a "claude" b"#;\nconst C: &[u8] = br"Codex-x";\n',
      }),
    ).toEqual([
      "crates/bazhen-daemon/src/route.rs:2: names a harness (`Codex`)",
      'crates/bazhen-store/src/q.rs:1: names a harness (`"claude-code"`)',
      "crates/bazhen-core/src/m.rs:1: names a harness (`as_codex`)",
      "crates/bazhen-new/src/lib.rs:1: names a harness (`ClaudeCode`)",
      "crates/bazhen/src/attach.rs:1: names a harness (`ClaudeCode`)",
      'crates/bazhen-holder/src/b.rs:1: names a harness (`"codex"`)',
      'crates/bazhen-holder/src/b.rs:2: names a harness (`"claude"`)',
      'crates/bazhen-holder/src/b.rs:3: names a harness (`"Codex-x"`)',
    ]);
  });

  it("frees only a free vocabulary identifier, never a bound one, a string or a field name", () => {
    expect(
      harnessNames({
        ...PROTOCOL,
        [daemon]: [
          "fn a() -> bool { s == MailboxState::QueuedInCodex }",
          'fn b() -> bool { h == "codex" }',
          "mod codex;",
          "fn c() -> bool { k == ExternalRefKind::CodexThread }",
          'fn d() -> &str { "QueuedInCodex" }',
          "",
        ].join("\n"),
        "crates/bazhen-store/src/sql.rs":
          "const Q: &str = \"SELECT id WHERE harness = 'codex'\";\n",
      }),
    ).toEqual([
      'crates/bazhen-daemon/src/route.rs:2: names a harness (`"codex"`)',
      "crates/bazhen-daemon/src/route.rs:3: names a harness (`codex`)",
      "crates/bazhen-daemon/src/route.rs:4: names a harness (`CodexThread`)",
      'crates/bazhen-daemon/src/route.rs:5: names a harness (`"QueuedInCodex"`)',
      'crates/bazhen-store/src/sql.rs:1: names a harness (`"codex"`)',
    ]);
  });

  it("holds HARNESS_VOCABULARY to the protocol's identifiers both ways, its strings aside", () => {
    expect(
      harnessNameFailures(
        ["crates/bazhen-protocol/src/lib.rs"],
        () => 'pub enum A { CodexNew, Codex }\nconst S: &str = "claude-only";\n',
        FREE,
        { Codex: { free: false, why: "w" }, ClaudeGone: { free: true, why: "w" } },
        {},
      ),
    ).toEqual([
      "scripts/check-standards.ts: bazhen-protocol names CodexNew, which HARNESS_VOCABULARY " +
        "doesn't list. List it, free only if harness-blind code may name it, with why.",
      "scripts/check-standards.ts: HARNESS_VOCABULARY lists ClaudeGone, which bazhen-protocol's " +
        "product code doesn't name. Drop it.",
    ]);
  });

  it("reads neither comments, test code nor a test-only module", () => {
    expect(
      harnessNames({
        ...PROTOCOL,
        [daemon]:
          '// Codex\n/** claude */\nfn a() {}\n#[cfg(test)]\nmod tests { const C: &str = "codex"; }\n',
        "crates/bazhen-daemon/src/lib.rs": "#[cfg(test)]\nmod fixture;\n",
        "crates/bazhen-daemon/src/fixture.rs": "fn codex() {}\n",
        "crates/bazhen-daemon/tests/codex.rs": "fn codex() {}\n",
      }),
    ).toEqual([]);
  });

  it("takes the names an entry lists, and holds each entry both ways", () => {
    expect(
      harnessNames(
        {
          ...PROTOCOL,
          [daemon]: 'fn as_codex() { "bazhen-codex-thread"; Codex }\n',
        },
        {
          [daemon]: { names: ["as_codex", '"bazhen-codex-thread', "codex_gone"], why: "w" },
          "crates/bazhen-core/src/g.rs": { names: [], why: "w" },
          "crates/bazhen-protocol/src/lib.rs": { names: ["Codex"], why: "w" },
        },
      ),
    ).toEqual([
      "crates/bazhen-daemon/src/route.rs:1: names a harness (`Codex`)",
      "scripts/check-standards.ts: HARNESS_NAMED lists codex_gone for " +
        "crates/bazhen-daemon/src/route.rs, which no longer holds it. Drop the name.",
      "scripts/check-standards.ts: HARNESS_NAMED lists crates/bazhen-core/src/g.rs, which isn't " +
        "product code.",
      "scripts/check-standards.ts: HARNESS_NAMED lists crates/bazhen-protocol/src/lib.rs, whose " +
        "crate HARNESS_CRATES frees already.",
    ]);
  });

  it("holds an entry's identifier and string apart, so listing one lets the other through never", () => {
    expect(
      harnessNames(
        { ...PROTOCOL, [daemon]: 'fn codex() { "codex"; }\nfn as_codex() { "as_codex"; }\n' },
        { [daemon]: { names: ['"codex', "as_codex"], why: "w" } },
      ),
    ).toEqual([
      "crates/bazhen-daemon/src/route.rs:1: names a harness (`codex`)",
      'crates/bazhen-daemon/src/route.rs:2: names a harness (`"as_codex"`)',
    ]);
  });

  it("refuses a freed crate that doesn't exist", () => {
    expect(harnessNameFailures(["crates/bazhen-peer/src/lib.rs"], () => "", FREE, {}, {})).toEqual([
      "scripts/check-standards.ts: HARNESS_CRATES lists missing bazhen-protocol.",
    ]);
  });
});
