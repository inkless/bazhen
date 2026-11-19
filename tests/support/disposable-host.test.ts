import { describe, expect, it } from "vitest";
import {
  onDisposableHost,
  requireDisposableHost,
  requireSignalSandbox,
} from "./disposable-host.ts";

describe("the disposable-host check", () => {
  it("accepts only a Linux host that carries root's marker", () => {
    expect(onDisposableHost("linux", { markerOwner: 0 })).toBe(true);
    expect(onDisposableHost("linux", { markerOwner: undefined })).toBe(false);
    expect(onDisposableHost("linux", { markerOwner: 1000 })).toBe(false);
    expect(onDisposableHost("darwin", { markerOwner: 0 })).toBe(false);
  });

  it("refuses to start a suite off a disposable host, naming the command to use", () => {
    expect(() => requireDisposableHost(false)).toThrow("moon run :test-real");
    expect(() => requireDisposableHost(true)).not.toThrow();
  });
});

describe("the signal-sandbox check", () => {
  it("refuses to start the holder suite off a sandbox, naming the command to use", () => {
    expect(() => requireSignalSandbox(false)).toThrow("moon run :test-real -- holder");
    expect(() => requireSignalSandbox(true)).not.toThrow();
  });
});
