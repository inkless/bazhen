import { describe, expect, it } from "vitest";
import { forwardedFromElsewhere } from "./forwarded.ts";

const via = (xForwardedFor?: string, forwarded?: string) =>
  forwardedFromElsewhere({ xForwardedFor, forwarded });

describe("forwardedFromElsewhere", () => {
  it("is false for a request no proxy forwarded, or one that only crossed loopback", () => {
    expect([
      via(),
      via("127.0.0.1"),
      via("127.0.0.1, ::1"),
      via(undefined, "for=127.0.0.1"),
    ]).toEqual([false, false, false, false]);
  });

  it("is true once any hop names another machine, wherever it is in the chain", () => {
    expect([
      via("192.168.1.30"),
      via("192.168.1.30, 127.0.0.1"),
      via("127.0.0.1, 2001:db8::5"),
      via(undefined, 'for="[2001:db8::5]:4711";proto=https'),
      via(undefined, "for=192.168.1.30:51000, for=127.0.0.1"),
    ]).toEqual([true, true, true, true, true]);
  });

  it("doesn't take an IPv4-mapped or bracketed loopback address for another machine", () => {
    expect([via("::ffff:127.0.0.1"), via(undefined, 'for="[::1]:80"')]).toEqual([false, false]);
  });

  it("takes a hop it can't read as another machine, since only a proxy writes one", () => {
    expect(via(undefined, "for=unknown")).toBe(true);
  });
});
