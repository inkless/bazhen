import { describe, expect, it } from "vitest";
import { allowlists, refusal } from "./guard.ts";

const allow = { hosts: ["127.0.0.1:7900"], origins: ["http://127.0.0.1:7900"] };
const host = "127.0.0.1:7900";

describe("refusal", () => {
  it("admits a read from any page, and an action from the daemon's own origin", () => {
    expect([
      refusal(allow, { host, origin: "https://evil.example", acting: false }),
      refusal(allow, { host, origin: "http://127.0.0.1:7900", acting: true }),
    ]).toEqual([null, null]);
  });

  it("refuses an action from another origin, and any request to another host", () => {
    expect([
      refusal(allow, { host, origin: "https://evil.example", acting: true }),
      refusal(allow, { host: "evil.example", origin: undefined, acting: false }),
    ]).toEqual(["origin_not_allowed", "host_not_allowed"]);
  });

  it("admits an action from a local process that sends no Origin", () => {
    expect(refusal(allow, { host, origin: undefined, acting: true })).toBeNull();
  });
});

describe("allowlists", () => {
  const loopback = ["127.0.0.1:7900", "localhost:7900"];

  it("admits the daemon's own loopback address, and nothing else, by default", () => {
    expect(allowlists({ port: 7900, webPort: undefined, externalOrigins: [] })).toEqual({
      hosts: loopback,
      origins: ["http://127.0.0.1:7900", "http://localhost:7900"],
    });
  });

  it("lets the web dev server's pages act, through its proxy", () => {
    expect(allowlists({ port: 7900, webPort: "7901", externalOrigins: [] }).origins).toEqual([
      "http://127.0.0.1:7900",
      "http://localhost:7900",
      "http://127.0.0.1:7901",
      "http://localhost:7901",
    ]);
  });

  it("admits an external origin as a host and as an origin, exactly as configured", () => {
    const external = allowlists({
      port: 7900,
      webPort: undefined,
      externalOrigins: ["https://bazhen.example.com"],
    });
    expect([
      refusal(external, {
        host: "bazhen.example.com",
        origin: "https://bazhen.example.com",
        acting: true,
      }),
      refusal(external, {
        host: "bazhen.example.com",
        origin: "http://bazhen.example.com",
        acting: true,
      }),
      refusal(external, { host: "other.example.com", origin: undefined, acting: false }),
    ]).toEqual([null, "origin_not_allowed", "host_not_allowed"]);
  });
});

describe("a request the web dev server proxied", () => {
  const daemon = { hosts: ["127.0.0.1:7900"], origins: ["https://bazhen.example.com"] };
  const via = (devOrigins: string) =>
    refusal(daemon, { host: "127.0.0.1:7900", origin: undefined, acting: false, devOrigins });

  it("is refused when the dev server admits an origin the daemon doesn't", () => {
    expect([via(""), via("https://bazhen.example.com"), via("https://other.example.com")]).toEqual([
      null,
      null,
      "host_not_allowed",
    ]);
  });
});
