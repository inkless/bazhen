import { describe, expect, it } from "vitest";
import {
  declaredTokens,
  hasRuntimeCode,
  offTokenLines,
  pathCandidates,
  pnpmScripts,
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
