import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevicesResponse, PairResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, bazhen, overSocket, waitUntil } from "./daemon.ts";

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
      cookie: null,
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

describe('web.pairing = "auto" with no external origin', () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("serves an unpaired loopback browser, refuses other hosts and origins, and says so", async () => {
    const state = await daemon.request("/v1/state", { cookie: null });
    const cursor = StateSnapshot.parse(state.body);
    const refused = (at: { host?: string; origin?: string }) =>
      daemon.events(cursor, at).then(
        () => "open",
        (err: unknown) => String(err),
      );
    const post = await daemon.request("/v1/agents", {
      method: "POST",
      origin: "http://evil.example",
      cookie: null,
      body: {},
    });
    const doctor = await bazhen(["doctor"], daemon.env);
    expect([
      state.status,
      await refused({ host: "evil.example" }),
      await refused({ origin: "http://evil.example" }),
      post.status,
      doctor.out.includes('pairing: not required on loopback (web.pairing = "auto"'),
      doctor.out.includes("other user of this machine who can reach the daemon's port"),
      daemon.log().includes("pairing not required on loopback"),
    ]).toEqual([200, "Error: refused: 421", "Error: refused: 403", 403, true, true, true]);
  });
});

describe('a request a proxy forwarded, under web.pairing = "auto" with no external origin', () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("must pair over HTTPS when it came from another machine, and passes from this one", async () => {
    const at = (forwardedFor: string) =>
      daemon.request("/v1/state", { cookie: null, headers: { "x-forwarded-for": forwardedFor } });
    // A device paired on loopback, as the harness pairs, is no good to a request from elsewhere.
    const paired = await daemon.request("/v1/state", {
      headers: { "x-forwarded-for": "192.168.1.30, 127.0.0.1" },
    });
    expect([
      (await at("192.168.1.30, 127.0.0.1")).status,
      (await at("127.0.0.1")).status,
      paired.status,
    ]).toEqual([401, 200, 401]);
  });
});

describe.each([
  ['web.pairing = "always"', { BAZHEN_PAIRING: "always" }],
  ["an external origin", { BAZHEN_EXTERNAL_ORIGINS: "https://bazhen.example.com" }],
])("a daemon with %s only serves paired browsers", (_why, env) => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start({ env });
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("answers a loopback browser that never paired 401, health included", async () => {
    const statuses = await Promise.all(
      ["/v1/health", "/v1/state"].map(
        async (p) => (await daemon.request(p, { cookie: null })).status,
      ),
    );
    expect(statuses).toEqual([401, 401]);
  });

  it("says so in bazhen doctor", async () => {
    expect((await bazhen(["doctor"], daemon.env)).out).toContain(
      "pairing: required on every origin",
    );
  });

  it("serves the page outside pairing, which says to build the app when it isn't built", async () => {
    const page = await daemon.request("/", {
      cookie: null,
      headers: { "x-forwarded-for": "192.168.1.30, 127.0.0.1" },
    });
    expect([page.status, String(page.body).includes("pnpm build")]).toEqual([404, true]);
  });
});

describe("a daemon that only serves paired browsers", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start({ env: { BAZHEN_PAIRING: "always" } });
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("refuses an unpaired browser's terminal stream before it looks for the terminal", async () => {
    const terminal = "term_0190a0b0c0d07e0f8a9b0c1d2e3f4a5b";
    const opened = (cookie?: string) =>
      daemon.view(terminal, "observe", daemon.url, undefined, cookie).then(
        (view) => {
          view.close();
          return "open";
        },
        (err: unknown) => String(err),
      );
    expect([await opened("bazhen_device=unknown"), await opened()]).toEqual([
      "Error: refused: 401",
      expect.not.stringContaining("401"),
    ]);
  });

  it("refuses an unpaired browser's event stream", async () => {
    const { body } = await daemon.request("/v1/state");
    const cursor = StateSnapshot.parse(body);
    await expect(daemon.events(cursor, { cookie: "bazhen_device=unknown" })).rejects.toThrow(
      "refused: 401",
    );
  });

  it("closes a revoked browser's open event stream, and refuses its requests", async () => {
    const cookie = await daemon.pairBrowser("Phone");
    const state = StateSnapshot.parse((await daemon.request("/v1/state", { cookie })).body);
    const stream = await daemon.events(state, { cookie });
    const [phone] = DevicesResponse.parse(
      (await overSocket(daemon.socket, "GET", "/v1/devices")).body,
    ).devices.filter((d) => d.name === "Phone");
    expect((await bazhen(["devices", "revoke", String(phone?.id)], daemon.env)).code).toBe(0);
    await waitUntil(() => stream.ended(), "the revoked browser's stream to close");
    expect((await daemon.request("/v1/state", { cookie })).status).toBe(401);
    // Another browser's session is untouched.
    expect((await daemon.request("/v1/state")).status).toBe(200);
  });
});
