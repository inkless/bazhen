import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, SchemaTooNew, Store } from "./store.ts";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "bz-store-")), "bazhen.db");
const event = {
  type: "terminal.created",
  entityType: "terminal",
  entityId: "term_1",
  actor: "system",
  payload: {},
};

describe("Store", () => {
  it("migrates a fresh database to the latest schema, and reopening is a no-op", () => {
    const path = dbPath();
    Store.open(path).close();
    const again = Store.open(path);
    expect(again.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    again.close();
  });

  it("refuses a database written by a newer build", () => {
    const path = dbPath();
    Store.open(path, [
      { version: 1, sql: "SELECT 1" },
      { version: 9, sql: "SELECT 1" },
    ]).close();
    expect(() => Store.open(path)).toThrow(SchemaTooNew);
  });

  it("records no event when its projection fails", () => {
    const store = Store.open(dbPath());
    expect(() =>
      store.append(event, () => {
        throw new Error("projection failed");
      }),
    ).toThrow("projection failed");
    expect(store.eventsAfter(0)).toEqual([]);
    store.close();
  });

  it("keeps the same HostId across reopen, and stamps it on events", () => {
    const path = dbPath();
    const first = Store.open(path);
    const host = first.hostId();
    first.append(event);
    first.close();
    const again = Store.open(path);
    expect(host).toMatch(/^host_[0-9a-f]{32}$/);
    expect(again.hostId()).toBe(host);
    again.close();
  });

  it("orders events by id for resumable streams", () => {
    const store = Store.open(dbPath());
    const a = store.append(event);
    const b = store.append({ ...event, entityId: "term_2" });
    expect(store.eventsAfter(a).map((e) => e.id)).toEqual([b]);
    store.close();
  });
});
