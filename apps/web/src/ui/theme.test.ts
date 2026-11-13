import { describe, expect, test } from "vitest";
import { loadTheme, parseTheme, saveTheme, THEME_KEY } from "./theme.ts";

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
