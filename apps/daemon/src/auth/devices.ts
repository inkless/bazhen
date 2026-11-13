import { createHash, randomBytes } from "node:crypto";
import { parse } from "hono/utils/cookie";
import type { DeviceId } from "@bazhen/core";
import { DEVICE_NAME_MAX, type Device } from "@bazhen/protocol";
import type { Store, StoredDevice } from "../store/store.ts";
import { forwardedFromElsewhere } from "./forwarded.ts";

/**
 * On HTTPS, a `__Host-` cookie: Secure, for this host only, every path. Plain HTTP is loopback in
 * practice, where a cookie can't be held to one port, so other local servers' `/v1` receive it
 * too; it is kept to `/v1` and lapses sooner (foundation-design §9.2).
 */
export const SECURE_COOKIE = "__Host-bazhen_device";
export const LOOPBACK_COOKIE = "bazhen_device";
/** How long a device paired over HTTPS stays paired without being used. */
export const SECURE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** The same for one paired over plain HTTP, whose cookie other local ports can read. */
export const LOOPBACK_IDLE_MS = 24 * 60 * 60 * 1000;
/** How stale `last_seen_at` may get before a request writes it, and sets the cookie again. */
export const TOUCH_EVERY_MS = 60 * 60 * 1000;
const DEFAULT_NAME = "Browser";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Control and format characters, bidi overrides among them, which could disguise a name. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const idleLimit = (device: { secure: boolean }) =>
  device.secure ? SECURE_IDLE_MS : LOOPBACK_IDLE_MS;

/** A device name as it may be stored and shown: printable, trimmed, and not too long. */
export const deviceName = (requested: string | undefined) =>
  requested?.replace(UNPRINTABLE, "").trim().slice(0, DEVICE_NAME_MAX) || DEFAULT_NAME;

/** What closes when its device is revoked or lapses: a WebSocket's underlying socket. */
export interface Closable {
  destroy(): void;
  once(event: "close", listener: () => void): unknown;
}

/** A request's device, and whether its cookie should be set again to restart its lifetime. */
export interface Verified {
  readonly device: StoredDevice;
  readonly refresh: boolean;
}

/**
 * Paired devices: minting their tokens, checking them on each request, and revoking them along
 * with every socket they hold open. Tokens are 32 random bytes; the store keeps their hash only.
 */
export class DeviceAuth {
  private readonly sockets = new Map<string, Set<Closable>>();
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(store: Store, opts: { now?: () => Date; log?: (line: string) => void } = {}) {
    this.store = store;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? console.log;
  }

  /** The token goes to the browser once, in its cookie, and is never kept here. */
  pair(
    requested: string | undefined,
    secure: boolean,
  ): { deviceId: DeviceId; name: string; token: string } {
    const name = deviceName(requested);
    const token = randomBytes(32).toString("base64url");
    const deviceId = this.store.pairDevice(name, hashToken(token), secure, this.now());
    this.log(`bazhen: paired a device, ${JSON.stringify(name)} (${deviceId})`);
    return { deviceId, name, token };
  }

  /**
   * The device `token` belongs to, if it is still paired and in date. Only a caller that can set
   * the cookie again records the use: one that couldn't would restart the daemon's lifetime but
   * not the browser's.
   */
  verify(
    presented: Presented | undefined,
    opts: { touch?: boolean; remote?: boolean } = {},
  ): Verified | null {
    if (presented === undefined || !TOKEN.test(presented.token)) return null;
    const device = this.store.deviceByToken(hashToken(presented.token));
    if (device === undefined || device.revoked || this.lapsed(device)) return null;
    // Each cookie carries only the token of a device paired over its scheme, so a token copied
    // off a loopback port can't pass as the HTTPS one, nor the reverse.
    if (device.secure !== presented.secure) return null;
    // A request from another machine, or over HTTPS, takes only a device paired over HTTPS:
    // a loopback token, which other local ports can read, is good on loopback alone.
    if (opts.remote === true && !device.secure) return null;
    const idle = this.now().getTime() - Date.parse(device.lastSeenAt);
    if (idle < TOUCH_EVERY_MS || opts.touch === false) return { device, refresh: false };
    this.store.touchDevice(device.id, this.now());
    return { device, refresh: true };
  }

  list(): Device[] {
    return this.store.devices().map((d) => ({
      id: d.id,
      name: d.name,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
      expiresAt: new Date(Date.parse(d.lastSeenAt) + idleLimit(d)).toISOString(),
    }));
  }

  /** Revokes the device and closes every socket it has open, so it can't keep watching. */
  revoke(id: string): void {
    this.store.revokeDevice(id, this.now());
    this.close(id);
    this.log(`bazhen: revoked device ${id}`);
  }

  /** Closes the sockets of every device that has lapsed since it opened them. */
  sweep(): void {
    const live = new Map<string, StoredDevice>(this.store.devices().map((d) => [d.id, d]));
    for (const id of this.sockets.keys()) {
      const device = live.get(id);
      if (device === undefined || this.lapsed(device)) this.close(id);
    }
  }

  /** Tracks a socket a device opened, until it closes. */
  hold(deviceId: DeviceId, socket: Closable): void {
    const open = this.sockets.get(deviceId) ?? new Set();
    open.add(socket);
    this.sockets.set(deviceId, open);
    socket.once("close", () => {
      open.delete(socket);
      if (open.size === 0 && this.sockets.get(deviceId) === open) this.sockets.delete(deviceId);
    });
  }

  private lapsed(device: StoredDevice): boolean {
    return this.now().getTime() - Date.parse(device.lastSeenAt) >= idleLimit(device);
  }

  private close(id: string): void {
    for (const socket of this.sockets.get(id) ?? []) socket.destroy();
    this.sockets.delete(id);
  }
}

/** A device token as a request presented it: which of the two cookies carried it. */
export interface Presented {
  readonly token: string;
  readonly secure: boolean;
}

/** The device token a `Cookie` header carries, if any. */
export function tokenFrom(header: string | undefined): Presented | undefined {
  if (header === undefined) return undefined;
  const cookies = parse(header);
  const secure = cookies[SECURE_COOKIE];
  if (secure !== undefined) return { token: secure, secure: true };
  const loopback = cookies[LOOPBACK_COOKIE];
  return loopback === undefined ? undefined : { token: loopback, secure: false };
}

/**
 * When a request must come from a paired device: always, under the configured mode, or when a
 * proxy says it came from another machine, whatever the mode (foundation-design §9.2).
 */
export interface DeviceGate {
  readonly devices: DeviceAuth;
  readonly always: boolean;
}

export const mustPair = (gate: DeviceGate, header: (name: string) => string | undefined): boolean =>
  gate.always || forwarded(header);

const forwarded = (header: (name: string) => string | undefined) =>
  forwardedFromElsewhere({
    xForwardedFor: header("x-forwarded-for"),
    forwarded: header("forwarded"),
  });

/** Whether a request came from another machine or over HTTPS, rather than straight from loopback. */
export const arrivedRemotely = (header: (name: string) => string | undefined): boolean =>
  forwarded(header) || (header("origin")?.startsWith("https:") ?? false);

/** The `Set-Cookie` value that carries a device's token. */
export function deviceCookie(token: string, secure: boolean): string {
  const scope = secure
    ? [`${SECURE_COOKIE}=${token}`, "Secure", "Path=/", `Max-Age=${SECURE_IDLE_MS / 1000}`]
    : [`${LOOPBACK_COOKIE}=${token}`, "Path=/v1", `Max-Age=${LOOPBACK_IDLE_MS / 1000}`];
  return [...scope, "HttpOnly", "SameSite=Strict"].join("; ");
}
