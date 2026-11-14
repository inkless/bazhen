import { matchKey, type KeyMap } from "./keymap.ts";

/** The keys a touch keyboard lacks, which the key bar types. */
export type BarKey = "escape" | "tab" | "up" | "down" | "left" | "right" | "newline" | "enter";

/** The key as a keyboard event names it, which a key map binds, and what xterm.js sends for it. */
type BarKeyInfo =
  | { readonly key: string; readonly shift?: boolean; readonly bytes: string }
  /** `arrow` is the final byte of its cursor sequence. */
  | { readonly key: string; readonly arrow: string };

const KEYS: Record<BarKey, BarKeyInfo> = {
  escape: { key: "Escape", bytes: "\x1b" },
  tab: { key: "Tab", bytes: "\t" },
  up: { key: "ArrowUp", arrow: "A" },
  down: { key: "ArrowDown", arrow: "B" },
  right: { key: "ArrowRight", arrow: "C" },
  left: { key: "ArrowLeft", arrow: "D" },
  // Shift+Enter, the TUIs' newline: ESC CR, as the default key map sends it, even unbound.
  newline: { key: "Enter", shift: true, bytes: "\x1b\r" },
  enter: { key: "Enter", bytes: "\r" },
};

export interface BarContext {
  readonly keyMap: KeyMap;
  /** Whether the bar's Ctrl is armed for this key. */
  readonly ctrl: boolean;
  /** Whether the program has asked for application cursor keys (DECCKM). */
  readonly appCursor: boolean;
}

/**
 * What the terminal is sent for `key`: the user's key map first, then what xterm.js sends. Ctrl
 * changes an arrow; on another key it counts only where the key map binds it, so Ctrl and newline
 * is still a newline, never the CR that would submit.
 */
export function barBytes(key: BarKey, { keyMap, ctrl, appCursor }: BarContext): string {
  const info = KEYS[key];
  const bound = (withCtrlKey: boolean) =>
    matchKey(
      {
        type: "keydown",
        key: info.key,
        shiftKey: "shift" in info && info.shift,
        ctrlKey: withCtrlKey,
        altKey: false,
        metaKey: false,
        isComposing: false,
        keyCode: 0,
      },
      keyMap,
    );
  if (ctrl) {
    const text = bound(true);
    if (text !== null) return text;
    if ("arrow" in info) return `\x1b[1;5${info.arrow}`;
  }
  const text = bound(false);
  if (text !== null) return text;
  if ("bytes" in info) return info.bytes;
  return `${appCursor ? "\x1bO" : "\x1b["}${info.arrow}`;
}

/** What xterm sends for Ctrl with a digit or punctuation that has no control code of its own. */
const CTRL_EXTRAS: Record<string, string> = {
  " ": "\x00",
  "2": "\x00",
  "`": "\x00",
  "3": "\x1b",
  "4": "\x1c",
  "5": "\x1d",
  "6": "\x1e",
  "7": "\x1f",
  "/": "\x1f",
  "-": "\x1f",
  "8": "\x7f",
  "?": "\x7f",
};

/** `typed` with Ctrl held, as xterm sends it: `c` is ETX, `?` is DEL; other text as typed. */
export function withCtrl(typed: string): string {
  if (typed.length !== 1) return typed;
  const extra = CTRL_EXTRAS[typed];
  if (extra !== undefined) return extra;
  // ASCII only: "ß" upper-cases to "SS", which must not become XOFF.
  const code = (/[a-z]/.test(typed) ? typed.toUpperCase() : typed).charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : typed;
}

/** A terminal view the bar can type into. */
export interface BarTarget {
  /** An agent's terminal, which the bar falls back to over a shell's. */
  readonly kind: "agent" | "shell";
  press(key: BarKey): void;
  /** Focuses its terminal, which on a phone opens the soft keyboard. */
  focus(): void;
  /** Whether focus is in its terminal. */
  holdsFocus(): boolean;
}

/** While the bar shows: its height, which a terminal leaves room for under it. */
export interface BarLayout {
  readonly bar: number;
}

/** The terminal views on the page, which one the bar types into, and the bar's sticky Ctrl. */
export function keyBarStore() {
  const views: BarTarget[] = [];
  let engaged: BarTarget | undefined;
  let ctrl = false;
  let layout: BarLayout | null = null;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  /** The view last engaged, else the one focus is in, else the agent's, else the newest. */
  const target = () =>
    engaged ??
    views.find((v) => v.holdsFocus()) ??
    views.find((v) => v.kind === "agent") ??
    views.at(-1);
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
      if (on === ctrl) return;
      ctrl = on;
      changed();
    },
    /** Releases Ctrl once the key it was armed for has been sent; whether it was armed. */
    takeCtrl: (): boolean => {
      if (!ctrl) return false;
      ctrl = false;
      changed();
      return true;
    },
    layout: () => layout,
    /** The bar's layout while it shows, `null` while it doesn't. */
    setLayout: (next: BarLayout | null): void => {
      if (next?.bar === layout?.bar) return;
      layout = next;
      changed();
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

export interface Device {
  /** Whether the primary pointer is a finger: a phone, or an iPad with no trackpad. */
  readonly coarse: boolean;
  readonly maxTouchPoints: number;
  readonly userAgent: string;
}

/**
 * Whether `device` gets the key bar: a phone, or an iPad, which names itself a Mac but has a touch
 * screen, even with a trackpad and keyboard, which has no Esc either. A laptop with a touch screen
 * has a keyboard with every key, and doesn't.
 */
export const wantsKeyBar = ({ coarse, maxTouchPoints, userAgent }: Device): boolean =>
  coarse || (maxTouchPoints > 1 && /Macintosh/.test(userAgent));
