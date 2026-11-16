import { describe, expect, it } from "vitest";
import { anyUnreachable, doctorRuntimeLines, runtimeLines } from "./runtimes.ts";

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

  it("warns in doctor of each defect worked around, under the runtime that has it", () => {
    const reported: Parameters<typeof doctorRuntimeLines>[0] = {
      runtime: { state: "healthy", version: "3.4" },
      runtimes: [
        { kind: "tmux", state: "healthy", version: "3.4", workarounds: ["crashes", "leaks"] },
        { kind: "holder", state: "healthy", version: "holder/1.2" },
      ],
    };
    expect([doctorRuntimeLines(reported), runtimeLines(reported)]).toEqual([
      ["tmux: healthy 3.4", "  warning: crashes", "  warning: leaks", "holder: healthy holder/1.2"],
      ["tmux: healthy 3.4", "holder: healthy holder/1.2"],
    ]);
  });
});
