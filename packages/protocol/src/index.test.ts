import { describe, expect, it } from "vitest";
import { DoctorResponse, ErrorResponse, HealthResponse, memoryCapText } from "./index.ts";

describe("HealthResponse schema", () => {
  it("rejects a runtime state outside the declared set", () => {
    const parsed = HealthResponse.safeParse({
      status: "ok",
      appVersion: "0.1.0",
      protocolVersion: "1.0",
      schemaVersion: 1,
      runtime: { kind: "tmux", state: "dead", version: null },
    });
    expect(parsed.success).toBe(false);
  });
});

const doctor = (lan: unknown) => ({
  appVersion: "0.1.0",
  protocolVersion: "1.36",
  runtime: { state: "healthy", version: "3.4" },
  hookClient: { path: "/bin/bazhen-hook", fallback: false },
  config: { path: "/c/config.toml", found: true },
  agents: { shell: "direct", loginShell: null },
  web: {
    externalOrigins: [],
    from: null,
    allowInsecureOrigins: false,
    lan,
  },
  env: { capturedAt: "2026-11-14T00:00:00.000Z", source: "start", kept: 3, removed: {} },
});

describe("DoctorResponse schema", () => {
  const lan = {
    url: "https://my-mac.local:7942",
    allow: ["192.168.1.0/24"],
    certificate: {
      fingerprint: "ab cd",
      path: "/s/tls/lan.crt",
      expiresAt: "2029-02-11T00:00:00.000Z",
    },
    error: null,
    subnets: [{ interface: "eno1", cidr: "192.168.1.0/24" }],
  };

  it("takes the LAN listener, or none, and refuses one missing what it must say", () => {
    expect([
      DoctorResponse.safeParse(doctor(lan)).success,
      DoctorResponse.safeParse(doctor(null)).success,
      DoctorResponse.safeParse(doctor({ ...lan, certificate: { fingerprint: "ab cd" } })).success,
      DoctorResponse.safeParse(doctor({ ...lan, error: undefined })).success,
    ]).toEqual([true, true, false, false]);
  });
});

describe("DoctorResponse terminals", () => {
  const base = doctor(null);
  const host = { used: 37, max: 4096, exact: true };
  const parses = (terminals: unknown) => DoctorResponse.safeParse({ ...base, terminals }).success;

  it("takes the open count, the budget and the machine's PTYs, or none from an older daemon", () => {
    expect([
      parses({ open: 3, max: 100, host, refusing: null }),
      parses({ open: 3, max: 100, host: null, refusing: "budget" }),
      DoctorResponse.safeParse(base).success,
    ]).toEqual([true, true, true]);
  });

  it("refuses a budget of no terminals, a machine count not said to be exact, and an unknown limit", () => {
    expect([
      parses({ open: 0, max: 0, host, refusing: null }),
      parses({ open: 3, max: 100, host: { used: 37, max: 4096 }, refusing: null }),
      parses({ open: 3, max: 100, host, refusing: "machine" }),
    ]).toEqual([false, false, false]);
  });
});

const cap = (asked: string, bytes: number | null) => ({ asked, bytes });

describe("DoctorResponse containment", () => {
  const base = doctor(null);
  const parses = (containment: unknown) =>
    DoctorResponse.safeParse({ ...base, containment }).success;
  const scoped = { state: "scoped", systemd: 255, oomPolicy: true };

  it("takes scoped terminals with each cap as asked and enforced, or why they aren't", () => {
    expect([
      parses({ ...scoped, terminal: cap("50%", 33_285_996_544), total: cap("infinity", null) }),
      parses({ state: "uncontained", why: "darwin has no cgroups" }),
      DoctorResponse.safeParse(base).success,
    ]).toEqual([true, true, true]);
  });

  it("refuses scoped terminals with no caps, uncontained ones with no reason, and other states", () => {
    expect([
      parses(scoped),
      parses({ state: "uncontained" }),
      parses({ state: "partial", why: "x" }),
      parses({ ...scoped, terminal: cap("50%", -1), total: cap("80%", 1) }),
    ]).toEqual([false, false, false, false]);
  });
});

describe("a memory cap as people read it", () => {
  it("shows what was asked and what the kernel enforces, to a tenth of a GiB", () => {
    expect([
      memoryCapText({ asked: "50%", bytes: 33_285_996_544 }),
      memoryCapText({ asked: "infinity", bytes: null }),
    ]).toEqual(["50% (31.0 GiB)", "infinity (no cap)"]);
  });
});

const errorParses = (error: string) => ErrorResponse.safeParse({ error, message: "m" }).success;

describe("ErrorResponse", () => {
  it("names a refused terminal as terminal_limit, and no code it doesn't know", () => {
    expect([errorParses("terminal_limit"), errorParses("too_many")]).toEqual([true, false]);
  });
});
