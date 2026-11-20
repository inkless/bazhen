import { describe, expect, it } from "vitest";
import { HOLDER_SOCKET_MAX_BYTES, holderSocket } from "@bazhen/host-guard";
import { resolvePaths, type PathInputs } from "./paths.ts";

const linux: PathInputs = { platform: "linux", env: {}, home: "/home/u", tmp: "/tmp", uid: 1000 };
const mac: PathInputs = {
  platform: "darwin",
  env: {},
  home: "/Users/u",
  tmp: "/var/folders/xy/T",
  uid: 501,
};

const tmux = (home: string) => resolvePaths({ ...linux, env: { BAZHEN_HOME: home } }).tmuxSocket;

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

  it("refuses a relative HOME, unless a home of Bazhen's own is named", () => {
    expect(() => resolvePaths({ ...linux, home: "rel" })).toThrow(
      new RangeError("HOME must be an absolute path, not rel"),
    );
    expect(resolvePaths({ ...linux, home: "rel", env: { BAZHEN_HOME: "/b" } }).data).toBe(
      "/b/data",
    );
  });

  it("ignores a relative XDG variable, as the XDG spec requires", () => {
    expect(resolvePaths({ ...linux, env: { XDG_DATA_HOME: "relative/dir" } }).data).toBe(
      "/home/u/.local/share/bazhen",
    );
  });

  it("keeps the runtime directory in XDG_RUNTIME_DIR on Linux and in TMPDIR on macOS", () => {
    const p = resolvePaths({ ...linux, env: { XDG_RUNTIME_DIR: "/run/user/1000" } });
    expect([p.run, p.holderRun]).toEqual(["/run/user/1000/bazhen", "/run/user/1000/bazhen"]);
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

  it("moves the holders when a macOS runtime directory fits only the daemon socket", () => {
    const tmp = `/var/folders/xy/${"d".repeat(30)}/T`;
    const p = resolvePaths({ ...mac, tmp });
    const terminal = "term_01a1f67bfc13789caade029e6d1b6582";
    expect(Buffer.byteLength(holderSocket(p.holderRun, terminal))).toBeLessThanOrEqual(
      HOLDER_SOCKET_MAX_BYTES,
    );
    expect(p.holderRun).toBe("/tmp/bazhen-holders-501-a71017ba");
    expect(p.socket).toBe(`${tmp}/bazhen/bazhen.sock`);
    expect(p.tmuxSocket).toBe(`${tmp}/bazhen/tmux.sock`);
    const atLimit = resolvePaths({ ...mac, tmp: `/var/folders/xy/${"d".repeat(27)}/T` });
    expect(atLimit.holderRun).toBe(atLimit.run);
  });

  it("keeps Linux daemon and tmux sockets reachable with a long XDG_RUNTIME_DIR", () => {
    const runtime = `/run/user/1000/${"d".repeat(38)}`;
    const p = resolvePaths({ ...linux, env: { XDG_RUNTIME_DIR: runtime } });
    expect(p.socket).toBe(`${runtime}/bazhen/bazhen.sock`);
    expect(p.tmuxSocket).toBe(`${runtime}/bazhen/tmux.sock`);
    expect(p.holderRun).toMatch(/^\/tmp\/bazhen-holders-1000-[0-9a-f]{8}$/);
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

  it("gives each home a tmux server of its own, by a socket in its private runtime directory", () => {
    expect(tmux("/a")).toBe("/a/run/tmux.sock");
    expect(resolvePaths(linux).tmuxSocket).toBe("/tmp/bazhen-1000/tmux.sock");
    expect(resolvePaths({ ...mac, env: { BAZHEN_TMUX_SOCKET: "default" } }).tmuxSocket).toBe(
      "/var/folders/xy/T/bazhen/tmux.sock",
    );
  });

  it("treats /a and /a/ as one home, and refuses a relative one", () => {
    expect(tmux("/a/")).toBe(tmux("/a"));
    expect(() => tmux("a")).toThrow(RangeError);
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
