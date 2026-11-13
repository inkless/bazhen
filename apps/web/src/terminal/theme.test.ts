import { describe, expect, test } from "vitest";
import { TERMINAL_COLOURS } from "@bazhen/protocol";
import { toHex } from "../ui/token-sheet.ts";
import { inOtherTheme, terminalTheme } from "./theme.ts";

const COLOUR_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionInactiveBackground",
  "selectionForeground",
  ...["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap((n) => [
    n,
    `bright${n[0]?.toUpperCase()}${n.slice(1)}`,
  ]),
];

/** The red channel of `#rrggbb`, which is the grey for a neutral. */
const grey = (hex = "") => Number.parseInt(hex.slice(1, 3), 16);

describe("toHex", () => {
  test("encodes sRGB's gamma: oklch(0.5693 0 0) is #777777, and black and white are exact", () => {
    expect(toHex({ l: 0.5693, c: 0, h: 0 })).toBe("#777777");
    expect(toHex({ l: 0, c: 0, h: 0 })).toBe("#000000");
    expect(toHex({ l: 1, c: 0, h: 0 })).toBe("#ffffff");
  });
});

describe("terminalTheme", () => {
  test("sets every colour xterm.js would otherwise take from its own dark default", () => {
    const theme = terminalTheme("light", false);
    for (const key of COLOUR_KEYS) expect(Reflect.get(theme, key)).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("is dark text on a light background in light, and the reverse in dark", () => {
    const light = terminalTheme("light", false);
    const dark = terminalTheme("dark", false);
    expect(grey(light.background)).toBeGreaterThan(200);
    expect(grey(light.foreground)).toBeLessThan(80);
    expect(grey(dark.background)).toBeLessThan(40);
    expect(grey(dark.foreground)).toBeGreaterThan(200);
  });
});

describe("the colours tmux and the daemon tell programs", () => {
  // Every variant terminalTheme() draws, so a more-contrast override can't drift from them.
  const variants = (["light", "dark"] as const).flatMap((scheme) =>
    [false, true].map((more) => [scheme, more] as const),
  );
  test.each(variants)(
    "are the %s terminal's text and background (more contrast: %s)",
    (scheme, more) => {
      const theme = terminalTheme(scheme, more);
      expect({
        text: theme.foreground,
        background: theme.background,
      }).toEqual(TERMINAL_COLOURS[scheme]);
    },
  );
});

describe("inOtherTheme", () => {
  test("lists open agents in the other theme whose harness can start in this one", () => {
    const both = ["light", "dark"] as const;
    const agents = [
      { id: "a", state: "running", theme: "dark", themes: both },
      { id: "b", state: "exited", theme: "dark", themes: both },
      { id: "c", state: "running", theme: "light", themes: both },
      { id: "d", state: "closed", theme: "dark", themes: both },
      { id: "e", state: "running", theme: "dark", themes: ["dark"] },
    ] as const;
    expect(inOtherTheme(agents, "light").map((a) => a.id)).toEqual(["a", "b"]);
  });
});
