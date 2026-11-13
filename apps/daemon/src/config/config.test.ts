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
      externalOriginsFrom: null,
      allowInsecureOrigins: false,
    });
  });

  it("takes the file over the defaults", () => {
    expect(resolveConfig(file, {})).toEqual({
      port: 8100,
      bank: "/bank",
      loginShell: undefined,
      envRules: { deny: ["SECRET_*"], passthrough: ["TERM"] },
      externalOrigins: [],
      externalOriginsFrom: null,
      allowInsecureOrigins: false,
    });
  });

  it("lists the origins the user's own route to the daemon presents, and where they came from", () => {
    const web = { web: { external_origins: ["https://bazhen.example.com"] } };
    expect(resolveConfig(web, {})).toMatchObject({
      externalOrigins: ["https://bazhen.example.com"],
      externalOriginsFrom: "config",
    });
  });

  it("takes external origins from the environment over the file, and refuses one that isn't", () => {
    const web = { web: { external_origins: ["https://bazhen.example.com"] } };
    const env = { BAZHEN_EXTERNAL_ORIGINS: "https://a.example.com, https://b.example.com:8443" };
    expect(resolveConfig(web, env)).toMatchObject({
      externalOrigins: ["https://a.example.com", "https://b.example.com:8443"],
      externalOriginsFrom: "BAZHEN_EXTERNAL_ORIGINS",
    });
    expect(() => resolveConfig({}, { BAZHEN_EXTERNAL_ORIGINS: "a.example.com" })).toThrow(
      "BAZHEN_EXTERNAL_ORIGINS: a.example.com must be an origin",
    );
  });

  it("refuses plain HTTP to another host unless it is explicitly allowed", () => {
    const plain = { web: { external_origins: ["http://bazhen.example.com"] } };
    expect(() => resolveConfig(plain, {})).toThrow(
      "web.external_origins: http://bazhen.example.com is plain HTTP to another host",
    );
    const allowed = { web: { ...plain.web, allow_insecure_origins: true } };
    expect([
      resolveConfig(allowed, {}).allowInsecureOrigins,
      resolveConfig(plain, { BAZHEN_ALLOW_INSECURE_ORIGINS: "true" }).externalOrigins,
    ]).toEqual([true, ["http://bazhen.example.com"]]);
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
