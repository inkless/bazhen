import { mkdtempSync, rmSync } from "node:fs";
import { request as httpsRequest, type Server } from "node:https";
import { connect } from "node:tls";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type ClientOptions } from "ws";
import { FakeRuntime } from "@bazhen/core/testing";
import { PairResponse } from "@bazhen/protocol";
import { DeviceAuth, LOOPBACK_COOKIE, SECURE_COOKIE } from "../auth/devices.ts";
import { PairingCodes } from "../auth/pairing.ts";
import { parseCidr, type Cidr } from "../config/cidr.ts";
import { Store } from "../store/store.ts";
import { tempDb, upgradeOutcome } from "../testing/fixtures.ts";
import { lanCertificate, type LanCertificate } from "../tls/material.ts";
import { createApp, type AppDeps } from "./app.ts";
import { upgrades, type UpgradeRoute } from "./upgrades.ts";
import { lanAllowlists, lanPeer, serveLan } from "./lan.ts";

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
    certificate = lanCertificate(join(dir, "tls"), { name, uid: userInfo().uid });
  }
  return certificate;
}

/** The LAN listener on 127.0.0.1, admitting `allow`, with a device store and one echo stream. */
async function lan(
  allow: readonly Cidr[] = [range("127.0.0.0/8")],
  peer: AppDeps["lan"] = { peer: lanPeer },
) {
  const store = Store.open(tempDb());
  const devices = new DeviceAuth(store, { log: () => {} });
  const codes = new PairingCodes({ log: () => {} });
  const allowlists = { hosts: [] as string[], origins: [] as string[] };
  const gate = { devices, always: true, remote: true };
  const deps: AppDeps = {
    appVersion: "0.1.0",
    schemaVersion: () => 1,
    runtime: new FakeRuntime(),
    allow: allowlists,
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
      send: refuse,
    },
    pairing: { codes, devices },
    gate,
    lan: peer,
  };
  const wss = new WebSocketServer({ noServer: true });
  const route: UpgradeRoute = {
    path: /^\/echo$/,
    upgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.send("hello")),
  };
  const port = await new Promise<number>((resolve) => {
    const server: Server = serveLan({
      app: createApp(deps),
      certificate: cert(),
      port: 0,
      hostname: "127.0.0.1",
      allow,
      upgrade: upgrades(allowlists, [route], gate),
      listening: resolve,
    });
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
  });
  const { hosts, origins } = lanAllowlists(name, port);
  allowlists.hosts.push(...hosts);
  allowlists.origins.push(...origins);
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
  return { call, pair, stream, codes, devices, origin, port };
}

describe("the LAN listener", () => {
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
    const { token } = devices.pair("Laptop", false);
    const cookie = `${LOOPBACK_COOKIE}=${token}`;
    const statuses = [
      (await call("/v1/state", { headers: { cookie } })).status,
      (await call("/v1/state", { headers: { cookie, origin } })).status,
      await upgradeOutcome(stream({ cookie, origin })),
    ];
    expect(statuses).toEqual([401, 401, 401]);
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
    const { pair, codes, origin } = await lan(undefined, { peer: () => at.peer });
    const { code } = codes.issue();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await pair("WRONGONE")).status);
    at.peer = "192.168.1.31";
    statuses.push((await pair("WRONGONE")).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 401]);
    expect(codes.attempt(code, origin).kind).toBe("paired");
  });

  it("knows the peer by its socket", async () => {
    const seen: (string | undefined)[] = [];
    const { pair, codes } = await lan(undefined, {
      peer: (c) => {
        seen.push(lanPeer(c));
        return lanPeer(c);
      },
    });
    await pair(codes.issue().code);
    expect(seen).toEqual(["127.0.0.1"]);
  });

  it("refuses TLS 1.2", async () => {
    const { port } = await lan();
    const outcome = await new Promise((resolve) => {
      const socket = connect({
        host: "127.0.0.1",
        port,
        servername: name,
        ca: cert().cert,
        maxVersion: "TLSv1.2",
      });
      socket.once("secureConnect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.once("error", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  });

  it("drops a peer outside the allowed ranges before the handshake", async () => {
    const { port } = await lan([range("10.0.0.0/8")]);
    const outcome = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port, servername: name, ca: cert().cert });
      socket.once("secureConnect", () => {
        resolve("handshake");
        socket.destroy();
      });
      socket.once("error", (err: NodeJS.ErrnoException) => resolve(err.code));
    });
    expect(outcome).toBe("ECONNRESET");
  });
});

afterEach(() => {
  if (certificate !== undefined)
    rmSync(join(certificate.path, "..", ".."), { recursive: true, force: true });
  certificate = undefined;
});
