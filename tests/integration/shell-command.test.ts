import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellCommand } from "@bazhen/runtime-tmux";

// The shells a user may paste an attach command into, installed in the test image: each must
// read the line back as the words it was made from.
const SHELLS = ["/usr/bin/fish", "/bin/bash", "/usr/bin/zsh", "/bin/sh"];
const HOSTILE = [
  "it's",
  'say "hi"',
  "a\\b",
  "a\\'b",
  "$HOME",
  "$7",
  "x;y",
  "#{pane_id}",
  "* ?",
  "=tmux",
  "%1",
  "~",
  "{a,b}",
  "--",
  "",
];

const env = { PATH: process.env["PATH"] ?? "", HOME: "/nonexistent" };

describe.each(SHELLS)("a command pasted into %s", (shell) => {
  it("reaches the program as the same words, quotes, backslashes and expansions included", () => {
    const line = `printf '<%s>\\n' ${shellCommand(HOSTILE)}`;
    const out = execFileSync(shell, ["-c", line], {
      env,
      encoding: "utf8",
    });
    expect(out).toBe(HOSTILE.map((w) => `<${w}>\n`).join(""));
  });
});
