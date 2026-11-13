import { describe, expect, it } from "vitest";
import { InvalidConfig, resolveConfig } from "./config.ts";

const file = {
  daemon: { port: 8100 },
  bank: { path: "/bank" },
  agents: { env: { deny: ["SECRET_*"], passthrough: ["TERM"] } },
};

describe("resolveConfig", () => {
  it("takes the defaults with no flag, variable or file", () => {
    expect(resolveConfig({}, {})).toEqual({
      port: 7900,
      bank: undefined,
      loginShell: undefined,
      envRules: { deny: [], passthrough: [] },
      externalOrigins: [],
    });
  });

  it("takes the file over the defaults", () => {
    expect(resolveConfig(file, {})).toEqual({
      port: 8100,
      bank: "/bank",
      loginShell: undefined,
      envRules: { deny: ["SECRET_*"], passthrough: ["TERM"] },
      externalOrigins: [],
    });
  });

  it("lists the origins the user's own route to the daemon presents", () => {
    const web = { web: { external_origins: ["https://bazhen.example.com"] } };
    expect(resolveConfig(web, {}).externalOrigins).toEqual(["https://bazhen.example.com"]);
  });

  it("takes external origins from the environment over the file, and refuses one that isn't", () => {
    const web = { web: { external_origins: ["https://bazhen.example.com"] } };
    const env = { BAZHEN_EXTERNAL_ORIGINS: "https://a.example.com, http://b.example.com:8080" };
    expect(resolveConfig(web, env).externalOrigins).toEqual([
      "https://a.example.com",
      "http://b.example.com:8080",
    ]);
    expect(() => resolveConfig({}, { BAZHEN_EXTERNAL_ORIGINS: "a.example.com" })).toThrow(
      InvalidConfig,
    );
  });

  it("takes the environment over the file", () => {
    expect(resolveConfig(file, { BAZHEN_PORT: "8200" }).port).toBe(8200);
  });

  it("starts agents through the user's login shell only when asked", () => {
    const login = { agents: { shell: "login" as const } };
    expect(resolveConfig(login, { SHELL: "/bin/zsh" }).loginShell).toBe("/bin/zsh");
    expect(resolveConfig({}, { SHELL: "/bin/zsh" }).loginShell).toBeUndefined();
    expect(resolveConfig({}, { SHELL: "/bin/zsh", BAZHEN_AGENTS_SHELL: "login" }).loginShell).toBe(
      "/bin/zsh",
    );
  });

  it.each([{}, { SHELL: "zsh" }])("refuses a login shell it can't find (%o)", (env) => {
    expect(() => resolveConfig({ agents: { shell: "login" } }, env)).toThrow(InvalidConfig);
  });

  it("treats an empty variable as unset", () => {
    expect(resolveConfig(file, { BAZHEN_PORT: "" }).port).toBe(8100);
  });

  it.each([
    ["BAZHEN_PORT", "eighty"],
    ["BAZHEN_PORT", "70000"],
  ])("refuses %s=%s, naming it", (name, value) => {
    expect(() => resolveConfig({}, { [name]: value })).toThrow(
      new InvalidConfig(`${name}=${value}`).message,
    );
  });
});
