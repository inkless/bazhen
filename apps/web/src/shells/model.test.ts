import { describe, expect, it } from "vitest";
import type { Shell } from "@bazhen/protocol";
import { age, shellCount, shellLabel, standaloneGroups } from "./model.ts";

const agentId = "agent_0190000000007000800000000000aaaa";
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

  it("counts an agent's shells and the busy ones, and no one else's", () => {
    const shells = [
      shell({ linkedAgentId: agentId, foreground: running("nvim") }),
      shell({ linkedAgentId: agentId }),
      shell({ foreground: running("htop") }),
    ];
    expect(shellCount(shells, agentId)).toEqual({ total: 2, busy: 1 });
  });

  it("groups standalone shells by directory, by name, leaving linked ones out", () => {
    const groups = standaloneGroups([
      shell({ cwd: "/work/web" }),
      shell({ cwd: "/work/api" }),
      shell({ cwd: "/work/web" }),
      shell({ cwd: "/work/api", linkedAgentId: agentId }),
    ]);
    expect(groups.map((g) => [g.dir, g.shells.length])).toEqual([
      ["/work/api", 1],
      ["/work/web", 2],
    ]);
  });

  it("says how long something has run in the largest whole unit", () => {
    const at = Date.parse("2026-11-13T00:00:00.000Z");
    const since = (ms: number) => new Date(at - ms).toISOString();
    expect([
      age(since(40_000), at),
      age(since(12 * 60_000), at),
      age(since(3 * 3_600_000), at),
      age(since(2 * 86_400_000), at),
    ]).toEqual(["40s", "12m", "3h", "2d"]);
  });
});
