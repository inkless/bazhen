import { describe, expect, it } from "vitest";
import {
  cmapOf,
  iconSets,
  isPrivateUse,
  readme,
  recorded,
  runs,
  unicodesArg,
} from "./terminal-font.ts";

describe("cutting the terminal's font", () => {
  it("counts the private use area and plane 15 as icons, and nothing around them", () => {
    const edges = [0xdfff, 0xe000, 0xf8ff, 0xf900, 0xeffff, 0xf0000, 0xffffd, 0xffffe];
    expect(edges.map(isPrivateUse)).toEqual([false, true, true, false, false, true, true, false]);
  });

  it("writes code points as the runs pyftsubset takes, whatever their order", () => {
    expect(unicodesArg(runs([0x42, 0x41, 0x43, 0xe0b0, 0x41, 0xf0001]))).toBe("41-43,E0B0,F0001");
  });

  it("reads a font's Unicode subtables, and not a Mac Roman one's byte codes", () => {
    const ttx = `<cmap>
    <cmap_format_4 platformID="0" platEncID="3" language="0">
      <map code="0x41" name="A"/>
    </cmap_format_4>
    <cmap_format_6 platformID="1" platEncID="0" language="0">
      <map code="0x0" name="NULL"/>
      <map code="0x80" name="Adieresis"/>
    </cmap_format_6>
    <cmap_format_12 platformID="3" platEncID="10" format="12" reserved="0" length="1" language="0" nGroups="1">
      <map code="0xf0001" name="md_ab"/>
    </cmap_format_12>
    <cmap_format_4 platformID="3" platEncID="1" language="0">
      <map code="0xe0b0" name="pl_left_hard_divider"/>
    </cmap_format_4>
  </cmap>`;
    expect([...cmapOf(ttx)].toSorted((a, b) => a - b)).toEqual([0x41, 0xe0b0, 0xf0001]);
  });

  it("takes the icon sets' licence table from the archive's README", () => {
    const text =
      "# Nerd Fonts\n\n## Icon sets\n\n| set | licence |\n| a | MIT |\n\n## Which font?\n";
    expect(iconSets(text)).toBe("| set | licence |\n| a | MIT |");
    expect(() => iconSets("# Nerd Fonts\n")).toThrow(/Icon sets/);
  });

  it("reads back from its README the files and hashes it wrote there", () => {
    const files = [
      { name: "JetBrainsMonoNFM-Regular.woff2", bytes: 81_800, sha256: "a".repeat(64) },
      { name: "JetBrainsMonoNFM-Symbols.woff2", bytes: 934_024, sha256: "b".repeat(64) },
    ];
    expect(recorded(readme(files))).toEqual(files);
  });
});
