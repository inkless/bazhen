import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon } from "./daemon.ts";

describe.each([
  ['web.pairing = "always"', { BAZHEN_PAIRING: "always" }],
  ["an external origin", { BAZHEN_EXTERNAL_ORIGINS: "https://bazhen.example.com" }],
])("the page of a daemon with %s, which only serves paired browsers", (_why, env) => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start({ env });
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("serves the page outside pairing, which says to build the app when it isn't built", async () => {
    const page = await daemon.request("/", {
      cookie: null,
      headers: { "x-forwarded-for": "192.168.1.30, 127.0.0.1" },
    });
    expect([page.status, String(page.body).includes("moon run :build")]).toEqual([404, true]);
  });
});
