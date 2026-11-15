import { statSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  holderEnv,
  holderProcessSpec,
  holderSocket,
  holdersDir,
  requireHolderEnv,
  RUN_ENV,
  testHome,
} from "../support/holder-home.ts";
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

const XDG_NAMES = [
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
];

const without = (env: Record<string, string>, name: string) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));

describe("a holder test's child environment", () => {
  it("keeps HOME, XDG_* and tmux's socket directory in the run's home, and no TMUX", () => {
    const home = testHome();
    const env = holderEnv({ LANG: "C.UTF-8" });
    expect(env).toMatchObject({
      BAZHEN_HOME: home,
      HOME: `${home}/home`,
      TMUX_TMPDIR: `${home}/tmux`,
      XDG_CONFIG_HOME: `${home}/home/.config`,
      XDG_RUNTIME_DIR: `${home}/home/run`,
      LANG: "C.UTF-8",
    });
    expect(
      Object.keys(env)
        .filter((name) => name.startsWith("XDG_"))
        .toSorted(),
    ).toEqual(XDG_NAMES);
    expect(env).not.toHaveProperty("TMUX");
    for (const dir of [env["HOME"], env["XDG_RUNTIME_DIR"]]) {
      expect(statSync(String(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it("lets no extra variable point the child back at the user's own", () => {
    expect(holderEnv({ HOME: homedir() })["HOME"]).toBe(`${testHome()}/home`);
    expect(() => holderEnv({ TMUX: "/tmp/tmux-1000/default,1,0" })).toThrow(/TMUX/);
    expect(() => holderEnv({ ZDOTDIR: homedir() })).toThrow(/ZDOTDIR/);
  });

  it.each<[string, (env: Record<string, string>) => Record<string, string>, string]>([
    ["with TMUX_TMPDIR missing", (env) => without(env, "TMUX_TMPDIR"), "TMUX_TMPDIR"],
    ["with the user's HOME", (env) => ({ ...env, HOME: homedir() }), "HOME"],
    [
      "with the user's config directory",
      (env) => ({ ...env, XDG_CONFIG_HOME: `${homedir()}/.config` }),
      "XDG_CONFIG_HOME",
    ],
    ["without the refusal first on PATH", (env) => ({ ...env, PATH: "/usr/bin:/bin" }), "PATH"],
    ["inside a tmux client", (env) => ({ ...env, TMUX: "/tmp/tmux-1000/default,1,0" }), "TMUX"],
  ])("refuses an environment %s", (_, change, name) => {
    expect(() => requireHolderEnv(change(holderEnv()))).toThrow(
      new RegExp(`Refusing .*\\b${name}\\b`),
    );
  });

  it("builds a process spec that runs in the run's HOME, with the child's environment", () => {
    const spec = holderProcessSpec(["sh", "-i"], { LANG: "C.UTF-8" });
    expect(spec).toEqual({
      argv: ["sh", "-i"],
      cwd: `${testHome()}/home`,
      env: holderEnv({ LANG: "C.UTF-8" }),
      generation: 0,
    });
  });
});
