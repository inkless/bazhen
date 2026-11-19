import { parseJson } from "@bazhen/protocol";
import type { DeviceStorage } from "../storage.ts";
import { APPLE_KEY_MAP, DEFAULT_KEY_MAP, parseKeyMap, type KeyMap } from "./keymap.ts";

/** Where a device keeps its own terminal settings; nothing is synced by the daemon. */
export const SETTINGS_KEYS = {
  /** `{ "shift+enter": "\u001b\r", "meta+.": null, … }`, over the defaults; `null` unbinds. */
  keyMap: "bazhen.keyMap",
  /** `"true"` for Option to send Alt+letter (Esc-prefixed keys), as kitty's `macos_option_as_alt`. */
  optionIsMeta: "bazhen.optionIsMeta",
  /** A CSS family list, `"Iosevka Term", monospace`, drawn ahead of the bundled font. */
  fontFamily: "bazhen.fontFamily",
} as const;

const FONT_FAMILY_MAX = 200;

export interface TerminalSettings {
  readonly keyMap: KeyMap;
  /**
   * Option sends Esc-prefixed keys (Alt+letter). Off by default, so Option types the characters it
   * puts on keys, as non-US Mac layouts need.
   */
  readonly optionIsMeta: boolean;
  /** The device's own font family, or null for the bundled font alone. */
  readonly fontFamily: string | null;
  /** A stored setting that couldn't be applied, to tell the user about. */
  readonly problem: string | null;
}

/**
 * The stored family, trimmed, or why it isn't one. A family is only ever a CSS `font-family`; the
 * refusal keeps a typo from turning the font off without a word.
 */
function storedFontFamily(stored: string | null): {
  family: string | null;
  problem: string | null;
} {
  if (stored === null) return { family: null, problem: null };
  const family = stored.trim();
  const why =
    family === ""
      ? "it is empty"
      : family.length > FONT_FAMILY_MAX
        ? `it is longer than ${FONT_FAMILY_MAX} characters`
        : /[;{}\\\n\r]/.test(family)
          ? "it may not contain ; { } \\ or a line break"
          : null;
  return why === null
    ? { family, problem: null }
    : { family: null, problem: `Your terminal font was not applied: ${why}.` };
}

/** This device's settings; `apple` for an Apple platform, which gets its defaults too. */
export function loadSettings(
  storage: Pick<DeviceStorage, "read">,
  apple = false,
): TerminalSettings {
  const defaults = apple ? APPLE_KEY_MAP : DEFAULT_KEY_MAP;
  const optionIsMeta = storage.read(SETTINGS_KEYS.optionIsMeta) === "true";
  const font = storedFontFamily(storage.read(SETTINGS_KEYS.fontFamily));
  const keys = storedKeyMap(storage.read(SETTINGS_KEYS.keyMap), defaults);
  const problems = [keys.problem, font.problem].filter((p) => p !== null);
  return {
    keyMap: keys.map,
    optionIsMeta,
    fontFamily: font.family,
    problem: problems.length === 0 ? null : problems.join(" "),
  };
}

function storedKeyMap(
  stored: string | null,
  defaults: KeyMap,
): { map: KeyMap; problem: string | null } {
  if (stored === null) return { map: defaults, problem: null };
  const parsed = parseKeyMap(parseJson(stored), defaults);
  return parsed.ok
    ? { map: parsed.map, problem: null }
    : { map: defaults, problem: `Your key map was not applied: ${parsed.error}.` };
}
