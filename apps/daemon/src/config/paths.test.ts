import { describe, expect, it } from "vitest";
import { resolvePaths, type PathInputs } from "./paths.ts";

const linux: PathInputs = { platform: "linux", env: {}, home: "/home/u", tmp: "/tmp", uid: 1000 };
const mac: PathInputs = {
  platform: "darwin",
  env: {},
  home: "/Users/u",
  tmp: "/var/tmp",
  uid: 501,
};

describe("resolvePaths", () => {
  it("uses XDG defaults on Linux when no XDG variables are set", () => {
    const p = resolvePaths(linux);
    expect(p.data).toBe("/home/u/.local/share/bazhen");
    expect(p.config).toBe("/home/u/.config/bazhen");
    expect(p.bank).toBe("/home/u/.local/share/bazhen/bank");
  });

  it("ignores a relative XDG variable, as the XDG spec requires", () => {
    expect(resolvePaths({ ...linux, env: { XDG_DATA_HOME: "relative/dir" } }).data).toBe(
      "/home/u/.local/share/bazhen",
    );
  });

  it("uses Library locations on macOS", () => {
    const p = resolvePaths(mac);
    expect(p.data).toBe("/Users/u/Library/Application Support/Bazhen");
    expect(p.state).toBe("/Users/u/Library/Logs/Bazhen");
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

  it("lets a flag beat the environment, and the environment beat the config file", () => {
    const env = { BAZHEN_BANK: "/env-bank" };
    expect(resolvePaths({ ...linux, env, configBank: "/cfg-bank" }).bank).toBe("/env-bank");
    expect(resolvePaths({ ...linux, env, flags: { bank: "/flag-bank" } }).bank).toBe("/flag-bank");
    expect(resolvePaths({ ...linux, configBank: "/cfg-bank" }).bank).toBe("/cfg-bank");
  });
});
