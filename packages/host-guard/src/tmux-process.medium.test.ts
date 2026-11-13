import { describe, expect, it } from "vitest";
import { processFacts } from "./tmux.ts";

describe("what ps says of a process", () => {
  it("reads this process's command, start and argument line", async () => {
    const started = Date.now() / 1000 - process.uptime();
    expect(await processFacts(process.pid)).toEqual({
      comm: expect.stringMatching(/(^|\/)node$/),
      start: expect.toSatisfy((start: number) => Math.abs(start - started) <= 2),
      args: expect.stringContaining(String(process.argv[1])),
    });
  });

  it("finds nothing for a pid no process has", async () => {
    // Above every system's pid limit (Linux's 2^22, macOS's 99999).
    expect(await processFacts(2 ** 22 + 1)).toBeUndefined();
  });
});
