/** Reads palette.css and tokens.css as text, to test the themes and to show them side by side. */

export type Oklch = {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  /** Below 1 for a translucent primitive, whose colour depends on what is under it. */
  readonly alpha?: number;
};
export type Scheme = "light" | "dark";
type Sides = { readonly light: string; readonly dark: string };

export interface Declaration {
  readonly property: string;
  readonly value: string;
  /** The preludes of the blocks it sits in, outermost first: `["@media (…)", ":root"]`. */
  readonly within: readonly string[];
  readonly line: number;
}

/**
 * Every declaration in a stylesheet, with the blocks around it. Enough CSS for the token files
 * and the screens' stylesheets: comments, nested blocks, and selectors and values over several
 * lines; strings are not looked into.
 */
export function cssDeclarations(css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const found: Declaration[] = [];
  const within: string[] = [];
  let start = 0;
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  const take = (end: number) => {
    const raw = text.slice(start, end);
    const line = lineAt(start + raw.length - raw.trimStart().length);
    start = end + 1;
    return { body: raw.trim(), line };
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") within.push(take(i).body.replace(/\s+/g, " "));
    else if (c === ";" || c === "}") {
      const { body, line } = take(i);
      const colon = body.indexOf(":");
      if (body !== "" && colon > 0 && within.length > 0) {
        found.push({
          property: body.slice(0, colon).trim(),
          value: body.slice(colon + 1).trim(),
          within: [...within],
          line,
        });
      }
      if (c === "}") within.pop();
    }
  }
  return found;
}

const PRIMITIVE = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/;
const MAPPED = /^light-dark\(var\(--([\w-]+)\), var\(--([\w-]+)\)\)$/;
const MORE_CONTRAST = "@media (prefers-contrast: more)";
const isColour = (d: Declaration) => d.property.startsWith("--color-");

export function paletteOf(css: string): Map<string, Oklch> {
  return new Map(
    cssDeclarations(css)
      .filter(isColour)
      .map((d) => {
        const [, l, c, h, alpha] = PRIMITIVE.exec(d.value) ?? [];
        if (h === undefined) throw new Error(`${d.property} is not an oklch() primitive`);
        const colour = { l: Number(l), c: Number(c), h: Number(h) };
        return [
          d.property.slice(2),
          alpha === undefined ? colour : { ...colour, alpha: Number(alpha) },
        ];
      }),
  );
}

/**
 * Each semantic colour token's primitive, light and dark, as tokens.css maps it, and under more
 * contrast with its overrides. Fails on a colour token in any other form, so none goes untested.
 */
export function mappingOf(tokensCss: string, moreContrast: boolean): Map<string, Sides> {
  const base = new Map<string, Sides>();
  const overrides = new Map<string, Sides>();
  for (const d of cssDeclarations(tokensCss).filter(isColour)) {
    const [, light, dark] =
      MAPPED.exec(d.value.replace(/\s+/g, " ").replaceAll("( ", "(").replaceAll(" )", ")")) ?? [];
    if (dark === undefined || light === undefined) {
      throw new Error(`${d.property} is not light-dark(var(--…), var(--…)): ${d.value}`);
    }
    const where = d.within.join(" ");
    if (where === ":root") base.set(d.property.slice(2), { light, dark });
    else if (where === `${MORE_CONTRAST} :root`)
      overrides.set(d.property.slice(2), { light, dark });
    else throw new Error(`${d.property} is mapped in ${where}, which no theme here reads`);
  }
  for (const name of overrides.keys()) {
    if (!base.has(name)) throw new Error(`${name} has a more-contrast override but no mapping`);
  }
  return moreContrast ? new Map([...base, ...overrides]) : base;
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

/** Linear sRGB through OKLab (Björn Ottosson's matrices), not clipped to the gamut. */
export function linearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const [x = 0, y = 0, z = 0] = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3);
  return [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ];
}

/** One linear sRGB channel, clipped and gamma-encoded, as two hex digits. */
const hexChannel = (v: number) => {
  const c = Math.min(1, Math.max(0, v));
  const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255)
    .toString(16)
    .padStart(2, "0");
};

/** An opaque primitive as `#rrggbb`, for what takes no CSS colour function, as xterm.js's theme. */
export const toHex = (colour: Oklch) => `#${linearSrgb(colour).map(hexChannel).join("")}`;

/** Inside sRGB, allowing for the three decimals the palette is written to. */
export const inSrgb = (colour: Oklch) =>
  linearSrgb(colour).every((v) => v >= -0.0005 && v <= 1.0005);

const luminance = (colour: Oklch) => {
  const [r, g, b] = linearSrgb(colour).map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

/**
 * WCAG 2.2's contrast ratio, 1 to 21, between two opaque colours. A translucent one is refused:
 * its ratio depends on what is under it, so a pair using one must be measured composited.
 */
export function contrast(a: Oklch, b: Oklch): number {
  if ((a.alpha ?? 1) < 1 || (b.alpha ?? 1) < 1) {
    throw new Error("contrast needs opaque colours; composite a translucent one over its backdrop");
  }
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
