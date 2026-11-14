import { describe, expect, it } from "vitest";
import {
  CLIPPY_CONFIG,
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
  type CargoMetadata,
  rootManifestFailures,
  offTokenLines,
  pathCandidates,
  pnpmScripts,
  rustFailures,
  skillFailures,
  unsafeModuleFailures,
} from "./check-standards.ts";

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

  it("refuses code compiled only under a cfg the gates never build", () => {
    const source = [
      "#[cfg(not(debug_assertions))]",
      '#[cfg(feature = "slow")]',
      '#[cfg_attr(target_os = "macos", derive(Debug))]',
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
    ".cargo/config.toml": "[build]\njobs = 2\n",
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

  it("refuses any cargo config, and clippy, rustfmt or toolchain files beside the root ones", () => {
    expect([
      about(".cargo/config.toml"),
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
  ].join("\n");

  const deps = (lines: string) =>
    rootManifestFailures(
      root.replace("[workspace.dependencies]\n", `[workspace.dependencies]\n${lines}\n`),
    );

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
    ]).toEqual([
      [expect.stringContaining("[workspace] differs from ROOT_TABLES")],
      [expect.stringContaining("[patch.crates-io] isn't one of the root manifest's tables")],
      [expect.stringContaining("[profile.test] isn't one of")],
      [expect.stringContaining("[profile.release] differs")],
      [expect.stringContaining("[profile.release] is missing")],
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
      "fn serve(s: &mut UnixStream) {}",
      "fn load(f: File) {}",
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
      "fn listen(l: UnixListener) {}",
      "fn owned(fd: OwnedFd) {}",
      "fn spawned(c: Child) {}",
    ].join("\n");
    expect(byteTakers(source)).toEqual([
      "parse",
      "fill",
      "header",
      "own",
      "from",
      "feed",
      "pump",
      "serve",
      "load",
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
      "listen",
      "owned",
      "spawned",
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
  ) => decoderFailures(Object.keys(tree), (p) => tree[p] ?? "", fuzzed, notDecoders);
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
        "pub struct Reader {",
        "    buf: Vec<u8>,",
        "}",
        "pub struct Frame<'a>(&'a [u8]);",
        "pub struct Plain {",
        "    n: u32,",
        "}",
        "impl Reader {",
        "    pub fn new() -> Self { todo() }",
        "    pub fn next_frame(&mut self) -> Option<u8> { None }",
        "}",
        "impl Plain {",
        "    pub fn get(&self) -> u32 { 0 }",
        "}",
        "pub fn decode(f: Frame<'_>) {}",
        "type Alias = Reader;",
      ].join("\n"),
    };
    expect(failures(fuzzed, exempt, reader).map((f) => f.split(": ")[0])).toEqual([
      "crates/p/src/reader.rs::Alias",
      "crates/p/src/reader.rs::Reader::next_frame",
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
        "    pub fn go(&self) {}",
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
