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
const ts = (line: string) => offTokenLines(line, false, tokens).length;
const css = (body: string) => offTokenLines(`.x {\n${body}\n}`, true, tokens).map((f) => f.line);

describe("offTokenLines", () => {
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
  });

  it("flags a primitive or a token tokens.css doesn't define", () => {
    expect(css("  color: var(--color-neutral-12);")).toEqual([2]);
    expect(css("  color: var(--colour-text);")).toEqual([2]);
  });

  it("reads selectors and comments as neither colours nor values", () => {
    expect(css("  /* red, #fff */\n  color: var(--color-text);")).toEqual([]);
    expect(offTokenLines(".red:hover {\n}", true, tokens)).toEqual([]);
  });

  it("flags a colour written in a script, and a var() naming an unknown token", () => {
    expect(ts('const c = "#ff0000";')).toBe(1);
    expect(ts('style={{ color: "var(--color-blue-9)" }}')).toBe(1);
    expect(ts('style={{ color: "var(--color-text)" }}')).toBe(0);
    expect(ts("const red = true;")).toBe(0);
  });
});
