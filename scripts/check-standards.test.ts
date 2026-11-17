import { describe, expect, it } from "vitest";
import {
  CARGO_CONFIG,
  CLIPPY_CONFIG,
  MAX_CAP,
  MUTANTS_CONFIG,
  cappedScriptFailures,
  ROOT_TABLES,
  TOOLCHAIN_CONFIG,
  DENY_CONFIG,
  RUST_GATE_SCRIPTS,
  WORKSPACE_LINTS,
  byteTakers,
  decoderFailures,
  declaredTokens,
  fuzzManifestFailures,
  tomlTables,
  gateScriptFailures,
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
  unmarkedSignallingTests,
  skillFailures,
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

  it("is one of the checks pnpm check runs", () => {
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
      '#[ignore = "signals processes; runs in pnpm test:real rust"]',
      "fn a() { bazhen_test_signal::require_sandbox().unwrap(); }",
      '#[ignore = "signals processes"]',
      '#![ignore = "signals processes; runs in pnpm test:real rust"]',
      '#[cfg_attr(test, ignore = "signals processes; runs in pnpm test:real rust")]',
    ].join("\n");
    expect(scan(source).map((f) => f.split(": ")[0])).toEqual([
      "crates/x/src/a.rs:4",
      "crates/x/src/a.rs:5",
      "crates/x/src/a.rs:6",
    ]);
  });
  it("requires such a test to refuse to run off a sandbox, before anything else", () => {
    const ignored = '#[test]\n#[ignore = "signals processes; runs in pnpm test:real rust"]\n';
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
      ].map((t) => harnessFailures("crates/a/Cargo.toml", t)),
    ).toEqual([
      [expect.stringContaining("sets a test harness")],
      [expect.stringContaining("sets a test harness")],
      [expect.stringContaining("holds a \\ escape")],
      [expect.stringContaining("holds a \\ escape")],
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
    ]).toEqual([
      [expect.stringContaining("[workspace] differs from ROOT_TABLES")],
      [expect.stringContaining("[patch.crates-io] isn't one of the root manifest's tables")],
      [expect.stringContaining("[profile.test] isn't one of")],
      [expect.stringContaining("[profile.release] differs")],
      [expect.stringContaining("[profile.release] is missing")],
      [expect.stringContaining("[profile.release-holder] differs")],
      [expect.stringContaining("[profile.release-holder] is missing")],
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

const CHECK = Object.keys(RUST_GATE_SCRIPTS)
  .map((name) => `pnpm run ${name}`)
  .join(" && ");

describe("gateScriptFailures", () => {
  it("accepts the standard's gate scripts, run by check", () => {
    expect(
      gateScriptFailures({ ...RUST_GATE_SCRIPTS, check: `pnpm run lint && ${CHECK}` }),
    ).toEqual([]);
  });

  it("refuses a gate that runs anything else, and a check that skips or steps round one", () => {
    const loosened = { ...RUST_GATE_SCRIPTS, "lint:rust": "cargo clippy --workspace" };
    expect([
      gateScriptFailures({ ...loosened, check: CHECK }),
      gateScriptFailures({ ...RUST_GATE_SCRIPTS, check: CHECK.replace(" && pnpm run deny", "") }),
      gateScriptFailures({ ...RUST_GATE_SCRIPTS, check: `${CHECK} || true` }),
      gateScriptFailures({ ...RUST_GATE_SCRIPTS, check: CHECK.replace(" && ", " ; ") }),
      gateScriptFailures({ ...RUST_GATE_SCRIPTS, check: `${CHECK} && true\nexit 0` }),
      gateScriptFailures({ ...RUST_GATE_SCRIPTS, check: `${CHECK} | cat` }),
    ]).toEqual([
      [expect.stringContaining('the "lint:rust" script must be')],
      [expect.stringContaining("must run `pnpm run deny`")],
      Object.keys(RUST_GATE_SCRIPTS).map(() => expect.stringContaining("must run")),
      Object.keys(RUST_GATE_SCRIPTS).map(() => expect.stringContaining("must run")),
      Object.keys(RUST_GATE_SCRIPTS).map(() => expect.stringContaining("line break")),
      Object.keys(RUST_GATE_SCRIPTS).map(() => expect.stringContaining("must run")),
    ]);
  });
});

describe("rustFailures on the gates' own configuration", () => {
  const standard: Record<string, string> = {
    "deny.toml": DENY_CONFIG.join("\n"),
    "clippy.toml": CLIPPY_CONFIG.join("\n"),
    "rust-toolchain.toml": TOOLCHAIN_CONFIG.join("\n"),
    ".cargo/config.toml": CARGO_CONFIG.join("\n"),
    ".cargo/mutants.toml": MUTANTS_CONFIG.join("\n"),
    "package.json": JSON.stringify({ scripts: { ...RUST_GATE_SCRIPTS, check: CHECK } }),
    "scripts/cargo-gate.ts": "RUSTFLAGS",
    "scripts/cargo-gate.test.ts": "RUSTFLAGS",
    "scripts/cargo-gate.medium.test.ts": "RUSTFLAGS",
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

  it("refuses a cargo config without the capping test runner, or none", () => {
    expect([
      failures({ ".cargo/config.toml": "[build]\njobs = 2\n" }),
      failures({}, [".cargo/config.toml"]),
    ]).toEqual([
      [expect.stringContaining(".cargo/config.toml: differs from CARGO_CONFIG")],
      [expect.stringContaining(".cargo/config.toml is missing")],
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

  it("refuses package.json gate scripts other than the standard's", () => {
    const loose = JSON.stringify({ scripts: { ...RUST_GATE_SCRIPTS, deny: "true", check: CHECK } });
    expect(failures({ "package.json": loose })).toEqual([
      expect.stringContaining('the "deny" script must be'),
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
    expect(failures({}, ["scripts/cargo-gate.test.ts"])).toEqual([
      "scripts/check-standards.ts: RUST_FLAG_EXEMPT lists missing scripts/cargo-gate.test.ts.",
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
        "lint:rust": "node scripts/cargo-gate.ts lint",
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
        "node scripts/cargo-gate.ts test",
        "node scripts/falsify.ts",
        "node scripts/hook-bench.ts",
        "node scripts/test-real.ts",
        `vitest run && ${cap} vitest run`,
      ].map((t) => cappedScriptFailures("package.json", { t }).length),
    ).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("refuses a capped step joined by anything but && to one that could run round it", () => {
    expect(
      ["; vitest", " | tee x", " & vitest", "\nvitest", " $(vitest)", " `vitest`"].map(
        (tail) => cappedScriptFailures("package.json", { t: `${cap} vitest run${tail}` })[0],
      ),
    ).toEqual(Array.from({ length: 6 }, () => expect.stringContaining("`&&` alone")));
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

describe("decoderFailures", () => {
  const lib = "pub fn decode(b: &[u8]) {}\nfn send(b: &[u8]) {}\nfn other(x: u8) {}\n";
  const repo: Record<string, string> = {
    "crates/p/src/lib.rs": lib,
    "crates/p/fuzz/fuzz_targets/decode.rs": "fuzz_target!(|b: &[u8]| { p::decode(b); });",
    "crates/p/tests/api.rs": "fn helper(b: &[u8]) {}",
  };
  const failures = (
    fuzzed: Record<string, string>,
    notDecoders: Record<string, string>,
    tree = repo,
    publicFields: Record<string, string> = {},
  ) => decoderFailures(Object.keys(tree), (p) => tree[p] ?? "", fuzzed, notDecoders, publicFields);
  const fuzzed = { "crates/p/src/lib.rs::decode": "decode" };
  const exempt = { "crates/p/src/lib.rs::send": "an encoder" };

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
      "crates/d/src/lib.rs": carrierCrate("D", "Frames", "use q::Frames;"),
      "crates/e/src/lib.rs": carrierCrate("E", "Frames", "use queue::Frames;"),
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
      "crates/g/Cargo.toml": '[package.metadata.x]\nqx.package = "queue"\n',
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

  it("names a manifest whose package name it can't read", () => {
    const tree = {
      ...repo,
      "Cargo.toml": [
        "[workspace.dependencies]",
        'qe = { package = "qu\\u0065ue" }',
        "qn.package = 1",
        "qi = { package = { name = 'queue' } }",
        'qo = { version = "1" }',
        "[package.metadata.x]",
        "qm.package = 1",
      ].join("\n"),
      "crates/q/Cargo.toml": '[package]\nname = """queue"""\n',
    };
    expect(failures(fuzzed, exempt, tree)).toEqual([
      expect.stringContaining('Cargo.toml: can\'t read `qe = { package = "qu\\u0065ue" }`'),
      expect.stringContaining("Cargo.toml: can't read `qn.package = 1`"),
      expect.stringContaining("Cargo.toml: can't read `qi = { package = { name = 'queue' } }`"),
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
      "crates/p/src/a.rs::Twin::n",
      "crates/p/src/a.rs::Bounded::n",
      "crates/p/src/b.rs::Mirror::n",
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
        "pub fn origin(o: Origin) {}",
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
        "pub enum Msg { Data { id: u64, bytes: Vec<u8> }, Raw(u64, Vec<u8>), Ping(u64), Gone }",
        "pub fn send(m: Msg) {}",
      ].join("\n"),
      "crates/a/src/lib.rs": [
        "use q::Msg;",
        "fn arm() { match next() { Msg::Data { bytes, .. } => look(bytes), _ => {} } }",
        "fn renamed() { match next() { Msg::Data { bytes: b, .. } => look(b), _ => {} } }",
        "fn tuple() { if let Msg::Raw(_, b) = next() { look(b) } }",
        "fn tail() { if let Msg::Raw(.., b) = next() { look(b) } }",
        "fn by_ref() { match &next() { &Msg::Data { ref bytes, .. } => look(bytes), _ => {} } }",
        "fn by_ref_mut() { match next() { Msg::Raw(_, ref mut b) => look(b), _ => {} } }",
        "fn by_amp() { if let Some(&Msg::Raw(_, ref b)) = all().first() { look(b) } }",
        "fn boxed() { match next() { Msg::Raw(_, box b) => look(b), _ => {} } }",
        "fn either() { match next() { Msg::Raw(_, b) | Msg::Data { bytes: b, .. } => look(b), _ => {} } }",
        "fn guard() { match next() { Msg::Raw(_, b) if b.is_empty() => {} _ => {} } }",
        "fn or_else() { let Msg::Raw(_, b) = next() else { return }; look(b) }",
        "fn each() { while let Some(Msg::Data { bytes, .. }) = queue() { look(bytes) } }",
        "fn check() -> bool { matches!(next(), Msg::Raw(_, b) if b.is_empty()) }",
        "fn slice() { if let [Msg::Raw(_, b), ..] = all() { look(b) } }",
        "fn pair() { match (next(), 1) { (Msg::Data { bytes, .. }, _) => look(bytes), _ => {} } }",
        "fn whole() { if let m @ Msg::Data { .. } = next() { keep(m) } }",
        "fn pathed() { if let q::Msg::Raw(_, b) = next() { look(b) } }",
        "fn rest() { match next() { Msg::Data { .. } => {} _ => {} } }",
        "fn other_field() { match next() { Msg::Data { id, .. } => look(id), Msg::Raw(n, _) => look(n), _ => {} } }",
        "fn plain() { if let Msg::Ping(n) = next() { look(n) } }",
        "fn unit() { if let Msg::Gone = next() {} }",
        "fn ignored() { if let Msg::Raw(_, _) = next() {} }",
        "fn built(n: u64) -> Msg { Msg::Data { id: n, bytes: make() } }",
        "fn sent(n: u64) { let m = Msg::Raw(n, make()); q::send(m); q::send(Msg::Raw(n, make())); }",
        "fn listed(n: u64) -> Vec<Msg> { vec![Msg::Raw(n, make()), Msg::Ping(n)] }",
        "fn chosen(n: u64) -> Option<Msg> { match n { 0 => Some(Msg::Raw(n, make())), _ => None } }",
        "fn forward() { let m = next(); match m { Msg::Data { .. } => q::send(m), _ => {} } }",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, tree).map((f) => f.split(": ")[0])).toEqual([
      "crates/q/src/lib.rs::send",
      ...[
        "arm",
        "renamed",
        "tuple",
        "tail",
        "by_ref",
        "by_ref_mut",
        "by_amp",
        "boxed",
        "either",
        "guard",
        "or_else",
        "each",
        "check",
        "slice",
        "pair",
        "whole",
        "pathed",
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

  it("names a chokepoint that no longer exists", () => {
    expect(signalChokepointFailures(CHOKEPOINTS.slice(1), () => "")).toEqual([
      "scripts/signal-paths.ts: SIGNAL_CHOKEPOINTS lists missing packages/host-guard/src/signal.ts.",
    ]);
  });
});

const unmarked = (sources: Record<string, string>) =>
  unmarkedSignallingTests(Object.keys(sources), (f) => sources[f] ?? "").map(
    (f) => f.split(": ")[0],
  );

describe("tests that signal processes they didn't start", () => {
  const MARK = '#[ignore = "signals processes; runs in pnpm test:real rust"]';
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
