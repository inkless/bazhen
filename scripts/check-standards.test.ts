import { describe, expect, it } from "vitest";
import {
  CLIPPY_CONFIG,
  WORKSPACE_LINTS,
  declaredTokens,
  hasRuntimeCode,
  inheritsWorkspaceLints,
  lintSuppressions,
  memberDependencyFailures,
  rootManifestFailures,
  offTokenLines,
  pathCandidates,
  pnpmScripts,
  rustFailures,
  skillFailures,
  suppressionFailures,
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

describe("lintSuppressions", () => {
  it("reads allow and expect, inner, outer, spaced, over several lines or under cfg_attr", () => {
    const source = [
      "#![allow(clippy::pedantic)]",
      '#[expect(clippy::unwrap_used, reason = "x")]',
      "#[cfg_attr(all(test, unix), allow(dead_code))]",
      "# [allow(unused)]",
      '#![expect(\n    unsafe_code,\n    reason = "the PTY (openpty, ioctl)"\n)]',
      "#[warn(missing_docs)]",
    ].join("\n");
    expect(lintSuppressions(source)).toEqual([
      { level: "allow", lints: ["clippy::pedantic"] },
      { level: "expect", lints: ["clippy::unwrap_used"] },
      { level: "allow", lints: ["dead_code"] },
      { level: "allow", lints: ["unused"] },
      { level: "expect", lints: ["unsafe_code"] },
    ]);
  });

  it("still reads an attribute whose reason holds //, quotes or brackets", () => {
    const source = [
      '#[expect(clippy::unwrap_used, reason = "see https://doc.rust-lang.org/x")]',
      '#[allow(dead_code, reason = "a \\"quoted\\" (word)")]',
      'let u = "http://x"; #[allow(unused)]',
      '#[cfg_attr(feature = "a[b]", allow(missing_docs))]',
    ].join("\n");
    expect(lintSuppressions(source).map((s) => s.lints[0])).toEqual([
      "clippy::unwrap_used",
      "dead_code",
      "unused",
      "missing_docs",
    ]);
  });

  it("leaves an attribute written in a comment, a string or a raw string alone", () => {
    const source = [
      "// never #[allow(clippy::pedantic)]",
      "/// see `#[expect(dead_code)]`",
      "/* #[allow(x)] /* nested */ still a comment */",
      'let s = "#[allow(y)]";',
      'let r = r#"a "#[allow(z)]" b"#;',
      "let c = '\\''; let q = '\"'; fn f<'a>(x: &'a str) {}",
    ].join("\n");
    expect(lintSuppressions(source)).toEqual([]);
  });
});

describe("suppressionFailures", () => {
  const unsafeModules = { "crates/x/src/pty.rs": "the PTY's FFI" };

  it("lets only an unsafe module expect unsafe_code, and nothing else", () => {
    const unsafeCode = '#![expect(unsafe_code, reason = "the PTY\'s FFI (openpty, ioctl)")]\n';
    expect(suppressionFailures("crates/x/src/pty.rs", unsafeCode, unsafeModules)).toEqual([]);
    expect(suppressionFailures("crates/x/src/a.rs", unsafeCode, unsafeModules)).toHaveLength(1);
    const more = "#![allow(unsafe_code)]\n#![expect(unsafe_code, dead_code)]\n";
    expect(suppressionFailures("crates/x/src/pty.rs", more, unsafeModules)).toHaveLength(2);
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
  });
  const about = (path: string) => failures.filter((f) => f.startsWith(`${path}: `));

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
      [expect.stringContaining("#[expect(dead_code)]")],
      [expect.stringContaining("passes an attribute through")],
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

  it("names an unsafe module that no longer exists", () => {
    expect(about("scripts/check-standards.ts")).toEqual([
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

describe("rootManifestFailures", () => {
  const root = [
    "[workspace]",
    'members = ["crates/*"]',
    "",
    "# Pinned here.",
    "[workspace.dependencies]",
    'proptest = { version = "=1.12.0", default-features = false }',
    "",
    ...WORKSPACE_LINTS.flatMap((l) => (l.startsWith("[") ? ["", l] : [l])),
    "",
    "[profile.release]",
    "lto = true",
  ].join("\n");

  const deps = (lines: string) =>
    rootManifestFailures(
      root.replace("[workspace.dependencies]\n", `[workspace.dependencies]\n${lines}\n`),
    );

  it("accepts a manifest holding the standard's lints and exact pins", () => {
    expect(rootManifestFailures(root)).toEqual([]);
  });

  it("refuses a lint level that differs from the standard's", () => {
    const relaxed = root.replace('unwrap_used = "warn"', 'unwrap_used = "allow"');
    const added = root.replace(
      "[workspace.lints.clippy]\n",
      '[workspace.lints.clippy]\ncast_lossless = "allow"\n',
    );
    expect([rootManifestFailures(relaxed), rootManifestFailures(added)]).toEqual([
      [expect.stringContaining("differs from WORKSPACE_LINTS")],
      [expect.stringContaining("differs from WORKSPACE_LINTS")],
    ]);
  });

  it("refuses a workspace dependency not pinned exactly, but takes a path to a crate of ours", () => {
    expect([
      deps('serde = "1.0.200"'),
      deps('serde = { version = "^1", features = ["derive"] }'),
      deps('serde = { version = "=1.0.200", default-features = false }'),
      deps('holder-proto = { path = "crates/holder-proto" }'),
    ]).toEqual([
      [expect.stringContaining('`serde = "1.0.200"` must pin an exact version')],
      [expect.stringContaining("must pin an exact version")],
      [],
      [],
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
