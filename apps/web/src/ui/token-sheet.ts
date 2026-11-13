/** Reads palette.css and tokens.css as text, to test the themes and to show them side by side. */

export type Oklch = { readonly l: number; readonly c: number; readonly h: number };
export type Scheme = "light" | "dark";

const PRIMITIVE = /--(color-[\w-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\);/g;
const MAPPED = /--(color-[\w-]+):\s*light-dark\(var\(--([\w-]+)\),\s*var\(--([\w-]+)\)\);/g;
const MORE_CONTRAST = "@media (prefers-contrast: more)";

export function paletteOf(css: string): Map<string, Oklch> {
  return new Map(
    [...css.matchAll(PRIMITIVE)].map(([, name = "", l, c, h]) => [
      name,
      { l: Number(l), c: Number(c), h: Number(h) },
    ]),
  );
}

function declarations(css: string): Map<string, { light: string; dark: string }> {
  return new Map(
    [...css.matchAll(MAPPED)].map(([, name = "", light = "", dark = ""]) => [
      name,
      { light, dark },
    ]),
  );
}

/** Each semantic colour token's primitive, light and dark, as tokens.css maps it. */
export function mappingOf(
  tokensCss: string,
  moreContrast: boolean,
): Map<string, { light: string; dark: string }> {
  const at = tokensCss.indexOf(MORE_CONTRAST);
  const base = declarations(at === -1 ? tokensCss : tokensCss.slice(0, at));
  if (moreContrast && at !== -1) {
    const section = tokensCss.slice(at, tokensCss.indexOf("\n}\n", at));
    for (const [name, sides] of declarations(section)) base.set(name, sides);
  }
  return base;
}

/** The semantic colour tokens, each resolved to its primitive under one theme. */
export function themeOf(
  tokensCss: string,
  palette: Map<string, Oklch>,
  scheme: Scheme,
  moreContrast: boolean,
): Map<string, Oklch> {
  return new Map(
    [...mappingOf(tokensCss, moreContrast)].map(([name, sides]) => {
      const primitive = palette.get(sides[scheme]);
      if (primitive === undefined) throw new Error(`${name} maps to unknown ${sides[scheme]}`);
      return [name, primitive];
    }),
  );
}

const clip = (v: number) => Math.min(1, Math.max(0, v));

/** Linear sRGB, clipped to the gamut, through OKLab (Björn Ottosson's matrices). */
function linearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3);
  const [x = 0, y = 0, z = 0] = lms;
  return [
    clip(4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z),
    clip(-1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z),
    clip(-0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z),
  ];
}

const luminance = (colour: Oklch) => {
  const [r, g, b] = linearSrgb(colour);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2.2's contrast ratio, 1 to 21. */
export function contrast(a: Oklch, b: Oklch): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
