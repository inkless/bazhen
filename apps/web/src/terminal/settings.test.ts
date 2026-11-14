import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_MAP } from "./keymap.ts";
import { loadSettings, SETTINGS_KEYS } from "./settings.ts";

const storage = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
});

describe("a device's terminal settings", () => {
  it("keeps the defaults on a device that stored nothing: Shift+Enter, and Option typing characters", () => {
    expect(loadSettings(storage({}))).toEqual({
      keyMap: DEFAULT_KEY_MAP,
      optionIsMeta: false,
      problem: null,
    });
  });

  it("applies a stored key map, and Option as Meta when asked", () => {
    const settings = loadSettings(
      storage({
        [SETTINGS_KEYS.keyMap]: '{"ctrl+enter":"\\n"}',
        [SETTINGS_KEYS.optionIsMeta]: "true",
      }),
    );
    expect([settings.keyMap.get("ctrl+enter"), settings.optionIsMeta]).toEqual(["\n", true]);
  });

  it("adds Apple's defaults on an Apple device, under the user's own map", () => {
    expect(loadSettings(storage({}), true).keyMap.get("meta+.")).toBe("\x1b");
    const unbound = loadSettings(storage({ [SETTINGS_KEYS.keyMap]: '{"meta+.":null}' }), true);
    expect(unbound.keyMap.has("meta+.")).toBe(false);
  });

  it("keeps the defaults and says why when the stored key map isn't usable", () => {
    const settings = loadSettings(storage({ [SETTINGS_KEYS.keyMap]: "not a map" }));
    expect([settings.keyMap, settings.problem]).toEqual([
      DEFAULT_KEY_MAP,
      "Your key map was not applied: a key map is an object of chord to text.",
    ]);
  });
});
