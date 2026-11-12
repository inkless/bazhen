import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_MAP } from "./keymap.ts";
import { loadSettings, SETTINGS_KEYS } from "./settings.ts";

const storage = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
});

describe("a device's terminal settings", () => {
  it("keeps the defaults on a device that stored nothing: Shift+Enter and Option as Meta", () => {
    expect(loadSettings(storage({}))).toEqual({
      keyMap: DEFAULT_KEY_MAP,
      optionIsMeta: true,
      problem: null,
    });
  });

  it("applies a stored key map and lets Option type characters when asked", () => {
    const settings = loadSettings(
      storage({
        [SETTINGS_KEYS.keyMap]: '{"ctrl+enter":"\\n"}',
        [SETTINGS_KEYS.optionIsMeta]: "false",
      }),
    );
    expect([settings.keyMap.get("ctrl+enter"), settings.optionIsMeta]).toEqual(["\n", false]);
  });

  it("keeps the defaults and says why when the stored key map isn't usable", () => {
    const settings = loadSettings(storage({ [SETTINGS_KEYS.keyMap]: "not a map" }));
    expect([settings.keyMap, settings.problem]).toEqual([
      DEFAULT_KEY_MAP,
      "Your key map was not applied: a key map is an object of chord to text.",
    ]);
  });
});
