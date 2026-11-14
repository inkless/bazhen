import { matchKey, type KeyMap } from "./keymap.ts";

/** The keys a touch keyboard lacks, which the key bar types. */
export type BarKey = "escape" | "tab" | "up" | "down" | "left" | "right" | "newline" | "enter";

interface BarKeyInfo {
  /** The key as a keyboard event names it, which a key map binds. */
  readonly key: string;
  readonly shift?: boolean;
  /** What xterm.js sends for it with no binding. */
  readonly bytes: string;
  /** The final byte of an arrow's cursor sequence. */
  readonly arrow?: string;
}

const KEYS: Record<BarKey, BarKeyInfo> = {
  escape: { key: "Escape", bytes: "\x1b" },
  tab: { key: "Tab", bytes: "\t" },
  up: { key: "ArrowUp", bytes: "", arrow: "A" },
  down: { key: "ArrowDown", bytes: "", arrow: "B" },
  right: { key: "ArrowRight", bytes: "", arrow: "C" },
  left: { key: "ArrowLeft", bytes: "", arrow: "D" },
  // Shift+Enter, which the default key map sends as ESC CR, the TUIs' newline.
  newline: { key: "Enter", shift: true, bytes: "\r" },
  enter: { key: "Enter", bytes: "\r" },
};

export interface BarContext {
  readonly keyMap: KeyMap;
  /** Whether the bar's Ctrl is armed for this key. */
  readonly ctrl: boolean;
  /** Whether the program has asked for application cursor keys (DECCKM). */
  readonly appCursor: boolean;
}

/** What the terminal is sent for `key`: the user's key map first, then what xterm.js sends. */
export function barBytes(key: BarKey, { keyMap, ctrl, appCursor }: BarContext): string {
  const info = KEYS[key];
  const bound = matchKey(
    {
      type: "keydown",
      key: info.key,
      shiftKey: info.shift === true,
      ctrlKey: ctrl,
      altKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 0,
    },
    keyMap,
  );
  if (bound !== null) return bound;
  if (info.arrow === undefined) return info.bytes;
  if (ctrl) return `\x1b[1;5${info.arrow}`;
  return `${appCursor ? "\x1bO" : "\x1b["}${info.arrow}`;
}

/** `typed` with Ctrl held, as a terminal sends it: `c` is ETX, `?` is DEL; other text as typed. */
export function withCtrl(typed: string): string {
  if (typed.length !== 1) return typed;
  if (typed === "?") return "\x7f";
  if (typed === " ") return "\x00";
  const code = typed.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : typed;
}

/** A terminal view the bar can type into. */
export interface BarTarget {
  press(key: BarKey): void;
  /** Focuses its terminal, which on a phone opens the soft keyboard. */
  focus(): void;
}

/** The terminal views on the page, which one the bar types into, and the bar's sticky Ctrl. */
export function keyBarStore() {
  const views: BarTarget[] = [];
  let engaged: BarTarget | undefined;
  let ctrl = false;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  const target = () => engaged ?? views.at(-1);
  /** Runs `change`, releasing Ctrl if it moves the bar to another terminal. */
  const moving = (change: () => void) => {
    const before = target();
    change();
    if (target() !== before) ctrl = false;
    changed();
  };

  return {
    /** Adds a view; the returned function removes it. */
    register: (view: BarTarget): (() => void) => {
      moving(() => views.push(view));
      return () => {
        if (!views.includes(view)) return;
        moving(() => {
          views.splice(views.indexOf(view), 1);
          if (engaged === view) engaged = undefined;
        });
      };
    },
    /** The user engaged `view`, by a tap or focus: the bar types into it from now on. */
    engaged: (view: BarTarget): void => {
      if (view !== engaged) moving(() => (engaged = view));
    },
    target,
    ctrl: () => ctrl,
    setCtrl: (on: boolean): void => {
      ctrl = on;
      changed();
    },
    /** Whether Ctrl applies to the key being sent; it applies to one key only. */
    takeCtrl: (): boolean => {
      if (!ctrl) return false;
      ctrl = false;
      changed();
      return true;
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type KeyBarStore = ReturnType<typeof keyBarStore>;

let shared: KeyBarStore | undefined;

/** This page's key bar store. */
export const keyBar = (): KeyBarStore => (shared ??= keyBarStore());

/**
 * How far the bar is raised to sit on what the page shows: iOS doesn't shrink the layout viewport
 * for the soft keyboard, so a bar fixed to its bottom would sit behind the keyboard.
 */
export function lift(
  innerHeight: number,
  viewport: { readonly height: number; readonly offsetTop: number } | null,
): number {
  if (viewport === null) return 0;
  return Math.max(0, innerHeight - (viewport.height + viewport.offsetTop));
}
