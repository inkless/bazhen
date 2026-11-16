import type { Containment } from "@bazhen/host-guard";
import { describe, expect, it } from "vitest";
import { ContainmentCheck, containmentDoctor, containmentLog } from "./containment.ts";

const GIB = 1024 ** 3;
const scoped = (systemd: number): Containment => ({
  kind: "scoped",
  systemd,
  oomPolicy: systemd >= 253,
  caps: { terminal: "50%", total: "infinity", swap: "0" },
  enforced: { terminal: 31 * GIB, total: null, swap: 0 },
  systemdRun: "/usr/bin/systemd-run",
  runtimeDir: "/run/user/1000",
});

describe("deciding whether terminals can be contained", () => {
  it("probes only once something asks, and once however many ask", async () => {
    let probes = 0;
    const decided: Containment[] = [];
    const check = new ContainmentCheck(
      async () => (probes++, scoped(255)),
      (c) => decided.push(c),
    );
    expect([probes, check.decided]).toEqual([0, undefined]);
    await Promise.all([check.decide(), check.decide()]);
    await check.decide();
    expect([probes, decided.length, check.decided]).toEqual([1, 1, scoped(255)]);
  });
});

describe("what doctor says of containment", () => {
  it("names each cap as configured and as the kernel enforces it", () => {
    expect(containmentDoctor(scoped(255))).toEqual({
      state: "scoped",
      systemd: 255,
      oomPolicy: true,
      terminal: { asked: "50%", bytes: 31 * GIB },
      total: { asked: "infinity", bytes: null },
      swap: { asked: "0", bytes: 0 },
    });
  });

  it("says why terminals aren't contained, and nothing of how systemd would be reached", () => {
    const uncontained: Containment = { kind: "uncontained", why: "darwin has no cgroups" };
    expect(containmentDoctor(uncontained)).toEqual({
      state: "uncontained",
      why: "darwin has no cgroups",
    });
  });

  it("says it hasn't checked before any holder terminal needed it", () => {
    expect(containmentDoctor(undefined)).toEqual({ state: "unchecked" });
  });
});

describe("what the daemon says of containment once decided", () => {
  it("names the slice and every cap, in GiB", () => {
    expect(containmentLog(scoped(255))).toEqual({
      warn: false,
      message:
        "holder terminals each start in a scope of their own in bazhen-terminals.slice, " +
        "at most 50% (31.0 GiB) each with 0 (none) of swap, and infinity (no cap) together",
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
