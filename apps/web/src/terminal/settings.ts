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

/** The CSS generic families, which a family list names bare; every other name it quotes. */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);
/** One word of an unquoted family name: a CSS identifier, which doesn't start with a digit. */
const IDENT = /^-?[\p{L}_][\p{L}\p{N}_-]*$/u;
/** A quoted family name, with nothing in it that could end the string or the rule around it. */
const QUOTED = /^(?:"([^"'\\;{}<>\p{Cc}]*)"|'([^"'\\;{}<>\p{Cc}]*)')$/u;

/** `entry` of a family list as a family a CSS `font-family` takes, quoted unless generic. */
function familyName(entry: string): string | null {
  const quoted = QUOTED.exec(entry);
  if (quoted !== null) {
    const name = (quoted[1] ?? quoted[2] ?? "").trim();
    return name === "" ? null : `"${name}"`;
  }
  const words = entry.split(/\s+/u);
  if (!words.every((word) => IDENT.test(word))) return null;
  const name = words.join(" ");
  return GENERIC_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`;
}

/**
 * The stored family list, each name re-quoted, or why it isn't one. xterm.js puts the list in a
 * canvas's `font` and in a style sheet, where one broken name would drop the whole list, bundled
 * font and all, or turn the rules after it into a comment.
 */
function storedFontFamily(stored: string | null): {
  family: string | null;
  problem: string | null;
} {
  if (stored === null) return { family: null, problem: null };
  const list = stored.trim();
  const entries = list.split(",").map((entry) => entry.trim());
  const names = entries.map(familyName);
  const bad = entries.find((_, i) => names[i] === null);
  const why =
    list === ""
      ? "it is empty"
      : list.length > FONT_FAMILY_MAX
        ? `it is longer than ${FONT_FAMILY_MAX} characters`
        : list.includes("/*") || list.includes("*/")
          ? "it may not contain a comment"
          : bad === ""
            ? "it has an empty name between its commas"
            : bad === undefined
              ? null
              : `${bad} is not a family name; put a name in quotes, as "Iosevka Term"`;
  return why === null
    ? { family: names.join(", "), problem: null }
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
