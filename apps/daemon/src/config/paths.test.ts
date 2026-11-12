import { describe, expect, it } from "vitest";
import { resolvePaths, type PathInputs } from "./paths.ts";

const linux: PathInputs = { platform: "linux", env: {}, home: "/home/u", tmp: "/tmp", uid: 1000 };
const mac: PathInputs = {
  platform: "darwin",
  env: {},
  home: "/Users/u",
  tmp: "/var/folders/xy/T",
  uid: 501,
};

describe("resolvePaths", () => {
  it("uses XDG defaults on Linux when no XDG variables are set", () => {
    const p = resolvePaths(linux);
    expect(p.data).toBe("/home/u/.local/share/bazhen");
    expect(p.config).toBe("/home/u/.config/bazhen");
    expect(p.bank).toBe("/home/u/.local/share/bazhen/bank");
  });

  it("uses the same XDG layout on macOS, not ~/Library", () => {
    const p = resolvePaths(mac);
    expect([p.config, p.data, p.state, p.cache]).toEqual([
      "/Users/u/.config/bazhen",
      "/Users/u/.local/share/bazhen",
      "/Users/u/.local/state/bazhen",
      "/Users/u/.cache/bazhen",
    ]);
  });

  it("ignores a relative XDG variable, as the XDG spec requires", () => {
    expect(resolvePaths({ ...linux, env: { XDG_DATA_HOME: "relative/dir" } }).data).toBe(
      "/home/u/.local/share/bazhen",
    );
  });

  it("keeps the runtime directory in XDG_RUNTIME_DIR on Linux and in TMPDIR on macOS", () => {
    expect(resolvePaths({ ...linux, env: { XDG_RUNTIME_DIR: "/run/user/1000" } }).run).toBe(
      "/run/user/1000/bazhen",
    );
    expect(resolvePaths(mac).socket).toBe("/var/folders/xy/T/bazhen/bazhen.sock");
  });

  it("falls back to a per-user /tmp directory when Linux has no XDG_RUNTIME_DIR", () => {
    expect(resolvePaths(linux).socket).toBe("/tmp/bazhen-1000/bazhen.sock");
  });

  it("moves the runtime directory to /tmp when the socket path would not fit in sun_path", () => {
    const deep = `/x/${"d".repeat(100)}`;
    const p = resolvePaths({ ...linux, env: { BAZHEN_HOME: deep } });
    expect(p.run).toMatch(/^\/tmp\/bazhen-1000-[0-9a-f]{8}$/);
    expect(Buffer.byteLength(p.socket)).toBeLessThanOrEqual(103);
  });

  it("relocates everything under BAZHEN_HOME", () => {
    const p = resolvePaths({ ...mac, env: { BAZHEN_HOME: "/x" } });
    expect([p.config, p.data, p.run, p.bank]).toEqual([
      "/x/config",
      "/x/data",
      "/x/run",
      "/x/data/bank",
    ]);
  });

  it("gives each BAZHEN_HOME its own tmux server, and the default home the bazhen server", () => {
    const a = resolvePaths({ ...linux, env: { BAZHEN_HOME: "/a" } }).tmuxSocket;
    const b = resolvePaths({ ...linux, env: { BAZHEN_HOME: "/b" } }).tmuxSocket;
    expect([resolvePaths(linux).tmuxSocket, a === b]).toEqual(["bazhen", false]);
    expect(a).toMatch(/^bazhen-[0-9a-f]{8}$/);
  });

  it("lets a flag beat the environment, and the environment beat the config file", () => {
    const env = { BAZHEN_BANK: "/env-bank" };
    expect(resolvePaths({ ...linux, env, configBank: "/cfg-bank" }).bank).toBe("/env-bank");
    expect(resolvePaths({ ...linux, env, flags: { bank: "/flag-bank" } }).bank).toBe("/flag-bank");
    expect(resolvePaths({ ...linux, configBank: "/cfg-bank" }).bank).toBe("/cfg-bank");
  });

  it("lets a --home flag beat BAZHEN_HOME, tmux server included", () => {
    const flagged = resolvePaths({
      ...linux,
      env: { BAZHEN_HOME: "/env" },
      flags: { home: "/flag" },
    });
    const flagOnly = resolvePaths({ ...linux, flags: { home: "/flag" } });
    expect([flagged.data, flagged.tmuxSocket]).toEqual(["/flag/data", flagOnly.tmuxSocket]);
    expect(flagged.tmuxSocket).not.toBe(
      resolvePaths({ ...linux, env: { BAZHEN_HOME: "/env" } }).tmuxSocket,
    );
  });
});
