import { describe, expect, it } from "vitest";
import { StateSnapshot } from "./agents.ts";
import { EVENTS } from "./events.ts";
import { DEVICE_PAIRED, Notice } from "./notices.ts";

const notice = {
  id: "ntc_01900000000070008000000000000001",
  kind: DEVICE_PAIRED,
  state: "open",
  closeReason: null,
  summary: "A new device paired",
  openedAt: "2026-11-15T12:00:00.000Z",
  device: {
    id: "dev_01900000000070008000000000000002",
    name: "Phone",
    origin: "https://my-mac.local:7942",
    address: "192.168.1.30",
  },
  actions: ["dismiss"],
  closedBy: null,
  closedFrom: null,
};

describe("notices", () => {
  it("reads a snapshot from a daemon older than notices as having none", () => {
    const older = {
      epoch: "e",
      eventId: 0,
      environments: [],
      agents: [],
      attention: [],
      messages: [],
    };
    expect(StateSnapshot.parse(older).notices).toEqual([]);
  });

  it("reads a notice with a kind, close reason or action this build doesn't know", () => {
    const later = {
      ...notice,
      kind: "certificate_expiring",
      state: "closed",
      closeReason: "expired",
      closedBy: "timer",
      device: null,
      actions: ["renew"],
    };
    expect(Notice.safeParse(later).success).toBe(true);
  });

  it("refuses a notice whose device is named by an id that isn't a device's", () => {
    const device = { ...notice.device, id: "agent_01900000000070008000000000000002" };
    expect(Notice.safeParse({ ...notice, device }).success).toBe(false);
  });

  it("records who closed a notice from where, and refuses a close that doesn't say", () => {
    const closed = EVENTS["notice.closed"].payload;
    expect([
      closed.safeParse({ reason: "dismissed", by: "owner-socket" }).success,
      closed.safeParse({ reason: "revoked", by: "revoke" }).success,
      closed.safeParse({ reason: "dismissed", by: "owner-loopback" }).success,
      closed.safeParse({ reason: "dismissed" }).success,
      closed.safeParse({ reason: "answered", by: "owner-socket" }).success,
    ]).toEqual([true, true, true, false, false]);
  });
});
