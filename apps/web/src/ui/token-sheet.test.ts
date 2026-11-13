import { describe, expect, test } from "vitest";
import paletteCss from "./palette.css?raw";
import {
  contrast,
  cssDeclarations,
  inSrgb,
  mappingOf,
  paletteOf,
  themeOf,
  type Declaration,
  type Scheme,
} from "./token-sheet.ts";
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
  "color-on-accent": ["color-accent", "color-accent-hover"],
  "color-ok": ["color-ok-subtle"],
  "color-warn": ["color-warn-subtle"],
  "color-danger": ["color-danger-subtle"],
  "color-terminal-text": ["color-terminal-bg"],
  "color-terminal-selection-text": ["color-terminal-selection"],
};
// Non-text that must be seen (WCAG 1.4.11): focus ring, input borders, the needs-you dot.
const SEEN_ON = {
  "color-focus-ring": ["color-bg", "color-surface", "color-surface-selected"],
  "color-border-strong": [
    "color-bg",
    "color-surface",
    "color-surface-hover",
    "color-surface-selected",
  ],
  "color-warn": ["color-bg", "color-surface-hover", "color-surface-selected"],
  "color-terminal-cursor": ["color-terminal-bg"],
  // Selected text keeps its place on screen; the selection must stand out from what is around it.
  "color-terminal-selection": ["color-terminal-bg"],
};

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap(
  (name) => [`color-terminal-ansi-${name}`, `color-terminal-ansi-bright-${name}`],
);
/**
 * ANSI's colours assume a black background, so in dark `black` is the background's own end of the
 * scale. Programs paint cells with it (`\e[40m`) rather than write in it, so it is held to carrying
 * text, not to being text; `opposite` is what they write on it. Light has no such exception:
 * `bright-white` is text there too (`\e[97m`), so it is a grey that reads, not a white.
 */
const BACKGROUND_END = {
  light: [],
  dark: [{ ansi: "color-terminal-ansi-black", opposite: "color-terminal-ansi-white" }],
} as const;

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

  const ends: readonly { ansi: string; opposite: string }[] = BACKGROUND_END[scheme];
  const exempt = new Set(ends.map((end) => end.ansi));
  test.each(ANSI.filter((name) => !exempt.has(name)))(
    "%s is readable text on the terminal (4.5:1)",
    (name) => {
      expect(ratio(name, "color-terminal-bg")).toBeGreaterThanOrEqual(4.5);
    },
  );

  test.each(ends)("$ansi, the background's own end, carries text (4.5:1)", ({ ansi, opposite }) => {
    expect(ratio("color-terminal-text", ansi)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(opposite, ansi)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the terminal's ANSI colours", () => {
  test("are all mapped, so none falls back to xterm.js's own", () => {
    const mapped = mappingOf(tokensCss, false);
    expect(ANSI.filter((name) => !mapped.has(name))).toEqual([]);
    expect(ANSI).toHaveLength(16);
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

  test("refuses a translucent colour, whose contrast depends on what is under it", () => {
    const scrim = palette.get("color-black-a5");
    expect(scrim?.alpha).toBe(0.3);
    expect(() => contrast({ l: 1, c: 0, h: 0 }, { l: 0, c: 0, h: 0, alpha: 0.3 })).toThrow(
      /opaque/,
    );
  });

  test("matches WCAG for a mid grey: #777 on white is 4.48:1", () => {
    // #777777 is oklch(0.5693 0 0).
    expect(contrast({ l: 0.5693, c: 0, h: 0 }, { l: 1, c: 0, h: 0 })).toBeCloseTo(4.48, 1);
  });
});

const root = (body: string) => `:root {\n${body}\n}`;
const isRootColour = (d: Declaration) =>
  d.property.startsWith("--color-") && d.within.join(" ") === ":root";
const declared = new Set(
  cssDeclarations(tokensCss)
    .filter(isRootColour)
    .map((d) => d.property.slice(2)),
);

describe("the theme mapping", () => {
  test("covers every colour token tokens.css declares, in both themes", () => {
    for (const [scheme, more] of THEMES) {
      expect(new Set(themeOf(tokensCss, palette, scheme, more).keys())).toEqual(declared);
    }
    expect(declared.size).toBeGreaterThan(10);
  });

  test("fails on a token mapped to a primitive that doesn't exist", () => {
    const broken = root(
      "--color-bg: light-dark(var(--color-nope-1), var(--color-neutral-dark-1));",
    );
    expect(() => themeOf(broken, palette, "light", false)).toThrow(/color-nope-1/);
  });

  test("fails on a colour token in any form it can't resolve, rather than skip it", () => {
    expect(() => mappingOf(root("--color-bg: var(--color-neutral-1);"), false)).toThrow(/color-bg/);
    expect(() => mappingOf(root("--color-bg: #fff;"), false)).toThrow(/color-bg/);
    const later = `${root("--color-bg: light-dark(var(--a), var(--b));")}
@media (pointer: coarse) {
  :root {
    --color-text: light-dark(var(--a), var(--b));
  }
}`;
    expect(() => mappingOf(later, false)).toThrow(/color-text/);
  });

  test("reads a mapping written over several lines, and more-contrast overrides only with it", () => {
    const css = `${root("--color-bg: light-dark(\n  var(--a),\n  var(--b)\n);")}
@media (prefers-contrast: more) {
  :root {
    --color-bg: light-dark(var(--c), var(--d));
  }
}`;
    expect(mappingOf(css, false).get("color-bg")).toEqual({ light: "a", dark: "b" });
    expect(mappingOf(css, true).get("color-bg")).toEqual({ light: "c", dark: "d" });
  });
});

describe("the palette", () => {
  test("is inside sRGB, so no contrast here rests on a browser's gamut mapping", () => {
    const outside = [...palette].filter(([, colour]) => !inSrgb(colour)).map(([name]) => name);
    expect(outside).toEqual([]);
    expect(palette.size).toBe(170);
  });

  test("can tell a colour outside sRGB", () => {
    expect(inSrgb({ l: 0.7, c: 0.3, h: 258 })).toBe(false);
  });
});
