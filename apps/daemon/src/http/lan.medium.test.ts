import { mkdtempSync, rmSync } from "node:fs";
import { request as httpsRequest, type Server } from "node:https";
import { connect as tcpConnect } from "node:net";
import { connect } from "node:tls";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type ClientOptions } from "ws";
import { FakeRuntime } from "@bazhen/core/testing";
import { PairResponse, StateSnapshot } from "@bazhen/protocol";
import { Notices } from "../attention/notices.ts";
import { DeviceAuth, LOOPBACK_COOKIE, SECURE_COOKIE } from "../auth/devices.ts";
import { PairingCodes } from "../auth/pairing.ts";
import { parseCidr, type Cidr } from "../config/cidr.ts";
import { Store } from "../store/store.ts";
import { loopbackPairing, tempDb, testView, upgradeOutcome } from "../testing/fixtures.ts";
import { lanCertificate, type LanCertificate } from "../tls/material.ts";
import { lanListener, lanPeer, type LanParts } from "./lan.ts";
import type { UpgradeRoute } from "./upgrades.ts";

const name = "my-mac.local";
const unused = () => Promise.reject(new Error("not used by these tests"));
const refuse = () => {
  throw new Error("not used by these tests");
};
const range = (text: string): Cidr => {
  const parsed = parseCidr(text);
  if (parsed === undefined) throw new Error(text);
  return parsed;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

let certificate: LanCertificate | undefined;
function cert(): LanCertificate {
  if (certificate === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "bz-lan-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    certificate = lanCertificate(join(dir, "tls"), { name, uid: userInfo().uid });
  }
  return certificate;
}
afterEach(() => {
  certificate = undefined;
});

const commands: LanParts["commands"] = {
  appVersion: "0.1.0",
  schemaVersion: () => 1,
  runtime: new FakeRuntime(),
  roles: () => ({ roles: [], problems: [] }),
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
    notices: [],
    observed: [],
  }),
  launch: unused,
  answer: refuse,
  close: unused,
  respawn: unused,
  relaunch: unused,
  signal: unused,
  reply: refuse,
  dismiss: refuse,
  resend: refuse,
  dismissNotice: refuse,
  openShell: unused,
  closeShell: unused,
  restartShell: unused,
  renameShell: unused,
  rename: () => {
    throw new Error("not used by these tests");
  },
  resolveAgent: (ref: string) => ref,
  unlinkShell: unused,
  tasks: {
    create: refuse,
    show: refuse,
    assign: refuse,
    unassign: refuse,
    finish: refuse,
    delegate: refuse,
    escalate: refuse,
    send: refuse,
    note: refuse,
  },
};

/** The LAN listener as the daemon builds it, on 127.0.0.1, with one echo stream. */
async function lan(over: Partial<LanParts> = {}) {
  const store = Store.open(tempDb());
  const devices = new DeviceAuth(store, { log: () => {} });
  const codes = new PairingCodes({ log: () => {} });
  const notices = new Notices(store);
  const served: LanParts["commands"] = {
    ...commands,
    state: (viewer) =>
      store.snapshot({ ...testView, noticeActions: (n) => notices.actions(n, viewer) }),
    dismissNotice: (id, req, viewer) => notices.dismiss(id, req, viewer),
  };
  const wss = new WebSocketServer({ noServer: true });
  const echo: UpgradeRoute = {
    path: /^\/echo$/,
    upgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.send("hello")),
  };
  let server: Server | undefined;
  const port = await new Promise<number>((resolve, reject) => {
    const started: Server = lanListener({
      commands: served,
      devices,
      codes,
      certificate: cert(),
      port: 0,
      hostname: "127.0.0.1",
      allow: [range("127.0.0.0/8")],
      streams: [echo],
      listening: resolve,
      failed: reject,
      ...over,
    });
    server = started;
    cleanups.push(() => {
      started.closeAllConnections();
      started.close();
    });
  });
  if (server === undefined) throw new Error("no server");
  const origin = `https://${name}:${port}`;
  /** A request over TLS that trusts the certificate and names the host, as Safari would. */
  const call = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ) =>
    new Promise<{ status: number; cookie: string; body: string }>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method: init.method ?? "GET",
          ca: cert().cert,
          servername: name,
          agent: false,
          headers: { host: `${name}:${port}`, "content-type": "application/json", ...init.headers },
        },
        (res) => {
          let body = "";
          res.on("data", (d: Buffer) => (body += d.toString("utf8")));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "",
              body,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
    });
  const pair = (code: string, from = origin) =>
    call("/v1/pairing", { method: "POST", headers: { origin: from }, body: { code } });
  const stream = (headers: Record<string, string>) => {
    // ws hands `servername` to tls.connect, though its types leave it out.
    const options: ClientOptions & { servername: string } = {
      ca: cert().cert,
      servername: name,
      headers: { host: `${name}:${port}`, ...headers },
    };
    return new WebSocket(`wss://127.0.0.1:${port}/echo`, options);
  };
  /** What a TLS client trusting the certificate gets: a handshake, or the code that ended it. */
  const handshake = (extra: { maxVersion?: "TLSv1.2" } = {}) =>
    new Promise((resolve) => {
      const socket = connect({
        host: "127.0.0.1",
        port,
        servername: name,
        ca: cert().cert,
        ...extra,
      });
      socket.once("secureConnect", () => {
        resolve("handshake");
        socket.destroy();
      });
      socket.once("error", (err: NodeJS.ErrnoException) => resolve(err.code));
    });
  return { call, pair, stream, handshake, codes, devices, origin, port, server };
}

describe("the LAN listener", () => {
  it("shows each pairing from its socket's address, and lets no paired device dismiss one", async () => {
    const { call, codes, origin } = await lan();
    const pairAs = async (label: string) => {
      const res = await call("/v1/pairing", {
        method: "POST",
        headers: { origin, "x-forwarded-for": "203.0.113.9" },
        body: { code: codes.issue().code, name: label },
      });
      return { cookie: res.cookie, id: PairResponse.parse(JSON.parse(res.body)).deviceId };
    };
    const phone = await pairAs("Phone");
    const impostor = await pairAs("iPhone");
    const seenBy = async (cookie: string) => {
      const res = await call("/v1/state", { headers: { cookie } });
      return StateSnapshot.parse(JSON.parse(res.body)).notices;
    };
    const ofPhone = (await seenBy(impostor.cookie)).find((n) => n.device?.id === phone.id);
    const asPhone = (await seenBy(phone.cookie)).find((n) => n.device?.id === phone.id);
    expect([ofPhone?.device?.address, ofPhone?.actions, asPhone?.actions]).toEqual([
      "127.0.0.1",
      [],
      [],
    ]);
    const dismiss = (cookie: string, idempotencyKey: string) =>
      call(`/v1/notices/${String(ofPhone?.id)}/dismiss`, {
        method: "POST",
        headers: { origin, cookie },
        body: { idempotencyKey },
      });
    expect([
      (await dismiss(phone.cookie, "k1")).status,
      (await dismiss(impostor.cookie, "k2")).status,
    ]).toEqual([409, 409]);
  });

  it("asks for pairing, then pairs a browser with the HTTPS cookie and serves it", async () => {
    const { call, pair, codes } = await lan();
    const before = await call("/v1/state");
    const paired = await pair(codes.issue().code);
    const after = await call("/v1/state", { headers: { cookie: paired.cookie } });
    expect([before.status, paired.status, paired.cookie.split("=")[0], after.status]).toEqual([
      401,
      200,
      SECURE_COOKIE,
      200,
    ]);
  });

  it("refuses a device paired over loopback, by request and by upgrade, with or without Origin", async () => {
    const { call, stream, devices, origin } = await lan();
    const { token } = devices.pair("Laptop", false, loopbackPairing);
    const cookie = `${LOOPBACK_COOKIE}=${token}`;
    const statuses = [
      (await call("/v1/state", { headers: { cookie } })).status,
      (await call("/v1/state", { headers: { cookie, origin } })).status,
      await upgradeOutcome(stream({ cookie, origin })),
      await upgradeOutcome(stream({ cookie })),
    ];
    expect(statuses).toEqual([401, 401, 401, 401]);
  });

  it("opens a stream for a device paired on the LAN, and closes it when the device is revoked", async () => {
    const { pair, stream, codes, devices, origin } = await lan();
    const paired = await pair(codes.issue().code);
    const ws = stream({ cookie: paired.cookie, origin });
    const first = await new Promise((resolve) =>
      ws.once("message", (d: Buffer) => resolve(d.toString("utf8"))),
    );
    const closed = new Promise((resolve) => ws.once("close", () => resolve("closed")));
    devices.revoke(PairResponse.parse(JSON.parse(paired.body)).deviceId);
    expect([first, await closed]).toEqual(["hello", "closed"]);
  });

  it("refuses an upgrade without Origin, even from a device paired on the LAN", async () => {
    const { pair, stream, codes } = await lan();
    const paired = await pair(codes.issue().code);
    expect(await upgradeOutcome(stream({ cookie: paired.cookie }))).toBe(403);
  });

  it("refuses another host name, and an action from another origin", async () => {
    const { call, codes, origin } = await lan();
    const otherHost = await call("/v1/state", { headers: { host: "192.168.1.20:7942" } });
    const otherOrigin = await call("/v1/pairing", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: { code: codes.issue().code },
    });
    const ownOrigin = await call("/v1/pairing", {
      method: "POST",
      headers: { origin },
      body: { code: "WRONGONE" },
    });
    expect([otherHost.status, otherOrigin.status, ownOrigin.status]).toEqual([421, 403, 401]);
  });

  it("limits pairing attempts by the peer's address, apart from loopback's", async () => {
    const at = { peer: "192.168.1.30" };
    const { pair, codes, origin } = await lan({ peer: () => at.peer });
    const { code } = codes.issue();
    const statuses: number[] = [];
    for (const [peer, count] of [
      ["192.168.1.30", 6],
      ["192.168.1.31", 5],
      ["192.168.1.32", 1],
    ] as const) {
      at.peer = peer;
      for (let i = 0; i < count; i++) statuses.push((await pair("WRONGONE")).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 401, 401, 401, 401, 401, 429]);
    // The LAN's window is full; loopback's is its own.
    expect(codes.attempt(code, origin).kind).toBe("paired");
  });

  it("knows the peer by its socket", async () => {
    const seen: (string | undefined)[] = [];
    const { pair, codes } = await lan({
      peer: (c) => {
        seen.push(lanPeer(c));
        return lanPeer(c);
      },
    });
    await pair(codes.issue().code);
    expect(seen).toEqual(["127.0.0.1"]);
  });

  it("refuses TLS 1.2", async () => {
    const { handshake } = await lan();
    expect(await handshake({ maxVersion: "TLSv1.2" })).not.toBe("handshake");
  });

  it("drops a peer outside the allowed ranges before the handshake", async () => {
    const { handshake } = await lan({ allow: [range("10.0.0.0/8")] });
    expect(await handshake()).toBe("ECONNRESET");
  });

  it("drops a connection past its cap", async () => {
    const { handshake, port } = await lan({ limits: { maxConnections: 1 } });
    const held = tcpConnect({ host: "127.0.0.1", port });
    cleanups.push(() => held.destroy());
    await new Promise((resolve) => held.once("connect", resolve));
    expect(await handshake()).toBe("ECONNRESET");
  });

  it("closes a connection whose handshake doesn't finish in time", async () => {
    const { port } = await lan({ limits: { handshakeMs: 200 } });
    const idle = tcpConnect({ host: "127.0.0.1", port });
    cleanups.push(() => idle.destroy());
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("still open"), 2_000);
      idle.once("close", () => {
        clearTimeout(timer);
        resolve("closed");
      });
    });
    expect(outcome).toBe("closed");
  });

  it("reports an error and closes only itself, as when its port is taken", async () => {
    const first = await lan();
    const failure = await new Promise<NodeJS.ErrnoException>((resolve) => {
      lanListener({
        commands,
        devices: first.devices,
        codes: first.codes,
        certificate: cert(),
        port: first.port,
        hostname: "127.0.0.1",
        allow: [range("127.0.0.0/8")],
        streams: [],
        failed: resolve,
      });
    });
    const stillServing = await first.call("/v1/state");
    expect([failure.code, stillServing.status]).toEqual(["EADDRINUSE", 401]);
  });

  it("drops a peer's connection past its own share, though the listener has room", async () => {
    const { handshake, port } = await lan({ limits: { maxPerPeer: 1 } });
    const held = tcpConnect({ host: "127.0.0.1", port });
    cleanups.push(() => held.destroy());
    await new Promise((resolve) => held.once("connect", resolve));
    expect(await handshake()).toBe("ECONNRESET");
  });

  it("gives a peer its share back as its connections close", async () => {
    const { handshake, port } = await lan({ limits: { maxPerPeer: 1 } });
    const first = tcpConnect({ host: "127.0.0.1", port });
    await new Promise((resolve) => first.once("connect", resolve));
    first.destroy();
    await new Promise((resolve) => first.once("close", resolve));
    await expect
      .poll(() => handshake(), {
        timeout: 2_000,
        interval: 50,
        message: "127.0.0.1 never got its share back after its connection closed",
      })
      .toBe("handshake");
  });

  it("stops listening and closes its open streams when it fails, as doctor then reports", async () => {
    const failures: Error[] = [];
    const { pair, stream, handshake, codes, origin, server } = await lan({
      failed: (err) => failures.push(err),
    });
    const paired = await pair(codes.issue().code);
    const ws = stream({ cookie: paired.cookie, origin });
    await new Promise((resolve) => ws.once("message", resolve));
    const closed = new Promise((resolve) => ws.once("close", () => resolve("closed")));
    server.emit("error", Object.assign(new Error("accept failed"), { code: "EMFILE" }));
    expect([await closed, failures.length, await handshake()]).toEqual([
      "closed",
      1,
      "ECONNREFUSED",
    ]);
  });
});
