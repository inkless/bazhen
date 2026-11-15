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
      desktopNotifications: true,
      pairing: "auto",
      pairingRequired: false,
      lan: null,
      launchLimits: { maxLaunched: 5, maxDepth: 3 },
      maxOpenTerminals: 100,
    });
  });

  it("takes the file over the defaults", () => {
    expect(resolveConfig(file, {})).toEqual({
      port: 8100,
      bank: "/bank",
      loginShell: undefined,
      envRules: { deny: ["SECRET_*"], passthrough: ["TERM"] },
      desktopNotifications: true,
      externalOrigins: [],
      externalOriginsFrom: null,
      allowInsecureOrigins: false,
      pairing: "auto",
      pairingRequired: false,
      lan: null,
      launchLimits: { maxLaunched: 5, maxDepth: 3 },
      maxOpenTerminals: 100,
    });
  });

  it("takes how far agents may launch agents from the file", () => {
    const limits = { agents: { max_launched: 2, max_launch_depth: 1 } };
    expect(resolveConfig(limits, {}).launchLimits).toEqual({ maxLaunched: 2, maxDepth: 1 });
  });

  it("takes how many terminals may be open at once from the file", () => {
    expect(resolveConfig({ terminals: { max_open: 12 } }, {}).maxOpenTerminals).toBe(12);
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

  it("turns desktop notifications off only when the file says so", () => {
    const off = resolveConfig({ notifications: { desktop: false } }, {});
    expect([
      off.desktopNotifications,
      resolveConfig({ notifications: {} }, {}).desktopNotifications,
    ]).toEqual([false, true]);
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

  it("asks browsers to pair only once an external origin is set, unless pairing is always", () => {
    const external = { web: { external_origins: ["https://bazhen.example.com"] } };
    const always = { web: { pairing: "always" as const } };
    expect([
      resolveConfig({}, {}).pairingRequired,
      resolveConfig(external, {}).pairingRequired,
      resolveConfig(always, {}).pairingRequired,
      resolveConfig({}, { BAZHEN_PAIRING: "always" }).pairingRequired,
    ]).toEqual([false, true, true, true]);
  });

  it("refuses a pairing mode it doesn't know, so a typo never turns pairing off", () => {
    expect(() => resolveConfig({}, { BAZHEN_PAIRING: "never" })).toThrow(InvalidConfig);
  });

  it("refuses a LAN listener without the ranges it admits, suggesting this host's subnets", () => {
    expect(() =>
      resolveConfig({ web: { listen: "lan" } }, {}, ["192.168.1.0/24", "fe80::/10"]),
    ).toThrow(
      'web.lan_allow: web.listen is "lan", so list the address ranges that may connect, such as ["192.168.1.0/24","fe80::/10"]',
    );
  });

  it("serves the LAN on its own port with the ranges listed, and then every browser pairs", () => {
    const config = resolveConfig({ web: { listen: "lan", lan_allow: ["192.168.1.0/24"] } }, {});
    expect({
      port: config.lan?.port,
      ranges: config.lan?.ranges,
      pairingRequired: config.pairingRequired,
    }).toEqual({ port: 7942, ranges: ["192.168.1.0/24"], pairingRequired: true });
  });

  it("takes the listener and its port from the environment over the file", () => {
    const config = resolveConfig(
      { web: { lan_allow: ["10.0.0.0/8"] } },
      { BAZHEN_WEB_LISTEN: "lan", BAZHEN_LAN_PORT: "9443" },
    );
    expect(config.lan?.port).toBe(9443);
  });

  it("refuses port 443 for the LAN, which browsers leave out of Host and Origin", () => {
    expect(() =>
      resolveConfig({ web: { listen: "lan", lan_port: 443, lan_allow: ["10.0.0.0/8"] } }, {}),
    ).toThrow("web.lan_port: 443 isn't supported");
  });

  it("refuses a range that admits everyone, saying why", () => {
    expect(() => resolveConfig({ web: { listen: "lan", lan_allow: ["::/0"] } }, {})).toThrow(
      "web.lan_allow: ::/0 admits every address; list your own network's range",
    );
  });

  it("refuses a range that isn't one, and a LAN port that is the daemon's own", () => {
    expect(() => resolveConfig({ web: { listen: "lan", lan_allow: ["192.168.1.0"] } }, {})).toThrow(
      InvalidConfig,
    );
    expect(() =>
      resolveConfig({ web: { listen: "lan", lan_port: 7900, lan_allow: ["10.0.0.0/8"] } }, {}),
    ).toThrow("web.lan_port: 7900 is the daemon's own port");
  });
});
