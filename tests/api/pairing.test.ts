import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PairResponse } from "@bazhen/protocol";
import { Daemon, bazhen } from "./daemon.ts";

describe("pairing a browser through the CLI", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  /** The code `bazhen pair` printed, without its dash. */
  const pairCode = async () => {
    const printed = await bazhen(["pair"], daemon.env);
    const code = /pairing code: ([A-Z2-7]{4})-([A-Z2-7]{4})/.exec(printed.out);
    expect([printed.code, printed.out]).toEqual([0, expect.stringContaining("works once, until")]);
    return `${code?.[1]}${code?.[2]}`;
  };
  const exchange = (code: string) =>
    daemon.request("/v1/pairing", {
      method: "POST",
      origin: daemon.url,
      body: { code, name: "Phone" },
    });

  it("trades the printed code once for a device that `bazhen devices` lists", async () => {
    const code = await pairCode();
    const first = await exchange(code);
    expect([first.status, first.body]).toMatchObject([200, { name: "Phone" }]);
    expect((await exchange(code)).status).toBe(401);
    const listed = await bazhen(["devices"], daemon.env);
    expect(listed.out).toContain(`${PairResponse.parse(first.body).deviceId}  Phone`);
  });

  it("revokes a device, so `bazhen devices` no longer lists it", async () => {
    const paired = await exchange(await pairCode());
    const { deviceId } = PairResponse.parse(paired.body);
    expect((await bazhen(["devices", "revoke", deviceId], daemon.env)).code).toBe(0);
    expect((await bazhen(["devices"], daemon.env)).out).not.toContain(deviceId);
  });

  it("refuses to issue a code to a caller that says it is an agent", async () => {
    const asAgent = await bazhen(["pair"], { ...daemon.env, BAZHEN_AGENT_ID: "agent_x" });
    expect([asAgent.code, asAgent.out]).toEqual([1, expect.stringContaining("can't pair")]);
  });
});
