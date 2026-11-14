import { describe, expect, it } from "vitest";
import { processArgs } from "./index.ts";

/** What `env` is given after its own options: the pane's assignments, then the program. */
const wrapperArgs = (env: Record<string, string>) => {
  const args = processArgs({ argv: ["claude", "--"], cwd: "/work", env, generation: 0 });
  return args.slice(args.indexOf("TMUX_PANE") + 2);
};

describe("a pane's process arguments", () => {
  it("give the program 24-bit colour when the spec names none, on any tmux", () => {
    expect(wrapperArgs({})).toEqual(["COLORTERM=truecolor", "claude", "--"]);
  });

  it("give the program the COLORTERM the spec carries, which a passthrough chose", () => {
    expect(wrapperArgs({ COLORTERM: "16color" })).toEqual(["COLORTERM=16color", "claude", "--"]);
  });
});
