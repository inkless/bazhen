import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Store, UnknownDevice } from "../store/store.ts";
import { tempDb } from "../testing/fixtures.ts";
import {
  DeviceAuth,
  LOOPBACK_IDLE_MS,
  SECURE_IDLE_MS,
  TOUCH_EVERY_MS,
  deviceCookie,
  tokenFrom,
} from "./devices.ts";

function auth() {
  const path = tempDb();
  const store = Store.open(path);
  const clock = { now: Date.parse("2026-11-12T00:00:00.000Z") };
  const logged: string[] = [];
  const devices = new DeviceAuth(store, {
    now: () => new Date(clock.now),
    log: (line) => logged.push(line),
  });
  return { path, store, clock, logged, devices };
}

/** A token as the HTTPS cookie presents it; `overHttp` as the loopback one does. */
const https = (token: string) => ({ token, secure: true });
const overHttp = (token: string) => ({ token, secure: false });

/** `token` with its last character changed. */
const tamper = (token: string) => `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

describe("DeviceAuth", () => {
  it("accepts the token it paired a device with, and no other", () => {
    const { devices } = auth();
    const { token, deviceId } = devices.pair("Phone", true);
    const laptop = devices.pair("Laptop", true);
    expect([
      devices.verify(https(token))?.device.id,
      devices.verify(https(laptop.token))?.device.id,
      devices.verify(https(tamper(token))),
      devices.verify(undefined),
    ]).toEqual([deviceId, laptop.deviceId, null, null]);
  });

  it("keeps only the token's hash, and puts neither in the event log nor its own log", () => {
    const { devices, path, store, logged } = auth();
    const { token } = devices.pair("Phone", true);
    const hash = createHash("sha256").update(token).digest("hex");
    store.close();
    const raw = new DatabaseSync(path);
    const stored = raw.prepare("SELECT token_hash FROM devices").all();
    const events = JSON.stringify(raw.prepare("SELECT * FROM events").all());
    raw.close();
    expect(stored).toEqual([{ token_hash: hash }]);
    const log = logged.join("\n");
    expect([events, log].flatMap((text) => [text.includes(token), text.includes(hash)])).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(events).toContain("device.paired");
  });

  it("says in its log when a device is paired and when one is revoked", () => {
    const { devices, logged } = auth();
    const { deviceId } = devices.pair("Phone", true);
    devices.revoke(deviceId);
    expect(logged).toEqual([
      `bazhen: paired a device, "Phone" (${deviceId})`,
      `bazhen: revoked device ${deviceId}`,
    ]);
  });

  it("names a device Browser when it gives no name, and trims a long one", () => {
    const { devices } = auth();
    expect(devices.pair(undefined, true).name).toBe("Browser");
    expect(devices.pair("  ", true).name).toBe("Browser");
    expect(devices.pair("x".repeat(100), true).name).toHaveLength(64);
  });

  it("drops control and bidi characters from a name, which could disguise it", () => {
    const { devices } = auth();
    expect(devices.pair("Ph\u0000o‮ne\n\u001b[2J", true).name).toBe("Phone[2J");
  });

  it("refuses a revoked device's token", () => {
    const { devices } = auth();
    const { token, deviceId } = devices.pair("Phone", true);
    devices.revoke(deviceId);
    expect([devices.verify(https(token)), devices.list()]).toEqual([null, []]);
  });

  it("records one revocation however often it is asked for, and refuses an unknown id", () => {
    const { devices, store } = auth();
    const { deviceId } = devices.pair("Phone", true);
    devices.revoke(deviceId);
    devices.revoke(deviceId);
    expect(store.events(0).filter((e) => e.type === "device.revoked")).toHaveLength(1);
    expect(() => devices.revoke("dev_nope")).toThrow(UnknownDevice);
  });

  it("closes every socket the revoked device holds, and no other device's", () => {
    const { devices } = auth();
    const phone = devices.pair("Phone", true).deviceId;
    const laptop = devices.pair("Laptop", true).deviceId;
    const [a, b, c] = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    devices.hold(phone, a, { required: true });
    devices.hold(phone, b, { required: false });
    devices.hold(laptop, c, { required: true });
    devices.revoke(phone);
    expect([a.destroyed, b.destroyed, c.destroyed]).toEqual([true, true, false]);
  });

  it("lapses a device paired over HTTPS after 30 days unused", () => {
    const { devices, clock } = auth();
    const { token } = devices.pair("Phone", true);
    clock.now += SECURE_IDLE_MS - 1;
    const before = devices.verify(https(token), { touch: false });
    clock.now += 1;
    expect([before?.device.name, devices.verify(https(token))]).toEqual(["Phone", null]);
  });

  it("lapses a device paired over plain HTTP after a day unused", () => {
    const { devices, clock } = auth();
    const { token } = devices.pair("Laptop", false);
    clock.now += LOOPBACK_IDLE_MS - 1;
    const before = devices.verify(overHttp(token), { touch: false });
    clock.now += 1;
    expect([before?.device.name, devices.verify(overHttp(token))]).toEqual(["Laptop", null]);
  });

  it("closes a revoked device's sockets and a lapsed one's that had to pair when swept, and leaves the rest open", () => {
    const { devices, store, clock } = auth();
    const laptop = devices.pair("Laptop", false).deviceId;
    const phone = devices.pair("Phone", true).deviceId;
    const tablet = devices.pair("Tablet", false).deviceId;
    const [a, b, c, d] = [new FakeSocket(), new FakeSocket(), new FakeSocket(), new FakeSocket()];
    devices.hold(laptop, a, { required: true });
    devices.hold(laptop, b, { required: false });
    devices.hold(phone, c, { required: true });
    devices.hold(tablet, d, { required: false });
    store.revokeDevice(tablet, new Date(clock.now));
    clock.now += LOOPBACK_IDLE_MS;
    devices.sweep();
    expect([a, b, c, d].map((s) => s.destroyed)).toEqual([true, false, false, true]);
  });

  it("restarts a device's lifetime when it is used, writing that at most hourly", () => {
    const { devices, clock } = auth();
    const { token } = devices.pair("Phone", true);
    clock.now += TOUCH_EVERY_MS - 1;
    expect(devices.verify(https(token))?.refresh).toBe(false);
    clock.now += 1;
    expect(devices.verify(https(token))?.refresh).toBe(true);
    clock.now += SECURE_IDLE_MS - 1;
    expect(devices.verify(https(token))).not.toBeNull();
  });

  it("accepts a token only in the cookie of the scheme its device was paired over", () => {
    const { devices } = auth();
    const phone = devices.pair("Phone", true).token;
    const laptop = devices.pair("Laptop", false).token;
    expect([
      devices.verify(https(phone))?.device.name,
      devices.verify(overHttp(phone)),
      devices.verify(overHttp(laptop))?.device.name,
      devices.verify(https(laptop)),
    ]).toEqual(["Phone", null, "Laptop", null]);
  });

  it("records no use for a caller that can't set the cookie again, such as an upgrade", () => {
    const { devices, clock } = auth();
    const { token } = devices.pair("Phone", true);
    clock.now += TOUCH_EVERY_MS;
    devices.verify(https(token), { touch: false });
    expect(devices.verify(https(token))?.refresh).toBe(true);
  });
});

describe("the device cookie", () => {
  const token = "t".repeat(43);

  it("is a __Host- cookie on HTTPS: Secure, this host only, every path", () => {
    expect(deviceCookie(token, true)).toBe(
      `__Host-bazhen_device=${token}; Secure; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`,
    );
  });

  it("on plain HTTP is kept to /v1, without Secure, and lasts a day", () => {
    expect(deviceCookie(token, false)).toBe(
      `bazhen_device=${token}; Path=/v1; Max-Age=86400; HttpOnly; SameSite=Strict`,
    );
  });

  it("is read back from a Cookie header under either name", () => {
    expect([
      tokenFrom(`theme=dark; __Host-bazhen_device=${token}`),
      tokenFrom(`bazhen_device=${token}`),
      tokenFrom("theme=dark"),
    ]).toEqual([https(token), overHttp(token), undefined]);
  });
});
