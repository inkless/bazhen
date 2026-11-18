import { describe, expect, it } from "vitest";
import { deviceStorageOf } from "./storage.ts";

/** Storage held in a map, as the browser's would be. */
function memory() {
  const items = new Map<string, string>();
  const storage = deviceStorageOf(() => ({
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }));
  return { items, storage };
}

const blocked = () => {
  throw new DOMException("site data is blocked", "SecurityError");
};

const refusing = () => ({ getItem: blocked, setItem: blocked, removeItem: blocked });

describe("this device's storage", () => {
  it("reads back what it stored, and nothing once a key is forgotten", () => {
    const { items, storage } = memory();
    storage.write("bazhen.k", "v");
    const stored = storage.read("bazhen.k");
    storage.write("bazhen.k", null);
    expect([stored, storage.read("bazhen.k"), items.has("bazhen.k")]).toEqual(["v", null, false]);
  });

  it("finds nothing, and keeps nothing, when storage can't even be reached", () => {
    const storage = deviceStorageOf(blocked);
    expect(() => storage.write("bazhen.k", "v")).not.toThrow();
    expect(() => storage.write("bazhen.k", null)).not.toThrow();
    expect(storage.read("bazhen.k")).toBeNull();
  });

  it("finds nothing, and keeps nothing, when storage refuses each call", () => {
    const storage = deviceStorageOf(refusing);
    expect(() => storage.write("bazhen.k", "v")).not.toThrow();
    expect(() => storage.write("bazhen.k", null)).not.toThrow();
    expect(storage.read("bazhen.k")).toBeNull();
  });
});
