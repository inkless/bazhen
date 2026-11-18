import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, UnsupportedRuntime } from "@bazhen/core";
import { TmuxServer } from "@bazhen/host-guard";
import { TmuxRuntime } from "./index.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("TmuxRuntime.screen", () => {
  it("refuses as unsupported, asking nothing of a server that never starts", async () => {
    const root = mkdtempSync("/tmp/bz-screen-");
    made.push(root);
    const server = TmuxServer.at(join(root, "tmux.sock"), {
      root,
      config: join(root, "tmux.conf"),
    });
    const pty = {
      spawn: () => {
        throw new Error("no PTY here");
      },
    };
    const tmux = new TmuxRuntime({ server, pty, env: {} });
    const ref = { terminalId: newId("term"), runtime: "tmux", locator: { sessionId: "$1" } };
    const read = tmux.screen(ref);
    await expect(read).rejects.toThrow(UnsupportedRuntime);
    await expect(read).rejects.toThrow(/runs on tmux, whose screens can't be read/u);
  });
});
