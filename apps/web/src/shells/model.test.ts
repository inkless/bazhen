import { describe, expect, it } from "vitest";
import type { Shell } from "@bazhen/protocol";
import { shellLabel } from "./model.ts";

let n = 0;
const shell = (over: Partial<Shell> = {}): Shell => ({
  id: `term_019000000000700080000000000${String(++n).padStart(5, "0")}`,
  environmentId: "env_01900000000070008000000000000001",
  state: "running",
  generation: 0,
  cwd: "/work/api",
  linkedAgentId: null,
  name: null,
  foreground: null,
  theme: "dark",
  attachCommand: "tmux attach",
  commands: ["close", "rename"],
  ...over,
});
const running = (command: string) => ({ command, since: "2026-11-13T00:00:00.000Z" });

describe("shells in the UI", () => {
  it("names a tab by the user's name, else its directory and what runs in it", () => {
    expect([
      shellLabel(shell({ name: "dev server", foreground: running("npm") })),
      shellLabel(shell({ cwd: "/work/api/" })),
      shellLabel(shell({ foreground: running("nvim") })),
    ]).toEqual(["dev server", "api", "api · nvim"]);
  });
});
