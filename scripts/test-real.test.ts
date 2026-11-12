import { describe, expect, it } from "vitest";
import { looksSecret, parseArgs, pins } from "./test-real.ts";

const repo: Record<string, string> = {
  ".nvmrc": "26.13.0\n",
  "package.json": JSON.stringify({ packageManager: "pnpm@12.16.1" }),
  "tests/e2e/package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1.64.1" } }),
};
const read = (files: Record<string, string>) => (path: string) => files[path] ?? "";

describe("pnpm test:real", () => {
  it("runs the suites it is given, once each and in order, or integration, api and e2e", () => {
    expect(parseArgs([]).suites).toEqual(["integration", "api", "e2e"]);
    expect(parseArgs(["falsify", "api", "falsify"]).suites).toEqual(["falsify", "api"]);
  });

  it("judges falsify against main, or the base it is given", () => {
    expect(parseArgs(["falsify"]).base).toBe("origin/main");
    expect(parseArgs(["falsify", "--base", "gz/below"])).toEqual({
      suites: ["falsify"],
      base: "gz/below",
    });
  });

  it("refuses a suite it does not know, or a --base without a ref, rather than running none", () => {
    expect(() => parseArgs(["api", "medium"])).toThrow("unknown suite medium");
    expect(() => parseArgs(["falsify", "--base"])).toThrow("usage");
    expect(() => parseArgs(["--base", "--api"])).toThrow("usage");
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

  it("keeps a file that looks like a secret out of the image, and every other file in", () => {
    const secret = [
      ".env",
      "apps/web/.env.local",
      "certs/dev.pem",
      "x.key",
      "id_ed25519",
      ".npmrc",
    ];
    const secretToo = ["aws-credentials.json", "client_secret.json"];
    const kept = ["src/tokens.test.ts", "environment.ts", "keys.test.ts", "README.md"];
    expect([...secret, ...secretToo].filter((p) => !looksSecret(p))).toEqual([]);
    expect(kept.filter(looksSecret)).toEqual([]);
  });
});
