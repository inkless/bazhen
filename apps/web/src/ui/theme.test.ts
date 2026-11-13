import { describe, expect, test } from "vitest";
import {
  loadTheme,
  parseTheme,
  saveTheme,
  THEME_KEY,
  themeStore,
  type ThemeHost,
} from "./theme.ts";

const holding = (value: string | null) => () => ({ getItem: () => value });
const blocked = () => {
  throw new Error("SecurityError: site data is blocked");
};

describe("the stored theme", () => {
  test("is the device's choice when it names a theme", () => {
    expect(loadTheme(holding("dark"))).toBe("dark");
    expect(loadTheme(holding("light"))).toBe("light");
  });

  test("follows the system when nothing, or nothing it knows, is stored", () => {
    expect(loadTheme(holding(null))).toBe("system");
    expect(parseTheme("Dark")).toBe("system");
  });

  test("follows the system when storage can't even be reached", () => {
    expect(loadTheme(blocked)).toBe("system");
  });
});

describe("saving the theme", () => {
  test("stores a pinned theme and forgets it for the system's", () => {
    const store = new Map<string, string>();
    const storage = () => ({
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    saveTheme("dark", storage);
    expect(store.get(THEME_KEY)).toBe("dark");
    saveTheme("system", storage);
    expect(store.has(THEME_KEY)).toBe(false);
  });

  test("doesn't throw when storage is blocked", () => {
    expect(() => saveTheme("dark", blocked)).not.toThrow();
  });
});

/** A page with a system scheme and storage that tests can change, as a browser would. */
function fakePage(systemDark: boolean, stored: string | null = null) {
  const items = new Map<string, string>(stored === null ? [] : [[THEME_KEY, stored]]);
  const media = new Map<string, { matches: boolean; fire: () => void }>();
  const storageListeners: ((e: { key: string | null; newValue: string | null }) => void)[] = [];
  const root: { dataset: Record<string, string> } = { dataset: {} };
  const host: ThemeHost = {
    storage: () => ({
      getItem: (k) => items.get(k) ?? null,
      setItem: (k, v) => void items.set(k, v),
      removeItem: (k) => void items.delete(k),
    }),
    root,
    matchMedia: (query) => {
      const listeners: (() => void)[] = [];
      const entry = {
        matches: query.includes("dark") ? systemDark : false,
        addEventListener: (_: string, l: () => void) => void listeners.push(l),
        fire: () => {
          for (const l of listeners) l();
        },
      };
      media.set(query, entry);
      return entry;
    },
    events: { addEventListener: (_, l) => void storageListeners.push(l) },
  };
  return {
    host,
    root,
    items,
    systemTurns(dark: boolean) {
      const entry = media.get("(prefers-color-scheme: dark)");
      if (entry === undefined) throw new Error("the store never asked for the scheme");
      entry.matches = dark;
      entry.fire();
    },
    otherTab(key: string | null, newValue: string | null) {
      for (const l of storageListeners) l({ key, newValue });
    },
  };
}

describe("the theme store", () => {
  test("shows the system's scheme under system, and the pinned one otherwise", () => {
    const page = fakePage(true);
    const store = themeStore(page.host);
    expect(store.scheme()).toBe("dark");
    store.choose("light");
    expect(store.scheme()).toBe("light");
    expect(page.items.get(THEME_KEY)).toBe("light");
    expect(page.root.dataset["theme"]).toBe("light");
  });

  test("announces a choice and a change of the system's scheme, until unsubscribed", () => {
    const page = fakePage(false);
    const store = themeStore(page.host);
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.scheme()));
    page.systemTurns(true);
    store.choose("light");
    unsubscribe();
    store.choose("dark");
    expect(seen).toEqual(["dark", "light"]);
  });

  test("follows another tab's choice, and ignores its other keys", () => {
    const page = fakePage(false, "light");
    const store = themeStore(page.host);
    let calls = 0;
    store.subscribe(() => calls++);
    page.otherTab("bazhen.keyMap", "{}");
    expect(calls).toBe(0);
    page.otherTab(THEME_KEY, "dark");
    expect([store.theme(), store.scheme(), page.root.dataset["theme"]]).toEqual([
      "dark",
      "dark",
      "dark",
    ]);
    page.otherTab(null, null);
    expect([store.theme(), store.scheme(), page.root.dataset["theme"]]).toEqual([
      "system",
      "light",
      undefined,
    ]);
    expect(calls).toBe(2);
  });
});
