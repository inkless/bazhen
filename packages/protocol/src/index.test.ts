import { describe, expect, it } from "vitest";
import { DoctorResponse, HealthResponse } from "./index.ts";

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
