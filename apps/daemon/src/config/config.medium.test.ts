import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidConfig, loadSettings, readConfigFile } from "./config.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(text: string): string {
  dir = mkdtempSync(join(tmpdir(), "bz-config-"));
  const file = join(dir, "config.toml");
  writeFileSync(file, text);
  return file;
}

describe("readConfigFile", () => {
  it("reads every key it knows", () => {
    const file = write(
      [
        "[daemon]",
        "port = 8100",
        "[bank]",
        'path = "/bank"',
        "[agents]",
        'shell = "login"',
        "[agents.env]",
        'deny = ["SECRET_*"]',
        'passthrough = ["TERM"]',
        "[web]",
        'external_origins = ["https://bazhen.example.com"]',
        "allow_insecure_origins = false",
        'pairing = "always"',
      ].join("\n"),
    );
    expect(readConfigFile(file)).toEqual({
      daemon: { port: 8100 },
      bank: { path: "/bank" },
      agents: { shell: "login", env: { deny: ["SECRET_*"], passthrough: ["TERM"] } },
      web: {
        external_origins: ["https://bazhen.example.com"],
        allow_insecure_origins: false,
        pairing: "always",
      },
    });
  });

  it("has no settings when there is no file", () => {
    dir = mkdtempSync(join(tmpdir(), "bz-config-"));
    expect(readConfigFile(join(dir, "config.toml"))).toBeUndefined();
  });

  it.each([
    ["an unknown key", '[agents]\nshel = "login"', "agents: Unrecognized key"],
    ["a wrong type", '[daemon]\nport = "8100"', "daemon.port:"],
    ["a relative bank", '[bank]\npath = "bank"', "bank.path:"],
    ["a value of the wrong kind", '[agents.env]\ndeny = "SECRET_*"', "agents.env.deny:"],
    ["a rule that names no variable", '[agents.env]\ndeny = ["*"]', "agents.env.deny.0:"],
    [
      "an origin with a path",
      '[web]\nexternal_origins = ["https://b.example.com/x"]',
      "web.external_origins.0:",
    ],
    [
      "an origin without a scheme",
      '[web]\nexternal_origins = ["b.example.com"]',
      "web.external_origins.0:",
    ],
    [
      "an origin that isn't web",
      '[web]\nexternal_origins = ["ftp://b.example.com"]',
      "web.external_origins.0:",
    ],
    ["broken TOML", "[daemon\nport = 1", "config.toml:"],
  ])("refuses %s, naming the file and the key", (_what, text, message) => {
    const file = write(text);
    expect(() => readConfigFile(file)).toThrow(InvalidConfig);
    expect(() => readConfigFile(file)).toThrow(`${file}: `);
    expect(() => readConfigFile(file)).toThrow(message);
  });
});

const inputs = (home: string, env: Record<string, string> = {}) => ({
  platform: "linux" as const,
  env: { BAZHEN_HOME: home, ...env },
  home: "/home/u",
  tmp: "/tmp",
  uid: 1000,
});

describe("loadSettings", () => {
  it("reads the file from the config directory, and lets it move the bank", () => {
    const file = write('[bank]\npath = "/elsewhere"\n[daemon]\nport = 8100');
    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    renameSync(file, join(home, "config", "config.toml"));
    const { paths, config } = loadSettings(inputs(home));
    expect([paths.bank, config.port]).toEqual(["/elsewhere", 8100]);
    expect(loadSettings(inputs(home, { BAZHEN_BANK: "/env-bank" })).paths.bank).toBe("/env-bank");
  });
});
