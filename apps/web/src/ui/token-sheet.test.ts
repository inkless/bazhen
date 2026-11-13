import { describe, expect, test } from "vitest";
import paletteCss from "./palette.css?raw";
import { contrast, paletteOf, themeOf, type Scheme } from "./token-sheet.ts";
import tokensCss from "./tokens.css?raw";

const palette = paletteOf(paletteCss);

// Every foreground the screens draw over every background it is drawn on (app.css, ui.css).
const TEXT_ON = {
  "color-text": ["color-bg", "color-surface", "color-surface-hover", "color-surface-selected"],
  "color-text-muted": [
    "color-bg",
    "color-surface",
    "color-surface-hover",
    "color-surface-selected",
  ],
  "color-link": ["color-bg", "color-surface"],
  "color-ok": ["color-ok-subtle"],
  "color-warn": ["color-warn-subtle"],
  "color-danger": ["color-danger-subtle"],
};
// Non-text that must be seen (WCAG 1.4.11): focus ring, input borders, the needs-you dot.
const SEEN_ON = {
  "color-focus-ring": ["color-bg", "color-surface", "color-surface-selected"],
  "color-border-strong": ["color-bg", "color-surface"],
  "color-warn": ["color-bg", "color-surface-hover", "color-surface-selected"],
};

const pairs = (table: Record<string, string[]>) =>
  Object.entries(table).flatMap(([fg, bgs]) => bgs.map((bg) => [fg, bg] as const));

const THEMES: [Scheme, boolean][] = [
  ["light", false],
  ["dark", false],
  ["light", true],
  ["dark", true],
];

describe.each(THEMES)("the %s theme (more contrast: %s)", (scheme, more) => {
  const theme = themeOf(tokensCss, palette, scheme, more);
  const ratio = (fg: string, bg: string) => {
    const [a, b] = [theme.get(fg), theme.get(bg)];
    if (a === undefined || b === undefined) throw new Error(`no token ${a ? bg : fg}`);
    return contrast(a, b);
  };

  test.each(pairs(TEXT_ON))("%s on %s is readable text (4.5:1)", (fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(pairs(SEEN_ON))("%s on %s is visible (3:1)", (fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
});

describe("contrast", () => {
  test("is 21:1 for black on white and 1:1 for a colour on itself", () => {
    const [black, white] = [
      { l: 0, c: 0, h: 0 },
      { l: 1, c: 0, h: 0 },
    ];
    expect(contrast(black, white)).toBeCloseTo(21, 1);
    expect(contrast(white, black)).toBeCloseTo(21, 1);
    expect(contrast(white, white)).toBe(1);
  });

  test("matches WCAG for a mid grey: #777 on white is 4.48:1", () => {
    // #777777 is oklch(0.5693 0 0).
    expect(contrast({ l: 0.5693, c: 0, h: 0 }, { l: 1, c: 0, h: 0 })).toBeCloseTo(4.48, 1);
  });
});

describe("the theme mapping", () => {
  test("gives every semantic colour token a primitive in both themes", () => {
    const light = themeOf(tokensCss, palette, "light", false);
    expect([...themeOf(tokensCss, palette, "dark", false).keys()]).toEqual([...light.keys()]);
    expect(light.size).toBeGreaterThan(10);
  });

  test("fails on a token mapped to a primitive that doesn't exist", () => {
    const broken = "--color-bg: light-dark(var(--color-nope-1), var(--color-neutral-dark-1));";
    expect(() => themeOf(broken, palette, "light", false)).toThrow(/color-nope-1/);
  });
});
