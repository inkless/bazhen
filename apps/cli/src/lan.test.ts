import { describe, expect, it } from "vitest";
import { lanLines } from "./lan.ts";

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

describe("what doctor says about the LAN listener", () => {
  it("shows where it serves and the certificate to trust", () => {
    expect(lanLines(lan)).toEqual([
      "LAN: https://my-mac.local:7942, to 192.168.1.0/24",
      "  certificate SHA-256: ab cd",
      "  certificate: /s/tls/lan.crt, expires 2029-02-11T00:00:00.000Z",
      "  this host's subnets: 192.168.1.0/24 (eno1)",
    ]);
  });

  it("says it isn't serving when it stopped, though its certificate is loaded", () => {
    const lines = lanLines({ ...lan, error: "the LAN listener stopped: listen EADDRINUSE" });
    expect(lines[1]).toBe("  not serving: the LAN listener stopped: listen EADDRINUSE");
  });

  it("says it isn't serving when its certificate couldn't be used", () => {
    const lines = lanLines({
      ...lan,
      certificate: null,
      error: "the LAN certificate can't be used",
    });
    expect(lines.slice(1, 2)).toEqual(["  not serving: the LAN certificate can't be used"]);
  });
});
