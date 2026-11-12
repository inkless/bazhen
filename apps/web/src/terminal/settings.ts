import { parseJson } from "@bazhen/protocol";
import { DEFAULT_KEY_MAP, parseKeyMap, type KeyMap } from "./keymap.ts";

/** Where a device keeps its own terminal settings; nothing is synced by the daemon. */
export const SETTINGS_KEYS = {
  /** `{ "shift+enter": "\u001b\r", … }`, over the defaults. */
  keyMap: "bazhen.keyMap",
  /** `"false"` to type the characters Option makes on a Mac, such as on non-US layouts. */
  optionIsMeta: "bazhen.optionIsMeta",
} as const;

export interface TerminalSettings {
  readonly keyMap: KeyMap;
  /** Option sends Esc-prefixed keys (Alt+letter), as TUIs and shells expect. */
  readonly optionIsMeta: boolean;
  /** A stored setting that couldn't be applied, to tell the user about. */
  readonly problem: string | null;
}

export function loadSettings(storage: Pick<Storage, "getItem">): TerminalSettings {
  const optionIsMeta = storage.getItem(SETTINGS_KEYS.optionIsMeta) !== "false";
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
