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
      envRules: { deny: [], passthrough: [] },
    });
  });

  it("takes the file over the defaults", () => {
    expect(resolveConfig(file, {})).toEqual({
      port: 8100,
      bank: "/bank",
      envRules: { deny: ["SECRET_*"], passthrough: ["TERM"] },
    });
  });

  it("takes the environment over the file", () => {
    expect(resolveConfig(file, { BAZHEN_PORT: "8200" }).port).toBe(8200);
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
