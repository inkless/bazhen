import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detach } from "./detach.ts";
import { fullBacklog } from "./testing/full-backlog.ts";

let dir = "";
let backlog: { close(): Promise<void> } | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await backlog?.close();
  backlog = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("detach", () => {
  it.runIf(process.platform === "linux")(
    "refuses a socket something holds without answering, and starts nothing",
    async () => {
      dir = mkdtempSync("/tmp/bz-detach-");
      const socket = join(dir, "bazhen.sock");
      backlog = await fullBacklog(socket);
      const said = vi.spyOn(console, "error").mockImplementation(() => {});
      const code = await detach({
        // A daemon started here would fail at once, and the wait for it would say so.
        entry: join(dir, "no-such-entry.ts"),
        socket,
        stateDir: dir,
        url: "http://127.0.0.1:1",
        env: {},
        envRules: {},
      });
      expect([code, said.mock.calls.map(([line]) => String(line))]).toEqual([
        1,
        [
          expect.stringMatching(
            new RegExp(`^bazhen won't start over ${socket}: something may hold it`),
          ),
        ],
      ]);
    },
    // Past the 10 s a start that went ahead would wait, so it fails on what was said.
    15_000,
  );
});
