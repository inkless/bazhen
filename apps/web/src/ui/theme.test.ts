import { describe, expect, test } from "vitest";
import { loadTheme, parseTheme } from "./theme.ts";

const storage = (value: string | null) => ({ getItem: () => value });

describe("the stored theme", () => {
  test("is the device's choice when it names a theme", () => {
    expect(loadTheme(storage("dark"))).toBe("dark");
    expect(loadTheme(storage("light"))).toBe("light");
  });

  test("follows the system when nothing, or nothing it knows, is stored", () => {
    expect(loadTheme(storage(null))).toBe("system");
    expect(parseTheme("Dark")).toBe("system");
    expect(parseTheme("")).toBe("system");
  });
});
