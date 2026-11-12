import { describe, expect, it } from "vitest";
import { parseSuites, pins } from "./test-real.ts";

const repo: Record<string, string> = {
  ".nvmrc": "26.13.0\n",
  "package.json": JSON.stringify({ packageManager: "pnpm@12.16.1" }),
  "tests/e2e/package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1.64.1" } }),
};
const read = (files: Record<string, string>) => (path: string) => files[path] ?? "";

describe("pnpm test:real", () => {
  it("runs the suites it is given, once each and in order, or integration, api and e2e", () => {
    expect(parseSuites([])).toEqual(["integration", "api", "e2e"]);
    expect(parseSuites(["falsify", "api", "falsify"])).toEqual(["falsify", "api"]);
  });

  it("refuses a suite it does not know rather than running none", () => {
    expect(() => parseSuites(["api", "medium"])).toThrow("unknown suite medium");
  });

  it("builds the image on the repository's own node, pnpm and Playwright pins", () => {
    expect(pins(read(repo))).toEqual({
      NODE_VERSION: "26.13.0",
      PNPM_VERSION: "12.16.1",
      PLAYWRIGHT_VERSION: "1.64.1",
    });
  });

  it("refuses to build when a pin is missing", () => {
    expect(() => pins(read({ ...repo, "package.json": "{}" }))).toThrow("not pinned");
  });
});
