// `pnpm font:terminal`: regenerates the web terminal's bundled font, JetBrainsMono Nerd Font Mono,
// from one pinned Nerd Fonts release. Never run by `pnpm check` or CI: it downloads the release,
// and cuts it with fontTools through `uvx`, so it needs the network and uv. Its outputs are
// committed, and `scripts/terminal-font.medium.test.ts` holds them to the hashes it records.
//
// The icons are the same glyphs in every face, so they ship once: four text faces without the
// private-use code points, and one symbols face with only them.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { brotliDecompressSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.ts";

export const RELEASE = "v3.5.1";
export const ARCHIVE_URL = `https://github.com/ryanoasis/nerd-fonts/releases/download/${RELEASE}/JetBrainsMono.tar.xz`;
export const ARCHIVE_SHA256 = "04d5e8f903693f9dd13e16f867e994834e681eb3c72c0d337a770dcda09010cf";
export const FONTTOOLS = "fonttools[woff]==4.68.0";

export const FONT_DIR = fileURLToPath(new URL("../apps/web/src/terminal/font/", import.meta.url));
const NOTICE = fileURLToPath(new URL("../apps/web/public/fonts/LICENSE.txt", import.meta.url));

/** The upstream Mono faces, and what each is cut into. */
export const TEXT_FACES = ["Regular", "Bold", "Italic", "BoldItalic"] as const;
export const SYMBOLS_SOURCE = "Regular";
export const textFile = (face: string) => `JetBrainsMonoNFM-${face}.woff2`;
export const SYMBOLS_FILE = "JetBrainsMonoNFM-Symbols.woff2";
const upstream = (face: string) => `JetBrainsMonoNerdFontMono-${face}.ttf`;

/** The Basic Multilingual Plane's private use area and plane 15, where Nerd Fonts puts its icons. */
export const PRIVATE_USE = [
  [0xe000, 0xf8ff],
  [0xf0000, 0xffffd],
] as const;

export const isPrivateUse = (cp: number) => PRIVATE_USE.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Sorted code points as inclusive runs. */
export function runs(codePoints: Iterable<number>): [number, number][] {
  const out: [number, number][] = [];
  for (const cp of [...new Set(codePoints)].toSorted((a, b) => a - b)) {
    const last = out.at(-1);
    if (last !== undefined && cp === last[1] + 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
}

/** Runs as pyftsubset's `--unicodes` takes them. */
export const unicodesArg = (rs: readonly (readonly [number, number])[]) =>
  rs.map(([lo, hi]) => (lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`)).join(",");
const hex = (n: number) => n.toString(16).toUpperCase();

/**
 * Every code point a font maps for Unicode, from `ttx -t cmap` output. A legacy Mac Roman
 * subtable maps byte codes, not code points, so only the Unicode and Windows Unicode subtables
 * count.
 */
export function cmapOf(ttx: string): Set<number> {
  const out = new Set<number>();
  const tables =
    /<cmap_format_\d+ platformID="(\d+)" platEncID="(\d+)"[^>]*>([\s\S]*?)<\/cmap_format_\d+>/g;
  for (const [, platform, encoding = "", body = ""] of ttx.matchAll(tables)) {
    if (platform !== "0" && !(platform === "3" && ["1", "10"].includes(encoding))) continue;
    for (const [, code = ""] of body.matchAll(/<map code="0x([0-9a-f]+)"/g))
      out.add(parseInt(code, 16));
  }
  return out;
}

/** The archive README's "Icon sets" section: each icon set's upstream and licence. */
export function iconSets(archiveReadme: string): string {
  const section = /^## Icon sets\n([\s\S]*?)(?=^## )/m.exec(archiveReadme)?.[1];
  if (section === undefined) throw new Error("the archive's README has no Icon sets section");
  return section.trim();
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The licence notice shipped beside the fonts. */
export function notice(ofl: string, icons: string): string {
  return [
    `JetBrainsMono Nerd Font Mono, from Nerd Fonts ${RELEASE}`,
    ARCHIVE_URL,
    `sha256 ${ARCHIVE_SHA256}`,
    "",
    "The web terminal's font is cut from this release's JetBrainsMonoNerdFontMono faces: four text",
    "faces without the private-use code points, and one face with only them. No glyph is changed.",
    "",
    "JetBrains Mono is licensed under the SIL Open Font License 1.1:",
    "",
    ofl.trim(),
    "",
    "The icons patched in by Nerd Fonts come from these sets, under these licences:",
    "",
    icons,
    "",
  ].join("\n");
}

/** A file the README records, as `readme` writes it and `recorded` reads it back. */
/** Every glyph's advance a cell font has, out of a 1000-unit em: a letter's, and so an icon's. */
export const CELL_ADVANCE = 600;

/** WOFF2's known-table index (its spec's table 5.1) of the tables `metrics` reads, or transforms. */
const TABLE = { head: 1, hhea: 2, hmtx: 3, maxp: 4, glyf: 10, loca: 11 } as const;
const ARBITRARY_TAG = 63;

/**
 * A WOFF2 font's em and each glyph's advance, read from its `head`, `hhea`, `maxp` and `hmtx`
 * tables, so the committed files can be held to one cell without fontTools.
 */
export function metrics(woff2: Uint8Array): { unitsPerEm: number; advances: number[] } {
  const file = new DataView(woff2.buffer, woff2.byteOffset, woff2.byteLength);
  if (file.getUint32(0) !== 0x774f4632) throw new Error("not a WOFF2 file");
  const numTables = file.getUint16(12);
  const compressedSize = file.getUint32(20);
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = file.getUint8(at++);
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("UIntBase128 longer than 5 bytes");
  };
  const tables = new Map<number, { offset: number; transformed: boolean }>();
  let offset = 0;
  for (let t = 0; t < numTables; t++) {
    const flags = file.getUint8(at++);
    const index = flags & 0x3f;
    const version = flags >> 6;
    if (index === ARBITRARY_TAG) at += 4;
    const length = base128();
    const nullTransform =
      index === TABLE.glyf || index === TABLE.loca ? version === 3 : version === 0;
    const stored = nullTransform ? length : base128();
    tables.set(index, { offset, transformed: !nullTransform });
    offset += stored;
  }
  const data = brotliDecompressSync(woff2.subarray(at, at + compressedSize));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const table = (index: number) => {
    const found = tables.get(index);
    if (found === undefined) throw new Error(`no table ${index}`);
    return found;
  };
  const unitsPerEm = view.getUint16(table(TABLE.head).offset + 18);
  const numberOfHMetrics = view.getUint16(table(TABLE.hhea).offset + 34);
  const numGlyphs = view.getUint16(table(TABLE.maxp).offset + 4);
  // A transformed hmtx starts with a flags byte, then the advances alone; a plain one interleaves
  // each advance with its left side bearing.
  const hmtx = table(TABLE.hmtx);
  const [start, stride] = hmtx.transformed ? [hmtx.offset + 1, 2] : [hmtx.offset, 4];
  const advances = Array.from({ length: numGlyphs }, (_, glyph) =>
    view.getUint16(start + Math.min(glyph, numberOfHMetrics - 1) * stride),
  );
  return { unitsPerEm, advances };
}

/** The advances in `woff2` that aren't one cell's. */
export function offCell(woff2: Uint8Array): number[] {
  const { unitsPerEm, advances } = metrics(woff2);
  const cell = (CELL_ADVANCE * unitsPerEm) / 1000;
  return [...new Set(advances.filter((advance) => advance !== cell))];
}

export interface Recorded {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

const RECORD = /^- `([\w.-]+\.woff2)`: (\d+) bytes, sha256 `([0-9a-f]{64})`$/gm;

/** The files a README written by `readme` records. */
export const recorded = (text: string): Recorded[] =>
  [...text.matchAll(RECORD)].map(([, name = "", bytes = "", hash = ""]) => ({
    name,
    bytes: Number(bytes),
    sha256: hash,
  }));

/** The font directory's README: where the files came from, and the hashes the test holds them to. */
export function readme(files: readonly Recorded[]): string {
  const rows = files.map((f) => `- \`${f.name}\`: ${f.bytes} bytes, sha256 \`${f.sha256}\``);
  return `# The terminal's font

JetBrainsMono Nerd Font Mono, cut from the Nerd Fonts ${RELEASE} release, JetBrains Mono 2.304
patched with Nerd Fonts' icons. Generated by \`pnpm font:terminal\` (\`scripts/terminal-font.ts\`);
don't edit these files by hand.

- Archive: ${ARCHIVE_URL}
- Archive sha256: \`${ARCHIVE_SHA256}\`, as GitHub lists it for the release asset
- Cut with \`${FONTTOOLS}\` (\`uvx --from '${FONTTOOLS}' fonttools subset\`)

The Mono faces give every glyph, icons included, the same 600/1000 advance, so an icon fills one
cell. The icons are the same glyphs in every face, so they ship once:

- \`JetBrainsMonoNFM-<face>.woff2\`: each upstream Mono face with its private-use code points
  (U+E000–F8FF and plane 15) removed.
- \`${SYMBOLS_FILE}\`: the ${SYMBOLS_SOURCE} face's private-use code points only.

Together they hold every code point of the upstream faces; the script checks that before it
writes them. \`symbols-ranges.json\` lists the symbols face's code points, as inclusive runs.

## Licence

The licence notice ships with the page, at \`apps/web/public/fonts/LICENSE.txt\`: JetBrains Mono's
OFL 1.1 and the icon sets' licences, from the archive's \`OFL.txt\` and \`README.md\`.

The OFL keeps a Reserved Font Name from a modified version, and these faces are cut from the
originals. JetBrains Mono declares none: the copyright line of the archive's \`OFL.txt\`, which is
where the OFL puts one ("Copyright … with Reserved Font Name …"), is only
"Copyright 2020 The JetBrains Mono Project Authors". Upstream's own
[OFL.txt](https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt) reads the same. Of the
icon sets, Pomicons reserves the name Pomicons (its own LICENSE: "with Reserved Font Name
Pomicons"), which none of these faces is called.

## Files

${rows.join("\n")}
`;
}

const uvx = (args: string[]) =>
  execFileSync("uvx", ["--quiet", "--from", FONTTOOLS, "fonttools", ...args], {
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });

const cmapOfFile = (path: string) =>
  cmapOf(String(uvx(["ttx", "-q", "-t", "cmap", "-o", "-", path])));

function subset(source: string, out: string, unicodes: string): void {
  uvx([
    "subset",
    source,
    `--unicodes=${unicodes}`,
    "--flavor=woff2",
    "--layout-features=*",
    "--name-IDs=*",
    "--notdef-outline",
    `--output-file=${out}`,
  ]);
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "terminal-font-"));
  try {
    const response = await fetch(ARCHIVE_URL);
    if (!response.ok) throw new Error(`${ARCHIVE_URL}: ${response.status}`);
    const archive = new Uint8Array(await response.arrayBuffer());
    const got = sha256(archive);
    if (got !== ARCHIVE_SHA256) throw new Error(`archive sha256 is ${got}, not ${ARCHIVE_SHA256}`);
    const tarball = join(work, "JetBrainsMono.tar.xz");
    writeFileSync(tarball, archive);
    execFileSync("tar", ["-xJf", tarball, "-C", work], { stdio: "inherit" });

    const symbolsSource = cmapOfFile(join(work, upstream(SYMBOLS_SOURCE)));
    const symbols = [...symbolsSource].filter(isPrivateUse);
    const outputs = [];
    for (const face of TEXT_FACES) {
      const source = join(work, upstream(face));
      const all = cmapOfFile(source);
      const icons = [...all].filter(isPrivateUse);
      if (icons.length !== symbols.length || icons.some((cp) => !symbolsSource.has(cp))) {
        throw new Error(`${face} has other icons than ${SYMBOLS_SOURCE}`);
      }
      const text = [...all].filter((cp) => !isPrivateUse(cp));
      const out = join(FONT_DIR, textFile(face));
      subset(source, out, unicodesArg(runs(text)));
      const cut = new Set([...cmapOfFile(out), ...symbols]);
      const lost = [...all].filter((cp) => !cut.has(cp));
      if (lost.length > 0) throw new Error(`${face} lost ${unicodesArg(runs(lost))}`);
      outputs.push(out);
    }
    const symbolsOut = join(FONT_DIR, SYMBOLS_FILE);
    subset(join(work, upstream(SYMBOLS_SOURCE)), symbolsOut, unicodesArg(PRIVATE_USE));
    const cutSymbols = cmapOfFile(symbolsOut);
    if (cutSymbols.size !== symbols.length || symbols.some((cp) => !cutSymbols.has(cp))) {
      throw new Error(`${SYMBOLS_FILE} doesn't hold exactly ${SYMBOLS_SOURCE}'s icons`);
    }
    outputs.push(symbolsOut);
    for (const out of outputs) {
      const off = offCell(readFileSync(out));
      if (off.length > 0) throw new Error(`${out} has glyphs ${off.join(", ")} wide, not one cell`);
    }

    const symbolRuns = runs(symbols);
    writeFileSync(
      join(FONT_DIR, "symbols-ranges.json"),
      `[\n${symbolRuns.map(([lo, hi]) => `  [${lo}, ${hi}]`).join(",\n")}\n]\n`,
    );
    const read = (name: string) => readFileSync(join(work, name), "utf8");
    writeFileSync(NOTICE, notice(read("OFL.txt"), iconSets(read("README.md"))));
    const files = outputs.map((path) => {
      const bytes = readFileSync(path);
      return { name: path.slice(FONT_DIR.length), bytes: bytes.length, sha256: sha256(bytes) };
    });
    writeFileSync(join(FONT_DIR, "README.md"), readme(files));
    for (const f of files) console.log(`font:terminal: ${f.name} ${f.bytes} bytes`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (isMain(import.meta)) await main();
