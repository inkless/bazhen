import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { FakeRuntime } from "@bazhen/core/testing";
import { PairResponse } from "@bazhen/protocol";
import { DeviceAuth, TOUCH_EVERY_MS } from "../auth/devices.ts";
import { PairingCodes } from "../auth/pairing.ts";
import { Store } from "../store/store.ts";
import { serveUpgrades, tempDb, upgradeOutcome } from "../testing/fixtures.ts";
import { createApp, type AppDeps } from "./app.ts";

const host = "127.0.0.1:7900";
const origin = `http://${host}`;
const external = "https://laptop.example.ts.net";
const unused = () => Promise.reject(new Error("not used by these tests"));
const refuse = () => {
  throw new Error("not used by these tests");
};

/** The `name=value` a response's Set-Cookie carries, or "" for none. */
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

function daemon(always = true) {
  const clock = { now: Date.parse("2026-11-12T00:00:00.000Z") };
  const store = Store.open(tempDb());
  const devices = new DeviceAuth(store, { now: () => new Date(clock.now), log: () => {} });
  const codes = new PairingCodes({ now: () => clock.now, log: () => {} });
  const deps: AppDeps = {
    appVersion: "0.1.0",
    schemaVersion: () => 1,
    runtime: new FakeRuntime(),
    allow: { hosts: [host, new URL(external).host], origins: [origin, external] },
    state: () => ({
      epoch: "e1",
      eventId: 0,
      environments: [],
      agents: [],
      attention: [],
      messages: [],
      shells: [],
      tasks: [],
      assignments: [],
    }),
    launch: unused,
    send: refuse,
    answer: refuse,
    close: unused,
    respawn: unused,
    relaunch: unused,
    signal: unused,
    reply: refuse,
    dismiss: refuse,
    resend: refuse,
    openShell: unused,
    closeShell: unused,
    restartShell: unused,
    renameShell: unused,
    unlinkShell: unused,
    tasks: {
      create: refuse,
      show: refuse,
      assign: refuse,
      unassign: refuse,
      finish: refuse,
      delegate: refuse,
      escalate: refuse,
    },
    pairing: { codes, devices },
    gate: { devices, always },
  };
  const app = createApp(deps);
  const request = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: { host, "content-type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const pair = (code: string, from: string = origin, h: Record<string, string> = {}) =>
    request("/v1/pairing", {
      method: "POST",
      headers: { origin: from, ...h },
      body: { code, name: "Phone" },
    });
  /** A paired browser's cookie header, and its device. */
  const paired = async () => {
    const res = await pair(codes.issue().code);
    return { cookie: cookieOf(res), deviceId: PairResponse.parse(await res.json()).deviceId };
  };
  return { request, pair, paired, codes, devices, clock };
}

describe("device auth when pairing is not always required", () => {
  it("serves loopback's own requests unpaired, and asks one a proxy forwarded from elsewhere", async () => {
    const { request } = daemon(false);
    const statuses = await Promise.all(
      [
        {},
        { "x-forwarded-for": "127.0.0.1" },
        { "x-forwarded-for": "192.168.1.30, 127.0.0.1" },
      ].map(async (headers) => (await request("/v1/state", { headers })).status),
    );
    expect(statuses).toEqual([200, 200, 401]);
  });

  it("asks for pairing on a request whose Forwarded header names another machine", async () => {
    const { request } = daemon(false);
    const res = await request("/v1/state", {
      headers: { forwarded: "for=192.168.1.30;proto=https" },
    });
    expect(res.status).toBe(401);
  });
});

describe("device auth on the TCP app", () => {
  it("takes a loopback-paired token on direct loopback only, an HTTPS-paired one forwarded too", async () => {
    const { request, pair, paired, codes } = daemon();
    const { cookie } = await paired();
    const externalHost = new URL(external).host;
    const https = cookieOf(await pair(codes.issue().code, external, { host: externalHost }));
    const forwarded = { "x-forwarded-for": "192.168.1.30, 127.0.0.1" };
    const statuses = await Promise.all(
      [
        { cookie },
        { cookie, ...forwarded },
        { cookie, origin: external, host: externalHost },
        { cookie: https, host: externalHost, ...forwarded },
      ].map(async (headers) => (await request("/v1/state", { headers })).status),
    );
    expect(statuses).toEqual([200, 401, 401, 200]);
  });

  it("refuses a paired browser's read from a page on another origin", async () => {
    const { request, paired } = daemon();
    const { cookie } = await paired();
    const res = await request("/v1/state", { headers: { cookie, origin: "http://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("answers an unpaired browser 401 everywhere, health and reads included", async () => {
    const { request } = daemon();
    const answers = await Promise.all(
      ["/v1/health", "/v1/state"].map(async (p) => {
        const res = await request(p);
        return [res.status, (await res.json()).error];
      }),
    );
    expect(answers).toEqual([
      [401, "unpaired"],
      [401, "unpaired"],
    ]);
  });

  it("pairs with a code and then serves that browser", async () => {
    const { request, pair, codes } = daemon();
    const res = await pair(codes.issue().code);
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie");
    expect(header).toMatch(/^bazhen_device=[\w-]{43}; Path=\/v1; Max-Age=86400; HttpOnly;/);
    const cookie = cookieOf(res);
    expect(JSON.stringify(await res.json())).not.toContain(cookie.slice("bazhen_device=".length));
    const state = await request("/v1/state", { headers: { cookie } });
    expect(state.status).toBe(200);
  });

  it("sets a __Host- cookie for a browser on an HTTPS origin, which serves it again", async () => {
    const { pair, codes, request } = daemon();
    const res = await pair(codes.issue().code, external, { host: new URL(external).host });
    expect(res.headers.get("set-cookie")).toMatch(
      /^__Host-bazhen_device=[\w-]{43}; Secure; Path=\/;/,
    );
    const state = await request("/v1/state", {
      headers: { host: new URL(external).host, cookie: cookieOf(res) },
    });
    expect(state.status).toBe(200);
  });

  it("refuses a wrong code 401 and a burst of tries 429, with when to try again", async () => {
    const { pair, codes } = daemon();
    codes.issue();
    const first = await pair("AAAAAAAA");
    expect([first.status, (await first.json()).error]).toEqual([401, "pairing_failed"]);
    for (let i = 0; i < 4; i++) await pair("AAAAAAAA");
    const limited = await pair("AAAAAAAA");
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "60"]);
  });

  it("refuses a pairing attempt that carries no Origin", async () => {
    const { request, codes } = daemon();
    const res = await request("/v1/pairing", {
      method: "POST",
      body: { code: codes.issue().code },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a paired browser's action from a foreign Origin, or with none", async () => {
    const { request, paired } = daemon();
    const { cookie } = await paired();
    const act = (headers: Record<string, string>) =>
      request("/v1/agents", { method: "POST", headers: { cookie, ...headers }, body: {} });
    const statuses = [
      (await act({ origin: "http://evil.example" })).status,
      (await act({})).status,
      (await act({ origin })).status,
    ];
    // The last one gets through to the route, whose body check refuses the empty request.
    expect(statuses).toEqual([403, 403, 400]);
  });

  it("refuses a revoked device", async () => {
    const { request, paired, devices } = daemon();
    const { cookie, deviceId } = await paired();
    devices.revoke(deviceId);
    expect((await request("/v1/state", { headers: { cookie } })).status).toBe(401);
  });

  it("sets an HTTPS device's cookie again as the __Host- cookie it was paired with", async () => {
    const { request, pair, codes, clock } = daemon();
    const externalHost = new URL(external).host;
    const res = await pair(codes.issue().code, external, { host: externalHost });
    clock.now += TOUCH_EVERY_MS;
    const later = await request("/v1/state", {
      headers: { host: externalHost, cookie: cookieOf(res) },
    });
    expect(later.headers.get("set-cookie")).toMatch(/^__Host-bazhen_device=[\w-]{43}; Secure;/);
  });

  it("sets the cookie again once an hour has passed, so its lifetime restarts", async () => {
    const { request, paired, clock } = daemon();
    const { cookie } = await paired();
    const soon = await request("/v1/state", { headers: { cookie } });
    clock.now += TOUCH_EVERY_MS;
    const later = await request("/v1/state", { headers: { cookie } });
    expect([
      soon.headers.get("set-cookie"),
      later.headers.get("set-cookie")?.split(";")[0],
    ]).toEqual([null, cookie]);
  });
});

let server: Server | undefined;
afterEach(() => {
  server?.close();
});

async function serving(always = true) {
  const store = Store.open(tempDb());
  const devices = new DeviceAuth(store, { log: () => {} });
  const wss = new WebSocketServer({ noServer: true });
  /** The device each upgrade the route took came from, by name. */
  const from: (string | null)[] = [];
  const served = await serveUpgrades(
    [
      {
        path: /^\/echo$/,
        upgrade: (req, socket, head, _url, _match, device) => {
          from.push(device?.name ?? null);
          wss.handleUpgrade(req, socket, head, (ws) => ws.send("hi"));
        },
      },
    ],
    { devices, always },
  );
  server = served.server;
  const { token, deviceId } = devices.pair("Phone", false);
  return {
    url: `ws://${served.host}/echo`,
    pageOrigin: `http://${served.host}`,
    cookie: `bazhen_device=${token}`,
    revoke: () => devices.revoke(deviceId),
    from,
  };
}

describe("device auth on WebSocket upgrades", () => {
  it("lets loopback's own upgrades through unpaired when not always, but not a forwarded one", async () => {
    const { url, pageOrigin } = await serving(false);
    const outcomes = [
      await upgradeOutcome(new WebSocket(url, { origin: pageOrigin })),
      await upgradeOutcome(
        new WebSocket(url, { origin: pageOrigin, headers: { "x-forwarded-for": "192.168.1.30" } }),
      ),
    ];
    expect(outcomes).toEqual(["open", 401]);
  });

  it("refuses an upgrade without a paired device's cookie, 401, or without Origin, 403", async () => {
    const { url, pageOrigin, cookie } = await serving();
    const outcomes = [
      await upgradeOutcome(new WebSocket(url, { origin: pageOrigin })),
      await upgradeOutcome(new WebSocket(url, { headers: { cookie } })),
      await upgradeOutcome(new WebSocket(url, { origin: pageOrigin, headers: { cookie } })),
    ];
    expect(outcomes).toEqual([401, 403, "open"]);
  });

  it("refuses a loopback-paired token on an upgrade a proxy forwarded", async () => {
    const { url, pageOrigin, cookie } = await serving();
    const forwarded = new WebSocket(url, {
      origin: pageOrigin,
      headers: { cookie, "x-forwarded-for": "192.168.1.30" },
    });
    expect(await upgradeOutcome(forwarded)).toBe(401);
  });

  it("tells the route which device an upgrade came from, on loopback too, and none for a browser that never paired", async () => {
    const { url, pageOrigin, cookie, from } = await serving(false);
    await upgradeOutcome(new WebSocket(url, { origin: pageOrigin, headers: { cookie } }));
    await upgradeOutcome(new WebSocket(url, { origin: pageOrigin }));
    expect(from).toEqual(["Phone", null]);
  });

  it("names no device for a revoked one's cookie on loopback, and lets it through unpaired", async () => {
    const { url, pageOrigin, cookie, from, revoke } = await serving(false);
    const upgrade = () =>
      upgradeOutcome(new WebSocket(url, { origin: pageOrigin, headers: { cookie } }));
    await upgrade();
    revoke();
    expect([await upgrade(), from]).toEqual(["open", ["Phone", null]]);
  });

  it("closes a device's sockets on loopback too when it is revoked, so it is named no longer", async () => {
    const { url, pageOrigin, cookie, revoke } = await serving(false);
    const ws = new WebSocket(url, { origin: pageOrigin, headers: { cookie } });
    await new Promise((resolve) => ws.once("message", resolve));
    revoke();
    await expect.poll(() => ws.readyState, { timeout: 1_000 }).toBe(WebSocket.CLOSED);
  });

  it("closes a revoked device's open sockets", async () => {
    const { url, pageOrigin, cookie, revoke } = await serving();
    const ws = new WebSocket(url, { origin: pageOrigin, headers: { cookie } });
    await new Promise((resolve) => ws.once("message", resolve));
    const closed = new Promise((resolve) => ws.once("close", resolve));
    revoke();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
