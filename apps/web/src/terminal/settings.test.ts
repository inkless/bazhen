import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_MAP } from "./keymap.ts";
import { loadSettings, SETTINGS_KEYS } from "./settings.ts";

const storage = (entries: Record<string, string>) => ({
  read: (key: string) => entries[key] ?? null,
});

describe("a device's terminal settings", () => {
  it("keeps the defaults on a device that stored nothing: Shift+Enter, and Option typing characters", () => {
    expect(loadSettings(storage({}))).toEqual({
      keyMap: DEFAULT_KEY_MAP,
      optionIsMeta: false,
      fontFamily: null,
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

  it("applies a stored terminal font family, without the spaces around it", () => {
    const stored = storage({ [SETTINGS_KEYS.fontFamily]: '  "Iosevka Term", monospace ' });
    expect(loadSettings(stored)).toMatchObject({
      fontFamily: '"Iosevka Term", monospace',
      problem: null,
    });
  });

  it.each([
    ["", "it is empty"],
    ["   ", "it is empty"],
    ["a".repeat(201), "it is longer than 200 characters"],
    ["Iosevka; color: red", "it may not contain ; { } \\ or a line break"],
    ["Iosevka}", "it may not contain ; { } \\ or a line break"],
    ["Iose\\vka", "it may not contain ; { } \\ or a line break"],
    ["Iosevka\nTerm", "it may not contain ; { } \\ or a line break"],
  ])("draws the bundled font and says why for a stored family it can't use: %j", (value, why) => {
    const settings = loadSettings(storage({ [SETTINGS_KEYS.fontFamily]: value }));
    expect([settings.fontFamily, settings.problem]).toEqual([
      null,
      `Your terminal font was not applied: ${why}.`,
    ]);
  });

  it("takes a family of exactly 200 characters", () => {
    const family = "a".repeat(200);
    expect(loadSettings(storage({ [SETTINGS_KEYS.fontFamily]: family })).fontFamily).toBe(family);
  });

  it("says what is wrong with both the key map and the font when neither is usable", () => {
    const settings = loadSettings(
      storage({ [SETTINGS_KEYS.keyMap]: "not a map", [SETTINGS_KEYS.fontFamily]: "" }),
    );
    expect(settings.problem).toBe(
      "Your key map was not applied: a key map is an object of chord to text. " +
        "Your terminal font was not applied: it is empty.",
    );
  });
});
