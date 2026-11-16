import type { Containment } from "@bazhen/host-guard";
import { describe, expect, it } from "vitest";
import { containmentDoctor, containmentLog } from "./containment.ts";

const GIB = 1024 ** 3;
const scoped = (systemd: number): Containment => ({
  kind: "scoped",
  systemd,
  oomPolicy: systemd >= 253,
  caps: { terminal: "50%", total: "infinity" },
  terminalBytes: 31 * GIB,
  totalBytes: null,
  systemdRun: "/usr/bin/systemd-run",
  runtimeDir: "/run/user/1000",
});

describe("what doctor says of containment", () => {
  it("names each cap as configured and as the kernel enforces it", () => {
    expect(containmentDoctor(scoped(255))).toEqual({
      state: "scoped",
      systemd: 255,
      oomPolicy: true,
      terminal: { asked: "50%", bytes: 31 * GIB },
      total: { asked: "infinity", bytes: null },
    });
  });

  it("says why terminals aren't contained, and nothing of how systemd would be reached", () => {
    const uncontained: Containment = { kind: "uncontained", why: "darwin has no cgroups" };
    expect(containmentDoctor(uncontained)).toEqual({
      state: "uncontained",
      why: "darwin has no cgroups",
    });
  });
});

describe("what the daemon says of containment as it starts", () => {
  it("names the slice and both caps, in GiB", () => {
    expect(containmentLog(scoped(255))).toEqual({
      warn: false,
      message:
        "holder terminals each start in a scope of their own in bazhen-terminals.slice, " +
        "at most 50% (31.0 GiB) each and infinity (no cap) together",
    });
  });

  it("warns that before systemd 253 the kernel alone decides what dies past a cap", () => {
    expect(containmentLog(scoped(252))).toMatchObject({
      warn: true,
      message: expect.stringContaining("systemd 252 predates OOMPolicy for scopes (253)"),
    });
  });

  it("warns when terminals aren't contained, saying why", () => {
    expect(containmentLog({ kind: "uncontained", why: "no user manager" })).toEqual({
      warn: true,
      message: "holder terminals are not contained: no user manager",
    });
  });
});
