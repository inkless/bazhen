import { parseJson } from "@bazhen/protocol";
import { DEFAULT_KEY_MAP, parseKeyMap, type KeyMap } from "./keymap.ts";

/** Where a device keeps its own terminal settings; nothing is synced by the daemon. */
export const SETTINGS_KEYS = {
  /** `{ "shift+enter": "\u001b\r", … }`, over the defaults. */
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

export function loadSettings(storage: Pick<Storage, "getItem">): TerminalSettings {
  const optionIsMeta = storage.getItem(SETTINGS_KEYS.optionIsMeta) === "true";
  const stored = storage.getItem(SETTINGS_KEYS.keyMap);
  if (stored === null) return { keyMap: DEFAULT_KEY_MAP, optionIsMeta, problem: null };
  const parsed = parseKeyMap(parseJson(stored));
  return parsed.ok
    ? { keyMap: parsed.map, optionIsMeta, problem: null }
    : {
        keyMap: DEFAULT_KEY_MAP,
        optionIsMeta,
        problem: `Your key map was not applied: ${parsed.error}.`,
      };
}
