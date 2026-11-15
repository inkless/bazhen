import { describe, expect, it } from "vitest";
import { DEVICE_PAIRED } from "@bazhen/protocol";
import { DeviceAuth } from "../auth/devices.ts";
import { CLOSED_NOTICES_SHOWN, DEVICE_PAIRED_SUMMARY, Store } from "../store/store.ts";
import { tempDb, testView } from "../testing/fixtures.ts";
import { NoticeClosed, NoticeRefused, Notices, type Viewer } from "./notices.ts";

const lan = { origin: "https://my-mac.local:7942", address: "192.168.1.30" };

function paired(path = tempDb()) {
  const store = Store.open(path);
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
    const { deviceId } = devices.pair("Ph‮one\n", true, lan);
    expect(seenBy("owner")).toMatchObject([
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

  it("is still the only one after the daemon restarts", () => {
    const path = tempDb();
    const first = paired(path);
    first.devices.pair("Phone", true, lan);
    first.store.close();
    const again = paired(path);
    expect(again.seenBy("owner")).toHaveLength(1);
    again.store.close();
  });

  it("offers its own device no dismissal, and every other device and the owner one", () => {
    const { store, devices, seenBy } = paired();
    const phone = devices.pair("Phone", true, lan).deviceId;
    const laptop = devices.pair("Laptop", true, lan).deviceId;
    const offered = (viewer: Viewer) =>
      seenBy(viewer).map((n) => [n.device?.id, n.actions.length > 0]);
    expect([offered(phone), offered(laptop), offered("owner")]).toEqual([
      [
        [phone, false],
        [laptop, true],
      ],
      [
        [phone, true],
        [laptop, false],
      ],
      [
        [phone, true],
        [laptop, true],
      ],
    ]);
    store.close();
  });

  it("refuses its own device's dismissal, and closes for another's, once per key", () => {
    const { store, devices, notices, seenBy } = paired();
    const phone = devices.pair("Phone", true, lan).deviceId;
    const laptop = devices.pair("Laptop", true, lan).deviceId;
    const id = String(seenBy("owner")[0]?.id);
    expect(() => notices.dismiss(id, key("k1"), phone)).toThrow(NoticeRefused);
    const first = notices.dismiss(id, key("k2"), laptop);
    expect(notices.dismiss(id, key("k2"), laptop)).toEqual(first);
    expect(() => notices.dismiss(id, key("k3"), "owner")).toThrow(NoticeClosed);
    expect(seenBy("owner")[0]).toMatchObject({ state: "closed", closeReason: "dismissed" });
    store.close();
  });

  it("closes as revoked when its device is revoked, and a second revoke records nothing", () => {
    const { store, devices, seenBy } = paired();
    const { deviceId } = devices.pair("Phone", true, lan);
    devices.revoke(deviceId);
    const after = store.latestEventId();
    devices.revoke(deviceId);
    expect(seenBy("owner")).toMatchObject([
      { state: "closed", closeReason: "revoked", actions: [] },
    ]);
    expect(store.latestEventId()).toBe(after);
    store.close();
  });

  it("is in the snapshot while open, but only the latest closed ones are", () => {
    const { store, devices, seenBy } = paired();
    const closed = Array.from({ length: CLOSED_NOTICES_SHOWN + 1 }, (_, i) => {
      const { deviceId } = devices.pair(`Old ${i}`, true, lan);
      devices.revoke(deviceId);
      return deviceId;
    });
    const open = devices.pair("New", true, lan).deviceId;
    const shown = seenBy("owner").map((n) => n.device?.id);
    expect(shown).toEqual([...closed.slice(1), open]);
    store.close();
  });
});
