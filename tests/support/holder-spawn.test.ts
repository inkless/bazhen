import { describe, expect, it } from "vitest";
import { spawnHolder } from "./holder-spawn.ts";

describe("starting a holder for a test", () => {
  // The refusal comes before the socket, the spec or the process, so this starts nothing.
  it("refuses off a disposable host, before it starts anything", async () => {
    await expect(spawnHolder("t", ["true"], { sandboxed: false })).rejects.toThrow(
      "the holder tests start holders, which signal every process in their sessions",
    );
  });
});
