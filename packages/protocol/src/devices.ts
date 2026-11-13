import { z } from "zod";
import { Id } from "./ids.ts";

/** RFC 4648 base32: what a pairing code is drawn from (foundation-design §12 item 4). */
export const PAIRING_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PAIRING_CODE_LENGTH = 8;

export const DEVICE_NAME_MAX = 64;

/**
 * `POST /v1/pairing/codes`, on the Unix socket only: a fresh code, replacing any earlier one.
 * `origins` are the configured external origins, the addresses another device would open.
 */
export const PairingCodeResponse = z.object({
  code: z.string().length(PAIRING_CODE_LENGTH),
  expiresAt: z.iso.datetime(),
  origins: z.array(z.string()),
});
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

/** `POST /v1/pairing`: a browser trades a code for a device cookie. */
export const PairRequest = z.object({
  /** As typed: case, spaces and dashes don't matter. */
  code: z.string().max(32),
  name: z.string().max(DEVICE_NAME_MAX).optional(),
});
export type PairRequest = z.infer<typeof PairRequest>;

/** The token itself travels only in the `Set-Cookie` header of this response. */
export const PairResponse = z.object({ deviceId: Id("dev"), name: z.string() });
export type PairResponse = z.infer<typeof PairResponse>;

export const Device = z.object({
  id: Id("dev"),
  name: z.string(),
  pairedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /** When the session lapses unless the device is used before then. */
  expiresAt: z.iso.datetime(),
});
export type Device = z.infer<typeof Device>;

/** `GET /v1/devices`, on the Unix socket only: every device not revoked, expired ones too. */
export const DevicesResponse = z.object({ devices: z.array(Device) });
export type DevicesResponse = z.infer<typeof DevicesResponse>;

/** `POST /v1/devices/:id/revoke`, on the Unix socket only. Revoking twice is not an error. */
export const RevokeDeviceResponse = z.object({});
export type RevokeDeviceResponse = z.infer<typeof RevokeDeviceResponse>;
