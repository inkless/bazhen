/** The parts of a keyboard event a key map reads. */
export interface KeyChord {
  readonly type: string;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  /** 229 while an IME is composing; Safari reports a composition's final key this way. */
  readonly keyCode: number;
}

/**
 * Chords, written like kitty's `map` (`shift+enter`), to the text the terminal is sent for them.
 * A user's map binds a chord to `null` to unbind it, which leaves the key to xterm.js.
 */
export type KeyMap = ReadonlyMap<string, string>;

/**
 * xterm.js sends a bare CR for Shift+Enter, the same as Enter, and tmux can't tell the TUIs it was
 * Shift+Enter; ESC CR is what Claude Code and Codex both take as a newline (foundation-design §5.9).
 */
export const DEFAULT_KEY_MAP: KeyMap = new Map([["shift+enter", "\x1b\r"]]);

/** On Apple's platforms Cmd+. is also Esc, as in macOS, for an iPad keyboard, which has no Esc. */
export const APPLE_KEY_MAP: KeyMap = new Map([...DEFAULT_KEY_MAP, ["meta+.", "\x1b"]]);

/** Whether `userAgent` is an Apple platform's; iPadOS's Safari names itself a Mac. */
export const isApple = (userAgent: string) => /Macintosh|iPhone|iPad|iPod/.test(userAgent);

const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;

export type ParsedKeyMap = { ok: true; map: KeyMap } | { ok: false; error: string };

/** A user's bindings over `defaults`; a map with any invalid entry is rejected whole. */
export function parseKeyMap(raw: unknown, defaults: KeyMap = DEFAULT_KEY_MAP): ParsedKeyMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "a key map is an object of chord to text" };
  }
  const map = new Map(defaults);
  for (const [chord, text] of Object.entries(raw)) {
    const name = canonical(chord);
    if (name === null) return { ok: false, error: `unknown chord "${chord}"` };
    if (text === null) map.delete(name);
    else if (typeof text === "string") map.set(name, text);
    else return { ok: false, error: `"${chord}" must map to a string, or null to unbind it` };
  }
  return { ok: true, map };
}

/** The text `event` is bound to, or null to leave it to xterm.js. */
export function matchKey(event: KeyChord, map: KeyMap): string | null {
  if (event.type !== "keydown" || event.isComposing || event.keyCode === 229) return null;
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
