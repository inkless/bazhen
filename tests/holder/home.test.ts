import { statSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { holderSocket, holdersDir, RUN_ENV, testHome } from "../support/holder-home.ts";
import { scrubBazhenEnv } from "../support/holder-setup.ts";

describe("the holder tests' home", () => {
  it("is a temporary directory under /tmp, with its holders' directory private", () => {
    expect(testHome()).toMatch(/^\/tmp\/bz-h-/);
    expect(statSync(holdersDir(testHome())).mode & 0o777).toBe(0o700);
  });

  it("refuses a terminal id that would put its socket outside the home", () => {
    expect(() => holderSocket("../../elsewhere")).toThrow(/no terminal id/);
  });

  it("drops the variables that would point a Bazhen CLI at a real daemon", () => {
    const env = { BAZHEN_SOCKET: "/run/bazhen.sock", BAZHEN_AGENT_ID: "a1", PATH: "/bin" };
    scrubBazhenEnv(env);
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("carries no Bazhen variable into the tests but its own home", () => {
    expect(Object.keys(process.env).filter((name) => name.startsWith("BAZHEN_"))).toEqual([
      "BAZHEN_HOME",
    ]);
  });

  it("keeps the longest holder socket path within the 103 bytes a Unix socket allows on macOS", () => {
    expect(Buffer.byteLength(holderSocket("x".repeat(64)))).toBeLessThanOrEqual(103);
  });

  it("refuses a BAZHEN_HOME the run didn't make", () => {
    const real = { ...process.env, BAZHEN_HOME: `${homedir()}/.local/share/bazhen` };
    expect(() => testHome(real)).toThrow(/Refusing BAZHEN_HOME/);
    expect(() => holderSocket("t1", real)).toThrow(/Refusing BAZHEN_HOME/);
  });

  it("refuses this run's home when the run named is another", () => {
    expect(() => testHome({ ...process.env, [RUN_ENV]: "another run" })).toThrow(
      /Refusing BAZHEN_HOME/,
    );
  });
});
