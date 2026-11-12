import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_HOST_MARKER,
  onDisposableHost,
  requireDisposableHost,
} from "./disposable-host.ts";

const marked = (path: string) => path === DISPOSABLE_HOST_MARKER;
const unmarked = () => false;

describe("the disposable-host check", () => {
  it("accepts only a Linux host that carries the marker", () => {
    expect(onDisposableHost("linux", marked)).toBe(true);
    expect(onDisposableHost("linux", unmarked)).toBe(false);
    expect(onDisposableHost("darwin", marked)).toBe(false);
  });

  it("refuses to start a suite off a disposable host, naming the command to use", () => {
    expect(() => requireDisposableHost(false)).toThrow("pnpm test:real");
    expect(() => requireDisposableHost(true)).not.toThrow();
  });
});
