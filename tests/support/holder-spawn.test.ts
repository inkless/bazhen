import { HOLDER_SPEC_MAX_BYTES } from "@bazhen/host-guard";
import { HOLDER_MAX_REQUEST_BYTES } from "@bazhen/protocol";
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

describe("a holder's spawn spec", () => {
  // host-guard may not depend on the protocol, so the cap it refuses specs over is pinned here.
  it("is refused over exactly the request cap a holder reads its spec under", () => {
    expect(HOLDER_SPEC_MAX_BYTES).toBe(HOLDER_MAX_REQUEST_BYTES);
  });
});
