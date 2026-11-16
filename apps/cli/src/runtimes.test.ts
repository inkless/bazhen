import { describe, expect, it } from "vitest";
import { anyUnreachable, runtimeLines } from "./runtimes.ts";

describe("what status and doctor say about runtimes", () => {
  it("says each runtime the daemon runs terminals on, with its version", () => {
    const reported = {
      runtime: { state: "healthy", version: "3.4" },
      runtimes: [
        { kind: "tmux", state: "healthy", version: "3.4" },
        { kind: "holder", state: "not-running", version: "holder/1.2" },
      ],
    } as const;
    expect(runtimeLines(reported)).toEqual(["tmux: healthy 3.4", "holder: not-running holder/1.2"]);
  });

  it("says tmux alone for a daemon that reports only that", () => {
    expect(runtimeLines({ runtime: { state: "not-running", version: null } })).toEqual([
      "tmux: not-running",
    ]);
  });

  it("fails when any runtime can't be read, not only tmux", () => {
    const runtime = { state: "healthy", version: "3.4" } as const;
    const runtimes = [
      { kind: "tmux", ...runtime },
      { kind: "holder", state: "unreachable", version: "holder/1.2" },
    ] as const;
    expect([anyUnreachable({ runtime, runtimes }), anyUnreachable({ runtime })]).toEqual([
      true,
      false,
    ]);
  });
});
