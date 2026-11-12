import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loginArgv } from "@bazhen/env-local";

// The shells users log in with, installed in the test image: the TUI's argv must reach the
// program byte for byte through each, since agents.shell = "login" hands it over as arguments.
const SHELLS = ["/usr/bin/fish", "/bin/bash", "/usr/bin/zsh", "/bin/sh"];
const HOSTILE = ["it's", 'say "hi"', "a\\b", "$HOME", "x;y", "#{pane_id}", "* ?", "--", ""];

const home = mkdtempSync(join(tmpdir(), "bz-login-"));
const env = { PATH: process.env["PATH"] ?? "", HOME: home };
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe.each(SHELLS)("a login shell (%s)", (shell) => {
  it("passes the TUI every argument exactly, quotes, backslashes and $ included", () => {
    const argv = loginArgv(shell, ["printf", "<%s>\\n", ...HOSTILE]);
    const out = execFileSync(argv[0], argv.slice(1), {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(out).toBe(HOSTILE.map((a) => `<${a}>\n`).join(""));
  });
});
