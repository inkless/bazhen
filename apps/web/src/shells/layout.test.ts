import { describe, expect, it } from "vitest";
import { DOCK_KEY, layoutStore, parseLayout } from "./layout.ts";

/** Storage held in a map, as the browser's would be. */
function memory() {
  const items = new Map<string, string>();
  return {
    items,
    storage: () => ({
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    }),
  };
}

describe("the dock's layout on this device", () => {
  it("reads what it can of a stored layout, and the default for anything else", () => {
    expect([
      parseLayout('{"position":"right","hidden":true}'),
      parseLayout('{"position":"left"}'),
      parseLayout("not json"),
      parseLayout(null),
    ]).toEqual([
      { position: "right", hidden: true },
      { position: "bottom", hidden: false },
      { position: "bottom", hidden: false },
      { position: "bottom", hidden: false },
    ]);
  });

  it("keeps a change, tells whoever listens, and a store opened later reads it back", () => {
    const { items, storage } = memory();
    let told = 0;
    const store = layoutStore(storage);
    store.subscribe(() => told++);
    store.write({ position: "right", hidden: false });
    expect([told, items.get(DOCK_KEY), layoutStore(storage).read()]).toEqual([
      1,
      '{"position":"right","hidden":false}',
      { position: "right", hidden: false },
    ]);
  });

  it("still changes for this page when storage refuses it", () => {
    const store = layoutStore(() => {
      throw new Error("site data blocked");
    });
    store.write({ position: "right", hidden: true });
    expect(store.read()).toEqual({ position: "right", hidden: true });
  });
});
