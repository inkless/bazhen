import { parseJson } from "@bazhen/protocol";
import { APPLE_KEY_MAP, DEFAULT_KEY_MAP, parseKeyMap, type KeyMap } from "./keymap.ts";

/** Where a device keeps its own terminal settings; nothing is synced by the daemon. */
export const SETTINGS_KEYS = {
  /** `{ "shift+enter": "\u001b\r", "meta+.": null, … }`, over the defaults; `null` unbinds. */
  keyMap: "bazhen.keyMap",
  /** `"true"` for Option to send Alt+letter (Esc-prefixed keys), as kitty's `macos_option_as_alt`. */
  optionIsMeta: "bazhen.optionIsMeta",
} as const;

export interface TerminalSettings {
  readonly keyMap: KeyMap;
  /**
   * Option sends Esc-prefixed keys (Alt+letter). Off by default, so Option types the characters it
   * puts on keys, as non-US Mac layouts need.
   */
  readonly optionIsMeta: boolean;
  /** A stored setting that couldn't be applied, to tell the user about. */
  readonly problem: string | null;
}

/** This device's settings; `apple` for an Apple platform, which gets its defaults too. */
export function loadSettings(storage: Pick<Storage, "getItem">, apple = false): TerminalSettings {
  const defaults = apple ? APPLE_KEY_MAP : DEFAULT_KEY_MAP;
  const optionIsMeta = storage.getItem(SETTINGS_KEYS.optionIsMeta) === "true";
  const stored = storage.getItem(SETTINGS_KEYS.keyMap);
  if (stored === null) return { keyMap: defaults, optionIsMeta, problem: null };
  const parsed = parseKeyMap(parseJson(stored), defaults);
  return parsed.ok
    ? { keyMap: parsed.map, optionIsMeta, problem: null }
    : {
        keyMap: defaults,
        optionIsMeta,
        problem: `Your key map was not applied: ${parsed.error}.`,
      };
}
