import { describe, expect, it } from "vitest";
import { DEVICE_PAIRED } from "@bazhen/protocol";
import { DeviceAuth } from "../auth/devices.ts";
import {
  CLOSED_NOTICES_SHOWN,
  DEVICE_PAIRED_SUMMARY,
  IdempotencyConflict,
  Store,
} from "../store/store.ts";
import { tempDb, testView } from "../testing/fixtures.ts";
import { NoticeClosed, NoticeRefused, Notices, type Viewer } from "./notices.ts";

const lan = { origin: "https://my-mac.local:7942", address: "192.168.1.30" };

function paired() {
  const store = Store.open(tempDb());
  const devices = new DeviceAuth(store, { log: () => {} });
  const notices = new Notices(store);
  const seenBy = (viewer: Viewer) =>
    store.snapshot({ ...testView, noticeActions: (n) => notices.actions(n, viewer) }).notices;
  return { store, devices, notices, seenBy };
}

const key = (k: string) => ({ idempotencyKey: k });

describe("a pairing's notice", () => {
  it("opens with the pairing, naming the device as stored and where it paired from", () => {
    const { store, devices, seenBy } = paired();
    const { deviceId } = devices.pair("Ph\u202eone\n", true, lan);
    expect(seenBy("owner-socket")).toMatchObject([
      {
        kind: DEVICE_PAIRED,
        state: "open",
        closeReason: null,
        summary: DEVICE_PAIRED_SUMMARY,
        device: { id: deviceId, name: "Phone", ...lan },
        actions: ["dismiss"],
      },
    ]);
    store.close();
  });

  it("offers a dismissal to the owner on this machine only, never to a paired device", () => {
    const { store, devices, seenBy } = paired();
    const phone = devices.pair("Phone", true, lan).deviceId;
    const other = devices.pair("iPhone", true, lan).deviceId;
    const offered = (viewer: Viewer) => seenBy(viewer).map((n) => n.actions);
    expect([
      offered(phone),
      offered(other),
      offered("owner-socket"),
      offered("owner-loopback"),
    ]).toEqual([
      [[], []],
      [[], []],
      [["dismiss"], ["dismiss"]],
      [["dismiss"], ["dismiss"]],
    ]);
    store.close();
  });

  it("refuses a dismissal from any paired device, the one it is about or another", () => {
    const { store, devices, notices, seenBy } = paired();
    const phone = devices.pair("Phone", true, lan).deviceId;
    const other = devices.pair("iPhone", true, lan).deviceId;
    const id = String(seenBy("owner-socket")[0]?.id);
    expect(() => notices.dismiss(id, key("k1"), phone)).toThrow(NoticeRefused);
    expect(() => notices.dismiss(id, key("k2"), other)).toThrow(NoticeRefused);
    expect(seenBy("owner-socket")[0]?.state).toBe("open");
    store.close();
  });

  it("closes for the owner, once per key and viewer, recording where the owner dismissed it", () => {
    const { store, devices, notices, seenBy } = paired();
    const phone = devices.pair("Phone", true, lan).deviceId;
    const id = String(seenBy("owner-socket")[0]?.id);
    const first = notices.dismiss(id, key("k1"), "owner-loopback");
    expect(notices.dismiss(id, key("k1"), "owner-loopback")).toEqual(first);
    expect(() => notices.dismiss(id, key("k1"), phone)).toThrow(IdempotencyConflict);
    expect(() => notices.dismiss(id, key("k2"), "owner-socket")).toThrow(NoticeClosed);
    const closed = store.events(0).find((e) => e.type === "notice.closed");
    expect([seenBy("owner-socket")[0], closed?.payload]).toMatchObject([
      { closeReason: "dismissed", closedBy: "owner-loopback", closedFrom: null },
      { reason: "dismissed", by: "owner-loopback" },
    ]);
    store.close();
  });

  it("notes the paired device whose shell dismissed it, and nothing for an id it never paired", () => {
    const { store, devices, notices, seenBy } = paired();
    const laptop = devices.pair("Laptop", true, lan).deviceId;
    devices.pair("Phone", true, lan);
    const [ofLaptop, ofPhone] = seenBy("owner-socket").map((n) => n.id);
    notices.dismiss(
      String(ofLaptop),
      key("k1"),
      "owner-socket",
      "dev_01900000000070008000000000000009",
    );
    notices.dismiss(String(ofPhone), key("k2"), "owner-socket", laptop);
    expect(seenBy("owner-socket").map((n) => n.closedFrom)).toEqual([
      null,
      { id: laptop, name: "Laptop" },
    ]);
    store.close();
  });

  it("closes as revoked when its device is revoked, and a second revoke records nothing", () => {
    const { store, devices, seenBy } = paired();
    const { deviceId } = devices.pair("Phone", true, lan);
    devices.revoke(deviceId);
    const after = store.latestEventId();
    devices.revoke(deviceId);
    expect(seenBy("owner-socket")).toMatchObject([
      { state: "closed", closeReason: "revoked", actions: [] },
    ]);
    expect(store.latestEventId()).toBe(after);
    store.close();
  });

  it("revokes a device whose notice was already dismissed, closing nothing twice", () => {
    const { store, devices, notices, seenBy } = paired();
    const { deviceId } = devices.pair("Phone", true, lan);
    notices.dismiss(String(seenBy("owner-socket")[0]?.id), key("k1"), "owner-socket");
    devices.revoke(deviceId);
    expect([
      store.devices().map((d) => d.id),
      store.events(0).filter((e) => e.type === "notice.closed").length,
      seenBy("owner-socket")[0]?.closeReason,
    ]).toEqual([[], 1, "dismissed"]);
    store.close();
  });

  it("is in the snapshot while open, but of the closed only the latest closed are", () => {
    const { store, devices, seenBy } = paired();
    const ids = Array.from(
      { length: CLOSED_NOTICES_SHOWN + 1 },
      (_, i) => devices.pair(`Old ${i}`, true, lan).deviceId,
    );
    const open = devices.pair("New", true, lan).deviceId;
    // Closed newest-opened first, so the one closed first, and dropped, is the last to open.
    for (const id of ids.toReversed()) devices.revoke(id);
    const shown = seenBy("owner-socket").map((n) => n.device?.id);
    expect(shown).toEqual([...ids.slice(0, -1), open]);
    store.close();
  });
});
