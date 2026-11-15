import { describe, expect, it } from "vitest";
import { onDisposableHost, requireDisposableHost } from "./disposable-host.ts";

describe("the disposable-host check", () => {
  it("accepts only a Linux host that carries root's marker", () => {
    expect(onDisposableHost("linux", { markerOwner: 0 })).toBe(true);
    expect(onDisposableHost("linux", { markerOwner: undefined })).toBe(false);
    expect(onDisposableHost("linux", { markerOwner: 1000 })).toBe(false);
    expect(onDisposableHost("darwin", { markerOwner: 0 })).toBe(false);
  });

  it("refuses to start a suite off a disposable host, naming the command to use", () => {
    expect(() => requireDisposableHost(false)).toThrow("pnpm test:real");
    expect(() => requireDisposableHost(true)).not.toThrow();
  });
});
