import { z } from "zod";
import { Id } from "./ids.ts";
import { DismissAttentionRequest, DismissAttentionResponse } from "./mail.ts";

/** The one kind a daemon opens today: a device paired. */
export const DEVICE_PAIRED = "device_paired";

/**
 * Why a notice closed: the human put it away, or the device it is about was revoked, which
 * answers it.
 */
export const NoticeCloseReason = z.enum(["dismissed", "revoked"]);
export type NoticeCloseReason = z.infer<typeof NoticeCloseReason>;

export const NoticeState = z.enum(["open", "closed"]);
export type NoticeState = z.infer<typeof NoticeState>;

export const NoticeAction = z.enum(["dismiss"]);
export type NoticeAction = z.infer<typeof NoticeAction>;

/** The device a notice is about, as the daemon stored and saw it. */
export const NoticeDevice = z.object({
  id: Id("dev"),
  /** As stored: printable, trimmed, at most `DEVICE_NAME_MAX` characters. */
  name: z.string(),
  /** The allowed origin it paired from. */
  origin: z.string(),
  /** The connection's own peer, on the LAN listener only; never a forwarding header's. */
  address: z.string().nullable(),
});
export type NoticeDevice = z.infer<typeof NoticeDevice>;

/**
 * Something the human should know that no agent raised (protocol 1.38). `kind` is a string,
 * not an enum: `/v1/state` can't tell which version a client speaks, so a kind added later
 * must not fail an older client's whole snapshot. A client shows a kind it doesn't know by its
 * `summary`, which the daemon writes and which carries nothing a device chose.
 */
export const Notice = z.object({
  id: Id("ntc"),
  kind: z.string(),
  state: NoticeState,
  closeReason: NoticeCloseReason.nullable(),
  summary: z.string(),
  /** When it opened, as an ISO timestamp. */
  openedAt: z.iso.datetime(),
  device: NoticeDevice.nullable(),
  /** What the viewer can do about it now: never dismiss, for the device it is about. */
  actions: z.array(NoticeAction),
});
export type Notice = z.infer<typeof Notice>;

/** `POST /v1/notices/:id/dismiss`. */
export const DismissNoticeRequest = DismissAttentionRequest;
export type DismissNoticeRequest = z.infer<typeof DismissNoticeRequest>;

export const DismissNoticeResponse = DismissAttentionResponse;
export type DismissNoticeResponse = z.infer<typeof DismissNoticeResponse>;
