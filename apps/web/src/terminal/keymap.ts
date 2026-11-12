/** The parts of a keyboard event a key map reads. */
export interface KeyChord {
  readonly type: string;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
}

/** Chords, written like kitty's `map` (`shift+enter`), to the bytes the terminal is sent. */
export type KeyMap = ReadonlyMap<string, string>;

/**
 * xterm.js sends a bare CR for Shift+Enter, the same as Enter, and tmux can't tell the TUIs it was
 * Shift+Enter; ESC CR is what Claude Code and Codex both take as a newline (foundation-design §5.9).
 */
export const DEFAULT_KEY_MAP: KeyMap = new Map([["shift+enter", "\x1b\r"]]);

/** The localStorage key a device's own bindings are kept under, as `{ chord: bytes }`. */
export const KEY_MAP_STORAGE_KEY = "bazhen.keyMap";

const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;

export type ParsedKeyMap = { ok: true; map: KeyMap } | { ok: false; error: string };

/** A user's bindings over the defaults; a map with any invalid entry is rejected whole. */
export function parseKeyMap(raw: unknown): ParsedKeyMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "a key map is an object of chord to bytes" };
  }
  const map = new Map(DEFAULT_KEY_MAP);
  for (const [chord, bytes] of Object.entries(raw)) {
    const name = canonical(chord);
    if (name === null) return { ok: false, error: `unknown chord "${chord}"` };
    if (typeof bytes !== "string") return { ok: false, error: `"${chord}" must map to a string` };
    map.set(name, bytes);
  }
  return { ok: true, map };
}

/** The bytes `event` is bound to, or null to leave it to xterm.js. */
export function matchKey(event: KeyChord, map: KeyMap): string | null {
  if (event.type !== "keydown" || event.isComposing) return null;
  const held = MODIFIERS.filter((m) => event[`${m}Key`]);
  return map.get([...held, event.key.toLowerCase()].join("+")) ?? null;
}

/** `Shift+Ctrl+Enter` → `ctrl+shift+enter`, so chords compare however they were written. */
function canonical(chord: string): string | null {
  const parts = chord.toLowerCase().split("+");
  const key = parts.pop();
  if (key === undefined || key === "" || parts.some((p) => !isModifier(p))) return null;
  return [...MODIFIERS.filter((m) => parts.includes(m)), key].join("+");
}

function isModifier(part: string): part is (typeof MODIFIERS)[number] {
  return (MODIFIERS as readonly string[]).includes(part);
}
