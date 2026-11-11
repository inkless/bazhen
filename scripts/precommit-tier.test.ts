import { describe, expect, it } from "vitest";
import { tier, type Tier } from "./precommit-tier.ts";

const cases: [string, string[], Tier][] = [
  ["docs only", ["AGENTS.md", "docs/standards/testing.md", ".agents/skills/bz-x/SKILL.md"], "docs"],
  [
    "a script under .agents",
    [".agents/skills/bz-x/SKILL.md", ".agents/skills/bz-x/run.sh"],
    "fast",
  ],
  ["a rename out of source, by its new path", ["docs/notes.md", "packages/core/src/x.ts"], "full"],
  [
    "a rename out of source, by its old path",
    ["packages/protocol/src/x.ts", "scripts/x.ts"],
    "full",
  ],
  ["a protocol change", ["packages/protocol/src/messages.ts"], "full"],
  ["the workspace file", ["pnpm-workspace.yaml"], "full"],
  ["a test package manifest", ["tests/e2e/package.json"], "full"],
  ["a web change", ["apps/web/src/App.tsx", "scripts/falsify.ts"], "fast"],
  ["nothing staged", [], "docs"],
];

describe("tier", () => {
  it.each(cases)("puts %s in its tier", (_, paths, expected) => {
    expect(tier(paths)).toBe(expected);
  });
});
