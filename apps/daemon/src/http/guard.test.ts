import { describe, expect, it } from "vitest";
import { refusal } from "./guard.ts";

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
