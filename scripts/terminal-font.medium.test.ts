import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_DIR, recorded, sha256, SYMBOLS_FILE, TEXT_FACES, textFile } from "./terminal-font.ts";

describe("the committed terminal font", () => {
  const files = recorded(readFileSync(join(FONT_DIR, "README.md"), "utf8"));

  it("records each face the script cuts, and no other font file is committed beside them", () => {
    const cut = [...TEXT_FACES.map(textFile), SYMBOLS_FILE];
    const present = readdirSync(FONT_DIR).filter((name) => name.endsWith(".woff2"));
    expect([files.map((f) => f.name).toSorted(), present.toSorted()]).toEqual([
      cut.toSorted(),
      cut.toSorted(),
    ]);
  });

  it("is, byte for byte, what the script wrote: the size and sha256 its README records", () => {
    const actual = files.map(({ name }) => {
      const bytes = readFileSync(join(FONT_DIR, name));
      return { name, bytes: bytes.length, sha256: sha256(bytes) };
    });
    expect(actual).toEqual(files);
  });
});
