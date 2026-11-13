import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { filterEnv, newId } from "@bazhen/core";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { testServer } from "./helpers.ts";

const server = testServer("foreground");
const runtime = new TmuxRuntime({ server, pty: nodePtySpawner, env: filterEnv(process.env).env });
afterAll(() => server.kill());

/** A terminal running `sleep` in `cwd`, and what one read of its foreground says of it. */
async function readIn(cwd: string) {
  const terminalId = newId("term");
  const tags = { kind: "shell" } as const;
  const spec = { terminalId, tags, cwd, env: {}, size: { cols: 80, rows: 24 }, generation: 0 };
  await runtime.create({ ...spec, argv: ["sleep", "300"] });
  return (await runtime.foregrounds(new Set([terminalId])))[0];
}

describe("a terminal's directory, as its foreground read gives it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bz-cwd-")));
  const dir = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  };

  it("is the path whole", async () => {
    const plain = dir("plain dir");
    expect((await readIn(plain))?.cwd).toBe(plain);
  });

  it("is none for a path tmux would print cut short, by a tab or a newline in it", async () => {
    dir("a");
    const tabbed = await readIn(dir("a\tb"));
    const broken = await readIn(dir("a\nb"));
    expect([tabbed?.command, tabbed?.cwd, broken?.command, broken?.cwd]).toEqual([
      "sleep",
      null,
      "sleep",
      null,
    ]);
  });
});
