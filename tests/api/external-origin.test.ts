import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateSnapshot } from "@bazhen/protocol";
import { bazhen, Daemon } from "./daemon.ts";

const external = "https://bazhen.example.com";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start({ env: { BAZHEN_EXTERNAL_ORIGINS: external } });
});
afterAll(async () => {
  await daemon?.stop();
});

describe("an external origin the user configured", () => {
  it("opens a stream from a page on it, reached under its name, and refuses near misses", async () => {
    const cursor = StateSnapshot.parse((await daemon.request("/v1/state")).body);
    // The page on the HTTPS origin paired there, as a phone does through the proxy.
    const cookie = await daemon.pairBrowser("Phone", external);
    const outcomes = await Promise.all(
      [
        { origin: external, host: "bazhen.example.com" },
        { origin: "http://bazhen.example.com", host: "bazhen.example.com" },
        { origin: external, host: "other.example.com" },
      ].map((at) =>
        daemon.events(cursor, { ...at, cookie }).then(
          (client) => {
            client.close();
            return "open";
          },
          (err: unknown) => String(err),
        ),
      ),
    );
    expect(outcomes).toEqual(["open", "Error: refused: 403", "Error: refused: 421"]);
  });

  it("says so at start and in bazhen doctor, with pairing required", async () => {
    const doctor = await bazhen(["doctor"], daemon.env);
    expect([
      daemon.log().includes(`admitting external origins from BAZHEN_EXTERNAL_ORIGINS: ${external}`),
      doctor.out.includes(`external origins: ${external} (from BAZHEN_EXTERNAL_ORIGINS)`),
      doctor.out.includes("pairing: required on every origin"),
    ]).toEqual([true, true, true]);
  });
});
