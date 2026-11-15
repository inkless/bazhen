import { describe, expect, it } from "vitest";
import { signallingWork } from "./falsify-signals.ts";
import { SIGNALS_IGNORE } from "./signal-paths.ts";

const failing = () => {
  throw new Error("fatal: bad object");
};

describe("signallingWork", () => {
  const SIGNALS =
    'import { signalGroup } from "@bazhen/host-guard";\nsignalGroup(child, "SIGTERM");\n';
  const files: Record<string, Record<string, string>> = {
    base: { "packages/a/src/was.ts": SIGNALS, "packages/a/src/now.ts": "export {};\n" },
    head: {
      "packages/a/src/was.ts": "export {};\n",
      "packages/a/src/now.ts": SIGNALS,
      "packages/a/src/never.ts": "export {};\n",
      "tests/holder/close.test.ts": "export {};\n",
      "packages/a/src/x.test.ts": "export {};\n",
      "crates/x/src/lib.rs": `#[test]\n#[ignore = "${SIGNALS_IGNORE}"]\nfn sweeps() {}\n`,
      "crates/x/src/plain.rs": "#[test]\nfn plain() {}\n",
    },
  };
  const read = (rev: string, path: string) => files[rev]?.[path];

  it("counts a file that signals as either the base or HEAD has it", () => {
    const sources = ["packages/a/src/was.ts", "packages/a/src/now.ts", "packages/a/src/never.ts"];
    expect(signallingWork(sources, [], ["base", "head"], read).sources).toEqual([
      "packages/a/src/was.ts",
      "packages/a/src/now.ts",
    ]);
  });

  it("counts a file it can't read as signalling", () => {
    expect(
      signallingWork(
        ["packages/a/src/never.ts"],
        ["packages/a/src/x.test.ts"],
        ["b", "h"],
        failing,
      ),
    ).toEqual({ sources: ["packages/a/src/never.ts"], tests: ["packages/a/src/x.test.ts"] });
  });

  it("passes on a git child killed by a signal, which is the run being stopped", () => {
    const interrupted = Object.assign(new Error("killed"), { signal: "SIGINT" });
    const stopped = () => {
      throw interrupted;
    };
    expect(() => signallingWork(["packages/a/src/never.ts"], [], ["b", "h"], stopped)).toThrow(
      interrupted,
    );
  });

  it("counts a test file of the holder suite or one with a test ignored as signalling", () => {
    const tests = [
      "tests/holder/close.test.ts",
      "packages/a/src/x.test.ts",
      "crates/x/src/lib.rs",
      "crates/x/src/plain.rs",
      "packages/a/src/gone.test.ts",
    ];
    expect(signallingWork([], tests, ["base", "head"], read).tests).toEqual([
      "tests/holder/close.test.ts",
      "crates/x/src/lib.rs",
    ]);
  });
});
