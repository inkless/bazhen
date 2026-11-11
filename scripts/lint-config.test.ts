import { describe, expect, it } from "vitest";
import { config } from "./lint-config.ts";

const overrideFor = (glob: string) => {
  const found = config.overrides.find((o) => o.files[0] === glob);
  if (found === undefined) throw new Error(`no override for ${glob}`);
  return found;
};

const patterns = (glob: string) => overrideFor(glob).rules["no-restricted-imports"][1].patterns;

const banned = (glob: string) => patterns(glob).flatMap((p) => p.group);

describe("generated oxlint config", () => {
  it("bans every form of a core import from apps/web", () => {
    expect(banned("apps/web/**/*.ts")).toEqual(
      expect.arrayContaining([
        "@bazhen/core",
        "@bazhen/core/**",
        "**/packages/core/**",
        "**/core/src/**",
      ]),
    );
  });

  it("lets packages/core import only types from protocol", () => {
    expect(patterns("packages/core/**/*.ts")).toContainEqual(
      expect.objectContaining({
        group: expect.arrayContaining(["@bazhen/protocol"]),
        allowTypeImports: true,
      }),
    );
  });

  it("applies the small-test bans to *.test.ts but not *.medium.test.ts", () => {
    expect([
      banned("scripts/**/*.test.ts").includes("node:child_process"),
      banned("packages/core/**/*.test.ts").includes("node:http"),
      banned("apps/daemon/**/*.medium.test.ts").includes("node:fs"),
    ]).toEqual([true, true, false]);
  });
});
